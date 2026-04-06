# Speed Audit Log Testing Guide

This directory contains comprehensive test scripts to validate the speed audit logging infrastructure added to the backend WebSocket sync pipeline.

## Overview

The speed audit logs track timing at **9 critical points** in the sync pipeline:

```
User Action → WAL → Outbox → Broadcast → WebSocket → Client
     [1]      [2]     [3]       [4]         [5]       [6]
```

1. **WAL entry appended** - When slide/vote mutations are queued
2. **WAL flush started** - When WAL worker begins processing
3. **WAL flush completed** - How long MySQL flush took
4. **Outbox event enqueued** - When event enters outbox queue
5. **Handler-level enqueue** - Slide/state mutation entry points
6. **Outbox event published** - Queue wait time (critical!)
7. **Batch processing** - Average latency per batch
8. **WebSocket delivery** - Broadcast → WS send time (critical!)
9. **Client receives** - (Frontend, not logged here)

## Test Scripts

### 1. `test-speed-audit-logs.sh` - Functional Test

**Purpose**: Validates that all 9 audit log points fire correctly during real operations.

**What it does**:
- Creates a test session
- Performs slide edits (triggers WAL logs)
- Uses live controls (triggers STATE_UPDATE logs)
- Sets up votes and questions
- Analyzes backend logs for audit entries
- Reports pass/fail for each audit log point

**Usage**:

```bash
# Basic usage (requires backend log file)
./test-speed-audit-logs.sh \
  --base-url https://your-backend.railway.app \
  --perf-test-token $PERF_TEST_TOKEN \
  --log-file /path/to/backend.log

# Skip cleanup to inspect session
./test-speed-audit-logs.sh \
  --base-url https://your-backend.railway.app \
  --skip-cleanup \
  --log-file /path/to/backend.log

# Generate JSON summary
./test-speed-audit-logs.sh \
  --base-url https://your-backend.railway.app \
  --perf-test-token $PERF_TEST_TOKEN \
  --log-file /var/log/backend.log \
  --summary-file audit-test-summary.json
```

**Output**:
```
========================================================================
  Speed Audit Log Test Suite
========================================================================

[INFO] Base URL: https://your-backend.railway.app
[INFO] Client Count: 10
[INFO] Timestamp: 2026-04-06T12:00:00Z

[INFO] Step 1: Authenticating user...
[PASS] Authentication successful
[INFO] Step 2: Creating test session...
[PASS] Session created: abc-123-def
[INFO] Step 3: Creating slides (triggers WAL + Outbox audit logs)...
[PASS] Created slide 1: slide-001
[PASS] Created slide 2: slide-002
[PASS] Created slide 3: slide-003
...

[PASS] 1. WAL entry appended - Found 15 occurrences
[PASS] 2. WAL flush started - Found 5 occurrences
[PASS] 3. WAL flush completed - Found 5 occurrences
[PASS] 4. Outbox event enqueued - Found 12 occurrences
[PASS] 5. Slide handler enqueue - Found 8 occurrences
[PASS] 6. State handler enqueue - Found 4 occurrences
[PASS] 7. Outbox event published - Found 12 occurrences
[PASS] 8. Batch processing completed - Found 3 occurrences
[PASS] 9. WebSocket delivery - Found 48 occurrences

[INFO] Timing Metrics Summary:

[INFO]   Outbox Queue Wait Time: avg=85ms, max=142ms
[INFO]   WAL Flush Duration: avg=25ms
[INFO]   WebSocket Delivery: avg=3ms, max=8ms

========================================================================
  Test Summary
========================================================================

[INFO] Total Tests:  9
[PASS] Passed:       9
[INFO] Failed:       0

✅ ALL AUDIT LOG TESTS PASSED
```

---

### 2. `test-speed-audit-load.sh` - Load Test

**Purpose**: Generates realistic classroom load to stress-test the sync pipeline under concurrency.

**What it does**:
- Runs k6 load test with multiple scenarios:
  - Teachers editing slides concurrently
  - Teachers using live controls (go live, navigate)
  - Students voting on polls
  - Students asking questions
  - Batch slide creation
- Tracks success rates for each operation
- Extracts timing metrics from k6 output
- Analyzes backend audit logs (if log file provided)
- Generates comprehensive JSON summary

**Usage**:

```bash
# Basic load test with 50 concurrent users
./test-speed-audit-load.sh \
  --base-url https://your-backend.railway.app \
  --concurrency 50 \
  --duration 5m \
  --perf-test-token $PERF_TEST_TOKEN

# High load test with 200 concurrent users
./test-speed-audit-load.sh \
  --base-url https://your-backend.railway.app \
  --concurrency 200 \
  --duration 10m \
  --perf-test-token $PERF_TEST_TOKEN \
  --summary-file load-test-summary.json \
  --log-file /var/log/backend.log

# Short test for quick validation
./test-speed-audit-load.sh \
  --base-url https://your-backend.railway.app \
  --concurrency 20 \
  --duration 1m \
  --skip-cleanup
```

**What gets tested**:
- **Slide Editor Scenario**: Concurrent slide edits → WAL queue pressure
- **Live Controls Scenario**: State updates → outbox queue pressure
- **Student Votes Scenario**: Vote bursts → VOTE_UPDATE pressure
- **Student Questions Scenario**: QA submissions → QA_UPDATE pressure
- **Batch Creation Scenario**: Large slide batches → batch processing pressure

**Output**:
```
========================================================================
  Speed Audit Load Test
========================================================================

[INFO] Base URL: https://your-backend.railway.app
[INFO] Concurrency: 100
[INFO] Duration: 5m
[INFO] Timestamp: 2026-04-06T12:00:00Z

     /\      |‾‾| /‾‾/   /‾‾/   
    /  \     |  |/  /   /  /    
   / /‾‾\    |     (   /   ‾‾\  
  / /    \   |  |\  \ |  (‾)  | 
 / /      \  |__| \__\ \_____/

  execution: local
     script: ./k6/speed-audit-load.js
     output: json (/tmp/k6-speed-audit-output.json)

  scenarios: (100.00%) 5 scenarios
           ✔ slideEditor: 100.00% of 100 VUs
           ✔ liveControls: 100.00% of 100 VUs
           ✔ studentVotes: 100.00% of 100 VUs
           ✔ studentQuestions: 100.00% of 100 VUs
           ✔ batchSlideCreation: 100.00% of 100 VUs

  ✓ slide_edit_success.........: 99.8%  ✓ state_update_success.....: 100.0%
  ✓ vote_success.............: 99.5%  ✓ question_success.........: 99.9%

========================================================================
  Load Test Summary
========================================================================

k6 Metrics:
  HTTP Request Duration:
    avg: 145ms
    p95: 320ms
    p99: 580ms

Audit Log Timing Metrics:
  Outbox Queue Wait:
    avg: 95ms
    p95: 165ms
    max: 245ms
  WAL Flush Duration:
    avg: 28ms
  WebSocket Delivery:
    avg: 4ms
    p95: 9ms
    max: 15ms

Audit Log Counts:
  WAL entries appended: 1250
  WAL flushes: 420
  Outbox events enqueued: 1180
  Outbox events published: 1180
  WS deliveries: 4720
  Total audit logs: 8750

Success Rates:
  Slide edits: 99.8%
  State updates: 100.0%
  Votes: 99.5%
  Questions: 99.9%
```

---

### 3. `analyze-speed-audit-logs.sh` - Log Analyzer

**Purpose**: Deep-dive analysis of backend audit logs to identify bottlenecks and optimization opportunities.

**What it does**:
- Parses backend log files for SPEED_AUDIT entries
- Calculates comprehensive timing statistics (avg, p50, p95, p99, max)
- Identifies bottlenecks with actionable recommendations
- Filters by session ID or time range
- Outputs text or JSON reports

**Usage**:

```bash
# Analyze all audit logs
./analyze-speed-audit-logs.sh /var/log/backend.log

# Analyze specific session
./analyze-speed-audit-logs.sh /var/log/backend.log \
  --session abc-123-def

# Analyze time range
./analyze-speed-audit-logs.sh /var/log/backend.log \
  --time-start "2026-04-06T10:00:00Z" \
  --time-end "2026-04-06T11:00:00Z"

# Export JSON report
./analyze-speed-audit-logs.sh /var/log/backend.log \
  --format json \
  --output audit-report.json
```

