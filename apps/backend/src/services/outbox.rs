use serde::{Deserialize, Serialize};
use sqlx::{MySql, Pool};
use std::time::Duration;
use tokio::sync::watch;
use uuid::Uuid;

use crate::services::ably;

const MAX_RETRIES: u32 = 5;
const POLL_INTERVAL_MS: u64 = 500;
const BATCH_SIZE: usize = 50;
const CLEANUP_AGE_HOURS: i64 = 24;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[allow(clippy::enum_variant_names)]
pub enum OutboxEventType {
    StateUpdate,
    VoteUpdate,
    QaUpdate,
    SlidesUpdate,
}

impl std::fmt::Display for OutboxEventType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OutboxEventType::StateUpdate => write!(f, "STATE_UPDATE"),
            OutboxEventType::VoteUpdate => write!(f, "VOTE_UPDATE"),
            OutboxEventType::QaUpdate => write!(f, "QA_UPDATE"),
            OutboxEventType::SlidesUpdate => write!(f, "SLIDES_UPDATE"),
        }
    }
}

impl std::str::FromStr for OutboxEventType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "STATE_UPDATE" => Ok(OutboxEventType::StateUpdate),
            "VOTE_UPDATE" => Ok(OutboxEventType::VoteUpdate),
            "QA_UPDATE" => Ok(OutboxEventType::QaUpdate),
            "SLIDES_UPDATE" => Ok(OutboxEventType::SlidesUpdate),
            _ => Err(format!("Unknown event type: {}", s)),
        }
    }
}

#[derive(Debug, sqlx::FromRow)]
#[allow(dead_code)]
pub struct OutboxEvent {
    pub id: String,
    pub session_id: String,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub status: String,
    pub retry_count: i32,
}

/// Insert an event into the outbox within an existing transaction
pub async fn enqueue_event(
    tx: &mut sqlx::Transaction<'_, MySql>,
    session_id: &str,
    event_type: OutboxEventType,
    payload: &impl Serialize,
) -> Result<String, sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    let payload_json = serde_json::to_value(payload).map_err(|e| {
        tracing::error!("Failed to serialize outbox payload: {}", e);
        sqlx::Error::Protocol(format!("Failed to serialize outbox payload: {}", e))
    })?;

    sqlx::query(
        "INSERT INTO outbox_events (id, session_id, event_type, payload) VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(session_id)
    .bind(event_type.to_string())
    .bind(sqlx::types::Json(&payload_json))
    .execute(&mut **tx)
    .await?;

    Ok(id)
}

/// Publish a single event to Ably based on its type
async fn publish_event(session_id: &str, event_type: &str, payload: &serde_json::Value) -> bool {
    match event_type.parse::<OutboxEventType>() {
        Ok(OutboxEventType::StateUpdate) => {
            ably::publish_state_update(session_id, payload).await
        }
        Ok(OutboxEventType::VoteUpdate) => {
            let slide_id = payload["slideId"].as_str().unwrap_or("");
            let results = payload["results"]
                .as_object()
                .map(|obj| {
                    obj.iter()
                        .map(|(k, v)| (k.clone(), v.as_i64().unwrap_or(0) as i32))
                        .collect()
                })
                .unwrap_or_default();
            let sequence = payload["sequence"].as_u64().unwrap_or(0);
            ably::publish_vote_update(session_id, slide_id, &results, sequence).await
        }
        Ok(OutboxEventType::QaUpdate) => {
            let questions = payload["payload"]["questions"].clone();
            let sequence = payload["sequence"].as_u64().unwrap_or(0);
            ably::publish_qa_update(session_id, &questions, sequence).await
        }
        Ok(OutboxEventType::SlidesUpdate) => {
            let slides = payload["slides"].clone();
            ably::publish_slides_update(session_id, &slides).await
        }
        Err(e) => {
            tracing::error!("Unknown outbox event type: {}", e);
            false
        }
    }
}

/// Process one batch of pending events. Returns the number of events processed.
pub async fn process_pending_batch(pool: &Pool<MySql>) -> Result<usize, sqlx::Error> {
    let events: Vec<OutboxEvent> = sqlx::query_as(
        "SELECT id, session_id, event_type, payload, status, retry_count 
         FROM outbox_events 
         WHERE status = 'pending' AND retry_count < ? 
         ORDER BY created_at 
         LIMIT ?",
    )
    .bind(MAX_RETRIES as i32)
    .bind(BATCH_SIZE as i64)
    .fetch_all(pool)
    .await?;

    let count = events.len();

    for event in events {
        let success = publish_event(&event.session_id, &event.event_type, &event.payload).await;

        if success {
            sqlx::query(
                "UPDATE outbox_events SET status = 'published', published_at = NOW() WHERE id = ?",
            )
            .bind(&event.id)
            .execute(pool)
            .await?;
        } else {
            sqlx::query(
                "UPDATE outbox_events SET retry_count = retry_count + 1 WHERE id = ?",
            )
            .bind(&event.id)
            .execute(pool)
            .await?;
        }
    }

    Ok(count)
}

