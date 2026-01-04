'use client';

export const runtime = 'edge';

import { useParams } from 'next/navigation';
import { WebSocketProvider, useWebSocket } from '@/lib/websocket';
import { useState, useEffect } from 'react';
import { Slide } from 'shared';
import { getSlides } from '@/lib/api';
import { SlideRenderer } from '@/components/slide-renderer';

function ProjectorContent() {
    const { state, initialStateLoaded } = useWebSocket();

    // Show loading while initial state is being fetched
    if (!initialStateLoaded) {
        return (
            <div className="min-h-screen bg-black text-white flex items-center justify-center text-2xl font-medium p-8 text-center">
                <div className="animate-pulse">Connecting to session...</div>
            </div>
        );
    }

    if (!state?.currentSlideId) {
        return (
            <div className="min-h-screen bg-black text-white flex items-center justify-center text-4xl font-bold p-8 text-center">
                Waiting for presentation...
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-black text-white p-8">
            <ProjectorSlideView slideId={state.currentSlideId} />
        </div>
    );
}

function ProjectorSlideView({ slideId }: { slideId: string }) {
    const params = useParams();
    const sessionId = params?.id as string;
    const [slide, setSlide] = useState<Slide | null>(null);

    useEffect(() => {
        getSlides(sessionId).then(slides => {
            const s = slides.find(s => s.id === slideId);
            if (s) setSlide(s);
        });
    }, [slideId, sessionId]);

    if (!slide) return <div className="text-white text-center">Loading...</div>;

    return (
        <div className="h-full w-full bg-white rounded-xl overflow-hidden">
            <SlideRenderer slide={slide} role="projector" />
        </div>
    );
}

export default function ProjectorView() {
    const params = useParams();
    const id = params?.id as string;

    if (!id) return null;

    return (
        <WebSocketProvider sessionId={id} role="projector">
            <ProjectorContent />
        </WebSocketProvider>
    );
}
