# Bug #2: Sequence Race Conditions — Local-Only Test Plan

## Executive summary

This plan adds **release-blocking, local-only concurrency tests** that prove:

- Every committed mutation that triggers a realtime publish emits a **strictly increasing, gapless** `sequence` in `VOTE_UPDATE` and `QA_UPDATE`.
- No two publishes share the same `sequence` (the failure mode that causes the frontend to drop a valid update when it dedupes on `<= lastSeq`).
- The **database sequence columns** (`sessions.vote_sequence`, `sessions.qa_sequence`) end at exactly the max published `sequence` (guards against “publish reads the wrong sequence”).

These tests are designed to be as real as possible:

- **Real MySQL 8.0** (docker)
- **Real backend binary** (`cargo run`) with real handlers + transactions
- **Ably REST stub** (local) used only to capture outbound publish payloads and to inject faults when desired

## Scope under review

**Endpoints / flows**

- `POST /api/sessions/:id/vote` → publishes `VOTE_UPDATE { sequence, slideId, results }`
- `POST /api/sessions/:id/questions` → publishes `QA_UPDATE { sequence, payload.questions }`
- `POST /api/sessions/:id/questions/:questionId/upvote` → publishes `QA_UPDATE { sequence, payload.questions }` (only when the upvote is new)

**Persistent state**

- `sessions.vote_sequence`
- `sessions.qa_sequence`

**Async boundary**

- Ably publish is executed in a `tokio::spawn` after DB commit; tests must tolerate this and wait for publishes.

## Architecture and dependency impact

**Why “DB sequence looks fine” is insufficient**

A class of bugs can exist where:

- the DB increments correctly (`vote_sequence` ends at N), **but**
- the published payload reads the wrong sequence (e.g., both publishes emit `sequence=6`)

This is invisible to tests that only assert the final DB value. The test plan therefore validates **publish payloads** directly via the Ably stub’s capture endpoint.

## Risk inventory (Bug #2)

### R-SEQ-01: Duplicate published sequence under concurrent writers (Release blocker)

- **Failure mode:** two `VOTE_UPDATE` (or `QA_UPDATE`) publishes contain the same `sequence`.
- **Trigger:** concurrent requests where “increment sequence” and “read sequence” are not effectively atomic from the publisher’s perspective.
- **User impact:** frontend dedupe (`sequence <= lastSeq`) drops one update → users see stale vote counts / questions.
- **Local reproduction:** burst concurrent requests (50+) and assert captured sequences are gapless + unique.
- **Required test:** Ably-capture based sequence uniqueness + contiguity check (implemented; see below).
- **Testable fully locally:** yes.

### R-SEQ-02: Publish count mismatch (Detectability gap) (Release blocker)

- **Failure mode:** request commits but publish doesn’t happen (or happens fewer times than committed mutations).
- **Trigger:** publish task failures, timeouts, unexpected early returns, swallowed errors.
- **User impact:** realtime UI doesn’t converge without refresh; projector can lag.
- **Local reproduction:** compare success-count vs captured publish-count for the same session and operation.
- **Required test:** wait for expected capture count; fail if under-delivered.
- **Testable fully locally:** yes (with Ably stub).

## Test strategy (failure-mode first)

### Core invariants to prove

1. For a session, each successful write that should publish yields **exactly one** publish event of the expected type.
2. Captured `sequence` values are:
   - **unique**
   - **strictly increasing by 1 as a set** (gapless)
   - start at `baseline + 1` and end at `baseline + successCount`
3. DB `sessions.{vote_sequence,qa_sequence}` ends at the same `expectedMax` as the captured set.

### Why “gapless” matters

If two publishes share `sequence=6`, then in a run of two concurrent writes you get a set like `{6,6}`:

- **duplicate detected** (unique-set check fails)
- **gap detected** (missing `5`) even if duplicates somehow slip through

This makes the test robust to different timing/orderings.

## Local-only test implementation plan (what exists + how it works)

### Environment (one machine, no staging)

- Docker services: MySQL + Ably stub
- Backend: local `cargo run` using test env vars
- Runner: `node` scripts in `loadtest/`

### Orchestration

`class-collaboration/loadtest/test-concurrency.sh` now:

1. Brings up `docker-compose.test.yml`
2. Runs migrations against `mysql://...:3307/classcolab_test`
3. Runs `cargo test` (unit tests)
4. Starts backend automatically (unless `--skip-backend`) and waits for `GET /health/ready`
5. Runs concurrency tests (`node run-concurrency-tests.js ...`)
6. Stops backend (unless `--leave-backend`)
7. Tears down docker (unless `--skip-cleanup`)

