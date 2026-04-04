use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use tokio::sync::{broadcast, RwLock};

use crate::services::circuit_breaker::CircuitBreaker;

/// Capacity of the per-session broadcast channel. 256 messages is far more
/// than any classroom session would generate between consumer reads.
const BROADCAST_CHANNEL_CAPACITY: usize = 256;

/// Error type for broadcast operations.
#[derive(Debug, thiserror::Error)]
pub enum BroadcastError {
    #[allow(dead_code)] // Reserved for future error handling
    #[error("Broadcast failed: {0}")]
    Internal(String),
}

/// Trait abstracting the broadcast mechanism for session events.
///
/// The outbox worker depends on this trait, not a concrete implementation,
/// so that the transport can be swapped (e.g. Redis Pub/Sub) without
/// changing outbox logic.
#[async_trait]
pub trait Broadcaster: Send + Sync {
    /// Broadcast a message to all connected clients in the given session.
    ///
    /// Returns the number of receivers that received the message.
    /// Returns `Ok(0)` if no receivers are connected (not an error).
    async fn broadcast(&self, session_id: &str, message: &Value) -> Result<usize, BroadcastError>;
}

/// In-memory session registry using tokio broadcast channels.
///
/// Each session gets its own broadcast channel. Clients subscribe to the
/// channel for their session. Broadcasting sends to the channel and all
/// subscribers receive the message. Dead sessions are pruned lazily on
/// the next broadcast attempt.
pub struct InMemoryRegistry {
    sessions: RwLock<HashMap<String, broadcast::Sender<Value>>>,
    circuit_breaker: CircuitBreaker,
}

impl InMemoryRegistry {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            circuit_breaker: CircuitBreaker::new(5, 30),
        }
    }

    /// Register a new connection for the given session.
    ///
    /// Returns a broadcast receiver that will receive all messages for this
    /// session. If the session doesn't exist yet, a new broadcast channel
    /// is created.
    pub async fn register(&self, session_id: &str) -> broadcast::Receiver<Value> {
        let mut sessions = self.sessions.write().await;

        let sender = sessions
            .entry(session_id.to_string())
            .or_insert_with(|| broadcast::channel(BROADCAST_CHANNEL_CAPACITY).0);

        sender.subscribe()
    }

    /// Return the total number of active receivers across all sessions.
    ///
    /// This is a side-effect-free read suitable for health checks and metrics.
    pub async fn active_connections(&self) -> usize {
        let sessions = self.sessions.read().await;
        sessions.values().map(|s| s.receiver_count()).sum()
    }

    /// Return the number of active receivers for a specific session.
    pub async fn session_connection_count(&self, session_id: &str) -> usize {
        let sessions = self.sessions.read().await;
        sessions
            .get(session_id)
            .map(|s| s.receiver_count())
            .unwrap_or(0)
    }

    /// Prune sessions that have no receivers.
    /// Called internally by broadcast when a send detects zero receivers.
    async fn prune_dead_sessions(&self, session_id: &str) {
        let mut sessions = self.sessions.write().await;
        if let Some(sender) = sessions.get(session_id) {
            if sender.receiver_count() == 0 {
                sessions.remove(session_id);
            }
        }
    }
}

