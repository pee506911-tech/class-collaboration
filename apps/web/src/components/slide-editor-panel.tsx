import { Slide } from 'shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, GripVertical, Trash2, Type, List, Trophy } from 'lucide-react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useState, useEffect, useRef, useCallback } from 'react';
import { addOption, removeOption, reorderOption, updateOptionText, markOptionCorrect } from '@/lib/slide-options';
import { StaticSlideEditor } from '@/components/slide-editors/static-slide-editor';
import { PollSlideEditor } from '@/components/slide-editors/poll-slide-editor';
import { QuizSlideEditor } from '@/components/slide-editors/quiz-slide-editor';
import { MultipleChoiceSlideEditor } from '@/components/slide-editors/multiple-choice-slide-editor';

export type SlideEditorSyncStatus = { dirty: boolean; saving: boolean; lastError?: string | null };

interface SlideEditorPanelProps {
    slide: Slide;
    onUpdate: (content: any) => Promise<void>;
    onSave: () => void;
    onSyncStatusChange?: (status: SlideEditorSyncStatus) => void;
    disabled?: boolean;
    disabledReason?: string;
}

export function SlideEditorPanel({ slide, onUpdate, onSave, onSyncStatusChange, disabled = false, disabledReason }: SlideEditorPanelProps) {
    const [localContent, setLocalContent] = useState<any>(slide.content);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [lastError, setLastError] = useState<string | null>(null);

    const isMountedRef = useRef(true);
    const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

    const latestContentRef = useRef<any>(slide.content);
    const lastSyncedVersionRef = useRef(slide.version);
    const pendingFlushRef = useRef(false);
    const inFlightRef = useRef(false);

    const editSeqRef = useRef(0);
    const ackedSeqRef = useRef(0);

    const dirtyRef = useRef(false);
    const savingRef = useRef(false);
    const lastErrorRef = useRef<string | null>(null);

    const onUpdateRef = useRef(onUpdate);
    useEffect(() => {
        onUpdateRef.current = onUpdate;
    }, [onUpdate]);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const setDirtyState = useCallback((next: boolean) => {
        dirtyRef.current = next;
        if (isMountedRef.current) setDirty(next);
    }, []);

    const setSavingState = useCallback((next: boolean) => {
        savingRef.current = next;
        if (isMountedRef.current) setSaving(next);
    }, []);

    const setLastErrorState = useCallback((next: string | null) => {
        lastErrorRef.current = next;
        if (isMountedRef.current) setLastError(next);
    }, []);

    const recomputeDirty = useCallback(() => {
        setDirtyState(editSeqRef.current !== ackedSeqRef.current);
    }, [setDirtyState]);

    const pump = useCallback(async () => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setSavingState(true);

        try {
            while (pendingFlushRef.current) {
                pendingFlushRef.current = false;

                const seqToSave = editSeqRef.current;
                const contentToSave = latestContentRef.current;

                try {
                    await onUpdateRef.current(contentToSave);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : 'Failed to save';
                    setLastErrorState(message || 'Failed to save');
                    recomputeDirty();
                    return;
                }

                ackedSeqRef.current = Math.max(ackedSeqRef.current, seqToSave);
                recomputeDirty();
            }
        } finally {
            setSavingState(false);
            inFlightRef.current = false;
        }
    }, [recomputeDirty, setLastErrorState, setSavingState]);

    const flushSave = useCallback(async (contentToSave = latestContentRef.current, showToast = false) => {
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        latestContentRef.current = contentToSave;
        pendingFlushRef.current = true;
        await pump();

        if (showToast && !dirtyRef.current && !lastErrorRef.current) {
            onSave();
        }
    }, [onSave, pump]);

    const scheduleDebouncedSave = useCallback(() => {
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        debounceTimerRef.current = setTimeout(() => {
            pendingFlushRef.current = true;
            void pump();
        }, 500);
    }, [pump]);

    const updateContent = useCallback((updater: (currentContent: any) => any, immediate = false) => {
        const nextContent = updater(latestContentRef.current);
        setLocalContent(nextContent);
        latestContentRef.current = nextContent;

        if (immediate) {
            editSeqRef.current += 1;
            setLastErrorState(null);
            recomputeDirty();
            void flushSave(nextContent);
            return;
        }

        editSeqRef.current += 1;
        setLastErrorState(null);
        recomputeDirty();
        scheduleDebouncedSave();
    }, [flushSave, recomputeDirty, scheduleDebouncedSave, setLastErrorState]);

    // Reset local state only when switching to a different slide.
    useEffect(() => {
        setLocalContent(slide.content);
        latestContentRef.current = slide.content;
        lastSyncedVersionRef.current = slide.version;
        pendingFlushRef.current = false;
        editSeqRef.current = 0;
        ackedSeqRef.current = 0;
        setDirtyState(false);
        setSavingState(false);
        setLastErrorState(null);

        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }

        return () => {
            // Clear any pending debounce timer to prevent saves after unmount
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
                debounceTimerRef.current = null;
            }
            // Do NOT flush here — if the slide was deleted, a flush would
            // attempt to save to a non-existent slide. The parent component
            // is responsible for flushing before structural changes.
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slide.id]);

    // Rebase to the latest server snapshot only when there is no local draft in flight.
    useEffect(() => {
        if (slide.version === lastSyncedVersionRef.current) {
            return;
        }

        lastSyncedVersionRef.current = slide.version;

        if (dirtyRef.current || savingRef.current || inFlightRef.current || pendingFlushRef.current) {
            return;
        }

        setLocalContent(slide.content);
        latestContentRef.current = slide.content;
        setLastErrorState(null);
    }, [slide.content, slide.version, setLastErrorState]);

    useEffect(() => {
        onSyncStatusChange?.({ dirty, saving, lastError });
    }, [dirty, saving, lastError, onSyncStatusChange]);

    const updateField = (field: string, value: any, immediate = false) => {
        updateContent((currentContent) => ({ ...currentContent, [field]: value }), immediate);
    };

    const handleOptionChange = (id: string, text: string) => {
        const newOptions = updateOptionText(localContent.options || [], id, text);
        updateField('options', newOptions);
    };

    const handleAddOption = () => {
        const newOptions = addOption(localContent.options || [], slide.type as any);
        updateField('options', newOptions);
    };

    const handleRemoveOption = (id: string) => {
        const newOptions = removeOption(localContent.options || [], id);
        updateField('options', newOptions);
    };

    const handleMarkOptionCorrect = (id: string) => {
        const newOptions = markOptionCorrect(localContent.options || [], id);
        updateField('options', newOptions);
    };

    const onDragEnd = (result: DropResult) => {
        if (!result.destination) return;
        const newOptions = reorderOption(
            localContent.options || [],
            result.source.index,
            result.destination.index,
        );
        updateField('options', newOptions);
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
                    <TabsContent value="content" className="space-y-6 mt-0">
                        {slide.type === 'static' && (
                            <StaticSlideEditor
                                content={localContent}
                                onChange={(next) => {
                                    setLocalContent(next);
                                    latestContentRef.current = next;
                                    editSeqRef.current += 1;
                                    setLastErrorState(null);
                                    recomputeDirty();
                                    scheduleDebouncedSave();
                                }}
                                onBlur={() => { void flushSave(); }}
                                disabled={disabled}
                            />
                        )}

                        {slide.type === 'poll' && (
                            <PollSlideEditor
                                content={localContent}
                                onChange={(next) => {
                                    setLocalContent(next);
                                    latestContentRef.current = next;
                                    editSeqRef.current += 1;
                                    setLastErrorState(null);
                                    recomputeDirty();
                                    scheduleDebouncedSave();
                                }}
                                disabled={disabled}
                            />
                        )}

                        {slide.type === 'quiz' && (
                            <QuizSlideEditor
                                content={localContent}
                                onChange={(next) => {
                                    setLocalContent(next);
                                    latestContentRef.current = next;
                                    editSeqRef.current += 1;
                                    setLastErrorState(null);
                                    recomputeDirty();
                                    scheduleDebouncedSave();
                                }}
                                disabled={disabled}
                            />
                        )}

                        {slide.type === 'multiple-choice' && (
                            <MultipleChoiceSlideEditor
                                content={localContent}
                                onChange={(next) => {
                                    setLocalContent(next);
                                    latestContentRef.current = next;
                                    editSeqRef.current += 1;
                                    setLastErrorState(null);
                                    recomputeDirty();
                                    scheduleDebouncedSave();
                                }}
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
                                                {(localContent.options || []).map((option: any, index: number) => (
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
                                                                    value={option.text}
                                                                    disabled={disabled}
                                                                    onChange={(e) => handleOptionChange(option.id, e.target.value)}
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

                    <TabsContent value="settings" className="space-y-6 mt-0">
                        <div className="text-sm text-slate-500 p-4">
                            <p>Settings for this slide type are included in the Content tab.</p>
                        </div>
                    </TabsContent>
                </div>
            </Tabs>

            <div className="p-4 border-t bg-white">
                {lastError && (
                    <p className="mb-2 text-xs text-rose-600">
                        Last save failed: {lastError}
                    </p>
                )}
                <Button disabled={disabled} onClick={() => { void flushSave(latestContentRef.current, true); }} className="w-full bg-slate-900 hover:bg-slate-800">
                    {disabled ? 'Waiting For Confirmation' : saving ? 'Saving…' : dirty ? 'Save Changes' : 'All Changes Saved'}
                </Button>
            </div>
        </div>
    );
}
