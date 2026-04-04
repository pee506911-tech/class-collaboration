import type { Slide } from 'shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, GripVertical, Trash2, Type, List, Trophy, CheckCircle2, AlertCircle, LoaderCircle } from 'lucide-react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useState, useEffect, useRef, useCallback } from 'react';
import { addOption, removeOption, reorderOption, updateOptionText, markOptionCorrect } from '@/lib/slide-options';
import { StaticSlideEditor } from '@/components/slide-editors/static-slide-editor';
import { PollSlideEditor } from '@/components/slide-editors/poll-slide-editor';
import { QuizSlideEditor } from '@/components/slide-editors/quiz-slide-editor';
import { MultipleChoiceSlideEditor } from '@/components/slide-editors/multiple-choice-slide-editor';

export type SlideEditorSyncStatus = { dirty: boolean; saving: boolean; lastError?: string | null };

type SaveMode = 'auto' | 'manual';
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
type AutoSaveFeedback = {
    phase: 'idle' | 'saving' | 'success' | 'error';
    message: string | null;
};

interface SlideEditorPanelProps {
    slide: Slide;
    onUpdate: (content: SlideContentDraft) => Promise<void>;
    onSave: () => void;
    onSyncStatusChange?: (status: SlideEditorSyncStatus) => void;
    disabled?: boolean;
    disabledReason?: string;
}

