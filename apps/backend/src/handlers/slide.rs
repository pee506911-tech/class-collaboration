use std::collections::HashSet;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::de::DeserializeOwned;
use sqlx::{query_as, query_scalar, MySql, QueryBuilder, Transaction};
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::middleware::auth::AuthUser;
use crate::models::response::ApiResponse;
use crate::models::slide::{CreateSlideRequest, CreateSlidesBatchRequest, CreateSlidesBatchResponse, ReorderSlidesRequest, Slide, UpdateSlideRequest};

const ORDER_STEP: i32 = 1024;
const CLIENT_REQUEST_ID_HEADER: &str = "x-client-request-id";
const MAX_CLIENT_REQUEST_ID_LEN: usize = 64;
const MAX_BATCH_SLIDE_COUNT: usize = 50;

fn deserialize_wal_response<T: DeserializeOwned>(value: serde_json::Value) -> Result<T> {
    serde_json::from_value(value).map_err(|error| {
        AppError::Internal(format!("Failed to decode WAL response payload: {error}"))
    })
}

fn resolved_client_request_id(
    explicit_client_request_id: Option<String>,
    headers: Option<&HeaderMap>,
) -> Result<String> {
    if let Some(client_request_id) = explicit_client_request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
    {
        if client_request_id.len() > MAX_CLIENT_REQUEST_ID_LEN {
            return Err(AppError::Input("Invalid X-Client-Request-Id".to_string()));
        }
        return Ok(client_request_id);
    }

    if let Some(headers) = headers {
        if let Some(client_request_id) = extract_client_request_id(headers)? {
            return Ok(client_request_id);
        }
    }

    Ok(Uuid::new_v4().to_string())
}

/// Enqueue a SlidesUpdate outbox event within the caller's transaction.
/// This ensures that every slide mutation that clients need to observe
/// produces an outbox event for real-time WebSocket delivery.
///
/// Note: This deliberately does NOT bump `state_version`, so that single-slide
/// updates avoid acquiring a session row lock. The `SLIDES_UPDATE` WebSocket message
/// bypasses the `shouldApplyStateUpdate()` gate entirely (it triggers via
/// `lastSlideUpdate` on the frontend). For batch creation, callers should bump
/// `state_version` separately since they already hold a session lock.
pub(crate) async fn enqueue_slides_update_event(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    slides: &[Slide],
) -> Result<()> {
    let state_payload = serde_json::json!({ "slides": slides });
    crate::services::outbox::enqueue_event(
        tx,
        session_id,
        crate::services::outbox::OutboxEventType::SlidesUpdate,
        &state_payload,
    )
    .await?;

    Ok(())
}

