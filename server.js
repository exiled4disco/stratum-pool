const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');

class StratumServer extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = {
            port: config.port || 3333,
            difficulty: config.difficulty || 1,
            ...config
        };
        
        this.miners = new Map();
        this.server = net.createServer();
        this.jobCounter = 0;
        this.currentJob = null;
        
        this.setupServer();
    }

    setupServer() {
        this.server.on('connection', this.handleConnection.bind(this));
        this.server.on('error', (err) => {
            console.error('Server error:', err);
        });
    }

    start() {
        this.server.listen(this.config.port, '0.0.0.0', () => {
            console.log(`Stratum server listening on port ${this.config.port}`);
            console.log(`Initial difficulty: ${this.config.difficulty}`);
        });
    }

    handleConnection(socket) {
        const minerId = crypto.randomUUID();
        const miner = {
            id: minerId,
            socket: socket,
            subscribed: false,
            authorized: false,
            difficulty: this.config.difficulty,
            lastActivity: Date.now(),
            address: socket.remoteAddress
        };

        this.miners.set(minerId, miner);
        console.log(`New connection: ${miner.address} (${minerId.substring(0, 8)})`);

        // Handle incoming data
        socket.on('data', (data) => {
            this.handleData(minerId, data);
        });

        // Handle disconnection
        socket.on('close', () => {
            console.log(`Miner disconnected: ${miner.address} (${minerId.substring(0, 8)})`);
            this.miners.delete(minerId);
        });

        socket.on('error', (err) => {
            console.error(`Socket error for ${miner.address}:`, err.message);
            this.miners.delete(minerId);
        });
    }

    handleData(minerId, data) {
        const miner = this.miners.get(minerId);
        if (!miner) return;

        miner.lastActivity = Date.now();

        // Parse JSON-RPC messages
        const messages = data.toString().trim().split('\n');
        
        for (const messageStr of messages) {
            if (!messageStr.trim()) continue;
            
            try {
                const message = JSON.parse(messageStr);
                this.processMessage(minerId, message);
            } catch (err) {
                console.error('JSON parse error:', err.message);
                this.sendError(miner.socket, null, -32700, 'Parse error');
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
                4 // extranonce2 size
            ],
            error: null
        };

        this.sendMessage(miner.socket, response);
        
        // Send initial difficulty
        this.sendDifficulty(miner);
        
        // Send initial job if available
        if (this.currentJob) {
            this.sendJob(miner);
        }

        console.log(`Miner subscribed: ${miner.address} (${miner.id.substring(0, 8)})`);
    }

    handleAuthorize(miner, id, params) {
        const [username, password] = params;
        
        // Basic authorization (customize this for your pool)
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

    handleSubmit(miner, id, params) {
        if (!miner.authorized) {
            this.sendError(miner.socket, id, -24, 'Unauthorized worker');
            return;
        }

        const [username, jobId, extranonce2, time, nonce] = params;
        
        console.log(`Share submitted by ${username}: job=${jobId}, nonce=${nonce}`);
        
        // TODO: Validate share against current job and difficulty
        // For now, just accept all shares
        const isValid = this.validateShare(miner, jobId, extranonce2, time, nonce);
        
        const response = {
            id: id,
            result: isValid,
            error: isValid ? null : [-23, 'Invalid share', null]
        };

        this.sendMessage(miner.socket, response);
        
        if (isValid) {
            console.log(`Valid share from ${username}`);
            this.emit('validShare', { miner, jobId, nonce });
        } else {
            console.log(`Invalid share from ${username}`);
        }
    }

    validateShare(miner, jobId, extranonce2, time, nonce) {
        // Basic validation - in production you'd validate against actual work
        if (!this.currentJob || jobId !== this.currentJob.jobId) {
            return false;
        }
        
        // TODO: Implement proper proof-of-work validation
        // This would involve reconstructing the block header and checking hash
        return true; // Accept all shares for testing
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
            params: this.currentJob.params
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

    createTestJob() {
        this.jobCounter++;
        const jobId = this.jobCounter.toString(16).padStart(8, '0');
        
        // More realistic mock job data
        const job = {
            jobId: jobId,
            params: [
                jobId,                                          // job_id
                "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", // prevhash (Bitcoin genesis)
                "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff01", // coinb1
                "00f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000", // coinb2
                [],                                            // merkle_branch
                "20000000",                                    // version
                "1d00ffff",                                    // nbits (difficulty 1)
                Math.floor(Date.now() / 1000).toString(16),    // ntime
                true                                           // clean_jobs
            ]
        };
        
        return job;
    }

    sendMessage(socket, message) {
        try {
            const data = JSON.stringify(message) + '\n';
            socket.write(data);
        } catch (err) {
            console.error('Error sending message:', err);
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
        return {
            totalMiners: miners.length,
            authorizedMiners: miners.filter(m => m.authorized).length,
            subscribedMiners: miners.filter(m => m.subscribed).length
        };
    }
}

// Configuration
const config = {
    port: 3333,
    difficulty: 1
};

// Start server
const stratumServer = new StratumServer(config);

// Handle events
stratumServer.on('validShare', (data) => {
    console.log(`Valid share received from ${data.miner.username}`);
});

// Start the server
stratumServer.start();

// Create test jobs every 30 seconds
setInterval(() => {
    const job = stratumServer.createTestJob();
    stratumServer.broadcastJob(job);
}, 30000);

// Display stats every 60 seconds
setInterval(() => {
    const stats = stratumServer.getStats();
    console.log(`Stats: ${stats.totalMiners} total, ${stats.authorizedMiners} authorized, ${stats.subscribedMiners} subscribed`);
}, 60000);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down stratum server...');
    stratumServer.server.close(() => {
        process.exit(0);
    });
});

module.exports = StratumServer;