import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { httpFetch } from '@/lib/http';
import { ApiRequestError } from '@/lib/api';

// Mock next/navigation
const mockPush = vi.fn();
const mockSaveSlideUpdate = vi.fn();
const mockEnqueueCreateSlide = vi.fn();
const mockEnqueueDuplicateSlide = vi.fn();
const mockEnqueueDeleteSlide = vi.fn(() => ({ accepted: false }));
const mockClearInlineError = vi.fn();
const mockClearSessionInlineError = vi.fn();
const mockResolveOptimisticId = vi.fn((id: string | null) => id);
const mockQueueState = { tempIdMap: {} };

vi.mock('next/navigation', () => ({
    useParams: () => ({ id: 'test-session-id' }),
    useRouter: () => ({ push: mockPush }),
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
    useOptimisticSlideQueue: ({ baseSlides, refreshBaseSlides }: {
        baseSlides: any[];
        refreshBaseSlides: () => Promise<void>;
    }) => ({
        slides: baseSlides,
        queueState: mockQueueState,
        enqueueCreateSlide: mockEnqueueCreateSlide,
        enqueueDuplicateSlide: mockEnqueueDuplicateSlide,
        enqueueDeleteSlide: mockEnqueueDeleteSlide,
        clearInlineError: mockClearInlineError,
        clearSessionInlineError: mockClearSessionInlineError,
        resolveOptimisticId: mockResolveOptimisticId,
        requestRefreshAfterDrain: refreshBaseSlides,
        hasPendingStructuralMutations: false,
        sessionInlineError: null,
    }),
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
        mockSaveSlideUpdate.mockResolvedValue({ status: 'saved' });
        vi.mocked(httpFetch).mockReset();
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
});
