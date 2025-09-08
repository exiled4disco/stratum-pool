const { Pool } = require('pg');

class DatabaseConnector {
    constructor() {
        this.pool = new Pool({
            user: 'pool_user',
            host: 'localhost',
            database: 'mining_pool',
            password: '911_+ChildMan!',
            port: 5432,
            max: 20, // max connections
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });
        
        this.pool.on('error', (err) => {
            console.error('Database pool error:', err);
        });
    }

    async logMinerConnection(minerId, username, ipAddress) {
        try {
            await this.pool.query(
                'INSERT INTO miners (id, username, ip_address) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET connected_at = NOW()',
                [minerId, username, ipAddress]
            );
            console.log(`📝 DB: Logged miner connection - ${username} (${ipAddress})`);
        } catch (error) {
            console.error('Error logging miner connection:', error);
        }
    }

    async logMinerDisconnection(minerId) {
        try {
            await this.pool.query(
                'UPDATE miners SET disconnected_at = NOW() WHERE id = $1',
                [minerId]
            );
            console.log(`📝 DB: Logged miner disconnection - ${minerId}`);
        } catch (error) {
            console.error('Error logging miner disconnection:', error);
        }
    }

    async logShare(minerId, jobId, nonce, isValid, meetsPoolDiff, meetsNetworkDiff, blockHash, processingTime) {
        try {
            const result = await this.pool.query(
                `INSERT INTO shares (miner_id, job_id, nonce, is_valid, meets_pool_difficulty, meets_network_difficulty, block_hash, processing_time_ms) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                [minerId, jobId, nonce, isValid, meetsPoolDiff, meetsNetworkDiff, blockHash, processingTime]
            );
            
            await this.pool.query(
                'UPDATE miners SET total_shares = total_shares + 1, valid_shares = valid_shares + $2 WHERE id = $1',
                [minerId, isValid ? 1 : 0]
            );
            
            // Only log blocks or errors
            if (meetsNetworkDiff) {
                console.log(`🎉 BLOCK FOUND - Share #${result.rows[0].id}`);
            }
        } catch (error) {
            console.error('Error logging share:', error);
        }
    }

    async logBlockFound(minerId, blockHash, blockHeight) {
        try {
            const result = await this.pool.query(
                'INSERT INTO blocks (miner_id, block_hash, block_height) VALUES ($1, $2, $3) RETURNING id',
                [minerId, blockHash, blockHeight]
            );
            console.log(`🎉 DB: BLOCK FOUND logged - ID: ${result.rows[0].id}, Hash: ${blockHash}`);
        } catch (error) {
            console.error('Error logging block found:', error);
        }
    }

    async logPoolStats(totalMiners, totalShares, validShares, efficiency, blockHeight, networkDifficulty) {
        try {
            await this.pool.query(
                'INSERT INTO pool_stats (total_miners, total_shares, valid_shares, efficiency, current_block_height, network_difficulty) VALUES ($1, $2, $3, $4, $5, $6)',
                [totalMiners, totalShares, validShares, efficiency, blockHeight, networkDifficulty]
            );
            console.log(`📈 DB: Pool stats logged - Miners: ${totalMiners}, Shares: ${validShares}/${totalShares} (${efficiency}%)`);
        } catch (error) {
            console.error('Error logging pool stats:', error);
        }
    }

    async getRealtimeStats() {
        try {
            const result = await this.pool.query(`
                SELECT 
                    COUNT(DISTINCT m.id) as active_miners,
                    COUNT(s.id) as total_shares_today,
                    COUNT(CASE WHEN s.is_valid THEN 1 END) as valid_shares_today,
                    COUNT(b.id) as blocks_found_today
                FROM miners m
                LEFT JOIN shares s ON m.id = s.miner_id AND s.submitted_at >= CURRENT_DATE
                LEFT JOIN blocks b ON m.id = b.miner_id AND b.found_at >= CURRENT_DATE
                WHERE m.disconnected_at IS NULL OR m.disconnected_at >= CURRENT_DATE
            `);
            return result.rows[0];
        } catch (error) {
            console.error('Error getting realtime stats:', error);
            return null;
        }
    }
}

module.exports = DatabaseConnector;