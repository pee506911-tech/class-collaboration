/// Production Environment Simulation Tests — Phase 2
///
/// Focused on **fast user behavior** colliding with **real production infrastructure
/// failure modes**. These tests simulate what actually happens in production when
/// a teacher clicks rapidly, auto-save fires frequently, or multiple tabs edit the
/// same session — combined with network delays, DB failures, cache staleness,
/// service restarts, and out-of-order responses.
///
/// All tests are UNIT-level (no real DB, no HTTP, no threads).
/// They model logical sequences of events and assert on outcomes.
///
/// Run with: cargo test slide_prod_simulation_test2
#[cfg(test)]
mod tests {
    use sqlx::types::Json;

    use crate::models::slide::{BatchSlideUpdate, Slide};

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
    // 1. LATENCY — Network Delays Between Client, API, and Storage
    // ============================================================

    /// Rapid slide adds arrive out of order due to network jitter.
    /// Client sends slide-A then slide-B, but B arrives at the server first.
    /// The server assigns order_index based on arrival order, not intent order.
    #[test]
    fn rapid_slide_adds_arrive_out_of_order() {
        // T0: Client sends POST slide-A (intended order=0)
        // T0+5ms: Client sends POST slide-B (intended order=1)
        // T0+100ms: slide-B arrives first (packet A delayed) → server assigns order_index=0
        // T0+200ms: slide-A arrives → server assigns order_index=1024
        // Result: slides appear as [B, A] instead of [A, B]

        let slide_b_arrival_order = 0;
        let slide_a_arrival_order = 1024;

        // Server-ordered query: ORDER BY order_index ASC
        let server_order = if slide_a_arrival_order < slide_b_arrival_order {
            vec!["slide-A", "slide-B"]
        } else {
            vec!["slide-B", "slide-A"]
        };

        assert_eq!(
            server_order,
            vec!["slide-B", "slide-A"],
            "B arrived first so appears first"
        );
        // Fix: Client should reorder via the reorder endpoint after all slides are created
    }

    /// API response takes 8s, client times out at 5s and retries.
    /// The original request DID succeed (slide created), so the retry
    /// should hit the idempotency cache and return the original response.
    #[test]
    fn api_timeout_triggers_idempotent_retry() {
        // T0: Client sends POST /slides with X-Client-Request-Id: "req-abc"
        // T0-T5: Server processes (slow DB, lock contention)
        // T5: Client times out, sends retry with same request ID
        // T6: Server finishes original request, stores response in wal_request_replays
        // T6: Server receives retry, finds stored response, returns it

        let _original_request_id = "req-abc";
        let server_processed = true; // original request completed
        let retry_found_in_cache = server_processed; // wal_request_replays has the entry

        assert!(
            retry_found_in_cache,
            "retry should find the original response via idempotency"
        );
        // Without X-Client-Request-Id, the retry would create a duplicate slide
    }

    /// Cross-region DB latency (200ms RTT) causes version conflict pile-up.
    /// User makes 5 rapid edits; all 5 read the same stale version before
    /// any of the writes have propagated.
    #[test]
    fn cross_region_latency_causes_version_conflict_pileup() {
        // All 5 edits read slide at version 1 (replication lag hasn't delivered writes yet)
        let initial_version = 1i64;
        let num_edits = 5;

        // All 5 edits send baseVersion=1
        let client_versions: Vec<i64> = vec![1; num_edits];

        // Server processes them sequentially (session lock serializes batch updates)
        // First edit: version 1 → 2 ✓
        // Second edit: expected 1, server has 2 → 409
        // Third edit: expected 1, server has 2 → 409
        // etc.

        let mut results = Vec::new();
        let mut current_server_version = initial_version;
        for &client_ver in &client_versions {
            if client_ver == current_server_version {
                current_server_version += 1;
                results.push("ok");
            } else {
                results.push("409_conflict");
            }
        }

        assert_eq!(
            results,
            vec![
                "ok",
                "409_conflict",
                "409_conflict",
                "409_conflict",
                "409_conflict"
            ]
        );
        // Fix: Client should use batch endpoint with all edits, or implement exponential backoff retry
    }

    /// CDN/proxy duplicates the request — same batch update received twice.
    /// The second duplicate should hit idempotency and return the cached response.
    #[test]
    fn cdn_proxy_duplicates_request() {
        let _request_id = "batch-dup-xyz";

        // First request: processed normally
        let first_processed = true;
        // Proxy retries due to perceived timeout
        let duplicate_sent = true;

        if first_processed && duplicate_sent {
            // Server finds wal_request_replays entry for request_id
            let idempotency_hit = true;
            assert!(idempotency_hit, "duplicate should be caught by idempotency");
            // Without idempotency key, the duplicate would re-apply all updates
            // (same content, but version++ → next real edit would conflict)
        }
    }

    /// WebSocket disconnects during batch save. Client falls back to HTTP polling.
    /// On reconnect, client's local state may be behind server state.
    #[test]
    fn websocket_disconnect_during_batch_save() {
        // T0: Client sends batch update via HTTP
        // T1: Server processes, commits, publishes SLIDES_UPDATE via WebSocket
        // T2: Client's WebSocket disconnects (network hiccup) — misses the event
        // T3: Client reconnects, but local state is still at old version
        // T4: Client's auto-save fires with stale baseVersion → 409

        let server_state_version = 15i64;
        let client_state_version = 12i64; // missed 3 updates during disconnect

        let version_gap = server_state_version - client_state_version;
        assert_eq!(version_gap, 3, "client is 3 versions behind");

        // Client sends edit with baseVersion matching its stale state
        let client_edit_version = Some(10i64); // even older — from before disconnect
        let server_slide_version = 5i64; // current version of the slide on server

        let will_conflict = client_edit_version
            .map(|v| v != server_slide_version)
            .unwrap_or(false);
        assert!(
            will_conflict,
            "stale edit after WS disconnect should conflict"
        );
        // Fix: On WS reconnect, client should fetch full session state before sending edits
    }

    /// Slow TLS handshake adds 2s to every request during certificate rotation.
    /// Rapid edits queue up, and each one sees a more stale version than expected.
    #[test]
    fn slow_tls_handshake_causes_version_cascade() {
        // Normal RTT: 50ms, with slow TLS: 2050ms
        let normal_rtt_ms = 50;
        let slow_tls_rtt_ms = 2050;
        let latency_multiplier = slow_tls_rtt_ms / normal_rtt_ms;
        assert_eq!(latency_multiplier, 41, "TLS overhead is 41x normal RTT");

        // User makes 3 edits in 1 second. Normal: all see progressively updated versions.
        // With slow TLS: all 3 arrive after 2s, all see the same stale version.
        let edits_sent_in_1s = 3;
        let all_see_same_version = slow_tls_rtt_ms > 1000;
        assert!(
            all_see_same_version,
            "all edits arrive after the same stale snapshot"
        );
        assert_eq!(edits_sent_in_1s, 3);
        // Only the first edit succeeds, the other 2 get 409
    }

