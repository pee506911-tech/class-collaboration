# Backend Test Coverage — Remaining Work Plan

> Generated: 2026-04-04
> Updated: 2026-04-04 (All phases complete)
> Project: `apps/backend` (Rust/Axum)
> Current status: **342 unit tests + 35 integration tests passing** (was 277)

---

## What Was Already Done (Phase 1 + 4 — Original)

| File | Tests Added | What It Covers |
|------|------------|----------------|
| `handlers/serde_test.rs` | 30 | Request DTO deserialization for all 11 handler modules |
| `models/serde_test.rs` | 22 | Model roundtrip: User, Session, Slide, SessionState, ApiResponse |
| `config_from_env_test.rs` | 16 | Config parsing logic: clamping, splitting, filtering |
| `error_test.rs` | +4 | Hash & Migration error variant existence |
| `handlers/student.rs` (inline) | +3 | Edge cases: max options, option ID length, missing options |

**Gap closed:** Request/response serde, config parsing logic, error variant completeness, boundary conditions.

---

## Phase 2 — Service Layer Tests (Mock Repositories) ✅ COMPLETE

### 2.1 SessionService — 13 new tests ✅

| File | Tests | What It Covers |
|------|-------|----------------|
| `services/session.rs` (inline) | 13 | `delete_session` (owner, non-owner, 0 rows), `archive_session` (owner, non-owner), `restore_session` (owner, non-owner), `get_session` (owner, not-found, non-owner), `get_user_sessions` (empty, multiple), `get_user_sessions_with_slide_count` (empty, with counts) |

### 2.2 Outbox Service — Already had tests ✅

Existing tests cover: watch channel shutdown, event type display/from_str roundtrips, constants.

### 2.3 Ably Service — 11 new tests ✅

| File | Tests | What It Covers |
|------|-------|----------------|
| `services/ably_test.rs` | 9 | Payload structures (state, vote, QA, slides), channel naming, URL encoding, event name consistency, URL construction |
| `services/ably.rs` (inline) | 2 | `get_ably_base_url` default and env override (serial test) |

### 2.4 Perf Service — 3 new tests ✅

| File | Tests | What It Covers |
|------|-------|----------------|
| `services/perf_test.rs` | 3 | `PerfCleanupResponse` camelCase serialization, deleted_creator_user=true/false, FK deletion order specification |

### 2.5 LazyDbPool — 2 new tests ✅

| File | Tests | What It Covers |
|------|-------|----------------|
| `db.rs` (inline) | 2 | `retry_delay` exponential backoff (1s→32s cap), attempt 0 edge case |

**Phase 2 total: ~30 new tests**

---

## Phase 3 — Auth Middleware `FromRequestParts` Tests ✅ COMPLETE

| File | Tests | What It Covers |
|------|-------|----------------|
| `middleware/auth_extraction_test.rs` | 13 | Cookie auth (valid, expired, wrong secret, tampered), Bearer auth (valid, missing header, Basic scheme, empty token, malformed, expired), Config missing, Cookie precedence over Bearer, Role extraction (teacher/student/staff) |

**Phase 3 total: 13 new tests**

---

## Phase 4b — Inline Helper Tests ✅ COMPLETE

| File | Tests | What It Covers |
|------|-------|----------------|
| `handlers/client_error.rs` (inline) | 7 | `truncate_chars`: zero max, shorter, exact boundary, exceeds by one, Unicode, emoji, empty |
| `handlers/slide.rs` (inline) | 10 | `extract_client_request_id` (missing, trimmed, oversized, exact 64, whitespace-only), `build_slide_version_conflict` (409 structure, version 0), `is_app_error_transient_slide_create/update` (non-database errors) |
| `handlers/student.rs` (inline) | 4 | `group_votes_by_slide` (multi, empty, single), `with_degraded_header` (non-degraded path) |

**Phase 4b total: 21 new tests**

---

