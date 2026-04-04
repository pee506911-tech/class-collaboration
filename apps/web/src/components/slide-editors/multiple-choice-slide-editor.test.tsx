import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
