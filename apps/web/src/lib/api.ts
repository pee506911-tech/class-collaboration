import { ApiResponse, Session, Slide, StateUpdatePayload } from 'shared';
import { httpFetch, createClientRequestId } from '@/lib/http';
import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from '@/lib/storage';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';

// Retry configuration for cold start handling
const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 5000,
};

export class ApiRequestError extends Error {
    status?: number;
    retryable: boolean;

    constructor(message: string, options?: { status?: number; retryable?: boolean; cause?: unknown }) {
        super(message);
        this.name = 'ApiRequestError';
        this.status = options?.status;
        this.retryable = options?.retryable ?? isRetryableStatus(options?.status);
        if (options?.cause !== undefined) {
            this.cause = options.cause;
        }
    }
}

async function fetchWithRetry(
    url: string,
    options: RequestInit = {},
    retries = RETRY_CONFIG.maxRetries
): Promise<Response> {
    const method = (options.method || 'GET').toUpperCase();
    const isIdempotent =
        method === 'GET' ||
        method === 'HEAD' ||
        method === 'OPTIONS' ||
        method === 'PUT' ||
        method === 'DELETE';

    const { response } = await httpFetch(url, {
        ...options,
        timeoutMs: 15000,
        idempotent: isIdempotent,
        retry: isIdempotent ? { maxRetries: retries, baseDelayMs: RETRY_CONFIG.baseDelay, maxDelayMs: RETRY_CONFIG.maxDelay } : false,
        throwOnHttpError: false,
    });

    return response;
}

function getHeaders(): HeadersInit {
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    const token = typeof window !== 'undefined' ? safeLocalStorageGet('token') : null;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
}

export function isRetryableApiError(error: unknown): boolean {
    return error instanceof ApiRequestError && error.retryable;
}

async function buildApiError(response: Response, fallbackMessage: string): Promise<ApiRequestError> {
    let message = fallbackMessage;

    try {
        const json = await response.clone().json() as Partial<ApiResponse<unknown>>;
        if (typeof json.error === 'string' && json.error.length > 0) {
            message = json.error;
        }
    } catch {
        try {
            const text = await response.text();
            if (text) {
                message = text;
            }
        } catch {
            message = fallbackMessage;
        }
    }

    return new ApiRequestError(message, {
        status: response.status,
        retryable: isRetryableStatus(response.status),
    });
}

function toApiRequestError(error: unknown, fallbackMessage: string): ApiRequestError {
    if (error instanceof ApiRequestError) {
        return error;
    }

    if (error instanceof Error) {
        return new ApiRequestError(error.message || fallbackMessage, {
            retryable: true,
            cause: error,
        });
    }

    return new ApiRequestError(fallbackMessage, { retryable: true });
}

function isRetryableStatus(status?: number): boolean {
    if (status === undefined) {
        return true;
    }

    // 409 conflicts should surface to the caller so the draft can rebase.
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

export type SharedSlide = Slide & {
    stats?: {
        votes?: Record<string, number>;
    };
};

export type SharedSessionData = {
    id: string;
    title: string;
    status: string;
    createdAt: string;
    slides: SharedSlide[];
    questions: Array<{
        id: string;
        content: string;
        upvotes: number;
        createdAt: string;
        slideId?: string;
    }>;
    participants: Array<{
        id: string;
        name: string;
        joinedAt: string;
    }>;
};

export async function getSharedSession(token: string, options?: { signal?: AbortSignal }): Promise<SharedSessionData> {
    const res = await fetchWithRetry(`${API_URL}/share/${encodeURIComponent(token)}`, {
        method: 'GET',
        signal: options?.signal,
    });

    if (res.status === 404) throw new Error('Session not found');
    if (!res.ok) throw new Error('Failed to load session');

    const json: ApiResponse<SharedSessionData> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load session');
    return json.data;
}

export async function login(email: string, password: string) {
    const res = await fetchWithRetry(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Login failed');
    safeLocalStorageSet('token', json.token);
    safeLocalStorageSet('user', JSON.stringify(json.user));
    return json;
}

export async function register(email: string, password: string, name: string, role: string) {
    const res = await fetchWithRetry(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name, role }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Registration failed');
    return json;
}

export function logout() {
    safeLocalStorageRemove('token');
    safeLocalStorageRemove('user');
    window.location.href = '/login';
}

export async function getSessions(status?: string): Promise<Session[]> {
    const url = status ? `${API_URL}/sessions?status=${status}` : `${API_URL}/sessions`;
    const res = await fetchWithRetry(url, { headers: getHeaders() });
    if (res.status === 401) { logout(); return []; }
    const json: ApiResponse<Session[]> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to fetch sessions');
    return json.data;
}

export async function getSession(sessionId: string): Promise<Session> {
    const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}`, { headers: getHeaders() });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<Session> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to fetch session');
    return json.data;
}

export async function duplicateSession(sessionId: string): Promise<Session> {
    const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/duplicate`, {
        method: 'POST',
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<Session> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to duplicate session');
    return json.data;
}

export async function archiveSession(sessionId: string): Promise<void> {
    const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/archive`, {
        method: 'PUT',
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to archive session');
}

export async function restoreSession(sessionId: string): Promise<void> {
    const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/restore`, {
        method: 'PUT',
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to restore session');
}

export async function createSession(title: string, allowQuestions = false, requireName = false): Promise<Session> {
    const res = await fetchWithRetry(`${API_URL}/sessions`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ title, allowQuestions, requireName }),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<Session> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to create session');
    return json.data;
}

export async function updateSession(sessionId: string, title?: string, allowQuestions?: boolean, requireName?: boolean): Promise<void> {
    const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ title, allowQuestions, requireName }),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to update session');
}

