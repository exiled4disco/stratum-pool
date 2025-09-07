-- Enhanced database schema for Bitcoin mining pool monitoring
-- Run this to add new tables and indexes for better analytics

-- Create events table for system events and alerts
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) DEFAULT 'info', -- info, warning, error, critical
    message TEXT NOT NULL,
    details JSONB,
    miner_id UUID REFERENCES miners(id),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Create hashrate_history table for tracking pool hashrate over time
CREATE TABLE IF NOT EXISTS hashrate_history (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP DEFAULT NOW(),
    estimated_hashrate DECIMAL(15,2), -- TH/s
    active_miners INTEGER,
    total_shares_hour INTEGER,
    valid_shares_hour INTEGER,
    efficiency DECIMAL(5,2)
);

-- Create miner_sessions table for detailed connection tracking
CREATE TABLE IF NOT EXISTS miner_sessions (
    id SERIAL PRIMARY KEY,
    miner_id UUID REFERENCES miners(id),
    session_start TIMESTAMP DEFAULT NOW(),
    session_end TIMESTAMP,
    ip_address INET,
    user_agent TEXT,
    shares_submitted INTEGER DEFAULT 0,
    valid_shares INTEGER DEFAULT 0,
    avg_processing_time DECIMAL(8,3),
    disconnect_reason VARCHAR(100)
);

-- Create performance_metrics table for detailed performance tracking
CREATE TABLE IF NOT EXISTS performance_metrics (
    id SERIAL PRIMARY KEY,
    recorded_at TIMESTAMP DEFAULT NOW(),
    metric_type VARCHAR(50) NOT NULL, -- 'share_rate', 'processing_time', 'efficiency', etc.
    metric_value DECIMAL(15,6),
    miner_id UUID REFERENCES miners(id),
    time_period VARCHAR(20), -- '1min', '5min', '1hour', etc.
    additional_data JSONB
);

-- Create alerts table for monitoring alerts
CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY,
    alert_type VARCHAR(50) NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    severity VARCHAR(20) DEFAULT 'info',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    resolved_at TIMESTAMP,
    miner_id UUID REFERENCES miners(id),
    alert_data JSONB
);

-- Add new columns to existing miners table for enhanced tracking
ALTER TABLE miners 
ADD COLUMN IF NOT EXISTS last_share_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS peak_hashrate DECIMAL(10,2),
ADD COLUMN IF NOT EXISTS avg_efficiency DECIMAL(5,2),
ADD COLUMN IF NOT EXISTS connection_count INTEGER DEFAULT 1,
ADD COLUMN IF NOT EXISTS total_session_time INTERVAL DEFAULT '0 seconds';

-- Add new columns to existing shares table for better analytics  
ALTER TABLE shares
ADD COLUMN IF NOT EXISTS difficulty_target DECIMAL(20,6),
ADD COLUMN IF NOT EXISTS estimated_hashrate DECIMAL(10,2),
ADD COLUMN IF NOT EXISTS session_id INTEGER;

