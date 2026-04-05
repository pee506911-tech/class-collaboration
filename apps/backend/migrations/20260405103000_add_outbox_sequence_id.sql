-- Add an append-only sequence for outbox-backed ordering tokens.
-- We keep UUID `id` as the primary key for status updates and add a separate
-- AUTO_INCREMENT sequence for monotonic event ordering.

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
        ADD COLUMN sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE
        AFTER id',
    'SELECT "Column sequence_id already exists"'
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
