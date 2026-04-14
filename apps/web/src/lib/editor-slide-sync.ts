import { Slide } from 'shared';

import {
    applySlideOperations,
    createSlide,
    deleteSlide,
    updateSlide,
    reorderSlides,
} from '@/lib/api';
import { createLatestOnlySlideCommitter } from '@/lib/clicker-navigation';

// ---------------------------------------------------------------------------
// Editor slide sync — uses the same coalescing serializer pattern as the
// clicker (createLatestOnlySlideCommitter) so rapid edits only send the
// latest state to the server.
// ---------------------------------------------------------------------------

/** Sort slides by orderIndex and re-index sequentially. */
export function normalizeSlides(slides: Slide[]): Slide[] {
    return [...slides]
        .sort((a, b) => {
            if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
            return a.id.localeCompare(b.id);
        })
        .map((slide, index) => ({ ...slide, orderIndex: index }));
}

function areSlideContentsEqual(left: Slide['content'], right: Slide['content']) {
    return JSON.stringify(left) === JSON.stringify(right);
}

type DeltaEditorSlide = Slide & {
    serverId?: string | null;
};

function insertSlideIdAfter(
    slideIds: string[],
    slideId: string,
    insertAfterSlideId?: string | null,
) {
    const next = slideIds.filter((currentSlideId) => currentSlideId !== slideId);

    if (!insertAfterSlideId) {
        next.push(slideId);
        return next;
    }

    const insertAfterIndex = next.indexOf(insertAfterSlideId);
    if (insertAfterIndex === -1) {
        next.push(slideId);
        return next;
    }

    next.splice(insertAfterIndex + 1, 0, slideId);
    return next;
}

export async function saveEditorDocumentDelta(
    sessionId: string,
    baseSlides: Slide[],
    localSlides: DeltaEditorSlide[],
): Promise<Slide[]> {
    const baseSlidesById = new Map(baseSlides.map((slide) => [slide.id, slide]));
    const desiredServerIds = new Set(
        localSlides.flatMap((slide) => (slide.serverId ? [slide.serverId] : [])),
    );

    const updateOperations = localSlides.flatMap((slide) => {
        if (!slide.serverId) {
            return [];
        }

        const baseSlide = baseSlidesById.get(slide.serverId);
        if (!baseSlide) {
            throw new Error(`Missing base slide ${slide.serverId}`);
        }

        const changedType = slide.type !== baseSlide.type;
        const changedContent = !areSlideContentsEqual(slide.content, baseSlide.content);
        const changedVisibility = (slide.isHidden ?? false) !== (baseSlide.isHidden ?? false);

        if (!changedType && !changedContent && !changedVisibility) {
            return [];
        }

        return [{
            op: 'update' as const,
            slideId: slide.serverId,
            content: slide.content,
            ...(changedType ? { type: slide.type } : {}),
            ...(changedVisibility ? { isHidden: slide.isHidden ?? false } : {}),
            baseVersion: baseSlide.version,
        }];
    });

    const createOperations: Array<{
        op: 'create';
        tempId: string;
        type: string;
        content: unknown;
        isHidden?: boolean;
        insertAfterSlideId?: string | null;
    }> = [];
    let currentSlideIds = baseSlides.map((slide) => slide.id);

    for (let index = 0; index < localSlides.length; index += 1) {
        const slide = localSlides[index];
        if (slide.serverId) {
            continue;
        }

        const insertAfterSlideId = index > 0 ? localSlides[index - 1]?.id ?? null : null;
        createOperations.push({
            op: 'create',
            tempId: slide.id,
            type: slide.type,
            content: slide.content,
            isHidden: slide.isHidden ?? false,
            ...(insertAfterSlideId ? { insertAfterSlideId } : {}),
        });
        currentSlideIds = insertSlideIdAfter(currentSlideIds, slide.id, insertAfterSlideId);
    }

    const desiredSlideIds = localSlides.map((slide) => slide.id);
    const moveOperations: Array<{
        op: 'move';
        slideId: string;
        insertAfterSlideId?: string | null;
    }> = [];

    for (let index = 0; index < desiredSlideIds.length; index += 1) {
        const desiredSlideId = desiredSlideIds[index];
        if (currentSlideIds[index] === desiredSlideId) {
            continue;
        }

        const insertAfterSlideId = index > 0 ? desiredSlideIds[index - 1] : null;
        moveOperations.push({
            op: 'move',
            slideId: desiredSlideId,
            ...(insertAfterSlideId ? { insertAfterSlideId } : {}),
        });
        currentSlideIds = currentSlideIds.filter((slideId) => slideId !== desiredSlideId);
        currentSlideIds.splice(index, 0, desiredSlideId);
    }

    const deleteOperations = baseSlides
        .filter((slide) => !desiredServerIds.has(slide.id))
        .map((slide) => ({
            op: 'delete' as const,
            slideId: slide.id,
        }));

    const operations = [
        ...updateOperations,
        ...createOperations,
        ...moveOperations,
        ...deleteOperations,
    ];

    if (operations.length === 0) {
        return normalizeSlides(baseSlides);
    }

    return normalizeSlides(await applySlideOperations(sessionId, operations));
}

