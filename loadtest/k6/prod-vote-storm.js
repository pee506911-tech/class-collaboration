import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import exec from 'k6/execution';
import encoding from 'k6/encoding';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const CONCURRENCY = readInt('CONCURRENCY', 100);
const INSECURE_SKIP_TLS_VERIFY = readBool('INSECURE_SKIP_TLS_VERIFY', false);
const SKIP_CLEANUP = readBool('SKIP_CLEANUP', false);
const CLEANUP_DELETE_CREATOR_USER = readBool('CLEANUP_DELETE_CREATOR_USER', true);

const SETTLE_AFTER_SETUP_SECONDS = readInt('SETTLE_AFTER_SETUP_SECONDS', 8);
const VOTE_START_SECONDS = readInt('VOTE_START_SECONDS', SETTLE_AFTER_SETUP_SECONDS + 4);
const VERIFY_START_SECONDS = readInt('VERIFY_START_SECONDS', VOTE_START_SECONDS + 8);
const VERIFY_POLL_ATTEMPTS = readInt('VERIFY_POLL_ATTEMPTS', 12);
const VERIFY_POLL_INTERVAL_SECONDS = readInt('VERIFY_POLL_INTERVAL_SECONDS', 2);
const VOTE_SUCCESS_SAMPLE_LIMIT = readInt('VOTE_SUCCESS_SAMPLE_LIMIT', 5);
const MY_VOTES_SAMPLE_COUNT = readInt('MY_VOTES_SAMPLE_COUNT', 3);
const SETUP_STATE_POLL_ATTEMPTS = readInt('SETUP_STATE_POLL_ATTEMPTS', 10);
const SETUP_STATE_POLL_INTERVAL_SECONDS = readInt('SETUP_STATE_POLL_INTERVAL_SECONDS', 2);

export const options = {
  insecureSkipTLSVerify: INSECURE_SKIP_TLS_VERIFY,
  scenarios: {
    student_join: {
      executor: 'per-vu-iterations',
      exec: 'studentJoin',
      vus: CONCURRENCY,
      iterations: 1,
      maxDuration: '2m',
      gracefulStop: '10s',
      tags: { phase: 'join' },
    },
    student_vote: {
      executor: 'per-vu-iterations',
      exec: 'studentVote',
      vus: CONCURRENCY,
      iterations: 1,
      startTime: `${VOTE_START_SECONDS}s`,
      maxDuration: '2m',
      gracefulStop: '10s',
      tags: { phase: 'vote' },
    },
    verify_results: {
      executor: 'shared-iterations',
      exec: 'verifyResults',
      vus: 1,
      iterations: 1,
      startTime: `${VERIFY_START_SECONDS}s`,
      maxDuration: '1m',
      tags: { phase: 'verify' },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    'http_req_duration{phase:join}': ['p(95)<3000', 'max<10000'],
    'http_req_duration{phase:vote}': ['p(95)<3000', 'max<10000'],
    'http_req_duration{phase:verify}': ['p(95)<3000', 'max<10000'],
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

function assert(condition, message) {
  if (!condition) fail(message);
}

function parseJsonResponse(response, context) {
  try {
    return JSON.parse(response.body);
  } catch (error) {
    fail(`${context}: invalid JSON (${error.message}) body=${response.body}`);
  }
}

function unwrapApiResponse(response, context) {
  const body = parseJsonResponse(response, context);
  if (!body || body.success !== true) {
    fail(`${context}: expected success=true, got status=${response.status} body=${response.body}`);
  }
  return body.data;
}

function buildStudentIndex() {
  return exec.scenario.iterationInTest + 1;
}

function buildParticipantId(index) {
  return `stu-${index}`;
}

function buildStudentName(index) {
  return `Student ${index}`;
}

function buildOptionId(index) {
  return `opt-${index}`;
}

function buildVoteClientRequestId(sessionId, participantId, optionId) {
  return `vote:${sessionId}:${participantId}:${optionId}`;
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
      question: `Prod vote storm (${CONCURRENCY} students)`,
      options,
      limitSubmissions: true,
      allowMultipleSelection: false,
    },
    clientRequestId: randId('slide'),
  };
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  assert(parts.length === 3, `jwt must have 3 segments (got=${parts.length})`);
  const decoded = encoding.b64decode(parts[1], 'rawurl', 's');
  try {
    return JSON.parse(decoded);
  } catch (error) {
    fail(`jwt payload is not valid JSON (${error.message})`);
  }
}

function validateWsJwt(token, expected) {
  const payload = decodeJwtPayload(token);
  assert(payload.role === expected.role, `ws token role mismatch (expected=${expected.role} got=${payload.role})`);
  assert(
    payload.sessionId === expected.sessionId,
    `ws token sessionId mismatch (expected=${expected.sessionId} got=${payload.sessionId})`
  );
  assert(
    payload.participantId === expected.participantId,
    `ws token participantId mismatch (expected=${expected.participantId} got=${payload.participantId})`
  );
  assert(typeof payload.userId === 'string' && payload.userId.length > 0, 'ws token userId missing');
  assert(typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000), 'ws token exp invalid');
}

