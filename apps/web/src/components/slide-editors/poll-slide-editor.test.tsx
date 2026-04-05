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
});
