ALTER TABLE sessions
    ADD COLUMN state_version BIGINT NOT NULL DEFAULT 0;

ALTER TABLE slides
    ADD COLUMN client_request_id VARCHAR(64) NULL;

ALTER TABLE slides
    ADD UNIQUE INDEX uq_slides_session_client_request_id (session_id, client_request_id);
