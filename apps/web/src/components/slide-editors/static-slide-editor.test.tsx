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

    it('handles special characters in title', async () => {
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{ title: 'Title with <script> & "quotes"', body: 'Body' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const titleInput = screen.getByDisplayValue('Title with <script> & "quotes"');
        expect(titleInput).toBeTruthy();
    });

    it('handles long body content', () => {
        const longBody = 'A'.repeat(10000);
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{ title: 'Long Content', body: longBody }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const textarea = screen.getByPlaceholderText(/enter slide content/i);
        expect(textarea).toHaveValue(longBody);
    });

    it('handles multiline body content', () => {
        const multilineBody = 'Line 1\nLine 2\nLine 3';
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{ title: 'Multiline', body: multilineBody }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const textarea = screen.getByPlaceholderText(/enter slide content/i);
        expect(textarea).toHaveValue(multilineBody);
    });

    it('buffers body changes until blur', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{ title: 'Title', body: 'Original' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const textarea = screen.getByPlaceholderText(/enter slide content/i);
        fireEvent.change(textarea, { target: { value: 'Updated body' } });

        expect(onChange).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.blur(textarea);
        });

        expect(onChange).toHaveBeenCalledWith({ title: 'Title', body: 'Updated body' });
    });

    it('syncs both title and body when content prop changes during editing', async () => {
        const onChange = vi.fn();
        const { rerender } = render(
            <StaticSlideEditor
                content={{ title: 'Original', body: 'Original Body' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const titleInput = screen.getByDisplayValue('Original');
        const textarea = screen.getByPlaceholderText(/enter slide content/i);

        // User types but doesn't blur
        fireEvent.change(titleInput, { target: { value: 'User title' } });
        fireEvent.change(textarea, { target: { value: 'User body' } });

        expect(titleInput).toHaveValue('User title');
        expect(textarea).toHaveValue('User body');

        // Content prop changes (e.g., server sync)
        rerender(
            <StaticSlideEditor
                content={{ title: 'Server title', body: 'Server Body' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        // Inputs should sync to server values
        expect(titleInput).toHaveValue('Server title');
        expect(textarea).toHaveValue('Server Body');
    });

    it('handles markdown-like content', () => {
        const markdownBody = '# Heading\n\n**Bold text**\n\n- List item 1\n- List item 2\n\n```code```';
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{ title: 'Markdown Example', body: markdownBody }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const textarea = screen.getByPlaceholderText(/enter slide content/i);
        expect(textarea).toHaveValue(markdownBody);
    });

    it('handles unicode characters', () => {
        const unicodeTitle = '🎉 Emoji Title 🚀 with 中文 and العربية';
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{ title: unicodeTitle, body: 'Body with ©®™' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const titleInput = screen.getByDisplayValue(unicodeTitle);
        expect(titleInput).toBeTruthy();
    });

    it('flushes title changes on blur and includes both fields', async () => {
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{ title: 'Title', body: 'Body' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const titleInput = screen.getByDisplayValue('Title');
        fireEvent.change(titleInput, { target: { value: 'Updated Title' } });

        await act(async () => {
            fireEvent.blur(titleInput);
        });

        expect(onChange).toHaveBeenCalledWith({ title: 'Updated Title', body: 'Body' });
    });

    it('handles rapid consecutive content changes', async () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        const { rerender } = render(
            <StaticSlideEditor
                content={{ title: 'V1', body: 'V1 Body' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        // Rapid content changes (simulating server updates)
        rerender(
            <StaticSlideEditor
                content={{ title: 'V2', body: 'V2 Body' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        rerender(
            <StaticSlideEditor
                content={{ title: 'V3', body: 'V3 Body' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        // Should show final version
        expect(screen.getByDisplayValue('V3')).toBeTruthy();
        expect(screen.getByPlaceholderText(/enter slide content/i)).toHaveValue('V3 Body');
    });

    it('preserves textarea value during user typing', async () => {
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{ title: 'Title', body: 'Initial' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const textarea = screen.getByPlaceholderText(/enter slide content/i);
        
        // Simulate typing
        fireEvent.change(textarea, { target: { value: 'Initial' } });
        fireEvent.change(textarea, { target: { value: 'Initia' } });
        fireEvent.change(textarea, { target: { value: 'Init' } });
        fireEvent.change(textarea, { target: { value: 'In' } });
        fireEvent.change(textarea, { target: { value: 'I' } });

        expect(textarea).toHaveValue('I');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('handles empty body', () => {
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                content={{ title: 'Title Only', body: '' }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const textarea = screen.getByPlaceholderText(/enter slide content/i);
        expect(textarea).toHaveValue('');
    });

    it('handles null/undefined-like edge cases in content', () => {
        const onChange = vi.fn();
        render(
            <StaticSlideEditor
                // @ts-ignore - testing edge case
                content={{ title: null, body: undefined }}
                onChange={onChange}
                disabled={false}
            />,
        );

        const inputs = screen.getAllByRole('textbox');
        // Should fallback to empty strings
        expect(inputs[0]).toHaveValue('');
        expect(inputs[1]).toHaveValue('');
    });
});
