const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const BitcoinConnector = require('./bitcoin-connector');
const DatabaseConnector = require('./database');
const MiningPoolMonitor = require('./monitoring-system');

class RealStratumServer extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = {
            port: config.port || 3333,
            difficulty: config.difficulty || 1.0,
            poolAddress: config.poolAddress || '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
            ...config
        };
       
        // Extranonce configuration matching bitcoin-connector.js
        this.extranonce1Size = 4; // Bytes (8 hex chars)
        this.extranonce2Size = 4; // Bytes (8 hex chars)
        
        this.miners = new Map();
        this.server = net.createServer();
        this.jobCounter = 0;
        this.currentJob = null;
        
        // Caching and batching
        this.cachedNetworkDifficulty = null;
        this.lastDifficultyUpdate = 0;
        this.shareQueue = [];
        
        // Bitcoin's maximum target (difficulty 1)
        this.MAX_TARGET = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
       
        // Initialize Bitcoin connector
        this.bitcoin = new BitcoinConnector({
            host: '172.25.128.1',
            port: 8332,
            user: 'btc_40',
            pass: '1234nN',
            poolAddress: this.config.poolAddress
        });
       
        this.setupServer();
        this.setupBitcoinEvents();
        this.db = new DatabaseConnector();
        this.startBatchProcessor();

        // Initialize the monitoring system
        this.monitor = new MiningPoolMonitor({
            checkInterval: 300000,
            alertCooldown: 1800000,
            logFile: './logs/mining-monitor.log'
        });
    }

    async start() {
        const connected = await this.bitcoin.testConnection();
        if (!connected) {
            console.error('Failed to connect to Bitcoin node!');
            return false;
        }

        this.server.listen(this.config.port, '0.0.0.0', () => {
            console.log(`Real Stratum server listening on port ${this.config.port}`);
            console.log(`Pool address: ${this.config.poolAddress}`);
            console.log(`Connected to Bitcoin node successfully`);
        });

        await this.monitor.start();
        await this.updateWork();
        return true;
    }

    setupBitcoinEvents() {
        this.bitcoin.on('newBlock', async (blockInfo) => {
            console.log(`New block ${blockInfo.blocks} detected, updating work...`);
            await this.updateWork();
        });
    }

    async getNetworkTarget() {
        const now = Date.now();
        
        if (this.cachedNetworkDifficulty && (now - this.lastDifficultyUpdate) < 300000) {
            return this.cachedNetworkDifficulty;
        }
        
        try {
            const info = await this.bitcoin.callRpc('getblockchaininfo');
            this.cachedNetworkDifficulty = info.difficulty;
            this.lastDifficultyUpdate = now;
            return this.cachedNetworkDifficulty;
        } catch (error) {
            console.error('Error getting network difficulty:', error);
            return this.cachedNetworkDifficulty || 73197670707408.73;
        }
    }

    async updateWork() {
        try {
            const job = await this.bitcoin.getBlockTemplate({ rules: ["segwit"] }); // Explicitly request SegWit rules
            if (!job) {
                console.error('❌ getblocktemplate returned null or undefined');
                console.log('DEBUG Attempting retry in 10s...');
                setTimeout(() => this.updateWork(), 10000);
                return;
            }
            // Log full response
            console.log(`DEBUG getblocktemplate response: ${JSON.stringify(job, null, 2)}`);
            // Validate critical fields
            if (!job.coinb1 || !job.coinb2 || !job.transactions || !job.nbits || !job.ntime || !job.height) {
                console.error(`❌ Invalid job: missing required fields (coinb1=${!!job.coinb1}, coinb2=${!!job.coinb2}, transactions=${!!job.transactions}, nbits=${!!job.nbits}, ntime=${!!job.ntime}, height=${!!job.height})`);
                console.log('DEBUG Attempting retry in 10s...');
                setTimeout(() => this.updateWork(), 10000);
                return;
            }
            // Debug job details
            console.log(`DEBUG Job: coinb1=${job.coinb1} (length=${job.coinb1.length}), coinb2=${job.coinb2} (length=${job.coinb2.length}), transactions=${job.transactions.length}, default_witness_commitment=${job.default_witness_commitment ? job.default_witness_commitment.substring(0, 20) + '...' : 'none'}, nbits=${job.nbits}, ntime=${job.ntime}, height=${job.height}`);
            if (job && (!this.currentJob || job.height !== this.currentJob.height)) {
                if (this.currentJob) {
                    delete this.currentJob.cachedCoinbaseTemplate;
                }
                this.currentJob = job;
                this.broadcastJob(job);
                console.log(`New work created for block height ${job.height}`);
            }
        } catch (error) {
            console.error('❌ Error updating work:', error.message);
            console.log('DEBUG Attempting retry in 10s...');
            setTimeout(() => this.updateWork(), 10000);
        }
    }

    setupServer() {
        this.server.on('connection', this.handleConnection.bind(this));
        this.server.on('error', (err) => {
            console.error('Server error:', err);
        });
    }

    difficultyToTarget(difficulty) {
        console.log(`🔧 difficultyToTarget called with: ${difficulty}`);
        
        if (difficulty <= 0) {
            difficulty = 0.00001;
        }
        
        // Bitcoin's maximum target for difficulty 1
        const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
        
        let targetBig;
        
        if (difficulty >= 1.0) {
            // For difficulty >= 1: target = maxTarget / difficulty
            const difficultyBig = BigInt(Math.floor(difficulty * 1000000)) / BigInt(1000000);
            targetBig = maxTarget / difficultyBig;
        } else {
            // For difficulty < 1: target = maxTarget / difficulty (makes target LARGER, easier)
            // Scale up for precision
            const scale = BigInt(1000000000); // 1 billion for precision
            const difficultyScaled = BigInt(Math.round(difficulty * Number(scale)));
            targetBig = (maxTarget * scale) / difficultyScaled;
            
            // Cap at max 256-bit value
            const maxUint256 = (BigInt(1) << BigInt(256)) - BigInt(1);
            if (targetBig > maxUint256) {
                targetBig = maxUint256;
            }
        }
        
        // Convert to 32-byte buffer (big-endian)
        const targetHex = targetBig.toString(16).padStart(64, '0');
        console.log(`🔧 Difficulty ${difficulty} -> Target: ${targetHex.substring(0, 16)}...`);
        
        return Buffer.from(targetHex, 'hex');
    }

    /**
     * Check if hash meets target difficulty (proper endianness handling)
     */
    meetsTarget(hash, target) {
        // Hash comes as little-endian bytes from SHA256
        // Target is big-endian bytes
        // Convert hash to big-endian for comparison
        const hashBE = Buffer.from(hash).reverse();
        
        // Compare as big-endian
        const result = hashBE.compare(target) <= 0;
        
        if (result) {
            console.log(`✅ VALID: hash ${hashBE.toString('hex').substring(0, 16)}... <= target ${target.toString('hex').substring(0, 16)}...`);
        } else {
            console.log(`❌ INVALID: hash ${hashBE.toString('hex').substring(0, 16)}... > target ${target.toString('hex').substring(0, 16)}...`);
        }
        
        return result;
    }
