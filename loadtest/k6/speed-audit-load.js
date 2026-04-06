/**
 * Speed Audit Log Load Test (k6)
 *
 * This script generates realistic classroom load to trigger all 9 audit log points:
 * 1. WAL entry appended (slide edits)
 * 2. WAL flush started
 * 3. WAL flush completed
 * 4. Outbox event enqueued
 * 5. Handler-level slide enqueue
 * 6. Handler-level state enqueue (live controls)
 * 7. Outbox event published (with queue_wait_ms)
 * 8. Batch processing completed
 * 9. WebSocket message sent to client (with delivery_ms)
 *
 * Usage:
 *   k6 run --env BASE_URL=https://your-backend.com --env CONCURRENCY=50 speed-audit-load.js
 *
 * The script:
 * - Creates a session and slides
 * - Simulates teacher editing slides
 * - Simulates teacher using live controls (go live, navigate slides)
 * - Simulates students voting
 * - Simulates students asking questions
 * - Reports timing metrics from HTTP responses
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Custom metrics
const slideEditSuccessRate = new Rate('slide_edit_success');
const stateUpdateSuccessRate = new Rate('state_update_success');
const voteSuccessRate = new Rate('vote_success');
const questionSuccessRate = new Rate('question_success');

// Test configuration
const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const CONCURRENCY = parseInt(__ENV.CONCURRENCY || '50', 10);
const TEST_DURATION = __ENV.TEST_DURATION || '2m';
const SLIDE_EDIT_INTERVAL = 0.5; // seconds between slide edits
const STATE_UPDATE_INTERVAL = 2; // seconds between state updates
const VOTE_INTERVAL = 0.2; // seconds between votes (burst)
const QUESTION_INTERVAL = 1; // seconds between questions

// Shared state (will be set by setup)
let sessionData = {};

// Setup function - runs once before test
export function setup() {
  console.log('Setting up test session...');

  // Step 1: Create teacher account and login
  const teacherEmail = `speed-audit-teacher-${Date.now()}@test.com`;
  const registerRes = http.post(`${BASE_URL}/api/auth/register`, {
    email: teacherEmail,
    password: 'TestPass123!',
  });

  check(registerRes, {
    'teacher registration successful': (r) => r.status === 200 || r.status === 201,
  });

  const teacherToken = registerRes.json('token') || registerRes.json('accessToken');
  if (!teacherToken) {
    console.error('Failed to get teacher token');
    return {};
  }

  // Step 2: Create session
  const sessionRes = http.post(
    `${BASE_URL}/api/sessions`,
    JSON.stringify({ title: 'Speed Audit Load Test Session' }),
    {
      headers: { 'Content-Type': 'application/json' },
      token: teacherToken,
    }
  );

  check(sessionRes, {
    'session created': (r) => r.status === 200 || r.status === 201,
  });

  const sessionId = sessionRes.json('data.id') || sessionRes.json('data.sessionId');
  if (!sessionId) {
    console.error('Failed to create session');
    return {};
  }

  console.log(`Created session: ${sessionId}`);

  // Step 3: Create initial slides
  const slideIds = [];
  for (let i = 0; i < 5; i++) {
    const slideRes = http.post(
      `${BASE_URL}/api/sessions/${sessionId}/slides`,
      JSON.stringify({
        slideType: i === 0 ? 'poll' : 'content',
        content: {
          title: `Load Test Slide ${i + 1}`,
          options: i === 0 ? [{ id: 'opt-a' }, { id: 'opt-b' }] : undefined,
        },
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        token: teacherToken,
      }
    );

    const slideId = slideRes.json('data.id');
    if (slideId) {
      slideIds.push(slideId);
    }
  }

  console.log(`Created ${slideIds.length} slides`);

  // Step 4: Get WS token for teacher
  const wsTokenRes = http.get(
    `${BASE_URL}/api/auth/ws-token?sessionId=${sessionId}&role=teacher&participantId=teacher-0`,
    { token: teacherToken }
  );

  const wsToken = wsTokenRes.json('token');

  return {
    sessionId,
    teacherToken,
    wsToken,
    slideIds,
    pollSlideId: slideIds[0],
  };
}

// Helper: Make authenticated request
function authRequest(method, path, body, token) {
  const params = {
    headers: { 'Content-Type': 'application/json' },
    token: token,
  };

  const url = `${BASE_URL}${path}`;

  if (method === 'GET') {
    return http.get(url, params);
  } else if (method === 'POST') {
    return http.post(url, JSON.stringify(body), params);
  } else if (method === 'PUT') {
    return http.put(url, JSON.stringify(body), params);
  }

  return null;
}

// Scenario 1: Teacher edits slides (triggers WAL + Outbox audit logs)
export function slideEditor(data) {
  if (!data.sessionId || !data.slideIds || data.slideIds.length === 0) {
    return;
  }

  const slideId = data.slideIds[Math.floor(Math.random() * data.slideIds.length)];

  // Edit slide content
  const res = authRequest(
    'PUT',
    `/api/sessions/${data.sessionId}/slides/${slideId}`,
    {
      content: {
        title: `Updated at ${Date.now()}`,
        updated: true,
      },
    },
    data.teacherToken
  );

  const success = res && (res.status === 200 || res.status === 201 || res.status === 202);
  slideEditSuccessRate.add(success);

  check(res, {
    'slide edit accepted': (r) => r && (r.status === 200 || r.status === 201 || r.status === 202),
  });

  sleep(SLIDE_EDIT_INTERVAL);
}

// Scenario 2: Teacher uses live controls (triggers STATE_UPDATE audit logs)
export function liveControls(data) {
  if (!data.sessionId) {
    return;
  }

  // Toggle go live / stop live
  const goLiveRes = authRequest(
    'POST',
    `/api/sessions/${data.sessionId}/go-live`,
    {},
    data.teacherToken
  );

  const success = goLiveRes && (goLiveRes.status === 200 || goLiveRes.status === 201);
  stateUpdateSuccessRate.add(success);

  check(goLiveRes, {
    'go live successful': (r) => r && (r.status === 200 || r.status === 201),
  });

  sleep(1);

  // Navigate to random slide
  if (data.slideIds && data.slideIds.length > 0) {
    const targetSlide = data.slideIds[Math.floor(Math.random() * data.slideIds.length)];
    const navigateRes = authRequest(
      'POST',
      `/api/sessions/${data.sessionId}/set-current-slide`,
      { slideId: targetSlide },
      data.teacherToken
    );

    check(navigateRes, {
      'navigate to slide': (r) => r && (r.status === 200 || r.status === 201),
    });
  }

  sleep(1);

  // Toggle results visibility
  const resultsRes = authRequest(
    'POST',
    `/api/sessions/${data.sessionId}/set-results-visibility`,
    { visible: Math.random() > 0.5 },
    data.teacherToken
  );

  check(resultsRes, {
    'set results visibility': (r) => r && (r.status === 200 || r.status === 201),
  });

  sleep(STATE_UPDATE_INTERVAL);
}

// Scenario 3: Students vote (triggers VOTE_UPDATE audit logs)
export function studentVotes(data) {
  if (!data.sessionId || !data.pollSlideId) {
    return;
  }

  // Simulate multiple students voting
  for (let i = 0; i < Math.min(CONCURRENCY, 20); i++) {
    const studentId = `student-${Date.now()}-${i}`;
    const optionId = Math.random() > 0.5 ? 'opt-a' : 'opt-b';

    const voteRes = authRequest(
      'POST',
      `/api/sessions/${data.sessionId}/slides/${data.pollSlideId}/votes`,
      {
        participantId: studentId,
        optionIds: [optionId],
      },
      data.teacherToken // In real test, use student tokens
    );

    const success = voteRes && (voteRes.status === 200 || voteRes.status === 201 || voteRes.status === 202);
    voteSuccessRate.add(success);

    check(voteRes, {
      'vote accepted': (r) => r && (r.status >= 200 && r.status < 300),
    });

    sleep(VOTE_INTERVAL);
  }
}

// Scenario 4: Students ask questions (triggers QA_UPDATE audit logs)
export function studentQuestions(data) {
  if (!data.sessionId) {
    return;
  }

  // Simulate students asking questions
  for (let i = 0; i < Math.min(CONCURRENCY, 10); i++) {
    const studentId = `student-${Date.now()}-${i}`;

    const questionRes = authRequest(
      'POST',
      `/api/sessions/${data.sessionId}/questions`,
      {
        participantId: studentId,
        content: `Question from ${studentId} at ${Date.now()}`,
      },
      data.teacherToken
    );

    const success = questionRes && (questionRes.status === 200 || questionRes.status === 201);
    questionSuccessRate.add(success);

    check(questionRes, {
      'question submitted': (r) => r && (r.status === 200 || r.status === 201),
    });

    sleep(QUESTION_INTERVAL);
  }
}

// Scenario 5: Batch slide creation (triggers batch audit logs)
export function batchSlideCreation(data) {
  if (!data.sessionId) {
    return;
  }

  const batchRes = authRequest(
    'POST',
    `/api/sessions/${data.sessionId}/slides/batch`,
    {
      slides: [
        { slideType: 'content', content: { title: 'Batch Slide 1' } },
        { slideType: 'content', content: { title: 'Batch Slide 2' } },
        { slideType: 'content', content: { title: 'Batch Slide 3' } },
      ],
    },
    data.teacherToken
  );

  check(batchRes, {
    'batch slide creation successful': (r) => r && (r.status === 200 || r.status === 201),
  });

  sleep(3);
}

// Test options
export const options = {
  stages: [
    { duration: '30s', target: CONCURRENCY / 2 }, // Ramp up
    { duration: TEST_DURATION, target: CONCURRENCY }, // Sustained load
    { duration: '30s', target: 0 }, // Ramp down
  ],
  thresholds: {
    'slide_edit_success': ['rate>0.95'], // 95% success rate
    'state_update_success': ['rate>0.95'],
    'vote_success': ['rate>0.95'],
    'question_success': ['rate>0.95'],
    'http_req_duration': ['p(95)<1000'], // 95% of requests < 1s
    'http_req_waiting': ['p(95)<800'], // 95% TTFB < 800ms
  },
};

// Teardown - cleanup
export function teardown(data) {
  if (data.sessionId && __ENV.PERF_TEST_TOKEN) {
    console.log(`Cleaning up session: ${data.sessionId}`);
    http.del(
      `${BASE_URL}/api/internal/perf/sessions/${data.sessionId}`,
      null,
      {
        token: __ENV.PERF_TEST_TOKEN,
      }
    );
  }
}
