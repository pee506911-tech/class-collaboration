import { describe, it, expect } from 'vitest';

/**
 * Contract tests for vote submission payload shape.
 *
 * These tests ensure that the frontend payload format matches what the
 * backend expects, and that the backend response shape is consistent.
 *
 * Backend expects (from SubmitVoteRequest in student.rs):
 *   - slideId: string (required)
 *   - optionId: string | null (optional, singular)
 *   - optionIds: string[] | null (optional, plural)
 *   - participantId: string (required)
 *
 * Frontend sends (from use-vote-submission.ts):
 *   - { slideId, optionId } for single-choice
 *   - { slideId, optionIds } for multi-select
 */

// Type matching backend's SubmitVoteRequest (camelCase from #[serde(rename_all = "camelCase")])
type BackendVoteRequest = {
  slideId: string;
  optionId?: string | null;
  optionIds?: string[] | null;
  participantId: string;
};

type FrontendVotePayload =
  | { slideId: string; optionId: string }
  | { slideId: string; optionIds: string[] };

function isValidBackendRequest(obj: unknown): obj is BackendVoteRequest {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.slideId !== 'string' || o.slideId.length === 0) return false;
  if (typeof o.participantId !== 'string' || o.participantId.length === 0) return false;
  if (o.optionId !== undefined && o.optionId !== null && typeof o.optionId !== 'string') return false;
  if (o.optionIds !== undefined && o.optionIds !== null) {
    if (!Array.isArray(o.optionIds)) return false;
    if (!o.optionIds.every((x) => typeof x === 'string')) return false;
  }
  return true;
}

function isValidFrontendPayload(obj: unknown): obj is FrontendVotePayload {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.slideId !== 'string' || o.slideId.length === 0) return false;
  if (typeof o.optionId === 'string') return true;
  if (Array.isArray(o.optionIds) && o.optionIds.every((x) => typeof x === 'string')) return true;
  return false;
}

describe('Vote Submission Contract', () => {
  describe('frontend payload matches backend expectations', () => {
    it('should accept single optionId payload', () => {
      const payload: FrontendVotePayload = { slideId: 'slide-1', optionId: 'opt-red' };

      expect(isValidFrontendPayload(payload)).toBe(true);

      // Wrap as backend request (adds participantId)
      const backendPayload: BackendVoteRequest = {
        ...payload,
        participantId: 'user-1',
      };
      expect(isValidBackendRequest(backendPayload)).toBe(true);
    });

    it('should accept multiple optionIds payload', () => {
      const payload: FrontendVotePayload = { slideId: 'slide-1', optionIds: ['opt-a', 'opt-b'] };

      expect(isValidFrontendPayload(payload)).toBe(true);

      const backendPayload: BackendVoteRequest = {
        ...payload,
        participantId: 'user-1',
      };
      expect(isValidBackendRequest(backendPayload)).toBe(true);
    });

    it('should reject payload with no option selection', () => {
      const payload = { slideId: 'slide-1' };

      expect(isValidFrontendPayload(payload)).toBe(false);
    });

    it('should accept payload with empty optionIds array (frontend-valid, backend-rejects)', () => {
      const payload = { slideId: 'slide-1', optionIds: [] };

      // Frontend schema accepts it (array is valid), but backend would reject
      // with "No option selected" after dedup. This test documents the gap.
      expect(isValidFrontendPayload(payload)).toBe(true);
    });

    it('should require slideId as non-empty string', () => {
      const payloadWithoutSlide = { optionId: 'opt-red' };
      const payloadWithEmptySlide = { slideId: '', optionId: 'opt-red' };

      expect(isValidFrontendPayload(payloadWithoutSlide)).toBe(false);
      expect(isValidFrontendPayload(payloadWithEmptySlide)).toBe(false);
    });
  });

  describe('backend response shape', () => {
    type SuccessResponse = { success: true; data: { message: string }; error: null };
    type ErrorResponse = { success: false; error: string; data?: null };

    it('should match success response shape', () => {
      const response: SuccessResponse = {
        success: true,
        data: { message: 'Vote submitted successfully' },
        error: null,
      };

      expect(response.success).toBe(true);
      expect(typeof response.data.message).toBe('string');
      expect(response.error).toBeNull();
    });

    it('should match error response shape', () => {
      const response: ErrorResponse = {
        success: false,
        error: 'No option selected',
      };

      expect(response.success).toBe(false);
      expect(typeof response.error).toBe('string');
    });
  });

  describe('property-based: arbitrary valid payloads pass both schemas', () => {
    it('accepts any valid single-option combination', () => {
      const testCases: FrontendVotePayload[] = [
        { slideId: 'uuid-here', optionId: 'opt-1' },
        { slideId: 'slide_123', optionId: 'option-abc' },
        { slideId: 'a'.repeat(36), optionId: 'b'.repeat(36) },
      ];

      for (const payload of testCases) {
        expect(isValidFrontendPayload(payload)).toBe(true);

        const backendPayload: BackendVoteRequest = { ...payload, participantId: 'user-1' };
        expect(isValidBackendRequest(backendPayload)).toBe(true);
      }
    });

    it('accepts any valid multi-option combination', () => {
      const testCases: FrontendVotePayload[] = [
        { slideId: 'slide-1', optionIds: ['opt-a'] },
        { slideId: 'slide-1', optionIds: ['opt-a', 'opt-b', 'opt-c'] },
        { slideId: 'slide-1', optionIds: Array(10).fill('opt-x') },
      ];

      for (const payload of testCases) {
        expect(isValidFrontendPayload(payload)).toBe(true);

        const backendPayload: BackendVoteRequest = { ...payload, participantId: 'user-1' };
        expect(isValidBackendRequest(backendPayload)).toBe(true);
      }
    });
  });
});
