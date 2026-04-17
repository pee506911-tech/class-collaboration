import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    reconcileCreatedSlide,
    commitCreateSlide,
    commitDeleteSlide,
    commitReorderSlides,
    createSlideCreateCommitter,
    createSlideEditCommitter,
    saveEditorDocumentDelta,
} from './editor-slide-sync';

const apiMocks = vi.hoisted(() => ({
    applySlideOperations: vi.fn(),
    createSlide: vi.fn(),
    deleteSlide: vi.fn(),
    reorderSlides: vi.fn(),
    updateSlide: vi.fn(),
}));

vi.mock('@/lib/api', () => apiMocks);

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

async function flushQueueTurn() {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createSlideEditCommitter', () => {
    beforeEach(() => {
        apiMocks.applySlideOperations.mockReset();
        apiMocks.createSlide.mockReset();
        apiMocks.deleteSlide.mockReset();
        apiMocks.reorderSlides.mockReset();
        apiMocks.updateSlide.mockReset();
    });

    it('commits the latest queued content for the same slide after the in-flight save settles', async () => {
        const firstSave = deferred<void>();
        const secondSave = deferred<void>();

        apiMocks.updateSlide
            .mockReturnValueOnce(firstSave.promise)
            .mockReturnValueOnce(secondSave.promise);

        const committer = createSlideEditCommitter('session-1');

        committer.schedule({
            slideId: 'slide-1',
            content: { title: 'Draft A' },
        });

        committer.schedule({
            slideId: 'slide-1',
            content: { title: 'Draft B' },
        });

        expect(apiMocks.updateSlide).toHaveBeenCalledTimes(1);
        expect(apiMocks.updateSlide).toHaveBeenNthCalledWith(
            1,
            'session-1',
            'slide-1',
            { title: 'Draft A' },
        );

        firstSave.resolve();
        await firstSave.promise;
        await flushQueueTurn();

        expect(apiMocks.updateSlide).toHaveBeenCalledTimes(2);
        expect(apiMocks.updateSlide).toHaveBeenNthCalledWith(
            2,
            'session-1',
            'slide-1',
            { title: 'Draft B' },
        );

        secondSave.resolve();
        await secondSave.promise;
    });
});