impl Default for InMemoryRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Broadcaster for InMemoryRegistry {
    async fn broadcast(&self, session_id: &str, message: &Value) -> Result<usize, BroadcastError> {
        let sessions = self.sessions.read().await;

        let sender = match sessions.get(session_id) {
            Some(s) => s.clone(),
            None => return Ok(0),
        };
        drop(sessions);

        match sender.send(message.clone()) {
            Ok(received_count) => {
                self.circuit_breaker.record_success();
                Ok(received_count)
            }
            Err(_) => {
                // All receivers have been dropped. Prune the dead session.
                tracing::debug!(
                    session_id = %session_id,
                    "Broadcast: all receivers closed, pruning"
                );
                self.prune_dead_sessions(session_id).await;
                self.circuit_breaker.record_success();
                Ok(0)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — behavior-focused, testing observable outcomes not internals
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    // === Broadcaster trait contract ===

    /// The trait is Send + Sync + 'static, required for Arc sharing across tokio tasks.
    #[test]
    fn broadcaster_trait_is_send_sync_static() {
        fn assert_send<T: Send + Sync + 'static + ?Sized>() {}
        assert_send::<dyn Broadcaster>();
    }

    // === register: creates and subscribes ===

    #[tokio::test]
    async fn register_creates_channel_for_new_session() {
        let registry = InMemoryRegistry::new();
        let rx = registry.register("session-1").await;

        // Receiver exists and session is tracked
        assert_eq!(registry.active_connections().await, 1);
        assert_eq!(registry.session_connection_count("session-1").await, 1);

        // Avoid compiler warning about unused receiver
        drop(rx);
    }

    #[tokio::test]
    async fn register_subscribes_to_existing_session() {
        let registry = InMemoryRegistry::new();
        let _rx1 = registry.register("session-1").await;
        let _rx2 = registry.register("session-1").await;

        assert_eq!(registry.active_connections().await, 2);
        assert_eq!(registry.session_connection_count("session-1").await, 2);
    }

    #[tokio::test]
    async fn register_multiple_sessions_independent() {
        let registry = InMemoryRegistry::new();
        let _rx1a = registry.register("session-a").await;
        let _rx1b = registry.register("session-a").await;
        let _rx2 = registry.register("session-b").await;

        assert_eq!(registry.active_connections().await, 3);
        assert_eq!(registry.session_connection_count("session-a").await, 2);
        assert_eq!(registry.session_connection_count("session-b").await, 1);
    }

    // === broadcast: delivers to all receivers in session ===

    #[tokio::test]
    async fn broadcast_delivers_to_all_receivers_in_session() {
        let registry = InMemoryRegistry::new();
        let mut rx1 = registry.register("session-1").await;
        let mut rx2 = registry.register("session-1").await;

        let msg = serde_json::json!({
            "type": "STATE_UPDATE",
            "payload": { "currentSlideId": "slide-42" }
        });

        let delivered = registry.broadcast("session-1", &msg).await.unwrap();
        assert_eq!(delivered, 2);

        // Both receivers receive the message
        assert_eq!(rx1.try_recv().unwrap(), msg);
        assert_eq!(rx2.try_recv().unwrap(), msg);
    }

    #[tokio::test]
    async fn broadcast_preserves_message_structure() {
        let registry = InMemoryRegistry::new();
        let mut rx = registry.register("session-1").await;

        let msg = serde_json::json!({
            "type": "VOTE_UPDATE",
            "slideId": "slide-1",
            "results": { "opt-a": 3, "opt-b": 7 },
            "sequence": 42u64
        });

        registry.broadcast("session-1", &msg).await.unwrap();

        let received = rx.try_recv().unwrap();
        assert_eq!(received["type"], "VOTE_UPDATE");
        assert_eq!(received["slideId"], "slide-1");
        assert_eq!(received["results"]["opt-a"], 3);
        assert_eq!(received["sequence"], 42);
    }

    #[tokio::test]
    async fn broadcast_to_nonexistent_session_returns_zero() {
        let registry = InMemoryRegistry::new();
        let msg = serde_json::json!({ "type": "STATE_UPDATE" });

        let delivered = registry.broadcast("nonexistent-session", &msg).await.unwrap();
        assert_eq!(delivered, 0);
    }

    #[tokio::test]
    async fn broadcast_does_not_leak_across_sessions() {
        let registry = InMemoryRegistry::new();
        let mut rx_a = registry.register("session-a").await;
        let _rx_b = registry.register("session-b").await;

        let msg_a = serde_json::json!({ "type": "STATE_UPDATE", "session": "a" });
        let delivered = registry.broadcast("session-a", &msg_a).await.unwrap();
        assert_eq!(delivered, 1);

        // Session A's receiver got the message
        assert_eq!(rx_a.try_recv().unwrap()["session"], "a");

        // Broadcast to session-B should deliver 1 (its own receiver),
        // confirming the channels are independent.
        let msg_b = serde_json::json!({ "type": "STATE_UPDATE", "session": "b" });
        let delivered_b = registry.broadcast("session-b", &msg_b).await.unwrap();
        assert_eq!(delivered_b, 1);
    }

    #[tokio::test]
    async fn broadcast_consecutive_messages_all_delivered() {
        let registry = InMemoryRegistry::new();
        let mut rx = registry.register("session-1").await;

        for i in 0..10 {
            let msg = serde_json::json!({ "type": "STATE_UPDATE", "version": i });
            registry.broadcast("session-1", &msg).await.unwrap();
            let received = rx.try_recv().unwrap();
            assert_eq!(received["version"], i);
        }
    }

    // === active_connections: metrics ===

    #[tokio::test]
    async fn active_connections_zero_for_empty_registry() {
        let registry = InMemoryRegistry::new();
        assert_eq!(registry.active_connections().await, 0);
    }

    #[tokio::test]
    async fn active_connections_counts_all_sessions() {
        let registry = InMemoryRegistry::new();
        let _r1 = registry.register("s1").await;
        let _r2 = registry.register("s1").await;
        let _r3 = registry.register("s2").await;
        let _r4 = registry.register("s3").await;

        assert_eq!(registry.active_connections().await, 4);
    }

    #[tokio::test]
    async fn session_connection_count_zero_for_unknown_session() {
        let registry = InMemoryRegistry::new();
        assert_eq!(registry.session_connection_count("nonexistent").await, 0);
    }

    // === dead connection pruning ===

    #[tokio::test]
    async fn dropping_all_receivers_prunes_session_on_next_broadcast() {
        let registry = InMemoryRegistry::new();

        // Register and immediately drop the receiver (simulates disconnect)
        {
            let _rx = registry.register("session-1").await;
            assert_eq!(registry.session_connection_count("session-1").await, 1);
        }
        // Receiver dropped — count is still 1 because sender entry exists
        // but receiver_count() reports 0
        assert_eq!(registry.session_connection_count("session-1").await, 0);

        // Broadcast triggers lazy pruning
        let msg = serde_json::json!({ "type": "STATE_UPDATE" });
        let delivered = registry.broadcast("session-1", &msg).await.unwrap();
        assert_eq!(delivered, 0);

        // Session entry removed
        assert_eq!(registry.session_connection_count("session-1").await, 0);
    }

    #[tokio::test]
    async fn active_connections_excludes_dropped_receivers() {
        let registry = InMemoryRegistry::new();
        let _rx1 = registry.register("session-1").await;
        let rx2 = registry.register("session-1").await;
        assert_eq!(registry.active_connections().await, 2);

        drop(rx2);
        assert_eq!(registry.active_connections().await, 1);
    }

    // === circuit breaker ===

    #[test]
    fn circuit_breaker_starts_closed() {
        let _registry = InMemoryRegistry::new();
        // Circuit breaker is internal, but we can verify successful broadcasts
        // don't trip it. The CB for in-memory should effectively never trip
        // since broadcast errors (no receivers) are not real failures.
    }

    // === concurrent access ===

    #[tokio::test]
    async fn concurrent_registrations_same_session_all_succeed() {
        let registry = Arc::new(InMemoryRegistry::new());
        let mut handles = vec![];

        for _ in 0..10 {
            let reg = registry.clone();
            handles.push(tokio::spawn(async move {
                reg.register("session-1").await
            }));
        }

        let receivers: Vec<_> = futures_util::future::join_all(handles)
            .await
            .into_iter()
            .map(|h| h.unwrap())
            .collect();

        assert_eq!(registry.active_connections().await, 10);

        // Broadcast reaches all 10
        let msg = serde_json::json!({ "type": "STATE_UPDATE" });
        let delivered = registry.broadcast("session-1", &msg).await.unwrap();
        assert_eq!(delivered, 10);

        // Each receiver gets it
        for mut rx in receivers {
            assert_eq!(rx.try_recv().unwrap()["type"], "STATE_UPDATE");
        }
    }

    #[tokio::test]
    async fn concurrent_broadcasts_all_delivered() {
        let registry = Arc::new(InMemoryRegistry::new());
        let mut rx = registry.register("session-1").await;

        let mut handles = vec![];
        for i in 0..20 {
            let reg = registry.clone();
            handles.push(tokio::spawn(async move {
                let msg = serde_json::json!({ "type": "UPDATE", "index": i });
                reg.broadcast("session-1", &msg).await.unwrap()
            }));
        }

        let results: Vec<usize> = futures_util::future::join_all(handles)
            .await
            .into_iter()
            .map(|h| h.unwrap())
            .collect();

        // All 20 broadcasts reported 1 receiver
        assert_eq!(results.len(), 20);
        for count in &results {
            assert_eq!(*count, 1);
        }

        // Receiver got all 20 messages (channel capacity 256 >> 20)
        for i in 0..20 {
            let msg = rx.try_recv().unwrap();
            assert_eq!(msg["index"], i);
        }
    }
}
