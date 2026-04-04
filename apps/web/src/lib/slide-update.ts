import type { Dispatch, SetStateAction } from 'react';
import type { Slide } from 'shared';

import { ApiRequestError, updateSlide as updateSlideApi } from '@/lib/api';

type SaveSlideUpdateArgs = {
    sessionId: string;
    slideId: string;
    content: Slide['content'];
    baseSlides: Slide[];
    resolveOptimisticId: (id: string) => string | null | undefined;
    setBaseSlides: Dispatch<SetStateAction<Slide[]>>;
    saveSlide?: typeof updateSlideApi;
    refreshSlides: () => Promise<void>;
};

type SaveSlideUpdateResult =
    | { status: 'saved'; slide: Slide }
    | { status: 'noop' };

export class SlideVersionConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SlideVersionConflictError';
    }
}

export async function saveSlideUpdate({
    sessionId,
    slideId,
    content,
    baseSlides,
    resolveOptimisticId,
    setBaseSlides,
    saveSlide = updateSlideApi,
    refreshSlides,
}: SaveSlideUpdateArgs): Promise<SaveSlideUpdateResult> {
    const resolvedSlideId = resolveOptimisticId(slideId) ?? slideId;
    const existingSlide = baseSlides.find((slide) => slide.id === resolvedSlideId);
    if (!existingSlide) {
        return { status: 'noop' };
    }

    setBaseSlides((prevSlides) =>
        prevSlides.map((slide) =>
            slide.id === resolvedSlideId ? { ...slide, content } : slide,
        ),
    );

    try {
        const savedSlide = await saveSlide(
            sessionId,
            resolvedSlideId,
            content,
            existingSlide.version,
        );
        setBaseSlides((prevSlides) =>
            prevSlides.map((slide) =>
                slide.id === resolvedSlideId ? savedSlide : slide,
            ),
        );
        return { status: 'saved', slide: savedSlide };
    } catch (error) {
        if (isSlideVersionConflict(error)) {
            await refreshSlides();
            throw new SlideVersionConflictError(
                error.message || 'Slide has changed on the server',
            );
        }

        setBaseSlides((prevSlides) =>
            prevSlides.map((slide) =>
                slide.id === resolvedSlideId ? existingSlide : slide,
            ),
        );
        throw error;
    }
}

export function isSlideVersionConflict(error: unknown): error is ApiRequestError {
    return error instanceof ApiRequestError && error.status === 409;
}