-- Add new columns to pool_stats for enhanced monitoring
ALTER TABLE pool_stats
ADD COLUMN IF NOT EXISTS avg_processing_time DECIMAL(8,3),
ADD COLUMN IF NOT EXISTS peak_hashrate DECIMAL(15,2),
ADD COLUMN IF NOT EXISTS total_connections INTEGER,
ADD COLUMN IF NOT EXISTS error_rate DECIMAL(5,2);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity) WHERE severity IN ('error', 'critical');
CREATE INDEX IF NOT EXISTS idx_hashrate_history_timestamp ON hashrate_history(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_miner_sessions_miner_start ON miner_sessions(miner_id, session_start DESC);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_type_time ON performance_metrics(metric_type, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(is_active, created_at DESC) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_miners_last_share ON miners(last_share_at DESC) WHERE last_share_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shares_difficulty ON shares(difficulty_target, submitted_at DESC);

-- Create views for common queries
CREATE OR REPLACE VIEW active_miners_summary AS
SELECT 
    m.id,
    m.username,
    m.ip_address,
    m.connected_at,
    m.total_shares,
    m.valid_shares,
    m.last_share_at,
    CASE WHEN m.disconnected_at IS NULL THEN true ELSE false END as is_connected,
    COALESCE(m.avg_efficiency, 
        CASE WHEN m.total_shares > 0 THEN (m.valid_shares::decimal / m.total_shares * 100) ELSE 0 END
    ) as efficiency,
    COUNT(s.id) FILTER (WHERE s.submitted_at >= NOW() - INTERVAL '1 hour') as shares_last_hour,
    COUNT(s.id) FILTER (WHERE s.submitted_at >= NOW() - INTERVAL '24 hours') as shares_last_24h
FROM miners m
LEFT JOIN shares s ON m.id = s.miner_id
WHERE m.disconnected_at IS NULL OR m.disconnected_at >= NOW() - INTERVAL '5 minutes'
GROUP BY m.id, m.username, m.ip_address, m.connected_at, m.total_shares, m.valid_shares, 
         m.last_share_at, m.disconnected_at, m.avg_efficiency;

CREATE OR REPLACE VIEW pool_performance_summary AS
SELECT 
    COUNT(DISTINCT m.id) as total_active_miners,
    COUNT(s.id) as total_shares_24h,
    COUNT(s.id) FILTER (WHERE s.is_valid) as valid_shares_24h,
    COUNT(s.id) FILTER (WHERE s.meets_network_difficulty) as blocks_found_24h,
    AVG(s.processing_time_ms) as avg_processing_time,
    COUNT(s.id) FILTER (WHERE s.submitted_at >= NOW() - INTERVAL '1 hour') as shares_last_hour,
    CASE WHEN COUNT(s.id) > 0 THEN 
        (COUNT(s.id) FILTER (WHERE s.is_valid)::decimal / COUNT(s.id) * 100) 
    ELSE 0 END as overall_efficiency
FROM miners m
LEFT JOIN shares s ON m.id = s.miner_id AND s.submitted_at >= NOW() - INTERVAL '24 hours'
WHERE m.disconnected_at IS NULL OR m.disconnected_at >= NOW() - INTERVAL '5 minutes';

-- Function to calculate estimated hashrate based on shares
CREATE OR REPLACE FUNCTION calculate_estimated_hashrate(
    share_count INTEGER,
    time_period_minutes INTEGER,
    difficulty DECIMAL DEFAULT 1.0
) RETURNS DECIMAL AS $$
BEGIN
    -- Rough estimation: shares per minute * difficulty * 4.295 billion / 60
    -- This is a simplified calculation - real pools use more sophisticated methods
    IF time_period_minutes = 0 OR share_count = 0 THEN
        RETURN 0;
    END IF;
    
    RETURN (share_count::decimal / time_period_minutes) * difficulty * 71583333.33; -- TH/s approximation
END;
$$ LANGUAGE plpgsql;

-- Function to log system events
CREATE OR REPLACE FUNCTION log_system_event(
    event_type VARCHAR(50),
    message TEXT,
    severity VARCHAR(20) DEFAULT 'info',
    miner_id UUID DEFAULT NULL,
    event_details JSONB DEFAULT NULL
) RETURNS INTEGER AS $$
DECLARE
    event_id INTEGER;
BEGIN
    INSERT INTO events (event_type, severity, message, details, miner_id)
    VALUES (event_type, severity, message, event_details, miner_id)
    RETURNING id INTO event_id;
    
    RETURN event_id;
END;
$$ LANGUAGE plpgsql;

-- Function to create alerts based on conditions
CREATE OR REPLACE FUNCTION check_and_create_alerts() RETURNS INTEGER AS $$
DECLARE
    alert_count INTEGER := 0;
    miner_record RECORD;
BEGIN
    -- Check for miners with low efficiency
    FOR miner_record IN 
        SELECT m.id, m.username, 
               CASE WHEN m.total_shares > 0 THEN (m.valid_shares::decimal / m.total_shares * 100) ELSE 0 END as efficiency
        FROM miners m 
        WHERE m.disconnected_at IS NULL 
        AND m.total_shares > 100 -- Only check miners with significant share count
        AND CASE WHEN m.total_shares > 0 THEN (m.valid_shares::decimal / m.total_shares * 100) ELSE 0 END < 85
    LOOP
        -- Check if alert already exists and is active
        IF NOT EXISTS (
            SELECT 1 FROM alerts 
            WHERE miner_id = miner_record.id 
            AND alert_type = 'low_efficiency' 
            AND is_active = true
        ) THEN
            INSERT INTO alerts (alert_type, title, description, severity, miner_id, alert_data)
            VALUES (
                'low_efficiency',
                'Low Mining Efficiency',
                'Miner ' || miner_record.username || ' has efficiency below 85%',
                'warning',
                miner_record.id,
                jsonb_build_object('efficiency', miner_record.efficiency)
            );
            alert_count := alert_count + 1;
        END IF;
    END LOOP;
    
    -- Check for no shares in last 10 minutes (possible connection issues)
    FOR miner_record IN
        SELECT m.id, m.username
        FROM miners m
        WHERE m.disconnected_at IS NULL
        AND NOT EXISTS (
            SELECT 1 FROM shares s 
            WHERE s.miner_id = m.id 
            AND s.submitted_at >= NOW() - INTERVAL '10 minutes'
        )
        AND m.connected_at < NOW() - INTERVAL '10 minutes' -- Must be connected for at least 10 min
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM alerts 
            WHERE miner_id = miner_record.id 
            AND alert_type = 'no_shares' 
            AND is_active = true
        ) THEN
            INSERT INTO alerts (alert_type, title, description, severity, miner_id)
            VALUES (
                'no_shares',
                'No Shares Received',
                'No shares received from ' || miner_record.username || ' in last 10 minutes',
                'error',
                miner_record.id
            );
            alert_count := alert_count + 1;
        END IF;
    END LOOP;
    
    RETURN alert_count;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update miner last_share_at when new share is submitted
CREATE OR REPLACE FUNCTION update_miner_last_share() RETURNS TRIGGER AS $$
BEGIN
    UPDATE miners 
    SET last_share_at = NEW.submitted_at,
        total_shares = total_shares + 1,
        valid_shares = valid_shares + CASE WHEN NEW.is_valid THEN 1 ELSE 0 END
    WHERE id = NEW.miner_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_miner_last_share ON shares;
CREATE TRIGGER trigger_update_miner_last_share
    AFTER INSERT ON shares
    FOR EACH ROW
    EXECUTE FUNCTION update_miner_last_share();

-- Sample monitoring queries for dashboard

-- Get current pool status
SELECT * FROM pool_performance_summary;

-- Get active miners with performance
SELECT * FROM active_miners_summary ORDER BY shares_last_hour DESC;

-- Get recent system events
SELECT event_type, severity, message, created_at, details
FROM events 
WHERE created_at >= NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;

-- Get active alerts
SELECT alert_type, title, description, severity, created_at, 
       m.username as miner_username
FROM alerts a
LEFT JOIN miners m ON a.miner_id = m.id
WHERE is_active = true
ORDER BY created_at DESC;

-- Get hashrate trend (last 24 hours)
SELECT timestamp, estimated_hashrate, active_miners, efficiency
FROM hashrate_history 
WHERE timestamp >= NOW() - INTERVAL '24 hours'
ORDER BY timestamp ASC;

-- Performance analytics query
SELECT 
    DATE_TRUNC('hour', submitted_at) as hour,
    COUNT(*) as total_shares,
    COUNT(CASE WHEN is_valid THEN 1 END) as valid_shares,
    AVG(processing_time_ms) as avg_processing_time,
    COUNT(DISTINCT miner_id) as active_miners,
    calculate_estimated_hashrate(COUNT(*), 60, 1.0) as estimated_hashrate
FROM shares
WHERE submitted_at >= NOW() - INTERVAL '24 hours'
GROUP BY DATE_TRUNC('hour', submitted_at)
ORDER BY hour ASC;

-- Comments for implementation:
-- 1. Run this schema enhancement on your existing database
-- 2. Update your stratum server to use the new tables and functions
-- 3. The enhanced dashboard API can now provide much richer analytics
-- 4. Set up automated jobs to run check_and_create_alerts() periodically
-- 5. Consider adding retention policies for historical data