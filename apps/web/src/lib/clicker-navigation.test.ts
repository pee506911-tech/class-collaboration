import { describe, expect, it, vi } from 'vitest';
import { createLatestOnlySlideCommitter, reconcilePendingSlide } from './clicker-navigation';

function createDeferred() {
    let resolve!: () => void;

    return {
        promise: new Promise<void>((nextResolve) => {
            resolve = nextResolve;
        }),
        resolve,
    };
}

describe('createLatestOnlySlideCommitter', () => {
    it('serializes slide commits and only keeps the latest queued slide', async () => {
        const firstCommit = createDeferred();
        const secondCommit = createDeferred();
        const commitSlide = vi.fn<(slideId: string) => Promise<void>>()
            .mockReturnValueOnce(firstCommit.promise)
            .mockReturnValueOnce(secondCommit.promise);

        const committer = createLatestOnlySlideCommitter(commitSlide);

        committer.schedule('slide-2');
        committer.schedule('slide-3');
        committer.schedule('slide-4');

        expect(commitSlide).toHaveBeenCalledTimes(1);
        expect(commitSlide).toHaveBeenNthCalledWith(1, 'slide-2');

        firstCommit.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(commitSlide).toHaveBeenCalledTimes(2);
        expect(commitSlide).toHaveBeenNthCalledWith(2, 'slide-4');

        secondCommit.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(commitSlide).toHaveBeenCalledTimes(2);
    });
});

describe('reconcilePendingSlide', () => {
    it('ignores stale remote slides while a newer local target is pending', () => {
        expect(reconcilePendingSlide('slide-4', 'slide-2')).toEqual({
            shouldApply: false,
            pendingSlideId: 'slide-4',
        });
    });

    it('clears the pending target once the remote state catches up', () => {
        expect(reconcilePendingSlide('slide-4', 'slide-4')).toEqual({
            shouldApply: true,
            pendingSlideId: null,
        });
    });

    it('applies remote slides immediately when no local target is pending', () => {
        expect(reconcilePendingSlide(null, 'slide-2')).toEqual({
            shouldApply: true,
            pendingSlideId: null,
        });
    });
});
