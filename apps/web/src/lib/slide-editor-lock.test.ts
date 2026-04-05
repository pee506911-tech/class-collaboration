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

    it('keeps the optimistic preview slide editable while it is syncing', () => {
        expect(getSlideEditorLockState({
            hasPendingStructuralMutations: true,
            isReordering: false,
            disableEditing: true,
            syncState: 'syncing',
        })).toEqual({
            disabled: false,
            reason: null,
        });
    });

    it('keeps retrying slides editable while they continue syncing', () => {
        expect(getSlideEditorLockState({
            hasPendingStructuralMutations: false,
            isReordering: false,
            disableEditing: true,
            syncState: 'retrying',
        })).toEqual({
            disabled: false,
            reason: null,
        });
    });
});
