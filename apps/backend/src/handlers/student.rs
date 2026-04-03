use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::{MySql, Transaction};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::models::response::ApiResponse;
use crate::models::student::Participant;
use crate::models::student::Question;
use crate::services::ably::{publish_qa_update, publish_vote_update};

const MAX_QUESTION_LENGTH: usize = 1000;
const MAX_NAME_LENGTH: usize = 100;
const MAX_OPTION_IDS: usize = 10;
const MAX_DEADLOCK_RETRIES: u32 = 3;
const MY_VOTES_SLIDE_ID_CHUNK_SIZE: usize = 128;

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

fn should_skip_vote_snapshot(limit_submissions: bool, rows_affected: u64) -> bool {
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
        drop(separated);
        qb.push(")");

        let chunk_votes = qb
            .build_query_as::<(String, String)>()
            .fetch_all(pool)
            .await?;
        votes.extend(chunk_votes);
    }

    Ok(votes)
}

/// Helper function: Atomically increment vote_sequence and fetch vote counts.
/// Returns (sequence, HashMap<option_id, count>)
async fn next_vote_sequence_and_counts(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    slide_id: &str,
) -> Result<(u64, HashMap<String, i32>)> {
    // Increment the sequence
    sqlx::query("UPDATE sessions SET vote_sequence = vote_sequence + 1 WHERE id = ?")
        .bind(session_id)
        .execute(&mut **tx)
        .await?;

    // Read the new sequence value
    let sequence: u64 = sqlx::query_scalar("SELECT vote_sequence FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_one(&mut **tx)
        .await?;

    // Read the vote counts snapshot
    let vote_counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT option_id, COUNT(*) as count FROM votes WHERE slide_id = ? GROUP BY option_id",
    )
    .bind(slide_id)
    .fetch_all(&mut **tx)
    .await?;

    let results: HashMap<String, i32> = vote_counts
        .into_iter()
        .map(|(option_id, count)| (option_id, count as i32))
        .collect();

    Ok((sequence, results))
}

