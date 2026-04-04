import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';
import { Slide } from 'shared';

import { ApiRequestError, createSlide, deleteSlide, isRetryableApiError } from '@/lib/api';
import {
    SESSION_INLINE_ERROR_KEY,
    StructuralQueueState,
    applyCreateLikeSuccessToBaseSlides,
    applyDeleteSuccessToBaseSlides,
    canEnqueueDelete,
    clearInlineError,
    deriveOptimisticSlides,
    enqueueCreate,
    enqueueDelete,
    enqueueDuplicate,
    failOpPermanently,
    getQueueHead,
    getRetryDelayMs,
    initialStructuralQueueState,
    isOpReady,
    markOpQueued,
    markOpRetrying,
    markOpSending,
    normalizeSlides,
    resolveCreateLikeSuccess,
    resolveDeleteSuccess,
    resolveSlideId,
} from '@/lib/optimistic-slide-queue';

type UseOptimisticSlideQueueArgs = {
    sessionId: string;
    baseSlides: Slide[];
    setBaseSlides: Dispatch<SetStateAction<Slide[]>>;
    refreshBaseSlides: () => Promise<void>;
    onDeleteRollback?: (rollback: {
        restorePreviewSlideId: string | null;
        fallbackPreviewSlideId: string | null;
    }) => void;
};

type EnqueueCreateArgs = {
    slideType: Slide['type'];
    content: Slide['content'];
    afterId?: string;
};

