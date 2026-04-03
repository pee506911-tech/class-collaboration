#!/usr/bin/env node
/**
 * Concurrency Test Runner
 * 
 * Executes the concurrency test suite against a running backend instance.
 * Requires:
 * - MySQL test database
 * - Backend running with test configuration
 * - Ably stub running
 * 
 * Usage: node run-concurrency-tests.js [options]
 * 
 * Options:
 *   --concurrency <n>    Number of concurrent requests (default: 100)
 *   --base-url <url>     Backend API URL (default: http://localhost:8080)
 *   --ably-url <url>     Ably stub URL (default: http://localhost:8081)
 */

import fetch from 'node-fetch';

function getArgValue(name, fallback) {
  const idx = process.argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (idx === -1) return fallback;

  const raw = process.argv[idx];
  if (raw.includes('=')) {
    return raw.slice(raw.indexOf('=') + 1) || fallback;
  }

  return process.argv[idx + 1] || fallback;
}

// Configuration
const CONFIG = {
  concurrency: parseInt(getArgValue('--concurrency', '100'), 10),
  baseUrl: getArgValue('--base-url', 'http://localhost:8080'),
  ablyUrl: getArgValue('--ably-url', 'http://localhost:8081'),
  databaseUrl: process.env.DATABASE_URL || 'mysql://classcolab:testpassword@localhost:3307/classcolab_test',
};

// Test results tracking
const results = {
  passed: [],
  failed: [],
  skipped: [],
};

// Utility functions
function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = {
    info: 'ℹ️',
    pass: '✅',
    fail: '❌',
    warn: '⚠️',
    test: '🧪',
  }[type] || 'ℹ️';
  
  console.log(`${prefix} [${timestamp}] ${message}`);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stableSerialize(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableSerialize(value[k])}`).join(',')}}`;
}

async function fetchMyVotes({ sessionId, participantId }) {
  const url = new URL(`${CONFIG.baseUrl}/api/sessions/${sessionId}/my-votes`);
  url.searchParams.set('participantId', participantId);
  const res = await fetch(url.toString(), { method: 'GET' });
  const json = await res.json().catch(() => null);
  return { res, json };
}

function normalizeVoteMap(votes) {
  if (!votes || typeof votes !== 'object') return {};
  const out = {};
  for (const [slideId, optionIds] of Object.entries(votes)) {
    if (!Array.isArray(optionIds)) continue;
    out[slideId] = optionIds.map(String).sort();
  }
  return out;
}

function assertVoteMapEquals(actualVotes, expectedVotes, label) {
  const actual = normalizeVoteMap(actualVotes);
  const expected = normalizeVoteMap(expectedVotes);
  const a = stableSerialize(actual);
  const e = stableSerialize(expected);
  assert(a === e, `${label}: vote map mismatch (actual=${a} expected=${e})`);
}

async function clearAblyCaptures() {
  await fetch(`${CONFIG.ablyUrl}/admin/captures`, { method: 'DELETE' });
}

async function fetchAblyCaptures({ channel, event } = {}) {
  const url = new URL(`${CONFIG.ablyUrl}/admin/captures`);
  if (channel) url.searchParams.set('channel', channel);
  if (event) url.searchParams.set('event', event);

  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ably captures fetch failed: ${res.status} ${body}`);
  }
  const json = await res.json();
  return json.captures || [];
}

async function waitForAblyCaptures({
  channel,
  event,
  minCount,
  timeoutMs = 30000,
  pollIntervalMs = 150,
  filter = undefined,
} = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const captures = await fetchAblyCaptures({ channel, event });
    const filtered = filter ? captures.filter(filter) : captures;
    if (filtered.length >= minCount) return filtered;
    await sleep(pollIntervalMs);
  }

  const captures = await fetchAblyCaptures({ channel, event });
  const filtered = filter ? captures.filter(filter) : captures;
  throw new Error(
    `Timed out waiting for captures (channel=${channel} event=${event} minCount=${minCount} got=${filtered.length})`
  );
}

// Test session setup
async function createTestSession() {
  const sessionId = Math.random().toString(36).substring(2, 10);
  const slideId = Math.random().toString(36).substring(2, 10);
  
  // Create session via direct DB insert (faster than API)
  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({
    uri: CONFIG.databaseUrl,
    waitForConnections: true,
    connectionLimit: 10,
  });
  
  try {
    await pool.query(`DELETE FROM votes WHERE session_id = ?`, [sessionId]);
    await pool.query(`DELETE FROM questions WHERE session_id = ?`, [sessionId]);
    await pool.query(`DELETE FROM slides WHERE session_id = ?`, [sessionId]);
    await pool.query(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
    
    await pool.query(
      `INSERT INTO sessions (id, creator_id, title, status, share_token, state_version, allow_questions, require_name)
       VALUES (?, 'test-user', 'Test Session', 'published', 'test-token', 0, TRUE, FALSE)`,
      [sessionId]
    );
    
    const slideContent = JSON.stringify({
      question: "What is your favorite color?",
      options: [
        { id: "opt-red", text: "Red" },
        { id: "opt-blue", text: "Blue" },
        { id: "opt-green", text: "Green" },
        { id: "opt-yellow", text: "Yellow" }
      ],
      limitSubmissions: true
    });
    
    await pool.query(
      `INSERT INTO slides (id, session_id, type, content, order_index)
       VALUES (?, ?, 'poll', ?, FLOOR(RAND() * 10000))`,
      [slideId, sessionId, slideContent]
    );
    
    log(`Created test session: ${sessionId}`, 'info');
    
    return { sessionId, slideId, pool };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

// Test: T-01 Same-Participant Vote Race
async function testT01_sameParticipantVoteRace(sessionId, slideId) {
  log('T-01: Same-Participant Vote Race Test', 'test');
  
  const concurrencyLevels = [2, 5, 10];
  
  for (const concurrency of concurrencyLevels) {
    log(`  Testing with ${concurrency} concurrent requests...`, 'info');
    const participantId = `race-test-${Math.random().toString(36).substring(2, 10)}-${concurrency}`;

    const { createPool } = await import('mysql2/promise');
    const pool = await createPool({ uri: CONFIG.databaseUrl });
    const baselineSeq = await getSessionSequence(pool, sessionId, 'vote_sequence');
    
    // Submit multiple votes concurrently
    const promises = [];
    for (let i = 0; i < concurrency; i++) {
      const promise = fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slideId,
          optionId: 'opt-red',
          participantId,
        }),
      });
      promises.push(promise);
    }
    
    const responses = await Promise.all(promises);
    const statusCodes = responses.map(r => r.status);
    
    // Wait for DB writes
    await sleep(200);
    
    const [[result]] = await pool.query(
      'SELECT COUNT(*) as count FROM votes WHERE slide_id = ? AND participant_id = ?',
      [slideId, participantId]
    );
    
    const voteCount = result.count;
    const finalSeq = await getSessionSequence(pool, sessionId, 'vote_sequence');
    await pool.end();
    
    if (voteCount === 1) {
      log(`  ✅ Concurrency ${concurrency}: Exactly 1 vote persisted (statuses: ${statusCodes.join(', ')})`, 'pass');
    } else {
      log(`  ❌ Concurrency ${concurrency}: Expected 1 vote, got ${voteCount}`, 'fail');
      return false;
    }

    if (finalSeq !== baselineSeq + 1) {
      log(`  ❌ Concurrency ${concurrency}: vote_sequence expected ${baselineSeq + 1}, got ${finalSeq}`, 'fail');
      return false;
    }
  }
  
  return true;
}

// Test: T-02 Burst Vote Load
async function testT02_burstVoteLoad(sessionId, slideId) {
  log('T-02: Burst Vote Load Test', 'test');
  
  const concurrencyLevels = [CONFIG.concurrency];
  
  for (const concurrency of concurrencyLevels) {
    log(`  Testing with ${concurrency} participants...`, 'info');
    
    // Create a fresh slide for this test
    const testSlideId = Math.random().toString(36).substring(2, 10);
    const { createPool } = await import('mysql2/promise');
    const pool = await createPool({ uri: CONFIG.databaseUrl });
    
    const slideContent = JSON.stringify({
      question: "Burst test?",
      options: [
        { id: "opt-red", text: "Red" },
        { id: "opt-blue", text: "Blue" },
        { id: "opt-green", text: "Green" },
        { id: "opt-yellow", text: "Yellow" }
      ],
      limitSubmissions: true
    });
    
    await pool.query(
      `INSERT INTO slides (id, session_id, type, content, order_index)
       VALUES (?, ?, 'poll', ?, FLOOR(RAND() * 10000))`,
      [testSlideId, sessionId, slideContent]
    );
    
    const startTime = Date.now();
    
    // Submit votes from distinct participants
    const promises = [];
    for (let i = 0; i < concurrency; i++) {
      const participantId = `burst-${Math.random().toString(36).substring(2, 10)}`;
      const optionId = ['opt-red', 'opt-blue', 'opt-green', 'opt-yellow'][i % 4];
      
      const promise = fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slideId: testSlideId,
          optionId,
          participantId,
        }),
      });
      promises.push(promise);
    }
    
    const responses = await Promise.all(promises);
    const elapsed = Date.now() - startTime;
    
    // Wait for DB writes
    await sleep(500);
    
    // Check vote count
    const [[result]] = await pool.query(
      'SELECT COUNT(*) as count FROM votes WHERE slide_id = ?',
      [testSlideId]
    );
    await pool.end();
    
    const voteCount = result.count;
    
    if (voteCount === concurrency) {
      log(`  ✅ ${concurrency} votes persisted in ${elapsed}ms`, 'pass');
    } else {
      log(`  ❌ Expected ${concurrency} votes, got ${voteCount}`, 'fail');
      return false;
    }
  }
  
  return true;
}

// Test: T-03 Invalid Option Rejection
async function testT03_invalidOptionRejection(sessionId, slideId) {
  log('T-03: Invalid Option Rejection Test', 'test');
  
  const validOptions = ['opt-red', 'opt-blue', 'opt-green', 'opt-yellow'];
  const invalidOptions = ['opt-invalid', 'opt-nonexistent', '', 'opt-12345'];
  
  // Create a fresh slide for this test
  const testSlideId = Math.random().toString(36).substring(2, 10);
  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl });
  
  const slideContent = JSON.stringify({
    question: "Invalid option test?",
    options: validOptions.map((text, i) => ({ id: text, text: text })),
    limitSubmissions: true
  });
  
  await pool.query(
    `INSERT INTO slides (id, session_id, type, content, order_index)
     VALUES (?, ?, 'poll', ?, FLOOR(RAND() * 10000))`,
    [testSlideId, sessionId, slideContent]
  );
  
  // Submit valid votes
  const validPromises = validOptions.map((optionId, i) => {
    const participantId = `valid-${Math.random().toString(36).substring(2, 10)}`;
    return fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slideId: testSlideId, optionId, participantId }),
    });
  });
  
  // Submit invalid votes
  const invalidPromises = invalidOptions.map((optionId, i) => {
    const participantId = `invalid-${Math.random().toString(36).substring(2, 10)}`;
    return fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slideId: testSlideId, optionId, participantId }),
    });
  });
  
  await Promise.all([...validPromises, ...invalidPromises]);
  await sleep(300);
  
  // Check vote count
  const [[result]] = await pool.query(
    'SELECT COUNT(*) as count FROM votes WHERE slide_id = ?',
    [testSlideId]
  );
  await pool.end();
  
  const voteCount = result.count;
  
  if (voteCount === validOptions.length) {
    log(`  ✅ Only ${validOptions.length} valid votes persisted (rejected ${invalidOptions.length} invalid)`, 'pass');
    return true;
  } else {
    log(`  ❌ Expected ${validOptions.length} votes, got ${voteCount}`, 'fail');
    return false;
  }
}

async function getSessionSequence(pool, sessionId, columnName) {
  const [[row]] = await pool.query(`SELECT ${columnName} as seq FROM sessions WHERE id = ?`, [sessionId]);
  return Number(row?.seq || 0);
}

function analyzeSequenceSet({ baseline, sequences, label }) {
  const numeric = sequences.map((s) => Number(s));
  if (numeric.some((n) => !Number.isFinite(n))) {
    throw new Error(`${label}: Non-numeric sequence observed (sample=${JSON.stringify(sequences.slice(0, 10))})`);
  }

  const sorted = [...numeric].sort((a, b) => a - b);
  const unique = new Set(sorted);
  if (unique.size !== sorted.length) {
    throw new Error(`${label}: Duplicate sequence(s) detected (unique=${unique.size} total=${sorted.length})`);
  }

  const expectedMin = baseline + 1;
  const expectedMax = baseline + sorted.length;
  if (sorted.length === 0) {
    throw new Error(`${label}: No sequences captured (baseline=${baseline})`);
  }
  if (sorted[0] !== expectedMin) {
    throw new Error(`${label}: Expected min seq=${expectedMin}, got ${sorted[0]}`);
  }
  if (sorted[sorted.length - 1] !== expectedMax) {
    throw new Error(`${label}: Expected max seq=${expectedMax}, got ${sorted[sorted.length - 1]}`);
  }

  // Contiguity check: catches "two updates publish the same seq" => missing a value.
  for (let i = 0; i < sorted.length; i++) {
    const expected = baseline + 1 + i;
    if (sorted[i] !== expected) {
      throw new Error(`${label}: Sequence gap detected: expected ${expected} at index ${i}, got ${sorted[i]}`);
    }
  }

  return { expectedMin, expectedMax, count: sorted.length };
}

async function createPollSlideForSession(pool, sessionId, { limitSubmissions, allowMultipleSelection } = {}) {
  const slideId = Math.random().toString(36).substring(2, 10);
  const slideContent = JSON.stringify({
    question: "Poll?",
    options: [
      { id: "opt-red", text: "Red" },
      { id: "opt-blue", text: "Blue" },
      { id: "opt-green", text: "Green" },
      { id: "opt-yellow", text: "Yellow" }
    ],
    limitSubmissions: limitSubmissions ?? true,
    allowMultipleSelection: allowMultipleSelection ?? false,
  });

  await pool.query(
    `INSERT INTO slides (id, session_id, type, content, order_index)
     VALUES (?, ?, 'poll', ?, FLOOR(RAND() * 10000))`,
    [slideId, sessionId, slideContent]
  );

  return slideId;
}

// Test: T-07 Vote Update Sequence Uniqueness (Ably capture based)
async function testT07_voteUpdateSequenceUniqueness(sessionId) {
  log('T-07: Vote Update Sequence Uniqueness Test', 'test');

  const channel = `session:${sessionId}`;
  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl });

  // Create a fresh slide to isolate VOTE_UPDATE captures.
  const testSlideId = await createPollSlideForSession(pool, sessionId, { limitSubmissions: true });

  const baseline = await getSessionSequence(pool, sessionId, 'vote_sequence');
  await clearAblyCaptures();
  await sleep(150);

  const concurrency = Math.min(CONFIG.concurrency, 50);
  log(`  Submitting ${concurrency} concurrent votes...`, 'info');

  const promises = [];
  for (let i = 0; i < concurrency; i++) {
    const participantId = `seq-vote-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const optionId = ['opt-red', 'opt-blue', 'opt-green', 'opt-yellow'][i % 4];
    promises.push(
      fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slideId: testSlideId, optionId, participantId }),
      })
    );
  }

  const responses = await Promise.all(promises);
  const successCount = responses.filter((r) => r.ok).length;
  assert(successCount === concurrency, `Expected all vote requests to succeed (ok=${successCount} expected=${concurrency})`);

  const captures = await waitForAblyCaptures({
    channel,
    event: 'VOTE_UPDATE',
    minCount: successCount,
    filter: (c) =>
      c?.data?.slideId === testSlideId &&
      typeof c?.data?.sequence === 'number' &&
      c.data.sequence > baseline,
  });

  const sequences = captures.map((c) => c.data.sequence);
  const analysis = analyzeSequenceSet({ baseline, sequences, label: 'T-07(VOTE_UPDATE)' });
  const finalDb = await getSessionSequence(pool, sessionId, 'vote_sequence');
  assert(finalDb === analysis.expectedMax, `vote_sequence mismatch (expected=${analysis.expectedMax} got=${finalDb})`);

  await pool.end();
  log(`  ✅ Captured ${analysis.count} VOTE_UPDATE events with contiguous unique sequences (${analysis.expectedMin}..${analysis.expectedMax})`, 'pass');
  return true;
}