/// Helper function: Atomically increment qa_sequence and fetch questions.
/// Returns (sequence, Vec<Question>)
async fn next_qa_sequence_and_questions(
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
    Path(session_id): Path<String>,
    Json(payload): Json<SubmitVoteRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    let pool = app_state.db_pool.pool().await?;

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

    let option_ids = if let Some(ids) = payload.option_ids {
        ids
    } else if let Some(id) = payload.option_id {
        vec![id]
    } else {
        return Err(AppError::Input("No option selected".to_string()));
    };
    let option_ids = dedupe_option_ids(option_ids);

    if option_ids.is_empty() {
        return Err(AppError::Input("No option selected".to_string()));
    }
    if option_ids.len() > MAX_OPTION_IDS {
        return Err(AppError::Input("Too many options selected".to_string()));
    }
    for opt_id in &option_ids {
        if opt_id.len() > 36 || opt_id.contains(|c: char| !c.is_alphanumeric() && c != '-') {
            return Err(AppError::Input("Invalid option ID format".to_string()));
        }
    }

    // Validate option IDs against slide content
    if let Some(options) = slide_content.get("options").and_then(|o| o.as_array()) {
        let valid_option_ids: HashSet<&str> = options
            .iter()
            .filter_map(|opt| opt.get("id").and_then(|id| id.as_str()))
            .collect();

        for opt_id in &option_ids {
            if !valid_option_ids.contains(opt_id.as_str()) {
                return Err(AppError::Input(format!(
                    "Invalid option ID: {} is not a valid option for this slide",
                    opt_id
                )));
            }
        }
    }

    // Parse slide settings from content
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
        return Err(AppError::Input(
            "This poll only allows selecting one option".to_string(),
        ));
    }

    // Use a single transaction to atomically:
    // 1. Check limitSubmissions locking
    // 2. Insert votes
    // 3. Increment vote_sequence
    // 4. Read the post-mutation snapshot (sequence + vote counts)
    // This ensures the published payload matches the sequence number.
    // Retry on deadlock errors (MySQL 1213/40001)
    let mut retry_count = 0;
    let (sequence, results) = loop {
        let mut tx = pool.begin().await?;

        // For limitSubmissions=true, atomically reserve a submission slot.
        // This avoids gap-lock deadlocks that can happen with SELECT ... FOR UPDATE on the votes table.
        if limit_submissions {
            let reserve = sqlx::query(
                "INSERT INTO vote_submissions (slide_id, participant_id, session_id) VALUES (?, ?, ?)",
            )
            .bind(&payload.slide_id)
            .bind(&payload.participant_id)
            .bind(&session_id)
            .execute(&mut *tx)
            .await;

            if let Err(e) = reserve {
                let _ = tx.rollback().await;

                if is_deadlock_error(&e) && retry_count < MAX_DEADLOCK_RETRIES {
                    retry_count += 1;
                    tracing::warn!(
                        "Vote submission deadlock, retrying ({}/{})",
                        retry_count,
                        MAX_DEADLOCK_RETRIES
                    );
                    tokio::time::sleep(Duration::from_millis(50 * retry_count as u64)).await;
                    continue;
                }

                if is_mysql_duplicate_key(&e) {
                    return Err(AppError::Input(
                        "You have already submitted a vote for this slide".to_string(),
                    ));
                }

                tracing::error!("Failed to reserve vote submission slot: {:?}", e);
                return Err(AppError::Internal(format!(
                    "Failed to reserve vote submission slot: {}",
                    e
                )));
            }
        }

        // Create votes within the transaction using INSERT IGNORE
        if !option_ids.is_empty() {
            let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
                "INSERT IGNORE INTO votes (id, session_id, slide_id, participant_id, option_id) ",
            );

            query.push_values(option_ids.iter(), |mut row, option_id| {
                let vote_id = Uuid::new_v4().to_string();
                row.push_bind(vote_id);
                row.push_bind(&session_id);
                row.push_bind(&payload.slide_id);
                row.push_bind(&payload.participant_id);
                row.push_bind(option_id);
            });

            match query.build().execute(&mut *tx).await {
                Ok(result) => {
                    if should_skip_vote_snapshot(limit_submissions, result.rows_affected()) {
                        let _ = tx.rollback().await;
                        return Ok(Json(ApiResponse::success(
                            serde_json::json!({ "message": "Vote submitted successfully" }),
                        )));
                    }
                }
                Err(e) => {
                    let _ = tx.rollback().await;
                    // Check for deadlock - retry if so
                    if is_deadlock_error(&e) && retry_count < MAX_DEADLOCK_RETRIES {
                        retry_count += 1;
                        tracing::warn!(
                            "Vote submission deadlock, retrying ({}/{})",
                            retry_count,
                            MAX_DEADLOCK_RETRIES
                        );
                        tokio::time::sleep(Duration::from_millis(50 * retry_count as u64)).await;
                        continue;
                    }
                    tracing::error!("Failed to insert votes: {:?}", e);
                    // Check for duplicate-key error
                    if is_mysql_duplicate_key(&e) {
                        return Err(AppError::Input(
                            "You have already submitted a vote for this option".to_string(),
                        ));
                    }
                    return Err(AppError::Internal(format!("Failed to insert votes: {}", e)));
                }
            }
        }

        // Atomically increment sequence and fetch the post-mutation snapshot
        match next_vote_sequence_and_counts(&mut tx, &session_id, &payload.slide_id).await {
            Ok(result) => {
                tx.commit().await?;
                break result;
            }
            Err(e) => {
                let _ = tx.rollback().await;
                if is_app_error_deadlock(&e) && retry_count < MAX_DEADLOCK_RETRIES {
                    retry_count += 1;
                    tracing::warn!(
                        "Vote sequence deadlock, retrying ({}/{})",
                        retry_count,
                        MAX_DEADLOCK_RETRIES
                    );
                    tokio::time::sleep(Duration::from_millis(50 * retry_count as u64)).await;
                    continue;
                }
                return Err(e);
            }
        }
    };

    // Publish vote update with sequence number
    let session_id_for_publish = session_id.clone();
    let slide_id_for_publish = payload.slide_id.clone();
    tokio::spawn(async move {
        let published = publish_vote_update(
            &session_id_for_publish,
            &slide_id_for_publish,
            &results,
            sequence,
        )
        .await;
        if !published {
            tracing::warn!(
                session_id = %session_id_for_publish,
                slide_id = %slide_id_for_publish,
                "Vote update committed but realtime publish failed - clients will converge via refresh"
            );
        }
    });

    Ok(Json(ApiResponse::success(
        serde_json::json!({ "message": "Vote submitted successfully" }),
    )))
}

