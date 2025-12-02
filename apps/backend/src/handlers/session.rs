use axum::{extract::{State, Path}, Json};
use serde::Deserialize;

use crate::error::Result;
use crate::models::session::Session;
use crate::models::response::ApiResponse;
use crate::middleware::auth::AuthUser;

/// Request DTO for creating a session
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    title: String,
    allow_questions: Option<bool>,
    require_name: Option<bool>,
}

/// Request DTO for updating a session
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionRequest {
    title: Option<String>,
    allow_questions: Option<bool>,
    require_name: Option<bool>,
}

/// PRESENTATION LAYER - Session Handlers
/// These handlers ONLY handle HTTP concerns:
/// - Parse requests
/// - Extract user identity
/// - Call service layer
/// - Return HTTP responses
/// NO business logic or database access here!

/// Get all sessions for the authenticated user
pub async fn get_sessions(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
) -> Result<Json<ApiResponse<Vec<crate::models::session::SessionWithSlideCount>>>> {
    let sessions = app_state.session_service
        .get_user_sessions_with_slide_count(&user_id)
        .await?;

    Ok(Json(ApiResponse::success(sessions)))
}

/// Create a new session
pub async fn create_session(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Json(payload): Json<CreateSessionRequest>,
) -> Result<Json<ApiResponse<Session>>> {
    let session = app_state.session_service
        .create_session(
            &user_id,
            &payload.title,
            payload.allow_questions.unwrap_or(false),
            payload.require_name.unwrap_or(false),
        )
        .await?;

    Ok(Json(ApiResponse::success(session)))
}

/// Get a specific session by ID
pub async fn get_session(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<ApiResponse<Session>>> {
    let session = app_state.session_service
        .get_session(&id, &user_id)
        .await?;

    Ok(Json(ApiResponse::success(session)))
}

/// Update a session
pub async fn update_session(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(id): Path<String>,
    Json(payload): Json<UpdateSessionRequest>,
) -> Result<Json<ApiResponse<Session>>> {
    let session = app_state.session_service
        .update_session(
            &id,
            &user_id,
            payload.title,
            payload.allow_questions,
            payload.require_name,
        )
        .await?;

    Ok(Json(ApiResponse::success(session)))
}

/// Duplicate a session
pub async fn duplicate_session(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<ApiResponse<Session>>> {
    let session = app_state.session_service
        .duplicate_session(&id, &user_id)
        .await?;

    Ok(Json(ApiResponse::success(session)))
}

/// Archive a session
pub async fn archive_session(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<ApiResponse<Session>>> {
    let session = app_state.session_service
        .archive_session(&id, &user_id)
        .await?;

    Ok(Json(ApiResponse::success(session)))
}

/// Restore an archived session
pub async fn restore_session(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<ApiResponse<Session>>> {
    let session = app_state.session_service
        .restore_session(&id, &user_id)
        .await?;

    Ok(Json(ApiResponse::success(session)))
}

/// Delete a session
pub async fn delete_session(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    app_state.session_service
        .delete_session(&id, &user_id)
        .await?;

    Ok(Json(ApiResponse::success(serde_json::json!({ 
        "message": "Session deleted successfully" 
    }))))
}