// Test: T-08 Q&A Update Sequence Uniqueness (question burst)
async function testT08_qaUpdateSequenceUniqueness_questions(sessionId) {
  log('T-08: Q&A Update Sequence Uniqueness (Questions) Test', 'test');

  const channel = `session:${sessionId}`;
  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl });

  const baseline = await getSessionSequence(pool, sessionId, 'qa_sequence');
  await clearAblyCaptures();
  await sleep(150);

  const concurrency = Math.min(CONFIG.concurrency, 30);
  log(`  Submitting ${concurrency} concurrent questions...`, 'info');

  const promises = [];
  for (let i = 0; i < concurrency; i++) {
    const participantId = `seq-q-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const content = `Sequence test question ${i} ${Math.random().toString(36).slice(2, 8)}`;
    promises.push(
      fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, participantId }),
      })
    );
  }

  const responses = await Promise.all(promises);
  const successCount = responses.filter((r) => r.ok).length;
  assert(successCount === concurrency, `Expected all question requests to succeed (ok=${successCount} expected=${concurrency})`);

  const captures = await waitForAblyCaptures({
    channel,
    event: 'QA_UPDATE',
    minCount: successCount,
    filter: (c) => typeof c?.data?.sequence === 'number' && c.data.sequence > baseline,
  });

  const sequences = captures.map((c) => c.data.sequence);
  const analysis = analyzeSequenceSet({ baseline, sequences, label: 'T-08(QA_UPDATE/questions)' });
  const finalDb = await getSessionSequence(pool, sessionId, 'qa_sequence');
  assert(finalDb === analysis.expectedMax, `qa_sequence mismatch (expected=${analysis.expectedMax} got=${finalDb})`);

  await pool.end();
  log(`  ✅ Captured ${analysis.count} QA_UPDATE events with contiguous unique sequences (${analysis.expectedMin}..${analysis.expectedMax})`, 'pass');
  return true;
}

// Test: T-09 Q&A Update Sequence Uniqueness (upvote burst)
async function testT09_qaUpdateSequenceUniqueness_upvotes(sessionId) {
  log('T-09: Q&A Update Sequence Uniqueness (Upvotes) Test', 'test');

  const channel = `session:${sessionId}`;
  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl });

  const authorId = `seq-upvote-author-${Math.random().toString(36).slice(2, 8)}`;
  const createRes = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Upvote sequence test question', participantId: authorId }),
  });
  assert(createRes.ok, `Failed to create seed question for upvotes (status=${createRes.status})`);

  await sleep(200);
  const [[qRow]] = await pool.query(
    'SELECT id FROM questions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
    [sessionId]
  );
  const questionId = qRow?.id;
  assert(questionId, 'Failed to find created questionId in DB');

  const baseline = await getSessionSequence(pool, sessionId, 'qa_sequence');
  await clearAblyCaptures();
  await sleep(150);

  const concurrency = Math.min(CONFIG.concurrency, 40);
  log(`  Submitting ${concurrency} concurrent upvotes...`, 'info');

  const promises = [];
  for (let i = 0; i < concurrency; i++) {
    const participantId = `seq-upvoter-${i}-${Math.random().toString(36).slice(2, 8)}`;
    promises.push(
      fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/questions/${questionId}/upvote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantId }),
      })
    );
  }

  const responses = await Promise.all(promises);
  const successCount = responses.filter((r) => r.ok).length;
  assert(successCount === concurrency, `Expected all upvote requests to succeed (ok=${successCount} expected=${concurrency})`);

  const captures = await waitForAblyCaptures({
    channel,
    event: 'QA_UPDATE',
    minCount: successCount,
    filter: (c) => typeof c?.data?.sequence === 'number' && c.data.sequence > baseline,
  });

  const sequences = captures.map((c) => c.data.sequence);
  const analysis = analyzeSequenceSet({ baseline, sequences, label: 'T-09(QA_UPDATE/upvotes)' });
  const finalDb = await getSessionSequence(pool, sessionId, 'qa_sequence');
  assert(finalDb === analysis.expectedMax, `qa_sequence mismatch (expected=${analysis.expectedMax} got=${finalDb})`);

  await pool.end();
  log(`  ✅ Captured ${analysis.count} QA_UPDATE events with contiguous unique sequences (${analysis.expectedMin}..${analysis.expectedMax})`, 'pass');
  return true;
}

async function runVoteBurstWithSequenceAssertions({
  pool,
  sessionId,
  slideId,
  concurrency,
  label,
  addJitter = false,
}) {
  const channel = `session:${sessionId}`;
  const baseline = await getSessionSequence(pool, sessionId, 'vote_sequence');

  await clearAblyCaptures();
  await sleep(150);

  const promises = Array.from({ length: concurrency }, (_, i) => i).map(async (i) => {
    if (addJitter) {
      await sleep(Math.floor(Math.random() * 25));
    }

    const participantId = `${label}-voter-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const optionId = ['opt-red', 'opt-blue', 'opt-green', 'opt-yellow'][i % 4];
    const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slideId, optionId, participantId }),
    });
    return res.ok;
  });

  const oks = await Promise.all(promises);
  const okCount = oks.filter(Boolean).length;
  assert(okCount === concurrency, `${label}: vote burst had failures (ok=${okCount} expected=${concurrency})`);

  const captures = await waitForAblyCaptures({
    channel,
    event: 'VOTE_UPDATE',
    minCount: okCount,
    filter: (c) =>
      c?.data?.slideId === slideId &&
      typeof c?.data?.sequence === 'number' &&
      c.data.sequence > baseline,
  });

  const sequences = captures.map((c) => c.data.sequence);
  const analysis = analyzeSequenceSet({ baseline, sequences, label: `${label}(VOTE_UPDATE)` });
  const finalDb = await getSessionSequence(pool, sessionId, 'vote_sequence');
  assert(finalDb === analysis.expectedMax, `${label}: vote_sequence mismatch (expected=${analysis.expectedMax} got=${finalDb})`);

  return analysis;
}

