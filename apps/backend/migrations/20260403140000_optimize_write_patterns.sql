-- TiDB Write Optimization: Reduce write amplification and eliminate index hotspots
--
-- This migration includes TiDB-specific DDL (e.g., `SHARD_ROW_ID_BITS`, `PRE_SPLIT_REGIONS`)
-- which will fail on MySQL. Local test infra currently runs MySQL, so we detect TiDB and
-- no-op everything when not running on TiDB.
--
-- Detection: `@@version_comment` typically contains "TiDB" on TiDB and not on MySQL.
SET @is_tidb = (SELECT @@version_comment LIKE '%TiDB%');

-- ============================================================
-- 1) Drop monotonic index: idx_votes_session_created_at (TiDB-only)
-- ============================================================
SET @idx_vc_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'votes'
      AND index_name = 'idx_votes_session_created_at'
);
SET @sql_vc = IF(
    @is_tidb AND @idx_vc_exists > 0,
    'ALTER TABLE votes DROP INDEX idx_votes_session_created_at',
    'SELECT \"Skipping drop idx_votes_session_created_at (not TiDB or missing)\"'
);
PREPARE stmt_vc FROM @sql_vc;
EXECUTE stmt_vc;
DEALLOCATE PREPARE stmt_vc;

-- ============================================================
-- 2) Drop monotonic index: idx_participants_session_joined_at (TiDB-only)
-- ============================================================
SET @idx_pj_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'participants'
      AND index_name = 'idx_participants_session_joined_at'
);
SET @sql_pj = IF(
    @is_tidb AND @idx_pj_exists > 0,
    'ALTER TABLE participants DROP INDEX idx_participants_session_joined_at',
    'SELECT \"Skipping drop idx_participants_session_joined_at (not TiDB or missing)\"'
);
PREPARE stmt_pj FROM @sql_pj;
EXECUTE stmt_pj;
DEALLOCATE PREPARE stmt_pj;

-- ============================================================
-- 3) Drop redundant index: idx_votes_session_participant (TiDB-only)
-- ============================================================
SET @idx_vsp_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'votes'
      AND index_name = 'idx_votes_session_participant'
);
SET @sql_vsp = IF(
    @is_tidb AND @idx_vsp_exists > 0,
    'ALTER TABLE votes DROP INDEX idx_votes_session_participant',
    'SELECT \"Skipping drop idx_votes_session_participant (not TiDB or missing)\"'
);
PREPARE stmt_vsp FROM @sql_vsp;
EXECUTE stmt_vsp;
DEALLOCATE PREPARE stmt_vsp;

-- ============================================================
-- 4) Add SHARD_ROW_ID_BITS to vote_submissions (TiDB-only)
-- ============================================================
SET @tbl_vote_submissions_exists = (
    SELECT COUNT(*)
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name = 'vote_submissions'
);
-- TiDB only supports SHARD_ROW_ID_BITS when the table uses an implicit row id
-- (i.e., when it does NOT have a PRIMARY KEY as the row handle).
SET @vote_submissions_has_pk = (
    SELECT COUNT(*)
    FROM information_schema.table_constraints
    WHERE table_schema = DATABASE()
      AND table_name = 'vote_submissions'
      AND constraint_type = 'PRIMARY KEY'
);
SET @sql_shard_vs = IF(
    @is_tidb AND @tbl_vote_submissions_exists > 0 AND @vote_submissions_has_pk = 0,
    'ALTER TABLE vote_submissions SHARD_ROW_ID_BITS = 4 PRE_SPLIT_REGIONS = 2',
    'SELECT \"Skipping vote_submissions sharding (not TiDB or missing)\"'
);
PREPARE stmt_shard_vs FROM @sql_shard_vs;
EXECUTE stmt_shard_vs;
DEALLOCATE PREPARE stmt_shard_vs;

-- ============================================================
-- 5) Add SHARD_ROW_ID_BITS to question_upvotes (TiDB-only)
-- ============================================================
SET @tbl_question_upvotes_exists = (
    SELECT COUNT(*)
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name = 'question_upvotes'
);
SET @question_upvotes_has_pk = (
    SELECT COUNT(*)
    FROM information_schema.table_constraints
    WHERE table_schema = DATABASE()
      AND table_name = 'question_upvotes'
      AND constraint_type = 'PRIMARY KEY'
);
SET @sql_shard_qu = IF(
    @is_tidb AND @tbl_question_upvotes_exists > 0 AND @question_upvotes_has_pk = 0,
    'ALTER TABLE question_upvotes SHARD_ROW_ID_BITS = 4 PRE_SPLIT_REGIONS = 2',
    'SELECT \"Skipping question_upvotes sharding (not TiDB or missing)\"'
);
PREPARE stmt_shard_qu FROM @sql_shard_qu;
EXECUTE stmt_shard_qu;
DEALLOCATE PREPARE stmt_shard_qu;

-- ============================================================
-- 6) Add SHARD_ROW_ID_BITS to slide_delete_requests (TiDB-only)
-- ============================================================
SET @tbl_slide_delete_requests_exists = (
    SELECT COUNT(*)
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name = 'slide_delete_requests'
);
SET @slide_delete_requests_has_pk = (
    SELECT COUNT(*)
    FROM information_schema.table_constraints
    WHERE table_schema = DATABASE()
      AND table_name = 'slide_delete_requests'
      AND constraint_type = 'PRIMARY KEY'
);
SET @sql_shard_sdr = IF(
    @is_tidb AND @tbl_slide_delete_requests_exists > 0 AND @slide_delete_requests_has_pk = 0,
    'ALTER TABLE slide_delete_requests SHARD_ROW_ID_BITS = 4 PRE_SPLIT_REGIONS = 2',
    'SELECT \"Skipping slide_delete_requests sharding (not TiDB or missing)\"'
);
PREPARE stmt_shard_sdr FROM @sql_shard_sdr;
EXECUTE stmt_shard_sdr;
DEALLOCATE PREPARE stmt_shard_sdr;

-- ============================================================
-- 7) Add PRE_SPLIT_REGIONS to votes table (TiDB-only)
-- ============================================================
-- NOTE: TiDB supports PRE_SPLIT_REGIONS on CREATE TABLE, but ALTER TABLE variants
-- are not reliably supported across versions and can fail with:
--   8200 (HY000): This type of ALTER TABLE is currently unsupported
-- So we intentionally no-op this step.
SELECT "Skipping votes PRE_SPLIT_REGIONS (avoid TiDB unsupported ALTER TABLE)";

-- ============================================================
-- 8) Add PRE_SPLIT_REGIONS to participants table (TiDB-only)
-- ============================================================
SELECT "Skipping participants PRE_SPLIT_REGIONS (avoid TiDB unsupported ALTER TABLE)";
