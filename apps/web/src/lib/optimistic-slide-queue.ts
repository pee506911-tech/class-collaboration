import { Slide } from 'shared';

export const SESSION_INLINE_ERROR_KEY = '__session__';

export type StructuralOpType = 'create' | 'duplicate' | 'delete';
export type StructuralOpStatus = 'queued' | 'sending' | 'retrying';
export type SlideSyncState = 'syncing' | 'retrying';

export type SlideErrorKey = string | typeof SESSION_INLINE_ERROR_KEY;

export type EditorSlide = Slide & {
    optimistic?: {
        opId?: string;
        syncState?: SlideSyncState;
        isPending?: boolean;
        isTemp?: boolean;
        disableEditing?: boolean;
        sourceId?: string;
        error?: string;
    };
};

type SlideContent = Slide['content'];
type SlideType = Slide['type'];

type StructuralOpBase = {
    opId: string;
    type: StructuralOpType;
    sessionId: string;
    status: StructuralOpStatus;
    clientRequestId: string;
    dependsOn?: string;
    error?: string;
    retryCount: number;
};

export type CreateLikeStructuralOp = StructuralOpBase & {
    type: 'create' | 'duplicate';
    tempId: string;
    afterId?: string;
    payload: {
        slideType: SlideType;
        content: SlideContent;
        sourceId?: string;
    };
};

export type DeleteStructuralOp = StructuralOpBase & {
    type: 'delete';
    targetId: string;
    rollback: {
        previewSlideId: string | null;
        deletedSlide: Slide;
    };
};

export type StructuralOp = CreateLikeStructuralOp | DeleteStructuralOp;

export type StructuralQueueState = {
    optimisticOps: Record<string, StructuralOp>;
    queue: string[];
    tempIdMap: Record<string, string>;
    inlineErrors: Record<string, string>;
    inFlightOpId: string | null;
    needsRefreshAfterDrain: boolean;
};

export const initialStructuralQueueState: StructuralQueueState = {
    optimisticOps: {},
    queue: [],
    tempIdMap: {},
    inlineErrors: {},
    inFlightOpId: null,
    needsRefreshAfterDrain: false,
};

export type EnqueueCreateParams = {
    opId: string;
    tempId: string;
    sessionId: string;
    slideType: SlideType;
    content: SlideContent;
    clientRequestId: string;
    afterId?: string;
};

export type EnqueueDuplicateParams = {
    opId: string;
    tempId: string;
    sessionId: string;
    clientRequestId: string;
    sourceSlide: Slide;
};

export type EnqueueDeleteParams = {
    opId: string;
    sessionId: string;
    targetId: string;
    clientRequestId: string;
    previewSlideId: string | null;
    deletedSlide: Slide;
};

export function normalizeSlides(slides: Slide[]): Slide[] {
    return [...slides]
        .sort((left, right) => {
            if (left.orderIndex !== right.orderIndex) {
                return left.orderIndex - right.orderIndex;
            }

            return left.id.localeCompare(right.id);
        })
        .map((slide, index) => ({ ...slide, orderIndex: index }));
}

export function resolveSlideId(id: string | null | undefined, tempIdMap: Record<string, string>): string | null {
    if (!id) {
        return null;
    }

    return tempIdMap[id] ?? id;
}

export function getQueueHead(state: StructuralQueueState): StructuralOp | null {
    const opId = state.queue[0];
    if (!opId) {
        return null;
    }

    return state.optimisticOps[opId] ?? null;
}

export function canEnqueueDelete(state: StructuralQueueState, targetId: string): boolean {
    return !state.queue.some((opId) => {
        const op = state.optimisticOps[opId];
        return op?.type === 'delete' && op.targetId === targetId;
    });
}

export function isStructuralQueueBusy(state: StructuralQueueState): boolean {
    return state.queue.length > 0 || state.inFlightOpId !== null;
}

