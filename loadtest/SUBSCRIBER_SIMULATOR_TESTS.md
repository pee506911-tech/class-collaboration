# Subscriber Simulator Tests (Local-Only)

## Goal

Validate that a client which:

1. fetches `/api/sessions/:id/state` (snapshot), and
2. receives delayed/out-of-order realtime messages afterwards,

**never regresses UI state** as long as it correctly seeds and enforces the snapshot sequence numbers.

This is the “real-world” failure mode behind refresh/reconnect glitches:

- snapshot is correct (latest)
- delayed message arrives later (older)
- if the client’s `last*Sequence` refs are not seeded from the snapshot, it can accept the stale message and overwrite fresh UI data.

These tests are **not a browser E2E**; they are a deterministic “client state machine” simulator that replays captured publish payloads from the Ably stub.

## What we simulate

### State inputs

- Snapshot: `GET /api/sessions/:id/state`
  - `voteSequence`, `voteCounts`
  - `qaSequence`, `questions`

- Realtime payloads: captured from Ably stub:
  - `VOTE_UPDATE { slideId, results, sequence }`
  - `QA_UPDATE { payload: { questions }, sequence }`

### Client logic we model (matches the dedupe semantics)

- Drop if `message.sequence <= lastSequence`
- Otherwise accept and set state, then update `lastSequence`

## Implemented test

### T-12: Snapshot + delayed message skew (vote + Q&A)

Implemented in: `class-collaboration/loadtest/run-concurrency-tests.js`

**Vote subtest**

1. Create a fresh session + poll slide.
2. Send 15 votes (each increments `voteSequence`).
3. Capture all `VOTE_UPDATE` via Ably stub.
4. Fetch snapshot `/state` (gets `voteSequence=S` and latest `voteCounts`).
5. Pick a stale captured message with `sequence < S`.
6. Replay the stale message to:
   - **Correct client (seeded)**: `lastVoteSequence = S` → stale message dropped → voteCounts unchanged.
   - **Buggy client (unseeded)**: `lastVoteSequence = 0` → stale message accepted → voteCounts regresses.  
     This is a “sensitivity check” to ensure the test would catch a missing seeding bug.

**Q&A subtest**

Same structure using `QA_UPDATE` and `qaSequence`.

## Why this is valuable

This test closes a real production gap:

- server-side sequence correctness is necessary but not sufficient
- clients must seed from snapshot consistently, or they will regress on delayed delivery after refresh/reconnect

## How to run

From `class-collaboration/loadtest/`:

```bash
./test-concurrency.sh --concurrency 100
```

`T-12` is included in the node-based suite run by the script.

## Limits / follow-ups

- This does not exercise actual React state update code; it validates the invariant with a simulated reducer.
- If you want a true end-to-end test, next step is a Playwright test that opens 2 clients, forces reconnect, and asserts UI never regresses. (Heavier + more flaky; keep this simulator as the fast release gate.)

