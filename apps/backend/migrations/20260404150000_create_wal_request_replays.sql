CREATE TABLE wal_request_replays (
    session_id VARCHAR(36) NOT NULL,
    op_type VARCHAR(64) NOT NULL,
    client_request_id VARCHAR(64) NOT NULL,
    response_payload JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, op_type, client_request_id)
);