export async function deleteSession(sessionId: string): Promise<void> {
    const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to delete session');
}

export async function getSlides(sessionId: string): Promise<Slide[]> {
    const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/slides`, { headers: getHeaders() });
    if (res.status === 401) { logout(); return []; }
    const json: ApiResponse<Slide[]> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to fetch slides');
    return json.data;
}

export async function createSlide(
    sessionId: string,
    type: string,
    content: unknown,
    options?: { insertAfterSlideId?: string; clientRequestId?: string }
): Promise<Slide> {
    const clientRequestId = options?.clientRequestId ?? createClientRequestId();
    let res: Response;

    try {
        res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/slides`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
                type,
                content,
                clientRequestId,
                ...(options?.insertAfterSlideId ? { insertAfterSlideId: options.insertAfterSlideId } : {}),
            }),
        });
    } catch (error) {
        throw toApiRequestError(error, 'Failed to create slide');
    }
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    if (!res.ok) throw await buildApiError(res, 'Failed to create slide');
    const json: ApiResponse<Slide> = await res.json();
    if (!json.success) throw new ApiRequestError(json.error || 'Failed to create slide', { status: res.status });
    return json.data;
}

export async function updateSlide(
    sessionId: string,
    slideId: string,
    content: unknown,
): Promise<Slide> {
    let res: Response;

    try {
        res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/slides/${slideId}`, {
            method: 'PUT',
            headers: getHeaders(),
            body: JSON.stringify({
                content,
            }),
        });
    } catch (error) {
        throw toApiRequestError(error, 'Failed to update slide');
    }
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    if (!res.ok) throw await buildApiError(res, 'Failed to update slide');
    const json: ApiResponse<Slide> = await res.json();
    if (!json.success) throw new ApiRequestError(json.error || 'Failed to update slide', { status: res.status });
    return json.data;
}

export async function updateSlidesBatch(
    sessionId: string,
    updates: Array<{ slideId: string; content: unknown; type?: string; baseVersion?: number }>,
): Promise<Slide[]> {
    let res: Response;

    try {
        res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/slides/batch-update`, {
            method: 'PUT',
            headers: getHeaders(),
            body: JSON.stringify({
                updates: updates.map((u) => ({
                    slideId: u.slideId,
                    content: u.content,
                    ...(u.type ? { type: u.type } : {}),
                    ...(u.baseVersion !== undefined ? { baseVersion: u.baseVersion } : {}),
                })),
            }),
        });
    } catch (error) {
        throw toApiRequestError(error, 'Failed to batch update slides');
    }
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    if (!res.ok) throw await buildApiError(res, 'Failed to batch update slides');
    const json: ApiResponse<{ slides: Slide[]; stateVersion: number }> = await res.json();
    if (!json.success) throw new ApiRequestError(json.error || 'Failed to batch update slides', { status: res.status });
    return json.data.slides;
}

