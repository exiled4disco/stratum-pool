const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const BitcoinConnector = require('./bitcoin-connector');

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
    }

    async start() {
        // Test Bitcoin connection first
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

        // Get initial work
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
        try {
            const info = await this.bitcoin.callRpc('getblockchaininfo');
            return info.difficulty;
        } catch (error) {
            console.error('Error getting network difficulty:', error);
            return 73197670707408.73; // fallback
        }
    }

    async updateWork() {
        try {
            const job = await this.bitcoin.getBlockTemplate();
            if (job && (!this.currentJob || job.height !== this.currentJob.height)) {
                // Clear cached templates when new block arrives
                if (this.currentJob) {
                    delete this.currentJob.cachedCoinbaseTemplate;
                }
                
                this.currentJob = job;
                this.broadcastJob(job);
                console.log(`New work created for block height ${job.height}`);
            }
        } catch (error) {
            console.error('Failed to update work:', error.message);
        }
    }

    setupServer() {
        this.server.on('connection', this.handleConnection.bind(this));
        this.server.on('error', (err) => {
            console.error('Server error:', err);
        });
    }

    handleConnection(socket) {
        const startTime = Date.now();
        const minerId = crypto.randomUUID();
        const miner = {
            id: minerId,
            socket: socket,
            subscribed: false,
            authorized: false,
            difficulty: 0.000001,
            lastActivity: Date.now(),
            address: socket.remoteAddress,
            shares: 0,
            validShares: 0,
            connectTime: startTime
        };

        this.miners.set(minerId, miner);
        console.log(`New connection: ${miner.address} (${minerId.substring(0, 8)})`);

        // Set socket timeout to prevent hanging connections
        socket.setTimeout(120000); // 2 minutes

        const keepAlive = setInterval(() => {
            if (socket.writable && !socket.destroyed) {
                socket.write('\n');
            } else {
                clearInterval(keepAlive);
            }
        }, 30000);        

        socket.on('data', (data) => {
            this.handleData(minerId, data);
        });

        socket.on('close', () => {
            const duration = Date.now() - startTime;
            const avgTimePerShare = miner.shares > 0 ? duration / miner.shares : 0;
            console.log(`Connection lasted ${duration}ms, ${miner.shares} shares, ${avgTimePerShare.toFixed(0)}ms/share average`);
            
            // Cleanup
            clearInterval(keepAlive);
            this.miners.delete(minerId);
            socket.removeAllListeners();
            
            console.log(`Miner disconnected: ${miner.address} (${minerId.substring(0, 8)}) - ${miner.validShares}/${miner.shares} valid shares`);
        });

        socket.on('timeout', () => {
            console.log(`Socket timeout for ${miner.address}`);
            socket.destroy();
        });

        socket.on('error', (err) => {
            clearInterval(keepAlive);
            console.error(`Socket error for ${miner.address}:`, err.message);
            this.miners.delete(minerId);
            socket.destroy();
        });
    }

    handleData(minerId, data) {
        const miner = this.miners.get(minerId);
        if (!miner) return;

        miner.lastActivity = Date.now();

        const messages = data.toString().trim().split('\n');
        
        for (const messageStr of messages) {
            if (!messageStr.trim()) continue;
            
            try {
                const message = JSON.parse(messageStr);
                console.log(`Received from ${miner.address}:`, JSON.stringify(message));
                this.processMessage(minerId, message);
            } catch (err) {
                // Silently ignore malformed JSON - S9 sends some non-JSON data
                continue;
            }
        }
    }

    processMessage(minerId, message) {
        const miner = this.miners.get(minerId);
        if (!miner) return;

        const { method, params, id } = message;

        switch (method) {
            case 'mining.subscribe':
                this.handleSubscribe(miner, id, params);
                break;
            
            case 'mining.authorize':
                this.handleAuthorize(miner, id, params);
                break;
            
            case 'mining.submit':
                this.handleSubmit(miner, id, params);
                break;
            
            case 'mining.configure':
                const configResponse = {
                    id: id,
                    result: {
                        "version-rolling": true,
                        "version-rolling.mask": "1fffe000",
                        "minimum-difficulty": true,
                        "subscribe-extranonce": false
                    },
                    error: null
                };
                this.sendMessage(miner.socket, configResponse);
                console.log(`Configure request handled for ${miner.address}`);
                break;

            default:
                console.log(`Unknown method: ${method}`);
                this.sendError(miner.socket, id, -3, 'Method not found');
        }
    }

    handleSubscribe(miner, id, params) {
        const subscriptionId = crypto.randomBytes(4).toString('hex');
        const extranonce1 = crypto.randomBytes(4).toString('hex');
        
        miner.subscribed = true;
        miner.subscriptionId = subscriptionId;
        miner.extranonce1 = extranonce1;

        const response = {
            id: id,
            result: [
                [
                    ["mining.set_difficulty", subscriptionId],
                    ["mining.notify", subscriptionId]
                ],
                extranonce1,
                4
            ],
            error: null
        };

        this.sendMessage(miner.socket, response);
        this.sendDifficulty(miner);
        
        if (this.currentJob) {
            this.sendJob(miner);
        }

        console.log(`Miner subscribed: ${miner.address} (${miner.id.substring(0, 8)})`);
    }

    handleAuthorize(miner, id, params) {
        const [username, password] = params;
        
        miner.authorized = true;
        miner.username = username;
        
        const response = {
            id: id,
            result: true,
            error: null
        };

        this.sendMessage(miner.socket, response);
        console.log(`Miner authorized: ${username} from ${miner.address}`);
    }

    async handleSubmit(miner, id, params) {
        if (!miner.authorized) {
            this.sendError(miner.socket, id, -24, 'Unauthorized worker');
            return;
        }

        const [username, jobId, extranonce2, time, nonce] = params;
        miner.shares++;
        
        console.log(`Share submitted by ${username}: job=${jobId}, nonce=${nonce}`);
        
        // For now, accept all shares - real validation would check proof-of-work
        const isValid = await this.validateShare(miner, jobId, extranonce2, time, nonce);
        
        if (isValid) {
            miner.validShares++;
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
        } else {
            console.log(`❌ Invalid share from ${username} (${miner.validShares}/${miner.shares})`);
        }
    }

    async validateShare(miner, jobId, extranonce2, time, nonce) {
        if (!this.currentJob) {
            console.error('No current job available for share validation');
            return false;
        }
        if (jobId !== this.currentJob.jobId) {
            console.warn(`Invalid job ID ${jobId}; expected ${this.currentJob.jobId}`);
            return false;
        }

        // Input validation
        if (!miner || !extranonce2 || !time || !nonce || 
            !/^[0-9a-fA-F]+$/.test(extranonce2) || !/^[0-9a-fA-F]+$/.test(nonce)) {
            console.error('Invalid share parameters');
            return false;
        }

        try {
            // Use cached header template and only update nonce/time
            const blockHeader = this.buildOptimizedBlockHeader(miner, extranonce2, time, nonce);
            const hash = this.calculateBlockHash(blockHeader);
            const reversedHash = Buffer.from(hash).reverse();

            console.log(`Hash: ${reversedHash.toString('hex').substring(0, 20)}...`);
            
            // Check pool difficulty
            const poolTarget = Buffer.from('ff00000000000000000000000000000000000000000000000000000000000000', 'hex');
            const meetsPoolDifficulty = reversedHash.compare(poolTarget) <= 0;
            
            console.log(`Meets pool difficulty: ${meetsPoolDifficulty}`);

            // Check network difficulty with real-time difficulty
            const networkDifficulty = await this.getNetworkTarget();
            const networkTarget = this.difficultyToTarget(networkDifficulty);
            const meetsNetworkDifficulty = reversedHash.compare(networkTarget) <= 0;

            console.log(`Meets network difficulty: ${meetsNetworkDifficulty}`);

            if (meetsNetworkDifficulty) {
                console.log('🎉 BLOCK FOUND! Hash:', reversedHash.toString('hex'));
                await this.submitFoundBlock(blockHeader, miner, extranonce2);
            }

            return meetsPoolDifficulty;
        } catch (error) {
            console.error('Validation error:', error.message);
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
            
            // Validate required components
            if (!job.coinb1 || !job.coinb2 || !miner.extranonce1 || !extranonce2) {
                throw new Error('Missing coinbase components');
            }
            
            // Construct coinbase transaction: coinb1 + extranonce1 + extranonce2 + coinb2
            let coinbaseTx = job.coinb1 + miner.extranonce1 + extranonce2 + job.coinb2;
            
            // Add witness commitment for SegWit blocks if available
            if (job.default_witness_commitment) {
                coinbaseTx += job.default_witness_commitment;
            }
            
            // Validate hex format
            if (!/^[0-9a-fA-F]+$/.test(coinbaseTx)) {
                throw new Error('Invalid hex format in coinbase transaction');
            }
            
            return coinbaseTx;
        } catch (error) {
            console.error('Coinbase reconstruction error:', error.message);
            return null;
        }
    }

    buildFullBlock(header, miner, extranonce2) {
        try {
            // Normalize header input
            const headerBuffer = Buffer.isBuffer(header) ? header : Buffer.from(header, 'hex');
            
            if (headerBuffer.length !== 80) {
                throw new Error(`Invalid block header length: ${headerBuffer.length}, expected 80 bytes`);
            }
            
            // Get and validate transactions from block template
            const transactions = this.currentJob.transactions || [];
            const txCount = transactions.length + 1; // +1 for coinbase
            
            console.log(`Building block with ${txCount} transactions (${transactions.length} + coinbase)`);
            
            // Build block parts using Buffer array for efficiency
            const blockParts = [];
            
            // 1. Block header (80 bytes)
            blockParts.push(headerBuffer);
            
            // 2. Transaction count (varint)
            const txCountBuffer = Buffer.from(this.encodeVarint(txCount), 'hex');
            blockParts.push(txCountBuffer);
            
            // 3. Coinbase transaction
            const coinbaseTx = this.reconstructCoinbase(miner, extranonce2);
            if (!coinbaseTx) {
                throw new Error('Failed to reconstruct coinbase transaction');
            }
            
            // Validate coinbase transaction hex
            if (!/^[0-9a-fA-F]+$/.test(coinbaseTx)) {
                throw new Error('Invalid coinbase transaction hex format');
            }
            
            blockParts.push(Buffer.from(coinbaseTx, 'hex'));
            console.log(`Added coinbase transaction: ${coinbaseTx.length / 2} bytes`);
            
            // 4. Add other transactions from block template
            for (let i = 0; i < transactions.length; i++) {
                const tx = transactions[i];
                
                if (!tx.data) {
                    throw new Error(`Transaction ${i} missing data field`);
                }
                
                if (!/^[0-9a-fA-F]+$/.test(tx.data)) {
                    throw new Error(`Transaction ${i} has invalid hex format`);
                }
                
                blockParts.push(Buffer.from(tx.data, 'hex'));
            }
            
            // 5. Concatenate all parts
            const blockBuffer = Buffer.concat(blockParts);
            
            // 6. Validate block size constraints
            if (blockBuffer.length > 4000000) { // 4MB weight limit
                throw new Error(`Block size ${blockBuffer.length} exceeds 4MB limit`);
            }
            
            if (blockBuffer.length > 1000000) { // 1MB legacy serialized size
                console.warn(`Block size ${blockBuffer.length} exceeds 1MB legacy limit`);
            }
            
            const blockHex = blockBuffer.toString('hex');
            
            console.log(`Block constructed successfully:`);
            console.log(`- Header: 80 bytes`);
            console.log(`- Transactions: ${txCount}`);
            console.log(`- Total size: ${blockBuffer.length} bytes`);
            console.log(`- Block hash: ${this.calculateBlockHash(headerBuffer).reverse().toString('hex')}`);
            
            return blockHex;
            
        } catch (error) {
            console.error('Block construction failed:', {
                message: error.message,
                header: header ? (Buffer.isBuffer(header) ? header.toString('hex').slice(0, 32) + '...' : header.slice(0, 32) + '...') : 'undefined',
                txCount: this.currentJob ? (this.currentJob.transactions || []).length + 1 : 'unknown',
                jobId: this.currentJob ? this.currentJob.jobId : 'no current job'
            });
            return null;
        }
    }

    async submitFoundBlock(blockHeader, miner, extranonce2) {
        try {
            console.log('Constructing complete block for submission...');
            
            // Build the complete block
            const blockHex = this.buildFullBlock(blockHeader, miner, extranonce2);
            
            if (!blockHex) {
                console.error('Failed to construct complete block - submission aborted');
                return null;
            }
            
            console.log('Submitting block to Bitcoin network...');
            console.log(`Block size: ${blockHex.length / 2} bytes`);
            
            // Submit block to Bitcoin Core
            const result = await this.bitcoin.callRpc('submitblock', [blockHex]);
            
            if (result === null) {
                // Successful submission
                console.log('🎉 BLOCK ACCEPTED BY BITCOIN NETWORK! 🎉');
                console.log('Block reward (3.125 BTC + fees) will arrive at:', this.bitcoin.poolAddress);
                console.log('Block hex:', blockHex.slice(0, 160) + '...');
                
                // Log to file for permanent record
                const timestamp = new Date().toISOString();
                const blockHash = this.calculateBlockHash(blockHeader).reverse().toString('hex');
                const logEntry = `${timestamp}: BLOCK FOUND - Hash: ${blockHash}, Size: ${blockHex.length / 2} bytes\n`;
                
                require('fs').appendFileSync('./logs/blocks-found.log', logEntry);
                
            } else {
                // Block was rejected
                console.error('Block rejected by network:', result);
                console.error('Rejection reason code:', result);
                
                // Log rejection for analysis
                const timestamp = new Date().toISOString();
                const logEntry = `${timestamp}: BLOCK REJECTED - Reason: ${result}, Size: ${blockHex.length / 2} bytes\n`;
                require('fs').appendFileSync('./logs/blocks-rejected.log', logEntry);
            }
            
            return result;
            
        } catch (error) {
            console.error('Block submission failed:', error.message);
            console.error('Error details:', error.stack);
            
            // Log submission errors
            const timestamp = new Date().toISOString();
            const logEntry = `${timestamp}: BLOCK SUBMISSION ERROR - ${error.message}\n`;
            require('fs').appendFileSync('./logs/blocks-errors.log', logEntry);
            
            return null;
        }
    }
        buildBlockHeader(miner, extranonce2, time, nonce) {
            const job = this.currentJob;
            
            // Construct coinbase transaction with miner's extranonce
            const coinbase = Buffer.concat([
                Buffer.from(job.coinb1, 'hex'),
                Buffer.from(miner.extranonce1, 'hex'),
                Buffer.from(extranonce2, 'hex'),
                Buffer.from(job.coinb2, 'hex')
            ]);
            
            // Calculate coinbase hash
            const coinbaseHash = this.doublesha256(coinbase);
            
            // Build merkle root
            const merkleRoot = this.calculateCorrectMerkleRoot([coinbaseHash.toString('hex'), ...job.merkleSteps]);
            
            // Construct 80-byte block header
            const header = Buffer.alloc(80);
            let offset = 0;
            
            // Version (4 bytes, little endian)
            header.writeUInt32LE(parseInt(job.version, 16), offset);
            offset += 4;
            
            // Previous block hash (32 bytes, reverse byte order)
            Buffer.from(job.prevHash, 'hex').reverse().copy(header, offset);
            offset += 32;
            
            // Merkle root (32 bytes, reverse byte order)
            Buffer.from(merkleRoot, 'hex').reverse().copy(header, offset);
            offset += 32;
            
            // Timestamp (4 bytes, little endian)
            header.writeUInt32LE(parseInt(time, 16), offset);
            offset += 4;
            
            // Difficulty bits (4 bytes, little endian)
            header.writeUInt32LE(parseInt(job.nbits, 16), offset);
            offset += 4;
            
            // Nonce (4 bytes, little endian)
            header.writeUInt32LE(parseInt(nonce, 16), offset);
            
            return header;
        }

        buildOptimizedBlockHeader(miner, extranonce2, time, nonce) {
            const job = this.currentJob;
            
            // Use cached coinbase hash if available
            if (!job.cachedCoinbaseTemplate) {
                job.cachedCoinbaseTemplate = Buffer.concat([
                    Buffer.from(job.coinb1, 'hex'),
                    Buffer.from(miner.extranonce1, 'hex')
                ]);
            }
            
            // Construct coinbase with new extranonce2
            const coinbase = Buffer.concat([
                job.cachedCoinbaseTemplate,
                Buffer.from(extranonce2, 'hex'),
                Buffer.from(job.coinb2, 'hex')
            ]);
            
            // Calculate coinbase hash
            const coinbaseHash = this.doublesha256(coinbase);
            
            // Build merkle root with corrected algorithm
            const merkleRoot = this.calculateCorrectMerkleRoot([coinbaseHash.toString('hex'), ...job.merkleSteps]);
            
            // Construct 80-byte block header
            const header = Buffer.alloc(80);
            let offset = 0;
            
            // Version (4 bytes, little endian)
            header.writeUInt32LE(parseInt(job.version, 16), offset);
            offset += 4;
            
            // Previous block hash (32 bytes) - job.prevHash is already reversed
            Buffer.from(job.prevHash, 'hex').copy(header, offset);
            offset += 32;
            
            // Merkle root (32 bytes, reverse byte order)
            Buffer.from(merkleRoot, 'hex').reverse().copy(header, offset);
            offset += 32;
            
            // Timestamp (4 bytes, little endian)
            header.writeUInt32LE(parseInt(time, 16), offset);
            offset += 4;
            
            // Difficulty bits (4 bytes, little endian)
            header.writeUInt32LE(parseInt(job.nbits, 16), offset);
            offset += 4;
            
            // Nonce (4 bytes, little endian)
            header.writeUInt32LE(parseInt(nonce, 16), offset);
            
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

        calculateCorrectMerkleRoot(hashes) {
            if (hashes.length === 0) return '0'.repeat(64);
            if (hashes.length === 1) return hashes[0];
            
            let level = hashes.slice();
            
            while (level.length > 1) {
                const nextLevel = [];
                
                for (let i = 0; i < level.length; i += 2) {
                    const left = Buffer.from(level[i], 'hex').reverse();
                    // Bitcoin protocol: if odd number, duplicate the last hash
                    const right = level[i + 1] ? 
                        Buffer.from(level[i + 1], 'hex').reverse() : 
                        Buffer.from(level[i], 'hex').reverse(); // Duplicate left
                    
                    const combined = Buffer.concat([left, right]);
                    const hash = this.doublesha256(combined);
                    nextLevel.push(hash.reverse().toString('hex'));
                }
                
                level = nextLevel;
            }
            
            return level[0];
        }

        checkDifficulty(hash, target) {
            try {
                const targetBuffer = this.difficultyToTarget(target);
                console.log(`DEBUG: Target for difficulty ${target}: ${targetBuffer.toString('hex')}`);
                
                const hashCopy = Buffer.from(hash);
                const result = hashCopy.reverse().compare(targetBuffer) <= 0;
                console.log(`DEBUG: Hash reversed: ${hashCopy.toString('hex')}`);
                console.log(`DEBUG: Comparison result: ${result}`);
                
                return result;
            } catch (error) {
                console.error('Difficulty check error:', error.message);
                return false;
            }
        }

        difficultyToTarget(difficulty) {
            // Handle edge cases
            if (difficulty <= 0) {
                difficulty = 1;
            }
            
            const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
            
            // Convert difficulty to integer to avoid floating point issues
            const difficultyInt = Math.floor(difficulty * 1000000); // Scale up to avoid decimals
            const scaledMaxTarget = maxTarget * BigInt(1000000); // Scale max target accordingly
            
            const target = scaledMaxTarget / BigInt(difficultyInt);
            
            // Convert to 32-byte buffer
            const targetHex = target.toString(16).padStart(64, '0');
            return Buffer.from(targetHex, 'hex');
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
                true // clean jobs
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
                socket.write(data, (err) => {
                    if (err) {
                        console.log(`Write error: ${err.message}`);
                        socket.destroy();
                    }
                });
            }
        } catch (err) {
            console.error('Error sending message:', err.message);
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
    poolAddress: '1GWVQpX8bnwkQsLYHrdzQqma7vWXbp9zFH' // Change this to your Bitcoin address
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

// Update work every 30 seconds
//setInterval(async () => {
//    await server.updateWork();
// }, 30000);

// Display stats every 60 seconds
setInterval(() => {
    const stats = server.getStats();
    console.log(`📊 Stats: ${stats.totalMiners} miners, ${stats.validShares}/${stats.totalShares} shares (${stats.efficiency}% efficiency)`);
}, 60000);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down real stratum server...');
    server.server.close(() => {
        process.exit(0);
    });
});

module.exports = RealStratumServer;