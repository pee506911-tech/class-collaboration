import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError, getSession, getSlides, publicSetCurrentSlide, updateSlide } from '@/lib/api';

const originalFetch = global.fetch;

function mockJsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: {
            'Content-Type': 'application/json',
            ...(init?.headers ?? {}),
        },
    });
}

describe('updateSlide', () => {
    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('sends only content in the request body', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            mockJsonResponse({
                success: true,
                data: {
                    id: 'slide-1',
                    sessionId: 'session-1',
                    type: 'static',
                    content: { title: 'Saved', body: 'Saved body' },
                    orderIndex: 0,
                    isHidden: false,
                    version: 2,
                },
            }),
        );
        global.fetch = fetchMock as typeof fetch;

        const slide = await updateSlide('session-1', 'slide-1', { title: 'Saved', body: 'Saved body' });

        expect(slide.version).toBe(2);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/api/sessions/session-1/slides/slide-1');
        expect(options.method).toBe('PUT');
        expect(JSON.parse(String(options.body))).toEqual({
            content: { title: 'Saved', body: 'Saved body' },
        });
    });

    it('accepts 202 queued responses as successful saves', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            mockJsonResponse(
                {
                    success: true,
                    data: {
                        id: 'slide-1',
                        sessionId: 'session-1',
                        type: 'static',
                        content: { title: 'Queued', body: 'Queued body' },
                        orderIndex: 0,
                        isHidden: false,
                        version: 2,
                    },
                },
                { status: 202 },
            ),
        );
        global.fetch = fetchMock as typeof fetch;

        await expect(
            updateSlide('session-1', 'slide-1', { title: 'Queued', body: 'Queued body' }),
        ).resolves.toMatchObject({
            version: 2,
            content: { title: 'Queued', body: 'Queued body' },
        });
    });

    it('surfaces a 409 conflict without retrying the stale save', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            mockJsonResponse(
                {
                    success: false,
                    error: 'Slide has changed on the server',
                    data: {
                        reason: 'stale_slide_version',
                        currentVersion: 3,
                    },
                },
                { status: 409 },
            ),
        );
        global.fetch = fetchMock as typeof fetch;

        await expect(
            updateSlide('session-1', 'slide-1', { title: 'Saved', body: 'Saved body' }),
        ).rejects.toEqual(
            expect.objectContaining({
                status: 409,
                message: 'Slide has changed on the server',
                retryable: false,
            }),
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries transient transport failures before succeeding', async () => {
        vi.useFakeTimers();

        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new TypeError('network failed'))
            .mockResolvedValueOnce(
                mockJsonResponse({
                    success: true,
                    data: {
                        id: 'slide-1',
                        sessionId: 'session-1',
                        type: 'static',
                        content: { title: 'Saved', body: 'Saved body' },
                        orderIndex: 0,
                        isHidden: false,
                        version: 2,
                    },
                }),
            );
        global.fetch = fetchMock as typeof fetch;

        const updatePromise = updateSlide('session-1', 'slide-1', { title: 'Saved', body: 'Saved body' });

        await vi.advanceTimersByTimeAsync(1000);

        await expect(updatePromise).resolves.toMatchObject({
            version: 2,
            content: { title: 'Saved', body: 'Saved body' },
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('getSession', () => {
    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('surfaces 404 responses as ApiRequestError', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            mockJsonResponse(
                {
                    success: false,
                    error: 'Session not found',
                },
                { status: 404 },
            ),
        );
        global.fetch = fetchMock as typeof fetch;

        await expect(getSession('session-missing')).rejects.toEqual(
            expect.objectContaining<ApiRequestError>({
                message: 'Session not found',
                status: 404,
                retryable: false,
            }),
        );
    });
});

describe('getSlides', () => {
    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('surfaces 404 responses as ApiRequestError', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            mockJsonResponse(
                {
                    success: false,
                    error: 'Session not found',
                },
                { status: 404 },
            ),
        );
        global.fetch = fetchMock as typeof fetch;

        await expect(getSlides('session-missing')).rejects.toEqual(
            expect.objectContaining<ApiRequestError>({
                message: 'Session not found',
                status: 404,
                retryable: false,
            }),
        );
    });
});

describe('publicSetCurrentSlide', () => {
    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('returns the authoritative slide state from the clicker endpoint', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            mockJsonResponse({
                success: true,
                data: {
                    currentSlideId: 'slide-4',
                    isPresentationActive: true,
                    isResultsVisible: false,
                    stateVersion: 9,
                },
            }),
        );
        global.fetch = fetchMock as typeof fetch;

        await expect(publicSetCurrentSlide('session-1', 'slide-4')).resolves.toEqual(
            expect.objectContaining({
                currentSlideId: 'slide-4',
                stateVersion: 9,
            }),
        );
    });

    it('surfaces clicker API failures to the caller', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            mockJsonResponse(
                {
                    success: false,
                    error: 'Invalid slide',
                },
                { status: 400 },
            ),
        );
        global.fetch = fetchMock as typeof fetch;

        await expect(publicSetCurrentSlide('session-1', 'slide-missing')).rejects.toEqual(
            expect.objectContaining({
                message: 'Invalid slide',
                status: 400,
                retryable: false,
            }),
        );
    });
});
