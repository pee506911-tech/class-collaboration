-- Add missing indexes for performance
CREATE INDEX IF NOT EXISTS idx_sessions_creator ON sessions(creator_id);
CREATE INDEX IF NOT EXISTS idx_sessions_share_token ON sessions(share_token);
CREATE INDEX IF NOT EXISTS idx_slides_session ON slides(session_id);

-- Upvote tracking table to prevent spam (one upvote per participant per question)
CREATE TABLE IF NOT EXISTS question_upvotes (
    question_id VARCHAR(36) NOT NULL,
    participant_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (question_id, participant_id),
    INDEX idx_upvotes_question (question_id)
);