export function SlideEditorPanel({ slide, onUpdate, onSave, onSyncStatusChange, disabled = false, disabledReason }: SlideEditorPanelProps) {
    const [localContent, setLocalContent] = useState<SlideContentDraft>(slide.content as SlideContentDraft);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [lastError, setLastError] = useState<string | null>(null);
    const [autoSaveFeedback, setAutoSaveFeedback] = useState<AutoSaveFeedback>({ phase: 'idle', message: null });
    const [consecutiveFailures, setConsecutiveFailures] = useState(0);

    const isMountedRef = useRef(true);
    const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
    const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

    const latestContentRef = useRef<SlideContentDraft>(slide.content as SlideContentDraft);
    const lastSyncedVersionRef = useRef(slide.version);
    const pendingFlushRef = useRef(false);
    const pendingSaveModeRef = useRef<SaveMode>('auto');
    const inFlightRef = useRef(false);

    const editSeqRef = useRef(0);
    const ackedSeqRef = useRef(0);

    const dirtyRef = useRef(false);
    const savingRef = useRef(false);
    const lastErrorRef = useRef<string | null>(null);
    const consecutiveFailuresRef = useRef(0);

    const onUpdateRef = useRef(onUpdate);
    useEffect(() => {
        onUpdateRef.current = onUpdate;
    }, [onUpdate]);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            if (autoSaveTimerRef.current) {
                clearTimeout(autoSaveTimerRef.current);
                autoSaveTimerRef.current = null;
            }
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

    const setConsecutiveFailuresState = useCallback((next: number) => {
        consecutiveFailuresRef.current = next;
        if (isMountedRef.current) setConsecutiveFailures(next);
    }, []);

    const clearAutoSaveTimer = useCallback(() => {
        if (autoSaveTimerRef.current) {
            clearTimeout(autoSaveTimerRef.current);
            autoSaveTimerRef.current = null;
        }
    }, []);

    const showAutoSaveFeedback = useCallback((phase: AutoSaveFeedback['phase'], message: string | null = null, autoHideMs?: number) => {
        clearAutoSaveTimer();
        if (isMountedRef.current) {
            setAutoSaveFeedback({ phase, message });
        }

        if (typeof autoHideMs === 'number') {
            autoSaveTimerRef.current = setTimeout(() => {
                if (isMountedRef.current) {
                    setAutoSaveFeedback({ phase: 'idle', message: null });
                }
                autoSaveTimerRef.current = null;
            }, autoHideMs);
        }
    }, [clearAutoSaveTimer]);

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
                const saveMode = pendingSaveModeRef.current;

                if (saveMode === 'auto') {
                    showAutoSaveFeedback('saving');
                }

                try {
                    await onUpdateRef.current(contentToSave);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : 'Failed to save';
                    setLastErrorState(message || 'Failed to save');
                    setConsecutiveFailuresState(consecutiveFailuresRef.current + 1);
                    if (saveMode === 'auto') {
                        showAutoSaveFeedback('error', message || 'Failed to save');
                    }
                    recomputeDirty();
                    return;
                }

                ackedSeqRef.current = Math.max(ackedSeqRef.current, seqToSave);
                setConsecutiveFailuresState(0);
                if (saveMode === 'auto') {
                    showAutoSaveFeedback('success', 'Draft saved', 2000);
                } else {
                    showAutoSaveFeedback('idle');
                }
                recomputeDirty();
            }
        } finally {
            setSavingState(false);
            inFlightRef.current = false;
        }
    }, [recomputeDirty, setConsecutiveFailuresState, setLastErrorState, setSavingState, showAutoSaveFeedback]);

    const flushSave = useCallback(async (
        contentToSave = latestContentRef.current,
        options: { showToast?: boolean; mode?: SaveMode } = {},
    ) => {
        const { showToast = false, mode = 'manual' } = options;
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        latestContentRef.current = contentToSave;
        setLastErrorState(null);
        if (mode === 'manual') {
            showAutoSaveFeedback('idle');
        }
        pendingFlushRef.current = true;
        pendingSaveModeRef.current = mode;
        await pump();

        if (showToast && !dirtyRef.current && !lastErrorRef.current) {
            onSave();
        }
    }, [onSave, pump, setLastErrorState, showAutoSaveFeedback]);

    const scheduleDebouncedSave = useCallback(() => {
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        debounceTimerRef.current = setTimeout(() => {
            pendingFlushRef.current = true;
            pendingSaveModeRef.current = 'auto';
            void pump();
        }, 500);
    }, [pump]);

    const stageDraft = useCallback((nextContent: SlideContentDraft) => {
        setLocalContent(nextContent);
        latestContentRef.current = nextContent;
        editSeqRef.current += 1;
        setLastErrorState(null);
        showAutoSaveFeedback('idle');
        recomputeDirty();
    }, [recomputeDirty, setLastErrorState, showAutoSaveFeedback]);

    const updateContent = useCallback((updater: (currentContent: SlideContentDraft) => SlideContentDraft, immediate = false) => {
        const nextContent = updater(latestContentRef.current);
        stageDraft(nextContent);

        if (immediate) {
            void flushSave(nextContent, { mode: 'auto' });
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
        editSeqRef.current = 0;
        ackedSeqRef.current = 0;
        setDirtyState(false);
        setSavingState(false);
        setLastErrorState(null);
        setConsecutiveFailuresState(0);
        showAutoSaveFeedback('idle');

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
            clearAutoSaveTimer();
            // Do NOT flush here — if the slide was deleted, a flush would
            // attempt to save to a non-existent slide. The parent component
            // is responsible for flushing before structural changes.
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clearAutoSaveTimer, setConsecutiveFailuresState, setDirtyState, setLastErrorState, setSavingState, showAutoSaveFeedback, slide.id]);

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

    const updateField = <K extends keyof SlideContentDraft>(field: K, value: SlideContentDraft[K], immediate = false) => {
        updateContent((currentContent) => ({ ...currentContent, [field]: value }), immediate);
    };

    const handleOptionChange = (id: string, text: string) => {
        const newOptions = updateOptionText(localContent.options || [], id, text);
        updateField('options', newOptions);
    };

    const handleAddOption = () => {
        const optionSlideType = slide.type === 'quiz' ? 'quiz' : slide.type === 'multiple-choice' ? 'multiple-choice' : 'poll';
        const newOptions = addOption(localContent.options || [], optionSlideType);
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

    const handleRetrySave = () => {
        void flushSave(latestContentRef.current, { mode: 'manual' });
    };

    const handleDismissError = () => {
        setLastErrorState(null);
        if (autoSaveFeedback.phase === 'error') {
            showAutoSaveFeedback('idle');
        }
    };

    const handleCopyContent = async () => {
        await navigator.clipboard.writeText(JSON.stringify(latestContentRef.current, null, 2));
    };

    const saveIndicator = lastError
        ? {
            label: 'Save failed',
            tone: 'text-rose-700',
            icon: <AlertCircle className="h-3.5 w-3.5" />,
            dotClassName: 'bg-rose-500',
            title: lastError,
        }
        : saving
            ? {
                label: 'Saving…',
                tone: 'text-blue-700',
                icon: <LoaderCircle className="h-3.5 w-3.5 animate-spin" />,
                dotClassName: '',
                title: undefined,
            }
            : dirty
                ? {
                    label: 'Unsaved changes',
                    tone: 'text-amber-700',
                    icon: null,
                    dotClassName: 'bg-amber-500',
                    title: undefined,
                }
                : {
                    label: 'Saved',
                    tone: 'text-slate-500',
                    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
                    dotClassName: '',
                    title: undefined,
                };

    return (
        <div className="h-full flex flex-col bg-slate-50">
            <div aria-live="polite" className="shrink-0">
                <div className={`h-0.5 w-full transition-all duration-300 ${autoSaveFeedback.phase === 'idle' ? 'opacity-0' : 'opacity-100'} ${autoSaveFeedback.phase === 'saving' ? 'bg-blue-500 animate-pulse' : autoSaveFeedback.phase === 'success' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                {autoSaveFeedback.phase === 'error' && autoSaveFeedback.message && (
                    <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">
                        Auto-save paused. {autoSaveFeedback.message}
                    </div>
                )}
            </div>

            <div className="p-4 border-b bg-white">
                <div className="flex items-start justify-between gap-3">
                    <h2 className="font-semibold text-lg flex items-center gap-2">
                        {slide.type === 'poll' && <List className="w-5 h-5 text-blue-500" />}
                        {slide.type === 'quiz' && <Trophy className="w-5 h-5 text-yellow-500" />}
                        {slide.type === 'static' && <Type className="w-5 h-5 text-slate-500" />}
                        Edit Slide
                    </h2>
                    <div
                        className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium ${lastError ? 'border-rose-200 bg-rose-50' : saving ? 'border-blue-200 bg-blue-50' : dirty ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50'} ${saveIndicator.tone}`}
                        title={saveIndicator.title}
                        tabIndex={lastError ? 0 : -1}
                        aria-label={lastError ? `Save failed: ${lastError}` : saveIndicator.label}
                    >
                        {saveIndicator.icon ?? <span className={`h-2 w-2 rounded-full ${saveIndicator.dotClassName}`} />}
                        <span>{saveIndicator.label}</span>
                    </div>
                </div>
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
                                onChange={handleContentEditorChange}
                                onBlur={() => { void flushSave(undefined, { mode: 'auto' }); }}
                                disabled={disabled}
                            />
                        )}

                        {slide.type === 'poll' && (
                            <PollSlideEditor
                                content={localContent}
                                onChange={handleContentEditorChange}
                                disabled={disabled}
                            />
                        )}

                        {slide.type === 'quiz' && (
                            <QuizSlideEditor
                                content={localContent}
                                onChange={handleContentEditorChange}
                                disabled={disabled}
                            />
                        )}

                        {slide.type === 'multiple-choice' && (
                            <MultipleChoiceSlideEditor
                                content={localContent}
                                onChange={handleContentEditorChange}
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
                    <div className={`mb-3 rounded-xl border px-3 py-3 ${consecutiveFailures >= 3 ? 'border-rose-300 bg-rose-50' : 'border-amber-200 bg-amber-50'}`}>
                        <div className="flex items-start gap-2">
                            <AlertCircle className={`mt-0.5 h-4 w-4 shrink-0 ${consecutiveFailures >= 3 ? 'text-rose-600' : 'text-amber-600'}`} />
                            <div className="min-w-0">
                                <p className={`text-sm font-semibold ${consecutiveFailures >= 3 ? 'text-rose-900' : 'text-amber-900'}`}>
                                    {consecutiveFailures >= 3 ? 'Unable to save right now.' : 'Save failed.'}
                                </p>
                                <p className={`mt-1 text-xs ${consecutiveFailures >= 3 ? 'text-rose-700' : 'text-amber-800'}`}>
                                    {consecutiveFailures >= 3
                                        ? 'Check your connection and try again. Your latest draft is still in the editor.'
                                        : lastError}
                                </p>
                            </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                            <Button size="sm" onClick={handleRetrySave} disabled={saving || disabled} className="bg-slate-900 hover:bg-slate-800">
                                Retry
                            </Button>
                            <Button size="sm" variant="outline" onClick={handleDismissError}>
                                Dismiss
                            </Button>
                            {consecutiveFailures >= 3 && (
                                <Button size="sm" variant="outline" onClick={() => { void handleCopyContent(); }}>
                                    Copy Content
                                </Button>
                            )}
                        </div>
                    </div>
                )}
                <Button
                    disabled={disabled || saving || !dirty}
                    onClick={() => { void flushSave(latestContentRef.current, { showToast: true, mode: 'manual' }); }}
                    variant={dirty ? 'default' : 'outline'}
                    className={`w-full ${dirty ? 'bg-slate-900 hover:bg-slate-800' : 'border-slate-200 bg-slate-50 text-slate-400 hover:bg-slate-50 hover:text-slate-400'}`}
                >
                    {saving ? (
                        <>
                            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                            Saving…
                        </>
                    ) : dirty ? 'Save Now' : 'All Saved'}
                </Button>
            </div>
        </div>
    );
}