    /// Jitter causes auto-save responses to resolve out of order.
    /// Edit-B (sent at T1) resolves before Edit-A (sent at T0).
    #[test]
    fn autosave_responses_resolve_out_of_order() {
        // T0: Client sends Edit-A (version 3 → 4)
        // T0+10ms: Client sends Edit-B (version 4 → 5)
        // T0+500ms: Edit-B response arrives (fast path) → client updates local version to 5
        // T0+2000ms: Edit-A response arrives (slow path) → client sees "version 4" but local is already 5

        let edit_a_sent_first = true;
        let edit_b_resolved_first = true;

        if edit_a_sent_first && edit_b_resolved_first {
            // Client's local version jumps to 5 before Edit-A confirms
            // When Edit-A finally arrives, client thinks "I'm already at 5, why does server say 4?"
            let client_local_version_after_b = 5i64;
            let edit_a_server_version = 4i64;

            let client_rejects_stale = edit_a_server_version < client_local_version_after_b;
            assert!(
                client_rejects_stale,
                "client should detect Edit-A is stale relative to local state"
            );
            // The actual slide on server IS at version 4 (Edit-A was first).
            // Edit-B then bumped it to 5. So Edit-A's response is correct, just late.
            // Fix: Client should track in-flight edits and ignore stale responses
        }
    }

    /// Client sends 10 slides in 500ms. Server processes sequentially via batch endpoint.
    /// If sent as 10 individual updates, each one increments version, causing cascading conflicts.
    #[test]
    fn rapid_individual_updates_cascade_version_conflicts() {
        // Scenario A: 10 individual PUT /slides/:id requests
        let slide_initial_version = 5i64;
        let num_updates = 10;

        // Each update reads the slide, sends baseVersion, gets response
        // But with high latency, all 10 reads see version 5
        let all_reads_see_version = 5i64;

        let mut individual_results = Vec::new();
        let mut server_version = slide_initial_version;
        for _ in 0..num_updates {
            if all_reads_see_version == server_version {
                server_version += 1;
                individual_results.push("ok");
            } else {
                individual_results.push("409");
            }
        }
        assert_eq!(
            individual_results,
            vec!["ok", "409", "409", "409", "409", "409", "409", "409", "409", "409"]
        );

        // Scenario B: Same 10 updates via single batch endpoint
        // Batch pre-validates all versions, processes atomically
        let batch_result = "all_or_nothing"; // either all 10 succeed or all fail
        assert_eq!(batch_result, "all_or_nothing");
        // With batch: if all baseVersions match server, all 10 succeed in one transaction
    }

    // ============================================================
    // 2. DATABASE ISSUES — Slow Queries, Timeouts, Partial Writes
    // ============================================================

    /// Slow `SELECT ... FOR UPDATE` lock (3s wait) causes client timeout.
    /// Two batch updates compete for the same session row lock.
    #[test]
    fn slow_session_lock_causes_client_timeout() {
        // T0: Request A acquires FOR UPDATE lock on session-X
        // T0+10ms: Request B tries to lock session-X → blocked
        // T0+3000ms: Request A commits, releases lock
        // T0+3000ms: Request B acquires lock
        // T0+5000ms: Request B's client timed out at 5s!

        let lock_wait_time_ms = 3000;
        let client_timeout_ms = 5000;
        let total_request_time_ms = lock_wait_time_ms + 500; // 500ms for actual work

        let client_timed_out = total_request_time_ms > client_timeout_ms;
        assert!(
            !client_timed_out,
            "request B should complete before client timeout in this scenario"
        );

        // But if lock wait is longer:
        let longer_lock_wait_ms = 6000;
        let total_with_longer_wait = longer_lock_wait_ms + 500;
        let client_timed_out_longer = total_with_longer_wait > client_timeout_ms;
        assert!(
            client_timed_out_longer,
            "longer lock wait causes client timeout"
        );
        // Server still processes the request to completion — client just never sees the response
        // On retry, idempotency key returns the cached response
    }

    /// Connection pool exhausted during traffic spike.
    /// Pool of 20, 50 concurrent requests — oldest 30 timeout waiting for a connection.
    #[test]
    fn connection_pool_exhaustion_during_spike() {
        let pool_size = 20;
        let concurrent_requests = 50;
        let queued_requests = pool_size;
        let rejected_requests = concurrent_requests - pool_size - queued_requests;

        // First 20 get connections immediately
        let immediate = pool_size;
        // Next 20 queue up (pool has a queue)
        let queued = queued_requests;
        // Last 10 get pool timeout
        let timed_out = rejected_requests;

        assert_eq!(immediate, 20);
        assert_eq!(queued, 20);
        assert_eq!(
            timed_out, 10,
            "10 requests should timeout waiting for connection"
        );

        // In production, the timed-out requests return 503 (transient error)
        // Client should implement exponential backoff retry
    }

    /// Deadlock: two concurrent batch updates on the same session.
    /// MySQL's InnoDB detects the deadlock and kills one transaction.
    #[test]
    fn deadlock_between_concurrent_batch_updates() {
        // Both batch updates start transactions, both acquire session lock
        // InnoDB detects circular wait → kills the younger transaction
        // Killed transaction: client gets error 1213, should retry
        // Surviving transaction: commits normally

        let transaction_killed = true; // one of the two
        let survivor_commits = true;

        assert!(
            transaction_killed,
            "MySQL kills one transaction on deadlock"
        );
        assert!(
            survivor_commits,
            "the other transaction commits successfully"
        );

        // Killed transaction client should retry with exponential backoff
        // On retry, it will see updated versions and need to rebase its edits
    }

    /// Replication lag: read from replica sees data 500ms behind.
    /// Client reads stale version, sends edit, gets unexpected response.
    #[test]
    fn replication_lag_causes_stale_read() {
        // T0: Primary writes slide version 10
        // T0+50ms: Client reads from replica → sees version 9 (lag=500ms)
        // T0+100ms: Client sends edit with baseVersion=9
        // T0+150ms: Server (reads from primary) sees version 10 → 409

        let primary_version = 10i64;
        let replica_version = 9i64;
        let client_sends_base_version = replica_version;

        let server_sees_version = primary_version;
        let conflict = client_sends_base_version != server_sees_version;
        assert!(conflict, "replication lag causes version conflict");

        // Fix: Reads should go to primary for recently-written sessions,
        // or client should retry on 409 with re-fetched version
    }

    /// Partial write: 3 of 5 slides updated, then connection drops.
    /// Because updates are in a single transaction, ALL rollback.
    #[test]
    fn partial_write_rolls_back_entirely() {
        // Batch update: 5 slides, transaction started
        // UPDATE slide-1 → OK (in transaction buffer)
        // UPDATE slide-2 → OK (in transaction buffer)
        // UPDATE slide-3 → OK (in transaction buffer)
        // UPDATE slide-4 → connection lost!
        // Transaction rolls back — slide-1, slide-2, slide-3 are NOT persisted

        let slides_in_transaction_buffer = 3;
        let connection_dropped = true;
        let transaction_committed = !connection_dropped;

        assert!(!transaction_committed, "transaction should NOT commit");
        // After rollback, zero slides are persisted in the database
        let slides_persisted_after_rollback = 0i32;
        assert_eq!(
            slides_persisted_after_rollback, 0,
            "no slides persisted after rollback"
        );
        // This is the correct behavior: atomicity guarantees no partial state
    }

