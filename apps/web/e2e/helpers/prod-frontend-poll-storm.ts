import { expect, request } from '@playwright/test';
import { randomUUID } from 'node:crypto';

export type PollOption = {
    id: string;
    text: string;
};

export type PollStormSetup = {
    sessionId: string;
    shareToken: string;
    staffToken: string;
    slideId: string;
    options: PollOption[];
    staffEmail: string;
};

export type PollStormSummary = {
    status: 'ok' | 'failed' | 'skipped';
    scenario: string;
    baseUrl: string;
    sessionId?: string;
    shareToken?: string;
    slideId?: string;
    students?: number;
    options?: number;
    uniqueParticipantIds?: number;
    authRequests?: number;
    websocketConnections?: number;
    registerSuccesses?: number;
    voteSuccesses?: number;
    voteSequence?: number;
    participantCount?: number;
    voteCounts?: Record<string, number>;
    cleanup?: 'ok' | 'skipped' | 'failed';
    error?: string;
    generatedAt: string;
};

function normalizeApiBaseUrl(url: string): string {
    return `${url.replace(/\/+$/, '')}/`;
}

function randomHexId(prefix: string): string {
    return `${prefix}-${Date.now()}-${randomUUID()}`;
}

function buildPollOption(index: number): PollOption {
    const suffix = String(index + 1).padStart(3, '0');
    return {
        id: `choice-${suffix}`,
        text: `Choice ${suffix}`,
    };
}

function buildPollOptions(optionCount: number): PollOption[] {
    return Array.from({ length: optionCount }, (_, index) => buildPollOption(index));
}

function buildPollSlideBody(optionCount: number) {
    return {
        type: 'poll',
        content: {
            question: 'Pick your unique choice',
            options: buildPollOptions(optionCount),
            limitSubmissions: true,
            allowMultipleSelection: false,
        },
        clientRequestId: randomHexId('slide'),
    };
}

type JsonResponse = {
    ok: () => boolean;
    status: () => number;
    json: () => Promise<any>;
};

function assertOk(condition: unknown, message: string): asserts condition {
    expect(Boolean(condition), message).toBeTruthy();
}

async function parseJsonResponse(response: JsonResponse, label: string): Promise<any> {
    expect(response.ok(), `${label}: HTTP ${response.status()}`).toBeTruthy();
    try {
        return await response.json();
    } catch (error) {
        throw new Error(`${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
}

function unwrapApiResponse(body: any, label: string) {
    assertOk(body && body.success === true, `${label}: expected success=true`);
    return body.data ?? body;
}

export async function createPollStormSetup(
    apiBaseUrl: string,
    optionCount: number,
): Promise<PollStormSetup> {
    const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
    const api = await request.newContext({
        baseURL: normalizedApiBaseUrl,
        extraHTTPHeaders: {
            Accept: 'application/json',
        },
    });

    try {
        const staffEmail = `browser-storm-${Date.now()}-${randomHexId('staff')}@example.com`;
        const staffPassword = `Perf-${randomHexId('password')}!Aa1`;
        const staffName = 'Frontend Perf Staff';

        const registerResponse = await api.post('auth/register', {
            data: {
                email: staffEmail,
                password: staffPassword,
                name: staffName,
                role: 'staff',
            },
        });
        const registerBody = await parseJsonResponse(registerResponse, 'staff register');
        unwrapApiResponse(registerBody, 'staff register');

        const loginResponse = await api.post('auth/login', {
            data: {
                email: staffEmail,
                password: staffPassword,
            },
        });
        const loginBody = await parseJsonResponse(loginResponse, 'staff login');
        expect(loginBody.success, 'staff login should succeed').toBeTruthy();
        assertOk(typeof loginBody.token === 'string' && loginBody.token.length > 0, 'staff login token missing');
        const staffToken = loginBody.token as string;

        const createSessionResponse = await api.post('sessions', {
            headers: {
                Authorization: `Bearer ${staffToken}`,
            },
            data: {
                title: `Frontend poll storm ${randomHexId('session')}`,
                allowQuestions: false,
                requireName: true,
            },
        });
        const sessionBody = await parseJsonResponse(createSessionResponse, 'create session');
        const session = unwrapApiResponse(sessionBody, 'create session');
        assertOk(typeof session.id === 'string' && session.id.length > 0, 'session id missing');
        assertOk(typeof session.shareToken === 'string' && session.shareToken.length > 0, 'share token missing');

        const slideResponse = await api.post(`sessions/${session.id}/slides`, {
            headers: {
                Authorization: `Bearer ${staffToken}`,
            },
            data: buildPollSlideBody(optionCount),
        });
        const slideBody = await parseJsonResponse(slideResponse, 'create slide');
        const slide = unwrapApiResponse(slideBody, 'create slide');
        assertOk(typeof slide.id === 'string' && slide.id.length > 0, 'slide id missing');

        const goLiveResponse = await api.post(`sessions/${session.id}/go-live`, {
            headers: {
                Authorization: `Bearer ${staffToken}`,
            },
        });
        const goLiveBody = await parseJsonResponse(goLiveResponse, 'go live');
        unwrapApiResponse(goLiveBody, 'go live');

        const currentSlideResponse = await api.put(`sessions/${session.id}/current-slide`, {
            headers: {
                Authorization: `Bearer ${staffToken}`,
            },
            data: {
                slideId: slide.id,
            },
        });
        const currentSlideBody = await parseJsonResponse(currentSlideResponse, 'current slide');
        unwrapApiResponse(currentSlideBody, 'current slide');

        const stateResponse = await api.get(`sessions/${session.id}/state`);
        const stateBody = await parseJsonResponse(stateResponse, 'session state');
        assertOk(stateBody.currentSlideId === slide.id, 'current slide did not stick');
        assertOk(stateBody.isPresentationActive === true, 'session should be live');

        return {
            sessionId: session.id,
            shareToken: session.shareToken,
            staffToken,
            slideId: slide.id,
            options: buildPollOptions(optionCount),
            staffEmail,
        };
    } finally {
        await api.dispose();
    }
}

export async function cleanupPollStormSession(
    apiBaseUrl: string,
    sessionId: string,
    perfTestToken: string,
    deleteCreatorUser = true,
): Promise<void> {
    const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
    const api = await request.newContext({
        baseURL: normalizedApiBaseUrl,
        extraHTTPHeaders: {
            Accept: 'application/json',
            'x-perf-test-token': perfTestToken,
        },
    });

    try {
        const response = await api.delete(`internal/perf/sessions/${sessionId}?deleteCreatorUser=${deleteCreatorUser ? 'true' : 'false'}`);
        const body = await parseJsonResponse(response, 'cleanup');
        unwrapApiResponse(body, 'cleanup');
    } finally {
        await api.dispose();
    }
}

export function buildStudentName(index: number): string {
    return `Student ${String(index + 1).padStart(3, '0')}`;
}

export function buildStudentChoice(index: number, options: PollOption[]): PollOption {
    const option = options[index];
    assertOk(option, `missing option for student ${index + 1}`);
    return option;
}

export function readPositiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return parsed;
}

export async function writeSummaryFile(summaryPath: string | undefined, summary: PollStormSummary): Promise<void> {
    if (!summaryPath) return;

    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');

    await mkdir(dirname(summaryPath), { recursive: true });
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}
