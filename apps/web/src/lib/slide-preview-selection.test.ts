import { describe, expect, it } from 'vitest';

import { getNextPreviewSlideId, resolveDeleteRollbackPreviewId, resolvePreviewSlideId } from './slide-preview-selection';

describe('slide preview selection', () => {
    it('falls back to the first existing slide when the current preview no longer exists', () => {
        expect(resolvePreviewSlideId(['A', 'B'], 'temp-1')).toBe('A');
    });

    it('keeps the current preview when it still exists', () => {
        expect(resolvePreviewSlideId(['A', 'B'], 'B')).toBe('B');
    });

    it('falls forward to the next available slide when deleting the current preview', () => {
        expect(getNextPreviewSlideId(['A', 'B', 'C'], 'A', 'A')).toBe('B');
    });

    it('keeps the user on their newer selection when a delete rollback arrives late', () => {
        expect(resolveDeleteRollbackPreviewId({
            currentPreviewSlideId: 'C',
            restorePreviewSlideId: 'A',
            fallbackPreviewSlideId: 'B',
        })).toBe('C');
    });

    it('restores the deleted slide when the user stayed on the optimistic fallback', () => {
        expect(resolveDeleteRollbackPreviewId({
            currentPreviewSlideId: 'B',
            restorePreviewSlideId: 'A',
            fallbackPreviewSlideId: 'B',
        })).toBe('A');
    });
});