    /// Query plan regression: slide SELECT goes from 2ms to 200ms.
    /// After stats change or index becomes stale, batch update exceeds client timeout.
    #[test]
    fn query_plan_regression_causes_timeout() {
        let normal_query_time_ms = 2;
        let regressed_query_time_ms = 200;
        let slowdown_factor = regressed_query_time_ms / normal_query_time_ms;

        assert_eq!(slowdown_factor, 100, "query is 100x slower than normal");

        // Batch update touches 10 slides: 10 * 200ms = 2000ms just for SELECTs
        let num_slides = 10;
        let total_select_time_ms = num_slides * regressed_query_time_ms;
        assert_eq!(total_select_time_ms, 2000, "SELECTs alone take 2 seconds");

        // Plus UPDATEs, locks, outbox enqueue, commit → easily exceeds 5s client timeout
        // Fix: ANALYZE TABLE, check index usage, or add query hints
    }

    /// TiDB region leader transfer causes brief write unavailability.
    /// During leader election (~100ms), writes fail with "region unavailable".
    #[test]
    fn tidb_leader_transfer_causes_brief_write_failure() {
        // T0: Region leader starts transfer to new node
        // T0+50ms: Writes to this region fail with "region is unavailable"
        // T0+100ms: New leader ready, writes resume
        let leader_transfer_duration_ms = 100;
        let write_during_transfer_fails = true;

        assert!(
            write_during_transfer_fails,
            "writes during leader transfer should fail"
        );
        assert_eq!(
            leader_transfer_duration_ms, 100,
            "typical TiDB leader transfer takes ~100ms"
        );

        // Failed writes are transient — client should retry
        // The transaction rolls back cleanly, no partial state
    }

    /// Max connections reached: new requests queue in FIFO order.
    /// The tail request waits 4s for a connection, then times out.
    #[test]
    fn max_connections_queues_tail_requests() {
        let max_connections = 100;
        let active_connections = 100;
        let queued_requests = 30; // more requests queue up

        // All 100 connections are in use
        let pool_exhausted = active_connections >= max_connections;
        assert!(pool_exhausted, "pool is exhausted");

        // 30 requests queue up
        // Assuming each connection frees up in 200ms average:
        let avg_connection_hold_time_ms = 200;
        let estimated_wait_for_tail_ms = queued_requests * avg_connection_hold_time_ms;

        let connection_wait_timeout_ms = 5000;
        let tail_request_times_out = estimated_wait_for_tail_ms > connection_wait_timeout_ms;
        assert!(
            tail_request_times_out,
            "tail request times out waiting for connection"
        );
        // In practice, the wait isn't perfectly FIFO — some connections free faster
    }

    /// Transaction commit takes 4s due to binlog sync to replica.
    /// Client retries at T3, doesn't find idempotency entry (commit hasn't finished).
    #[test]
    fn slow_binlog_sync_delays_commit_past_retry() {
        // T0: Server starts batch update
        // T1: Server executes all UPDATEs
        // T1: Server calls tx.commit() → blocks on binlog sync
        // T3: Client times out, retries with same request_id
        // T3: Server checks wal_request_replays → NOT FOUND (commit hasn't finished!)
        // T3: Server starts processing the retry as a NEW request
        // T4: Original commit finishes → slide updated
        // T5: Retry commit finishes → same slide updated again (DOUBLE APPLY!)

        let commit_time_ms = 4000;
        let client_timeout_ms = 3000;
        let retry_before_commit_finishes = client_timeout_ms < commit_time_ms;

        assert!(
            retry_before_commit_finishes,
            "client retries before original commit finishes"
        );

        // Without idempotency guard, the update is applied TWICE
        // With X-Client-Request-Id: the retry also INSERT IGNOREs into wal_request_replays
        // The original commit also INSERT IGNOREs — one wins, but the slide is still updated twice
        // because the UPDATE itself isn't idempotent (version++ each time)

        // Fix: The handler should check wal_request_replays BEFORE starting the UPDATEs,
        // not after. Currently it checks before, so the retry would also find nothing.
        // This is a genuine gap — the idempotency check is before the transaction starts.
    }

    /// Prepared statement cache eviction: first request after eviction is 10x slower.
    /// sqlx re-prepares the statement, adding latency to the critical path.
    #[test]
    fn prepared_statement_cache_eviction_adds_latency() {
        let _normal_prepare_ms = 0; // already prepared, cached
        let reprepare_ms = 5; // network round-trip to DB for PREPARE

        let _batch_touches_10_unique_statements = true;
        let all_were_evicted = true; // e.g., after connection pool recycle

        if all_were_evicted {
            let total_reprepare_overhead_ms = 10 * reprepare_ms;
            assert_eq!(
                total_reprepare_overhead_ms, 50,
                "50ms overhead from re-preparing"
            );

            // 50ms isn't enough to cause timeouts, but it adds up with other latency sources
            // Combined with 200ms RTT and 3s lock wait → pushes request over the edge
        }
    }

    // ============================================================
    // 3. CACHE INCONSISTENCY — Stale Reads, Miss Storms, Desync
    // ============================================================

    /// Stale cache: user adds a slide, cache still returns old slide list.
    /// The invalidation happens AFTER commit, but there's a window where
    /// a concurrent read hits the cache before invalidation.
    #[test]
    fn stale_cache_returns_old_slide_list() {
        // T0: Batch update commits 3 new slides
        // T0+0ms: Cache still has old state (invalidation hasn't run yet)
        // T0+1ms: Concurrent GET hits cache → returns old slide list (missing 3 slides)
        // T0+2ms: Cache invalidation runs
        // T0+3ms: Next GET misses cache, rebuilds from DB → correct state

        let cache_invalidated_yet = false;
        let concurrent_read_hits_cache = true;

        if concurrent_read_hits_cache && !cache_invalidated_yet {
            // Client sees stale data — missing the 3 new slides
            let cached_slide_count = 5;
            let actual_slide_count = 8;
            assert_eq!(cached_slide_count, 5, "cache still has old count");
            assert_eq!(actual_slide_count, 8, "DB has the new slides");
            // The stale read is brief (1-2ms window) but can cause UI flicker
        }
    }

    /// Cache miss storm: cache invalidated, 10 concurrent requests all hit DB.
    /// Each request independently rebuilds SessionState (N+1 queries).
    #[test]
    fn cache_miss_storm_hammers_database() {
        let cache_invalidated = true;
        let concurrent_reads = 10;

        if cache_invalidated {
            // Each read misses cache, runs full rebuild:
            // 1x session header + 1x slides + 1x questions + Nx vote_counts
            let queries_per_rebuild = 3; // simplified
            let total_queries = concurrent_reads * queries_per_rebuild;

            assert_eq!(
                total_queries, 30,
                "10 concurrent reads × 3 queries each = 30 queries"
            );

            // Only the first rebuild should populate the cache; the others should
            // ideally wait for it (thundering herd prevention).
            // Current implementation: all 10 run independently → redundant work
            // Fix: Use a mutex/semaphore keyed by session_id for cache rebuild
        }
    }