// Test: T-13 Vote Sequence Stress (multiple rounds + jitter)
async function testT13_voteSequenceStressRounds(sessionId) {
  log('T-13: Vote Sequence Stress (Rounds + Jitter) Test', 'test');

  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl });

  const rounds = 5;
  const concurrency = Math.min(CONFIG.concurrency, 60);

  for (let round = 1; round <= rounds; round++) {
    const slideId = await createPollSlideForSession(pool, sessionId, { limitSubmissions: true });
    log(`  Round ${round}/${rounds}: ${concurrency} concurrent votes (jittered)`, 'info');

    const analysis = await runVoteBurstWithSequenceAssertions({
      pool,
      sessionId,
      slideId,
      concurrency,
      label: `T-13-R${round}`,
      addJitter: true,
    });

    log(`  ✅ Round ${round}: sequences ${analysis.expectedMin}..${analysis.expectedMax}`, 'pass');
  }

  await pool.end();
  return true;
}

// Test: T-14 Vote Sequence Uniqueness when limitSubmissions=false
async function testT14_voteSequenceLimitSubmissionsFalse(sessionId) {
  log('T-14: Vote Sequence (limitSubmissions=false) Test', 'test');

  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl });

  const slideId = await createPollSlideForSession(pool, sessionId, { limitSubmissions: false });
  const concurrency = Math.min(CONFIG.concurrency, 60);

  log(`  Submitting ${concurrency} concurrent votes (no submission lock table)...`, 'info');
  const analysis = await runVoteBurstWithSequenceAssertions({
    pool,
    sessionId,
    slideId,
    concurrency,
    label: 'T-14',
    addJitter: true,
  });

  await pool.end();
  log(`  ✅ Captured contiguous unique sequences (${analysis.expectedMin}..${analysis.expectedMax})`, 'pass');
  return true;
}

