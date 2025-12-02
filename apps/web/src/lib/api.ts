import { ApiResponse, Session, Slide } from 'shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';

function getHeaders(): HeadersInit {
    const headers: HeadersInit = {
        'Content-Type': 'application/json',
    };
    // Use Authorization header for cross-origin compatibility (works in incognito)
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

export async function login(email: string, password: string) {
    const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Login failed');
    // Store token in localStorage for Authorization header
    localStorage.setItem('token', json.token);
    localStorage.setItem('user', JSON.stringify(json.user));
    return json;
}

export async function register(email: string, password: string, name: string, role: string) {
    const res = await fetch(`${API_URL}/auth/register`, {
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
    const res = await fetch(url, {
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); return []; }
    const json: ApiResponse<Session[]> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to fetch sessions');
    return json.data;
}

export async function getSession(sessionId: string): Promise<Session> {
    const res = await fetch(`${API_URL}/sessions/${sessionId}`, { headers: getHeaders() });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<Session> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to fetch session');
    return json.data;
}

export async function duplicateSession(sessionId: string): Promise<Session> {
    const res = await fetch(`${API_URL}/sessions/${sessionId}/duplicate`, {
        method: 'POST',
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<Session> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to duplicate session');
    return json.data;
}

export async function archiveSession(sessionId: string): Promise<void> {
    const res = await fetch(`${API_URL}/sessions/${sessionId}/archive`, {
        method: 'PUT',
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to archive session');
}

export async function restoreSession(sessionId: string): Promise<void> {
    const res = await fetch(`${API_URL}/sessions/${sessionId}/restore`, {
        method: 'PUT',
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to restore session');
}

export async function createSession(title: string, allowQuestions: boolean = false, requireName: boolean = false): Promise<Session> {
    const res = await fetch(`${API_URL}/sessions`, {
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
    const res = await fetch(`${API_URL}/sessions/${sessionId}`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ title, allowQuestions, requireName }),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to update session');
}

export async function deleteSession(sessionId: string): Promise<void> {
    const res = await fetch(`${API_URL}/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to delete session');
}

export async function getSlides(sessionId: string): Promise<Slide[]> {
    const res = await fetch(`${API_URL}/sessions/${sessionId}/slides`, { headers: getHeaders() });
    if (res.status === 401) { logout(); return []; }
    const json: ApiResponse<Slide[]> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to fetch slides');
    return json.data;
}

export async function createSlide(sessionId: string, type: string, content: any): Promise<Slide> {
    const res = await fetch(`${API_URL}/sessions/${sessionId}/slides`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ type, content }),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<Slide> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to create slide');
    return json.data;
}

export async function updateSlide(sessionId: string, slideId: string, content: any): Promise<void> {
    const res = await fetch(`${API_URL}/sessions/${sessionId}/slides/${slideId}`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ content }),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to update slide');
}

export async function deleteSlide(sessionId: string, slideId: string): Promise<void> {
    const res = await fetch(`${API_URL}/sessions/${sessionId}/slides/${slideId}`, {
        method: 'DELETE',
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to delete slide');
}

export async function reorderSlides(sessionId: string, slideIds: string[]): Promise<void> {
    const res = await fetch(`${API_URL}/sessions/${sessionId}/slides/reorder`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ slideIds }),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to reorder slides');
}

export async function updateSlideVisibility(sessionId: string, slideId: string, isHidden: boolean): Promise<void> {
    const res = await fetch(`${API_URL}/sessions/${sessionId}/slides/${slideId}/visibility`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ isHidden }),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to update slide visibility');
}

export async function goLiveSession(sessionId: string): Promise<void> {
    const res = await fetch(`${API_URL}/sessions/${sessionId}/go-live`, {
        method: 'POST',
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to go live');
}

export async function stopSession(sessionId: string): Promise<void> {
    const res = await fetch(`${API_URL}/sessions/${sessionId}/stop`, {
        method: 'POST',
        headers: getHeaders(),
    });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const json: ApiResponse<void> = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to stop session');
}