### Tests added for Bug #2 (release blockers)

Implemented in `class-collaboration/loadtest/run-concurrency-tests.js`:

#### T-07: Vote publish sequence uniqueness (VOTE_UPDATE)

- **Setup:**
  - Create a fresh slide for isolation
  - Read `baseline = sessions.vote_sequence`
  - Clear Ably captures
- **Action:** send `min(concurrency, 50)` concurrent `POST /vote` (distinct participants)
- **Assert:**
  - All requests return `2xx`
  - Captured `VOTE_UPDATE` count reaches `successCount`
  - Captured `sequence` set is **unique + gapless** for `(baseline+1 .. baseline+successCount)`
  - DB `vote_sequence == expectedMax`

#### T-08: Q&A publish sequence uniqueness (QA_UPDATE) for question creates

- **Setup:** read `baseline = sessions.qa_sequence`, clear captures
- **Action:** send `min(concurrency, 30)` concurrent `POST /questions`
- **Assert:** same uniqueness + gapless set and DB final match

#### T-09: Q&A publish sequence uniqueness (QA_UPDATE) for upvotes

- **Setup:**
  - Create one seed question (excluded from the measured baseline)
  - Read `baseline = sessions.qa_sequence`, clear captures
- **Action:** send `min(concurrency, 40)` concurrent `POST /questions/:id/upvote` (distinct participants)
- **Assert:** same uniqueness + gapless set and DB final match

#### T-13: Vote sequence stress (multiple rounds + jitter)

- **Purpose:** increase probability of catching “same sequence published twice” regressions by running repeated bursts.
- **Action:** run 5 rounds of `min(concurrency, 60)` concurrent `POST /vote` with small random client-side jitter.
- **Assert (each round):** published `VOTE_UPDATE.sequence` values are unique + gapless relative to the round’s DB baseline and DB `vote_sequence` ends at the expected max.

#### T-14: Vote sequence correctness when `limitSubmissions=false`

- **Purpose:** cover the branch that skips the `vote_submissions` reservation table (different locking profile).
- **Action:** create a poll slide with `limitSubmissions=false`, then run a jittered vote burst.
- **Assert:** same sequence uniqueness + gapless + DB final-value invariants as T-07.

#### Hardening: T-01 now asserts sequence doesn’t inflate on duplicate submissions

- **Purpose:** ensure “duplicate vote attempts” don’t accidentally increment `vote_sequence` multiple times.
- **Assert:** for N concurrent duplicate submissions by the same participant, DB `vote_sequence` increases by exactly 1.

### How to run

From `class-collaboration/loadtest/`:

```bash
./test-concurrency.sh --concurrency 100
```

Useful variants:

```bash
./test-concurrency.sh --concurrency 200 --skip-cleanup
./test-concurrency.sh --skip-backend    # if you already started backend yourself
./test-concurrency.sh --leave-backend   # keep backend running for manual inspection
```

### Pass/fail criteria

- **Fail** if any of `T-07/T-08/T-09/T-13/T-14` fail.
- **Fail** if Ably stub does not capture enough events (publish under-delivery).
- **Fail** if sequences are not gapless and unique relative to DB baseline.

### Runtime target

- `--concurrency 100`: typically < 30–60s end-to-end on a dev laptop (dominated by backend compile on first run).

## Release gates

Hard gates for shipping changes touching sequencing or publish paths:

1. `./test-concurrency.sh --concurrency 100` green
2. `T-07/T-08/T-09/T-13/T-14` green at least once with `--concurrency 200` on a developer machine before release
3. Any changes to `sessions.vote_sequence` / `sessions.qa_sequence` logic must include:
   - Ably-capture based assertion
   - DB final-value assertion

## Residual risk and unknowns

- **Client-side dedupe logic** is not exercised here (we validate server publish invariants). A separate UI-level test would be needed to prove “no regression under delayed/out-of-order delivery” end-to-end.
- **Mixed-version rollouts** (old clients + new server) are not covered. If event payload shape changes, add contract tests that replay old payloads through the new client and vice versa.
- If Ably behavior differs materially from the stub (headers, batching, retries), add a local contract fixture that matches Ably’s documented REST envelope.

## Final recommendation

**Go with conditions** once `T-07/T-08/T-09/T-13/T-14` are consistently green in CI or in a documented pre-release checklist run, because they close the main detectability gap for Bug #2 (duplicate published sequences under concurrency).
