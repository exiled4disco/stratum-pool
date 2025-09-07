const { Pool } = require('pg');
const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');

class MiningPoolMonitor extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            checkInterval: config.checkInterval || 30000, // 30 seconds
            alertCooldown: config.alertCooldown || 300000, // 5 minutes
            logFile: config.logFile || './logs/monitor.log',
            ...config
        };
        
        this.pool = new Pool({
            user: 'pool_user',
            host: 'localhost',
            database: 'mining_pool',
            password: '911_+ChildMan!',
            port: 5432,
        });
        
        this.alertCooldowns = new Map();
        this.lastBlockCount = 0;
        this.baselineMetrics = null;
        this.isRunning = false;
        
        this.setupEventHandlers();
    }

    setupEventHandlers() {
        this.on('alert', this.handleAlert.bind(this));
        this.on('blockFound', this.handleBlockFound.bind(this));
        this.on('minerDisconnected', this.handleMinerDisconnected.bind(this));
        this.on('efficiencyDrop', this.handleEfficiencyDrop.bind(this));
        this.on('systemError', this.handleSystemError.bind(this));
    }

    async start() {
        console.log('🔍 Starting mining pool monitor...');
        this.isRunning = true;
        
        // Initialize baseline metrics
        await this.initializeBaseline();
        
        // Start monitoring loops
        this.startHealthChecks();
        this.startPerformanceMonitoring();
        this.startAlertChecking();
        this.startDataCleanup();
        
        console.log('✅ Mining pool monitor started successfully');
    }

    async stop() {
        console.log('🛑 Stopping mining pool monitor...');
        this.isRunning = false;
        await this.pool.end();
        console.log('✅ Monitor stopped');
    }

    async initializeBaseline() {
        try {
            const result = await this.pool.query(`
                SELECT 
                    AVG(processing_time_ms) as avg_processing_time,
                    COUNT(DISTINCT miner_id) as typical_miners,
                    AVG(CASE WHEN total_shares > 0 THEN (valid_shares::decimal / total_shares * 100) ELSE 0 END) as avg_efficiency
                FROM shares s
                JOIN miners m ON s.miner_id = m.id
                WHERE s.submitted_at >= NOW() - INTERVAL '7 days'
            `);
            
            this.baselineMetrics = result.rows[0];
            console.log('📊 Baseline metrics initialized:', this.baselineMetrics);
        } catch (error) {
            console.error('Failed to initialize baseline metrics:', error);
        }
    }

    startHealthChecks() {
        setInterval(async () => {
            if (!this.isRunning) return;
            
            try {
                await this.performHealthChecks();
            } catch (error) {
                this.emit('systemError', { message: 'Health check failed', error: error.message });
            }
        }, this.config.checkInterval);
    }

    startPerformanceMonitoring() {
        setInterval(async () => {
            if (!this.isRunning) return;
            
            try {
                await this.collectPerformanceMetrics();
                await this.updateHashrateHistory();
            } catch (error) {
                console.error('Performance monitoring error:', error);
            }
        }, 60000); // Every minute
    }

    startAlertChecking() {
        setInterval(async () => {
            if (!this.isRunning) return;
            
            try {
                await this.checkForAlerts();
            } catch (error) {
                console.error('Alert checking error:', error);
            }
        }, this.config.checkInterval);
    }

    startDataCleanup() {
        // Run cleanup every hour
        setInterval(async () => {
            if (!this.isRunning) return;
            
            try {
                await this.cleanupOldData();
            } catch (error) {
                console.error('Data cleanup error:', error);
            }
        }, 3600000); // Every hour
    }

    async performHealthChecks() {
        const checks = [];
        
        // Database connectivity check
        checks.push(this.checkDatabaseHealth());
        
        // Miner connectivity check
        checks.push(this.checkMinerConnectivity());
        
        // Share submission rate check
        checks.push(this.checkShareSubmissionRate());
        
        // Processing time check
        checks.push(this.checkProcessingTimes());
        
        // Block height synchronization check
        checks.push(this.checkBlockHeightSync());
        
        const results = await Promise.allSettled(checks);
        
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                this.emit('systemError', {
                    check: ['database', 'miners', 'shares', 'processing', 'sync'][index],
                    error: result.reason
                });
            }
        });
    }

    async checkDatabaseHealth() {
        const start = Date.now();
        const result = await this.pool.query('SELECT NOW()');
        const responseTime = Date.now() - start;
        
        if (responseTime > 1000) {
            this.emit('alert', {
                type: 'database_slow',
                severity: 'warning',
                message: `Database response time is ${responseTime}ms (>1000ms threshold)`,
                data: { responseTime }
            });
        }
        
        return { responseTime, healthy: true };
    }

    async checkMinerConnectivity() {
        const result = await this.pool.query(`
            SELECT 
                COUNT(*) as total_miners,
                COUNT(CASE WHEN disconnected_at IS NULL THEN 1 END) as connected_miners,
                COUNT(CASE WHEN last_share_at >= NOW() - INTERVAL '5 minutes' THEN 1 END) as active_miners
            FROM miners
            WHERE connected_at >= NOW() - INTERVAL '1 hour'
        `);
        
        const stats = result.rows[0];
        
        if (stats.connected_miners === 0 && stats.total_miners > 0) {
            this.emit('alert', {
                type: 'no_miners_connected',
                severity: 'critical',
                message: 'No miners currently connected to the pool',
                data: stats
            });
        }
        
        if (stats.active_miners < stats.connected_miners * 0.8) {
            this.emit('alert', {
                type: 'low_miner_activity',
                severity: 'warning',
                message: `Only ${stats.active_miners} of ${stats.connected_miners} connected miners are actively mining`,
                data: stats
            });
        }
        
        return stats;
    }

    async checkShareSubmissionRate() {
        const result = await this.pool.query(`
            SELECT 
                COUNT(*) as shares_last_5min,
                COUNT(CASE WHEN is_valid THEN 1 END) as valid_shares_last_5min,
                COUNT(DISTINCT miner_id) as active_miners
            FROM shares
            WHERE submitted_at >= NOW() - INTERVAL '5 minutes'
        `);
        
        const stats = result.rows[0];
        const expectedMinShares = stats.active_miners * 5; // Rough expectation
        
        if (stats.active_miners > 0 && stats.shares_last_5min < expectedMinShares) {
            this.emit('alert', {
                type: 'low_share_rate',
                severity: 'warning',
                message: `Share submission rate is low: ${stats.shares_last_5min} shares in 5 minutes (expected ~${expectedMinShares})`,
                data: stats
            });
        }
        
        const efficiency = stats.shares_last_5min > 0 ? 
            (stats.valid_shares_last_5min / stats.shares_last_5min * 100) : 0;
        
        if (efficiency < 80 && stats.shares_last_5min > 10) {
            this.emit('efficiencyDrop', {
                efficiency,
                shares: stats.shares_last_5min,
                validShares: stats.valid_shares_last_5min
            });
        }
        
        return stats;
    }

    async checkProcessingTimes() {
        const result = await this.pool.query(`
            SELECT 
                AVG(processing_time_ms) as avg_processing_time,
                MAX(processing_time_ms) as max_processing_time,
                COUNT(CASE WHEN processing_time_ms > 100 THEN 1 END) as slow_shares
            FROM shares
            WHERE submitted_at >= NOW() - INTERVAL '5 minutes'
        `);
        
        const stats = result.rows[0];
        
        if (stats.avg_processing_time > 50) {
            this.emit('alert', {
                type: 'high_processing_time',
                severity: 'warning',
                message: `Average processing time is ${stats.avg_processing_time.toFixed(2)}ms (>50ms threshold)`,
                data: stats
            });
        }
        
        if (stats.max_processing_time > 500) {
            this.emit('alert', {
                type: 'very_high_processing_time',
                severity: 'error',
                message: `Maximum processing time is ${stats.max_processing_time.toFixed(2)}ms (>500ms threshold)`,
                data: stats
            });
        }
        
        return stats;
    }

    async checkBlockHeightSync() {
        const result = await this.pool.query(`
            SELECT current_block_height, recorded_at
            FROM pool_stats
            ORDER BY recorded_at DESC
            LIMIT 1
        `);
        
        if (result.rows.length === 0) return { synced: false };
        
        const stats = result.rows[0];
        const ageMinutes = (Date.now() - new Date(stats.recorded_at)) / 60000;
        
        if (ageMinutes > 15) {
            this.emit('alert', {
                type: 'stale_block_height',
                severity: 'warning',
                message: `Block height data is ${ageMinutes.toFixed(1)} minutes old`,
                data: { blockHeight: stats.current_block_height, ageMinutes }
            });
        }
        
        return { blockHeight: stats.current_block_height, ageMinutes, synced: true };
    }

    async collectPerformanceMetrics() {
        // Collect various performance metrics
        const metrics = [
            { type: 'share_rate', query: this.getShareRateMetric() },
            { type: 'efficiency', query: this.getEfficiencyMetric() },
            { type: 'processing_time', query: this.getProcessingTimeMetric() },
            { type: 'miner_count', query: this.getMinerCountMetric() }
        ];
        
        for (const metric of metrics) {
            try {
                const result = await this.pool.query(metric.query);
                if (result.rows.length > 0) {
                    await this.storePerformanceMetric(metric.type, result.rows[0]);
                }
            } catch (error) {
                console.error(`Error collecting ${metric.type} metric:`, error);
            }
        }
    }

    getShareRateMetric() {
        return `
            SELECT 
                COUNT(*) as total_shares,
                COUNT(CASE WHEN is_valid THEN 1 END) as valid_shares,
                COUNT(DISTINCT miner_id) as active_miners
            FROM shares
            WHERE submitted_at >= NOW() - INTERVAL '1 minute'
        `;
    }

    getEfficiencyMetric() {
        return `
            SELECT 
                CASE WHEN COUNT(*) > 0 THEN 
                    COUNT(CASE WHEN is_valid THEN 1 END)::decimal / COUNT(*) * 100 
                ELSE 0 END as efficiency
            FROM shares
            WHERE submitted_at >= NOW() - INTERVAL '5 minutes'
        `;
    }

    getProcessingTimeMetric() {
        return `
            SELECT 
                AVG(processing_time_ms) as avg_processing_time,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY processing_time_ms) as p95_processing_time
            FROM shares
            WHERE submitted_at >= NOW() - INTERVAL '1 minute'
        `;
    }

    getMinerCountMetric() {
        return `
            SELECT 
                COUNT(DISTINCT id) as connected_miners,
                COUNT(DISTINCT CASE WHEN last_share_at >= NOW() - INTERVAL '5 minutes' THEN id END) as active_miners
            FROM miners
            WHERE disconnected_at IS NULL
        `;
    }

    async storePerformanceMetric(metricType, data) {
        const metricValue = this.extractMetricValue(metricType, data);
        
        await this.pool.query(`
            INSERT INTO performance_metrics (metric_type, metric_value, time_period, additional_data)
            VALUES ($1, $2, '1min', $3)
        `, [metricType, metricValue, JSON.stringify(data)]);
    }

    extractMetricValue(metricType, data) {
        switch (metricType) {
            case 'share_rate': return data.total_shares;
            case 'efficiency': return data.efficiency;
            case 'processing_time': return data.avg_processing_time;
            case 'miner_count': return data.active_miners;
            default: return 0;
        }
    }

    async updateHashrateHistory() {
        const result = await this.pool.query(`
            SELECT 
                COUNT(DISTINCT miner_id) as active_miners,
                COUNT(*) as shares_last_hour,
                COUNT(CASE WHEN is_valid THEN 1 END) as valid_shares_last_hour
            FROM shares
            WHERE submitted_at >= NOW() - INTERVAL '1 hour'
        `);
        
        const stats = result.rows[0];
        const estimatedHashrate = this.calculateHashrate(stats.shares_last_hour, 60);
        const efficiency = stats.shares_last_hour > 0 ? 
            (stats.valid_shares_last_hour / stats.shares_last_hour * 100) : 0;
        
        await this.pool.query(`
            INSERT INTO hashrate_history (estimated_hashrate, active_miners, total_shares_hour, valid_shares_hour, efficiency)
            VALUES ($1, $2, $3, $4, $5)
        `, [estimatedHashrate, stats.active_miners, stats.shares_last_hour, stats.valid_shares_last_hour, efficiency]);
    }

    calculateHashrate(shares, minutes) {
        // Simplified hashrate calculation
        // Real calculation would use network difficulty and share difficulty
        if (shares === 0 || minutes === 0) return 0;
        return (shares / minutes) * 0.2388; // Very rough approximation for difficulty 1
    }

    async checkForAlerts() {
        // Check for blocks found
        await this.checkForNewBlocks();
        
        // Check miner-specific issues
        await this.checkMinerIssues();
        
        // Check system-wide issues
        await this.checkSystemIssues();
        
        // Run database alert function
        await this.runDatabaseAlertChecks();
    }

    async checkForNewBlocks() {
        const result = await this.pool.query(`
            SELECT COUNT(*) as block_count
            FROM blocks
        `);
        
        const currentBlockCount = parseInt(result.rows[0].block_count);
        
        if (currentBlockCount > this.lastBlockCount) {
            const newBlocks = currentBlockCount - this.lastBlockCount;
            this.emit('blockFound', { newBlocks, totalBlocks: currentBlockCount });
            this.lastBlockCount = currentBlockCount;
        }
    }

    async checkMinerIssues() {
        // Check for miners with unusual behavior
        const result = await this.pool.query(`
            SELECT 
                m.id, m.username, m.ip_address,
                COUNT(s.id) as shares_last_10min,
                AVG(s.processing_time_ms) as avg_processing_time
            FROM miners m
            LEFT JOIN shares s ON m.id = s.miner_id AND s.submitted_at >= NOW() - INTERVAL '10 minutes'
            WHERE m.disconnected_at IS NULL
            GROUP BY m.id, m.username, m.ip_address
            HAVING COUNT(s.id) = 0 AND m.connected_at < NOW() - INTERVAL '10 minutes'
        `);
        
        for (const miner of result.rows) {
            this.emit('minerDisconnected', miner);
        }
    }

    async checkSystemIssues() {
        // Check for system-wide performance degradation
        if (!this.baselineMetrics) return;
        
        const result = await this.pool.query(`
            SELECT 
                AVG(processing_time_ms) as current_avg_processing,
                COUNT(*) as shares_count
            FROM shares
            WHERE submitted_at >= NOW() - INTERVAL '5 minutes'
        `);
        
        const current = result.rows[0];
        
        if (current.shares_count > 10 && 
            current.current_avg_processing > this.baselineMetrics.avg_processing_time * 2) {
            this.emit('alert', {
                type: 'performance_degradation',
                severity: 'warning',
                message: `Processing time is ${(current.current_avg_processing / this.baselineMetrics.avg_processing_time).toFixed(1)}x baseline`,
                data: { current: current.current_avg_processing, baseline: this.baselineMetrics.avg_processing_time }
            });
        }
    }

    async runDatabaseAlertChecks() {
        try {
            const result = await this.pool.query('SELECT check_and_create_alerts()');
            const alertCount = result.rows[0].check_and_create_alerts;
            
            if (alertCount > 0) {
                console.log(`📢 Created ${alertCount} new alerts`);
            }
        } catch (error) {
            console.error('Database alert check error:', error);
        }
    }

    async handleAlert(alert) {
        const alertKey = `${alert.type}_${alert.data?.minerId || 'system'}`;
        
        // Check cooldown
        if (this.alertCooldowns.has(alertKey)) {
            const lastAlert = this.alertCooldowns.get(alertKey);
            if (Date.now() - lastAlert < this.config.alertCooldown) {
                return; // Skip duplicate alert within cooldown period
            }
        }
        
        this.alertCooldowns.set(alertKey, Date.now());
        
        // Log to database
        await this.logSystemEvent(alert.type, alert.message, alert.severity, alert.data);
        
        // Log to console with appropriate formatting
        const emoji = this.getSeverityEmoji(alert.severity);
        console.log(`${emoji} ALERT [${alert.severity.toUpperCase()}]: ${alert.message}`);
        
        // Log to file
        await this.logToFile(`[${new Date().toISOString()}] ${alert.severity.toUpperCase()}: ${alert.message}`, alert.data);
        
        // Could add webhook notifications, email alerts, etc. here
        this.sendWebhookAlert(alert);
    }

    async handleBlockFound(data) {
        const message = `🎉 BLOCK FOUND! Total blocks discovered: ${data.totalBlocks}`;
        console.log(message);
        
        await this.logSystemEvent('block_found', message, 'info', data);
        await this.logToFile(`[${new Date().toISOString()}] BLOCK_FOUND: ${message}`, data);
        
        // Special notification for block discovery
        this.sendWebhookAlert({
            type: 'block_found',
            severity: 'info',
            message: message,
            data: data
        });
    }

    async handleMinerDisconnected(miner) {
        const message = `Miner ${miner.username} (${miner.ip_address}) appears disconnected - no shares in 10 minutes`;
        
        await this.logSystemEvent('miner_inactive', message, 'warning', { minerId: miner.id });
        console.log(`⚠️  ${message}`);
    }

    async handleEfficiencyDrop(data) {
        const message = `Pool efficiency dropped to ${data.efficiency.toFixed(1)}% (${data.validShares}/${data.shares} shares)`;
        
        await this.logSystemEvent('efficiency_drop', message, 'warning', data);
        console.log(`📉 ${message}`);
    }

    async handleSystemError(error) {
        const message = `System error: ${error.message}`;
        
        await this.logSystemEvent('system_error', message, 'error', error);
        console.error(`❌ ${message}`);
    }

    getSeverityEmoji(severity) {
        const emojis = {
            'info': 'ℹ️',
            'warning': '⚠️',
            'error': '❌',
            'critical': '🚨'
        };
        return emojis[severity] || 'ℹ️';
    }

    async logSystemEvent(eventType, message, severity = 'info', data = null) {
        try {
            await this.pool.query(`
                INSERT INTO events (event_type, severity, message, details)
                VALUES ($1, $2, $3, $4)
            `, [eventType, severity, message, JSON.stringify(data)]);
        } catch (error) {
            console.error('Failed to log system event:', error);
        }
    }

    async logToFile(message, data = null) {
        try {
            const logDir = path.dirname(this.config.logFile);
            await fs.mkdir(logDir, { recursive: true });
            
            const logEntry = data ? `${message}\nData: ${JSON.stringify(data, null, 2)}\n\n` : `${message}\n`;
            await fs.appendFile(this.config.logFile, logEntry);
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
    }

    sendWebhookAlert(alert) {
        // Implement webhook notifications here
        // Example: send to Discord, Slack, or custom webhook endpoint
        // This is a placeholder for external notification integration
        
        if (process.env.WEBHOOK_URL) {
            // Example webhook implementation
            console.log(`📡 Would send webhook alert: ${alert.message}`);
            // fetch(process.env.WEBHOOK_URL, { ... })
        }
    }

    async cleanupOldData() {
        const cleanupQueries = [
            // Keep events for 30 days
            "DELETE FROM events WHERE created_at < NOW() - INTERVAL '30 days'",
            
            // Keep performance metrics for 7 days
            "DELETE FROM performance_metrics WHERE recorded_at < NOW() - INTERVAL '7 days'",
            
            // Keep hashrate history for 90 days
            "DELETE FROM hashrate_history WHERE timestamp < NOW() - INTERVAL '90 days'",
            
            // Resolve old alerts
            "UPDATE alerts SET resolved_at = NOW() WHERE is_active = true AND created_at < NOW() - INTERVAL '24 hours'"
        ];
        
        for (const query of cleanupQueries) {
            try {
                const result = await this.pool.query(query);
                if (result.rowCount > 0) {
                    console.log(`🧹 Cleaned up ${result.rowCount} records: ${query.split(' ')[2]}`);
                }
            } catch (error) {
                console.error('Cleanup error:', error);
            }
        }
    }

    // Public methods for integration with stratum server
    async recordMinerConnection(minerId, username, ipAddress) {
        await this.logSystemEvent('miner_connected', `Miner ${username} connected from ${ipAddress}`, 'info', { minerId });
    }

    async recordMinerDisconnection(minerId, username) {
        await this.logSystemEvent('miner_disconnected', `Miner ${username} disconnected`, 'info', { minerId });
    }

    async recordBlockSubmission(blockHash, blockHeight, minerId) {
        await this.logSystemEvent('block_submitted', `Block ${blockHash} submitted to network`, 'info', 
            { blockHash, blockHeight, minerId });
    }

    async recordShareValidation(minerId, isValid, processingTime) {
        // Could implement detailed share validation logging here
        if (processingTime > 100) {
            await this.logSystemEvent('slow_share_validation', 
                `Share validation took ${processingTime}ms`, 'warning', { minerId, processingTime });
        }
    }
}

// Export the monitor class
module.exports = MiningPoolMonitor;

// Example usage in your main stratum server:
/*
const MiningPoolMonitor = require('./monitoring-alerting-system');

// In your stratum server initialization:
const monitor = new MiningPoolMonitor({
    checkInterval: 30000,
    alertCooldown: 300000,
    logFile: './logs/mining-monitor.log'
});

monitor.start();

// Integration points in your stratum server:
// monitor.recordMinerConnection(minerId, username, ipAddress);
// monitor.recordMinerDisconnection(minerId, username);
// monitor.recordBlockSubmission(blockHash, blockHeight, minerId);
// monitor.recordShareValidation(minerId, isValid, processingTime);
*/