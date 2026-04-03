-- Cleanup duplicate votes with same-second timestamp handling
-- IMPORTANT: This migration cleans up TRUE duplicates only.
-- The votes table has UNIQUE KEY unique_vote (slide_id, participant_id, option_id)
-- so true duplicates are rows with the SAME (slide_id, participant_id, option_id).
--
-- This migration uses the auto-increment id to deterministically keep the latest
-- when true duplicates exist (same slide, participant, AND option).
--
-- Addresses R-05: Migration failure on existing environments

-- First, clean up TRUE duplicate votes (same slide_id, participant_id, AND option_id)
-- keeping the one with the highest id (most recent)
DELETE v1 FROM votes v1
INNER JOIN (
    SELECT slide_id, participant_id, option_id, MAX(id) as max_id
    FROM votes
    GROUP BY slide_id, participant_id, option_id
    HAVING COUNT(*) > 1
) v2 ON v1.slide_id = v2.slide_id 
    AND v1.participant_id = v2.participant_id 
    AND v1.option_id = v2.option_id
WHERE v1.id < v2.max_id;

-- Note: The correct unique constraint (slide_id, participant_id, option_id)
-- already exists in the original schema (20241201150000_recreate_student_tables.sql)
-- No additional index creation is needed.
