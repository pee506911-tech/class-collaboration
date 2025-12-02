import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

/**
 * Connection closure logic extracted for testing.
 * This mirrors the cleanup logic in WebSocketProvider.
 */
interface MockConnection {
  state: 'initialized' | 'connecting' | 'connected' | 'disconnected' | 'closing' | 'closed' | 'failed' | 'suspended';
  close: () => void;
  off: () => void;
}

interface MockChannel {
  unsubscribe: () => void;
}

/**
 * Cleanup function that mirrors the WebSocketProvider cleanup logic.
 * This is the function under test.
 */
function cleanupConnection(
  connection: MockConnection,
  channel: MockChannel,
  setIsMounted: (value: boolean) => void
): { closeCalled: boolean; error: Error | null; logMessages: string[] } {
  const logMessages: string[] = [];
  let closeCalled = false;
  let error: Error | null = null;

  // Set isMounted to false to prevent state updates
  setIsMounted(false);

  // Remove all event listeners
  connection.off();

  // Unsubscribe from channel
  channel.unsubscribe();

  // Check connection state before closing
  try {
    if (connection.state !== 'closed' && connection.state !== 'closing') {
      logMessages.push('🔌 Closing Ably connection');
      connection.close();
      closeCalled = true;
    }
  } catch (e) {
    error = e as Error;
    logMessages.push(`Error closing Ably connection: ${(e as Error).message}`);
  }

  return { closeCalled, error, logMessages };
}

// Arbitrary for connection states
const connectionStateArb = fc.constantFrom(
  'initialized',
  'connecting',
  'connected',
  'disconnected',
  'closing',
  'closed',
  'failed',
  'suspended'
) as fc.Arbitrary<MockConnection['state']>;

describe('WebSocket Connection Closure - Property Tests', () => {
  /**
   * **Feature: websocket-stats-reliability, Property 1: Connection State Check Before Close**
   * **Validates: Requirements 1.1, 1.2**
   * 
   * Property: For any connection state that is 'closed' or 'closing', 
   * the close method SHALL NOT be called.
   * For any other state, the close method SHALL be called.
   */
  describe('Property 1: Connection State Check Before Close', () => {
    it('should skip close operation when connection state is closed or closing', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('closed', 'closing') as fc.Arbitrary<MockConnection['state']>,
          (state) => {
            const closeMock = vi.fn();
            const connection: MockConnection = {
              state,
              close: closeMock,
              off: vi.fn(),
            };
            const channel: MockChannel = { unsubscribe: vi.fn() };
            const setIsMounted = vi.fn();

            const result = cleanupConnection(connection, channel, setIsMounted);

            // close() should NOT be called for 'closed' or 'closing' states
            expect(closeMock).not.toHaveBeenCalled();
            expect(result.closeCalled).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should call close operation when connection state is not closed or closing', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('initialized', 'connecting', 'connected', 'disconnected', 'failed', 'suspended') as fc.Arbitrary<MockConnection['state']>,
          (state) => {
            const closeMock = vi.fn();
            const connection: MockConnection = {
              state,
              close: closeMock,
              off: vi.fn(),
            };
            const channel: MockChannel = { unsubscribe: vi.fn() };
            const setIsMounted = vi.fn();

            const result = cleanupConnection(connection, channel, setIsMounted);

            // close() SHOULD be called for active states
            expect(closeMock).toHaveBeenCalledTimes(1);
            expect(result.closeCalled).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * **Feature: websocket-stats-reliability, Property 2: Active Connection Close**
   * **Validates: Requirements 1.3**
   * 
   * Property: For any active connection (not closed/closing), when close is invoked,
   * a log message indicating the connection is being closed SHALL be recorded.
   */
  describe('Property 2: Active Connection Close', () => {
    it('should log a message when closing an active connection', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('initialized', 'connecting', 'connected', 'disconnected', 'failed', 'suspended') as fc.Arbitrary<MockConnection['state']>,
          (state) => {
            const connection: MockConnection = {
              state,
              close: vi.fn(),
              off: vi.fn(),
            };
            const channel: MockChannel = { unsubscribe: vi.fn() };
            const setIsMounted = vi.fn();

            const result = cleanupConnection(connection, channel, setIsMounted);

            // Should have logged the closing message
            expect(result.logMessages).toContain('🔌 Closing Ably connection');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * **Feature: websocket-stats-reliability, Property 3: Close Error Handling**
   * **Validates: Requirements 1.4**
   * 
   * Property: For any connection where close() throws an error,
   * the error SHALL be caught and logged without propagating.
   */
  describe('Property 3: Close Error Handling', () => {
    it('should catch and log errors during connection closure without propagating', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('initialized', 'connecting', 'connected', 'disconnected', 'failed', 'suspended') as fc.Arbitrary<MockConnection['state']>,
          fc.string({ minLength: 1 }),
          (state, errorMessage) => {
            const connection: MockConnection = {
              state,
              close: () => { throw new Error(errorMessage); },
              off: vi.fn(),
            };
            const channel: MockChannel = { unsubscribe: vi.fn() };
            const setIsMounted = vi.fn();

            // Should not throw
            let thrownError: Error | null = null;
            let result: ReturnType<typeof cleanupConnection> | null = null;
            try {
              result = cleanupConnection(connection, channel, setIsMounted);
            } catch (e) {
              thrownError = e as Error;
            }

            // Error should be caught, not propagated
            expect(thrownError).toBeNull();
            // Error should be captured in result
            expect(result?.error).not.toBeNull();
            expect(result?.error?.message).toBe(errorMessage);
            // Error should be logged
            expect(result?.logMessages.some(msg => msg.includes('Error closing Ably connection'))).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
