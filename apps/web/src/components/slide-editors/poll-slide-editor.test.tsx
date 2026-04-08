import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PollSlideEditor } from './poll-slide-editor';

function makeContent(overrides = {}) {
    return {
        question: 'Favorite color?',
        options: [
            { id: 'opt-1', text: 'Red' },
            { id: 'opt-2', text: 'Blue' },
        ],
        chartType: 'bar' as const,
        limitSubmissions: true,
        ...overrides,
    };
}

describe('PollSlideEditor', () => {
    it('renders question input', () => {
        const onChange = vi.fn();
        render(
            <PollSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByDisplayValue('Favorite color?')).toBeTruthy();
        expect(screen.getByText(/question/i)).toBeTruthy();
    });

    it('does not render options — those are handled by OptionListEditor', () => {
        const onChange = vi.fn();
        render(
            <PollSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        // Options are managed by the parent SlideEditorPanel via OptionListEditor
        expect(screen.queryByDisplayValue('Red')).toBeNull();
    });

    it('buffers question changes until blur', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        render(
            <PollSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        const questionInput = screen.getByDisplayValue('Favorite color?');
        fireEvent.change(questionInput, { target: { value: 'New question?' } });

        expect(onChange).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.blur(questionInput);
        });

        expect(onChange).toHaveBeenCalledWith(
            expect.objectContaining({ question: 'New question?' }),
        );
    });

    it('flushes question changes after idle time', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        render(
            <PollSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        const questionInput = screen.getByDisplayValue('Favorite color?');
        fireEvent.change(questionInput, { target: { value: 'Buffered poll question?' } });

        await act(async () => {
            vi.advanceTimersByTime(2000);
        });

        expect(onChange).toHaveBeenCalledWith(
            expect.objectContaining({ question: 'Buffered poll question?' }),
        );
    });

    it('does not render configuration controls in the content editor', () => {
        const onChange = vi.fn();
        render(
            <PollSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.queryByRole('button', { name: /bar chart/i })).toBeNull();
        expect(screen.queryByRole('button', { name: /pie chart/i })).toBeNull();
        expect(screen.queryByText(/limit to one submission/i)).toBeNull();
    });

    it('disables the question input when disabled is true', () => {
        const onChange = vi.fn();
        render(
            <PollSlideEditor
                content={makeContent()}
                onChange={onChange}
                disabled={true}
            />,
        );

        const questionInput = screen.getByDisplayValue('Favorite color?');
        expect(questionInput).toBeDisabled();
    });

    it('handles empty question gracefully', () => {
        const onChange = vi.fn();
        render(
            <PollSlideEditor
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
            <PollSlideEditor
                content={makeContent({ question: 'First poll question' })}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByDisplayValue('First poll question')).toBeTruthy();

        rerender(
            <PollSlideEditor
                content={makeContent({ question: 'Second poll question' })}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByDisplayValue('Second poll question')).toBeTruthy();
    });

    it('preserves uncontrolled input value until content changes', async () => {
        const onChange = vi.fn();
        const { rerender } = render(
            <PollSlideEditor
                content={makeContent({ question: 'Original poll question' })}
                onChange={onChange}
                disabled={false}
            />,
        );

        const questionInput = screen.getByDisplayValue('Original poll question');

        // Manually change input (simulates user typing)
        fireEvent.change(questionInput, { target: { value: 'User typed answer' } });

        // Input should still show user input (uncontrolled)
        expect(questionInput).toHaveValue('User typed answer');

        // Now change content prop - should sync
        rerender(
            <PollSlideEditor
                content={makeContent({ question: 'Server updated question' })}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(questionInput).toHaveValue('Server updated question');
    });

    it('includes chartType and other fields in onChange', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        const content = makeContent({
            question: 'Test?',
            chartType: 'pie' as const,
            limitSubmissions: false,
        });

        render(
            <PollSlideEditor
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
            options: content.options,
            chartType: 'pie',
            limitSubmissions: false,
        });
    });

    it('handles missing options array gracefully', () => {
        const onChange = vi.fn();
        render(
            <PollSlideEditor
                content={{ question: 'No options poll' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByDisplayValue('No options poll')).toBeTruthy();
    });

    it('handles chartType defaults', () => {
        const onChange = vi.fn();
        render(
            <PollSlideEditor
                content={{ question: 'Default chart?' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByDisplayValue('Default chart?')).toBeTruthy();
    });
});
