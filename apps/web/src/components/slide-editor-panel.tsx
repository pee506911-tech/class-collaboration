import type { Slide, StaticSlideContent, PollSlideContent, QuizSlideContent, MultipleChoiceSlideContent } from 'shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, GripVertical, Trash2, Type, List, Trophy, Settings } from 'lucide-react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useState, useEffect, useRef, useCallback } from 'react';
import { addOption, removeOption, reorderOption, markOptionCorrect } from '@/lib/slide-options';
import { StaticSlideEditor } from '@/components/slide-editors/static-slide-editor';
import { PollSlideEditor } from '@/components/slide-editors/poll-slide-editor';
import { QuizSlideEditor } from '@/components/slide-editors/quiz-slide-editor';
import { MultipleChoiceSlideEditor } from '@/components/slide-editors/multiple-choice-slide-editor';
import type { EditorSlide } from '@/lib/optimistic-slide-queue';

export type SlideEditorSaveResult = { status: 'saved' | 'queued' };
type SlideOption = { id: string; text: string; isCorrect?: boolean };
type SlideContentDraft = {
    title?: string;
    body?: string;
    description?: string;
    question?: string;
    options?: SlideOption[];
    chartType?: 'bar' | 'pie';
    limitSubmissions?: boolean;
    allowMultipleSelection?: boolean;
    points?: number;
    timerDuration?: number;
};

function areOptionListsEqual(left: SlideOption[], right: SlideOption[]) {
    return left.length === right.length
        && left.every((option, index) => {
            const nextOption = right[index];
            return option.id === nextOption?.id
                && option.text === nextOption.text
                && option.isCorrect === nextOption.isCorrect;
        });
}

interface SlideEditorPanelProps {
    slide: Slide | EditorSlide;
    onUpdate: (content: SlideContentDraft) => Promise<SlideEditorSaveResult>;
    onSave?: () => void;
    disabled?: boolean;
    disabledReason?: string;
}

