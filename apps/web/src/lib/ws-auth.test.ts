import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fetchWsToken } from './ws-auth';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('fetchWsToken', () => {
    beforeEach(() => {
        mockFetch.mockReset();
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
            {
                method: 'GET',
                credentials: 'include',
                headers: { 'Accept': 'application/json' },
            }
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

    it('throws error when fetch fails', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
        });

        await expect(
            fetchWsToken({
                sessionId: 'session-123',
                role: 'student',
            })
        ).rejects.toThrow('WS token fetch failed: HTTP 401');
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
});
