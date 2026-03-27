use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::models::response::ApiResponse;
use crate::models::student::{Participant, Question, Vote};
use crate::services::ably::{publish_qa_update, publish_vote_update};

const MAX_QUESTION_LENGTH: usize = 1000;
const MAX_NAME_LENGTH: usize = 100;
const MAX_OPTION_IDS: usize = 10;

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

    let session_exists: Option<bool> =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?)")
            .bind(&session_id)
            .fetch_optional(&pool)
            .await?;

    if session_exists != Some(true) {
        return Err(AppError::NotFound("Session not found".to_string()));
    }

    let option_ids: Vec<String> = if let Some(ids) = payload.option_ids {
        ids
    } else if let Some(id) = payload.option_id {
        vec![id]
    } else {
        return Err(AppError::Input("No option selected".to_string()));
    };

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

    Vote::create_many(
        &pool,
        &session_id,
        &payload.slide_id,
        &payload.participant_id,
        &option_ids,
    )
    .await
    .map_err(|e| {
        tracing::error!("Failed to insert votes: {:?}", e);
        AppError::Internal(format!("Failed to save vote: {}", e))
    })?;

    let vote_counts = Vote::get_vote_counts(&pool, &payload.slide_id)
        .await
        .unwrap_or_default();
    let results: HashMap<String, i32> = vote_counts
        .into_iter()
        .map(|(option_id, count)| (option_id, count as i32))
        .collect();
    let session_id_for_publish = session_id.clone();
    let slide_id_for_publish = payload.slide_id.clone();
    tokio::spawn(async move {
        publish_vote_update(&session_id_for_publish, &slide_id_for_publish, &results).await;
    });

    Ok(Json(ApiResponse::success(
        serde_json::json!({ "message": "Vote submitted successfully" }),
    )))
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
        .execute(&pool)
        .await;

        match insert_result {
            Ok(_) => {
                let question = sqlx::query_as::<_, Question>(
                    "SELECT id, session_id, slide_id, participant_id, content, upvotes, is_approved, created_at \
                     FROM questions WHERE id = ? LIMIT 1",
                )
                .bind(&question_id)
                .fetch_one(&pool)
                .await?;

                let all_questions = Question::find_by_session(&pool, &session_id)
                    .await
                    .unwrap_or_default();
                let session_id_for_publish = session_id.clone();
                tokio::spawn(async move {
                    publish_qa_update(&session_id_for_publish, &all_questions).await;
                });

                return Ok(Json(ApiResponse::success(question.into())));
            }
            Err(e) => {
                let is_duplicate_key = matches!(
                    &e,
                    sqlx::Error::Database(db_err) if db_err.code().as_deref() == Some("1062")
                );

                if is_duplicate_key {
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
                }

                return Err(AppError::Internal(format!("Failed to save question: {}", e)));
            }
        }
    }

    let question_id = Uuid::new_v4().to_string();
    let question = Question::create(
        &pool,
        &question_id,
        &session_id,
        payload.slide_id.as_deref(),
        &payload.participant_id,
        &sanitized_content,
    )
    .await
    .map_err(|e| AppError::Internal(format!("Failed to save question: {}", e)))?;

    let all_questions = Question::find_by_session(&pool, &session_id)
        .await
        .unwrap_or_default();
    let session_id_for_publish = session_id.clone();
    tokio::spawn(async move {
        publish_qa_update(&session_id_for_publish, &all_questions).await;
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

    let mut tx = pool.begin().await?;
    let mut already_upvoted = false;

    let insert_result = sqlx::query(
        "INSERT INTO question_upvotes (question_id, participant_id) VALUES (?, ?)",
    )
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
            let is_duplicate_key = matches!(
                &e,
                sqlx::Error::Database(db_err) if db_err.code().as_deref() == Some("1062")
            );
            if is_duplicate_key {
                already_upvoted = true;
            } else {
                return Err(AppError::Internal(format!("Failed to upvote question: {}", e)));
            }
        }
    }

    let new_upvotes: i32 = sqlx::query_scalar("SELECT upvotes FROM questions WHERE id = ?")
        .bind(&question_id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;

    if !already_upvoted {
        let all_questions = Question::find_by_session(&pool, &session_id)
            .await
            .unwrap_or_default();
        let session_id_for_publish = session_id.clone();
        tokio::spawn(async move {
            publish_qa_update(&session_id_for_publish, &all_questions).await;
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

    // Fetch all votes for this participant in this session
    let votes: Vec<(String, String)> = sqlx::query_as(
        "SELECT slide_id, option_id FROM votes WHERE session_id = ? AND participant_id = ?",
    )
    .bind(&session_id)
    .bind(&query.participant_id)
    .fetch_all(&pool)
    .await?;

    tracing::info!(
        "Found {} votes for participant {}",
        votes.len(),
        query.participant_id
    );

    // Group by slide_id
    let mut votes_map: HashMap<String, Vec<String>> = HashMap::new();
    for (slide_id, option_id) in votes {
        votes_map.entry(slide_id).or_default().push(option_id);
    }

    Ok(Json(ApiResponse::success(MyVotesResponse {
        votes: votes_map,
    })))
}
