'use client';

export const runtime = 'edge';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Slide, Session } from 'shared';
import { getSlides, createSlide, updateSlide, deleteSlide, reorderSlides, getSession, updateSession, updateSlideVisibility, goLiveSession, stopSession } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Plus, Layout, BarChart2, HelpCircle, Play, X, CheckSquare, Smartphone, GripVertical, Share2, ArrowLeft, Settings, Edit2, MessageSquare, Users, Eye, EyeOff, Square, Copy, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { WebSocketProvider, useWebSocket } from '@/lib/websocket';
import { SlideRenderer } from '@/components/slide-renderer';
import { SlideEditorPanel } from '@/components/slide-editor-panel';
import { QAManager } from '@/components/qa-manager';
import { SlideTypeSelector } from '@/components/slide-type-selector';
import { SessionDashboard } from '@/components/session-dashboard';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { toast } from 'sonner';
import { Breadcrumb } from '@/components/ui/breadcrumb';

function EditorContent({ slides, setSlides, loadSlides, session, loadSession }: { slides: Slide[], setSlides: (slides: Slide[]) => void, loadSlides: () => void, session: Session | null, loadSession: () => void }) {
    const { sendMessage, state, activeParticipants, updateState } = useWebSocket();
    const params = useParams();
    const id = params?.id as string;
    const [showTypeSelector, setShowTypeSelector] = useState(false);
    const [previewRole, setPreviewRole] = useState<'student' | 'projector'>('student');
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [showQAManager, setShowQAManager] = useState(false);
    const [showDashboard, setShowDashboard] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    const [showShareDialog, setShowShareDialog] = useState(false);

    // SEPARATE PREVIEW STATE: This is for editor preview only, independent of student view
    const [previewSlideId, setPreviewSlideId] = useState<string | null>(null);

    useEffect(() => {
        if (session) setEditTitle(session.title);
    }, [session]);

    // Sync preview to active slide when it changes (optional - keeps preview updated)
    useEffect(() => {
        if (state?.currentSlideId && !previewSlideId) {
            setPreviewSlideId(state.currentSlideId);
        }
    }, [state?.currentSlideId]);

    const handleSaveSettings = async () => {
        if (!session) return;
        try {
            await updateSession(session.id, editTitle, session.allowQuestions, session.requireName);
            loadSession();
            setIsSettingsOpen(false);
            toast.success('Settings saved');
        } catch (e) {
            toast.error('Failed to save settings');
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
                    sendMessage('STATE_UPDATE', { isBlackout: !state.isBlackout });
                    toast.info(state.isBlackout ? 'Blackout Disabled' : 'Blackout Enabled');
                }
            } else if (e.key === ' ' || e.key.toLowerCase() === 'r') {
                e.preventDefault();
                if (state) {
                    sendMessage('STATE_UPDATE', { showResults: !state.showResults });
                    toast.info(state.showResults ? 'Results Hidden' : 'Results Visible');
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [state]); // Re-bind when state/slides change to ensure fresh closures if needed

    async function handleAddSlide(type: string) {
        let content = {};
        if (type === 'static') content = { title: 'New Slide', body: 'Content here' };
        if (type === 'poll') content = { question: 'New Poll', options: [{ id: '1', text: 'Option 1' }, { id: '2', text: 'Option 2' }] };
        if (type === 'multiple-choice') content = { question: 'New Question', options: [{ id: '1', text: 'Option 1' }, { id: '2', text: 'Option 2' }], allowMultipleSelection: false };
        if (type === 'qa') content = { title: 'Q&A Session' };
        if (type === 'quiz') content = {
            question: 'New Quiz Question',
            options: [{ id: '1', text: 'Option 1', isCorrect: true }, { id: '2', text: 'Option 2', isCorrect: false }],
            points: 1000,
            timerDuration: 30
        };
        if (type === 'leaderboard') content = { title: 'Leaderboard' };

        try {
            await createSlide(id, type, content);
            loadSlides();
            setShowTypeSelector(false);
            toast.success('Slide created successfully');
        } catch (e) {
            toast.error('Failed to create slide');
        }
    }

    // NAVIGATION REMOVED: Use Mobile Clicker for slide navigation
    // This editor is for content editing only, not presentation control

    // PREVIEW NAVIGATION: For editor preview only (does NOT affect students)
    const previewIndex = slides.findIndex(s => s.id === previewSlideId);
    const previewSlide = slides[previewIndex] || slides[0];

    const handlePreviewNext = () => {
        if (previewIndex < slides.length - 1) {
            setPreviewSlideId(slides[previewIndex + 1].id);
        }
    };

    const handlePreviewPrev = () => {
        if (previewIndex > 0) {
            setPreviewSlideId(slides[previewIndex - 1].id);
        }
    };

    const handleSelectSlide = (slideId: string) => {
        setPreviewSlideId(slideId);
    };

    async function handleUpdateSlide(slideId: string, content: any) {
        try {
            await updateSlide(id, slideId, content);
            // Silently update - no toast spam on every keystroke
            // Only reload slides to sync state
            loadSlides();
        } catch (e) {
            toast.error('Failed to update slide');
        }
    }

    async function handleDeleteSlide(slideId: string) {
        if (!confirm('Are you sure you want to delete this slide?')) return;
        try {
            await deleteSlide(id, slideId);
            loadSlides();
            toast.success('Slide deleted');
        } catch (e) {
            toast.error('Failed to delete slide');
        }
    }

    async function handleDuplicateSlide(slideId: string) {
        const slide = slides.find(s => s.id === slideId);
        if (!slide) return;
        try {
            await createSlide(id, slide.type, slide.content);
            loadSlides();
            toast.success('Slide duplicated');
        } catch (e) {
            toast.error('Failed to duplicate slide');
        }
    }

    async function handleToggleVisibility(e: React.MouseEvent, slide: Slide) {
        e.stopPropagation();
        try {
            await updateSlideVisibility(id, slide.id, !slide.isHidden);
            // Optimistic update
            const newSlides = slides.map(s => s.id === slide.id ? { ...s, isHidden: !s.isHidden } : s);
            setSlides(newSlides);
            toast.success(slide.isHidden ? 'Slide is now visible' : 'Slide is now hidden');
        } catch (e) {
            toast.error('Failed to update visibility');
            loadSlides();
        }
    }

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

    const currentSlideIndex = slides.findIndex(s => s.id === state?.currentSlideId);
    const currentSlide = slides[currentSlideIndex];

    async function onDragEnd(result: DropResult) {
        if (!result.destination) return;

        const sourceIndex = result.source.index;
        const destinationIndex = result.destination.index;

        if (sourceIndex === destinationIndex) return;

        const newSlides = Array.from(slides);
        const [reorderedItem] = newSlides.splice(sourceIndex, 1);
        newSlides.splice(destinationIndex, 0, reorderedItem);

        setSlides(newSlides); // Optimistic update

        try {
            await reorderSlides(id, newSlides.map(s => s.id));
            toast.success('Slide order updated');
        } catch (e) {
            toast.error('Failed to save slide order');
            loadSlides(); // Revert on error
        }
    }

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
                            Use <span className="font-semibold">Mobile Clicker</span> to control what's live for students
                        </div>
                    </div>
                </div>

                <DragDropContext onDragEnd={onDragEnd}>
                    <Droppable droppableId="slides-list">
                        {(provided) => (
                            <div
                                className="flex-1 overflow-y-auto p-3 space-y-2 bg-slate-50/50"
                                {...provided.droppableProps}
                                ref={provided.innerRef}
                            >
                                {slides.map((slide, index) => (
                                    <Draggable key={slide.id} draggableId={slide.id} index={index}>
                                        {(provided, snapshot) => (
                                            <div
                                                ref={provided.innerRef}
                                                {...provided.draggableProps}
                                                // PREVIEW SELECTION: Click selects for EDITOR PREVIEW (not student view)
                                                onClick={() => handleSelectSlide(slide.id)}
                                                className={`group relative p-3 rounded-xl cursor-pointer transition-all duration-200 border ${previewSlideId === slide.id
                                                    ? 'bg-white border-blue-600 shadow-md ring-1 ring-blue-600/20 z-10'
                                                    : state?.currentSlideId === slide.id
                                                        ? 'bg-green-50 border-green-600 shadow-sm ring-1 ring-green-600/20'
                                                        : 'bg-white border-slate-200 hover:border-blue-300 hover:shadow-sm'
                                                    } ${snapshot.isDragging ? 'shadow-xl ring-2 ring-blue-600 rotate-2 z-50' : ''}`}
                                                style={provided.draggableProps.style}
                                                title={
                                                    previewSlideId === slide.id
                                                        ? "Selected for Preview"
                                                        : state?.currentSlideId === slide.id
                                                            ? "Active for Students (via Mobile Clicker)"
                                                            : "Click to preview"
                                                }
                                            >
                                                <div className="flex items-center gap-3">
                                                    <div {...provided.dragHandleProps} className="text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing p-1 -ml-1">
                                                        <GripVertical className="w-4 h-4" />
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center justify-between mb-2">
                                                            <div className="flex items-center gap-1">
                                                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${previewSlideId === slide.id
                                                                    ? 'bg-blue-100 text-blue-700'
                                                                    : state?.currentSlideId === slide.id
                                                                        ? 'bg-green-100 text-green-700'
                                                                        : 'bg-slate-100 text-slate-500'
                                                                    }`}>
                                                                    #{index + 1}
                                                                </span>
                                                                {state?.currentSlideId === slide.id && (
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
                                                                    onClick={(e) => handleToggleVisibility(e, slide)}
                                                                    title={slide.isHidden ? "Show Slide" : "Hide Slide"}
                                                                >
                                                                    {slide.isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                                                </Button>
                                                                {slide.type === 'poll' && <BarChart2 className="w-3 h-3 text-slate-400" />}
                                                                {slide.type === 'quiz' && <HelpCircle className="w-3 h-3 text-yellow-500" />}
                                                                {slide.type === 'static' && <Layout className="w-3 h-3 text-slate-400" />}
                                                            </div>
                                                        </div>
                                                        <p className={`text-xs font-medium truncate ${slide.isHidden ? 'text-slate-400 italic' : 'text-slate-700'}`}>
                                                            {slide.content.question || slide.content.title || 'Untitled Slide'}
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </Draggable>
                                ))}
                                {provided.placeholder}
                                <Button
                                    variant="outline"
                                    onClick={() => setShowTypeSelector(true)}
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
                                {state?.isPresentationActive ? (
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
                                <Button variant="ghost" size="icon" onClick={() => setShowShareDialog(true)} title="Share Session">
                                    <Share2 className="w-4 h-4 text-slate-500" />
                                </Button>
                            )}
                            <Button variant="ghost" size="icon" onClick={() => window.open(`/staff/session/${id}/clicker`, '_blank')} title="Mobile Clicker">
                                <Smartphone className="w-4 h-4 text-slate-500" />
                            </Button>
                        </div>

                        {/* Primary Action */}
                        <Button
                            size="sm"
                            onClick={handleToggleLive}
                            className={`${state?.isPresentationActive
                                ? "bg-red-600 hover:bg-red-700 shadow-red-600/20"
                                : "bg-green-600 hover:bg-green-700 shadow-green-600/20"} text-white shadow-lg px-5 font-semibold ml-2 transition-all`}
                        >
                            {state?.isPresentationActive ? (
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
                                {state?.currentSlideId === previewSlideId && (
                                    <span className="px-2.5 py-1 rounded-lg bg-green-100 text-green-700 font-semibold text-xs border border-green-200">
                                        ● LIVE for Students
                                    </span>
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
                                onSave={() => toast.success('Changes saved')}
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
                            onClick={() => setShowTypeSelector(false)}
                            className="absolute top-6 right-6 text-slate-400 hover:text-slate-600 transition-colors"
                        >
                            <X className="w-6 h-6" />
                        </button>
                        <h2 className="text-2xl font-bold mb-2 text-center text-slate-900">Add New Slide</h2>
                        <p className="text-center text-slate-500 mb-8">Choose a template to get started</p>
                        <SlideTypeSelector onSelect={handleAddSlide} />
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

    useEffect(() => {
        // Check auth first
        const token = localStorage.getItem('token');
        if (!token) {
            router.push('/login');
            return;
        }
        setAuthChecked(true);
        
        if (id) {
            loadSlides();
            loadSession();
        }
    }, [id, router]);

    async function loadSession() {
        try {
            const data = await getSession(id);
            setSession(data);
        } catch (e) {
            console.error(e);
            toast.error('Failed to load session details');
        }
    }

    async function loadSlides() {
        try {
            const data = await getSlides(id);
            setSlides(data);
        } catch (e) {
            console.error(e);
            toast.error('Failed to load slides');
        } finally {
            setLoading(false);
        }
    }

    if (!id || !authChecked) return null;

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
            <EditorContent slides={slides} setSlides={setSlides} loadSlides={loadSlides} session={session} loadSession={loadSession} />
        </WebSocketProvider>
    );
}
