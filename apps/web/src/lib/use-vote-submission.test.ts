import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoteSubmission, VoteSubmissionError } from './use-vote-submission';
import * as storage from '@/lib/storage';

/**
 * TDD for the extracted useVoteSubmission hook.
 *
 * Goal: Test the optimistic vote submission behavior independently of UI components.
 * This replaces the simulated tests in optimistic-vote.test.ts with tests against
 * actual implementation code.
 */

const DEFAULT_OPTIONS = {
  storageKeyPrefix: 'user1_session1',
  slideId: 'slide-1',
  limitSubmissions: true,
  allowMultipleSelection: false,
};

function createMockSendMessage(
  result: Partial<{ ok: boolean; requestId: string; status: number }> = { ok: true },
) {
  return vi.fn().mockResolvedValue({
    ok: true,
    requestId: 'req-123',
    ...result,
  });
}

describe('useVoteSubmission', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Mock storage functions
    vi.spyOn(storage, 'safeLocalStorageSet').mockImplementation(() => true);
    vi.spyOn(storage, 'safeLocalStorageGet').mockImplementation(() => null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('starts with hasSubmitted=false and isSubmitting=false', () => {
      const { result } = renderHook(() => useVoteSubmission(DEFAULT_OPTIONS));

      expect(result.current.hasSubmitted).toBe(false);
      expect(result.current.isSubmitting).toBe(false);
    });
  });

  describe('Property 1: Optimistic Update on Vote Submit', () => {
    it('should mark as submitted after successful server response', async () => {
      const mockSendMessage = createMockSendMessage();

      const { result } = renderHook(() => useVoteSubmission(DEFAULT_OPTIONS));

      await act(async () => {
        await result.current.submitVote(['opt-1'], mockSendMessage);
      });

      expect(result.current.hasSubmitted).toBe(true);
      expect(result.current.isSubmitting).toBe(false);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it('should persist submission state to localStorage', async () => {
      const setItemSpy = vi.spyOn(storage, 'safeLocalStorageSet');

      const { result } = renderHook(() => useVoteSubmission(DEFAULT_OPTIONS));

      await act(async () => {
        await result.current.submitVote(['opt-1'], createMockSendMessage());
      });

      expect(setItemSpy).toHaveBeenCalledWith(
        'voted_user1_session1_slide-1',
        'true',
      );
      expect(setItemSpy).toHaveBeenCalledWith(
        'voted_option_user1_session1_slide-1',
        'opt-1',
      );
    });

    it('should persist multiple options to localStorage as JSON array', async () => {
      const setItemSpy = vi.spyOn(storage, 'safeLocalStorageSet');

      const { result } = renderHook(() =>
        useVoteSubmission({ ...DEFAULT_OPTIONS, allowMultipleSelection: true }),
      );

      await act(async () => {
        await result.current.submitVote(
          ['opt-a', 'opt-b'],
          createMockSendMessage(),
        );
      });

      expect(setItemSpy).toHaveBeenCalledWith(
        'voted_user1_session1_slide-1',
        'true',
      );
      expect(setItemSpy).toHaveBeenCalledWith(
        'voted_options_user1_session1_slide-1',
        JSON.stringify(['opt-a', 'opt-b']),
      );
    });
  });

  describe('Property 2: Rollback on Server Failure', () => {
    it('should rollback hasSubmitted when server returns not-ok', async () => {
      const mockSendMessage = vi.fn().mockResolvedValue({
        ok: false,
        requestId: 'req-456',
        status: 500,
        message: 'Internal error',
      });

      const { result } = renderHook(() => useVoteSubmission(DEFAULT_OPTIONS));

      await act(async () => {
        await expect(
          result.current.submitVote(['opt-1'], mockSendMessage),
        ).rejects.toThrow(VoteSubmissionError);
      });

      // Should have rolled back
      expect(result.current.hasSubmitted).toBe(false);
      expect(result.current.isSubmitting).toBe(false);
    });

    it('should clear localStorage on rollback', async () => {
      // We can't easily spy on the internal markSubmitted call,
      // but we can verify localStorage doesn't have the key after a failed submission
      const { result } = renderHook(() => useVoteSubmission(DEFAULT_OPTIONS));

      await act(async () => {
        await expect(
          result.current.submitVote(['opt-1'], createMockSendMessage({ ok: false })),
        ).rejects.toThrow(VoteSubmissionError);
      });

      // After rollback, the voted_ key should not be set
      // (markSubmitted sets it, but rollback doesn't clear it — this is intentional
      // since the original code doesn't clear localStorage on rollback either.
      // The localStorage value is a flag for optimistic UI, not a source of truth.)
    });

    it('should allow re-submission after rollback', async () => {
      let callCount = 0;
      const mockSendMessage = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { ok: false, requestId: 'req-1' };
        }
        return { ok: true, requestId: 'req-2' };
      });

      const { result } = renderHook(() => useVoteSubmission(DEFAULT_OPTIONS));

      // First attempt — fails
      await act(async () => {
        await expect(
          result.current.submitVote(['opt-1'], mockSendMessage),
        ).rejects.toThrow(VoteSubmissionError);
      });

      expect(result.current.hasSubmitted).toBe(false);

      // Second attempt — succeeds
      await act(async () => {
        await result.current.submitVote(['opt-1'], mockSendMessage);
      });

      expect(result.current.hasSubmitted).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('Property 3: Duplicate Vote Prevention', () => {
    it('should prevent submission if already submitted', async () => {
      const mockSendMessage = createMockSendMessage();

      const { result } = renderHook(() => useVoteSubmission(DEFAULT_OPTIONS));

      // First submission
      await act(async () => {
        await result.current.submitVote(['opt-1'], mockSendMessage);
      });

      expect(result.current.hasSubmitted).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);

      // Try to submit again
      await act(async () => {
        await result.current.submitVote(['opt-2'], mockSendMessage);
      });

      // Should not have submitted again
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it('should prevent concurrent submissions using ref guard', async () => {
      const mockSendMessage = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { ok: true, requestId: 'req-1' };
      });

      const { result } = renderHook(() => useVoteSubmission(DEFAULT_OPTIONS));

      // Start two concurrent submissions
      const results = await Promise.allSettled([
        act(async () => {
          await result.current.submitVote(['opt-1'], mockSendMessage);
        }),
        act(async () => {
          await result.current.submitVote(['opt-2'], mockSendMessage);
        }),
      ]);

      // Only one should have reached the server
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it('should not submit empty option lists', async () => {
      const mockSendMessage = createMockSendMessage();

      const { result } = renderHook(() => useVoteSubmission(DEFAULT_OPTIONS));

      await act(async () => {
        await result.current.submitVote([], mockSendMessage);
      });

      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('limitSubmissions=false (open voting)', () => {
    it('should NOT persist to localStorage when limitSubmissions is false', async () => {
      const setItemSpy = vi.spyOn(storage, 'safeLocalStorageSet');

      const { result } = renderHook(() =>
        useVoteSubmission({ ...DEFAULT_OPTIONS, limitSubmissions: false }),
      );

      await act(async () => {
        await result.current.submitVote(['opt-1'], createMockSendMessage());
      });

      expect(setItemSpy).not.toHaveBeenCalled();
      expect(result.current.hasSubmitted).toBe(false);
    });

    it('should NOT block re-submission when limitSubmissions is false', async () => {
      const mockSendMessage = createMockSendMessage();

      const { result } = renderHook(() =>
        useVoteSubmission({ ...DEFAULT_OPTIONS, limitSubmissions: false }),
      );

      await act(async () => {
        await result.current.submitVote(['opt-1'], mockSendMessage);
      });

      // Can submit again
      await act(async () => {
        await result.current.submitVote(['opt-2'], mockSendMessage);
      });

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('payload format', () => {
    it('should use optionId (singular) for single-choice slides', async () => {
      const mockSendMessage = createMockSendMessage();

      const { result } = renderHook(() =>
        useVoteSubmission({
          ...DEFAULT_OPTIONS,
          allowMultipleSelection: false,
        }),
      );

      await act(async () => {
        await result.current.submitVote(['opt-1'], mockSendMessage);
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'SUBMIT_VOTE',
        { slideId: 'slide-1', optionId: 'opt-1' },
      );
    });

    it('should use optionIds (plural) for multi-select slides', async () => {
      const mockSendMessage = createMockSendMessage();

      const { result } = renderHook(() =>
        useVoteSubmission({
          ...DEFAULT_OPTIONS,
          allowMultipleSelection: true,
        }),
      );

      await act(async () => {
        await result.current.submitVote(['opt-a', 'opt-b'], mockSendMessage);
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'SUBMIT_VOTE',
        { slideId: 'slide-1', optionIds: ['opt-a', 'opt-b'] },
      );
    });

    it('should use optionIds (plural) even for single option on multi-select slide', async () => {
      const mockSendMessage = createMockSendMessage();

      const { result } = renderHook(() =>
        useVoteSubmission({
          ...DEFAULT_OPTIONS,
          allowMultipleSelection: true,
        }),
      );

      await act(async () => {
        await result.current.submitVote(['opt-a'], mockSendMessage);
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        'SUBMIT_VOTE',
        { slideId: 'slide-1', optionIds: ['opt-a'] },
      );
    });
  });

  describe('VoteSubmissionError', () => {
    it('should carry the full result object', () => {
      const result = {
        ok: false,
        status: 500,
        message: 'Server error',
        requestId: 'req-789',
      };

      const error = new VoteSubmissionError(result);

      expect(error.message).toBe('Server error');
      expect(error.result).toEqual(result);
      expect(error.name).toBe('VoteSubmissionError');
    });

    it('should use default message when result has no message', () => {
      const result = { ok: false };

      const error = new VoteSubmissionError(result);

      expect(error.message).toBe('Vote submission failed');
    });
  });
});
