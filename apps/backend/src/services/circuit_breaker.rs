use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::time::{Duration, Instant};

/// Circuit breaker states
const STATE_CLOSED: u8 = 0;
const STATE_OPEN: u8 = 1;
const STATE_HALF_OPEN: u8 = 2;

/// A circuit breaker that protects against cascading external dependency failures.
///
/// States:
/// - **Closed** (normal): Requests pass through. Failures are counted.
/// - **Open** (tripped): Requests are rejected immediately. After a recovery timeout,
///   transitions to half-open.
/// - **Half-Open** (probing): One probe request is allowed. If it succeeds, the circuit
///   closes. If it fails, the circuit reopens.
pub struct CircuitBreaker {
    failures: AtomicU32,
    /// Nanoseconds since `created_at` when the last failure occurred
    last_failure_nanos: AtomicU64,
    state: AtomicU8,
    failure_threshold: u32,
    recovery_timeout: Duration,
    /// Reference instant captured at creation
    created_at: Instant,
}

impl CircuitBreaker {
    /// Create a new circuit breaker.
    ///
    /// # Arguments
    /// * `failure_threshold` - Number of consecutive failures before the circuit opens.
    /// * `recovery_timeout_secs` - Seconds to wait in the open state before probing.
    pub fn new(failure_threshold: u32, recovery_timeout_secs: u64) -> Self {
        Self {
            failures: AtomicU32::new(0),
            last_failure_nanos: AtomicU64::new(0),
            state: AtomicU8::new(STATE_CLOSED),
            failure_threshold,
            recovery_timeout: Duration::from_secs(recovery_timeout_secs),
            created_at: Instant::now(),
        }
    }

    /// Create a new circuit breaker with millisecond precision (for testing).
    #[cfg(test)]
    pub fn new_with_millis(failure_threshold: u32, recovery_timeout_ms: u64) -> Self {
        Self {
            failures: AtomicU32::new(0),
            last_failure_nanos: AtomicU64::new(0),
            state: AtomicU8::new(STATE_CLOSED),
            failure_threshold,
            recovery_timeout: Duration::from_millis(recovery_timeout_ms),
            created_at: Instant::now(),
        }
    }

    fn nanos_since_creation(&self) -> u64 {
        self.created_at.elapsed().as_nanos() as u64
    }

    /// Check if a request should be allowed through.
    ///
    /// Returns `true` if the request is allowed, `false` if the circuit is open.
    /// If the circuit is in the open state and the recovery timeout has elapsed,
    /// this transitions to half-open and returns `true` for a probe request.
    pub fn allow_request(&self) -> bool {
        match self.state.load(Ordering::SeqCst) {
            STATE_CLOSED => true,
            STATE_OPEN => {
                let failures = self.failures.load(Ordering::SeqCst);
                if failures == 0 {
                    // State says open but no failures counted — treat as closed.
                    // This can happen if record_success() reset failures but another
                    // thread already observed the OPEN state.
                    return true;
                }
                let now = self.nanos_since_creation();
                let last_failure = self.last_failure_nanos.load(Ordering::SeqCst);
                // last_failure == 0 means the failure was recorded within <1ns of
                // creation. In that case the time since failure is simply `now`.
                let time_since_failure = Duration::from_nanos(now.saturating_sub(last_failure));
                if time_since_failure >= self.recovery_timeout {
                    self.state.store(STATE_HALF_OPEN, Ordering::SeqCst);
                    true
                } else {
                    false
                }
            }
            STATE_HALF_OPEN => true,
            _ => false,
        }
    }

    /// Record a successful request. Closes the circuit and resets failure count.
    pub fn record_success(&self) {
        self.failures.store(0, Ordering::SeqCst);
        self.state.store(STATE_CLOSED, Ordering::SeqCst);
    }

    /// Record a failed request. Increments the failure count and opens the circuit
    /// if the threshold is reached.
    pub fn record_failure(&self) {
        let failures = self.failures.fetch_add(1, Ordering::SeqCst) + 1;
        self.last_failure_nanos.store(self.nanos_since_creation(), Ordering::SeqCst);

        if failures >= self.failure_threshold {
            self.state.store(STATE_OPEN, Ordering::SeqCst);
        }
    }