export function SlideEditorPanel({ slide, onUpdate, disabled = false, disabledReason }: SlideEditorPanelProps) {
    const [localContent, setLocalContent] = useState<SlideContentDraft>(slide.content as SlideContentDraft);

    const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
    const optionCaptureTimerRef = useRef<NodeJS.Timeout | null>(null);
    const optionInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

    const latestContentRef = useRef<SlideContentDraft>(slide.content as SlideContentDraft);
    const lastSyncedVersionRef = useRef(slide.version);
    const pendingFlushRef = useRef(false);
    const inFlightRef = useRef(false);
    const hasLocalDraftRef = useRef(false);

    const onUpdateRef = useRef(onUpdate);
    useEffect(() => {
        onUpdateRef.current = onUpdate;
    }, [onUpdate]);

    const clearOptionCaptureTimer = useCallback(() => {
        if (optionCaptureTimerRef.current) {
            clearTimeout(optionCaptureTimerRef.current);
            optionCaptureTimerRef.current = null;
        }
    }, []);

    const pump = useCallback(async () => {
        if (inFlightRef.current) {
            return;
        }

        inFlightRef.current = true;

        try {
            while (pendingFlushRef.current) {
                pendingFlushRef.current = false;
                const contentToSave = latestContentRef.current;

                try {
                    await onUpdateRef.current(contentToSave);
                } catch (err: unknown) {
                    console.error('Failed to save slide draft', err);
                    return;
                }

                if (latestContentRef.current === contentToSave && !pendingFlushRef.current) {
                    hasLocalDraftRef.current = false;
                }
            }
        } finally {
            inFlightRef.current = false;
        }
    }, []);

    const flushSave = useCallback(async (contentToSave = latestContentRef.current) => {
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        latestContentRef.current = contentToSave;
        pendingFlushRef.current = true;
        await pump();
    }, [pump]);

    const scheduleDebouncedSave = useCallback(() => {
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        debounceTimerRef.current = setTimeout(() => {
            pendingFlushRef.current = true;
            void pump();
        }, 500);
    }, [pump]);

    const stageDraft = useCallback((nextContent: SlideContentDraft) => {
        setLocalContent(nextContent);
        latestContentRef.current = nextContent;
        hasLocalDraftRef.current = true;
    }, []);

    const updateContent = useCallback((updater: (currentContent: SlideContentDraft) => SlideContentDraft, immediate = false) => {
        const nextContent = updater(latestContentRef.current);
        stageDraft(nextContent);

        if (immediate) {
            void flushSave(nextContent);
            return;
        }

        scheduleDebouncedSave();
    }, [flushSave, scheduleDebouncedSave, stageDraft]);

    const handleContentEditorChange = useCallback((nextContent: SlideContentDraft) => {
        stageDraft(nextContent);
        scheduleDebouncedSave();
    }, [scheduleDebouncedSave, stageDraft]);

    // Reset local state only when switching to a different slide.
    useEffect(() => {
        setLocalContent(slide.content);
        latestContentRef.current = slide.content;
        lastSyncedVersionRef.current = slide.version;
        pendingFlushRef.current = false;
        hasLocalDraftRef.current = false;

        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        clearOptionCaptureTimer();

        return () => {
            // Clear any pending debounce timer to prevent saves after unmount
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
                debounceTimerRef.current = null;
            }
            clearOptionCaptureTimer();
            // Do NOT flush here — if the slide was deleted, a flush would
            // attempt to save to a non-existent slide. The parent component
            // is responsible for flushing before structural changes.
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clearOptionCaptureTimer, slide.id]);

    // Rebase to the latest server snapshot only when there is no local draft in flight.
    useEffect(() => {
        if (slide.version === lastSyncedVersionRef.current) {
            return;
        }

        lastSyncedVersionRef.current = slide.version;

        if (hasLocalDraftRef.current || inFlightRef.current || pendingFlushRef.current) {
            return;
        }

        setLocalContent(slide.content);
        latestContentRef.current = slide.content;
    }, [slide.content, slide.version]);

    useEffect(() => {
        for (const option of (localContent.options || []) as SlideOption[]) {
            const input = optionInputRefs.current[option.id];
            if (input && input.value !== option.text) {
                input.value = option.text;
            }
        }
    }, [localContent.options]);

    const updateField = <K extends keyof SlideContentDraft>(field: K, value: SlideContentDraft[K], immediate = false) => {
        updateContent((currentContent) => ({ ...currentContent, [field]: value }), immediate);
    };

    const readCurrentOptions = useCallback((): SlideOption[] => {
        const currentOptions = (latestContentRef.current.options || []) as SlideOption[];
        return currentOptions.map((option) => ({
            ...option,
            text: optionInputRefs.current[option.id]?.value ?? option.text,
        }));
    }, []);

    const captureOptionEdits = useCallback((immediate = false) => {
        const currentOptions = (latestContentRef.current.options || []) as SlideOption[];
        const nextOptions = readCurrentOptions();

        if (areOptionListsEqual(currentOptions, nextOptions)) {
            if (immediate) {
                void flushSave();
            }
            return;
        }

        const nextContent = { ...latestContentRef.current, options: nextOptions };
        stageDraft(nextContent);

        if (immediate) {
            void flushSave(nextContent);
            return;
        }

        scheduleDebouncedSave();
    }, [flushSave, readCurrentOptions, scheduleDebouncedSave, stageDraft]);

    const scheduleOptionCapture = useCallback(() => {
        clearOptionCaptureTimer();
        optionCaptureTimerRef.current = setTimeout(() => {
            captureOptionEdits(false);
            optionCaptureTimerRef.current = null;
        }, 2000);
    }, [captureOptionEdits, clearOptionCaptureTimer]);

    const flushOptionCapture = useCallback(() => {
        clearOptionCaptureTimer();
        captureOptionEdits(true);
    }, [captureOptionEdits, clearOptionCaptureTimer]);

    const handleAddOption = () => {
        const optionSlideType = slide.type === 'quiz' ? 'quiz' : slide.type === 'multiple-choice' ? 'multiple-choice' : 'poll';
        const newOptions = addOption(readCurrentOptions(), optionSlideType);
        updateField('options', newOptions);
    };

    const handleRemoveOption = (id: string) => {
        const newOptions = removeOption(readCurrentOptions(), id);
        updateField('options', newOptions);
    };

    const handleMarkOptionCorrect = (id: string) => {
        const newOptions = markOptionCorrect(readCurrentOptions(), id);
        updateField('options', newOptions);
    };

    const onDragEnd = (result: DropResult) => {
        if (!result.destination) return;
        const newOptions = reorderOption(
            readCurrentOptions(),
            result.source.index,
            result.destination.index,
        );
        updateField('options', newOptions);
    };

    const pollChartType = localContent.chartType || 'bar';
    const limitSubmissions = localContent.limitSubmissions !== false;
    const allowMultipleSelection = localContent.allowMultipleSelection || false;

    const renderSettingsContent = () => {
        if (slide.type === 'poll') {
            return (
                <div className="space-y-4 rounded-lg border bg-white p-4">
                    <h3 className="flex items-center gap-2 font-medium text-slate-800">
                        <Settings className="h-4 w-4" /> Configuration
                    </h3>

                    <div className="space-y-3 border-b border-slate-100 pb-4">
                        <label className="text-sm text-slate-600">Chart Visualization</label>
                        <div className="flex gap-2">
                            <Button
                                variant={pollChartType === 'bar' ? 'default' : 'outline'}
                                disabled={disabled}
                                onClick={() => updateField('chartType', 'bar')}
                                size="sm"
                                className="flex-1"
                            >
                                Bar Chart
                            </Button>
                            <Button
                                variant={pollChartType === 'pie' ? 'default' : 'outline'}
                                disabled={disabled}
                                onClick={() => updateField('chartType', 'pie')}
                                size="sm"
                                className="flex-1"
                            >
                                Pie Chart
                            </Button>
                        </div>
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <label className="text-sm font-medium text-slate-700">Limit to One Submission</label>
                            <p className="text-xs text-slate-500">Prevent students from changing their answer.</p>
                        </div>
                        <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            disabled={disabled}
                            checked={limitSubmissions}
                            onChange={(e) => updateField('limitSubmissions', e.target.checked)}
                        />
                    </div>
                </div>
            );
        }

        if (slide.type === 'quiz') {
            return (
                <div className="space-y-4 rounded-lg border bg-white p-4">
                    <h3 className="flex items-center gap-2 font-medium text-slate-800">
                        <Settings className="h-4 w-4" /> Configuration
                    </h3>
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <label className="text-sm font-medium text-slate-700">Limit to One Submission</label>
                            <p className="text-xs text-slate-500">Prevent students from changing their answer.</p>
                        </div>
                        <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            disabled={disabled}
                            checked={limitSubmissions}
                            onChange={(e) => updateField('limitSubmissions', e.target.checked)}
                        />
                    </div>
                </div>
            );
        }

        if (slide.type === 'multiple-choice') {
            return (
                <div className="space-y-4 rounded-lg border bg-white p-4">
                    <h3 className="flex items-center gap-2 font-medium text-slate-800">
                        <Settings className="h-4 w-4" /> Configuration
                    </h3>

                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                                <label className="text-sm font-medium text-slate-700">Allow Multiple Selection</label>
                                <p className="text-xs text-slate-500">Students can select more than one option.</p>
                            </div>
                            <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                disabled={disabled}
                                checked={allowMultipleSelection}
                                onChange={(e) => updateField('allowMultipleSelection', e.target.checked)}
                            />
                        </div>

                        <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                                <label className="text-sm font-medium text-slate-700">Limit to One Submission</label>
                                <p className="text-xs text-slate-500">Prevent students from changing their answer.</p>
                            </div>
                            <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                disabled={disabled}
                                checked={limitSubmissions}
                                onChange={(e) => updateField('limitSubmissions', e.target.checked)}
                            />
                        </div>
                    </div>
                </div>
            );
        }

        return (
            <div className="rounded-lg border bg-white p-4 text-sm text-slate-500">
                <p>This slide has no additional settings.</p>
            </div>
        );
    };

    return (
        <div className="h-full flex flex-col bg-slate-50">
            <div className="p-4 border-b bg-white">
                <h2 className="font-semibold text-lg flex items-center gap-2">
                    {slide.type === 'poll' && <List className="w-5 h-5 text-blue-500" />}
                    {slide.type === 'quiz' && <Trophy className="w-5 h-5 text-yellow-500" />}
                    {slide.type === 'static' && <Type className="w-5 h-5 text-slate-500" />}
                    Edit Slide
                </h2>
                {disabled && (
                    <p className="mt-2 text-xs text-amber-700">
                        {disabledReason || 'Editing is temporarily disabled while this slide is syncing.'}
                    </p>
                )}
            </div>

            <Tabs defaultValue="content" className="flex-1 flex flex-col overflow-hidden">
                <div className="px-4 pt-2 bg-white border-b">
                    <TabsList className="w-full justify-start h-9 bg-transparent p-0">
                        <TabsTrigger value="content" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 data-[state=active]:shadow-none rounded-none px-4 pb-2">Content</TabsTrigger>
                        <TabsTrigger value="settings" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 data-[state=active]:shadow-none rounded-none px-4 pb-2">Settings</TabsTrigger>
                    </TabsList>
                </div>

                <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                    <TabsContent value="content" forceMount className="space-y-6 mt-0 data-[state=inactive]:hidden">
                        {slide.type === 'static' && (
                            <StaticSlideEditor
                                content={localContent as StaticSlideContent}
                                onChange={(next) => handleContentEditorChange(next)}
                                onBlur={() => { void flushSave(); }}
                                disabled={disabled}
                            />
                        )}

                        {slide.type === 'poll' && (
                            <PollSlideEditor
                                content={localContent as PollSlideContent}
                                onChange={(next) => handleContentEditorChange(next as SlideContentDraft)}
                                onBlur={() => { void flushSave(); }}
                                disabled={disabled}
                            />
                        )}

                        {slide.type === 'quiz' && (
                            <QuizSlideEditor
                                content={localContent as QuizSlideContent}
                                onChange={(next) => handleContentEditorChange(next as SlideContentDraft)}
                                onBlur={() => { void flushSave(); }}
                                disabled={disabled}
                            />
                        )}

                        {slide.type === 'multiple-choice' && (
                            <MultipleChoiceSlideEditor
                                content={localContent as MultipleChoiceSlideContent}
                                onChange={(next) => handleContentEditorChange(next as SlideContentDraft)}
                                onBlur={() => { void flushSave(); }}
                                disabled={disabled}
                            />
                        )}

                        {(slide.type === 'poll' || slide.type === 'multiple-choice' || slide.type === 'quiz') && (
                            <div className="space-y-4">
                                <div className="flex justify-between items-center">
                                    <label className="text-sm font-medium text-slate-700">Answer Options</label>
                                    <span className="text-xs text-slate-400">{(localContent.options || []).length} options</span>
                                </div>

                                <DragDropContext onDragEnd={onDragEnd}>
                                    <Droppable droppableId="options">
                                        {(provided) => (
                                            <div {...provided.droppableProps} ref={provided.innerRef} className="space-y-2">
                                                {(localContent.options || []).map((option: SlideOption, index: number) => (
                                                    <Draggable key={option.id} draggableId={option.id} index={index} isDragDisabled={disabled}>
                                                        {(provided, snapshot) => (
                                                            <div
                                                                ref={provided.innerRef}
                                                                {...provided.draggableProps}
                                                                className={`flex items-center gap-2 bg-white p-2 rounded-lg border group transition-all ${snapshot.isDragging ? 'shadow-lg ring-2 ring-blue-500 z-50' : 'hover:border-blue-300'}`}
                                                            >
                                                                <div {...provided.dragHandleProps} className="text-slate-300 cursor-grab hover:text-slate-600 p-1">
                                                                    <GripVertical className="w-4 h-4" />
                                                                </div>
                                                                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${option.isCorrect ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                                                                    {String.fromCharCode(65 + index)}
                                                                </div>
                                                                <Input
                                                                    defaultValue={option.text}
                                                                    ref={(node) => {
                                                                        optionInputRefs.current[option.id] = node;
                                                                    }}
                                                                    disabled={disabled}
                                                                    onChange={scheduleOptionCapture}
                                                                    onBlur={flushOptionCapture}
                                                                    className="flex-1 border-0 focus-visible:ring-0 px-2 h-8"
                                                                    placeholder={`Option ${index + 1}`}
                                                                />
                                                                {slide.type === 'quiz' && (
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="sm"
                                                                        disabled={disabled}
                                                                        onClick={() => handleMarkOptionCorrect(option.id)}
                                                                        className={`h-7 px-2 text-xs ${option.isCorrect ? "bg-green-100 text-green-700 hover:bg-green-200" : "text-slate-400 hover:text-slate-600"}`}
                                                                    >
                                                                        {option.isCorrect ? "Correct Answer" : "Mark Correct"}
                                                                    </Button>
                                                                )}
                                                                <Button variant="ghost" size="icon" disabled={disabled} onClick={() => handleRemoveOption(option.id)} className="h-7 w-7 text-slate-300 hover:text-red-500 hover:bg-red-50">
                                                                    <Trash2 className="w-4 h-4" />
                                                                </Button>
                                                            </div>
                                                        )}
                                                    </Draggable>
                                                ))}
                                                {provided.placeholder}
                                            </div>
                                        )}
                                    </Droppable>
                                </DragDropContext>

                                <Button variant="outline" disabled={disabled} onClick={handleAddOption} className="w-full border-dashed text-slate-500 hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50">
                                    <Plus className="w-4 h-4 mr-2" /> Add Option
                                </Button>
                            </div>
                        )}
                    </TabsContent>

                    <TabsContent value="settings" forceMount className="space-y-6 mt-0 data-[state=inactive]:hidden">
                        {renderSettingsContent()}
                    </TabsContent>
                </div>
            </Tabs>

        </div>
    );
}
