import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMockState = vi.hoisted(() => ({
    publicGetSlides: vi.fn(),
    publicSetCurrentSlide: vi.fn(),
}));

const wsMockState = vi.hoisted(() => ({
    initialState: {
        currentSlideId: 'slide-1',
        stateVersion: 1,
        isPresentationActive: true,
        isResultsVisible: false,
    },
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
        WebSocketProvider: ({ children }: { children: React.ReactNode }) => children,
        useWebSocket: () => {
            const [state, setState] = ReactModule.useState(wsMockState.initialState);

            return {
                state,
                isConnected: true,
                lastSlideUpdate: 0,
                initialStateLoaded: true,
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
        wsMockState.initialState = {
            currentSlideId: 'slide-1',
            stateVersion: 1,
            isPresentationActive: true,
            isResultsVisible: false,
        };
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
});
