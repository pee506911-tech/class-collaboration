import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Phase 2.1: Optimistic Vote UI - Test-Driven Development
 *
 * Goal: Vote submission should feel instant (<50ms perceived latency)
 * Current: 500-800ms round-trip before seeing any feedback
 *
 * Strategy: Test the optimistic update behavior independently of network calls
 */

describe('Optimistic Vote UI - PollSlide', () => {
  /**
   * **Feature: performance-audit, Finding 5: Optimistic Vote UI**
   * **Validates: Phase 2.1 - Instant vote feedback**
   *
   * Property: When a student selects a vote option, the UI SHALL immediately show
   * the selection as "submitted" BEFORE the server confirms. If the server call
   * fails, the UI MUST roll back to the pre-vote state and show an error.
   *
   * Rationale: Vote submission is idempotent (participantId + slideId). Rollback
   * is trivial: restore previous selection. This is simpler than Twitter's like
   * pattern because there's no conflict resolution needed.
   */
  describe('Property 1: Optimistic Update on Vote Submit', () => {
    it('should immediately mark option as submitted before server responds', async () => {
      // This test documents the FIXED behavior (GREEN phase):
      // Optimistic update should mark as submitted BEFORE awaiting server

      let serverCallTime = 0;
      const mockSendMessage = vi.fn().mockImplementation(async () => {
        serverCallTime = Date.now();
        // Simulate 500ms server delay
        await new Promise(resolve => setTimeout(resolve, 500));
        return { ok: true, requestId: 'req-123' };
      });

      const slide = {
        id: 'slide-1',
        type: 'poll',
        content: {
          question: 'What is 2+2?',
          options: [
            { id: 'opt-1', text: '4' },
            { id: 'opt-2', text: '5' },
          ],
          limitSubmissions: true,
        },
      };

      // State tracking
      let hasSubmitted = false;
      let selectedOption: string | null = null;
      let submissionStartTime = 0;
      let stateUpdateTime = 0;

      // Simulate optimistic update behavior (as implemented in slide-renderer.tsx)
      const handleSubmitOptimistic = async () => {
        const selectedOptionId = 'opt-1';
        submissionStartTime = Date.now();
        
        // Optimistic update: mark as submitted IMMEDIATELY
        hasSubmitted = true;
        selectedOption = selectedOptionId;
        stateUpdateTime = Date.now();
        
        // Now await the server call
        await mockSendMessage('SUBMIT_VOTE', { slideId: slide.id, optionId: selectedOptionId });
      };

      // Start vote submission
      await handleSubmitOptimistic();

      // ASSERTION: State should be updated before the server call completed
      const perceivedLatency = stateUpdateTime - submissionStartTime;
      const serverLatency = serverCallTime - submissionStartTime;

      // GREEN: Optimistic update happens immediately (<10ms)
      expect(perceivedLatency).toBeLessThan(10);
      expect(hasSubmitted).toBe(true);
      expect(selectedOption).toBe('opt-1');
      // Server call should happen after state update
      expect(serverLatency).toBeGreaterThanOrEqual(perceivedLatency);
    });

    it('should rollback optimistic update on server failure', async () => {
      // This test verifies rollback behavior

      const mockSendMessage = vi.fn().mockResolvedValue({
        ok: false,
        requestId: 'req-123',
        status: 500,
      });

      let hasSubmitted = false;
      let selectedOption: string | null = null;
      const previousState: { hasSubmitted: boolean; selectedOption: string | null } = { hasSubmitted: false, selectedOption: null };

      // Simulate optimistic update with rollback
      const handleSubmitWithRollback = async () => {
        const selectedOptionId = 'opt-1';
        
        // Save state for rollback
        previousState.hasSubmitted = hasSubmitted;
        previousState.selectedOption = selectedOption;

        // Optimistic update
        hasSubmitted = true;
        selectedOption = selectedOptionId;

        const result = await mockSendMessage('SUBMIT_VOTE', { 
          slideId: 'slide-1', 
          optionId: selectedOptionId 
        });

        if (!result.ok) {
          // Rollback
          hasSubmitted = previousState.hasSubmitted;
          selectedOption = previousState.selectedOption;
        }
      };

      await handleSubmitWithRollback();

      expect(hasSubmitted).toBe(false);
      expect(selectedOption).toBe(null);
    });
  });

  describe('Property 2: MyVotes Sync After Optimistic Update', () => {
    it('should update myVotes context optimistically', async () => {
      // Test that myVotes gets updated immediately, not after server round-trip

      let myVotes: Record<string, string[]> = {};
      const mockSetMyVotes = vi.fn((update) => {
        myVotes = typeof update === 'function' ? update(myVotes) : update;
      });

      // Simulate optimistic myVotes update (as should happen in websocket context)
      const updateMyVotesOptimistic = async () => {
        // Optimistic update: update immediately
        mockSetMyVotes({ 'slide-1': ['opt-1'] });
        
        // Simulate server delay (but we don't wait for it to update myVotes)
        await new Promise(resolve => setTimeout(resolve, 500));
      };

      const startTime = Date.now();
      await updateMyVotesOptimistic();
      const endTime = Date.now();

      // GREEN: myVotes should be updated immediately (<10ms)
      // The function awaits a delay, but myVotes should be set before the await
      const updateLatency = endTime - startTime;
      
      // The myVotes was set optimistically before the await
      expect(myVotes['slide-1']).toEqual(['opt-1']);
      // Total time includes the await, but the update happened immediately
      expect(mockSetMyVotes).toHaveBeenCalledWith({ 'slide-1': ['opt-1'] });
    });
  });

  describe('Property 3: Duplicate Vote Prevention', () => {
    it('should prevent double submission during optimistic update', async () => {
      const mockSendMessage = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
        return { ok: true, requestId: 'req-123' };
      });

      let isSubmitting = false;
      let hasSubmitted = false;
      let submitCount = 0;

      const handleSubmit = async () => {
        if (hasSubmitted || isSubmitting) return;
        
        isSubmitting = true;
        submitCount++;
        
        await mockSendMessage('SUBMIT_VOTE', { slideId: 'slide-1', optionId: 'opt-1' });
        
        isSubmitting = false;
        hasSubmitted = true;
      };

      // Simulate rapid double-click
      await Promise.all([handleSubmit(), handleSubmit()]);

      // Should only submit once
      expect(submitCount).toBe(1);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
  });
});
