-- Replace single-row vote counters with sharded counters to reduce write hotspots.

CREATE TABLE IF NOT EXISTS vote_count_shards (
    session_id VARCHAR(36) NOT NULL,
    slide_id VARCHAR(36) NOT NULL,
    option_id VARCHAR(36) NOT NULL,
    shard_id INT NOT NULL,
    vote_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (slide_id, option_id, shard_id),
    INDEX idx_vote_count_shards_session_slide (session_id, slide_id),
    INDEX idx_vote_count_shards_session_option (session_id, option_id)
);

-- Backfill sharded counters from raw votes so read paths can switch immediately.
INSERT INTO vote_count_shards (session_id, slide_id, option_id, shard_id, vote_count)
SELECT
    session_id,
    slide_id,
    option_id,
    MOD(CRC32(participant_id), 16) AS shard_id,
    COUNT(*) AS vote_count
FROM votes
GROUP BY session_id, slide_id, option_id, MOD(CRC32(participant_id), 16)
ON DUPLICATE KEY UPDATE vote_count = VALUES(vote_count);
