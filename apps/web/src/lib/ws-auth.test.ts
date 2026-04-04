import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { fetchWsToken } from './ws-auth';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock localStorage
const mockStorage = new Map<string, string>();

const mockLocalStorage: Storage = {
    getItem: vi.fn((key: string) => mockStorage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { mockStorage.set(key, value); }),
    removeItem: vi.fn((key: string) => { mockStorage.delete(key); }),
    clear: vi.fn(() => { mockStorage.clear(); }),
    length: 0,
    key: vi.fn(),
};

Object.defineProperty(global, 'localStorage', {
    value: mockLocalStorage,
    writable: true,
});

Object.defineProperty(window, 'localStorage', {
    value: mockLocalStorage,
    writable: true,
});

describe('fetchWsToken', () => {
    beforeEach(() => {
        mockFetch.mockReset();
        mockStorage.clear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('fetches token from correct endpoint with all params', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ token: 'test-jwt-token' }),
        });

        const token = await fetchWsToken({
            sessionId: 'session-123',
            role: 'student',
            participantId: 'participant-456',
            apiUrl: 'http://localhost:8080/api',
        });

        expect(token).toBe('test-jwt-token');
        expect(mockFetch).toHaveBeenCalledWith(
            'http://localhost:8080/api/auth/ws-token?sessionId=session-123&role=student&participantId=participant-456',
            expect.objectContaining({
                method: 'GET',
                credentials: 'include',
                headers: expect.objectContaining({ 'Accept': 'application/json' }),
            })
        );
    });

    it('fetches token without participantId when not provided', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ token: 'test-jwt-token' }),
        });

        const token = await fetchWsToken({
            sessionId: 'session-123',
            role: 'staff',
        });

        expect(token).toBe('test-jwt-token');
        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining('role=staff'),
            expect.any(Object)
        );
        expect(mockFetch).not.toHaveBeenCalledWith(
            expect.stringContaining('participantId'),
            expect.any(Object)
        );
    });

    it('uses NEXT_PUBLIC_API_URL when apiUrl not provided', async () => {
        const originalEnv = process.env.NEXT_PUBLIC_API_URL;
        process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com/api';

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ token: 'test-jwt-token' }),
        });

        await fetchWsToken({
            sessionId: 'session-123',
            role: 'student',
        });

        // Check that the URL starts with the expected base
        const callArgs = mockFetch.mock.calls[0];
        expect(callArgs[0]).toContain('https://api.example.com/api/auth/ws-token');

        process.env.NEXT_PUBLIC_API_URL = originalEnv;
    });

    it('throws clear error when cookie auth fails (401) and no Bearer token available', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
        });

        // Ensure no token in storage (already cleared in beforeEach)
        expect(mockStorage.has('token')).toBe(false);

        await expect(
            fetchWsToken({
                sessionId: 'session-123',
                role: 'student',
            })
        ).rejects.toThrow('Authentication required: please log in again');

        // Should have tried Bearer fallback (even though no token, it checks and throws)
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws error immediately for non-401 failures (no Bearer retry)', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 500,
        });

        await expect(
            fetchWsToken({
                sessionId: 'session-123',
                role: 'student',
            })
        ).rejects.toThrow('WS token fetch failed: HTTP 500');

        // Should NOT retry with Bearer
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws error when response missing token', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ noToken: 'here' }),
        });

        await expect(
            fetchWsToken({
                sessionId: 'session-123',
                role: 'student',
            })
        ).rejects.toThrow('WS token fetch response missing token field');
    });

    it('throws error for all roles', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ token: 'staff-token' }),
        });

        const token = await fetchWsToken({
            sessionId: 'session-123',
            role: 'staff',
        });
        expect(token).toBe('staff-token');

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ token: 'projector-token' }),
        });

        const token2 = await fetchWsToken({
            sessionId: 'session-123',
            role: 'projector',
        });
        expect(token2).toBe('projector-token');
    });

    it('sends Bearer token from localStorage when cookie auth fails (401)', async () => {
        // Simulate cross-origin scenario where cookie is not sent
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
        });

        // Second attempt should include Bearer token
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ token: 'bearer-ws-token' }),
        });

        // Mock localStorage having the auth token
        mockStorage.set('token', 'auth-token-123');

        const token = await fetchWsToken({
            sessionId: 'session-123',
            role: 'staff',
        });

        expect(token).toBe('bearer-ws-token');
        expect(mockFetch).toHaveBeenCalledTimes(2);

        // First call: cookie-based (failed)
        expect(mockFetch).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('/auth/ws-token'),
            expect.objectContaining({
                credentials: 'include',
                headers: { 'Accept': 'application/json' },
            })
        );

        // Second call: Bearer token fallback
        expect(mockFetch).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('/auth/ws-token'),
            expect.objectContaining({
                credentials: 'include',
                headers: {
                    'Accept': 'application/json',
                    'Authorization': 'Bearer auth-token-123',
                },
            })
        );
    });

    it('throws clear error when both cookie and Bearer token auth fail', async () => {
        // Both attempts fail
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
        });
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
        });

        // Mock localStorage having a token (so it tries Bearer)
        mockStorage.set('token', 'expired-token');

        await expect(
            fetchWsToken({
                sessionId: 'session-123',
                role: 'staff',
            })
        ).rejects.toThrow('WS token fetch failed: HTTP 401');
    });

    it('does not retry when cookie auth succeeds', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ token: 'cookie-token' }),
        });

        const token = await fetchWsToken({
            sessionId: 'session-123',
            role: 'staff',
        });

        expect(token).toBe('cookie-token');
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});