export async function deleteSlide(sessionId: string, slideId: string, options?: { clientRequestId?: string }): Promise<void> {
    const headers = { ...(getHeaders() as Record<string, string>) };
    if (options?.clientRequestId) {
        headers['X-Client-Request-Id'] = options.clientRequestId;
    }

    let res: Response;

    try {
        res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/slides/${slideId}`, {
            method: 'DELETE',
            headers,
        });
    } catch (error) {
        throw toApiRequestError(error, 'Failed to delete slide');
    }
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    if (!res.ok) throw await buildApiError(res, 'Failed to delete slide');
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new ApiRequestError(json.error || 'Failed to delete slide', { status: res.status });
}

export async function reorderSlides(sessionId: string, slideIds: string[]): Promise<void> {
    if (slideIds.length === 0) {
        return;
    }

    const uniqueIds = new Set(slideIds);
    if (uniqueIds.size !== slideIds.length) {
        console.error('Reorder request contains duplicate slide IDs');
        return;
    }

    let res: Response;

    try {
        res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/slides/reorder`, {
            method: 'PUT',
            headers: getHeaders(),
            body: JSON.stringify({ slideIds }),
        });
    } catch (error) {
        throw toApiRequestError(error, 'Failed to reorder slides');
    }
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    if (!res.ok) throw await buildApiError(res, 'Failed to reorder slides');
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new ApiRequestError(json.error || 'Failed to reorder slides', { status: res.status });
}

export async function updateSlideVisibility(sessionId: string, slideId: string, isHidden: boolean): Promise<void> {
    let res: Response;

    try {
        res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/slides/${slideId}/visibility`, {
            method: 'PATCH',
            headers: getHeaders(),
            body: JSON.stringify({ isHidden }),
        });
    } catch (error) {
        throw toApiRequestError(error, 'Failed to update slide visibility');
    }
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    if (!res.ok) throw await buildApiError(res, 'Failed to update slide visibility');
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new ApiRequestError(json.error || 'Failed to update slide visibility', { status: res.status });
}

/**
 * Synchronize the entire slide collection in a single request.
 * Round trips: 1 (replaces createSlide ×N + deleteSlide ×M + reorder + updateSlidesBatch)
 */
export async function syncSlides(
    sessionId: string,
    slides: Array<{
        id: string | null;
        type: string;
        content: unknown;
        isHidden?: boolean;
    }>,
    options?: {
        baseVersions?: Record<string, number>;
    },
): Promise<Slide[]> {
    let res: Response;

    try {
        res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/slides/sync`, {
            method: 'PATCH',
            headers: getHeaders(),
            body: JSON.stringify({
                slides: slides.map(s => ({
                    id: s.id,
                    type: s.type,
                    content: s.content,
                    isHidden: s.isHidden ?? false,
                })),
                ...(options?.baseVersions ? { baseVersions: options.baseVersions } : {}),
            }),
        });
    } catch (error) {
        throw toApiRequestError(error, 'Failed to sync slides');
    }
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    if (!res.ok) throw await buildApiError(res, 'Failed to sync slides');
    const json: ApiResponse<{ slides: Slide[]; stateVersion: number }> = await res.json();
    if (!json.success) throw new ApiRequestError(json.error || 'Failed to sync slides', { status: res.status });
    return json.data.slides;
}

export async function goLiveSession(sessionId: string): Promise<void> {
    const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/go-live`, {
        method: 'POST',
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to go live');
}

export async function stopSession(sessionId: string): Promise<void> {
    const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/stop`, {
        method: 'POST',
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to stop session');
}

// ============ Public Clicker API (no auth required) ============

export async function publicSetCurrentSlide(sessionId: string, slideId: string | null): Promise<StateUpdatePayload> {
    let res: Response;

    try {
        res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/clicker/slide`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slideId }),
        }, 2);
    } catch (error) {
        throw toApiRequestError(error, 'Failed to set slide');
    }

    if (!res.ok) {
        throw await buildApiError(res, 'Failed to set slide');
    }

    const json: ApiResponse<StateUpdatePayload> = await res.json();
    if (!json.success || !json.data) {
        throw new ApiRequestError(json.error || 'Failed to set slide', { status: res.status });
    }

    return json.data;
}

export async function publicSetResultsVisibility(sessionId: string, visible: boolean): Promise<void> {
    try {
        const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/clicker/results`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visible }),
        }, 2);
        if (!res.ok) return;
        const text = await res.text();
        if (!text) return;
        const json: ApiResponse<void> = JSON.parse(text);
        if (!json.success) console.error(json.error || 'Failed to set results visibility');
    } catch (e) {
        console.error('Error setting results visibility:', e);
    }
}

export async function publicGetSlides(sessionId: string): Promise<Slide[]> {
    try {
        const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/state`);
        if (!res.ok) return [];
        const json = await res.json();
        return json.slides || [];
    } catch (e) {
        console.error('Error fetching slides:', e);
        return [];
    }
}