#[cfg(test)]
mod tests {
    use super::{dedupe_option_ids, should_skip_vote_snapshot};

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
    fn should_skip_vote_snapshot_only_for_duplicate_non_limited_submissions() {
        assert!(should_skip_vote_snapshot(false, 0));
        assert!(!should_skip_vote_snapshot(true, 0));
        assert!(!should_skip_vote_snapshot(false, 1));
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitQuestionRequest {
    content: String,
    participant_id: String,
    slide_id: Option<String>,
}

#[derive(Debug, Serialize)]
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
) -> Result<Json<ApiResponse<QuestionResponse>>> {
    let pool = app_state.db_pool.pool().await?;

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

    let client_request_id = headers
        .get("x-client-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    if let Some(client_request_id) = client_request_id.as_deref() {
        if client_request_id.len() > 64 {
            return Err(AppError::Input("Invalid X-Client-Request-Id".to_string()));
        }

        let existing = sqlx::query_as::<_, Question>(
            "SELECT id, session_id, slide_id, participant_id, content, upvotes, is_approved, created_at \
             FROM questions WHERE session_id = ? AND participant_id = ? AND client_request_id = ? LIMIT 1",
        )
        .bind(&session_id)
        .bind(&payload.participant_id)
        .bind(client_request_id)
        .fetch_optional(&pool)
        .await?;

        if let Some(question) = existing {
            return Ok(Json(ApiResponse::success(question.into())));
        }

        // Use a single transaction to atomically:
        // 1. Insert the question
        // 2. Increment qa_sequence
        // 3. Read the post-mutation snapshot (sequence + questions)
        // On duplicate-key (1062), rollback and return the existing question (idempotency)
        let mut tx = pool.begin().await?;

        let question_id = Uuid::new_v4().to_string();
        let insert_result = sqlx::query(
            "INSERT INTO questions (id, session_id, slide_id, participant_id, content, client_request_id) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&question_id)
        .bind(&session_id)
        .bind(payload.slide_id.as_deref())
        .bind(&payload.participant_id)
        .bind(&sanitized_content)
        .bind(client_request_id)
        .execute(&mut *tx)
        .await;

        match insert_result {
            Ok(_) => {
                // Insert succeeded - increment sequence and fetch snapshot
                let (sequence, all_questions) =
                    next_qa_sequence_and_questions(&mut tx, &session_id).await?;
                tx.commit().await?;

                let question = all_questions
                    .iter()
                    .find(|q| q.id == question_id)
                    .cloned()
                    .ok_or_else(|| {
                        AppError::Internal("Question not found after insert".to_string())
                    })?;

                let session_id_for_publish = session_id.clone();
                tokio::spawn(async move {
                    let published =
                        publish_qa_update(&session_id_for_publish, &all_questions, sequence).await;
                    if !published {
                        tracing::warn!(
                            session_id = %session_id_for_publish,
                            "Question committed but realtime publish failed - clients will converge via refresh"
                        );
                    }
                });

                return Ok(Json(ApiResponse::success(question.into())));
            }
            Err(e) => {
                let is_duplicate = is_mysql_duplicate_key(&e);
                let _ = tx.rollback().await;

                if is_duplicate {
                    // Duplicate-key: fetch the existing question and return it (idempotent).
                    // Use a transaction with FOR UPDATE to wait for the concurrent insert to commit.
                    let mut fetch_tx = pool.begin().await?;

                    for attempt in 0..3 {
                        // Use FOR UPDATE to wait for any concurrent insert to commit
                        let existing = sqlx::query_as::<_, Question>(
                            "SELECT id, session_id, slide_id, participant_id, content, upvotes, is_approved, created_at
                             FROM questions
                             WHERE session_id = ? AND participant_id = ? AND client_request_id = ?
                             LIMIT 1 FOR UPDATE",
                        )
                        .bind(&session_id)
                        .bind(&payload.participant_id)
                        .bind(client_request_id)
                        .fetch_optional(&mut *fetch_tx)
                        .await?;

                        if let Some(question) = existing {
                            let _ = fetch_tx.rollback().await;
                            return Ok(Json(ApiResponse::success(question.into())));
                        }

                        // Still not found, wait and retry
                        if attempt < 2 {
                            tokio::time::sleep(Duration::from_millis(100 * (attempt + 1) as u64))
                                .await;
                        }
                    }

                    let _ = fetch_tx.rollback().await;
                    // Still not found after retries - return the duplicate error
                    return Err(AppError::Internal(format!(
                        "Duplicate question request but existing not found after retries: {}",
                        e
                    )));
                }

                return Err(AppError::Internal(format!(
                    "Failed to save question: {}",
                    e
                )));
            }
        }
    }

    // Use a single transaction to atomically:
    // 1. Insert the question
    // 2. Increment qa_sequence
    // 3. Read the post-mutation snapshot (sequence + questions)
    let mut tx = pool.begin().await?;

    let question_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO questions (id, session_id, slide_id, participant_id, content) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&question_id)
    .bind(&session_id)
    .bind(payload.slide_id.as_deref())
    .bind(&payload.participant_id)
    .bind(&sanitized_content)
    .execute(&mut *tx)
    .await?;

    // Atomically increment sequence and fetch the post-mutation snapshot
    let (sequence, all_questions) = next_qa_sequence_and_questions(&mut tx, &session_id).await?;

    tx.commit().await?;

    let question = all_questions
        .iter()
        .find(|q| q.id == question_id)
        .cloned()
        .ok_or_else(|| AppError::Internal("Question not found after insert".to_string()))?;

    let session_id_for_publish = session_id.clone();
    tokio::spawn(async move {
        let published = publish_qa_update(&session_id_for_publish, &all_questions, sequence).await;
        if !published {
            tracing::warn!(
                session_id = %session_id_for_publish,
                "Question committed but realtime publish failed - clients will converge via refresh"
            );
        }
    });

    Ok(Json(ApiResponse::success(question.into())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpvoteQuestionRequest {
    participant_id: Option<String>,
}

/// Upvote a question
pub async fn upvote_question(
    State(app_state): State<crate::AppState>,
    Path((session_id, question_id)): Path<(String, String)>,
    body: Option<Json<UpvoteQuestionRequest>>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    let pool = app_state.db_pool.pool().await?;

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

    // Use a single transaction to atomically:
    // 1. Insert upvote (or detect duplicate)
    // 2. Update upvotes count
    // 3. Increment qa_sequence (if new upvote)
    // 4. Read the post-mutation snapshot (sequence + questions)
    let mut tx = pool.begin().await?;
    let mut already_upvoted = false;

    let insert_result =
        sqlx::query("INSERT INTO question_upvotes (question_id, participant_id) VALUES (?, ?)")
            .bind(&question_id)
            .bind(&participant_id)
            .execute(&mut *tx)
            .await;

    match insert_result {
        Ok(_) => {
            sqlx::query("UPDATE questions SET upvotes = upvotes + 1 WHERE id = ?")
                .bind(&question_id)
                .execute(&mut *tx)
                .await?;
        }
        Err(e) => {
            if is_mysql_duplicate_key(&e) {
                already_upvoted = true;
            } else {
                return Err(AppError::Internal(format!(
                    "Failed to upvote question: {}",
                    e
                )));
            }
        }
    }

    let new_upvotes: i32 = sqlx::query_scalar("SELECT upvotes FROM questions WHERE id = ?")
        .bind(&question_id)
        .fetch_one(&mut *tx)
        .await?;

    let (sequence, all_questions) = if !already_upvoted {
        // Atomically increment sequence and fetch the post-mutation snapshot
        next_qa_sequence_and_questions(&mut tx, &session_id).await?
    } else {
        // Already upvoted - just fetch current state without incrementing sequence
        let sequence: u64 = sqlx::query_scalar("SELECT qa_sequence FROM sessions WHERE id = ?")
            .bind(&session_id)
            .fetch_one(&mut *tx)
            .await?;
        let questions: Vec<Question> = sqlx::query_as(
            "SELECT id, session_id, slide_id, participant_id, content, upvotes, is_approved, created_at
             FROM questions WHERE session_id = ? ORDER BY upvotes DESC, created_at DESC",
        )
        .bind(&session_id)
        .fetch_all(&mut *tx)
        .await?;
        (sequence, questions)
    };

    tx.commit().await?;

    if !already_upvoted {
        let session_id_for_publish = session_id.clone();
        tokio::spawn(async move {
            let published =
                publish_qa_update(&session_id_for_publish, &all_questions, sequence).await;
            if !published {
                tracing::warn!(
                    session_id = %session_id_for_publish,
                    "Question upvote committed but realtime publish failed - clients will converge via refresh"
                );
            }
        });
    }

    Ok(Json(ApiResponse::success(
        serde_json::json!({ "message": "Question upvoted", "upvotes": new_upvotes, "alreadyUpvoted": already_upvoted }),
    )))
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
    let pool = app_state.db_pool.pool().await?;

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
    let pool = app_state.db_pool.pool().await?;

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