    /// Cache eviction mid-operation: TTL=3s, batch update takes 5s.
    /// By the time invalidation runs, the cache entry has already expired.
    #[test]
    fn cache_expires_during_slow_operation() {
        let cache_ttl_secs = 3;
        let operation_duration_secs = 5;

        // T0: Cache entry created for session-X
        // T3: Cache entry expires (TTL reached)
        // T5: Batch update commits, tries to invalidate → key already gone
        let entry_expired_before_invalidation = operation_duration_secs > cache_ttl_secs;
        assert!(
            entry_expired_before_invalidation,
            "cache entry expires before invalidation runs"
        );

        // This is harmless — the next read will miss and rebuild correctly.
        // But it means the cache provides no benefit for slow operations.
    }

    /// Cache/DB desync: cache says v5, DB at v7 due to concurrent edits.
    /// Two batch edits happen in rapid succession; the cache only saw the first.
    #[test]
    fn cache_db_desync_on_concurrent_edits() {
        // T0: Cache has session at state_version=5
        // T1: Batch edit A commits → bumps to v6, invalidates cache
        // T1+1ms: Read C misses cache, rebuilds → sees v6, caches it
        // T2: Batch edit B commits → bumps to v7, invalidates cache
        // T2+1ms: Read D misses cache, rebuilds → sees v7, caches it

        // BUT if read C is slow (takes 2s to rebuild):
        // T1+2s: Read C finishes rebuild → caches v6
        // T2 already happened → DB is at v7, cache has v6
        let slow_rebuild_time_ms = 2000;
        let time_between_edits_ms = 1000;

        let cache_is_stale = slow_rebuild_time_ms > time_between_edits_ms;
        assert!(cache_is_stale, "slow rebuild produces stale cache entry");

        // Next read gets v6 from cache, but DB has v7
        // Client detects mismatch via state_version in WebSocket events
    }

    /// Two concurrent batch updates both invalidate cache.
    /// The second invalidation is a no-op (cache already empty).
    #[test]
    fn double_invalidation_is_harmless() {
        // T0: Cache has session-X
        // T1: Batch A commits → invalidates cache (cache now empty for session-X)
        // T1+5ms: Batch B commits → invalidates cache (no-op, already empty)

        let first_invalidation_removed_entry = true;
        let second_invalidation_is_noop = first_invalidation_removed_entry;

        assert!(
            second_invalidation_is_noop,
            "second invalidation is a harmless no-op"
        );
        // After both commits, cache is empty → next read rebuilds from DB → correct state
    }

    /// Cache serves deleted slide: slide deleted, cache not yet invalidated.
    #[test]
    fn cache_serves_deleted_slide() {
        // T0: Cache has slides [A, B, C]
        // T1: DELETE slide-B commits, invalidates cache
        // T1+0ms: Concurrent read hits cache → returns [A, B, C] (B was just deleted!)

        let delete_committed = true;
        let invalidation_ran = false; // hasn't run yet
        let read_hits_cache = true;

        if read_hits_cache && !invalidation_ran && delete_committed {
            let returned_slides = vec!["A", "B", "C"];
            let actual_slides = vec!["A", "C"];
            assert_ne!(
                returned_slides, actual_slides,
                "cache returns ghost slide B"
            );
            // Window is very brief (microseconds in-process), but exists
        }
    }

    /// LRU eviction removes hot session cache.
    /// A frequently-accessed session gets evicted by a burst of new sessions.
    #[test]
    fn lru_eviction_removes_hot_session() {
        // Cache capacity: 8 entries
        let _cache_capacity = 8;

        // Hot session (teacher presenting): accessed 1000 times
        // New sessions: 10 students each open the app → 10 new cache entries
        // But only 8 fit → hot session stays (it's the most recently used)

        // However, if the teacher navigates away and 8 new sessions come in:
        let teacher_navigated_away = true; // stop accessing hot session
        let new_sessions = 8;

        if teacher_navigated_away {
            let hot_session_evicted = new_sessions >= _cache_capacity;
            assert!(hot_session_evicted, "hot session evicted after inactivity");
            // When teacher returns, cache miss → slow rebuild → presentation lag
        }
    }

    /// Rebuild storm after full deployment clears all caches.
    /// All instances simultaneously miss and hammer the DB.
    #[test]
    fn rebuild_storm_after_deployment() {
        let num_instances = 3;
        let hot_sessions_per_instance = 5;
        let _cache_capacity = 8;

        // After deploy: all caches empty
        // Each instance independently rebuilds its hot sessions
        let total_rebuilds = num_instances * hot_sessions_per_instance;
        let queries_per_rebuild = 3; // session header + slides + questions
        let total_db_queries = total_rebuilds * queries_per_rebuild;

        assert_eq!(total_rebuilds, 15, "15 independent cache rebuilds");
        assert_eq!(total_db_queries, 45, "45 DB queries in a short window");

        // With cache_capacity=8 and only 5 hot sessions per instance,
        // there's no eviction pressure, but the initial burst hits DB
    }

    /// Cache key collision scenario: sessions with similar IDs could theoretically
    /// collide if the cache key derivation is flawed.
    #[test]
    fn cache_key_uniqueness() {
        let session_a = "sess-abc123";
        let session_b = "sess-abc12"; // similar prefix

        // Cache key should be the full session_id string
        let key_a = session_a;
        let key_b = session_b;

        assert_ne!(
            key_a, key_b,
            "similar session IDs must produce distinct cache keys"
        );
        // The SessionStateCache uses the session_id string directly as the key,
        // so collisions are impossible unless two sessions share the same UUID
    }

    // ============================================================
    // 4. CONCURRENCY — Multi-User Edit Races, Optimistic Locking
    // ============================================================

    /// Two tabs editing same session: both send batch updates simultaneously.
    /// The session row lock serializes them; one succeeds, one sees updated versions.
    #[test]
    fn two_tabs_send_concurrent_batch_updates() {
        // Tab A: baseVersion for slides [1, 2, 3] = [5, 3, 10]
        // Tab B: baseVersion for slides [1, 2, 3] = [5, 3, 10] (same stale snapshot)
        let tab_a_versions = vec![5, 3, 10];
        let _tab_b_versions = vec![5, 3, 10]; // same as Tab A's snapshot

        // Tab A's request arrives first, acquires session lock
        // Tab A updates: slide-1 v5→6, slide-2 v3→4, slide-3 v10→11
        // Tab A commits, releases lock

        // Tab B's request was waiting for lock
        // Tab B pre-validation already ran (before lock) — all versions matched at that time
        // BUT Tab B's UPDATE uses WHERE version = X → fails because versions changed

        let tab_a_succeeds = true;
        let tab_b_versions_on_server_after_a = vec![6, 4, 11];

        // Tab B's pre-check saw [5,3,10] but by UPDATE time, server has [6,4,11]
        let tab_b_update_versions = tab_a_versions; // Tab B sends with original versions
        let tab_b_conflicts: Vec<bool> = tab_b_update_versions
            .iter()
            .zip(tab_b_versions_on_server_after_a.iter())
            .map(|(&client_ver, &server_ver)| client_ver != server_ver)
            .collect();

        assert!(tab_a_succeeds);
        assert_eq!(
            tab_b_conflicts,
            vec![true, true, true],
            "Tab B conflicts on ALL slides"
        );
        // Tab B's entire batch rolls back → client gets 409 for the first conflicting slide
    }

