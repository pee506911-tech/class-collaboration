use std::collections::HashSet;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use sqlx::{query, query_as, query_scalar, MySql, QueryBuilder, Transaction};
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::middleware::auth::AuthUser;
use crate::models::response::ApiResponse;
use crate::models::slide::{CreateSlideRequest, ReorderSlidesRequest, Slide, UpdateSlideRequest};

const ORDER_STEP: i32 = 1024;
const CLIENT_REQUEST_ID_HEADER: &str = "x-client-request-id";
const MAX_SLIDE_CREATE_DEADLOCK_RETRIES: u32 = 3;
const MAX_SLIDE_UPDATE_DEADLOCK_RETRIES: u32 = 3;

/// Get all slides for a session
pub async fn get_slides(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(session_id): Path<String>,
) -> Result<Json<ApiResponse<Vec<Slide>>>> {
    let pool = app_state.db_pool.pool().await?;
    verify_session_ownership(&pool, &session_id, &user_id).await?;

    let slides = query_as::<_, Slide>(
        "SELECT id, session_id, type, content, order_index, is_hidden FROM slides WHERE session_id = ? ORDER BY order_index ASC, id ASC",
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
    let CreateSlideRequest {
        slide_type,
        content,
        insert_after_slide_id,
        client_request_id,
    } = payload;

    let mut retry_count = 0;
    loop {
        let attempt: Result<Slide> = async {
            let mut tx = pool.begin().await?;
            lock_owned_session(&mut tx, &session_id, &user_id).await?;

            if let Some(client_request_id) = client_request_id.as_deref() {
                if let Some(existing_slide) =
                    find_slide_by_client_request_id(&mut tx, &session_id, client_request_id)
                        .await?
                {
                    tx.commit().await?;
                    return Ok(existing_slide);
                }
            }

            let id = Uuid::new_v4().to_string();
            let order_index = match insert_after_slide_id.as_deref() {
                Some(insert_after_slide_id) => {
                    allocate_order_after(&mut tx, &session_id, insert_after_slide_id).await?
                }
                None => get_append_order_index(&mut tx, &session_id).await?,
            };

            query(
                "INSERT INTO slides (id, session_id, type, content, order_index, client_request_id) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(&session_id)
            .bind(&slide_type)
            .bind(sqlx::types::Json(&content))
            .bind(order_index)
            .bind(&client_request_id)
            .execute(&mut *tx)
            .await?;

            tx.commit().await?;

            Ok(Slide {
                id,
                session_id: session_id.clone(),
                slide_type: slide_type.clone(),
                content: sqlx::types::Json(content.clone()),
                order_index,
                is_hidden: false,
            })
        }
        .await;

        match attempt {
            Ok(slide) => return Ok(Json(ApiResponse::success(slide))),
            Err(e) => {
                if is_app_error_transient_slide_create(&e)
                    && retry_count < MAX_SLIDE_CREATE_DEADLOCK_RETRIES
                {
                    retry_count += 1;
                    tracing::warn!(
                        "Slide create contention, retrying ({}/{})",
                        retry_count,
                        MAX_SLIDE_CREATE_DEADLOCK_RETRIES
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(50 * retry_count as u64))
                        .await;
                    continue;
                }

                if is_app_error_mysql_duplicate_key(&e) {
                    if let Some(client_request_id) = client_request_id.as_deref() {
                        if let Some(existing_slide) =
                            fetch_slide_by_client_request_id(&pool, &session_id, client_request_id)
                                .await?
                        {
                            return Ok(Json(ApiResponse::success(existing_slide)));
                        }
                    }

                    return Err(AppError::Input(
                        "A slide with this client request id already exists".to_string(),
                    ));
                }

                return Err(AppError::Internal(format!("Failed to create slide: {}", e)));
            }
        }
    }
}

async fn find_slide_by_client_request_id(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    client_request_id: &str,
) -> Result<Option<Slide>> {
    let slide = query_as::<_, Slide>(
        "SELECT id, session_id, type, content, order_index, is_hidden FROM slides WHERE session_id = ? AND client_request_id = ? LIMIT 1",
    )
    .bind(session_id)
    .bind(client_request_id)
    .fetch_optional(&mut **tx)
    .await?;

    Ok(slide)
}

fn is_mysql_duplicate_key(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Database(db_err) => {
            db_err.message().contains("Duplicate entry")
                || db_err.code().as_deref() == Some("23000")
                || db_err.code().as_deref() == Some("1062")
        }
        _ => false,
    }
}

fn is_app_error_mysql_duplicate_key(e: &AppError) -> bool {
    match e {
        AppError::Database(sqlx_err) => is_mysql_duplicate_key(sqlx_err),
        _ => false,
    }
}

fn is_deadlock_error(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Database(db_err) => {
            db_err.code().as_deref() == Some("40001")
                || db_err.code().as_deref() == Some("1205")
                || db_err.message().contains("Deadlock found")
                || db_err.message().contains("Lock wait timeout exceeded")
        }
        _ => false,
    }
}

