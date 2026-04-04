import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { httpFetch } from '@/lib/http';
import { ApiRequestError } from '@/lib/api';

const dndState = vi.hoisted(() => ({
    dragEndHandlers: [] as Array<(result: any) => void | Promise<void>>,
}));

const apiMockState = vi.hoisted(() => ({
    reorderSlides: vi.fn(),
}));

const queueMockState = vi.hoisted(() => ({
    onDeleteRollback: null as null | ((rollback: {
        restorePreviewSlideId: string | null;
        fallbackPreviewSlideId: string | null;
    }) => void),
    slides: null as null | any[],
    tempIdMap: {} as Record<string, string>,
    hasPendingStructuralMutations: false,
}));

// Mock next/navigation
const mockPush = vi.fn();
const mockSaveSlideUpdate = vi.fn();
const mockEnqueueCreateSlide = vi.fn();
const mockEnqueueDuplicateSlide = vi.fn();
const mockEnqueueDeleteSlide = vi.fn(() => ({ accepted: false }));
const mockClearInlineError = vi.fn();
const mockClearSessionInlineError = vi.fn();
const mockResolveOptimisticId = vi.fn((id: string | null) => id);
vi.mock('next/navigation', () => ({
    useParams: () => ({ id: 'test-session-id' }),
    useRouter: () => ({ push: mockPush }),
}));

vi.mock('@hello-pangea/dnd', () => ({
    DragDropContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: (result: any) => void | Promise<void> }) => {
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
        },
    }, { isDragging: false }),
}));

// Mock toast
const mockToast = {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
};
vi.mock('sonner', () => ({
    toast: mockToast,
}));

vi.mock('@/lib/api', async () => {
    const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    return {
        ...actual,
        reorderSlides: apiMockState.reorderSlides,
    };
});

// Mock localStorage
const mockStorage = new Map<string, string>();
const mockLocalStorage: Storage = {
    getItem: vi.fn((key: string) => mockStorage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { mockStorage.set(key, value); }),
    removeItem: vi.fn((key: string) => { mockStorage.delete(key); }),
    clear: vi.fn(() => { mockStorage.clear(); }),
    length: 0,
    key: vi.fn(),
};

Object.defineProperty(global, 'localStorage', {
    value: mockLocalStorage,
    writable: true,
});

Object.defineProperty(window, 'localStorage', {
    value: mockLocalStorage,
    writable: true,
});

Object.defineProperty(window, 'confirm', {
    value: vi.fn(() => true),
    writable: true,
});

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock httpFetch
vi.mock('@/lib/http', () => ({
    httpFetch: vi.fn(),
    createClientRequestId: () => 'test-request-id',
}));

vi.mock('@/lib/websocket', () => ({
    WebSocketProvider: ({ children }: { children: React.ReactNode }) => children,
    useWebSocket: () => ({
        sendMessage: vi.fn(),
        state: null,
        activeParticipants: 0,
        updateState: vi.fn(),
        initialStateLoaded: true,
    }),
}));

vi.mock('@/lib/use-optimistic-slide-queue', () => ({
    useOptimisticSlideQueue: ({ baseSlides, refreshBaseSlides, onDeleteRollback }: {
        baseSlides: any[];
        refreshBaseSlides: () => Promise<void>;
        onDeleteRollback?: (rollback: {
            restorePreviewSlideId: string | null;
            fallbackPreviewSlideId: string | null;
        }) => void;
    }) => {
        queueMockState.onDeleteRollback = onDeleteRollback ?? null;
        return {
            slides: queueMockState.slides ?? baseSlides,
            queueState: { tempIdMap: queueMockState.tempIdMap },
            enqueueCreateSlide: mockEnqueueCreateSlide,
            enqueueDuplicateSlide: mockEnqueueDuplicateSlide,
            enqueueDeleteSlide: mockEnqueueDeleteSlide,
            clearInlineError: mockClearInlineError,
            clearSessionInlineError: mockClearSessionInlineError,
            resolveOptimisticId: mockResolveOptimisticId,
            requestRefreshAfterDrain: refreshBaseSlides,
            hasPendingStructuralMutations: queueMockState.hasPendingStructuralMutations,
            sessionInlineError: null,
        };
    },
}));

