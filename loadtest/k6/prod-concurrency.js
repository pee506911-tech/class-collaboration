import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import crypto from 'k6/crypto';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const CONCURRENCY = readInt('CONCURRENCY', 100);
const QUESTION_CONCURRENCY = readInt('QUESTION_CONCURRENCY', Math.min(CONCURRENCY, 30));
const UPVOTE_CONCURRENCY = readInt('UPVOTE_CONCURRENCY', Math.min(CONCURRENCY, 40));
const STATS_POLL_COUNT = readInt('STATS_POLL_COUNT', 4);
const INSECURE_SKIP_TLS_VERIFY = readBool('INSECURE_SKIP_TLS_VERIFY', false);
const SKIP_CLEANUP = readBool('SKIP_CLEANUP', false);
const CLEANUP_DELETE_CREATOR_USER = readBool('CLEANUP_DELETE_CREATOR_USER', true);

export const options = {
  vus: 1,
  iterations: 1,
  insecureSkipTLSVerify: INSECURE_SKIP_TLS_VERIFY,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

function readInt(name, fallback) {
  const raw = __ENV[name];
  if (!raw) return fallback;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function readBool(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function randId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function jsonHeaders(extra = {}) {
  return {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...extra,
    },
  };
}

function authHeaders(token, extra = {}) {
  return jsonHeaders({
    Authorization: `Bearer ${token}`,
    ...extra,
  });
}

function parseJsonResponse(response, context) {
  try {
    return JSON.parse(response.body);
  } catch (error) {
    fail(`${context}: invalid JSON (${error.message})`);
  }
}

function unwrapApiResponse(response, context) {
  const body = parseJsonResponse(response, context);
  if (!body || body.success !== true) {
    fail(`${context}: expected success=true, got ${response.status} body=${response.body}`);
  }
  return body.data;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function expectedOpsForRole(role) {
  if (role === 'staff') return ['publish', 'subscribe', 'presence'];
  if (role === 'student' || role === 'projector') return ['subscribe', 'presence'];
  fail(`Unsupported role: ${role}`);
}

function validateAblyTokenRequest({
  tokenRequest,
  expected: { sessionId, role, participantId, keyName, keySecret, nowMs },
}) {
  const requiredKeys = ['keyName', 'ttl', 'capability', 'clientId', 'timestamp', 'nonce', 'mac'];
  for (const key of requiredKeys) {
    assert(Object.prototype.hasOwnProperty.call(tokenRequest, key), `missing ${key}`);
  }

  assert(tokenRequest.keyName === keyName, `keyName mismatch (got=${tokenRequest.keyName} expected=${keyName})`);
  assert(tokenRequest.ttl === 3600000, `ttl mismatch (got=${tokenRequest.ttl})`);
  assert(tokenRequest.clientId === participantId, `clientId mismatch (got=${tokenRequest.clientId} expected=${participantId})`);
  assert(typeof tokenRequest.timestamp === 'number', 'timestamp must be numeric');
  assert(Math.abs(tokenRequest.timestamp - nowMs) < 5 * 60 * 1000, 'timestamp skew too large');
  assert(
    typeof tokenRequest.nonce === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tokenRequest.nonce),
    `nonce is not a UUID v4 (got=${tokenRequest.nonce})`
  );
  assert(typeof tokenRequest.mac === 'string' && tokenRequest.mac.length > 0, 'mac must be a non-empty string');

  let capability;
  try {
    capability = JSON.parse(tokenRequest.capability);
  } catch (error) {
    fail(`capability is not valid JSON (${error.message})`);
  }

  const channel = `session:${sessionId}`;
  const ops = capability[channel];
  assert(Array.isArray(ops), `capability missing channel ${channel}`);
  assert(
    ops.join(',') === expectedOpsForRole(role).join(','),
    `capability ops mismatch (got=${JSON.stringify(ops)})`
  );

  const signText = `${keyName}\n${tokenRequest.ttl}\n${tokenRequest.capability}\n${tokenRequest.clientId}\n${tokenRequest.timestamp}\n${tokenRequest.nonce}\n`;
  const expectedMac = crypto.hmac('sha256', keySecret, signText, 'base64');
  assert(tokenRequest.mac === expectedMac, 'token request mac mismatch');
}

function parseAblyApiKey() {
  const raw = __ENV.ABLY_API_KEY;
  if (!raw) {
    fail('ABLY_API_KEY is required to validate token request signatures');
  }

  const parts = raw.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    fail('ABLY_API_KEY must be in keyName:keySecret format');
  }

  return { keyName: parts[0], keySecret: parts[1] };
}

function sumVoteCounts(voteCounts) {
  if (!voteCounts || typeof voteCounts !== 'object') return 0;
  return Object.values(voteCounts).reduce((total, value) => total + Number(value || 0), 0);
}

function getSlideVoteCounts(state, slideId) {
  if (!state || !state.voteCounts || typeof state.voteCounts !== 'object') return {};
  const counts = state.voteCounts[slideId];
  if (!counts || typeof counts !== 'object') return {};
  return counts;
}

function buildVoteOptionId(index) {
  return ['opt-a', 'opt-b', 'opt-c', 'opt-d'][index % 4];
}

function buildStudentParticipantId(index) {
  return `stu-${index}-${randId('p')}`;
}

function buildQuestionParticipantId(index) {
  return `q-${index}-${randId('p')}`;
}

function buildUpvoteParticipantId(index) {
  return `uv-${index}-${randId('p')}`;
}

function buildStudentName(index) {
  return `Student ${index + 1}`;
}

function statsQueryString() {
  return 'participantLimit=2000&questionLimit=2000&voteLimit=5000';
}

function createPollSlideBody() {
  return {
    type: 'poll',
    content: {
      question: 'Perf poll?',
      options: [
        { id: 'opt-a', text: 'A' },
        { id: 'opt-b', text: 'B' },
        { id: 'opt-c', text: 'C' },
        { id: 'opt-d', text: 'D' },
      ],
      limitSubmissions: true,
      allowMultipleSelection: false,
    },
    clientRequestId: randId('slide'),
  };
}

export function setup() {
  const staffEmail = `perf-${Date.now()}-${randId('staff')}@example.com`;
  const staffPassword = `Perf-${randId('password')}!Aa1`;
  const staffName = 'Perf Staff';

  const registerRes = http.post(
    `${BASE_URL}/api/auth/register`,
    JSON.stringify({
      email: staffEmail,
      password: staffPassword,
      name: staffName,
      role: 'staff',
    }),
    jsonHeaders()
  );
  assert(registerRes.status === 200, `staff registration failed (${registerRes.status})`);

  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({
      email: staffEmail,
      password: staffPassword,
    }),
    jsonHeaders()
  );
  assert(loginRes.status === 200, `staff login failed (${loginRes.status})`);
  const loginBody = parseJsonResponse(loginRes, 'staff login');
  const staffToken = loginBody.token;
  assert(typeof staffToken === 'string' && staffToken.length > 0, 'staff token missing from login response');

  const sessionRes = http.post(
    `${BASE_URL}/api/sessions`,
    JSON.stringify({
      title: `Perf session ${randId('session')}`,
      allowQuestions: true,
      requireName: false,
    }),
    authHeaders(staffToken)
  );
  const session = unwrapApiResponse(sessionRes, 'create session');
  const sessionId = session.id;
  assert(typeof sessionId === 'string' && sessionId.length > 0, 'session id missing');

  const slideIds = [];
  for (let i = 0; i < 2; i++) {
    const slideRes = http.post(
      `${BASE_URL}/api/sessions/${sessionId}/slides`,
      JSON.stringify(createPollSlideBody()),
      authHeaders(staffToken)
    );
    const slide = unwrapApiResponse(slideRes, `create slide ${i + 1}`);
    slideIds.push(slide.id);
  }

  const seedQuestionParticipantId = buildQuestionParticipantId(0);
  const seedQuestionRes = http.post(
    `${BASE_URL}/api/sessions/${sessionId}/questions`,
    JSON.stringify({
      content: 'Seed question for perf testing',
      participantId: seedQuestionParticipantId,
      slideId: slideIds[0],
    }),
    jsonHeaders({
      'x-client-request-id': randId('question-seed'),
    })
  );
  const seedQuestion = unwrapApiResponse(seedQuestionRes, 'seed question');

  const stateRes = http.get(`${BASE_URL}/api/sessions/${sessionId}/state`);
  assert(stateRes.status === 200, `initial state fetch failed (${stateRes.status})`);
  const state = parseJsonResponse(stateRes, 'initial state');

  const statsRes = http.get(`${BASE_URL}/api/sessions/${sessionId}/stats?${statsQueryString()}`, authHeaders(staffToken));
  assert(statsRes.status === 200, `initial stats fetch failed (${statsRes.status})`);
  const statsBody = parseJsonResponse(statsRes, 'initial stats');
  assert(Array.isArray(statsBody.participants), 'initial stats response missing participants array');
  assert(Array.isArray(statsBody.slides), 'initial stats response missing slides array');
  assert(Array.isArray(statsBody.questions), 'initial stats response missing questions array');

  return {
    baseUrl: BASE_URL,
    staffToken,
    staffEmail,
    sessionId,
    slideIds,
    seedQuestionId: seedQuestion.id,
    baselineVoteSequence: Number(state.voteSequence || 0),
    baselineQaSequence: Number(state.qaSequence || 0),
  };
}