export function isOpReady(state: StructuralQueueState, op: StructuralOp | null): op is StructuralOp {
    if (!op) {
        return false;
    }

    if (state.inFlightOpId !== null && state.inFlightOpId !== op.opId) {
        return false;
    }

    if (op.dependsOn && state.optimisticOps[op.dependsOn]) {
        return false;
    }

    if (op.type !== 'delete' && op.afterId?.startsWith('temp-') && !state.tempIdMap[op.afterId]) {
        return false;
    }

    return true;
}

export function deriveOptimisticSlides(baseSlides: Slide[], state: StructuralQueueState): EditorSlide[] {
    let slides = normalizeSlides(baseSlides).map((slide) => ({ ...slide })) as EditorSlide[];

    for (const opId of state.queue) {
        const op = state.optimisticOps[opId];
        if (!op) {
            continue;
        }

        if (op.type === 'delete') {
            slides = slides.filter((slide) => slide.id !== op.targetId);
            continue;
        }

        const afterId = resolveSlideId(op.afterId, state.tempIdMap);
        const insertIndex = afterId
            ? Math.max(0, slides.findIndex((slide) => slide.id === afterId) + 1)
            : slides.length;
        const tempSlide: EditorSlide = {
            id: op.tempId,
            sessionId: op.sessionId,
            type: op.payload.slideType,
            content: op.payload.content,
            orderIndex: insertIndex,
            isHidden: false,
            version: 0,
            optimistic: {
                opId: op.opId,
                syncState: op.status === 'retrying' ? 'retrying' : 'syncing',
                isPending: true,
                isTemp: true,
                disableEditing: true,
                sourceId: op.payload.sourceId,
            },
        };

        slides.splice(insertIndex, 0, tempSlide);
    }

    const reindexedSlides = slides.map((slide, index) => ({ ...slide, orderIndex: index }));

    return reindexedSlides.map((slide) => {
        const inlineError = state.inlineErrors[slide.id];
        if (!inlineError) {
            return slide;
        }

        return {
            ...slide,
            optimistic: {
                ...slide.optimistic,
                error: inlineError,
            },
        };
    });
}

export function enqueueCreate(state: StructuralQueueState, params: EnqueueCreateParams): StructuralQueueState {
    const op: CreateLikeStructuralOp = {
        opId: params.opId,
        type: 'create',
        sessionId: params.sessionId,
        tempId: params.tempId,
        afterId: params.afterId,
        status: 'queued',
        clientRequestId: params.clientRequestId,
        retryCount: 0,
        payload: {
            slideType: params.slideType,
            content: params.content,
        },
    };

    return {
        ...state,
        optimisticOps: {
            ...state.optimisticOps,
            [op.opId]: op,
        },
        queue: [...state.queue, op.opId],
        inlineErrors: omitKey(state.inlineErrors, SESSION_INLINE_ERROR_KEY),
    };
}

export function enqueueDuplicate(
    state: StructuralQueueState,
    baseSlides: Slide[],
    params: EnqueueDuplicateParams
): StructuralQueueState {
    const pendingTail = getPendingDuplicateTail(state, params.sourceSlide.id);
    const dependsOn = pendingTail ? getOpIdByTempId(state, pendingTail) : undefined;
    const afterId = pendingTail ?? params.sourceSlide.id;

    const op: CreateLikeStructuralOp = {
        opId: params.opId,
        type: 'duplicate',
        sessionId: params.sessionId,
        tempId: params.tempId,
        afterId,
        status: 'queued',
        dependsOn,
        clientRequestId: params.clientRequestId,
        retryCount: 0,
        payload: {
            slideType: params.sourceSlide.type,
            content: params.sourceSlide.content,
            sourceId: params.sourceSlide.id,
        },
    };

    const nextState = {
        ...state,
        optimisticOps: {
            ...state.optimisticOps,
            [op.opId]: op,
        },
        queue: [...state.queue, op.opId],
        inlineErrors: omitKey(state.inlineErrors, params.sourceSlide.id),
    };

    if (!findSlideById(baseSlides, params.sourceSlide.id)) {
        return nextState;
    }

    return nextState;
}

