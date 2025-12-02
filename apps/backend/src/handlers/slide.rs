use axum::{extract::{State, Path}, Json};
use sqlx::{query_as, query};
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::models::slide::{Slide, CreateSlideRequest, UpdateSlideRequest, ReorderSlidesRequest};
use crate::models::response::ApiResponse;
use crate::middleware::auth::AuthUser;

/// Get all slides for a session
pub async fn get_slides(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(session_id): Path<String>,
) -> Result<Json<ApiResponse<Vec<Slide>>>> {
    // Verify user owns the session
    verify_session_ownership(&app_state.db_pool, &session_id, &user_id).await?;

    let slides = query_as::<_, Slide>(
        "SELECT * FROM slides WHERE session_id = ? ORDER BY order_index ASC"
    )
    .bind(&session_id)
    .fetch_all(&app_state.db_pool)
    .await?;

    Ok(Json(ApiResponse::success(slides)))
}

/// Create a new slide
pub async fn create_slide(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(session_id): Path<String>,
    Json(payload): Json<CreateSlideRequest>,
) -> Result<Json<ApiResponse<Slide>>> {
    // Verify user owns the session
    verify_session_ownership(&app_state.db_pool, &session_id, &user_id).await?;

    let id = Uuid::new_v4().to_string();

    // Get max order_index
    let max_order: Option<i32> = sqlx::query_scalar(
        "SELECT COALESCE(MAX(order_index), -1) FROM slides WHERE session_id = ?"
    )
    .bind(&session_id)
    .fetch_one(&app_state.db_pool)
    .await?;

    let order_index = max_order.unwrap_or(-1) + 1;

    query(
        "INSERT INTO slides (id, session_id, type, content, order_index) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(&session_id)
    .bind(&payload.slide_type)
    .bind(sqlx::types::Json(&payload.content))
    .bind(order_index)
    .execute(&app_state.db_pool)
    .await?;

    let slide = query_as::<_, Slide>("SELECT * FROM slides WHERE id = ?")
        .bind(&id)
        .fetch_one(&app_state.db_pool)
        .await?;

    Ok(Json(ApiResponse::success(slide)))
}

/// Update an existing slide
pub async fn update_slide(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path((session_id, slide_id)): Path<(String, String)>,
    Json(payload): Json<UpdateSlideRequest>,
) -> Result<Json<ApiResponse<Slide>>> {
    // Verify user owns the session
    verify_session_ownership(&app_state.db_pool, &session_id, &user_id).await?;

    // Verify slide belongs to session
    let _slide: Slide = query_as("SELECT * FROM slides WHERE id = ? AND session_id = ?")
        .bind(&slide_id)
        .bind(&session_id)
        .fetch_optional(&app_state.db_pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Slide not found".to_string()))?;

    // Update fields if provided
    if let Some(slide_type) = payload.slide_type {
        query("UPDATE slides SET type = ? WHERE id = ?")
            .bind(&slide_type)
            .bind(&slide_id)
            .execute(&app_state.db_pool)
            .await?;
    }

    if let Some(content) = payload.content {
        query("UPDATE slides SET content = ? WHERE id = ?")
            .bind(sqlx::types::Json(&content))
            .bind(&slide_id)
            .execute(&app_state.db_pool)
            .await?;
    }

    // Fetch updated slide
    let updated_slide = query_as::<_, Slide>("SELECT * FROM slides WHERE id = ?")
        .bind(&slide_id)
        .fetch_one(&app_state.db_pool)
        .await?;

    Ok(Json(ApiResponse::success(updated_slide)))
}

/// Delete a slide
pub async fn delete_slide(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path((session_id, slide_id)): Path<(String, String)>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    // Verify user owns the session
    verify_session_ownership(&app_state.db_pool, &session_id, &user_id).await?;

    let result = query("DELETE FROM slides WHERE id = ? AND session_id = ?")
        .bind(&slide_id)
        .bind(&session_id)
        .execute(&app_state.db_pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Slide not found".to_string()));
    }

    Ok(Json(ApiResponse::success(serde_json::json!({ "message": "Slide deleted successfully" }))))
}

/// Reorder slides
pub async fn reorder_slides(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(session_id): Path<String>,
    Json(payload): Json<ReorderSlidesRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    // Verify user owns the session
    verify_session_ownership(&app_state.db_pool, &session_id, &user_id).await?;

    // Update order_index for each slide
    for (index, slide_id) in payload.slide_ids.iter().enumerate() {
        query("UPDATE slides SET order_index = ? WHERE id = ? AND session_id = ?")
            .bind(index as i32)
            .bind(slide_id)
            .bind(&session_id)
            .execute(&app_state.db_pool)
            .await?;
    }

    Ok(Json(ApiResponse::success(serde_json::json!({ "message": "Slides reordered successfully" }))))
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
