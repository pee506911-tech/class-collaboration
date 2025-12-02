-- Fix allow_questions default to TRUE and update existing sessions

-- Update existing sessions to allow questions by default
UPDATE sessions SET allow_questions = TRUE WHERE allow_questions IS NULL OR allow_questions = FALSE;

-- Change the default for new sessions
ALTER TABLE sessions MODIFY COLUMN allow_questions TINYINT(1) DEFAULT 1;
