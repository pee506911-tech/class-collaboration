# Ably Token “100% correctness” Local Test Suite (What we can and cannot prove)

## What “100%” means here

We cannot guarantee real production Ably behavior 100% (network, Ably infra, account config, etc.).

But we *can* achieve **near-absolute local correctness** for the **token-request contract** by proving:

- the response shape matches Ably’s TokenRequest format
- the `capability` content matches our intended permissions (student vs staff)
- the token request is **cryptographically valid**:
  - `mac == base64(HMAC_SHA256(keySecret, signText))`
  - `signText` formatting is exactly what Ably expects

If those are true, Ably will accept the token request *assuming* the Ably API key is correct and Ably is available.

## Implemented tests

### 1) Contract smoke tests (serial, deterministic)

Implemented inside: `class-collaboration/loadtest/run-auth-burst-test.js`

Checks:

- Valid roles: `student`, `projector`, `staff`
- Fallback `clientId` when `participantId` is omitted (`${role}-${sessionId}`)
- Invalid role returns `400`
- Missing `sessionId` returns `4xx` (query validation)
- For each successful response:
  - `ttl == 3600000`
  - `timestamp` is within 5 minutes of local clock
  - `nonce` is UUIDv4
  - `capability` is a JSON string and matches the expected ops for the role:
    - student/projector: `["subscribe","presence"]`
    - staff: `["publish","subscribe","presence"]`
  - `mac` matches locally computed HMAC using `ABLY_API_KEY`

### 2) Burst test (concurrent, NAT storm)

Still `run-auth-burst-test.js`, but now it also validates **every** returned token request:

- HMAC signature correctness per response
- correct capability per role
- correct `clientId == participantId` (critical for preventing clientId collisions)

It continues to fail on:

- any `429`
- any non-2xx
- any JSON parse failure
- any signature/capability mismatch
- any duplicate `nonce` within the burst
- any duplicate `clientId` within the burst

## How to run

Via the full suite:

```bash
cd class-collaboration/loadtest
./test-concurrency.sh --concurrency 130
```

Or directly:

```bash
cd class-collaboration/loadtest
ABLY_API_KEY="test.key:secret" node run-auth-burst-test.js --concurrency 130 --base-url http://localhost:8080 --role student
```

## Residual risk (what this still doesn’t prove)

- **Ably availability and latency** (external dependency).
- Ably-side **rate limiting** for your real Ably account/plan (we only assert our local server doesn’t 429; Ably itself isn’t called here).
- **Time skew** between your server and Ably beyond the 5-minute window.
- Security model correctness:
  - `/api/auth/ably` currently allows requesting `role=staff` token without auth; if that’s undesirable, treat it as a separate security change with its own tests.