/// Clean up events older than the configured retention period
pub async fn cleanup_old_events(pool: &Pool<MySql>) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        "DELETE FROM outbox_events WHERE created_at < NOW() - INTERVAL ? HOUR",
    )
    .bind(CLEANUP_AGE_HOURS)
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}

/// Run the outbox worker loop. This function runs until a shutdown signal is received.
/// On shutdown, it performs one final flush of pending events before exiting.
pub async fn run_outbox_worker(pool: Pool<MySql>, mut shutdown_rx: watch::Receiver<bool>) {
    tracing::info!("Outbox worker started");
    let mut poll_interval = tokio::time::interval(Duration::from_millis(POLL_INTERVAL_MS));
    let mut cleanup_interval = tokio::time::interval(Duration::from_secs(60));

    loop {
        tokio::select! {
            _ = poll_interval.tick() => {
                match process_pending_batch(&pool).await {
                    Ok(0) => {} // No pending events
                    Ok(count) => {
                        tracing::info!(count, "Outbox worker processed events");
                    }
                    Err(e) => {
                        tracing::error!("Outbox worker error processing batch: {}", e);
                    }
                }
            }
            _ = cleanup_interval.tick() => {
                match cleanup_old_events(&pool).await {
                    Ok(0) => {}
                    Ok(count) => {
                        tracing::info!(count, "Outbox worker cleaned up old events");
                    }
                    Err(e) => {
                        tracing::error!("Outbox worker error cleaning up old events: {}", e);
                    }
                }
            }
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    tracing::info!("Outbox worker received shutdown signal, flushing pending batch");
                    match process_pending_batch(&pool).await {
                        Ok(count) => tracing::info!(count, "Outbox worker final flush complete"),
                        Err(e) => tracing::error!(error = %e, "Outbox worker final flush error"),
                    }
                    tracing::info!("Outbox worker shut down gracefully");
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies the watch channel mechanics used by the outbox worker shutdown.
    /// When the sender transmits `true`, the receiver's `changed()` must resolve.
    #[tokio::test]
    async fn shutdown_watch_channel_delivers_signal() {
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

        // Receiver should NOT resolve immediately — value hasn't changed yet.
        // We use try_recv to confirm initial state without blocking.
        assert_eq!(*shutdown_rx.borrow(), false);

        // Send the shutdown signal.
        shutdown_tx.send(true).unwrap();

        // Now changed() should resolve immediately.
        shutdown_rx.changed().await.unwrap();
        assert_eq!(*shutdown_rx.borrow(), true);
    }

    /// Verifies that a task waiting on changed() unblocks when the signal is sent.
    /// This simulates the outbox worker's select! branch behavior.
    #[tokio::test]
    async fn shutdown_watch_unblocks_waiting_task() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let exited = Arc::new(AtomicBool::new(false));
        let exited_clone = exited.clone();

        // Spawn a task that mimics the outbox worker's shutdown branch:
        // it waits on changed(), then sets a flag and exits.
        let worker = tokio::spawn(async move {
            shutdown_rx.changed().await.unwrap();
            exited_clone.store(true, Ordering::SeqCst);
        });

        // The worker should NOT have exited yet.
        assert!(!exited.load(Ordering::SeqCst));
        assert!(!worker.is_finished());

        // Send the shutdown signal.
        shutdown_tx.send(true).unwrap();

        // Wait for the worker to complete.
        worker.await.unwrap();

        // The worker MUST have exited.
        assert!(exited.load(Ordering::SeqCst));
    }

    #[test]
    fn event_type_display_matches_string() {
        assert_eq!(OutboxEventType::StateUpdate.to_string(), "STATE_UPDATE");
        assert_eq!(OutboxEventType::VoteUpdate.to_string(), "VOTE_UPDATE");
        assert_eq!(OutboxEventType::QaUpdate.to_string(), "QA_UPDATE");
        assert_eq!(OutboxEventType::SlidesUpdate.to_string(), "SLIDES_UPDATE");
    }

    #[test]
    fn event_type_from_str_roundtrips() {
        assert_eq!(
            "STATE_UPDATE".parse::<OutboxEventType>().unwrap(),
            OutboxEventType::StateUpdate
        );
        assert_eq!(
            "VOTE_UPDATE".parse::<OutboxEventType>().unwrap(),
            OutboxEventType::VoteUpdate
        );
        assert_eq!(
            "QA_UPDATE".parse::<OutboxEventType>().unwrap(),
            OutboxEventType::QaUpdate
        );
        assert_eq!(
            "SLIDES_UPDATE".parse::<OutboxEventType>().unwrap(),
            OutboxEventType::SlidesUpdate
        );
    }

    #[test]
    fn event_type_from_str_rejects_unknown() {
        assert!("UNKNOWN_TYPE".parse::<OutboxEventType>().is_err());
        assert!("".parse::<OutboxEventType>().is_err());
        assert!("state_update".parse::<OutboxEventType>().is_err()); // case-sensitive
    }

    #[test]
    fn constants_have_expected_values() {
        assert_eq!(MAX_RETRIES, 5);
        assert_eq!(POLL_INTERVAL_MS, 500);
        assert_eq!(BATCH_SIZE, 50);
        assert_eq!(CLEANUP_AGE_HOURS, 24);
    }
}
