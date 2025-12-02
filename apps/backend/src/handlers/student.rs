use axum::{extract::{State, Path}, Json};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use std::collections::HashMap;

use crate::error::{AppError, Result};
use crate::models::response::ApiResponse;
use crate::models::student::{Vote, Question, Participant};
use crate::services::ably::{publish_vote_update, publish_qa_update};

// Input validation constants
const MAX_QUESTION_LENGTH: usize = 1000;
const MAX_NAME_LENGTH: usize = 100;
const MAX_OPTION_IDS: usize = 10;

// ============ Vote Handling ============

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitVoteRequest {
    slide_id: String,
    option_id: Option<String>,      // For single-choice polls
    option_ids: Option<Vec<String>>, // For multiple-choice
    participant_id: String,
}

/// Submit a vote for a poll/quiz slide
pub async fn submit_vote(
    State(app_state): State<crate::AppState>,
    Path(session_id): Path<String>,
    Json(payload): Json<SubmitVoteRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    tracing::info!("Vote submission for session {}: slide={}, participant={}", 
        session_id, payload.slide_id, payload.participant_id);
    
    // Verify session exists
    let session_exists: Option<bool> = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?)"
    )
    .bind(&session_id)
    .fetch_optional(&app_state.db_pool)
    .await?;

    if session_exists != Some(true) {
        return Err(AppError::NotFound("Session not found".to_string()));
    }

    // Handle both single and multiple option votes
    let option_ids: Vec<String> = if let Some(ids) = payload.option_ids {
        ids
    } else if let Some(id) = payload.option_id {
        vec![id]
    } else {
        return Err(AppError::Input("No option selected".to_string()));
    };

    // Input validation
    if option_ids.is_empty() {
        return Err(AppError::Input("No option selected".to_string()));
    }
    if option_ids.len() > MAX_OPTION_IDS {
        return Err(AppError::Input("Too many options selected".to_string()));
    }
    // Validate option IDs are valid UUIDs (prevent injection)
    for opt_id in &option_ids {
        if opt_id.len() > 36 || opt_id.contains(|c: char| !c.is_alphanumeric() && c != '-') {
            return Err(AppError::Input("Invalid option ID format".to_string()));
        }
    }

    tracing::info!("Processing {} vote option(s)", option_ids.len());

    // Insert votes using ORM model
    for option_id in &option_ids {
        let vote_id = Uuid::new_v4().to_string();
        
        if let Err(e) = Vote::create(
            &app_state.db_pool, 
            &vote_id, 
            &session_id, 
            &payload.slide_id, 
            &payload.participant_id, 
            option_id
        ).await {
            tracing::error!("Failed to insert vote: {:?}", e);
            return Err(AppError::Internal(format!("Failed to save vote: {}. Make sure the votes table exists.", e)));
        }
    }

    // Get updated vote counts using ORM
    let vote_counts = Vote::get_vote_counts(&app_state.db_pool, &payload.slide_id).await.unwrap_or_default();
    let results: HashMap<String, i32> = vote_counts
        .into_iter()
        .map(|(option_id, count)| (option_id, count as i32))
        .collect();

    // Publish vote update to Ably for real-time sync
    publish_vote_update(&session_id, &payload.slide_id, &results).await;

    Ok(Json(ApiResponse::success(serde_json::json!({ 
        "message": "Vote submitted successfully" 
    }))))
}

