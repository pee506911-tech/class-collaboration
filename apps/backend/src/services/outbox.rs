use serde::{Deserialize, Serialize};
use sqlx::{MySql, Pool};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{watch, Notify};
use tokio::time::MissedTickBehavior;
use uuid::Uuid;

use crate::ws::registry::Broadcaster;

const MAX_RETRIES: u32 = 5;
const POLL_INTERVAL_MS: u64 = 100;
const BATCH_SIZE: usize = 50;
const CLEANUP_AGE_HOURS: i64 = 24;

#[derive(Debug, PartialEq, Eq)]
enum OutboxWorkerSignal {
    PollTick,
    CleanupTick,
    FlushRequested,
    ShutdownRequested,
}

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
    pub sequence_id: u64,
    pub session_id: String,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub status: String,
    pub retry_count: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnqueuedOutboxEvent {
    pub id: String,
    pub sequence_id: u64,
}

/// Insert an event into the outbox within an existing transaction
pub async fn enqueue_event(
    tx: &mut sqlx::Transaction<'_, MySql>,
    session_id: &str,
    event_type: OutboxEventType,
    payload: &impl Serialize,
) -> Result<EnqueuedOutboxEvent, sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    let sequence_id: u64 =
        sqlx::query_scalar("SELECT CAST(NEXTVAL(outbox_event_sequence) AS UNSIGNED)")
            .fetch_one(&mut **tx)
            .await?;
    let payload_json = serde_json::to_value(payload).map_err(|e| {
        tracing::error!("Failed to serialize outbox payload: {}", e);
        sqlx::Error::Protocol(format!("Failed to serialize outbox payload: {}", e))
    })?;

    sqlx::query(
        "INSERT INTO outbox_events (id, sequence_id, session_id, event_type, payload) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(sequence_id)
    .bind(session_id)
    .bind(event_type.to_string())
    .bind(sqlx::types::Json(&payload_json))
    .execute(&mut **tx)
    .await?;

    Ok(EnqueuedOutboxEvent { id, sequence_id })
}

/// Publish a single event to the Broadcaster based on its type
async fn publish_event(broadcaster: &dyn Broadcaster, event: &OutboxEvent) -> bool {
    let message = match event.event_type.parse::<OutboxEventType>() {
        Ok(OutboxEventType::StateUpdate) => serde_json::json!({
            "type": "STATE_UPDATE",
            "payload": event.payload
        }),
        Ok(OutboxEventType::VoteUpdate) => {
            let slide_id = event.payload["slideId"].as_str().unwrap_or("");
            let results = event.payload["results"]
                .as_object()
                .map(|obj| {
                    obj.iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect::<serde_json::Map<String, serde_json::Value>>()
                })
                .unwrap_or_default();
            let sequence = event.payload["sequence"]
                .as_u64()
                .unwrap_or(event.sequence_id);
            serde_json::json!({
                "type": "VOTE_UPDATE",
                "slideId": slide_id,
                "results": results,
                "sequence": sequence
            })
        }
        Ok(OutboxEventType::QaUpdate) => {
            let questions = event.payload["payload"]["questions"].clone();
            let sequence = event.payload["sequence"].as_u64().unwrap_or(0);
            serde_json::json!({
                "type": "QA_UPDATE",
                "payload": { "questions": questions },
                "sequence": sequence
            })
        }
        Ok(OutboxEventType::SlidesUpdate) => {
            let slides = event.payload["slides"].clone();
            serde_json::json!({
                "type": "SLIDES_UPDATE",
                "slides": slides
            })
        }
        Err(e) => {
            tracing::error!("Unknown outbox event type: {}", e);
            return false;
        }
    };

    match broadcaster.broadcast(&event.session_id, &message).await {
        Ok(_) => true,
        Err(e) => {
            tracing::error!("Broadcast failed for event {}: {}", event.event_type, e);
            false
        }
    }
}

/// Process one batch of pending events. Returns the number of events processed.
pub async fn process_pending_batch(
    pool: &Pool<MySql>,
    broadcaster: &dyn Broadcaster,
) -> Result<usize, sqlx::Error> {
    let events: Vec<OutboxEvent> = sqlx::query_as(
        "SELECT id, sequence_id, session_id, event_type, payload, status, retry_count
         FROM outbox_events
         WHERE status = 'pending' AND retry_count < ?
         ORDER BY sequence_id
         LIMIT ?",
    )
    .bind(MAX_RETRIES as i32)
    .bind(BATCH_SIZE as i64)
    .fetch_all(pool)
    .await?;

    let count = events.len();

    for event in events {
        let success = publish_event(broadcaster, &event).await;

        if success {
            sqlx::query(
                "UPDATE outbox_events SET status = 'published', published_at = NOW() WHERE id = ?",
            )
            .bind(&event.id)
            .execute(pool)
            .await?;
        } else {
            sqlx::query("UPDATE outbox_events SET retry_count = retry_count + 1 WHERE id = ?")
                .bind(&event.id)
                .execute(pool)
                .await?;
        }
    }

    Ok(count)
}

