use axum::{extract::{State, Path}, Json};
use serde::Deserialize;
use sqlx::query_as;

use crate::error::{AppError, Result};
use crate::models::response::ApiResponse;
use crate::models::session::{PublicSessionResponse, Session, SessionState};
use crate::services::ably::publish_state_update;

/// Get session by share token (public endpoint)
/// Returns session with slides, questions, and stats
pub async fn get_session_by_share_token(
    State(app_state): State<crate::AppState>,
    Path(token): Path<String>,
) -> Result<Json<ApiResponse<PublicSessionResponse>>> {
    let response = app_state.session_service.get_public_session(&token).await?;
    Ok(Json(ApiResponse::success(response)))
}

/// Get session state (for students/projector real-time sync)
/// Returns flattened state that matches frontend StateUpdatePayload
pub async fn get_session_state(
    State(app_state): State<crate::AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<SessionState>> {
    let state = app_state.session_service.get_session_state(&session_id).await?;
    Ok(Json(state))
}

// ============ Public Clicker Endpoints ============
// These endpoints allow mobile clicker access without authentication
// They verify the session exists but don't require ownership proof

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSetSlideRequest {
    slide_id: Option<String>,
}

#[derive(Deserialize)]
pub struct PublicSetResultsRequest {
    visible: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StateUpdatePayload {
    current_slide_id: Option<String>,
    is_presentation_active: bool,
    is_results_visible: bool,
}

/// Public endpoint to set current slide (for mobile clicker)
pub async fn public_set_current_slide(
    State(app_state): State<crate::AppState>,
    Path(session_id): Path<String>,
    Json(payload): Json<PublicSetSlideRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    let pool = app_state.db_pool.pool().await?;
    
    let session: Option<Session> = query_as("SELECT * FROM sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_optional(&pool)
        .await?;

    let session = session.ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

    sqlx::query("UPDATE sessions SET current_slide_id = ? WHERE id = ?")
        .bind(&payload.slide_id)
        .bind(&session_id)
        .execute(&pool)
        .await?;

    let state_payload = StateUpdatePayload {
        current_slide_id: payload.slide_id,
        is_presentation_active: session.is_presentation_active,
        is_results_visible: session.is_results_visible,
    };
    let session_id_for_publish = session_id.clone();
    tokio::spawn(async move {
        publish_state_update(&session_id_for_publish, &state_payload).await;
    });

    Ok(Json(ApiResponse::success(serde_json::json!({ "message": "Slide updated" }))))
}

/// Public endpoint to set results visibility (for mobile clicker)
pub async fn public_set_results_visibility(
    State(app_state): State<crate::AppState>,
    Path(session_id): Path<String>,
    Json(payload): Json<PublicSetResultsRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    let pool = app_state.db_pool.pool().await?;
    
    let session: Option<Session> = query_as("SELECT * FROM sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_optional(&pool)
        .await?;

    let session = session.ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

    sqlx::query("UPDATE sessions SET is_results_visible = ? WHERE id = ?")
        .bind(payload.visible)
        .bind(&session_id)
        .execute(&pool)
        .await?;

    let state_payload = StateUpdatePayload {
        current_slide_id: session.current_slide_id,
        is_presentation_active: session.is_presentation_active,
        is_results_visible: payload.visible,
    };
    let session_id_for_publish = session_id.clone();
    tokio::spawn(async move {
        publish_state_update(&session_id_for_publish, &state_payload).await;
    });

    Ok(Json(ApiResponse::success(serde_json::json!({ "message": "Results visibility updated" }))))
}
