import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StaticSlideEditor } from './static-slide-editor';

describe('StaticSlideEditor', () => {
    it('renders title input with current value', () => {
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{ title: 'My Title', body: 'My Body' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const titleInput = screen.getByDisplayValue('My Title');
        expect(titleInput).toBeTruthy();
        expect(screen.getByText(/title/i)).toBeTruthy();
    });

    it('renders body textarea with current value', () => {
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{ title: 'My Title', body: 'My Body' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const textarea = screen.getByPlaceholderText(/enter slide content/i);
        expect(textarea).toHaveValue('My Body');
    });

    it('buffers title changes until blur', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{ title: 'Original', body: 'Body' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const titleInput = screen.getByDisplayValue('Original');
        fireEvent.change(titleInput, { target: { value: 'New Title' } });

        expect(onChange).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.blur(titleInput);
        });

        expect(onChange).toHaveBeenCalledWith({ title: 'New Title', body: 'Body' });
    });

    it('flushes buffered body changes after an idle timeout', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{ title: 'Title', body: 'Original Body' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const textarea = screen.getByPlaceholderText(/enter slide content/i);
        fireEvent.change(textarea, { target: { value: 'New Body' } });

        await act(async () => {
            vi.advanceTimersByTime(1999);
        });

        expect(onChange).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(1);
        });

        expect(onChange).toHaveBeenCalledWith({ title: 'Title', body: 'New Body' });
    });

    it('syncs uncontrolled inputs when content changes', () => {
        const onChange = vi.fn();
        const { rerender } = render(
            <StaticSlideEditor
                content={{ title: 'First', body: 'First Body' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        rerender(
            <StaticSlideEditor
                content={{ title: 'Second', body: 'Second Body' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        expect(screen.getByDisplayValue('Second')).toBeTruthy();
        expect(screen.getByPlaceholderText(/enter slide content/i)).toHaveValue('Second Body');
    });

    it('disables inputs when disabled is true', () => {
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{ title: 'Title', body: 'Body' }}
                onChange={onChange}
                disabled
            />,
        );

        expect(screen.getByDisplayValue('Title')).toBeDisabled();
        expect(screen.getByPlaceholderText(/enter slide content/i)).toBeDisabled();
    });

    it('uses default empty strings when content is missing fields', () => {
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{}}
                onChange={onChange}
                disabled={false}
            />,
        );

        const inputs = screen.getAllByRole('textbox');
        expect(inputs[0]).toHaveValue('');
        expect(inputs[1]).toHaveValue('');
    });
});
