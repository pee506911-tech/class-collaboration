import { describe, expect, it } from 'vitest';

import { getSlideEditorLockState } from './slide-editor-lock';

describe('getSlideEditorLockState', () => {
    it('keeps content editing enabled while only reorder is syncing', () => {
        expect(getSlideEditorLockState({
            hasPendingStructuralMutations: false,
            isReordering: true,
            disableEditing: false,
            syncState: undefined,
        })).toEqual({
            disabled: false,
            reason: null,
        });
    });

    it('locks editing while structural mutations are syncing', () => {
        expect(getSlideEditorLockState({
            hasPendingStructuralMutations: true,
            isReordering: false,
            disableEditing: false,
            syncState: undefined,
        })).toEqual({
            disabled: false,
            reason: null,
        });
    });

    it('still locks the optimistic preview slide while it is syncing', () => {
        expect(getSlideEditorLockState({
            hasPendingStructuralMutations: true,
            isReordering: false,
            disableEditing: true,
            syncState: 'syncing',
        })).toEqual({
            disabled: true,
            reason: 'This slide is still syncing. Editing is disabled until it is confirmed.',
        });
    });

    it('surfaces retry-specific guidance when the slide itself is still syncing', () => {
        expect(getSlideEditorLockState({
            hasPendingStructuralMutations: false,
            isReordering: false,
            disableEditing: true,
            syncState: 'retrying',
        })).toEqual({
            disabled: true,
            reason: 'This slide is retrying. Editing is disabled until it is confirmed.',
        });
    });
});
