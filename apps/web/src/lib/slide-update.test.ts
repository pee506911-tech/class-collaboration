import { describe, expect, it, vi } from 'vitest';
import type { Slide } from 'shared';

import { ApiRequestError } from '@/lib/api';
import { saveSlideUpdate } from '@/lib/slide-update';

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
        const saveSlide = vi.fn().mockResolvedValue(makeSlide({
            content: { title: 'Server', body: 'Updated' },
            version: 1,
        }));

        await saveSlideUpdate({
            sessionId: 'session-1',
            slideId: 'slide-1',
            content: { title: 'Local', body: 'Updated' },
            getBaseSlides: () => slides,
            resolveOptimisticId: () => null,
            setBaseSlides: (updater) => {
                slides = typeof updater === 'function' ? updater(slides) : updater;
            },
            saveSlide,
        });

        expect(saveSlide).toHaveBeenCalledWith('session-1', 'slide-1', { title: 'Local', body: 'Updated' });
        expect(slides[0]).toMatchObject({
            content: { title: 'Server', body: 'Updated' },
            version: 1,
        });
    });

    it('keeps the latest local draft when a save fails', async () => {
        let slides = [makeSlide()];
        const saveSlide = vi.fn().mockRejectedValue(
            new ApiRequestError('Server error', { status: 500, retryable: true }),
        );

        await expect(
            saveSlideUpdate({
                sessionId: 'session-1',
                slideId: 'slide-1',
                content: { title: 'Local', body: 'Updated' },
                getBaseSlides: () => slides,
                resolveOptimisticId: () => null,
                setBaseSlides: (updater) => {
                    slides = typeof updater === 'function' ? updater(slides) : updater;
                },
                saveSlide,
            }),
        ).rejects.toThrow('Server error');
        expect(slides[0]).toMatchObject({
            content: { title: 'Local', body: 'Updated' },
            version: 0,
        });
    });

    it('does not treat 409 responses as a special conflict path', async () => {
        let slides = [makeSlide()];
        const saveSlide = vi.fn().mockRejectedValue(
            new ApiRequestError('Slide has changed on the server', { status: 409, retryable: false }),
        );

        await expect(
            saveSlideUpdate({
                sessionId: 'session-1',
                slideId: 'slide-1',
                content: { title: 'Local', body: 'Updated' },
                getBaseSlides: () => slides,
                resolveOptimisticId: () => null,
                setBaseSlides: (updater) => {
                    slides = typeof updater === 'function' ? updater(slides) : updater;
                },
                saveSlide,
            }),
        ).rejects.toThrow('Slide has changed on the server');

        expect(slides[0]).toMatchObject({
            content: { title: 'Local', body: 'Updated' },
            version: 0,
        });
    });

    it('preserves the current order and visibility when a save response arrives with stale structural fields', async () => {
        let slides = [makeSlide({ orderIndex: 4, isHidden: true, version: 3 })];
        const saveSlide = vi.fn().mockResolvedValue(makeSlide({
            content: { title: 'Saved', body: 'Updated' },
            orderIndex: 0,
            isHidden: false,
            version: 4,
        }));

        await saveSlideUpdate({
            sessionId: 'session-1',
            slideId: 'slide-1',
            content: { title: 'Local', body: 'Updated' },
            getBaseSlides: () => slides,
            resolveOptimisticId: () => null,
            setBaseSlides: (updater) => {
                slides = typeof updater === 'function' ? updater(slides) : updater;
            },
            saveSlide,
        });

        expect(slides[0]).toMatchObject({
            content: { title: 'Saved', body: 'Updated' },
            orderIndex: 4,
            isHidden: true,
            version: 4,
        });
    });

    it('uses the latest slide version for back-to-back saves', async () => {
        let slides = [makeSlide({ version: 0 })];
        const saveSlide = vi.fn()
            .mockResolvedValueOnce(makeSlide({
                content: { title: 'First', body: 'Body' },
                version: 1,
            }))
            .mockResolvedValueOnce(makeSlide({
                content: { title: 'Second', body: 'Body' },
                version: 2,
            }));

        await saveSlideUpdate({
            sessionId: 'session-1',
            slideId: 'slide-1',
            content: { title: 'First', body: 'Body' },
            getBaseSlides: () => slides,
            resolveOptimisticId: () => null,
            setBaseSlides: (updater) => {
                slides = typeof updater === 'function' ? updater(slides) : updater;
            },
            saveSlide,
        });

        await saveSlideUpdate({
            sessionId: 'session-1',
            slideId: 'slide-1',
            content: { title: 'Second', body: 'Body' },
            getBaseSlides: () => slides,
            resolveOptimisticId: () => null,
            setBaseSlides: (updater) => {
                slides = typeof updater === 'function' ? updater(slides) : updater;
            },
            saveSlide,
        });

        expect(saveSlide).toHaveBeenNthCalledWith(1, 'session-1', 'slide-1', { title: 'First', body: 'Body' });
        expect(saveSlide).toHaveBeenNthCalledWith(2, 'session-1', 'slide-1', { title: 'Second', body: 'Body' });
        expect(slides[0]).toMatchObject({ version: 2 });
    });
});
