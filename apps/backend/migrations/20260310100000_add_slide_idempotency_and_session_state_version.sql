-- Add session state_version and slide idempotency key.
--
-- NOTE: These changes may already exist (some environments create `state_version`
-- in the initial sessions table). MySQL does not support `ADD COLUMN IF NOT EXISTS`,
-- so we guard via `information_schema` + dynamic SQL.

-- 1) sessions.state_version
SET @col_exists = (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'sessions'
      AND column_name = 'state_version'
);
SET @sql = IF(
    @col_exists = 0,
    'ALTER TABLE sessions ADD COLUMN state_version BIGINT NOT NULL DEFAULT 0',
    'SELECT \"Column state_version already exists\"'
);
PREPARE stmt_state_version FROM @sql;
EXECUTE stmt_state_version;
DEALLOCATE PREPARE stmt_state_version;

-- 2) slides.client_request_id
SET @col_exists = (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'slides'
      AND column_name = 'client_request_id'
);
SET @sql = IF(
    @col_exists = 0,
    'ALTER TABLE slides ADD COLUMN client_request_id VARCHAR(64) NULL',
    'SELECT \"Column slides.client_request_id already exists\"'
);
PREPARE stmt_slides_client_request_id FROM @sql;
EXECUTE stmt_slides_client_request_id;
DEALLOCATE PREPARE stmt_slides_client_request_id;

-- 3) uq_slides_session_client_request_id
SET @idx_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'slides'
      AND index_name = 'uq_slides_session_client_request_id'
);
SET @sql = IF(
    @idx_exists = 0,
    'ALTER TABLE slides ADD UNIQUE INDEX uq_slides_session_client_request_id (session_id, client_request_id)',
    'SELECT \"Index uq_slides_session_client_request_id already exists\"'
);
PREPARE stmt_uq_slides_session_client_request_id FROM @sql;
EXECUTE stmt_uq_slides_session_client_request_id;
DEALLOCATE PREPARE stmt_uq_slides_session_client_request_id;
