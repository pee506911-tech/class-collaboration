import { memo } from 'react';
import type { CSSProperties, MouseEvent, TransitionEventHandler } from 'react';

import { Button } from '@/components/ui/button';
import type { Slide } from 'shared';
import type { DraggableProvidedDragHandleProps } from '@hello-pangea/dnd';
import { BarChart2, Eye, EyeOff, GripVertical, HelpCircle, Layout } from 'lucide-react';

export interface SlideListItemProps {
    slide: Slide;
    index: number;
    isPreview: boolean;
    isLive: boolean;
    isDragging: boolean;
    isStructuralSyncing: boolean;
    innerRef: (element?: HTMLElement | null) => void;
    draggableAttributes: {
        'data-rfd-draggable-context-id': string;
        'data-rfd-draggable-id': string;
    };
    draggableStyle?: CSSProperties;
    onTransitionEnd?: TransitionEventHandler<HTMLDivElement>;
    dragHandleProps: DraggableProvidedDragHandleProps | null;
    onSelectSlide: (slideId: string) => void;
    onToggleVisibility: (event: MouseEvent, slide: Slide) => void;
}

function getSlideLabel(slide: Slide) {
    return slide.content.question || slide.content.title || 'Untitled Slide';
}

function areStylesEqual(left?: CSSProperties, right?: CSSProperties) {
    if (left === right) {
        return true;
    }

    if (!left || !right) {
        return false;
    }

    const leftKeys = Object.keys(left) as Array<keyof CSSProperties>;
    const rightKeys = Object.keys(right) as Array<keyof CSSProperties>;

    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    return leftKeys.every((key) => Object.is(left[key], right[key]));
}

function areDragHandlePropsEqual(
    left: DraggableProvidedDragHandleProps | null,
    right: DraggableProvidedDragHandleProps | null,
) {
    if (left === right) {
        return true;
    }

    if (!left || !right) {
        return false;
    }

    return left.role === right.role
        && left.tabIndex === right.tabIndex
        && left.draggable === right.draggable
        && left['aria-describedby'] === right['aria-describedby']
        && left['data-rfd-drag-handle-context-id'] === right['data-rfd-drag-handle-context-id']
        && left['data-rfd-drag-handle-draggable-id'] === right['data-rfd-drag-handle-draggable-id'];
}

function areSlidesEqual(left: Slide, right: Slide) {
    return left.id === right.id
        && left.type === right.type
        && left.isHidden === right.isHidden
        && getSlideLabel(left) === getSlideLabel(right);
}

function SlideListItemComponent({
    slide,
    index,
    isPreview,
    isLive,
    isDragging,
    isStructuralSyncing,
    innerRef,
    draggableAttributes,
    draggableStyle,
    onTransitionEnd,
    dragHandleProps,
    onSelectSlide,
    onToggleVisibility,
}: SlideListItemProps) {
    return (
        <div
            ref={innerRef}
            {...draggableAttributes}
            onTransitionEnd={onTransitionEnd}
            onClick={() => onSelectSlide(slide.id)}
            style={{
                ...draggableStyle,
                contentVisibility: 'auto',
                containIntrinsicSize: '80px',
            }}
            className={`group relative p-3 rounded-xl cursor-pointer transition-all duration-200 border ${isPreview
                ? 'bg-white border-blue-600 shadow-md ring-1 ring-blue-600/20 z-10'
                : isLive
                    ? 'bg-green-50 border-green-600 shadow-sm ring-1 ring-green-600/20'
                    : 'bg-white border-slate-200 hover:border-blue-300 hover:shadow-sm'
                } ${isDragging ? 'shadow-xl ring-2 ring-blue-600 rotate-2 z-50' : ''}`}
            title={
                isPreview
                    ? 'Selected for Preview'
                    : isLive
                        ? 'Active for Students (via Mobile Clicker)'
                        : 'Click to preview'
            }
        >
            <div className="flex items-center gap-3">
                <div {...(dragHandleProps ?? {})} className="text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing p-1 -ml-1">
                    <GripVertical className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-1">
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isPreview
                                ? 'bg-blue-100 text-blue-700'
                                : isLive
                                    ? 'bg-green-100 text-green-700'
                                    : 'bg-slate-100 text-slate-500'
                                }`}>
                                #{index + 1}
                            </span>
                            {isLive && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-600 text-white">
                                    LIVE
                                </span>
                            )}
                            {slide.isHidden && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-500 flex items-center gap-1">
                                    <EyeOff className="w-3 h-3" /> HIDDEN
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-1">
                            <Button
                                variant="ghost"
                                size="icon"
                                className={`h-6 w-6 ${slide.isHidden ? 'text-slate-400' : 'text-slate-300 hover:text-slate-500'}`}
                                disabled={isStructuralSyncing}
                                onClick={(event) => onToggleVisibility(event, slide)}
                                title={slide.isHidden ? 'Show Slide' : 'Hide Slide'}
                            >
                                {slide.isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </Button>
                            {slide.type === 'poll' && <BarChart2 className="w-3 h-3 text-slate-400" />}
                            {slide.type === 'quiz' && <HelpCircle className="w-3 h-3 text-yellow-500" />}
                            {slide.type === 'static' && <Layout className="w-3 h-3 text-slate-400" />}
                        </div>
                    </div>
                    <p className={`text-xs font-medium truncate ${slide.isHidden ? 'text-slate-400 italic' : 'text-slate-700'}`}>
                        {getSlideLabel(slide)}
                    </p>
                </div>
            </div>
        </div>
    );
}

export function areSlideListItemPropsEqual(prevProps: SlideListItemProps, nextProps: SlideListItemProps) {
    return prevProps.index === nextProps.index
        && prevProps.isPreview === nextProps.isPreview
        && prevProps.isLive === nextProps.isLive
        && prevProps.isDragging === nextProps.isDragging
        && prevProps.isStructuralSyncing === nextProps.isStructuralSyncing
        && prevProps.onTransitionEnd === nextProps.onTransitionEnd
        && prevProps.onSelectSlide === nextProps.onSelectSlide
        && prevProps.onToggleVisibility === nextProps.onToggleVisibility
        && prevProps.draggableAttributes['data-rfd-draggable-context-id'] === nextProps.draggableAttributes['data-rfd-draggable-context-id']
        && prevProps.draggableAttributes['data-rfd-draggable-id'] === nextProps.draggableAttributes['data-rfd-draggable-id']
        && areStylesEqual(prevProps.draggableStyle, nextProps.draggableStyle)
        && areDragHandlePropsEqual(prevProps.dragHandleProps, nextProps.dragHandleProps)
        && areSlidesEqual(prevProps.slide, nextProps.slide);
}

export const SlideListItem = memo(SlideListItemComponent, areSlideListItemPropsEqual);