export function enqueueDelete(
    state: StructuralQueueState,
    params: EnqueueDeleteParams
): StructuralQueueState {
    const op: DeleteStructuralOp = {
        opId: params.opId,
        type: 'delete',
        sessionId: params.sessionId,
        targetId: params.targetId,
        status: 'queued',
        clientRequestId: params.clientRequestId,
        retryCount: 0,
        rollback: {
            previewSlideId: params.previewSlideId,
            deletedSlide: params.deletedSlide,
        },
    };

    return {
        ...state,
        optimisticOps: {
            ...state.optimisticOps,
            [op.opId]: op,
        },
        queue: [...state.queue, op.opId],
        inlineErrors: omitKey(state.inlineErrors, params.targetId),
    };
}

export function markOpSending(state: StructuralQueueState, opId: string): StructuralQueueState {
    const op = state.optimisticOps[opId];
    if (!op) {
        return state;
    }

    return {
        ...state,
        inFlightOpId: opId,
        optimisticOps: {
            ...state.optimisticOps,
            [opId]: {
                ...op,
                status: 'sending',
                error: undefined,
            },
        },
    };
}

export function markOpRetrying(
    state: StructuralQueueState,
    opId: string,
    error: string
): StructuralQueueState {
    const op = state.optimisticOps[opId];
    if (!op) {
        return state;
    }

    return {
        ...state,
        inFlightOpId: null,
        optimisticOps: {
            ...state.optimisticOps,
            [opId]: {
                ...op,
                status: 'retrying',
                retryCount: op.retryCount + 1,
                error,
            },
        },
    };
}

export function markOpQueued(state: StructuralQueueState, opId: string): StructuralQueueState {
    const op = state.optimisticOps[opId];
    if (!op) {
        return state;
    }

    return {
        ...state,
        optimisticOps: {
            ...state.optimisticOps,
            [opId]: {
                ...op,
                status: 'queued',
            },
        },
    };
}

export function resolveCreateLikeSuccess(
    state: StructuralQueueState,
    opId: string,
    realSlideId: string
): StructuralQueueState {
    const op = state.optimisticOps[opId];
    if (!op || op.type === 'delete') {
        return state;
    }

    const nextOps = omitKey(state.optimisticOps, opId);
    const nextQueue = state.queue.filter((queuedOpId) => queuedOpId !== opId);

    return {
        ...state,
        optimisticOps: nextOps,
        queue: nextQueue,
        inFlightOpId: state.inFlightOpId === opId ? null : state.inFlightOpId,
        tempIdMap: {
            ...state.tempIdMap,
            [op.tempId]: realSlideId,
        },
    };
}

export function resolveDeleteSuccess(state: StructuralQueueState, opId: string): StructuralQueueState {
    if (!state.optimisticOps[opId]) {
        return state;
    }

    return {
        ...state,
        optimisticOps: omitKey(state.optimisticOps, opId),
        queue: state.queue.filter((queuedOpId) => queuedOpId !== opId),
        inFlightOpId: state.inFlightOpId === opId ? null : state.inFlightOpId,
    };
}

export function failOpPermanently(
    state: StructuralQueueState,
    opId: string,
    error: string
): StructuralQueueState {
    const op = state.optimisticOps[opId];
    if (!op) {
        return state;
    }

    if (op.type === 'delete') {
        return {
            ...state,
            optimisticOps: omitKey(state.optimisticOps, opId),
            queue: state.queue.filter((queuedOpId) => queuedOpId !== opId),
            inFlightOpId: state.inFlightOpId === opId ? null : state.inFlightOpId,
            inlineErrors: {
                ...state.inlineErrors,
                [op.targetId]: error,
            },
        };
    }

    const removedOpIds = getDependentOpIds(state, opId);
    const removedTempIds = removedOpIds.flatMap((removedOpId) => {
        const removedOp = state.optimisticOps[removedOpId];
        return removedOp && removedOp.type !== 'delete' ? [removedOp.tempId] : [];
    });

    const nextOps = { ...state.optimisticOps };
    for (const removedOpId of removedOpIds) {
        delete nextOps[removedOpId];
    }

    const nextInlineErrors = {
        ...state.inlineErrors,
        [op.payload.sourceId ?? SESSION_INLINE_ERROR_KEY]: error,
    };

    const nextTempIdMap = { ...state.tempIdMap };
    for (const tempId of removedTempIds) {
        delete nextTempIdMap[tempId];
    }

    return {
        ...state,
        optimisticOps: nextOps,
        queue: state.queue.filter((queuedOpId) => !removedOpIds.includes(queuedOpId)),
        tempIdMap: nextTempIdMap,
        inFlightOpId: state.inFlightOpId === opId ? null : state.inFlightOpId,
        inlineErrors: nextInlineErrors,
    };
}

