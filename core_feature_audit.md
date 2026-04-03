# Core Feature Production-Safety Audit

## 1. Executive summary

**Status Update (April 2, 2026):** All release-blocking code fixes have been implemented. Test infrastructure is in place. Concurrency test suite pending execution.

Core feature under review: the high-concurrency live classroom workflow, with emphasis on simultaneous student voting/question activity, realtime fan-out through Ably, stale-state recovery, and correctness under retries, duplication, ordering, and burst load.

Explicitly out of scope for this revision:

- authentication and authorization design
- token issuance policy
- permission model changes

### Implementation Status

| Risk | Status | Fix Implemented | Test Status |
|------|--------|-----------------|-------------|
| R-01: Vote correctness | ✅ Fixed | Uniqueness constraint + validation | ⏳ Pending T-01 to T-04 |
| R-02: Realtime divergence | ✅ Fixed | Sequence numbers for ordering | ⏳ Pending T-06 to T-07 |
| R-03: Slide propagation | ✅ Fixed | SLIDES_UPDATE publishing | ⏳ Pending T-08 |
| R-04: state_version incomplete | ✅ Fixed | Sequence numbers for vote/QA | ⏳ Pending T-07 |
| R-05: Publish failure detection | ✅ Fixed | Degraded-mode logging | ⏳ Pending T-06 |
| R-06: Schema transition risks | ✅ Fixed | Migration + concurrency test | ⏳ Pending T-10 |

### Files Changed

**Backend:**
- `migrations/20260402100000_add_vote_uniqueness_constraint.sql` - Vote uniqueness
- `migrations/20260402100001_add_event_sequence_numbers.sql` - Sequence numbers
- `src/services/ably.rs` - Enhanced publishing with failure tracking
- `src/handlers/student.rs` - Vote validation, sequence numbering
- `src/handlers/slide.rs` - SLIDES_UPDATE publishing

**Frontend:**
- `apps/web/src/lib/websocket.tsx` - Sequence number filtering

**Test Infrastructure:**
- `docker-compose.test.yml` - Test environment orchestration
- `loadtest/ably-stub/` - Ably mock with fault injection
- `loadtest/run-concurrency-tests.js` - Test runner
- `loadtest/test-concurrency.sh` - Full suite orchestrator

**Documentation:**
- `PRODUCTION_FIXES_SUMMARY.md` - Implementation summary
- `ARCHITECTURE.md` - Concurrency patterns section
- `loadtest/README.md` - Test infrastructure guide

Current local evidence: Backend and frontend compile successfully. Test infrastructure is ready. **Release recommendation remains No-go until concurrency test suite (T-01 through T-10) executes successfully.**

Release recommendation: **No-go** until the concurrency and realtime gates in Sections 4, 6, and 7 are covered by hermetic local tests.

## 2. Scope under review

Services:

- `apps/backend` Axum service
- `apps/web` staff, student, projector, and clicker clients
- Ably realtime integration

Functional scope:

- session state transitions: current slide, live status, results visibility
- slide CRUD, reorder, hide/show, and how those changes reach connected clients
- student vote submission
- student question submission and question upvote
- public session state fetch and stale-state refresh
- projector/student/clicker convergence under realtime updates

DB tables touched:

- `sessions`
- `slides`
- `votes`
- `questions`
- `participants`
- `question_upvotes`
- `slide_delete_requests`

Third-party dependencies:

- Ably token use at runtime
- Ably REST publish path

Migrations in scope:

- `20260309120000_enforce_slide_order_uniqueness.sql`
- `20260310100000_add_slide_idempotency_and_session_state_version.sql`
- `20260310110000_add_slide_delete_idempotency.sql`
- `20260327120000_add_question_idempotency.sql`

Out of scope:

- authn/authz hardening
- tenant isolation review
- cookie/JWT policy review

## 3. Architecture and dependency impact

### Simultaneous student activity path

