use std::collections::HashSet;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::IntoResponse,
    Json,
};
use sqlx::{query_as, query_scalar, MySql, QueryBuilder, Transaction};
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::middleware::auth::AuthUser;
use crate::models::response::ApiResponse;
use crate::models::slide::{
    CreateSlideRequest, CreateSlidesBatchRequest, CreateSlidesBatchResponse, ReorderSlidesRequest,
    Slide, SyncSlidesRequest, SyncSlidesResponse, UpdateSlideRequest, UpdateSlidesBatchRequest,
    UpdateSlidesBatchResponse,
};

const ORDER_STEP: i32 = 1024;
const CLIENT_REQUEST_ID_HEADER: &str = "x-client-request-id";
const MAX_CLIENT_REQUEST_ID_LEN: usize = 64;
const MAX_BATCH_SLIDE_COUNT: usize = 50;

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

/// Broadcast a SlidesUpdate WebSocket message to all connected clients.
/// This replaces the old outbox-based enqueue pattern with direct broadcast.
pub(crate) async fn broadcast_slides_update(
    app_state: &crate::AppState,
    session_id: &str,
    slides: &[Slide],
) {
    let slides_json = serde_json::to_value(slides).expect("slides should serialize");
    crate::services::broadcast::broadcast_slides_update(
        &*app_state.registry,
        session_id,
        &slides_json,
    )
    .await;
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

async fn compute_insert_order_index(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    insert_after_slide_id: Option<&str>,
) -> Result<i32> {
    match insert_after_slide_id {
        Some(after_id) => allocate_order_after(tx, session_id, after_id).await,
        None => get_append_order_index(tx, session_id).await,
    }
}

async fn lock_session(tx: &mut Transaction<'_, MySql>, session_id: &str) -> Result<()> {
    let lock_start = std::time::Instant::now();
    let exists = query_scalar::<_, String>("SELECT id FROM sessions WHERE id = ? FOR UPDATE")
        .bind(session_id)
        .fetch_optional(&mut **tx)
        .await?;

    let lock_duration_ms = lock_start.elapsed().as_millis();
    if lock_duration_ms > 100 {
        tracing::warn!(
            session_id = %session_id,
            lock_duration_ms = %lock_duration_ms,
            "SPEED_AUDIT: lock_session wait exceeded 100ms"
        );
    }

    match exists {
        Some(_) => Ok(()),
        None => Err(AppError::NotFound("Session not found".to_string())),
    }
}

async fn load_slide(
    tx: &mut Transaction<'_, MySql>,
    slide_id: &str,
    session_id: &str,
) -> Result<Slide> {
    let slide = query_as::<_, Slide>(
        "SELECT id, session_id, type, content, order_index, is_hidden, version
         FROM slides
         WHERE id = ? AND session_id = ?",
    )
    .bind(slide_id)
    .bind(session_id)
    .fetch_optional(&mut **tx)
    .await?;

    slide.ok_or_else(|| AppError::NotFound("Slide not found".to_string()))
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

    let client_request_id =
        resolved_client_request_id(payload.client_request_id.clone(), Some(&headers))?;
    if let Some(existing_slide) = crate::services::wal::fetch_replay_response::<Slide>(
        &pool,
        &session_id,
        crate::services::wal::WalOpType::CreateSlide,
        &client_request_id,
    )
    .await?
    {
        return Ok(crate::services::wal::queued_success_response(
            &existing_slide,
        ));
    }

    let slide_id = Uuid::new_v4().to_string();
    let slide_type = payload.slide_type.clone();
    let content = payload.content.clone();
    let insert_after = payload.insert_after_slide_id.clone();

    let mut tx = pool.begin().await?;
    lock_session(&mut tx, &session_id).await?;

    let order_index =
        compute_insert_order_index(&mut tx, &session_id, insert_after.as_deref()).await?;

    sqlx::query(
        "INSERT INTO slides (id, session_id, type, content, order_index, client_request_id)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&slide_id)
    .bind(&session_id)
    .bind(&slide_type)
    .bind(sqlx::types::Json(&content))
    .bind(order_index)
    .bind(&client_request_id)
    .execute(&mut *tx)
    .await?;

    let slide = load_slide(&mut tx, &slide_id, &session_id).await?;

    sqlx::query(
        "INSERT IGNORE INTO wal_request_replays (session_id, op_type, client_request_id, response_payload)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&session_id)
    .bind(crate::services::wal::WalOpType::CreateSlide.to_string())
    .bind(&client_request_id)
    .bind(sqlx::types::Json(serde_json::to_value(&slide).expect("slide should serialize")))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    broadcast_slides_update(&app_state, &session_id, std::slice::from_ref(&slide)).await;
    app_state
        .session_service
        .invalidate_session_cache(&session_id)
        .await;

    Ok(crate::services::wal::queued_success_response(&slide))
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

    if payload.slides.is_empty() {
        return Err(AppError::Input("No slides to create".to_string()));
    }
    if payload.slides.len() > MAX_BATCH_SLIDE_COUNT {
        return Err(AppError::Input(format!(
            "Too many slides in batch (max {})",
            MAX_BATCH_SLIDE_COUNT
        )));
    }

    let client_request_id =
        resolved_client_request_id(payload.client_request_id.clone(), Some(&headers))?;
    if let Some(existing) =
        crate::services::wal::fetch_replay_response::<CreateSlidesBatchResponse>(
            &pool,
            &session_id,
            crate::services::wal::WalOpType::CreateSlidesBatch,
            &client_request_id,
        )
        .await?
    {
        return Ok(crate::services::wal::queued_success_response(&existing));
    }

    let slide_specs: Vec<_> = payload
        .slides
        .iter()
        .map(|s| {
            (
                Uuid::new_v4().to_string(),
                s.slide_type.clone(),
                s.content.clone(),
            )
        })
        .collect();

    let slide_ids: Vec<&str> = slide_specs.iter().map(|(id, _, _)| id.as_str()).collect();

    let mut tx = pool.begin().await?;
    lock_session(&mut tx, &session_id).await?;

    let mut next_order_index = get_append_order_index(&mut tx, &session_id).await?;

    // Single multi-row INSERT for all slides
    let mut qb = QueryBuilder::<MySql>::new(
        "INSERT INTO slides (id, session_id, type, content, order_index, client_request_id) "
    );
    qb.push_values(&slide_specs, |mut b, (slide_id, slide_type, content)| {
        b.push_bind(slide_id)
            .push_bind(&session_id)
            .push_bind(slide_type)
            .push_bind(sqlx::types::Json(content))
            .push_bind(next_order_index)
            .push_bind(&client_request_id);
        next_order_index = next_order_index.saturating_add(ORDER_STEP);
    });
    qb.build().execute(&mut *tx).await?;

    // Single SELECT to load all created slides
    let placeholders = slide_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "SELECT id, session_id, type, content, order_index, is_hidden, version \
         FROM slides \
         WHERE id IN ({}) AND session_id = ? \
         ORDER BY order_index",
        placeholders
    );

    let mut db_query = sqlx::query_as::<_, Slide>(&query);
    for slide_id in &slide_ids {
        db_query = db_query.bind(slide_id);
    }
    db_query = db_query.bind(&session_id);
    let created_slides: Vec<Slide> = db_query.fetch_all(&mut *tx).await?;

    sqlx::query("UPDATE sessions SET state_version = state_version + 1 WHERE id = ?")
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "INSERT IGNORE INTO wal_request_replays (session_id, op_type, client_request_id, response_payload)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&session_id)
    .bind(crate::services::wal::WalOpType::CreateSlidesBatch.to_string())
    .bind(&client_request_id)
    .bind(sqlx::types::Json(serde_json::to_value(&CreateSlidesBatchResponse {
        slides: created_slides.clone(),
        state_version: 0,
    }).expect("batch response should serialize")))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    broadcast_slides_update(&app_state, &session_id, &created_slides).await;
    app_state
        .session_service
        .invalidate_session_cache(&session_id)
        .await;

    // Use the state_version from transaction (incremented before commit)
    let state_version = query_scalar::<_, i64>("SELECT state_version FROM sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_one(&pool)
        .await?;

    Ok(crate::services::wal::queued_success_response(
        &CreateSlidesBatchResponse {
            slides: created_slides,
            state_version,
        },
    ))
}

/// Update multiple slides in a single atomic operation.
/// All updates are processed within one transaction with a single state_version bump
/// and one real-time publish for the entire batch.
/// If any slide has a version conflict, the entire batch is rolled back (409).
pub async fn update_slides_batch(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(payload): Json<UpdateSlidesBatchRequest>,
) -> Result<impl IntoResponse> {
    let pool = app_state.db_pool.pool_fast_fail().await?;
    verify_session_ownership(&pool, &session_id, &user_id).await?;

    if payload.updates.is_empty() {
        return Err(AppError::Input("No slides to update".to_string()));
    }
    if payload.updates.len() > MAX_BATCH_SLIDE_COUNT {
        return Err(AppError::Input(format!(
            "Too many slides in batch (max {})",
            MAX_BATCH_SLIDE_COUNT
        )));
    }

    let client_request_id =
        resolved_client_request_id(payload.client_request_id.clone(), Some(&headers))?;
    if let Some(existing) =
        crate::services::wal::fetch_replay_response::<UpdateSlidesBatchResponse>(
            &pool,
            &session_id,
            crate::services::wal::WalOpType::UpdateSlidesBatch,
            &client_request_id,
        )
        .await?
    {
        return Ok(crate::services::wal::queued_success_response(&existing));
    }

    // Pre-load all existing slides with a single bulk SELECT
    let slide_ids_to_update: Vec<&str> = payload.updates.iter().map(|u| u.slide_id.as_str()).collect();
    let placeholders = slide_ids_to_update
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "SELECT id, session_id, type, content, order_index, is_hidden, version \
         FROM slides \
         WHERE id IN ({}) AND session_id = ?",
        placeholders
    );

    let mut db_query = sqlx::query_as::<_, Slide>(&query);
    for slide_id in &slide_ids_to_update {
        db_query = db_query.bind(slide_id);
    }
    db_query = db_query.bind(&session_id);
    let existing_slides: Vec<Slide> = db_query.fetch_all(&pool).await?;

    if existing_slides.len() != payload.updates.len() {
        // Some slides not found - find which ones
        let found_ids: std::collections::HashSet<_> =
            existing_slides.iter().map(|s| &s.id).collect();
        for update in &payload.updates {
            if !found_ids.contains(&update.slide_id) {
                return Err(AppError::NotFound(format!(
                    "Slide {} not found",
                    update.slide_id
                )));
            }
        }
    }

    let existing_slides_map: std::collections::HashMap<String, Slide> =
        existing_slides.into_iter().map(|s| (s.id.clone(), s)).collect();

    // Validate versions before starting transaction
    for update in &payload.updates {
        let slide = existing_slides_map.get(&update.slide_id).unwrap();
        if let Some(base_version) = update.base_version {
            if base_version != slide.version {
                return Err(build_slide_version_conflict(
                    &update.slide_id,
                    slide.version,
                ));
            }
        }
    }

    let mut tx = pool.begin().await?;
    lock_session(&mut tx, &session_id).await?;

    // Bulk UPDATE all slides
    for update in &payload.updates {
        let expected_version = existing_slides_map
            .get(&update.slide_id)
            .map(|s| s.version)
            .unwrap_or(0);

        let result = sqlx::query(
            "UPDATE slides SET content = ?, version = version + 1 \
             WHERE id = ? AND session_id = ? AND version = ?",
        )
        .bind(sqlx::types::Json(&update.content))
        .bind(&update.slide_id)
        .bind(&session_id)
        .bind(expected_version)
        .execute(&mut *tx)
        .await?;

        if result.rows_affected() == 0 {
            // This should not happen given pre-check, but guard anyway
            return Err(build_slide_version_conflict(
                &update.slide_id,
                expected_version,
            ));
        }
    }

    // Single SELECT to load all updated slides
    let placeholders = slide_ids_to_update
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "SELECT id, session_id, type, content, order_index, is_hidden, version \
         FROM slides \
         WHERE id IN ({}) AND session_id = ? \
         ORDER BY order_index",
        placeholders
    );

    let mut db_query = sqlx::query_as::<_, Slide>(&query);
    for slide_id in &slide_ids_to_update {
        db_query = db_query.bind(slide_id);
    }
    db_query = db_query.bind(&session_id);
    let updated_slides: Vec<Slide> = db_query.fetch_all(&mut *tx).await?;

    sqlx::query("UPDATE sessions SET state_version = state_version + 1 WHERE id = ?")
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "INSERT IGNORE INTO wal_request_replays (session_id, op_type, client_request_id, response_payload)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&session_id)
    .bind(crate::services::wal::WalOpType::UpdateSlidesBatch.to_string())
    .bind(&client_request_id)
    .bind(sqlx::types::Json(
        serde_json::to_value(&UpdateSlidesBatchResponse {
            slides: updated_slides.clone(),
            state_version: 0,
        })
        .expect("batch response should serialize"),
    ))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    broadcast_slides_update(&app_state, &session_id, &updated_slides).await;
    app_state
        .session_service
        .invalidate_session_cache(&session_id)
        .await;

    let state_version = query_scalar::<_, i64>("SELECT state_version FROM sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_one(&pool)
        .await?;

    Ok(crate::services::wal::queued_success_response(
        &UpdateSlidesBatchResponse {
            slides: updated_slides,
            state_version,
        },
    ))
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
        return Ok(crate::services::wal::queued_success_response(&existing));
    }

    let existing_slide = query_as::<_, Slide>(
        "SELECT id, session_id, type, content, order_index, is_hidden, version FROM slides WHERE id = ? AND session_id = ?",
    )
    .bind(&slide_id)
    .bind(&session_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Slide not found".to_string()))?;

    if let Some(base_version) = payload.base_version {
        if base_version != existing_slide.version {
            return Err(build_slide_version_conflict(
                &slide_id,
                existing_slide.version,
            ));
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
        return Ok(Json(ApiResponse::success(existing_slide)));
    }

    let expected_version = payload.base_version.unwrap_or(existing_slide.version);

    let mut tx = pool.begin().await?;

    let result = sqlx::query(
        "UPDATE slides SET type = ?, content = ?, version = version + 1
         WHERE id = ? AND session_id = ? AND version = ?",
    )
    .bind(&updated_slide.slide_type)
    .bind(&updated_slide.content)
    .bind(&slide_id)
    .bind(&session_id)
    .bind(expected_version)
    .execute(&mut *tx)
    .await?;

    if result.rows_affected() == 0 {
        // Version mismatch — the slide changed between our pre-check and this UPDATE.
        let current_version =
            query_scalar::<_, i64>("SELECT version FROM slides WHERE id = ? AND session_id = ?")
                .bind(&slide_id)
                .bind(&session_id)
                .fetch_optional(&mut *tx)
                .await?
                .unwrap_or(expected_version);

        return Err(build_slide_version_conflict(&slide_id, current_version));
    }

    let slide = load_slide(&mut tx, &slide_id, &session_id).await?;

    sqlx::query(
        "INSERT IGNORE INTO wal_request_replays (session_id, op_type, client_request_id, response_payload)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&session_id)
    .bind(crate::services::wal::WalOpType::UpdateSlide.to_string())
    .bind(&client_request_id)
    .bind(sqlx::types::Json(serde_json::to_value(&slide).expect("slide should serialize")))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    broadcast_slides_update(&app_state, &session_id, std::slice::from_ref(&slide)).await;
    app_state
        .session_service
        .invalidate_session_cache(&session_id)
        .await;

    Ok(crate::services::wal::queued_success_response(&slide))
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
        return Ok(crate::services::wal::queued_success_response(&existing));
    }

    let mut tx = pool.begin().await?;
    lock_session(&mut tx, &session_id).await?;

    let deleted = sqlx::query("DELETE FROM slides WHERE id = ? AND session_id = ?")
        .bind(&slide_id)
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;

    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound("Slide not found".to_string()));
    }

    sqlx::query(
        "INSERT IGNORE INTO slide_delete_requests (session_id, client_request_id, slide_id)
         VALUES (?, ?, ?)",
    )
    .bind(&session_id)
    .bind(&client_request_id)
    .bind(&slide_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT IGNORE INTO wal_request_replays (session_id, op_type, client_request_id, response_payload)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&session_id)
    .bind(crate::services::wal::WalOpType::DeleteSlide.to_string())
    .bind(&client_request_id)
    .bind(sqlx::types::Json(&response))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    broadcast_slides_update(&app_state, &session_id, &[]).await;
    app_state
        .session_service
        .invalidate_session_cache(&session_id)
        .await;

    Ok(crate::services::wal::queued_success_response(&response))
}

/// Reorder slides by setting new order_index values
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
        return Ok(crate::services::wal::queued_success_response(&existing));
    }

    if payload.slide_ids.is_empty() {
        return Err(AppError::Input("No slides to reorder".to_string()));
    }

    let mut tx = pool.begin().await?;
    lock_session(&mut tx, &session_id).await?;

    let session_slide_ids = query_scalar::<_, String>(
        "SELECT id FROM slides WHERE session_id = ? ORDER BY order_index ASC, id ASC",
    )
    .bind(&session_id)
    .fetch_all(&mut *tx)
    .await?;

    validate_reorder_payload(&session_slide_ids, &payload.slide_ids)?;

    if session_slide_ids != payload.slide_ids {
        let changed_slide_ids = collect_changed_slide_ids(&session_slide_ids, &payload.slide_ids);
        let temporary_assignments = build_temporary_order_assignments(&changed_slide_ids);
        let final_assignments =
            build_final_order_assignments(&session_slide_ids, &payload.slide_ids);

        apply_order_assignments(&mut tx, &session_id, &temporary_assignments).await?;
        apply_order_assignments(&mut tx, &session_id, &final_assignments).await?;
    }

    sqlx::query("UPDATE sessions SET state_version = state_version + 1 WHERE id = ?")
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "INSERT IGNORE INTO wal_request_replays (session_id, op_type, client_request_id, response_payload)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&session_id)
    .bind(crate::services::wal::WalOpType::ReorderSlides.to_string())
    .bind(&client_request_id)
    .bind(sqlx::types::Json(&response))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    broadcast_slides_update(&app_state, &session_id, &[]).await;
    app_state
        .session_service
        .invalidate_session_cache(&session_id)
        .await;

    Ok(crate::services::wal::queued_success_response(&response))
}