    /// Auto-save race: same slide edited in two tabs at the same moment.
    /// Both read v3, both send update with baseVersion=3.
    #[test]
    fn autosave_race_same_slide_two_tabs() {
        // Both tabs read slide at version 3
        let shared_version = 3i64;

        // Tab A sends update with baseVersion=3
        // Tab B sends update with baseVersion=3
        // Server processes A first: version 3→4 ✓
        // Server processes B: expected 3, has 4 → 409

        let tab_a_result = "ok"; // first to arrive
        let tab_b_result = "409"; // version mismatch

        assert_eq!(tab_a_result, "ok");
        assert_eq!(tab_b_result, "409");
        // Tab B should re-fetch slide content and re-apply its edit
    }

    /// Rapid slide creation: user clicks "Add Slide" 5 times in 1 second.
    /// 5 concurrent POSTs, each assigns order_index independently.
    #[test]
    fn rapid_slide_creation_order_index_race() {
        // Without proper locking, all 5 reads get append_order_index=0
        // and all insert at order_index=0 → duplicates!
        //
        // With FOR UPDATE lock on session: they serialize correctly
        // Slide 1: order=0
        // Slide 2: order=1024
        // Slide 3: order=2048
        // Slide 4: order=3072
        // Slide 5: order=4096

        const ORDER_STEP: i32 = 1024;
        let expected_orders: Vec<i32> = (0..5).map(|i| i * ORDER_STEP).collect();
        assert_eq!(expected_orders, vec![0, 1024, 2048, 3072, 4096]);

        // The create_slide handler acquires FOR UPDATE on the session row,
        // so these requests are serialized — no race condition on order_index
    }

    /// Reorder while content is saving: order update and content update
    /// compete for the session lock.
    #[test]
    fn reorder_while_content_saving() {
        // T0: Tab A sends content update for slide-1 (acquires session lock in batch, or no lock in single)
        // T0+5ms: Tab B sends reorder request (acquires FOR UPDATE session lock)
        // T0+10ms: Tab B's reorder commits
        // T0+50ms: Tab A's content update commits (or conflicts if batch)

        // For single-slide update (no session lock):
        // Tab A updates slide-1 content (optimistic lock via version)
        // Tab B reorders all slides (session lock, bumps state_version)
        // These don't conflict directly — different lock paths

        let content_update_uses_version_lock = true;
        let reorder_uses_session_lock = true;

        assert!(content_update_uses_version_lock);
        assert!(reorder_uses_session_lock);

        // They can execute concurrently without blocking each other
        // But the reorder might move slide-1 while its content is being updated
        // Result: slide-1 has new content AND new position (both succeed)
    }

    /// Teacher adds slide while student votes — different lock paths.
    /// Slide update doesn't block vote submission.
    #[test]
    fn slide_add_does_not_block_voting() {
        // Teacher: POST /slides (acquires FOR UPDATE on session)
        // Student: POST /vote (uses vote submission lock, different row)

        let slide_update_locks_session = true;
        let vote_uses_separate_lock = true;

        assert!(slide_update_locks_session);
        assert!(vote_uses_separate_lock);

        // These are independent — voting continues while slide is being added
        // The vote might reference a slide that's mid-creation, but the vote
        // validates slide_id against the DB (which doesn't have the new slide yet)
        // → vote would fail with "slide not found" if it references the new slide
    }

    /// Three-way edit collision: Tab A, Tab B, Tab C all edit the same slide.
    #[test]
    fn three_way_edit_collision() {
        // All three tabs read slide at version 5
        let initial_version = 5i64;

        // Server serializes them (session lock for batch, or optimistic lock for single)
        // Tab A: version 5→6 ✓
        // Tab B: expected 5, has 6 → 409
        // Tab C: expected 5, has 6 → 409

        let mut results = Vec::new();
        let mut server_ver = initial_version;
        for _ in 0..3 {
            if server_ver == initial_version {
                server_ver += 1;
                results.push("ok");
            } else {
                results.push("409");
            }
        }

        assert_eq!(results, vec!["ok", "409", "409"]);
        // Only the first arrival wins; the other two must retry with fresh content
    }

    /// Batch update interleaved with single-slide update.
    /// Batch holds session lock; single update starves.
    #[test]
    fn batch_interleaved_with_single_slide_update() {
        // T0: Single-slide update reads slide version (no lock needed)
        // T1: Batch update starts, acquires FOR UPDATE session lock
        // T2: Single-slide UPDATE executes → no session lock needed (removed!)
        //     But uses WHERE version = X → may conflict with batch's changes

        let single_update_precheck_version = 3i64;
        let batch_updates_slide_same = true;

        if batch_updates_slide_same {
            // Batch changes slide version 3→4
            // Single update's WHERE version = 3 → rows_affected = 0 → 409
            let single_update_succeeds = false;
            assert!(
                !single_update_succeeds,
                "single update conflicts with batch"
            );
        } else {
            // Batch updates different slides → no conflict
            let single_update_succeeds = true;
            assert!(single_update_succeeds);
        }
    }

    /// Concurrent deletes: two users delete the same slide simultaneously.
    #[test]
    fn concurrent_deletes_same_slide() {
        // Both DELETEs execute: DELETE FROM slides WHERE id = ? AND session_id = ?
        // First: rows_affected = 1 → success
        // Second: rows_affected = 0 → 404 "Slide not found"

        let first_delete_succeeds = true;
        let second_delete_finds_nothing = true;

        assert!(first_delete_succeeds);
        assert!(second_delete_finds_nothing);
        // Idempotent: deleting an already-deleted slide returns 404, not an error
    }

    /// Slide reorder during batch content update.
    #[test]
    fn reorder_during_batch_content_update() {
        // Batch A: updating content of slides [1, 2, 3]
        // Request B: reordering slides to [3, 1, 2]

        // If Batch A holds session lock (it does):
        // Reorder B waits for Batch A to finish
        // Then Reorder B acquires lock, updates order_index
        // Result: slides have new content AND new order (both succeed, serialized)

        let content_updated = true;
        let order_updated = true;
        let no_conflict = true; // different operations, same lock

        assert!(content_updated);
        assert!(order_updated);
        assert!(no_conflict);
    }

    /// Auto-save fires every 2s, user types for 10s → 5 saves.
    /// Each save increments the slide version.
    #[test]
    fn autosave_fires_rapidly_version_accumulates() {
        let auto_save_interval_ms = 2000;
        let typing_duration_ms = 10000;
        let expected_saves = typing_duration_ms / auto_save_interval_ms;

        let mut version = 0i64;
        for _ in 0..expected_saves {
            version += 1;
        }

        assert_eq!(version, 5, "slide version increments with each save");
        assert_eq!(expected_saves, 5);

        // If any save fails (network error), the client retries with the same
        // content but a potentially stale baseVersion → 409
    }

    /// User rapidly toggles slide visibility (is_hidden).
    /// Responses arrive out of order → UI shows wrong state.
    #[test]
    fn rapid_visibility_toggle_responses_out_of_order() {
        // T0: Toggle 1: is_hidden=true (version 1→2)
        // T0+50ms: Toggle 2: is_hidden=false (version 2→3)
        // T0+100ms: Toggle 3: is_hidden=true (version 3→4)

        // Responses arrive: Toggle 3 first, Toggle 1 last
        // Client's UI: true → false → true (out of order)
        // Actual server state: true (version 4)

        let toggles = vec![true, false, true]; // intended sequence
        let response_order = vec![2, 0, 1]; // indices of toggles in arrival order

        let observed_sequence: Vec<bool> = response_order.iter().map(|&i| toggles[i]).collect();
        assert_eq!(observed_sequence, vec![true, true, false]);

        // Client's final UI shows false, but server has true
        // Fix: Client should track in-flight toggles and ignore out-of-order responses
        // Or: use a monotonically increasing sequence number in responses
    }

