export function getSlideEditorLockState({
    hasPendingStructuralMutations: _hasPendingStructuralMutations,
    isReordering: _isReordering,
    disableEditing: _disableEditing,
    syncState: _syncState,
}: {
    hasPendingStructuralMutations: boolean;
    isReordering: boolean;
    disableEditing?: boolean;
    syncState?: string;
}) {
    return {
        disabled: false,
        reason: null,
    };
}
