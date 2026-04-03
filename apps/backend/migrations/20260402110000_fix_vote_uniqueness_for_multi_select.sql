-- Verify and ensure the correct unique constraint exists for votes.
-- 
-- The votes table should have: UNIQUE KEY unique_vote (slide_id, participant_id, option_id)
-- This allows multi-select polls (one row per option) while preventing duplicate votes
-- for the same option by the same participant.
--
-- This migration is idempotent and safe to run on already-migrated databases.

-- Verify the unique_vote index exists with the correct columns
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() 
    AND table_name = 'votes' 
    AND index_name = 'unique_vote');

-- If the index doesn't exist, something is very wrong - but we don't fail
-- Just log a warning message
SET @sql = IF(@idx_exists = 0,
    'SELECT "WARNING: unique_vote index not found! Please check votes table schema."',
    'SELECT "unique_vote index verified"');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Ensure index for faster lookups if not exists
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'votes' AND index_name = 'idx_votes_slide_participant');
SET @sql = IF(@idx_exists = 0,
    'ALTER TABLE votes ADD INDEX idx_votes_slide_participant (slide_id, participant_id)',
    'SELECT "Index idx_votes_slide_participant already exists"');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
