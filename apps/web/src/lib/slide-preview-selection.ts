export function resolvePreviewSlideId(
    slideIds: string[],
    currentPreviewSlideId: string | null,
    tempIdMap: Record<string, string> = {},
): string | null {
    const resolvedPreviewSlideId = currentPreviewSlideId ? tempIdMap[currentPreviewSlideId] ?? currentPreviewSlideId : null;

    if (resolvedPreviewSlideId && slideIds.includes(resolvedPreviewSlideId)) {
        return resolvedPreviewSlideId;
    }

    if (currentPreviewSlideId && slideIds.includes(currentPreviewSlideId)) {
        return currentPreviewSlideId;
    }

    return slideIds[0] ?? null;
}

export function getNextPreviewSlideId(
    slideIds: string[],
    deletedSlideId: string,
    currentPreviewSlideId: string | null,
): string | null {
    if (currentPreviewSlideId !== deletedSlideId) {
        return currentPreviewSlideId;
    }

    const deletedIndex = slideIds.findIndex((slideId) => slideId === deletedSlideId);
    const remainingSlideIds = slideIds.filter((slideId) => slideId !== deletedSlideId);

    if (remainingSlideIds.length === 0) {
        return null;
    }

    const fallbackIndex = Math.min(deletedIndex, remainingSlideIds.length - 1);
    return remainingSlideIds[fallbackIndex] ?? remainingSlideIds[remainingSlideIds.length - 1] ?? null;
}

export function resolveDeleteRollbackPreviewId({
    currentPreviewSlideId,
    restorePreviewSlideId,
    fallbackPreviewSlideId,
}: {
    currentPreviewSlideId: string | null;
    restorePreviewSlideId: string | null;
    fallbackPreviewSlideId: string | null;
}) {
    if (currentPreviewSlideId === null || currentPreviewSlideId === fallbackPreviewSlideId) {
        return restorePreviewSlideId;
    }

    return currentPreviewSlideId;
}
