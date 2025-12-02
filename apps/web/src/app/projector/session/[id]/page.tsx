'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Slide } from 'shared';
import { getSlides } from '@/lib/api';
import { WebSocketProvider, useWebSocket } from '@/lib/websocket';
import { SlideRenderer } from '@/components/slide-renderer';
import { Card } from '@/components/ui/card';

function ProjectorContent({ slides }: { slides: Slide[] }) {
    const { state } = useWebSocket();

    const currentSlide = slides.find(s => s.id === state?.currentSlideId);

    return (
        <div className="min-h-screen bg-black flex items-center justify-center overflow-hidden">
            {currentSlide ? (
                <div className="w-full h-full max-w-[1920px] max-h-[1080px] aspect-video bg-white relative">
                    <SlideRenderer slide={currentSlide} role="projector" />

                    {/* QR Code or Join Info Overlay could go here */}
                    <div className="absolute bottom-4 right-4 bg-black/50 text-white px-4 py-2 rounded-full text-sm backdrop-blur-sm">
                        Join at <strong>classcolab.com/student</strong>
                    </div>
                </div>
            ) : (
                <div className="text-white text-2xl animate-pulse">
                    Waiting for presentation to start...
                </div>
            )}
        </div>
    );
}

export default function ProjectorPage() {
    const params = useParams();
    const id = params?.id as string;
    const [slides, setSlides] = useState<Slide[]>([]);

    useEffect(() => {
        if (id) {
            getSlides(id).then(setSlides);
        }
    }, [id]);

    if (!id) return null;

    return (
        <WebSocketProvider sessionId={id} role="projector">
            <ProjectorContent slides={slides} />
        </WebSocketProvider>
    );
}
