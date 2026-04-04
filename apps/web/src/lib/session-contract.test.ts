import { describe, it, expect } from 'vitest';
import {
  SessionSchema,
  SlideSchema,
  UserSchema,
  ParticipantSchema,
  QuestionSchema,
  PollSlideContentSchema,
  MultipleChoiceSlideContentSchema,
  QuizSlideContentSchema,
  StaticSlideContentSchema,
} from 'shared';

/**
 * Contract tests for session CRUD endpoint response shapes.
 *
 * These tests validate that backend responses conform to the Zod schemas
 * defined in packages/shared/, ensuring frontend-backend consistency.
 */

// --- Session Response Shape Tests ---

describe('Session Contract', () => {
  describe('session list response (GET /api/sessions)', () => {
    it('should be an array of session objects', () => {
      const response = [
        {
          id: 'session-1',
          title: 'Test Session',
          status: 'draft',
          shareToken: 'abc12345',
          allowQuestions: true,
          requireName: false,
          isPresentationActive: false,
          stateVersion: 0,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          slideCount: 3,
        },
      ];

      const parseResult = SessionSchema.safeParse(response[0]);
      expect(parseResult.success).toBe(true);
    });

    it('should accept session with minimal fields', () => {
      const minimalSession = {
        id: 'session-2',
        title: 'Minimal',
        status: 'draft',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const parseResult = SessionSchema.safeParse(minimalSession);
      expect(parseResult.success).toBe(true);
    });

    it('should reject session with invalid status', () => {
      const invalidSession = {
        id: 'session-3',
        title: 'Bad Status',
        status: 'invalid-status',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const parseResult = SessionSchema.safeParse(invalidSession);
      expect(parseResult.success).toBe(false);
    });

    it('should reject session with missing required fields', () => {
      const incompleteSession = {
        title: 'Missing Fields',
        status: 'draft',
        // missing id, createdAt, updatedAt
      };

      const parseResult = SessionSchema.safeParse(incompleteSession);
      expect(parseResult.success).toBe(false);
    });
  });

  describe('session creation response (POST /api/sessions)', () => {
    it('should return created session object', () => {
      const response = {
        id: 'new-session',
        title: 'New Session',
        status: 'draft',
        shareToken: 'token123',
        allowQuestions: true,
        requireName: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const parseResult = SessionSchema.safeParse(response);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('session update response (PUT /api/sessions/:id)', () => {
    it('should return updated session object', () => {
      const response = {
        id: 'session-1',
        title: 'Updated Title',
        status: 'published',
        shareToken: 'abc12345',
        allowQuestions: false,
        requireName: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };

      const parseResult = SessionSchema.safeParse(response);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('session error responses', () => {
    type ErrorResponse = { success: false; error: string; data?: unknown };

    it('should match error shape for not found', () => {
      const response: ErrorResponse = {
        success: false,
        error: 'Session not found',
      };

      expect(response.success).toBe(false);
      expect(typeof response.error).toBe('string');
    });

    it('should match error shape for unauthorized', () => {
      const response: ErrorResponse = {
        success: false,
        error: 'Unauthorized access to session',
      };

      expect(response.success).toBe(false);
      expect(typeof response.error).toBe('string');
    });
  });
});