async function registerAndLoginStaff() {
  const email = `staff-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const password = `Password-${Math.random().toString(36).slice(2, 10)}!`;
  const name = 'Loadtest Staff';

  const registerRes = await fetch(`${CONFIG.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name, role: 'staff' }),
  });
  if (!registerRes.ok) {
    const body = await registerRes.text().catch(() => '');
    throw new Error(`Staff register failed: ${registerRes.status} ${body}`);
  }
  const registerJson = await registerRes.json().catch(() => ({}));
  const userId = registerJson.userId;
  assert(typeof userId === 'string' && userId.length > 0, 'Staff register did not return userId');

  const loginRes = await fetch(`${CONFIG.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    const body = await loginRes.text().catch(() => '');
    throw new Error(`Staff login failed: ${loginRes.status} ${body}`);
  }
  const loginJson = await loginRes.json().catch(() => ({}));
  const token = loginJson.token;
  assert(typeof token === 'string' && token.length > 0, 'Staff login did not return token');

  return { token, userId, email };
}

async function createOwnedSessionWithSlides({ pool, creatorId, slideCount }) {
  const sessionId = Math.random().toString(36).substring(2, 10);
  const shareToken = `test-token-${Math.random().toString(36).slice(2, 8)}`;

  await pool.query(`DELETE FROM votes WHERE session_id = ?`, [sessionId]);
  await pool.query(`DELETE FROM questions WHERE session_id = ?`, [sessionId]);
  await pool.query(`DELETE FROM participants WHERE session_id = ?`, [sessionId]).catch(() => {});
  await pool.query(`DELETE FROM slides WHERE session_id = ?`, [sessionId]);
  await pool.query(`DELETE FROM sessions WHERE id = ?`, [sessionId]);

  await pool.query(
    `INSERT INTO sessions (id, creator_id, title, status, share_token, state_version, allow_questions, require_name)
     VALUES (?, ?, 'Scenario Session', 'published', ?, 0, TRUE, FALSE)`,
    [sessionId, creatorId, shareToken]
  );

  const slideIds = [];
  for (let i = 0; i < slideCount; i++) {
    const slideId = Math.random().toString(36).substring(2, 10);
    const slideContent = JSON.stringify({
      question: `Scenario slide ${i + 1}?`,
      options: [
        { id: 'opt-a', text: 'A' },
        { id: 'opt-b', text: 'B' },
        { id: 'opt-c', text: 'C' },
        { id: 'opt-d', text: 'D' },
      ],
      limitSubmissions: true,
      allowMultipleSelection: false,
    });

    await pool.query(
      `INSERT INTO slides (id, session_id, type, content, order_index)
       VALUES (?, ?, 'poll', ?, ?)`,
      [slideId, sessionId, slideContent, i * 1024]
    );
    slideIds.push(slideId);
  }

  return { sessionId, slideIds };
}

async function cleanupSessionArtifacts(pool, sessionId) {
  await pool.query('DELETE FROM slide_delete_requests WHERE session_id = ?', [sessionId]).catch(() => {});
  await pool.query('DELETE FROM question_upvotes WHERE question_id IN (SELECT id FROM questions WHERE session_id = ?)', [sessionId]).catch(() => {});
  await pool.query('DELETE FROM questions WHERE session_id = ?', [sessionId]).catch(() => {});
  await pool.query('DELETE FROM votes WHERE session_id = ?', [sessionId]).catch(() => {});
  await pool.query('DELETE FROM vote_submissions WHERE session_id = ?', [sessionId]).catch(() => {});
  await pool.query('DELETE FROM participants WHERE session_id = ?', [sessionId]).catch(() => {});
  await pool.query('DELETE FROM slides WHERE session_id = ?', [sessionId]).catch(() => {});
  await pool.query('DELETE FROM sessions WHERE id = ?', [sessionId]).catch(() => {});
}

// Test: T-10 Realistic Scenario (100 students join + staff dashboard + vote burst)
async function testT10_realisticJoinDashboardVoteScenario() {
  log('T-10: Realistic Scenario (Join + Dashboard + Vote)', 'test');

  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl, waitForConnections: true, connectionLimit: 10 });

  const { token, userId, email } = await registerAndLoginStaff();
  const slideCount = 6;
  const { sessionId, slideIds } = await createOwnedSessionWithSlides({ pool, creatorId: userId, slideCount });
  const voteSlideId = slideIds[0];

  const staffHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const studentCount = Math.min(CONFIG.concurrency, 100);

  // Start staff dashboard actions in parallel with join/vote workload to create real lock contention.
  const staffOps = (async () => {
    const errors = [];

    const goLive = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/go-live`, {
      method: 'POST',
      headers: staffHeaders,
    });
    if (!goLive.ok) errors.push(`go-live:${goLive.status}`);

    const setCurrent = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/current-slide`, {
      method: 'PUT',
      headers: staffHeaders,
      body: JSON.stringify({ slideId: voteSlideId }),
    });
    if (!setCurrent.ok) errors.push(`current-slide:${setCurrent.status}`);

    // Poll stats and toggle results visibility while students are active.
    for (let i = 0; i < 8; i++) {
      const statsRes = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/stats`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!statsRes.ok) errors.push(`stats:${statsRes.status}`);
      else {
        const json = await statsRes.json().catch(() => null);
        if (!json || !Array.isArray(json.slides) || !Array.isArray(json.participants)) {
          errors.push('stats:bad-shape');
        }
      }

      const visible = i % 2 === 0;
      const visRes = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/results-visibility`, {
        method: 'PUT',
        headers: staffHeaders,
        body: JSON.stringify({ visible }),
      });
      if (!visRes.ok) errors.push(`results-visibility:${visRes.status}`);

      await sleep(75);
    }

    if (errors.length > 0) throw new Error(`Staff dashboard ops failed: ${errors.join(', ')}`);
  })();

  // Students join: Ably token + participant registration.
  const requiredTokenKeys = ['keyName', 'ttl', 'capability', 'clientId', 'timestamp', 'nonce', 'mac'];
  const joinAndRegister = (async () => {
    const seenClientIds = new Set();
    const seenNonces = new Set();

    const joinReqs = Array.from({ length: studentCount }, (_, i) => i).map(async (i) => {
      const participantId = `student-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const tokenUrl = `${CONFIG.baseUrl}/api/auth/ably?sessionId=${encodeURIComponent(sessionId)}&role=student&participantId=${encodeURIComponent(participantId)}`;

      const tokenRes = await fetch(tokenUrl, { method: 'GET' });
      if (!tokenRes.ok) return { ok: false, stage: 'token', status: tokenRes.status };
      const tokenJson = await tokenRes.json().catch(() => null);
      const tokenOk = tokenJson && requiredTokenKeys.every((k) => Object.prototype.hasOwnProperty.call(tokenJson, k));
      if (!tokenOk) return { ok: false, stage: 'token-schema', status: 0 };
      if (tokenJson.clientId !== participantId) return { ok: false, stage: 'token-clientId', status: 0 };

      // Student tokens must not have publish capability.
      try {
        const cap = JSON.parse(tokenJson.capability);
        const ops = cap?.[`session:${sessionId}`];
        if (!Array.isArray(ops) || ops.sort().join(',') !== ['presence', 'subscribe'].join(',')) {
          return { ok: false, stage: 'token-capability', status: 0 };
        }
      } catch {
        return { ok: false, stage: 'token-capability-json', status: 0 };
      }

      if (seenClientIds.has(tokenJson.clientId)) return { ok: false, stage: 'token-clientId-dup', status: 0 };
      seenClientIds.add(tokenJson.clientId);
      if (seenNonces.has(tokenJson.nonce)) return { ok: false, stage: 'token-nonce-dup', status: 0 };
      seenNonces.add(tokenJson.nonce);

      const regRes = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/register-participant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantId, name: `Student ${i}` }),
      });
      if (!regRes.ok) return { ok: false, stage: 'register', status: regRes.status };

      return { ok: true, participantId };
    });

    const results = await Promise.all(joinReqs);
    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
      const sample = failures.slice(0, 5).map((f) => `${f.stage}:${f.status}`).join(', ');
      throw new Error(`Student join/register failures: count=${failures.length} sample=${sample}`);
    }
  })();

  const voteBurst = (async () => {
    await joinAndRegister;

    const baseline = await getSessionSequence(pool, sessionId, 'vote_sequence');
    await clearAblyCaptures();
    await sleep(150);

    const voteReqs = Array.from({ length: studentCount }, (_, i) => i).map(async (i) => {
      const participantId = `voter-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const optionId = ['opt-a', 'opt-b', 'opt-c', 'opt-d'][i % 4];
      const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slideId: voteSlideId, optionId, participantId }),
      });
      return res.ok;
    });

    const oks = await Promise.all(voteReqs);
    const okCount = oks.filter(Boolean).length;
    assert(okCount === studentCount, `Vote burst had failures (ok=${okCount} expected=${studentCount})`);

    const captures = await waitForAblyCaptures({
      channel: `session:${sessionId}`,
      event: 'VOTE_UPDATE',
      minCount: okCount,
      filter: (c) =>
        c?.data?.slideId === voteSlideId &&
        typeof c?.data?.sequence === 'number' &&
        c.data.sequence > baseline,
    });

    const sequences = captures.map((c) => c.data.sequence);
    const analysis = analyzeSequenceSet({ baseline, sequences, label: 'T-10(VOTE_UPDATE)' });

    const [[voteRow]] = await pool.query('SELECT COUNT(*) as count FROM votes WHERE session_id = ? AND slide_id = ?', [sessionId, voteSlideId]);
    assert(Number(voteRow.count) === studentCount, `DB vote count mismatch (db=${voteRow.count} expected=${studentCount})`);

    const finalDb = await getSessionSequence(pool, sessionId, 'vote_sequence');
    assert(finalDb === analysis.expectedMax, `vote_sequence mismatch (expected=${analysis.expectedMax} got=${finalDb})`);

    log(`  ✅ Scenario votes published with contiguous unique sequences (${analysis.expectedMin}..${analysis.expectedMax})`, 'pass');
  })();

  // Await all scenario tasks (staff + joins + votes).
  try {
    await Promise.all([staffOps, joinAndRegister, voteBurst]);

    // Final dashboard snapshot should reflect full join.
    const statsRes = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/stats`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(statsRes.ok, `Final stats fetch failed (status=${statsRes.status})`);
    const stats = await statsRes.json();
    assert(Array.isArray(stats.participants), 'Final stats missing participants');
    assert(stats.participants.length >= studentCount, `Final stats participants too low (got=${stats.participants.length} expected>=${studentCount})`);
    assert(Array.isArray(stats.slides) && stats.slides.length === slideCount, `Final stats slides mismatch (got=${stats.slides?.length} expected=${slideCount})`);

    await cleanupSessionArtifacts(pool, sessionId);
    await pool.query('DELETE FROM users WHERE id = ?', [userId]).catch(() => {});
    await pool.end();

    log(`  ✅ Scenario complete (staff=${email} students=${studentCount})`, 'pass');
    return true;
  } catch (e) {
    await cleanupSessionArtifacts(pool, sessionId).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ?', [userId]).catch(() => {});
    await pool.end().catch(() => {});
    throw e;
  }
}

// Test: T-11 Interleaved writers (votes + questions + upvotes) with sequence integrity
async function testT11_interleavedWritersSequenceIntegrity() {
  log('T-11: Interleaved Writers Sequence Integrity Test', 'test');

  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl, waitForConnections: true, connectionLimit: 10 });

  const sessionId = Math.random().toString(36).substring(2, 10);
  const slideId = Math.random().toString(36).substring(2, 10);

  await cleanupSessionArtifacts(pool, sessionId);
  await pool.query(
    `INSERT INTO sessions (id, creator_id, title, status, share_token, state_version, allow_questions, require_name)
     VALUES (?, 'test-user', 'Interleaved Session', 'published', 'test-token', 0, TRUE, FALSE)`,
    [sessionId]
  );

  const slideContent = JSON.stringify({
    question: 'Interleaved test?',
    options: [
      { id: 'opt-a', text: 'A' },
      { id: 'opt-b', text: 'B' },
      { id: 'opt-c', text: 'C' },
      { id: 'opt-d', text: 'D' },
    ],
    limitSubmissions: true,
    allowMultipleSelection: false,
  });
  await pool.query(
    `INSERT INTO slides (id, session_id, type, content, order_index)
     VALUES (?, ?, 'poll', ?, 0)`,
    [slideId, sessionId, slideContent]
  );

  // Seed one question for upvotes, then take baselines.
  const seedAuthor = `seed-author-${Math.random().toString(36).slice(2, 8)}`;
  const seedRes = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Seed question', participantId: seedAuthor }),
  });
  assert(seedRes.ok, `Failed to seed question (status=${seedRes.status})`);
  await sleep(150);
  const [[qRow]] = await pool.query('SELECT id FROM questions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1', [sessionId]);
  const questionId = qRow?.id;
  assert(questionId, 'Failed to read seeded question id');

  const baselineVote = await getSessionSequence(pool, sessionId, 'vote_sequence');
  const baselineQa = await getSessionSequence(pool, sessionId, 'qa_sequence');
  await clearAblyCaptures();
  await sleep(150);

  const voteN = Math.min(CONFIG.concurrency, 60);
  const questionN = Math.min(Math.floor(CONFIG.concurrency / 3), 25);
  const upvoteN = Math.min(Math.floor(CONFIG.concurrency / 2), 40);

  const voteReqs = Array.from({ length: voteN }, (_, i) => i).map(async (i) => {
    const participantId = `mix-voter-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const optionId = ['opt-a', 'opt-b', 'opt-c', 'opt-d'][i % 4];
    const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slideId, optionId, participantId }),
    });
    return res.ok;
  });

  const questionReqs = Array.from({ length: questionN }, (_, i) => i).map(async (i) => {
    const participantId = `mix-q-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `Interleaved question ${i}`, participantId }),
    });
    return res.ok;
  });

  const upvoteReqs = Array.from({ length: upvoteN }, (_, i) => i).map(async (i) => {
    const participantId = `mix-up-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/questions/${questionId}/upvote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId }),
    });
    return res.ok;
  });

  const [voteOk, qOk, upOk] = await Promise.all([
    Promise.all(voteReqs),
    Promise.all(questionReqs),
    Promise.all(upvoteReqs),
  ]);

  const voteOkCount = voteOk.filter(Boolean).length;
  const qOkCount = qOk.filter(Boolean).length;
  const upOkCount = upOk.filter(Boolean).length;
  assert(voteOkCount === voteN, `Vote failures in interleaved test (ok=${voteOkCount} expected=${voteN})`);
  assert(qOkCount === questionN, `Question failures in interleaved test (ok=${qOkCount} expected=${questionN})`);
  assert(upOkCount === upvoteN, `Upvote failures in interleaved test (ok=${upOkCount} expected=${upvoteN})`);

  const voteCaptures = await waitForAblyCaptures({
    channel: `session:${sessionId}`,
    event: 'VOTE_UPDATE',
    minCount: voteOkCount,
    filter: (c) => typeof c?.data?.sequence === 'number' && c.data.sequence > baselineVote,
  });
  const qaCaptures = await waitForAblyCaptures({
    channel: `session:${sessionId}`,
    event: 'QA_UPDATE',
    minCount: qOkCount + upOkCount,
    filter: (c) => typeof c?.data?.sequence === 'number' && c.data.sequence > baselineQa,
  });

  const voteSeq = analyzeSequenceSet({ baseline: baselineVote, sequences: voteCaptures.map((c) => c.data.sequence), label: 'T-11(VOTE_UPDATE)' });
  const qaSeq = analyzeSequenceSet({ baseline: baselineQa, sequences: qaCaptures.map((c) => c.data.sequence), label: 'T-11(QA_UPDATE)' });

  const finalVoteDb = await getSessionSequence(pool, sessionId, 'vote_sequence');
  const finalQaDb = await getSessionSequence(pool, sessionId, 'qa_sequence');
  assert(finalVoteDb === voteSeq.expectedMax, `vote_sequence mismatch (expected=${voteSeq.expectedMax} got=${finalVoteDb})`);
  assert(finalQaDb === qaSeq.expectedMax, `qa_sequence mismatch (expected=${qaSeq.expectedMax} got=${finalQaDb})`);

  await cleanupSessionArtifacts(pool, sessionId);
  await pool.end();

  log(`  ✅ Interleaved writers preserved sequence integrity (vote=${voteSeq.count} qa=${qaSeq.count})`, 'pass');
  return true;
}

async function fetchSessionState(sessionId) {
  const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/state`, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Session state fetch failed: ${res.status} ${body}`);
  }
  return res.json();
}

function applyVoteUpdate(client, voteUpdate) {
  const seq = Number(voteUpdate?.sequence);
  if (!Number.isFinite(seq)) throw new Error('applyVoteUpdate: missing sequence');
  if (seq <= client.lastVoteSequence) return;
  client.lastVoteSequence = seq;

  const slideId = voteUpdate.slideId;
  const results = voteUpdate.results || {};
  client.voteCounts = { ...client.voteCounts, [slideId]: results };
}

function applyQaUpdate(client, qaUpdate) {
  const seq = Number(qaUpdate?.sequence);
  if (!Number.isFinite(seq)) throw new Error('applyQaUpdate: missing sequence');
  if (seq <= client.lastQaSequence) return;
  client.lastQaSequence = seq;

  const questions = qaUpdate?.payload?.questions;
  if (!Array.isArray(questions)) throw new Error('applyQaUpdate: payload.questions missing');
  client.questions = questions;
}

function pickStaleCapture({ captures, snapshotSequence, readSequence, readValue }) {
  const stale = captures
    .map((c) => ({ capture: c, seq: readSequence(c) }))
    .filter((x) => Number.isFinite(x.seq) && x.seq < snapshotSequence)
    .sort((a, b) => b.seq - a.seq); // prefer "almost-latest" stale message

  for (const { capture, seq } of stale) {
    const value = readValue(capture);
    if (value === undefined) continue;
    return { capture, seq, value };
  }

  return null;
}

// Test: T-12 Subscriber Simulator (Snapshot + Delayed/Out-of-Order Messages)
async function testT12_subscriberSimulatorSnapshotRealtimeSkew() {
  log('T-12: Subscriber Simulator (Snapshot + Delayed Messages) Test', 'test');

  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl, waitForConnections: true, connectionLimit: 10 });

  const sessionId = Math.random().toString(36).substring(2, 10);
  const slideId = Math.random().toString(36).substring(2, 10);

  try {
    await cleanupSessionArtifacts(pool, sessionId);
    await pool.query(
      `INSERT INTO sessions (id, creator_id, title, status, share_token, state_version, allow_questions, require_name)
       VALUES (?, 'test-user', 'Subscriber Sim Session', 'published', 'test-token', 0, TRUE, FALSE)`,
      [sessionId]
    );

    const slideContent = JSON.stringify({
      question: "Subscriber sim poll?",
      options: [
        { id: "opt-red", text: "Red" },
        { id: "opt-blue", text: "Blue" },
        { id: "opt-green", text: "Green" },
        { id: "opt-yellow", text: "Yellow" }
      ],
      limitSubmissions: true,
      allowMultipleSelection: false
    });
    await pool.query(
      `INSERT INTO slides (id, session_id, type, content, order_index)
       VALUES (?, ?, 'poll', ?, 0)`,
      [slideId, sessionId, slideContent]
    );

    // -----------------------
    // Vote skew simulation
    // -----------------------
    await clearAblyCaptures();
    await sleep(150);

    const voteN = 15;
    for (let i = 0; i < voteN; i++) {
      const participantId = `sim-voter-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const optionId = ['opt-red', 'opt-blue', 'opt-green', 'opt-yellow'][i % 4];
      const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slideId, optionId, participantId }),
      });
      assert(res.ok, `Vote ${i} failed (status=${res.status})`);
    }

    const voteCaptures = await waitForAblyCaptures({
      channel: `session:${sessionId}`,
      event: 'VOTE_UPDATE',
      minCount: voteN,
      filter: (c) => c?.data?.slideId === slideId && typeof c?.data?.sequence === 'number',
    });

    const voteSnapshot = await fetchSessionState(sessionId);
    const snapshotVoteSeq = Number(voteSnapshot.voteSequence);
    assert(Number.isFinite(snapshotVoteSeq) && snapshotVoteSeq >= voteN, `Snapshot voteSequence invalid (voteSequence=${voteSnapshot.voteSequence})`);

    const snapshotVoteCounts = voteSnapshot.voteCounts || {};
    const snapshotSlideCounts = snapshotVoteCounts[slideId] || {};

    const staleVote = pickStaleCapture({
      captures: voteCaptures,
      snapshotSequence: snapshotVoteSeq,
      readSequence: (c) => Number(c?.data?.sequence),
      readValue: (c) => c?.data?.results,
    });
    assert(staleVote, 'Could not find a stale VOTE_UPDATE capture (sequence < snapshot)');

    const staleVoteCounts = staleVote.value || {};
    const snapshotCountsSer = stableSerialize(snapshotSlideCounts);
    const staleCountsSer = stableSerialize(staleVoteCounts);
    assert(staleCountsSer !== snapshotCountsSer, 'Stale vote results matched snapshot unexpectedly; test lost sensitivity');

    // Correct client: seeds lastVoteSequence from snapshot, must drop stale message.
    const correctVoteClient = {
      lastVoteSequence: snapshotVoteSeq,
      voteCounts: snapshotVoteCounts,
    };
    applyVoteUpdate(correctVoteClient, { ...staleVote.capture.data });
    assert(
      stableSerialize(correctVoteClient.voteCounts[slideId] || {}) === snapshotCountsSer,
      'Correct vote client regressed after applying stale VOTE_UPDATE'
    );

    // Buggy client: does NOT seed sequence; accepts stale and regresses (sensitivity check).
    const buggyVoteClient = {
      lastVoteSequence: 0,
      voteCounts: snapshotVoteCounts,
    };
    applyVoteUpdate(buggyVoteClient, { ...staleVote.capture.data });
    assert(
      stableSerialize(buggyVoteClient.voteCounts[slideId] || {}) === staleCountsSer,
      'Buggy vote client did not regress; test lost sensitivity'
    );

    log(`  ✅ Vote snapshot skew guarded (stale_seq=${staleVote.seq} snapshot_seq=${snapshotVoteSeq})`, 'pass');

    // -----------------------
    // Q&A skew simulation
    // -----------------------
    await clearAblyCaptures();
    await sleep(150);

    const qaN = 10;
    for (let i = 0; i < qaN; i++) {
      const participantId = `sim-q-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const content = `Sim question ${i} ${Math.random().toString(36).slice(2, 8)}`;
      const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, participantId }),
      });
      assert(res.ok, `Question ${i} failed (status=${res.status})`);
    }

    const qaCaptures = await waitForAblyCaptures({
      channel: `session:${sessionId}`,
      event: 'QA_UPDATE',
      minCount: qaN,
      filter: (c) => typeof c?.data?.sequence === 'number' && Array.isArray(c?.data?.payload?.questions),
    });

    const qaSnapshot = await fetchSessionState(sessionId);
    const snapshotQaSeq = Number(qaSnapshot.qaSequence);
    assert(Number.isFinite(snapshotQaSeq) && snapshotQaSeq >= qaN, `Snapshot qaSequence invalid (qaSequence=${qaSnapshot.qaSequence})`);

    const snapshotQuestionsSer = stableSerialize(qaSnapshot.questions || []);

    const staleQa = pickStaleCapture({
      captures: qaCaptures,
      snapshotSequence: snapshotQaSeq,
      readSequence: (c) => Number(c?.data?.sequence),
      readValue: (c) => c?.data?.payload?.questions,
    });
    assert(staleQa, 'Could not find a stale QA_UPDATE capture (sequence < snapshot)');

    const staleQuestionsSer = stableSerialize(staleQa.value || []);
    assert(staleQuestionsSer !== snapshotQuestionsSer, 'Stale QA questions matched snapshot unexpectedly; test lost sensitivity');

    const correctQaClient = {
      lastQaSequence: snapshotQaSeq,
      questions: qaSnapshot.questions || [],
    };
    applyQaUpdate(correctQaClient, { ...staleQa.capture.data });
    assert(
      stableSerialize(correctQaClient.questions) === snapshotQuestionsSer,
      'Correct QA client regressed after applying stale QA_UPDATE'
    );

    const buggyQaClient = {
      lastQaSequence: 0,
      questions: qaSnapshot.questions || [],
    };
    applyQaUpdate(buggyQaClient, { ...staleQa.capture.data });
    assert(
      stableSerialize(buggyQaClient.questions) === staleQuestionsSer,
      'Buggy QA client did not regress; test lost sensitivity'
    );

    log(`  ✅ QA snapshot skew guarded (stale_seq=${staleQa.seq} snapshot_seq=${snapshotQaSeq})`, 'pass');

    await cleanupSessionArtifacts(pool, sessionId);
    await pool.end();
    return true;
  } catch (e) {
    await cleanupSessionArtifacts(pool, sessionId).catch(() => {});
    await pool.end().catch(() => {});
    throw e;
  }
}

// Test: T-06 Ably Fault Injection
async function testT06_ablyFaultInjection(sessionId, slideId) {
  log('T-06: Ably Fault Injection Test', 'test');

  // Test 1: Set Ably stub to delay mode
  log('  Testing delay fault injection...', 'info');
  try {
    await fetch(`${CONFIG.ablyUrl}/admin/fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'delay', delayMs: 1000 }),
    });
  } catch (e) {
    log(`  ⚠️ Could not set delay mode: ${e.message}`, 'warn');
  }

  // Submit vote
  const participantId = `delay-test-${Math.random().toString(36).substring(2, 10)}`;
  const voteResponse = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slideId, optionId: 'opt-red', participantId }),
  });

  // Vote should succeed or return 500 (but still persist)
  if (voteResponse.ok || voteResponse.status === 500) {
    log('  ✅ Vote succeeded despite Ably delay', 'pass');
  } else {
    log('  ❌ Vote failed with Ably delay', 'fail');
    return false;
  }

  // Test 2: Set Ably stub to error mode
  log('  Testing error fault injection...', 'info');
  try {
    await fetch(`${CONFIG.ablyUrl}/admin/fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'error', errorRate: 1.0 }),
    });
  } catch (e) {
    log(`  ⚠️ Could not set error mode: ${e.message}`, 'warn');
  }

  const participantId2 = `error-test-${Math.random().toString(36).substring(2, 10)}`;
  const voteResponse2 = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slideId, optionId: 'opt-blue', participantId: participantId2 }),
  });

  if (voteResponse2.ok || voteResponse2.status === 500) {
    log('  ✅ Vote succeeded despite Ably error (graceful degradation)', 'pass');
  } else {
    log('  ❌ Vote failed with Ably error', 'fail');
    return false;
  }

  // Reset fault injection
  try {
    await fetch(`${CONFIG.ablyUrl}/admin/fault`, {
      method: 'DELETE',
    });
  } catch (e) {
    // Ignore
  }

  return true;
}

// Test: T-15 My-Votes Isolation (no cross-participant leaks under concurrency)
async function testT15_myVotesIsolationUnderConcurrency() {
  log('T-15: My-Votes Isolation (Concurrency) Test', 'test');

  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl, waitForConnections: true, connectionLimit: 10 });

  const sessionId = Math.random().toString(36).substring(2, 10);
  await cleanupSessionArtifacts(pool, sessionId);
  await pool.query(
    `INSERT INTO sessions (id, creator_id, title, status, share_token, state_version, allow_questions, require_name)
     VALUES (?, 'test-user', 'MyVotes Isolation', 'published', 'test-token', 0, TRUE, FALSE)`,
    [sessionId]
  );

  const slideId = await createPollSlideForSession(pool, sessionId, { limitSubmissions: true });

  const voters = Math.min(CONFIG.concurrency, 40);
  const nonVoters = Math.min(10, Math.max(2, Math.floor(voters / 5)));
  const options = ['opt-red', 'opt-blue', 'opt-green', 'opt-yellow'];

  const votePlan = Array.from({ length: voters }, (_, i) => i).map((i) => {
    const participantId = `iso-voter-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const optionId = options[i % options.length];
    return { participantId, optionId };
  });
  const nonVoterIds = Array.from({ length: nonVoters }, (_, i) => i).map(
    (i) => `iso-novote-${i}-${Math.random().toString(36).slice(2, 8)}`
  );

  // Submit votes concurrently.
  const voteResponses = await Promise.all(
    votePlan.map(async ({ participantId, optionId }) => {
      const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slideId, optionId, participantId }),
      });
      return { participantId, optionId, status: res.status, ok: res.ok };
    })
  );

  const voteFailures = voteResponses.filter((r) => !r.ok);
  assert(
    voteFailures.length === 0,
    `Vote submissions failed (count=${voteFailures.length} sample=${stableSerialize(voteFailures.slice(0, 3))})`
  );

  // Fetch my-votes concurrently for voters and non-voters.
  const allParticipants = [...votePlan.map((v) => v.participantId), ...nonVoterIds];
  const myVotesResponses = await Promise.all(
    allParticipants.map(async (participantId) => {
      const { res, json } = await fetchMyVotes({ sessionId, participantId });
      return { participantId, status: res.status, ok: res.ok, json };
    })
  );

  const mvFailures = myVotesResponses.filter((r) => !r.ok);
  assert(
    mvFailures.length === 0,
    `my-votes fetch failed (count=${mvFailures.length} sample=${stableSerialize(mvFailures.slice(0, 3))})`
  );

  const byPid = new Map(myVotesResponses.map((r) => [r.participantId, r.json]));
  for (const { participantId, optionId } of votePlan) {
    const body = byPid.get(participantId);
    assert(body?.success === true, `my-votes response not success=true (participantId=${participantId})`);
    assertVoteMapEquals(body?.data?.votes, { [slideId]: [optionId] }, `participantId=${participantId}`);
  }

  for (const participantId of nonVoterIds) {
    const body = byPid.get(participantId);
    assert(body?.success === true, `my-votes response not success=true (participantId=${participantId})`);
    assertVoteMapEquals(body?.data?.votes, {}, `participantId=${participantId}`);
  }

  await cleanupSessionArtifacts(pool, sessionId);
  await pool.end();
  log(`  ✅ Verified my-votes isolation for voters=${voters} nonVoters=${nonVoters}`, 'pass');
  return true;
}

