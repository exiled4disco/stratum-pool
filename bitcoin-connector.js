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

    createCoinbaseParts(template) {
        const height = template.height;
        const coinbaseValue = template.coinbasevalue; // Satoshis
        const witnessCommitment = template.default_witness_commitment || '';
        const flags = template.coinbaseaux ? template.coinbaseaux.flags || '' : '';

        // Varint encode for height (compact size)
        const heightBuffer = this.varintEncode(height);

        // Pool signature buffer
        const poolSigBuffer = Buffer.from(this.poolSig, 'utf8');

        // Extranonce space: extranonce1_size + extranonce2_size = 8 bytes (placeholder all zero for merkle)
        const extranonceSpace = Buffer.alloc(this.extranonce1Size + this.extranonce2Size, 0);

        // ScriptSig content: height + flags + poolSig + extranonce space
        const scriptSigContent = Buffer.concat([heightBuffer, Buffer.from(flags, 'hex'), poolSigBuffer, extranonceSpace]);

        // Varint for scriptSig length
        const scriptSigLen = this.varintEncode(scriptSigContent.length);

        // coinb1: version (20000000 LE) + input count (01) + prevout hash (32 zero) + vout (ffffffff) + scriptSig len + scriptSig content up to extranonce space
        const coinb1Parts = [
            Buffer.from('01000000', 'hex'), // Version 1 (LE)
            Buffer.from('01', 'hex'), // Input count: 1
            Buffer.alloc(32, 0), // Prevout hash: all zero
            Buffer.from('ffffffff', 'hex'), // Prevout index
            scriptSigLen,
            heightBuffer,
            Buffer.from(flags, 'hex'),
            poolSigBuffer,
            Buffer.alloc(this.extranonce1Size, 0) // Space for extranonce1 only (extranonce2 in coinb2 space)
        ];
        const coinb1 = Buffer.concat(coinb1Parts).toString('hex');

        // Pool address scriptPubKey (P2PKH for 1GWVQpX8bnwkQsLYHrdzQqma7vWXbp9zFH: hash160 = e1ffffd5dc4e292f1a93e400be0b5e7a3d4b0b3b)
        const poolHash160 = Buffer.from('e1ffffd5dc4e292f1a93e400be0b5e7a3d4b0b3b', 'hex');
        const scriptPubKey = Buffer.concat([
            Buffer.from('76a914', 'hex'), // OP_DUP OP_HASH160
            poolHash160,
            Buffer.from('88ac', 'hex') // OP_EQUALVERIFY OP_CHECKSIG
        ]);

        // Coinbase output: value (8B LE) + output count (01) + script len (19 for P2PKH) + scriptPubKey
        const valueBuffer = this.littleEndian64(coinbaseValue);
        const outputParts = [
            valueBuffer,
            Buffer.from('01', 'hex'), // Output count: 1 (solo, no fees split)
            Buffer.from([scriptPubKey.length]), // Script len: 25
            scriptPubKey
        ];

        // Sequence + witness commitment (if present): ffffffff + 6a 24 aa21 + commitment
        let witnessPart = Buffer.from('ffffffff', 'hex'); // Sequence
        if (witnessCommitment) {
            const commitmentScript = Buffer.concat([
                Buffer.from('6a24aa21', 'hex'), // OP_RETURN + push 34B
                Buffer.from(witnessCommitment, 'hex')
            ]);
            witnessPart = Buffer.concat([witnessPart, Buffer.from([commitmentScript.length]), commitmentScript]);
        }

        // coinb2: extranonce2 space + output + witness part + locktime (00000000)
        const coinb2Parts = [
            Buffer.alloc(this.extranonce2Size, 0), // Space for extranonce2
            ...outputParts,
            witnessPart,
            Buffer.from('00000000', 'hex') // Locktime
        ];
        const coinb2 = Buffer.concat(coinb2Parts).toString('hex');

        // Full placeholder coinbase for merkle hash (extranonce2=00000000)
        const fullCoinbase = Buffer.concat([Buffer.from(coinb1, 'hex'), extranonceSpace.slice(this.extranonce1Size), Buffer.from(coinb2, 'hex')]);
        const coinbaseHash = this.doublesha256(fullCoinbase).reverse().toString('hex');

        console.log(`DEBUG Coinbase construction: coinb1 len=${coinb1.length}, coinb2 len=${coinb2.length}, witness=${witnessCommitment ? 'included' : 'missing'}`);
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

    getMerkleSteps(transactions) {
        if (!transactions || transactions.length === 0) return [];
        let level = transactions.slice();
        const steps = [];
        while (level.length > 1) {
            const nextLevel = [];
            for (let i = 0; i < level.length; i += 2) {
                const left = Buffer.from(level[i], 'hex').reverse();
                const right = level[i + 1] ? Buffer.from(level[i + 1], 'hex').reverse() : left;
                const combined = Buffer.concat([left, right]);
                const hash = this.doublesha256(combined).reverse().toString('hex');
                nextLevel.push(hash);
                if (i === 0) steps.push(level[i + 1] || level[i]); // Right sibling for coinbase (first tx)
            }
            level = nextLevel;
        }
        return steps;
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