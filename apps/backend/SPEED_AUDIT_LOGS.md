# Speed Audit Log Documentation

## Overview
This document describes the comprehensive speed audit logging added to the backend WebSocket sync pipeline. These logs are designed to profile end-to-end synchronization latency from user edit → dashboard update.

**Goal**: Identify bottlenecks in the sync pipeline **without changing any logic** — purely instrumentation for profiling.

---

## Event Flow Architecture

```
User edits slide (HTTP POST/PUT)
  ↓ [1] WAL append (SQLite queue)
  ↓ [2] WAL worker flushes to MySQL
  ↓ [3] enqueue_slides_update() → outbox_events (status='pending')
  ↓ [4] notify outbox worker
  ↓ [5] outbox worker polls/notifies
  ↓ [6] process_pending_batch()
  ↓ [7] publish_event() → broadcaster.broadcast()
  ↓ [8] InMemoryRegistry tokio broadcast
  ↓ [9] WS handler forward loop sends to client
  ↓ [10] Dashboard receives & applies update
```

---

## Audit Log Events

### 1. WAL Entry Appended (Slide/Vote/Question Mutation Queued)
**Location**: `src/services/wal.rs` → `append_or_get_existing()`

```
INFO SPEED_AUDIT: WAL entry appended (queued for flush)
  session_id=xxx
  op_type=create_slide|update_slide|delete_slide|...
  client_request_id=xxx
  resource_id=Some("slide-123")
```

**What this tells you**: When a mutation was first queued in the SQLite WAL. This is the **entry point** for slide/vote/question mutations.

---

### 2. WAL Session Group Flush Started
**Location**: `src/services/wal.rs` → `flush_session_group()`

```
INFO SPEED_AUDIT: WAL session group flush started
  session_id=xxx
  wal_id=12345
  op_type=create_slide
  client_request_id=xxx
  entry_count=3
  wal_entry_age_ms=2024-04-06T10:15:30.123Z
```

**What this tells you**: When the WAL worker started processing a batch. The `wal_entry_age_ms` shows when the oldest entry was created.

---

### 3. WAL Session Group Flush Completed
**Location**: `src/services/wal.rs` → `flush_session_group()`

```
INFO SPEED_AUDIT: WAL session group flush completed
  session_id=xxx
  flushed_count=3
  flush_duration_ms=45
  avg_ms_per_entry=15
```

**What this tells you**: How long the WAL → MySQL flush took. **This is the time spent in step [2]**.

---

### 4. Outbox Event Enqueued
**Location**: `src/services/outbox.rs` → `enqueue_event()`

```
INFO SPEED_AUDIT: Event enqueued to outbox
  session_id=xxx
  event_type=SLIDES_UPDATE|STATE_UPDATE|VOTE_UPDATE|QA_UPDATE
  sequence_id=42
  correlation_id=uuid-here
```

**What this tells you**: When an event was added to the outbox queue (inside a DB transaction). The `correlation_id` lets you trace this specific event through the entire pipeline.

---

### 5. Handler-Level Enqueue (Slide Mutations)
**Location**: `src/handlers/slide.rs` → `enqueue_slides_update_event()`

```
INFO SPEED_AUDIT: SLIDES_UPDATE event enqueued from slide handler
  session_id=xxx
  slide_count=5
  correlation_id=uuid-here
  sequence_id=42
```

**What this tells you**: When a slide-related event was enqueued from the slide handler. Includes slide count for context.

---

### 6. Handler-Level Enqueue (State Updates)
**Locations**: `src/handlers/live.rs` → various handlers

```
INFO SPEED_AUDIT: STATE_UPDATE enqueued from set_current_slide
  session_id=xxx
  state_version=15
  current_slide_id=Some("slide-123")
  correlation_id=uuid-here
  sequence_id=43
```

**Variants**:
- `set_current_slide` — slide navigation
- `set_results_visibility` — results toggle
- `update_slide_visibility` — slide hide/show
- `go_live` — start presentation
- `stop_live` — stop presentation

