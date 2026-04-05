export type PendingSlideIntent = {
    slideId: string;
    intentSeq: number;
};

type SlideCommitter<T> = (value: T) => Promise<void>;

export function createLatestOnlySlideCommitter<T>(commitSlide: SlideCommitter<T>) {
    let inFlight = false;
    let queuedValue: T | null = null;

    const pump = async (value: T) => {
        inFlight = true;

        try {
            await commitSlide(value);
        } finally {
            inFlight = false;

            if (!queuedValue || queuedValue === value) {
                queuedValue = null;
                return;
            }

            const nextValue = queuedValue;
            queuedValue = null;
            void pump(nextValue);
        }
    };

    return {
        schedule(value: T) {
            if (inFlight) {
                queuedValue = value;
                return;
            }

            void pump(value);
        },
    };
}

export function reconcilePendingSlide(
    pendingIntent: PendingSlideIntent | null,
    incomingSlideId: string | null | undefined,
) {
    if (!pendingIntent) {
        return {
            shouldApply: true,
            pendingIntent: null,
        };
    }

    if (incomingSlideId !== pendingIntent.slideId) {
        return {
            shouldApply: false,
            pendingIntent,
        };
    }

    return {
        shouldApply: true,
        pendingIntent: null,
    };
}
