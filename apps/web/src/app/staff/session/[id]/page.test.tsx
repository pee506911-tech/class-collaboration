import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Slide, Session } from 'shared';

type EditorLikeSlide = Slide & { serverId?: string | null };

const dndState = vi.hoisted(() => ({
    dragEndHandlers: [] as Array<(result: unknown) => void | Promise<void>>,
}));

const apiMockState = vi.hoisted(() => ({
    applySlideOperations: vi.fn(),
    getSession: vi.fn(),
    getSlides: vi.fn(),
    updateSession: vi.fn(),
    goLiveSession: vi.fn(),
    stopSession: vi.fn(),
}));

const wsMockState = vi.hoisted(() => ({
    initialState: {
        currentSlideId: null,
        isPresentationActive: false,
        isBlackout: false,
        showResults: false,
        stateVersion: 1,
    } as Record<string, unknown>,
    lastSlideUpdate: 0,
}));

const toastMock = vi.hoisted(() => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
}));

const navigationMockState = vi.hoisted(() => ({
    router: {
        push: vi.fn(),
    },
}));

const editorMockState = vi.hoisted(() => ({
    latestSlide: null as EditorLikeSlide | null,
    onUpdate: null as null | ((content: Slide['content']) => Promise<{ status: 'saved' | 'queued' }>),
}));

vi.mock('next/navigation', () => ({
    useParams: () => ({ id: 'test-session-id' }),
    useRouter: () => navigationMockState.router,
}));

vi.mock('@hello-pangea/dnd', () => ({
    DragDropContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: (result: unknown) => void | Promise<void> }) => {
        dndState.dragEndHandlers.push(onDragEnd);
        return children;
    },
    Droppable: ({ children }: { children: (provided: any) => React.ReactNode }) => children({
        innerRef: vi.fn(),
        droppableProps: {},
        placeholder: null,
    }),
    Draggable: ({ children }: { children: (provided: any, snapshot: any) => React.ReactNode }) => children({
        innerRef: vi.fn(),
        draggableProps: {
            style: {},
            onTransitionEnd: undefined,
            'data-rfd-draggable-context-id': 'test-context',
            'data-rfd-draggable-id': 'test-draggable',
        },
        dragHandleProps: {
            tabIndex: 0,
            role: 'button',
            draggable: false,
            'aria-describedby': 'drag-handle',
            'data-rfd-drag-handle-context-id': 'test-context',
            'data-rfd-drag-handle-draggable-id': 'test-draggable',
            onDragStart: vi.fn(),
        },
    }, { isDragging: false }),
}));

vi.mock('sonner', () => ({
    toast: toastMock,
}));

vi.mock('@/lib/storage', () => ({
    safeLocalStorageGet: vi.fn((key: string) => key === 'token' ? 'valid-token' : null),
}));

vi.mock('@/lib/api', async () => {
    const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    return {
        ...actual,
        applySlideOperations: apiMockState.applySlideOperations,
        getSession: apiMockState.getSession,
        getSlides: apiMockState.getSlides,
        updateSession: apiMockState.updateSession,
        goLiveSession: apiMockState.goLiveSession,
        stopSession: apiMockState.stopSession,
    };
});

vi.mock('@/lib/websocket', async () => {
    const ReactModule = await import('react');

    return {
        WebSocketProvider: ({ children }: { children: React.ReactNode }) => children,
        useWebSocket: () => {
            const [state, setState] = ReactModule.useState<Record<string, unknown> | null>(wsMockState.initialState);
            return {
                sendMessage: vi.fn(() => Promise.resolve({ ok: true })),
                state,
                activeParticipants: 0,
                updateState: (updates: Record<string, unknown>) => {
                    setState((prev: Record<string, unknown> | null) => ({ ...(prev ?? {}), ...updates }));
                },
                initialStateLoaded: true,
                lastSlideUpdate: wsMockState.lastSlideUpdate,
            };
        },
    };
});

vi.mock('@/components/slide-renderer', () => ({
    SlideRenderer: ({ slide }: { slide: Slide }) => <div data-testid="slide-renderer">{slide.content.title || slide.content.question || slide.id}</div>,
}));

vi.mock('@/components/slide-editor-panel', () => ({
    SlideEditorPanel: ({
        slide,
        onUpdate,
    }: {
        slide: EditorLikeSlide;
        onUpdate: (content: Slide['content']) => Promise<{ status: 'saved' | 'queued' }>;
    }) => {
        editorMockState.latestSlide = slide;
        editorMockState.onUpdate = onUpdate;
        return (
            <div>
                <div data-testid="editor-slide-id">{slide.id}</div>
                <div data-testid="editor-slide-server-id">{slide.serverId ?? ''}</div>
                <div data-testid="editor-slide-title">{slide.content.title || slide.content.question || ''}</div>
            </div>
        );
    },
}));

vi.mock('@/components/qa-manager', () => ({
    QAManager: () => null,
}));

vi.mock('@/components/session-dashboard', () => ({
    SessionDashboard: () => null,
}));

vi.mock('@/components/slide-type-selector', () => ({
    SlideTypeSelector: () => null,
}));

vi.mock('@/components/ui/breadcrumb', () => ({
    Breadcrumb: () => null,
}));