fn is_app_error_transient_slide_create(e: &AppError) -> bool {
    match e {
        AppError::Database(sqlx_err) => is_deadlock_error(sqlx_err),
        _ => false,
    }
}

fn is_app_error_transient_slide_update(e: &AppError) -> bool {
    match e {
        AppError::Database(sqlx_err) => is_deadlock_error(sqlx_err),
        _ => false,
    }
}

async fn fetch_slide_by_client_request_id(
    pool: &crate::db::DbPool,
    session_id: &str,
    client_request_id: &str,
) -> Result<Option<Slide>> {
    let slide = query_as::<_, Slide>(
        "SELECT id, session_id, type, content, order_index, is_hidden FROM slides WHERE session_id = ? AND client_request_id = ? LIMIT 1",
    )
    .bind(session_id)
    .bind(client_request_id)
    .fetch_optional(pool)
    .await?;

    Ok(slide)
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

    let mut retry_count = 0;
    loop {
        let attempt: Result<Slide> = async {
            let mut tx = pool.begin().await?;
            lock_owned_session(&mut tx, &session_id, &user_id).await?;

            let existing_slide: Slide = query_as::<_, Slide>(
                "SELECT id, session_id, type, content, order_index, is_hidden FROM slides WHERE id = ? AND session_id = ?",
            )
            .bind(&slide_id)
            .bind(&session_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| AppError::NotFound("Slide not found".to_string()))?;

            let mut updated_slide = existing_slide.clone();
            let mut has_changes = false;
            let mut updated_slide_type = None;
            let mut updated_content = None;

            if let Some(slide_type) = payload.slide_type.as_ref() {
                if updated_slide.slide_type != *slide_type {
                    updated_slide.slide_type = slide_type.clone();
                    updated_slide_type = Some(slide_type.clone());
                    has_changes = true;
                }
            }

            if let Some(content) = payload.content.as_ref() {
                let content_json = sqlx::types::Json(content.clone());
                if updated_slide.content != content_json {
                    updated_slide.content = content_json;
                    updated_content = Some(content.clone());
                    has_changes = true;
                }
            }

            if !has_changes {
                tx.commit().await?;
                return Ok(existing_slide);
            }

            let mut qb = QueryBuilder::<MySql>::new("UPDATE slides SET ");
            let mut has_assignment = false;
            if let Some(slide_type) = updated_slide_type.as_ref() {
                if has_assignment {
                    qb.push(", ");
                }
                qb.push("type = ");
                qb.push_bind(slide_type);
                has_assignment = true;
            }
            if let Some(content) = updated_content.as_ref() {
                if has_assignment {
                    qb.push(", ");
                }
                qb.push("content = ");
                qb.push_bind(sqlx::types::Json(content));
            }
            qb.push(" WHERE id = ");
            qb.push_bind(&slide_id);
            qb.push(" AND session_id = ");
            qb.push_bind(&session_id);
            qb.build().execute(&mut *tx).await?;

            tx.commit().await?;
            Ok(updated_slide)
        }
        .await;

        match attempt {
            Ok(slide) => return Ok(Json(ApiResponse::success(slide))),
            Err(e) => {
                if is_app_error_transient_slide_update(&e)
                    && retry_count < MAX_SLIDE_UPDATE_DEADLOCK_RETRIES
                {
                    retry_count += 1;
                    tracing::warn!(
                        "Slide update contention, retrying ({}/{})",
                        retry_count,
                        MAX_SLIDE_UPDATE_DEADLOCK_RETRIES
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(50 * retry_count as u64))
                        .await;
                    continue;
                }

                return match e {
                    AppError::NotFound(_) | AppError::Auth(_) | AppError::Input(_) => Err(e),
                    _ => Err(AppError::Internal(format!("Failed to update slide: {}", e))),
                };
            }
        }
    }
}