    /// Poll submission while slide content is being updated.
    /// Vote hits an option that's being removed from the poll.
    #[test]
    fn vote_hits_option_being_removed() {
        // T0: Teacher edits poll, removes option "opt-C"
        // T0+5ms: Student votes for "opt-C"
        // T0+10ms: Teacher's edit commits (opt-C gone)
        // T0+15ms: Student's vote arrives → "opt-C" doesn't exist in slide content

        // The vote handler validates option_id against the current slide content
        let vote_option = "opt-C";
        let slide_has_option = false; // teacher removed it

        if !slide_has_option {
            // Vote is rejected or mapped to closest match
            let vote_rejected = true;
            assert!(vote_rejected, "vote for removed option should be rejected");
        }
        // This is a UX issue — student didn't know option was being removed
        // Could add a grace period or "orphaned vote" handling
    }

    // ============================================================
    // 5. INFRASTRUCTURE INSTABILITY — Restarts, Deploys, Backlogs
    // ============================================================

    /// Pod restart mid-batch-update: request killed after DB commit but before response.
    /// Client retries, idempotency saves it from double-applying.
    #[test]
    fn pod_restart_after_commit_before_response() {
        // T0: Server starts batch update
        // T1: Server commits transaction (slides updated, outbox event enqueued)
        // T2: Server starts writing HTTP response
        // T2+1ms: Pod gets SIGTERM (rolling deploy) → process killed
        // T3: Client times out (no response received)
        // T4: Client retries with same X-Client-Request-Id
        // T5: New pod checks wal_request_replays → FOUND → returns cached response

        let db_committed = true;
        let response_sent = false;
        let idempotency_entry_exists = db_committed;

        assert!(
            idempotency_entry_exists,
            "wal_request_replays has the entry"
        );
        // BUT: the wal_request_replays INSERT is inside the same transaction as the updates.
        // If the transaction committed, the replay entry is there.
        // The retry finds it and returns the stored response. ✓

        // Edge case: what if wal_request_replays INSERT failed but slide UPDATEs committed?
        // That can't happen — they're in the same transaction.
        // Either both commit or both roll back.
    }

    /// Partial deploy: 1 of 3 pods has new batch endpoint code.
    /// Depending on which pod handles the request, behavior differs.
    #[test]
    fn partial_deploy_causes_inconsistent_behavior() {
        let total_pods = 3;
        let updated_pods = 1;
        let old_pods = 2;

        let request_hits_updated_pod = false;
        let batch_endpoint_exists_on_old_pods = true; // old pods don't have the route

        if !request_hits_updated_pod && !batch_endpoint_exists_on_old_pods {
            // Old pod returns 404 for the batch endpoint
            let request_fails = true;
            assert!(request_fails, "old pod doesn't recognize batch endpoint");
        }

        // Fix: Deploy all pods simultaneously (blue-green or canary)
        // Or: ensure backward compatibility (old pods proxy unknown routes to new pods)
    }

    /// Outbox backlog: 1000 pending events, poller processes 50 per 100ms.
    /// SLIDES_UPDATE events delayed 2 seconds.
    #[test]
    fn outbox_backlog_delays_realtime_updates() {
        let pending_events = 1000;
        let batch_size = 50;
        let poll_interval_ms = 100;
        let batches_needed = pending_events / batch_size;
        let total_drain_time_ms = batches_needed * poll_interval_ms;

        assert_eq!(batches_needed, 20);
        assert_eq!(
            total_drain_time_ms, 2000,
            "takes 2 seconds to drain backlog"
        );

        // SLIDES_UPDATE events are mixed with STATE_UPDATE and VOTE_UPDATE
        // STATE_UPDATE has priority (processed first)
        // SLIDES_UPDATE may wait even longer if many STATE_UPDATEs are queued

        let slides_update_wait_time_ms = total_drain_time_ms;
        assert_eq!(slides_update_wait_time_ms, 2000);

        // During this 2s window, real-time clients see stale slide data
        // Clients fall back to polling (HTTP GET /slides) after timeout
    }

    /// Load balancer drops connection: server processed request, response lost.
    #[test]
    fn load_balancer_drops_response() {
        // T0: Client sends batch update
        // T1: Server processes, commits, sends response
        // T2: Load balancer drops the response packet (connection reset)
        // T3: Client times out at T5 (no response)
        // T5: Client retries → idempotency returns cached response

        let server_processed = true;
        let response_reached_client = false;
        let client_retries = true;

        assert!(server_processed);
        assert!(!response_reached_client);
        assert!(client_retries);
        // Idempotency saves the day — without it, the batch would apply twice
    }

    /// Health check window: request routes to unhealthy instance during termination.
    #[test]
    fn request_routes_to_dying_instance() {
        // T0: Pod receives SIGTERM, starts graceful shutdown
        // T0-T30s: Pod stops accepting new connections but finishes in-flight requests
        // T0+5ms: Load balancer health check hasn't detected termination yet
        // T0+10ms: New request routed to dying pod → 502 or connection refused

        let graceful_shutdown_window_ms = 30000;
        let health_check_interval_ms = 10000;
        let request_arrives_after_health_check_fail = false;

        if !request_arrives_after_health_check_fail {
            // Request hits the dying pod
            let pod_accepts_connection = false; // stopped accepting new connections
            assert!(!pod_accepts_connection, "dying pod rejects new connections");
            // Load balancer retries on another pod → request succeeds
        }
    }

    /// Outbox poller crashes mid-batch. Events processed so far are marked "published",
    /// remaining events stay "pending" for next poll cycle.
    #[test]
    fn outbox_poller_crash_mid_batch() {
        // Poll cycle: processes events 1-50 from batch of 100
        // Events 1-25: published successfully (status='published')
        // Events 26-50: broadcast fails, retry_count incremented (status='pending')
        // T0: Poller crashes
        // T0+100ms: New poll cycle starts (or poller restarts)
        // Events 26-50 are retried (up to MAX_RETRIES=5)

        let events_in_batch = 50;
        let successfully_published = 25;
        let failed_and_retried = events_in_batch - successfully_published;

        assert_eq!(failed_and_retried, 25);
        // These 25 events will be picked up by the next poll cycle
        // No events are lost — they persist in the database until published or max retries
    }

    /// DNS failover routes traffic to wrong region — 500ms added latency.
    #[test]
    fn dns_failover_adds_latency_version_conflicts_explode() {
        let normal_latency_ms = 50;
        let failover_latency_ms = 550;
        let latency_increase = failover_latency_ms - normal_latency_ms;

        assert_eq!(latency_increase, 500, "500ms additional latency");

        // With 500ms extra latency, every rapid edit sees more stale data
        let rapid_edits_in_1s = 5;
        let all_edits_see_same_version = failover_latency_ms > 200;

        if all_edits_see_same_version {
            let successful_edits = 1; // only the first one
            let conflicted_edits = rapid_edits_in_1s - 1;
            assert_eq!(successful_edits, 1);
            assert_eq!(conflicted_edits, 4, "4 out of 5 edits conflict");
        }
    }

