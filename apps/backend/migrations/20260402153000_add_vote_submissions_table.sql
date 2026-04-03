-- Track per-slide vote submissions to enforce limitSubmissions atomically without
-- relying on SELECT ... FOR UPDATE against the votes table (which can cause gap-lock
-- deadlocks under burst concurrency).
--
-- One row per (slide_id, participant_id) indicates the participant has submitted
-- a vote payload for that slide (single-select or multi-select).

CREATE TABLE IF NOT EXISTS vote_submissions (
    slide_id VARCHAR(36) NOT NULL,
    participant_id VARCHAR(36) NOT NULL,
    session_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (slide_id, participant_id),
    INDEX idx_vote_submissions_session (session_id)
);