// Test: T-16 My-Votes Cross-Session Isolation (prevents "previous vote" bleed)
async function testT16_myVotesCrossSessionIsolation() {
  log('T-16: My-Votes Cross-Session Isolation Test', 'test');

  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl, waitForConnections: true, connectionLimit: 10 });

  const participantId = `cross-session-${Math.random().toString(36).slice(2, 10)}`;

  const sessionA = Math.random().toString(36).substring(2, 10);
  const sessionB = Math.random().toString(36).substring(2, 10);

  await cleanupSessionArtifacts(pool, sessionA);
  await cleanupSessionArtifacts(pool, sessionB);

  await pool.query(
    `INSERT INTO sessions (id, creator_id, title, status, share_token, state_version, allow_questions, require_name)
     VALUES (?, 'test-user', 'Session A', 'published', 'test-token', 0, TRUE, FALSE)`,
    [sessionA]
  );
  await pool.query(
    `INSERT INTO sessions (id, creator_id, title, status, share_token, state_version, allow_questions, require_name)
     VALUES (?, 'test-user', 'Session B', 'published', 'test-token', 0, TRUE, FALSE)`,
    [sessionB]
  );

  const slideA = await createPollSlideForSession(pool, sessionA, { limitSubmissions: true });
  const slideB = await createPollSlideForSession(pool, sessionB, { limitSubmissions: true });

  const voteA = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionA}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slideId: slideA, optionId: 'opt-red', participantId }),
  });
  assert(voteA.ok, `Vote A failed (status=${voteA.status})`);

  const voteB = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionB}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slideId: slideB, optionId: 'opt-blue', participantId }),
  });
  assert(voteB.ok, `Vote B failed (status=${voteB.status})`);

  const { res: mvARes, json: mvA } = await fetchMyVotes({ sessionId: sessionA, participantId });
  assert(mvARes.ok, `my-votes A failed (status=${mvARes.status})`);
  assertVoteMapEquals(mvA?.data?.votes, { [slideA]: ['opt-red'] }, 'sessionA');

  const { res: mvBRes, json: mvB } = await fetchMyVotes({ sessionId: sessionB, participantId });
  assert(mvBRes.ok, `my-votes B failed (status=${mvBRes.status})`);
  assertVoteMapEquals(mvB?.data?.votes, { [slideB]: ['opt-blue'] }, 'sessionB');

  await cleanupSessionArtifacts(pool, sessionA);
  await cleanupSessionArtifacts(pool, sessionB);
  await pool.end();

  log('  ✅ Verified per-session scoping for my-votes', 'pass');
  return true;
}

