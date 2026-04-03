# Principal Engineer Test-Audit: 100–130 Concurrent Students (WebSocket/Ably/Voting)

Date: 2026-04-02  
Repo: `class-collaboration`  
Target load: **100 concurrent** (steady) and **130 concurrent** (peak bursts, e.g. class join + vote)

This document is a **production-safety audit + local-only test implementation plan** focused on preventing breakage under classroom burst traffic, especially for:
- Ably “WebSocket” connectivity (token auth + subscription)
- Vote submission correctness under concurrency
- Student flows that depend on Ably updates (state/vote/QA propagation)

---

## 1. Executive summary

### What changed / what we’re validating
- **Realtime architecture**: browser clients connect to **Ably Realtime**; backend publishes events to Ably over **Ably REST**.
- **Critical mutation**: `POST /api/sessions/:id/vote` writes to MySQL and publishes `VOTE_UPDATE`.
- **Student boot flow**: `GET /api/sessions/:id/state`, `GET /api/auth/ably`, `GET /api/sessions/:id/my-votes` (and optional `POST /register-participant`).

### Highest-risk areas for 100–130 concurrent
1. **Ably token endpoint rate limiting**: burst joins can be throttled (429) behind a NAT (many students share one IP).
2. **DB connection pool / query fanout at join**: `/state` pulls slides + questions + aggregated vote counts; join storms can exhaust a small pool.
3. **Vote path lock contention**: hot `sessions` row updates (`vote_sequence`), plus snapshot read of vote counts per write.
4. **Realtime publish backlog**: per-vote `tokio::spawn` publishes can accumulate under Ably slowness/outage.
5. **Client-side ordering/dup handling**: out-of-order/duplicate Ably messages must not regress UI state, especially across slide changes.

### Can local testing sufficiently cover the risk?
Partially.
- **Yes (fully local)**: DB correctness, idempotency/uniqueness, API rate limiting behavior, retry/deadlock behavior, degraded-mode Ably REST publishing with a stub.
- **Not fully local**: true Ably Realtime WebSocket semantics at scale (connection limits, presence fanout, channel throughput). We can only approximate via unit/contract tests and REST-publish stubs.

### Release posture (today)
**No-go until the “Release gates” below are green**, especially the Ably token burst gate and the 130-student boot storm gate.

---

## 2. Scope under review

### Services
- Frontend: `apps/web` (Next.js App Router)
- Backend: `apps/backend` (Rust Axum)

### Endpoints (critical)
- `GET /api/auth/ably` (Ably token request signing)
- `GET /api/sessions/:id/state` (student/projector initial state)
- `POST /api/sessions/:id/vote` (vote submission)
- `GET /api/sessions/:id/my-votes` (restore student answers)
- `POST /api/sessions/:id/questions` (student questions; includes idempotency via `X-Client-Request-Id`)
- `POST /api/sessions/:session_id/questions/:question_id/upvote` (upvote de-dup)
- `POST /api/sessions/:id/register-participant` (optional)

### Jobs/workers
- None (no separate queue consumer in-repo). Backend uses async tasks (`tokio::spawn`) for Ably publishing.

### Persistent state (MySQL tables)
- `sessions` (includes `state_version`, `vote_sequence`, `qa_sequence`)
- `slides`
- `votes`
- `vote_submissions` (enforces `limitSubmissions` without gap-lock deadlocks)
- `questions`
- `question_upvotes`
- `participants`

### Caches / queues / topics
- No Redis / queue in-repo.
- Ably channels: `session:{sessionId}`

### Third-party dependencies
- Ably Realtime (browser) + Ably REST (backend)

### Feature flags / runtime config knobs
- Rate limits:
  - `RATE_LIMIT_GENERAL_PER_SECOND`, `RATE_LIMIT_GENERAL_BURST`
  - `RATE_LIMIT_STRICT_PER_SECOND`, `RATE_LIMIT_STRICT_BURST`
- DB pool:
  - `DB_MAX_CONNECTIONS`, `DB_MIN_CONNECTIONS`, `DB_ACQUIRE_TIMEOUT_SECONDS`
- Ably:
  - `ABLY_API_KEY`, `ABLY_REST_URL`

### Migrations
- `apps/backend/migrations/*.sql` including `vote_submissions` and session sequence columns.

### Observability
- `tracing` logs in backend
- Frontend console logs (some `[DEBUG]` logs exist in websocket provider)

---

## 3. Architecture and dependency impact