export function reconcileCreatedSlide({
    localSlide,
    serverSlide,
}: {
    localSlide: Slide | null | undefined;
    serverSlide: Slide;
}) {
    if (!localSlide) {
        return {
            slide: serverSlide,
            contentNeedingSync: null,
        };
    }

    const contentNeedingSync = areSlideContentsEqual(localSlide.content, serverSlide.content)
        ? null
        : localSlide.content;

    return {
        slide: {
            ...serverSlide,
            content: contentNeedingSync ?? serverSlide.content,
            orderIndex: localSlide.orderIndex,
            isHidden: localSlide.isHidden,
        },
        contentNeedingSync,
    };
}

/**
 * Coalesces rapid slide content edits.  Only the latest pending value is
 * ever sent to the server.  Intermediate states are dropped.
 */
export function createSlideEditCommitter(
    sessionId: string,
    callbacks?: {
        onSuccess?: (savedSlide: Slide, request: { slideId: string; content: Slide['content'] }) => void;
        onError?: (error: unknown, request: { slideId: string; content: Slide['content'] }) => void;
    },
) {
    return createLatestOnlySlideCommitter(async (value: { slideId: string; content: Slide['content'] }) => {
        try {
            const savedSlide = await updateSlide(sessionId, value.slideId, value.content);
            callbacks?.onSuccess?.(savedSlide, value);
        } catch (error) {
            callbacks?.onError?.(error, value);
        }
    });
}

export function createSlideCreateCommitter(
    sessionId: string,
    callbacks?: {
        onSuccess?: (
            savedSlide: Slide,
            request: {
                tempId: string;
                slideType: Slide['type'];
                content: Slide['content'];
                insertAfterSlideId?: string;
            },
        ) => void;
        onError?: (
            error: unknown,
            request: {
                tempId: string;
                slideType: Slide['type'];
                content: Slide['content'];
                insertAfterSlideId?: string;
            },
        ) => void;
    },
) {
    let queue = Promise.resolve();
    const resolvedSlideIds = new Map<string, string>();
    const pendingSlideIds = new Map<string, Promise<string | undefined>>();

    const resolveInsertAfterSlideId = async (slideId?: string) => {
        if (!slideId) {
            return undefined;
        }

        if (!slideId.startsWith('temp-')) {
            return slideId;
        }

        const resolvedSlideId = resolvedSlideIds.get(slideId);
        if (resolvedSlideId) {
            return resolvedSlideId;
        }

        const pendingSlideId = pendingSlideIds.get(slideId);
        if (!pendingSlideId) {
            return undefined;
        }

        return pendingSlideId;
    };

    return {
        schedule(request: {
            tempId: string;
            slideType: Slide['type'];
            content: Slide['content'];
            insertAfterSlideId?: string;
        }) {
            let resolvePendingSlideId!: (slideId: string | undefined) => void;
            const pendingSlideId = new Promise<string | undefined>((resolve) => {
                resolvePendingSlideId = resolve;
            });
            pendingSlideIds.set(request.tempId, pendingSlideId);

            const task = queue
                .catch(() => undefined)
                .then(async () => {
                    const insertAfterSlideId = await resolveInsertAfterSlideId(request.insertAfterSlideId);
                    const savedSlide = await createSlide(
                        sessionId,
                        request.slideType,
                        request.content,
                        insertAfterSlideId ? { insertAfterSlideId } : undefined,
                    );
                    resolvedSlideIds.set(request.tempId, savedSlide.id);
                    resolvePendingSlideId(savedSlide.id);
                    callbacks?.onSuccess?.(savedSlide, {
                        ...request,
                        ...(insertAfterSlideId ? { insertAfterSlideId } : {}),
                    });
                    return savedSlide;
                })
                .catch((error) => {
                    resolvePendingSlideId(undefined);
                    callbacks?.onError?.(error, request);
                    throw error;
                })
                .finally(() => {
                    pendingSlideIds.delete(request.tempId);
                });

            queue = task.then(() => undefined, () => undefined);
            return task;
        },
    };
}

/**
 * Create a new slide via HTTP POST.
 * The server will broadcast SLIDES_UPDATE via WebSocket to all connected
 * tabs, which will then refetch the slide list. The caller is responsible
 * for handling failures so optimistic UI can reconcile immediately.
 */
export async function commitCreateSlide(
    sessionId: string,
    slideType: Slide['type'],
    content: Slide['content'],
    options?: { insertAfterSlideId?: string },
): Promise<Slide> {
    return createSlide(sessionId, slideType, content, options);
}

/**
 * Delete a slide via HTTP DELETE.
 * The caller is responsible for rollback on failure.
 */
export async function commitDeleteSlide(
    sessionId: string,
    slideId: string,
): Promise<void> {
    await deleteSlide(sessionId, slideId);
}

/**
 * Reorder slides via HTTP PUT.
 * The caller is responsible for rollback on failure.
 */
export async function commitReorderSlides(
    sessionId: string,
    slideIds: string[],
): Promise<void> {
    await reorderSlides(sessionId, slideIds);
}
