import { describe, expect, it, vi } from 'vitest';
import type { Slide } from 'shared';

import { ApiRequestError } from '@/lib/api';
import { saveSlideUpdate, SlideVersionConflictError } from '@/lib/slide-update';

function makeSlide(overrides: Partial<Slide> = {}): Slide {
    return {
        id: 'slide-1',
        sessionId: 'session-1',
        type: 'static',
        content: { title: 'Original', body: 'Body' },
        orderIndex: 0,
        isHidden: false,
        version: 0,
        ...overrides,
    };
}

describe('saveSlideUpdate', () => {
    it('replaces the optimistic slide with the saved server slide on success', async () => {
        let slides = [makeSlide()];
        const refreshSlides = vi.fn();
        const saveSlide = vi.fn().mockResolvedValue(makeSlide({
            content: { title: 'Server', body: 'Updated' },
            version: 1,
        }));

        await saveSlideUpdate({
            sessionId: 'session-1',
            slideId: 'slide-1',
            content: { title: 'Local', body: 'Updated' },
            baseSlides: slides,
            resolveOptimisticId: () => null,
            setBaseSlides: (updater) => {
                slides = typeof updater === 'function' ? updater(slides) : updater;
            },
            saveSlide,
            refreshSlides,
        });

        expect(saveSlide).toHaveBeenCalledWith('session-1', 'slide-1', { title: 'Local', body: 'Updated' }, 0);
        expect(refreshSlides).not.toHaveBeenCalled();
        expect(slides[0]).toMatchObject({
            content: { title: 'Server', body: 'Updated' },
            version: 1,
        });
    });

    it('refreshes from the server and throws a conflict error on 409', async () => {
        let slides = [makeSlide()];
        const refreshSlides = vi.fn().mockImplementation(async () => {
            slides = [makeSlide({
                content: { title: 'Remote', body: 'Current' },
                version: 2,
            })];
        });
        const saveSlide = vi.fn().mockRejectedValue(
            new ApiRequestError('Slide has changed on the server', { status: 409, retryable: false }),
        );

        await expect(
            saveSlideUpdate({
                sessionId: 'session-1',
                slideId: 'slide-1',
                content: { title: 'Local', body: 'Updated' },
                baseSlides: slides,
                resolveOptimisticId: () => null,
                setBaseSlides: (updater) => {
                    slides = typeof updater === 'function' ? updater(slides) : updater;
                },
                saveSlide,
                refreshSlides,
            }),
        ).rejects.toThrow(SlideVersionConflictError);

        expect(refreshSlides).toHaveBeenCalledTimes(1);
        expect(slides[0]).toMatchObject({
            content: { title: 'Remote', body: 'Current' },
            version: 2,
        });
    });

    it('rolls back the optimistic change on non-conflict failures', async () => {
        let slides = [makeSlide()];
        const refreshSlides = vi.fn();
        const saveSlide = vi.fn().mockRejectedValue(
            new ApiRequestError('Server error', { status: 500, retryable: true }),
        );

        await expect(
            saveSlideUpdate({
                sessionId: 'session-1',
                slideId: 'slide-1',
                content: { title: 'Local', body: 'Updated' },
                baseSlides: slides,
                resolveOptimisticId: () => null,
                setBaseSlides: (updater) => {
                    slides = typeof updater === 'function' ? updater(slides) : updater;
                },
                saveSlide,
                refreshSlides,
            }),
        ).rejects.toThrow('Server error');

        expect(refreshSlides).not.toHaveBeenCalled();
        expect(slides[0]).toMatchObject({
            content: { title: 'Original', body: 'Body' },
            version: 0,
        });
    });
});
