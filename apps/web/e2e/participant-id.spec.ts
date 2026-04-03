import { expect, test, type BrowserContext } from '@playwright/test';

const SHARE_TOKEN = 'deadbeef';
const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const PRELOAD_KEY = `preloaded_session_${SHARE_TOKEN}`;
const PARTICIPANT_KEY = `studentParticipantId_${SESSION_ID}`;

test.describe.configure({ mode: 'serial' });

function buildSessionState() {
  return {
    currentSlideId: null,
    isPresentationActive: false,
    isResultsVisible: false,
    stateVersion: 1,
    slides: [],
    questions: [],
    voteCounts: {},
    voteSequence: 0,
    qaSequence: 0,
  };
}

function buildPreloadedSession() {
  const now = Date.now();

  return {
    expiresAt: now + 10 * 60 * 1000,
    requestId: 'participant-id-test-request',
    data: {
      id: SESSION_ID,
      creatorId: 'test-user',
      title: 'Participant ID Test Session',
      status: 'draft',
      shareToken: SHARE_TOKEN,
      currentSlideId: null,
      isResultsVisible: false,
      isPresentationActive: false,
      stateVersion: 1,
      allowQuestions: false,
      requireName: false,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      slides: [],
      questions: [],
      participants: [],
    },
  };
}

async function seedPreloadedSession(context: BrowserContext) {
  await context.addInitScript(
    ({ key, value }) => {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    },
    { key: PRELOAD_KEY, value: buildPreloadedSession() }
  );
}

async function seedLegacyParticipantId(context: BrowserContext, participantId: string) {
  await context.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: 'participantId', value: participantId }
  );
}

async function installStudentRoutes(context: BrowserContext) {
  const apiBasePattern = `**/api/sessions/${SESSION_ID}`;

  await context.route(`${apiBasePattern}/state`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildSessionState()),
    });
  });

  await context.route(`${apiBasePattern}/my-votes**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { votes: {} },
        error: null,
      }),
    });
  });
}

async function loadStudentSession(context: BrowserContext) {
  await seedPreloadedSession(context);
  await installStudentRoutes(context);

  const page = await context.newPage();
  await page.goto(`/student/session/${SHARE_TOKEN}`);
  await page.waitForFunction(
    (key) => Boolean(window.localStorage.getItem(key)),
    PARTICIPANT_KEY
  );

  return { page, context };
}

test('participant id survives a browser reload with localStorage', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { page } = await loadStudentSession(context);

    const firstId = await page.evaluate((key) => window.localStorage.getItem(key), PARTICIPANT_KEY);
    expect(firstId).toBeTruthy();

    await page.reload();
    await page.waitForFunction(
      (key) => Boolean(window.localStorage.getItem(key)),
      PARTICIPANT_KEY
    );

    const secondId = await page.evaluate((key) => window.localStorage.getItem(key), PARTICIPANT_KEY);
    expect(secondId).toBe(firstId);
  } finally {
    await context.close();
  }
});

test('legacy participantId storage coexists with the new student-scoped id', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await seedLegacyParticipantId(context, 'legacy-participant-id');
    const { page } = await loadStudentSession(context);

    const legacyId = await page.evaluate(() => window.localStorage.getItem('participantId'));
    const studentId = await page.evaluate((key) => window.localStorage.getItem(key), PARTICIPANT_KEY);

    expect(legacyId).toBe('legacy-participant-id');
    expect(studentId).toBeTruthy();
    expect(studentId).not.toBe(legacyId);

    await page.reload();
    await page.waitForFunction(
      (key) => Boolean(window.localStorage.getItem(key)),
      PARTICIPANT_KEY
    );

    const reloadedLegacyId = await page.evaluate(() => window.localStorage.getItem('participantId'));
    const reloadedStudentId = await page.evaluate((key) => window.localStorage.getItem(key), PARTICIPANT_KEY);

    expect(reloadedLegacyId).toBe('legacy-participant-id');
    expect(reloadedStudentId).toBe(studentId);
  } finally {
    await context.close();
  }
});

test('100 student browsers get 100 unique participant ids', async ({ browser }) => {
  test.setTimeout(300_000);

  const ids = new Set<string>();
  const total = 100;
  const batchSize = 10;

  for (let offset = 0; offset < total; offset += batchSize) {
    const batchIndices = Array.from(
      { length: Math.min(batchSize, total - offset) },
      (_, index) => offset + index
    );

    const batchResults = await Promise.all(
      batchIndices.map(async () => {
        const context = await browser.newContext();
        try {
          const { page } = await loadStudentSession(context);
          const participantId = await page.evaluate(
            (key) => window.localStorage.getItem(key),
            PARTICIPANT_KEY
          );

          expect(participantId).toBeTruthy();
          return participantId as string;
        } finally {
          await context.close();
        }
      })
    );

    for (const participantId of batchResults) {
      expect(ids.has(participantId)).toBe(false);
      ids.add(participantId);
    }
  }

  expect(ids.size).toBe(total);
});
