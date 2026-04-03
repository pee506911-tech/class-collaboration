-- Add missing indexes for performance
--
-- NOTE: MySQL does not support `CREATE INDEX IF NOT EXISTS`.
-- These base indexes are already created in `20241201140000_create_sessions_and_slides.sql`,
-- so we intentionally skip redundant index creation here.
SELECT "Skipping redundant base index creation (already created in 20241201140000_create_sessions_and_slides.sql)";

-- Upvote tracking table to prevent spam (one upvote per participant per question)
CREATE TABLE IF NOT EXISTS question_upvotes (
    question_id VARCHAR(36) NOT NULL,
    participant_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (question_id, participant_id),
    INDEX idx_upvotes_question (question_id)
);