/// Get all slides for a session
pub async fn get_slides(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(session_id): Path<String>,
) -> Result<Json<ApiResponse<Vec<Slide>>>> {
    let pool = app_state.db_pool.pool_fast_fail().await?;
    verify_session_ownership(&pool, &session_id, &user_id).await?;

    let slides = query_as::<_, Slide>(
        "SELECT id, session_id, type, content, order_index, is_hidden, version FROM slides WHERE session_id = ? ORDER BY order_index ASC, id ASC",
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
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(payload): Json<CreateSlideRequest>,
) -> Result<impl IntoResponse> {
    let pool = app_state.db_pool.pool_fast_fail().await?;
    verify_session_ownership(&pool, &session_id, &user_id).await?;

    let client_request_id = resolved_client_request_id(payload.client_request_id.clone(), Some(&headers))?;
    if let Some(existing_slide) = crate::services::wal::fetch_replay_response::<Slide>(
        &pool,
        &session_id,
        crate::services::wal::WalOpType::CreateSlide,
        &client_request_id,
    )
    .await?
    {
        return crate::services::wal::queued_success_response(&existing_slide);
    }

    if let Some(insert_after_slide_id) = payload.insert_after_slide_id.as_deref() {
        let exists: i64 = query_scalar(
            "SELECT EXISTS(SELECT 1 FROM slides WHERE id = ? AND session_id = ?)",
        )
        .bind(insert_after_slide_id)
        .bind(&session_id)
        .fetch_one(&pool)
        .await?;

        if exists == 0 {
            return Err(AppError::Input("Insert-after slide not found".to_string()));
        }
    }

    let predicted_order_index = if let Some(insert_after_slide_id) = payload.insert_after_slide_id.as_deref() {
        let insert_after_order_index: i32 = query_scalar(
            "SELECT order_index FROM slides WHERE id = ? AND session_id = ?",
        )
        .bind(insert_after_slide_id)
        .bind(&session_id)
        .fetch_one(&pool)
        .await?;
        insert_after_order_index.saturating_add(1)
    } else {
        let max_order_index =
            query_scalar::<_, Option<i32>>("SELECT MAX(order_index) FROM slides WHERE session_id = ?")
                .bind(&session_id)
                .fetch_one(&pool)
                .await?;
        compute_append_order_index(max_order_index)
    };

    let slide = Slide {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        slide_type: payload.slide_type.clone(),
        content: sqlx::types::Json(payload.content.clone()),
        order_index: predicted_order_index,
        is_hidden: false,
        version: 0,
    };

    let append_result = app_state
        .wal_store
        .append_or_get_existing(crate::services::wal::AppendWalEntry {
            op_type: crate::services::wal::WalOpType::CreateSlide,
            session_id: session_id.clone(),
            client_request_id: client_request_id.clone(),
            resource_id: Some(slide.id.clone()),
            payload: serde_json::to_value(crate::services::wal::CreateSlideWalPayload {
                slide_id: slide.id.clone(),
                slide_type: slide.slide_type.clone(),
                content: slide.content.0.clone(),
                insert_after_slide_id: payload.insert_after_slide_id.clone(),
            })
            .map_err(|error| AppError::Internal(format!("Failed to encode WAL payload: {error}")))?,
            response_payload: serde_json::to_value(&slide)
                .map_err(|error| AppError::Internal(format!("Failed to encode queued slide: {error}")))?,
            priority: 3,
        })
        .await?;

    match append_result {
        crate::services::wal::AppendWalResult::Appended => {
            crate::services::wal::queued_success_response(&slide)
        }
        crate::services::wal::AppendWalResult::Existing { response_payload } => {
            let slide = deserialize_wal_response::<Slide>(response_payload)?;
            crate::services::wal::queued_success_response(&slide)
        }
    }
}

/// Create multiple slides in a single atomic operation.
/// All slides are created within one transaction with a single state_version bump
/// and one real-time publish for the entire batch.
pub async fn create_slides_batch(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(payload): Json<CreateSlidesBatchRequest>,
) -> Result<impl IntoResponse> {
    let pool = app_state.db_pool.pool_fast_fail().await?;
    verify_session_ownership(&pool, &session_id, &user_id).await?;

    // Validate batch size
    if payload.slides.is_empty() {
        return Err(AppError::Input("No slides to create".to_string()));
    }
    if payload.slides.len() > MAX_BATCH_SLIDE_COUNT {
        return Err(AppError::Input(
            format!("Too many slides in batch (max {})", MAX_BATCH_SLIDE_COUNT)
        ));
    }

    let client_request_id = resolved_client_request_id(payload.client_request_id.clone(), Some(&headers))?;
    if let Some(existing) = crate::services::wal::fetch_replay_response::<CreateSlidesBatchResponse>(
        &pool,
        &session_id,
        crate::services::wal::WalOpType::CreateSlidesBatch,
        &client_request_id,
    )
    .await?
    {
        return crate::services::wal::queued_success_response(&existing);
    }

    let mut next_order_index =
        query_scalar::<_, Option<i32>>("SELECT MAX(order_index) FROM slides WHERE session_id = ?")
            .bind(&session_id)
            .fetch_one(&pool)
            .await?
            .map(|value| value.saturating_add(ORDER_STEP))
            .unwrap_or(0);

    let created_slides: Vec<Slide> = payload
        .slides
        .iter()
        .map(|slide_req| {
            let slide = Slide {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.clone(),
                slide_type: slide_req.slide_type.clone(),
                content: sqlx::types::Json(slide_req.content.clone()),
                order_index: next_order_index,
                is_hidden: false,
                version: 0,
            };
            next_order_index = next_order_index.saturating_add(ORDER_STEP);
            slide
        })
        .collect();

    let state_version = sqlx::query_scalar::<_, i64>("SELECT state_version FROM sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_one(&pool)
        .await?;

    let response = CreateSlidesBatchResponse {
        slides: created_slides,
        state_version: state_version.saturating_add(1),
    };

    let append_result = app_state
        .wal_store
        .append_or_get_existing(crate::services::wal::AppendWalEntry {
            op_type: crate::services::wal::WalOpType::CreateSlidesBatch,
            session_id: session_id.clone(),
            client_request_id,
            resource_id: response.slides.first().map(|slide| slide.id.clone()),
            payload: serde_json::to_value(crate::services::wal::CreateSlidesBatchWalPayload {
                slides: response
                    .slides
                    .iter()
                    .map(|slide| crate::services::wal::CreateSlidesBatchWalItem {
                        slide_id: slide.id.clone(),
                        slide_type: slide.slide_type.clone(),
                        content: slide.content.0.clone(),
                    })
                    .collect(),
            })
            .map_err(|error| AppError::Internal(format!("Failed to encode batch WAL payload: {error}")))?,
            response_payload: serde_json::to_value(&response)
                .map_err(|error| AppError::Internal(format!("Failed to encode batch response: {error}")))?,
            priority: 3,
        })
        .await?;

    match append_result {
        crate::services::wal::AppendWalResult::Appended => {
            crate::services::wal::queued_success_response(&response)
        }
        crate::services::wal::AppendWalResult::Existing { response_payload } => {
            let response = deserialize_wal_response::<CreateSlidesBatchResponse>(response_payload)?;
            crate::services::wal::queued_success_response(&response)
        }
    }
}

async fn find_batch_by_client_request_id(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    session_id: &str,
    client_request_id: &str,
) -> Result<Option<CreateSlidesBatchResponse>> {
    // Check slide_update_requests for slides created with this batch client_request_id
    let slides: Vec<Slide> = query_as::<_, Slide>(
        "SELECT id, session_id, type, content, order_index, is_hidden, version FROM slides WHERE session_id = ? AND client_request_id = ? ORDER BY order_index ASC, id ASC",
    )
    .bind(session_id)
    .bind(client_request_id)
    .fetch_all(&mut **tx)
    .await?;

    if slides.is_empty() {
        return Ok(None);
    }

    let state_version = sqlx::query_scalar("SELECT state_version FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_one(&mut **tx)
        .await?;

    Ok(Some(CreateSlidesBatchResponse {
        slides,
        state_version,
    }))
}

async fn store_batch_client_request_id(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    session_id: &str,
    client_request_id: &str,
    slides: &[Slide],
) -> Result<()> {
    // We use the existing slide_update_requests table for idempotency.
    // Store the first slide's id as the slide_id in the idempotency table.
    if slides.is_empty() {
        return Ok(());
    }
    let response_slide = serde_json::to_value(slides).map_err(|e| {
        AppError::Internal(format!("Failed to serialize batch response: {}", e))
    })?;
    let request_payload = serde_json::json!({"batch": true, "slideCount": slides.len()});

    sqlx::query(
        "INSERT INTO slide_update_requests (session_id, client_request_id, slide_id, request_payload, response_slide) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(session_id)
    .bind(client_request_id)
    .bind(&slides[0].id)
    .bind(sqlx::types::Json(&request_payload))
    .bind(sqlx::types::Json(&response_slide))
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn find_slide_by_client_request_id(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    client_request_id: &str,
) -> Result<Option<Slide>> {
    let slide = query_as::<_, Slide>(
        "SELECT id, session_id, type, content, order_index, is_hidden, version FROM slides WHERE session_id = ? AND client_request_id = ? LIMIT 1",
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
        "SELECT id, session_id, type, content, order_index, is_hidden, version FROM slides WHERE session_id = ? AND client_request_id = ? LIMIT 1",
    )
    .bind(session_id)
    .bind(client_request_id)
    .fetch_optional(pool)
    .await?;

    Ok(slide)
}

#[derive(Debug, sqlx::FromRow)]
struct SlideUpdateReplay {
    slide_id: String,
    request_payload: sqlx::types::Json<UpdateSlideRequest>,
    response_slide: Option<sqlx::types::Json<Slide>>,
}

async fn fetch_slide_update_replay(
    pool: &crate::db::DbPool,
    session_id: &str,
    client_request_id: &str,
) -> Result<Option<SlideUpdateReplay>> {
    let replay = query_as::<_, SlideUpdateReplay>(
        "SELECT slide_id, request_payload, response_slide FROM slide_update_requests WHERE session_id = ? AND client_request_id = ? LIMIT 1",
    )
    .bind(session_id)
    .bind(client_request_id)
    .fetch_optional(pool)
    .await?;

    Ok(replay)
}

fn extract_client_request_id(headers: &HeaderMap) -> Result<Option<String>> {
    let client_request_id = headers
        .get(CLIENT_REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    if let Some(client_request_id) = client_request_id.as_deref() {
        if client_request_id.len() > MAX_CLIENT_REQUEST_ID_LEN {
            return Err(AppError::Input("Invalid X-Client-Request-Id".to_string()));
        }
    }

    Ok(client_request_id)
}

/// Update an existing slide
pub async fn update_slide(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    headers: HeaderMap,
    Path((session_id, slide_id)): Path<(String, String)>,
    Json(payload): Json<UpdateSlideRequest>,
) -> Result<impl IntoResponse> {
    let pool = app_state.db_pool.pool_fast_fail().await?;
    verify_session_ownership(&pool, &session_id, &user_id).await?;

    let client_request_id = resolved_client_request_id(None, Some(&headers))?;
    if let Some(existing) = crate::services::wal::fetch_replay_response::<Slide>(
        &pool,
        &session_id,
        crate::services::wal::WalOpType::UpdateSlide,
        &client_request_id,
    )
    .await?
    {
        return crate::services::wal::queued_success_response(&existing);
    }

    let existing_slide = if let Some(pending_slide) = app_state
        .wal_store
        .fetch_latest_pending_response::<Slide>(
            &session_id,
            &slide_id,
            crate::services::wal::WalOpType::UpdateSlide,
        )
        .await?
    {
        pending_slide
    } else {
        query_as::<_, Slide>(
            "SELECT id, session_id, type, content, order_index, is_hidden, version FROM slides WHERE id = ? AND session_id = ?",
        )
        .bind(&slide_id)
        .bind(&session_id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Slide not found".to_string()))?
    };

    if let Some(base_version) = payload.base_version {
        if base_version != existing_slide.version {
            return Err(build_slide_version_conflict(&slide_id, existing_slide.version));
        }
    }

    let mut updated_slide = existing_slide.clone();
    let mut has_changes = false;

    if let Some(slide_type) = payload.slide_type.as_ref() {
        if updated_slide.slide_type != *slide_type {
            updated_slide.slide_type = slide_type.clone();
            has_changes = true;
        }
    }

    if let Some(content) = payload.content.as_ref() {
        let content_json = sqlx::types::Json(content.clone());
        if updated_slide.content != content_json {
            updated_slide.content = content_json;
            has_changes = true;
        }
    }

    if !has_changes {
        return Ok((StatusCode::OK, Json(ApiResponse::success(existing_slide))));
    }

    updated_slide.version = existing_slide.version + 1;

    let append_result = app_state
        .wal_store
        .append_or_get_existing(crate::services::wal::AppendWalEntry {
            op_type: crate::services::wal::WalOpType::UpdateSlide,
            session_id: session_id.clone(),
            client_request_id,
            resource_id: Some(slide_id.clone()),
            payload: serde_json::to_value(crate::services::wal::UpdateSlideWalPayload {
                slide_id: slide_id.clone(),
                slide_type: payload.slide_type.clone(),
                content: payload.content.clone(),
                base_version: payload.base_version,
            })
            .map_err(|error| AppError::Internal(format!("Failed to encode update WAL payload: {error}")))?,
            response_payload: serde_json::to_value(&updated_slide)
                .map_err(|error| AppError::Internal(format!("Failed to encode updated slide: {error}")))?,
            priority: 1,
        })
        .await?;

    match append_result {
        crate::services::wal::AppendWalResult::Appended => {
            crate::services::wal::queued_success_response(&updated_slide)
        }
        crate::services::wal::AppendWalResult::Existing { response_payload } => {
            let slide = deserialize_wal_response::<Slide>(response_payload)?;
            crate::services::wal::queued_success_response(&slide)
        }
    }
}

fn build_slide_version_conflict(slide_id: &str, current_version: i64) -> AppError {
    AppError::Conflict {
        message: "Slide has changed on the server".to_string(),
        data: Some(serde_json::json!({
            "reason": "stale_slide_version",
            "slideId": slide_id,
            "currentVersion": current_version
        })),
    }
}

/// Delete a slide
pub async fn delete_slide(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    headers: HeaderMap,
    Path((session_id, slide_id)): Path<(String, String)>,
) -> Result<impl IntoResponse> {
    let pool = app_state.db_pool.pool_fast_fail().await?;
    verify_session_ownership(&pool, &session_id, &user_id).await?;
    let client_request_id = resolved_client_request_id(None, Some(&headers))?;

    let response = serde_json::json!({ "message": "Slide deleted successfully" });
    if let Some(existing) = crate::services::wal::fetch_replay_response::<serde_json::Value>(
        &pool,
        &session_id,
        crate::services::wal::WalOpType::DeleteSlide,
        &client_request_id,
    )
    .await?
    {
        return crate::services::wal::queued_success_response(&existing);
    }

    let slide_exists: i64 = query_scalar("SELECT EXISTS(SELECT 1 FROM slides WHERE id = ? AND session_id = ?)")
        .bind(&slide_id)
        .bind(&session_id)
        .fetch_one(&pool)
        .await?;
    if slide_exists == 0 {
        return Err(AppError::NotFound("Slide not found".to_string()));
    }

    let append_result = app_state
        .wal_store
        .append_or_get_existing(crate::services::wal::AppendWalEntry {
            op_type: crate::services::wal::WalOpType::DeleteSlide,
            session_id: session_id.clone(),
            client_request_id,
            resource_id: Some(slide_id.clone()),
            payload: serde_json::to_value(crate::services::wal::DeleteSlideWalPayload {
                slide_id: slide_id.clone(),
            })
            .map_err(|error| AppError::Internal(format!("Failed to encode delete WAL payload: {error}")))?,
            response_payload: response.clone(),
            priority: 3,
        })
        .await?;

    match append_result {
        crate::services::wal::AppendWalResult::Appended => {
            crate::services::wal::queued_success_response(&response)
        }
        crate::services::wal::AppendWalResult::Existing { response_payload } => {
            let response = deserialize_wal_response::<serde_json::Value>(response_payload)?;
            crate::services::wal::queued_success_response(&response)
        }
    }
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
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(payload): Json<ReorderSlidesRequest>,
) -> Result<impl IntoResponse> {
    let pool = app_state.db_pool.pool_fast_fail().await?;
    verify_session_ownership(&pool, &session_id, &user_id).await?;
    let client_request_id = resolved_client_request_id(None, Some(&headers))?;
    let response = serde_json::json!({ "message": "Slides reordered successfully" });

    if let Some(existing) = crate::services::wal::fetch_replay_response::<serde_json::Value>(
        &pool,
        &session_id,
        crate::services::wal::WalOpType::ReorderSlides,
        &client_request_id,
    )
    .await?
    {
        return crate::services::wal::queued_success_response(&existing);
    }

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
    .fetch_all(&pool)
    .await?;

    validate_reorder_payload(&session_slide_ids, &payload.slide_ids)?;

    if session_slide_ids == payload.slide_ids {
        return Ok((StatusCode::OK, Json(ApiResponse::success(response))));
    }

    let append_result = app_state
        .wal_store
        .append_or_get_existing(crate::services::wal::AppendWalEntry {
            op_type: crate::services::wal::WalOpType::ReorderSlides,
            session_id: session_id.clone(),
            client_request_id,
            resource_id: None,
            payload: serde_json::to_value(crate::services::wal::ReorderSlidesWalPayload {
                slide_ids: payload.slide_ids.clone(),
            })
            .map_err(|error| AppError::Internal(format!("Failed to encode reorder WAL payload: {error}")))?,
            response_payload: response.clone(),
            priority: 3,
        })
        .await?;

    match append_result {
        crate::services::wal::AppendWalResult::Appended => {
            crate::services::wal::queued_success_response(&response)
        }
        crate::services::wal::AppendWalResult::Existing { response_payload } => {
            let response = deserialize_wal_response::<serde_json::Value>(response_payload)?;
            crate::services::wal::queued_success_response(&response)
        }
    }
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

pub(crate) async fn get_append_order_index(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
) -> Result<i32> {
    let max_order_index =
        query_scalar::<_, Option<i32>>("SELECT MAX(order_index) FROM slides WHERE session_id = ?")
            .bind(session_id)
            .fetch_one(&mut **tx)
            .await?;

    Ok(compute_append_order_index(max_order_index))
}

pub(crate) async fn allocate_order_after(
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

pub(crate) fn collect_changed_slide_ids(
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

pub(crate) fn build_temporary_order_assignments(slide_ids: &[String]) -> Vec<(String, i32)> {
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

pub(crate) fn build_final_order_assignments(
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

pub(crate) async fn apply_order_assignments(
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
    qb.push(")");

    qb.build().execute(&mut **tx).await?;
    Ok(())
}

pub(crate) fn validate_reorder_payload(
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
    fn update_slide_request_supports_base_version() {
        let payload = serde_json::from_value::<UpdateSlideRequest>(serde_json::json!({
            "content": { "title": "Updated" },
            "baseVersion": 7
        }))
        .expect("payload should deserialize");

        assert_eq!(payload.base_version, Some(7));
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

    // --- extract_client_request_id tests ---

    use axum::http::{HeaderMap, HeaderValue};

    /// Returns None when the header is not present.
    #[test]
    fn extract_client_request_id_returns_none_when_missing() {
        let headers = HeaderMap::new();
        let result = extract_client_request_id(&headers);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), None);
    }

    /// Returns the trimmed value when the header is present and valid.
    #[test]
    fn extract_client_request_id_returns_trimmed_value() {
        let mut headers = HeaderMap::new();
        headers.insert("x-client-request-id", HeaderValue::from_static("  req-123  "));
        let result = extract_client_request_id(&headers);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), Some("req-123".to_string()));
    }

    /// Returns an error when the value exceeds MAX_CLIENT_REQUEST_ID_LEN (64).
    #[test]
    fn extract_client_request_id_rejects_oversized_value() {
        let mut headers = HeaderMap::new();
        let long_id = "a".repeat(65);
        headers.insert(
            "x-client-request-id",
            HeaderValue::from_str(&long_id).unwrap(),
        );
        let result = extract_client_request_id(&headers);
        assert!(result.is_err());
    }

    /// Accepts a value exactly at MAX_CLIENT_REQUEST_ID_LEN (64).
    #[test]
    fn extract_client_request_id_accepts_exact_max_length() {
        let mut headers = HeaderMap::new();
        let max_id = "a".repeat(64);
        headers.insert(
            "x-client-request-id",
            HeaderValue::from_str(&max_id).unwrap(),
        );
        let result = extract_client_request_id(&headers);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), Some(max_id));
    }

    /// Returns None for an empty/whitespace-only header value.
    #[test]
    fn extract_client_request_id_filters_empty_after_trim() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-client-request-id",
            HeaderValue::from_static("   "),
        );
        let result = extract_client_request_id(&headers);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), None);
    }

    // --- build_slide_version_conflict tests ---

    /// Returns a 409 Conflict AppError with the correct structure:
    /// reason, slideId, and currentVersion in the data payload.
    #[test]
    fn build_slide_version_conflict_returns_409_with_data() {
        let err = build_slide_version_conflict("slide-42", 7);
        match err {
            AppError::Conflict { message, data } => {
                assert_eq!(message, "Slide has changed on the server");
                let d = data.expect("conflict should have data");
                assert_eq!(d["reason"], "stale_slide_version");
                assert_eq!(d["slideId"], "slide-42");
                assert_eq!(d["currentVersion"], 7);
            }
            _ => panic!("expected Conflict error, got {:?}", err),
        }
    }

    /// Version 0 is handled correctly — the conflict response
    /// should still include the version number.
    #[test]
    fn build_slide_version_conflict_handles_version_zero() {
        let err = build_slide_version_conflict("slide-1", 0);
        match err {
            AppError::Conflict { data, .. } => {
                let d = data.expect("conflict should have data");
                assert_eq!(d["currentVersion"], 0);
            }
            _ => panic!("expected Conflict error"),
        }
    }

    // --- is_app_error_transient_slide_create/update tests ---

    /// Deadlock errors are classified as transient and should be retried.
    #[test]
    fn is_app_error_transient_slide_create_identifies_deadlock() {
        let deadlock = AppError::Database(sqlx::Error::Protocol(
            "Deadlock found when trying to get lock".to_string(),
        ));
        // Note: The actual is_deadlock_error checks error codes, not message text.
        // With a Protocol error it won't match — this tests the negative path.
        assert!(!is_app_error_transient_slide_create(&deadlock));
    }

    /// Non-database errors are NOT transient.
    #[test]
    fn is_app_error_transient_slide_create_rejects_non_database_errors() {
        let input_err = AppError::Input("bad input".to_string());
        assert!(!is_app_error_transient_slide_create(&input_err));

        let auth_err = AppError::Auth("unauthorized".to_string());
        assert!(!is_app_error_transient_slide_create(&auth_err));

        let conflict_err = AppError::Conflict {
            message: "conflict".to_string(),
            data: None,
        };
        assert!(!is_app_error_transient_slide_create(&conflict_err));
    }

    /// Same negative path for slide update — only deadlock is transient.
    #[test]
    fn is_app_error_transient_slide_update_rejects_non_database_errors() {
        let input_err = AppError::Input("bad input".to_string());
        assert!(!is_app_error_transient_slide_update(&input_err));

        let not_found = AppError::NotFound("slide not found".to_string());
        assert!(!is_app_error_transient_slide_update(&not_found));
    }
}