### Student join / “websocket” path
- Upstream callers: browsers (many behind the same NAT IP)
- Backend dependencies: none for `GET /api/auth/ably` besides `ABLY_API_KEY` (CPU-only HMAC signing)
- Compatibility boundary: Ably token request format must remain compatible with Ably client expectations
- Operational dependency: **rate limiting** is applied per IP (`SmartIpKeyExtractor`)

### Vote submission path
- Upstream callers: browsers (bursty)
- Downstream dependencies:
  - MySQL transaction (writes `vote_submissions`, writes `votes`, updates `sessions.vote_sequence`, reads count snapshot)
  - Ably REST publish (async after commit)
- Persistent state touched:
  - `vote_submissions` uniqueness = “one submission per (slide, participant)” when `limitSubmissions=true`
  - `votes` uniqueness = “no duplicate option votes”
  - `sessions.vote_sequence` monotonically increases (contention hotspot)
- Compatibility boundary:
  - `VOTE_UPDATE` payload fields: `slideId`, `results`, `sequence`
  - Frontend ordering/dedup behavior depends on `sequence` semantics

### Initial state path (`/state` + `/my-votes`)
- Upstream callers: browsers (join storm)
- Downstream dependencies: MySQL (multiple queries)
- Performance sensitivity: `/state` aggregates vote counts; `/my-votes` reads all votes for participant

---

## 4. Risk inventory

Risk ranking heuristic: **Impact × Likelihood × Detectability gap**.

### R-01: Ably token endpoint throttled during classroom join storm (NAT)
- Failure mode: students cannot connect to realtime; Ably auth retries create a retry storm; perceived “app stuck loading”.
- Trigger: 100–130 browsers call `GET /api/auth/ably` within seconds, sharing one public IP.
- Impact: major (class cannot start; no realtime updates).
- Root cause candidate: `/api/auth/ably` treated as “strict auth” traffic and rate-limited too aggressively per IP.
- Test required: burst 130 token requests with a single source IP; assert **0×429** and bounded latency.
- Fully local? **Yes** (no DB required).
- Release blocker? **Yes**.

### R-02: Join storm overloads DB pool and increases `/state` latency
- Failure mode: `/state` timeouts, server 500s, or request queuing; students see blank/stale state.
- Trigger: 130 concurrent page loads cause `/state` (slides+questions+vote_counts+sequences) + `/my-votes` (even empty) + optional participant registration.
- Impact: high.
- Root cause candidates:
  - DB pool size too small (`DB_MAX_CONNECTIONS` defaults low).
  - Heavy aggregation query for `vote_counts`.
  - Duplicate initial-state fetches from frontend (if present).
- Test required: local join-storm test that executes the boot flow N=130 with production-like DB schema + seed data; assert p95 and error rate thresholds.
- Fully local? **Yes** (MySQL via Docker).
- Release blocker? **Yes** (must be proven).

### R-03: Vote path deadlocks / lock contention under concurrent vote burst
- Failure mode: increased deadlock retries, timeouts, or partial failure; votes dropped or delayed.
- Trigger: 130 concurrent `POST /vote` to same session/slide.
- Impact: high (votes are core value).
- Root cause candidates:
  - Hot row lock on `sessions` (`vote_sequence` increment).
  - Unique constraint/locking patterns on `vote_submissions` and `votes`.
- Test required: concurrency burst with N=130 and repeated bursts; assert all votes persisted, no duplicates, bounded latency, and no elevated deadlock failures.
- Fully local? **Yes**.
- Release blocker? **Yes**.

### R-04: Ably REST publish backlog under Ably slowness/outage
- Failure mode: background tasks pile up, memory grows, CPU increases; backend becomes unstable even though DB commits succeed.
- Trigger: Ably REST becomes slow (e.g. 1–3s), errors (500), or timeouts while votes keep flowing.
- Impact: medium→high (eventual cascade).
- Root cause candidate: unbounded `tokio::spawn` per mutation without backpressure/queue limits.
- Test required: local fault injection against Ably REST stub (delay/error/drop), with sustained vote rate; assert process stability and bounded resource usage.
- Fully local? **Partially** (we can inject Ably REST faults; we can’t emulate Ably Realtime).
- Release blocker? **Conditional** (block if we can’t demonstrate no runaway backlog).

### R-05: Client applies stale/incorrect realtime vote updates under out-of-order delivery
- Failure mode: UI vote counts regress or remain stale (especially when multiple slides receive updates).
- Trigger: out-of-order/duplicate `VOTE_UPDATE` messages on the same session channel.
- Impact: medium (trust/UX) but can cause staff decisions based on wrong data.
- Root cause candidates:
  - Sequence filtering logic too coarse (e.g. global-only filtering dropping updates for other slides).
  - Missing invariant tests for ordering across slides.
