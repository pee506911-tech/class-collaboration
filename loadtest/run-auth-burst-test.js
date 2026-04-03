#!/usr/bin/env node
/**
 * Ably Token Burst Test
 *
 * Validates that a classroom NAT burst (100–130+ students) can fetch Ably token
 * requests without being rate-limited (429) or erroring, and that each token
 * request is cryptographically valid (HMAC matches ABLY_API_KEY).
 *
 * Usage:
 *   node run-auth-burst-test.js --concurrency=130 --base-url=http://localhost:8080
 *   node run-auth-burst-test.js --concurrency 130 --base-url http://localhost:8080
 */

import fetch from 'node-fetch';
import crypto from 'crypto';

function getArgValue(name, fallback) {
  const idx = process.argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (idx === -1) return fallback;

  const raw = process.argv[idx];
  if (raw.includes('=')) {
    return raw.slice(raw.indexOf('=') + 1) || fallback;
  }

  return process.argv[idx + 1] || fallback;
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[idx];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isUuidV4(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseAblyApiKey() {
  const raw = process.env.ABLY_API_KEY;
  if (!raw) throw new Error('ABLY_API_KEY env var is required to validate token request MAC');
  const parts = raw.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('ABLY_API_KEY must be in keyName:keySecret format');
  return { keyName: parts[0], keySecret: parts[1] };
}

function expectedOpsForRole(role) {
  if (role === 'staff') return ['publish', 'subscribe', 'presence'];
  if (role === 'student' || role === 'projector') return ['subscribe', 'presence'];
  throw new Error(`Unsupported role for expectation: ${role}`);
}

function validateTokenRequest({
  tokenRequest,
  expected: { sessionId, role, participantId, keyName, keySecret, nowMs },
}) {
  const requiredKeys = ['keyName', 'ttl', 'capability', 'clientId', 'timestamp', 'nonce', 'mac'];
  for (const k of requiredKeys) {
    assert(Object.prototype.hasOwnProperty.call(tokenRequest, k), `Missing key: ${k}`);
  }

  assert(tokenRequest.keyName === keyName, `keyName mismatch (got=${tokenRequest.keyName} expected=${keyName})`);
  assert(typeof tokenRequest.ttl === 'number' && Number.isFinite(tokenRequest.ttl), 'ttl must be a number');
  assert(tokenRequest.ttl === 3600000, `ttl mismatch (got=${tokenRequest.ttl} expected=3600000)`);

  assert(typeof tokenRequest.clientId === 'string' && tokenRequest.clientId.length > 0, 'clientId must be a non-empty string');
  if (participantId !== undefined) {
    assert(tokenRequest.clientId === participantId, `clientId mismatch (got=${tokenRequest.clientId} expected=${participantId})`);
  } else {
    const fallback = `${role}-${sessionId}`;
    assert(tokenRequest.clientId === fallback, `clientId fallback mismatch (got=${tokenRequest.clientId} expected=${fallback})`);
  }

  assert(typeof tokenRequest.timestamp === 'number' && Number.isFinite(tokenRequest.timestamp), 'timestamp must be a number');
  // Ably expects ms timestamp; allow generous skew for CI runners.
  const skewMs = Math.abs(tokenRequest.timestamp - nowMs);
  assert(skewMs < 5 * 60 * 1000, `timestamp skew too large (skewMs=${skewMs})`);

  assert(isUuidV4(tokenRequest.nonce), `nonce must be uuid v4 (got=${tokenRequest.nonce})`);
  assert(typeof tokenRequest.mac === 'string' && tokenRequest.mac.length > 0, 'mac must be a non-empty string');

  assert(typeof tokenRequest.capability === 'string' && tokenRequest.capability.length > 0, 'capability must be a non-empty string');
  let capabilityJson;
  try {
    capabilityJson = JSON.parse(tokenRequest.capability);
  } catch (e) {
    throw new Error(`capability is not valid JSON string: ${e.message}`);
  }

  const channel = `session:${sessionId}`;
  const ops = capabilityJson[channel];
  assert(Array.isArray(ops), `capability missing channel ${channel}`);

  const expectedOps = expectedOpsForRole(role);
  assert(
    ops.join(',') === expectedOps.join(','),
    `capability ops mismatch (got=${JSON.stringify(ops)} expected=${JSON.stringify(expectedOps)})`
  );

  // Verify HMAC-SHA256 signature exactly matches Ably token request format:
  // keyName\nTTL\ncapability\nclientId\ntimestamp\nnonce\n
  const signText = `${keyName}\n${tokenRequest.ttl}\n${tokenRequest.capability}\n${tokenRequest.clientId}\n${tokenRequest.timestamp}\n${tokenRequest.nonce}\n`;
  const expectedMac = crypto.createHmac('sha256', keySecret).update(signText, 'utf8').digest('base64');
  assert(tokenRequest.mac === expectedMac, 'mac mismatch (token request signature invalid)');
}

async function runContractSmokeTests({ baseUrl, sessionId, keyName, keySecret }) {
  // Minimal serial contract tests before burst to catch regressions deterministically.
  const nowMs = Date.now();

  const cases = [
    { role: 'student', participantId: `contract-student-${Math.random().toString(36).slice(2, 8)}` },
    { role: 'projector', participantId: `contract-projector-${Math.random().toString(36).slice(2, 8)}` },
    { role: 'staff', participantId: `contract-staff-${Math.random().toString(36).slice(2, 8)}` },
    // Fallback clientId case (no participantId)
    { role: 'student', participantId: undefined },
  ];

  for (const c of cases) {
    const url = new URL(`${baseUrl}/api/auth/ably`);
    url.searchParams.set('sessionId', sessionId);
    url.searchParams.set('role', c.role);
    if (c.participantId !== undefined) url.searchParams.set('participantId', c.participantId);

    const res = await fetch(url.toString(), { method: 'GET' });
    assert(res.ok, `contract smoke token request failed (role=${c.role}) status=${res.status}`);
    const body = await res.json();
    validateTokenRequest({
      tokenRequest: body,
      expected: { sessionId, role: c.role, participantId: c.participantId, keyName, keySecret, nowMs },
    });
  }

  // Invalid role should be 400
  {
    const url = new URL(`${baseUrl}/api/auth/ably`);
    url.searchParams.set('sessionId', sessionId);
    url.searchParams.set('role', 'invalid-role');
    url.searchParams.set('participantId', 'pid');
    const res = await fetch(url.toString(), { method: 'GET' });
    assert(res.status === 400, `expected invalid role to return 400, got ${res.status}`);
  }

  // Missing sessionId should be 400 or 422 depending on query parsing; treat any 4xx as acceptable.
  {
    const url = new URL(`${baseUrl}/api/auth/ably`);
    url.searchParams.set('role', 'student');
    url.searchParams.set('participantId', 'pid');
    const res = await fetch(url.toString(), { method: 'GET' });
    assert(res.status >= 400 && res.status < 500, `expected missing sessionId to return 4xx, got ${res.status}`);
  }

  console.log('[auth-contract] PASS');
}

async function main() {
  const concurrency = parseInt(getArgValue('--concurrency', '130'), 10);
  const baseUrl = getArgValue('--base-url', 'http://localhost:8080').replace(/\/+$/, '');
  const role = getArgValue('--role', 'student');
  const sessionId = getArgValue('--session-id', `test-session-${Math.random().toString(36).slice(2, 10)}`);
  const maxP95Ms = parseFloat(getArgValue('--max-p95-ms', '500'));
  const maxP99Ms = parseFloat(getArgValue('--max-p99-ms', '1000'));

  console.log(
    `[auth-burst] baseUrl=${baseUrl} concurrency=${concurrency} role=${role} sessionId=${sessionId} maxP95Ms=${maxP95Ms} maxP99Ms=${maxP99Ms}`
  );

  const { keyName, keySecret } = parseAblyApiKey();
  await runContractSmokeTests({ baseUrl, sessionId, keyName, keySecret });

  const latenciesMs = [];
  const statusHist = new Map();
  let parseFailures = 0;
  let validationFailures = 0;
  const validationFailureSamples = [];
  const seenNonces = new Set();
  const seenClientIds = new Set();

  const requests = Array.from({ length: concurrency }, (_, i) => i).map(async (i) => {
    const participantId = `pid-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const url = `${baseUrl}/api/auth/ably?sessionId=${encodeURIComponent(sessionId)}&role=${encodeURIComponent(role)}&participantId=${encodeURIComponent(participantId)}`;

    const start = process.hrtime.bigint();
    let res;
    try {
      res = await fetch(url, { method: 'GET' });
    } finally {
      const end = process.hrtime.bigint();
      latenciesMs.push(Number(end - start) / 1e6);
    }

    statusHist.set(res.status, (statusHist.get(res.status) || 0) + 1);

    let body;
    try {
      body = await res.json();
    } catch {
      parseFailures += 1;
      return;
    }

    try {
      validateTokenRequest({
        tokenRequest: body,
        expected: { sessionId, role, participantId, keyName, keySecret, nowMs: Date.now() },
      });

      if (seenNonces.has(body.nonce)) {
        throw new Error(`duplicate nonce observed: ${body.nonce}`);
      }
      seenNonces.add(body.nonce);

      if (seenClientIds.has(body.clientId)) {
        throw new Error(`duplicate clientId observed: ${body.clientId}`);
      }
      seenClientIds.add(body.clientId);
    } catch (e) {
      validationFailures += 1;
      if (validationFailureSamples.length < 5) {
        validationFailureSamples.push(String(e?.message || e));
      }
      return;
    }
  });

  await Promise.all(requests);

  latenciesMs.sort((a, b) => a - b);
  const p50Ms = percentile(latenciesMs, 50);
  const p95Ms = percentile(latenciesMs, 95);
  const p99Ms = percentile(latenciesMs, 99);

  const statusSummary = Array.from(statusHist.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([code, count]) => `${code}:${count}`)
    .join(' ');

  console.log(`[auth-burst] status_hist=${statusSummary}`);
  console.log(
    `[auth-burst] latency_ms p50=${p50Ms.toFixed(1)} p95=${p95Ms.toFixed(1)} p99=${p99Ms.toFixed(1)}`
  );
  console.log(`[auth-burst] parse_failures=${parseFailures} validation_failures=${validationFailures}`);
  if (validationFailureSamples.length > 0) {
    console.log(`[auth-burst] validation_failure_samples=${validationFailureSamples.join(' | ')}`);
  }

  const rateLimited = statusHist.get(429) || 0;
  const non2xx = Array.from(statusHist.entries()).some(([code, _]) => code < 200 || code >= 300);

  if (rateLimited > 0) {
    console.error(`[auth-burst] FAIL: received 429 responses (count=${rateLimited})`);
    process.exit(1);
  }
  if (non2xx) {
    console.error('[auth-burst] FAIL: non-2xx responses observed');
    process.exit(1);
  }
  if (parseFailures > 0) {
    console.error('[auth-burst] FAIL: response parsing/schema failures');
    process.exit(1);
  }
  if (validationFailures > 0) {
    console.error('[auth-burst] FAIL: token request validation failures');
    process.exit(1);
  }
  if (!Number.isNaN(maxP95Ms) && p95Ms > maxP95Ms) {
    console.error(`[auth-burst] FAIL: p95 latency ${p95Ms.toFixed(1)}ms exceeded threshold ${maxP95Ms}ms`);
    process.exit(1);
  }
  if (!Number.isNaN(maxP99Ms) && p99Ms > maxP99Ms) {
    console.error(`[auth-burst] FAIL: p99 latency ${p99Ms.toFixed(1)}ms exceeded threshold ${maxP99Ms}ms`);
    process.exit(1);
  }

  console.log('[auth-burst] PASS');
}

main().catch((err) => {
  console.error('[auth-burst] ERROR:', err);
  process.exit(1);
});
