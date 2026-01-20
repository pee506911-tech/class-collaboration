import { ApiResponse, Participant, Question, Session, Slide } from 'shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';

// Retry configuration for cold start handling
const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 5000,
};

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(
    url: string,
    options: RequestInit = {},
    retries = RETRY_CONFIG.maxRetries
): Promise<Response> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
            
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
            });
            
            clearTimeout(timeoutId);
            
            // Retry on 503 (service unavailable - cold start)
            if (response.status === 503 && attempt < retries) {
                const delay = Math.min(
                    RETRY_CONFIG.baseDelay * Math.pow(2, attempt),
                    RETRY_CONFIG.maxDelay
                );
                console.log(`Backend warming up, retrying in ${delay}ms...`);
                await sleep(delay);
                continue;
            }
            
            return response;
        } catch (error: unknown) {
            lastError = error instanceof Error ? error : new Error('Request failed');
            
            // Retry on network errors or timeouts
            const isAbortError = error instanceof DOMException && error.name === 'AbortError';
            const isTypeError = error instanceof TypeError;
            if (attempt < retries && (isAbortError || isTypeError)) {
                const delay = Math.min(
                    RETRY_CONFIG.baseDelay * Math.pow(2, attempt),
                    RETRY_CONFIG.maxDelay
                );
                console.log(`Request failed, retrying in ${delay}ms...`, lastError.message);
                await sleep(delay);
                continue;
            }
        }
    }
    
    throw lastError || new Error('Request failed after retries');
}

function getHeaders(): HeadersInit {
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
}

export async function login(email: string, password: string) {
    const res = await fetchWithRetry(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Login failed');
    localStorage.setItem('token', json.token);
    localStorage.setItem('user', JSON.stringify(json.user));
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
    localStorage.removeItem('token');
    localStorage.removeItem('user');
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

export type VoteStats = {
    votes?: Record<string, number>;
};

export type SlideWithStats = Slide & {
    stats?: VoteStats | null;
};

export type PublicSessionResponse = {
    id: string;
    title: string;
    status: string;
    createdAt: string;
    updatedAt?: string;
    slides: SlideWithStats[];
    questions: Question[];
    participants: Participant[];
};

export async function getPublicSessionByShareToken(token: string): Promise<PublicSessionResponse> {
    const res = await fetchWithRetry(`${API_URL}/share/${token}`);
    if (!res.ok) throw new Error('Session not found');
    const json: ApiResponse<PublicSessionResponse> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load session');
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

export async function createSlide(sessionId: string, type: string, content: unknown): Promise<Slide> {
    const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/slides`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ type, content }),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<Slide> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to create slide');
    return json.data;
}

export async function updateSlide(sessionId: string, slideId: string, content: unknown): Promise<void> {
    const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/slides/${slideId}`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ content }),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to update slide');
}

export async function deleteSlide(sessionId: string, slideId: string): Promise<void> {
    const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/slides/${slideId}`, {
        method: 'DELETE',
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to delete slide');
}

export async function reorderSlides(sessionId: string, slideIds: string[]): Promise<void> {
    const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/slides/reorder`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ slideIds }),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to reorder slides');
}

export async function updateSlideVisibility(sessionId: string, slideId: string, isHidden: boolean): Promise<void> {
    const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/slides/${slideId}/visibility`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ isHidden }),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to update slide visibility');
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

export async function publicSetCurrentSlide(sessionId: string, slideId: string | null): Promise<void> {
    try {
        const res = await fetchWithRetry(`${API_URL}/sessions/${sessionId}/clicker/slide`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slideId }),
        }, 2); // Fewer retries for non-critical
        if (!res.ok) return;
        const text = await res.text();
        if (!text) return;
        const json: ApiResponse<void> = JSON.parse(text);
        if (!json.success) console.error(json.error || 'Failed to set slide');
    } catch (e) {
        console.error('Error setting slide:', e);
    }
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