// Test: T-17 Question Idempotency (x-client-request-id) under concurrency
async function testT17_questionIdempotencyClientRequestId() {
  log('T-17: Question Idempotency (X-Client-Request-Id) Test', 'test');

  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl, waitForConnections: true, connectionLimit: 10 });

  const sessionId = Math.random().toString(36).substring(2, 10);
  await cleanupSessionArtifacts(pool, sessionId);
  await pool.query(
    `INSERT INTO sessions (id, creator_id, title, status, share_token, state_version, allow_questions, require_name)
     VALUES (?, 'test-user', 'Question Idempotency', 'published', 'test-token', 0, TRUE, FALSE)`,
    [sessionId]
  );

  const channel = `session:${sessionId}`;
  const baseline = await getSessionSequence(pool, sessionId, 'qa_sequence');
  await clearAblyCaptures();
  await sleep(150);

  const participantId = `idem-q-${Math.random().toString(36).slice(2, 10)}`;
  const clientRequestId = `qreq-${Math.random().toString(36).slice(2, 18)}`;
  const concurrency = Math.min(CONFIG.concurrency, 20);

  const responses = await Promise.all(
    Array.from({ length: concurrency }, (_, i) => i).map(async () => {
      const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-client-request-id': clientRequestId },
        body: JSON.stringify({ content: 'Idempotent question', participantId }),
      });
      const json = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, json };
    })
  );

  const failures = responses.filter((r) => !r.ok);
  assert(
    failures.length === 0,
    `Question idempotency requests failed (count=${failures.length} sample=${stableSerialize(failures.slice(0, 3))})`
  );

  const questionIds = responses.map((r) => r.json?.data?.id).filter(Boolean);
  assert(questionIds.length === concurrency, `Missing question ids in responses (got=${questionIds.length} expected=${concurrency})`);

  const uniqueIds = new Set(questionIds);
  assert(uniqueIds.size === 1, `Expected all responses to return same question id, got ${stableSerialize(Array.from(uniqueIds))}`);
  const questionId = questionIds[0];

  await sleep(250);
  const [[countRow]] = await pool.query(
    'SELECT COUNT(*) as count FROM questions WHERE session_id = ? AND participant_id = ? AND client_request_id = ?',
    [sessionId, participantId, clientRequestId]
  );
  assert(Number(countRow.count) === 1, `Expected exactly 1 question row, got ${countRow.count}`);

  const finalSeq = await getSessionSequence(pool, sessionId, 'qa_sequence');
  assert(finalSeq === baseline + 1, `qa_sequence inflated on idempotent retries (baseline=${baseline} final=${finalSeq})`);

  await waitForAblyCaptures({
    channel,
    event: 'QA_UPDATE',
    minCount: 1,
    filter: (c) => typeof c?.data?.sequence === 'number' && c.data.sequence > baseline,
  });
  await sleep(250);
  const qaCaptures = await fetchAblyCaptures({ channel, event: 'QA_UPDATE' });
  const relevant = qaCaptures.filter((c) => typeof c?.data?.sequence === 'number' && c.data.sequence > baseline);
  assert(relevant.length === 1, `Expected exactly 1 QA_UPDATE publish, got ${relevant.length}`);
  assert(relevant[0].data.sequence === baseline + 1, `QA_UPDATE sequence mismatch (got=${relevant[0].data.sequence} expected=${baseline + 1})`);

  const publishedQuestions = relevant[0]?.data?.payload?.questions;
  assert(Array.isArray(publishedQuestions), 'QA_UPDATE payload.questions missing/invalid');
  assert(publishedQuestions.some((q) => q?.id === questionId), 'QA_UPDATE payload did not include created question');

  await cleanupSessionArtifacts(pool, sessionId);
  await pool.end();

  log(`  ✅ Verified question idempotency (concurrency=${concurrency})`, 'pass');
  return true;
}

// Test: T-18 Upvote Idempotency (same participant concurrent retries)
async function testT18_upvoteIdempotencySameParticipant() {
  log('T-18: Upvote Idempotency (Same Participant) Test', 'test');

  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl, waitForConnections: true, connectionLimit: 10 });

  const sessionId = Math.random().toString(36).substring(2, 10);
  await cleanupSessionArtifacts(pool, sessionId);
  await pool.query(
    `INSERT INTO sessions (id, creator_id, title, status, share_token, state_version, allow_questions, require_name)
     VALUES (?, 'test-user', 'Upvote Idempotency', 'published', 'test-token', 0, TRUE, FALSE)`,
    [sessionId]
  );

  // Seed a question (exclude from baseline).
  const seedAuthor = `seed-author-${Math.random().toString(36).slice(2, 8)}`;
  const seedRes = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Seed question for upvote idempotency', participantId: seedAuthor }),
  });
  assert(seedRes.ok, `Failed to seed question (status=${seedRes.status})`);
  const seedJson = await seedRes.json().catch(() => null);
  const questionId = seedJson?.data?.id;
  assert(typeof questionId === 'string' && questionId.length > 0, 'Seed question did not return id');

  await sleep(200);
  const channel = `session:${sessionId}`;
  const baseline = await getSessionSequence(pool, sessionId, 'qa_sequence');
  await clearAblyCaptures();
  await sleep(150);

  const participantId = `idem-upvoter-${Math.random().toString(36).slice(2, 10)}`;
  const concurrency = Math.min(CONFIG.concurrency, 15);

  const upvoteResponses = await Promise.all(
    Array.from({ length: concurrency }, (_, i) => i).map(async () => {
      const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/questions/${questionId}/upvote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantId }),
      });
      const json = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, json };
    })
  );

  const failures = upvoteResponses.filter((r) => !r.ok);
  assert(
    failures.length === 0,
    `Upvote retries failed (count=${failures.length} sample=${stableSerialize(failures.slice(0, 3))})`
  );

  const alreadyUpvotedValues = upvoteResponses.map((r) => r.json?.data?.alreadyUpvoted).filter((v) => typeof v === 'boolean');
  assert(alreadyUpvotedValues.length === concurrency, 'Missing alreadyUpvoted values in responses');
  const newUpvotes = alreadyUpvotedValues.filter((v) => v === false).length;
  assert(newUpvotes === 1, `Expected exactly 1 non-duplicate upvote, got ${newUpvotes}`);

  await sleep(250);
  const [[upvoteRow]] = await pool.query('SELECT upvotes FROM questions WHERE id = ?', [questionId]);
  assert(Number(upvoteRow.upvotes) === 1, `Question upvotes count mismatch (got=${upvoteRow.upvotes} expected=1)`);

  const [[dedupeRow]] = await pool.query(
    'SELECT COUNT(*) as count FROM question_upvotes WHERE question_id = ? AND participant_id = ?',
    [questionId, participantId]
  );
  assert(Number(dedupeRow.count) === 1, `Expected 1 question_upvotes row, got ${dedupeRow.count}`);

  const finalSeq = await getSessionSequence(pool, sessionId, 'qa_sequence');
  assert(finalSeq === baseline + 1, `qa_sequence inflated on duplicate upvotes (baseline=${baseline} final=${finalSeq})`);

  await waitForAblyCaptures({
    channel,
    event: 'QA_UPDATE',
    minCount: 1,
    filter: (c) => typeof c?.data?.sequence === 'number' && c.data.sequence > baseline,
  });
  await sleep(250);
  const qaCaptures = await fetchAblyCaptures({ channel, event: 'QA_UPDATE' });
  const relevant = qaCaptures.filter((c) => typeof c?.data?.sequence === 'number' && c.data.sequence > baseline);
  assert(relevant.length === 1, `Expected exactly 1 QA_UPDATE publish for upvote, got ${relevant.length}`);
  assert(relevant[0].data.sequence === baseline + 1, `QA_UPDATE sequence mismatch (got=${relevant[0].data.sequence} expected=${baseline + 1})`);

  await cleanupSessionArtifacts(pool, sessionId);
  await pool.end();

  log(`  ✅ Verified upvote idempotency (concurrency=${concurrency})`, 'pass');
  return true;
}