- Upstream callers: student session page and slide renderer.
- Downstream dependencies: DB writes to `votes`, `questions`, `participants`, `question_upvotes`; Ably publish of `VOTE_UPDATE` and `QA_UPDATE`.
- Synchronous path: HTTP request validation and durable DB write.
- Asynchronous path: post-commit Ably publish and eventual client refresh fallback.
- Persistent state touched: vote rows, question rows, participant records, session aggregate reads.
- Compatibility boundaries: slide content schema vs backend acceptance rules; `limitSubmissions` and `allowMultipleSelection` in the UI vs backend invariants.

### Session state and fan-out path

- Upstream callers: staff editor, clicker UI, student/projector subscribers.
- Downstream dependencies: `sessions` table updates, Ably `STATE_UPDATE`, `/sessions/:id/state` refresh.
- Synchronous path: DB commit for `current_slide_id`, `is_presentation_active`, `is_results_visible`.
- Asynchronous path: Ably event publish and client-side stale detection.
- Compatibility boundaries: `state_version` monotonicity, old clients without versioning, reconnect after missed realtime messages.

### Slide mutation propagation path

- Upstream callers: staff editor.
- Downstream dependencies: `slides` table, student refetch behavior, projector view.
- Synchronous path: slide CRUD/reorder/visibility DB writes.
- Asynchronous path: expected `SLIDES_UPDATE` fan-out to trigger refetch.
- Compatibility boundaries: hidden slides, reordered slides, temp IDs in optimistic UI vs committed IDs.

### Operational dependencies

- MySQL/TiDB write semantics and uniqueness enforcement
- Ably availability and latency
- browser retry behavior
- local storage vote restoration
- periodic refresh and stale-connection recovery

## 4. Risk inventory

### R-01: Duplicate or invalid vote state under simultaneous submissions

- Description: vote correctness is not enforced strongly enough on the backend for burst traffic and direct retries.
- Failure mode: same participant produces multiple business submissions, invalid option votes are counted, or votes land on nonexistent slides.
- Trigger condition: rapid repeat clicks, retry-after-timeout, multiple browser tabs for one participant, or crafted direct API calls during high activity.
- User/business impact: incorrect poll results, wrong quiz/leaderboard outcomes, irrecoverable analytics corruption.
- Technical root cause candidate: `apps/backend/src/handlers/student.rs:29-110` verifies only session existence, then persists via `Vote::create_many`; uniqueness is `(slide_id, participant_id, option_id)` in `apps/backend/migrations/20241201150000_recreate_student_tables.sql:15-23`, which does not enforce single-submit semantics. UI assumptions like `limitSubmissions` and `allowMultipleSelection` live in `packages/shared/src/index.ts:25-36` and `apps/web/src/components/slide-renderer.tsx:101-170,486-570`.
- Test required: integration and concurrency suite with real DB proving single-choice, multi-choice, retry, duplicate-tab, and invalid-option invariants.
- Can be tested fully locally: yes.
- Release blocker: yes.

### R-02: Realtime divergence under Ably delay, loss, or reordering

- Description: the system assumes Ably fan-out plus client fallback will converge, but ordering and failure behavior are not proven under burst.
- Failure mode: students, projector, and clicker observe different current slides/results visibility, or vote/question updates lag and then overwrite newer state.
- Trigger condition: publish delay, publish failure, reconnect after missed messages, or out-of-order delivery during heavy interaction.
- User/business impact: presenter sees one state, projector another, students another; live class appears broken or inconsistent.
- Technical root cause candidate: state changes publish asynchronously after commit; client reducer only protects `STATE_UPDATE` by `stateVersion` in `apps/web/src/lib/state-updates.ts`, while `VOTE_UPDATE` and `QA_UPDATE` do not have equivalent ordering protection. Refresh fallback exists in `apps/web/src/lib/websocket.tsx` but is not validated under load.
- Test required: Ably stub plus fault-injection suite with delayed, dropped, duplicated, and reordered events.
- Can be tested fully locally: partially. App behavior can be tested locally; vendor-internal Ably guarantees cannot.
- Release blocker: yes.

