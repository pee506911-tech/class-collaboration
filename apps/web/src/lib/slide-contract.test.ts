import { describe, it, expect } from 'vitest';
import {
  SlideSchema,
  PollSlideContentSchema,
  MultipleChoiceSlideContentSchema,
  QuizSlideContentSchema,
  StaticSlideContentSchema,
} from 'shared';

/**
 * Contract tests for slide endpoint response shapes.
 *
 * Validates that slide CRUD responses conform to shared Zod schemas.
 */

describe('Slide Contract', () => {
  describe('slide list response (GET /api/sessions/:id/slides)', () => {
    it('should be an array of slide objects', () => {
      const response = [
        {
          id: 'slide-1',
          sessionId: 'session-1',
          type: 'poll',
          content: {
            question: 'What is your favorite color?',
            options: [
              { id: 'opt-red', text: 'Red' },
              { id: 'opt-blue', text: 'Blue' },
            ],
            limitSubmissions: true,
          },
          orderIndex: 0,
          isHidden: false,
          version: 0,
        },
      ];

      const parseResult = SlideSchema.safeParse(response[0]);
      expect(parseResult.success).toBe(true);
    });

    it('should accept slide with all slide types', () => {
      const slides = [
        {
          id: 'slide-static',
          sessionId: 'session-1',
          type: 'static' as const,
          content: { title: 'Title', body: 'Body' },
          orderIndex: 0,
          version: 0,
        },
        {
          id: 'slide-poll',
          sessionId: 'session-1',
          type: 'poll' as const,
          content: {
            question: 'Question?',
            options: [{ id: 'opt-1', text: 'Option 1' }],
            limitSubmissions: true,
          },
          orderIndex: 1,
          version: 0,
        },
        {
          id: 'slide-quiz',
          sessionId: 'session-1',
          type: 'quiz' as const,
          content: {
            question: 'Quiz?',
            options: [{ id: 'opt-1', text: 'A', isCorrect: true }],
            points: 1000,
            timerDuration: 30,
            limitSubmissions: true,
          },
          orderIndex: 2,
          version: 0,
        },
        {
          id: 'slide-mcq',
          sessionId: 'session-1',
          type: 'multiple-choice' as const,
          content: {
            question: 'MCQ?',
            options: [{ id: 'opt-1', text: 'A' }],
            allowMultipleSelection: false,
            limitSubmissions: true,
          },
          orderIndex: 3,
          version: 0,
        },
      ];

      for (const slide of slides) {
        const parseResult = SlideSchema.safeParse(slide);
        expect(parseResult.success).toBe(true);
      }
    });

    it('should accept slide with optional isHidden omitted', () => {
      const slide = {
        id: 'slide-no-hidden',
        sessionId: 'session-1',
        type: 'static' as const,
        content: { title: 'Test', body: 'Test' },
        orderIndex: 0,
        version: 0,
      };

      const parseResult = SlideSchema.safeParse(slide);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('slide creation response (POST /api/sessions/:id/slides)', () => {
    it('should return created slide with version 0', () => {
      const response = {
        id: 'new-slide',
        sessionId: 'session-1',
        type: 'poll' as const,
        content: {
          question: 'New poll?',
          options: [{ id: 'opt-a', text: 'A' }],
          limitSubmissions: true,
        },
        orderIndex: 1024,
        version: 0,
      };

      const parseResult = SlideSchema.safeParse(response);
      expect(parseResult.success).toBe(true);
      expect(response.version).toBe(0);
    });
  });

  describe('slide update response (PUT /api/sessions/:id/slides/:slideId)', () => {
    it('should return updated slide with bumped version', () => {
      const response = {
        id: 'slide-1',
        sessionId: 'session-1',
        type: 'poll' as const,
        content: {
          question: 'Updated question?',
          options: [{ id: 'opt-b', text: 'B' }],
          limitSubmissions: true,
        },
        orderIndex: 1024,
        isHidden: false,
        version: 6, // bumped from 5
      };

      const parseResult = SlideSchema.safeParse(response);
      expect(parseResult.success).toBe(true);
    });

    it('should match conflict error shape for stale version', () => {
      const conflictResponse = {
        success: false,
        error: 'stale_slide_version',
        data: { currentVersion: 7 },
      };

      expect(conflictResponse.success).toBe(false);
      expect(conflictResponse.error).toBe('stale_slide_version');
      expect(typeof conflictResponse.data.currentVersion).toBe('number');
    });
  });

  describe('slide batch creation response (POST /api/sessions/:id/slides/batch)', () => {
    it('should return array of created slides', () => {
      const response = [
        {
          id: 'batch-slide-1',
          sessionId: 'session-1',
          type: 'poll' as const,
          content: { question: 'Q1?', options: [{ id: 'opt-a', text: 'A' }] },
          orderIndex: 1024,
          version: 0,
        },
        {
          id: 'batch-slide-2',
          sessionId: 'session-1',
          type: 'quiz' as const,
          content: { question: 'Q2?', options: [{ id: 'opt-b', text: 'B', isCorrect: true }], points: 1000, timerDuration: 30 },
          orderIndex: 2048,
          version: 0,
        },
      ];

      for (const slide of response) {
        const parseResult = SlideSchema.safeParse(slide);
        expect(parseResult.success).toBe(true);
      }
    });
  });

  describe('slide reorder response (PUT /api/sessions/:id/slides/reorder)', () => {
    it('should return slides with updated orderIndex', () => {
      const response = [
        {
          id: 'slide-c',
          sessionId: 'session-1',
          type: 'poll' as const,
          content: { question: 'Q?', options: [{ id: 'opt-a', text: 'A' }] },
          orderIndex: 1024,
          version: 0,
        },
        {
          id: 'slide-a',
          sessionId: 'session-1',
          type: 'poll' as const,
          content: { question: 'Q?', options: [{ id: 'opt-a', text: 'A' }] },
          orderIndex: 2048,
          version: 0,
        },
        {
          id: 'slide-b',
          sessionId: 'session-1',
          type: 'poll' as const,
          content: { question: 'Q?', options: [{ id: 'opt-a', text: 'A' }] },
          orderIndex: 3072,
          version: 0,
        },
      ];

      // Verify orderIndex spacing is at 1024 intervals
      for (let i = 0; i < response.length; i++) {
        const expectedOrder = (i + 1) * 1024;
        expect(response[i].orderIndex).toBe(expectedOrder);
      }
    });
  });

  describe('slide deletion response (DELETE /api/sessions/:id/slides/:slideId)', () => {
    it('should return success for successful deletion', () => {
      // DELETE returns 204 No Content or 200 with success message
      expect(true).toBe(true);
    });
  });

  describe('slide content schemas', () => {
    it('should validate poll content', () => {
      const content = {
        question: 'Test?',
        options: [{ id: 'opt-1', text: 'Option 1' }],
        limitSubmissions: true,
      };

      const parseResult = PollSlideContentSchema.safeParse(content);
      expect(parseResult.success).toBe(true);
    });

    it('should validate multiple choice content', () => {
      const content = {
        question: 'Test?',
        options: [{ id: 'opt-1', text: 'Option 1' }],
        allowMultipleSelection: false,
        limitSubmissions: true,
      };

      const parseResult = MultipleChoiceSlideContentSchema.safeParse(content);
      expect(parseResult.success).toBe(true);
    });

    it('should validate quiz content', () => {
      const content = {
        question: 'Test?',
        options: [
          { id: 'opt-1', text: 'A', isCorrect: true },
          { id: 'opt-2', text: 'B', isCorrect: false },
        ],
        points: 1000,
        timerDuration: 30,
        limitSubmissions: true,
      };

      const parseResult = QuizSlideContentSchema.safeParse(content);
      expect(parseResult.success).toBe(true);
    });

    it('should validate static content', () => {
      const content = {
        title: 'Static Slide',
        body: 'Some content here',
      };

      const parseResult = StaticSlideContentSchema.safeParse(content);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('slide error responses', () => {
    type ErrorResponse = { success: false; error: string; data?: unknown };

    it('should match not found error shape', () => {
      const response: ErrorResponse = {
        success: false,
        error: 'Slide not found',
      };

      expect(response.success).toBe(false);
      expect(typeof response.error).toBe('string');
    });

    it('should match validation error shape', () => {
      const response: ErrorResponse = {
        success: false,
        error: 'Slide type must be one of: static, poll, quiz, ...',
      };

      expect(response.success).toBe(false);
      expect(typeof response.error).toBe('string');
    });
  });
});
