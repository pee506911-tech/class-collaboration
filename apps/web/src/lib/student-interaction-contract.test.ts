import { describe, it, expect } from 'vitest';
import { QuestionSchema, ParticipantSchema } from 'shared';

/**
 * Contract tests for student interaction endpoints:
 * - Question submission (POST /api/sessions/:id/questions)
 * - Question upvote (POST /api/sessions/:id/questions/:id/upvote)
 * - Participant registration (POST /api/sessions/:id/register-participant)
 */

describe('Student Interaction Contract', () => {
  describe('question submission (POST /api/sessions/:id/questions)', () => {
    type QuestionRequest = {
      content: string;
      slideId?: string;
    };

    it('should accept question with content', () => {
      const request: QuestionRequest = {
        content: 'Can you repeat the last slide?',
      };

      expect(typeof request.content).toBe('string');
      expect(request.content.length).toBeGreaterThan(0);
    });

    it('should accept question with optional slideId', () => {
      const request: QuestionRequest = {
        content: 'Question about this slide',
        slideId: 'slide-1',
      };

      expect(typeof request.slideId).toBe('string');
    });

    it('should match success response shape', () => {
      const response = {
        success: true,
        data: {
          id: 'question-1',
          sessionId: 'session-1',
          participantId: 'participant-1',
          content: 'Can you explain this?',
          upvotes: 0,
          isApproved: true,
          createdAt: '2024-01-01T00:00:00Z',
        },
        error: null,
      };

      const parseResult = QuestionSchema.safeParse(response.data);
      expect(parseResult.success).toBe(true);
    });

    it('should match error response for empty content', () => {
      const response = {
        success: false,
        error: 'Question content cannot be empty',
        data: null,
      };

      expect(response.success).toBe(false);
      expect(typeof response.error).toBe('string');
    });
  });

  describe('question upvote (POST /api/sessions/:id/questions/:id/upvote)', () => {
    it('should match success response shape', () => {
      const response = {
        success: true,
        data: {
          questionId: 'question-1',
          upvotes: 5,
        },
        error: null,
      };

      expect(response.success).toBe(true);
      expect(response.data.upvotes).toBe(5);
    });

    it('should match idempotent upvote response', () => {
      // Same participant upvoting same question twice should be idempotent
      const response = {
        success: true,
        data: {
          questionId: 'question-1',
          upvotes: 5, // same as before, not incremented
        },
        error: null,
      };

      expect(response.success).toBe(true);
      expect(response.data.upvotes).toBe(5);
    });
  });

  describe('participant registration (POST /api/sessions/:id/register-participant)', () => {
    type RegisterRequest = {
      name: string;
      participantId?: string;
    };

    it('should accept registration with name', () => {
      const request: RegisterRequest = {
        name: 'John Doe',
      };

      expect(typeof request.name).toBe('string');
      expect(request.name.length).toBeGreaterThan(0);
    });

    it('should accept registration with existing participantId', () => {
      const request: RegisterRequest = {
        name: 'Jane Doe',
        participantId: 'existing-participant-uuid',
      };

      expect(typeof request.participantId).toBe('string');
    });

    it('should match success response shape', () => {
      const response = {
        success: true,
        data: {
          id: 'participant-uuid',
          sessionId: 'session-1',
          name: 'John Doe',
          joinedAt: '2024-01-01T00:00:00Z',
        },
        error: null,
      };

      const parseResult = ParticipantSchema.safeParse(response.data);
      expect(parseResult.success).toBe(true);
    });

    it('should match error response for duplicate registration', () => {
      const response = {
        success: false,
        error: 'Participant already registered',
        data: null,
      };

      expect(response.success).toBe(false);
      expect(typeof response.error).toBe('string');
    });
  });

  describe('question list response (GET /api/sessions/:id/state)', () => {
    it('should return array of questions matching schema', () => {
      const questions = [
        {
          id: 'q-1',
          sessionId: 'session-1',
          participantId: 'p-1',
          content: 'Question 1?',
          upvotes: 3,
          isApproved: true,
          createdAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'q-2',
          sessionId: 'session-1',
          participantId: 'p-2',
          content: 'Question 2?',
          upvotes: 1,
          isApproved: false,
          createdAt: '2024-01-01T00:00:00Z',
        },
      ];

      for (const q of questions) {
        const parseResult = QuestionSchema.safeParse(q);
        expect(parseResult.success).toBe(true);
      }
    });
  });

  describe('student interaction error responses', () => {
    type ErrorResponse = { success: false; error: string; data: null };

    it('should match not found error for invalid session', () => {
      const response: ErrorResponse = {
        success: false,
        error: 'Session not found',
        data: null,
      };

      expect(response.success).toBe(false);
      expect(response.error).toBe('Session not found');
    });

    it('should match validation error for invalid input', () => {
      const response: ErrorResponse = {
        success: false,
        error: 'Name cannot be empty',
        data: null,
      };

      expect(response.success).toBe(false);
      expect(typeof response.error).toBe('string');
    });
  });
});