**Output**:
```
[INFO] Analyzing audit logs from: /var/log/backend.log
[INFO] Total log lines: 125000
[INFO] Filtered to session: abc-123-def

[INFO] Audit Log Occurrences:

[INFO]   WAL entries appended:          45
[INFO]   WAL flushes started:           15
[INFO]   WAL flushes completed:         15
[INFO]   Outbox events enqueued:        42
[INFO]   Slide handler enqueues:        28
[INFO]   State handler enqueues:        14
[INFO]   Outbox events published:       42
[INFO]   Batch processing completed:    8
[INFO]   WebSocket deliveries:          168

[INFO] Total SPEED_AUDIT logs:          397

[INFO] Timing Metrics (milliseconds):

[INFO]   Outbox Queue Wait Time:
    count: 42
    min:   12ms
    avg:   85.3ms
    p50:   78ms
    p95:   142ms
    p99:   195ms
    max:   245ms

[INFO]   WAL Flush Duration:
    count: 15
    min:   8ms
    avg:   25.7ms
    p50:   22ms
    p95:   45ms
    p99:   58ms
    max:   62ms

[INFO]   WebSocket Delivery Time:
    count: 168
    min:   1ms
    avg:   3.2ms
    p50:   3ms
    p95:   8ms
    p99:   12ms
    max:   15ms

[INFO] Event Type Breakdown:

[INFO]   SLIDES_UPDATE:                 126
[INFO]   STATE_UPDATE:                  56
[INFO]   VOTE_UPDATE:                   168
[INFO]   QA_UPDATE:                     47

[INFO] Bottleneck Analysis:

[PASS]   ✓ Outbox queue latency is good (p95: 142ms)
[PASS]   ✓ WAL flush duration is good (avg: 25ms)
[PASS]   ✓ WebSocket delivery is fast (p95: 8ms)
```

---

## Quick Start

### Production Validation

Run this sequence to validate audit logs in production:

```bash
# 1. Run functional test
./test-speed-audit-logs.sh \
  --base-url https://class-collaboration-production.up.railway.app \
  --perf-test-token $PERF_TEST_TOKEN \
  --log-file /tmp/backend.log \
  --summary-file functional-summary.json

# 2. Run load test
./test-speed-audit-load.sh \
  --base-url https://class-collaboration-production.up.railway.app \
  --concurrency 100 \
  --duration 5m \
  --perf-test-token $PERF_TEST_TOKEN \
  --summary-file load-summary.json \
  --log-file /tmp/backend.log

# 3. Analyze logs in depth
./analyze-speed-audit-logs.sh /tmp/backend.log \
  --format json \
  --output audit-report.json
```

### Local Development Testing

Test against local backend:

```bash
# 1. Start local backend
cd ../..
docker-compose -f docker-compose.test.yml up -d

# 2. Run functional test
cd loadtest
./test-speed-audit-logs.sh \
  --base-url http://localhost:8080 \
  --skip-cleanup \
  --log-file ../apps/backend/logs/backend.log

# 3. Run load test
./test-speed-audit-load.sh \
  --base-url http://localhost:8080 \
  --concurrency 50 \
  --duration 2m \
  --skip-cleanup
```

---

## Interpreting Results

### Good Performance Indicators

| Metric | Good | Warning | Critical |
|--------|------|---------|----------|
| Outbox Queue Wait (p95) | < 150ms | 150-300ms | > 300ms |
| WAL Flush Duration (avg) | < 50ms | 50-150ms | > 150ms |
| WebSocket Delivery (p95) | < 10ms | 10-30ms | > 30ms |
| Batch Processing (avg) | < 200ms | 200-500ms | > 500ms |
| Audit Log Count Match | enqueue ≈ publish | 10-20% gap | > 20% gap |

### Bottleneck Diagnosis

**High Outbox Queue Wait Time (>200ms)**:
```
Problem: Events waiting too long in outbox queue
Possible causes:
  - Outbox worker poll interval too slow (100ms default)
  - notify_one() not being called after enqueue
  - Database contention slowing down event fetch
Solutions:
  - Reduce POLL_INTERVAL_MS in outbox.rs
  - Verify notify is called in all enqueue paths
  - Check MySQL lock contention in slow query log
```

**High WAL Flush Duration (>100ms)**:
```
Problem: WAL → MySQL flush taking too long
Possible causes:
  - WAL worker poll interval too slow (200ms default)
  - MySQL row lock contention on sessions table
  - Too many pending entries per batch
Solutions:
  - Reduce FLUSH_INTERVAL_MS in wal.rs
  - Add indexes to sessions table
  - Consider notify-based WAL trigger (like outbox)
```

**High WebSocket Delivery Time (>20ms)**:
```
Problem: Broadcast → WS send taking too long
Possible causes:
  - Too many connected clients
  - Tokio runtime saturation
  - Serialization overhead
Solutions:
  - Pre-serialize broadcast messages
  - Use send_all() with streams
  - Scale tokio runtime threads
```