vi.mock('@/lib/slide-update', () => ({
    saveSlideUpdate: mockSaveSlideUpdate,
    SlideVersionConflictError: class SlideVersionConflictError extends Error {},
}));

describe('SlideEditor session loading', () => {
    beforeEach(() => {
        mockStorage.clear();
        mockFetch.mockReset();
        mockPush.mockReset();
        mockSaveSlideUpdate.mockReset();
        mockEnqueueCreateSlide.mockReset();
        mockEnqueueDuplicateSlide.mockReset();
        mockEnqueueDeleteSlide.mockClear();
        mockClearInlineError.mockReset();
        mockClearSessionInlineError.mockReset();
        mockResolveOptimisticId.mockClear();
        apiMockState.reorderSlides.mockReset();
        dndState.dragEndHandlers = [];
        queueMockState.onDeleteRollback = null;
        queueMockState.slides = null;
        queueMockState.tempIdMap = {};
        queueMockState.hasPendingStructuralMutations = false;
        mockSaveSlideUpdate.mockResolvedValue({ status: 'saved' });
        apiMockState.reorderSlides.mockResolvedValue(undefined);
        vi.mocked(httpFetch).mockReset();
        vi.mocked(window.confirm).mockClear();
    });

    it('redirects to dashboard when session returns 404', async () => {
        // Arrange: authenticated user
        mockStorage.set('token', 'valid-token');

        // getSession/getSlides return 404 as ApiRequestError
        vi.mocked(httpFetch).mockImplementation(async (url: string) => {
            if (url.includes('/sessions/test-session-id')) {
                throw new ApiRequestError('Session not found', { status: 404, retryable: false });
            }
            return {
                response: {
                    ok: true,
                    json: async () => ({ success: true, data: [] }),
                },
            };
        });

        // Act: import and render component
        const { default: SlideEditor } = await import('./page');
        render(<SlideEditor />);

        // Assert: should redirect to sessions list
        await waitFor(() => {
            expect(mockPush).toHaveBeenCalledWith('/sessions');
        });

        // Should show appropriate error message
        expect(mockToast.error).toHaveBeenCalledWith('Session not found');
    });

    it('shows loading state while fetching session', async () => {
        // Arrange: authenticated user
        mockStorage.set('token', 'valid-token');

        // Slow responses
        vi.mocked(httpFetch).mockImplementation(async (url: string) => {
            await new Promise(resolve => setTimeout(resolve, 100));

            if (url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({ success: true, data: [] }),
                    },
                };
            }

            return {
                response: {
                    ok: true,
                    json: async () => ({
                        success: true,
                        data: {
                            id: 'test-session-id',
                            title: 'Test Session',
                            status: 'draft',
                            createdAt: '2024-01-01T00:00:00Z',
                            allowQuestions: false,
                            requireName: false,
                            createdBy: 'user-1',
                        },
                    }),
                },
            };
        });

        // Act
        const { default: SlideEditor } = await import('./page');
        render(<SlideEditor />);

        // Assert: should show loading indicator
        expect(screen.getByText('Loading session...')).toBeInTheDocument();
    });

    it('renders editor when session loads successfully', async () => {
        // Arrange: authenticated user
        mockStorage.set('token', 'valid-token');

        vi.mocked(httpFetch).mockImplementation(async (url: string) => {
            if (url.includes('/sessions/test-session-id') && !url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({
                            success: true,
                            data: {
                                id: 'test-session-id',
                                title: 'Test Session',
                                status: 'draft',
                                createdAt: '2024-01-01T00:00:00Z',
                                allowQuestions: false,
                                requireName: false,
                                createdBy: 'user-1',
                            },
                        }),
                    },
                };
            }
            if (url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({ success: true, data: [] }),
                    },
                };
            }
            return { response: { ok: true, json: async () => ({ success: true, data: null }) } };
        });

        // Act
        const { default: SlideEditor } = await import('./page');
        const { container } = render(<SlideEditor />);

        // Assert: should render editor (check for WebSocketProvider wrapper)
        await waitFor(() => {
            expect(screen.queryByText('Loading session...')).not.toBeInTheDocument();
        });
    });

    it('saves the latest option draft before switching to another slide', async () => {
        mockStorage.set('token', 'valid-token');

        vi.mocked(httpFetch).mockImplementation(async (url: string) => {
            if (url.includes('/sessions/test-session-id') && !url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({
                            success: true,
                            data: {
                                id: 'test-session-id',
                                title: 'Test Session',
                                status: 'draft',
                                createdAt: '2024-01-01T00:00:00Z',
                                allowQuestions: false,
                                requireName: false,
                                createdBy: 'user-1',
                            },
                        }),
                    },
                };
            }

            if (url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({
                            success: true,
                            data: [
                                {
                                    id: 'slide-poll',
                                    sessionId: 'test-session-id',
                                    type: 'poll',
                                    content: {
                                        question: 'Favorite color?',
                                        options: [
                                            { id: 'opt-1', text: 'Red' },
                                            { id: 'opt-2', text: 'Blue' },
                                        ],
                                        chartType: 'bar',
                                        limitSubmissions: true,
                                    },
                                    orderIndex: 0,
                                    isHidden: false,
                                    version: 1,
                                },
                                {
                                    id: 'slide-static',
                                    sessionId: 'test-session-id',
                                    type: 'static',
                                    content: {
                                        title: 'Agenda',
                                        body: 'Second slide',
                                    },
                                    orderIndex: 1,
                                    isHidden: false,
                                    version: 1,
                                },
                            ],
                        }),
                    },
                };
            }

            return { response: { ok: true, json: async () => ({ success: true, data: null }) } };
        });

        const { default: SlideEditor } = await import('./page');
        render(<SlideEditor />);

        const redInput = await screen.findByDisplayValue('Red');

        fireEvent.focus(redInput);
        fireEvent.change(redInput, { target: { value: 'Crimson' } });
        fireEvent.blur(redInput);
        fireEvent.click(await screen.findByText('Agenda'));

        await waitFor(() => {
            expect(mockSaveSlideUpdate).toHaveBeenCalledWith(expect.objectContaining({
                sessionId: 'test-session-id',
                slideId: 'slide-poll',
                content: expect.objectContaining({
                    question: 'Favorite color?',
                    options: expect.arrayContaining([
                        expect.objectContaining({ id: 'opt-1', text: 'Crimson' }),
                        expect.objectContaining({ id: 'opt-2', text: 'Blue' }),
                    ]),
                }),
            }));
        });

        expect(await screen.findByDisplayValue('Agenda')).toBeInTheDocument();
    });

    it('keeps a newer preview selection when delete rollback arrives late', async () => {
        mockStorage.set('token', 'valid-token');
        mockEnqueueDeleteSlide.mockReturnValueOnce({ accepted: true });

        vi.mocked(httpFetch).mockImplementation(async (url: string) => {
            if (url.includes('/sessions/test-session-id') && !url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({
                            success: true,
                            data: {
                                id: 'test-session-id',
                                title: 'Test Session',
                                status: 'draft',
                                createdAt: '2024-01-01T00:00:00Z',
                                allowQuestions: false,
                                requireName: false,
                                createdBy: 'user-1',
                            },
                        }),
                    },
                };
            }

            if (url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({
                            success: true,
                            data: [
                                {
                                    id: 'slide-poll',
                                    sessionId: 'test-session-id',
                                    type: 'poll',
                                    content: {
                                        question: 'Favorite color?',
                                        options: [
                                            { id: 'opt-1', text: 'Red' },
                                            { id: 'opt-2', text: 'Blue' },
                                        ],
                                        chartType: 'bar',
                                        limitSubmissions: true,
                                    },
                                    orderIndex: 0,
                                    isHidden: false,
                                    version: 1,
                                },
                                {
                                    id: 'slide-agenda',
                                    sessionId: 'test-session-id',
                                    type: 'static',
                                    content: {
                                        title: 'Agenda',
                                        body: 'Second slide',
                                    },
                                    orderIndex: 1,
                                    isHidden: false,
                                    version: 1,
                                },
                                {
                                    id: 'slide-wrap',
                                    sessionId: 'test-session-id',
                                    type: 'static',
                                    content: {
                                        title: 'Wrap up',
                                        body: 'Third slide',
                                    },
                                    orderIndex: 2,
                                    isHidden: false,
                                    version: 1,
                                },
                            ],
                        }),
                    },
                };
            }

            return { response: { ok: true, json: async () => ({ success: true, data: null }) } };
        });

        const { default: SlideEditor } = await import('./page');
        render(<SlideEditor />);

        await screen.findByDisplayValue('Red');

        fireEvent.click(screen.getByRole('button', { name: /delete/i }));
        expect(await screen.findByDisplayValue('Agenda')).toBeInTheDocument();

        fireEvent.click(screen.getAllByText('Wrap up')[0]);
        expect(await screen.findByDisplayValue('Wrap up')).toBeInTheDocument();

        act(() => {
            queueMockState.onDeleteRollback?.({
                restorePreviewSlideId: 'slide-poll',
                fallbackPreviewSlideId: 'slide-agenda',
            });
        });

        expect(screen.getByDisplayValue('Wrap up')).toBeInTheDocument();
    });

    it('falls back to an existing slide when the preview temp slide disappears', async () => {
        mockStorage.set('token', 'valid-token');
        mockEnqueueDuplicateSlide.mockReturnValueOnce('temp-duplicate');

        vi.mocked(httpFetch).mockImplementation(async (url: string) => {
            if (url.includes('/sessions/test-session-id') && !url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({
                            success: true,
                            data: {
                                id: 'test-session-id',
                                title: 'Test Session',
                                status: 'draft',
                                createdAt: '2024-01-01T00:00:00Z',
                                allowQuestions: false,
                                requireName: false,
                                createdBy: 'user-1',
                            },
                        }),
                    },
                };
            }

            if (url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({
                            success: true,
                            data: [
                                {
                                    id: 'slide-agenda',
                                    sessionId: 'test-session-id',
                                    type: 'static',
                                    content: {
                                        title: 'Agenda',
                                        body: 'First slide',
                                    },
                                    orderIndex: 0,
                                    isHidden: false,
                                    version: 1,
                                },
                                {
                                    id: 'slide-wrap',
                                    sessionId: 'test-session-id',
                                    type: 'static',
                                    content: {
                                        title: 'Wrap up',
                                        body: 'Second slide',
                                    },
                                    orderIndex: 1,
                                    isHidden: false,
                                    version: 1,
                                },
                            ],
                        }),
                    },
                };
            }

            return { response: { ok: true, json: async () => ({ success: true, data: null }) } };
        });

        const { default: SlideEditor } = await import('./page');
        const { rerender } = render(<SlideEditor />);

        expect(await screen.findByDisplayValue('Agenda')).toBeInTheDocument();

        queueMockState.slides = [
            {
                id: 'slide-agenda',
                sessionId: 'test-session-id',
                type: 'static',
                content: {
                    title: 'Agenda',
                    body: 'First slide',
                },
                orderIndex: 0,
                isHidden: false,
                version: 1,
            },
            {
                id: 'temp-duplicate',
                sessionId: 'test-session-id',
                type: 'static',
                content: {
                    title: 'Agenda',
                    body: 'First slide',
                },
                orderIndex: 1,
                isHidden: false,
                version: 0,
                optimistic: {
                    isPending: true,
                    isTemp: true,
                    disableEditing: true,
                    syncState: 'syncing',
                },
            },
            {
                id: 'slide-wrap',
                sessionId: 'test-session-id',
                type: 'static',
                content: {
                    title: 'Wrap up',
                    body: 'Second slide',
                },
                orderIndex: 2,
                isHidden: false,
                version: 1,
            },
        ];
        rerender(<SlideEditor />);

        fireEvent.click(screen.getByRole('button', { name: /duplicate/i }));

        await waitFor(() => {
            expect(screen.getByText('Preview: Slide 2')).toBeInTheDocument();
        });

        queueMockState.slides = null;
        rerender(<SlideEditor />);

        await waitFor(() => {
            expect(screen.getByDisplayValue('Agenda')).toBeInTheDocument();
        });
        expect(screen.getByText('Preview: Slide 1')).toBeInTheDocument();
    });

    it('keeps preview on the resolved slide when a temp duplicate is confirmed', async () => {
        mockStorage.set('token', 'valid-token');

        vi.mocked(httpFetch).mockImplementation(async (url: string) => {
            if (url.includes('/sessions/test-session-id') && !url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({
                            success: true,
                            data: {
                                id: 'test-session-id',
                                title: 'Test Session',
                                status: 'draft',
                                createdAt: '2024-01-01T00:00:00Z',
                                allowQuestions: false,
                                requireName: false,
                                createdBy: 'user-1',
                            },
                        }),
                    },
                };
            }

            if (url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({
                            success: true,
                            data: [
                                {
                                    id: 'slide-one',
                                    sessionId: 'test-session-id',
                                    type: 'static',
                                    content: {
                                        title: 'Slide 1',
                                        body: 'First',
                                    },
                                    orderIndex: 0,
                                    isHidden: false,
                                    version: 1,
                                },
                                {
                                    id: 'slide-twenty-three',
                                    sessionId: 'test-session-id',
                                    type: 'static',
                                    content: {
                                        title: 'Slide 23',
                                        body: 'Last confirmed slide',
                                    },
                                    orderIndex: 1,
                                    isHidden: false,
                                    version: 1,
                                },
                            ],
                        }),
                    },
                };
            }

            return { response: { ok: true, json: async () => ({ success: true, data: null }) } };
        });

        queueMockState.slides = [
            {
                id: 'slide-one',
                sessionId: 'test-session-id',
                type: 'static',
                content: {
                    title: 'Slide 1',
                    body: 'First',
                },
                orderIndex: 0,
                isHidden: false,
                version: 1,
            },
            {
                id: 'slide-twenty-three',
                sessionId: 'test-session-id',
                type: 'static',
                content: {
                    title: 'Slide 23',
                    body: 'Last confirmed slide',
                },
                orderIndex: 1,
                isHidden: false,
                version: 1,
            },
            {
                id: 'temp-duplicate',
                sessionId: 'test-session-id',
                type: 'static',
                content: {
                    title: 'Slide 24 draft',
                    body: 'Last confirmed slide',
                },
                orderIndex: 2,
                isHidden: false,
                version: 0,
                optimistic: {
                    isPending: true,
                    isTemp: true,
                    disableEditing: true,
                    syncState: 'syncing',
                },
            },
        ];

        const { default: SlideEditor } = await import('./page');
        const { rerender } = render(<SlideEditor />);

        fireEvent.click(await screen.findByText('Slide 24 draft'));
        expect(await screen.findByText('Preview: Slide 3')).toBeInTheDocument();

        queueMockState.tempIdMap = { 'temp-duplicate': 'slide-twenty-four' };
        queueMockState.slides = [
            {
                id: 'slide-one',
                sessionId: 'test-session-id',
                type: 'static',
                content: {
                    title: 'Slide 1',
                    body: 'First',
                },
                orderIndex: 0,
                isHidden: false,
                version: 1,
            },
            {
                id: 'slide-twenty-three',
                sessionId: 'test-session-id',
                type: 'static',
                content: {
                    title: 'Slide 23',
                    body: 'Last confirmed slide',
                },
                orderIndex: 1,
                isHidden: false,
                version: 1,
            },
            {
                id: 'slide-twenty-four',
                sessionId: 'test-session-id',
                type: 'static',
                content: {
                    title: 'Slide 24 draft',
                    body: 'Last confirmed slide',
                },
                orderIndex: 2,
                isHidden: false,
                version: 1,
            },
        ];

        rerender(<SlideEditor />);

        expect(await screen.findByText('Preview: Slide 3')).toBeInTheDocument();
        expect(screen.queryByText('Preview: Slide 1')).not.toBeInTheDocument();
    });

    it('keeps a confirmed slide editable while a new temp slide is still syncing', async () => {
        mockStorage.set('token', 'valid-token');
        queueMockState.hasPendingStructuralMutations = true;

        vi.mocked(httpFetch).mockImplementation(async (url: string) => {
            if (url.includes('/sessions/test-session-id') && !url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({
                            success: true,
                            data: {
                                id: 'test-session-id',
                                title: 'Test Session',
                                status: 'draft',
                                createdAt: '2024-01-01T00:00:00Z',
                                allowQuestions: false,
                                requireName: false,
                                createdBy: 'user-1',
                            },
                        }),
                    },
                };
            }

            if (url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({
                            success: true,
                            data: [
                                {
                                    id: 'slide-agenda',
                                    sessionId: 'test-session-id',
                                    type: 'static',
                                    content: {
                                        title: 'Agenda',
                                        body: 'First slide',
                                    },
                                    orderIndex: 0,
                                    isHidden: false,
                                    version: 1,
                                },
                                {
                                    id: 'slide-wrap',
                                    sessionId: 'test-session-id',
                                    type: 'static',
                                    content: {
                                        title: 'Wrap up',
                                        body: 'Second slide',
                                    },
                                    orderIndex: 1,
                                    isHidden: false,
                                    version: 1,
                                },
                            ],
                        }),
                    },
                };
            }

            return { response: { ok: true, json: async () => ({ success: true, data: null }) } };
        });

        queueMockState.slides = [
            {
                id: 'slide-agenda',
                sessionId: 'test-session-id',
                type: 'static',
                content: {
                    title: 'Agenda',
                    body: 'First slide',
                },
                orderIndex: 0,
                isHidden: false,
                version: 1,
            },
            {
                id: 'temp-new-slide',
                sessionId: 'test-session-id',
                type: 'static',
                content: {
                    title: 'New Slide',
                    body: 'Content here',
                },
                orderIndex: 1,
                isHidden: false,
                version: 0,
                optimistic: {
                    isPending: true,
                    isTemp: true,
                    disableEditing: true,
                    syncState: 'syncing',
                },
            },
            {
                id: 'slide-wrap',
                sessionId: 'test-session-id',
                type: 'static',
                content: {
                    title: 'Wrap up',
                    body: 'Second slide',
                },
                orderIndex: 2,
                isHidden: false,
                version: 1,
            },
        ];

        const { default: SlideEditor } = await import('./page');
        render(<SlideEditor />);

        fireEvent.click(await screen.findByText('New Slide'));
        expect(await screen.findByDisplayValue('New Slide')).toBeDisabled();

        fireEvent.click(screen.getAllByText('Agenda')[0]);

        const agendaInput = await screen.findByDisplayValue('Agenda');
        expect(agendaInput).not.toBeDisabled();
        expect(screen.queryByText('This slide is temporarily locked while structural changes are syncing.')).not.toBeInTheDocument();
    });

    it('keeps the delete fallback slide editable while the delete is still syncing', async () => {
        mockStorage.set('token', 'valid-token');
        queueMockState.hasPendingStructuralMutations = true;
        queueMockState.slides = [
            {
                id: 'slide-wrap',
                sessionId: 'test-session-id',
                type: 'static',
                content: {
                    title: 'Wrap up',
                    body: 'Second slide',
                },
                orderIndex: 0,
                isHidden: false,
                version: 1,
            },
        ];

        vi.mocked(httpFetch).mockImplementation(async (url: string) => {
            if (url.includes('/sessions/test-session-id') && !url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({
                            success: true,
                            data: {
                                id: 'test-session-id',
                                title: 'Test Session',
                                status: 'draft',
                                createdAt: '2024-01-01T00:00:00Z',
                                allowQuestions: false,
                                requireName: false,
                                createdBy: 'user-1',
                            },
                        }),
                    },
                };
            }

            if (url.includes('/slides')) {
                return {
                    response: {
                        ok: true,
                        json: async () => ({
                            success: true,
                            data: [
                                {
                                    id: 'slide-agenda',
                                    sessionId: 'test-session-id',
                                    type: 'static',
                                    content: {
                                        title: 'Agenda',
                                        body: 'First slide',
                                    },
                                    orderIndex: 0,
                                    isHidden: false,
                                    version: 1,
                                },
                                {
                                    id: 'slide-wrap',
                                    sessionId: 'test-session-id',
                                    type: 'static',
                                    content: {
                                        title: 'Wrap up',
                                        body: 'Second slide',
                                    },
                                    orderIndex: 1,
                                    isHidden: false,
                                    version: 1,
                                },
                            ],
                        }),
                    },
                };
            }

            return { response: { ok: true, json: async () => ({ success: true, data: null }) } };
        });

        const { default: SlideEditor } = await import('./page');
        render(<SlideEditor />);

        const wrapInput = await screen.findByDisplayValue('Wrap up');
        expect(wrapInput).not.toBeDisabled();
        expect(screen.queryByText('This slide is temporarily locked while structural changes are syncing.')).not.toBeInTheDocument();
    });
});
