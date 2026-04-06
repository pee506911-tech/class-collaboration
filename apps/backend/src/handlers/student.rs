use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::{MySql, Transaction};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::models::response::ApiResponse;
use crate::models::student::Participant;
use crate::models::student::Question;

const MAX_QUESTION_LENGTH: usize = 1000;
const MAX_NAME_LENGTH: usize = 100;
const MAX_OPTION_IDS: usize = 10;
const MAX_DEADLOCK_RETRIES: u32 = 3;
const MY_VOTES_SLIDE_ID_CHUNK_SIZE: usize = 128;
const VOTE_COUNT_SHARD_COUNT: u32 = 16;

fn resolve_client_request_id(headers: &HeaderMap) -> Result<String> {
    let client_request_id = headers
        .get("x-client-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    if let Some(client_request_id) = client_request_id {
        if client_request_id.len() > 64 {
            return Err(AppError::Input("Invalid X-Client-Request-Id".to_string()));
        }
        return Ok(client_request_id);
    }

    Ok(Uuid::new_v4().to_string())
}

fn is_mysql_duplicate_key(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Database(db_err) => {
            // SQLx returns SQLSTATE in `code()` for MySQL (e.g. "23000" for integrity violations).
            // Error number (e.g. 1062) is included in the message.
            db_err.message().contains("Duplicate entry")
                || db_err.code().as_deref() == Some("23000")
                || db_err.code().as_deref() == Some("1062")
        }
        _ => false,
    }
}

/// Check if an error is a deadlock error that should be retried
fn is_deadlock_error(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Database(db_err) => {
            // Deadlock: SQLSTATE 40001 (ER_LOCK_DEADLOCK = 1213)
            // Lock wait timeout: often SQLSTATE HY000 (ER_LOCK_WAIT_TIMEOUT = 1205)
            db_err.code().as_deref() == Some("40001")
                || db_err.message().contains("Deadlock found")
                || db_err.message().contains("Lock wait timeout exceeded")
        }
        _ => false,
    }
}

/// Check if an AppError wraps a deadlock error
fn is_app_error_deadlock(e: &AppError) -> bool {
    match e {
        AppError::Database(sqlx_err) => is_deadlock_error(sqlx_err),
        _ => false,
    }
}

/// Returns the response unchanged (degraded header removed since Ably is gone)
fn with_degraded_header<T: serde::Serialize>(body: ApiResponse<T>) -> axum::response::Response {
    Json(body).into_response()
}

fn group_votes_by_slide(votes: Vec<(String, String)>) -> HashMap<String, Vec<String>> {
    let mut votes_map: HashMap<String, Vec<String>> = HashMap::new();
    for (slide_id, option_id) in votes {
        votes_map.entry(slide_id).or_default().push(option_id);
    }
    votes_map
}

fn dedupe_option_ids(option_ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::with_capacity(option_ids.len());
    option_ids
        .into_iter()
        .filter(|option_id| seen.insert(option_id.clone()))
        .collect()
}

pub(crate) fn should_skip_vote_snapshot(limit_submissions: bool, rows_affected: u64) -> bool {
    !limit_submissions && rows_affected == 0
}

async fn get_session_slide_ids(pool: &crate::db::DbPool, session_id: &str) -> Result<Vec<String>> {
    Ok(
        sqlx::query_scalar("SELECT id FROM slides WHERE session_id = ?")
            .bind(session_id)
            .fetch_all(pool)
            .await?,
    )
}

async fn get_votes_for_participant_by_slide_ids(
    pool: &crate::db::DbPool,
    participant_id: &str,
    slide_ids: &[String],
) -> Result<Vec<(String, String)>> {
    if slide_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut votes = Vec::new();

    // Keep lookups aligned with the existing slide_id-leading vote indexes so we
    // do not need to reintroduce the TiDB write-heavy (session_id, participant_id) index.
    for slide_id_chunk in slide_ids.chunks(MY_VOTES_SLIDE_ID_CHUNK_SIZE) {
        let mut qb = sqlx::QueryBuilder::<MySql>::new(
            "SELECT slide_id, option_id FROM votes WHERE participant_id = ",
        );
        qb.push_bind(participant_id);
        qb.push(" AND slide_id IN (");
        let mut separated = qb.separated(", ");
        for slide_id in slide_id_chunk {
            separated.push_bind(slide_id);
        }
        qb.push(")");

        let chunk_votes = qb
            .build_query_as::<(String, String)>()
            .fetch_all(pool)
            .await?;
        votes.extend(chunk_votes);
    }

    Ok(votes)
}

pub(crate) fn vote_count_shard_id(participant_id: &str) -> u32 {
    let mut hash = 0x811c9dc5u32;
    for byte in participant_id.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash % VOTE_COUNT_SHARD_COUNT
}

pub(crate) fn build_vote_update_payload(
    slide_id: &str,
    shard_id: u32,
    option_ids: &[String],
) -> serde_json::Value {
    serde_json::json!({
        "slideId": slide_id,
        "projection": {
            "shardId": shard_id,
            "optionIds": option_ids,
        }
    })
}

