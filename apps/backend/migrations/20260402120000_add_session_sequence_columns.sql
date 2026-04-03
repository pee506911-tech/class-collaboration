-- Add vote_sequence and qa_sequence columns to sessions for realtime event ordering
-- This migration is idempotent and safe to run on already-migrated databases
-- Addresses R-02: Non-monotonic realtime ordering

-- Add vote_sequence to sessions if not exists
SET @col_exists = (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sessions' AND column_name = 'vote_sequence');
SET @sql = IF(@col_exists = 0,
    'ALTER TABLE sessions ADD COLUMN vote_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0',
    'SELECT "Column vote_sequence already exists"');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add qa_sequence to sessions if not exists
SET @col_exists = (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sessions' AND column_name = 'qa_sequence');
SET @sql = IF(@col_exists = 0,
    'ALTER TABLE sessions ADD COLUMN qa_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0',
    'SELECT "Column qa_sequence already exists"');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add index for faster sequence lookups if not exists
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'sessions' AND index_name = 'idx_sessions_id_sequence');
SET @sql = IF(@idx_exists = 0,
    'ALTER TABLE sessions ADD INDEX idx_sessions_id_sequence (id, vote_sequence, qa_sequence)',
    'SELECT "Index already exists"');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
