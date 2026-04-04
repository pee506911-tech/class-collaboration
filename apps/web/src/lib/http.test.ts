import { describe, it, expect, beforeEach, vi } from 'vitest';
import { httpFetch } from './http';

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

describe('httpFetch with Authorization header', () => {
    beforeEach(() => {
        mockFetch.mockReset();
        mockStorage.clear();
    });

    it('preserves Authorization header from options', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, data: {} }),
            headers: { get: () => null },
        });

        await httpFetch('https://api.example.com/test', {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer test-token-123',
            },
        });

        expect(mockFetch).toHaveBeenCalledWith(
            'https://api.example.com/test',
            expect.objectContaining({
                headers: expect.any(Headers),
            })
        );

        const callArgs = mockFetch.mock.calls[0][1];
        const headers = callArgs.headers as Headers;
        expect(headers.get('Authorization')).toBe('Bearer test-token-123');
        expect(headers.get('Content-Type')).toBe('application/json');
    });

    it('includes X-Client-Request-Id header', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, data: {} }),
            headers: { get: () => null },
        });

        await httpFetch('https://api.example.com/test');

        const callArgs = mockFetch.mock.calls[0][1];
        const headers = callArgs.headers as Headers;
        expect(headers.get('X-Client-Request-Id')).toBeTruthy();
    });

    it('automatically adds Bearer token from localStorage when not provided', async () => {
        mockStorage.set('token', 'auto-token-123');
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, data: {} }),
            headers: { get: () => null },
        });

        await httpFetch('https://api.example.com/test');

        const callArgs = mockFetch.mock.calls[0][1];
        const headers = callArgs.headers as Headers;
        expect(headers.get('Authorization')).toBe('Bearer auto-token-123');
    });

    it('does not override Authorization header when already present', async () => {
        mockStorage.set('token', 'should-not-be-used');
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, data: {} }),
            headers: { get: () => null },
        });

        await httpFetch('https://api.example.com/test', {
            headers: {
                'Authorization': 'Bearer explicit-token-456',
            },
        });

        const callArgs = mockFetch.mock.calls[0][1];
        const headers = callArgs.headers as Headers;
        expect(headers.get('Authorization')).toBe('Bearer explicit-token-456');
    });

    it('sends request without Authorization when no token in localStorage', async () => {
        // localStorage is empty (cleared in beforeEach)
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, data: {} }),
            headers: { get: () => null },
        });

        await httpFetch('https://api.example.com/test');

        const callArgs = mockFetch.mock.calls[0][1];
        const headers = callArgs.headers as Headers;
        expect(headers.has('Authorization')).toBe(false);
    });

    it('still sends request even when localStorage token is expired', async () => {
        // Old users might have expired tokens - we still send it
        // Backend will return 401, and callers should handle it
        mockStorage.set('token', 'expired-token-old');
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, data: {} }),
            headers: { get: () => null },
        });

        await httpFetch('https://api.example.com/test');

        const callArgs = mockFetch.mock.calls[0][1];
        const headers = callArgs.headers as Headers;
        // Token is sent even if expired - backend will validate
        expect(headers.get('Authorization')).toBe('Bearer expired-token-old');
    });
});
