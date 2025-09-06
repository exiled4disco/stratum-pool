const bitcoin = require('node-bitcoin-rpc');
const crypto = require('crypto');
const EventEmitter = require('events');

class BitcoinConnector extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            host: config.host || '127.0.0.1',
            port: config.port || 8332,
            user: config.user || 'btc_40',
            pass: config.pass || '1234nN',
            timeout: 30000,
            ...config
        };
        
        // Initialize Bitcoin RPC
        bitcoin.init(this.config.host, this.config.port, this.config.user, this.config.pass);
        bitcoin.setTimeout(this.config.timeout);
        this.poolAddress = config.poolAddress || '1GWVQpX8bnwkQsLYHrdzQqma7vWXbp9zFH';
        this.currentBlockHash = null;
        this.currentHeight = 0;
        this.startBlockWatcher();
    }

    async testConnection() {
        try {
            const info = await this.callRpc('getblockchaininfo');
            console.log(`Connected to Bitcoin node: ${info.chain} network, block ${info.blocks}`);
            this.currentHeight = info.blocks;
            return true;
        } catch (error) {
            console.error('Failed to connect to Bitcoin node:', error.message);
            return false;
        }
    }

    async callRpc(method, params = []) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('RPC timeout'));
            }, 10000);

            bitcoin.call(method, params, (err, data) => {
                clearTimeout(timeout);
                
                if (err) {
                    // Handle string errors that start with 'W' (warnings)
                    if (typeof err === 'string') {
                        if (err.startsWith('W')) {
                            console.warn(`Bitcoin Core warning for ${method}: ${err}`);
                            resolve(null); // Treat as non-fatal
                        } else {
                            reject(new Error(`RPC Error: ${err}`));
                        }
                    } else {
                        reject(new Error(`RPC Error: ${err.message || err}`));
                    }
                } else if (!data || typeof data !== 'object') {
                    console.warn(`Invalid response from Bitcoin Core for ${method}:`, data);
                    resolve(null); // Don't crash on invalid responses
                } else if (data.error) {
                    reject(new Error(`Bitcoin Core Error: ${data.error.message}`));
                } else {
                    resolve(data.result);
                }
            });
        });
    }

    async getBlockTemplate() {
        try {
            // Get block template for mining
            const template = await this.callRpc('getblocktemplate', [{"rules": ["segwit"]}]);
            return this.processBlockTemplate(template);
        } catch (error) {
            console.error('Error getting block template:', error.message);
            return null;
        }
    }

    processBlockTemplate(template) {
        // Create coinbase transaction
        const coinbaseTx = this.createCoinbaseTransaction(template);
        
        // Calculate merkle tree
        const transactions = [coinbaseTx.hash, ...template.transactions.map(tx => tx.txid)];
        const merkleRoot = this.calculateMerkleRoot(transactions);
        
        // Create job data
        const job = {
            jobId: Date.now().toString(16),
            prevHash: this.reverseHex(template.previousblockhash),
            coinb1: coinbaseTx.part1,
            coinb2: coinbaseTx.part2,
            merkleSteps: this.getMerkleSteps(transactions),
            version: template.version.toString(16).padStart(8, '0'),
            nbits: template.bits,
            ntime: template.curtime.toString(16).padStart(8, '0'),
            height: template.height,
            target: template.target
        };

        return job;
    }

    createCoinbaseTransaction(template) {
        const height = template.height;
        const reward = template.coinbasevalue;
        
        // Coinbase input (simplified)
        const coinbaseInput = Buffer.concat([
            Buffer.from([height & 0xff, (height >> 8) & 0xff, (height >> 16) & 0xff]), // Block height
            Buffer.from('Stratum Pool', 'utf8'), // Pool signature
            Buffer.alloc(4) // Extra nonce space
        ]);

        // Create coinbase transaction parts
        const part1 = Buffer.concat([
            Buffer.from('01000000', 'hex'), // Version
            Buffer.from('01', 'hex'), // Input count
            Buffer.alloc(32), // Previous output hash (null)
            Buffer.from('ffffffff', 'hex'), // Previous output index
            Buffer.from([coinbaseInput.length]), // Script length
            coinbaseInput.slice(0, coinbaseInput.length - 4) // Script (without extranonce2)
        ]);

        const part2 = Buffer.concat([
            coinbaseInput.slice(-4), // Extranonce2 placeholder
            Buffer.from('ffffffff', 'hex'), // Sequence
            Buffer.from('01', 'hex'), // Output count
            Buffer.from(reward.toString(16).padStart(16, '0'), 'hex').reverse(), // Value (little endian)
            Buffer.from('19', 'hex'), // Script length (25 bytes for P2PKH)
            Buffer.from('76a914', 'hex'), // OP_DUP OP_HASH160
            this.addressToHash160(this.poolAddress), // Pool address hash
            Buffer.from('88ac', 'hex'), // OP_EQUALVERIFY OP_CHECKSIG
            Buffer.from('00000000', 'hex') // Lock time
        ]);

        // Calculate hash for merkle tree
        const fullCoinbase = Buffer.concat([part1, Buffer.alloc(4), part2]);
        const hash = crypto.createHash('sha256').update(
            crypto.createHash('sha256').update(fullCoinbase).digest()
        ).digest().reverse().toString('hex');

        return {
            part1: part1.toString('hex'),
            part2: part2.toString('hex'),
            hash: hash
        };
    }

    addressToHash160(address) {
        // Simplified - in production, use proper base58 decoding
        // This is just a placeholder for the example
        return Buffer.from('89abcdefabbaabbaabbaabbaabbaabbaabbaabba', 'hex');
    }

    calculateMerkleRoot(transactions) {
        if (transactions.length === 0) return null;
        if (transactions.length === 1) return transactions[0];

        let level = transactions.slice();
        
        while (level.length > 1) {
            const nextLevel = [];
            
            for (let i = 0; i < level.length; i += 2) {
                const left = level[i];
                const right = level[i + 1] || left; // Duplicate last if odd
                
                const combined = left + right;
                const hash = crypto.createHash('sha256').update(
                    crypto.createHash('sha256').update(Buffer.from(combined, 'hex')).digest()
                ).digest().toString('hex');
                
                nextLevel.push(hash);
            }
            
            level = nextLevel;
        }
        
        return level[0];
    }

    getMerkleSteps(transactions) {
        // Calculate merkle branch for coinbase (first transaction)
        const steps = [];
        let level = transactions.slice();
        
        while (level.length > 1) {
            // For coinbase, we always want the right sibling
            if (level.length > 1) {
                steps.push(level[1]); // Right sibling of coinbase
            }
            
            const nextLevel = [];
            for (let i = 0; i < level.length; i += 2) {
                const left = level[i];
                const right = level[i + 1] || left;
                const combined = left + right;
                const hash = crypto.createHash('sha256').update(
                    crypto.createHash('sha256').update(Buffer.from(combined, 'hex')).digest()
                ).digest().toString('hex');
                nextLevel.push(hash);
            }
            level = nextLevel;
        }
        
        return steps;
    }

    reverseHex(hex) {
        return hex.match(/.{2}/g).reverse().join('');
    }

    startBlockWatcher() {
        // Check for new blocks every 10 seconds
        setInterval(async () => {
            try {
                const info = await this.callRpc('getblockchaininfo');
                if (info.bestblockhash !== this.currentBlockHash) {
                    this.currentBlockHash = info.bestblockhash;
                    this.currentHeight = info.blocks;
                    console.log(`New block detected: ${info.blocks}`);
                    this.emit('newBlock', info);
                }
            } catch (error) {
                console.error('Error checking for new blocks:', error.message);
            }
        }, 10000);
    }

    async submitBlock(blockHex) {
        try {
            const result = await this.callRpc('submitblock', [blockHex]);
            console.log('Block submitted:', result);
            return result;
        } catch (error) {
            console.error('Error submitting block:', error.message);
            throw error;
        }
    }
}

module.exports = BitcoinConnector;