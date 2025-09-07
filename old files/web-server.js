const express = require('express');
const path = require('path');
const app = express();

class WebServer {
    constructor(stratumServer) {
        this.stratum = stratumServer;
        this.app = express();
        this.setupRoutes();
    }

    setupRoutes() {
        // Serve the dashboard
        this.app.use(express.static('.'));
        
        // API endpoint for real-time stats
        this.app.get('/api/stats', (req, res) => {
            const stats = this.stratum.getStats();
            const miners = Array.from(this.stratum.miners.values())
                .filter(miner => miner.authorized); // Only get authorized miners
            
            res.json({
                poolStats: {
                    totalMiners: miners.length,
                    totalShares: stats.totalShares,
                    validShares: stats.validShares,
                    efficiency: parseFloat(stats.efficiency),
                    uptime: Date.now() - this.startTime
                },
                miners: miners.map(miner => ({
                    id: miner.id.substring(0, 8),
                    username: miner.username || 'Unknown',
                    address: miner.address,
                    shares: miner.shares,
                    validShares: miner.validShares,
                    connected: miner.authorized && !miner.socket.destroyed,
                    connectTime: miner.connectTime
                })),
                network: {
                    blockHeight: this.stratum.currentJob?.height || 0,
                    difficulty: this.stratum.cachedNetworkDifficulty || 0
                }
            });
        });
    }

    start(port = 3334) {
        this.startTime = Date.now();
        this.app.listen(port, () => {
            console.log(`Dashboard available at http://localhost:${port}`);
        });
    }
}

module.exports = WebServer;