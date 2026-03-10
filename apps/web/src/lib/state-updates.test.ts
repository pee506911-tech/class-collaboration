import { describe, expect, it } from 'vitest';
import { shouldApplyStateUpdate } from './state-updates';

describe('shouldApplyStateUpdate', () => {
    it('accepts newer versioned state', () => {
        expect(
            shouldApplyStateUpdate(
                { currentSlideId: 'slide-a', stateVersion: 4 },
                { currentSlideId: 'slide-b', stateVersion: 5 }
            )
        ).toBe(true);
    });

    it('rejects stale or duplicate versioned state', () => {
        expect(
            shouldApplyStateUpdate(
                { currentSlideId: 'slide-b', stateVersion: 5 },
                { currentSlideId: 'slide-a', stateVersion: 5 }
            )
        ).toBe(false);

        expect(
            shouldApplyStateUpdate(
                { currentSlideId: 'slide-b', stateVersion: 5 },
                { currentSlideId: 'slide-a', stateVersion: 4 }
            )
        ).toBe(false);
    });

    it('allows unversioned updates as a fallback', () => {
        expect(
            shouldApplyStateUpdate(
                { currentSlideId: 'slide-a' },
                { currentSlideId: 'slide-b' }
            )
        ).toBe(true);
    });
});
