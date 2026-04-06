import { describe, expect, it, vi } from 'vitest';

import {
    reconcileCreatedSlide,
    commitCreateSlide,
    commitDeleteSlide,
    commitReorderSlides,
    createSlideEditCommitter,
} from './editor-slide-sync';

const apiMocks = vi.hoisted(() => ({
    createSlide: vi.fn(),
    deleteSlide: vi.fn(),
    reorderSlides: vi.fn(),
    updateSlide: vi.fn(),
}));

vi.mock('@/lib/api', () => apiMocks);

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

describe('createSlideEditCommitter', () => {
    it('commits the latest queued content for the same slide after the in-flight save settles', async () => {
        const firstSave = deferred<void>();
        const secondSave = deferred<void>();

        apiMocks.updateSlide
            .mockReturnValueOnce(firstSave.promise)
            .mockReturnValueOnce(secondSave.promise);

        const committer = createSlideEditCommitter('session-1');

        committer.schedule({
            slideId: 'slide-1',
            content: { title: 'Draft A' },
        });

        committer.schedule({
            slideId: 'slide-1',
            content: { title: 'Draft B' },
        });

        expect(apiMocks.updateSlide).toHaveBeenCalledTimes(1);
        expect(apiMocks.updateSlide).toHaveBeenNthCalledWith(
            1,
            'session-1',
            'slide-1',
            { title: 'Draft A' },
        );

        firstSave.resolve();
        await firstSave.promise;
        await Promise.resolve();

        expect(apiMocks.updateSlide).toHaveBeenCalledTimes(2);
        expect(apiMocks.updateSlide).toHaveBeenNthCalledWith(
            2,
            'session-1',
            'slide-1',
            { title: 'Draft B' },
        );

        secondSave.resolve();
        await secondSave.promise;
    });
});

describe('slide structural commit helpers', () => {
    it('preserves local temp-slide edits when the server confirms the created slide', () => {
        const result = reconcileCreatedSlide({
            localSlide: {
                id: 'temp-1',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'Edited after duplicate', body: 'Draft body' },
                orderIndex: 3,
                isHidden: false,
                version: 0,
            },
            serverSlide: {
                id: 'slide-99',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'Original copy', body: 'Original body' },
                orderIndex: 7,
                isHidden: false,
                version: 1,
            },
        });

        expect(result.slide).toEqual({
            id: 'slide-99',
            sessionId: 'session-1',
            type: 'static',
            content: { title: 'Edited after duplicate', body: 'Draft body' },
            orderIndex: 3,
            isHidden: false,
            version: 1,
        });
        expect(result.contentNeedingSync).toEqual({ title: 'Edited after duplicate', body: 'Draft body' });
    });

    it('uses the server slide directly when the temp slide was not edited locally', () => {
        const result = reconcileCreatedSlide({
            localSlide: {
                id: 'temp-1',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'Original copy', body: 'Original body' },
                orderIndex: 3,
                isHidden: false,
                version: 0,
            },
            serverSlide: {
                id: 'slide-99',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'Original copy', body: 'Original body' },
                orderIndex: 7,
                isHidden: false,
                version: 1,
            },
        });

        expect(result.slide).toEqual({
            id: 'slide-99',
            sessionId: 'session-1',
            type: 'static',
            content: { title: 'Original copy', body: 'Original body' },
            orderIndex: 3,
            isHidden: false,
            version: 1,
        });
        expect(result.contentNeedingSync).toBeNull();
    });

    it('forwards insertAfterSlideId to createSlide', async () => {
        apiMocks.createSlide.mockResolvedValueOnce({ id: 'slide-2' });

        await commitCreateSlide(
            'session-1',
            'static',
            { title: 'Duplicate' },
            { insertAfterSlideId: 'slide-1' },
        );

        expect(apiMocks.createSlide).toHaveBeenCalledWith(
            'session-1',
            'static',
            { title: 'Duplicate' },
            { insertAfterSlideId: 'slide-1' },
        );
    });

    it('does not swallow create failures', async () => {
        apiMocks.createSlide.mockRejectedValueOnce(new Error('create failed'));

        await expect(
            commitCreateSlide('session-1', 'static', { title: 'New slide' }),
        ).rejects.toThrow('create failed');
    });

    it('does not swallow delete failures', async () => {
        apiMocks.deleteSlide.mockRejectedValueOnce(new Error('delete failed'));

        await expect(
            commitDeleteSlide('session-1', 'slide-1'),
        ).rejects.toThrow('delete failed');
    });

    it('does not swallow reorder failures', async () => {
        apiMocks.reorderSlides.mockRejectedValueOnce(new Error('reorder failed'));

        await expect(
            commitReorderSlides('session-1', ['slide-2', 'slide-1']),
        ).rejects.toThrow('reorder failed');
    });
});