pub(crate) async fn commit_vote_submission(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    slide_id: &str,
    participant_id: &str,
    option_ids: &[String],
    limit_submissions: bool,
) -> Result<bool> {
    if limit_submissions {
        let reserve_result = sqlx::query(
            "INSERT INTO vote_submissions (slide_id, participant_id, session_id) VALUES (?, ?, ?)",
        )
        .bind(slide_id)
        .bind(participant_id)
        .bind(session_id)
        .execute(&mut **tx)
        .await;

        match reserve_result {
            Ok(_) => {}
            Err(error) if is_mysql_duplicate_key(&error) => return Ok(false),
            Err(error) => return Err(error.into()),
        }
    }

    let mut inserted_option_ids = Vec::new();
    for option_id in option_ids {
        let insert_result = sqlx::query(
            "INSERT IGNORE INTO votes (id, session_id, slide_id, participant_id, option_id)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(session_id)
        .bind(slide_id)
        .bind(participant_id)
        .bind(option_id)
        .execute(&mut **tx)
        .await;

        match insert_result {
            Ok(result) => {
                if result.rows_affected() > 0 {
                    inserted_option_ids.push(option_id.clone());
                }
            }
            Err(error) => return Err(error.into()),
        }
    }

    if should_skip_vote_snapshot(limit_submissions, inserted_option_ids.len() as u64) {
        return Ok(false);
    }

    let shard_id = vote_count_shard_id(participant_id);

    crate::services::outbox::enqueue_event(
        tx,
        session_id,
        crate::services::outbox::OutboxEventType::VoteUpdate,
        &build_vote_update_payload(slide_id, shard_id, &inserted_option_ids),
    )
    .await?;

    Ok(true)
}
/// Helper function: Atomically increment qa_sequence and fetch questions.
/// Returns (sequence, Vec<Question>)
pub(crate) async fn next_qa_sequence_and_questions(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
) -> Result<(u64, Vec<Question>)> {
    // Increment the sequence
    sqlx::query("UPDATE sessions SET qa_sequence = qa_sequence + 1 WHERE id = ?")
        .bind(session_id)
        .execute(&mut **tx)
        .await?;

    // Read the new sequence value
    let sequence: u64 = sqlx::query_scalar("SELECT qa_sequence FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_one(&mut **tx)
        .await?;

    // Read the questions snapshot
    let questions: Vec<Question> = sqlx::query_as(
        "SELECT id, session_id, slide_id, participant_id, content, upvotes, is_approved, created_at
         FROM questions WHERE session_id = ? ORDER BY upvotes DESC, created_at DESC",
    )
    .bind(session_id)
    .fetch_all(&mut **tx)
    .await?;

    Ok((sequence, questions))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitVoteRequest {
    slide_id: String,
    option_id: Option<String>,
    option_ids: Option<Vec<String>>,
    participant_id: String,
}

/// Submit a vote for a poll/quiz slide
pub async fn submit_vote(
    State(app_state): State<crate::AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(payload): Json<SubmitVoteRequest>,
) -> Result<axum::response::Response> {
    let pool = app_state.db_pool.pool_fast_fail().await?;

    // Validate participant_id is not empty
    if payload.participant_id.trim().is_empty() {
        tracing::warn!(
            "Vote submission rejected: empty participant_id for session {}",
            session_id
        );
        return Err(AppError::Input("Participant ID is required".to_string()));
    }

    tracing::info!(
        "Vote submission for session {}: slide={}, participant={}",
        session_id,
        payload.slide_id,
        payload.participant_id
    );

    #[derive(sqlx::FromRow)]
    struct SlideMetaRow {
        session_id: String,
        slide_type: String,
        content: serde_json::Value,
    }

    // Slide ids are UUID primary keys, so a point lookup by id keeps this
    // validation read cheap without requiring extra secondary indexes.
    let slide_meta = if crate::tidb_ru::should_sample() {
        let mut conn = pool.acquire().await?;
        let slide_meta = sqlx::query_as::<_, SlideMetaRow>(
            "SELECT session_id, type as slide_type, content FROM slides WHERE id = ?",
        )
        .bind(&payload.slide_id)
        .fetch_optional(&mut *conn)
        .await?;
        crate::tidb_ru::log_last_query_info("slides.meta_for_vote", &mut *conn).await;
        slide_meta
    } else {
        sqlx::query_as::<_, SlideMetaRow>(
            "SELECT session_id, type as slide_type, content FROM slides WHERE id = ?",
        )
        .bind(&payload.slide_id)
        .fetch_optional(&pool)
        .await?
    };

    let (slide_type, slide_content) = match slide_meta {
        Some(m) if m.session_id == session_id => (m.slide_type, m.content),
        None => {
            // Best-effort specificity: distinguish missing session from wrong slide.
            let session_exists: Option<bool> =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?)")
                    .bind(&session_id)
                    .fetch_optional(&pool)
                    .await?;

            if session_exists != Some(true) {
                return Err(AppError::NotFound("Session not found".to_string()));
            }

            return Err(AppError::Input(
                "Invalid slide: slide does not exist or does not belong to this session"
                    .to_string(),
            ));
        }
        Some(_) => {
            return Err(AppError::Input(
                "Invalid slide: slide does not exist or does not belong to this session"
                    .to_string(),
            ));
        }
    };

    // Resolve option IDs from the request payload (supports both option_id and option_ids)
    let raw_option_ids = if let Some(ids) = payload.option_ids {
        ids
    } else if let Some(id) = payload.option_id {
        vec![id]
    } else {
        return Err(AppError::Input("No option selected".to_string()));
    };

    // Validate options against slide content and settings (pure function)
    let (option_ids, _limit_submissions) =
        match validate_vote_options(raw_option_ids, &slide_type, &slide_content) {
            VoteValidationResult::Valid {
                option_ids,
                limit_submissions,
                ..
            } => (option_ids, limit_submissions),
            VoteValidationResult::Invalid(msg) => return Err(AppError::Input(msg)),
        };

    let client_request_id = resolve_client_request_id(&headers)?;
    let response_payload = serde_json::json!({ "message": "Vote submitted successfully" });

    if let Some(existing) = crate::services::wal::fetch_replay_response::<serde_json::Value>(
        &pool,
        &session_id,
        crate::services::wal::WalOpType::SubmitVote,
        &client_request_id,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(ApiResponse::success(existing))).into_response());
    }

    for attempt in 0..=MAX_DEADLOCK_RETRIES {
        let mut tx = pool.begin().await?;

        match commit_vote_submission(
            &mut tx,
            &session_id,
            &payload.slide_id,
            &payload.participant_id,
            &option_ids,
            _limit_submissions,
        )
        .await
        {
            Ok(_) => {
                sqlx::query(
                    "INSERT IGNORE INTO wal_request_replays (session_id, op_type, client_request_id, response_payload)
                     VALUES (?, ?, ?, ?)",
                )
                .bind(&session_id)
                .bind(crate::services::wal::WalOpType::SubmitVote.to_string())
                .bind(&client_request_id)
                .bind(sqlx::types::Json(&response_payload))
                .execute(&mut *tx)
                .await?;

                tx.commit().await?;
                app_state.outbox_flush_notify.notify_one();
                app_state
                    .session_service
                    .invalidate_session_cache(&session_id)
                    .await;

                tracing::info!(
                    session_id,
                    slide_id = %payload.slide_id,
                    participant_id = %payload.participant_id,
                    client_request_id = %client_request_id,
                    "Vote committed synchronously"
                );

                return Ok((
                    StatusCode::OK,
                    Json(ApiResponse::success(response_payload.clone())),
                )
                    .into_response());
            }
            Err(error) if is_app_error_deadlock(&error) && attempt < MAX_DEADLOCK_RETRIES => {
                tx.rollback().await?;
                tokio::time::sleep(std::time::Duration::from_millis(10 * (1_u64 << attempt))).await;
            }
            Err(error) => {
                tx.rollback().await?;
                return Err(error);
            }
        }
    }

    Err(AppError::ServiceUnavailable(
        "Vote submission hit repeated database contention, please retry".to_string(),
    ))
}

