const express = require('express');
const { Pool } = require('pg');
const path = require('path');

class EnhancedDashboard {
    constructor() {
        this.app = express();
        this.pool = new Pool({
            user: 'pool_user',
            host: 'localhost',
            database: 'mining_pool',
            password: '911_+ChildMan!',
            port: 5432,
        });
        
        this.setupRoutes();
    }

    setupRoutes() {
        // Serve static files
        this.app.use(express.static('.'));
        
        // Enhanced real-time stats
        this.app.get('/api/realtime-stats', async (req, res) => {
            try {
                const stats = await this.getEnhancedStats();
                res.json(stats);
            } catch (error) {
                console.error('Enhanced stats error:', error);
                res.status(500).json({ error: 'Database error', details: error.message });
            }
        });

        // Hashrate history endpoint with specific hours
        this.app.get('/api/hashrate-history/:hours', async (req, res) => {
            try {
                const hours = parseInt(req.params.hours) || 24;
                const history = await this.getHashrateHistory(hours);
                res.json(history);
            } catch (error) {
                console.error('Hashrate history error:', error);
                res.status(500).json({ error: 'Failed to get hashrate history' });
            }
        });
        
        // Hashrate history endpoint (default 24 hours)
        this.app.get('/api/hashrate-history', async (req, res) => {
            try {
                const hours = parseInt(req.query.hours) || 24;
                const history = await this.getHashrateHistory(hours);
                res.json(history);
            } catch (error) {
                console.error('Hashrate history error:', error);
                res.status(500).json({ error: 'Failed to get hashrate history' });
            }
        });

        // Performance analytics
        this.app.get('/api/performance-analytics', async (req, res) => {
            try {
                const analytics = await this.getPerformanceAnalytics();
                res.json(analytics);
            } catch (error) {
                console.error('Performance analytics error:', error);
                res.status(500).json({ error: 'Failed to get performance analytics' });
            }
        });

        // Block discovery events
        this.app.get('/api/blocks-found', async (req, res) => {
            try {
                const blocks = await this.getBlocksFound();
                res.json(blocks);
            } catch (error) {
                console.error('Blocks found error:', error);
                res.status(500).json({ error: 'Failed to get blocks data' });
            }
        });

        // Miner performance details with specific ID
        this.app.get('/api/miner-performance/:minerId', async (req, res) => {
            try {
                const minerId = req.params.minerId;
                const performance = await this.getMinerPerformance(minerId);
                res.json(performance);
            } catch (error) {
                console.error('Miner performance error:', error);
                res.status(500).json({ error: 'Failed to get miner performance' });
            }
        });
        
        // All miners performance
        this.app.get('/api/miner-performance', async (req, res) => {
            try {
                const performance = await this.getMinerPerformance();
                res.json(performance);
            } catch (error) {
                console.error('Miner performance error:', error);
                res.status(500).json({ error: 'Failed to get miner performance' });
            }
        });

        // Health check endpoint
        this.app.get('/api/health', async (req, res) => {
            try {
                const health = await this.getSystemHealth();
                res.json(health);
            } catch (error) {
                res.status(503).json({ status: 'unhealthy', error: error.message });
            }
        });

        // Live share stream (SSE)
        this.app.get('/api/live-shares', (req, res) => {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            });

            const sendEvent = (data) => {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            // Send initial connection
            sendEvent({ type: 'connected', timestamp: new Date().toISOString() });

            // Set up interval to send updates
            const interval = setInterval(async () => {
                try {
                    const recentShares = await this.getRecentShares(5);
                    sendEvent({ 
                        type: 'shares_update', 
                        data: recentShares,
                        timestamp: new Date().toISOString()
                    });
                } catch (error) {
                    sendEvent({ 
                        type: 'error', 
                        message: error.message,
                        timestamp: new Date().toISOString()
                    });
                }
            }, 2000);

            req.on('close', () => {
                clearInterval(interval);
            });
        });
    }

    async getCurrentPoolDifficulty() {
        try {
            // Get the most recent shares to determine actual pool difficulty
            const result = await this.pool.query(`
                SELECT difficulty_target
                FROM shares 
                WHERE difficulty_target IS NOT NULL
                ORDER BY submitted_at DESC 
                LIMIT 1
            `);
            
            if (result.rows.length > 0 && result.rows[0].difficulty_target) {
                return parseFloat(result.rows[0].difficulty_target);
            }
            
            // Default to difficulty 1 if no data
            return 1.0;
        } catch (error) {
            console.log('Could not get pool difficulty, defaulting to 1.0');
            return 1.0;
        }
    }

    async getEnhancedStats() {
        // Get current active miners with detailed info
        const minersResult = await this.pool.query(`
            SELECT 
                m.id, m.username, m.ip_address, m.connected_at, m.disconnected_at,
                m.total_shares, m.valid_shares,
                CASE WHEN m.disconnected_at IS NULL THEN true ELSE false END as is_connected,
                EXTRACT(EPOCH FROM (COALESCE(m.disconnected_at, NOW()) - m.connected_at)) as connection_duration,
                COUNT(s.id) as shares_last_hour
            FROM miners m
            LEFT JOIN shares s ON m.id = s.miner_id AND s.submitted_at >= NOW() - INTERVAL '1 hour'
            WHERE m.disconnected_at IS NULL OR m.disconnected_at >= NOW() - INTERVAL '5 minutes'
            GROUP BY m.id, m.username, m.ip_address, m.connected_at, m.disconnected_at, m.total_shares, m.valid_shares
            ORDER BY m.connected_at DESC
        `);

        // Get comprehensive share statistics
        const sharesResult = await this.pool.query(`
            SELECT 
                COUNT(*) as total_shares_today,
                COUNT(CASE WHEN is_valid THEN 1 END) as valid_shares_today,
                COUNT(CASE WHEN meets_network_difficulty THEN 1 END) as blocks_found_today,
                AVG(processing_time_ms) as avg_processing_time,
                MIN(processing_time_ms) as min_processing_time,
                MAX(processing_time_ms) as max_processing_time,
                STDDEV(processing_time_ms) as stddev_processing_time,
                COUNT(CASE WHEN submitted_at >= NOW() - INTERVAL '1 hour' THEN 1 END) as shares_last_hour,
                COUNT(CASE WHEN submitted_at >= NOW() - INTERVAL '10 minutes' THEN 1 END) as shares_last_10min
            FROM shares 
            WHERE submitted_at >= CURRENT_DATE
        `);

        // Get all-time statistics
        const allTimeResult = await this.pool.query(`
            SELECT 
                COUNT(*) as total_shares_all_time,
                COUNT(CASE WHEN is_valid THEN 1 END) as valid_shares_all_time,
                COUNT(CASE WHEN meets_network_difficulty THEN 1 END) as total_blocks_found,
                MAX(submitted_at) as last_share_time
            FROM shares
        `);

        // Get latest pool stats
        const poolStatsResult = await this.pool.query(`
            SELECT * FROM pool_stats 
            ORDER BY recorded_at DESC 
            LIMIT 1
        `);

        // Get recent activity (last 20 shares with more details)
        const activityResult = await this.pool.query(`
            SELECT 
                s.submitted_at, s.is_valid, s.meets_network_difficulty,
                s.nonce, s.processing_time_ms, s.block_hash,
                m.username, m.ip_address
            FROM shares s
            JOIN miners m ON s.miner_id = m.id
            ORDER BY s.submitted_at DESC
            LIMIT 20
        `);

        // Get blocks found with details
        const blocksResult = await this.pool.query(`
            SELECT 
                b.block_hash, b.block_height, b.found_at,
                m.username as finder
            FROM blocks b
            JOIN miners m ON b.miner_id = m.id
            ORDER BY b.found_at DESC
            LIMIT 10
        `);

        const shares = sharesResult.rows[0];
        const allTime = allTimeResult.rows[0];
        const poolStats = poolStatsResult.rows[0] || {};
        
        // Calculate efficiency and performance metrics
        const efficiency = shares.total_shares_today > 0 ? 
            ((shares.valid_shares_today / shares.total_shares_today) * 100).toFixed(1) : '0.0';
        
        const allTimeEfficiency = allTime.total_shares_all_time > 0 ? 
            ((allTime.valid_shares_all_time / allTime.total_shares_all_time) * 100).toFixed(1) : '0.0';

        // Calculate shares per minute
        const sharesPerMinute = shares.shares_last_hour > 0 ? (shares.shares_last_hour / 60).toFixed(1) : '0.0';

        // Calculate estimated hashrate (rough approximation)
        const estimatedHashrate = this.calculateEstimatedHashrate(minersResult.rows, shares.shares_last_hour);

        // Calculate uptime percentage (very rough estimate)
        const uptimePercent = this.calculateUptimePercent(minersResult.rows);

        return {
            miners: minersResult.rows,
            stats: {
                totalMiners: minersResult.rows.filter(m => m.is_connected).length,
                totalShares: parseInt(shares.total_shares_today) || 0,
                validShares: parseInt(shares.valid_shares_today) || 0,
                blocksFound: parseInt(shares.blocks_found_today) || 0,
                totalBlocksAllTime: parseInt(allTime.total_blocks_found) || 0,
                efficiency: efficiency,
                allTimeEfficiency: allTimeEfficiency,
                avgProcessingTime: parseFloat(shares.avg_processing_time) || 0,
                minProcessingTime: parseFloat(shares.min_processing_time) || 0,
                maxProcessingTime: parseFloat(shares.max_processing_time) || 0,
                stddevProcessingTime: parseFloat(shares.stddev_processing_time) || 0,
                currentBlockHeight: poolStats.current_block_height || 0,
                networkDifficulty: poolStats.network_difficulty || 0,
                sharesPerMinute: parseFloat(sharesPerMinute),
                sharesLastHour: parseInt(shares.shares_last_hour) || 0,
                estimatedHashrate: estimatedHashrate,
                uptimePercent: uptimePercent,
                lastShareTime: allTime.last_share_time
            },
            recentActivity: activityResult.rows,
            blocksFound: blocksResult.rows,
            performance: {
                processingTimeStats: {
                    avg: parseFloat(shares.avg_processing_time) || 0,
                    min: parseFloat(shares.min_processing_time) || 0,
                    max: parseFloat(shares.max_processing_time) || 0,
                    stddev: parseFloat(shares.stddev_processing_time) || 0
                }
            }
        };
    }

    calculateEstimatedHashrate(miners, sharesLastHour) {
        console.log('=== SIMPLE MINER COUNT METHOD ===');
        
        // Count connected miners from the query
        const connectedMiners = miners.filter(m => m.is_connected).length;
        console.log('Connected miners:', connectedMiners);
        
        if (connectedMiners > 0) {
            const hashrate = (connectedMiners * 14).toFixed(1);
            console.log('Hashrate calculation: ', connectedMiners, '× 14 TH/s =', hashrate, 'TH/s');
            return hashrate;
        }
        
        return "0.0";
    }

    calculateUptimePercent(miners) {
        if (miners.length === 0) return 0;
        
        // Very rough uptime calculation based on connection durations
        const oneDaySeconds = 24 * 60 * 60;
        let totalUptime = 0;
        
        miners.forEach(miner => {
            const duration = Math.min(miner.connection_duration || 0, oneDaySeconds);
            totalUptime += duration;
        });
        
        const maxPossibleUptime = miners.length * oneDaySeconds;
        return maxPossibleUptime > 0 ? ((totalUptime / maxPossibleUptime) * 100).toFixed(1) : '0.0';
    }

    async getHashrateHistory(hours = 24) {
        // Check if hashrate_history table exists, if not create mock data
        try {
            const result = await this.pool.query(`
                SELECT 
                    DATE_TRUNC('hour', recorded_at) as hour,
                    AVG(total_miners) as avg_miners,
                    AVG(total_shares) as avg_shares,
                    AVG(efficiency) as avg_efficiency
                FROM pool_stats 
                WHERE recorded_at >= NOW() - INTERVAL '${hours} hours'
                GROUP BY DATE_TRUNC('hour', recorded_at)
                ORDER BY hour ASC
            `);
            
            return result.rows.map(row => ({
                timestamp: row.hour,
                estimatedHashrate: (row.avg_miners * 14).toFixed(1), // Rough estimate
                miners: Math.round(row.avg_miners),
                efficiency: parseFloat(row.avg_efficiency).toFixed(1)
            }));
        } catch (error) {
            console.log('Using fallback hashrate data');
            // Return empty array if table doesn't exist yet
            return [];
        }
    }

    async getPerformanceAnalytics() {
        const result = await this.pool.query(`
            SELECT 
                DATE_TRUNC('hour', submitted_at) as hour,
                COUNT(*) as total_shares,
                COUNT(CASE WHEN is_valid THEN 1 END) as valid_shares,
                AVG(processing_time_ms) as avg_processing_time,
                COUNT(DISTINCT miner_id) as active_miners
            FROM shares
            WHERE submitted_at >= NOW() - INTERVAL '24 hours'
            GROUP BY DATE_TRUNC('hour', submitted_at)
            ORDER BY hour ASC
        `);

        return result.rows.map(row => ({
            timestamp: row.hour,
            totalShares: parseInt(row.total_shares),
            validShares: parseInt(row.valid_shares),
            efficiency: row.total_shares > 0 ? ((row.valid_shares / row.total_shares) * 100).toFixed(1) : '0.0',
            avgProcessingTime: parseFloat(row.avg_processing_time).toFixed(2),
            activeMiners: parseInt(row.active_miners)
        }));
    }

    async getBlocksFound() {
        const result = await this.pool.query(`
            SELECT 
                b.block_hash, b.block_height, b.found_at,
                m.username as finder,
                m.ip_address as finder_ip
            FROM blocks b
            JOIN miners m ON b.miner_id = m.id
            ORDER BY b.found_at DESC
            LIMIT 50
        `);

        return result.rows;
    }

    async getMinerPerformance(minerId = null) {
        let query, params;
        
        if (minerId) {
            query = `
                SELECT 
                    m.id, m.username, m.ip_address, m.connected_at,
                    m.total_shares, m.valid_shares,
                    COUNT(s.id) as shares_last_24h,
                    COUNT(CASE WHEN s.is_valid THEN 1 END) as valid_shares_last_24h,
                    AVG(s.processing_time_ms) as avg_processing_time,
                    COUNT(CASE WHEN s.meets_network_difficulty THEN 1 END) as blocks_found
                FROM miners m
                LEFT JOIN shares s ON m.id = s.miner_id AND s.submitted_at >= NOW() - INTERVAL '24 hours'
                WHERE m.id = $1
                GROUP BY m.id, m.username, m.ip_address, m.connected_at, m.total_shares, m.valid_shares
            `;
            params = [minerId];
        } else {
            query = `
                SELECT 
                    m.id, m.username, m.ip_address, m.connected_at,
                    m.total_shares, m.valid_shares,
                    COUNT(s.id) as shares_last_24h,
                    COUNT(CASE WHEN s.is_valid THEN 1 END) as valid_shares_last_24h,
                    AVG(s.processing_time_ms) as avg_processing_time,
                    COUNT(CASE WHEN s.meets_network_difficulty THEN 1 END) as blocks_found
                FROM miners m
                LEFT JOIN shares s ON m.id = s.miner_id AND s.submitted_at >= NOW() - INTERVAL '24 hours'
                GROUP BY m.id, m.username, m.ip_address, m.connected_at, m.total_shares, m.valid_shares
                ORDER BY m.connected_at DESC
            `;
            params = [];
        }

        const result = await this.pool.query(query, params);
        return result.rows;
    }

    async getRecentShares(limit = 10) {
        const result = await this.pool.query(`
            SELECT 
                s.submitted_at, s.is_valid, s.meets_network_difficulty,
                s.nonce, s.processing_time_ms, s.block_hash,
                m.username
            FROM shares s
            JOIN miners m ON s.miner_id = m.id
            ORDER BY s.submitted_at DESC
            LIMIT $1
        `, [limit]);

        return result.rows;
    }

    async getSystemHealth() {
        try {
            // Test database connection
            const dbTest = await this.pool.query('SELECT NOW()');
            
            // Get basic stats
            const stats = await this.pool.query(`
                SELECT 
                    COUNT(DISTINCT miner_id) as active_miners,
                    COUNT(*) as shares_last_hour
                FROM shares 
                WHERE submitted_at >= NOW() - INTERVAL '1 hour'
            `);

            return {
                status: 'healthy',
                timestamp: new Date().toISOString(),
                database: {
                    connected: true,
                    responseTime: Date.now() - parseInt(dbTest.rows[0].now)
                },
                mining: {
                    activeMiners: parseInt(stats.rows[0].active_miners),
                    sharesLastHour: parseInt(stats.rows[0].shares_last_hour)
                }
            };
        } catch (error) {
            throw new Error(`System health check failed: ${error.message}`);
        }
    }

    start(port = 3334) {
        this.app.listen(port, '0.0.0.0', () => {
            console.log(`Enhanced dashboard available at http://localhost:${port}/dashboard.html`);
            console.log(`API endpoints available:`);
            console.log(`  - GET /api/realtime-stats`);
            console.log(`  - GET /api/hashrate-history/:hours`);
            console.log(`  - GET /api/performance-analytics`);
            console.log(`  - GET /api/blocks-found`);
            console.log(`  - GET /api/miner-performance/:minerId`);
            console.log(`  - GET /api/health`);
            console.log(`  - GET /api/live-shares (SSE)`);
        });
    }
}

// Start the enhanced dashboard
const dashboard = new EnhancedDashboard();
dashboard.start(3334);