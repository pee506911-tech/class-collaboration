import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMockState = vi.hoisted(() => ({
    publicGetSlides: vi.fn(),
    publicSetCurrentSlide: vi.fn(),
}));

const wsMockState = vi.hoisted(() => ({
    providerProps: null as null | { sessionId: string; role: string },
    initialState: {
        currentSlideId: 'slide-1',
        stateVersion: 1,
        isPresentationActive: true,
        isResultsVisible: false,
    },
    isConnected: true,
    isConnecting: false,
    initialStateLoaded: true,
    connectionError: null as string | null,
    initialStateError: null as string | null,
}));

vi.mock('next/navigation', () => ({
    useParams: () => ({ id: 'session-1' }),
}));

vi.mock('@/lib/api', () => ({
    publicGetSlides: apiMockState.publicGetSlides,
    publicSetCurrentSlide: apiMockState.publicSetCurrentSlide,
}));

vi.mock('@/lib/websocket', async () => {
    const ReactModule = await import('react');

    return {
        WebSocketProvider: ({
            children,
            sessionId,
            role,
        }: {
            children: React.ReactNode;
            sessionId: string;
            role: string;
        }) => {
            wsMockState.providerProps = { sessionId, role };
            return children;
        },
        useWebSocket: () => {
            const [state, setState] = ReactModule.useState(wsMockState.initialState);

            return {
                state,
                isConnected: wsMockState.isConnected,
                isConnecting: wsMockState.isConnecting,
                connectionError: wsMockState.connectionError,
                lastSlideUpdate: 0,
                initialStateLoaded: wsMockState.initialStateLoaded,
                initialStateError: wsMockState.initialStateError,
                updateState: (updates: Record<string, unknown>) => {
                    setState((prev) => ({ ...prev, ...updates }));
                },
            };
        },
    };
});

vi.mock('@/components/slide-renderer', () => ({
    SlideRenderer: ({ slide }: { slide: { id: string } }) => <div data-testid="slide-renderer">{slide.id}</div>,
}));

describe('ClickerPage', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        apiMockState.publicGetSlides.mockReset();
        apiMockState.publicSetCurrentSlide.mockReset();
        wsMockState.providerProps = null;
        wsMockState.initialState = {
            currentSlideId: 'slide-1',
            stateVersion: 1,
            isPresentationActive: true,
            isResultsVisible: false,
        };
        wsMockState.isConnected = true;
        wsMockState.isConnecting = false;
        wsMockState.initialStateLoaded = true;
        wsMockState.connectionError = null;
        wsMockState.initialStateError = null;
    });

    it('connects the mobile clicker with the public projector realtime role', async () => {
        apiMockState.publicGetSlides.mockResolvedValue([]);

        const { default: ClickerPage } = await import('./page');
        render(<ClickerPage />);

        await act(async () => {
            await Promise.resolve();
        });

        expect(wsMockState.providerProps).toEqual({
            sessionId: 'session-1',
            role: 'projector',
        });
    });

    it('sends the slide change request immediately after clicking next', async () => {
        apiMockState.publicGetSlides.mockResolvedValue([
            {
                id: 'slide-1',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'One', body: 'First' },
                orderIndex: 0,
                isHidden: false,
                version: 1,
            },
            {
                id: 'slide-2',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'Two', body: 'Second' },
                orderIndex: 1,
                isHidden: false,
                version: 1,
            },
        ]);
        apiMockState.publicSetCurrentSlide.mockResolvedValue({
            currentSlideId: 'slide-2',
            stateVersion: 2,
            isPresentationActive: true,
            isResultsVisible: false,
        });

        const { default: ClickerPage } = await import('./page');
        render(<ClickerPage />);

        const nextButton = screen.getByRole('button', { name: /next slide/i });

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(nextButton).not.toBeDisabled();

        fireEvent.click(nextButton);

        await act(async () => {
            await Promise.resolve();
        });

        expect(apiMockState.publicSetCurrentSlide).toHaveBeenCalledWith('session-1', 'slide-2');
    });

    it('does not fall back to slide 1 when there is no authoritative live slide yet', async () => {
        wsMockState.initialState = {
            currentSlideId: null,
            stateVersion: 1,
            isPresentationActive: true,
            isResultsVisible: false,
        };
        apiMockState.publicGetSlides.mockResolvedValue([
            {
                id: 'slide-1',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'One', body: 'First' },
                orderIndex: 0,
                isHidden: false,
                version: 1,
            },
            {
                id: 'slide-2',
                sessionId: 'session-1',
                type: 'static',
                content: { title: 'Two', body: 'Second' },
                orderIndex: 1,
                isHidden: false,
                version: 1,
            },
        ]);

        const { default: ClickerPage } = await import('./page');
        render(<ClickerPage />);

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(screen.getByText('No active slide')).toBeInTheDocument();
        expect(screen.queryByTestId('slide-renderer')).not.toBeInTheDocument();
    });

    it('shows the connection error instead of an endless loading message', async () => {
        wsMockState.isConnected = false;
        wsMockState.initialStateLoaded = true;
        wsMockState.connectionError = 'Authentication required: please log in again';
        apiMockState.publicGetSlides.mockResolvedValue([]);

        const { default: ClickerPage } = await import('./page');
        render(<ClickerPage />);

        await act(async () => {
            await Promise.resolve();
        });

        expect(screen.getByText('Unable to connect to Clicker')).toBeInTheDocument();
        expect(screen.getByText('Authentication required: please log in again')).toBeInTheDocument();
    });
});