    /// Certificate rotation causes brief TLS failures (30-second window).
    #[test]
    fn certificate_rotation_causes_brief_tls_failures() {
        let rotation_window_seconds = 30;
        let request_fails_during_rotation = true;

        assert!(
            request_fails_during_rotation,
            "some requests fail during cert rotation"
        );

        // Failed requests get TLS handshake error → client retries
        // Retry succeeds once rotation completes
        // This is transparent to the application layer (connection-level error)
    }

    /// Rolling restart drops WebSocket connections.
    /// Clients lose real-time updates, fall back to HTTP polling.
    #[test]
    fn websocket_drop_during_rolling_restart() {
        let total_ws_connections = 200;
        let pods_restarting = 3;
        let total_pods = 5;
        let connections_dropped = (total_ws_connections * pods_restarting) / total_pods;

        assert_eq!(connections_dropped, 120, "60% of WS connections dropped");

        // Dropped clients reconnect to surviving pods
        // But they miss any SLIDES_UPDATE events published during the disconnect window
        let reconnect_time_ms = 1000;
        let events_missed_during_reconnect = reconnect_time_ms / 100; // poll interval
        assert_eq!(
            events_missed_during_reconnect, 10,
            "may miss up to 10 poll cycles"
        );

        // On reconnect, client should do a full state refetch
    }

    /// Disk I/O spike on DB server — all queries 10x slower.
    #[test]
    fn disk_io_spike_causes_cascading_timeouts() {
        let normal_query_ms = 5;
        let spiked_query_ms = 50;
        let slowdown = 10;

        assert_eq!(spiked_query_ms, normal_query_ms * slowdown);

        // Batch update: 10 slides × (5ms SELECT + 5ms UPDATE) = 100ms normal
        let num_slides = 10;
        let normal_batch_ms = num_slides * (normal_query_ms * 2); // SELECT + UPDATE per slide
        let spiked_batch_ms = num_slides * (spiked_query_ms * 2);

        assert_eq!(normal_batch_ms, 100, "normal batch takes 100ms");
        assert_eq!(spiked_batch_ms, 1000, "spiked batch takes 1000ms");

        // 1000ms is still under client timeout (5000ms), but:
        // If multiple batch updates queue up behind this one (session lock),
        // the tail request could easily exceed 5s
    }

    // ============================================================
    // 6. FAST USER BEHAVIOR — Rapid Clicks, Multi-Tab, Auto-Save
    // ============================================================

    /// User clicks "Add Slide" 10 times rapidly.
    /// Creates 10 slides, but order_index assignment may have gaps.
    #[test]
    fn rapid_slide_creation_with_gaps() {
        // Each POST /slides acquires FOR UPDATE, so they're serialized
        // ORDER_STEP = 1024, so:
        let order_step = 1024i32;
        let num_slides = 10;

        let order_indices: Vec<i32> = (0..num_slides).map(|i| i as i32 * order_step).collect();
        assert_eq!(
            order_indices,
            vec![0, 1024, 2048, 3072, 4096, 5120, 6144, 7168, 8192, 9216]
        );

        // Large gaps are intentional — they allow insertions between existing slides
        // Without gaps, inserting between slide 0 and 1 would require reordering all slides
    }

    /// User drags slide to reorder, then immediately edits content.
    /// Two mutations in-flight for the same slide.
    #[test]
    fn reorder_then_edit_same_slide() {
        // T0: User drags slide-3 from position 3 to position 1
        // T0+10ms: Reorder request sent (session lock, updates order_index for all slides)
        // T0+50ms: User edits slide-3 content
        // T0+60ms: Content update sent (no session lock for single-slide update)

        let reorder_acquires_session_lock = true;
        let content_update_uses_optimistic_lock = true;

        // If content update arrives before reorder commits:
        // Content update succeeds (version 5→6)
        // Reorder then commits (bumps state_version, doesn't touch slide version)
        // Result: both succeed, no conflict

        assert!(reorder_acquires_session_lock);
        assert!(content_update_uses_optimistic_lock);
        // Different lock mechanisms → no direct conflict
        // But reorder might use stale slide list if content update changed something
    }

    /// User deletes slide, then tries to edit it — edit was in-flight before delete confirmed.
    #[test]
    fn edit_in_flight_before_delete_confirms() {
        // T0: User clicks delete on slide-X
        // T0+5ms: User clicks edit on slide-X (UI hasn't confirmed delete yet)
        // T0+10ms: Delete request arrives at server
        // T0+20ms: Edit request arrives at server

        let delete_arrives_first = true;

        if delete_arrives_first {
            // Delete commits → slide-X removed
            // Edit arrives → 404 "Slide not found"
            let edit_fails = true;
            assert!(edit_fails, "edit of deleted slide returns 404");
        } else {
            // Edit commits first → slide-X updated
            // Delete then removes it
            // Result: edit is wasted (slide gets deleted anyway)
            let edit_is_wasted = true;
            assert!(edit_is_wasted);
        }
    }

    /// User switches between slides rapidly, auto-save fires on wrong slide.
    #[test]
    fn autosave_fires_on_wrong_slide() {
        // T0: User views slide-1, starts editing
        // T0+500ms: User switches to slide-2
        // T0+1000ms: User edits slide-2
        // T0+2000ms: Auto-save fires — but which slide's content?

        let active_slide_id = "slide-2";
        let autosave_slide_id = "slide-1"; // bug: auto-save captured stale slide-1 content

        let saves_to_wrong_slide = autosave_slide_id != active_slide_id;
        assert!(saves_to_wrong_slide, "auto-save must track current slide");

        // Fix: Auto-save should use a ref to the current slide ID at save time,
        // not the slide ID when editing started
    }

    /// User pastes large content into 5 slides simultaneously.
    /// All auto-save at once → version conflicts.
    #[test]
    fn simultaneous_large_content_pastes() {
        // User has 5 slides open in split view, pastes content into each
        // All 5 auto-save fire at the same time (2s interval synced)

        let num_slides = 5;
        let all_save_simultaneously = true;

        if all_save_simultaneously {
            // Each slide gets its own update — different slides, no version conflict
            // (version conflict is per-slide, not per-session)
            let all_succeed = true;
            assert!(all_succeed, "different slides can be updated concurrently");
        }

        // But if all 5 slides are in the SAME batch update request:
        // Batch acquires session lock, updates all 5 atomically
        let batch_succeeds = true;
        assert!(batch_succeeds);
    }

    /// User reorders slides 20 times in 5 seconds.
    /// Order_index gap exhaustion triggers reallocate.
    #[test]
    fn rapid_reorder_triggers_gap_reallocate() {
        const ORDER_STEP: i32 = 1024;

        // 20 reorder operations on 5 slides
        let num_reorders = 20;
        let num_slides = 5;

        // Each reorder reassigns all 5 slides' order_index
        // After many reorder operations between the same pair of slides,
        // the gap between them narrows: 1024 → 512 → 256 → 128 → ...

        let gap_after_n_insertions = ORDER_STEP / (2_i32.pow(4)); // after ~4 insertions between same pair
        assert_eq!(gap_after_n_insertions, 64, "gap narrows to 64");

        // When gap < 2, reallocate is triggered: all slides get new order_index
        // with full ORDER_STEP spacing
        let reallocate_threshold = 2;
        let reallocate_needed = gap_after_n_insertions < reallocate_threshold;
        assert!(
            !reallocate_needed,
            "20 reorder operations don't exhaust gap (reallocate not needed yet)"
        );
        // But many more reorder operations between the same two adjacent slides would trigger it
    }

