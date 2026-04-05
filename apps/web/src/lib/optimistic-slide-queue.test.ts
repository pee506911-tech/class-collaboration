import { describe, expect, it } from 'vitest';
import { Slide } from 'shared';

import {
    applyCreateLikeSuccessToBaseSlides,
    canEnqueueDelete,
    discardCreateLikeOp,
    deriveOptimisticSlides,
    enqueueDelete,
    enqueueDuplicate,
    failOpPermanently,
    initialStructuralQueueState,
    markOpSending,
    resolveCreateLikeSuccess,
    resolveSlideId,
    updateCreateLikeDraft,
} from './optimistic-slide-queue';

function makeSlide(id: string, orderIndex: number): Slide {
    return {
        id,
        sessionId: 'session-1',
        type: 'static',
        content: { title: id, body: `${id} body` },
        orderIndex,
        isHidden: false,
        version: 0,
    };
}

describe('optimistic slide queue', () => {
    it('renders rapid duplicates immediately in click order', () => {
        const baseSlides = [makeSlide('A', 0), makeSlide('B', 1)];
        let state = initialStructuralQueueState;

        state = enqueueDuplicate(state, baseSlides, {
            opId: 'dup-1',
            tempId: 'temp-1',
            sessionId: 'session-1',
            clientRequestId: 'req-1',
            sourceSlide: baseSlides[0],
        });

        state = enqueueDuplicate(state, baseSlides, {
            opId: 'dup-2',
            tempId: 'temp-2',
            sessionId: 'session-1',
            clientRequestId: 'req-2',
            sourceSlide: baseSlides[0],
        });

        state = enqueueDuplicate(state, baseSlides, {
            opId: 'dup-3',
            tempId: 'temp-3',
            sessionId: 'session-1',
            clientRequestId: 'req-3',
            sourceSlide: baseSlides[0],
        });

        const slides = deriveOptimisticSlides(baseSlides, state);

        expect(slides.map((slide) => slide.id)).toEqual(['A', 'temp-1', 'temp-2', 'temp-3', 'B']);
        expect(state.optimisticOps['dup-2']).toMatchObject({ afterId: 'temp-1', dependsOn: 'dup-1' });
        expect(state.optimisticOps['dup-3']).toMatchObject({ afterId: 'temp-2', dependsOn: 'dup-2' });
    });

    it('reconciles temp ids to real ids while preserving queued ordering', () => {
        const baseSlides = [makeSlide('A', 0), makeSlide('B', 1)];
        let state = initialStructuralQueueState;

        state = enqueueDuplicate(state, baseSlides, {
            opId: 'dup-1',
            tempId: 'temp-1',
            sessionId: 'session-1',
            clientRequestId: 'req-1',
            sourceSlide: baseSlides[0],
        });

        state = enqueueDuplicate(state, baseSlides, {
            opId: 'dup-2',
            tempId: 'temp-2',
            sessionId: 'session-1',
            clientRequestId: 'req-2',
            sourceSlide: baseSlides[0],
        });

        const dup1 = state.optimisticOps['dup-1'];
        if (!dup1 || dup1.type === 'delete') {
            throw new Error('expected duplicate op');
        }

        const nextBaseSlides = applyCreateLikeSuccessToBaseSlides(baseSlides, dup1, makeSlide('S101', 999), state.tempIdMap);
        state = resolveCreateLikeSuccess(state, 'dup-1', 'S101');

        expect(resolveSlideId('temp-1', state.tempIdMap)).toBe('S101');
        expect(deriveOptimisticSlides(nextBaseSlides, state).map((slide) => slide.id)).toEqual(['A', 'S101', 'temp-2', 'B']);
    });

    it('retains failed temp subtrees on the canvas with an error state', () => {
        const baseSlides = [makeSlide('A', 0), makeSlide('B', 1)];
        let state = initialStructuralQueueState;

        state = enqueueDuplicate(state, baseSlides, {
            opId: 'dup-1',
            tempId: 'temp-1',
            sessionId: 'session-1',
            clientRequestId: 'req-1',
            sourceSlide: baseSlides[0],
        });
        state = enqueueDuplicate(state, baseSlides, {
            opId: 'dup-2',
            tempId: 'temp-2',
            sessionId: 'session-1',
            clientRequestId: 'req-2',
            sourceSlide: baseSlides[0],
        });

        state = failOpPermanently(state, 'dup-1', 'Duplicate failed');

        expect(state.queue).toEqual([]);
        expect(Object.keys(state.optimisticOps)).toEqual(['dup-1', 'dup-2']);
        expect(deriveOptimisticSlides(baseSlides, state).map((slide) => slide.id)).toEqual(['A', 'temp-1', 'temp-2', 'B']);
        expect(deriveOptimisticSlides(baseSlides, state)[1].optimistic).toMatchObject({
            syncState: 'failed',
            error: 'Duplicate failed',
        });
    });

    it('hides deleted slides immediately and blocks duplicate pending deletes', () => {
        const baseSlides = [makeSlide('A', 0), makeSlide('B', 1)];
        let state = enqueueDelete(initialStructuralQueueState, {
            opId: 'del-1',
            sessionId: 'session-1',
            targetId: 'A',
            clientRequestId: 'req-1',
            restorePreviewSlideId: 'A',
            fallbackPreviewSlideId: 'B',
            deletedSlide: baseSlides[0],
        });

        expect(canEnqueueDelete(state, 'A')).toBe(false);
        expect(deriveOptimisticSlides(baseSlides, state).map((slide) => slide.id)).toEqual(['B']);
    });

    it('keeps temp slide drafts editable before and during send', () => {
        const baseSlides = [makeSlide('A', 0)];
        let state = enqueueDuplicate(initialStructuralQueueState, baseSlides, {
            opId: 'dup-1',
            tempId: 'temp-1',
            sessionId: 'session-1',
            clientRequestId: 'req-1',
            sourceSlide: baseSlides[0],
        });

        state = updateCreateLikeDraft(state, 'temp-1', {
            title: 'Edited before send',
            body: 'Local body',
        });

        let slides = deriveOptimisticSlides(baseSlides, state);
        expect(slides.find((slide) => slide.id === 'temp-1')?.content).toEqual({
            title: 'Edited before send',
            body: 'Local body',
        });

        state = markOpSending(state, 'dup-1');
        state = updateCreateLikeDraft(state, 'temp-1', {
            title: 'Edited while sending',
            body: 'Newest body',
        });

        slides = deriveOptimisticSlides(baseSlides, state);
        expect(slides.find((slide) => slide.id === 'temp-1')?.content).toEqual({
            title: 'Edited while sending',
            body: 'Newest body',
        });
        expect(state.optimisticOps['dup-1']).toMatchObject({
            status: 'sending',
            sentContent: { title: 'Edited before send', body: 'Local body' },
            payload: { content: { title: 'Edited while sending', body: 'Newest body' } },
        });
    });

    it('retains failed temp slides with their draft and error state', () => {
        const baseSlides = [makeSlide('A', 0)];
        let state = enqueueDuplicate(initialStructuralQueueState, baseSlides, {
            opId: 'dup-1',
            tempId: 'temp-1',
            sessionId: 'session-1',
            clientRequestId: 'req-1',
            sourceSlide: baseSlides[0],
        });

        state = updateCreateLikeDraft(state, 'temp-1', {
            title: 'Edited draft',
            body: 'Keep me',
        });
        state = failOpPermanently(state, 'dup-1', 'Failed to save slide');

        const slides = deriveOptimisticSlides(baseSlides, state);
        expect(state.queue).toEqual([]);
        expect(slides.map((slide) => slide.id)).toEqual(['A', 'temp-1']);
        expect(slides[1]).toMatchObject({
            content: { title: 'Edited draft', body: 'Keep me' },
            optimistic: {
                syncState: 'failed',
                isPending: false,
                error: 'Failed to save slide',
            },
        });
    });

    it('can discard a retained temp slide after a failed sync', () => {
        const baseSlides = [makeSlide('A', 0)];
        let state = enqueueDuplicate(initialStructuralQueueState, baseSlides, {
            opId: 'dup-1',
            tempId: 'temp-1',
            sessionId: 'session-1',
            clientRequestId: 'req-1',
            sourceSlide: baseSlides[0],
        });
        state = failOpPermanently(state, 'dup-1', 'Failed to save slide');
        state = discardCreateLikeOp(state, 'temp-1');

        expect(deriveOptimisticSlides(baseSlides, state).map((slide) => slide.id)).toEqual(['A']);
    });
});
