-- Add monotonically increasing sequence_id to outbox_events.
-- MySQL/TiDB: guard via information_schema + dynamic SQL since
-- ADD COLUMN IF NOT EXISTS is not supported.

-- 1) Add sequence_id column to outbox_events if missing.
--    AUTO_INCREMENT will auto-populate values for existing rows.
SET @col_exists = (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'outbox_events'
      AND column_name = 'sequence_id'
);
SET @sql = IF(
    @col_exists = 0,
    'ALTER TABLE outbox_events ADD COLUMN sequence_id BIGINT UNSIGNED AUTO_INCREMENT UNIQUE',
    'SELECT "Column sequence_id already exists"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2) Create composite index for session/type/sequence lookups if missing.
SET @idx_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'outbox_events'
      AND index_name = 'idx_outbox_session_type_sequence'
);
SET @sql = IF(
    @idx_exists = 0,
    'ALTER TABLE outbox_events ADD INDEX idx_outbox_session_type_sequence (session_id, event_type, sequence_id)',
    'SELECT "Index idx_outbox_session_type_sequence already exists"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