## Phase 5 — Integration Tests ✅ COMPLETE

All 16 tests in `tests/handler_integration.rs` + 16 existing in `tests/concurrency.rs` + 2 cache_control + 1 smoke = **35 integration tests**.

### 5.1 Handler-Level CRUD (8 new tests) ✅

| Test | What It Covers |
|------|---------------|
| `i01_session_crud_lifecycle` | Create → Read → Update → Delete → 404 |
| `i02_session_archive_and_restore` | Archive (status→archived), Restore (status→draft) |
| `i03_session_duplicate` | Duplicate with "(Copy)" suffix, original unchanged |
| `i04_slide_create` | Single slide creation via HTTP API |
| `i05_slide_batch_create` | Atomic batch slide creation |
| `i06_vote_submission_happy_path` | Vote persists, sequence increments, read model updates |
| `i07_question_submission_html_content` | Question content persists |
| `i10_health_endpoint_db_ready` | Health returns 200 when DB ready |

### 5.2 Public API (2 new tests) ✅

| Test | What It Covers |
|------|---------------|
| `i08_public_session_token_not_found` | Invalid share token → 404 |
| `i09_public_session_valid_token` | Share token returns session + slides |

### 5.3 Idempotency (4 new tests) ✅

| Test | What It Covers |
|------|---------------|
| `i11_slide_create_idempotent` | Same `X-Client-Request-Id` → same slide returned |
| `i12_question_idempotent` | Same request ID → exactly one question row |
| `i13_vote_dedup_same_participant_option` | Same participant+option → exactly one vote row |
| `i14_slide_batch_idempotent` | Same batch request ID → same slides returned |

### 5.4 Concurrency + Version (2 new tests) ✅

| Test | What It Covers |
|------|---------------|
| `i15_concurrent_votes_distinct_participants` | 10 concurrent votes, all persist correctly |
| `i16_slide_update_version_conflict` | Stale `baseVersion` handled, version incremented |

---

## Summary

| Phase | Tests Added | Status |
|-------|-------------|--------|
| Phase 2: Service layer | ~30 | ✅ Complete |
| Phase 3: Auth middleware | 13 | ✅ Complete |
| Phase 4b: Inline helpers | 21 | ✅ Complete |
| Phase 5: Integration | 16 | ✅ Complete |
| **Total added** | **81** | |

**Before:** 277 tests
**After:** 342 unit tests + 35 integration tests = **377 total** (all passing)

---

## File Inventory — Created/Modified

### New Test Files Created
```
apps/backend/src/
├── services/
│   ├── ably_test.rs            # Ably payload structure & URL tests
│   └── perf_test.rs            # Perf cleanup response & FK order tests
└── middleware/
    └── auth_extraction_test.rs # FromRequestParts cookie/bearer/config tests

apps/backend/tests/
    └── handler_integration.rs  # Phase 5: CRUD, idempotency, concurrency (16 tests)
```

### Inline Test Additions (appended to existing files)
```
apps/backend/src/
├── handlers/
│   ├── slide.rs                # +10 extract_client_request_id, build_slide_version_conflict, transient error tests
│   ├── client_error.rs         # +7 truncate_chars tests
│   └── student.rs              # +4 group_votes_by_slide, with_degraded_header tests
├── services/
│   ├── session.rs              # +13 delete, archive, restore, get_session, get_user_sessions tests
│   └── ably.rs                 # +2 get_ably_base_url default/override test
└── db.rs                       # +2 retry_delay exponential backoff tests
```

---

## Running the Tests

```bash
# Unit tests (fast, no dependencies)
cargo test --bin backend-rust

# Integration tests (requires MySQL + running backend)
cargo test --test handler_integration -- --ignored --test-threads=1
cargo test --test concurrency -- --ignored --test-threads=1
cargo test --test cache_control -- --test-threads=1
cargo test --test prod_slide_student_smoke

# All tests
cargo test -- --test-threads=1
```