### R-03: Slide edits do not propagate to already connected clients

- Description: clients expect `SLIDES_UPDATE`, but the backend never emits it.
- Failure mode: connected student/projector/clicker clients keep stale slide text, stale visibility, or stale ordering until manual refresh.
- Trigger condition: staff edits slides after students/projector are already connected.
- User/business impact: live lesson content diverges across screens; hidden slides may still show; edits appear to fail.
- Technical root cause candidate: frontend listens for `SLIDES_UPDATE` in `apps/web/src/lib/websocket.tsx:250-252`; student refetch depends on that trigger in `apps/web/src/app/student/session/[id]/page.tsx:46-61`; projector fetches slides only once in `apps/web/src/app/projector/session/[id]/page.tsx:43-47`; backend Ably helpers only publish `STATE_UPDATE`, `VOTE_UPDATE`, and `QA_UPDATE` in `apps/backend/src/services/ably.rs:80-120`.
- Test required: e2e mutation-propagation suite with connected staff, student, projector, and clicker clients.
- Can be tested fully locally: yes.
- Release blocker: yes.

### R-04: `state_version` protects only part of the convergence model

- Description: state versioning exists for session state changes, but not for slide, vote, or question event streams.
- Failure mode: stale vote/question payloads overwrite newer UI state or create temporarily impossible mixed views after reconnect.
- Trigger condition: duplicate delivery, reconnect gap, slow client tab, rapid results toggle combined with vote burst.
- User/business impact: users see counts move backward, questions reappear in old order, or slide/result state paired with mismatched aggregates.
- Technical root cause candidate: `shouldApplyStateUpdate` only guards `STATE_UPDATE`; `VOTE_UPDATE` and `QA_UPDATE` are applied directly in `apps/web/src/lib/websocket.tsx:240-247` with no sequence number or monotonicity check.
- Test required: contract and browser tests with delayed duplicate vote/question messages and interleaved refresh.
- Can be tested fully locally: yes.
- Release blocker: yes.

### R-05: Publish failure after durable commit is weakly detectable

- Description: DB writes succeed even if Ably publish fails, and the system relies on eventual refresh with limited proof or observability.
- Failure mode: vote/question/state changes commit but connected clients stay stale until the next refresh cycle.
- Trigger condition: Ably outage, transient network fault, bad key, REST timeout to Ably.
- User/business impact: perceived lost interaction, delayed results, presenter confusion, inconsistent class timing.
- Technical root cause candidate: `apps/backend/src/services/ably.rs:51-76` logs failures only; no retry queue, outbox, or explicit degraded-mode signal exists.
- Test required: post-commit publish-failure test that proves clients converge by refresh and that failure is detectable from logs/metrics.
- Can be tested fully locally: partially.
- Release blocker: no, but release should be blocked until a fallback proof exists.

### R-06: Recent schema transitions are not proven under concurrent traffic

- Description: order uniqueness, request-id idempotency, and `state_version` were added recently, but their behavior under load and rollout is not proven.
- Failure mode: duplicate-key errors, reorder/write conflicts, old/new code disagreement, or rollback-readability issues during active sessions.
- Trigger condition: rolling deploy, concurrent slide reorder/create/delete, or retries against mixed-version instances.
- User/business impact: live authoring failures, partial session state, migration-time production incidents.
- Technical root cause candidate: recent migrations changed hot tables and semantics, but there is no hermetic migration harness or mixed-version concurrency suite.
- Test required: forward/rollback migration tests plus concurrent write load against migrated schema.
- Can be tested fully locally: yes.
- Release blocker: yes.

## 5. Test strategy

### Functional correctness under load