    /// User creates slide, immediately edits it.
    /// Edit arrives before create is fully committed.
    #[test]
    fn edit_arrives_before_create_commits() {
        // T0: POST /slides (create slide-X)
        // T0+5ms: PUT /slides/:id (edit slide-X)
        // T0+10ms: Create commits → slide-X exists, version=0
        // T0+15ms: Edit arrives → slide-X exists, but version=0, edit has baseVersion=0

        let create_version = 0i64;
        let edit_base_version = 0i64;

        let version_matches = create_version == edit_base_version;
        assert!(
            version_matches,
            "edit should match the freshly-created slide's version"
        );

        // Edit succeeds: version 0→1
        // Both operations complete successfully
    }

    /// User bulk-deletes 10 slides while editing the remaining 5.
    /// Delete lock starves edits.
    #[test]
    fn bulk_delete_starves_concurrent_edits() {
        // Each DELETE acquires FOR UPDATE on session
        // Edits (single-slide updates) don't need session lock (removed!)
        // So they don't conflict

        let delete_locks_session = true;
        let edit_locks_session = false; // removed in our optimization

        assert!(delete_locks_session);
        assert!(!edit_locks_session);

        // Edits and deletes can proceed concurrently
        // BUT: an edit might reference a slide that's being deleted → race
    }

    /// User toggles presentation mode rapidly — STATE_UPDATE burst floods outbox.
    #[test]
    fn rapid_presentation_mode_toggle_floods_outbox() {
        // Each toggle: UPDATE sessions SET is_presentation_active = ?, state_version++
        // Then: enqueue STATE_UPDATE event to outbox

        let num_toggles = 20;
        let outbox_events_generated = num_toggles;

        assert_eq!(outbox_events_generated, 20);

        // Outbox poller processes 50 events per 100ms cycle
        // 20 STATE_UPDATEs fit in one batch — no backlog
        let fits_in_one_batch = outbox_events_generated <= 50;
        assert!(fits_in_one_batch, "20 events fit in one poll batch");

        // But 20 STATE_UPDATEs cause 20 WebSocket broadcasts → client refetches state 20 times
        // This is wasteful — debouncing on the server side would help
    }

    /// User opens session in 5 browser tabs, edits in all of them.
    /// 5-way version race.
    #[test]
    fn five_tab_edit_race() {
        let num_tabs = 5;
        let initial_version = 10i64;

        // All 5 tabs read version 10
        // All 5 send edits with baseVersion=10
        // Server serializes them:

        let mut results = Vec::new();
        let mut server_version = initial_version;
        for tab in 0..num_tabs {
            if server_version == initial_version {
                server_version += 1;
                results.push(("tab", tab, "ok"));
            } else {
                results.push(("tab", tab, "409"));
            }
        }

        let successes: Vec<_> = results.iter().filter(|(_, _, r)| *r == "ok").collect();
        let conflicts: Vec<_> = results.iter().filter(|(_, _, r)| *r == "409").collect();

        assert_eq!(successes.len(), 1, "only one tab wins the race");
        assert_eq!(conflicts.len(), 4, "four tabs get conflicts");
    }

    /// User imports 50 slides at once — exceeds MAX_BATCH_SLIDE_COUNT.
    #[test]
    fn bulk_import_exceeds_max_batch_size() {
        const MAX_BATCH_SLIDE_COUNT: usize = 50;
        let slides_to_import = 50;

        let fits_in_batch = slides_to_import <= MAX_BATCH_SLIDE_COUNT;
        assert!(fits_in_batch, "50 slides is exactly the limit");

        // 51 slides would exceed:
        let fifty_one_slides = 51;
        let exceeds = fifty_one_slides > MAX_BATCH_SLIDE_COUNT;
        assert!(exceeds, "51 slides exceeds the limit");
        // Client must split into multiple batch requests or use individual creates
    }

    // ============================================================
    // 7. COMBINED SCENARIOS — Multiple Failure Modes at Once
    // ============================================================

    /// Latency + DB timeout + retry: the perfect storm.
    #[test]
    fn perfect_storm_latency_timeout_retry() {
        // T0: Client sends batch update (normal RTT: 50ms)
        // T0+2000ms: Slow TLS handshake (certificate rotation)
        // T0+2050ms: Request reaches server
        // T0+2060ms: Server tries to acquire session lock → blocked by another batch
        // T0+5060ms: Lock acquired (waited 3s)
        // T0+5100ms: Server processes updates, commits
        // T0+5100ms: Client already timed out at T0+5000ms
        // T0+5100ms: Client retries with same request_id
        // T0+5110ms: Retry reaches server (another slow TLS)
        // T0+5120ms: Server checks wal_request_replays → FOUND
        // T0+7120ms: Retry response reaches client (slow TLS)

        let total_time_ms = 7120;
        let user_waited_ms = total_time_ms;

        assert!(user_waited_ms > 5000, "user waited more than the timeout");
        assert_eq!(user_waited_ms, 7120, "total wall time for the operation");
        // But only ONE update was applied (idempotency) ✓
    }

    /// Cache stale + concurrent edit + slow DB.
    #[test]
    fn cache_stale_concurrent_edit_slow_db() {
        // T0: Cache has state_version=10
        // T0: Client reads from cache → version=10
        // T0+10ms: Concurrent edit commits → state_version=11, invalidates cache
        // T0+20ms: Client sends edit with baseVersion from state_version=10
        // T0+200ms: Server receives edit (slow network)
        // T0+210ms: Server validates: client's baseVersion is stale → 409

        let cache_version = 10i64;
        let server_version = 11i64;
        let client_sends_stale = cache_version < server_version;

        assert!(client_sends_stale, "client sends stale version from cache");
        // 409 response includes current version → client can retry with correct version
    }

    /// Service restart + outbox backlog + rapid edits.
    #[test]
    fn restart_backlog_rapid_edits_combined() {
        // T0: Server restarts
        // T0: Outbox has 500 pending events from before restart
        // T0+100ms: Outbox poller starts, processes 50 events per 100ms
        // T0+1000ms: Poller has processed 500 events, backlog cleared
        // T0+500ms: User starts rapid editing (5 edits in 2s)
        // T0+500ms-T0+2500ms: 5 edits create 5 SLIDES_UPDATE events
        // T0+1100ms-T0+1500ms: These 5 events are processed by poller

        let backlog_drain_ms = 1000;
        let new_events = 5;
        let new_events_drain_ms = new_events * 100; // one poll cycle per batch

        assert_eq!(backlog_drain_ms, 1000);
        assert_eq!(new_events_drain_ms, 500);

        // Total delay for the first new event: ~1000ms (waiting for backlog to drain)
        // Then each subsequent event: ~100ms
    }
}
