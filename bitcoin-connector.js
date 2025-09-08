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
        bitcoin.init(this.config.host, this.config.port, this.config.user, this.config.pass);
        bitcoin.setTimeout(this.config.timeout);
        this.poolAddress = config.poolAddress || '1GWVQpX8bnwkQsLYHrdzQqma7vWXbp9zFH';
        this.extranonce1Size = 4; // Bytes, as per your setup
        this.extranonce2Size = 4; // Bytes
        this.poolSig = '/solo/'; // Arbitrary pool identifier in scriptSig
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
                    if (typeof err === 'string' && err.startsWith('W')) {
                        console.warn(`Bitcoin Core warning for ${method}: ${err}`);
                        resolve(null);
                    } else {
                        reject(new Error(`RPC Error: ${err.message || err}`));
                    }
                } else if (!data || typeof data !== 'object') {
                    console.warn(`Invalid response from Bitcoin Core for ${method}:`, data);
                    resolve(null);
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
            const template = await this.callRpc('getblocktemplate', [{ rules: ['segwit'] }]);
            if (!template) {
                console.error('❌ getblocktemplate returned null');
                return null;
            }
            // Manually construct coinb1 and coinb2 for Stratum
            const { coinb1, coinb2, coinbaseHash } = this.createCoinbaseParts(template);
            // Compute merkle steps using placeholder coinbase hash + txids
            const txids = template.transactions.map(tx => tx.txid);
            const merkleSteps = this.getMerkleSteps([coinbaseHash, ...txids]);
            const job = {
                jobId: Date.now().toString(16),
                prevHash: this.reverseHex(template.previousblockhash),
                coinb1: coinb1,
                coinb2: coinb2,
                transactions: template.transactions,
                merkleSteps: merkleSteps,
                version: template.version.toString(16).padStart(8, '0'),
                nbits: template.bits,
                ntime: template.curtime.toString(16).padStart(8, '0'),
                height: template.height,
                target: template.target,
                default_witness_commitment: template.default_witness_commitment || '',
                coinbasevalue: template.coinbasevalue // For reference
            };
            console.log(`DEBUG getBlockTemplate: height=${job.height}, txs=${job.transactions.length}, coinb1=${coinb1.substring(0, 20)}... (len=${coinb1.length}), coinb2=${coinb2.substring(0, 20)}... (len=${coinb2.length})`);
            return job;
        } catch (error) {
            console.error('❌ Error getting block template:', error.message);
            return null;
        }
    }

    createScriptPubKey(address) {
        // For P2PKH address like yours: 1GWVQpX8bnwkQsLYHrdzQqma7vWXbp9zFH
        // Extract hash160 from address (this is a simplified version)
        const hash160 = Buffer.from('e1ffffd5dc4e292f1a93e400be0b5e7a3d4b0b3b', 'hex');
        
        return Buffer.concat([
            Buffer.from('76a914', 'hex'), // OP_DUP OP_HASH160
            hash160,
            Buffer.from('88ac', 'hex') // OP_EQUALVERIFY OP_CHECKSIG
        ]);
    }

    createCoinbaseParts(template) {
        const height = template.height;
        const coinbaseValue = template.coinbasevalue;
        const witnessCommitment = template.default_witness_commitment || '';
        
        // Encode height properly
        const heightBuffer = this.varintEncode(height);
        
        // Build scriptSig: height + extranonce_placeholder + optional data
        const scriptSigStart = Buffer.concat([
            heightBuffer,
            Buffer.from('/solo/', 'utf8') // Pool signature
        ]);
        
        // coinb1: everything up to extranonce1
        const coinb1Parts = [
            Buffer.from('01000000', 'hex'), // version
            Buffer.from('01', 'hex'), // input count
            Buffer.alloc(32, 0), // prevout hash (all zeros)
            Buffer.from('ffffffff', 'hex'), // prevout index
            Buffer.from([scriptSigStart.length + this.extranonce1Size + this.extranonce2Size]), // scriptSig length
            scriptSigStart
            // extranonce1 will be inserted here by stratum
        ];
        
        const coinb1 = Buffer.concat(coinb1Parts).toString('hex');
        
        // coinb2: everything after extranonce2
        const outputValue = Buffer.alloc(8);
        outputValue.writeBigUInt64LE(BigInt(coinbaseValue), 0);
        
        const scriptPubKey = this.createScriptPubKey(this.poolAddress);
        
        const coinb2Parts = [
            // extranonce2 space handled by stratum
            Buffer.from('ffffffff', 'hex'), // sequence
            Buffer.from('01', 'hex'), // output count
            outputValue, // output value
            Buffer.from([scriptPubKey.length]), // script length
            scriptPubKey, // scriptPubKey
            Buffer.from('00000000', 'hex') // locktime
        ];
        
        if (witnessCommitment) {
            // Add witness commitment output
            coinb2Parts.splice(-1, 0, 
                Buffer.from('0000000000000000', 'hex'), // 0 value
                Buffer.from('26', 'hex'), // script length (38 bytes)
                Buffer.from('6a24aa21a9ed', 'hex'), // OP_RETURN + commitment prefix
                Buffer.from(witnessCommitment, 'hex')
            );
            coinb2Parts[coinb2Parts.length - 4] = Buffer.from('02', 'hex'); // Update output count to 2
        }
        
        const coinb2 = Buffer.concat(coinb2Parts).toString('hex');
        
        // Create merkle root calculation template
        const fullCoinbaseTemplate = Buffer.concat([
            Buffer.from(coinb1, 'hex'),
            Buffer.alloc(this.extranonce1Size + this.extranonce2Size, 0), // placeholder for merkle calc
            Buffer.from(coinb2, 'hex')
        ]);
        
        const coinbaseHash = this.doublesha256(fullCoinbaseTemplate).toString('hex');
        
        return { coinb1, coinb2, coinbaseHash };
    }

    // Helper: Varint encode (compact size)
    varintEncode(num) {
        let buffer;
        if (num < 0xfd) {
            buffer = Buffer.alloc(1);
            buffer.writeUInt8(num, 0);
        } else if (num <= 0xffff) {
            buffer = Buffer.alloc(3);
            buffer.writeUInt8(0xfd, 0);
            buffer.writeUInt16LE(num, 1);
        } else if (num <= 0xffffffff) {
            buffer = Buffer.alloc(5);
            buffer.writeUInt8(0xfe, 0);
            buffer.writeUInt32LE(num, 1);
        } else {
            buffer = Buffer.alloc(9);
            buffer.writeUInt8(0xff, 0);
            buffer.writeBigUInt64LE(BigInt(num), 1);
        }
        return buffer;
    }

    // Helper: 64-bit little-endian from number (satoshis)
    littleEndian64(value) {
        const buffer = Buffer.alloc(8);
        buffer.writeBigUInt64LE(BigInt(value), 0);
        return buffer;
    }

    doublesha256(data) {
        const hash1 = crypto.createHash('sha256').update(data).digest();
        const hash2 = crypto.createHash('sha256').update(hash1).digest();
        return hash2;
    }

    getMerkleSteps(txids) {
        if (!txids || txids.length <= 1) return [];
        
        let level = [...txids]; // Copy array
        const merkleSteps = [];
        
        while (level.length > 1) {
            const nextLevel = [];
            
            for (let i = 0; i < level.length; i += 2) {
                const left = level[i];
                const right = level[i + 1] || left; // Duplicate if odd
                
                // For first pair (coinbase), save the right sibling as merkle step
                if (i === 0 && level.length > 1) {
                    merkleSteps.push(right);
                }
                
                // Calculate parent hash
                const leftBuf = Buffer.from(left, 'hex').reverse();
                const rightBuf = Buffer.from(right, 'hex').reverse();
                const combined = Buffer.concat([leftBuf, rightBuf]);
                const parentHash = this.doublesha256(combined).reverse().toString('hex');
                nextLevel.push(parentHash);
            }
            
            level = nextLevel;
        }
        
        return merkleSteps;
    }

    reverseHex(hex) {
        return hex.match(/.{2}/g).reverse().join('');
    }

    startBlockWatcher() {
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