// ============================================
// Vote Submission Validation (pure functions — testable)
// ============================================

/// Result of validating option IDs against slide content and settings.
#[derive(Debug)]
pub enum VoteValidationResult {
    /// Options are valid; proceed to insertion.
    Valid {
        option_ids: Vec<String>,
        limit_submissions: bool,
        #[allow(dead_code)]
        allow_multiple_selection: bool,
    },
    /// Rejection with a user-facing error message.
    Invalid(String),
}

/// Validate the resolved option IDs against slide content, format rules,
/// and slide-level settings (limitSubmissions, allowMultipleSelection).
///
/// This is a pure function — no I/O, fully testable.
pub fn validate_vote_options(
    raw_option_ids: Vec<String>,
    slide_type: &str,
    slide_content: &serde_json::Value,
) -> VoteValidationResult {
    let option_ids = dedupe_option_ids(raw_option_ids);

    if option_ids.is_empty() {
        return VoteValidationResult::Invalid("No option selected".to_string());
    }
    if option_ids.len() > MAX_OPTION_IDS {
        return VoteValidationResult::Invalid("Too many options selected".to_string());
    }

    // Validate option ID format (alphanumeric + hyphens, max 36 chars)
    for opt_id in &option_ids {
        if opt_id.len() > 36 || opt_id.contains(|c: char| !c.is_alphanumeric() && c != '-') {
            return VoteValidationResult::Invalid("Invalid option ID format".to_string());
        }
    }

    // Validate option IDs exist in slide content
    if let Some(options) = slide_content.get("options").and_then(|o| o.as_array()) {
        let valid_option_ids: HashSet<&str> = options
            .iter()
            .filter_map(|opt| opt.get("id").and_then(|id| id.as_str()))
            .collect();

        for opt_id in &option_ids {
            if !valid_option_ids.contains(opt_id.as_str()) {
                return VoteValidationResult::Invalid(format!(
                    "Invalid option ID: {} is not a valid option for this slide",
                    opt_id
                ));
            }
        }
    }

    // Parse slide settings
    let limit_submissions = slide_content
        .get("limitSubmissions")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let allow_multiple_selection = slide_content
        .get("allowMultipleSelection")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // Enforce allowMultipleSelection for multiple-choice slides
    if slide_type == "multiple-choice" && !allow_multiple_selection && option_ids.len() > 1 {
        return VoteValidationResult::Invalid(
            "This poll only allows selecting one option".to_string(),
        );
    }

    VoteValidationResult::Valid {
        option_ids,
        limit_submissions,
        allow_multiple_selection,
    }
}

