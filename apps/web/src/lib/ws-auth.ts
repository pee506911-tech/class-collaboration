/**
 * Fetch a short-lived JWT that authenticates the WebSocket upgrade.
 *
 * The backend endpoint is GET /api/auth/ws-token with query params:
 *   - sessionId: string
 *   - role: 'staff' | 'student' | 'projector'
 *   - participantId: string (optional)
 *
 * The response is { token: string } where token is a signed JWT.
 * The browser automatically sends the auth cookie with this request.
 */

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
 * @throws Error if the request fails or the response doesn't contain a token
 */
export async function fetchWsToken({
    sessionId,
    role,
    participantId,
    apiUrl,
}: FetchWsTokenOptions): Promise<string> {
    const apiBase = apiUrl || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';

    const params = new URLSearchParams({
        sessionId,
        role,
    });

    if (participantId) {
        params.set('participantId', participantId);
    }

    const url = `${apiBase}/auth/ws-token?${params.toString()}`;

    const response = await fetch(url, {
        method: 'GET',
        credentials: 'include', // Send auth cookie
        headers: {
            'Accept': 'application/json',
        },
    });

    if (!response.ok) {
        throw new Error(`WS token fetch failed: HTTP ${response.status}`);
    }

    const data: WsTokenResponse = await response.json();

    if (!data.token || typeof data.token !== 'string') {
        throw new Error('WS token fetch response missing token field');
    }

    return data.token;
}
