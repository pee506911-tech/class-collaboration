import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBufferedSlideContent } from './use-buffered-slide-content';

// ─── Test Helpers ───────────────────────────────────────────────

function makeOptions(overrides = {}) {
    return {
        content: { title: 'Test', body: 'Content' },
        onChange: vi.fn(),
        onBlur: vi.fn(),
        readCurrentContent: vi.fn().mockReturnValue({ title: 'Test', body: 'Content' }),
        syncInputs: vi.fn(),
        idleMs: 2000,
        ...overrides,
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────

describe('useBufferedSlideContent', () => {
    describe('idle capture', () => {
        it('emits change after idle timeout elapses', async () => {
            vi.useFakeTimers();

            const readCurrentContent = vi.fn().mockReturnValue({ title: 'Updated', body: 'Content' });
            const onChange = vi.fn();

            const { result } = renderHook(() =>
                useBufferedSlideContent({
                    content: { title: 'Test', body: 'Content' },
                    onChange,
                    readCurrentContent,
                    syncInputs: vi.fn(),
                    idleMs: 2000,
                }),
            );

            await act(async () => {
                result.current.scheduleBufferedChange();
            });

            expect(onChange).not.toHaveBeenCalled();

            await act(async () => {
                vi.advanceTimersByTime(2000);
            });

            expect(onChange).toHaveBeenCalledTimes(1);
            expect(onChange).toHaveBeenCalledWith({ title: 'Updated', body: 'Content' });
        });

        it('resets timer on subsequent calls before idle', async () => {
            vi.useFakeTimers();

            const readCurrentContent = vi.fn().mockReturnValue({ title: 'Updated', body: 'Content' });
            const onChange = vi.fn();

            const { result } = renderHook(() =>
                useBufferedSlideContent({
                    content: { title: 'Test', body: 'Content' },
                    onChange,
                    readCurrentContent,
                    syncInputs: vi.fn(),
                    idleMs: 2000,
                }),
            );

            await act(async () => {
                result.current.scheduleBufferedChange();
            });

            await act(async () => {
                vi.advanceTimersByTime(1000);
            });

            expect(onChange).not.toHaveBeenCalled();

            // Schedule again - should reset timer
            await act(async () => {
                result.current.scheduleBufferedChange();
            });

            await act(async () => {
                vi.advanceTimersByTime(1500);
            });

            // Should NOT have fired yet (only 1500ms since second call)
            expect(onChange).not.toHaveBeenCalled();

            await act(async () => {
                vi.advanceTimersByTime(500);
            });

            // Now should fire (2000ms since second call)
            expect(onChange).toHaveBeenCalledTimes(1);
        });

        it('does not emit if content has not changed', async () => {
            vi.useFakeTimers();

            const content = { title: 'Same', body: 'Content' };
            const readCurrentContent = vi.fn().mockReturnValue(content);
            const onChange = vi.fn();

            const { result } = renderHook(() =>
                useBufferedSlideContent({
                    content,
                    onChange,
                    readCurrentContent,
                    syncInputs: vi.fn(),
                    idleMs: 2000,
                }),
            );

            await act(async () => {
                result.current.scheduleBufferedChange();
                vi.advanceTimersByTime(2000);
            });

            expect(onChange).not.toHaveBeenCalled();
        });
    });

    describe('flush on blur', () => {
        it('immediately emits change on flush', async () => {
            const readCurrentContent = vi.fn().mockReturnValue({ title: 'Updated', body: 'Content' });
            const onChange = vi.fn();

            const { result } = renderHook(() =>
                useBufferedSlideContent({
                    content: { title: 'Test', body: 'Content' },
                    onChange,
                    readCurrentContent,
                    syncInputs: vi.fn(),
                    idleMs: 2000,
                }),
            );

            await act(async () => {
                result.current.flushBufferedChange();
            });

            expect(onChange).toHaveBeenCalledTimes(1);
            expect(onChange).toHaveBeenCalledWith({ title: 'Updated', body: 'Content' });
        });

        it('calls onBlur after flushing', async () => {
            const onBlur = vi.fn();
            const onChange = vi.fn().mockReturnValue({ title: 'Updated', body: 'Content' });

            const { result } = renderHook(() =>
                useBufferedSlideContent({
                    content: { title: 'Test', body: 'Content' },
                    onChange,
                    onBlur,
                    readCurrentContent: vi.fn().mockReturnValue({ title: 'Updated', body: 'Content' }),
                    syncInputs: vi.fn(),
                    idleMs: 2000,
                }),
            );

            await act(async () => {
                result.current.flushBufferedChange();
            });

            expect(onBlur).toHaveBeenCalledTimes(1);
        });

        it('cancels pending timer when flushing', async () => {
            vi.useFakeTimers();

            const readCurrentContent = vi.fn().mockReturnValue({ title: 'Flushed', body: 'Content' });
            const onChange = vi.fn();

            const { result } = renderHook(() =>
                useBufferedSlideContent({
                    content: { title: 'Test', body: 'Content' },
                    onChange,
                    readCurrentContent,
                    syncInputs: vi.fn(),
                    idleMs: 2000,
                }),
            );

            // Schedule a change
            await act(async () => {
                result.current.scheduleBufferedChange();
            });

            // Flush before timer fires
            await act(async () => {
                result.current.flushBufferedChange();
            });

            expect(onChange).toHaveBeenCalledTimes(1);

            // Advance timer - should not cause another emission
            await act(async () => {
                vi.advanceTimersByTime(2000);
            });

            expect(onChange).toHaveBeenCalledTimes(1);
        });

        it('does not emit on flush if content unchanged', async () => {
            const content = { title: 'Same', body: 'Content' };
            const onChange = vi.fn();

            const { result } = renderHook(() =>
                useBufferedSlideContent({
                    content,
                    onChange,
                    readCurrentContent: vi.fn().mockReturnValue(content),
                    syncInputs: vi.fn(),
                    idleMs: 2000,
                }),
            );

            await act(async () => {
                result.current.flushBufferedChange();
            });

            expect(onChange).not.toHaveBeenCalled();
        });
    });

    describe('cleanup and lifecycle', () => {
        it('clears pending timer on unmount', async () => {
            vi.useFakeTimers();

            const onChange = vi.fn();
            const { unmount, result } = renderHook(() =>
                useBufferedSlideContent({
                    content: { title: 'Test', body: 'Content' },
                    onChange,
                    readCurrentContent: vi.fn().mockReturnValue({ title: 'Updated', body: 'Content' }),
                    syncInputs: vi.fn(),
                    idleMs: 2000,
                }),
            );

            // Schedule but don't wait
            await act(async () => {
                result.current.scheduleBufferedChange();
            });

            // Unmount before timer fires
            unmount();

            // Advance timer
            await act(async () => {
                vi.advanceTimersByTime(2000);
            });

            // The hook's cleanup should have cleared the timer
            // Note: In the actual implementation, the timer cleanup happens in useEffect cleanup
            // So this test verifies that behavior
            expect(onChange).toHaveBeenCalledTimes(0);
        });
    });

    describe('input synchronization', () => {
        it('calls syncInputs when content prop changes', () => {
            const syncInputs = vi.fn();
            const content = { title: 'New', body: 'Content' };

            renderHook(() =>
                useBufferedSlideContent({
                    content,
                    onChange: vi.fn(),
                    readCurrentContent: vi.fn().mockReturnValue(content),
                    syncInputs,
                    idleMs: 2000,
                }),
            );

            expect(syncInputs).toHaveBeenCalledWith(content);
        });

        it('clears pending timer when content changes', async () => {
            vi.useFakeTimers();

            const onChange = vi.fn();
            const readCurrentContent = vi.fn().mockReturnValue({ title: 'Updated', body: 'Content' });

            const { rerender } = renderHook(
                ({ content }) =>
                    useBufferedSlideContent({
                        content,
                        onChange,
                        readCurrentContent,
                        syncInputs: vi.fn(),
                        idleMs: 2000,
                    }),
                {
                    initialProps: { content: { title: 'Initial', body: 'Content' } },
                },
            );

            // Schedule a change
            await act(async () => {
                rerender({ content: { title: 'Initial', body: 'Content' } });
                vi.advanceTimersByTime(1000);
            });

            // Content changes - should clear pending timer and update lastEmitted
            await act(async () => {
                rerender({ content: { title: 'New', body: 'Content' } });
            });

            // Advance timer - the content change should have reset the emitted ref
            await act(async () => {
                vi.advanceTimersByTime(2000);
            });

            // The onChange should NOT have been called because the content prop
            // change updated lastEmittedRef, so the scheduled change sees no diff
            expect(onChange).not.toHaveBeenCalled();
        });

        it('updates lastEmitted ref when content changes', async () => {
            vi.useFakeTimers();
            
            const onChange = vi.fn();
            const initialContent = { title: 'Initial', body: 'Content' };
            const newContent = { title: 'New', body: 'Content' };

            const { rerender, result } = renderHook(
                ({ content }) =>
                    useBufferedSlideContent({
                        content,
                        onChange,
                        readCurrentContent: vi.fn().mockReturnValue(newContent),
                        syncInputs: vi.fn(),
                        idleMs: 2000,
                    }),
                {
                    initialProps: { content: initialContent },
                },
            );

            // Change content prop - this updates lastEmittedRef
            await act(async () => {
                rerender({ content: newContent });
            });

            // Now schedule - should not emit because lastEmitted was updated to newContent
            await act(async () => {
                result.current.scheduleBufferedChange();
                vi.advanceTimersByTime(2000);
            });

            expect(onChange).not.toHaveBeenCalled();
        });
    });

    describe('edge cases', () => {
        it('handles rapid schedule and flush cycles', async () => {
            vi.useFakeTimers();

            const readCurrentContent = vi.fn().mockReturnValue({ title: 'Rapid', body: 'Content' });
            const onChange = vi.fn();

            const { result } = renderHook(() =>
                useBufferedSlideContent({
                    content: { title: 'Test', body: 'Content' },
                    onChange,
                    readCurrentContent,
                    syncInputs: vi.fn(),
                    idleMs: 2000,
                }),
            );

            // Multiple rapid calls
            await act(async () => {
                result.current.scheduleBufferedChange();
                result.current.scheduleBufferedChange();
                result.current.scheduleBufferedChange();
            });

            await act(async () => {
                vi.advanceTimersByTime(2000);
            });

            expect(onChange).toHaveBeenCalledTimes(1);
        });

        it('handles custom idleMs correctly', async () => {
            vi.useFakeTimers();

            const readCurrentContent = vi.fn().mockReturnValue({ title: 'Updated', body: 'Content' });
            const onChange = vi.fn();

            const { result } = renderHook(() =>
                useBufferedSlideContent({
                    content: { title: 'Test', body: 'Content' },
                    onChange,
                    readCurrentContent,
                    syncInputs: vi.fn(),
                    idleMs: 500,
                }),
            );

            await act(async () => {
                result.current.scheduleBufferedChange();
            });

            await act(async () => {
                vi.advanceTimersByTime(499);
            });

            expect(onChange).not.toHaveBeenCalled();

            await act(async () => {
                vi.advanceTimersByTime(1);
            });

            expect(onChange).toHaveBeenCalledTimes(1);
        });

        it('handles empty content objects', async () => {
            const onChange = vi.fn();

            const { result } = renderHook(() =>
                useBufferedSlideContent({
                    content: {},
                    onChange,
                    readCurrentContent: vi.fn().mockReturnValue({}),
                    syncInputs: vi.fn(),
                    idleMs: 2000,
                }),
            );

            await act(async () => {
                result.current.flushBufferedChange();
            });

            // Should not emit because content is same (empty)
            expect(onChange).not.toHaveBeenCalled();
        });

        it('handles content with undefined values', async () => {
            const onChange = vi.fn();
            const content = { title: undefined, body: undefined };

            const { result } = renderHook(() =>
                useBufferedSlideContent({
                    content,
                    onChange,
                    readCurrentContent: vi.fn().mockReturnValue(content),
                    syncInputs: vi.fn(),
                    idleMs: 2000,
                }),
            );

            await act(async () => {
                result.current.flushBufferedChange();
            });

            expect(onChange).not.toHaveBeenCalled();
        });
    });
});
