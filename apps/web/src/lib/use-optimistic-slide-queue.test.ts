import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Slide } from 'shared';
import React from 'react';

const apiMockState = vi.hoisted(() => ({
    createSlide: vi.fn(),
    deleteSlide: vi.fn(),
    updateSlide: vi.fn(),
    isRetryableApiError: vi.fn(() => false),
}));

vi.mock('@/lib/api', () => ({
    createSlide: apiMockState.createSlide,
    deleteSlide: apiMockState.deleteSlide,
    updateSlide: apiMockState.updateSlide,
    isRetryableApiError: apiMockState.isRetryableApiError,
    ApiRequestError: class ApiRequestError extends Error {
        status?: number;
        retryable?: boolean;

        constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
            super(message);
            this.name = 'ApiRequestError';
            this.status = options.status;
            this.retryable = options.retryable;
        }
    },
}));

import { useOptimisticSlideQueue } from './use-optimistic-slide-queue';

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

function makeSlide(overrides: Partial<Slide> = {}): Slide {
    return {
        id: 'slide-1',
        sessionId: 'session-1',
        type: 'static',
        content: { title: 'Server title', body: 'Server body' },
        orderIndex: 0,
        isHidden: false,
        version: 1,
        ...overrides,
    };
}

describe('useOptimisticSlideQueue', () => {
    beforeEach(() => {
        apiMockState.createSlide.mockReset();
        apiMockState.deleteSlide.mockReset();
        apiMockState.updateSlide.mockReset();
        apiMockState.isRetryableApiError.mockReset();
        apiMockState.isRetryableApiError.mockReturnValue(false);
    });

    it('defers a requested refresh until structural work drains', async () => {
        const createRequest = deferred<Slide>();
        const refreshBaseSlides = vi.fn().mockResolvedValue(undefined);

        apiMockState.createSlide.mockReturnValue(createRequest.promise);

        const { result } = renderHook(() => {
            const [baseSlides, setBaseSlides] = React.useState<Slide[]>([]);

            return useOptimisticSlideQueue({
                sessionId: 'session-1',
                baseSlides,
                setBaseSlides,
                refreshBaseSlides,
            });
        });

        act(() => {
            result.current.enqueueCreateSlide({
                slideType: 'static',
                content: { title: 'Local draft', body: 'Draft body' },
            });
        });

        await waitFor(() => {
            expect(apiMockState.createSlide).toHaveBeenCalledTimes(1);
            expect(result.current.hasPendingStructuralMutations).toBe(true);
        });

        act(() => {
            result.current.requestRefreshAfterDrain();
        });

        expect(refreshBaseSlides).not.toHaveBeenCalled();

        await act(async () => {
            createRequest.resolve(makeSlide({
                id: 'slide-2',
                content: { title: 'Local draft', body: 'Draft body' },
                version: 2,
            }));
            await createRequest.promise;
        });

        await waitFor(() => {
            expect(result.current.hasPendingStructuralMutations).toBe(false);
            expect(refreshBaseSlides).toHaveBeenCalledTimes(1);
        });
    });
});
