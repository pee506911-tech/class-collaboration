use axum::{extract::{State, Path}, Json};
use sqlx::query_as;

use crate::error::Result;
use crate::models::response::ApiResponse;
use crate::models::session::{PublicSessionResponse, SessionState};
use crate::models::slide::Slide;

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

/// Get slides for a session (public endpoint - no auth required)
/// Used by the mobile clicker which can be shared without login
pub async fn get_public_slides(
    State(app_state): State<crate::AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<ApiResponse<Vec<Slide>>>> {
    let slides = query_as::<_, Slide>(
        "SELECT * FROM slides WHERE session_id = ? ORDER BY order_index ASC"
    )
    .bind(&session_id)
    .fetch_all(&app_state.db_pool)
    .await?;

    Ok(Json(ApiResponse::success(slides)))
}