// Test: T-19 Multi-select Vote Payload (optionIds[]) correctness + limits
async function testT19_voteMultiSelectPayload() {
  log('T-19: Vote Multi-Select Payload Test', 'test');

  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl, waitForConnections: true, connectionLimit: 10 });

  const sessionId = Math.random().toString(36).substring(2, 10);
  await cleanupSessionArtifacts(pool, sessionId);
  await pool.query(
    `INSERT INTO sessions (id, creator_id, title, status, share_token, state_version, allow_questions, require_name)
     VALUES (?, 'test-user', 'Vote Multi-select', 'published', 'test-token', 0, TRUE, FALSE)`,
    [sessionId]
  );

  const channel = `session:${sessionId}`;

  // Case 1: distinct optionIds (3 options) => 3 vote rows, 1 sequence increment, 1 publish.
  {
    const slideId = await createPollSlideForSession(pool, sessionId, { limitSubmissions: true, allowMultipleSelection: true });
    const participantId = `ms-voter-${Math.random().toString(36).slice(2, 10)}`;
    const optionIds = ['opt-red', 'opt-blue', 'opt-green'];

    const baseline = await getSessionSequence(pool, sessionId, 'vote_sequence');
    await clearAblyCaptures();
    await sleep(150);

    const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slideId, optionIds, participantId }),
    });
    assert(res.ok, `Multi-select vote failed (status=${res.status})`);

    await sleep(250);

    const [[vsRow]] = await pool.query(
      'SELECT COUNT(*) as count FROM vote_submissions WHERE slide_id = ? AND participant_id = ?',
      [slideId, participantId]
    );
    assert(Number(vsRow.count) === 1, `Expected 1 vote_submissions row, got ${vsRow.count}`);

    const [voteRows] = await pool.query(
      'SELECT option_id as optionId FROM votes WHERE slide_id = ? AND participant_id = ? ORDER BY option_id ASC',
      [slideId, participantId]
    );
    const persisted = voteRows.map((r) => r.optionId);
    assert(
      stableSerialize(persisted) === stableSerialize([...optionIds].sort()),
      `Persisted optionIds mismatch (got=${stableSerialize(persisted)} expected=${stableSerialize([...optionIds].sort())})`
    );

    const finalSeq = await getSessionSequence(pool, sessionId, 'vote_sequence');
    assert(finalSeq === baseline + 1, `vote_sequence mismatch for multi-select vote (baseline=${baseline} final=${finalSeq})`);

    await waitForAblyCaptures({
      channel,
      event: 'VOTE_UPDATE',
      minCount: 1,
      filter: (c) => c?.data?.slideId === slideId && typeof c?.data?.sequence === 'number' && c.data.sequence > baseline,
    });
    await sleep(250);
    const captures = await fetchAblyCaptures({ channel, event: 'VOTE_UPDATE' });
    const relevant = captures.filter(
      (c) => c?.data?.slideId === slideId && typeof c?.data?.sequence === 'number' && c.data.sequence > baseline
    );
    assert(relevant.length === 1, `Expected exactly 1 VOTE_UPDATE publish, got ${relevant.length}`);
    assert(relevant[0].data.sequence === baseline + 1, `VOTE_UPDATE sequence mismatch (got=${relevant[0].data.sequence} expected=${baseline + 1})`);

    for (const opt of optionIds) {
      const count = Number(relevant[0]?.data?.results?.[opt] || 0);
      assert(count === 1, `VOTE_UPDATE results mismatch for ${opt} (got=${count} expected=1)`);
    }
  }

  // Case 2: duplicate optionIds in payload => unique_vote prevents double count.
  {
    const slideId = await createPollSlideForSession(pool, sessionId, { limitSubmissions: true, allowMultipleSelection: true });
    const participantId = `ms-dupe-${Math.random().toString(36).slice(2, 10)}`;
    const optionIds = ['opt-red', 'opt-red', 'opt-blue'];
    const expectedUnique = ['opt-blue', 'opt-red'];

    const baseline = await getSessionSequence(pool, sessionId, 'vote_sequence');
    await clearAblyCaptures();
    await sleep(150);

    const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slideId, optionIds, participantId }),
    });
    assert(res.ok, `Multi-select (dupe) vote failed (status=${res.status})`);

    await sleep(250);

    const [voteRows] = await pool.query(
      'SELECT option_id as optionId FROM votes WHERE slide_id = ? AND participant_id = ? ORDER BY option_id ASC',
      [slideId, participantId]
    );
    const persisted = voteRows.map((r) => r.optionId);
    assert(
      stableSerialize(persisted) === stableSerialize(expectedUnique),
      `Persisted optionIds mismatch for dupes (got=${stableSerialize(persisted)} expected=${stableSerialize(expectedUnique)})`
    );

    const finalSeq = await getSessionSequence(pool, sessionId, 'vote_sequence');
    assert(finalSeq === baseline + 1, `vote_sequence mismatch for multi-select (dupes) (baseline=${baseline} final=${finalSeq})`);

    await waitForAblyCaptures({
      channel,
      event: 'VOTE_UPDATE',
      minCount: 1,
      filter: (c) => c?.data?.slideId === slideId && typeof c?.data?.sequence === 'number' && c.data.sequence > baseline,
    });
    await sleep(250);
    const captures = await fetchAblyCaptures({ channel, event: 'VOTE_UPDATE' });
    const relevant = captures.filter(
      (c) => c?.data?.slideId === slideId && typeof c?.data?.sequence === 'number' && c.data.sequence > baseline
    );
    assert(relevant.length === 1, `Expected exactly 1 VOTE_UPDATE publish (dupes), got ${relevant.length}`);
    assert(relevant[0].data.sequence === baseline + 1, `VOTE_UPDATE sequence mismatch (dupes) (got=${relevant[0].data.sequence} expected=${baseline + 1})`);

    const red = Number(relevant[0]?.data?.results?.['opt-red'] || 0);
    const blue = Number(relevant[0]?.data?.results?.['opt-blue'] || 0);
    assert(red === 1, `VOTE_UPDATE results mismatch for opt-red (dupes) (got=${red} expected=1)`);
    assert(blue === 1, `VOTE_UPDATE results mismatch for opt-blue (dupes) (got=${blue} expected=1)`);
  }

  // Case 3: too many optionIds => 400 and no durable side effects.
  {
    const slideId = await createPollSlideForSession(pool, sessionId, { limitSubmissions: true, allowMultipleSelection: true });
    const participantId = `ms-too-many-${Math.random().toString(36).slice(2, 10)}`;
    const optionIds = Array.from({ length: 11 }, (_, i) => `opt-${i}`);

    const baseline = await getSessionSequence(pool, sessionId, 'vote_sequence');

    const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slideId, optionIds, participantId }),
    });
    assert(res.status === 400, `Expected too-many optionIds to return 400, got ${res.status}`);

    await sleep(200);
    const finalSeq = await getSessionSequence(pool, sessionId, 'vote_sequence');
    assert(finalSeq === baseline, `vote_sequence changed on rejected payload (baseline=${baseline} final=${finalSeq})`);

    const [[vsRow]] = await pool.query(
      'SELECT COUNT(*) as count FROM vote_submissions WHERE slide_id = ? AND participant_id = ?',
      [slideId, participantId]
    );
    assert(Number(vsRow.count) === 0, `vote_submissions row created for rejected payload (count=${vsRow.count})`);

    const [[voteRow]] = await pool.query(
      'SELECT COUNT(*) as count FROM votes WHERE slide_id = ? AND participant_id = ?',
      [slideId, participantId]
    );
    assert(Number(voteRow.count) === 0, `votes rows created for rejected payload (count=${voteRow.count})`);
  }

  await cleanupSessionArtifacts(pool, sessionId);
  await pool.end();

  log('  ✅ Verified multi-select vote payload semantics and limits', 'pass');
  return true;
}

