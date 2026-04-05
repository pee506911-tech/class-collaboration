type SlideCommitter = (slideId: string) => Promise<void>;

export function createLatestOnlySlideCommitter(commitSlide: SlideCommitter) {
    let inFlight = false;
    let queuedSlideId: string | null = null;

    const pump = async (slideId: string) => {
        inFlight = true;

        try {
            await commitSlide(slideId);
        } finally {
            inFlight = false;

            if (!queuedSlideId || queuedSlideId === slideId) {
                queuedSlideId = null;
                return;
            }

            const nextSlideId = queuedSlideId;
            queuedSlideId = null;
            void pump(nextSlideId);
        }
    };

    return {
        schedule(slideId: string) {
            if (inFlight) {
                queuedSlideId = slideId;
                return;
            }

            void pump(slideId);
        },
    };
}

export function reconcilePendingSlide(
    pendingSlideId: string | null,
    incomingSlideId: string | null | undefined,
) {
    if (!pendingSlideId) {
        return {
            shouldApply: true,
            pendingSlideId: null,
        };
    }

    if (incomingSlideId !== pendingSlideId) {
        return {
            shouldApply: false,
            pendingSlideId,
        };
    }

    return {
        shouldApply: true,
        pendingSlideId: null,
    };
}
