use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

/// Serializes vote write transactions per session so vote storms do not all
/// block on the same DB row while holding scarce pool connections.
#[derive(Clone, Default)]
pub struct VoteGate {
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl VoteGate {
    pub fn new() -> Self {
        Self {
            locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn session_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().await;
        locks
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::VoteGate;
    use std::sync::Arc;
    use tokio::sync::Barrier;
    use tokio::time::{sleep, timeout, Duration};

    #[tokio::test]
    async fn same_session_waits_for_prior_vote() {
        let gate = VoteGate::new();
        let lock = gate.session_lock("session-1").await;
        let _guard = lock.lock().await;

        let gate_for_task = gate.clone();
        let waiter = tokio::spawn(async move {
            let lock = gate_for_task.session_lock("session-1").await;
            let _guard = lock.lock().await;
        });

        assert!(
            timeout(Duration::from_millis(50), waiter).await.is_err(),
            "same-session vote should remain queued while the first writer holds the gate"
        );
    }

    #[tokio::test]
    async fn different_sessions_do_not_block_each_other() {
        let gate = VoteGate::new();
        let barrier = Arc::new(Barrier::new(2));

        let gate_a = gate.clone();
        let barrier_a = barrier.clone();
        let first = tokio::spawn(async move {
            let lock = gate_a.session_lock("session-a").await;
            let _guard = lock.lock().await;
            barrier_a.wait().await;
            sleep(Duration::from_millis(100)).await;
        });

        let gate_b = gate.clone();
        let second = tokio::spawn(async move {
            barrier.wait().await;
            let lock = gate_b.session_lock("session-b").await;
            let _guard = lock.lock().await;
        });

        timeout(Duration::from_millis(50), second)
            .await
            .expect("different sessions should not share the same vote gate")
            .expect("second task should succeed");
        first.await.expect("first task should succeed");
    }
}
