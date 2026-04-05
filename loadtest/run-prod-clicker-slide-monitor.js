#!/usr/bin/env node

import fetch from 'node-fetch';
import https from 'https';
import WebSocket from 'ws';

const args = process.argv.slice(2);

function readArg(name, fallback = '') {
  const flag = `--${name}`;
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return process.env[name.toUpperCase().replace(/-/g, '_')] ?? fallback;
  }
  return args[index + 1];
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

function readInt(name, fallback) {
  const raw = readArg(name, String(fallback));
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function readBool(name, fallback) {
  const raw = readArg(name, fallback ? 'true' : 'false');
  if (typeof raw !== 'string') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

const BASE_URL = String(readArg('base-url', 'http://localhost:8080'))
  .replace(/\/+$/, '')
  .replace(/\/api$/, '');
const API_BASE = `${BASE_URL}/api`;
const WS_BASE = BASE_URL.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
const CONCURRENCY = readInt('concurrency', 100);
const SLIDE_CHANGES = readInt('slide-changes', 3);
const CLICK_INTERVAL_MS = readInt('click-interval-ms', 250);
const CLICK_START_DELAY_MS = readInt('click-start-delay-ms', 100);
const OBSERVER_TIMEOUT_MS = readInt('observer-timeout-ms', 10000);
const STATE_POLL_INTERVAL_MS = readInt('state-poll-interval-ms', 100);
const SKIP_CLEANUP = readBool('skip-cleanup', false);
const CLEANUP_DELETE_CREATOR_USER = readBool('cleanup-delete-creator-user', true);
const PERF_TEST_TOKEN = readArg('perf-test-token', process.env.PERF_TEST_TOKEN || '');
const INSECURE_SKIP_TLS_VERIFY = readBool('insecure-skip-tls-verify', false);

const httpsAgent = new https.Agent({ rejectUnauthorized: !INSECURE_SKIP_TLS_VERIFY });

function log(event) {
  console.log(
    JSON.stringify({
      scenario: 'prod-clicker-slide-storm',
      ts: new Date().toISOString(),
      ...event,
    })
  );
}

function randId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeLatencies(values) {
  if (!values.length) {
    return { minMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  }
  return {
    minMs: Math.min(...values),
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    maxMs: Math.max(...values),
  };
}

function requestOptions(method, body, headers = {}) {
  return {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    agent: BASE_URL.startsWith('https://') ? httpsAgent : undefined,
  };
}

async function requestJson(method, path, { body, headers, expectedStatuses = [200], timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${API_BASE}${path}`;
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      ...requestOptions(method, body, headers),
      signal: controller.signal,
    });
    const rawBody = await response.text();
    let json = null;
    if (rawBody) {
      try {
        json = JSON.parse(rawBody);
      } catch (error) {
        throw new Error(`${method} ${path}: invalid JSON (${error.message}) body=${rawBody.slice(0, 400)}`);
      }
    }

    if (!expectedStatuses.includes(response.status)) {
      throw new Error(`${method} ${path}: expected ${expectedStatuses.join(',')} got ${response.status} body=${rawBody.slice(0, 400)}`);
    }

    return {
      response,
      json,
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function unwrapApiSuccess(json, context) {
  assert(json && json.success === true, `${context}: expected success=true`);
  return json.data;
}

function buildOptionId(index) {
  return `opt-${index}`;
}

function createPollSlideBody() {
  const options = [];
  for (let index = 1; index <= CONCURRENCY; index += 1) {
    options.push({
      id: buildOptionId(index),
      text: `Choice ${index}`,
    });
  }

  return {
    type: 'poll',
    content: {
      question: `Clicker storm poll (${CONCURRENCY} voters)`,
      options,
      limitSubmissions: true,
      allowMultipleSelection: false,
    },
    clientRequestId: randId('poll-slide'),
  };
}

function createStaticSlideBody(index) {
  return {
    type: 'static',
    content: {
      title: `Slide ${index}`,
      body: `Static slide ${index} for clicker propagation`,
    },
    clientRequestId: randId(`static-slide-${index}`),
  };
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  assert(parts.length === 3, `jwt must have 3 segments (got=${parts.length})`);
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

class StateObserver {
  constructor(sessionId, participantId) {
    this.sessionId = sessionId;
    this.participantId = participantId;
    this.messages = [];
    this.waiters = [];
    this.ws = null;
  }

  async connect() {
    const tokenResult = await requestJson(
      'GET',
      `/auth/ws-token?sessionId=${encodeURIComponent(this.sessionId)}&role=student&participantId=${encodeURIComponent(this.participantId)}`,
      { expectedStatuses: [200], body: undefined, headers: {}, timeoutMs: 15000 }
    );

    const token = tokenResult.json?.token;
    assert(typeof token === 'string' && token.length > 0, 'observer ws token missing');

    const claims = decodeJwtPayload(token);
    assert(claims.sessionId === this.sessionId, `observer token session mismatch (${claims.sessionId})`);
    assert(claims.participantId === this.participantId, `observer token participant mismatch (${claims.participantId})`);

    const wsUrl = `${WS_BASE}/api/ws?token=${encodeURIComponent(token)}`;
    const wsOptions = WS_BASE.startsWith('wss://') ? { rejectUnauthorized: !INSECURE_SKIP_TLS_VERIFY } : undefined;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, wsOptions);
      this.ws = ws;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`observer websocket timeout after ${OBSERVER_TIMEOUT_MS}ms`));
      }, OBSERVER_TIMEOUT_MS);

      ws.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });

      ws.on('message', (raw) => {
        try {
          const message = JSON.parse(String(raw));
          if (message?.type !== 'STATE_UPDATE') return;
          const payload = message.payload || message;
          const observed = {
            atMs: Date.now(),
            currentSlideId: payload.currentSlideId ?? null,
            stateVersion: typeof payload.stateVersion === 'number' ? payload.stateVersion : null,
            raw: payload,
          };
          this.messages.push(observed);
          this.resolveWaiters(observed);
        } catch (error) {
          log({
            phase: 'observer-parse-error',
            status: 'failed',
            message: error.message,
          });
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    log({
      phase: 'observer-connected',
      status: 'ok',
      sessionId: this.sessionId,
      participantId: this.participantId,
    });
  }

  resolveWaiters(observed) {
    const remaining = [];
    for (const waiter of this.waiters) {
      if (waiter.matches(observed)) {
        clearTimeout(waiter.timeout);
        waiter.resolve(observed);
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;
  }

  waitForSlide(targetSlideId, minStateVersion, sinceMs) {
    const match = (observed) =>
      observed.atMs >= sinceMs &&
      observed.currentSlideId === targetSlideId &&
      (minStateVersion == null || observed.stateVersion == null || observed.stateVersion >= minStateVersion);

    const existing = this.messages.find(match);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate.resolve !== resolve);
        reject(
          new Error(
            `timed out waiting for STATE_UPDATE currentSlideId=${targetSlideId} minStateVersion=${minStateVersion}`
          )
        );
      }, OBSERVER_TIMEOUT_MS);

      this.waiters.push({
        matches: match,
        resolve,
        timeout,
      });
    });
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
  }
}

async function createStaffSession() {
  const unique = randId('clicker-storm');
  const staffEmail = `perf-${unique}@example.com`;
  const staffPassword = `Perf-${randId('password')}!Aa1`;
  const staffName = 'Perf Staff';

  await requestJson('POST', '/auth/register', {
    body: {
      email: staffEmail,
      password: staffPassword,
      name: staffName,
      role: 'staff',
    },
    expectedStatuses: [200],
  });

  const login = await requestJson('POST', '/auth/login', {
    body: {
      email: staffEmail,
      password: staffPassword,
    },
    expectedStatuses: [200],
  });
  const staffToken = login.json?.token;
  assert(typeof staffToken === 'string' && staffToken.length > 0, 'staff token missing');

  const sessionResponse = await requestJson('POST', '/sessions', {
    body: {
      title: `Prod clicker storm ${unique}`,
      allowQuestions: false,
      requireName: false,
    },
    headers: {
      Authorization: `Bearer ${staffToken}`,
    },
    expectedStatuses: [200],
  });
  const session = unwrapApiSuccess(sessionResponse.json, 'create session');
  const sessionId = session.id;

  const slides = [];

  const pollSlideResponse = await requestJson('POST', `/sessions/${sessionId}/slides`, {
    body: createPollSlideBody(),
    headers: {
      Authorization: `Bearer ${staffToken}`,
    },
    expectedStatuses: [200],
  });
  slides.push(unwrapApiSuccess(pollSlideResponse.json, 'create poll slide'));

  for (let index = 2; index <= Math.max(SLIDE_CHANGES + 1, 3); index += 1) {
    const response = await requestJson('POST', `/sessions/${sessionId}/slides`, {
      body: createStaticSlideBody(index),
      headers: {
        Authorization: `Bearer ${staffToken}`,
      },
      expectedStatuses: [200],
    });
    slides.push(unwrapApiSuccess(response.json, `create static slide ${index}`));
  }

  const pollSlideId = slides[0].id;

  await requestJson('PUT', `/sessions/${sessionId}/current-slide`, {
    body: { slideId: pollSlideId },
    headers: {
      Authorization: `Bearer ${staffToken}`,
    },
    expectedStatuses: [200, 202],
  });

  await requestJson('POST', `/sessions/${sessionId}/go-live`, {
    headers: {
      Authorization: `Bearer ${staffToken}`,
    },
    expectedStatuses: [200],
  });

  log({
    phase: 'setup',
    status: 'ok',
    sessionId,
    pollSlideId,
    targetSlideIds: slides.slice(1).map((slide) => slide.id),
  });

  return {
    staffEmail,
    staffToken,
    sessionId,
    pollSlideId,
    targetSlideIds: slides.slice(1).map((slide) => slide.id),
  };
}

async function runVoteStorm(sessionId, slideId) {
  const promises = [];
  for (let index = 1; index <= CONCURRENCY; index += 1) {
    const participantId = `storm-${index}`;
    const optionId = buildOptionId(index);
    const clientRequestId = `vote:${sessionId}:${participantId}:${optionId}`;
    const startedAt = Date.now();

    promises.push(
      requestJson('POST', `/sessions/${sessionId}/vote`, {
        body: {
          slideId,
          optionId,
          participantId,
        },
        headers: {
          'x-client-request-id': clientRequestId,
        },
        expectedStatuses: [200],
        timeoutMs: 20000,
      })
        .then((result) => ({
          ok: true,
          participantId,
          optionId,
          clientRequestId,
          latencyMs: result.latencyMs,
          startedAt,
        }))
        .catch((error) => ({
          ok: false,
          participantId,
          optionId,
          clientRequestId,
          latencyMs: Date.now() - startedAt,
          startedAt,
          error: error.message,
        }))
    );
  }

  const results = await Promise.all(promises);
  const failures = results.filter((result) => !result.ok);
  const latencies = results.filter((result) => result.ok).map((result) => result.latencyMs);

  log({
    phase: 'vote-summary',
    status: failures.length === 0 ? 'ok' : 'failed',
    requestedVotes: CONCURRENCY,
    successfulVotes: results.length - failures.length,
    failedVotes: failures.length,
    latency: summarizeLatencies(latencies),
    failureSamples: failures.slice(0, 5),
  });

  return {
    results,
    failures,
  };
}

async function waitForStateVisibility(sessionId, targetSlideId, minStateVersion, sinceMs) {
  const deadline = Date.now() + OBSERVER_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const result = await requestJson('GET', `/sessions/${sessionId}/state`, {
      expectedStatuses: [200],
      timeoutMs: 10000,
    });
    const state = result.json;
    if (
      state?.currentSlideId === targetSlideId &&
      (minStateVersion == null || typeof state?.stateVersion !== 'number' || state.stateVersion >= minStateVersion)
    ) {
      return {
        atMs: Date.now(),
        stateVersion: state?.stateVersion ?? null,
        currentSlideId: state?.currentSlideId ?? null,
        seenAfterMs: Date.now() - sinceMs,
      };
    }
    await wait(STATE_POLL_INTERVAL_MS);
  }

  throw new Error(`timed out waiting for /state currentSlideId=${targetSlideId} minStateVersion=${minStateVersion}`);
}

async function clickAndObserve(sessionId, targetSlideId, observer) {
  const requestId = randId('clicker-slide');
  const startedAt = Date.now();

  const clickerResponse = await requestJson('PUT', `/sessions/${sessionId}/clicker/slide`, {
    body: { slideId: targetSlideId },
    headers: {
      'x-client-request-id': requestId,
    },
    expectedStatuses: [200],
    timeoutMs: 15000,
  });

  const ack = unwrapApiSuccess(clickerResponse.json, `clicker slide ${targetSlideId}`);
  const ackedStateVersion = typeof ack.stateVersion === 'number' ? ack.stateVersion : null;
  const ackedSlideId = ack.currentSlideId ?? null;
  const ackedAt = Date.now();

  log({
    phase: 'clicker-ack',
    status: 'ok',
    requestId,
    sessionId,
    targetSlideId,
    acknowledgedSlideId: ackedSlideId,
    stateVersion: ackedStateVersion,
    httpLatencyMs: clickerResponse.latencyMs,
  });

  const [wsObserved, stateObserved] = await Promise.all([
    observer.waitForSlide(targetSlideId, ackedStateVersion, startedAt),
    waitForStateVisibility(sessionId, targetSlideId, ackedStateVersion, startedAt),
  ]);

  const wsPropagationMs = wsObserved.atMs - startedAt;
  const statePollMs = stateObserved.atMs - startedAt;

  log({
    phase: 'ws-observed',
    status: 'ok',
    requestId,
    targetSlideId,
    stateVersion: wsObserved.stateVersion,
    propagationMs: wsPropagationMs,
  });

  log({
    phase: 'state-observed',
    status: 'ok',
    requestId,
    targetSlideId,
    stateVersion: stateObserved.stateVersion,
    propagationMs: statePollMs,
  });

  return {
    requestId,
    targetSlideId,
    startedAt,
    ackedAt,
    httpLatencyMs: clickerResponse.latencyMs,
    ackedStateVersion,
    wsPropagationMs,
    statePollMs,
  };
}

async function cleanupSession(sessionId) {
  if (SKIP_CLEANUP) {
    log({
      phase: 'cleanup',
      status: 'skipped',
      sessionId,
    });
    return;
  }

  assert(PERF_TEST_TOKEN, 'PERF_TEST_TOKEN is required for cleanup');

  const result = await requestJson(
    'DELETE',
    `/internal/perf/sessions/${sessionId}?deleteCreatorUser=${CLEANUP_DELETE_CREATOR_USER ? 'true' : 'false'}`,
    {
      headers: {
        'x-perf-test-token': PERF_TEST_TOKEN,
      },
      expectedStatuses: [200],
      timeoutMs: 15000,
    }
  );

  log({
    phase: 'cleanup',
    status: 'ok',
    sessionId,
    deletedCreatorUser: result.json?.data?.deletedCreatorUser ?? null,
  });
}

async function main() {
  const setup = await createStaffSession();
  const observer = new StateObserver(setup.sessionId, 'observer-student-1');
  const clickObservations = [];
  let voteSummary = null;

  try {
    await observer.connect();
    await wait(CLICK_START_DELAY_MS);

    const voteStormPromise = runVoteStorm(setup.sessionId, setup.pollSlideId);

    const targetSlideIds = [];
    for (let index = 0; index < SLIDE_CHANGES; index += 1) {
      targetSlideIds.push(setup.targetSlideIds[index % setup.targetSlideIds.length]);
    }

    for (let index = 0; index < targetSlideIds.length; index += 1) {
      clickObservations.push(await clickAndObserve(setup.sessionId, targetSlideIds[index], observer));
      if (index < targetSlideIds.length - 1) {
        await wait(CLICK_INTERVAL_MS);
      }
    }

    voteSummary = await voteStormPromise;

    const finalState = await requestJson('GET', `/sessions/${setup.sessionId}/state`, {
      expectedStatuses: [200],
      timeoutMs: 10000,
    });

    const failedClicks = clickObservations.filter(
      (entry) => entry.ackedStateVersion == null || entry.wsPropagationMs == null || entry.statePollMs == null
    );
    const voteFailures = voteSummary.failures.length;
    const wsLatencies = clickObservations.map((entry) => entry.wsPropagationMs);
    const stateLatencies = clickObservations.map((entry) => entry.statePollMs);
    const ackLatencies = clickObservations.map((entry) => entry.httpLatencyMs);

    const verifyStatus = failedClicks.length === 0 && voteFailures === 0 ? 'ok' : 'failed';

    log({
      phase: 'verify',
      status: verifyStatus,
      sessionId: setup.sessionId,
      requestedVotes: CONCURRENCY,
      successfulVotes: CONCURRENCY - voteFailures,
      failedVotes: voteFailures,
      clickCount: clickObservations.length,
      finalCurrentSlideId: finalState.json?.currentSlideId ?? null,
      finalStateVersion: finalState.json?.stateVersion ?? null,
      clickAckLatency: summarizeLatencies(ackLatencies),
      wsPropagationLatency: summarizeLatencies(wsLatencies),
      statePollLatency: summarizeLatencies(stateLatencies),
      clickObservations,
      voteFailureSamples: voteSummary.failures.slice(0, 5),
    });

    if (verifyStatus !== 'ok') {
      throw new Error(`verification failed (failedVotes=${voteFailures} failedClicks=${failedClicks.length})`);
    }
  } finally {
    observer.close();
    await cleanupSession(setup.sessionId).catch((error) => {
      log({
        phase: 'cleanup',
        status: 'failed',
        sessionId: setup.sessionId,
        message: error.message,
      });
    });
  }
}

main().catch((error) => {
  log({
    phase: 'fatal',
    status: 'failed',
    message: error.message,
  });
  process.exit(1);
});