export default function (data) {
  const sessionId = data.sessionId;
  const staffToken = data.staffToken;
  const voteSlideId = data.slideIds[0];
  const controlSlideId = data.slideIds[1];
  const { keyName, keySecret } = parseAblyApiKey();

  const studentCount = CONCURRENCY;
  const questionCount = QUESTION_CONCURRENCY;
  const upvoteCount = UPVOTE_CONCURRENCY;

  const studentParticipants = Array.from({ length: studentCount }, (_, index) => buildStudentParticipantId(index));
  const questionParticipants = Array.from({ length: questionCount }, (_, index) => buildQuestionParticipantId(index + 1));
  const upvoteParticipants = Array.from({ length: upvoteCount }, (_, index) => buildUpvoteParticipantId(index));

  const authRequests = studentParticipants.map((participantId) => ({
    method: 'GET',
    url: `${BASE_URL}/api/auth/ably?sessionId=${encodeURIComponent(sessionId)}&role=student&participantId=${encodeURIComponent(participantId)}`,
    params: { headers: { Accept: 'application/json' } },
  }));

  const registerRequests = studentParticipants.map((participantId, index) => ({
    method: 'POST',
    url: `${BASE_URL}/api/sessions/${sessionId}/register-participant`,
    body: JSON.stringify({
      participantId,
      name: buildStudentName(index),
    }),
    params: jsonHeaders(),
  }));

  const staffRequests = [
    {
      method: 'POST',
      url: `${BASE_URL}/api/sessions/${sessionId}/go-live`,
      params: authHeaders(staffToken),
    },
    {
      method: 'PUT',
      url: `${BASE_URL}/api/sessions/${sessionId}/current-slide`,
      body: JSON.stringify({ slideId: voteSlideId }),
      params: authHeaders(staffToken),
    },
    {
      method: 'PUT',
      url: `${BASE_URL}/api/sessions/${sessionId}/results-visibility`,
      body: JSON.stringify({ visible: true }),
      params: authHeaders(staffToken),
    },
    ...Array.from({ length: STATS_POLL_COUNT }, () => ({
      method: 'GET',
      url: `${BASE_URL}/api/sessions/${sessionId}/stats?${statsQueryString()}`,
      params: authHeaders(staffToken),
    })),
    {
      method: 'GET',
      url: `${BASE_URL}/api/sessions/public/${sessionId}/stats?${statsQueryString()}`,
      params: { headers: { Accept: 'application/json' } },
    },
  ];

  const voteRequests = studentParticipants.map((participantId, index) => ({
    method: 'POST',
    url: `${BASE_URL}/api/sessions/${sessionId}/vote`,
    body: JSON.stringify({
      slideId: voteSlideId,
      optionId: buildVoteOptionId(index),
      participantId,
    }),
    params: jsonHeaders(),
  }));

  const questionRequests = questionParticipants.map((participantId, index) => ({
    method: 'POST',
    url: `${BASE_URL}/api/sessions/${sessionId}/questions`,
    body: JSON.stringify({
      content: `Perf question ${index + 1}`,
      participantId,
      slideId: controlSlideId,
    }),
    params: jsonHeaders({
      'x-client-request-id': randId(`question-${index}`),
    }),
  }));

  const upvoteRequests = upvoteParticipants.map((participantId) => ({
    method: 'POST',
    url: `${BASE_URL}/api/sessions/${sessionId}/questions/${data.seedQuestionId}/upvote`,
    body: JSON.stringify({ participantId }),
    params: jsonHeaders(),
  }));

  const batch = [
    ...authRequests,
    ...registerRequests,
    ...staffRequests,
    ...voteRequests,
    ...questionRequests,
    ...upvoteRequests,
  ];

  const start = Date.now();
  const responses = http.batch(batch);
  const elapsedMs = Date.now() - start;

  let index = 0;

  let authSuccessCount = 0;
  const authFailureSamples = [];
  for (let i = 0; i < authRequests.length; i++, index++) {
    const response = responses[index];
    if (response.status !== 200) {
      if (authFailureSamples.length < 5) authFailureSamples.push(`status=${response.status} body=${response.body}`);
      continue;
    }

    const tokenRequest = parseJsonResponse(response, `auth response ${i + 1}`);
    try {
      validateAblyTokenRequest({
        tokenRequest,
        expected: {
          sessionId,
          role: 'student',
          participantId: studentParticipants[i],
          keyName,
          keySecret,
          nowMs: Date.now(),
        },
      });
      authSuccessCount += 1;
    } catch (error) {
      if (authFailureSamples.length < 5) authFailureSamples.push(String(error.message || error));
    }
  }

  let registerSuccessCount = 0;
  for (let i = 0; i < registerRequests.length; i++, index++) {
    const response = responses[index];
    if (response.status >= 200 && response.status < 300) {
      registerSuccessCount += 1;
    }
  }

  let staffSuccessCount = 0;
  for (let i = 0; i < staffRequests.length; i++, index++) {
    const response = responses[index];
    if (response.status >= 200 && response.status < 300) {
      staffSuccessCount += 1;
    }
  }

  let voteSuccessCount = 0;
  for (let i = 0; i < voteRequests.length; i++, index++) {
    const response = responses[index];
    if (response.status >= 200 && response.status < 300) {
      voteSuccessCount += 1;
    }
  }

  let questionSuccessCount = 0;
  for (let i = 0; i < questionRequests.length; i++, index++) {
    const response = responses[index];
    if (response.status >= 200 && response.status < 300) {
      questionSuccessCount += 1;
    }
  }

  let upvoteSuccessCount = 0;
  for (let i = 0; i < upvoteRequests.length; i++, index++) {
    const response = responses[index];
    if (response.status >= 200 && response.status < 300) {
      upvoteSuccessCount += 1;
    }
  }

  assert(authSuccessCount === authRequests.length, `auth burst failures (ok=${authSuccessCount} expected=${authRequests.length})`);
  assert(registerSuccessCount === registerRequests.length, `participant registration failures (ok=${registerSuccessCount} expected=${registerRequests.length})`);
  assert(staffSuccessCount === staffRequests.length, `staff dashboard failures (ok=${staffSuccessCount} expected=${staffRequests.length})`);
  assert(voteSuccessCount === voteRequests.length, `vote burst failures (ok=${voteSuccessCount} expected=${voteRequests.length})`);
  assert(questionSuccessCount === questionRequests.length, `question burst failures (ok=${questionSuccessCount} expected=${questionRequests.length})`);
  assert(upvoteSuccessCount === upvoteRequests.length, `upvote burst failures (ok=${upvoteSuccessCount} expected=${upvoteRequests.length})`);

  if (authFailureSamples.length > 0) {
    fail(`Ably auth validation failures: ${authFailureSamples.join(' | ')}`);
  }

  sleep(1.2);

  const finalStateRes = http.get(`${BASE_URL}/api/sessions/${sessionId}/state`);
  assert(finalStateRes.status === 200, `final state fetch failed (${finalStateRes.status})`);
  const finalState = parseJsonResponse(finalStateRes, 'final state');

  const finalStatsRes = http.get(`${BASE_URL}/api/sessions/${sessionId}/stats?${statsQueryString()}`, authHeaders(staffToken));
  assert(finalStatsRes.status === 200, `final stats fetch failed (${finalStatsRes.status})`);
  const finalStats = parseJsonResponse(finalStatsRes, 'final stats');
  assert(Array.isArray(finalStats.participants), 'final stats response missing participants array');
  assert(Array.isArray(finalStats.slides), 'final stats response missing slides array');
  assert(Array.isArray(finalStats.questions), 'final stats response missing questions array');

  const publicStatsRes = http.get(`${BASE_URL}/api/sessions/public/${sessionId}/stats?${statsQueryString()}`);
  assert(publicStatsRes.status === 200, `public stats fetch failed (${publicStatsRes.status})`);
  const publicStats = parseJsonResponse(publicStatsRes, 'public stats');
  assert(Array.isArray(publicStats.participants), 'public stats response missing participants array');
  assert(Array.isArray(publicStats.slides), 'public stats response missing slides array');
  assert(Array.isArray(publicStats.questions), 'public stats response missing questions array');

  const myVotesRes = http.get(
    `${BASE_URL}/api/sessions/${sessionId}/my-votes?participantId=${encodeURIComponent(studentParticipants[0])}`
  );
  assert(myVotesRes.status === 200, `my-votes fetch failed (${myVotesRes.status})`);
  const myVotes = parseJsonResponse(myVotesRes, 'my-votes');
  assert(myVotes.success === true, 'my-votes response not successful');

  const voteCounts = getSlideVoteCounts(finalState, voteSlideId);
  const voteCountTotal = sumVoteCounts(voteCounts);
  const expectedVoteSequence = data.baselineVoteSequence + voteSuccessCount;
  const expectedQaSequence = data.baselineQaSequence + questionSuccessCount + upvoteSuccessCount;

  assert(finalState.voteSequence === expectedVoteSequence, `vote_sequence mismatch (expected=${expectedVoteSequence} got=${finalState.voteSequence})`);
  assert(finalState.qaSequence === expectedQaSequence, `qa_sequence mismatch (expected=${expectedQaSequence} got=${finalState.qaSequence})`);
  assert(finalState.isPresentationActive === true, 'session should be live after go-live');
  assert(finalState.isResultsVisible === true, 'results visibility should be true');
  assert(finalState.currentSlideId === voteSlideId, `current slide mismatch (expected=${voteSlideId} got=${finalState.currentSlideId})`);
  assert(voteCountTotal === voteSuccessCount, `vote count mismatch (expected=${voteSuccessCount} got=${voteCountTotal})`);
  assert(Array.isArray(finalState.slides) && finalState.slides.length === data.slideIds.length, `slide count mismatch (expected=${data.slideIds.length} got=${finalState.slides?.length})`);
  assert(Array.isArray(finalState.questions) && finalState.questions.length === 1 + questionSuccessCount, `question count mismatch (expected=${1 + questionSuccessCount} got=${finalState.questions?.length})`);
  assert(finalStats.participants.length === registerSuccessCount, `participant count mismatch (expected=${registerSuccessCount} got=${finalStats.participants.length})`);
  assert(finalStats.slides.length === data.slideIds.length, `stats slide count mismatch (expected=${data.slideIds.length} got=${finalStats.slides.length})`);
  assert(finalStats.questions.length === 1 + questionSuccessCount, `stats question count mismatch (expected=${1 + questionSuccessCount} got=${finalStats.questions.length})`);
  assert(publicStats.participants.length === registerSuccessCount, `public stats participant count mismatch`);
  assert(publicStats.slides.length === data.slideIds.length, `public stats slide count mismatch`);
  assert(publicStats.questions.length === 1 + questionSuccessCount, `public stats question count mismatch`);

  const voteOptions = myVotes.data?.votes?.[voteSlideId];
  assert(Array.isArray(voteOptions), 'my-votes response missing vote array');
  assert(voteOptions.includes(buildVoteOptionId(0)), `my-votes missing expected option (got=${JSON.stringify(voteOptions)})`);

  console.log(
    JSON.stringify({
      scenario: 'prod-concurrency',
      phase: 'run',
      status: 'ok',
      elapsedMs,
      authSuccessCount,
      registerSuccessCount,
      staffSuccessCount,
      voteSuccessCount,
      questionSuccessCount,
      upvoteSuccessCount,
      voteSequence: finalState.voteSequence,
      qaSequence: finalState.qaSequence,
      participants: finalStats.participants.length,
      questions: finalStats.questions.length,
      slides: finalStats.slides.length,
    })
  );
}

export function teardown(data) {
  if (SKIP_CLEANUP) {
    console.log(JSON.stringify({ scenario: 'prod-concurrency', phase: 'cleanup', status: 'skipped' }));
    return;
  }

  const cleanupRes = http.del(
    `${BASE_URL}/api/internal/perf/sessions/${data.sessionId}?deleteCreatorUser=${CLEANUP_DELETE_CREATOR_USER ? 'true' : 'false'}`,
    null,
    {
      headers: {
        'x-perf-test-token': __ENV.PERF_TEST_TOKEN || '',
        Accept: 'application/json',
      },
    }
  );

  assert(cleanupRes.status === 200, `cleanup failed (${cleanupRes.status}) body=${cleanupRes.body}`);
  const cleanupBody = parseJsonResponse(cleanupRes, 'cleanup');
  assert(cleanupBody.success === true, 'cleanup response not successful');

  console.log(
    JSON.stringify({
      scenario: 'prod-concurrency',
      phase: 'cleanup',
      status: 'ok',
      cleanup: 'ok',
      deletedCreatorUser: cleanupBody.data?.deletedCreatorUser,
    })
  );
}
