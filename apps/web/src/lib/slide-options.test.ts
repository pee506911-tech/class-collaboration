import { describe, expect, it } from 'vitest';
import {
    addOption,
    removeOption,
    reorderOption,
    updateOptionText,
    markOptionCorrect,
} from './slide-options';

// ─── Test Helpers ───────────────────────────────────────────────

function makeOption(text: string, extra = {}): any {
    return { id: `opt-${text.toLowerCase()}`, text, ...extra };
}

const baseOptions = [
    makeOption('Red'),
    makeOption('Blue'),
];

const quizOptions = [
    makeOption('A', { isCorrect: false }),
    makeOption('B', { isCorrect: true }),
    makeOption('C', { isCorrect: false }),
];

// ─── Tests ─────────────────────────────────────────────────────

describe('addOption', () => {
    it('adds a new option at the end with auto-generated label', () => {
        const result = addOption(baseOptions, 'poll');

        expect(result).toHaveLength(3);
        expect(result[2].text).toBe('Option 3');
        expect(result[2].id).toBeTruthy();
    });

    it('does not mutate the original array', () => {
        const original = [...baseOptions];
        addOption(baseOptions, 'poll');
        expect(baseOptions).toEqual(original);
    });

    it('adds isCorrect: false for quiz slides', () => {
        const result = addOption(quizOptions, 'quiz');

        expect(result).toHaveLength(4);
        expect(result[3].isCorrect).toBe(false);
    });

    it('does not add isCorrect for poll slides', () => {
        const result = addOption(baseOptions, 'poll');

        expect(result[2]).not.toHaveProperty('isCorrect');
    });

    it('does not add isCorrect for multiple-choice slides', () => {
        const result = addOption(baseOptions, 'multiple-choice');

        expect(result[2]).not.toHaveProperty('isCorrect');
    });
});

describe('removeOption', () => {
    it('removes the option with the matching ID', () => {
        const result = removeOption(baseOptions, 'opt-red');

        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('Blue');
    });

    it('does not mutate the original array', () => {
        const original = [...baseOptions];
        removeOption(baseOptions, 'opt-red');
        expect(baseOptions).toEqual(original);
    });

    it('returns empty array when removing the last option', () => {
        const result = removeOption([makeOption('Only')], 'opt-only');
        expect(result).toEqual([]);
    });

    it('returns unchanged array when ID not found', () => {
        const result = removeOption(baseOptions, 'opt-nonexistent');
        expect(result).toEqual(baseOptions);
    });
});

describe('reorderOption', () => {
    it('moves an option from one index to another', () => {
        const options = [makeOption('A'), makeOption('B'), makeOption('C')];
        const result = reorderOption(options, 0, 2);

        expect(result).toHaveLength(3);
        expect(result[0].text).toBe('B');
        expect(result[1].text).toBe('C');
        expect(result[2].text).toBe('A');
    });

    it('does not mutate the original array', () => {
        const options = [makeOption('A'), makeOption('B')];
        const original = [...options];
        reorderOption(options, 0, 1);
        expect(options).toEqual(original);
    });

    it('handles moving to the same index (no-op)', () => {
        const options = [makeOption('A'), makeOption('B')];
        const result = reorderOption(options, 0, 0);

        expect(result).toEqual(options);
    });

    it('handles moving backwards', () => {
        const options = [makeOption('A'), makeOption('B'), makeOption('C')];
        const result = reorderOption(options, 2, 0);

        expect(result[0].text).toBe('C');
        expect(result[1].text).toBe('A');
        expect(result[2].text).toBe('B');
    });
});

describe('updateOptionText', () => {
    it('updates the text of the matching option', () => {
        const result = updateOptionText(baseOptions, 'opt-red', 'Crimson');

        expect(result[0].text).toBe('Crimson');
        expect(result[1].text).toBe('Blue');
    });

    it('does not mutate the original array', () => {
        const original = [...baseOptions];
        updateOptionText(baseOptions, 'opt-red', 'Crimson');
        expect(baseOptions).toEqual(original);
    });

    it('preserves other properties (like isCorrect)', () => {
        const result = updateOptionText(quizOptions, 'opt-b', 'Updated B');

        expect(result[1].text).toBe('Updated B');
        expect(result[1].isCorrect).toBe(true);
    });

    it('returns unchanged array when ID not found', () => {
        const result = updateOptionText(baseOptions, 'opt-nonexistent', 'New');
        expect(result).toEqual(baseOptions);
    });
});

describe('markOptionCorrect', () => {
    it('marks the matching option as correct and others as false', () => {
        const result = markOptionCorrect(quizOptions, 'opt-a');

        expect(result[0].isCorrect).toBe(true);
        expect(result[1].isCorrect).toBe(false);
        expect(result[2].isCorrect).toBe(false);
    });

    it('does not mutate the original array', () => {
        const original = JSON.parse(JSON.stringify(quizOptions));
        markOptionCorrect(quizOptions, 'opt-a');
        expect(quizOptions).toEqual(original);
    });

    it('preserves text and ID while changing only isCorrect', () => {
        const result = markOptionCorrect(quizOptions, 'opt-a');

        expect(result[0].text).toBe('A');
        expect(result[0].id).toBe('opt-a');
        expect(result[1].text).toBe('B');
        expect(result[1].isCorrect).toBe(false);
    });
});
