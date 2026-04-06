'use client';

export const runtime = 'edge';

import { Dispatch, SetStateAction, startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Slide, Session } from 'shared';
import { getSlides, getSession, updateSession, updateSlideVisibility, goLiveSession, stopSession, ApiRequestError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Plus, Layout, BarChart2, Play, X, CheckSquare, Smartphone, Share2, ArrowLeft, Settings, Edit2, MessageSquare, Users, Eye, Square, Copy, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { WebSocketProvider, useWebSocket } from '@/lib/websocket';
import { SlideRenderer } from '@/components/slide-renderer';
import { SlideEditorPanel } from '@/components/slide-editor-panel';
import { QAManager } from '@/components/qa-manager';
import { SlideTypeSelector } from '@/components/slide-type-selector';
import { SessionDashboard } from '@/components/session-dashboard';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import type { DraggableProvided } from '@hello-pangea/dnd';
import { toast } from 'sonner';
import { Breadcrumb } from '@/components/ui/breadcrumb';
import { safeLocalStorageGet } from '@/lib/storage';
import { formatRequestId, mapHttpErrorToUiMessage } from '@/lib/http-error-ui';
import { SlideListItem } from '@/components/slide-list-item';
import { reorderSlidesWithRollback } from '@/lib/slide-reorder';
import { getNextPreviewSlideId } from '@/lib/slide-preview-selection';
import {
    createSlideEditCommitter,
    commitCreateSlide,
    commitDeleteSlide,
    commitReorderSlides,
    normalizeSlides,
    reconcileCreatedSlide,
} from '@/lib/editor-slide-sync';

function getDefaultSlideContent(type: Slide['type']) {
    if (type === 'static') return { title: 'New Slide', body: 'Content here' };
    if (type === 'poll') return { question: 'New Poll', options: [{ id: '1', text: 'Option 1' }, { id: '2', text: 'Option 2' }] };
    if (type === 'multiple-choice') return { question: 'New Question', options: [{ id: '1', text: 'Option 1' }, { id: '2', text: 'Option 2' }], allowMultipleSelection: false };
    if (type === 'qa') return { title: 'Q&A Session' };
    if (type === 'quiz') {
        return {
            question: 'New Quiz Question',
            options: [{ id: '1', text: 'Option 1', isCorrect: true }, { id: '2', text: 'Option 2', isCorrect: false }],
            points: 1000,
            timerDuration: 30,
        };
    }

    return { title: 'Leaderboard' };
}

function restoreSlideAtOrder(slides: Slide[], restoredSlide: Slide) {
    const nextSlides = [...slides];
    const insertAt = Math.min(Math.max(restoredSlide.orderIndex, 0), nextSlides.length);
    nextSlides.splice(insertAt, 0, restoredSlide);
    return normalizeSlides(nextSlides);
}

function EditorContent({
    baseSlides,
    setBaseSlides,
    loadSlides,
    session,
    loadSession,
}: {
    baseSlides: Slide[];
    setBaseSlides: Dispatch<SetStateAction<Slide[]>>;
    loadSlides: () => Promise<void>;
    session: Session | null;
    loadSession: () => void;
}) {
    const { sendMessage, state, activeParticipants, updateState, initialStateLoaded, lastSlideUpdate } = useWebSocket();
    const params = useParams();
    const id = params?.id as string;
    const [showTypeSelector, setShowTypeSelector] = useState(false);
    const [previewRole, setPreviewRole] = useState<'student' | 'projector'>('student');
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [showQAManager, setShowQAManager] = useState(false);
    const [showDashboard, setShowDashboard] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    const [showShareDialog, setShowShareDialog] = useState(false);
    const [isReordering, setIsReordering] = useState(false);
    const [isTogglingVisibility, setIsTogglingVisibility] = useState(false);
    const [isSavingSettings, setIsSavingSettings] = useState(false);

    const baseSlidesRef = useRef(baseSlides);

    useEffect(() => {
        baseSlidesRef.current = baseSlides;
    }, [baseSlides]);

    // Refetch slides when server confirms changes via WS broadcast
    useEffect(() => {
        if (lastSlideUpdate > 0) {
            void loadSlides();
        }
    }, [lastSlideUpdate, loadSlides]);

    const setBaseSlidesSynced = useCallback((updater: SetStateAction<Slide[]>) => {
        if (typeof updater === 'function') {
            const nextSlides = (updater as (prevState: Slide[]) => Slide[])(baseSlidesRef.current);
            baseSlidesRef.current = nextSlides;
            setBaseSlides(nextSlides);
            return;
        }

        baseSlidesRef.current = updater;
        setBaseSlides(updater);
    }, [setBaseSlides]);

    const handleSlideSaveSuccess = useCallback((savedSlide: Slide, request: { slideId: string; content: Slide['content'] }) => {
        setBaseSlidesSynced((prev) => prev.map((slide) =>
            slide.id === request.slideId
                ? {
                    ...slide,
                    ...savedSlide,
                    orderIndex: slide.orderIndex,
                    isHidden: slide.isHidden,
                }
                : slide,
        ));
    }, [setBaseSlidesSynced]);

    const handleSlideSaveError = useCallback((error: unknown) => {
        console.error('Failed to save slide draft', error);
        toast.error('Failed to save slide');
        void loadSlides();
    }, [loadSlides]);

    // Slide edit committer — coalesces rapid edits on the same slide
    const slideEditCommitterRef = useRef(createSlideEditCommitter(id, {
        onSuccess: handleSlideSaveSuccess,
        onError: handleSlideSaveError,
    }));
    useEffect(() => {
        slideEditCommitterRef.current = createSlideEditCommitter(id, {
            onSuccess: handleSlideSaveSuccess,
            onError: handleSlideSaveError,
        });
    }, [handleSlideSaveError, handleSlideSaveSuccess, id]);

    // Slides are the base slides directly (no optimistic wrapper)
    const slides = baseSlides;

    // SEPARATE PREVIEW STATE: This is for editor preview only, independent of student view
    const [previewSlideId, setPreviewSlideId] = useState<string | null>(null);
    const hasManualPreviewSelectionRef = useRef(false);

    useEffect(() => {
        if (session) setEditTitle(session.title);
    }, [session]);

    useEffect(() => {
        if (previewSlideId) {
            return;
        }

        if (state?.currentSlideId && slides.some((slide) => slide.id === state.currentSlideId)) {
            setPreviewSlideId(state.currentSlideId);
            return;
        }

        if (slides[0]) {
            setPreviewSlideId(slides[0].id);
        }
    }, [previewSlideId, slides, state?.currentSlideId]);

    // When slides change (from server refetch), ensure previewSlideId is still valid
    useEffect(() => {
        setPreviewSlideId((currentPreviewSlideId) => {
            if (!currentPreviewSlideId) {
                return currentPreviewSlideId;
            }

            if (slides.some((slide) => slide.id === currentPreviewSlideId)) {
                return currentPreviewSlideId;
            }

            // Preview slide was deleted or replaced — fall back to live slide or first slide
            const liveSlideId = state?.currentSlideId ?? null;
            if (liveSlideId && slides.some((slide) => slide.id === liveSlideId)) {
                return liveSlideId;
            }

            return hasManualPreviewSelectionRef.current ? currentPreviewSlideId : (slides[0]?.id ?? null);
        });
    }, [slides, state?.currentSlideId]);

    const handleSaveSettings = async () => {
        if (!session) return;
        setIsSavingSettings(true);
        try {
            await updateSession(session.id, editTitle, session.allowQuestions, session.requireName);
            loadSession();
            setIsSettingsOpen(false);
            toast.success('Settings saved');
        } catch (e) {
            toast.error('Failed to save settings');
        } finally {
            setIsSavingSettings(false);
        }
    };

    // Keyboard Shortcuts (Editor Mode - No Navigation Control)
    // Navigation is controlled ONLY by Mobile Clicker
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if typing in an input or textarea
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            // NOTE: Arrow key navigation REMOVED - use Mobile Clicker for slide navigation
            if (e.key.toLowerCase() === 'b') {
                e.preventDefault();
                // Toggle blackout
                if (state) {
                    void sendMessage('STATE_UPDATE', { isBlackout: !state.isBlackout });
                    toast.info(state.isBlackout ? 'Blackout Disabled' : 'Blackout Enabled');
                }
            } else if (e.key === ' ' || e.key.toLowerCase() === 'r') {
                e.preventDefault();
                if (state) {
                    void sendMessage('STATE_UPDATE', { showResults: !state.showResults });
                    toast.info(state.showResults ? 'Results Hidden' : 'Results Visible');
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [state]); // Re-bind when state/slides change to ensure fresh closures if needed

    function handleAddSlide(type: string) {
        const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const newSlide: Slide = {
            id: tempId,
            sessionId: id,
            type: type as Slide['type'],
            content: getDefaultSlideContent(type as Slide['type']),
            orderIndex: slides.length,
            isHidden: false,
            version: 0,
        };

        // Optimistic: add immediately to local state
        setBaseSlidesSynced((prev) => [...prev, newSlide]);

        hasManualPreviewSelectionRef.current = true;
        startTransition(() => {
            setPreviewSlideId(tempId);
            setShowTypeSelector(false);
        });

        // Fire-and-forget: server will broadcast SLIDES_UPDATE which triggers refetch
        void commitCreateSlide(id, type as Slide['type'], newSlide.content)
            .then((serverSlide) => {
                let contentNeedingSync: Slide['content'] | null = null;
                setBaseSlidesSynced((prev) => normalizeSlides(prev.map((slide) => {
                    if (slide.id !== tempId) {
                        return slide;
                    }

                    const resolved = reconcileCreatedSlide({
                        localSlide: slide,
                        serverSlide,
                    });
                    contentNeedingSync = resolved.contentNeedingSync;
                    return resolved.slide;
                })));
                setPreviewSlideId((currentPreviewSlideId) => currentPreviewSlideId === tempId ? serverSlide.id : currentPreviewSlideId);
                if (contentNeedingSync) {
                    slideEditCommitterRef.current.schedule({
                        slideId: serverSlide.id,
                        content: contentNeedingSync,
                    });
                }
            })
            .catch((error) => {
                console.error('Failed to create slide', error);
                toast.error('Failed to create slide');
                setBaseSlidesSynced((prev) => prev.filter((slide) => slide.id !== tempId));
                setPreviewSlideId((currentPreviewSlideId) => {
                    if (currentPreviewSlideId !== tempId) {
                        return currentPreviewSlideId;
                    }

                    const liveSlideId = state?.currentSlideId ?? null;
                    if (liveSlideId && slides.some((slide) => slide.id === liveSlideId)) {
                        return liveSlideId;
                    }

                    return slides[0]?.id ?? null;
                });
                void loadSlides();
            });
    }

    // NAVIGATION REMOVED: Use Mobile Clicker for slide navigation
    // This editor is for content editing only, not presentation control

    // PREVIEW NAVIGATION: For editor preview only (does NOT affect students)
    const previewIndex = slides.findIndex(s => s.id === previewSlideId);
    const previewSlide = previewIndex >= 0 ? slides[previewIndex] : null;
    const isPreviewLive = Boolean(state?.currentSlideId && previewSlideId === state.currentSlideId);

    const handlePreviewNext = useCallback(() => {
        if (previewIndex < slides.length - 1) {
            hasManualPreviewSelectionRef.current = true;
            startTransition(() => {
                setPreviewSlideId(slides[previewIndex + 1].id);
            });
        }
    }, [previewIndex, slides]);

    const handlePreviewPrev = useCallback(() => {
        if (previewIndex > 0) {
            hasManualPreviewSelectionRef.current = true;
            startTransition(() => {
                setPreviewSlideId(slides[previewIndex - 1].id);
            });
        }
    }, [previewIndex, slides]);

    const handleSelectSlide = useCallback((slideId: string) => {
        hasManualPreviewSelectionRef.current = true;
        startTransition(() => {
            setPreviewSlideId(slideId);
        });
    }, []);

    async function handleUpdateSlide(slideId: string, content: Slide['content']) {
        // Optimistic: update local state immediately
        setBaseSlidesSynced((prev) =>
            prev.map((s) => (s.id === slideId ? { ...s, content } : s)),
        );

        if (slideId.startsWith('temp-')) {
            return { status: 'queued' as const };
        }

        // Commit via coalescing committer — rapid edits only send latest
        slideEditCommitterRef.current.schedule({ slideId, content });

        return { status: 'saved' as const };
    }

    async function handleDeleteSlide(slideId: string) {
        const slide = slides.find((entry) => entry.id === slideId);
        if (!slide) return;
        if (!confirm('Are you sure you want to delete this slide?')) return;

        const slideIds = slides.map((s) => s.id);
        const nextPreviewSlideId = getNextPreviewSlideId(slideIds, slideId, previewSlideId);

        // Optimistic: remove from local state immediately
        setBaseSlidesSynced((prev) => prev.filter((s) => s.id !== slideId));

        hasManualPreviewSelectionRef.current = true;
        startTransition(() => {
            setPreviewSlideId(nextPreviewSlideId);
        });

        // Fire-and-forget: WS refetch will reconcile
        void commitDeleteSlide(id, slideId).catch((error) => {
            console.error('Failed to delete slide', error);
            toast.error('Failed to delete slide');
            setBaseSlidesSynced((prev) => restoreSlideAtOrder(prev, slide));
            void loadSlides();
        });
    }

    function handleDuplicateSlide(slideId: string) {
        const sourceSlide = slides.find((entry) => entry.id === slideId);
        if (!sourceSlide) return;

        const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const sourceIndex = slides.findIndex((s) => s.id === slideId);

        const duplicatedSlide: Slide = {
            id: tempId,
            sessionId: id,
            type: sourceSlide.type,
            content: sourceSlide.content,
            orderIndex: sourceIndex + 1,
            isHidden: false,
            version: 0,
        };

        // Optimistic: insert immediately
        setBaseSlidesSynced((prev) => {
            const next = [...prev];
            next.splice(sourceIndex + 1, 0, duplicatedSlide);
            // Re-index orderIndex
            return next.map((s, i) => ({ ...s, orderIndex: i }));
        });

        hasManualPreviewSelectionRef.current = true;
        startTransition(() => {
            setPreviewSlideId(tempId);
        });

        // Fire-and-forget
        void commitCreateSlide(
            id,
            sourceSlide.type,
            sourceSlide.content,
            { insertAfterSlideId: sourceSlide.id },
        )
            .then((serverSlide) => {
                let contentNeedingSync: Slide['content'] | null = null;
                setBaseSlidesSynced((prev) => normalizeSlides(prev.map((slide) => {
                    if (slide.id !== tempId) {
                        return slide;
                    }

                    const resolved = reconcileCreatedSlide({
                        localSlide: slide,
                        serverSlide,
                    });
                    contentNeedingSync = resolved.contentNeedingSync;
                    return resolved.slide;
                })));
                setPreviewSlideId((currentPreviewSlideId) => currentPreviewSlideId === tempId ? serverSlide.id : currentPreviewSlideId);
                if (contentNeedingSync) {
                    slideEditCommitterRef.current.schedule({
                        slideId: serverSlide.id,
                        content: contentNeedingSync,
                    });
                }
            })
            .catch((error) => {
                console.error('Failed to duplicate slide', error);
                toast.error('Failed to duplicate slide');
                setBaseSlidesSynced((prev) => prev.filter((slide) => slide.id !== tempId).map((slide, index) => ({
                    ...slide,
                    orderIndex: index,
                })));
                setPreviewSlideId((currentPreviewSlideId) => currentPreviewSlideId === tempId ? sourceSlide.id : currentPreviewSlideId);
                void loadSlides();
            });
    }

    const handleToggleVisibility = useCallback(async (e: React.MouseEvent, slide: Slide) => {
        e.stopPropagation();

        const slideId = slide.id;
        setBaseSlidesSynced((prevSlides) =>
            prevSlides.map((entry) => entry.id === slideId ? { ...entry, isHidden: !slide.isHidden } : entry),
        );

        setIsTogglingVisibility(true);
        try {
            await updateSlideVisibility(id, slideId, !slide.isHidden);
            toast.success(slide.isHidden ? 'Slide is now visible' : 'Slide is now hidden');
        } catch (e) {
            toast.error('Failed to update visibility');
            setBaseSlidesSynced((prevSlides) =>
                prevSlides.map((entry) => entry.id === slideId ? { ...entry, isHidden: slide.isHidden } : entry),
            );
        } finally {
            setIsTogglingVisibility(false);
        }
    }, [id, setBaseSlidesSynced]);

    async function handleToggleLive() {
        if (!session) return;
        try {
            if (state?.isPresentationActive) {
                // Optimistic update for immediate UI feedback
                updateState({ isPresentationActive: false });
                await stopSession(id);
                toast.success('Session stopped');
            } else {
                // Optimistic update for immediate UI feedback
                updateState({ isPresentationActive: true });
                await goLiveSession(id);
                toast.success('Session is now LIVE');
            }
            // Update local session state
            loadSession();
        } catch (e) {
            // Revert optimistic update on error
            updateState({ isPresentationActive: state?.isPresentationActive });
            toast.error('Failed to toggle live status');
        }
    }

    async function onDragEnd(result: DropResult) {
        if (!result.destination) return;

        const sourceIndex = result.source.index;
        const destinationIndex = result.destination.index;

        if (sourceIndex === destinationIndex) return;

        setIsReordering(true);
        try {
            const result = await reorderSlidesWithRollback({
                slides,
                sourceIndex,
                destinationIndex,
                applySlides: setBaseSlidesSynced,
                saveOrder: (slideIds) => commitReorderSlides(id, slideIds),
            });

            if (result.status === 'saved') {
                toast.success('Slide order updated');
            } else {
                toast.error('Failed to save slide order');
            }
        } catch (e) {
            toast.error('Failed to save slide order');
        } finally {
            setIsReordering(false);
        }
    }

    const isStructuralSyncing = isReordering;
    const isReorderLocked = isReordering;
    const isShareEnabled = !(isStructuralSyncing || isTogglingVisibility || isSavingSettings);
    const renderSlideCard = useCallback((
        slide: Slide,
        index: number,
        draggableProvided: DraggableProvided,
        isDragging: boolean,
    ) => (
        <SlideListItem
            slide={slide}
            index={index}
            isPreview={previewSlideId === slide.id}
            isLive={state?.currentSlideId === slide.id}
            isDragging={isDragging}
            isStructuralSyncing={false}
            innerRef={draggableProvided.innerRef}
            draggableAttributes={{
                'data-rfd-draggable-context-id': draggableProvided.draggableProps['data-rfd-draggable-context-id'],
                'data-rfd-draggable-id': draggableProvided.draggableProps['data-rfd-draggable-id'],
            }}
            draggableStyle={draggableProvided.draggableProps.style}
            onTransitionEnd={draggableProvided.draggableProps.onTransitionEnd}
            dragHandleProps={draggableProvided.dragHandleProps}
            onSelectSlide={handleSelectSlide}
            onToggleVisibility={handleToggleVisibility}
        />
    ), [handleSelectSlide, handleToggleVisibility, previewSlideId, state?.currentSlideId]);

    return (
        <div className="h-screen bg-slate-50 flex overflow-hidden font-sans text-slate-900">
            {/* Left: Slide List & Creation */}
            <div className="w-72 bg-white border-r border-slate-200 flex flex-col shrink-0 z-20">
                <div className="h-14 px-4 border-b border-slate-100 flex items-center justify-between bg-white">
                    <div className="flex flex-col overflow-hidden mr-2">
                        <h2 className="font-bold text-sm text-slate-800 truncate" title={session?.title}>{session?.title || 'Loading...'}</h2>
                        <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Session Manager</span>
                    </div>
                    <div className="flex gap-1">
                        <Link href={`/staff/session/${id}/settings`}>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-slate-600" title="Session Settings">
                                <Settings className="w-4 h-4" />
                            </Button>
                        </Link>
                    </div>
                </div>

                {/* Navigation Info Banner */}
                <div className="bg-slate-50 border-b border-slate-200 px-4 py-2">
                    <div className="space-y-1.5">
                        <div className="flex items-start gap-2">
                            <Smartphone className="w-3.5 h-3.5 text-blue-600 mt-0.5 flex-shrink-0" />
                            <div>
                                <p className="text-[11px] font-medium text-slate-900">Two States:</p>
                                <p className="text-[10px] text-slate-600 leading-tight">
                                    <span className="font-semibold text-blue-600">Blue = Preview</span> (your view),
                                    <span className="font-semibold text-green-600"> Green = Live</span> (students see)
                                </p>
                            </div>
                        </div>
                        <div className="text-[10px] text-slate-500 leading-tight pl-5">
                            Use <span className="font-semibold">Mobile Clicker</span> to control what&apos;s live for students
                        </div>
                    </div>
                </div>

                <DragDropContext onDragEnd={onDragEnd}>
                    <Droppable
                        droppableId="slides-list"
                        renderClone={(provided, snapshot, rubric) => {
                            const slide = slides[rubric.source.index];
                            return renderSlideCard(slide, rubric.source.index, provided, snapshot.isDragging);
                        }}
                    >
                        {(provided) => (
                            <div
                                className="flex-1 overflow-y-auto p-3 space-y-2 bg-slate-50/50"
                                {...provided.droppableProps}
                                ref={provided.innerRef}
                            >
                                {slides.map((slide, index) => (
                                    <Draggable key={slide.id} draggableId={slide.id} index={index} isDragDisabled={isReorderLocked}>
                                        {(provided, snapshot) => renderSlideCard(slide, index, provided, snapshot.isDragging)}
                                    </Draggable>
                                ))}
                                {provided.placeholder}
                                <Button
                                    variant="outline"
                                    onClick={() => {
                                        startTransition(() => {
                                            setShowTypeSelector(true);
                                        });
                                    }}
                                    className="w-full h-12 border-dashed border-slate-300 text-slate-500 hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50"
                                >
                                    <Plus className="w-4 h-4 mr-2" /> Add New Slide
                                </Button>
                            </div>
                        )}
                    </Droppable>
                </DragDropContext>
            </div>

            {/* Center: Main Canvas (Preview) */}
            <div className="flex-1 flex flex-col relative overflow-hidden bg-slate-100">
                {/* Toolbar */}
                <div className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 shrink-0 z-10 shadow-sm">
                    <div className="flex items-center gap-4">
                        <Breadcrumb items={[
                            { label: 'Sessions', href: '/' },
                            { label: session?.title || 'Session', href: `/staff/session/${id}` },
                            { label: 'Editor' }
                        ]} />
                    </div>

                    <div className="flex items-center gap-3">
                        {/* Live Status Pill */}
                        <div className="flex items-center gap-3 bg-slate-50 px-3 py-1.5 rounded-full border border-slate-200">
                            <div className="text-xs font-medium text-slate-500 flex items-center gap-2">
                                {!initialStateLoaded ? (
                                    <span className="flex items-center gap-1.5 text-slate-400">
                                        <span className="h-2 w-2 rounded-full bg-slate-300 animate-pulse"></span>
                                        Loading...
                                    </span>
                                ) : state?.isPresentationActive ? (
                                    <span className="text-green-600 flex items-center gap-1.5 font-bold">
                                        <span className="relative flex h-2 w-2">
                                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                                        </span>
                                        Live
                                    </span>
                                ) : (
                                    <span className="flex items-center gap-1.5">
                                        <span className="h-2 w-2 rounded-full bg-slate-300"></span>
                                        Offline
                                    </span>
                                )}
                            </div>
                            <div className="w-px h-3 bg-slate-300" />
                            <div className="flex items-center gap-1.5 text-slate-600" title="Active Participants">
                                <Users className="w-3.5 h-3.5" />
                                <span className="text-xs font-bold">{activeParticipants}</span>
                            </div>
                        </div>

                        <div className="h-6 w-px bg-slate-200 mx-1" />

                        {/* Secondary Actions (Icon Only) */}
                        <div className="flex items-center gap-1">
                            {session?.shareToken && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setShowShareDialog(true)}
                                    disabled={!isShareEnabled}
                                    title={isShareEnabled ? 'Share Session' : 'Finish saving before sharing'}
                                >
                                    <Share2 className="w-4 h-4 text-slate-500" />
                                </Button>
                            )}
                            <Button variant="ghost" size="icon" onClick={() => window.open(`/staff/session/${id}/clicker`, '_blank')} title="Mobile Clicker">
                                <Smartphone className="w-4 h-4 text-slate-500" />
                            </Button>
                        </div>

                        {/* Primary Action - Only show after initial state is loaded */}
                        <Button
                            size="sm"
                            onClick={handleToggleLive}
                            disabled={!initialStateLoaded}
                            className={`${initialStateLoaded && state?.isPresentationActive
                                ? "bg-red-600 hover:bg-red-700 shadow-red-600/20"
                                : "bg-green-600 hover:bg-green-700 shadow-green-600/20"} text-white shadow-lg px-5 font-semibold ml-2 transition-all`}
                        >
                            {!initialStateLoaded ? (
                                <>Loading...</>
                            ) : state?.isPresentationActive ? (
                                <>
                                    <Square className="w-3.5 h-3.5 mr-2 fill-current" /> Stop Session
                                </>
                            ) : (
                                <>
                                    <Play className="w-3.5 h-3.5 mr-2 fill-current" /> Go Live
                                </>
                            )}
                        </Button>
                    </div>
                </div>

                {/* Canvas Area */}
                <div className="flex-1 flex items-center justify-center p-8 overflow-auto relative">
                    {/* Dot Pattern Background */}
                    <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(#000 1px, transparent 1px)', backgroundSize: '20px 20px' }}></div>

                    {previewSlide ? (
                        <div className="w-full max-w-5xl relative">
                            {/* Preview Label */}
                            <div className="absolute -top-6 left-0 flex items-center gap-2 text-sm">
                                <span className="px-2.5 py-1 rounded-lg bg-blue-100 text-blue-700 font-semibold text-xs border border-blue-200">
                                    Preview: Slide {previewIndex + 1}
                                </span>
                                {isPreviewLive && (
                                    <span className="px-2.5 py-1 rounded-lg bg-green-100 text-green-700 font-semibold text-xs border border-green-200">
                                        ● LIVE for Students
                                    </span>
                                )}
                                {!isPreviewLive && state?.currentSlideId && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 rounded-lg border-green-200 bg-white/90 px-2 text-[11px] font-semibold text-green-700 hover:bg-green-50"
                                        onClick={() => {
                                            hasManualPreviewSelectionRef.current = true;
                                            startTransition(() => {
                                                setPreviewSlideId(state.currentSlideId ?? null);
                                            });
                                        }}
                                    >
                                        Jump to live
                                    </Button>
                                )}
                            </div>
                            <div className="aspect-video bg-white shadow-2xl rounded-xl overflow-hidden ring-1 ring-slate-900/5 z-10 transition-all duration-300">
                                <SlideRenderer
                                    slide={previewSlide}
                                    role={previewRole}
                                    isPreview={true}
                                />
                            </div>
                        </div>
                    ) : (
                        <div className="text-slate-400 flex flex-col items-center z-10">
                            <div className="w-16 h-16 bg-slate-200 rounded-full flex items-center justify-center mb-4">
                                <Layout className="w-8 h-8 text-slate-400" />
                            </div>
                            <p className="font-medium">Select a slide to preview</p>
                            <p className="text-sm opacity-75">or create a new one</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Right: Inspector (Editor Panel) */}
            <div className="w-[340px] bg-white border-l border-slate-200 flex flex-col shrink-0 z-20 shadow-xl">
                {previewSlide ? (
                    <div className="flex flex-col h-full">
                        {/* Simplified Header */}
                        <div className="h-14 px-4 border-b border-slate-100 flex items-center justify-between bg-white shrink-0">
                            <span className="font-semibold text-sm text-slate-800">Slide Properties</span>
                            <div className="flex items-center gap-1">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-slate-400 hover:text-blue-600"
                                    onClick={() => handleDuplicateSlide(previewSlide.id)}
                                    title="Duplicate Slide"
                                >
                                    <span className="sr-only">Duplicate</span>
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-slate-400 hover:text-red-600 hover:bg-red-50"
                                    onClick={() => handleDeleteSlide(previewSlide.id)}
                                    title="Delete Slide"
                                >
                                    <span className="sr-only">Delete</span>
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" /></svg>
                                </Button>
                            </div>
                        </div>

                        <div className="flex-1 overflow-hidden">
                            <SlideEditorPanel
                                slide={previewSlide}
                                onUpdate={(content) => handleUpdateSlide(previewSlide.id, content)}
                                disabled={isStructuralSyncing}
                                disabledReason={isStructuralSyncing ? 'Syncing changes...' : undefined}
                            />
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-slate-400 p-8 text-center bg-slate-50/50">
                        <Settings className="w-12 h-12 mb-4 opacity-20" />
                        <p className="text-sm font-medium">No Slide Selected</p>
                        <p className="text-xs opacity-75 mt-1">Select a slide to view and edit its properties.</p>
                    </div>
                )}
            </div>

            {/* Slide Type Selector Modal */}
            {showTypeSelector && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full p-8 relative animate-in fade-in zoom-in-95 duration-200">
                        <button
                            onClick={() => {
                                startTransition(() => {
                                    setShowTypeSelector(false);
                                });
                            }}
                            className="absolute top-6 right-6 text-slate-400 hover:text-slate-600 transition-colors"
                        >
                            <X className="w-6 h-6" />
                        </button>
                        <h2 className="text-2xl font-bold mb-2 text-center text-slate-900">Add New Slide</h2>
                        <p className="text-center text-slate-500 mb-8">Choose a template to get started</p>
                        <SlideTypeSelector onSelect={handleAddSlide} disabled={false} />
                    </div>
                </div>
            )}
            {/* Q&A Manager Overlay */}
            {showQAManager && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
                    <div className="w-full max-w-2xl h-[80vh] bg-white rounded-xl shadow-2xl overflow-hidden">
                        <QAManager onClose={() => setShowQAManager(false)} slides={slides} />
                    </div>
                </div>
            )}
            {/* Share Dialog */}
            {showShareDialog && session?.shareToken && (
                <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full relative animate-in fade-in zoom-in-95 duration-200 overflow-hidden">
                        <button
                            onClick={() => setShowShareDialog(false)}
                            className="absolute top-4 right-4 z-10 text-slate-400 hover:text-slate-600 transition-colors hover:bg-slate-100 rounded-full p-1"
                        >
                            <X className="w-5 h-5" />
                        </button>

                        {/* Header with gradient */}
                        <div className="bg-gradient-to-br from-blue-600 to-blue-700 p-6 pb-8">
                            <div className="flex items-center gap-3 mb-2">
                                <div className="w-10 h-10 bg-white/20 backdrop-blur-sm rounded-xl flex items-center justify-center">
                                    <Share2 className="w-5 h-5 text-white" />
                                </div>
                                <h2 className="text-2xl font-bold text-white">Share Session</h2>
                            </div>
                            <p className="text-blue-100 text-sm">Invite students or share analytics with stakeholders</p>
                        </div>

                        <div className="p-6 space-y-6">
                            {!isShareEnabled && (
                                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
                                    <p className="text-sm font-semibold">Finish the current structural update before sharing.</p>
                                </div>
                            )}
                            {/* Join Code Card */}
                            <div className="bg-gradient-to-br from-green-50 to-emerald-50 border-2 border-green-200 rounded-xl p-4">
                                <div className="flex items-center gap-2 mb-3">
                                    <div className="w-6 h-6 bg-green-600 rounded-lg flex items-center justify-center">
                                        <Users className="w-4 h-4 text-white" />
                                    </div>
                                    <label className="text-sm font-bold text-green-900 uppercase tracking-wide">
                                        Student Join Code
                                    </label>
                                </div>
                                <div className="bg-white rounded-lg border-2 border-green-300 p-4 mb-3">
                                    <div className="text-center">
                                        <p className="text-xs text-slate-500 mb-2">Students enter this code at:</p>
                                        <p className="text-xs font-mono text-slate-600 mb-3">{window.location.origin}/student/join</p>
                                        <div className="bg-gradient-to-br from-green-100 to-green-50 rounded-lg py-3 px-4 inline-block">
                                            <p className="text-4xl font-black text-green-700 tracking-widest font-mono">{session.shareToken}</p>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <Button
                                        variant="outline"
                                        className="flex-1 border-green-300 text-green-700 hover:bg-green-100 hover:border-green-400"
                                        disabled={!isShareEnabled}
                                        onClick={() => {
                                            navigator.clipboard.writeText(session.shareToken!);
                                            toast.success('Join code copied!');
                                        }}
                                    >
                                        <Copy className="w-4 h-4 mr-2" />
                                        Copy Code
                                    </Button>
                                    <Button
                                        variant="outline"
                                        className="flex-1 border-green-300 text-green-700 hover:bg-green-100 hover:border-green-400"
                                        disabled={!isShareEnabled}
                                        onClick={() => {
                                            navigator.clipboard.writeText(`${window.location.origin}/student/session/${session.shareToken}`);
                                            toast.success('Direct link copied!');
                                        }}
                                    >
                                        <ExternalLink className="w-4 h-4 mr-2" />
                                        Copy Link
                                    </Button>
                                </div>
                            </div>

                            {/* Dashboard Link Card */}
                            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border-2 border-blue-200 rounded-xl p-4">
                                <div className="flex items-center gap-2 mb-3">
                                    <div className="w-6 h-6 bg-blue-600 rounded-lg flex items-center justify-center">
                                        <BarChart2 className="w-4 h-4 text-white" />
                                    </div>
                                    <label className="text-sm font-bold text-blue-900 uppercase tracking-wide">
                                        Public Dashboard
                                    </label>
                                </div>
                                <div className="bg-white rounded-lg border border-blue-200 p-3 mb-3">
                                    <div className="flex gap-2 items-center">
                                        <div className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-slate-600 truncate select-all">
                                            {window.location.origin}/dashboard/{session.shareToken}
                                        </div>
                                        <Button
                                            variant="outline"
                                            size="icon"
                                            className="shrink-0 border-blue-300 text-blue-700 hover:bg-blue-100"
                                            disabled={!isShareEnabled}
                                            onClick={() => {
                                                navigator.clipboard.writeText(`${window.location.origin}/dashboard/${session.shareToken}`);
                                                toast.success('Dashboard link copied!');
                                            }}
                                            title="Copy Dashboard Link"
                                        >
                                            <Copy className="w-4 h-4" />
                                        </Button>
                                    </div>
                                </div>
                                <p className="text-xs text-blue-700 bg-blue-100 rounded-lg p-2 flex items-start gap-2">
                                    <Eye className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                    <span>Read-only analytics view. No login required. Perfect for stakeholders or external monitors.</span>
                                </p>
                            </div>
                        </div>

                        <div className="px-6 pb-6 flex gap-2">
                            <Button
                                variant="outline"
                                className="flex-1"
                                disabled={!isShareEnabled}
                                onClick={() => window.open(`/dashboard/${session.shareToken}`, '_blank')}
                            >
                                <ExternalLink className="w-4 h-4 mr-2" />
                                Open Dashboard
                            </Button>
                            <Button
                                className="flex-1 bg-blue-600 hover:bg-blue-700"
                                onClick={() => setShowShareDialog(false)}
                            >
                                Done
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function SlideEditor() {
    const params = useParams();
    const router = useRouter();
    const id = params?.id as string;
    const [slides, setSlides] = useState<Slide[]>([]);
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);
    const [authChecked, setAuthChecked] = useState(false);
    const [notFound, setNotFound] = useState(false);

    const loadSession = useCallback(async () => {
        try {
            const data = await getSession(id);
            setSession(data);
        } catch (e) {
            console.error(e);
            if (e instanceof ApiRequestError && e.status === 404) {
                setNotFound(true);
                toast.error('Session not found');
                router.push('/sessions');
                return;
            }
            toast.error('Failed to load session details');
        }
    }, [id, router]);

    const loadSlides = useCallback(async () => {
        try {
            const data = await getSlides(id);
            setSlides(normalizeSlides(data));
        } catch (e) {
            console.error(e);
            if (e instanceof ApiRequestError && e.status === 404) {
                setNotFound(true);
                return;
            }
            toast.error('Failed to load slides');
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        // Check auth first
        const token = safeLocalStorageGet('token');
        if (!token) {
            router.push('/login');
            return;
        }
        setAuthChecked(true);

        if (id) {
            void loadSlides();
            void loadSession();
        }
    }, [id, loadSession, loadSlides, router]);

    if (!id || !authChecked) return null;

    if (notFound) {
        return (
            <div className="h-screen flex items-center justify-center bg-slate-100">
                <div className="flex flex-col items-center gap-4">
                    <p className="text-slate-500 font-medium">Redirecting to sessions...</p>
                </div>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="h-screen flex items-center justify-center bg-slate-100">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                    <p className="text-slate-500 font-medium">Loading session...</p>
                </div>
            </div>
        );
    }

    return (
        <WebSocketProvider sessionId={id} role="staff">
            <EditorContent baseSlides={slides} setBaseSlides={setSlides} loadSlides={loadSlides} session={session} loadSession={loadSession} />
        </WebSocketProvider>
    );
}
