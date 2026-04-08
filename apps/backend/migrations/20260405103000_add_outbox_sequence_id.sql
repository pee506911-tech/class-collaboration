-- Add monotonically increasing sequence_id to outbox_events.
-- TiDB-compatible: uses AUTO_INCREMENT instead of CREATE SEQUENCE
-- and IF NOT EXISTS / IF EXISTS syntax (TiDB supports both).

-- 1) Add sequence_id as AUTO_INCREMENT column if it doesn't exist yet.
ALTER TABLE outbox_events
    ADD COLUMN IF NOT EXISTS sequence_id BIGINT UNSIGNED AUTO_INCREMENT UNIQUE;

-- 2) Create composite index for session/type/sequence lookups.
CREATE INDEX IF NOT EXISTS idx_outbox_session_type_sequence
    ON outbox_events (session_id, event_type, sequence_id);