/// Clean up events older than the configured retention period
pub async fn cleanup_old_events(pool: &Pool<MySql>) -> Result<u64, sqlx::Error> {
    let result =
        sqlx::query("DELETE FROM outbox_events WHERE created_at < NOW() - INTERVAL ? HOUR")
            .bind(CLEANUP_AGE_HOURS)
            .execute(pool)
            .await?;

    Ok(result.rows_affected())
}

async fn next_worker_signal(
    poll_interval: &mut tokio::time::Interval,
    cleanup_interval: &mut tokio::time::Interval,
    shutdown_rx: &mut watch::Receiver<bool>,
    flush_notify: &Notify,
) -> OutboxWorkerSignal {
    loop {
        tokio::select! {
            _ = poll_interval.tick() => return OutboxWorkerSignal::PollTick,
            _ = cleanup_interval.tick() => return OutboxWorkerSignal::CleanupTick,
            _ = flush_notify.notified() => return OutboxWorkerSignal::FlushRequested,
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    return OutboxWorkerSignal::ShutdownRequested;
                }
            }
        }
    }
}

async fn flush_pending_events(
    pool: &Pool<MySql>,
    broadcaster: &dyn Broadcaster,
    trigger: &'static str,
) {
    let started_at = std::time::Instant::now();
    match process_pending_batch(pool, broadcaster).await {
        Ok(0) => {
            tracing::trace!(
                trigger,
                latency_ms = started_at.elapsed().as_millis(),
                "Outbox worker found no pending events"
            );
        }
        Ok(count) => {
            tracing::info!(
                trigger,
                count,
                latency_ms = started_at.elapsed().as_millis(),
                "Outbox worker processed events"
            );
        }
        Err(e) => {
            tracing::error!(trigger, "Outbox worker error processing batch: {}", e);
        }
    }
}

