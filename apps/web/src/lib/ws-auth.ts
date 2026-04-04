/**
 * Fetch a short-lived JWT that authenticates the WebSocket upgrade.
 *
 * The backend endpoint is GET /api/auth/ws-token with query params:
 *   - sessionId: string
 *   - role: 'staff' | 'student' | 'projector'
 *   - participantId: string (optional)
 *
 * The response is { token: string } where token is a signed JWT.
 * Authentication methods (tried in order):
 *   1. HTTP-only cookie (automatically sent by browser)
 *   2. Bearer token from localStorage (fallback for cross-origin scenarios)
 */

import { safeLocalStorageGet } from './storage';
import { trimTrailingSlash } from './url';

export interface WsTokenResponse {
    token: string;
}

export interface FetchWsTokenOptions {
    sessionId: string;
    role: 'staff' | 'student' | 'projector';
    participantId?: string;
    apiUrl?: string; // Override NEXT_PUBLIC_API_URL for testing
}

/**
 * Fetch a WS token from the backend.
 *
 * Tries cookie-based auth first, then falls back to Bearer token from localStorage
 * if the cookie auth fails with 401 (common in cross-origin deployments).
 *
 * @throws Error with message 'Authentication required: please log in again' if no valid auth
 * @throws Error if the request fails for other reasons or response doesn't contain a token
 */
export async function fetchWsToken({
    sessionId,
    role,
    participantId,
    apiUrl,
}: FetchWsTokenOptions): Promise<string> {
    const apiBase = trimTrailingSlash(apiUrl || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api');

    const params = new URLSearchParams({
        sessionId,
        role,
    });

    if (participantId) {
        params.set('participantId', participantId);
    }

    const url = `${apiBase}/auth/ws-token?${params.toString()}`;

    if (shouldPreferBearerAuth(apiBase)) {
        return fetchWithBearerToken(url);
    }

    // Try 1: Cookie-based auth (works for same-origin or properly configured cross-origin)
    const cookieResponse = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
            'Accept': 'application/json',
        },
    });

    if (cookieResponse.ok) {
        return extractToken(cookieResponse);
    }

    // If cookie auth failed with 401, try Bearer token from localStorage
    if (cookieResponse.status === 401) {
        return fetchWithBearerToken(url);
    }

    // Other errors - throw immediately
    throw new Error(`WS token fetch failed: HTTP ${cookieResponse.status}`);
}

async function extractToken(response: Response): Promise<string> {
    const data: WsTokenResponse = await response.json();

    if (!data.token || typeof data.token !== 'string') {
        throw new Error('WS token fetch response missing token field');
    }

    return data.token;
}

async function fetchWithBearerToken(url: string): Promise<string> {
    const token = safeLocalStorageGet('token');

    if (!token) {
        throw new Error('Authentication required: please log in again');
    }

    const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        throw new Error(`WS token fetch failed: HTTP ${response.status}`);
    }

    return extractToken(response);
}

function shouldPreferBearerAuth(apiBase: string): boolean {
    if (typeof window === 'undefined') {
        return false;
    }

    const token = safeLocalStorageGet('token');
    if (!token) {
        return false;
    }

    try {
        const apiOrigin = new URL(apiBase).origin;
        return apiOrigin !== window.location.origin;
    } catch {
        return false;
    }
}
