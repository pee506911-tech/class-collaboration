import type { Dispatch, SetStateAction } from 'react';
import type { Slide } from 'shared';

import { updateSlide as updateSlideApi } from '@/lib/api';

type SaveSlideUpdateArgs = {
    sessionId: string;
    slideId: string;
    content: Slide['content'];
    getBaseSlides: () => Slide[];
    resolveOptimisticId: (id: string) => string | null | undefined;
    setBaseSlides: Dispatch<SetStateAction<Slide[]>>;
    saveSlide?: typeof updateSlideApi;
};

type SaveSlideUpdateResult =
    | { status: 'saved'; slide: Slide }
    | { status: 'noop' };

export async function saveSlideUpdate({
    sessionId,
    slideId,
    content,
    getBaseSlides,
    resolveOptimisticId,
    setBaseSlides,
    saveSlide = updateSlideApi,
}: SaveSlideUpdateArgs): Promise<SaveSlideUpdateResult> {
    const resolvedSlideId = resolveOptimisticId(slideId) ?? slideId;
    const existingSlide = getBaseSlides().find((slide) => slide.id === resolvedSlideId);
    if (!existingSlide) {
        return { status: 'noop' };
    }

    setBaseSlides((prevSlides) =>
        prevSlides.map((slide) =>
            slide.id === resolvedSlideId ? { ...slide, content } : slide,
        ),
    );

    try {
        const savedSlide = await saveSlide(sessionId, resolvedSlideId, content);
        setBaseSlides((prevSlides) =>
            prevSlides.map((slide) =>
                slide.id === resolvedSlideId
                    ? {
                        ...slide,
                        ...savedSlide,
                        orderIndex: slide.orderIndex,
                        isHidden: slide.isHidden,
                    }
                    : slide,
            ),
        );
        return { status: 'saved', slide: savedSlide };
    } catch (error) {
        throw error;
    }
}
