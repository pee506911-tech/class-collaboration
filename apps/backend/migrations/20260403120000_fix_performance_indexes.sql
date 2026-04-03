-- Performance index fixes for TiDB RU efficiency
-- 1. Add missing indexes for slide_id-first vote queries
-- 2. Drop redundant/duplicate indexes that cause write amplification
--
-- All operations are safe to run multiple times (idempotent).

-- ============================================================
-- 1. Add missing index: idx_votes_slide_participant
--    Used by: Vote::find_by_slide, Vote::has_voted
--    Queries: SELECT ... FROM votes WHERE slide_id = ?
--             SELECT COUNT(*) FROM votes WHERE slide_id = ? AND participant_id = ?
-- ============================================================
SET @idx_vp_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'votes'
      AND index_name = 'idx_votes_slide_participant'
);

SET @sql_vp = IF(
    @idx_vp_exists = 0,
    'ALTER TABLE votes ADD INDEX idx_votes_slide_participant (slide_id, participant_id)',
    'SELECT "Index idx_votes_slide_participant already exists"'
);

PREPARE stmt_vp FROM @sql_vp;
EXECUTE stmt_vp;
DEALLOCATE PREPARE stmt_vp;

-- ============================================================
-- 2. Add covering index: idx_votes_slide_option
--    Used by: Vote::get_vote_counts, per-slide vote aggregation
--    Query: SELECT option_id, COUNT(*) FROM votes WHERE slide_id = ? GROUP BY option_id
-- ============================================================
SET @idx_so_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'votes'
      AND index_name = 'idx_votes_slide_option'
);

SET @sql_so = IF(
    @idx_so_exists = 0,
    'ALTER TABLE votes ADD INDEX idx_votes_slide_option (slide_id, option_id)',
    'SELECT "Index idx_votes_slide_option already exists"'
);

PREPARE stmt_so FROM @sql_so;
EXECUTE stmt_so;
DEALLOCATE PREPARE stmt_so;

-- ============================================================
-- 3. Drop redundant index: idx_sessions_id_sequence
--    Duplicate of idx_sessions_sequences (id, vote_sequence, qa_sequence)
-- ============================================================
SET @idx_dup1_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'sessions'
      AND index_name = 'idx_sessions_id_sequence'
);

SET @sql_dup1 = IF(
    @idx_dup1_exists > 0,
    'ALTER TABLE sessions DROP INDEX idx_sessions_id_sequence',
    'SELECT "Index idx_sessions_id_sequence does not exist"'
);

PREPARE stmt_dup1 FROM @sql_dup1;
EXECUTE stmt_dup1;
DEALLOCATE PREPARE stmt_dup1;

-- ============================================================
-- 4. Drop redundant index: idx_slides_session_order_index
--    Duplicate of idx_slides_session_order (session_id, order_index)
-- ============================================================
SET @idx_dup2_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'slides'
      AND index_name = 'idx_slides_session_order_index'
);

SET @sql_dup2 = IF(
    @idx_dup2_exists > 0,
    'ALTER TABLE slides DROP INDEX idx_slides_session_order_index',
    'SELECT "Index idx_slides_session_order_index does not exist"'
);

PREPARE stmt_dup2 FROM @sql_dup2;
EXECUTE stmt_dup2;
DEALLOCATE PREPARE stmt_dup2;

-- ============================================================
-- 5. Drop redundant index: idx_users_email
--    Redundant with UNIQUE(email) constraint which already creates an index
-- ============================================================
SET @idx_dup3_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'users'
      AND index_name = 'idx_users_email'
);

SET @sql_dup3 = IF(
    @idx_dup3_exists > 0,
    'ALTER TABLE users DROP INDEX idx_users_email',
    'SELECT "Index idx_users_email does not exist"'
);

PREPARE stmt_dup3 FROM @sql_dup3;
EXECUTE stmt_dup3;
DEALLOCATE PREPARE stmt_dup3;