/// Synchronize the entire slide collection in a single request.
///
/// The client sends the complete desired slide list. The server:
/// - Creates new slides (entries with `id = None`)
/// - Updates existing slides (content, type, isHidden)
/// - Deletes slides not present in the desired list
/// - Sets order_index based on array position
/// - Returns the final complete slide list
///
/// All operations happen in a single transaction with one WS broadcast.
pub async fn sync_slides(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(payload): Json<SyncSlidesRequest>,
) -> Result<impl IntoResponse> {
    let pool = app_state.db_pool.pool_fast_fail().await?;
    verify_session_ownership(&pool, &session_id, &user_id).await?;

    let client_request_id =
        resolved_client_request_id(payload.client_request_id.clone(), Some(&headers))?;
    if let Some(existing) =
        crate::services::wal::fetch_replay_response::<SyncSlidesResponse>(
            &pool,
            &session_id,
            crate::services::wal::WalOpType::SyncSlides,
            &client_request_id,
        )
        .await?
    {
        return Ok(crate::services::wal::queued_success_response(&existing));
    }

    if payload.slides.is_empty() {
        // Deleting all slides is valid — proceed with empty list
    }
    if payload.slides.len() > MAX_BATCH_SLIDE_COUNT {
        return Err(AppError::Input(format!(
            "Too many slides in sync (max {})",
            MAX_BATCH_SLIDE_COUNT
        )));
    }

    let mut tx = pool.begin().await?;
    lock_session(&mut tx, &session_id).await?;

    // Load all existing slides
    let existing_slides: Vec<Slide> = query_as::<_, Slide>(
        "SELECT id, session_id, type, content, order_index, is_hidden, version \
         FROM slides WHERE session_id = ? ORDER BY order_index ASC, id ASC",
    )
    .bind(&session_id)
    .fetch_all(&mut *tx)
    .await?;

    let existing_slide_map: std::collections::HashMap<String, Slide> =
        existing_slides.into_iter().map(|s| (s.id.clone(), s)).collect();

    // Check base versions if provided
    if let Some(ref base_versions) = payload.base_versions {
        for (slide_id, expected_version) in base_versions {
            if let Some(slide) = existing_slide_map.get(slide_id) {
                if slide.version != *expected_version {
                    return Err(build_slide_version_conflict(slide_id, slide.version));
                }
            }
            // If slide doesn't exist on server but client sent a base_version,
            // that means client thinks it exists — this is a stale state, reject.
        }
    }

    // Collect desired slide IDs (only the ones with existing server IDs)
    let desired_ids: std::collections::HashSet<String> = payload
        .slides
        .iter()
        .filter_map(|e| e.id.clone())
        .filter(|id| !id.starts_with("temp-"))
        .collect();

    // Determine which slides to delete (exist on server but not in desired list)
    let slides_to_delete: Vec<&String> = existing_slide_map
        .keys()
        .filter(|id| !desired_ids.contains(*id))
        .collect();

    // DELETE slides not in desired set
    if !slides_to_delete.is_empty() {
        let placeholders = slides_to_delete
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let query = format!("DELETE FROM slides WHERE session_id = ? AND id IN ({})", placeholders);
        let mut db_query = sqlx::query(&query).bind(&session_id);
        for id in &slides_to_delete {
            db_query = db_query.bind(*id);
        }
        db_query.execute(&mut *tx).await?;
    }

    // Process each desired slide entry — first assign temporary negative
    // order indices to avoid unique constraint collisions, then set final values.
    // This mirrors the two-phase approach used in reorder_slides.

    // Phase 1: assign temporary negative order indices to all existing slides
    // that will be updated, so their final positions are free.
    let mut temp_order = -ORDER_STEP;
    for entry in &payload.slides {
        if let Some(id) = &entry.id {
            if existing_slide_map.contains_key(id.as_str()) {
                sqlx::query(
                    "UPDATE slides SET order_index = ? WHERE id = ? AND session_id = ?",
                )
                .bind(temp_order)
                .bind(id)
                .bind(&session_id)
                .execute(&mut *tx)
                .await?;
                temp_order -= ORDER_STEP;
            }
        }
    }

    // Phase 2: set final order indices and create/update slides
    let mut order_index = 0i32;
    let mut created_ids: Vec<String> = Vec::new();

    for entry in &payload.slides {
        match &entry.id {
            None => {
                // New slide — INSERT
                let slide_id = Uuid::new_v4().to_string();
                sqlx::query(
                    "INSERT INTO slides (id, session_id, type, content, order_index) VALUES (?, ?, ?, ?, ?)",
                )
                .bind(&slide_id)
                .bind(&session_id)
                .bind(&entry.slide_type)
                .bind(sqlx::types::Json(&entry.content))
                .bind(order_index)
                .execute(&mut *tx)
                .await?;
                created_ids.push(slide_id);
            }
            Some(id) => {
                // Existing or new slide — UPDATE or INSERT with final order_index
                if existing_slide_map.contains_key(id.as_str()) {
                    let result = sqlx::query(
                        "UPDATE slides SET type = ?, content = ?, is_hidden = ?, order_index = ? \
                         WHERE id = ? AND session_id = ?",
                    )
                    .bind(&entry.slide_type)
                    .bind(sqlx::types::Json(&entry.content))
                    .bind(entry.is_hidden)
                    .bind(order_index)
                    .bind(id)
                    .bind(&session_id)
                    .execute(&mut *tx)
                    .await?;

                    if result.rows_affected() == 0 {
                        return Err(AppError::NotFound(format!(
                            "Slide {} not found in session",
                            id
                        )));
                    }
                } else {
                    // Slide doesn't exist on server but client thinks it does — treat as new
                    let slide_id = Uuid::new_v4().to_string();
                    sqlx::query(
                        "INSERT INTO slides (id, session_id, type, content, order_index) VALUES (?, ?, ?, ?, ?)",
                    )
                    .bind(&slide_id)
                    .bind(&session_id)
                    .bind(&entry.slide_type)
                    .bind(sqlx::types::Json(&entry.content))
                    .bind(order_index)
                    .execute(&mut *tx)
                    .await?;
                    created_ids.push(slide_id);
                }
            }
        }
        order_index += ORDER_STEP;
    }

    // Bump state_version once
    sqlx::query("UPDATE sessions SET state_version = state_version + 1 WHERE id = ?")
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;

    // Load all final slides
    let final_slides: Vec<Slide> = query_as::<_, Slide>(
        "SELECT id, session_id, type, content, order_index, is_hidden, version \
         FROM slides WHERE session_id = ? ORDER BY order_index ASC, id ASC",
    )
    .bind(&session_id)
    .fetch_all(&mut *tx)
    .await?;

    let state_version = query_scalar::<_, i64>("SELECT state_version FROM sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_one(&mut *tx)
        .await?;

    // WAL replay for idempotency
    sqlx::query(
        "INSERT IGNORE INTO wal_request_replays (session_id, op_type, client_request_id, response_payload)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&session_id)
    .bind(crate::services::wal::WalOpType::SyncSlides.to_string())
    .bind(&client_request_id)
    .bind(sqlx::types::Json(
        serde_json::to_value(&SyncSlidesResponse {
            slides: final_slides.clone(),
            state_version,
        })
        .expect("sync response should serialize"),
    ))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // One WS broadcast with the full slide list
    broadcast_slides_update(&app_state, &session_id, &final_slides).await;
    app_state
        .session_service
        .invalidate_session_cache(&session_id)
        .await;

    Ok(crate::services::wal::queued_success_response(
        &SyncSlidesResponse {
            slides: final_slides,
            state_version,
        },
    ))
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
        headers.insert(
            "x-client-request-id",
            HeaderValue::from_static("  req-123  "),
        );
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
        headers.insert("x-client-request-id", HeaderValue::from_static("   "));
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
}
