-- NO-OP: This migration was found to be dangerous and has been replaced.
-- 
-- The original migration attempted to add a unique constraint on (slide_id, participant_id)
-- which would break multi-select polls. The votes table already has the correct constraint:
-- UNIQUE KEY unique_vote (slide_id, participant_id, option_id)
--
-- See migration 20260402110000_fix_vote_uniqueness_for_multi_select.sql for the fix.
--
-- This file is kept for migration history tracking but performs no operations.

SELECT "Skipping dangerous migration - see 20260402110000_fix_vote_uniqueness_for_multi_select.sql";