export function clearInlineError(state: StructuralQueueState, targetId: SlideErrorKey): StructuralQueueState {
    if (!state.inlineErrors[targetId]) {
        return state;
    }

    return {
        ...state,
        inlineErrors: omitKey(state.inlineErrors, targetId),
    };
}

export function applyCreateLikeSuccessToBaseSlides(
    baseSlides: Slide[],
    op: CreateLikeStructuralOp,
    serverSlide: Slide,
    tempIdMap: Record<string, string>
): Slide[] {
    const normalizedBaseSlides = normalizeSlides(baseSlides);
    const afterId = resolveSlideId(op.afterId, tempIdMap);
    return normalizeSlides(insertSlideAfter(normalizedBaseSlides, { ...serverSlide }, afterId ?? undefined));
}

export function applyDeleteSuccessToBaseSlides(baseSlides: Slide[], op: DeleteStructuralOp): Slide[] {
    return normalizeSlides(baseSlides.filter((slide) => slide.id !== op.targetId));
}

export function getPendingDuplicateTail(state: StructuralQueueState, sourceId: string): string | null {
    for (let index = state.queue.length - 1; index >= 0; index -= 1) {
        const op = state.optimisticOps[state.queue[index]];
        if (op?.type === 'duplicate' && op.payload.sourceId === sourceId) {
            return op.tempId;
        }
    }

    return null;
}

export function getOpIdByTempId(state: StructuralQueueState, tempId: string): string | undefined {
    return Object.values(state.optimisticOps).find((op) => op.type !== 'delete' && op.tempId === tempId)?.opId;
}

export function getRetryDelayMs(retryCount: number): number {
    return Math.min(1000 * Math.pow(2, retryCount), 5000);
}

function getDependentOpIds(state: StructuralQueueState, rootOpId: string): string[] {
    const dependentOpIds = new Set<string>([rootOpId]);
    let foundNewDependency = true;

    while (foundNewDependency) {
        foundNewDependency = false;

        for (const opId of state.queue) {
            const op = state.optimisticOps[opId];
            if (!op || dependentOpIds.has(opId)) {
                continue;
            }

            if (op.dependsOn && dependentOpIds.has(op.dependsOn)) {
                dependentOpIds.add(opId);
                foundNewDependency = true;
            }
        }
    }

    return Array.from(dependentOpIds);
}

function insertSlideAfter(slides: Slide[], newSlide: Slide, afterId?: string): Slide[] {
    const nextSlides = slides.filter((slide) => slide.id !== newSlide.id);
    const insertIndex = afterId
        ? Math.max(0, nextSlides.findIndex((slide) => slide.id === afterId) + 1)
        : nextSlides.length;

    nextSlides.splice(insertIndex, 0, newSlide);
    return nextSlides.map((slide, index) => ({ ...slide, orderIndex: index }));
}

function findSlideById(slides: Slide[], slideId: string): Slide | undefined {
    return slides.find((slide) => slide.id === slideId);
}

function omitKey<T extends Record<string, unknown>>(record: T, key: string): T {
    if (!(key in record)) {
        return record;
    }

    const nextRecord = { ...record };
    delete nextRecord[key];
    return nextRecord;
}