function makeSession(): Session {
    return {
        id: 'test-session-id',
        title: 'Test Session',
        status: 'draft',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        allowQuestions: false,
        requireName: false,
        shareToken: 'share-token',
    };
}

function makeSlide(overrides: Partial<Slide> = {}): Slide {
    return {
        id: 'slide-1',
        sessionId: 'test-session-id',
        type: 'static',
        content: {
            title: 'Original title',
            body: 'Original body',
        },
        orderIndex: 0,
        isHidden: false,
        version: 1,
        ...overrides,
    };
}

async function renderPage() {
    const { default: SlideEditorPage } = await import('./page');
    render(<SlideEditorPage />);
}

async function duplicateAndEditDraft(title: string) {
    await waitFor(() => {
        expect(editorMockState.latestSlide?.id).toBe('slide-1');
    });

    fireEvent.click(screen.getByRole('button', { name: /duplicate/i }));

    await waitFor(() => {
        expect(editorMockState.latestSlide?.id).toMatch(/^temp-/);
    });

    await act(async () => {
        await editorMockState.onUpdate?.({
            ...editorMockState.latestSlide?.content,
            title,
        } as Slide['content']);
    });
}

describe('staff editor delta save flow', () => {
    beforeEach(() => {
        dndState.dragEndHandlers = [];
        apiMockState.applySlideOperations.mockReset();
        apiMockState.getSession.mockReset();
        apiMockState.getSlides.mockReset();
        apiMockState.updateSession.mockReset();
        apiMockState.goLiveSession.mockReset();
        apiMockState.stopSession.mockReset();
        navigationMockState.router.push.mockReset();
        editorMockState.latestSlide = null;
        editorMockState.onUpdate = null;
        toastMock.success.mockReset();
        toastMock.error.mockReset();
        toastMock.info.mockReset();

        apiMockState.getSession.mockResolvedValue(makeSession());
        apiMockState.getSlides.mockResolvedValue([makeSlide()]);
        apiMockState.applySlideOperations.mockResolvedValue([makeSlide()]);
        apiMockState.updateSession.mockResolvedValue(undefined);
        apiMockState.goLiveSession.mockResolvedValue(undefined);
        apiMockState.stopSession.mockResolvedValue(undefined);
    });

    it('keeps the latest edited duplicate content visible as local draft state before save', async () => {
        await renderPage();
        await duplicateAndEditDraft('Edited duplicate title');

        expect(editorMockState.latestSlide?.id).toMatch(/^temp-/);
        expect(editorMockState.latestSlide?.serverId).toBeNull();
        expect(editorMockState.latestSlide?.content.title).toBe('Edited duplicate title');
        expect(screen.getByText('Not saved')).toBeInTheDocument();
        expect(apiMockState.applySlideOperations).not.toHaveBeenCalled();
    });

    it('preserves the local duplicate draft on retryable save failures', async () => {
        const { ApiRequestError } = await import('@/lib/api');
        apiMockState.applySlideOperations.mockRejectedValueOnce(new ApiRequestError('Database error', { status: 500, retryable: true }));

        await renderPage();
        await duplicateAndEditDraft('Edited duplicate title');

        fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

        await waitFor(() => {
            expect(toastMock.error).toHaveBeenCalled();
        });

        expect(apiMockState.applySlideOperations).toHaveBeenCalledTimes(1);
        expect(apiMockState.getSlides).toHaveBeenCalledTimes(1);
        expect(editorMockState.latestSlide?.id).toMatch(/^temp-/);
        expect(editorMockState.latestSlide?.content.title).toBe('Edited duplicate title');
        expect(screen.getByText('Not saved')).toBeInTheDocument();
    });

    it('rebases to the latest server snapshot after a 409 save conflict', async () => {
        const { ApiRequestError } = await import('@/lib/api');
        apiMockState.applySlideOperations.mockRejectedValueOnce(
            new ApiRequestError('Slide has changed on the server', { status: 409, retryable: false }),
        );
        apiMockState.getSlides
            .mockResolvedValueOnce([makeSlide()])
            .mockResolvedValueOnce([
                makeSlide({
                    content: { title: 'Server title', body: 'Server body' },
                    version: 2,
                }),
            ]);

        await renderPage();
        await duplicateAndEditDraft('Edited duplicate title');

        fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

        await waitFor(() => {
            expect(apiMockState.getSlides).toHaveBeenCalledTimes(2);
        });

        await waitFor(() => {
            expect(editorMockState.latestSlide?.id).toBe('slide-1');
        });

        expect(editorMockState.latestSlide?.content.title).toBe('Server title');
        expect(screen.getByText('Saved')).toBeInTheDocument();
    });

    it('redirects to sessions on initial 404 load failures', async () => {
        const { ApiRequestError } = await import('@/lib/api');
        apiMockState.getSession.mockRejectedValueOnce(
            new ApiRequestError('Session not found', { status: 404, retryable: false }),
        );
        apiMockState.getSlides.mockRejectedValueOnce(
            new ApiRequestError('Session not found', { status: 404, retryable: false }),
        );

        await renderPage();

        await waitFor(() => {
            expect(screen.getByText('Redirecting to sessions...')).toBeInTheDocument();
        });

        expect(navigationMockState.router.push).toHaveBeenCalledWith('/sessions');
    });
});
