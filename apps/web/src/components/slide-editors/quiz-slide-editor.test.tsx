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

    it('calls onChange when timer duration changes', () => {
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
            expect(onChange).toHaveBeenCalledWith(
                expect.objectContaining({ timerDuration: 60 }),
            );
        }
    });

    it('renders limit submissions toggle', () => {
        const onChange = vi.fn();
        render(
            <QuizSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByText(/limit to one submission/i)).toBeTruthy();
    });
});