- Test required: deterministic unit tests for vote-update ordering logic with multiple slides + out-of-order sequences; assert “no regression” and “eventual convergence”.
- Fully local? **Yes** (frontend unit tests).
- Release blocker? **Yes** if logic is currently unproven.

---

## 5. Test strategy (failure-mode first)

### Functional correctness
- Vote: one submission per participant when `limitSubmissions=true`; multi-select behavior correct when enabled.
- Student restore: `/my-votes` returns correct mapping; name registration enforces `require_name`.

### Contract compatibility
- Ably token request format remains stable (fields, encoding, HMAC).
- Ably event payload schema: `STATE_UPDATE`, `VOTE_UPDATE`, `QA_UPDATE`, `SLIDES_UPDATE`.

### Data safety
- Vote uniqueness constraints and `vote_submissions` behavior prevent duplicates under retries.
- Question idempotency via `X-Client-Request-Id` does not double-insert under timeout/retry.

### Concurrency and timing
- Vote concurrency burst at N=130 with repeated bursts.
- Concurrent join storm with N=130 (state + token + my-votes).
- Deadlock retry correctness (no partial writes, no “phantom extra sequence” that breaks invariants).

### Failure recovery
- Ably REST down/slow: votes still persist, client can converge via `/state` refresh.
- DB acquire timeout behavior: should surface clear errors and not corrupt state.

### Performance guardrails (local)
- Join storm: `/state` p95 latency and error rate under N=130.
- Vote burst: p95 and p99 latency under N=130; no connection pool exhaustion.
- Ably publish: ensure no pathological backlog under injected 1s delay for 60s.

### Security and permissions
- Ably capabilities:
  - staff: `publish+subscribe+presence`
  - student/projector: `subscribe+presence`
- Rate limiting:
  - token endpoint must allow classroom bursts but remain rate-limited (no unthrottled abuse).

### Deployment safety
- Mixed-version risk mainly in frontend ordering logic and backend payload schemas; validate older/newer payload tolerance (unknown fields ignored).

### Observability
- Ensure errors and degraded mode are visible in logs with `session_id`, `slide_id`, event name.

---

## 6. Local-only test implementation plan (non-negotiable section)

### Local environment requirements (hermetic)
- Docker Compose: `docker-compose.test.yml` (MySQL 8.0, Ably REST stub, optional Toxiproxy)
- One-command boot: `./loadtest/test-concurrency.sh`
- Determinism:
  - fixed DB name/port for tests (`3307`)
  - test data created per run and torn down
  - no reliance on shared staging

### Test suite: local boot + join storm + vote burst (target = 100/130)

#### L-01: Ably token burst gate (130 in <5s, 0×429)
- Purpose: prove join storm won’t be blocked by per-IP throttling.
- Env: backend only (no DB).
- Setup:
  - start backend with `ABLY_API_KEY` set
  - ensure token endpoint is not under “strict” limiter for NAT bursts
- Execution:
  - fire **130 concurrent** `GET /api/auth/ably?sessionId=<id>&role=student&participantId=<unique>`
- Assertions:
  - **0 responses with 429**
  - `p95 < 200ms` locally (CPU-only HMAC)
  - returned JSON includes required fields: `keyName, ttl, capability, clientId, timestamp, nonce, mac`
- Pass/fail:
  - any 429 = fail (release blocker)
  - >1% non-2xx = fail
- Automation: `loadtest/run-auth-burst-test.js` (new), run via `./loadtest/test-concurrency.sh --concurrency 130`
- Runtime target: <10s
- Owner: backend

#### L-02: Student boot storm gate (130 concurrent `/state` + `/my-votes`)
- Purpose: prove join storm doesn’t time out or exhaust DB connections.
- Env: MySQL via Docker + backend.
- Fixtures:
  - session with ~20 slides (poll) and pre-seeded votes for at least 1 slide
  - optional: questions and participants seeded
- Execution:
  - for N=130:
    - `GET /api/sessions/:id/state`
    - `GET /api/sessions/:id/my-votes?participantId=<pid>`
    - (optional) `POST /register-participant` if `require_name=true`
- Assertions:
  - 0×5xx
  - 0×DB acquire timeout errors
  - `/state` `p95 < 500ms` locally (tune threshold per machine)
  - `/state` response has non-empty `slides` and includes `voteSequence/qaSequence`
- Pass/fail:
  - any 5xx burst = fail (release blocker)
  - p95 above threshold = fail until tuned/understood
- Automation: extend `loadtest/run-concurrency-tests.js` or add `loadtest/run-boot-storm-test.js`
- Runtime target: <60s
- Owner: backend

