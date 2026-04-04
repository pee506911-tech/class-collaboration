import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * useDebouncedValue — a minimal debounce utility for triggering refetches
 * when a numeric timestamp (lastSlideUpdate) changes rapidly.
 *
 * Behavior:
 * - When value changes, start/restart a delay timer.
 * - After the timer elapses with no further changes, call the callback.
 * - If the value changes again before the timer fires, the timer resets.
 */
import { useDebouncedValue } from './use-debounced-slide-refetch';

describe('useDebouncedValue', () => {
    it('calls the callback after the debounce delay when value stabilizes', async () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        const { rerender } = renderHook(
            ({ value }: { value: number }) => useDebouncedValue(value, 200, callback),
            { initialProps: { value: 0 } }
        );

        // Initial render with value 0 — no callback yet (0 is falsy/default)
        expect(callback).not.toHaveBeenCalled();

        // Update to a non-zero value
        rerender({ value: 1000 });

        // Before the delay, callback should not have fired
        expect(callback).not.toHaveBeenCalled();

        // Advance past the debounce delay
        await act(async () => {
            vi.advanceTimersByTime(200);
        });

        expect(callback).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
    });

    it('does not call the callback if value changes before delay elapses', async () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        const { rerender } = renderHook(
            ({ value }: { value: number }) => useDebouncedValue(value, 200, callback),
            { initialProps: { value: 0 } }
        );

        // Rapid changes
        rerender({ value: 1000 });
        await act(async () => {
            vi.advanceTimersByTime(100);
        });
        rerender({ value: 1100 });
        await act(async () => {
            vi.advanceTimersByTime(100);
        });
        rerender({ value: 1200 });

        // Still within the debounce window — no callback yet
        expect(callback).not.toHaveBeenCalled();

        // Advance past the delay from the last change
        await act(async () => {
            vi.advanceTimersByTime(200);
        });

        expect(callback).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
    });

    it('does not call the callback when value is 0', async () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        renderHook(
            () => useDebouncedValue(0, 200, callback)
        );

        await act(async () => {
            vi.advanceTimersByTime(500);
        });

        expect(callback).not.toHaveBeenCalled();

        vi.useRealTimers();
    });

    it('calls the callback with the latest value', async () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        const { rerender } = renderHook(
            ({ value }: { value: number }) => useDebouncedValue(value, 200, callback),
            { initialProps: { value: 1000 } }
        );

        await act(async () => {
            vi.advanceTimersByTime(200);
        });

        expect(callback).toHaveBeenCalledWith(1000);

        vi.useRealTimers();
    });
});
