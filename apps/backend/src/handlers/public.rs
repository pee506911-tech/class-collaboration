use axum::{
    extract::{Path, State},
    http::{HeaderMap, HeaderValue},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use sqlx::{query_as, MySql};
use uuid::Uuid;

use crate::error::Result;
use crate::models::response::ApiResponse;
use crate::models::session::Session;
use crate::services::outbox::{self, OutboxEventType};
use crate::ws::registry::Broadcaster;

/// Cache policy for read-mostly public session metadata.
/// Allows CDN edge caching with 10-second TTL and 5-minute stale-if-error fallback.
fn cache_control_public_session() -> HeaderValue {
    HeaderValue::from_static("public, s-maxage=10, stale-if-error=300")
}

/// Cache policy for real-time session state.
/// `/state` must always reflect the latest visible session state and must not be cached by CDNs.
fn cache_control_state() -> HeaderValue {
    HeaderValue::from_static("no-store")
}

/// Get session by share token (public endpoint)
/// Returns session with slides, questions, and stats
pub async fn get_session_by_share_token(
    State(app_state): State<crate::AppState>,
    Path(token): Path<String>,
) -> Result<impl IntoResponse> {
    let response = app_state.session_service.get_public_session(&token).await?;

    Ok((
        [("Cache-Control", cache_control_public_session())],
        Json(ApiResponse::success(response)),
    ))
}

/// Get session state (for students/projector real-time sync)
/// Returns flattened state that matches frontend StateUpdatePayload
pub async fn get_session_state(
    State(app_state): State<crate::AppState>,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse> {
    let state = app_state
        .session_service
        .get_session_state(&session_id)
        .await?;

    Ok(([("Cache-Control", cache_control_state())], Json(state)))
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
pub struct StateUpdatePayload {
    current_slide_id: Option<String>,
    is_presentation_active: bool,
    is_results_visible: bool,
    state_version: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ClickerWritePathTimings {
    pool_acquire_ms: u128,
    begin_tx_ms: u128,
    validate_slide_ms: u128,
    update_session_ms: u128,
    fetch_session_ms: u128,
    enqueue_outbox_ms: u128,
    commit_ms: u128,
    post_commit_ms: u128,
}

impl ClickerWritePathTimings {
    fn total_db_path_ms(&self) -> u128 {
        self.begin_tx_ms
            + self.validate_slide_ms
            + self.update_session_ms
            + self.fetch_session_ms
            + self.enqueue_outbox_ms
            + self.commit_ms
    }
}

/// Public endpoint to set current slide (for mobile clicker)
pub async fn public_set_current_slide(
    State(app_state): State<crate::AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(payload): Json<PublicSetSlideRequest>,
) -> Result<Json<ApiResponse<StateUpdatePayload>>> {
    let request_id = resolve_public_client_request_id(&headers);
    let started_at = std::time::Instant::now();
    let requested_slide_id = payload.slide_id.clone();

    tracing::info!(
        request_id = %request_id,
        session_id = %session_id,
        requested_slide_id = ?requested_slide_id,
        "Clicker slide update requested"
    );

    let pool = app_state.db_pool.pool_fast_fail().await?;
    let pool_ready_at = std::time::Instant::now();
    let mut tx = pool.begin().await?;
    let tx_started_at = std::time::Instant::now();

    validate_target_slide_exists(&mut tx, &session_id, payload.slide_id.as_deref()).await?;
    let validated_at = std::time::Instant::now();

    let update_result = sqlx::query(
        "UPDATE sessions SET current_slide_id = ?, state_version = state_version + 1 WHERE id = ? AND NOT (current_slide_id <=> ?)"
    )
        .bind(&payload.slide_id)
        .bind(&session_id)
        .bind(&payload.slide_id)
        .execute(&mut *tx)
        .await?;
    let updated_at = std::time::Instant::now();

    let session = fetch_session(&mut *tx, &session_id).await?;
    let session_fetched_at = std::time::Instant::now();
    let should_flush_outbox = update_result.rows_affected() > 0;
    if should_flush_outbox {
        let state_payload = build_state_payload(&session);
        outbox::enqueue_event(
            &mut tx,
            &session_id,
            OutboxEventType::StateUpdate,
            &state_payload,
        )
        .await?;
    }
    let outbox_enqueued_at = std::time::Instant::now();

    tx.commit().await?;
    let committed_at = std::time::Instant::now();
    if should_flush_outbox {
        broadcast_state_update_fast_lane(
            app_state.registry.as_ref(),
            &session_id,
            &build_state_payload(&session),
        )
        .await;
        app_state.outbox_flush_notify.notify_one();
    }
    let post_commit_finished_at = std::time::Instant::now();

    let timings = ClickerWritePathTimings {
        pool_acquire_ms: pool_ready_at.duration_since(started_at).as_millis(),
        begin_tx_ms: tx_started_at.duration_since(pool_ready_at).as_millis(),
        validate_slide_ms: validated_at.duration_since(tx_started_at).as_millis(),
        update_session_ms: updated_at.duration_since(validated_at).as_millis(),
        fetch_session_ms: session_fetched_at.duration_since(updated_at).as_millis(),
        enqueue_outbox_ms: outbox_enqueued_at
            .duration_since(session_fetched_at)
            .as_millis(),
        commit_ms: committed_at.duration_since(outbox_enqueued_at).as_millis(),
        post_commit_ms: post_commit_finished_at
            .duration_since(committed_at)
            .as_millis(),
    };

    tracing::info!(
        request_id = %request_id,
        session_id = %session_id,
        requested_slide_id = ?requested_slide_id,
        applied_slide_id = ?session.current_slide_id,
        state_version = session.state_version,
        outbox_enqueued = should_flush_outbox,
        pool_acquire_ms = timings.pool_acquire_ms,
        begin_tx_ms = timings.begin_tx_ms,
        validate_slide_ms = timings.validate_slide_ms,
        update_session_ms = timings.update_session_ms,
        fetch_session_ms = timings.fetch_session_ms,
        enqueue_outbox_ms = timings.enqueue_outbox_ms,
        commit_ms = timings.commit_ms,
        post_commit_ms = timings.post_commit_ms,
        db_path_ms = timings.total_db_path_ms(),
        latency_ms = started_at.elapsed().as_millis(),
        "Clicker slide update committed"
    );

    Ok(Json(ApiResponse::success(build_state_payload(&session))))
}

/// Public endpoint to set results visibility (for mobile clicker)
pub async fn public_set_results_visibility(
    State(app_state): State<crate::AppState>,
    Path(session_id): Path<String>,
    Json(payload): Json<PublicSetResultsRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>> {
    let pool = app_state.db_pool.pool_fast_fail().await?;

    let mut tx = pool.begin().await?;

    let update_result = sqlx::query(
        "UPDATE sessions SET is_results_visible = ?, state_version = state_version + 1 WHERE id = ? AND is_results_visible <> ?"
    )
        .bind(payload.visible)
        .bind(&session_id)
        .bind(payload.visible)
        .execute(&mut *tx)
        .await?;

    let session = fetch_session(&mut *tx, &session_id).await?;
    let should_flush_outbox = update_result.rows_affected() > 0;
    if should_flush_outbox {
        let state_payload = build_state_payload(&session);
        outbox::enqueue_event(
            &mut tx,
            &session_id,
            OutboxEventType::StateUpdate,
            &state_payload,
        )
        .await?;
    }

    tx.commit().await?;
    if should_flush_outbox {
        app_state.outbox_flush_notify.notify_one();
    }

    Ok(Json(ApiResponse::success(
        serde_json::json!({ "message": "Results visibility updated" }),
    )))
}

fn build_state_payload(session: &Session) -> StateUpdatePayload {
    StateUpdatePayload {
        current_slide_id: session.current_slide_id.clone(),
        is_presentation_active: session.is_presentation_active,
        is_results_visible: session.is_results_visible,
        state_version: session.state_version,
    }
}

async fn broadcast_state_update_fast_lane(
    broadcaster: &dyn Broadcaster,
    session_id: &str,
    payload: &StateUpdatePayload,
) {
    let message = serde_json::json!({
        "type": "STATE_UPDATE",
        "payload": payload,
    });

    match broadcaster.broadcast(session_id, &message).await {
        Ok(receiver_count) => {
            tracing::info!(
                session_id = %session_id,
                receiver_count,
                current_slide_id = ?payload.current_slide_id,
                state_version = payload.state_version,
                "Fast-lane STATE_UPDATE broadcast after commit"
            );
        }
        Err(error) => {
            tracing::warn!(
                session_id = %session_id,
                current_slide_id = ?payload.current_slide_id,
                state_version = payload.state_version,
                error = %error,
                "Fast-lane STATE_UPDATE broadcast failed; outbox fallback remains available"
            );
        }
    }
}

fn resolve_public_client_request_id(headers: &HeaderMap) -> String {
    headers
        .get("x-client-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("clicker-{}", Uuid::new_v4()))
}

async fn fetch_session<'c, E>(executor: E, session_id: &str) -> Result<Session>
where
    E: sqlx::Executor<'c, Database = MySql>,
{
    let session = query_as::<_, Session>(
            "SELECT id, creator_id, title, status, share_token, current_slide_id, is_results_visible, is_presentation_active, state_version, allow_questions, require_name, created_at, updated_at FROM sessions WHERE id = ?",
        )
        .bind(session_id)
        .fetch_one(executor)
        .await?;

    Ok(session)
}

async fn validate_target_slide_exists(
    tx: &mut sqlx::Transaction<'_, MySql>,
    session_id: &str,
    slide_id: Option<&str>,
) -> Result<()> {
    let Some(slide_id) = slide_id.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };

    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM slides WHERE id = ? AND session_id = ?)")
            .bind(slide_id)
            .bind(session_id)
            .fetch_one(&mut **tx)
            .await?;

    if exists {
        Ok(())
    } else {
        Err(crate::error::AppError::Input(
            "Invalid slide: slide does not exist or does not belong to this session".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::broadcaster_spy::BroadcasterSpy;

    #[tokio::test]
    async fn fast_lane_state_update_broadcasts_immediately_to_registry() {
        let spy = BroadcasterSpy::new();
        let payload = StateUpdatePayload {
            current_slide_id: Some("slide-123".to_string()),
            is_presentation_active: true,
            is_results_visible: false,
            state_version: 42,
        };

        broadcast_state_update_fast_lane(&spy, "session-fast-lane", &payload).await;

        let messages = spy.messages_for_session("session-fast-lane").await;
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["type"], "STATE_UPDATE");
        assert_eq!(messages[0]["payload"]["currentSlideId"], "slide-123");
        assert_eq!(messages[0]["payload"]["stateVersion"], 42);
    }

    #[tokio::test]
    async fn fast_lane_state_update_tolerates_broadcast_failures() {
        let spy = BroadcasterSpy::failing();
        let payload = StateUpdatePayload {
            current_slide_id: Some("slide-456".to_string()),
            is_presentation_active: true,
            is_results_visible: true,
            state_version: 99,
        };

        broadcast_state_update_fast_lane(&spy, "session-fast-lane", &payload).await;

        assert_eq!(
            spy.failure_count.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[test]
    fn clicker_write_path_total_db_path_excludes_post_commit_work() {
        let timings = ClickerWritePathTimings {
            pool_acquire_ms: 4,
            begin_tx_ms: 7,
            validate_slide_ms: 11,
            update_session_ms: 13,
            fetch_session_ms: 17,
            enqueue_outbox_ms: 19,
            commit_ms: 23,
            post_commit_ms: 29,
        };

        assert_eq!(timings.total_db_path_ms(), 90);
        assert_eq!(timings.post_commit_ms, 29);
    }
}
