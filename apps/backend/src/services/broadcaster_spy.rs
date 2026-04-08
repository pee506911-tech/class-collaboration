use async_trait::async_trait;
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::ws::registry::{BroadcastError, Broadcaster};

/// Test double for the Broadcaster trait.
///
/// Records all broadcast calls so tests can verify what was broadcast,
/// how many times, and to which sessions.
#[allow(dead_code)]
pub struct BroadcasterSpy {
    /// Each call to broadcast() appends to this vector.
    pub calls: Arc<Mutex<Vec<(String, Value)>>>,
    /// Controls whether broadcast succeeds or fails.
    pub should_fail: bool,
    /// Count of successful broadcasts (atomic for thread safety).
    pub success_count: AtomicUsize,
    /// Count of failed broadcasts (atomic for thread safety).
    pub failure_count: AtomicUsize,
}

#[allow(dead_code)]
impl BroadcasterSpy {
    pub fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            should_fail: false,
            success_count: AtomicUsize::new(0),
            failure_count: AtomicUsize::new(0),
        }
    }

    /// Create a spy that will fail all broadcasts.
    pub fn failing() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            should_fail: true,
            success_count: AtomicUsize::new(0),
            failure_count: AtomicUsize::new(0),
        }
    }

    /// Get all session IDs that were broadcast to.
    pub async fn session_ids(&self) -> Vec<String> {
        self.calls
            .lock()
            .await
            .iter()
            .map(|(session_id, _)| session_id.clone())
            .collect()
    }

    /// Get all messages broadcast to a specific session.
    pub async fn messages_for_session(&self, session_id: &str) -> Vec<Value> {
        self.calls
            .lock()
            .await
            .iter()
            .filter(|(sid, _)| sid == session_id)
            .map(|(_, msg)| msg.clone())
            .collect()
    }
}

impl Default for BroadcasterSpy {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Broadcaster for BroadcasterSpy {
    async fn broadcast(&self, session_id: &str, message: &Value) -> Result<usize, BroadcastError> {
        if self.should_fail {
            self.failure_count.fetch_add(1, Ordering::SeqCst);
            Err(BroadcastError::Internal(
                "Spy configured to fail".to_string(),
            ))
        } else {
            self.calls
                .lock()
                .await
                .push((session_id.to_string(), message.clone()));
            self.success_count.fetch_add(1, Ordering::SeqCst);
            Ok(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn spy_records_broadcast_calls() {
        let spy = BroadcasterSpy::new();
        let msg = json!({ "type": "STATE_UPDATE" });

        spy.broadcast("session-1", &msg).await.unwrap();

        let calls = spy.calls.lock().await;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "session-1");
        assert_eq!(calls[0].1["type"], "STATE_UPDATE");
    }

    #[tokio::test]
    async fn spy_records_multiple_broadcasts() {
        let spy = BroadcasterSpy::new();

        spy.broadcast("session-1", &json!({ "type": "STATE_UPDATE" }))
            .await
            .unwrap();
        spy.broadcast("session-2", &json!({ "type": "VOTE_UPDATE" }))
            .await
            .unwrap();

        let session_ids = spy.session_ids().await;
        assert_eq!(session_ids, vec!["session-1", "session-2"]);
    }

    #[tokio::test]
    async fn spy_returns_messages_for_specific_session() {
        let spy = BroadcasterSpy::new();

        spy.broadcast(
            "session-1",
            &json!({ "type": "STATE_UPDATE", "version": 1 }),
        )
        .await
        .unwrap();
        spy.broadcast(
            "session-1",
            &json!({ "type": "STATE_UPDATE", "version": 2 }),
        )
        .await
        .unwrap();
        spy.broadcast("session-2", &json!({ "type": "VOTE_UPDATE" }))
            .await
            .unwrap();

        let messages = spy.messages_for_session("session-1").await;
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["version"], 1);
        assert_eq!(messages[1]["version"], 2);
    }

    #[tokio::test]
    async fn spy_fails_when_configured() {
        let spy = BroadcasterSpy::failing();

        let result = spy.broadcast("session-1", &json!({})).await;
        assert!(result.is_err());
        assert_eq!(spy.failure_count.load(Ordering::SeqCst), 1);
        assert_eq!(spy.success_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn spy_counts_successful_broadcasts() {
        let spy = BroadcasterSpy::new();

        spy.broadcast("session-1", &json!({})).await.unwrap();
        spy.broadcast("session-2", &json!({})).await.unwrap();
        spy.broadcast("session-3", &json!({})).await.unwrap();

        assert_eq!(spy.success_count.load(Ordering::SeqCst), 3);
        assert_eq!(spy.failure_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn spy_is_send_sync() {
        fn assert_send<T: Send + Sync + ?Sized>() {}
        assert_send::<BroadcasterSpy>();
    }
}
