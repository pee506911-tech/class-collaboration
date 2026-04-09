-- Fix vote_sequence and qa_sequence column types from BIGINT to BIGINT UNSIGNED.
-- These were incorrectly created as signed BIGINT in production before migration
-- 20260402100001 was finalized with UNSIGNED type definitions.
--
-- MySQL/TiDB: guard via information_schema + dynamic SQL since
-- MODIFY COLUMN is not idempotent by default.

-- 1) Fix vote_sequence column type
SET @col_info = (
    SELECT CONCAT(data_type, IF(column_type LIKE '%unsigned%', ' unsigned', ''))
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'sessions'
      AND column_name = 'vote_sequence'
    LIMIT 1
);
SET @fix_vote_seq = IF(
    @col_info != 'bigint unsigned',
    'ALTER TABLE sessions MODIFY COLUMN vote_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0',
    'SELECT "Column vote_sequence already BIGINT UNSIGNED"'
);
PREPARE stmt FROM @fix_vote_seq;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2) Fix qa_sequence column type
SET @col_info = (
    SELECT CONCAT(data_type, IF(column_type LIKE '%unsigned%', ' unsigned', ''))
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'sessions'
      AND column_name = 'qa_sequence'
    LIMIT 1
);
SET @fix_qa_seq = IF(
    @col_info != 'bigint unsigned',
    'ALTER TABLE sessions MODIFY COLUMN qa_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0',
    'SELECT "Column qa_sequence already BIGINT UNSIGNED"'
);
PREPARE stmt FROM @fix_qa_seq;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