export function useOptimisticSlideQueue({
    sessionId,
    baseSlides,
    setBaseSlides,
    refreshBaseSlides,
    onDeleteRollback,
}: UseOptimisticSlideQueueArgs) {
    const [state, setState] = useState<StructuralQueueState>(initialStructuralQueueState);
    const retryTimersRef = useRef<Record<string, number>>({});
    const processingRef = useRef(false);

    useEffect(() => {
        return () => {
            for (const timerId of Object.values(retryTimersRef.current)) {
                window.clearTimeout(timerId);
            }
            retryTimersRef.current = {};
        };
    }, []);

    useEffect(() => {
        if (state.queue.length > 0) {
            return;
        }

        if (!state.needsRefreshAfterDrain) {
            return;
        }

        let cancelled = false;

        void (async () => {
            try {
                await refreshBaseSlides();
            } finally {
                if (!cancelled) {
                    setState((prev) => ({
                        ...prev,
                        needsRefreshAfterDrain: false,
                    }));
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [refreshBaseSlides, state.needsRefreshAfterDrain, state.queue.length]);

    useEffect(() => {
        const head = getQueueHead(state);
        if (!head || !isOpReady(state, head) || processingRef.current) {
            return;
        }

        processingRef.current = true;
        setState((prev) => markOpSending(prev, head.opId));

        void (async () => {
            try {
                if (head.type === 'delete') {
                    const targetId = resolveSlideId(head.targetId, state.tempIdMap) ?? head.targetId;
                    await deleteSlide(sessionId, targetId, { clientRequestId: head.clientRequestId });

                    setBaseSlides((prevSlides) => applyDeleteSuccessToBaseSlides(prevSlides, head));
                    setState((prev) => resolveDeleteSuccess(prev, head.opId));
                    return;
                }

                const afterId = resolveSlideId(head.afterId, state.tempIdMap) ?? undefined;
                const serverSlide = await createSlide(sessionId, head.payload.slideType, head.payload.content, {
                    insertAfterSlideId: afterId,
                    clientRequestId: head.clientRequestId,
                });

                setBaseSlides((prevSlides) => applyCreateLikeSuccessToBaseSlides(prevSlides, head, serverSlide, state.tempIdMap));
                setState((prev) => resolveCreateLikeSuccess(prev, head.opId, serverSlide.id));
            } catch (error) {
                const apiError = toApiRequestError(error, head.type === 'delete' ? 'Failed to delete slide' : 'Failed to save slide');

                if (isRetryableApiError(apiError)) {
                    const retryDelayMs = getRetryDelayMs(head.retryCount);
                    setState((prev) => markOpRetrying(prev, head.opId, apiError.message));

                    retryTimersRef.current[head.opId] = window.setTimeout(() => {
                        delete retryTimersRef.current[head.opId];
                        setState((prev) => markOpQueued(prev, head.opId));
                    }, retryDelayMs);
                } else {
                    if (head.type === 'delete' && onDeleteRollback) {
                        onDeleteRollback({
                            restorePreviewSlideId: head.rollback.restorePreviewSlideId,
                            fallbackPreviewSlideId: head.rollback.fallbackPreviewSlideId,
                        });
                    }
                    setState((prev) => failOpPermanently(prev, head.opId, apiError.message));
                }
            } finally {
                processingRef.current = false;
            }
        })();
    }, [onDeleteRollback, sessionId, setBaseSlides, state, state.tempIdMap]);

    const slides = deriveOptimisticSlides(baseSlides, state);

    function enqueueCreateSlide({ slideType, content, afterId }: EnqueueCreateArgs): string {
        const tempId = createLocalId('temp');
        const opId = createLocalId('op');
        const clientRequestId = createLocalId('req');

        setState((prev) => enqueueCreate(prev, {
            opId,
            tempId,
            sessionId,
            slideType,
            content,
            clientRequestId,
            afterId,
        }));

        return tempId;
    }

    function enqueueDuplicateSlide(sourceSlide: Slide): string {
        const tempId = createLocalId('temp');
        const opId = createLocalId('op');
        const clientRequestId = createLocalId('req');

        setState((prev) => enqueueDuplicate(prev, baseSlides, {
            opId,
            tempId,
            sessionId,
            clientRequestId,
            sourceSlide,
        }));

        return tempId;
    }

    function enqueueDeleteSlide(
        targetId: string,
        rollbackPreview: { restorePreviewSlideId: string | null; fallbackPreviewSlideId: string | null },
    ): { accepted: boolean } {
        const resolvedTargetId = resolveSlideId(targetId, state.tempIdMap) ?? targetId;
        const deletedSlide = baseSlides.find((slide) => slide.id === resolvedTargetId);
        if (!deletedSlide) {
            return { accepted: false };
        }

        if (!canEnqueueDelete(state, resolvedTargetId)) {
            return { accepted: false };
        }

        setState((prev) => enqueueDelete(prev, {
            opId: createLocalId('op'),
            sessionId,
            targetId: resolvedTargetId,
            clientRequestId: createLocalId('req'),
            restorePreviewSlideId: rollbackPreview.restorePreviewSlideId,
            fallbackPreviewSlideId: rollbackPreview.fallbackPreviewSlideId,
            deletedSlide,
        }));

        return { accepted: true };
    }

    function requestRefreshAfterDrain() {
        if (state.queue.length === 0) {
            void refreshBaseSlides();
            return;
        }

        setState((prev) => ({
            ...prev,
            needsRefreshAfterDrain: true,
        }));
    }

    return {
        slides,
        queueState: state,
        normalizedBaseSlides: normalizeSlides(baseSlides),
        enqueueCreateSlide,
        enqueueDuplicateSlide,
        enqueueDeleteSlide,
        clearInlineError(targetId: string) {
            setState((prev) => clearInlineError(prev, targetId));
        },
        clearSessionInlineError() {
            setState((prev) => clearInlineError(prev, SESSION_INLINE_ERROR_KEY));
        },
        resolveOptimisticId(id: string | null) {
            return resolveSlideId(id, state.tempIdMap);
        },
        requestRefreshAfterDrain,
        hasPendingStructuralMutations: state.queue.length > 0 || state.inFlightOpId !== null,
        sessionInlineError: state.inlineErrors[SESSION_INLINE_ERROR_KEY] ?? null,
    };
}

function createLocalId(prefix: string): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `${prefix}-${crypto.randomUUID()}`;
    }

    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toApiRequestError(error: unknown, fallbackMessage: string): ApiRequestError {
    if (error instanceof ApiRequestError) {
        return error;
    }

    if (error instanceof Error) {
        return new ApiRequestError(error.message || fallbackMessage, { retryable: true, cause: error });
    }

    return new ApiRequestError(fallbackMessage, { retryable: true });
}
