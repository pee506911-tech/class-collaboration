import { Slide } from 'shared';

import {
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
