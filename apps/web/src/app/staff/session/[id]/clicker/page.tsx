'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Slide } from 'shared';
import { publicGetSlides, publicSetCurrentSlide } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { WebSocketProvider, useWebSocket } from '@/lib/websocket';
import { ChevronLeft, ChevronRight, Smartphone, Layout } from 'lucide-react';
import { SlideRenderer } from '@/components/slide-renderer';

function ClickerContent() {
    const { state, isConnected, lastSlideUpdate, updateState, initialStateLoaded } = useWebSocket();
    const params = useParams();
    const id = params?.id as string;
    const [slides, setSlides] = useState<Slide[]>([]);
    const [currentIndex, setCurrentIndex] = useState(-1);
    const [currentTime, setCurrentTime] = useState<Date | null>(null);

    useEffect(() => {
        setCurrentTime(new Date());
        const timer = setInterval(() => setCurrentTime(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    // Fetch slides and reload when they change
    useEffect(() => {
        const loadSlides = () => publicGetSlides(id).then(setSlides);
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

    const handleNext = async () => {
        if (currentIndex < visibleSlides.length - 1) {
            const nextSlide = visibleSlides[currentIndex + 1];
            setCurrentIndex(currentIndex + 1);
            updateState({ currentSlideId: nextSlide.id });
            await publicSetCurrentSlide(id, nextSlide.id);
        }
    };

    const handlePrev = async () => {
        if (currentIndex > 0) {
            const prevSlide = visibleSlides[currentIndex - 1];
            setCurrentIndex(currentIndex - 1);
            updateState({ currentSlideId: prevSlide.id });
            await publicSetCurrentSlide(id, prevSlide.id);
        }
    };

    const currentSlide = visibleSlides[currentIndex];

    const hasPrev = currentIndex > 0;
    const hasNext = currentIndex < visibleSlides.length - 1;

    if (!isConnected || !initialStateLoaded) {
        return (
            <div className="fixed inset-0 flex items-center justify-center bg-slate-900 text-white">
                <div className="animate-pulse">{!initialStateLoaded ? 'Loading session state...' : 'Connecting to Clicker...'}</div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 bg-slate-900 flex flex-col font-sans text-white">
            {/* Header - Compact */}
            <div className="h-12 flex-shrink-0 bg-slate-800 border-b border-white/10 px-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center">
                        <Smartphone className="w-3.5 h-3.5 text-white" />
                    </div>
                    <div>
                        <h1 className="font-bold text-xs leading-tight">Remote</h1>
                        <div className="flex items-center gap-1 text-[9px] text-slate-400">
                            <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
                            {isConnected ? 'Connected' : 'Disconnected'}
                        </div>
                    </div>
                </div>
                <div className="text-base font-mono font-bold tabular-nums">
                    {currentTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '--:--'}
                </div>
            </div>

            {/* Slide Preview - Fill available space */}
            <div className="flex-1 bg-white m-2 rounded-lg shadow-2xl overflow-hidden relative">
                {currentSlide ? (
                    <>
                        <SlideRenderer slide={currentSlide} role="student" />
                        <div className="absolute top-1 right-1 bg-blue-600/90 text-white text-[7px] px-1 py-0.5 rounded font-bold">
                            PREVIEW
                        </div>
                    </>
                ) : (
                    <div className="h-full flex flex-col items-center justify-center text-slate-400 bg-slate-100">
                        <Layout className="w-10 h-10 mb-2 opacity-30" />
                        <p className="text-sm">No active slide</p>
                    </div>
                )}
            </div>

            {/* Navigation Buttons - Fixed at bottom */}
            <div className="flex-shrink-0 bg-slate-900 border-t border-white/10 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
                <div className="grid grid-cols-2 gap-2 h-16">
                    <Button
                        variant="outline"
                        onClick={handlePrev}
                        disabled={!hasPrev}
                        className="h-full rounded-xl border-slate-700 bg-slate-800/50 hover:bg-slate-800 text-slate-200 hover:text-white transition-all active:scale-95 flex flex-col gap-0.5"
                    >
                        <ChevronLeft className="w-7 h-7" />
                        <span className="text-[10px] font-bold uppercase">Previous</span>
                    </Button>

                    <Button
                        variant="default"
                        onClick={handleNext}
                        disabled={!hasNext}
                        className="h-full rounded-xl bg-blue-600 hover:bg-blue-500 text-white shadow-lg transition-all active:scale-95 flex flex-col gap-0.5"
                    >
                        <ChevronRight className="w-7 h-7" />
                        <span className="text-[10px] font-bold uppercase">Next Slide</span>
                    </Button>
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
