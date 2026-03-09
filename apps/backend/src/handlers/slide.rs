use std::collections::HashSet;

use axum::{
    extract::{Path, State},
    Json,
};
use sqlx::{query, query_as, query_scalar, MySql, Transaction};
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::middleware::auth::AuthUser;
use crate::models::response::ApiResponse;
use crate::models::slide::{CreateSlideRequest, ReorderSlidesRequest, Slide, UpdateSlideRequest};

/// Get all slides for a session
pub async fn get_slides(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(session_id): Path<String>,
) -> Result<Json<ApiResponse<Vec<Slide>>>> {
    let pool = app_state.db_pool.pool().await?;
    verify_session_ownership(&pool, &session_id, &user_id).await?;

    let slides = query_as::<_, Slide>(
        "SELECT * FROM slides WHERE session_id = ? ORDER BY order_index ASC, id ASC",
    )
    .bind(&session_id)
    .fetch_all(&pool)
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
    let pool = app_state.db_pool.pool().await?;
    let mut tx = pool.begin().await?;
    lock_owned_session(&mut tx, &session_id, &user_id).await?;

    let id = Uuid::new_v4().to_string();
    let order_index = match payload.insert_after_slide_id.as_deref() {
        Some(insert_after_slide_id) => {
            let insert_after_order_index = query_scalar::<_, i32>(
                "SELECT order_index FROM slides WHERE id = ? AND session_id = ? FOR UPDATE",
            )
            .bind(insert_after_slide_id)
            .bind(&session_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| AppError::Input("Insert-after slide not found".to_string()))?;

            shift_slide_orders_up_from(&mut tx, &session_id, insert_after_order_index + 1).await?;
            insert_after_order_index + 1
        }
        None => {
            let max_order_index = query_scalar::<_, i32>(
                "SELECT order_index FROM slides WHERE session_id = ? ORDER BY order_index DESC LIMIT 1 FOR UPDATE"
            )
            .bind(&session_id)
            .fetch_optional(&mut *tx)
            .await?;

            max_order_index.unwrap_or(-1) + 1
        }
    };

    query("INSERT INTO slides (id, session_id, type, content, order_index) VALUES (?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&session_id)
        .bind(&payload.slide_type)
        .bind(sqlx::types::Json(&payload.content))
        .bind(order_index)
        .execute(&mut *tx)
        .await?;

    let slide = query_as::<_, Slide>("SELECT * FROM slides WHERE id = ?")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(Json(ApiResponse::success(slide)))
}

/// Update an existing slide
pub async fn update_slide(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path((session_id, slide_id)): Path<(String, String)>,
    Json(payload): Json<UpdateSlideRequest>,
) -> Result<Json<ApiResponse<Slide>>> {
    let pool = app_state.db_pool.pool().await?;
    verify_session_ownership(&pool, &session_id, &user_id).await?;

    let _slide: Slide = query_as("SELECT * FROM slides WHERE id = ? AND session_id = ?")
        .bind(&slide_id)
        .bind(&session_id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Slide not found".to_string()))?;

    if let Some(slide_type) = payload.slide_type {
        query("UPDATE slides SET type = ? WHERE id = ?")
            .bind(&slide_type)
            .bind(&slide_id)
            .execute(&pool)
            .await?;
    }

    if let Some(content) = payload.content {
        query("UPDATE slides SET content = ? WHERE id = ?")
            .bind(sqlx::types::Json(&content))
            .bind(&slide_id)
            .execute(&pool)
            .await?;
    }

    let updated_slide = query_as::<_, Slide>("SELECT * FROM slides WHERE id = ?")
        .bind(&slide_id)
        .fetch_one(&pool)
        .await?;

    Ok(Json(ApiResponse::success(updated_slide)))
}

/// Delete a slide
pub async fn delete_slide(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path((session_id, slide_id)): Path<(String, String)>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    let pool = app_state.db_pool.pool().await?;
    let mut tx = pool.begin().await?;
    lock_owned_session(&mut tx, &session_id, &user_id).await?;

    let deleted_order_index = query_scalar::<_, i32>(
        "SELECT order_index FROM slides WHERE id = ? AND session_id = ? FOR UPDATE",
    )
    .bind(&slide_id)
    .bind(&session_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("Slide not found".to_string()))?;

    query("DELETE FROM slides WHERE id = ? AND session_id = ?")
        .bind(&slide_id)
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;

    close_slide_order_gap(&mut tx, &session_id, deleted_order_index).await?;
    tx.commit().await?;

    Ok(Json(ApiResponse::success(
        serde_json::json!({ "message": "Slide deleted successfully" }),
    )))
}

/// Reorder slides
pub async fn reorder_slides(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(session_id): Path<String>,
    Json(payload): Json<ReorderSlidesRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    let pool = app_state.db_pool.pool().await?;
    let mut tx = pool.begin().await?;
    lock_owned_session(&mut tx, &session_id, &user_id).await?;

    if payload.slide_ids.is_empty() {
        return Err(AppError::Input("No slides to reorder".to_string()));
    }

    let session_slide_ids =
        query_scalar::<_, String>("SELECT id FROM slides WHERE session_id = ? FOR UPDATE")
            .bind(&session_id)
            .fetch_all(&mut *tx)
            .await?;

    validate_reorder_payload(&session_slide_ids, &payload.slide_ids)?;
    apply_order_mapping(&mut tx, &session_id, &payload.slide_ids, |index| {
        -((index as i32) + 1)
    })
    .await?;
    apply_order_mapping(&mut tx, &session_id, &payload.slide_ids, |index| {
        index as i32
    })
    .await?;
    tx.commit().await?;

    Ok(Json(ApiResponse::success(
        serde_json::json!({ "message": "Slides reordered successfully" }),
    )))
}

async fn lock_owned_session(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    user_id: &str,
) -> Result<()> {
    let exists = query_scalar::<_, String>(
        "SELECT id FROM sessions WHERE id = ? AND creator_id = ? FOR UPDATE",
    )
    .bind(session_id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;

    match exists {
        Some(_) => Ok(()),
        None => Err(AppError::Auth("Unauthorized access to session".to_string())),
    }
}

async fn shift_slide_orders_up_from(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    starting_at: i32,
) -> Result<()> {
    query(
        "UPDATE slides SET order_index = -order_index - 1 WHERE session_id = ? AND order_index >= ?"
    )
    .bind(session_id)
    .bind(starting_at)
    .execute(&mut **tx)
    .await?;

    query("UPDATE slides SET order_index = -order_index WHERE session_id = ? AND order_index <= ?")
        .bind(session_id)
        .bind(-(starting_at + 1))
        .execute(&mut **tx)
        .await?;

    Ok(())
}

async fn close_slide_order_gap(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    deleted_order_index: i32,
) -> Result<()> {
    query("UPDATE slides SET order_index = -order_index WHERE session_id = ? AND order_index > ?")
        .bind(session_id)
        .bind(deleted_order_index)
        .execute(&mut **tx)
        .await?;

    query(
        "UPDATE slides SET order_index = -order_index - 1 WHERE session_id = ? AND order_index <= ?"
    )
    .bind(session_id)
    .bind(-(deleted_order_index + 1))
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn apply_order_mapping(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    slide_ids: &[String],
    map_index: impl Fn(usize) -> i32,
) -> Result<()> {
    let mut qb = sqlx::QueryBuilder::<MySql>::new("UPDATE slides SET order_index = CASE id ");
    for (index, slide_id) in slide_ids.iter().enumerate() {
        qb.push("WHEN ");
        qb.push_bind(slide_id);
        qb.push(" THEN ");
        qb.push_bind(map_index(index));
        qb.push(" ");
    }
    qb.push("ELSE order_index END WHERE session_id = ");
    qb.push_bind(session_id);
    qb.push(" AND id IN (");
    let mut separated = qb.separated(", ");
    for slide_id in slide_ids {
        separated.push_bind(slide_id);
    }
    drop(separated);
    qb.push(")");

    qb.build().execute(&mut **tx).await?;
    Ok(())
}

fn validate_reorder_payload(
    session_slide_ids: &[String],
    requested_slide_ids: &[String],
) -> Result<()> {
    if session_slide_ids.len() != requested_slide_ids.len() {
        return Err(AppError::Input(
            "Reorder request must include every slide exactly once".to_string(),
        ));
    }

    let mut seen_ids = HashSet::with_capacity(requested_slide_ids.len());
    for slide_id in requested_slide_ids {
        if !seen_ids.insert(slide_id) {
            return Err(AppError::Input(
                "Reorder request contains duplicate slide IDs".to_string(),
            ));
        }
    }

    let session_slide_id_set: HashSet<&str> =
        session_slide_ids.iter().map(String::as_str).collect();
    if requested_slide_ids
        .iter()
        .any(|slide_id| !session_slide_id_set.contains(slide_id.as_str()))
    {
        return Err(AppError::Input(
            "Reorder request contains slides that do not belong to this session".to_string(),
        ));
    }

    Ok(())
}

/// Helper function to verify session ownership
async fn verify_session_ownership(
    pool: &crate::db::DbPool,
    session_id: &str,
    user_id: &str,
) -> Result<()> {
    let exists: Option<bool> =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ? AND creator_id = ?)")
            .bind(session_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;

    match exists {
        Some(true) => Ok(()),
        _ => Err(AppError::Auth("Unauthorized access to session".to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_reorder_payload_rejects_duplicate_ids() {
        let session_slide_ids = vec!["a".to_string(), "b".to_string()];
        let requested_slide_ids = vec!["a".to_string(), "a".to_string()];

        let result = validate_reorder_payload(&session_slide_ids, &requested_slide_ids);

        assert!(matches!(result, Err(AppError::Input(message)) if message.contains("duplicate")));
    }

    #[test]
    fn validate_reorder_payload_rejects_missing_session_slides() {
        let session_slide_ids = vec!["a".to_string(), "b".to_string()];
        let requested_slide_ids = vec!["a".to_string()];

        let result = validate_reorder_payload(&session_slide_ids, &requested_slide_ids);

        assert!(matches!(result, Err(AppError::Input(message)) if message.contains("every slide")));
    }

    #[test]
    fn create_slide_request_supports_insert_after_slide_id() {
        let payload = serde_json::from_value::<CreateSlideRequest>(serde_json::json!({
            "type": "static",
            "content": { "title": "Copy" },
            "insertAfterSlideId": "slide-123"
        }))
        .expect("payload should deserialize");

        assert_eq!(payload.slide_type, "static");
        assert_eq!(payload.insert_after_slide_id.as_deref(), Some("slide-123"));
    }
}
