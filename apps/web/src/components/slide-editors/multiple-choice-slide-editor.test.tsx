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

    it('does not render configuration controls in the content editor', () => {
        const onChange = vi.fn();
        render(
            <MultipleChoiceSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.queryByText(/allow multiple selection/i)).toBeNull();
        expect(screen.queryByText(/limit to one submission/i)).toBeNull();
    });

    it('disables the question input when disabled is true', () => {
        const onChange = vi.fn();
        render(
            <MultipleChoiceSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={true}
            />,
        );

        const questionInput = screen.getByDisplayValue('Select all that apply');
        expect(questionInput).toBeDisabled();
    });

    it('handles empty question gracefully', () => {
        const onChange = vi.fn();
        render(
            <MultipleChoiceSlideEditor
                content={makeContent({ question: '' })}
                onChange={onChange}
                disabled={false}
            />,
        );

        const questionInput = screen.getByPlaceholderText(/enter your question/i);
        expect(questionInput).toHaveValue('');
    });

    it('syncs input value when content prop changes', () => {
        const onChange = vi.fn();
        const { rerender } = render(
            <MultipleChoiceSlideEditor
                content={makeContent({ question: 'First question' })}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByDisplayValue('First question')).toBeTruthy();

        rerender(
            <MultipleChoiceSlideEditor
                content={makeContent({ question: 'Second question' })}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByDisplayValue('Second question')).toBeTruthy();
    });

    it('preserves uncontrolled input value until content changes', async () => {
        const onChange = vi.fn();
        const { rerender } = render(
            <MultipleChoiceSlideEditor
                content={makeContent({ question: 'Original' })}
                onChange={onChange}
                disabled={false}
            />,
        );

        const questionInput = screen.getByDisplayValue('Original');

        // Manually change input (simulates user typing)
        fireEvent.change(questionInput, { target: { value: 'User typed' } });

        // Input should still show user input (uncontrolled)
        expect(questionInput).toHaveValue('User typed');

        // Now change content prop - should sync
        rerender(
            <MultipleChoiceSlideEditor
                content={makeContent({ question: 'Server updated' })}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(questionInput).toHaveValue('Server updated');
    });

    it('flushes question changes after idle time', async () => {
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
        fireEvent.change(questionInput, { target: { value: 'Buffered question' } });

        expect(onChange).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(2000);
        });

        expect(onChange).toHaveBeenCalledWith(
            expect.objectContaining({ question: 'Buffered question' }),
        );
    });

    it('includes all content fields in onChange', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        const content = makeContent({
            question: 'Test?',
            options: [{ id: 'opt-1', text: 'Option 1' }],
            allowMultipleSelection: true,
            limitSubmissions: false,
        });

        render(
            <MultipleChoiceSlideEditor
                content={content}
                onChange={onChange}
                disabled={false}
            />,
        );

        const questionInput = screen.getByDisplayValue('Test?');
        fireEvent.change(questionInput, { target: { value: 'Updated?' } });

        await act(async () => {
            vi.advanceTimersByTime(2000);
        });

        expect(onChange).toHaveBeenCalledWith({
            question: 'Updated?',
            options: [{ id: 'opt-1', text: 'Option 1' }],
            allowMultipleSelection: true,
            limitSubmissions: false,
        });
    });

    it('handles missing options array gracefully', () => {
        const onChange = vi.fn();
        render(
            <MultipleChoiceSlideEditor
                content={{ question: 'No options' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByDisplayValue('No options')).toBeTruthy();
    });
});
