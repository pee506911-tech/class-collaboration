import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
    buildStudentChoice,
    buildStudentName,
    cleanupPollStormSession,
    createPollStormSetup,
    readPositiveIntEnv,
    type PollStormSummary,
    writeSummaryFile,
} from './helpers/prod-frontend-poll-storm';

test.describe.configure({ mode: 'serial' });

const BACKEND_API_URL = process.env.PLAYWRIGHT_API_URL || 'http://localhost:8080/api';
const STUDENT_COUNT = readPositiveIntEnv('PLAYWRIGHT_STUDENT_COUNT', 100);
const OPTION_COUNT = readPositiveIntEnv('PLAYWRIGHT_OPTION_COUNT', STUDENT_COUNT);
const BATCH_SIZE = readPositiveIntEnv('PLAYWRIGHT_BATCH_SIZE', 10);
const CLEANUP_TOKEN = process.env.PERF_TEST_TOKEN || '';
const SKIP_CLEANUP = process.env.PLAYWRIGHT_SKIP_CLEANUP === '1';
const SUMMARY_FILE = process.env.PLAYWRIGHT_SUMMARY_FILE;

type StudentClient = {
    page: Page;
    context: BrowserContext;
    name: string;
    participantId: string;
    optionId: string;
    optionText: string;
    websocketUrl: string;
    authClientId: string;
};

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function voteCountsForSlide(state: any, slideId: string): Record<string, number> {
    return (state?.voteCounts && state.voteCounts[slideId]) || {};
}

async function fetchState(apiBaseUrl: string, sessionId: string) {
    const response = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/sessions/${sessionId}/state`);
    expect(response.ok, `state HTTP ${response.status}`).toBeTruthy();
    return await response.json();
}

async function fetchStats(apiBaseUrl: string, sessionId: string, staffToken: string) {
    const response = await fetch(
        `${apiBaseUrl.replace(/\/+$/, '')}/sessions/${sessionId}/stats?participantLimit=2000&questionLimit=2000&voteLimit=5000`,
        {
            headers: {
                Authorization: `Bearer ${staffToken}`,
                Accept: 'application/json',
            },
        }
    );
    expect(response.ok, `stats HTTP ${response.status}`).toBeTruthy();
    return await response.json();
}

async function fetchMyVotes(apiBaseUrl: string, sessionId: string, participantId: string) {
    const response = await fetch(
        `${apiBaseUrl.replace(/\/+$/, '')}/sessions/${sessionId}/my-votes?participantId=${encodeURIComponent(participantId)}`
    );
    expect(response.ok, `my-votes HTTP ${response.status}`).toBeTruthy();
    const body = await response.json();
    expect(body.success, 'my-votes response should succeed').toBeTruthy();
    return body.data;
}

async function waitForBackendToSettle(
    apiBaseUrl: string,
    sessionId: string,
    staffToken: string,
    slideId: string,
    optionIds: string[],
    expectedStudents: number,
    timeoutMs = 120_000,
) {
    const startedAt = Date.now();
    let lastSummary: Record<string, unknown> | null = null;

    while (Date.now() - startedAt < timeoutMs) {
        const state = await fetchState(apiBaseUrl, sessionId);
        const stats = await fetchStats(apiBaseUrl, sessionId, staffToken);
        const voteCounts = voteCountsForSlide(state, slideId);
        const voteSequence = Number(state?.voteSequence || 0);
        const participantCount = Array.isArray(stats?.participants) ? stats.participants.length : 0;
        const allVotesRecorded = optionIds.every((optionId) => Number(voteCounts[optionId] || 0) === 1);

        lastSummary = {
            voteSequence,
            participantCount,
            voteCounts,
        };

        if (
            voteSequence >= expectedStudents &&
            participantCount >= expectedStudents &&
            allVotesRecorded
        ) {
            return { state, stats, voteCounts };
        }

        await sleep(1000);
    }

    throw new Error(`Timed out waiting for backend to settle: ${JSON.stringify(lastSummary)}`);
}

async function openStudentClient(
    browser: Browser,
    sessionId: string,
    shareToken: string,
    index: number,
    optionId: string,
    optionText: string,
) {
    const name = buildStudentName(index);
    const context = await browser.newContext();
    const page = await context.newPage();

    const authRequestPromise = page.waitForRequest(
        (request) => request.url().includes('/api/auth/ably') && request.method() === 'GET',
        { timeout: 30_000 }
    );
    const authResponsePromise = page.waitForResponse(
        (response) => response.url().includes('/api/auth/ably') && response.request().method() === 'GET',
        { timeout: 30_000 }
    );
    const websocketPromise = page.waitForEvent('websocket', {
        predicate: (websocket) => websocket.url().toLowerCase().includes('ably'),
        timeout: 30_000,
    });
    const registerResponsePromise = page.waitForResponse(
        (response) => response.url().includes('/register-participant') && response.request().method() === 'POST',
        { timeout: 30_000 }
    );

    await page.goto(`/student/session/${shareToken}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByPlaceholder('Your Name')).toBeVisible({ timeout: 30_000 });
    await page.getByPlaceholder('Your Name').fill(name);
    await page.getByRole('button', { name: 'Join Session' }).click();

    await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Submit Answer' })).toBeVisible({ timeout: 60_000 });

    const [authRequest, authResponse, websocket, registerResponse] = await Promise.all([
        authRequestPromise,
        authResponsePromise,
        websocketPromise,
        registerResponsePromise,
    ]);

    expect(authResponse.ok(), 'ably auth response should be ok').toBeTruthy();
    expect(registerResponse.ok(), 'participant registration should be ok').toBeTruthy();

    const authBody = await authResponse.json();
    expect(authBody.clientId, 'ably auth clientId should exist').toBeTruthy();

    const participantId = await page.evaluate((currentSessionId) => {
        return localStorage.getItem(`studentParticipantId_${currentSessionId}`);
    }, sessionId);

    expect(participantId, 'participantId should exist in localStorage').toBeTruthy();
    expect(new URL(authRequest.url()).searchParams.get('participantId')).toBe(participantId);
    expect(authBody.clientId).toBe(participantId);
    expect(websocket.url().toLowerCase()).toContain('ably');

    return {
        page,
        context,
        name,
        participantId: participantId as string,
        optionId,
        optionText,
        websocketUrl: websocket.url(),
        authClientId: authBody.clientId as string,
    };
}