/// Delete a slide
pub async fn delete_slide(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    headers: HeaderMap,
    Path((session_id, slide_id)): Path<(String, String)>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    let pool = app_state.db_pool.pool().await?;
    let mut tx = pool.begin().await?;
    lock_owned_session(&mut tx, &session_id, &user_id).await?;
    let client_request_id = headers
        .get(CLIENT_REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    if let Some(client_request_id) = client_request_id.as_deref() {
        if let Some(existing_slide_id) =
            find_slide_delete_by_client_request_id(&mut tx, &session_id, client_request_id).await?
        {
            if existing_slide_id != slide_id {
                return Err(AppError::Input(
                    "Delete request id already used for a different slide".to_string(),
                ));
            }

            tx.commit().await?;
            return Ok(Json(ApiResponse::success(
                serde_json::json!({ "message": "Slide deleted successfully" }),
            )));
        }
    }

    let delete_result = query("DELETE FROM slides WHERE id = ? AND session_id = ?")
        .bind(&slide_id)
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;

    if delete_result.rows_affected() == 0 {
        return Err(AppError::NotFound("Slide not found".to_string()));
    }

    if let Some(client_request_id) = client_request_id.as_deref() {
        query(
            "INSERT INTO slide_delete_requests (session_id, client_request_id, slide_id) VALUES (?, ?, ?)",
        )
        .bind(&session_id)
        .bind(client_request_id)
        .bind(&slide_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    Ok(Json(ApiResponse::success(
        serde_json::json!({ "message": "Slide deleted successfully" }),
    )))
}

async fn find_slide_delete_by_client_request_id(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    client_request_id: &str,
) -> Result<Option<String>> {
    let slide_id = query_scalar::<_, String>(
        "SELECT slide_id FROM slide_delete_requests WHERE session_id = ? AND client_request_id = ? LIMIT 1",
    )
    .bind(session_id)
    .bind(client_request_id)
    .fetch_optional(&mut **tx)
    .await?;

    Ok(slide_id)
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

    // Lock only the session row (single-row lock), not all slides.
    // Validate that all requested slide IDs belong to this session using a
    // non-locking read. The session-level lock from lock_owned_session provides
    // isolation for this session's data.
    let session_slide_ids = query_scalar::<_, String>(
        "SELECT id FROM slides WHERE session_id = ? ORDER BY order_index ASC, id ASC",
    )
    .bind(&session_id)
    .fetch_all(&mut *tx)
    .await?;

    validate_reorder_payload(&session_slide_ids, &payload.slide_ids)?;

    if session_slide_ids == payload.slide_ids {
        tx.commit().await?;
        return Ok(Json(ApiResponse::success(
            serde_json::json!({ "message": "Slides reordered successfully" }),
        )));
    }

    let changed_slide_ids = collect_changed_slide_ids(&session_slide_ids, &payload.slide_ids);
    let temporary_assignments = build_temporary_order_assignments(&changed_slide_ids);
    let final_assignments = build_final_order_assignments(&session_slide_ids, &payload.slide_ids);

    apply_order_assignments(&mut tx, &session_id, &temporary_assignments).await?;
    apply_order_assignments(&mut tx, &session_id, &final_assignments).await?;

    // Bump state_version to signal slide order change to real-time clients
    sqlx::query("UPDATE sessions SET state_version = state_version + 1 WHERE id = ?")
        .bind(&session_id)
        .execute(&mut *tx)
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

async fn get_append_order_index(tx: &mut Transaction<'_, MySql>, session_id: &str) -> Result<i32> {
    let max_order_index =
        query_scalar::<_, Option<i32>>("SELECT MAX(order_index) FROM slides WHERE session_id = ?")
            .bind(session_id)
            .fetch_one(&mut **tx)
            .await?;

    Ok(compute_append_order_index(max_order_index))
}

async fn allocate_order_after(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    insert_after_slide_id: &str,
) -> Result<i32> {
    let mut insert_after_order_index =
        query_scalar::<_, i32>("SELECT order_index FROM slides WHERE id = ? AND session_id = ?")
            .bind(insert_after_slide_id)
            .bind(session_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| AppError::Input("Insert-after slide not found".to_string()))?;

    let mut next_order_index =
        get_next_order_index(tx, session_id, insert_after_order_index).await?;

    if let Some(order_index) =
        calculate_insert_order_index(insert_after_order_index, next_order_index)
    {
        return Ok(order_index);
    }

    rebalance_slide_orders(tx, session_id).await?;

    insert_after_order_index =
        query_scalar::<_, i32>("SELECT order_index FROM slides WHERE id = ? AND session_id = ?")
            .bind(insert_after_slide_id)
            .bind(session_id)
            .fetch_one(&mut **tx)
            .await?;

    next_order_index = get_next_order_index(tx, session_id, insert_after_order_index).await?;

    calculate_insert_order_index(insert_after_order_index, next_order_index)
        .ok_or_else(|| AppError::Input("Unable to allocate slide order".to_string()))
}

async fn get_next_order_index(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    insert_after_order_index: i32,
) -> Result<Option<i32>> {
    let next_order_index = query_scalar::<_, i32>(
        "SELECT order_index FROM slides WHERE session_id = ? AND order_index > ? ORDER BY order_index ASC LIMIT 1"
    )
    .bind(session_id)
    .bind(insert_after_order_index)
    .fetch_optional(&mut **tx)
    .await?;

    Ok(next_order_index)
}

fn calculate_insert_order_index(
    insert_after_order_index: i32,
    next_order_index: Option<i32>,
) -> Option<i32> {
    match next_order_index {
        Some(next_order_index) => {
            let gap = next_order_index - insert_after_order_index;
            if gap > 1 {
                Some(insert_after_order_index + (gap / 2))
            } else {
                None
            }
        }
        None => Some(insert_after_order_index.saturating_add(ORDER_STEP)),
    }
}

fn compute_append_order_index(max_order_index: Option<i32>) -> i32 {
    max_order_index
        .map(|value| value.saturating_add(ORDER_STEP))
        .unwrap_or(0)
}

async fn rebalance_slide_orders(tx: &mut Transaction<'_, MySql>, session_id: &str) -> Result<()> {
    let slide_ids = query_scalar::<_, String>(
        "SELECT id FROM slides WHERE session_id = ? ORDER BY order_index ASC, id ASC",
    )
    .bind(session_id)
    .fetch_all(&mut **tx)
    .await?;

    if slide_ids.is_empty() {
        return Ok(());
    }

    let temporary_assignments = build_temporary_order_assignments(&slide_ids);
    let final_assignments = build_dense_order_assignments(&slide_ids);

    apply_order_assignments(tx, session_id, &temporary_assignments).await?;
    apply_order_assignments(tx, session_id, &final_assignments).await?;

    Ok(())
}

fn collect_changed_slide_ids(
    session_slide_ids: &[String],
    requested_slide_ids: &[String],
) -> Vec<String> {
    requested_slide_ids
        .iter()
        .enumerate()
        .filter(|(index, slide_id)| session_slide_ids.get(*index) != Some(*slide_id))
        .map(|(_, slide_id)| slide_id.clone())
        .collect()
}

fn build_temporary_order_assignments(slide_ids: &[String]) -> Vec<(String, i32)> {
    slide_ids
        .iter()
        .enumerate()
        .map(|(index, slide_id)| (slide_id.clone(), -(((index as i32) + 1) * ORDER_STEP)))
        .collect()
}

fn build_dense_order_assignments(slide_ids: &[String]) -> Vec<(String, i32)> {
    slide_ids
        .iter()
        .enumerate()
        .map(|(index, slide_id)| (slide_id.clone(), (index as i32) * ORDER_STEP))
        .collect()
}

fn build_final_order_assignments(
    session_slide_ids: &[String],
    requested_slide_ids: &[String],
) -> Vec<(String, i32)> {
    requested_slide_ids
        .iter()
        .enumerate()
        .filter(|(index, slide_id)| session_slide_ids.get(*index) != Some(*slide_id))
        .map(|(index, slide_id)| (slide_id.clone(), (index as i32) * ORDER_STEP))
        .collect()
}

async fn apply_order_assignments(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    assignments: &[(String, i32)],
) -> Result<()> {
    if assignments.is_empty() {
        return Ok(());
    }

    let mut qb = QueryBuilder::<MySql>::new("UPDATE slides SET order_index = CASE id ");
    for (slide_id, order_index) in assignments {
        qb.push("WHEN ");
        qb.push_bind(slide_id);
        qb.push(" THEN ");
        qb.push_bind(order_index);
        qb.push(" ");
    }
    qb.push("ELSE order_index END WHERE session_id = ");
    qb.push_bind(session_id);
    qb.push(" AND id IN (");
    let mut separated = qb.separated(", ");
    for (slide_id, _) in assignments {
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
            "insertAfterSlideId": "slide-123",
            "clientRequestId": "req-123"
        }))
        .expect("payload should deserialize");

        assert_eq!(payload.slide_type, "static");
        assert_eq!(payload.insert_after_slide_id.as_deref(), Some("slide-123"));
        assert_eq!(payload.client_request_id.as_deref(), Some("req-123"));
    }

    #[test]
    fn calculate_insert_order_index_uses_midpoint_when_gap_exists() {
        assert_eq!(calculate_insert_order_index(1024, Some(2048)), Some(1536));
    }

    #[test]
    fn calculate_insert_order_index_requests_rebalance_when_gap_is_exhausted() {
        assert_eq!(calculate_insert_order_index(1024, Some(1025)), None);
    }

    #[test]
    fn calculate_insert_order_index_appends_with_step_when_no_next_slide_exists() {
        assert_eq!(calculate_insert_order_index(2048, None), Some(3072));
    }

    #[test]
    fn compute_append_order_index_returns_zero_for_empty_session() {
        assert_eq!(compute_append_order_index(None), 0);
    }

    #[test]
    fn collect_changed_slide_ids_returns_only_rows_that_move() {
        let session_slide_ids = vec![
            "a".to_string(),
            "b".to_string(),
            "c".to_string(),
            "d".to_string(),
        ];
        let requested_slide_ids = vec![
            "a".to_string(),
            "c".to_string(),
            "b".to_string(),
            "d".to_string(),
        ];

        assert_eq!(
            collect_changed_slide_ids(&session_slide_ids, &requested_slide_ids),
            vec!["c".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn build_final_order_assignments_targets_only_changed_rows() {
        let session_slide_ids = vec![
            "a".to_string(),
            "b".to_string(),
            "c".to_string(),
            "d".to_string(),
        ];
        let requested_slide_ids = vec![
            "a".to_string(),
            "c".to_string(),
            "b".to_string(),
            "d".to_string(),
        ];

        assert_eq!(
            build_final_order_assignments(&session_slide_ids, &requested_slide_ids),
            vec![
                ("c".to_string(), ORDER_STEP),
                ("b".to_string(), ORDER_STEP * 2)
            ]
        );
    }

    #[test]
    fn build_dense_order_assignments_preserves_dense_spacing() {
        assert_eq!(
            build_dense_order_assignments(&["x".to_string(), "y".to_string()]),
            vec![("x".to_string(), 0), ("y".to_string(), ORDER_STEP)]
        );
    }
}