describe('slide structural commit helpers', () => {
    beforeEach(() => {
        apiMocks.applySlideOperations.mockReset();
        apiMocks.createSlide.mockReset();
        apiMocks.deleteSlide.mockReset();
        apiMocks.reorderSlides.mockReset();
        apiMocks.updateSlide.mockReset();
    });

    it('waits for a temp insert-after slide to resolve before creating the dependent slide', async () => {
        const firstCreate = deferred<{ id: string }>();
        const secondCreate = deferred<{ id: string }>();

        apiMocks.createSlide
            .mockReturnValueOnce(firstCreate.promise)
            .mockReturnValueOnce(secondCreate.promise);

        const committer = createSlideCreateCommitter('session-1');

        const firstRequest = committer.schedule({
            tempId: 'temp-1',
            slideType: 'static',
            content: { title: 'First' },
        });

        const secondRequest = committer.schedule({
            tempId: 'temp-2',
            slideType: 'static',
            content: { title: 'Second' },
            insertAfterSlideId: 'temp-1',
        });

        await flushQueueTurn();

        expect(apiMocks.createSlide).toHaveBeenCalledTimes(1);
        expect(apiMocks.createSlide).toHaveBeenNthCalledWith(
            1,
            'session-1',
            'static',
            { title: 'First' },
            undefined,
        );

        firstCreate.resolve({ id: 'slide-1' });
        await firstRequest;
        await flushQueueTurn();

        expect(apiMocks.createSlide).toHaveBeenCalledTimes(2);
        expect(apiMocks.createSlide).toHaveBeenNthCalledWith(
            2,
            'session-1',
            'static',
            { title: 'Second' },
            { insertAfterSlideId: 'slide-1' },
        );

        secondCreate.resolve({ id: 'slide-2' });
        await secondRequest;
    });

    it('falls back to creating without insert-after when the temp dependency failed', async () => {
        apiMocks.createSlide
            .mockRejectedValueOnce(new Error('create failed'))
            .mockResolvedValueOnce({ id: 'slide-2' });

        const committer = createSlideCreateCommitter('session-1');

        await expect(committer.schedule({
            tempId: 'temp-1',
            slideType: 'static',
            content: { title: 'First' },
        })).rejects.toThrow('create failed');

        await committer.schedule({
            tempId: 'temp-2',
            slideType: 'static',
            content: { title: 'Second' },
            insertAfterSlideId: 'temp-1',
        });

        expect(apiMocks.createSlide).toHaveBeenNthCalledWith(
            2,
            'session-1',
            'static',
            { title: 'Second' },
            undefined,
        );
    });

    it('preserves local temp-slide edits when the server confirms the created slide', () => {
        const result = reconcileCreatedSlide({
            localSlide: {
                id: 'temp-1',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'Edited after duplicate', body: 'Draft body' },
                orderIndex: 3,
                isHidden: false,
                version: 0,
            },
            serverSlide: {
                id: 'slide-99',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'Original copy', body: 'Original body' },
                orderIndex: 7,
                isHidden: false,
                version: 1,
            },
        });

        expect(result.slide).toEqual({
            id: 'slide-99',
            sessionId: 'session-1',
            type: 'static',
            content: { title: 'Edited after duplicate', body: 'Draft body' },
            orderIndex: 3,
            isHidden: false,
            version: 1,
        });
        expect(result.contentNeedingSync).toEqual({ title: 'Edited after duplicate', body: 'Draft body' });
    });

    it('uses the server slide directly when the temp slide was not edited locally', () => {
        const result = reconcileCreatedSlide({
            localSlide: {
                id: 'temp-1',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'Original copy', body: 'Original body' },
                orderIndex: 3,
                isHidden: false,
                version: 0,
            },
            serverSlide: {
                id: 'slide-99',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'Original copy', body: 'Original body' },
                orderIndex: 7,
                isHidden: false,
                version: 1,
            },
        });

        expect(result.slide).toEqual({
            id: 'slide-99',
            sessionId: 'session-1',
            type: 'static',
            content: { title: 'Original copy', body: 'Original body' },
            orderIndex: 3,
            isHidden: false,
            version: 1,
        });
        expect(result.contentNeedingSync).toBeNull();
    });

    it('forwards insertAfterSlideId to createSlide', async () => {
        apiMocks.createSlide.mockResolvedValueOnce({ id: 'slide-2' });

        await commitCreateSlide(
            'session-1',
            'static',
            { title: 'Duplicate' },
            { insertAfterSlideId: 'slide-1' },
        );

        expect(apiMocks.createSlide).toHaveBeenCalledWith(
            'session-1',
            'static',
            { title: 'Duplicate' },
            { insertAfterSlideId: 'slide-1' },
        );
    });

    it('does not swallow create failures', async () => {
        apiMocks.createSlide.mockRejectedValueOnce(new Error('create failed'));

        await expect(
            commitCreateSlide('session-1', 'static', { title: 'New slide' }),
        ).rejects.toThrow('create failed');
    });

    it('does not swallow delete failures', async () => {
        apiMocks.deleteSlide.mockRejectedValueOnce(new Error('delete failed'));

        await expect(
            commitDeleteSlide('session-1', 'slide-1'),
        ).rejects.toThrow('delete failed');
    });

    it('does not swallow reorder failures', async () => {
        apiMocks.reorderSlides.mockRejectedValueOnce(new Error('reorder failed'));

        await expect(
            commitReorderSlides('session-1', ['slide-2', 'slide-1']),
        ).rejects.toThrow('reorder failed');
    });

    it('builds delta operations instead of full-document sync for mixed edits', async () => {
        apiMocks.applySlideOperations.mockResolvedValueOnce([
            {
                id: 'slide-1',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'Updated A' },
                orderIndex: 0,
                isHidden: false,
                version: 2,
            },
            {
                id: 'slide-3',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'New C' },
                orderIndex: 1,
                isHidden: false,
                version: 1,
            },
        ]);

        const savedSlides = await saveEditorDocumentDelta(
            'session-1',
            [
                {
                    id: 'slide-1',
                    sessionId: 'session-1',
                    type: 'static',
                    content: { title: 'Original A' },
                    orderIndex: 0,
                    isHidden: false,
                    version: 1,
                },
                {
                    id: 'slide-2',
                    sessionId: 'session-1',
                    type: 'static',
                    content: { title: 'Original B' },
                    orderIndex: 1,
                    isHidden: false,
                    version: 1,
                },
            ],
            [
                {
                    id: 'slide-1',
                    serverId: 'slide-1',
                    sessionId: 'session-1',
                    type: 'static',
                    content: { title: 'Updated A' },
                    orderIndex: 0,
                    isHidden: false,
                    version: 1,
                },
                {
                    id: 'temp-1',
                    serverId: null,
                    sessionId: 'session-1',
                    type: 'static',
                    content: { title: 'New C' },
                    orderIndex: 1,
                    isHidden: false,
                    version: 0,
                },
            ],
        );

        expect(apiMocks.applySlideOperations).toHaveBeenCalledWith(
            'session-1',
            [
                {
                    op: 'update',
                    slideId: 'slide-1',
                    content: { title: 'Updated A' },
                    baseVersion: 1,
                },
                {
                    op: 'create',
                    tempId: 'temp-1',
                    type: 'static',
                    content: { title: 'New C' },
                    isHidden: false,
                    insertAfterSlideId: 'slide-1',
                },
                {
                    op: 'delete',
                    slideId: 'slide-2',
                },
            ],
        );
        expect(savedSlides).toHaveLength(2);
        expect(savedSlides[0].content).toEqual({ title: 'Updated A' });
        expect(savedSlides[1].content).toEqual({ title: 'New C' });
    });

    it('uses move operations to place a newly created front slide without renumbering the whole deck', async () => {
        apiMocks.applySlideOperations.mockResolvedValueOnce([
            {
                id: 'slide-9',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'Front' },
                orderIndex: 0,
                isHidden: false,
                version: 1,
            },
            {
                id: 'slide-1',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'A' },
                orderIndex: 1,
                isHidden: false,
                version: 1,
            },
        ]);

        await saveEditorDocumentDelta(
            'session-1',
            [
                {
                    id: 'slide-1',
                    sessionId: 'session-1',
                    type: 'static',
                    content: { title: 'A' },
                    orderIndex: 0,
                    isHidden: false,
                    version: 1,
                },
            ],
            [
                {
                    id: 'temp-front',
                    serverId: null,
                    sessionId: 'session-1',
                    type: 'static',
                    content: { title: 'Front' },
                    orderIndex: 0,
                    isHidden: false,
                    version: 0,
                },
                {
                    id: 'slide-1',
                    serverId: 'slide-1',
                    sessionId: 'session-1',
                    type: 'static',
                    content: { title: 'A' },
                    orderIndex: 1,
                    isHidden: false,
                    version: 1,
                },
            ],
        );

        expect(apiMocks.applySlideOperations).toHaveBeenCalledWith(
            'session-1',
            [
                {
                    op: 'create',
                    tempId: 'temp-front',
                    type: 'static',
                    content: { title: 'Front' },
                    isHidden: false,
                },
                {
                    op: 'move',
                    slideId: 'slide-1',
                    insertAfterSlideId: null,
                },
            ],
        );
    });

    it('uses serverId for insertAfterSlideId when adding multiple new slides in sequence', async () => {
        apiMocks.applySlideOperations.mockResolvedValueOnce([
            {
                id: 'slide-1',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'A' },
                orderIndex: 0,
                isHidden: false,
                version: 1,
            },
            {
                id: 'slide-2',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'New B' },
                orderIndex: 1,
                isHidden: false,
                version: 1,
            },
            {
                id: 'slide-3',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'New C' },
                orderIndex: 2,
                isHidden: false,
                version: 1,
            },
        ]);

        await saveEditorDocumentDelta(
            'session-1',
            [
                {
                    id: 'slide-1',
                    sessionId: 'session-1',
                    type: 'static',
                    content: { title: 'A' },
                    orderIndex: 0,
                    isHidden: false,
                    version: 1,
                },
            ],
            [
                {
                    id: 'slide-1',
                    serverId: 'slide-1',
                    sessionId: 'session-1',
                    type: 'static',
                    content: { title: 'A' },
                    orderIndex: 0,
                    isHidden: false,
                    version: 1,
                },
                {
                    id: 'temp-2',
                    serverId: null,
                    sessionId: 'session-1',
                    type: 'static',
                    content: { title: 'New B' },
                    orderIndex: 1,
                    isHidden: false,
                    version: 0,
                },
                {
                    id: 'temp-3',
                    serverId: null,
                    sessionId: 'session-1',
                    type: 'static',
                    content: { title: 'New C' },
                    orderIndex: 2,
                    isHidden: false,
                    version: 0,
                },
            ],
        );

        expect(apiMocks.applySlideOperations).toHaveBeenCalledWith(
            'session-1',
            [
                {
                    op: 'create',
                    tempId: 'temp-2',
                    type: 'static',
                    content: { title: 'New B' },
                    isHidden: false,
                    insertAfterSlideId: 'slide-1',
                },
                {
                    op: 'create',
                    tempId: 'temp-3',
                    type: 'static',
                    content: { title: 'New C' },
                    isHidden: false,
                    insertAfterSlideId: 'temp-2',
                },
            ],
        );
    });
});
