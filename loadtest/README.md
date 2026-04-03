# Concurrency Test Suite

This directory contains the test infrastructure for verifying vote correctness, realtime event ordering, and fault tolerance under concurrent load.
It also includes a burst test for Ably token signing to ensure classroom NAT join storms (e.g. 130 students) are not rate-limited.

## Quick Start

### 1. Start Test Infrastructure

```bash
# Start MySQL, Ably stub, and test runner
cd loadtest
npm run setup
npm run docker:up

# Wait for services to be healthy (about 30 seconds)
npm run docker:logs
```

### 2. Start Backend in Test Mode

```bash
cd apps/backend

# Set test environment variables
export DATABASE_URL="mysql://classcolab:testpassword@localhost:3307/classcolab_test"
export ABLY_API_KEY="test.key:secret"
export ABLY_REST_URL="http://localhost:8081"

# Run migrations
./run_migration.sh

# Start backend
cargo run
```

### 3. Run Concurrency Tests

```bash
cd loadtest

# Run all tests
npm run test:concurrency

# Or run with specific concurrency levels
npm run test:concurrency:100
npm run test:concurrency:130
npm run test:concurrency:300
npm run test:concurrency:500
```

### 3a. Run Ably Token Burst Test (Join Storm Gate)

```bash
cd loadtest

# Burst 130 Ably token requests; fails on any 429
npm run test:auth-burst:130
```

### 3b. Run Against a Live Backend URL

```bash
cd loadtest

# Auth-burst only against prod or staging
ABLY_API_KEY="..." ./test-concurrency.sh --base-url https://prod.example.com --concurrency 130
```

This mode only runs the Ably token burst against the live backend URL. The rest of
`test-concurrency.sh` stays local-only because it depends on Docker MySQL, the Ably stub,
and direct database assertions.

### 3c. Run the Full HTTPS k6 Scenario

```bash
cd loadtest

ABLY_API_KEY="..." PERF_TEST_TOKEN="..." ./test-concurrency-k6.sh --base-url https://prod.example.com --concurrency 100
# or
npm run test:prod-concurrency -- --base-url https://prod.example.com
# write a CI-friendly JSON summary
ABLY_API_KEY="..." PERF_TEST_TOKEN="..." ./test-concurrency-k6.sh \
  --base-url https://prod.example.com \
  --summary-file ./artifacts/prod-concurrency-summary.json
```

This scenario drives the real backend API over HTTPS with `k6`:

- staff signup/login
- session + slide creation
- Ably token burst
- participant registration
- live controls + stats reads
- vote burst
- question burst + upvotes
- final state/stats verification
- guarded cleanup via `DELETE /api/internal/perf/sessions/:id`

Set `PERF_TEST_TOKEN` on the backend to enable the cleanup route. If you want to keep
the temporary session for inspection, add `--skip-cleanup`.

### 4. Clean Up

```bash
npm run docker:down
```

---

## Test Infrastructure

### Components

| Component | Port | Description |
|-----------|------|-------------|
| MySQL Test | 3307 | Isolated MySQL 8.0 instance for testing |
| Ably Stub | 8081 | Mock Ably REST API with fault injection |
| Toxiproxy | 8474, 3308 | Network fault injection (optional) |

### Ably Stub Features

The Ably stub (`ably-stub/`) mimics the Ably REST API and supports:

- **Event Capture**: All published events are stored in `/tmp/ably-captures/`
- **Fault Injection**:
  - `delay`: Add artificial latency to responses
  - `drop`: Randomly fail to respond (simulate timeout)
  - `duplicate`: Send duplicate responses
  - `reorder`: Reorder batched messages
  - `error`: Return HTTP 500 errors

#### Fault Injection API

```bash
# Get current fault config
curl http://localhost:8081/admin/fault

# Set delay mode (1 second delay)
curl -X POST http://localhost:8081/admin/fault \
  -H "Content-Type: application/json" \
  -d '{"mode": "delay", "delayMs": 1000}'

# Set error mode (100% error rate)
curl -X POST http://localhost:8081/admin/fault \
  -H "Content-Type: application/json" \
  -d '{"mode": "error", "errorRate": 1.0}'

# Set drop mode (50% drop rate)
curl -X POST http://localhost:8081/admin/fault \
  -H "Content-Type: application/json" \
  -d '{"mode": "drop", "dropRate": 0.5}'

# Reset to normal operation
curl -X DELETE http://localhost:8081/admin/fault

# Get captured events
curl http://localhost:8081/admin/captures

# Clear captured events
curl -X DELETE http://localhost:8081/admin/captures
```

---

## Test Suite

### T-01: Same-Participant Vote Race

**Purpose:** Verify that a single participant cannot submit multiple votes even with concurrent requests.

**Test:** Fire 2, 5, and 10 parallel vote submissions for the same participant.

**Assertion:** Exactly ONE vote is persisted per participant per slide.

**Expected Results:**
- All concurrent requests complete (some may return 400/409)
- Database contains exactly 1 vote for the participant
- No duplicate-key errors in logs

---

### T-02: Burst Vote Load

**Purpose:** Verify vote handling under burst load from multiple participants.

**Test:** Submit votes from 100, 300, and 500 distinct participants concurrently.

**Assertion:** All votes persist correctly, no DB errors, bounded latency.

**Expected Results:**
- All votes persist (count matches expected)
- p95 latency < 500ms
- No connection pool exhaustion