/// Run the outbox worker loop. This function runs until a shutdown signal is received.
/// On shutdown, it performs one final flush of pending events before exiting.
pub async fn run_outbox_worker(
    pool: Pool<MySql>,
    broadcaster: Arc<dyn Broadcaster>,
    flush_notify: Arc<Notify>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    tracing::info!("Outbox worker started");
    let mut poll_interval = tokio::time::interval(Duration::from_millis(POLL_INTERVAL_MS));
    let mut cleanup_interval = tokio::time::interval(Duration::from_secs(60));
    poll_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    cleanup_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        match next_worker_signal(
            &mut poll_interval,
            &mut cleanup_interval,
            &mut shutdown_rx,
            flush_notify.as_ref(),
        )
        .await
        {
            OutboxWorkerSignal::PollTick => {
                flush_pending_events(&pool, broadcaster.as_ref(), "poll").await;
            }
            OutboxWorkerSignal::FlushRequested => {
                flush_pending_events(&pool, broadcaster.as_ref(), "notify").await;
            }
            OutboxWorkerSignal::CleanupTick => {
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
            OutboxWorkerSignal::ShutdownRequested => {
                tracing::info!("Outbox worker received shutdown signal, flushing pending batch");
                match process_pending_batch(&pool, broadcaster.as_ref()).await {
                    Ok(count) => tracing::info!(count, "Outbox worker final flush complete"),
                    Err(e) => tracing::error!(error = %e, "Outbox worker final flush error"),
                }
                tracing::info!("Outbox worker shut down gracefully");
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::broadcaster_spy::BroadcasterSpy;
    use tokio::sync::Notify;

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

    #[tokio::test]
    async fn flush_signal_unblocks_worker_without_waiting_for_poll_tick() {
        let flush_notify = Notify::new();
        let (_shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let mut poll_interval = tokio::time::interval(Duration::from_millis(POLL_INTERVAL_MS));
        let mut cleanup_interval = tokio::time::interval(Duration::from_secs(60));
        poll_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        cleanup_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

        poll_interval.tick().await;
        cleanup_interval.tick().await;

        let wait_for_signal = next_worker_signal(
            &mut poll_interval,
            &mut cleanup_interval,
            &mut shutdown_rx,
            &flush_notify,
        );

        tokio::pin!(wait_for_signal);

        flush_notify.notify_one();

        assert_eq!(
            tokio::time::timeout(Duration::from_millis(20), wait_for_signal)
                .await
                .unwrap(),
            OutboxWorkerSignal::FlushRequested
        );
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
        assert_eq!(POLL_INTERVAL_MS, 100);
        assert_eq!(BATCH_SIZE, 50);
        assert_eq!(CLEANUP_AGE_HOURS, 24);
    }

    // === Outbox dispatch tests with BroadcasterSpy ===

    #[tokio::test]
    async fn publish_event_dispatches_state_update_to_broadcaster() {
        let spy = BroadcasterSpy::new();
        let event = OutboxEvent {
            id: "evt-1".to_string(),
            sequence_id: 1,
            session_id: "session-123".to_string(),
            event_type: "STATE_UPDATE".to_string(),
            payload: serde_json::json!({ "currentSlideId": "slide-1" }),
            status: "pending".to_string(),
            retry_count: 0,
        };

        let success = publish_event(&spy, &event).await;

        assert!(success);
        assert_eq!(
            spy.success_count.load(std::sync::atomic::Ordering::SeqCst),
            1
        );

        let messages = spy.messages_for_session("session-123").await;
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["type"], "STATE_UPDATE");
        assert_eq!(messages[0]["payload"]["currentSlideId"], "slide-1");
    }

    #[tokio::test]
    async fn publish_event_dispatches_vote_update_to_broadcaster() {
        let spy = BroadcasterSpy::new();
        let event = OutboxEvent {
            id: "evt-2".to_string(),
            sequence_id: 10,
            session_id: "session-456".to_string(),
            event_type: "VOTE_UPDATE".to_string(),
            payload: serde_json::json!({
                "slideId": "slide-2",
                "results": { "opt-a": 5, "opt-b": 3 }
            }),
            status: "pending".to_string(),
            retry_count: 0,
        };

        let success = publish_event(&spy, &event).await;

        assert!(success);
        let messages = spy.messages_for_session("session-456").await;
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["type"], "VOTE_UPDATE");
        assert_eq!(messages[0]["slideId"], "slide-2");
        assert_eq!(messages[0]["results"]["opt-a"], 5);
        assert_eq!(messages[0]["sequence"], 10);
    }

    #[tokio::test]
    async fn publish_event_dispatches_qa_update_to_broadcaster() {
        let spy = BroadcasterSpy::new();
        let event = OutboxEvent {
            id: "evt-3".to_string(),
            sequence_id: 11,
            session_id: "session-789".to_string(),
            event_type: "QA_UPDATE".to_string(),
            payload: serde_json::json!({
                "payload": {
                    "questions": [
                        { "id": "q1", "text": "What is Rust?" }
                    ]
                },
                "sequence": 5
            }),
            status: "pending".to_string(),
            retry_count: 0,
        };

        let success = publish_event(&spy, &event).await;

        assert!(success);
        let messages = spy.messages_for_session("session-789").await;
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["type"], "QA_UPDATE");
        assert_eq!(
            messages[0]["payload"]["questions"][0]["text"],
            "What is Rust?"
        );
        assert_eq!(messages[0]["sequence"], 5);
    }

    #[tokio::test]
    async fn publish_event_dispatches_slides_update_to_broadcaster() {
        let spy = BroadcasterSpy::new();
        let event = OutboxEvent {
            id: "evt-4".to_string(),
            sequence_id: 12,
            session_id: "session-abc".to_string(),
            event_type: "SLIDES_UPDATE".to_string(),
            payload: serde_json::json!({
                "slides": [
                    { "id": "slide-1", "title": "Intro" },
                    { "id": "slide-2", "title": "Details" }
                ]
            }),
            status: "pending".to_string(),
            retry_count: 0,
        };

        let success = publish_event(&spy, &event).await;

        assert!(success);
        let messages = spy.messages_for_session("session-abc").await;
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["type"], "SLIDES_UPDATE");
        assert_eq!(messages[0]["slides"][0]["title"], "Intro");
        assert_eq!(messages[0]["slides"][1]["title"], "Details");
    }

    #[tokio::test]
    async fn publish_event_returns_false_on_broadcaster_failure() {
        let spy = BroadcasterSpy::failing();
        let event = OutboxEvent {
            id: "evt-5".to_string(),
            sequence_id: 13,
            session_id: "session-123".to_string(),
            event_type: "STATE_UPDATE".to_string(),
            payload: serde_json::json!({ "currentSlideId": "slide-1" }),
            status: "pending".to_string(),
            retry_count: 0,
        };

        let success = publish_event(&spy, &event).await;

        assert!(!success);
        assert_eq!(
            spy.failure_count.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[tokio::test]
    async fn publish_event_returns_false_for_unknown_event_type() {
        let spy = BroadcasterSpy::new();
        let event = OutboxEvent {
            id: "evt-6".to_string(),
            sequence_id: 14,
            session_id: "session-123".to_string(),
            event_type: "UNKNOWN_TYPE".to_string(),
            payload: serde_json::json!({}),
            status: "pending".to_string(),
            retry_count: 0,
        };

        let success = publish_event(&spy, &event).await;

        assert!(!success);
        assert_eq!(
            spy.success_count.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
    }

    #[tokio::test]
    async fn publish_event_preserves_sequence_numbers() {
        let spy = BroadcasterSpy::new();
        let event = OutboxEvent {
            id: "evt-7".to_string(),
            sequence_id: 99,
            session_id: "session-123".to_string(),
            event_type: "VOTE_UPDATE".to_string(),
            payload: serde_json::json!({
                "slideId": "slide-1",
                "results": {}
            }),
            status: "pending".to_string(),
            retry_count: 0,
        };

        publish_event(&spy, &event).await;

        let messages = spy.messages_for_session("session-123").await;
        assert_eq!(messages[0]["sequence"], 99);
    }
}
