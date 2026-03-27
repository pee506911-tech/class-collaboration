-- Add idempotency key for student question submission retries
-- Allows safe retry of POST /api/sessions/:id/questions without creating duplicates.

ALTER TABLE questions
    ADD COLUMN client_request_id VARCHAR(64) NULL;

ALTER TABLE questions
    ADD UNIQUE INDEX uq_questions_session_participant_client_request_id (session_id, participant_id, client_request_id);