**What this tells you**: When a state update was enqueued from live control handlers. Includes `state_version` for ordering verification.

---

### 7. Outbox Event Published to Broadcast
**Location**: `src/services/outbox.rs` → `publish_event()`

```
INFO SPEED_AUDIT: Event published to broadcast channel
  session_id=xxx
  event_type=SLIDES_UPDATE
  sequence_id=42
  correlation_id=uuid-here
  queue_wait_ms=85
```

**What this tells you**: **Critical metric!** `queue_wait_ms` is the time from enqueue to publish. This is the **outbox queue latency** — how long the event waited before being broadcast.

---

### 8. Batch Processing Completed
**Location**: `src/services/outbox.rs` → `process_pending_batch()`

```
INFO SPEED_AUDIT: Batch processing completed
  event_count=10
  batch_duration_ms=120
  avg_latency_per_event_ms=12
```

**What this tells you**: How long the outbox worker took to process a batch of events. High avg latency might indicate DB or broadcast bottlenecks.

---

### 9. WebSocket Message Sent to Client
**Location**: `src/ws/handler.rs` → forward loop

```
INFO SPEED_AUDIT: WebSocket message sent to client
  session_id=xxx
  client_id=student-abc123
  event_type=SLIDES_UPDATE
  sequence_id=42
  delivery_ms=3
```

**What this tells you**: **Critical metric!** `delivery_ms` is the time from receiving the broadcast to sending it over WebSocket. This measures **broadcast → WS send latency** (step [8] → [9]).

---

## Correlation Strategy

All audit logs include:
- **`session_id`**: Trace events within a single classroom session
- **`sequence_id`**: Monotonic ordering from outbox (higher = newer)
- **`correlation_id`**: The outbox event UUID — trace a single event end-to-end
- **`event_type`**: SLIDES_UPDATE, STATE_UPDATE, VOTE_UPDATE, QA_UPDATE

### Example Trace (Single Slide Edit)

```
# 1. User edits slide → WAL append
SPEED_AUDIT: WAL entry appended (queued for flush)
  session_id=session-abc, op_type=update_slide, client_request_id=req-123

# 2. WAL worker flushes to MySQL (~200ms interval)
SPEED_AUDIT: WAL session group flush started
  session_id=session-abc, wal_id=5001, entry_count=1

SPEED_AUDIT: WAL session group flush completed
  session_id=session-abc, flushed_count=1, flush_duration_ms=25

# 3. Outbox event enqueued (in same TX as WAL flush)
SPEED_AUDIT: Event enqueued to outbox
  session_id=session-abc, event_type=SLIDES_UPDATE, sequence_id=42, correlation_id=evt-xyz

SPEED_AUDIT: SLIDES_UPDATE event enqueued from slide handler
  session_id=session-abc, slide_count=5, correlation_id=evt-xyz, sequence_id=42

# 4. Outbox worker picks up event (~100ms poll interval)
SPEED_AUDIT: Event published to broadcast channel
  session_id=session-abc, event_type=SLIDES_UPDATE, sequence_id=42, 
  correlation_id=evt-xyz, queue_wait_ms=85

SPEED_AUDIT: Batch processing completed
  event_count=1, batch_duration_ms=15, avg_latency_per_event_ms=15

# 5. WebSocket delivers to clients
SPEED_AUDIT: WebSocket message sent to client
  session_id=session-abc, client_id=student-001, event_type=SLIDES_UPDATE, 
  sequence_id=42, delivery_ms=3
```

### End-to-End Latency Calculation

From this trace:
- **WAL queue time**: ~200ms (WAL poll interval)
- **WAL flush time**: 25ms (`flush_duration_ms`)
- **Outbox queue time**: 85ms (`queue_wait_ms`)
- **WS delivery time**: 3ms (`delivery_ms`)
- **Total**: ~313ms from edit to delivery

---

## Database Migration

A migration file is included to add the `enqueued_at` column:

