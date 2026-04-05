-- Add an append-only sequence for outbox-backed ordering tokens.
-- TiDB does not support ALTER TABLE ... ADD COLUMN ... AUTO_INCREMENT,
-- so we use a standalone sequence object plus an explicit BIGINT column.

CREATE SEQUENCE IF NOT EXISTS outbox_event_sequence;

SET @col_exists = (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'outbox_events'
      AND column_name = 'sequence_id'
);

SET @sql = IF(
    @col_exists = 0,
    'ALTER TABLE outbox_events
        ADD COLUMN sequence_id BIGINT UNSIGNED NULL
        AFTER id',
    'SELECT "Column sequence_id already exists"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE outbox_events
SET sequence_id = NEXTVAL(outbox_event_sequence)
WHERE sequence_id IS NULL;

SET @idx_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'outbox_events'
      AND index_name = 'idx_outbox_sequence_id'
);

SET @sql = IF(
    @idx_exists = 0,
    'ALTER TABLE outbox_events
        ADD UNIQUE INDEX idx_outbox_sequence_id (sequence_id)',
    'SELECT "Index idx_outbox_sequence_id already exists"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'outbox_events'
      AND index_name = 'idx_outbox_session_type_sequence'
);

SET @sql = IF(
    @idx_exists = 0,
    'ALTER TABLE outbox_events
        ADD INDEX idx_outbox_session_type_sequence (session_id, event_type, sequence_id)',
    'SELECT "Index idx_outbox_session_type_sequence already exists"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
