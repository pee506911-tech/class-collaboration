'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Slide } from 'shared';
import { getSlides } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { WebSocketProvider, useWebSocket } from '@/lib/websocket';
import { ChevronLeft, ChevronRight, Eye, EyeOff, BarChart2, Users, Smartphone, Layout } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { SlideRenderer } from '@/components/slide-renderer';

function ClickerContent() {
    const { sendMessage, state, isConnected, activeParticipants, lastSlideUpdate, updateState } = useWebSocket();
    const params = useParams();
    const id = params?.id as string;
    const [slides, setSlides] = useState<Slide[]>([]);
    const [currentIndex, setCurrentIndex] = useState(-1);
    const [isBlackout, setIsBlackout] = useState(false);
    const [showResults, setShowResults] = useState(false);
    const [lostCount, setLostCount] = useState(0);
    const [currentTime, setCurrentTime] = useState<Date | null>(null);

    useEffect(() => {
        setCurrentTime(new Date());
        const timer = setInterval(() => setCurrentTime(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    // Fetch slides and reload when they change
    useEffect(() => {
        const loadSlides = () => getSlides(id).then(setSlides);
        loadSlides();

        // Poll for slide changes (in case of edits)
        const interval = setInterval(loadSlides, 10000); // Refresh every 10s
        return () => clearInterval(interval);
    }, [id, lastSlideUpdate]);

    // Filter out hidden slides for navigation logic
    const visibleSlides = slides.filter(s => !s.isHidden);

    useEffect(() => {
        if (visibleSlides.length > 0) {
            if (state?.currentSlideId) {
                // Sync with server state
                const index = visibleSlides.findIndex(s => s.id === state.currentSlideId);
                setCurrentIndex(index);
            } else if (currentIndex === -1) {
                // Initialize to first slide if no state yet
                setCurrentIndex(0);
            }
        }
    }, [slides, state?.currentSlideId]); // Re-run when slides change (visibility might change)

    useEffect(() => {
        if (state) {
            setIsBlackout(state.isBlackout || false);
            setShowResults(state.showResults || false);
            setLostCount(state.lostCount || 0);
        }
    }, [state]);

    const handleNext = () => {
        if (currentIndex < visibleSlides.length - 1) {
            const nextSlide = visibleSlides[currentIndex + 1];
            setCurrentIndex(currentIndex + 1); // Optimistic update for local UI
            updateState({ currentSlideId: nextSlide.id }); // Optimistic update for shared state
            sendMessage('SET_SLIDE', { slideId: nextSlide.id });
        }
    };

    const handlePrev = () => {
        if (currentIndex > 0) {
            const prevSlide = visibleSlides[currentIndex - 1];
            setCurrentIndex(currentIndex - 1); // Optimistic update for local UI
            updateState({ currentSlideId: prevSlide.id }); // Optimistic update for shared state
            sendMessage('SET_SLIDE', { slideId: prevSlide.id });
        }
    };

    const currentSlide = visibleSlides[currentIndex];
    const nextSlide = visibleSlides[currentIndex + 1];

    const hasPrev = currentIndex > 0;
    const hasNext = currentIndex < visibleSlides.length - 1;

    const toggleBlackout = () => {
        const newState = !isBlackout;
        setIsBlackout(newState);
        sendMessage('STATE_UPDATE', { isBlackout: newState });
    };

    const toggleResults = () => {
        const newState = !showResults;
        setShowResults(newState);
        sendMessage('STATE_UPDATE', { showResults: newState });
    };

    if (!isConnected) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-900 text-white">
                <div className="animate-pulse">Connecting to Clicker...</div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-900 flex flex-col font-sans text-white">
            {/* Header */}
            <div className="bg-slate-800/50 backdrop-blur-md border-b border-white/10 p-4 flex items-center justify-between sticky top-0 z-20">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/20">
                        <Smartphone className="w-5 h-5 text-white" />
                    </div>
                    <div>
                        <h1 className="font-bold text-lg leading-tight">Remote</h1>
                        <div className="flex items-center gap-2 text-xs text-slate-400">
                            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-red-500'}`} />
                            {isConnected ? 'Connected' : 'Disconnected'}
                        </div>
                    </div>
                </div>
                <div className="text-right">
                    <div className="text-2xl font-mono font-bold tracking-wider tabular-nums">
                        {currentTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '--:--'}
                    </div>
                </div>
            </div>

            {/* Main Content Area - Split View */}
            <div className="flex-1 flex flex-col relative overflow-hidden">

                {/* Top: Live Slide Preview (Student View) */}
                <div className="flex-1 bg-slate-950 flex items-center justify-center p-4 overflow-hidden relative">
                    {/* Background Pattern */}
                    <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(#fff 1px, transparent 1px)', backgroundSize: '20px 20px' }} />

                    {currentSlide ? (
                        <div className="w-full max-w-5xl relative z-10">
                            <div className="aspect-video w-full bg-white rounded-lg shadow-2xl overflow-hidden ring-1 ring-white/10 relative">
                                {/* We force role="student" here so the clicker sees exactly what students see */}
                                <div className="absolute inset-0 pointer-events-none">
                                    <SlideRenderer slide={currentSlide} role="student" />
                                </div>
                            </div>
                            {/* Overlay to indicate it's a preview */}
                            <div className="absolute -top-3 -right-2 bg-blue-600 text-white text-[10px] px-2 py-0.5 rounded-full font-bold shadow-sm z-20 border border-blue-400">
                                STUDENT VIEW
                            </div>
                        </div>
                    ) : (
                        <div className="text-slate-500 flex flex-col items-center relative z-10">
                            <Layout className="w-12 h-12 mb-2 opacity-20" />
                            <p className="text-sm">No active slide</p>
                        </div>
                    )}
                </div>

                {/* Bottom: Controls */}
                <div className="bg-slate-900 border-t border-white/10 p-6 pb-8 z-20 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
                    {/* Navigation */}
                    <div className="grid grid-cols-2 gap-4 mb-6">
                        <Button
                            variant="outline"
                            size="lg"
                            onClick={handlePrev}
                            disabled={!hasPrev}
                            className="h-20 rounded-2xl border-slate-700 bg-slate-800/50 hover:bg-slate-800 text-slate-200 hover:text-white hover:border-slate-600 transition-all active:scale-95 flex flex-col gap-2"
                        >
                            <ChevronLeft className="w-8 h-8" />
                            <span className="text-xs font-bold uppercase tracking-wider">Previous</span>
                        </Button>

                        <Button
                            variant="default"
                            size="lg"
                            onClick={handleNext}
                            disabled={!hasNext}
                            className="h-20 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20 transition-all active:scale-95 flex flex-col gap-2"
                        >
                            <ChevronRight className="w-8 h-8" />
                            <span className="text-xs font-bold uppercase tracking-wider">Next Slide</span>
                        </Button>
                    </div>

                    {/* Quick Actions */}
                    <div className="grid grid-cols-3 gap-3">
                        <Button
                            variant="secondary"
                            onClick={toggleBlackout}
                            className={`h-14 rounded-xl border border-slate-700 ${isBlackout ? 'bg-red-500/10 text-red-400 border-red-500/50' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                        >
                            {isBlackout ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
                        </Button>

                        <Button
                            variant="secondary"
                            onClick={toggleResults}
                            className={`h-14 rounded-xl border border-slate-700 ${showResults ? 'bg-blue-500/10 text-blue-400 border-blue-500/50' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                        >
                            <BarChart2 className="w-5 h-5" />
                        </Button>

                        <div className="h-14 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center gap-2 text-slate-400">
                            <Users className="w-4 h-4" />
                            <span className="font-bold">{activeParticipants}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function ClickerPage() {
    const params = useParams();
    const id = params?.id as string;

    if (!id) return null;

    return (
        <WebSocketProvider sessionId={id} role="staff">
            <ClickerContent />
        </WebSocketProvider>
    );
}
