-- Fix vote_sequence and qa_sequence column types from BIGINT to BIGINT UNSIGNED
-- These were incorrectly created as signed BIGINT in production before migration
-- 20260402100001 was finalized with UNSIGNED type definitions.

ALTER TABLE sessions 
MODIFY COLUMN vote_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
MODIFY COLUMN qa_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0;
