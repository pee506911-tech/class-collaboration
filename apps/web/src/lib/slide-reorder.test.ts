import { describe, expect, it, vi } from 'vitest';
import type { Slide } from 'shared';

import { reorderSlidesByIndex, reorderSlidesWithRollback } from './slide-reorder';

function makeSlides(): Slide[] {
    return [
        {
            id: 'slide-1',
            sessionId: 'session-1',
            type: 'poll',
            content: { question: 'First' },
            orderIndex: 0,
            isHidden: false,
            version: 1,
        },
        {
            id: 'slide-2',
            sessionId: 'session-1',
            type: 'static',
            content: { title: 'Second' },
            orderIndex: 1,
            isHidden: false,
            version: 1,
        },
    ];
}

describe('slide reorder', () => {
    it('reindexes slides after reordering', () => {
        expect(reorderSlidesByIndex(makeSlides(), 0, 1).map((slide) => ({
            id: slide.id,
            orderIndex: slide.orderIndex,
        }))).toEqual([
            { id: 'slide-2', orderIndex: 0 },
            { id: 'slide-1', orderIndex: 1 },
        ]);
    });

    it('rolls back local order when saving fails', async () => {
        const applySlides = vi.fn();

        const result = await reorderSlidesWithRollback({
            slides: makeSlides(),
            sourceIndex: 0,
            destinationIndex: 1,
            applySlides,
            saveOrder: vi.fn().mockRejectedValue(new Error('save failed')),
        });

        expect(applySlides).toHaveBeenNthCalledWith(1, expect.arrayContaining([
            expect.objectContaining({ id: 'slide-2', orderIndex: 0 }),
            expect.objectContaining({ id: 'slide-1', orderIndex: 1 }),
        ]));
        expect(applySlides).toHaveBeenNthCalledWith(2, expect.arrayContaining([
            expect.objectContaining({ id: 'slide-1', orderIndex: 0 }),
            expect.objectContaining({ id: 'slide-2', orderIndex: 1 }),
        ]));
        expect(result).toEqual(expect.objectContaining({
            status: 'rolled_back',
        }));
    });
});