// ============ Question Handling ============

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
    Json(payload): Json<SubmitQuestionRequest>,
) -> Result<Json<ApiResponse<QuestionResponse>>> {
    // Input validation
    let content = payload.content.trim();
    if content.is_empty() {
        return Err(AppError::Input("Question cannot be empty".to_string()));
    }
    if content.len() > MAX_QUESTION_LENGTH {
        return Err(AppError::Input(format!("Question too long (max {} characters)", MAX_QUESTION_LENGTH)));
    }
    // Sanitize: remove potential HTML/script tags (basic protection)
    let sanitized_content = content
        .replace('<', "&lt;")
        .replace('>', "&gt;");

    // Verify session exists
    let session_exists: Option<bool> = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?)"
    )
    .bind(&session_id)
    .fetch_optional(&app_state.db_pool)
    .await?;

    if session_exists != Some(true) {
        return Err(AppError::NotFound("Session not found".to_string()));
    }

    // Check allow_questions - default to true if column doesn't exist or is NULL
    let allows_questions: Option<bool> = sqlx::query_scalar(
        "SELECT allow_questions FROM sessions WHERE id = ?"
    )
    .bind(&session_id)
    .fetch_optional(&app_state.db_pool)
    .await
    .unwrap_or(Some(true));

    // Only block if explicitly set to false (not NULL or missing)
    if allows_questions == Some(false) {
        tracing::info!("Questions disabled for session {}", session_id);
        return Err(AppError::Input("Questions are not enabled for this session".to_string()));
    }
    
    tracing::info!("allow_questions check passed: {:?}", allows_questions);

    let question_id = Uuid::new_v4().to_string();
    
    tracing::info!("Submitting question for session {}: content={}", session_id, sanitized_content);

    // Use ORM model to create question
    let question = Question::create(
        &app_state.db_pool,
        &question_id,
        &session_id,
        payload.slide_id.as_deref(),
        &payload.participant_id,
        &sanitized_content,
    ).await.map_err(|e| {
        tracing::error!("Failed to insert question: {:?}", e);
        AppError::Internal(format!("Failed to save question: {}. Make sure the questions table exists.", e))
    })?;

    // Fetch all questions and publish to Ably
    let all_questions = Question::find_by_session(&app_state.db_pool, &session_id).await.unwrap_or_default();
    publish_qa_update(&session_id, &all_questions).await;

    Ok(Json(ApiResponse::success(question.into())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpvoteQuestionRequest {
    participant_id: Option<String>,
}

/// Upvote a question (with duplicate prevention)
pub async fn upvote_question(
    State(app_state): State<crate::AppState>,
    Path((session_id, question_id)): Path<(String, String)>,
    body: Option<Json<UpvoteQuestionRequest>>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    // Verify question exists
    let question = Question::find_by_id(&app_state.db_pool, &question_id).await?;
    if question.is_none() {
        return Err(AppError::NotFound("Question not found".to_string()));
    }

    // Get participant ID from body or generate anonymous one
    let participant_id = body
        .and_then(|b| b.participant_id.clone())
        .unwrap_or_else(|| "anonymous".to_string());

    // Check if this participant already upvoted this question
    let already_upvoted: Option<bool> = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM question_upvotes WHERE question_id = ? AND participant_id = ?)"
    )
    .bind(&question_id)
    .bind(&participant_id)
    .fetch_optional(&app_state.db_pool)
    .await
    .unwrap_or(Some(false));

    if already_upvoted == Some(true) {
        return Err(AppError::Input("You have already upvoted this question".to_string()));
    }

    // Record the upvote
    sqlx::query(
        "INSERT INTO question_upvotes (question_id, participant_id) VALUES (?, ?) 
         ON DUPLICATE KEY UPDATE created_at = created_at"
    )
    .bind(&question_id)
    .bind(&participant_id)
    .execute(&app_state.db_pool)
    .await
    .ok(); // Ignore errors (table might not exist yet)

    // Upvote using ORM
    let new_upvotes = Question::upvote(&app_state.db_pool, &question_id).await?;

    // Fetch all questions and publish to Ably
    let all_questions = Question::find_by_session(&app_state.db_pool, &session_id).await.unwrap_or_default();
    publish_qa_update(&session_id, &all_questions).await;

    Ok(Json(ApiResponse::success(serde_json::json!({ 
        "message": "Question upvoted",
        "upvotes": new_upvotes
    }))))
}

// ============ Participant Registration ============

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
    // Input validation
    let name = payload.name.trim();
    if name.is_empty() {
        return Err(AppError::Input("Name cannot be empty".to_string()));
    }
    if name.len() > MAX_NAME_LENGTH {
        return Err(AppError::Input(format!("Name too long (max {} characters)", MAX_NAME_LENGTH)));
    }
    // Sanitize name
    let sanitized_name = name
        .replace('<', "&lt;")
        .replace('>', "&gt;");

    // Verify session exists
    let session_exists: Option<bool> = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?)"
    )
    .bind(&session_id)
    .fetch_optional(&app_state.db_pool)
    .await?;

    if session_exists != Some(true) {
        return Err(AppError::NotFound("Session not found".to_string()));
    }

    // Use ORM model to create participant
    Participant::create(&app_state.db_pool, &payload.participant_id, &session_id, &sanitized_name).await?;

    Ok(Json(ApiResponse::success(serde_json::json!({ 
        "message": "Participant registered",
        "participantId": payload.participant_id
    }))))
}
