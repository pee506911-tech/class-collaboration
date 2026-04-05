CREATE TABLE IF NOT EXISTS vote_projection_applied (
    outbox_event_id VARCHAR(36) PRIMARY KEY,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
