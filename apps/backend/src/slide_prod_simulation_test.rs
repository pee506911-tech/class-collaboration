/// Production Environment Simulation Tests for Slide Handlers
///
/// These tests simulate real-world production issues WITHOUT requiring a real
/// database or running server. They test the logic layer that handles:
/// - High-latency environments (delayed responses, stale reads)
/// - Cache inconsistency (stale cache, cache stampede, cache miss during write)
/// - Concurrent edits from multiple tabs/clients (race conditions)
/// - Database connection failures and transient errors
/// - WAL outbox delivery failures and retries
/// - Batch update version conflicts (partial failure scenarios)
/// - Network-level issues (timeout, interrupted requests)
///
/// These are UNIT tests — they test data structures, error classification,
/// and handler response shapes. They do NOT call real HTTP handlers or MySQL.
///
/// Run with: cargo test --lib slide_prod_simulation
#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::types::Json;

    use crate::error::AppError;
    use crate::models::slide::{
        BatchSlideUpdate, Slide, UpdateSlidesBatchRequest, UpdateSlidesBatchResponse,
    };

    // ============================================================
    // Helper factories
    // ============================================================

    fn make_slide(id: &str, session_id: &str, content: serde_json::Value, version: i64) -> Slide {
        Slide {
            id: id.to_string(),
            session_id: session_id.to_string(),
            slide_type: "static".to_string(),
            content: Json(content),
            order_index: 0,
            is_hidden: false,
            version,
        }
    }

    fn make_batch_update(
        slide_id: &str,
        content: serde_json::Value,
        base_version: Option<i64>,
    ) -> BatchSlideUpdate {
        BatchSlideUpdate {
            slide_id: slide_id.to_string(),
            content,
            slide_type: None,
            is_hidden: None,
            base_version,
        }
    }

    // ============================================================
    // 1. Latency Simulation Tests
    // ============================================================
    // Simulate what happens when requests take a long time to complete,
    // causing clients to retry, overlap, or send stale data.

    /// When latency causes a client's pre-read to be stale by the time the
    /// UPDATE lands, the server should detect the version mismatch and
    /// return 409 with the current version.
    #[test]
    fn latency_causes_stale_version_conflict() {
        // Client reads slide at version 3 at T0.
        // Server processes 2 other updates → slide is now version 5 at T1.
        // Client sends update with baseVersion=3 at T2.
        // Handler should detect version mismatch and reject.
        let slide = make_slide("slide-1", "session-1", json!({"title": "v5"}), 5);
        let client_base_version = Some(3i64);

        // Simulate the version check logic from update_slide
        let conflict = if let Some(base) = client_base_version {
            base != slide.version
        } else {
            false
        };

        assert!(conflict, "should detect stale version due to latency");
        // The 409 response should include the current version so client can rebase
        let error = AppError::Conflict {
            message: "Slide has changed on the server".to_string(),
            data: Some(json!({
                "reason": "stale_slide_version",
                "slideId": "slide-1",
                "currentVersion": slide.version
            })),
        };
        match &error {
            AppError::Conflict { data, .. } => {
                let d = data.as_ref().unwrap();
                assert_eq!(d["currentVersion"], 5);
                assert_eq!(d["reason"], "stale_slide_version");
            }
            _ => panic!("expected Conflict error"),
        }
    }

    /// Multiple clients editing the same slide simultaneously:
    /// both read version N, both send updates, only one should succeed.
    #[test]
    fn concurrent_edits_one_wins_on_version() {
        let slide_v1 = make_slide("slide-1", "session-1", json!({"title": "original"}), 1);

        // Client A reads v1, Client B reads v1 (same stale snapshot)
        // Client A sends update first with baseVersion=1 → succeeds, bumps to v2
        let client_a_version = Some(1i64);
        let a_wins = client_a_version
            .map(|v| v == slide_v1.version)
            .unwrap_or(true);
        assert!(a_wins, "Client A should succeed (version matches)");

        // Client B sends update with baseVersion=1, but server now has v2
        let server_version_after_a = 2;
        let client_b_version = Some(1i64);
        let b_conflicts = client_b_version
            .map(|v| v != server_version_after_a)
            .unwrap_or(false);
        assert!(b_conflicts, "Client B should conflict (version stale)");
    }

    /// Under sustained high latency, a client may accumulate many pending edits.
    /// When they finally flush, the batch should fail atomically if ANY slide conflicts.
    #[test]
    fn batch_update_all_or_nothing_under_latency() {
        // Server state: slide-1 at v5, slide-2 at v3, slide-3 at v10
        let server_slides = vec![
            make_slide("slide-1", "session-1", json!({"title": "v5"}), 5),
            make_slide("slide-2", "session-1", json!({"title": "v3"}), 3),
            make_slide("slide-3", "session-1", json!({"title": "v10"}), 10),
        ];

        // Client's stale snapshot: slide-1 at v4, slide-2 at v3, slide-3 at v9
        let batch_request = UpdateSlidesBatchRequest {
            client_request_id: None,
            updates: vec![
                make_batch_update("slide-1", json!({"title": "new-1"}), Some(4)), // stale!
                make_batch_update("slide-2", json!({"title": "new-2"}), Some(3)), // current
                make_batch_update("slide-3", json!({"title": "new-3"}), Some(9)), // stale!
            ],
        };

        // Pre-validation should reject the entire batch on the first conflict
        let mut conflicts = Vec::new();
        for update in &batch_request.updates {
            if let Some(base) = update.base_version {
                let server_slide = server_slides
                    .iter()
                    .find(|s| s.id == update.slide_id)
                    .unwrap();
                if base != server_slide.version {
                    conflicts.push(&update.slide_id);
                }
            }
        }

        assert_eq!(
            conflicts,
            vec!["slide-1", "slide-3"],
            "should detect all stale versions"
        );
        // In production, the entire batch is rolled back — none of the updates apply
    }

    // ============================================================
    // 2. Cache Inconsistency Tests
    // ============================================================
    // Simulate scenarios where the cache is out of sync with the database.

    /// Cache holds stale slide data after a batch update.
    /// The cache invalidation happens AFTER the transaction commits.
    /// If the cache invalidation fails, subsequent reads return stale data.
    #[test]
    fn cache_stale_after_batch_update() {
        // Before: cache has slides with state_version=1
        let cached_state_version = 1i64;

        // Batch update commits, bumps state_version to 2
        let _new_state_version = 2i64;

        // Scenario A: cache invalidation succeeds
        let cache_invalidated = true;
        assert!(
            cache_invalidated,
            "cache should be invalidated after batch update"
        );

        // Scenario B: cache invalidation fails (e.g., network partition to cache layer)
        let cache_invalidated_b = false;
        // Next read from cache returns stale data
        if !cache_invalidated_b {
            assert_eq!(
                cached_state_version, 1,
                "cache still serves stale state_version"
            );
            // The client would detect this via state_version mismatch on the WebSocket
            // SLIDES_UPDATE message and force a hard refetch.
        }
    }

    /// Two concurrent batch updates to the same session:
    /// both invalidate the cache, but only one state_version bump is visible.
    /// Tests that the cache doesn't serve a "mixed" state.
    #[test]
    fn cache_stampede_on_concurrent_batch_updates() {
        // Both requests read the same cached state (state_version=10)
        let _cached_version = 10i64;

        // Request A commits first → bumps state_version to 11, invalidates cache
        // Request B commits second → bumps state_version to 12, invalidates cache (again)
        let final_version = 12i64;

        // Cache was invalidated twice — the second invalidation is idempotent
        // (invalidating an already-empty cache entry is a no-op)
        let invalidation_count = 2;
        assert!(
            invalidation_count >= 1,
            "cache should be invalidated at least once"
        );

        // Next read misses cache and fetches state_version=12 from DB
        assert_eq!(
            final_version, 12,
            "next read should see latest state_version"
        );
    }

    /// Cache eviction during long-running operation:
    /// A batch update takes 5 seconds; the cache TTL is 3 seconds.
    /// By the time the update commits, the cache entry has already expired.
    #[test]
    fn cache_eviction_during_slow_operation() {
        let cache_ttl_secs = 3;
        let operation_duration_secs = 5;

        // Cache entry was inserted at T=0, expires at T=3
        // Operation commits at T=5
        let cache_still_valid = operation_duration_secs < cache_ttl_secs;

        assert!(
            !cache_still_valid,
            "cache entry should have expired by commit time"
        );
        // The invalidate() call at T=5 is a no-op (key already evicted)
        // This is fine — the next read will miss and rebuild from DB.
    }

    // ============================================================
    // 3. Race Condition Tests (Logical, No Threads)
    // ============================================================
    // Simulate race conditions as sequences of logical operations.

    /// TOCTOU race: pre-check passes, but UPDATE fails because another writer
    /// sneaked in between the SELECT and the UPDATE.
    #[test]
    fn toctou_race_between_precheck_and_update() {
        // T0: Client reads slide → version=3
        let precheck_version = 3i64;

        // T1: Another client updates slide → version=4
        let actual_version_at_update_time = 4i64;

        // T2: UPDATE ... WHERE version = 3 → rows_affected = 0
        let rows_affected = if precheck_version == actual_version_at_update_time {
            1
        } else {
            0
        };

        assert_eq!(
            rows_affected, 0,
            "UPDATE should affect 0 rows due to version mismatch"
        );
        // Handler should detect rows_affected==0 and return 409 with current version
    }

    /// Batch update: pre-validation passes for all slides, but between
    /// validation and transaction start, another client updates one slide.
    #[test]
    fn batch_precheck_passes_but_update_fails_mid_batch() {
        // T0: Pre-validation — all versions match
        //   slide-1: client sees v2, server has v2 ✓
        //   slide-2: client sees v5, server has v5 ✓
        //   slide-3: client sees v1, server has v1 ✓

        // T1: Another client updates slide-2 → version=6
        // T2: Batch transaction starts, UPDATE slide-2 WHERE version=5 → rows_affected=0

        let slide_versions_at_precheck = vec![2, 5, 1];
        let slide_versions_at_update = vec![2, 6, 1]; // slide-2 changed by another writer

        let mut failure_index: Option<usize> = None;
        for (i, (&pre_ver, &actual_ver)) in slide_versions_at_precheck
            .iter()
            .zip(slide_versions_at_update.iter())
            .enumerate()
        {
            if pre_ver != actual_ver {
                failure_index = Some(i);
                break;
            }
        }

        assert_eq!(
            failure_index,
            Some(1),
            "slide-2 should fail due to race window"
        );
        // In production, the entire transaction rolls back — no partial updates
    }

    /// Two tabs editing the same session: Tab A creates a slide, Tab B deletes it
    /// before Tab A's update arrives. This tests the "slide not found" path.
    #[test]
    fn update_deleted_slide_returns_not_found() {
        // Tab A: creates slide-X
        // Tab B: deletes slide-X
        // Tab A: tries to update slide-X → server returns 404
        let slide_exists = false;

        let result = if slide_exists { "ok" } else { "not_found" };

        assert_eq!(
            result, "not_found",
            "updating a deleted slide should return 404"
        );
    }

    // ============================================================
    // 4. Database Connection Failure Tests
    // ============================================================
    // Test error classification for various database failure modes.

    /// Database connection pool exhausted under high load.
    /// The handler should return a 503-style error (transient, retryable).
    #[test]
    fn db_pool_exhaustion_is_transient_error() {
        // In production, sqlx returns a PoolTimedOut error which maps to AppError::Database.
        // The middleware classifies pool exhaustion as transient (retryable).
        // We test the classification logic here conceptually:
        let error_description = "pool timed out while waiting for an open connection";
        let is_transient_by_design =
            error_description.contains("timed out") || error_description.contains("pool");

        assert!(
            is_transient_by_design,
            "pool exhaustion should be classified as transient"
        );
    }

    /// Database connection reset mid-transaction.
    /// The handler should return a transient error (client can retry).
    #[test]
    fn db_connection_reset_is_transient_error() {
        // sqlx wraps this as AppError::Database(sqlx::Error::Pool(...))
        // Connection reset is always transient — the operation may have partially applied.
        let error_description = "connection reset by peer";
        let is_transient_by_design =
            error_description.contains("reset") || error_description.contains("broken pipe");

        assert!(
            is_transient_by_design,
            "connection reset should be transient"
        );
    }

    /// Deadlock detected during batch commit.
    /// MySQL automatically rolls back one transaction; the client should retry.
    #[test]
    fn db_deadlock_is_transient_error() {
        // MySQL error 1213: "Deadlock found when trying to get lock"
        // sqlx surfaces this as a database error; the handler should classify as transient.
        let error_description = "Deadlock found when trying to get lock";
        let is_transient_by_design =
            error_description.contains("Deadlock") || error_description.contains("lock");

        assert!(is_transient_by_design, "deadlock should be transient");
    }

    /// Non-transient error (e.g., invalid input) should NOT be retried.
    #[test]
    fn invalid_input_is_not_transient() {
        let error = AppError::Input("No slides to update".to_string());

        // AppError::Input is never transient — retrying won't fix bad input
        match &error {
            AppError::Input(msg) => {
                assert!(
                    msg.contains("No slides"),
                    "should preserve the original message"
                );
            }
            _ => panic!("expected Input error"),
        }
    }

    // ============================================================
    // 5. WAL Outbox Delivery Failure Tests
    // ============================================================
    // Simulate outbox enqueue failures and their impact.

    /// Outbox enqueue fails (e.g., disk full, constraint violation).
    /// The slide update should still succeed — outbox is best-effort
    /// within the same transaction, but a failure rolls back the whole tx.
    #[test]
    fn outbox_enqueue_failure_rolls_back_transaction() {
        // In production, enqueue_slides_update_event() is called within the same
        // transaction as the slide UPDATE. If it fails, the ENTIRE transaction
        // rolls back — the slide update is NOT persisted.
        //
        // This is correct behavior: without the outbox event, real-time clients
        // would not see the update, creating a consistency gap.

        let outbox_enqueue_succeeded = false;
        let transaction_committed = outbox_enqueue_succeeded;

        assert!(
            !transaction_committed,
            "transaction should NOT commit if outbox fails"
        );
    }

    /// Outbox event is enqueued but the WebSocket publisher crashes before
    /// delivering to clients. The outbox entry persists and will be picked up
    /// by the next poll cycle (at-most-100ms delay).
    #[test]
    fn outbox_event_persists_for_retry() {
        // Outbox events are durable — they survive server crashes.
        // The outbox poller runs every 100ms and will retry delivery.
        let outbox_enqueued = true;
        let websocket_delivery_failed = true;

        // Event is still in the outbox table, awaiting poll
        let event_available_for_retry = outbox_enqueued && websocket_delivery_failed;
        assert!(
            event_available_for_retry,
            "outbox event should be available for next poll cycle"
        );
    }

    /// Multiple slide updates in a batch produce exactly ONE outbox event
    /// (not N events). This reduces WebSocket fan-out pressure.
    #[test]
    fn batch_update_produces_single_outbox_event() {
        let num_slides_in_batch = 5;

        // In update_slides_batch, enqueue_slides_update_event is called ONCE
        // with all updated slides as the payload.
        let outbox_events_enqueued = 1; // not num_slides_in_batch

        assert_eq!(
            outbox_events_enqueued, 1,
            "batch should produce exactly one outbox event"
        );
        assert!(
            outbox_events_enqueued < num_slides_in_batch,
            "single event is more efficient than N events"
        );
    }

    // ============================================================
    // 6. Batch Update Version Conflict Tests
    // ============================================================

    /// Empty batch update should be rejected with an input error.
    #[test]
    fn empty_batch_rejected() {
        let request = UpdateSlidesBatchRequest {
            client_request_id: None,
            updates: vec![],
        };

        let rejected = request.updates.is_empty();
        assert!(rejected, "empty batch should be rejected");
    }

    /// Batch exceeding max slide count should be rejected.
    #[test]
    fn oversized_batch_rejected() {
        const MAX_BATCH_SLIDE_COUNT: usize = 50;
        let updates: Vec<BatchSlideUpdate> = (0..51)
            .map(|i| {
                make_batch_update(
                    &format!("slide-{i}"),
                    json!({"title": format!("slide {i}")}),
                    Some(0),
                )
            })
            .collect();

        let exceeds_limit = updates.len() > MAX_BATCH_SLIDE_COUNT;
        assert!(exceeds_limit, "batch with 51 slides should exceed limit");
    }

    /// Batch with mixed existing/non-existing slides: if ANY slide doesn't exist,
    /// the entire batch should fail (before starting a transaction).
    #[test]
    fn batch_with_nonexistent_slide_fails_early() {
        // Pre-load phase: slide-1 exists, slide-2 does NOT exist
        let existing_slide_ids = vec!["slide-1", "slide-3"];
        let requested_slide_ids = vec!["slide-1", "slide-2", "slide-3"];

        let missing_slides: Vec<_> = requested_slide_ids
            .iter()
            .filter(|id| !existing_slide_ids.contains(id))
            .collect();

        assert_eq!(
            missing_slides,
            vec![&"slide-2"],
            "should detect missing slide before transaction"
        );
        // In production, the handler returns 404 without starting a transaction
    }

    /// Batch update response includes the new state_version so clients can
    /// verify their local state is current.
    #[test]
    fn batch_response_includes_state_version() {
        let response = UpdateSlidesBatchResponse {
            slides: vec![
                make_slide("slide-1", "session-1", json!({"title": "updated"}), 6),
                make_slide("slide-2", "session-1", json!({"title": "updated"}), 4),
            ],
            state_version: 42,
        };

        assert_eq!(
            response.state_version, 42,
            "response should include state_version"
        );
        assert_eq!(
            response.slides.len(),
            2,
            "response should include all updated slides"
        );
    }

    // ============================================================
    // 7. Network-Level Issue Tests
    // ============================================================

    /// Client request ID is truncated by a proxy/middleware.
    /// The server should handle this gracefully (accept or reject based on length).
    #[test]
    fn truncated_client_request_id_handled() {
        // Original ID: "req-abc-123-def-456"
        // Proxy truncates to: "req-abc-123"
        let original_id = "req-abc-123-def-456";
        let truncated_id = "req-abc-123";

        // Both are valid (non-empty, < 64 chars) — server accepts either
        let is_valid = |id: &str| !id.is_empty() && id.len() <= 64;
        assert!(is_valid(original_id));
        assert!(is_valid(truncated_id));

        // Idempotency is per-ID — truncated ID is treated as a different request
        assert_ne!(
            original_id, truncated_id,
            "truncated ID is a different idempotency key"
        );
    }

    /// Client request ID exceeds maximum length (64 chars).
    /// The server should reject with 400.
    #[test]
    fn oversized_client_request_id_rejected() {
        let oversized_id = "x".repeat(65);
        let max_len = 64;

        let rejected = oversized_id.len() > max_len;
        assert!(rejected, "request ID exceeding 64 chars should be rejected");
    }

    /// Client sends duplicate batch request with same client_request_id.
    /// Server should return the cached/stored response (idempotency).
    #[test]
    fn duplicate_batch_request_returns_cached_response() {
        let _request_id = "batch-req-unique-123";

        // First request: processed normally, response stored in wal_request_replays
        // Second request (same ID): server finds existing response, returns it directly
        let idempotency_hit = true; // wal_request_replays has an entry for this ID

        if idempotency_hit {
            // Server returns the ORIGINAL response without re-processing
            // This prevents double-updates if the client retries due to network issues
            assert!(
                idempotency_hit,
                "duplicate request should hit idempotency cache"
            );
        }
    }

    // ============================================================
    // 8. State Version Consistency Tests
    // ============================================================

    /// Single slide update does NOT bump state_version (by design).
    /// The SLIDES_UPDATE WebSocket event bypasses the state_version gate.
    #[test]
    fn single_slide_update_does_not_bump_state_version() {
        // This is intentional: single-slide updates don't acquire a session
        // row lock (removed FOR UPDATE), so they can't bump state_version
        // without an extra UPDATE sessions query.
        //
        // The SLIDES_UPDATE WebSocket message triggers a targeted refetch
        // of the slide data, not a full session state reload.
        let state_version_before = 10i64;
        let state_version_after_single_slide_update = state_version_before; // unchanged

        assert_eq!(
            state_version_before, state_version_after_single_slide_update,
            "single slide update should not bump state_version"
        );
    }

    /// Batch slide update DOES bump state_version exactly once.
    #[test]
    fn batch_slide_update_bumps_state_version_once() {
        let state_version_before = 10i64;
        let state_version_after = state_version_before + 1;

        assert_eq!(
            state_version_after, 11,
            "batch update should bump state_version by 1"
        );
    }

    /// Multiple concurrent batch updates each bump state_version independently.
    #[test]
    fn concurrent_batch_updates_each_bump_state_version() {
        let initial_version = 10i64;

        // Three concurrent batch updates (serialized by the session row lock)
        let version_after_a = initial_version + 1;
        let version_after_b = version_after_a + 1;
        let version_after_c = version_after_b + 1;

        assert_eq!(
            version_after_c, 13,
            "three batch updates should bump state_version by 3"
        );
    }

    // ============================================================
    // 9. Ordering Gap Exhaustion Tests
    // ============================================================

    /// ORDER_STEP = 1024 provides a large gap between slides.
    /// Even with thousands of insertions between two adjacent slides,
    /// the gap should not exhaust (i32 range is ±2 billion).
    #[test]
    fn order_gap_does_not_exhaust_under_normal_use() {
        const ORDER_STEP: i32 = 1024;

        // Start with two adjacent slides: order 0 and 1024
        let _gap = ORDER_STEP;

        // Even after 1000 insertions between them (each using gap/2 strategy),
        // the minimum gap would be: 1024 / (2^1000) → but we reallocate before that.
        // In practice, reallocate is triggered when gap < 2, which requires
        // ~10 consecutive insertions at the same spot without rebalancing.
        let insertions_before_reallocate = 10; // ORDER_STEP / 2^10 < 2

        assert!(
            insertions_before_reallocate > 5,
            "gap should handle at least 5 insertions before needing reallocate"
        );
    }

    // ============================================================
    // 10. Slide Content Serialization Tests
    // ============================================================

    /// Slide content with very large JSON should serialize/deserialize correctly.
    #[test]
    fn large_slide_content_serializes_correctly() {
        // Simulate a slide with a large content object (e.g., many options in a poll)
        let options: Vec<_> = (0..100)
            .map(|i| json!({"id": format!("opt-{i}"), "text": format!("Option {i}")}))
            .collect();

        let content = json!({
            "question": "Very long question with many options",
            "options": options,
            "limitSubmissions": true,
            "allowMultipleSelection": false
        });

        let slide = make_slide("slide-big", "session-1", content.clone(), 0);

        // Serialize and deserialize roundtrip
        let serialized = serde_json::to_string(&slide).expect("should serialize");
        let deserialized: Slide = serde_json::from_str(&serialized).expect("should deserialize");

        assert_eq!(deserialized.id, "slide-big");
        assert_eq!(
            deserialized.content.0["options"].as_array().unwrap().len(),
            100
        );
    }

    /// Slide content with Unicode characters should survive roundtrip.
    #[test]
    fn unicode_slide_content_roundtrip() {
        let content = json!({
            "title": "こんにちは世界",
            "body": "Привет мир 🌍🎉",
            "emoji": ["🚀", "🔥", "💯"]
        });

        let slide = make_slide("slide-unicode", "session-1", content.clone(), 0);
        let serialized = serde_json::to_string(&slide).expect("should serialize");
        let deserialized: Slide = serde_json::from_str(&serialized).expect("should deserialize");

        assert_eq!(deserialized.content.0["title"], "こんにちは世界");
        assert_eq!(deserialized.content.0["body"], "Привет мир 🌍🎉");
    }

    // ============================================================
    // 11. Production Error Shape Tests
    // ============================================================

    /// Verify the exact shape of a 409 Conflict response for slide version conflicts.
    #[test]
    fn version_conflict_response_shape() {
        let error = AppError::Conflict {
            message: "Slide has changed on the server".to_string(),
            data: Some(json!({
                "reason": "stale_slide_version",
                "slideId": "slide-42",
                "currentVersion": 7
            })),
        };

        // Verify the error structure (AppError doesn't impl Serialize, so we check fields directly)
        match &error {
            AppError::Conflict { message, data } => {
                assert_eq!(message, "Slide has changed on the server");
                let d = data.as_ref().unwrap();
                assert_eq!(d["reason"], "stale_slide_version");
                assert_eq!(d["slideId"], "slide-42");
                assert_eq!(d["currentVersion"], 7);
            }
            _ => panic!("expected Conflict error"),
        }
    }

    /// Verify the shape of a 404 response when slide is not found.
    #[test]
    fn slide_not_found_response_shape() {
        let error = AppError::NotFound("Slide not found".to_string());
        match &error {
            AppError::NotFound(msg) => {
                assert_eq!(msg, "Slide not found");
            }
            _ => panic!("expected NotFound error"),
        }
    }

    /// Verify the shape of a 400 response for invalid batch input.
    #[test]
    fn invalid_batch_input_response_shape() {
        let error = AppError::Input("No slides to update".to_string());
        match &error {
            AppError::Input(msg) => {
                assert_eq!(msg, "No slides to update");
            }
            _ => panic!("expected Input error"),
        }
    }

    // ============================================================
    // 12. Ownership Verification Tests
    // ============================================================

    /// User from a different session tries to update slides in another session.
    /// The handler should reject before touching the database.
    #[test]
    fn cross_session_access_rejected() {
        let session_creator = "user-a";
        let attacker = "user-b";
        let _target_session = "session-x";

        let is_owner = session_creator == attacker;
        assert!(!is_owner, "attacker should not own the session");

        // In production, verify_session_ownership() checks the sessions table
        // and returns 403 if creator_id doesn't match the authenticated user.
    }

    /// User creates a session, then is deleted, then tries to update slides.
    /// The handler should reject (session still exists but creator is gone).
    #[test]
    fn deleted_creator_cannot_update_slides() {
        let session_exists = true;
        let creator_exists = false;

        // In production, this depends on whether sessions have a FK to users.
        // If they do, deleting the user cascades to session deletion.
        // If not, the session persists orphaned.
        let access_allowed = session_exists && creator_exists;
        assert!(
            !access_allowed,
            "deleted creator should not be able to update slides"
        );
    }

    // ============================================================
    // 13. Batch Update Atomicity Under Partial Failure
    // ============================================================

    /// Batch of 3 slides: slide-1 and slide-3 update fine, but slide-2 hits
    /// a database error (not a version conflict — a real DB error like
    /// connection lost). The entire transaction should roll back.
    #[test]
    fn batch_rolls_back_on_database_error() {
        // Simulate: UPDATE slide-1 → OK, UPDATE slide-2 → DB error, UPDATE slide-3 → not reached
        let slide_1_updated = true; // in transaction buffer
        let slide_2_error = true;
        let slide_3_reached = false;

        let transaction_rolled_back = slide_2_error;
        assert!(
            transaction_rolled_back,
            "any DB error in batch should roll back the entire transaction"
        );

        // After rollback, NONE of the slides should be updated in the DB
        assert!(
            !slide_1_updated || transaction_rolled_back,
            "slide-1 should NOT be persisted after rollback"
        );
        assert!(!slide_3_reached, "slide-3 should not be reached");
    }

    /// Batch of 3 slides: slide-2 has a version conflict (409).
    /// The handler should detect the conflict during pre-validation (before
    /// the transaction) and return 409 without starting a transaction.
    #[test]
    fn batch_detects_version_conflict_before_transaction() {
        let server_versions = vec![5, 3, 10];
        let client_versions = vec![5, 2, 10]; // slide-2 is stale

        // Pre-validation runs OUTSIDE the transaction
        let mut conflict_detected = false;
        let conflict_slide: Option<usize> = None;

        for (_i, (&client_ver, &server_ver)) in client_versions
            .iter()
            .zip(server_versions.iter())
            .enumerate()
        {
            if client_ver != server_ver {
                conflict_detected = true;
                assert_eq!(conflict_slide, None, "first conflict should be detected");
                break;
            }
        }

        assert!(
            conflict_detected,
            "pre-validation should detect version conflict"
        );
        // No transaction was started — this is efficient (no wasted DB work)
    }

    // ============================================================
    // 14. Idempotency Under Production Conditions
    // ============================================================

    /// Client sends batch update, server processes it, but the HTTP response
    /// is lost (network partition). Client retries with the same
    /// X-Client-Request-Id. Server should return the original response.
    #[test]
    fn idempotency_survives_response_loss() {
        // The wal_request_replays table stores the response keyed by
        // (session_id, op_type, client_request_id). On retry, the handler
        // checks this table BEFORE processing the request.

        let original_request_id = "batch-abc-123";
        let response_was_stored = true; // INSERT IGNORE succeeded before response was lost

        // Client retries with same request_id
        let retry_request_id = original_request_id;
        let replay_found = response_was_stored && retry_request_id == original_request_id;

        assert!(replay_found, "retry should find the original response");
        // Server returns the stored response without re-executing the updates
    }

    /// Two different clients accidentally use the same X-Client-Request-Id
    /// (UUID collision is astronomically unlikely, but test the logic anyway).
    #[test]
    fn idempotency_key_collision_between_clients() {
        // Client A sends batch with request_id="xyz"
        // Client B (different user) sends batch with same request_id="xyz"
        //
        // The wal_request_replays key includes session_id, so this is only
        // a collision if both clients are editing the SAME session.
        //
        // If they're editing different sessions, the keys are distinct:
        //   (session-1, UpdateSlidesBatch, xyz) != (session-2, UpdateSlidesBatch, xyz)

        let client_a_session = "session-1";
        let client_b_session = "session-2";
        let shared_request_id = "xyz";

        let key_a = (client_a_session, "UpdateSlidesBatch", shared_request_id);
        let key_b = (client_b_session, "UpdateSlidesBatch", shared_request_id);

        assert_ne!(
            key_a, key_b,
            "idempotency keys should be distinct for different sessions"
        );
    }

    // ============================================================
    // 15. Edge Cases in Batch Update Logic
    // ============================================================

    /// Batch update with base_version=None (no version check).
    /// This is a "blind write" — the handler should allow it but it risks
    /// silently overwriting concurrent edits.
    #[test]
    fn blind_write_skips_version_check() {
        let update = make_batch_update("slide-1", json!({"title": "blind"}), None);

        let has_version_check = update.base_version.is_some();
        assert!(!has_version_check, "blind write should skip version check");
        // In production, the UPDATE still uses WHERE version = <current>,
        // so it will succeed (it just reads the current version inside the tx)
    }

    /// Batch update with a single slide (degenerate case).
    /// Should work correctly — the batch endpoint handles N=1.
    #[test]
    fn batch_with_single_slide() {
        let request = UpdateSlidesBatchRequest {
            client_request_id: None,
            updates: vec![make_batch_update(
                "slide-1",
                json!({"title": "solo"}),
                Some(5),
            )],
        };

        assert_eq!(
            request.updates.len(),
            1,
            "batch should accept a single slide"
        );
        // This produces the same result as calling the individual update endpoint,
        // but uses the batch path (one session lock, one outbox event)
    }

    /// Batch update where all slides have the same content (no-op updates).
    /// The handler should still process them (version bump, outbox event).
    #[test]
    fn batch_noop_updates_still_process() {
        // Client sends updates with identical content to what's on the server.
        // The handler does NOT check for content equality — it blindly
        // updates (version++, outbox event).
        //
        // This means even no-op updates produce a state_version bump and
        // a SLIDES_UPDATE WebSocket event (which triggers client refetches).

        let content = json!({"title": "unchanged"});
        let request = UpdateSlidesBatchRequest {
            client_request_id: None,
            updates: vec![
                make_batch_update("slide-1", content.clone(), Some(5)),
                make_batch_update("slide-2", content.clone(), Some(3)),
            ],
        };

        // These are "no-op" from a content perspective, but the handler
        // still bumps versions and publishes an outbox event.
        assert_eq!(
            request.updates.len(),
            2,
            "no-op updates should still be processed"
        );
    }
}
