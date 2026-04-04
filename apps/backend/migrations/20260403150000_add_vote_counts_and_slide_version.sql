-- Add per-option vote counters and per-slide optimistic concurrency versioning.

-- 1) slides.version
SET @slides_version_exists = (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'slides'
      AND column_name = 'version'
);
SET @sql_slides_version = IF(
    @slides_version_exists = 0,
    'ALTER TABLE slides ADD COLUMN version BIGINT NOT NULL DEFAULT 0',
    'SELECT "Column slides.version already exists"'
);
PREPARE stmt_slides_version FROM @sql_slides_version;
EXECUTE stmt_slides_version;
DEALLOCATE PREPARE stmt_slides_version;

-- 2) vote_counts read model
CREATE TABLE IF NOT EXISTS vote_counts (
    session_id VARCHAR(36) NOT NULL,
    slide_id VARCHAR(36) NOT NULL,
    option_id VARCHAR(36) NOT NULL,
    vote_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (slide_id, option_id),
    INDEX idx_vote_counts_session_slide (session_id, slide_id),
    INDEX idx_vote_counts_session_option (session_id, option_id)
);

-- 3) backfill counters from existing raw votes
INSERT INTO vote_counts (session_id, slide_id, option_id, vote_count)
SELECT session_id, slide_id, option_id, COUNT(*) AS vote_count
FROM votes
GROUP BY session_id, slide_id, option_id
ON DUPLICATE KEY UPDATE vote_count = VALUES(vote_count);
