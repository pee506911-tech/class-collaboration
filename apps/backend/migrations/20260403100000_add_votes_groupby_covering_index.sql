-- Add covering index for vote_counts aggregation used by /api/sessions/:id/state
-- Query: SELECT slide_id, option_id, COUNT(*) FROM votes WHERE session_id = ? GROUP BY slide_id, option_id
--
-- In TiDB Cloud (RU metering), reducing scanned keys and avoiding table lookups helps under join storms.
-- This index is additive and safe to run multiple times.

SET @idx_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'votes'
      AND index_name = 'idx_votes_session_slide_option'
);

SET @sql = IF(
    @idx_exists = 0,
    'ALTER TABLE votes ADD INDEX idx_votes_session_slide_option (session_id, slide_id, option_id)',
    'SELECT \"Index idx_votes_session_slide_option already exists\"'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