function sumVoteCounts(voteCounts) {
  return Object.values(voteCounts || {}).reduce((total, count) => total + Number(count || 0), 0);
}

function countUniqueHitOptions(voteCounts) {
  return Object.values(voteCounts || {}).filter((count) => Number(count || 0) > 0).length;
}

function getSlideVoteCounts(state, slideId) {
  if (!state || !state.voteCounts || typeof state.voteCounts !== 'object') return {};
  const counts = state.voteCounts[slideId];
  if (!counts || typeof counts !== 'object') return {};
  return counts;
}

function statsQueryString() {
  return `participantLimit=${CONCURRENCY + 50}&questionLimit=50&voteLimit=${CONCURRENCY + 50}`;
}

function findSlideById(state, slideId) {
  const slides = Array.isArray(state?.slides) ? state.slides : [];
  return slides.find((candidate) => candidate.id === slideId) || null;
}

function fetchVerificationSnapshot(data) {
  const finalStateRes = http.get(`${BASE_URL}/api/sessions/${data.sessionId}/state`);
  assert(finalStateRes.status === 200, `final state fetch failed (${finalStateRes.status})`);
  const finalState = parseJsonResponse(finalStateRes, 'final state');

  const finalStatsRes = http.get(
    `${BASE_URL}/api/sessions/${data.sessionId}/stats?${statsQueryString()}`,
    authHeaders(data.staffToken)
  );
  assert(finalStatsRes.status === 200, `final stats fetch failed (${finalStatsRes.status})`);
  const finalStats = parseJsonResponse(finalStatsRes, 'final stats');

  const voteCounts = getSlideVoteCounts(finalState, data.slideId);
  const targetSlideStats = Array.isArray(finalStats.slides)
    ? finalStats.slides.find((slide) => slide.id === data.slideId) || null
    : null;
  const statsVoteCounts = targetSlideStats && targetSlideStats.votes ? targetSlideStats.votes : {};
  const statsInteractions = Array.isArray(targetSlideStats?.interactions)
    ? targetSlideStats.interactions
    : [];
  const expectedVoteSequence = data.baselineVoteSequence + CONCURRENCY;
  const observedVoteSequence = Number(finalState.voteSequence || 0);
  const totalVotes = sumVoteCounts(voteCounts);
  const uniqueOptionsHit = countUniqueHitOptions(voteCounts);
  const statsTotalVotes = sumVoteCounts(statsVoteCounts);
  const statsUniqueOptionsHit = countUniqueHitOptions(statsVoteCounts);
  const participantCount = Array.isArray(finalStats.participants) ? finalStats.participants.length : 0;
  const myVotesSamples = [];

  for (let index = 1; index <= Math.min(MY_VOTES_SAMPLE_COUNT, CONCURRENCY); index += 1) {
    const participantId = buildParticipantId(index);
    const myVotesRes = http.get(
      `${BASE_URL}/api/sessions/${data.sessionId}/my-votes?participantId=${encodeURIComponent(participantId)}`
    );
    assert(myVotesRes.status === 200, `my-votes fetch failed for ${participantId} (${myVotesRes.status})`);
    const myVotesBody = parseJsonResponse(myVotesRes, `my-votes ${participantId}`);
    myVotesSamples.push({
      participantId,
      success: myVotesBody.success === true,
      votesForSlide: myVotesBody.data?.votes?.[data.slideId] || [],
    });
  }

  return {
    finalState,
    finalStats,
    voteCounts,
    statsVoteCounts,
    statsInteractions,
    expectedVoteSequence,
    observedVoteSequence,
    totalVotes,
    uniqueOptionsHit,
    statsTotalVotes,
    statsUniqueOptionsHit,
    participantCount,
    myVotesSamples,
  };
}

