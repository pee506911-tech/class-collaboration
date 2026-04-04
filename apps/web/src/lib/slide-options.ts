/**
 * Pure utility functions for slide option management.
 * No side effects, no React — easily testable.
 */

export interface SlideOption {
    id: string;
    text: string;
    isCorrect?: boolean;
}

export type SlideType = 'poll' | 'multiple-choice' | 'quiz';

/**
 * Add a new option to the end of the list.
 * For quiz slides, the new option defaults to isCorrect: false.
 */
export function addOption(
    options: SlideOption[],
    slideType: SlideType,
): SlideOption[] {
    const newOption: SlideOption = {
        id: Math.random().toString(36).substr(2, 9),
        text: `Option ${options.length + 1}`,
        ...(slideType === 'quiz' ? { isCorrect: false } : {}),
    };
    return [...options, newOption];
}

/**
 * Remove an option by ID.
 */
export function removeOption(
    options: SlideOption[],
    optionId: string,
): SlideOption[] {
    return options.filter((o) => o.id !== optionId);
}

/**
 * Reorder options from one index to another.
 */
export function reorderOption(
    options: SlideOption[],
    fromIndex: number,
    toIndex: number,
): SlideOption[] {
    const items = Array.from(options);
    const [reorderedItem] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, reorderedItem);
    return items;
}

/**
 * Update the text of a specific option.
 */
export function updateOptionText(
    options: SlideOption[],
    optionId: string,
    text: string,
): SlideOption[] {
    return options.map((o) =>
        o.id === optionId ? { ...o, text } : o,
    );
}

/**
 * Mark a specific option as correct (for quiz slides).
 * All other options are marked as incorrect.
 */
export function markOptionCorrect(
    options: SlideOption[],
    optionId: string,
): SlideOption[] {
    return options.map((o) => ({
        ...o,
        isCorrect: o.id === optionId,
    }));
}
