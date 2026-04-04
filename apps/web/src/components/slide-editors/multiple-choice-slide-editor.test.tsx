import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MultipleChoiceSlideEditor } from './multiple-choice-slide-editor';

function makeContent(overrides = {}) {
    return {
        question: 'Select all that apply',
        options: [
            { id: 'opt-x', text: 'Alpha' },
            { id: 'opt-y', text: 'Beta' },
        ],
        allowMultipleSelection: false,
        limitSubmissions: true,
        ...overrides,
    };
}

describe('MultipleChoiceSlideEditor', () => {
    it('renders question input', () => {
        const onChange = vi.fn();
        render(
            <MultipleChoiceSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByDisplayValue('Select all that apply')).toBeTruthy();
    });

    it('buffers question changes until blur', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        render(
            <MultipleChoiceSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        const questionInput = screen.getByDisplayValue('Select all that apply');
        fireEvent.change(questionInput, { target: { value: 'Updated question' } });

        expect(onChange).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.blur(questionInput);
        });

        expect(onChange).toHaveBeenCalledWith(
            expect.objectContaining({ question: 'Updated question' }),
        );
    });

    it('renders allow multiple selection toggle', () => {
        const onChange = vi.fn();
        render(
            <MultipleChoiceSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByText(/allow multiple selection/i)).toBeTruthy();
        expect(screen.getByText(/prevent students from changing/i)).toBeTruthy();
    });

    it('renders limit submissions toggle', () => {
        const onChange = vi.fn();
        render(
            <MultipleChoiceSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByText(/limit to one submission/i)).toBeTruthy();
    });
});
