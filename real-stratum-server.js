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
            difficulty: config.difficulty || 1,
            poolAddress: config.poolAddress || '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
            ...config
        };
       
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
                console.error(`❌ Invalid job: missing required fields (coinb1=${!!job.coinb1}, coinb2=${!!job.coinb2}, transactions=${!!job.transactions}, nbits=${!!job.ntime}, height=${!!job.height})`);
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

    /**
     * Convert difficulty to target value
     */
    difficultyToTarget(difficulty) {
        console.log(`🔧 difficultyToTarget called with: ${difficulty}`);
        
        if (difficulty <= 0) {
            difficulty = 0.00001;
        }
        
        // Bitcoin's maximum target (difficulty 1)
        const maxTargetHex = '00000000FFFF0000000000000000000000000000000000000000000000000000';
        const maxTarget = BigInt('0x' + maxTargetHex);
        
        const diffFloat = parseFloat(difficulty);
        let targetBig;
        
        if (diffFloat >= 1.0) {
            // For difficulty >= 1: target = maxTarget / floor(difficulty)
            const d = BigInt(Math.floor(diffFloat));
            targetBig = maxTarget / d;
        } else {
            // For difficulty < 1: target = maxTarget * (1 / difficulty)
            // Use scaling for precision (10^18)
            const scale = 1000000000000000000n; // 1e18
            const recipFloat = 1.0 / diffFloat;
            // Round to nearest integer for recip * scale
            const recipBigApprox = BigInt(Math.floor(recipFloat * Number(scale)) + 0.5);
            targetBig = (maxTarget * recipBigApprox) / scale;
            
            // Cap at maximum 256-bit value if overflow (all hashes would pass, but unlikely for your diffs)
            const maxUint256 = (1n << 256n) - 1n;
            if (targetBig > maxUint256) {
                targetBig = maxUint256;
            }
        }
        
        const targetHex = targetBig.toString(16).padStart(64, '0');
        console.log(`🔧 Computed target hex (first 16 chars): ${targetHex.substring(0, 16)}`);
        return Buffer.from(targetHex, 'hex');
    }

    /**
     * Check if hash meets target difficulty
     */
    meetsTarget(hash, target) {
        const reversedHash = Buffer.from(hash).reverse();
        return reversedHash.compare(target) <= 0;
    }

    adjustMinerDifficulty(miner) {
        const now = Date.now();
        const timeSinceLastAdjust = now - (miner.lastDifficultyAdjust || now);
        
        if (timeSinceLastAdjust < 60000) return;
        
        const targetSharesPerMinute = 6; // ~6 shares/min per miner
        const timeWindowMinutes = Math.min(timeSinceLastAdjust / 60000, 10);
        const actualSharesPerMinute = (miner.validShares || 0) / timeWindowMinutes;
        
        let newDifficulty = miner.difficulty;
        
        if (actualSharesPerMinute > targetSharesPerMinute * 1.5) {
            newDifficulty = miner.difficulty * 2;
        } else if (actualSharesPerMinute < targetSharesPerMinute * 0.5 && miner.validShares > 5) {
            newDifficulty = Math.max(miner.difficulty * 0.5, 0.001);
        }
        
        if (Math.abs(newDifficulty - miner.difficulty) / miner.difficulty > 0.1) {
            console.log(`🎯 Adjusting ${miner.username} difficulty: ${miner.difficulty.toFixed(6)} → ${newDifficulty.toFixed(6)}`);
            miner.difficulty = newDifficulty;
            miner.lastDifficultyAdjust = now;
            miner.validShares = 0;
            this.sendDifficulty(miner);
        }
    }

    handleConnection(socket) {
        const startTime = Date.now();
        const minerId = crypto.randomUUID();
        const miner = {
            id: minerId,
            socket: socket,
            subscribed: false,
            authorized: false,
            difficulty: 1, 
            lastActivity: Date.now(),
            address: socket.remoteAddress,
            shares: 0,
            validShares: 0,
            connectTime: startTime,
            rollingMask: null
        };

        this.miners.set(minerId, miner);
        console.log(`🔗 NEW CONNECTION: ${miner.address} (${minerId.substring(0, 8)})`);

        this.monitor.recordMinerConnection(minerId, 'new-connection', socket.remoteAddress);
        
        // Increase timeout for debugging
        socket.setTimeout(600000); // 10 minutes

        const keepAlive = setInterval(() => {
            if (socket.writable && !socket.destroyed) {
                // Don't send keepalive during debugging - it might interfere
                // socket.write('\n');
            } else {
                clearInterval(keepAlive);
            }
        }, 30000);        

        socket.on('data', (data) => {
            console.log(`📡 DATA EVENT for ${miner.address}`);
            this.handleData(minerId, data);
        });

        socket.on('close', () => {
            const duration = Date.now() - startTime;
            const avgTimePerShare = miner.shares > 0 ? duration / miner.shares : 0;
            
            console.log(`🔌 CONNECTION CLOSED: ${miner.address} (${minerId.substring(0, 8)})`);
            console.log(`   Duration: ${duration}ms`);
            console.log(`   Subscribed: ${miner.subscribed}`);
            console.log(`   Authorized: ${miner.authorized}`);
            console.log(`   Shares: ${miner.shares}`);
            
            this.db.logMinerDisconnection(miner.id);
            this.monitor.recordMinerDisconnection(miner.id, miner.username || 'unknown');
            
            clearInterval(keepAlive);
            this.miners.delete(minerId);
            socket.removeAllListeners();
        });

        socket.on('timeout', () => {
            console.log(`⏰ SOCKET TIMEOUT for ${miner.address}`);
            socket.destroy();
        });

        socket.on('error', (err) => {
            console.log(`💥 SOCKET ERROR for ${miner.address}: ${err.message}`);
            clearInterval(keepAlive);
            this.miners.delete(minerId);
            socket.destroy();
        });
        
        console.log(`🎯 Waiting for messages from ${miner.address}...`);
    }

    handleData(minerId, data) {
        const miner = this.miners.get(minerId);
        if (!miner) return;

        miner.lastActivity = Date.now();
        
        // DEBUG: Log all incoming data
        console.log(`📥 RAW DATA from ${miner.address}:`, data.toString().trim());
        
        const messages = data.toString().trim().split('\n');
        
        for (const messageStr of messages) {
            if (!messageStr.trim() || !messageStr.startsWith('{')) continue; // Skip non-JSON
            
            try {
                const message = JSON.parse(messageStr);
                console.log(`📨 PARSED MESSAGE from ${miner.address}:`, JSON.stringify(message));
                this.processMessage(minerId, message);
            } catch (err) {
                console.log(`⚠️ JSON PARSE ERROR from ${miner.address}:`, err.message);
                console.log(`⚠️ FAILED MESSAGE:`, messageStr);
                continue;
            }
        }
    }

    processMessage(minerId, message) {
        const miner = this.miners.get(minerId);
        if (!miner) return;

        const { method, params, id } = message;
        console.log(`🔄 PROCESSING ${method} from ${miner.address}`);

        switch (method) {
            case 'mining.subscribe':
                console.log(`🔄 PROCESSING mining.subscribe from ${miner.address}`);
                const subscriptionId = crypto.randomBytes(4).toString('hex');
                const extranonce1 = crypto.randomBytes(4).toString('hex');
                const extranonce2Size = 4; // Bytes, matches config (4B = 8 hex chars)

                miner.subscribed = true;
                miner.subscriptionId = subscriptionId;
                miner.extranonce1 = extranonce1;
                miner.extranonce2Size = extranonce2Size; // Store for validation
                miner.difficulty = 0.001; // Initial difficulty for S9 (~1 valid every ~111 ms at 13 TH/s)
                miner.shareCount = 0;
                miner.validShares = 0;
                miner.lastDifficultyAdjust = Date.now();

                const response = {
                    id: message.id,
                    result: [
                        [
                            ["mining.set_difficulty", subscriptionId],
                            ["mining.notify", subscriptionId]
                        ],
                        extranonce1, // 4 bytes = 8 hex
                        extranonce2Size // 4 bytes for miner-generated extranonce2
                    ],
                    error: null
                };
                this.sendMessage(miner.socket, response);
                this.sendDifficulty(miner);

                if (this.currentJob) {
                    this.sendJob(miner);
                }
                // Periodic job refresh to prevent timeout
                setInterval(() => {
                    if (miner.subscribed && miner.authorized && this.currentJob && miner.socket.writable && !miner.socket.destroyed) {
                        this.sendJob(miner);
                        console.log(`🔄 Sent job refresh to ${miner.address}`);
                    }
                }, 30000);
                console.log(`✅ Miner subscribed: ${miner.address} (extranonce1: ${extranonce1}, extranonce2_size: ${extranonce2Size}, difficulty: ${miner.difficulty})`);
                break;
            
            case 'mining.authorize':
                console.log(`🔐 Processing authorize from ${miner.address}`);
                this.handleAuthorize(miner, id, params);
                break;
            
            case 'mining.submit':
                console.log(`🔄 PROCESSING mining.submit from ${miner.address}`);
                const params = message.params;
                const jobId = params[1];
                let extranonce2 = params[2];
                const time = params[3];
                const nonce = params[4];
                const versionRolled = params[5] || null;

                console.log(`🔍 Validating share for ${miner.username}: jobId=${jobId}, extranonce2=${extranonce2}, time=${time}, nonce=${nonce}, versionRolled=${versionRolled}`);

                // Temporary fallback for empty extranonce2 (remove after confirming non-empty submits)
                if (!extranonce2 || extranonce2.length === 0) {
                    extranonce2 = '00000000'; // 4-byte zero pad
                    console.warn(`⚠️ Empty extranonce2 from ${miner.username}; using zero pad (remove after subscribe fix)`);
                }
                if (extranonce2.length !== miner.extranonce2Size * 2) {
                    console.error(`❌ Invalid extranonce2 length: ${extranonce2.length} (expected ${miner.extranonce2Size * 2})`);
                    this.sendError(socket, message.id, 23, `Invalid extranonce2 length: ${extranonce2.length}`);
                    return;
                }

                // Verify job exists
                if (!this.currentJob || this.currentJob.jobId !== jobId) {
                    console.error(`❌ Invalid jobId ${jobId} from ${miner.username}`);
                    this.sendError(socket, message.id, 21, 'Invalid job');
                    return;
                }

                // Version rolling check
                if (versionRolled && miner.rollingMask) {
                    const rolledVersion = parseInt(versionRolled, 16);
                    const mask = parseInt(miner.rollingMask, 16);
                    const baseVersion = parseInt(this.currentJob.version, 16);
                    if ((rolledVersion & mask) !== (rolledVersion & mask)) {
                        console.warn(`⚠️ Version rolling mismatch: ${versionRolled} (base: ${this.currentJob.version}, mask: ${miner.rollingMask})`);
                    }
                }

                // Build and validate block header
                const blockHeader = this.buildOptimizedBlockHeader(miner, extranonce2, time, nonce, versionRolled);
                const blockHash = this.calculateBlockHash(blockHeader);
                const coinbaseTx = this.reconstructCoinbase(miner, extranonce2);
                const coinbaseHash = this.doublesha256(coinbaseTx);
                const merkleRoot = this.calculateCorrectMerkleRoot(coinbaseHash.toString('hex'), this.currentJob.merkleSteps || []);

                console.log(`DEBUG Share: job=${jobId}, extranonce2=${extranonce2}, coinbaseHash=${coinbaseHash.toString('hex').substring(0, 16)}..., merkleRoot=${merkleRoot.substring(0, 16)}..., blockHash=${blockHash.toString('hex').substring(0, 16)}...`);

                // Validate share against pool difficulty
                const target = this.difficultyToTarget(miner.difficulty);
                const reversedHash = Buffer.from(blockHash).reverse();
                const meetsPoolDiff = this.meetsTarget(blockHash, target);

                // Validate against network difficulty (for block submission)
                const networkTarget = this.difficultyToTarget(this.cachedNetworkDifficulty || 73197670707408.73);
                const meetsNetworkDiff = this.meetsTarget(blockHash, networkTarget);

                console.log(`DEBUG Full reversed hash: ${reversedHash.toString('hex')}`);
                console.log(`DEBUG Full reversed target: ${target.toString('hex')}`);
                console.log(`DEBUG: Diff=${miner.difficulty}, Target=${target.toString('hex').substring(0, 16)}..., Hash=${reversedHash.toString('hex').substring(0, 16)}..., Compare=${reversedHash.compare(target)}`);

                // Queue share for batch processing
                const share = {
                    minerId: miner.id,
                    jobId: jobId,
                    nonce: nonce,
                    isValid: meetsPoolDiff,
                    meetsPoolDiff: meetsPoolDiff,
                    meetsNetworkDiff: meetsNetworkDiff,
                    blockHash: blockHash.toString('hex'),
                    processingTime: Date.now() - (miner.lastActivity || Date.now())
                };
                this.shareQueue.push(share);

                if (meetsPoolDiff) {
                    miner.validShares++;
                    console.log(`💎 Valid share: ${miner.username} found nonce ${nonce}`);
                    this.emit('validShare', { miner, nonce, jobId });
                    this.adjustMinerDifficulty(miner);
                } else {
                    console.log(`🔍 Share validation result: Invalid`);
                }

                this.sendMessage(socket, { id: message.id, result: meetsPoolDiff, error: meetsPoolDiff ? null : [-23, 'Invalid share', null] });

                // Handle block submission if meets network difficulty
                if (meetsNetworkDiff) {
                    console.log(`🎉 Potential block found by ${miner.username}! Submitting...`);
                    const blockHex = this.buildFullBlock(blockHeader, miner, extranonce2);
                    this.bitcoin.submitBlock(blockHex).then(result => {
                        console.log(`Block submission result: ${JSON.stringify(result)}`);
                        if (!result || result === 'inconclusive') {
                            this.db.logBlockFound(miner.id, blockHash.toString('hex'), this.currentJob.height);
                        }
                    }).catch(error => {
                        console.error(`❌ Block submission failed: ${error.message}`);
                    });
                }
                break;
            
            case 'mining.configure':
                console.log(`🔄 PROCESSING mining.configure from ${remoteAddress}`);
                if (!message || !message.params || !Array.isArray(message.params) || message.params.length < 2) {
                    console.error(`❌ Invalid mining.configure params from ${remoteAddress}: ${JSON.stringify(message)}`);
                    this.sendError(socket, message.id, 20, 'Invalid configure params');
                    return;
                }
                const configParams = message.params[1] || {};
                if (configParams['version-rolling'] && configParams['version-rolling.mask']) {
                    miner.rollingMask = configParams['version-rolling.mask'];
                    console.log(`🔄 Using miner's requested mask: ${miner.rollingMask}`);
                } else {
                    miner.rollingMask = '1fffe000'; // Default mask
                    console.log(`🔄 No version-rolling mask provided; using default: ${miner.rollingMask}`);
                }
                const configResponse = {
                    id: message.id,
                    result: {
                        'version-rolling': !!miner.rollingMask,
                        'version-rolling.mask': miner.rollingMask,
                        'minimum-difficulty': true,
                        'subscribe-extranonce': false
                    },
                    error: null
                };
                this.sendMessage(socket, configResponse);
                console.log(`✅ Sent configure response to ${remoteAddress} with mask ${miner.rollingMask}`);
                break;

            default:
                console.log(`❓ Unknown method: ${method} from ${miner.address}`);
                this.sendError(miner.socket, id, -3, 'Method not found');
        }
    }

    handleSubscribe(miner, id, params) {
        const subscriptionId = crypto.randomBytes(4).toString('hex');
        const extranonce1 = crypto.randomBytes(4).toString('hex');
        const extranonce2Size = 4; // Bytes, matches your config (4B = 8 hex chars)

        miner.subscribed = true;
        miner.subscriptionId = subscriptionId;
        miner.extranonce1 = extranonce1;
        miner.extranonce2Size = extranonce2Size; // Store for validation
        miner.difficulty = 0.001; // Initial difficulty for S9 (~1 valid every ~111 ms at 13 TH/s)
        miner.shareCount = 0;
        miner.validShares = 0;
        miner.lastDifficultyAdjust = Date.now();

        const response = {
            id: id,
            result: [
                [
                    ["mining.set_difficulty", subscriptionId],
                    ["mining.notify", subscriptionId]
                ],
                extranonce1, // 4 bytes = 8 hex
                extranonce2Size // 4 bytes for miner-generated extranonce2
            ],
            error: null
        };
        this.sendMessage(miner.socket, response);
        this.sendDifficulty(miner);

        if (this.currentJob) {
            this.sendJob(miner);
        }
        // Periodic job refresh to prevent timeout
        setInterval(() => {
            if (miner.subscribed && miner.authorized && this.currentJob && miner.socket.writable && !miner.socket.destroyed) {
                this.sendJob(miner);
                console.log(`🔄 Sent job refresh to ${miner.address}`);
            }
        }, 30000);
        console.log(`✅ Miner subscribed: ${miner.address} (extranonce1: ${extranonce1}, extranonce2_size: ${extranonce2Size}, difficulty: ${miner.difficulty})`);
    }

    handleAuthorize(miner, id, params) {
        const [username, password] = params;
        
        miner.authorized = true;
        miner.username = username;
        
        this.db.logMinerConnection(miner.id, username, miner.address);
        
        const response = {
            id: id,
            result: true,
            error: null
        };

        this.sendMessage(miner.socket, response);
        this.sendDifficulty(miner);
        
        console.log(`Miner authorized: ${username} from ${miner.address} - Using difficulty ${miner.difficulty}`);
    }

    async handleSubmit(miner, id, params) {
        if (!miner.authorized) {
            this.sendError(miner.socket, id, -24, 'Unauthorized worker');
            return;
        }

        const [username, jobId, extranonce2, time, nonce, versionRolled = null] = params;  // Capture 6th param
        miner.shares++;
        
        // Pass versionRolled to validateShare
        const isValid = await this.validateShare(miner, jobId, extranonce2, time, nonce, versionRolled);
        
        if (isValid) {
            miner.validShares++;
            this.adjustMinerDifficulty(miner);
        }
        
        const response = {
            id: id,
            result: isValid,
            error: isValid ? null : [-23, 'Invalid share', null]
        };

        this.sendMessage(miner.socket, response);
        
        if (isValid) {
            console.log(`✅ Valid share from ${username} (${miner.validShares}/${miner.shares})`);
            this.emit('validShare', { miner, jobId, nonce });
        }
    }
        
    async validateShare(miner, jobId, extranonce2, time, nonce, versionRolled = null) {
        console.log(`🔍 Validating share for ${miner.username}: jobId=${jobId}, extranonce2=${extranonce2}, time=${time}, nonce=${nonce}, versionRolled=${versionRolled}`);
        
        if (!this.currentJob || jobId !== this.currentJob.jobId) {
            console.log(`❌ Invalid share: Job ${jobId} not found or stale`);
            return false;
        }
        
        if ((extranonce2 !== '' && !/^[0-9a-fA-F]+$/.test(extranonce2)) || 
            !time || !nonce || !/^[0-9a-fA-F]+$/.test(time) || !/^[0-9a-fA-F]+$/.test(nonce)) {
            console.log(`❌ Invalid share: Malformed parameters (extranonce2=${extranonce2}, time=${time}, nonce=${nonce})`);
            return false;
        }
        
        if (versionRolled) {
            if (!/^[0-9a-fA-F]{8}$/.test(versionRolled)) {
                console.log(`❌ Invalid share: Malformed versionRolled=${versionRolled}`);
                return false;
            }
            const version = parseInt(versionRolled, 16);
            const baseVersion = parseInt(this.currentJob.version, 16);
            const mask = parseInt(miner.rollingMask || '1fffe000', 16);
            if ((version & ~mask) !== (baseVersion & ~mask)) {
                console.log(`⚠️ Version rolling mismatch (relaxed accept): ${versionRolled} (base: ${this.currentJob.version}, mask: ${miner.rollingMask})`);
            } else {
                console.log(`✅ Version rolling valid: ${versionRolled} matches mask ${miner.rollingMask}`);
            }
        }
        
        try {
            const blockHeader = this.buildOptimizedBlockHeader(miner, extranonce2, time, nonce, versionRolled);
            const hash = this.calculateBlockHash(blockHeader);
            
            // Real pool difficulty check (no cap)
            const poolTarget = this.difficultyToTarget(miner.difficulty);
            
            const reversedHash = Buffer.from(hash).reverse();
            const reversedTarget = poolTarget.reverse();
            
            console.log(`DEBUG Full reversed hash: ${reversedHash.toString('hex')}`);
            console.log(`DEBUG Full reversed target: ${reversedTarget.toString('hex')}`);
            console.log(`DEBUG: Diff=${miner.difficulty}, Target=${reversedTarget.toString('hex').substring(0, 16)}..., Hash=${reversedHash.toString('hex').substring(0, 16)}..., Compare=${reversedHash.compare(reversedTarget)}`);
            
            const meetsPoolDifficulty = reversedHash.compare(reversedTarget) <= 0;
            
            let meetsNetworkDifficulty = false;
            if (meetsPoolDifficulty) {
                const networkDifficulty = await this.getNetworkTarget();
                const networkTarget = this.difficultyToTarget(networkDifficulty);
                const reversedNetworkTarget = networkTarget.reverse();
                meetsNetworkDifficulty = reversedHash.compare(reversedNetworkTarget) <= 0;
                
                if (meetsNetworkDifficulty) {
                    console.log('🎉 BLOCK FOUND!');
                    const blockHash = reversedHash.toString('hex');
                    await this.db.logBlockFound(miner.id, blockHash, this.currentJob.height);
                    await this.submitFoundBlock(blockHeader, miner, extranonce2);
                }
            }
            
            this.shareQueue.push({
                minerId: miner.id,
                jobId,
                nonce,
                isValid: meetsPoolDifficulty,
                meetsPoolDiff: meetsPoolDifficulty,
                meetsNetworkDiff: meetsNetworkDifficulty,
                blockHash: reversedHash.toString('hex'),
                processingTime: Date.now() - miner.lastActivity
            });
            console.log(`Share queued: valid=${meetsPoolDifficulty}`);
            
            console.log(`🔍 Share validation result: ${meetsPoolDifficulty ? 'Valid' : 'Invalid'}`);
            return meetsPoolDifficulty;
        } catch (error) {
            console.error(`❌ Share validation error for ${miner.username}:`, error.message);
            return false;
        }
    }

    encodeVarint(num) {
        if (num < 0xFD) {
            return Buffer.from([num]).toString('hex');
        } else if (num <= 0xFFFF) {
            return Buffer.from([0xFD, num & 0xFF, (num >> 8) & 0xFF]).toString('hex');
        } else if (num <= 0xFFFFFFFF) {
            return Buffer.from([0xFE, num & 0xFF, (num >> 8) & 0xFF, (num >> 16) & 0xFF, (num >> 24) & 0xFF]).toString('hex');
        } else {
            throw new Error('Transaction count too large for varint encoding');
        }
    }

    reconstructCoinbase(miner, extranonce2) {
        try {
            const job = this.currentJob;
            
            if (!job || !job.coinb1 || !job.coinb2 || !miner.extranonce1) {
                throw new Error('Missing coinbase components: job, coinb1, coinb2, or extranonce1');
            }
            
            // Calculate scriptSig extranonce length (extranonce1 is 4 bytes, extranonce2 is 0 if empty)
            let scriptSigLen = miner.extranonce1.length / 2; // Bytes (4 for extranonce1)
            if (extranonce2 && extranonce2 !== '') {
                scriptSigLen += extranonce2.length / 2; // Add extranonce2 bytes
            }
            
            // Parse coinb1: typically version (4 bytes) + input count (1 byte) + prevout (36 bytes) + scriptSigLen (1 byte) + scriptSig
            // Remove last byte of coinb1 (scriptSigLen) and append correct length
            let coinb1Prefix = job.coinb1.substring(0, job.coinb1.length - 2);
            const lengthHex = scriptSigLen.toString(16).padStart(2, '0'); // e.g., '04' for 4 bytes
            let coinbaseTx = coinb1Prefix + lengthHex + miner.extranonce1;
            
            // Append extranonce2 if non-empty
            if (extranonce2 && extranonce2 !== '') {
                coinbaseTx += extranonce2;
            }
            
            // Append coinb2 (outputs, typically 1 output to pool address)
            coinbaseTx += job.coinb2;
            
            // Add SegWit witness commitment (mandatory for Bitcoin Core post-2016)
            const witnessRoot = this.calculateCorrectMerkleRoot([...job.merkleSteps, '0000000000000000000000000000000000000000000000000000000000000000']);
            const witnessCommitment = '6a24aa21a9ed' + witnessRoot; // OP_RETURN + 36-byte commitment
            coinbaseTx += witnessCommitment;
            
            // Validate hex
            if (!/^[0-9a-fA-F]+$/.test(coinbaseTx)) {
                throw new Error('Invalid hex format in coinbase transaction');
            }
            
            console.log(`✅ Coinbase reconstructed: length=${coinbaseTx.length} chars, extranonce length=${scriptSigLen} bytes, witness=generated`);
            return coinbaseTx;
        } catch (error) {
            console.error('Coinbase reconstruction error:', error.message);
            return null;
        }
    }
    buildFullBlock(header, miner, extranonce2) {
        try {
            const headerBuffer = Buffer.isBuffer(header) ? header : Buffer.from(header, 'hex');
            
            if (headerBuffer.length !== 80) {
                throw new Error(`Invalid block header length: ${headerBuffer.length}, expected 80 bytes`);
            }
            
            const transactions = this.currentJob.transactions || [];
            const txCount = transactions.length + 1; // +1 for coinbase
            
            const blockParts = [];
            
            // Block header (80 bytes)
            blockParts.push(headerBuffer);
            
            // Transaction count (varint)
            const txCountHex = this.encodeVarint(txCount);
            const txCountBuffer = Buffer.from(txCountHex, 'hex');
            blockParts.push(txCountBuffer);
            
            // Coinbase transaction
            const coinbaseTx = this.reconstructCoinbase(miner, extranonce2);
            if (!coinbaseTx) {
                throw new Error('Failed to reconstruct coinbase transaction');
            }
            const coinbaseBuffer = Buffer.from(coinbaseTx, 'hex');
            blockParts.push(coinbaseBuffer);
            
            // Other transactions
            for (let i = 0; i < transactions.length; i++) {
                const tx = transactions[i];
                if (!tx.data || !/^[0-9a-fA-F]+$/.test(tx.data)) {
                    throw new Error(`Transaction ${i} missing or invalid data field`);
                }
                blockParts.push(Buffer.from(tx.data, 'hex'));
            }
            
            const blockBuffer = Buffer.concat(blockParts);
            
            if (blockBuffer.length > 4000000) {
                throw new Error(`Block size ${blockBuffer.length} exceeds 4MB limit`);
            }
            
            const blockHex = blockBuffer.toString('hex');
            console.log(`✅ Block constructed: size=${blockBuffer.length} bytes, tx count=${txCount}`);
            console.log(`DEBUG Block hex (first 200 chars): ${blockHex.substring(0, 200)}...`);
            return blockHex;
        } catch (error) {
            console.error('Block construction failed:', error.message);
            return null;
        }
    }

    async submitFoundBlock(blockHeader, miner, extranonce2) {
        try {
            console.log('Constructing complete block for submission...');
            
            const blockHex = this.buildFullBlock(blockHeader, miner, extranonce2);
            
            if (!blockHex) {
                console.error('Failed to construct complete block - submission aborted');
                return null;
            }
            
            console.log('Submitting block to Bitcoin network...');
            console.log(`Block size: ${blockHex.length / 2} bytes`);
            
            const result = await this.bitcoin.callRpc('submitblock', [blockHex]);
            
            if (result === null) {
                console.log('🎉 BLOCK ACCEPTED BY BITCOIN NETWORK! 🎉');
                console.log('Block reward (3.125 BTC + fees) will arrive at:', this.bitcoin.poolAddress);
                
                const blockHash = this.calculateBlockHash(blockHeader).reverse().toString('hex');
                this.monitor.recordBlockSubmission(blockHash, this.currentJob.height, miner.id);
                
                const timestamp = new Date().toISOString();
                const logEntry = `${timestamp}: BLOCK FOUND - Hash: ${blockHash}, Size: ${blockHex.length / 2} bytes\n`;
                
                require('fs').appendFileSync('./logs/blocks-found.log', logEntry);
                
            } else {
                console.error('Block rejected by network:', result);
                
                const timestamp = new Date().toISOString();
                const logEntry = `${timestamp}: BLOCK REJECTED - Reason: ${result}, Size: ${blockHex.length / 2} bytes\n`;
                require('fs').appendFileSync('./logs/blocks-rejected.log', logEntry);
            }
            
            return result;
            
        } catch (error) {
            console.error('Block submission failed:', error.message);
            return null;
        }
    }

    buildOptimizedBlockHeader(miner, extranonce2, time, nonce, versionRolled = null) {
        const job = this.currentJob;
        
        if (!job.cachedCoinbaseTemplate) {
            job.cachedCoinbaseTemplate = Buffer.concat([
                Buffer.from(job.coinb1, 'hex'),
                Buffer.from(miner.extranonce1, 'hex')
            ]);
        }
        
        const coinbase = Buffer.concat([
            job.cachedCoinbaseTemplate,
            Buffer.from(extranonce2, 'hex'),
            Buffer.from(job.coinb2, 'hex')
        ]);
        
        const coinbaseHash = this.doublesha256(coinbase);
        const merkleRoot = this.calculateCorrectMerkleRoot(coinbaseHash.toString('hex'), job.merkleSteps || []);
        console.log(`DEBUG Merkle: coinbaseHash=${coinbaseHash.toString('hex').substring(0, 16)}..., root=${merkleRoot.substring(0, 16)}...`);
        
        const header = Buffer.alloc(80);
        let offset = 0;
        
        // Version: LE, apply version rolling
        const version = versionRolled ? (parseInt(job.version, 16) | (parseInt(versionRolled, 16) & parseInt(miner.rollingMask, 16))) : parseInt(job.version, 16);
        header.writeUInt32LE(version, offset);
        console.log(`DEBUG Header: version=0x${version.toString(16).padStart(8, '0')} (LE)`);
        offset += 4;
        
        // Prev block hash: LE bytes (job.prevHash is already reversed hex)
        const prevHashBuf = Buffer.from(job.prevHash, 'hex');
        prevHashBuf.copy(header, offset);
        console.log(`DEBUG Header: prevHash=${job.prevHash.substring(0, 16)}... (LE)`);
        offset += 32;
        
        // Merkle root: LE bytes (root is BE hex, reverse for header)
        Buffer.from(merkleRoot, 'hex').reverse().copy(header, offset);
        console.log(`DEBUG Header: merkleRoot=${merkleRoot.substring(0, 16)}... (BE, reversed to LE)`);
        offset += 32;
        
        // Timestamp: LE
        header.writeUInt32LE(parseInt(time, 16), offset);
        console.log(`DEBUG Header: time=0x${time} (LE)`);
        offset += 4;
        
        // Difficulty bits: LE
        header.writeUInt32LE(parseInt(job.nbits, 16), offset);
        console.log(`DEBUG Header: nbits=${job.nbits} (LE)`);
        offset += 4;
        
        // Nonce: LE
        header.writeUInt32LE(parseInt(nonce, 16), offset);
        console.log(`DEBUG Header: nonce=0x${nonce} (LE)`);
        
        console.log(`DEBUG Constructed header: ${header.toString('hex').substring(0, 80)}...`);
        return header;
    }

    calculateBlockHash(header) {
        return this.doublesha256(header);
    }

    doublesha256(data) {
        const crypto = require('crypto');
        const hash1 = crypto.createHash('sha256').update(data).digest();
        const hash2 = crypto.createHash('sha256').update(hash1).digest();
        return hash2;
    }

    calculateCorrectMerkleRoot(coinbaseHashHex, merkleSteps) {
        if (!merkleSteps || merkleSteps.length === 0) {
            console.log(`DEBUG Merkle: No steps, using coinbaseHash=${coinbaseHashHex.substring(0, 16)}...`);
            return coinbaseHashHex;
        }
        let root = coinbaseHashHex;
        for (let i = 0; i < merkleSteps.length; i++) {
            const left = Buffer.from(root, 'hex').reverse(); // LE for hashing
            const right = Buffer.from(merkleSteps[i], 'hex').reverse(); // LE
            const combined = Buffer.concat([left, right]);
            const hash = this.doublesha256(combined);
            root = hash.reverse().toString('hex'); // BE hex for Stratum
            console.log(`DEBUG Merkle step ${i}: left=${left.toString('hex').substring(0, 16)}..., right=${right.toString('hex').substring(0, 16)}..., root=${root.substring(0, 16)}...`);
        }
        return root;
    }

    startBatchProcessor() {
        setInterval(async () => {
            console.log(`🕒 Batch processor tick, queue size: ${this.shareQueue.length}`);
            if (this.shareQueue.length > 0) {
                const batch = this.shareQueue.splice(0, 5000); // Handle 500 TH/s
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
        if (!this.currentJob || !miner.subscribed) return;

        const message = {
            id: null,
            method: 'mining.notify',
            params: [
                this.currentJob.jobId,
                this.currentJob.prevHash,
                this.currentJob.coinb1,
                this.currentJob.coinb2,
                this.currentJob.merkleSteps,
                this.currentJob.version,
                this.currentJob.nbits,
                this.currentJob.ntime,
                true
            ]
        };
        this.sendMessage(miner.socket, message);
    }

    broadcastJob(jobData) {
        this.currentJob = jobData;
        
        for (const [minerId, miner] of this.miners) {
            if (miner.subscribed && miner.authorized) {
                this.sendJob(miner);
            }
        }
        
        console.log(`Broadcasted job ${jobData.jobId} to ${this.miners.size} miners`);
    }

    sendMessage(socket, message) {
        try {
            if (socket && socket.writable && !socket.destroyed) {
                const data = JSON.stringify(message) + '\n';
                console.log(`📤 SENDING:`, JSON.stringify(message));
                socket.write(data, (err) => {
                    if (err) {
                        console.log(`❌ Write error: ${err.message}`);
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
    difficulty: 1,
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