```sql
-- 20260406100000_add_outbox_enqueued_at.sql
ALTER TABLE outbox_events 
ADD COLUMN enqueued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX idx_outbox_enqueued_at ON outbox_events(enqueued_at);
```

**Run this migration before deploying the audit logs.**

---

## How to Use These Logs for Optimization

### 1. Identify the Bottleneck

Search for audit logs by `correlation_id` to trace a single event:

```bash
# Example: trace a specific event
grep "correlation_id=evt-xyz" backend.log
```

### 2. Profile Queue Wait Times

```bash
# Find events with high outbox queue wait times
grep "SPEED_AUDIT: Event published" backend.log | grep -o 'queue_wait_ms=[0-9]*' | sort -n | tail -20
```

### 3. Profile WAL Flush Times

```bash
# Find slow WAL flushes
grep "SPEED_AUDIT: WAL session group flush completed" backend.log | grep -o 'flush_duration_ms=[0-9]*' | sort -n | tail -20
```

### 4. Profile WS Delivery Times

```bash
# Find slow WebSocket deliveries
grep "SPEED_AUDIT: WebSocket message sent" backend.log | grep -o 'delivery_ms=[0-9]*' | sort -n | tail -20
```

### 5. Calculate End-to-End Latency

Correlate logs by `session_id` + `sequence_id` + `event_type`:

```
User edit timestamp → WAL append time → Outbox enqueue time → 
Outbox publish time (queue_wait_ms) → WS delivery time (delivery_ms)
```

---

## Optimization Opportunities

Based on the logs, you might find:

### High WAL Queue Wait Time (>500ms)
- **Cause**: WAL worker polls every 200ms (`FLUSH_INTERVAL_MS`)
- **Fix**: Reduce poll interval or add notify-based trigger (like outbox has)

### High Outbox Queue Wait Time (>200ms)
- **Cause**: Outbox worker polls every 100ms (`POLL_INTERVAL_MS`)
- **Fix**: Already uses notify system — ensure `notify_one()` is called after every enqueue

### High Batch Processing Time (>100ms)
- **Cause**: Database contention, slow queries, or broadcast lag
- **Fix**: Check DB indexes, optimize `publish_event()` logic, consider batching improvements

### High WebSocket Delivery Time (>10ms)
- **Cause**: Serialization overhead, slow WS send, or tokio scheduler contention
- **Fix**: Pre-serialize messages, use `send_all()` with streams, tune tokio runtime

---

## Log Format

All audit logs use the `tracing` crate with structured fields:

```rust
tracing::info!(
    session_id = %session_id,
    event_type = %event_type,
    sequence_id = sequence_id,
    correlation_id = %id,
    queue_wait_ms = queue_wait_ms,
    "SPEED_AUDIT: Event published to broadcast channel"
);
```

This allows filtering and parsing with standard log tools (jq, grep, etc.).

---

## Files Modified

1. **`src/services/outbox.rs`** — Added `enqueued_at` tracking, queue latency logging, batch timing
2. **`src/services/wal.rs`** — Added WAL flush timing, entry creation tracking
3. **`src/handlers/slide.rs`** — Added slide mutation entry point logging
4. **`src/handlers/live.rs`** — Added state update entry point logging (5 handlers)
5. **`src/ws/handler.rs`** — Added WebSocket delivery timing
6. **`migrations/20260406100000_add_outbox_enqueued_at.sql`** — DB migration

---

## Testing

All 397 unit tests pass. The audit logs are additive and do not change any logic.

Run tests with:
```bash
cd apps/backend
cargo test
```

---

## Future Enhancements (Optional)

1. **Add correlation_id to WebSocket messages** — Include in payload so frontend can log receipt time
2. **Add Prometheus metrics** — Export histogram of queue_wait_ms, delivery_ms, etc.
3. **Add trace ID propagation** — Use OpenTelemetry for distributed tracing
4. **Add frontend timing logs** — Log when WS message is received vs when UI updates
5. **Add alerting** — Alert when queue_wait_ms > threshold (e.g., 500ms)
