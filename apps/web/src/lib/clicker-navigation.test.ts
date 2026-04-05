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
        const commitSlide = vi.fn<(slideId: { slideId: string; intentSeq: number }) => Promise<void>>()
            .mockReturnValueOnce(firstCommit.promise)
            .mockReturnValueOnce(secondCommit.promise);

        const committer = createLatestOnlySlideCommitter(commitSlide);

        committer.schedule({ slideId: 'slide-2', intentSeq: 1 });
        committer.schedule({ slideId: 'slide-3', intentSeq: 2 });
        committer.schedule({ slideId: 'slide-4', intentSeq: 3 });

        expect(commitSlide).toHaveBeenCalledTimes(1);
        expect(commitSlide).toHaveBeenNthCalledWith(1, { slideId: 'slide-2', intentSeq: 1 });

        firstCommit.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(commitSlide).toHaveBeenCalledTimes(2);
        expect(commitSlide).toHaveBeenNthCalledWith(2, { slideId: 'slide-4', intentSeq: 3 });

        secondCommit.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(commitSlide).toHaveBeenCalledTimes(2);
    });
});

describe('reconcilePendingSlide', () => {
    it('ignores stale remote slides while a newer local target is pending', () => {
        expect(reconcilePendingSlide({ slideId: 'slide-4', intentSeq: 3 }, 'slide-2')).toEqual({
            shouldApply: false,
            pendingIntent: { slideId: 'slide-4', intentSeq: 3 },
        });
    });

    it('clears the pending target once the remote state catches up', () => {
        expect(reconcilePendingSlide({ slideId: 'slide-4', intentSeq: 3 }, 'slide-4')).toEqual({
            shouldApply: true,
            pendingIntent: null,
        });
    });

    it('applies remote slides immediately when no local target is pending', () => {
        expect(reconcilePendingSlide(null, 'slide-2')).toEqual({
            shouldApply: true,
            pendingIntent: null,
        });
    });
});
