import type { Slide } from 'shared';

type SaveSlideOrder = (slideIds: string[]) => Promise<void>;
type ApplySlides = (slides: Slide[]) => void;

export function reindexSlides(slides: Slide[]): Slide[] {
    return slides.map((slide, index) => ({ ...slide, orderIndex: index }));
}

export function reorderSlidesByIndex(slides: Slide[], sourceIndex: number, destinationIndex: number): Slide[] {
    const nextSlides = Array.from(slides);
    const [reorderedItem] = nextSlides.splice(sourceIndex, 1);
    nextSlides.splice(destinationIndex, 0, reorderedItem);
    return reindexSlides(nextSlides);
}

export async function reorderSlidesWithRollback({
    slides,
    sourceIndex,
    destinationIndex,
    applySlides,
    saveOrder,
}: {
    slides: Slide[];
    sourceIndex: number;
    destinationIndex: number;
    applySlides: ApplySlides;
    saveOrder: SaveSlideOrder;
}) {
    const previousSlides = slides;
    const reorderedSlides = reorderSlidesByIndex(slides, sourceIndex, destinationIndex);

    applySlides(reorderedSlides);

    try {
        await saveOrder(reorderedSlides.map((slide) => slide.id));
        return { status: 'saved' as const, slides: reorderedSlides };
    } catch (error) {
        applySlides(previousSlides);
        return { status: 'rolled_back' as const, slides: previousSlides, error };
    }
}
