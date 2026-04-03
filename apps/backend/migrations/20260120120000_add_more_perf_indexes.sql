-- Additional performance indexes for common query patterns
--
-- NOTE: MySQL does not support `CREATE INDEX IF NOT EXISTS`, so we create
-- indexes conditionally using `information_schema.statistics` + dynamic SQL.

-- Sessions dashboard listing: WHERE creator_id = ? ORDER BY created_at DESC
SET @idx_sessions_creator_created_at_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'sessions'
      AND index_name = 'idx_sessions_creator_created_at'
);
SET @sql_sessions_creator_created_at = IF(
    @idx_sessions_creator_created_at_exists = 0,
    'CREATE INDEX idx_sessions_creator_created_at ON sessions(creator_id, created_at)',
    'SELECT \"Index idx_sessions_creator_created_at already exists\"'
);
PREPARE stmt_sessions_creator_created_at FROM @sql_sessions_creator_created_at;
EXECUTE stmt_sessions_creator_created_at;
DEALLOCATE PREPARE stmt_sessions_creator_created_at;

-- Votes lookups: get_my_votes + stats timelines
SET @idx_votes_session_participant_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'votes'
      AND index_name = 'idx_votes_session_participant'
);
SET @sql_votes_session_participant = IF(
    @idx_votes_session_participant_exists = 0,
    'CREATE INDEX idx_votes_session_participant ON votes(session_id, participant_id)',
    'SELECT \"Index idx_votes_session_participant already exists\"'
);
PREPARE stmt_votes_session_participant FROM @sql_votes_session_participant;
EXECUTE stmt_votes_session_participant;
DEALLOCATE PREPARE stmt_votes_session_participant;

SET @idx_votes_session_created_at_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'votes'
      AND index_name = 'idx_votes_session_created_at'
);
SET @sql_votes_session_created_at = IF(
    @idx_votes_session_created_at_exists = 0,
    'CREATE INDEX idx_votes_session_created_at ON votes(session_id, created_at)',
    'SELECT \"Index idx_votes_session_created_at already exists\"'
);
PREPARE stmt_votes_session_created_at FROM @sql_votes_session_created_at;
EXECUTE stmt_votes_session_created_at;
DEALLOCATE PREPARE stmt_votes_session_created_at;

-- Questions sorting: WHERE session_id = ? ORDER BY upvotes DESC, created_at DESC
SET @idx_questions_session_upvotes_created_at_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'questions'
      AND index_name = 'idx_questions_session_upvotes_created_at'
);
SET @sql_questions_session_upvotes_created_at = IF(
    @idx_questions_session_upvotes_created_at_exists = 0,
    'CREATE INDEX idx_questions_session_upvotes_created_at ON questions(session_id, upvotes, created_at)',
    'SELECT \"Index idx_questions_session_upvotes_created_at already exists\"'
);
PREPARE stmt_questions_session_upvotes_created_at FROM @sql_questions_session_upvotes_created_at;
EXECUTE stmt_questions_session_upvotes_created_at;
DEALLOCATE PREPARE stmt_questions_session_upvotes_created_at;

-- Slides ordering: WHERE session_id = ? [AND is_hidden = FALSE] ORDER BY order_index
SET @idx_slides_session_order_index_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'slides'
      AND index_name = 'idx_slides_session_order_index'
);
SET @sql_slides_session_order_index = IF(
    @idx_slides_session_order_index_exists = 0,
    'CREATE INDEX idx_slides_session_order_index ON slides(session_id, order_index)',
    'SELECT \"Index idx_slides_session_order_index already exists\"'
);
PREPARE stmt_slides_session_order_index FROM @sql_slides_session_order_index;
EXECUTE stmt_slides_session_order_index;
DEALLOCATE PREPARE stmt_slides_session_order_index;

SET @idx_slides_session_hidden_order_index_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'slides'
      AND index_name = 'idx_slides_session_hidden_order_index'
);
SET @sql_slides_session_hidden_order_index = IF(
    @idx_slides_session_hidden_order_index_exists = 0,
    'CREATE INDEX idx_slides_session_hidden_order_index ON slides(session_id, is_hidden, order_index)',
    'SELECT \"Index idx_slides_session_hidden_order_index already exists\"'
);
PREPARE stmt_slides_session_hidden_order_index FROM @sql_slides_session_hidden_order_index;
EXECUTE stmt_slides_session_hidden_order_index;
DEALLOCATE PREPARE stmt_slides_session_hidden_order_index;

-- Participants ordering: WHERE session_id = ? ORDER BY joined_at DESC
SET @idx_participants_session_joined_at_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'participants'
      AND index_name = 'idx_participants_session_joined_at'
);
SET @sql_participants_session_joined_at = IF(
    @idx_participants_session_joined_at_exists = 0,
    'CREATE INDEX idx_participants_session_joined_at ON participants(session_id, joined_at)',
    'SELECT \"Index idx_participants_session_joined_at already exists\"'
);
PREPARE stmt_participants_session_joined_at FROM @sql_participants_session_joined_at;
EXECUTE stmt_participants_session_joined_at;
DEALLOCATE PREPARE stmt_participants_session_joined_at;