export function setup() {
  const unique = randId('vote-storm');
  const staffEmail = `perf-${unique}@example.com`;
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
      title: `Prod vote storm ${unique}`,
      allowQuestions: false,
      requireName: false,
    }),
    authHeaders(staffToken)
  );
  const session = unwrapApiResponse(sessionRes, 'create session');
  const sessionId = session.id;
  assert(typeof sessionId === 'string' && sessionId.length > 0, 'session id missing');

  const slideRes = http.post(
    `${BASE_URL}/api/sessions/${sessionId}/slides`,
    JSON.stringify(createPollSlideBody()),
    authHeaders(staffToken)
  );
  const slide = unwrapApiResponse(slideRes, 'create poll slide');
  const slideId = slide.id;
  assert(typeof slideId === 'string' && slideId.length > 0, 'slide id missing');

  const stateRes = http.get(`${BASE_URL}/api/sessions/${sessionId}/state`);
  assert(stateRes.status === 200, `initial state fetch failed (${stateRes.status})`);
  const state = parseJsonResponse(stateRes, 'initial state');

  let setupSlideFound = Boolean(findSlideById(state, slideId));
  let setupStateBodySample = String(stateRes.body || '').slice(0, 800);

  if (!setupSlideFound) {
    for (let attempt = 1; attempt <= SETUP_STATE_POLL_ATTEMPTS; attempt += 1) {
      sleep(SETUP_STATE_POLL_INTERVAL_SECONDS);
      const pollStateRes = http.get(`${BASE_URL}/api/sessions/${sessionId}/state`);
      assert(pollStateRes.status === 200, `setup poll state fetch failed (${pollStateRes.status})`);
      const pollState = parseJsonResponse(pollStateRes, `setup poll state ${attempt}`);
      setupStateBodySample = String(pollStateRes.body || '').slice(0, 800);

      if (findSlideById(pollState, slideId)) {
        setupSlideFound = true;
        break;
      }
    }
  }

  if (!setupSlideFound) {
    console.log(
      JSON.stringify({
        scenario: 'prod-vote-storm',
        phase: 'setup-slide-missing',
        status: 'failed',
        sessionId,
        slideId,
        createSlideResponse: String(slideRes.body || '').slice(0, 800),
        stateBodySample: setupStateBodySample,
      })
    );
  }

  assert(setupSlideFound, `setup state does not include created slide ${slideId}`);

  if (SETTLE_AFTER_SETUP_SECONDS > 0) {
    sleep(SETTLE_AFTER_SETUP_SECONDS);
  }

  const currentSlideRes = http.put(
    `${BASE_URL}/api/sessions/${sessionId}/current-slide`,
    JSON.stringify({ slideId }),
    authHeaders(staffToken)
  );
  assert(currentSlideRes.status >= 200 && currentSlideRes.status < 300, `set current slide failed (${currentSlideRes.status}) body=${currentSlideRes.body}`);

  const resultsVisibleRes = http.put(
    `${BASE_URL}/api/sessions/${sessionId}/results-visibility`,
    JSON.stringify({ visible: true }),
    authHeaders(staffToken)
  );
  assert(
    resultsVisibleRes.status >= 200 && resultsVisibleRes.status < 300,
    `set results visibility failed (${resultsVisibleRes.status})`
  );

  const goLiveRes = http.post(`${BASE_URL}/api/sessions/${sessionId}/go-live`, null, authHeaders(staffToken));
  assert(goLiveRes.status >= 200 && goLiveRes.status < 300, `go-live failed (${goLiveRes.status})`);

  const settledStateRes = http.get(`${BASE_URL}/api/sessions/${sessionId}/state`);
  assert(settledStateRes.status === 200, `settled state fetch failed (${settledStateRes.status})`);
  const settledState = parseJsonResponse(settledStateRes, 'settled state');
  const settledSlideFound = Boolean(findSlideById(settledState, slideId));
  if (!settledSlideFound) {
    console.log(
      JSON.stringify({
        scenario: 'prod-vote-storm',
        phase: 'settled-slide-missing',
        status: 'failed',
        sessionId,
        slideId,
        createSlideResponse: String(slideRes.body || '').slice(0, 800),
        settledStateBodySample: String(settledStateRes.body || '').slice(0, 800),
      })
    );
  }
  assert(settledSlideFound, `settled state does not include created slide ${slideId}`);

  console.log(
    JSON.stringify({
      scenario: 'prod-vote-storm',
      phase: 'setup',
      status: 'ok',
      sessionId,
      slideId,
      settleAfterSetupSeconds: SETTLE_AFTER_SETUP_SECONDS,
      slideVisibleInInitialState: true,
      slideVisibleAfterSettle: true,
    })
  );

  return {
    baseUrl: BASE_URL,
    staffToken,
    staffEmail,
    sessionId,
    slideId,
    baselineVoteSequence: Number(state.voteSequence || 0),
  };
}

