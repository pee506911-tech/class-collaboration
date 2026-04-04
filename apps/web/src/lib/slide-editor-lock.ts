export function getSlideEditorLockState({
    hasPendingStructuralMutations: _hasPendingStructuralMutations,
    isReordering,
    disableEditing,
    syncState,
}: {
    hasPendingStructuralMutations: boolean;
    isReordering: boolean;
    disableEditing?: boolean;
    syncState?: string;
}) {
    if (disableEditing) {
        if (syncState === 'retrying') {
            return {
                disabled: true,
                reason: 'This slide is retrying. Editing is disabled until it is confirmed.',
            };
        }

        return {
            disabled: true,
            reason: 'This slide is still syncing. Editing is disabled until it is confirmed.',
        };
    }

    if (isReordering) {
        return {
            disabled: false,
            reason: null,
        };
    }

    return {
        disabled: false,
        reason: null,
    };
}
