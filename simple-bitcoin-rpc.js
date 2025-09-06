const http = require('http');

class SimpleBitcoinRPC {
    constructor(config) {
        this.host = config.host || '127.0.0.1';
        this.port = config.port || 8332;
        this.user = config.user || 'btc_40';
        this.pass = config.pass || '12345nN';
        this.auth = Buffer.from(`${this.user}:${this.pass}`).toString('base64');
        this.id = 1;
    }

    async call(method, params = []) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify({
                jsonrpc: '1.0',
                id: this.id++,
                method: method,
                params: params
            });

            const options = {
                hostname: this.host,
                port: this.port,
                path: '/',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    'Authorization': `Basic ${this.auth}`
                }
            };

            const req = http.request(options, (res) => {
                let responseData = '';

                res.on('data', (chunk) => {
                    responseData += chunk;
                });

                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseData);
                        if (parsed.error) {
                            reject(new Error(parsed.error.message || 'RPC Error'));
                        } else {
                            resolve(parsed.result);
                        }
                    } catch (err) {
                        reject(new Error(`Failed to parse response: ${err.message}`));
                    }
                });
            });

            req.on('error', (err) => {
                reject(new Error(`HTTP Error: ${err.message}`));
            });

            req.write(data);
            req.end();
        });
    }
}

module.exports = SimpleBitcoinRPC;