/// Resolves the raw request payload into a deduplicated list of option IDs.
/// Returns None if no options were selected at all.
#[allow(dead_code)]
pub fn resolve_option_ids(
    option_id: Option<String>,
    option_ids: Option<Vec<String>>,
) -> Option<Vec<String>> {
    if let Some(ids) = option_ids {
        Some(dedupe_option_ids(ids))
    } else {
        option_id.map(|id| vec![id])
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_vote_update_payload, dedupe_option_ids, resolve_option_ids,
        should_skip_vote_snapshot, validate_vote_options, vote_count_shard_id,
        VoteValidationResult,
    };
    use serde_json::json;

    fn poll_slide_content() -> serde_json::Value {
        json!({
            "question": "What is your favorite color?",
            "options": [
                {"id": "opt-red", "text": "Red"},
                {"id": "opt-blue", "text": "Blue"},
                {"id": "opt-green", "text": "Green"}
            ],
            "limitSubmissions": true
        })
    }

    fn multi_select_poll_content() -> serde_json::Value {
        json!({
            "question": "Select all that apply",
            "options": [
                {"id": "opt-a", "text": "A"},
                {"id": "opt-b", "text": "B"}
            ],
            "allowMultipleSelection": true,
            "limitSubmissions": false
        })
    }

    fn multiple_choice_content() -> serde_json::Value {
        json!({
            "question": "Pick one",
            "options": [
                {"id": "opt-1", "text": "One"},
                {"id": "opt-2", "text": "Two"}
            ],
            "allowMultipleSelection": false,
            "limitSubmissions": true
        })
    }

    // --- resolve_option_ids tests ---

    #[test]
    fn resolve_option_ids_from_single_option_id() {
        let result = resolve_option_ids(Some("opt-red".to_string()), None);
        assert_eq!(result, Some(vec!["opt-red".to_string()]));
    }

    #[test]
    fn resolve_option_ids_from_multiple_ids() {
        let result = resolve_option_ids(
            None,
            Some(vec!["opt-red".to_string(), "opt-blue".to_string()]),
        );
        assert_eq!(
            result,
            Some(vec!["opt-red".to_string(), "opt-blue".to_string()])
        );
    }

    #[test]
    fn resolve_option_ids_deduplicates() {
        let result = resolve_option_ids(
            None,
            Some(vec![
                "opt-red".to_string(),
                "opt-blue".to_string(),
                "opt-red".to_string(),
            ]),
        );
        assert_eq!(
            result,
            Some(vec!["opt-red".to_string(), "opt-blue".to_string()])
        );
    }

    #[test]
    fn resolve_option_ids_returns_none_when_both_none() {
        let result = resolve_option_ids(None, None);
        assert!(result.is_none());
    }

    #[test]
    fn resolve_option_ids_prioritizes_option_ids_over_option_id() {
        // When both are present, option_ids takes precedence (matches handler behavior)
        let result = resolve_option_ids(
            Some("opt-ignored".to_string()),
            Some(vec!["opt-used".to_string()]),
        );
        assert_eq!(result, Some(vec!["opt-used".to_string()]));
    }

    // --- validate_vote_options tests ---

    #[test]
    fn rejects_empty_options() {
        let content = poll_slide_content();
        match validate_vote_options(vec![], "poll", &content) {
            VoteValidationResult::Invalid(msg) => {
                assert_eq!(msg, "No option selected")
            }
            other => panic!("Expected Invalid, got {:?}", other),
        }
    }

    #[test]
    fn rejects_after_deduplication_if_all_same() {
        // Even after dedup, if all option_ids were the same, we still get a single valid option.
        // This test validates that dedup doesn't cause false rejection.
        let content = poll_slide_content();
        match validate_vote_options(
            vec!["opt-red".to_string(), "opt-red".to_string()],
            "poll",
            &content,
        ) {
            VoteValidationResult::Valid { option_ids, .. } => {
                // Dedup reduces to one valid option — should pass
                assert_eq!(option_ids, vec!["opt-red".to_string()])
            }
            other => panic!("Expected Valid, got {:?}", other),
        }
    }

    #[test]
    fn rejects_too_many_options() {
        let content = poll_slide_content();
        let ids: Vec<String> = (0..11).map(|i| format!("opt-{}", i)).collect();
        match validate_vote_options(ids, "poll", &content) {
            VoteValidationResult::Invalid(msg) => {
                assert_eq!(msg, "Too many options selected")
            }
            other => panic!("Expected Invalid, got {:?}", other),
        }
    }

    #[test]
    fn rejects_invalid_option_id_format() {
        let content = poll_slide_content();

        // Too long
        match validate_vote_options(vec!["a".repeat(37)], "poll", &content) {
            VoteValidationResult::Invalid(msg) => {
                assert_eq!(msg, "Invalid option ID format")
            }
            other => panic!("Expected Invalid, got {:?}", other),
        }

        // Special characters
        match validate_vote_options(vec!["opt<script>".to_string()], "poll", &content) {
            VoteValidationResult::Invalid(msg) => {
                assert_eq!(msg, "Invalid option ID format")
            }
            other => panic!("Expected Invalid, got {:?}", other),
        }
    }

    #[test]
    fn accepts_alphanumeric_with_hyphens() {
        let content = json!({
            "question": "Test",
            "options": [
                {"id": "opt-red-123-abc", "text": "Red"}
            ],
            "limitSubmissions": true
        });
        match validate_vote_options(vec!["opt-red-123-abc".to_string()], "poll", &content) {
            VoteValidationResult::Valid { option_ids, .. } => {
                assert_eq!(option_ids, vec!["opt-red-123-abc".to_string()])
            }
            other => panic!("Expected Valid, got {:?}", other),
        }
    }

    #[test]
    fn rejects_option_not_in_slide_content() {
        let content = poll_slide_content();
        match validate_vote_options(vec!["opt-purple".to_string()], "poll", &content) {
            VoteValidationResult::Invalid(msg) => {
                assert!(msg.contains("opt-purple"));
                assert!(msg.contains("not a valid option"));
            }
            other => panic!("Expected Invalid, got {:?}", other),
        }
    }

    #[test]
    fn accepts_valid_single_option_in_poll() {
        let content = poll_slide_content();
        match validate_vote_options(vec!["opt-red".to_string()], "poll", &content) {
            VoteValidationResult::Valid {
                option_ids,
                limit_submissions,
                ..
            } => {
                assert_eq!(option_ids, vec!["opt-red".to_string()]);
                assert!(limit_submissions); // default is true
            }
            other => panic!("Expected Valid, got {:?}", other),
        }
    }

    #[test]
    fn accepts_multiple_options_when_allowed() {
        let content = multi_select_poll_content();
        match validate_vote_options(
            vec!["opt-a".to_string(), "opt-b".to_string()],
            "poll",
            &content,
        ) {
            VoteValidationResult::Valid {
                option_ids,
                limit_submissions,
                allow_multiple_selection,
            } => {
                assert_eq!(option_ids, vec!["opt-a".to_string(), "opt-b".to_string()]);
                assert!(!limit_submissions);
                assert!(allow_multiple_selection);
            }
            other => panic!("Expected Valid, got {:?}", other),
        }
    }

    #[test]
    fn rejects_multiple_options_in_single_choice_multiple_choice_slide() {
        let content = multiple_choice_content();
        match validate_vote_options(
            vec!["opt-1".to_string(), "opt-2".to_string()],
            "multiple-choice",
            &content,
        ) {
            VoteValidationResult::Invalid(msg) => {
                assert_eq!(msg, "This poll only allows selecting one option")
            }
            other => panic!("Expected Invalid, got {:?}", other),
        }
    }

    #[test]
    fn accepts_single_option_in_multiple_choice_slide() {
        let content = multiple_choice_content();
        match validate_vote_options(vec!["opt-1".to_string()], "multiple-choice", &content) {
            VoteValidationResult::Valid { option_ids, .. } => {
                assert_eq!(option_ids, vec!["opt-1".to_string()])
            }
            other => panic!("Expected Valid, got {:?}", other),
        }
    }

    #[test]
    fn limit_submissions_defaults_to_true_when_not_in_content() {
        let content = json!({
            "question": "Test",
            "options": [{"id": "opt-x", "text": "X"}]
        });
        match validate_vote_options(vec!["opt-x".to_string()], "poll", &content) {
            VoteValidationResult::Valid {
                limit_submissions, ..
            } => {
                assert!(limit_submissions)
            }
            other => panic!("Expected Valid, got {:?}", other),
        }
    }

    #[test]
    fn dedupe_option_ids_preserves_first_occurrence_order() {
        assert_eq!(
            dedupe_option_ids(vec![
                "opt-red".to_string(),
                "opt-blue".to_string(),
                "opt-red".to_string(),
            ]),
            vec!["opt-red".to_string(), "opt-blue".to_string()]
        );
    }

    #[test]
    fn dedupe_option_ids_all_unique() {
        let input = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        assert_eq!(dedupe_option_ids(input.clone()), input);
    }

    #[test]
    fn dedupe_option_ids_all_same() {
        let input = vec!["x".to_string(), "x".to_string(), "x".to_string()];
        assert_eq!(dedupe_option_ids(input), vec!["x".to_string()]);
    }

    #[test]
    fn should_skip_vote_snapshot_only_for_duplicate_non_limited_submissions() {
        assert!(should_skip_vote_snapshot(false, 0));
        assert!(!should_skip_vote_snapshot(true, 0));
        assert!(!should_skip_vote_snapshot(false, 1));
        assert!(!should_skip_vote_snapshot(true, 1));
        assert!(!should_skip_vote_snapshot(false, 2));
    }

    // --- Additional edge cases for boundary conditions ---

    #[test]
    fn validate_vote_options_accepts_exactly_max_option_ids() {
        // MAX_OPTION_IDS = 10; exactly 10 valid options should pass
        let options: Vec<_> = (0..10)
            .map(|i| json!({"id": format!("opt-{}", i)}))
            .collect();
        let content = json!({ "options": options, "limitSubmissions": true });
        let ids: Vec<String> = (0..10).map(|i| format!("opt-{}", i)).collect();
        match validate_vote_options(ids, "poll", &content) {
            VoteValidationResult::Valid { option_ids, .. } => {
                assert_eq!(option_ids.len(), 10);
            }
            other => panic!("Expected Valid for exactly 10 options, got {:?}", other),
        }
    }

    #[test]
    fn validate_vote_options_accepts_option_id_exactly_36_chars() {
        // 36 chars (UUID length) should be accepted
        let valid_id = "a".repeat(36);
        let content = json!({
            "options": [{"id": &valid_id}]
        });
        match validate_vote_options(vec![valid_id.clone()], "poll", &content) {
            VoteValidationResult::Valid { option_ids, .. } => {
                assert_eq!(option_ids, vec![valid_id]);
            }
            other => panic!("Expected Valid for 36-char option ID, got {:?}", other),
        }
    }

    #[test]
    fn validate_vote_options_handles_slide_with_no_options_array() {
        // Some slides may not have an options array in content
        let content = json!({ "question": "Open question" });
        match validate_vote_options(vec!["any-id".to_string()], "poll", &content) {
            // When there's no options array, validation skips option existence check
            VoteValidationResult::Valid { .. } => {}
            other => panic!("Expected Valid when no options array, got {:?}", other),
        }
    }

    #[test]
    fn build_vote_update_payload_keeps_vote_snapshot_out_of_the_write_path() {
        let payload =
            build_vote_update_payload("slide-123", 7, &["opt-a".to_string(), "opt-b".to_string()]);

        assert_eq!(payload["slideId"], "slide-123");
        assert_eq!(payload["projection"]["shardId"], 7);
        assert_eq!(payload["projection"]["optionIds"][0], "opt-a");
        assert_eq!(payload["projection"]["optionIds"][1], "opt-b");
        assert!(payload.get("results").is_none());
    }

    #[test]
    fn vote_count_shard_id_is_stable_for_the_same_participant() {
        let first = vote_count_shard_id("participant-123");
        let second = vote_count_shard_id("participant-123");

        assert_eq!(first, second);
        assert!(first < 16);
    }

    #[test]
    fn vote_count_shard_id_spreads_different_participants_across_valid_range() {
        let shard_a = vote_count_shard_id("participant-a");
        let shard_b = vote_count_shard_id("participant-b");

        assert!(shard_a < 16);
        assert!(shard_b < 16);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitQuestionRequest {
    content: String,
    participant_id: String,
    slide_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResponse {
    pub id: String,
    pub session_id: String,
    pub slide_id: Option<String>,
    pub participant_id: String,
    pub content: String,
    pub upvotes: i32,
    pub is_approved: bool,
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl From<Question> for QuestionResponse {
    fn from(q: Question) -> Self {
        QuestionResponse {
            id: q.id,
            session_id: q.session_id,
            slide_id: q.slide_id,
            participant_id: q.participant_id,
            content: q.content,
            upvotes: q.upvotes,
            is_approved: q.is_approved,
            created_at: q.created_at,
        }
    }
}

/// Submit a question
pub async fn submit_question(
    State(app_state): State<crate::AppState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(payload): Json<SubmitQuestionRequest>,
) -> Result<axum::response::Response> {
    let pool = app_state.db_pool.pool_fast_fail().await?;

    let content = payload.content.trim();
    if content.is_empty() {
        return Err(AppError::Input("Question cannot be empty".to_string()));
    }
    if content.len() > MAX_QUESTION_LENGTH {
        return Err(AppError::Input(format!(
            "Question too long (max {} characters)",
            MAX_QUESTION_LENGTH
        )));
    }
    let sanitized_content = content.replace('<', "&lt;").replace('>', "&gt;");

    let session_exists: Option<bool> =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?)")
            .bind(&session_id)
            .fetch_optional(&pool)
            .await?;
    if session_exists != Some(true) {
        return Err(AppError::NotFound("Session not found".to_string()));
    }

    let allows_questions: Option<bool> =
        sqlx::query_scalar("SELECT allow_questions FROM sessions WHERE id = ?")
            .bind(&session_id)
            .fetch_optional(&pool)
            .await
            .unwrap_or(Some(true));
    if allows_questions == Some(false) {
        return Err(AppError::Input(
            "Questions are not enabled for this session".to_string(),
        ));
    }

    let client_request_id = resolve_client_request_id(&headers)?;
    if let Some(existing) = crate::services::wal::fetch_replay_response::<QuestionResponse>(
        &pool,
        &session_id,
        crate::services::wal::WalOpType::SubmitQuestion,
        &client_request_id,
    )
    .await?
    {
        return Ok((StatusCode::ACCEPTED, Json(ApiResponse::success(existing))).into_response());
    }

    let question_id = Uuid::new_v4().to_string();
    let question = QuestionResponse {
        id: question_id.clone(),
        session_id: session_id.clone(),
        slide_id: payload.slide_id.clone(),
        participant_id: payload.participant_id.clone(),
        content: sanitized_content.clone(),
        upvotes: 0,
        is_approved: false,
        created_at: None,
    };

    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT INTO questions (id, session_id, slide_id, participant_id, content, client_request_id)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&question_id)
    .bind(&session_id)
    .bind(question.slide_id.as_deref())
    .bind(&question.participant_id)
    .bind(&question.content)
    .bind(&client_request_id)
    .execute(&mut *tx)
    .await?;

    let (sequence, questions) = next_qa_sequence_and_questions(&mut tx, &session_id).await?;
    let qa_payload = serde_json::json!({
        "payload": { "questions": questions },
        "sequence": sequence
    });
    crate::services::outbox::enqueue_event(
        &mut tx,
        &session_id,
        crate::services::outbox::OutboxEventType::QaUpdate,
        &qa_payload,
    )
    .await?;

    sqlx::query(
        "INSERT IGNORE INTO wal_request_replays (session_id, op_type, client_request_id, response_payload)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&session_id)
    .bind(crate::services::wal::WalOpType::SubmitQuestion.to_string())
    .bind(&client_request_id)
    .bind(sqlx::types::Json(serde_json::to_value(&question).expect("question should serialize")))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok((StatusCode::ACCEPTED, Json(ApiResponse::success(question))).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpvoteQuestionRequest {
    participant_id: Option<String>,
}

/// Upvote a question
pub async fn upvote_question(
    State(app_state): State<crate::AppState>,
    headers: HeaderMap,
    Path((session_id, question_id)): Path<(String, String)>,
    body: Option<Json<UpvoteQuestionRequest>>,
) -> Result<impl IntoResponse> {
    let pool = app_state.db_pool.pool_fast_fail().await?;

    let question = Question::find_by_id(&pool, &question_id).await?;
    let Some(question) = question else {
        return Err(AppError::NotFound("Question not found".to_string()));
    };
    if question.session_id != session_id {
        return Err(AppError::NotFound("Question not found".to_string()));
    }

    let participant_id = body
        .and_then(|b| b.participant_id.clone())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "anonymous".to_string());
    let client_request_id = resolve_client_request_id(&headers)?;
    if let Some(existing) = crate::services::wal::fetch_replay_response::<serde_json::Value>(
        &pool,
        &session_id,
        crate::services::wal::WalOpType::UpvoteQuestion,
        &client_request_id,
    )
    .await?
    {
        return Ok(crate::services::wal::queued_success_response(&existing));
    }

    let mut tx = pool.begin().await?;

    let insert_result =
        sqlx::query("INSERT INTO question_upvotes (question_id, participant_id) VALUES (?, ?)")
            .bind(&question_id)
            .bind(&participant_id)
            .execute(&mut *tx)
            .await;

    let already_upvoted = match insert_result {
        Ok(_) => false,
        Err(ref error) => is_mysql_duplicate_key(error),
    };

    if !already_upvoted {
        sqlx::query("UPDATE questions SET upvotes = upvotes + 1 WHERE id = ?")
            .bind(&question_id)
            .execute(&mut *tx)
            .await?;
    }

    let (sequence, questions) = next_qa_sequence_and_questions(&mut tx, &session_id).await?;
    let qa_payload = serde_json::json!({
        "payload": { "questions": questions },
        "sequence": sequence
    });
    crate::services::outbox::enqueue_event(
        &mut tx,
        &session_id,
        crate::services::outbox::OutboxEventType::QaUpdate,
        &qa_payload,
    )
    .await?;

    let updated_upvotes = question.upvotes.saturating_add(if already_upvoted { 0 } else { 1 });
    let response = serde_json::json!({
        "message": "Question upvoted",
        "upvotes": updated_upvotes,
        "alreadyUpvoted": already_upvoted
    });

    sqlx::query(
        "INSERT IGNORE INTO wal_request_replays (session_id, op_type, client_request_id, response_payload)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&session_id)
    .bind(crate::services::wal::WalOpType::UpvoteQuestion.to_string())
    .bind(&client_request_id)
    .bind(sqlx::types::Json(&response))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(crate::services::wal::queued_success_response(&response))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterParticipantRequest {
    participant_id: String,
    name: String,
}

/// Register a participant in a session
pub async fn register_participant(
    State(app_state): State<crate::AppState>,
    Path(session_id): Path<String>,
    Json(payload): Json<RegisterParticipantRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    let pool = app_state.db_pool.pool_fast_fail().await?;

    let name = payload.name.trim();

    // Check if session exists and get require_name setting
    let session_info: Option<(bool,)> =
        sqlx::query_as("SELECT require_name FROM sessions WHERE id = ?")
            .bind(&session_id)
            .fetch_optional(&pool)
            .await?;

    let require_name = match session_info {
        Some((require_name,)) => require_name,
        None => return Err(AppError::NotFound("Session not found".to_string())),
    };

    // If session requires name, reject empty names
    let is_anonymous = name.eq_ignore_ascii_case("anonymous");
    if require_name && (name.is_empty() || is_anonymous) {
        tracing::warn!(
            "Participant registration rejected: empty name for session {} which requires name",
            session_id
        );
        return Err(AppError::Input(
            "Name is required for this session".to_string(),
        ));
    }

    // If name is empty and not required, don't register (just return success)
    if name.is_empty() {
        return Ok(Json(ApiResponse::success(serde_json::json!({
            "message": "Participant joined anonymously",
            "participantId": payload.participant_id
        }))));
    }

    if name.len() > MAX_NAME_LENGTH {
        return Err(AppError::Input(format!(
            "Name too long (max {} characters)",
            MAX_NAME_LENGTH
        )));
    }
    let sanitized_name = name.replace('<', "&lt;").replace('>', "&gt;");

    Participant::create(&pool, &payload.participant_id, &session_id, &sanitized_name).await?;

    Ok(Json(ApiResponse::success(serde_json::json!({
        "message": "Participant registered",
        "participantId": payload.participant_id
    }))))
}

#[derive(Deserialize)]
pub struct GetMyVotesQuery {
    #[serde(rename = "participantId")]
    pub participant_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyVotesResponse {
    pub votes: HashMap<String, Vec<String>>, // slide_id -> [option_ids]
}

/// Get a student's previous votes for a session
/// This allows restoring vote state when reopening the app
pub async fn get_my_votes(
    State(app_state): State<crate::AppState>,
    Path(session_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<GetMyVotesQuery>,
) -> Result<Json<ApiResponse<MyVotesResponse>>> {
    let pool = app_state.db_pool.pool_fast_fail().await?;

    tracing::info!(
        "get_my_votes called for session {} with participantId {}",
        session_id,
        query.participant_id
    );

    if query.participant_id.trim().is_empty() {
        return Err(AppError::Input("Participant ID is required".to_string()));
    }

    let session_slide_ids = get_session_slide_ids(&pool, &session_id).await?;
    let votes =
        get_votes_for_participant_by_slide_ids(&pool, &query.participant_id, &session_slide_ids)
            .await?;

    tracing::info!(
        "Found {} votes for participant {}",
        votes.len(),
        query.participant_id
    );

    Ok(Json(ApiResponse::success(MyVotesResponse {
        votes: group_votes_by_slide(votes),
    })))
}

#[cfg(test)]
mod student_helper_tests {
    use super::{group_votes_by_slide, with_degraded_header, ApiResponse};

    // --- group_votes_by_slide tests ---

    /// Groups (slide_id, option_id) tuples into a HashMap keyed by slide_id.
    #[test]
    fn group_votes_by_slide_groups_multiple_options_per_slide() {
        let votes = vec![
            ("slide-1".to_string(), "opt-a".to_string()),
            ("slide-1".to_string(), "opt-b".to_string()),
            ("slide-2".to_string(), "opt-c".to_string()),
        ];
        let grouped = group_votes_by_slide(votes);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped["slide-1"], vec!["opt-a", "opt-b"]);
        assert_eq!(grouped["slide-2"], vec!["opt-c"]);
    }

    /// Empty input produces an empty map.
    #[test]
    fn group_votes_by_slide_empty_input() {
        let grouped = group_votes_by_slide(vec![]);
        assert!(grouped.is_empty());
    }

    /// A single vote for a single slide produces a single-entry map.
    #[test]
    fn group_votes_by_slide_single_vote() {
        let votes = vec![("slide-x".to_string(), "opt-y".to_string())];
        let grouped = group_votes_by_slide(votes);
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped["slide-x"], vec!["opt-y"]);
    }

    // --- with_degraded_header tests ---

    /// When the realtime circuit breaker is NOT open, the response has no
    /// `X-Realtime-Degraded` header.
    #[test]
    fn with_degraded_header_omits_header_when_not_degraded() {
        let body = ApiResponse::success("ok");
        let response = with_degraded_header(body);
        assert!(response.headers().get("x-realtime-degraded").is_none());
    }

    // Note: with_degraded_header when degraded=true requires setting the circuit
    // breaker to open state, which uses a static global. Testing that path
    // requires serializing access to the global circuit breaker state, which
    // is better done in an integration test or via dependency injection.
    // The degraded path is tested indirectly via the existing concurrency tests.
}
