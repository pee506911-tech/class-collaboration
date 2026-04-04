/**
 * Reconnection helper with exponential backoff and jitter.
 *
 * Usage:
 *   const reconnect = createReconnect({
 *     baseDelay: 1000,
 *     maxDelay: 30000,
 *     maxAttempts: 10,
 *     onReconnect: (attempt) => { ... },
 *     onMaxAttempts: () => { ... },
 *   });
 *
 *   // When connection drops:
 *   reconnect.schedule();
 *
 *   // When connection succeeds:
 *   reconnect.reset();
 *
 *   // On cleanup:
 *   reconnect.cancel();
 */

export interface ReconnectOptions {
    /** Base delay in ms (default: 1000) */
    baseDelay?: number;
    /** Maximum delay in ms (default: 30000) */
    maxDelay?: number;
    /** Maximum number of reconnection attempts (default: 10) */
    maxAttempts?: number;
    /** Jitter factor (0-1), default 0.5 */
    jitter?: number;
    /** Called before each reconnect attempt */
    onReconnect?: (attempt: number) => void;
    /** Called when max attempts is reached */
    onMaxAttempts?: () => void;
}

export interface ReconnectController {
    /** Schedule a reconnect attempt */
    schedule: () => void;
    /** Reset attempt counter and cancel pending reconnect */
    reset: () => void;
    /** Cancel any pending reconnect without resetting counter */
    cancel: () => void;
    /** Get current attempt count (read-only) */
    getAttempts: () => number;
}

/**
 * Calculate delay with exponential backoff and jitter.
 *
 * delay = min(baseDelay * 2^attempt, maxDelay) ± jitter
 *
 * @param attempt - Current attempt number (0-based)
 * @param baseDelay - Base delay in ms
 * @param maxDelay - Maximum delay in ms
 * @returns Delay in ms
 */
export function calculateBackoff(
    attempt: number,
    baseDelay: number,
    maxDelay: number,
    jitter: number = 0.5
): number {
    const exponentialDelay = baseDelay * Math.pow(2, attempt);
    const cappedDelay = Math.min(exponentialDelay, maxDelay);

    // Apply jitter: random value in range [capped * (1-jitter), capped * (1+jitter)]
    const jitterRange = cappedDelay * jitter;
    const jitteredDelay = cappedDelay + (Math.random() - 0.5) * 2 * jitterRange;

    return Math.max(0, jitteredDelay);
}

/**
 * Create a reconnect controller with exponential backoff.
 */
export function createReconnect(options: ReconnectOptions = {}): ReconnectController {
    const {
        baseDelay = 1000,
        maxDelay = 30000,
        maxAttempts = 10,
        jitter = 0.5,
        onReconnect,
        onMaxAttempts,
    } = options;

    let attempt = 0;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    function clearPending() {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
    }

    function schedule() {
        clearPending();

        if (attempt >= maxAttempts) {
            onMaxAttempts?.();
            return;
        }

        const delay = calculateBackoff(attempt, baseDelay, maxDelay, jitter);

        onReconnect?.(attempt);

        timeoutId = setTimeout(() => {
            attempt++;
        }, delay);
    }

    function reset() {
        clearPending();
        attempt = 0;
    }

    function cancel() {
        clearPending();
    }

    function getAttempts() {
        return attempt;
    }

    return {
        schedule,
        reset,
        cancel,
        getAttempts,
    };
}
