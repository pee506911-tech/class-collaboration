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

    it('calls onChange when title changes', () => {
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

        expect(onChange).toHaveBeenCalledWith({ title: 'New Title', body: 'Body' });
    });

    it('calls onChange when body changes', () => {
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

        expect(onChange).toHaveBeenCalledWith({ title: 'Title', body: 'New Body' });
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