async function submitStudentVote(client: StudentClient) {
    const voteResponsePromise = client.page.waitForResponse(
        (response) => response.url().includes('/vote') && response.request().method() === 'POST',
        { timeout: 30_000 }
    );

    await client.page.getByText(client.optionText, { exact: true }).click();
    await client.page.getByRole('button', { name: 'Submit Answer' }).click();

    const voteResponse = await voteResponsePromise;
    expect(voteResponse.ok(), `vote response for ${client.name} should be ok`).toBeTruthy();
    await expect(client.page.getByText('Answer Submitted')).toBeVisible({ timeout: 30_000 });
}

test('submits poll answers from many frontend clients on prod', async ({ browser }) => {
    test.setTimeout(20 * 60 * 1000);
    test.slow();

    if (OPTION_COUNT < STUDENT_COUNT) {
        throw new Error(`PLAYWRIGHT_OPTION_COUNT must be >= PLAYWRIGHT_STUDENT_COUNT (${OPTION_COUNT} < ${STUDENT_COUNT})`);
    }

    const setup = await createPollStormSetup(BACKEND_API_URL, OPTION_COUNT);
    const clients: StudentClient[] = [];
    let summary: PollStormSummary = {
        status: 'failed',
        scenario: 'prod-frontend-poll-storm',
        baseUrl: BACKEND_API_URL,
        sessionId: setup.sessionId,
        shareToken: setup.shareToken,
        slideId: setup.slideId,
        students: STUDENT_COUNT,
        options: OPTION_COUNT,
        generatedAt: new Date().toISOString(),
    };

    try {
        for (let start = 0; start < STUDENT_COUNT; start += BATCH_SIZE) {
            const batch = Array.from(
                { length: Math.min(BATCH_SIZE, STUDENT_COUNT - start) },
                (_, offset) => {
                    const studentIndex = start + offset;
                    const option = buildStudentChoice(studentIndex, setup.options);
                    return {
                        studentIndex,
                        option,
                    };
                }
            );

            const batchClients = await Promise.all(
                batch.map(async ({ studentIndex, option }) => {
                    return openStudentClient(
                        browser,
                        setup.sessionId,
                        setup.shareToken,
                        studentIndex,
                        option.id,
                        option.text,
                    );
                })
            );

            clients.push(...batchClients);
        }

        const uniqueParticipantIds = new Set(clients.map((client) => client.participantId));
        expect(uniqueParticipantIds.size, 'each browser should get a unique participantId').toBe(STUDENT_COUNT);
        expect(clients.filter((client) => client.websocketUrl).length, 'each browser should open an Ably websocket').toBe(STUDENT_COUNT);

        for (let start = 0; start < clients.length; start += BATCH_SIZE) {
            const batch = clients.slice(start, start + BATCH_SIZE);
            await Promise.all(batch.map((client) => submitStudentVote(client)));
        }

        const settled = await waitForBackendToSettle(
            BACKEND_API_URL,
            setup.sessionId,
            setup.staffToken,
            setup.slideId,
            setup.options.map((option) => option.id),
            STUDENT_COUNT,
        );

        const state = settled.state;
        const stats = settled.stats;
        const voteCounts = settled.voteCounts;

        expect(state.currentSlideId, 'current slide should stay on the poll slide').toBe(setup.slideId);
        expect(state.isPresentationActive, 'session should remain live').toBe(true);
        expect(Number(state.voteSequence || 0), 'vote sequence should equal number of students').toBe(STUDENT_COUNT);
        expect(stats.participants.length, 'participant count should equal number of students').toBe(STUDENT_COUNT);
        expect(stats.slides.length, 'slide count should equal the setup slide count').toBe(1);
        expect(Array.isArray(stats.questions), 'stats questions should be an array').toBeTruthy();
        expect(Object.keys(voteCounts).length, 'each option should have one vote').toBe(OPTION_COUNT);
        for (const option of setup.options) {
            expect(Number(voteCounts[option.id] || 0), `vote count for ${option.id}`).toBe(1);
        }

        for (const client of clients) {
            const myVotes = await fetchMyVotes(BACKEND_API_URL, setup.sessionId, client.participantId);
            const votesForSlide = myVotes?.votes?.[setup.slideId] || [];
            expect(votesForSlide, `my-votes for ${client.name}`).toEqual([client.optionId]);
        }

        summary = {
            status: 'ok',
            scenario: 'prod-frontend-poll-storm',
            baseUrl: BACKEND_API_URL,
            sessionId: setup.sessionId,
            shareToken: setup.shareToken,
            slideId: setup.slideId,
            students: STUDENT_COUNT,
            options: OPTION_COUNT,
            uniqueParticipantIds: uniqueParticipantIds.size,
            authRequests: clients.length,
            websocketConnections: clients.length,
            registerSuccesses: stats.participants.length,
            voteSuccesses: STUDENT_COUNT,
            voteSequence: Number(state.voteSequence || 0),
            participantCount: stats.participants.length,
            voteCounts,
            cleanup: SKIP_CLEANUP ? 'skipped' : 'ok',
            generatedAt: new Date().toISOString(),
        };
    } catch (error) {
        summary = {
            ...summary,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
            generatedAt: new Date().toISOString(),
        };
        throw error;
    } finally {
        for (const client of clients) {
            await client.page.close().catch(() => undefined);
            await client.context.close().catch(() => undefined);
        }

        let cleanupError: unknown = null;
        let cleanupStatus: PollStormSummary['cleanup'] = SKIP_CLEANUP ? 'skipped' : 'ok';

        if (!SKIP_CLEANUP) {
            if (!CLEANUP_TOKEN) {
                cleanupStatus = 'failed';
                cleanupError = new Error('PERF_TEST_TOKEN is required unless PLAYWRIGHT_SKIP_CLEANUP=1');
            } else {
                try {
                    await cleanupPollStormSession(BACKEND_API_URL, setup.sessionId, CLEANUP_TOKEN, true);
                } catch (error) {
                    cleanupStatus = 'failed';
                    cleanupError = error;
                }
            }
        }

        summary = {
            ...summary,
            cleanup: cleanupStatus,
            generatedAt: new Date().toISOString(),
        };

        if (cleanupError && summary.status === 'ok') {
            summary = {
                ...summary,
                status: 'failed',
                error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            };
        }

        await writeSummaryFile(SUMMARY_FILE, summary);

        console.log(JSON.stringify(summary));

        if (cleanupError) {
            throw cleanupError;
        }
    }
});
