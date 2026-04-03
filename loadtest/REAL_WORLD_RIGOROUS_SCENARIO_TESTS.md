# Real-World Rigorous Scenario Tests (Local-Only)

## Purpose

This document defines additional **production-safety scenario tests** that simulate a realistic classroom:

- **100 students join at the same time**
- Students register names (participant table)
- Students vote concurrently on a live poll
- Staff dashboard is actively used during the burst (stats polling + live controls)

The goal is to catch failures that only appear during **cross-feature contention**:

- lock contention on the `sessions` row (vote sequence increments + staff state updates)
- publish correctness under concurrent writers
- join storms interacting with live reads (stats polling)

All tests are **local-only** and use:

- Real MySQL (docker)
- Real backend server (`cargo run`)
- Ably stub (captures outbound publish payloads)

## Key failure modes (what these scenarios target)

### FM-01: Sequence corruption under mixed writers (Release blocker)

If vote updates publish duplicate/non-gapless `sequence`, the client can drop valid updates.

**Proof:** Ably-capture assertions that published sequences are **unique + gapless** for each burst.

### FM-02: Join storm breaks live dashboard reads (Release blocker)

Stats/dashboard endpoints should remain available while many students join/register and vote.

**Proof:** Repeated `GET /api/sessions/:id/stats` remains `2xx` and returns valid JSON shape.

### FM-03: Cross-feature deadlocks/timeouts (Release blocker)

Staff live controls (`go-live`, `current-slide`, `results-visibility`) and votes both touch `sessions`.

**Proof:** mixed workload finishes without 5xx/timeouts; DB counts match expectations.

## Implemented scenario tests

### T-10: Realistic Scenario (Join + Dashboard + Vote)

Implemented in: `class-collaboration/loadtest/run-concurrency-tests.js`

**What it does**

1. Creates a real staff user via:
   - `POST /api/auth/register`
   - `POST /api/auth/login` (uses returned JWT token with `Authorization: Bearer ...`)
2. Inserts a session owned by that staff user + multiple slides (DB insert).
3. Runs in parallel:
   - 100 student join storm:
     - `GET /api/auth/ably` token request (schema validated)
     - `POST /api/sessions/:id/register-participant` (writes `participants`)
   - staff dashboard activity:
     - `POST /api/sessions/:id/go-live`
     - `PUT /api/sessions/:id/current-slide`
     - repeated `GET /api/sessions/:id/stats`
     - repeated `PUT /api/sessions/:id/results-visibility`
4. After join completes, runs a vote burst (100 students) and verifies:
   - Ably stub captured **exactly N** `VOTE_UPDATE` for that slide
   - published `sequence` values are **unique + gapless** relative to DB baseline
   - DB vote count matches N
   - DB `sessions.vote_sequence` matches captured max sequence

**Why this matters**

This reproduces the “real classroom” risk window: heavy parallelism + staff read/write actions while vote sequence is updating.

### T-11: Interleaved Writers (votes + questions + upvotes)

Implemented in: `class-collaboration/loadtest/run-concurrency-tests.js`

**What it does**

1. Creates a new session + poll slide (DB insert).
2. Seeds 1 question (so upvotes have a target).
3. Takes DB baselines (`vote_sequence`, `qa_sequence`), clears Ably captures.
4. Executes concurrently:
   - vote burst (N)
   - question burst (M)
   - upvote burst (K)
5. Verifies:
   - `VOTE_UPDATE` sequences are **unique + gapless** from `baselineVote+1 .. baselineVote+N`
   - `QA_UPDATE` sequences are **unique + gapless** from `baselineQa+1 .. baselineQa+(M+K)`
   - DB sequences match the captured max for each stream

**Why this matters**

This catches bugs where vote and Q&A sequencing are individually correct in isolation but fail under shared resource contention (DB pools, session-row locks, publish timing).

## How to run

From `class-collaboration/loadtest/`:

```bash
./test-concurrency.sh --concurrency 100
```

Notes:

- `T-10` caps at 100 students even if `--concurrency` is larger (keeps runtime bounded).
- If debugging, use:
  - `./test-concurrency.sh --concurrency 100 --skip-cleanup --leave-backend`
  - inspect Ably captures: `curl http://localhost:8081/admin/captures`

## Pass / fail (release gates)

Treat these as **hard gates** for shipping changes affecting sessions/votes/Q&A/realtime:

- `T-10` must pass at `--concurrency 100`
- `T-11` must pass at `--concurrency 100`
- Any failure is a **no-go** until root-caused (race, lock contention, publish mismatch, rate limiting).

## Next scenarios to add (if you want to go further)

If you want even more realism, the next highest-value additions are:

- **Delayed/out-of-order delivery** simulation at the subscriber layer (requires a synthetic client that applies messages with the same dedupe logic as the frontend).
- **Fault injection on the DB path** using Toxiproxy (latency spikes + connection resets) to validate retry/idempotency behavior.