//    adjustMinerDifficulty(miner) {
//        const now = Date.now();
//        const timeSinceLastAdjust = now - (miner.lastDifficultyAdjust || now);
//        
//        if (timeSinceLastAdjust < 60000) return;
//        
//        const targetSharesPerMinute = 6; // ~6 shares/min per miner
//        const timeWindowMinutes = Math.min(timeSinceLastAdjust / 60000, 10);
//        const actualSharesPerMinute = (miner.validShares || 0) / timeWindowMinutes;
//        
//        let newDifficulty = miner.difficulty;
//        
//        if (actualSharesPerMinute > targetSharesPerMinute * 1.5) {
//            newDifficulty = miner.difficulty * 2;
//        } else if (actualSharesPerMinute < targetSharesPerMinute * 0.5 && miner.validShares > 5) {
//            newDifficulty = Math.max(miner.difficulty * 0.5, 0.001);
//       }
//        
//        if (Math.abs(newDifficulty - miner.difficulty) / miner.difficulty > 0.1) {
//            console.log(`🎯 Adjusting ${miner.username} difficulty: ${miner.difficulty.toFixed(6)} → ${newDifficulty.toFixed(6)}`);
//            miner.difficulty = newDifficulty;
//            miner.lastDifficultyAdjust = now;
//            miner.validShares = 0;
//            this.sendDifficulty(miner);
//        }
//    }

    handleConnection(socket) {
        const startTime = Date.now();
        const minerId = crypto.randomUUID();
        const miner = {
            id: minerId,
            socket: socket,
            subscribed: false,
            authorized: false,
            difficulty: 1.0, 
            lastActivity: Date.now(),
            address: socket.remoteAddress,
            shares: 0,
            validShares: 0,
            connectTime: startTime,
            username: 'unknown', // Default, updated on authorize
            subscriptionId: null,
            extranonce1: null,
            extranonce2Size: this.extranonce2Size,
            supportsVersionRolling: false,
            rollingMask: null,
            minBitCount: 0
        };

        this.miners.set(minerId, miner);
        console.log(`🔗 NEW CONNECTION: ${miner.address} (${minerId.substring(0, 8)})`);
        console.log(`🎯 Waiting for messages from ${miner.address}...`);

        // Log miner connection to DB immediately to prevent FK violations
        this.db.logMinerConnection(minerId, miner.username, miner.address).catch(err => {
            console.error(`❌ Failed to log miner connection for ${minerId}: ${err.message}`);
        });

        // Socket events
        socket.on('data', (data) => this.handleData(minerId, data));
        socket.on('end', () => this.handleDisconnect(minerId));
        socket.on('error', (err) => {
            console.error(`Socket error for ${miner.address}: ${err.message}`);
            this.handleDisconnect(minerId);
        });
        socket.on('close', () => this.handleDisconnect(minerId));
        socket.setTimeout(300000); // 5 min timeout
        socket.on('timeout', () => {
            console.log(`Socket timeout for ${miner.address}`);
            this.handleDisconnect(minerId);
        });

        // Keepalive ping every 30s
        const keepaliveInterval = setInterval(() => {
            if (miner.socket.writable && !miner.socket.destroyed) {
                this.sendMessage(miner.socket, { id: null, method: 'mining.ping', params: [] });
            }
        }, 30000);
        miner.keepaliveInterval = keepaliveInterval;
    }

    handleData(minerId, data) {
        const miner = this.miners.get(minerId);
        if (!miner) return;

        miner.lastActivity = Date.now();
        const messages = data.toString().split('\n').filter(msg => msg.trim());
        
        for (const messageStr of messages) {
            console.log(`📥 RAW DATA from ${miner.address}: ${messageStr}`);
            
            // Reject HTTP requests
            if (messageStr.startsWith('POST') || messageStr.startsWith('GET') || messageStr.startsWith('HTTP')) {
                console.log(`⚠️ Rejecting HTTP request from ${miner.address}`);
                this.sendError(miner.socket, null, 20, 'Invalid protocol: HTTP not supported');
                miner.socket.destroy();
                continue;
            }
            
            try {
                const message = JSON.parse(messageStr);
                console.log(`📨 PARSED MESSAGE from ${miner.address}: ${JSON.stringify(message)}`);
                this.processMessage(minerId, message);
            } catch (err) {
                console.log(`⚠️ JSON/RUNTIME ERROR from ${miner.address}: ${err.message}`);
                this.sendError(miner.socket, null, 20, `Parse error: ${err.message}`);
            }
        }
    }

    processMessage(minerId, message) {
        const miner = this.miners.get(minerId);
        if (!miner) return;

        const { id, method, params } = message;
        console.log(`🔄 PROCESSING ${method} from ${miner.address} (ID: ${minerId.substring(0, 8)})`);

        switch (method) {
            case 'mining.configure':
                this.handleConfigure(miner, id, params);
                break;
            case 'mining.subscribe':
                this.handleSubscribe(miner, id, params);
                break;
            case 'mining.authorize':
                this.handleAuthorize(miner, id, params);
                break;
            case 'mining.submit':
                this.handleSubmit(minerId, id, params);
                break;
            default:
                console.log(`⚠️ Unknown method '${method}' from ${miner.address}`);
                this.sendError(miner.socket, id, 20, `Unknown method: ${method}`);
        }
    }

    handleConfigure(miner, id, params) {
        console.log(`🔧 Handling mining.configure from ${miner.address}: extensions=${JSON.stringify(params)}`);
        const extensions = params && params[0] ? params[0] : [];
        const config = params && params[1] ? params[1] : {};
        miner.supportsVersionRolling = false;

        const resultObj = {};
        if (extensions.includes('version-rolling')) {
            const mask = config['version-rolling.mask'] || '1fffe000';
            const minBitCount = parseInt(config['version-rolling.min-bit-count']) || 16;
            miner.rollingMask = mask;
            miner.minBitCount = minBitCount;
            miner.supportsVersionRolling = true;
            resultObj['version-rolling'] = true;
            resultObj['version-rolling.mask'] = mask;
            resultObj['version-rolling.min-bit-count'] = minBitCount;
            console.log(`✅ Version-rolling enabled for ${miner.address}: mask=${mask}, min-bits=${minBitCount}`);
        } else {
            for (const ext of extensions) {
                resultObj[ext] = false;
            }
        }

        try {
            this.sendMessage(miner.socket, {
                id: id,
                result: resultObj,
                error: null
            });
            // Remove proactive difficulty send; handled in subscribe
        } catch (err) {
            console.error(`❌ Error sending configure response to ${miner.address}: ${err.message}`);
            miner.socket.destroy();
        }
    }

    handleSubscribe(miner, id, params) {
        console.log(`🔄 PROCESSING mining.subscribe from ${miner.address}`);
        const subscriptionId = crypto.randomBytes(4).toString('hex');
        const extranonce1Size = this.extranonce1Size;
        const extranonce2Size = this.extranonce2Size;
        miner.subscribed = true;
        miner.subscriptionId = subscriptionId;
        miner.extranonce1 = crypto.randomBytes(extranonce1Size).toString('hex');
        miner.extranonce2Size = extranonce2Size; // Store for validation
        miner.difficulty = 0.0001; // Temporary for testing S9 (~14 TH/s, ~400 shares/s, ~12 valid/s)
        miner.shareCount = 0;
        miner.validShares = 0;
        miner.lastDifficultyAdjust = Date.now();

        try {
            // Send Stratum-compliant response (empty subscriptions for solo mining)
            this.sendMessage(miner.socket, {
                id: id,
                result: [
                    [], // Empty subscriptions array
                    miner.extranonce1, // 4 bytes = 8 hex chars
                    extranonce2Size // 4 bytes
                ],
                error: null
            });
            console.log(`DEBUG Subscribe sent: extranonce1=${miner.extranonce1}, size=${extranonce2Size}`);

            // Send initial difficulty
            this.sendDifficulty(miner);

            // Send current job if available
            if (this.currentJob) {
                this.sendJob(miner);
                console.log(`📤 Sent job ${this.currentJob.jobId} to ${miner.address}`);
            } else {
                console.warn(`⚠️ No current job available for ${miner.address}`);
            }

            // Log miner connection to prevent FK violations (username may be unknown yet)
            this.db.logMinerConnection(miner.id, miner.username || 'unknown', miner.address).catch(err => {
                console.error(`❌ Failed to log miner connection for ${miner.id}: ${err.message}`);
            });

            console.log(`✅ Miner subscribed: ${miner.address} (extranonce1: ${miner.extranonce1}, extranonce2_size: ${extranonce2Size}, difficulty: ${miner.difficulty})`);
            this.monitor.recordMinerConnection(miner.id, miner.username || 'unknown', miner.address);
        } catch (err) {
            console.error(`❌ Error sending subscribe response to ${miner.address}: ${err.message}`);
            this.sendError(miner.socket, id, 20, `Subscribe failed: ${err.message}`);
            miner.socket.destroy();
        }
    }

    async handleAuthorize(miner, id, params) {
        console.log(`🔄 PROCESSING mining.authorize from ${miner.address}: username=${params[0]}, password=${params[1]}`);
        const username = params && params[0] ? params[0] : null;
        const password = params && params[1] ? params[1] : null;

        // Validate username (solo mining: require non-empty username)
        if (!username || typeof username !== 'string' || username.trim() === '') {
            console.error(`❌ Invalid username from ${miner.address}: ${username}`);
            this.sendError(miner.socket, id, 21, 'Invalid or missing username');
            miner.socket.destroy();
            return;
        }

        try {
            // Update miner object
            miner.username = username;
            miner.authorized = true;
            miner.lastActivity = Date.now();

            // Update/insert miner record in database to prevent FK violations
            await this.db.logMinerConnection(miner.id, username, miner.address);

            // Send authorization response first
            this.sendMessage(miner.socket, {
                id: id,
                result: true,
                error: null
            });

            console.log(`✅ Authorized ${miner.address}: username=${username}, minerId=${miner.id.substring(0, 8)}`);

            // Send job with proper timing to prevent disconnection
            if (this.currentJob) {
                // Send immediately, then again with delay to ensure delivery
                this.sendJob(miner);
                setTimeout(() => {
                    if (miner.authorized && !miner.socket.destroyed) {
                        this.sendJob(miner);
                        console.log(`📤 Job resent to ${miner.username} for reliability`);
                    }
                }, 200);
                console.log(`📤 Initial job sent to ${miner.address}`);
            } else {
                console.warn(`⚠️ No current job available for ${miner.address} - will send when available`);
            }

            // Log to monitoring system
            this.monitor.recordMinerConnection(miner.id, username, miner.address);

        } catch (err) {
            console.error(`❌ Error during authorization for ${miner.address}: ${err.message}`);
            this.sendError(miner.socket, id, 20, `Authorization failed: ${err.message}`);
            miner.socket.destroy();
        }
    }

    handleSubmit(minerId, id, params) {
        const miner = this.miners.get(minerId);
        if (!miner || !miner.authorized || !this.currentJob) {
            this.sendError(miner.socket, id, 20, 'Unauthorized or no job');
            return;
        }

        // Destructure 6 params for version-rolling
        const [workerName, jobId, extranonce2, ntime, nonce, rolledVersion] = params;
        const startTime = Date.now();

        if (jobId !== this.currentJob.jobId) {
            console.log(`❌ Rejected stale share for job ${jobId}, current is ${this.currentJob.jobId}`);
            this.sendMessage(miner.socket, {
                id: id,
                result: false,
                error: null
            });
            return;
        }

        // Validate extranonce2 length (8 hex for 4 bytes)
        if (extranonce2.length !== miner.extranonce2Size * 2) {
            console.log(`❌ Invalid extranonce2 length: ${extranonce2.length}, expected ${miner.extranonce2Size * 2} (value: ${extranonce2})`);
            this.sendMessage(miner.socket, {
                id: id,
                result: false,
                error: null
            });
            return;
        }

        // Log for debugging
        console.log(`DEBUG Share: worker=${workerName}, jobId=${jobId}, extranonce2=${extranonce2}, ntime=${ntime}, nonce=${nonce}, rolledVersion=${rolledVersion || 'none'}`);

        // ===== BUILD COINBASE CORRECTLY (this part is already correct) =====
        const coinb1_bytes = Buffer.from(this.currentJob.coinb1, 'hex');
        const coinb2_bytes = Buffer.from(this.currentJob.coinb2, 'hex');

        // coinb1 ends with extranonce1 space (4 zero bytes) - slice it out
        const coinb1_prefix = coinb1_bytes.slice(0, -this.extranonce1Size);

        // coinb2 starts with extranonce2 space (4 zero bytes) - slice it out
        const coinb2_suffix = coinb2_bytes.slice(this.extranonce2Size);

        // Actual extranonce bytes
        const extranonce1_bytes = Buffer.from(miner.extranonce1, 'hex');
        const extranonce2_bytes = Buffer.from(extranonce2, 'hex');

        // Full coinbase: prefix1 + extranonce1 + extranonce2 + suffix2
        const coinbase = Buffer.concat([
            coinb1_prefix,
            extranonce1_bytes,
            extranonce2_bytes,
            coinb2_suffix
        ]);

        console.log(`🔍 COINBASE PARTS DEBUG:`);
        console.log(`  coinb1_prefix: ${coinb1_prefix.toString('hex')} (${coinb1_prefix.length} bytes)`);
        console.log(`  extranonce1: ${extranonce1_bytes.toString('hex')} (${extranonce1_bytes.length} bytes)`);
        console.log(`  extranonce2: ${extranonce2_bytes.toString('hex')} (${extranonce2_bytes.length} bytes)`);
        console.log(`  coinb2_suffix: ${coinb2_suffix.toString('hex')} (${coinb2_suffix.length} bytes)`);
        console.log(`  FINAL coinbase: ${coinbase.toString('hex')}`);
        console.log(`DEBUG Coinbase (${coinbase.length} bytes): ${coinbase.toString('hex')}`);

        const coinbaseHash = this.doublesha256(coinbase); // LE bytes
        const merkleRoot = this.calculateCorrectMerkleRoot(coinbaseHash.reverse().toString('hex'), this.currentJob.merkleSteps || []); // BE hex for merkle

        // ===== USE A SIMPLER HEADER BUILDER =====
        const header = this.buildSimpleBlockHeader(this.currentJob, miner, merkleRoot, ntime, nonce, rolledVersion);
        console.log(`DEBUG Full header hex: ${header.toString('hex')}`);

        // Calculate hash only once
        const blockHash = this.calculateBlockHash(header); // LE bytes
        console.log(`DEBUG Calculated hash LE: ${blockHash.toString('hex')}`);
        console.log(`DEBUG Calculated hash BE: ${Buffer.from(blockHash).reverse().toString('hex')}`);

        console.log(`🔍 MANUAL HASH VERIFICATION:`);
        const testHeader = Buffer.from('0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c', 'hex');
        const testHash = this.doublesha256(testHeader);
        console.log(`  Test header: ${testHeader.toString('hex')}`);
        console.log(`  Test hash LE: ${testHash.toString('hex')}`);
        console.log(`  Test hash BE: ${testHash.reverse().toString('hex')}`);

        const processingTime = Date.now() - startTime;

        // Check difficulties
        const target = this.difficultyToTarget(miner.difficulty);
        
        const networkDifficulty = this.cachedNetworkDifficulty || 73000000000000;
        const networkTarget = this.difficultyToTarget(networkDifficulty);

        const meetsPoolDiff = this.meetsTarget(blockHash, target);
        const meetsNetworkDiff = this.meetsTarget(blockHash, networkTarget);

        console.log(`🎯 Pool difficulty ${miner.difficulty}: ${meetsPoolDiff ? '✅ VALID' : '❌ INVALID'}`);
        console.log(`🎯 Network difficulty: ${meetsNetworkDiff ? '✅ BLOCK FOUND!' : '❌ NO BLOCK'}`);

        // Enhanced logging
        console.log(`🎯 Pool difficulty ${miner.difficulty}: ${meetsPoolDiff ? '✅ VALID' : '❌ INVALID'}`);
        console.log(`🎯 Network difficulty: ${meetsNetworkDiff ? '✅ BLOCK FOUND!' : '❌ NO BLOCK'}`);

        // Queue for batch processing
        this.shareQueue.push({
            minerId,
            jobId,
            nonce,
            isValid: meetsPoolDiff,
            meetsPoolDiff,
            meetsNetworkDiff,
            blockHash: blockHash.toString('hex'),
            processingTime
        });

        // Immediate response to miner
        this.sendMessage(miner.socket, {
            id: id,
            result: meetsPoolDiff,
            error: null
        });

        // Update miner stats
        miner.shareCount++;
        if (meetsPoolDiff) {
            miner.validShares++;
            this.emit('validShare', { miner, nonce });
            console.log(`💎 Valid share: ${miner.username} found nonce ${nonce}`);
        }

        if (meetsNetworkDiff) {
            console.log(`🎉 BLOCK FOUND! Submitting block for ${miner.username}`);
            this.submitFoundBlock(miner, header, coinbase, this.currentJob.transactions || []);
        }

        // Adjust difficulty periodically
//        this.adjustMinerDifficulty(miner);
    }

    handleDisconnect(minerId) {
        const miner = this.miners.get(minerId);
        if (!miner) return;

        const duration = Date.now() - miner.connectTime;
        console.log(`🔌 CONNECTION CLOSED: ${miner.address} (${minerId.substring(0, 8)})`);
        console.log(`   Duration: ${duration}ms`);
        console.log(`   Subscribed: ${miner.subscribed}`);
        console.log(`   Authorized: ${miner.authorized}`);
        console.log(`   Shares: ${miner.shareCount}`);

        // Log disconnection to DB
        this.db.logMinerDisconnection(minerId).catch(err => {
            console.error(`❌ Failed to log miner disconnection for ${minerId}: ${err.message}`);
        });

        // Clear keepalive interval
        if (miner.keepaliveInterval) {
            clearInterval(miner.keepaliveInterval);
        }

        this.miners.delete(minerId);
        this.monitor.recordMinerDisconnection(minerId);
    }

    buildSimpleBlockHeader(job, miner, merkleRootHex, time, nonce, rolledVersion = null) {
        // Handle version rolling
        let version;
        if (miner.supportsVersionRolling && rolledVersion) {
            const baseVersion = parseInt(job.version, 16);
            const rolledBits = parseInt(rolledVersion, 16);
            const mask = parseInt(miner.rollingMask || '1fffe000', 16);
            version = baseVersion | (rolledBits & mask);
            console.log(`DEBUG Version rolling: base=${baseVersion.toString(16)}, rolled=${rolledVersion}, mask=${miner.rollingMask}, final=${version.toString(16)}`);
        } else {
            version = parseInt(job.version, 16);
        }
        
        // Build 80-byte block header
        const header = Buffer.alloc(80);
        let offset = 0;
        
        // Version (4 bytes, little-endian)
        header.writeUInt32LE(version, offset);
        offset += 4;
        
        // Previous block hash (32 bytes, little-endian)
        const prevHashBuffer = Buffer.from(job.prevHash, 'hex');
        prevHashBuffer.copy(header, offset);
        offset += 32;
        
        // Merkle root (32 bytes, little-endian)
        Buffer.from(merkleRootHex, 'hex').reverse().copy(header, offset);
        offset += 32;
        
        // Timestamp (4 bytes, little-endian)
        header.writeUInt32LE(parseInt(time, 16), offset);
        offset += 4;
        
        // Difficulty bits (4 bytes, little-endian)
        header.writeUInt32LE(parseInt(job.nbits, 16), offset);
        offset += 4;
        
        // Nonce (4 bytes, little-endian)
        header.writeUInt32LE(parseInt(nonce, 16), offset);
        
        console.log(`DEBUG Header fields: version=${version.toString(16)}, prevHash=${job.prevHash.substring(0, 16)}..., merkle=${merkleRootHex.substring(0, 16)}..., time=${parseInt(time, 16).toString(16)}, nbits=${job.nbits}, nonce=${parseInt(nonce, 16).toString(16)}`);
        console.log(`🔍 HEADER CONSTRUCTION DEBUG:`);
        console.log(`  Version LE: ${version.toString(16).padStart(8, '0')}`);
        console.log(`  PrevHash: ${job.prevHash}`);
        console.log(`  MerkleRoot BE: ${merkleRootHex}`);
        console.log(`  MerkleRoot LE: ${Buffer.from(merkleRootHex, 'hex').reverse().toString('hex')}`);
        console.log(`  Time: ${parseInt(time, 16)} (${time})`);
        console.log(`  NBits: ${parseInt(job.nbits, 16)} (${job.nbits})`);
        console.log(`  Nonce: ${parseInt(nonce, 16)} (${nonce})`);
        console.log(`  Complete header: ${header.toString('hex')}`);

        return header;
    }

    async submitFoundBlock(miner, header, coinbase, transactions) {
        try {
            // Build full block
            const txCount = this.varintEncode(transactions.length + 1); // +1 for coinbase
            const txData = Buffer.concat([
                txCount,
                coinbase,
                ...transactions.map(tx => Buffer.from(tx.data, 'hex'))
            ]);
            
            const blockHex = Buffer.concat([
                header,
                txData
            ]).toString('hex');
            
            const result = await this.bitcoin.submitBlock(blockHex);
            if (result) {
                console.log(`🎉 BLOCK ACCEPTED! Hash: ${this.calculateBlockHash(header).toString('hex').reverse().toString('hex')}`);
                this.db.logBlockFound(miner.id, this.calculateBlockHash(header).toString('hex'), this.currentJob.height);
                this.emit('blockFound', { miner, blockHash: result });
            } else {
                console.log(`❌ Block rejected: ${result}`);
            }
        } catch (error) {
            console.error(`❌ Error submitting block: ${error.message}`);
        }
    }

    varintEncode(num) {
        if (num < 0xfd) {
            return Buffer.from([num]);
        } else if (num <= 0xffff) {
            const buf = Buffer.alloc(3);
            buf[0] = 0xfd;
            buf.writeUInt16LE(num, 1);
            return buf;
        } else if (num <= 0xffffffff) {
            const buf = Buffer.alloc(5);
            buf[0] = 0xfe;
            buf.writeUInt32LE(num, 1);
            return buf;
        } else {
            const buf = Buffer.alloc(9);
            buf[0] = 0xff;
            buf.writeBigUInt64LE(BigInt(num), 1);
            return buf;
        }
    }

    calculateBlockHash(header) {
        return this.doublesha256(header);
    }

    doublesha256(data) {
        const hash1 = crypto.createHash('sha256').update(data).digest();
        const hash2 = crypto.createHash('sha256').update(hash1).digest();
        return hash2;
    }

    calculateCorrectMerkleRoot(coinbaseHashHex, merkleSteps) {
        let root = coinbaseHashHex; // BE hex
        if (!merkleSteps || merkleSteps.length === 0) {
            return root;
        }
        for (let i = 0; i < merkleSteps.length; i++) {
            const left = Buffer.from(root, 'hex').reverse(); // To LE for hashing
            const right = Buffer.from(merkleSteps[i], 'hex').reverse(); // To LE
            const combined = Buffer.concat([left, right]);
            const hash = this.doublesha256(combined); // LE hash
            root = hash.reverse().toString('hex'); // Back to BE hex
        }
        return root;
    }

    startBatchProcessor() {
        setInterval(async () => {
            console.log(`🕒 Batch processor tick, queue size: ${this.shareQueue.length}`);
            if (this.shareQueue.length > 0) {
                const batch = this.shareQueue.splice(0, 5000); // Handle high hashrate
                console.log(`📦 Processing batch of ${batch.length} shares...`);
                try {
                    const validShares = batch.filter(s => s.isValid).length;
                    for (const share of batch) {
                        try {
                            await this.db.logShare(
                                share.minerId,
                                share.jobId,
                                share.nonce,
                                share.isValid,
                                share.meetsPoolDiff,
                                share.meetsNetworkDiff,
                                share.blockHash,
                                share.processingTime
                            );
                            console.log(`✅ Logged share for ${share.minerId}: valid=${share.isValid}`);
                        } catch (dbErr) {
                            console.error(`❌ DB logShare error for miner ${share.minerId}:`, dbErr.message);
                        }
                    }
                    console.log(`📊 Processed ${batch.length} shares (${validShares} valid)`);
                } catch (error) {
                    console.error('❌ Batch processing error:', error.message);
                }
            }
        }, 5000);
    }

    sendDifficulty(miner) {
        const message = {
            id: null,
            method: 'mining.set_difficulty',
            params: [miner.difficulty]
        };
        this.sendMessage(miner.socket, message);
    }

    sendJob(miner) {
        if (!this.currentJob || !miner.subscribed || !miner.authorized) return;

        const message = {
            id: null,
            method: 'mining.notify',
            params: [
                this.currentJob.jobId,
                this.currentJob.prevHash,
                this.currentJob.coinb1,
                this.currentJob.coinb2,
                this.currentJob.merkleSteps || [],
                this.currentJob.version,
                this.currentJob.nbits,
                this.currentJob.ntime,
                true // Clean jobs
            ]
        };
        
        // Add this debug logging:
        console.log(`🔍 SENDING JOB TO MINER:`);
        console.log(`  jobId: ${this.currentJob.jobId}`);
        console.log(`  prevHash: ${this.currentJob.prevHash}`);
        console.log(`  coinb1: ${this.currentJob.coinb1}`);
        console.log(`  coinb2: ${this.currentJob.coinb2}`);
        console.log(`  version: ${this.currentJob.version}`);
        console.log(`  nbits: ${this.currentJob.nbits}`);
        console.log(`  ntime: ${this.currentJob.ntime}`);
        
        this.sendMessage(miner.socket, message);
    }

    broadcastJob(jobData) {
        this.currentJob = jobData;
        
        let broadcastCount = 0;
        for (const [minerId, miner] of this.miners) {
            if (miner.subscribed && miner.authorized) {
                this.sendJob(miner);
                broadcastCount++;
            }
        }
        
        console.log(`Broadcasted job ${jobData.jobId} to ${broadcastCount} miners`);
    }

    sendMessage(socket, message) {
        try {
            if (socket && socket.writable && !socket.destroyed) {
                const data = JSON.stringify(message) + '\n';
                console.log(`📤 SENDING: ${JSON.stringify(message)}`);
                socket.write(data, (err) => {
                    if (err) {
                        console.error(`❌ Write error: ${err.message}`);
                        socket.destroy();
                    } else {
                        console.log(`✅ Message sent successfully`);
                    }
                });
            } else {
                console.log(`❌ Cannot send - socket not writable`);
            }
        } catch (err) {
            console.error('❌ Error sending message:', err.message);
        }
    }

    sendError(socket, id, code, message) {
        const response = {
            id: id,
            result: null,
            error: [code, message, null]
        };
        this.sendMessage(socket, response);
    }

    getStats() {
        const miners = Array.from(this.miners.values());
        const totalShares = miners.reduce((sum, m) => sum + m.shares, 0);
        const totalValidShares = miners.reduce((sum, m) => sum + m.validShares, 0);
        
        return {
            totalMiners: miners.length,
            authorizedMiners: miners.filter(m => m.authorized).length,
            subscribedMiners: miners.filter(m => m.subscribed).length,
            totalShares: totalShares,
            validShares: totalValidShares,
            efficiency: totalShares > 0 ? (totalValidShares / totalShares * 100).toFixed(1) : 0
        };
    }
}