// Test: T-20 Slide Create Idempotency (clientRequestId) under concurrency
async function testT20_slideCreateIdempotencyClientRequestId() {
  log('T-20: Slide Create Idempotency (clientRequestId) Test', 'test');

  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl, waitForConnections: true, connectionLimit: 10 });

  const { token, userId, email } = await registerAndLoginStaff();
  const { sessionId } = await createOwnedSessionWithSlides({ pool, creatorId: userId, slideCount: 0 });

  const clientRequestId = `slide-create-${Math.random().toString(36).slice(2, 18)}`;
  const concurrency = Math.min(CONFIG.concurrency, 15);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const body = {
    type: 'poll',
    content: {
      question: 'Idempotent create?',
      options: [
        { id: 'opt-a', text: 'A' },
        { id: 'opt-b', text: 'B' },
      ],
      limitSubmissions: true,
      allowMultipleSelection: false,
    },
    clientRequestId,
  };

  const responses = await Promise.all(
    Array.from({ length: concurrency }, (_, i) => i).map(async () => {
      const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/slides`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, json };
    })
  );

  const failures = responses.filter((r) => !r.ok);
  assert(
    failures.length === 0,
    `Slide create requests failed (count=${failures.length} sample=${stableSerialize(failures.slice(0, 3))})`
  );

  const slideIds = responses.map((r) => r.json?.data?.id).filter(Boolean);
  assert(slideIds.length === concurrency, `Missing slide ids in responses (got=${slideIds.length} expected=${concurrency})`);

  const uniqueIds = new Set(slideIds);
  assert(uniqueIds.size === 1, `Expected all create responses to return same slide id, got ${stableSerialize(Array.from(uniqueIds))}`);
  const slideId = slideIds[0];

  const [[countRow]] = await pool.query(
    'SELECT COUNT(*) as count FROM slides WHERE session_id = ? AND client_request_id = ?',
    [sessionId, clientRequestId]
  );
  assert(Number(countRow.count) === 1, `Expected exactly 1 slide row for clientRequestId, got ${countRow.count}`);

  await cleanupSessionArtifacts(pool, sessionId);
  await pool.query('DELETE FROM users WHERE id = ?', [userId]).catch(() => {});
  await pool.end();

  log(`  ✅ Verified slide create idempotency (staff=${email} concurrency=${concurrency} slideId=${slideId})`, 'pass');
  return true;
}

// Test: T-21 Slide Delete Idempotency (x-client-request-id) + misuse guard
async function testT21_slideDeleteIdempotencyClientRequestId() {
  log('T-21: Slide Delete Idempotency (X-Client-Request-Id) Test', 'test');

  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl, waitForConnections: true, connectionLimit: 10 });

  const { token, userId } = await registerAndLoginStaff();
  const { sessionId, slideIds } = await createOwnedSessionWithSlides({ pool, creatorId: userId, slideCount: 2 });
  assert(slideIds.length === 2, 'Expected 2 slides for delete-idempotency test');

  const [slideA, slideB] = slideIds;
  const requestId = `slide-del-${Math.random().toString(36).slice(2, 18)}`;
  const concurrency = Math.min(CONFIG.concurrency, 10);
  const headers = { Authorization: `Bearer ${token}`, 'x-client-request-id': requestId };

  const deleteResponses = await Promise.all(
    Array.from({ length: concurrency }, (_, i) => i).map(async () => {
      const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/slides/${slideA}`, {
        method: 'DELETE',
        headers,
      });
      const json = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, json };
    })
  );

  const failures = deleteResponses.filter((r) => !r.ok);
  assert(
    failures.length === 0,
    `Slide delete retries failed (count=${failures.length} sample=${stableSerialize(failures.slice(0, 3))})`
  );

  const [[existsRow]] = await pool.query('SELECT COUNT(*) as count FROM slides WHERE id = ? AND session_id = ?', [slideA, sessionId]);
  assert(Number(existsRow.count) === 0, 'Slide A still exists after delete');

  const [[reqRow]] = await pool.query(
    'SELECT slide_id as slideId FROM slide_delete_requests WHERE session_id = ? AND client_request_id = ? LIMIT 2',
    [sessionId, requestId]
  );
  assert(reqRow?.slideId === slideA, `slide_delete_requests mismatch (got=${reqRow?.slideId} expected=${slideA})`);

  // Guard: same request id reused for different slide must fail with 400.
  const misuseRes = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/slides/${slideB}`, {
    method: 'DELETE',
    headers,
  });
  assert(misuseRes.status === 400, `Expected delete request-id reuse to return 400, got ${misuseRes.status}`);

  await cleanupSessionArtifacts(pool, sessionId);
  await pool.query('DELETE FROM users WHERE id = ?', [userId]).catch(() => {});
  await pool.end();

  log(`  ✅ Verified slide delete idempotency + misuse guard (concurrency=${concurrency})`, 'pass');
  return true;
}

// Test: T-22 STATE_UPDATE broadcast contains final stateVersion under concurrency
async function testT22_stateUpdateBroadcastFinalStateVersion() {
  log('T-22: STATE_UPDATE Final stateVersion Broadcast Test', 'test');

  const { createPool } = await import('mysql2/promise');
  const pool = await createPool({ uri: CONFIG.databaseUrl, waitForConnections: true, connectionLimit: 10 });

  const { token, userId } = await registerAndLoginStaff();
  const concurrency = Math.min(CONFIG.concurrency, 25);
  const { sessionId, slideIds } = await createOwnedSessionWithSlides({ pool, creatorId: userId, slideCount: concurrency });
  assert(slideIds.length === concurrency, `Expected ${concurrency} slides, got ${slideIds.length}`);

  const channel = `session:${sessionId}`;
  const baseline = await getSessionSequence(pool, sessionId, 'state_version');
  await clearAblyCaptures();
  await sleep(150);

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const responses = await Promise.all(
    slideIds.map(async (slideId) => {
      const res = await fetch(`${CONFIG.baseUrl}/api/sessions/${sessionId}/current-slide`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ slideId }),
      });
      return { ok: res.ok, status: res.status };
    })
  );

  const failures = responses.filter((r) => !r.ok);
  assert(
    failures.length === 0,
    `current-slide updates failed (count=${failures.length} sample=${stableSerialize(failures.slice(0, 3))})`
  );

  const finalDb = await getSessionSequence(pool, sessionId, 'state_version');
  assert(finalDb === baseline + concurrency, `state_version mismatch (baseline=${baseline} final=${finalDb} expected=${baseline + concurrency})`);

  await waitForAblyCaptures({
    channel,
    event: 'STATE_UPDATE',
    minCount: concurrency,
    filter: (c) => typeof c?.data?.payload?.stateVersion === 'number' && c.data.payload.stateVersion > baseline,
    timeoutMs: 45000,
  });

  await sleep(250);
  const captures = await fetchAblyCaptures({ channel, event: 'STATE_UPDATE' });
  const relevant = captures.filter((c) => typeof c?.data?.payload?.stateVersion === 'number' && c.data.payload.stateVersion > baseline);
  assert(relevant.length >= concurrency, `Expected >=${concurrency} STATE_UPDATE publishes, got ${relevant.length}`);

  const stateVersions = relevant.map((c) => Number(c.data.payload.stateVersion));
  const maxCaptured = Math.max(...stateVersions);
  assert(maxCaptured === finalDb, `Final state_version not observed in publishes (maxCaptured=${maxCaptured} finalDb=${finalDb})`);

  const [[row]] = await pool.query('SELECT current_slide_id as currentSlideId FROM sessions WHERE id = ?', [sessionId]);
  const currentSlideId = row?.currentSlideId;
  assert(typeof currentSlideId === 'string' && currentSlideId.length > 0, 'Final current_slide_id missing');

  const hasFinal = relevant.some(
    (c) => Number(c?.data?.payload?.stateVersion) === finalDb && c?.data?.payload?.currentSlideId === currentSlideId
  );
  assert(hasFinal, 'Did not find a STATE_UPDATE publish matching final DB stateVersion + currentSlideId');

  await cleanupSessionArtifacts(pool, sessionId);
  await pool.query('DELETE FROM users WHERE id = ?', [userId]).catch(() => {});
  await pool.end();

  log(`  ✅ Verified final STATE_UPDATE broadcast under concurrency=${concurrency}`, 'pass');
  return true;
}

// Main test runner
async function runTests() {
  log('Starting Concurrency Test Suite', 'info');
  log(`Configuration: concurrency=${CONFIG.concurrency}, baseUrl=${CONFIG.baseUrl}, ablyUrl=${CONFIG.ablyUrl}`, 'info');
  
  let session;
  try {
    session = await createTestSession();
    const { sessionId, slideId, pool } = session;
    
    // Run tests
    const tests = [
      { name: 'T-07', fn: () => testT07_voteUpdateSequenceUniqueness(sessionId) },
      { name: 'T-08', fn: () => testT08_qaUpdateSequenceUniqueness_questions(sessionId) },
      { name: 'T-09', fn: () => testT09_qaUpdateSequenceUniqueness_upvotes(sessionId) },
      { name: 'T-13', fn: () => testT13_voteSequenceStressRounds(sessionId) },
      { name: 'T-14', fn: () => testT14_voteSequenceLimitSubmissionsFalse(sessionId) },
      { name: 'T-10', fn: () => testT10_realisticJoinDashboardVoteScenario() },
      { name: 'T-11', fn: () => testT11_interleavedWritersSequenceIntegrity() },
      { name: 'T-12', fn: () => testT12_subscriberSimulatorSnapshotRealtimeSkew() },
      { name: 'T-15', fn: () => testT15_myVotesIsolationUnderConcurrency() },
      { name: 'T-16', fn: () => testT16_myVotesCrossSessionIsolation() },
      { name: 'T-17', fn: () => testT17_questionIdempotencyClientRequestId() },
      { name: 'T-18', fn: () => testT18_upvoteIdempotencySameParticipant() },
      { name: 'T-19', fn: () => testT19_voteMultiSelectPayload() },
      { name: 'T-20', fn: () => testT20_slideCreateIdempotencyClientRequestId() },
      { name: 'T-21', fn: () => testT21_slideDeleteIdempotencyClientRequestId() },
      { name: 'T-22', fn: () => testT22_stateUpdateBroadcastFinalStateVersion() },
      { name: 'T-01', fn: () => testT01_sameParticipantVoteRace(sessionId, slideId) },
      { name: 'T-02', fn: () => testT02_burstVoteLoad(sessionId, slideId) },
      { name: 'T-03', fn: () => testT03_invalidOptionRejection(sessionId, slideId) },
      { name: 'T-06', fn: () => testT06_ablyFaultInjection(sessionId, slideId) },
    ];
    
    for (const test of tests) {
      try {
        const passed = await test.fn();
        if (passed) {
          results.passed.push(test.name);
          log(`${test.name}: PASSED`, 'pass');
        } else {
          results.failed.push(test.name);
          log(`${test.name}: FAILED`, 'fail');
        }
      } catch (error) {
        results.failed.push(test.name);
        log(`${test.name}: ERROR - ${error.message}`, 'fail');
      }
    }
    
    // Clean up
    await pool.query('DELETE FROM question_upvotes WHERE question_id IN (SELECT id FROM questions WHERE session_id = ?)', [sessionId]);
    await pool.query('DELETE FROM questions WHERE session_id = ?', [sessionId]);
    await pool.query('DELETE FROM votes WHERE session_id = ?', [sessionId]);
    await pool.query('DELETE FROM vote_submissions WHERE session_id = ?', [sessionId]).catch(() => {});
    await pool.query('DELETE FROM participants WHERE session_id = ?', [sessionId]).catch(() => {});
    await pool.query('DELETE FROM slides WHERE session_id = ?', [sessionId]);
    await pool.query('DELETE FROM sessions WHERE id = ?', [sessionId]);
    await pool.end();
    
  } catch (error) {
    log(`Test setup failed: ${error.message}`, 'fail');
    results.failed.push('SETUP');
  }
  
  // Print summary
  console.log('\n' + '='.repeat(60));
  log('TEST SUMMARY', 'info');
  console.log('='.repeat(60));
  log(`Passed: ${results.passed.length} (${results.passed.join(', ')})`, 'pass');
  log(`Failed: ${results.failed.length} (${results.failed.join(', ')})`, 'fail');
  console.log('='.repeat(60));
  
  // Exit with error code if any tests failed
  if (results.failed.length > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch(error => {
  log(`Fatal error: ${error.message}`, 'fail');
  process.exit(1);
});
