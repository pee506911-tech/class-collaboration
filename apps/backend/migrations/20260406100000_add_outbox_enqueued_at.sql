-- Add enqueued_at column for speed audit profiling
-- This mirrors created_at but makes the intent explicit for audit tooling
ALTER TABLE outbox_events 
ADD COLUMN enqueued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Index for audit queries
CREATE INDEX idx_outbox_enqueued_at ON outbox_events(enqueued_at);
