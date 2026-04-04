CREATE TABLE IF NOT EXISTS slide_update_requests (
    session_id VARCHAR(36) NOT NULL,
    client_request_id VARCHAR(64) NOT NULL,
    slide_id VARCHAR(36) NOT NULL,
    request_payload JSON NOT NULL,
    response_slide JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, client_request_id),
    INDEX idx_slide_update_requests_session_slide (session_id, slide_id)
);