export function studentJoin(data) {
  const index = buildStudentIndex();
  const participantId = buildParticipantId(index);

  const tokenRes = http.get(
    `${BASE_URL}/api/auth/ws-token?sessionId=${encodeURIComponent(data.sessionId)}&role=student&participantId=${encodeURIComponent(participantId)}`,
    { headers: { Accept: 'application/json' }, tags: { endpoint: 'ws_token' } }
  );

  check(tokenRes, {
    'ws token status is 200': (response) => response.status === 200,
  });

  const tokenBody = parseJsonResponse(tokenRes, `ws token ${participantId}`);
  check(tokenBody, {
    'ws token response includes token': (body) => typeof body.token === 'string' && body.token.length > 0,
  });
  validateWsJwt(tokenBody.token, {
    role: 'student',
    sessionId: data.sessionId,
    participantId,
  });

  const registerRes = http.post(
    `${BASE_URL}/api/sessions/${data.sessionId}/register-participant`,
    JSON.stringify({
      participantId,
      name: buildStudentName(index),
    }),
    jsonHeaders()
  );

  check(registerRes, {
    'register participant succeeded': (response) => response.status >= 200 && response.status < 300,
  });
}

export function studentVote(data) {
  const index = buildStudentIndex();
  const participantId = buildParticipantId(index);
  const optionId = buildOptionId(index);
  const clientRequestId = buildVoteClientRequestId(data.sessionId, participantId, optionId);

  const voteRes = http.post(
    `${BASE_URL}/api/sessions/${data.sessionId}/vote`,
    JSON.stringify({
      slideId: data.slideId,
      optionId,
      participantId,
    }),
    jsonHeaders({
      'x-client-request-id': clientRequestId,
    })
  );

  if (!(voteRes.status >= 200 && voteRes.status < 300)) {
    console.log(
      JSON.stringify({
        scenario: 'prod-vote-storm',
        phase: 'vote-failure',
        clientRequestId,
        index,
        participantId,
        optionId,
        status: voteRes.status,
        body: String(voteRes.body || '').slice(0, 400),
      })
    );
  } else if (index <= VOTE_SUCCESS_SAMPLE_LIMIT) {
    console.log(
      JSON.stringify({
        scenario: 'prod-vote-storm',
        phase: 'vote-success',
        clientRequestId,
        index,
        participantId,
        optionId,
        status: voteRes.status,
        body: String(voteRes.body || '').slice(0, 400),
      })
    );
  }

  check(voteRes, {
    'vote submission succeeded': (response) => response.status >= 200 && response.status < 300,
  });
}

