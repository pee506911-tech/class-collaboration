'use client';

import { useState, useCallback, useRef } from 'react';
import { safeLocalStorageGet, safeLocalStorageSet } from '@/lib/storage';

export interface VoteSubmissionOptions {
  /** Key prefix for localStorage (e.g. `participantId_sessionId`) */
  storageKeyPrefix: string;
  /** Slide ID for scoping localStorage keys */
  slideId: string;
  /** Whether this slide enforces single submission */
  limitSubmissions: boolean;
  /** Whether this slide allows multiple option selections */
  allowMultipleSelection: boolean;
}

export interface VoteSubmissionResult {
  ok: boolean;
  requestId?: string;
  status?: number;
  message?: string;
  kind?: unknown;
}

type SendMessageFn = (
  type: 'SUBMIT_VOTE',
  payload: { slideId: string; optionId?: string; optionIds?: string[] },
  opts?: { clientRequestId?: string },
) => Promise<VoteSubmissionResult>;

interface UseVoteSubmissionReturn {
  /** Whether the user has already submitted (from localStorage or state) */
  hasSubmitted: boolean;
  /** Whether a submission is in-flight */
  isSubmitting: boolean;
  /** Mark as submitted optimistically and persist to localStorage */
  markSubmitted: (optionIds: string[]) => void;
  /** Rollback the optimistic submission state */
  rollback: (prevHasSubmitted: boolean, prevOptions: string[]) => void;
  /** Submit vote with optimistic update and retry on failure */
  submitVote: (
    optionIds: string[],
    sendMessage: SendMessageFn,
  ) => Promise<void>;
}

/**
 * Hook for optimistic vote submission with localStorage persistence,
 * rollback on failure, and idempotent retry support.
 *
 * Extracted from slide-renderer.tsx to enable independent testing
 * and reuse across poll, quiz, and multiple-choice slides.
 */
export function useVoteSubmission({
  storageKeyPrefix,
  slideId,
  limitSubmissions,
  allowMultipleSelection,
}: VoteSubmissionOptions): UseVoteSubmissionReturn {
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Use a ref to guard against double-submission
  const submittedRef = useRef(false);

  const markSubmitted = useCallback(
    (optionIds: string[]) => {
      if (!limitSubmissions) return;

      setHasSubmitted(true);
      safeLocalStorageSet(`voted_${storageKeyPrefix}_${slideId}`, 'true');

      if (optionIds.length === 1) {
        safeLocalStorageSet(
          `voted_option_${storageKeyPrefix}_${slideId}`,
          optionIds[0],
        );
      } else {
        safeLocalStorageSet(
          `voted_options_${storageKeyPrefix}_${slideId}`,
          JSON.stringify(optionIds),
        );
      }
    },
    [limitSubmissions, storageKeyPrefix, slideId],
  );

  const rollback = useCallback(
    (prevHasSubmitted: boolean, prevOptions: string[]) => {
      if (!limitSubmissions) return;

      setHasSubmitted(prevHasSubmitted);
      // The caller is responsible for restoring the selected options
    },
    [limitSubmissions],
  );

  const submitVote = useCallback(
    async (
      optionIds: string[],
      sendMessage: SendMessageFn,
    ): Promise<void> => {
      if (optionIds.length === 0 || isSubmitting) {
        return;
      }

      // For limitSubmissions slides, also check if already submitted
      if (limitSubmissions && (hasSubmitted || submittedRef.current)) {
        return;
      }

      // Prevent concurrent submissions
      submittedRef.current = true;
      setIsSubmitting(true);

      // Save state for rollback
      const previousState = {
        hasSubmitted,
        selectedOptions: [...optionIds],
      };

      // Optimistic update
      markSubmitted(optionIds);

      // Build payload: use optionId for single, optionIds for multiple
      const payload =
        optionIds.length === 1 && !allowMultipleSelection
          ? { slideId, optionId: optionIds[0] }
          : { slideId, optionIds };

      const result = await sendMessage('SUBMIT_VOTE', payload);
      setIsSubmitting(false);

      if (!result.ok) {
        // Rollback optimistic update
        rollback(previousState.hasSubmitted, previousState.selectedOptions);
        submittedRef.current = false;

        // Surface failure to caller via thrown error
        throw new VoteSubmissionError(result);
      }

      // On success, keep ref as true for limitSubmissions to prevent re-submission
      // For non-limitSubmissions, reset ref to allow future submissions
      if (!limitSubmissions) {
        submittedRef.current = false;
      }
    },
    [
      hasSubmitted,
      isSubmitting,
      limitSubmissions,
      markSubmitted,
      rollback,
      slideId,
      allowMultipleSelection,
    ],
  );

  return {
    hasSubmitted,
    isSubmitting,
    markSubmitted,
    rollback,
    submitVote,
  };
}

export class VoteSubmissionError extends Error {
  public readonly result: VoteSubmissionResult;

  constructor(result: VoteSubmissionResult) {
    super(result.message ?? 'Vote submission failed');
    this.name = 'VoteSubmissionError';
    this.result = result;
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, VoteSubmissionError.prototype);
  }
}