#### L-03: Vote burst correctness gate (130 participants, 1 slide)
- Purpose: prove “no duplicates, no drops” under 130 concurrent votes.
- Env: MySQL via Docker + backend + Ably REST stub.
- Setup:
  - session + poll slide with `limitSubmissions=true`
- Execution:
  - 130 concurrent `POST /vote` from distinct `participantId`s
  - repeat burst 3× with fresh slides
- Assertions:
  - DB `votes` rows == 130 per slide
  - `vote_submissions` rows == 130 per slide
  - `sessions.vote_sequence` increments by 130 per burst
  - Ably REST stub captures exactly 130 `VOTE_UPDATE` publishes per burst (or 130±0 if publish is best-effort)
- Pass/fail:
  - missing votes or duplicates = fail (release blocker)
  - DB deadlock errors exceeding retry budget = fail
- Automation: fix `--concurrency` plumbing in `loadtest/run-concurrency-tests.js` so it actually uses 100/130; add explicit 130 scenario
- Runtime target: <90s
- Owner: backend

#### L-04: Ably degraded mode gate (delay/error/drop)
- Purpose: prove DB commit safety + bounded backend behavior when Ably is unhealthy.
- Env: MySQL via Docker + backend + Ably REST stub fault injection.
- Execution:
  - set stub to delay `1000ms`, run sustained vote rate (e.g. 20 rps) for 60s
  - set stub to error `100%`, repeat
  - set stub to drop `50%` (timeout), repeat
- Assertions:
  - vote API remains 2xx
  - DB has expected vote rows
  - backend does not OOM / become unresponsive
  - logs contain structured “publish failed” warnings with `session_id` and `slide_id`
- Pass/fail:
  - vote endpoint becomes unreliable (5xx/timeout) = fail
  - evidence of runaway task backlog = fail (release blocker if reproducible)
- Automation: extend loadtest runner to run sustained mode + basic memory sampling (`ps`/RSS)
- Runtime target: 3–5 min
- Owner: backend

#### L-05: Frontend ordering invariants (unit tests; deterministic)
- Purpose: prove duplicate/out-of-order messages can’t regress state.
- Env: `pnpm --filter web test`
- Tests (exact):
  - vote updates across **two slides** arriving out of order must update both slides eventually (no cross-slide drops).
  - duplicate `VOTE_UPDATE` with same `sequence` must be ignored.
  - `STATE_UPDATE` must respect `state_version` monotonicity (`shouldApplyStateUpdate` already exists).
- Assertions:
  - voteResults for slide A and B reflect latest update for each slide
  - no “older” results overwrite newer for same slide
- Pass/fail:
  - any regression in invariants = fail (release blocker)
- Owner: frontend

---

## 7. Release gates

Release is blocked until all “Yes” items are satisfied:
- **G-01 (blocker)**: L-01 Ably token burst gate passes at **N=130** (0×429).
- **G-02 (blocker)**: L-02 boot storm gate passes at **N=130** with 0×5xx and acceptable p95.
- **G-03 (blocker)**: L-03 vote burst correctness gate passes at **N=130** (no duplicates/drops).
- **G-04 (blocker)**: L-05 frontend ordering invariants pass in CI and locally.
- **G-05 (conditional blocker)**: L-04 degraded mode gate passes or we implement backpressure/queueing for Ably publishing.
- **G-06**: DB pool configured for expected load (documented `DB_MAX_CONNECTIONS` and verified under join storm).

---

## 8. Residual risk and unknowns

These cannot be fully proven locally without a true Ably Realtime emulator:
- Real Ably WebSocket connection limits and TLS handshake cost at 130 concurrent users.
- Presence fanout behavior (if/when used) and its impact on message rates.
- Real-world network variability (mobile, high latency, packet loss) affecting Ably reconnect storms.
- Production DB connection limits and latency variance compared to local MySQL.

Mitigation: keep a **production-safe observability plan** (alerts on 429 rate, Ably publish failures, DB acquire timeouts) and a rollback plan.

---

## 9. Final go / no-go recommendation

**No-go** until:
1) Ably token endpoint proves it can handle a 130-student NAT burst with **0×429**, and  
2) join storm + vote burst gates are green locally with pinned infra, and  
3) frontend ordering invariants are proven by deterministic unit tests.

Once those gates are satisfied, the recommendation becomes **Go with conditions**:
- Condition A: confirm production DB connection limits and set `DB_MAX_CONNECTIONS` accordingly.
- Condition B: confirm Ably plan limits (connections / message rate) match the classroom target.
