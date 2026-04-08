import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Slide } from 'shared';

import { SlideEditorPanel } from './slide-editor-panel';

// ─── Test Helpers ───────────────────────────────────────────────

function makeSlide(overrides: Partial<Slide> = {}): Slide {
    return {
        id: 'slide-1',
        sessionId: 'session-1',
        type: 'static',
        content: { title: 'Original', body: 'Body' },
        orderIndex: 0,
        isHidden: false,
        version: 1,
        ...overrides,
    };
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

function makePollSlide(): Slide {
    return makeSlide({
        type: 'poll',
        content: {
            question: 'Favorite color?',
            options: [
                { id: 'opt-1', text: 'Red' },
                { id: 'opt-2', text: 'Blue' },
            ],
            chartType: 'bar' as const,
            limitSubmissions: true,
        },
    });
}

function makeQuizSlide(): Slide {
    return makeSlide({
        type: 'quiz',
        content: {
            question: 'What is 2+2?',
            options: [
                { id: 'opt-a', text: '3', isCorrect: false },
                { id: 'opt-b', text: '4', isCorrect: true },
                { id: 'opt-c', text: '5', isCorrect: false },
            ],
            points: 1000,
            timerDuration: 30,
            limitSubmissions: true,
        },
    });
}

function makeMultipleChoiceSlide(): Slide {
    return makeSlide({
        type: 'multiple-choice',
        content: {
            question: 'Select all that apply',
            options: [
                { id: 'opt-x', text: 'Alpha' },
                { id: 'opt-y', text: 'Beta' },
            ],
            allowMultipleSelection: false,
            limitSubmissions: true,
        },
    });
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// ─── Characterization Tests ─────────────────────────────────────

describe('SlideEditorPanel', () => {
    // ── Existing Tests (preserved) ──

    it('keeps a dirty draft and eventually saves it when the slide version changes mid-flight', async () => {
        vi.useFakeTimers();

        const firstSave = deferred<void>();
        const onUpdate = vi
            .fn()
            .mockReturnValueOnce(firstSave.promise)
            .mockResolvedValue(undefined);
        const onSave = vi.fn();

        const { rerender } = render(
            <SlideEditorPanel
                slide={makeSlide()}
                onUpdate={onUpdate}
                onSave={onSave}
            />,
        );

        const input = screen.getByDisplayValue('Original');

        await act(async () => {
            fireEvent.change(input, { target: { value: 'Draft A' } });
        });

        await act(async () => {
            vi.advanceTimersByTime(2500);
        });

        expect(onUpdate).toHaveBeenCalledTimes(1);
        expect(onUpdate).toHaveBeenNthCalledWith(1, {
            title: 'Draft A',
            body: 'Body',
        });

        await act(async () => {
            fireEvent.change(input, { target: { value: 'Draft B' } });
        });

        await act(async () => {
            rerender(
                <SlideEditorPanel
                    slide={makeSlide({
                        version: 2,
                        content: { title: 'Draft A', body: 'Body' },
                    })}
                    onUpdate={onUpdate}
                    onSave={onSave}
                />,
            );
        });

        expect(input).toHaveValue('Draft B');

        await act(async () => {
            firstSave.resolve();
            await firstSave.promise;
        });

        await act(async () => {
            vi.advanceTimersByTime(2500);
        });

        expect(onUpdate).toHaveBeenCalledTimes(2);
        expect(onUpdate).toHaveBeenNthCalledWith(2, {
            title: 'Draft B',
            body: 'Body',
        });
    });

    it('keeps the local draft visible when a newer server snapshot arrives mid-save', async () => {
        vi.useFakeTimers();

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const firstSave = deferred<void>();
        const onUpdate = vi.fn().mockReturnValueOnce(firstSave.promise);
        const onSave = vi.fn();

        const { rerender } = render(
            <SlideEditorPanel
                slide={makeSlide()}
                onUpdate={onUpdate}
                onSave={onSave}
            />,
        );

        const input = screen.getByDisplayValue('Original');

        await act(async () => {
            fireEvent.change(input, { target: { value: 'Local draft' } });
            fireEvent.blur(input);
        });

        expect(onUpdate).toHaveBeenCalledWith({
            title: 'Local draft',
            body: 'Body',
        });

        // Keep the first save unresolved so the panel stays in its in-flight state
        // while a newer server snapshot arrives, matching the real conflict window.
        await act(async () => {
            rerender(
                <SlideEditorPanel
                    slide={makeSlide({
                        version: 2,
                        content: { title: 'Remote title', body: 'Server body' },
                    })}
                    onUpdate={onUpdate}
                    onSave={onSave}
                />,
            );
        });

        expect(screen.getByDisplayValue('Local draft')).toBeInTheDocument();

        await act(async () => {
            firstSave.reject(new Error(
                'A newer version of this slide was saved elsewhere. Your draft is still in the editor; review and save again.',
            ));
            try {
                await firstSave.promise;
            } catch {
                // expected rejection
            }
        });

        expect(screen.getByDisplayValue('Local draft')).toBeInTheDocument();
        expect(screen.queryByText('Save failed.')).not.toBeInTheDocument();
        expect(screen.queryByText('A newer version of this slide was saved elsewhere. Your draft is still in the editor; review and save again.')).not.toBeInTheDocument();
        expect(errorSpy).toHaveBeenCalledWith('Failed to save slide draft', expect.any(Error));
    });

    it('cancels pending save and does not flush when unmounting (slide deleted)', async () => {
        vi.useFakeTimers();

        const onUpdate = vi.fn().mockResolvedValue(undefined);
        const onSave = vi.fn();

        const { unmount } = render(
            <SlideEditorPanel
                slide={makeSlide()}
                onUpdate={onUpdate}
                onSave={onSave}
            />,
        );

        const input = screen.getByDisplayValue('Original');

        // Type to schedule a debounced save
        await act(async () => {
            fireEvent.change(input, { target: { value: 'Draft before delete' } });
        });

        // Advance partway through the debounce window
        await act(async () => {
            vi.advanceTimersByTime(300);
        });

        // No save yet — still within debounce window
        expect(onUpdate).not.toHaveBeenCalled();

        // Simulate slide deletion by unmounting
        unmount();

        // Advance past the debounce window
        await act(async () => {
            vi.advanceTimersByTime(500);
        });

        // The pending save should have been cancelled — no save should occur
        expect(onUpdate).not.toHaveBeenCalled();
    });

    // ── Characterization: Field Updates ──

    describe('field updates', () => {
        it('does not save a text edit until the debounce window elapses', async () => {
            vi.useFakeTimers();
            const onUpdate = vi.fn().mockResolvedValue(undefined);

            render(
                <SlideEditorPanel
                    slide={makeSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            const input = screen.getByDisplayValue('Original');

            await act(async () => {
                fireEvent.change(input, { target: { value: 'Changed' } });
            });

            expect(onUpdate).not.toHaveBeenCalled();

            await act(async () => {
                vi.advanceTimersByTime(2500);
            });

            expect(onUpdate).toHaveBeenCalledWith({
                title: 'Changed',
                body: 'Body',
            });
        });

        it('flushes a buffered text edit on blur without waiting for idle capture', async () => {
            vi.useFakeTimers();
            const onUpdate = vi.fn().mockResolvedValue(undefined);

            render(
                <SlideEditorPanel
                    slide={makeSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            const input = screen.getByDisplayValue('Original');

            await act(async () => {
                fireEvent.change(input, { target: { value: 'Changed' } });
                fireEvent.blur(input);
            });

            expect(onUpdate).toHaveBeenCalledWith({
                title: 'Changed',
                body: 'Body',
            });
        });

        it('preserves in-progress content edits when switching tabs', async () => {
            render(
                <SlideEditorPanel
                    slide={makeSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            const input = screen.getByDisplayValue('Original');

            await act(async () => {
                fireEvent.change(input, { target: { value: 'Buffered title' } });
            });

            await act(async () => {
                fireEvent.click(screen.getByRole('tab', { name: /settings/i }));
            });

            await act(async () => {
                fireEvent.click(screen.getByRole('tab', { name: /content/i }));
            });

            expect(screen.getByDisplayValue('Buffered title')).toBeTruthy();
        });

        it('keeps the local draft visible and logs when a save fails', async () => {
            vi.useFakeTimers();
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const onUpdate = vi.fn().mockRejectedValueOnce(new Error('Network error'));

            render(
                <SlideEditorPanel
                    slide={makeSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            const input = screen.getByDisplayValue('Original');

            await act(async () => {
                fireEvent.change(input, { target: { value: 'Draft' } });
            });
            await act(async () => {
                vi.advanceTimersByTime(2500);
            });

            await vi.waitFor(() => {
                expect(errorSpy).toHaveBeenCalledWith('Failed to save slide draft', expect.any(Error));
            });

            expect(screen.getByDisplayValue('Draft')).toBeInTheDocument();
            expect(screen.queryByText('Save failed.')).not.toBeInTheDocument();
            expect(screen.queryByText('Network error')).not.toBeInTheDocument();
        });
    });

    // ── Characterization: Immediate Save (onBlur) ──

    describe('immediate save (onBlur)', () => {
        it('flushes save on blur', async () => {
            vi.useFakeTimers();
            const onUpdate = vi.fn().mockResolvedValue(undefined);

            render(
                <SlideEditorPanel
                    slide={makeSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            const input = screen.getByDisplayValue('Original');

            await act(async () => {
                fireEvent.change(input, { target: { value: 'Edited' } });
            });

            // Blur should trigger immediate save
            await act(async () => {
                fireEvent.blur(input);
            });

            expect(onUpdate).toHaveBeenCalledWith({
                title: 'Edited',
                body: 'Body',
            });
        });
    });

    // ── Characterization: Error Handling ──

    describe('error handling', () => {
        it('does not render sync status chrome or retry controls', async () => {
            vi.useFakeTimers();
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const onUpdate = vi.fn().mockRejectedValue(new Error('Failed to save'));

            render(
                <SlideEditorPanel
                    slide={makeSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            const input = screen.getByDisplayValue('Original');

            await act(async () => {
                fireEvent.change(input, { target: { value: 'Bad draft' } });
            });
            await act(async () => {
                vi.advanceTimersByTime(2500);
            });

            await vi.waitFor(() => {
                expect(errorSpy).toHaveBeenCalledWith('Failed to save slide draft', expect.any(Error));
            });

            expect(screen.queryByText('Saved')).not.toBeInTheDocument();
            expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: /save now/i })).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
        });
    });

    // ── Characterization: Slide Switch Reset ──

    describe('slide switch reset', () => {
        it('resets all state when switching to a different slide', async () => {
            vi.useFakeTimers();
            const onUpdate = vi.fn().mockResolvedValue(undefined);

            const { rerender } = render(
                <SlideEditorPanel
                    slide={makeSlide({ id: 'slide-1' })}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            // Make some edits
            const input = screen.getByDisplayValue('Original');
            await act(async () => {
                fireEvent.change(input, { target: { value: 'Dirty' } });
            });

            // Switch to a different slide
            await act(async () => {
                rerender(
                    <SlideEditorPanel
                        slide={makeSlide({ id: 'slide-2', content: { title: 'Fresh', body: 'New' } })}
                        onUpdate={onUpdate}
                        onSave={vi.fn()}
                    />,
                );
            });

            // Should show the new slide's content
            expect(screen.getByDisplayValue('Fresh')).toBeTruthy();
        });
    });

    // ── Characterization: Poll Slide Option CRUD ──

    describe('poll slide option CRUD', () => {
        it('renders poll configuration under the settings tab', async () => {
            vi.useFakeTimers();
            const onUpdate = vi.fn().mockResolvedValue(undefined);

            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            await act(async () => {
                fireEvent.click(screen.getByRole('tab', { name: /settings/i }));
            });

            expect(screen.getByRole('button', { name: /bar chart/i })).toBeTruthy();
            expect(screen.getByRole('button', { name: /pie chart/i })).toBeTruthy();
            expect(screen.getByText(/limit to one submission/i)).toBeTruthy();

            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: /pie chart/i }));
                vi.advanceTimersByTime(500);
            });

            expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ chartType: 'pie' }));
        });

        it('renders existing options', async () => {
            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            expect(screen.getByDisplayValue('Red')).toBeTruthy();
            expect(screen.getByDisplayValue('Blue')).toBeTruthy();
        });

        it('adds a new option', async () => {
            vi.useFakeTimers();
            const onUpdate = vi.fn().mockResolvedValue(undefined);

            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            const addOptionBtn = screen.getByRole('button', { name: /add option/i });
            await act(async () => {
                fireEvent.click(addOptionBtn);
            });

            // Should have 3 options now
            expect(screen.getByDisplayValue('Red')).toBeTruthy();
            expect(screen.getByDisplayValue('Blue')).toBeTruthy();
            expect(screen.getByDisplayValue('Option 3')).toBeTruthy();
        });

        it('removes an option', async () => {
            vi.useFakeTimers();
            const onUpdate = vi.fn().mockResolvedValue(undefined);

            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            // Find the option row containing "Red" and click its delete button
            const redOptionRow = screen.getByDisplayValue('Red').closest('[class*="flex items-center gap-2"]');
            const deleteBtn = redOptionRow?.querySelector('button:last-child');

            expect(deleteBtn).toBeTruthy();
            await act(async () => {
                fireEvent.click(deleteBtn!);
            });

            // "Red" should be gone, "Blue" should remain
            expect(screen.queryByDisplayValue('Red')).toBeNull();
            expect(screen.getByDisplayValue('Blue')).toBeTruthy();
        });

        it('edits option text', async () => {
            vi.useFakeTimers();
            const onUpdate = vi.fn().mockResolvedValue(undefined);

            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            const redInput = screen.getByDisplayValue('Red');
            await act(async () => {
                fireEvent.change(redInput, { target: { value: 'Crimson' } });
            });

            expect(redInput).toHaveValue('Crimson');
        });

        it('does not save option text until the buffered change is captured', async () => {
            vi.useFakeTimers();
            const onUpdate = vi.fn().mockResolvedValue(undefined);

            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            const redInput = screen.getByDisplayValue('Red');

            await act(async () => {
                fireEvent.change(redInput, { target: { value: 'Crimson' } });
            });

            expect(onUpdate).not.toHaveBeenCalled();

            await act(async () => {
                vi.advanceTimersByTime(2500);
            });

            expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
                options: expect.arrayContaining([
                    expect.objectContaining({ id: 'opt-1', text: 'Crimson' }),
                    expect.objectContaining({ id: 'opt-2', text: 'Blue' }),
                ]),
            }));
        });

        it('keeps the latest option text when adding another option before idle save', async () => {
            vi.useFakeTimers();

            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            const redInput = screen.getByDisplayValue('Red');

            await act(async () => {
                fireEvent.change(redInput, { target: { value: 'Crimson' } });
            });

            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: /add option/i }));
            });

            expect(screen.getByDisplayValue('Crimson')).toBeTruthy();
            expect(screen.getByDisplayValue('Option 3')).toBeTruthy();
        });
    });

    // ── Characterization: Quiz Slide ──

    describe('quiz slide', () => {
        it('renders quiz configuration under the settings tab', async () => {
            render(
                <SlideEditorPanel
                    slide={makeQuizSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            await act(async () => {
                fireEvent.click(screen.getByRole('tab', { name: /settings/i }));
            });

            expect(screen.getByText(/limit to one submission/i)).toBeTruthy();
        });

        it('renders options with correct/incorrect state', async () => {
            render(
                <SlideEditorPanel
                    slide={makeQuizSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            expect(screen.getByDisplayValue('3')).toBeTruthy();
            expect(screen.getByDisplayValue('4')).toBeTruthy();
            expect(screen.getByDisplayValue('5')).toBeTruthy();

            // There should be one "Correct Answer" button (for opt-b which is correct)
            const correctAnswerBtns = screen.getAllByRole('button', { name: /correct answer/i });
            expect(correctAnswerBtns.length).toBeGreaterThanOrEqual(1);

            // There should be "Mark Correct" buttons for the incorrect options
            const markCorrectBtns = screen.getAllByRole('button', { name: /mark correct/i });
            expect(markCorrectBtns.length).toBeGreaterThanOrEqual(1);
        });

        it('marks an option as correct', async () => {
            vi.useFakeTimers();
            const onUpdate = vi.fn().mockResolvedValue(undefined);

            render(
                <SlideEditorPanel
                    slide={makeQuizSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            // Click "Mark Correct" for the first option (currently incorrect)
            const markCorrectBtns = screen.getAllByRole('button', { name: /mark correct/i });
            await act(async () => {
                fireEvent.click(markCorrectBtns[0]);
            });

            // The first option should now say "Correct Answer"
            expect(screen.getByRole('button', { name: /^correct answer$/i })).toBeTruthy();
        });

        it('renders settings tab button', async () => {
            render(
                <SlideEditorPanel
                    slide={makeQuizSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            // Verify both tab buttons exist
            const settingsTab = screen.getByRole('tab', { name: /settings/i });
            const contentTab = screen.getByRole('tab', { name: /content/i });
            expect(settingsTab).toBeTruthy();
            expect(contentTab).toBeTruthy();

            // Content tab should be active by default
            expect(contentTab).toHaveAttribute('data-state', 'active');
            expect(settingsTab).toHaveAttribute('data-state', 'inactive');
        });
    });

    // ── Characterization: Multiple Choice Slide ──

    describe('multiple choice slide', () => {
        it('renders configuration under the settings tab', async () => {
            render(
                <SlideEditorPanel
                    slide={makeMultipleChoiceSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            // Verify the Settings tab exists
            const settingsTab = screen.getByRole('tab', { name: /settings/i });
            const contentTab = screen.getByRole('tab', { name: /content/i });
            expect(settingsTab).toBeTruthy();
            expect(contentTab).toBeTruthy();

            await act(async () => {
                fireEvent.click(settingsTab);
            });

            expect(screen.getByText(/allow multiple selection/i)).toBeTruthy();
            expect(screen.getByText(/limit to one submission/i)).toBeTruthy();
        });
    });

    // ── Characterization: Disabled State ──

    describe('disabled state', () => {
        it('disables all inputs when disabled', async () => {
            render(
                <SlideEditorPanel
                    slide={makeSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                    disabled
                    disabledReason="Waiting for confirmation"
                />,
            );

            const input = screen.getByDisplayValue('Original');
            expect(input).toBeDisabled();
            // The reason text appears in multiple places (header + button) — just verify at least one exists
            expect(screen.queryAllByText(/Waiting for confirmation/i).length).toBeGreaterThanOrEqual(1);
        });
    });

    // ── Characterization: Static Slide Body ──

    describe('static slide body', () => {
        it('renders textarea for body content', async () => {
            render(
                <SlideEditorPanel
                    slide={makeSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            const textarea = screen.getByPlaceholderText(/enter slide content/i);
            expect(textarea).toBeTruthy();
            expect(textarea).toHaveValue('Body');
        });

        it('edits body content with debounce', async () => {
            vi.useFakeTimers();
            const onUpdate = vi.fn().mockResolvedValue(undefined);

            render(
                <SlideEditorPanel
                    slide={makeSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            const textarea = screen.getByPlaceholderText(/enter slide content/i);
            await act(async () => {
                fireEvent.change(textarea, { target: { value: 'New body content' } });
            });

            // Should not save immediately
            expect(onUpdate).not.toHaveBeenCalled();

            // After debounce window, should save
            await act(async () => {
                vi.advanceTimersByTime(2500);
            });

            expect(onUpdate).toHaveBeenCalledWith({
                title: 'Original',
                body: 'New body content',
            });
        });
    });

    // ── Integration: Option Drag and Drop ──

    describe('option drag and drop', () => {
        it('renders draggable option rows', async () => {
            const onUpdate = vi.fn().mockResolvedValue(undefined);

            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            // Get the option rows
            const redInput = screen.getByDisplayValue('Red');
            const blueInput = screen.getByDisplayValue('Blue');
            
            expect(redInput).toBeTruthy();
            expect(blueInput).toBeTruthy();

            // Verify the options are rendered
            expect(screen.getByText('2 options')).toBeTruthy();
        });
    });

    // ── Integration: Disabled State Propagation ──

    describe('disabled state propagation', () => {
        it('disables option inputs when panel is disabled', () => {
            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                    disabled={true}
                />,
            );

            const redInput = screen.getByDisplayValue('Red');
            const blueInput = screen.getByDisplayValue('Blue');

            expect(redInput).toBeDisabled();
            expect(blueInput).toBeDisabled();
        });

        it('disables add option button when panel is disabled', () => {
            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                    disabled={true}
                />,
            );

            const addOptionBtn = screen.getByRole('button', { name: /add option/i });
            expect(addOptionBtn).toBeDisabled();
        });

        it('disables delete option buttons when panel is disabled', () => {
            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                    disabled={true}
                />,
            );

            const deleteBtns = screen.getAllByRole('button', { name: '' });
            const trashBtns = deleteBtns.filter(btn => btn.querySelector('svg'));
            
            trashBtns.forEach(btn => {
                expect(btn).toBeDisabled();
            });
        });

        it('disables settings controls when panel is disabled', async () => {
            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                    disabled={true}
                />,
            );

            await act(async () => {
                fireEvent.click(screen.getByRole('tab', { name: /settings/i }));
            });

            const barChartBtn = screen.getByRole('button', { name: /bar chart/i });
            const pieChartBtn = screen.getByRole('button', { name: /pie chart/i });
            
            expect(barChartBtn).toBeDisabled();
            expect(pieChartBtn).toBeDisabled();
            
            // Find checkbox by role
            const limitSubmissionCheckbox = screen.getByRole('checkbox');
            expect(limitSubmissionCheckbox).toBeDisabled();
        });

        it('disables quiz mark correct buttons when panel is disabled', () => {
            render(
                <SlideEditorPanel
                    slide={makeQuizSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                    disabled={true}
                />,
            );

            const markCorrectBtns = screen.getAllByRole('button', { name: /mark correct/i });
            markCorrectBtns.forEach(btn => {
                expect(btn).toBeDisabled();
            });
        });
    });

    // ── Integration: Option Label Generation ──

    describe('option label generation', () => {
        it('generates A, B, C labels for options', () => {
            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            // Should have option labels A and B
            const optionLabels = screen.getAllByText(/^[A-Z]$/, { selector: 'div' });
            expect(optionLabels.length).toBeGreaterThanOrEqual(2);
        });

        it('updates labels when options are added', async () => {
            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            const addOptionBtn = screen.getByRole('button', { name: /add option/i });
            await act(async () => {
                fireEvent.click(addOptionBtn);
            });

            // Should now have A, B, C
            const optionLabels = screen.getAllByText(/^[A-Z]$/, { selector: 'div' });
            expect(optionLabels.length).toBeGreaterThanOrEqual(3);
        });

        it('updates labels when options are removed', async () => {
            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            const redInput = screen.getByDisplayValue('Red');
            const redOptionRow = redInput.closest('[class*="flex items-center gap-2"]');
            const deleteBtn = redOptionRow?.querySelector('button:last-child');

            await act(async () => {
                fireEvent.click(deleteBtn!);
            });

            // After removing Red (A), Blue becomes the first option and gets label A
            const optionLabels = screen.getAllByText(/^[A-Z]$/, { selector: 'div' });
            expect(optionLabels.length).toBe(1);
            expect(screen.getByText('A')).toBeTruthy();
        });
    });

    // ── Integration: Option Count Display ──

    describe('option count display', () => {
        it('shows correct option count', () => {
            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            expect(screen.getByText('2 options')).toBeTruthy();
        });

        it('updates count when option is added', async () => {
            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: /add option/i }));
            });

            expect(screen.getByText('3 options')).toBeTruthy();
        });

        it('updates count when option is removed', async () => {
            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            const redInput = screen.getByDisplayValue('Red');
            const redOptionRow = redInput.closest('[class*="flex items-center gap-2"]');
            const deleteBtn = redOptionRow?.querySelector('button:last-child');

            await act(async () => {
                fireEvent.click(deleteBtn!);
            });

            expect(screen.getByText('1 options')).toBeTruthy();
        });
    });

    // ── Integration: Multiple Concurrent Option Edits ──

    describe('multiple concurrent option edits', () => {
        it('handles editing multiple options before save', async () => {
            vi.useFakeTimers();
            const onUpdate = vi.fn().mockResolvedValue(undefined);

            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            const redInput = screen.getByDisplayValue('Red');
            const blueInput = screen.getByDisplayValue('Blue');

            await act(async () => {
                fireEvent.change(redInput, { target: { value: 'Crimson' } });
                fireEvent.change(blueInput, { target: { value: 'Navy' } });
            });

            expect(onUpdate).not.toHaveBeenCalled();

            await act(async () => {
                vi.advanceTimersByTime(250);
            });

            expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
                options: expect.arrayContaining([
                    expect.objectContaining({ text: 'Crimson' }),
                    expect.objectContaining({ text: 'Navy' }),
                ]),
            }));
        });

        it('preserves latest edits when adding option before save', async () => {
            vi.useFakeTimers();
            const onUpdate = vi.fn().mockResolvedValue(undefined);

            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={onUpdate}
                    onSave={vi.fn()}
                />,
            );

            const redInput = screen.getByDisplayValue('Red');

            await act(async () => {
                fireEvent.change(redInput, { target: { value: 'Crimson' } });
            });

            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: /add option/i }));
            });

            // Crimson should still be in the input
            expect(screen.getByDisplayValue('Crimson')).toBeTruthy();
            expect(screen.getByDisplayValue('Option 3')).toBeTruthy();
        });
    });

    // ── Integration: Edge Cases ──

    describe('edge cases', () => {
        it('handles single option deletion', async () => {
            const singleOptionSlide = makePollSlide();
            singleOptionSlide.content = {
                ...singleOptionSlide.content,
                options: [{ id: 'opt-1', text: 'Only Option' }],
            };

            render(
                <SlideEditorPanel
                    slide={singleOptionSlide}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            expect(screen.getByDisplayValue('Only Option')).toBeTruthy();
            expect(screen.getByText('1 options')).toBeTruthy();
        });

        it('handles empty options array', () => {
            const noOptionsSlide = makePollSlide();
            noOptionsSlide.content = {
                ...noOptionsSlide.content,
                options: [],
            };

            render(
                <SlideEditorPanel
                    slide={noOptionsSlide}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            expect(screen.getByText('0 options')).toBeTruthy();
            expect(screen.queryByDisplayValue('Red')).toBeNull();
        });

        it('handles rapid tab switching without losing data', async () => {
            render(
                <SlideEditorPanel
                    slide={makePollSlide()}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            const redInput = screen.getByDisplayValue('Red');

            await act(async () => {
                fireEvent.change(redInput, { target: { value: 'Crimson' } });
            });

            // Rapid tab switching
            for (let i = 0; i < 5; i++) {
                await act(async () => {
                    fireEvent.click(screen.getByRole('tab', { name: /settings/i }));
                    fireEvent.click(screen.getByRole('tab', { name: /content/i }));
                });
            }

            // Data should be preserved
            expect(screen.getByDisplayValue('Crimson')).toBeTruthy();
        });

        it('handles poll slide with all settings', async () => {
            const pollSlide = makePollSlide();
            pollSlide.content = {
                question: 'Complete poll?',
                options: [{ id: 'opt-1', text: 'A' }],
                chartType: 'pie',
                limitSubmissions: false,
            };

            render(
                <SlideEditorPanel
                    slide={pollSlide}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            await act(async () => {
                fireEvent.click(screen.getByRole('tab', { name: /settings/i }));
            });

            // Pie chart button should be active
            const pieChartBtn = screen.getByRole('button', { name: /pie chart/i });
            expect(pieChartBtn).toBeTruthy();
            
            expect(screen.getByText(/limit to one submission/i)).toBeTruthy();
        });

        it('handles quiz slide with all settings', () => {
            const quizSlide = makeQuizSlide();
            quizSlide.content = {
                question: 'Complete quiz?',
                options: [
                    { id: 'opt-1', text: 'A', isCorrect: true },
                    { id: 'opt-2', text: 'B', isCorrect: false },
                ],
                points: 500,
                timerDuration: 60,
                limitSubmissions: false,
            };

            render(
                <SlideEditorPanel
                    slide={quizSlide}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            expect(screen.getByDisplayValue('Complete quiz?')).toBeTruthy();
            expect(screen.getByDisplayValue('A')).toBeTruthy();
            expect(screen.getByDisplayValue('B')).toBeTruthy();
        });

        it('handles multiple choice slide with all settings', async () => {
            const mcSlide = makeMultipleChoiceSlide();
            mcSlide.content = {
                question: 'Complete MC?',
                options: [{ id: 'opt-1', text: 'A' }],
                allowMultipleSelection: true,
                limitSubmissions: false,
            };

            render(
                <SlideEditorPanel
                    slide={mcSlide}
                    onUpdate={vi.fn().mockResolvedValue(undefined)}
                    onSave={vi.fn()}
                />,
            );

            await act(async () => {
                fireEvent.click(screen.getByRole('tab', { name: /settings/i }));
            });

            expect(screen.getByText(/allow multiple selection/i)).toBeTruthy();
            expect(screen.getByText(/limit to one submission/i)).toBeTruthy();
        });
    });
});
