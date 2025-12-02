-- Create student interaction tables
-- Uses CREATE TABLE IF NOT EXISTS to be idempotent

-- Participants table (tracks students who join sessions)
CREATE TABLE IF NOT EXISTS participants (
    id VARCHAR(36) NOT NULL,
    session_id VARCHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, session_id),
    INDEX idx_participants_session (session_id)
);

-- Votes table (tracks poll/quiz responses)
CREATE TABLE IF NOT EXISTS votes (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    slide_id VARCHAR(36) NOT NULL,
    participant_id VARCHAR(36) NOT NULL,
    option_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_vote (slide_id, participant_id, option_id),
    INDEX idx_votes_session_slide (session_id, slide_id)
);

-- Questions table (Q&A feature)
CREATE TABLE IF NOT EXISTS questions (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    slide_id VARCHAR(36),
    participant_id VARCHAR(36) NOT NULL,
    content TEXT NOT NULL,
    upvotes INT DEFAULT 0,
    is_approved BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_questions_session (session_id)
);
