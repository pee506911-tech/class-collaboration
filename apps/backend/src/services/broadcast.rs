use serde_json::Value;
use sqlx::{MySql, Pool};

use crate::services::vote_cache::VoteResultCache;
use crate::ws::registry::Broadcaster;

/// Broadcast a STATE_UPDATE to all WS clients for the given session.
pub async fn broadcast_state_update(
    broadcaster: &dyn Broadcaster,
    session_id: &str,
    payload: &Value,
) {
    let message = serde_json::json!({
        "type": "STATE_UPDATE",
        "payload": payload
    });

    match broadcaster.broadcast(session_id, &message).await {
        Ok(receivers) => {
            tracing::info!(
                session_id = %session_id,
                receivers = receivers,
                "STATE_UPDATE broadcast to WS clients"
            );
        }
        Err(e) => {
            tracing::error!(
                session_id = %session_id,
                error = %e,
                "Failed to broadcast STATE_UPDATE"
            );
        }
    }
}

/// Broadcast a SLIDES_UPDATE to all WS clients for the given session.
pub async fn broadcast_slides_update(
    broadcaster: &dyn Broadcaster,
    session_id: &str,
    slides: &Value,
) {
    let message = serde_json::json!({
        "type": "SLIDES_UPDATE",
        "slides": slides
    });

    match broadcaster.broadcast(session_id, &message).await {
        Ok(receivers) => {
            tracing::info!(
                session_id = %session_id,
                slide_count = slides.as_array().map(|a| a.len()).unwrap_or(0),
                receivers = receivers,
                "SLIDES_UPDATE broadcast to WS clients"
            );
        }
        Err(e) => {
            tracing::error!(
                session_id = %session_id,
                error = %e,
                "Failed to broadcast SLIDES_UPDATE"
            );
        }
    }
}

/// Broadcast a VOTE_UPDATE to all WS clients for the given session.
/// Reads vote results from the vote_count_shards table, using the vote cache
/// to avoid redundant DB queries during vote storms.
pub async fn broadcast_vote_update(
    pool: &Pool<MySql>,
    broadcaster: &dyn Broadcaster,
    vote_cache: &VoteResultCache,
    session_id: &str,
    slide_id: &str,
    sequence: u64,
) {
    let results = match vote_cache.get(slide_id) {
        Some(cached) => {
            tracing::debug!(
                session_id = %session_id,
                slide_id = %slide_id,
                "VOTE_UPDATE using cached vote results"
            );
            cached
        }
        None => match fetch_vote_results(pool, slide_id).await {
            Ok(r) => {
                let value = serde_json::Value::Object(r);
                vote_cache.insert(slide_id, value.clone());
                value
            }
            Err(_) => Value::Object(serde_json::Map::new()),
        },
    };

    let message = serde_json::json!({
        "type": "VOTE_UPDATE",
        "slideId": slide_id,
        "results": results,
        "sequence": sequence
    });

    match broadcaster.broadcast(session_id, &message).await {
        Ok(receivers) => {
            tracing::info!(
                session_id = %session_id,
                slide_id = %slide_id,
                sequence = sequence,
                receivers = receivers,
                "VOTE_UPDATE broadcast to WS clients"
            );
        }
        Err(e) => {
            tracing::error!(
                session_id = %session_id,
                slide_id = %slide_id,
                error = %e,
                "Failed to broadcast VOTE_UPDATE"
            );
        }
    }
}

/// Broadcast a QA_UPDATE to all WS clients for the given session.
pub async fn broadcast_qa_update(
    broadcaster: &dyn Broadcaster,
    session_id: &str,
    questions: &Value,
    sequence: u64,
) {
    let message = serde_json::json!({
        "type": "QA_UPDATE",
        "payload": { "questions": questions },
        "sequence": sequence
    });

    match broadcaster.broadcast(session_id, &message).await {
        Ok(receivers) => {
            tracing::info!(
                session_id = %session_id,
                sequence = sequence,
                receivers = receivers,
                "QA_UPDATE broadcast to WS clients"
            );
        }
        Err(e) => {
            tracing::error!(
                session_id = %session_id,
                error = %e,
                "Failed to broadcast QA_UPDATE"
            );
        }
    }
}

/// Read aggregated vote results from the vote_count_shards table.
pub(crate) async fn fetch_vote_results(
    pool: &Pool<MySql>,
    slide_id: &str,
) -> Result<serde_json::Map<String, Value>, sqlx::Error> {
    let vote_counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT option_id, CAST(SUM(vote_count) AS SIGNED) as count
         FROM vote_count_shards
         WHERE slide_id = ? AND vote_count > 0
         GROUP BY option_id",
    )
    .bind(slide_id)
    .fetch_all(pool)
    .await?;

    Ok(vote_counts
        .into_iter()
        .map(|(option_id, count)| (option_id, serde_json::Value::from(count)))
        .collect())
}