**Mismatched Audit Log Counts**:
```
Problem: enqueue count ≠ publish count
Possible causes:
  - Outbox worker failing to process events
  - Events stuck in pending state
  - publish_event() failures
Solutions:
  - Check for errors in "Event published" logs
  - Monitor retry_count in outbox_events table
  - Verify broadcaster is not failing
```

---

## End-to-End Latency Calculation

To calculate total sync latency from user action to WebSocket delivery:

```bash
# Find a specific event by correlation_id
grep "correlation_id=evt-xyz" backend.log

# This will show:
# 1. When it was enqueued (SPEED_AUDIT: Event enqueued)
# 2. When it was published with queue_wait_ms=85
# 3. When it was delivered with delivery_ms=3

# Total latency = time_from_enqueue_to_publish + delivery_time
#               = queue_wait_ms + delivery_ms
#               = 85ms + 3ms = 88ms
```

For slide edits specifically:
```
Total = WAL_queue_time + WAL_flush_time + 
        outbox_queue_time + ws_delivery_time
      = ~200ms + ~25ms + ~85ms + ~3ms
      = ~313ms (typical)
```

For state updates (live controls):
```
Total = outbox_queue_time + ws_delivery_time
      = ~85ms + ~3ms
      = ~88ms (typical)
```

---

## Troubleshooting

### "No audit logs found in log file"

**Cause**: Backend logs not captured or wrong log file path

**Solution**:
```bash
# Check if backend is logging
tail -f /path/to/backend.log | grep SPEED_AUDIT

# Ensure RUST_LOG includes info level
export RUST_LOG=info

# Restart backend to ensure logs are fresh
```

### "Audit log count mismatch"

**Cause**: Some events may not have been published yet (still in queue)

**Solution**:
```bash
# Wait for outbox worker to flush
sleep 2

# Check pending events in database
mysql> SELECT COUNT(*) FROM outbox_events WHERE status='pending';

# If still pending, check for errors
grep "Broadcast failed\|Failed to hydrate" backend.log
```

### "WebSocket delivery logs missing"

**Cause**: No WebSocket clients connected, or clients disconnected before delivery

**Solution**:
```bash
# Verify WS connections
grep "WebSocket connection established" backend.log

# Check for WS errors
grep "WebSocket\|broadcast" backend.log | grep -i error

# Ensure frontend is connected with WS_URL set
```

---

## Continuous Monitoring

For production monitoring, consider:

1. **Export metrics to Prometheus**: Add histogram metrics for queue_wait_ms, delivery_ms
2. **Set up alerts**: Alert when p95 queue wait > 300ms
3. **Dashboard**: Grafana dashboard showing sync latency over time
4. **Sampling**: Log every Nth event to reduce log volume in production

Example Prometheus metrics (future enhancement):
```rust
static ref OUTBOX_QUEUE_WAIT_MS: Histogram = register_histogram!(
    "outbox_queue_wait_ms",
    "Time events spend in outbox queue",
    vec![5.0, 10.0, 25.0, 50.0, 100.0, 200.0, 500.0]
).unwrap();

static ref WS_DELIVERY_MS: Histogram = register_histogram!(
    "ws_delivery_ms",
    "Time to deliver message via WebSocket",
    vec![1.0, 2.0, 5.0, 10.0, 20.0, 50.0]
).unwrap();
```

---

## Files

| File | Purpose |
|------|---------|
| `test-speed-audit-logs.sh` | Functional test for all 9 audit log points |
| `test-speed-audit-load.sh` | Load test with k6 for stress testing |
| `k6/speed-audit-load.js` | k6 script with classroom scenarios |
| `analyze-speed-audit-logs.sh` | Deep-dive log analysis and bottleneck detection |
| `README.md` | This file |

---

## Requirements

- **bash** 4.0+
- **curl** (for HTTP requests)
- **k6** (for load tests) - [Install guide](https://k6.io/docs/getting-started/installation/)
- **node.js** (for JSON parsing)
- **grep**, **awk**, **sort** (standard Unix tools)
- **bc** (for bottleneck analysis)

---

## Support

For issues or questions:
1. Check the bottleneck analysis section above
2. Review audit log examples in `../backend/SPEED_AUDIT_LOGS.md`
3. Look for errors in backend logs with `grep SPEED_AUDIT backend.log`
4. Run tests with `--skip-cleanup` to inspect test sessions
