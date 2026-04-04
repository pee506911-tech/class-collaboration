import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { areSlideListItemPropsEqual, SlideListItem } from './slide-list-item';

function makeProps(overrides: Partial<React.ComponentProps<typeof SlideListItem>> = {}): React.ComponentProps<typeof SlideListItem> {
    return {
        slide: {
            id: 'slide-1',
            sessionId: 'session-1',
            type: 'static',
            content: { title: 'Intro slide' },
            orderIndex: 0,
            isHidden: false,
            version: 1,
        },
        index: 0,
        isPreview: false,
        isLive: false,
        isDragging: false,
        isStructuralSyncing: false,
        innerRef: vi.fn(),
        draggableAttributes: {
            'data-rbd-draggable-context-id': 'test-context',
            'data-rbd-draggable-id': 'slide-1',
        },
        draggableStyle: {},
        dragHandleProps: {
            tabIndex: 0,
            role: 'button',
            'aria-describedby': 'drag-handle',
            draggable: false,
            onDragStart: vi.fn(),
        },
        onSelectSlide: vi.fn(),
        onToggleVisibility: vi.fn(),
        ...overrides,
    };
}

describe('SlideListItem', () => {
    it('renders slide state badges and title', () => {
        render(
            <SlideListItem
                {...makeProps({
                    isPreview: true,
                    isLive: true,
                    slide: {
                        id: 'slide-1',
                        sessionId: 'session-1',
                        type: 'static',
                        content: { title: 'Intro slide' },
                        orderIndex: 0,
                        isHidden: true,
                        version: 1,
                    },
                })}
            />,
        );

        expect(screen.getByText('#1')).toBeTruthy();
        expect(screen.getByText('LIVE')).toBeTruthy();
        expect(screen.getByText('HIDDEN')).toBeTruthy();
        expect(screen.getByText('Intro slide')).toBeTruthy();
    });

    it('treats cloned slide objects with the same rendered fields as equal', () => {
        const props = makeProps();
        expect(areSlideListItemPropsEqual(
            props,
            {
                ...props,
                slide: { ...props.slide },
            },
        )).toBe(true);

        expect(areSlideListItemPropsEqual(
            props,
            {
                ...props,
                isPreview: true,
            },
        )).toBe(false);
    });
});