    /// Get the current state name for logging/monitoring.
    pub fn state_name(&self) -> &'static str {
        match self.state.load(Ordering::SeqCst) {
            STATE_CLOSED => "closed",
            STATE_OPEN => "open",
            STATE_HALF_OPEN => "half-open",
            _ => "unknown",
        }
    }

    /// Returns true if the circuit is currently OPEN (tripped).
    /// Unlike `allow_request()`, this is a side-effect-free read — it does not
    /// transition from OPEN to HALF_OPEN even if the recovery timeout has elapsed.
    pub fn is_open(&self) -> bool {
        self.state.load(Ordering::SeqCst) == STATE_OPEN
    }

    /// Get the current failure count (for testing).
    #[cfg(test)]
    fn failure_count(&self) -> u32 {
        self.failures.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    // === Initial state ===

    #[test]
    fn starts_in_closed_state() {
        let cb = CircuitBreaker::new(3, 10);
        assert_eq!(cb.state_name(), "closed");
        assert_eq!(cb.failure_count(), 0);
    }

    #[test]
    fn allows_requests_when_closed() {
        let cb = CircuitBreaker::new(3, 10);
        assert!(cb.allow_request());
    }

    // === Transition to open after threshold failures ===

    #[test]
    fn stays_closed_until_threshold_reached() {
        let cb = CircuitBreaker::new(3, 10);

        cb.record_failure();
        assert_eq!(cb.state_name(), "closed");
        assert!(cb.allow_request());

        cb.record_failure();
        assert_eq!(cb.state_name(), "closed");
        assert!(cb.allow_request());
    }

    #[test]
    fn opens_after_threshold_failures() {
        let cb = CircuitBreaker::new(3, 10);

        cb.record_failure();
        cb.record_failure();
        cb.record_failure();

        assert_eq!(cb.state_name(), "open");
        assert!(!cb.allow_request());
    }

    #[test]
    fn rejects_requests_when_open() {
        let cb = CircuitBreaker::new(1, 10);
        cb.record_failure();

        assert!(!cb.allow_request());
    }

    // === Recovery: open → half-open → closed ===

    #[test]
    fn transitions_to_half_open_after_recovery_timeout() {
        // Use a 200ms timeout so we can test quickly and reliably
        let cb = CircuitBreaker::new_with_millis(1, 200);

        cb.record_failure();
        assert_eq!(cb.state_name(), "open");

        // Wait for recovery timeout + small buffer to avoid race with Instant
        std::thread::sleep(Duration::from_millis(250));

        assert!(cb.allow_request());
        assert_eq!(cb.state_name(), "half-open");
    }

    #[test]
    fn closes_on_success_in_half_open() {
        let cb = CircuitBreaker::new_with_millis(1, 200);

        cb.record_failure();
        std::thread::sleep(Duration::from_millis(250));
        cb.allow_request(); // transitions to half-open

        cb.record_success();

        assert_eq!(cb.state_name(), "closed");
        assert!(cb.allow_request());
    }

    #[test]
    fn reopens_on_failure_in_half_open() {
        let cb = CircuitBreaker::new_with_millis(1, 200);

        cb.record_failure();
        std::thread::sleep(Duration::from_millis(250));
        cb.allow_request(); // transitions to half-open

        cb.record_failure();

        assert_eq!(cb.state_name(), "open");
        assert!(!cb.allow_request());
    }

    // === Success resets failures ===

    #[test]
    fn success_resets_failure_count() {
        let cb = CircuitBreaker::new(3, 10);

        cb.record_failure();
        cb.record_failure();
        cb.record_success();

        assert_eq!(cb.failure_count(), 0);

        // Need 3 more failures to open again
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state_name(), "closed");

        cb.record_failure();
        assert_eq!(cb.state_name(), "open");
    }

    // === Edge cases ===

    #[test]
    fn is_open_returns_false_when_closed() {
        let cb = CircuitBreaker::new(3, 10);
        assert!(!cb.is_open());
    }

    #[test]
    fn is_open_returns_true_when_tripped() {
        let cb = CircuitBreaker::new(3, 10);
        cb.record_failure();
        cb.record_failure();
        cb.record_failure();
        assert!(cb.is_open());
    }

    #[test]
    fn is_open_has_no_side_effects_on_timeout() {
        // is_open() must NOT transition OPEN → HALF_OPEN even after timeout elapses.
        let cb = CircuitBreaker::new(1, 1);
        cb.record_failure();
        assert!(cb.is_open());

        std::thread::sleep(Duration::from_millis(1100));

        // is_open() still reports OPEN
        assert!(cb.is_open());

        // But allow_request() transitions to HALF_OPEN
        assert!(cb.allow_request());
        assert_eq!(cb.state_name(), "half-open");
        // After allow_request() side-effect, is_open() correctly reports false
        assert!(!cb.is_open());
    }

    #[test]
    fn threshold_of_one_opens_immediately() {
        let cb = CircuitBreaker::new(1, 10);
        cb.record_failure();
        assert_eq!(cb.state_name(), "open");
    }

    #[test]
    fn allows_request_initially_with_high_threshold() {
        let cb = CircuitBreaker::new(100, 30);
        for _ in 0..50 {
            assert!(cb.allow_request());
            cb.record_success();
        }
    }

    #[test]
    fn concurrent_failures_thread_safety() {
        use std::sync::Arc;
        use std::thread;

        let cb = Arc::new(CircuitBreaker::new(5, 10));
        let mut handles = vec![];

        for _ in 0..10 {
            let cb_clone = cb.clone();
            handles.push(thread::spawn(move || {
                cb_clone.record_failure();
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        // At least 5 failures should have triggered open state
        assert!(cb.failure_count() >= 5);
        assert_eq!(cb.state_name(), "open");
    }

    #[test]
    fn concurrent_success_and_failure_thread_safety() {
        use std::sync::Arc;
        use std::thread;

        let cb = Arc::new(CircuitBreaker::new(3, 10));
        let mut handles = vec![];

        // Record 2 failures
        cb.record_failure();
        cb.record_failure();

        // Concurrent successes and failures
        for i in 0..10 {
            let cb_clone = cb.clone();
            handles.push(thread::spawn(move || {
                if i % 2 == 0 {
                    cb_clone.record_failure();
                } else {
                    cb_clone.record_success();
                }
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        // State should be either closed or open, never inconsistent
        let state = cb.state_name();
        assert!(state == "closed" || state == "open");
    }
}