---

### T-03: Invalid Option Rejection

**Purpose:** Verify that votes with invalid option IDs are rejected.

**Test:** Mix valid and invalid option IDs in concurrent submissions.

**Assertion:** Only valid options persist, invalid payloads return 400 errors.

**Expected Results:**
- Valid votes: 200 OK, persisted in DB
- Invalid votes: 400 Bad Request, not persisted
- No partial writes or corruption

---

### T-04: Retry-After-Timeout Safety

**Purpose:** Verify that retrying a vote after timeout doesn't create duplicates.

**Test:** Submit vote, simulate timeout after DB write, retry with same request ID.

**Assertion:** No duplicate business effect (idempotency).

**Expected Results:**
- First request: timeout or success
- Retry: idempotent response (same vote)
- Database: exactly 1 vote

---

### T-06: Ably Fault Injection

**Purpose:** Verify graceful degradation when Ably publish fails.

**Test:** 
1. Set Ably stub to delay mode, submit vote
2. Set Ably stub to error mode, submit vote

**Assertion:** Votes succeed despite Ably failures, warnings logged.

**Expected Results:**
- Vote endpoints return 200 OK
- Backend logs contain "realtime publish failed" warnings
- Clients converge via refresh (verified in e2e tests)

---

### T-07: Duplicate/Reordered Event Resilience

**Purpose:** Verify frontend correctly handles duplicate and out-of-order events.

**Test:** 
1. Set Ably stub to duplicate mode
2. Submit vote, verify frontend applies only latest
3. Set Ably stub to reorder mode
4. Submit multiple votes, verify correct ordering

**Assertion:** Frontend skips stale/duplicate messages based on sequence numbers.

**Expected Results:**
- Frontend vote counts match database
- No backward count updates
- Sequence numbers monotonically increase

---

### T-08: Slide Edit Propagation

**Purpose:** Verify connected clients receive slide updates immediately.

**Test:**
1. Connect student and projector clients
2. Staff creates/updates/deletes slide
3. Verify clients refetch slides automatically

**Assertion:** Connected clients see updated slides within 5 seconds.

**Expected Results:**
- `SLIDES_UPDATE` event published
- Frontend `lastSlideUpdate` timestamp updates
- Slide content matches backend

---

### T-09: Mixed Presenter+Student Concurrency

**Purpose:** Verify correctness under realistic load (presenter + students).

**Test:**
1. Start 100+ student clients voting concurrently
2. Presenter advances slides, toggles results visibility
3. Verify state consistency across all clients

**Assertion:** `state_version` monotonicity, no corrupted counts.

**Expected Results:**
- All state updates apply in order
- Vote counts match database truth
- No stale updates override newer state

---

### T-10: Migration + Concurrency Replay

**Purpose:** Verify schema migrations work correctly under concurrent load.

**Test:**
1. Apply migrations to test database
2. Immediately execute concurrent vote workload
3. Verify no duplicate-key errors or state corruption

**Assertion:** Stable state after migration, continued correctness.

**Expected Results:**
- Migration completes without errors
- Concurrent workload succeeds
- Final state matches expected

---

## Troubleshooting

### MySQL Connection Refused

```bash
# Check if MySQL is running
docker ps | grep mysql

# Check logs
docker logs classcolab-test-mysql

# Restart if needed
npm run docker:down
npm run docker:up
```

### Ably Stub Not Responding

```bash
# Check health endpoint
curl http://localhost:8081/health

# Check logs
docker logs classcolab-test-ably-stub

# Restart if needed
docker restart classcolab-test-ably-stub
```

### Test Failures

1. **Check backend logs** for errors:
   ```bash
   journalctl -u backend -f  # systemd
   # or
   tail -f /var/log/backend.log
   ```

2. **Check database state**:
   ```bash
   docker exec -it classcolab-test-mysql mysql \
     -u classcolab -ptestpassword classcolab_test \
     -e "SELECT COUNT(*) FROM votes;"
   ```

3. **Check Ably captures**:
   ```bash
   docker exec classcolab-test-ably-stub ls -la /tmp/ably-captures/
   docker exec classcolab-test-ably-stub cat /tmp/ably-captures/*.json
   ```

---

## Adding New Tests

1. Create test function in `run-concurrency-tests.js`:
   ```javascript
   async function testTXX_testName(sessionId, slideId) {
     log('T-XX: Test Name', 'test');
     
     // Test implementation
     // ...
     
     return true; // or false for failure
   }
   ```

2. Add to test runner:
   ```javascript
   const tests = [
     // ...
     { name: 'T-XX', fn: () => testTXX_testName(sessionId, slideId) },
   ];
   ```

3. Document in this README.

---

## Performance Benchmarks

| Test | Concurrency | Target p95 | Target p99 |
|------|-------------|------------|------------|
| T-01 | 10 | 100ms | 200ms |
| T-02 | 100 | 200ms | 500ms |
| T-02 | 300 | 300ms | 800ms |
| T-02 | 500 | 500ms | 1000ms |
| T-03 | 10 | 100ms | 200ms |

---

## References

- [Core Feature Audit](../core_feature_audit.md) - Original risk assessment
- [Production Fixes Summary](../PRODUCTION_FIXES_SUMMARY.md) - Implementation details
- [Architecture](../ARCHITECTURE.md) - System design and concurrency patterns