export function verifyResults(data) {
  let snapshot = null;
  for (let attempt = 1; attempt <= VERIFY_POLL_ATTEMPTS; attempt += 1) {
    snapshot = fetchVerificationSnapshot(data);

    const converged =
      snapshot.totalVotes === CONCURRENCY &&
      snapshot.uniqueOptionsHit === CONCURRENCY &&
      snapshot.statsTotalVotes === CONCURRENCY &&
      snapshot.statsUniqueOptionsHit === CONCURRENCY &&
      snapshot.participantCount === CONCURRENCY;

    console.log(
      JSON.stringify({
        scenario: 'prod-vote-storm',
        phase: 'verify-poll',
        attempt,
        totalVotes: snapshot.totalVotes,
        uniqueOptionsHit: snapshot.uniqueOptionsHit,
        statsTotalVotes: snapshot.statsTotalVotes,
        statsUniqueOptionsHit: snapshot.statsUniqueOptionsHit,
        statsInteractionCount: snapshot.statsInteractions.length,
        statsInteractionSamples: snapshot.statsInteractions.slice(0, 5),
        participantCount: snapshot.participantCount,
        expectedVoteSequence: snapshot.expectedVoteSequence,
        observedVoteSequence: snapshot.observedVoteSequence,
        voteSequenceMatched: snapshot.observedVoteSequence === snapshot.expectedVoteSequence,
        myVotesSamples: snapshot.myVotesSamples,
      })
    );

    if (converged) break;
    if (attempt < VERIFY_POLL_ATTEMPTS) sleep(VERIFY_POLL_INTERVAL_SECONDS);
  }

  assert(snapshot, 'verification snapshot missing');

  const {
    finalState,
    voteCounts,
    statsVoteCounts,
    statsInteractions,
    expectedVoteSequence,
    observedVoteSequence,
    totalVotes,
    uniqueOptionsHit,
    statsTotalVotes,
    statsUniqueOptionsHit,
    participantCount,
    myVotesSamples,
  } = snapshot;

  assert(finalState.isPresentationActive === true, 'session should still be live');
  assert(finalState.isResultsVisible === true, 'results visibility should still be true');
  assert(finalState.currentSlideId === data.slideId, `current slide mismatch (expected=${data.slideId} got=${finalState.currentSlideId})`);
  assert(totalVotes === CONCURRENCY, `vote total mismatch after polling (expected=${CONCURRENCY} got=${totalVotes})`);
  assert(uniqueOptionsHit === CONCURRENCY, `unique option hit mismatch after polling (expected=${CONCURRENCY} got=${uniqueOptionsHit})`);
  assert(statsTotalVotes === CONCURRENCY, `stats vote total mismatch after polling (expected=${CONCURRENCY} got=${statsTotalVotes})`);
  assert(
    statsUniqueOptionsHit === CONCURRENCY,
    `stats unique option hit mismatch after polling (expected=${CONCURRENCY} got=${statsUniqueOptionsHit})`
  );
  assert(participantCount === CONCURRENCY, `participant count mismatch after polling (expected=${CONCURRENCY} got=${participantCount})`);

  for (let index = 1; index <= CONCURRENCY; index += 1) {
    const optionId = buildOptionId(index);
    const count = Number(voteCounts[optionId] || 0);
    const statsCount = Number(statsVoteCounts[optionId] || 0);
    assert(count === 1, `option ${optionId} should have exactly 1 vote (got=${count})`);
    assert(statsCount === 1, `stats option ${optionId} should have exactly 1 vote (got=${statsCount})`);
  }

  console.log(
    JSON.stringify({
      scenario: 'prod-vote-storm',
      phase: 'verify',
      status: 'ok',
      concurrency: CONCURRENCY,
      sessionId: data.sessionId,
      slideId: data.slideId,
      participantCount,
      totalVotes,
      uniqueOptionsHit,
      statsTotalVotes,
      statsUniqueOptionsHit,
      statsInteractionCount: statsInteractions.length,
      expectedVoteSequence,
      observedVoteSequence,
      voteSequenceMatched: observedVoteSequence === expectedVoteSequence,
      myVotesSamples,
    })
  );
}

export function teardown(data) {
  if (SKIP_CLEANUP) {
    console.log(
      JSON.stringify({
        scenario: 'prod-vote-storm',
        phase: 'cleanup',
        status: 'skipped',
        sessionId: data.sessionId,
      })
    );
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
      scenario: 'prod-vote-storm',
      phase: 'cleanup',
      status: 'ok',
      sessionId: data.sessionId,
      deletedCreatorUser: cleanupBody.data?.deletedCreatorUser,
    })
  );
}
