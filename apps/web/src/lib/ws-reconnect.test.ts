import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createReconnect, calculateBackoff } from './ws-reconnect';

describe('calculateBackoff', () => {
    it('returns base delay for attempt 0', () => {
        const delay = calculateBackoff(0, 1000, 30000, 0);
        expect(delay).toBe(1000);
    });

    it('doubles delay each attempt', () => {
        expect(calculateBackoff(0, 1000, 30000, 0)).toBe(1000);
        expect(calculateBackoff(1, 1000, 30000, 0)).toBe(2000);
        expect(calculateBackoff(2, 1000, 30000, 0)).toBe(4000);
        expect(calculateBackoff(3, 1000, 30000, 0)).toBe(8000);
    });

    it('caps delay at maxDelay', () => {
        const delay = calculateBackoff(10, 1000, 30000, 0);
        expect(delay).toBe(30000);
    });

    it('applies jitter when enabled', () => {
        // Run multiple times to ensure jitter introduces variation
        const delays = new Set<number>();
        for (let i = 0; i < 20; i++) {
            delays.add(calculateBackoff(0, 1000, 30000, 0.5));
        }
        // With jitter, we should see different values
        expect(delays.size).toBeGreaterThan(1);
    });

    it('stays within expected range with jitter', () => {
        for (let i = 0; i < 50; i++) {
            const delay = calculateBackoff(2, 1000, 30000, 0.5);
            expect(delay).toBeGreaterThanOrEqual(2000); // 4000 * 0.5
            expect(delay).toBeLessThanOrEqual(6000);   // 4000 * 1.5
        }
    });

    it('never returns negative delay', () => {
        for (let i = 0; i < 100; i++) {
            const delay = calculateBackoff(i, 100, 30000, 0.5);
            expect(delay).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('createReconnect', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('schedules reconnect with base delay', () => {
        const onReconnect = vi.fn();
        const reconnect = createReconnect({ baseDelay: 1000, maxDelay: 30000, jitter: 0, onReconnect });

        reconnect.schedule();
        expect(onReconnect).toHaveBeenCalledTimes(1);
        expect(onReconnect).toHaveBeenCalledWith(0);

        // Advance by base delay
        vi.advanceTimersByTime(1000);
        expect(reconnect.getAttempts()).toBe(1);
    });

    it('increases delay with each attempt', () => {
        const reconnect = createReconnect({ baseDelay: 1000, maxDelay: 10000, jitter: 0 });

        reconnect.schedule();
        vi.advanceTimersByTime(1000);
        expect(reconnect.getAttempts()).toBe(1);

        reconnect.schedule();
        vi.advanceTimersByTime(2000);
        expect(reconnect.getAttempts()).toBe(2);

        reconnect.schedule();
        vi.advanceTimersByTime(4000);
        expect(reconnect.getAttempts()).toBe(3);
    });

    it('calls onMaxAttempts when limit reached', () => {
        const onMaxAttempts = vi.fn();
        const reconnect = createReconnect({ maxAttempts: 3, maxDelay: 10000, jitter: 0, onMaxAttempts });

        // Exhaust all attempts (need to go past maxAttempts)
        for (let i = 0; i <= 3; i++) {
            reconnect.schedule();
            vi.advanceTimersByTime(10000);
        }

        expect(onMaxAttempts).toHaveBeenCalledTimes(1);
    });

    it('reset clears attempt counter', () => {
        const reconnect = createReconnect({ maxAttempts: 3, maxDelay: 10000, jitter: 0 });

        reconnect.schedule();
        vi.advanceTimersByTime(1000);
        expect(reconnect.getAttempts()).toBe(1);

        reconnect.reset();
        expect(reconnect.getAttempts()).toBe(0);

        // Should be able to schedule again
        reconnect.schedule();
        vi.advanceTimersByTime(1000);
        expect(reconnect.getAttempts()).toBe(1);
    });

    it('cancel stops pending reconnect', () => {
        const reconnect = createReconnect({ baseDelay: 1000, maxDelay: 10000, jitter: 0 });

        reconnect.schedule();
        reconnect.cancel();

        vi.advanceTimersByTime(1000);
        expect(reconnect.getAttempts()).toBe(0);
    });

    it('handles schedule when already pending (cancels previous)', () => {
        const reconnect = createReconnect({ baseDelay: 5000, maxDelay: 10000, jitter: 0 });

        reconnect.schedule();
        reconnect.schedule(); // Should cancel the first one

        // If first one wasn't cancelled, this would still be 0
        vi.advanceTimersByTime(5000);
        expect(reconnect.getAttempts()).toBe(1);
    });

    it('works with default options', () => {
        const reconnect = createReconnect();
        expect(reconnect.getAttempts()).toBe(0);
    });
});
