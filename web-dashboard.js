const express = require('express');
const { Pool } = require('pg');
const path = require('path');

class DatabaseDashboard {
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
        
        // Real-time stats from database
        this.app.get('/api/realtime-stats', async (req, res) => {
            try {
                // Get current active miners
                const minersResult = await this.pool.query(`
                    SELECT 
                        id, username, ip_address, connected_at,
                        total_shares, valid_shares,
                        CASE 
                            WHEN disconnected_at IS NULL THEN true 
                            WHEN disconnected_at >= NOW() - INTERVAL '2 minutes' THEN true
                            ELSE false 
                        END as is_connected
                    FROM miners 
                    WHERE connected_at >= CURRENT_DATE
                    ORDER BY connected_at DESC
                    LIMIT 20
                `);

                // Get today's share statistics
                const sharesResult = await this.pool.query(`
                    SELECT 
                        COUNT(*) as total_shares_today,
                        COUNT(CASE WHEN is_valid THEN 1 END) as valid_shares_today,
                        COUNT(CASE WHEN meets_network_difficulty THEN 1 END) as blocks_found_today,
                        AVG(processing_time_ms) as avg_processing_time
                    FROM shares 
                    WHERE submitted_at >= CURRENT_DATE
                `);

                // Get latest pool stats
                const poolStatsResult = await this.pool.query(`
                    SELECT * FROM pool_stats 
                    ORDER BY recorded_at DESC 
                    LIMIT 1
                `);

                // Get recent activity (last 20 shares)
                const activityResult = await this.pool.query(`
                    SELECT 
                        s.submitted_at, s.is_valid, s.meets_network_difficulty,
                        s.nonce, m.username, s.processing_time_ms
                    FROM shares s
                    JOIN miners m ON s.miner_id = m.id
                    ORDER BY s.submitted_at DESC
                    LIMIT 20
                `);

                const stats = sharesResult.rows[0];
                const poolStats = poolStatsResult.rows[0] || {};
                
                res.json({
                    miners: minersResult.rows,
                    stats: {
                        totalMiners: minersResult.rows.filter(m => m.is_connected).length,
                        totalShares: parseInt(stats.total_shares_today) || 0,
                        validShares: parseInt(stats.valid_shares_today) || 0,
                        blocksFound: parseInt(stats.blocks_found_today) || 0,
                        efficiency: stats.total_shares_today > 0 ? 
                            ((stats.valid_shares_today / stats.total_shares_today) * 100).toFixed(1) : '0.0',
                        avgProcessingTime: parseFloat(stats.avg_processing_time) || 0,
                        currentBlockHeight: poolStats.current_block_height || 0,
                        networkDifficulty: poolStats.network_difficulty || 0
                    },
                    recentActivity: activityResult.rows
                });
            } catch (error) {
                console.error('Database query error:', error);
                res.status(500).json({ error: 'Database error' });
            }
        });
    }

    start(port = 3334) {
        this.app.listen(port, '0.0.0.0', () => {
            console.log(`Database dashboard available at http://localhost:${port}/dashboard.html`);
        });
    }
}

// Start the dashboard
const dashboard = new DatabaseDashboard();
dashboard.start(3334);