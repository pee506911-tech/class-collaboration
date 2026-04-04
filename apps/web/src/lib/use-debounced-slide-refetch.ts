import { useEffect, useRef } from 'react';

/**
 * Triggers a callback after a value stabilizes for the specified delay.
 * Used to debounce student slide refetches when lastSlideUpdate fires
 * rapidly, preventing a thundering herd of HTTP requests.
 *
 * @param value - A numeric timestamp (0 means "no update yet")
 * @param delayMs - Debounce window in milliseconds
 * @param callback - Function to call after the value stabilizes
 */
export function useDebouncedValue(
    value: number,
    delayMs: number,
    callback: (value: number) => void
): void {
    const callbackRef = useRef(callback);
    callbackRef.current = callback;

    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        // Skip if value is 0 (initial/default state)
        if (value === 0) return;

        // Clear any existing timer
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
        }

        // Start a new timer
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            callbackRef.current(value);
        }, delayMs);

        // Cleanup on unmount or when dependencies change
        return () => {
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [value, delayMs]);
}
