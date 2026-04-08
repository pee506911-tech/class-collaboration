import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QuizSlideEditor } from './quiz-slide-editor';

function makeContent(overrides = {}) {
    return {
        question: 'What is 2+2?',
        options: [
            { id: 'opt-a', text: '3', isCorrect: false },
            { id: 'opt-b', text: '4', isCorrect: true },
        ],
        points: 1000,
        timerDuration: 30,
        limitSubmissions: true,
        ...overrides,
    };
}

describe('QuizSlideEditor', () => {
    it('renders question input', () => {
        const onChange = vi.fn();
        render(
            <QuizSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByDisplayValue('What is 2+2?')).toBeTruthy();
    });

    it('renders timer duration and points inputs', () => {
        const onChange = vi.fn();
        render(
            <QuizSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        // Check the labels exist
        expect(screen.getByText(/duration \(seconds\)/i)).toBeTruthy();
        // "Points" text may appear in multiple elements — just verify at least one exists
        expect(screen.getAllByText(/points/i).length).toBeGreaterThanOrEqual(1);

        // Check number inputs exist
        const numberInputs = screen.getAllByRole('spinbutton');
        expect(numberInputs.length).toBeGreaterThanOrEqual(2);
    });

    it('buffers timer duration changes until blur', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        render(
            <QuizSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        const timerInputs = screen.getAllByRole('spinbutton');
        const timerInput = timerInputs.find((el) => el.getAttribute('value') === '30');
        if (timerInput) {
            fireEvent.change(timerInput, { target: { value: '60' } });

            expect(onChange).not.toHaveBeenCalled();

            await act(async () => {
                fireEvent.blur(timerInput);
            });

            expect(onChange).toHaveBeenCalledWith(
                expect.objectContaining({ timerDuration: 60 }),
            );
        }
    });

    it('flushes question changes after idle time', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        render(
            <QuizSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        const questionInput = screen.getByDisplayValue('What is 2+2?');
        fireEvent.change(questionInput, { target: { value: 'What is 3+3?' } });

        await act(async () => {
            vi.advanceTimersByTime(2000);
        });

        expect(onChange).toHaveBeenCalledWith(
            expect.objectContaining({ question: 'What is 3+3?' }),
        );
    });

    it('does not render configuration controls in the content editor', () => {
        const onChange = vi.fn();
        render(
            <QuizSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.queryByText(/limit to one submission/i)).toBeNull();
    });

    it('disables all inputs when disabled is true', () => {
        const onChange = vi.fn();
        render(
            <QuizSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={true}
            />,
        );

        const questionInput = screen.getByDisplayValue('What is 2+2?');
        expect(questionInput).toBeDisabled();

        const numberInputs = screen.getAllByRole('spinbutton');
        numberInputs.forEach((input) => {
            expect(input).toBeDisabled();
        });
    });

    it('handles empty question gracefully', () => {
        const onChange = vi.fn();
        render(
            <QuizSlideEditor
                content={makeContent({ question: '' })}
                onChange={onChange}
                disabled={false}
            />,
        );

        const questionInput = screen.getByPlaceholderText(/enter your question/i);
        expect(questionInput).toHaveValue('');
    });

    it('syncs all input values when content prop changes', () => {
        const onChange = vi.fn();
        const { rerender } = render(
            <QuizSlideEditor
                content={makeContent({ question: 'First?', timerDuration: 30, points: 1000 })}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByDisplayValue('First?')).toBeTruthy();

        rerender(
            <QuizSlideEditor
                content={makeContent({ question: 'Second?', timerDuration: 60, points: 2000 })}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByDisplayValue('Second?')).toBeTruthy();
        
        const numberInputs = screen.getAllByRole('spinbutton');
        const timerInput = numberInputs.find((el) => el.getAttribute('value') === '60');
        const pointsInput = numberInputs.find((el) => el.getAttribute('value') === '2000');
        
        expect(timerInput).toBeTruthy();
        expect(pointsInput).toBeTruthy();
    });

    it('preserves uncontrolled input values until content changes', async () => {
        const onChange = vi.fn();
        const { rerender } = render(
            <QuizSlideEditor
                content={makeContent({ question: 'Original?', timerDuration: 30, points: 1000 })}
                onChange={onChange}
                disabled={false}
            />,
        );

        const questionInput = screen.getByDisplayValue('Original?');
        const numberInputs = screen.getAllByRole('spinbutton');
        const timerInput = numberInputs.find((el) => el.getAttribute('value') === '30')!;
        const pointsInput = numberInputs.find((el) => el.getAttribute('value') === '1000')!;

        // Manually change inputs (simulates user typing)
        fireEvent.change(questionInput, { target: { value: 'User question?' } });
        fireEvent.change(timerInput, { target: { value: '45' } });
        fireEvent.change(pointsInput, { target: { value: '1500' } });

        // Inputs should still show user input (uncontrolled)
        expect(questionInput).toHaveValue('User question?');
        expect(timerInput).toHaveValue(45);
        expect(pointsInput).toHaveValue(1500);

        // Now change content prop - should sync
        rerender(
            <QuizSlideEditor
                content={makeContent({ question: 'Server?', timerDuration: 90, points: 3000 })}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(questionInput).toHaveValue('Server?');
        
        const updatedNumberInputs = screen.getAllByRole('spinbutton');
        const updatedTimerInput = updatedNumberInputs.find((el) => el.getAttribute('value') === '90');
        const updatedPointsInput = updatedNumberInputs.find((el) => el.getAttribute('value') === '3000');
        
        expect(updatedTimerInput).toBeTruthy();
        expect(updatedPointsInput).toBeTruthy();
    });

    it('handles invalid number values gracefully', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        render(
            <QuizSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        const numberInputs = screen.getAllByRole('spinbutton');
        const timerInput = numberInputs.find((el) => el.getAttribute('value') === '30')!;

        // Enter invalid value
        fireEvent.change(timerInput, { target: { value: 'abc' } });

        // Change another field to trigger onChange
        const questionInput = screen.getByDisplayValue('What is 2+2?');
        fireEvent.change(questionInput, { target: { value: 'Updated question' } });

        await act(async () => {
            vi.advanceTimersByTime(2000);
        });

        // Should not crash and should call onChange with the question change
        expect(onChange).toHaveBeenCalled();
    });

    it('uses default values when points and timerDuration are missing', () => {
        const onChange = vi.fn();
        render(
            <QuizSlideEditor
                content={{ question: 'No timer/points' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        // Should render with defaults (timerDuration: 30, points: 1000)
        const numberInputs = screen.getAllByRole('spinbutton');
        expect(numberInputs.length).toBeGreaterThanOrEqual(2);
    });

    it('buffers points changes until blur', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        render(
            <QuizSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        const numberInputs = screen.getAllByRole('spinbutton');
        const pointsInput = numberInputs.find((el) => el.getAttribute('value') === '1000');
        
        if (pointsInput) {
            fireEvent.change(pointsInput, { target: { value: '2000' } });

            expect(onChange).not.toHaveBeenCalled();

            await act(async () => {
                fireEvent.blur(pointsInput);
            });

            expect(onChange).toHaveBeenCalledWith(
                expect.objectContaining({ points: 2000 }),
            );
        }
    });

    it('flushes timer duration changes after idle time', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        render(
            <QuizSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        const numberInputs = screen.getAllByRole('spinbutton');
        const timerInput = numberInputs.find((el) => el.getAttribute('value') === '30');
        
        if (timerInput) {
            fireEvent.change(timerInput, { target: { value: '45' } });

            expect(onChange).not.toHaveBeenCalled();

            await act(async () => {
                vi.advanceTimersByTime(2000);
            });

            expect(onChange).toHaveBeenCalledWith(
                expect.objectContaining({ timerDuration: 45 }),
            );
        }
    });

    it('includes all content fields in onChange', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        const content = makeContent({
            question: 'Full quiz?',
            options: [
                { id: 'opt-1', text: 'A', isCorrect: true },
                { id: 'opt-2', text: 'B', isCorrect: false },
            ],
            points: 500,
            timerDuration: 60,
            limitSubmissions: false,
        });

        render(
            <QuizSlideEditor
                content={content}
                onChange={onChange}
                disabled={false}
            />,
        );

        const questionInput = screen.getByDisplayValue('Full quiz?');
        fireEvent.change(questionInput, { target: { value: 'Updated quiz?' } });

        await act(async () => {
            vi.advanceTimersByTime(2000);
        });

        expect(onChange).toHaveBeenCalledWith(
            expect.objectContaining({
                question: 'Updated quiz?',
                options: content.options,
                points: 500,
                timerDuration: 60,
                limitSubmissions: false,
            }),
        );
    });

    it('handles zero values for points and timer', () => {
        const onChange = vi.fn();
        render(
            <QuizSlideEditor
                content={makeContent({ points: 0, timerDuration: 0 })}
                onChange={onChange}
                disabled={false}
            />,
        );

        // With ?? operator, zero values are preserved (not replaced with defaults)
        const numberInputs = screen.getAllByRole('spinbutton');
        const zeroInputs = numberInputs.filter((el) => el.getAttribute('value') === '0');
        
        // Should have 2 inputs with value 0
        expect(zeroInputs.length).toBe(2);
    });
});
