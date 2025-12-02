use axum::{extract::{State, Path}, Json};
use serde::{Deserialize, Serialize};
use sqlx::query_as;

use crate::error::{AppError, Result};
use crate::models::session::Session;
use crate::models::response::ApiResponse;
use crate::middleware::auth::AuthUser;
use crate::services::ably::publish_state_update;

/// State update payload for real-time broadcast
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateUpdatePayload {
    current_slide_id: Option<String>,
    is_presentation_active: bool,
    is_results_visible: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCurrentSlideRequest {
    slide_id: Option<String>,
}

#[derive(Deserialize)]
pub struct SetResultsVisibilityRequest {
    visible: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSlideVisibilityRequest {
    is_hidden: bool,
}

/// Set current slide for live presentation
pub async fn set_current_slide(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(session_id): Path<String>,
    Json(payload): Json<SetCurrentSlideRequest>,
) -> Result<Json<ApiResponse<Session>>> {
    verify_session_ownership(&app_state.db_pool, &session_id, &user_id).await?;

    sqlx::query("UPDATE sessions SET current_slide_id = ? WHERE id = ?")
        .bind(&payload.slide_id)
        .bind(&session_id)
        .execute(&app_state.db_pool)
        .await?;

    let session = query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_one(&app_state.db_pool)
        .await?;

    // Publish state update to Ably for real-time sync
    let state_payload = StateUpdatePayload {
        current_slide_id: session.current_slide_id.clone(),
        is_presentation_active: session.is_presentation_active,
        is_results_visible: session.is_results_visible,
    };
    publish_state_update(&session_id, &state_payload).await;

    Ok(Json(ApiResponse::success(session)))
}

/// Set results visibility
pub async fn set_results_visibility(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(session_id): Path<String>,
    Json(payload): Json<SetResultsVisibilityRequest>,
) -> Result<Json<ApiResponse<Session>>> {
    verify_session_ownership(&app_state.db_pool, &session_id, &user_id).await?;

    sqlx::query("UPDATE sessions SET is_results_visible = ? WHERE id = ?")
        .bind(payload.visible)
        .bind(&session_id)
        .execute(&app_state.db_pool)
        .await?;

    let session = query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_one(&app_state.db_pool)
        .await?;

    // Publish state update to Ably for real-time sync
    let state_payload = StateUpdatePayload {
        current_slide_id: session.current_slide_id.clone(),
        is_presentation_active: session.is_presentation_active,
        is_results_visible: session.is_results_visible,
    };
    publish_state_update(&session_id, &state_payload).await;

    Ok(Json(ApiResponse::success(session)))
}

/// Update slide visibility
pub async fn update_slide_visibility(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path((session_id, slide_id)): Path<(String, String)>,
    Json(payload): Json<UpdateSlideVisibilityRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    verify_session_ownership(&app_state.db_pool, &session_id, &user_id).await?;

    sqlx::query("UPDATE slides SET is_hidden = ? WHERE id = ? AND session_id = ?")
        .bind(payload.is_hidden)
        .bind(&slide_id)
        .bind(&session_id)
        .execute(&app_state.db_pool)
        .await?;

    Ok(Json(ApiResponse::success(serde_json::json!({ "message": "Slide visibility updated" }))))
}

/// Go live with session
pub async fn go_live(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(session_id): Path<String>,
) -> Result<Json<ApiResponse<Session>>> {
    verify_session_ownership(&app_state.db_pool, &session_id, &user_id).await?;

    sqlx::query("UPDATE sessions SET is_presentation_active = TRUE, status = 'published' WHERE id = ?")
        .bind(&session_id)
        .execute(&app_state.db_pool)
        .await?;

    let session = query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_one(&app_state.db_pool)
        .await?;

    // Publish state update to Ably for real-time sync
    let state_payload = StateUpdatePayload {
        current_slide_id: session.current_slide_id.clone(),
        is_presentation_active: session.is_presentation_active,
        is_results_visible: session.is_results_visible,
    };
    publish_state_update(&session_id, &state_payload).await;

    Ok(Json(ApiResponse::success(session)))
}

/// Stop live session
pub async fn stop_live(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(session_id): Path<String>,
) -> Result<Json<ApiResponse<Session>>> {
    verify_session_ownership(&app_state.db_pool, &session_id, &user_id).await?;

    sqlx::query("UPDATE sessions SET is_presentation_active = FALSE WHERE id = ?")
        .bind(&session_id)
        .execute(&app_state.db_pool)
        .await?;

    let session = query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_one(&app_state.db_pool)
        .await?;

    // Publish state update to Ably for real-time sync
    let state_payload = StateUpdatePayload {
        current_slide_id: session.current_slide_id.clone(),
        is_presentation_active: session.is_presentation_active,
        is_results_visible: session.is_results_visible,
    };
    publish_state_update(&session_id, &state_payload).await;

    Ok(Json(ApiResponse::success(session)))
}

/// Helper function to verify session ownership
async fn verify_session_ownership(
    pool: &crate::db::DbPool,
    session_id: &str,
    user_id: &str,
) -> Result<()> {
    let exists: Option<bool> = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ? AND creator_id = ?)"
    )
    .bind(session_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    match exists {
        Some(true) => Ok(()),
        _ => Err(AppError::Auth("Unauthorized access to session".to_string())),
    }
}