- Prove a poll vote creates exactly one valid business effect for a participant when `limitSubmissions=true`.
- Prove multi-select works only when the slide allows it and does not accept extra options or invalid option IDs.
- Prove questions and upvotes remain consistent under burst submissions and duplicates.

### Concurrency and timing

- Parallel identical votes from the same participant.
- Parallel votes from hundreds of distinct participants on the same slide.
- Duplicate browser-tab behavior for the same participant ID.
- Retry after timeout but before server response arrives.
- Concurrent state changes: next slide, show/hide results, go live, stop live.
- Interleaving slide edit activity with ongoing student voting.

### Ably and realtime consistency

- Delayed `STATE_UPDATE`.
- Dropped `STATE_UPDATE`.
- Delayed `VOTE_UPDATE`.
- Duplicate `VOTE_UPDATE`.
- Reordered `QA_UPDATE`.
- reconnect after 10-30 seconds of missed traffic.
- stale refresh path after no realtime traffic for >15 seconds.

### Data safety

- reject votes for slides outside the session
- reject votes for unknown options
- prevent duplicate question creation on retry with same request ID
- preserve order uniqueness during reorder plus insert races
- preserve delete idempotency when delete is retried after timeout

### Performance

- hot-path latency for vote submit under 100, 300, and 500 concurrent students
- `GET /sessions/:id/state` latency and payload size with large sessions
- stats query latency after heavy vote accumulation
- lock contention and duplicate-key behavior during reorder bursts

### Deployment safety

- old/new version coexistence around `state_version`
- migrated schema under concurrent vote and slide activity
- rollback readability after new rows use idempotency columns

### Observability

- publish failure log
- stale refresh invocation log
- duplicate vote rejection signal
- retry collision signal
- migration-time duplicate-key signal

## 6. Local-only implementation plan

Local environment required:

- MySQL 8-compatible local DB via Docker Compose or Testcontainers
- backend service
- web app
- Ably stub or proxy that can:
  - accept token requests
  - capture outbound published events
  - inject delay, drop, duplicate, reorder, and 500 responses
- optional Toxiproxy for network latency and timeout injection
- deterministic seed loader and isolated DB per run

Recommended startup order:

1. Start MySQL with empty isolated test schema.
2. Apply backend migrations.
3. Seed users, sessions, slides, and participants.
4. Start Ably stub/proxy.
5. Start backend against test config.
6. Start web app for browser scenarios.

Priority local suite:

| Test ID | Test | Local env needed | Fixtures / seed data | Exact assertions | Pass / fail criteria | Automation | Runtime target | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-01 | Same-participant vote race | MySQL + backend | one poll slide, one participant ID, `limitSubmissions=true` | fire 2, 5, and 10 parallel submissions for same participant; assert one business submission only, stable count, deterministic response semantics | fail if counts exceed allowed business effect | integration/concurrency | < 15s | backend |
| T-02 | Burst vote load on one slide | MySQL + backend | one live poll slide, 100/300/500 participant IDs | submit votes concurrently; assert total persisted counts equal accepted submissions, no DB errors, bounded latency | fail on count mismatch, timeouts, or hot-path regression | integration/load guardrail | < 45s | backend |
| T-03 | Invalid-option rejection under burst | MySQL + backend | one poll slide with fixed option IDs | mix valid and invalid option IDs concurrently; assert only valid options persist and counts exclude invalid payloads | fail if invalid rows appear in `votes` | integration | < 20s | backend |
| T-04 | Retry-after-timeout vote safety | MySQL + backend + fault proxy | one participant, deterministic request IDs, single-choice slide | inject timeout after durable write boundary; retry; assert no duplicate business effect | fail if retry changes final accepted answer/count incorrectly | fault injection | < 20s | backend |
| T-05 | Question retry and duplicate safety | MySQL + backend | active session, one participant, deterministic question request ID | retry same question after forced timeout and duplicate delivery; assert one row only and one visible question in final state | fail if duplicate question persists | integration/fault injection | < 20s | backend |
| T-06 | Ably delayed/dropped state update convergence | MySQL + backend + web + Ably stub | connected staff, student, projector clients | delay/drop `STATE_UPDATE` after current-slide/results toggle; assert clients converge via later event or refresh and never settle on impossible final state | fail if connected clients disagree after recovery window | e2e/fault injection | < 60s | full-stack |
| T-07 | Ably duplicate/reordered vote update resilience | backend + web + Ably stub | one poll slide with live student/projector sessions | inject duplicate and reordered `VOTE_UPDATE` payloads around refresh calls; assert counts do not move backward and final UI matches DB truth | fail if UI diverges from DB truth after stabilization | e2e/contract | < 60s | full-stack |
| T-08 | Slide edit propagation while students are connected | backend + web + Ably stub | staff editor, projector, student all connected | update slide text, hide slide, reorder slides, delete slide; assert connected clients refresh or receive update without manual reload | fail if clients remain stale | e2e | < 60s | full-stack |
| T-09 | Mixed load: votes plus slide navigation | MySQL + backend + web + Ably stub | active session, 100+ voting participants, presenter changing slides/results | run concurrent student voting while presenter advances slides and toggles results; assert `state_version` monotonicity and no corrupted counts | fail if final state is invalid or stale updates override newer state | e2e/load guardrail | < 90s | full-stack |
| T-10 | Migration + concurrency replay | MySQL + old/new backend binaries | pre-migration dataset plus concurrent vote and slide mutation workload | migrate, run workload, optionally roll back binary, verify readability and continued correctness | fail on migration error, duplicate-key instability, or unreadable state | migration harness | < 90s | backend |

Implementation guidance:

- Use real MySQL, not mocked repositories, for all concurrency and duplicate-write cases.
- Treat Ably as a contract stub, not a pure in-memory mock, so timeout/delay/failure behavior is exercised through HTTP.
- Add deterministic synthetic datasets:
  - 1 active session with 200 slides
  - 1 hot poll slide with 500 participants
  - 1 question-heavy session with 1,000 questions/upvotes
- Freeze clocks where stale-refresh timing is asserted.
- Seed random generators for repeatable load runs.

## 7. Release gates

- Same-participant vote race suite is green.
- Burst vote load suite is green at the agreed concurrency level.
- Invalid-option and cross-slide vote rejection suite is green.
- Question retry/idempotency suite is green.
- Ably delayed/dropped/duplicate/reordered event suite is green.
- Connected-client slide propagation suite is green.
- Mixed presenter-plus-student concurrency suite is green.
- Migration plus concurrency replay suite is green.
- Performance guardrails for vote submit and session-state fetch remain below agreed thresholds.
- Publish-failure path emits a detectable signal and proves eventual client convergence.

## 8. Residual risk and unknowns

- Exact production Ably limits, batching behavior, and regional latency are not available locally, so vendor-scale characteristics remain partially inferred.
- Production DB engine/version is still not explicit in repo docs; MySQL/TiDB differences may matter for locking and uniqueness contention.
- Real class-size targets are not documented. The concurrency numbers in this plan need confirmation from expected peak usage.
- The current client model relies on local storage and refresh fallback for some recovery paths; those flows need product acceptance if short-lived stale UI is considered acceptable.

## 9. Final go / no-go recommendation

**No-go** for the simultaneous-student and Ably-heavy path in its current state.

Reasoning:

- correctness under concurrent voting is not proven and is likely weaker than the product semantics imply
- realtime convergence is only partially ordered and not exercised under delay/drop/duplicate conditions
- slide mutation fan-out is incomplete for already connected clients
- recent schema changes have no concurrency-aware migration proof

This can move to **Go with conditions** once the local suites above provide evidence that simultaneous student traffic and Ably failure modes converge safely with low residual risk.
