# Load Test WebSocket Migration

## Status: ✅ Complete

The load test infrastructure has been migrated from Ably to WebSocket.

## What Changed

### 1. Docker Infrastructure (`docker-compose.test.yml`)

**Removed:**
- ❌ `ably-stub` service (no longer needed)
- ❌ `ably_captures` volume
- ❌ `ABLY_API_KEY` and `ABLY_REST_URL` from test-runner

**Kept:**
- ✅ `mysql-test` service (still needed)
- ✅ `toxiproxy` service (optional, for fault injection)
- ✅ `test-runner` service (updated env vars)

### 2. Test Runner Script (`test-concurrency.sh`)

**Changed:**
- Replaced `run-auth-burst-test.js` → `run-ws-auth-burst-test.js`
- Removed Ably stub wait loop
- Removed `ABLY_API_KEY`, `ABLY_REST_URL` env vars
- Updated web server startup: `NEXT_PUBLIC_DISABLE_ABLY=1` → `NEXT_PUBLIC_WS_URL=ws://localhost:8080`
- Updated log messages to reference "WebSocket" instead of "Ably"

### 3. Concurrency Tests (`run-concurrency-tests.js`)

**Changed:**
- Removed Ably capture verification (now verifies via HTTP state)
- `clearAblyCaptures()`, `fetchAblyCaptures()`, `waitForAblyCaptures()` now return empty arrays
- Tests still validate correctness via HTTP endpoints (vote counts, state, etc.)

### 4. New WebSocket Auth Burst Test (`run-ws-auth-burst-test.js`)

**Created:**
- Tests `/api/auth/ws-token` endpoint under concurrent load
- Validates JWT token responses
- Tests WebSocket upgrade with returned tokens
- Reports success rate, errors, and performance metrics

## Usage

### Basic Run

```bash
cd loadtest
./test-concurrency.sh --concurrency 100
```

### Skip Setup (If MySQL Already Running)

```bash
./test-concurrency.sh --skip-setup --skip-backend --concurrency 100
```

### Production-Safe Auth Test Only

```bash
./test-concurrency.sh --base-url https://your-backend.railway.app --concurrency 100
```

### Environment Variables

**No longer needed:**
```bash
# ❌ Remove these:
export ABLY_API_KEY="..."
export ABLY_REST_URL="..."
```

**Still needed:**
```bash
# ✅ Keep these:
export DATABASE_URL="mysql://..."
export DB_MAX_CONNECTIONS=20
```

## Migration Notes

### What Was Removed

| Component | Reason |
|-----------|--------|
| Ably stub Docker service | WebSocket doesn't need mock Ably |
| Ably capture verification | Real-time verified via HTTP state instead |
| `ABLY_API_KEY`, `ABLY_REST_URL` | No Ably authentication |
| Ably-specific wait loops | WebSocket connects directly |

### What Still Works

| Feature | Status | Notes |
|---------|--------|-------|
| Vote concurrency tests | ✅ | Verify via HTTP vote counts |
| Session setup/teardown | ✅ | Unchanged |
| Database migrations | ✅ | Unchanged |
| Slide autosave tests | ✅ | Rust tests, unchanged |
| Toxiproxy fault injection | ✅ | Still available for advanced testing |

### What Changed

| Test | Old Behavior | New Behavior |
|------|--------------|--------------|
| Auth burst test | Validates Ably HMAC | Validates JWT token format |
| Real-time verification | Ably captures | HTTP state verification |
| Web server startup | `NEXT_PUBLIC_DISABLE_ABLY=1` | `NEXT_PUBLIC_WS_URL=ws://localhost:8080` |

## Known Limitations

1. **No WebSocket message capture**: Unlike Ably stub, we can't easily intercept WebSocket messages for verification. Tests verify correctness by checking HTTP state after actions.

2. **Real-time timing**: Tests that verified message ordering/timing via Ably timestamps now rely on HTTP state being eventually consistent (which is correct for production behavior).

## Future Enhancements

If you need to verify WebSocket message delivery specifically:

1. **Add WebSocket proxy**: Create a test proxy that logs all WS messages
2. **Use browser automation**: Playwright tests already verify real-time behavior
3. **Backend metrics**: Monitor `ws_connections` metric on `/health` endpoint

## Files Modified

| File | Change Type | Lines Changed |
|------|-------------|---------------|
| `docker-compose.test.yml` | Removed Ably services | ~40 lines removed |
| `test-concurrency.sh` | Updated for WS | ~15 edits |
| `run-concurrency-tests.js` | Disabled Ably captures | ~10 lines changed |
| `run-ws-auth-burst-test.js` | New file | ~200 lines |

## Testing

The updated load tests have been verified to:
- ✅ Start MySQL container successfully
- ✅ Run database migrations
- ✅ Execute concurrency tests (HTTP-based verification)
- ✅ Test WebSocket auth endpoint under load
- ✅ Clean up infrastructure on exit

---

**Migration Date**: April 4, 2026  
**Status**: Complete and tested  
**Next Steps**: Run full concurrency test suite against production backend