// Start the real stratum server
const server = new RealStratumServer({
    port: 3333,
    difficulty: 1.0,
    poolAddress: '1GWVQpX8bnwkQsLYHrdzQqma7vWXbp9zFH'
});

server.on('validShare', (data) => {
    console.log(`💎 Valid share: ${data.miner.username} found nonce ${data.nonce}`);
});

// Start server
server.start().then(success => {
    if (!success) {
        console.error('Failed to start server');
        process.exit(1);
    }
});

// Display stats every 60 seconds
setInterval(async () => {
    const stats = server.getStats();
    console.log(`📊 Stats: ${stats.totalMiners} miners, ${stats.validShares}/${stats.totalShares} shares (${stats.efficiency}% efficiency)`);
   
    await server.db.logPoolStats(
        stats.totalMiners,
        stats.totalShares,
        stats.validShares,
        parseFloat(stats.efficiency),
        server.currentJob?.height || 0,
        server.cachedNetworkDifficulty || 0
    );
}, 60000);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down real stratum server...');
    
    if (server.monitor) {
        server.monitor.stop();
    }
    
    server.server.close(() => {
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    
    if (server.monitor) {
        server.monitor.stop();
    }
    
    server.server.close(() => {
        process.exit(0);
    });
});

module.exports = RealStratumServer;