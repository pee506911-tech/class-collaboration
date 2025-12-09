'use client';

export const runtime = 'edge';

import { useParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WebSocketProvider, useWebSocket } from '@/lib/websocket';
import { useEffect, useState } from 'react';
import { Slide, Session } from 'shared';
import { getSlides } from '@/lib/api';
import { SlideRenderer } from '@/components/slide-renderer';
import { LoadingState } from '@/components/ui/loading';
import { Loader2, User, ArrowRight, MessageSquare } from 'lucide-react';
import { Dialog, DialogFooter } from '@/components/ui/dialog';

// Public API call for students (no auth required)
async function getSessionByToken(token: string): Promise<any> {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
    const res = await fetch(`${apiUrl}/session-by-token/${token}`);
    if (!res.ok) throw new Error('Session not found');
    const json = await res.json();
    return json.data;
}

function StudentSlideView({ slideId, slides }: { slideId: string; slides: Slide[] }) {
    const [slide, setSlide] = useState<Slide | null>(null);

    useEffect(() => {
        const s = slides.find(s => s.id === slideId);
        if (s) setSlide(s);
    }, [slideId, slides]);

    if (!slide) return <LoadingState message="Loading slide..." size="sm" />;

    return <SlideRenderer slide={slide} role="student" />;
}

function ConnectedStudentView({ session, shareToken }: { session: Session & { slides: Slide[]; isPresentationActive?: boolean; allowQuestions?: boolean }; shareToken: string }) {
    const { state, isConnected, sendMessage, lastSlideUpdate } = useWebSocket();
    const [slides, setSlides] = useState<Slide[]>(session.slides || []);
    const [showQA, setShowQA] = useState(false);
    const [globalQuestion, setGlobalQuestion] = useState('');
    const [selectedSlideId, setSelectedSlideId] = useState<string>(''); // No default selection



    // Refetch slides when notified of updates
    useEffect(() => {
        if (lastSlideUpdate > 0) {
            getSessionByToken(shareToken).then(data => {
                if (data && data.slides) {
                    setSlides(data.slides);
                }
            }).catch(err => console.error('Failed to update slides:', err));
        }
    }, [lastSlideUpdate, shareToken]);

    const handleGlobalSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!globalQuestion.trim() || !selectedSlideId) return;

        // Send slide ID as null for "overall" and "vibe", or the actual slide ID
        const slideIdToSend = (selectedSlideId === 'overall' || selectedSlideId === 'vibe') ? null : selectedSlideId;

        sendMessage('SUBMIT_QUESTION', {
            content: globalQuestion,
            slideId: slideIdToSend,
            category: selectedSlideId === 'overall' ? 'overall' : selectedSlideId === 'vibe' ? 'vibe' : 'slide'
        });
        setGlobalQuestion('');
        setSelectedSlideId(''); // Reset to empty
        setShowQA(false);
    };

    // Determine if presentation is active
    const isLive = state?.isPresentationActive !== undefined ? state.isPresentationActive : session.isPresentationActive;

    if (!isLive) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4 animate-fade-in">
                <Card className="w-full max-w-md text-center shadow-xl border-slate-200">
                    <CardHeader>
                        <div className="mx-auto w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mb-6 animate-pulse">
                            <span className="text-4xl">⏳</span>
                        </div>
                        <CardTitle className="text-2xl font-bold text-slate-900">Waiting for session to start</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-slate-500 text-lg mb-6">
                            The presenter hasn't started the session yet.
                            Sit tight, it will begin shortly!
                        </p>
                        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-slate-100 text-slate-600 text-sm font-medium">
                            {isConnected ? (
                                <>
                                    <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                                    Connected to server
                                </>
                            ) : (
                                <>
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    Connecting...
                                </>
                            )}
                        </div>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-50 p-4 pb-24 relative animate-fade-in">
            <div className="max-w-md mx-auto space-y-4 h-full">
                <div className="flex justify-center mb-4">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white border shadow-sm text-xs font-medium text-slate-500">
                        {isConnected ? (
                            <>
                                <span className="w-2 h-2 rounded-full bg-green-500" />
                                Live
                            </>
                        ) : (
                            <>
                                <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
                                Reconnecting...
                            </>
                        )}
                    </div>
                </div>

                {state?.currentSlideId ? (
                    <div className="h-full">
                        <StudentSlideView slideId={state.currentSlideId} slides={slides} />
                    </div>
                ) : (
                    <Card className="shadow-md">
                        <CardContent className="p-8 text-center">
                            <div className="mx-auto w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                                <User className="w-8 h-8 text-slate-400" />
                            </div>
                            <h2 className="text-xl font-bold mb-2 text-slate-900">Waiting for teacher...</h2>
                            <p className="text-slate-500">The presentation hasn't started yet or no slide is currently active.</p>
                        </CardContent>
                    </Card>
                )}
            </div>

            {/* Floating Ask Question Button */}
            {session?.allowQuestions && (
                <div className="fixed bottom-6 right-6 z-40">
                    <Button
                        variant="default"
                        size="lg"
                        className="rounded-full shadow-lg bg-blue-600 hover:bg-blue-700 text-white h-14 px-6 transition-transform hover:scale-105 active:scale-95"
                        onClick={() => setShowQA(true)}
                    >
                        <MessageSquare className="mr-2 h-5 w-5" /> Ask Question
                    </Button>
                </div>
            )}

            {/* Q&A Dialog with Slide Selector */}
            <Dialog
                isOpen={showQA}
                onClose={() => setShowQA(false)}
                title="Ask a Question"
                description="Select which slide your question is about, or choose Overall/Vibe."
            >
                <form onSubmit={handleGlobalSubmit} className="space-y-4">
                    {/* Slide Selector */}
                    <div className="space-y-2">
                        <label className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                            Question About
                            {!selectedSlideId && <span className="text-xs font-normal text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full animate-pulse">Required</span>}
                        </label>
                        <select
                            value={selectedSlideId}
                            onChange={(e) => setSelectedSlideId(e.target.value)}
                            className={`w-full p-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-base bg-white transition-all ${!selectedSlideId ? 'border-amber-300 ring-4 ring-amber-50' : 'border-slate-200'}`}
                            required
                            autoFocus
                        >
                            <option value="" disabled>-- Select a topic to start --</option>
                            <option value="overall">📚 Overall Session</option>
                            <option value="vibe">💭 Vibe / Feedback</option>
                            <optgroup label="Specific Slides">
                                {slides.filter(s => !s.isHidden).map((slide, index) => {
                                    const question = slide.content?.question || slide.content?.title || `Slide ${index + 1}`;
                                    return (
                                        <option key={slide.id} value={slide.id}>
                                            #{index + 1}: {question}
                                        </option>
                                    );
                                })}
                            </optgroup>
                        </select>
                        {!selectedSlideId && (
                            <p className="text-xs text-slate-500">
                                👆 Please choose what your question is related to first.
                            </p>
                        )}
                    </div>

                    {/* Question Input */}
                    <div className="space-y-2">
                        <label className={`text-sm font-semibold transition-colors ${!selectedSlideId ? 'text-slate-400' : 'text-slate-700'}`}>
                            Your Question
                        </label>
                        <div className="relative">
                            <textarea
                                className="w-full p-4 border border-slate-200 rounded-xl min-h-[120px] focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none resize-none text-base text-slate-900 bg-white disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors"
                                placeholder={selectedSlideId ? "What would you like to ask?" : "Select a topic above to start typing..."}
                                value={globalQuestion}
                                onChange={(e) => setGlobalQuestion(e.target.value)}
                                required
                                disabled={!selectedSlideId}
                            />
                            {!selectedSlideId && (
                                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                    <span className="text-slate-400 text-sm font-medium bg-white/80 px-3 py-1 rounded-full backdrop-blur-sm border border-slate-100 shadow-sm">
                                        🔒 Select topic to unlock
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>

                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => setShowQA(false)}>Cancel</Button>
                        <Button
                            type="submit"
                            disabled={!globalQuestion.trim() || !selectedSlideId}
                            className={!selectedSlideId ? "opacity-50 cursor-not-allowed" : ""}
                        >
                            Submit Question
                        </Button>
                    </DialogFooter>
                </form>
            </Dialog>
        </div>
    );
}

export default function StudentSession() {
    const params = useParams();
    const id = params?.id as string;
    const [session, setSession] = useState<any | null>(null);
    const [studentName, setStudentName] = useState('');
    const [hasJoined, setHasJoined] = useState(false);
    const [loading, setLoading] = useState(true);
    const [joining, setJoining] = useState(false);

    useEffect(() => {
        if (id) {
            getSessionByToken(id).then(data => {
                setSession(data);
                const storedName = localStorage.getItem(`studentName_${id}`);

                if (storedName && storedName.trim()) {
                    setStudentName(storedName);
                    setHasJoined(true);
                } else if (data.requireName === false) {
                    setHasJoined(true);
                }
            }).catch(err => {
                console.error('Failed to load session:', err);
            }).finally(() => {
                setLoading(false);
            });
        }
    }, [id]);

    const handleJoin = (e: React.FormEvent) => {
        e.preventDefault();
        if (!session) return;
        if (session.requireName && !studentName.trim()) return;

        setJoining(true);
        // Simulate small delay for UX
        setTimeout(() => {
            if (studentName.trim()) {
                localStorage.setItem(`studentName_${id}`, studentName);
            }
            setHasJoined(true);
            setJoining(false);
        }, 500);
    };

    if (!id) return null;

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-50">
                <LoadingState message="Loading session..." />
            </div>
        );
    }

    if (!session) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
                <Card className="w-full max-w-md text-center p-8">
                    <div className="mx-auto w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mb-4">
                        <span className="text-2xl">❌</span>
                    </div>
                    <h2 className="text-xl font-bold text-slate-900 mb-2">Session Not Found</h2>
                    <p className="text-slate-500">The session code you entered is invalid or the session has ended.</p>
                    <Button className="mt-6 w-full" onClick={() => window.location.href = '/student/join'}>
                        Go Back
                    </Button>
                </Card>
            </div>
        );
    }

    if (!hasJoined) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-blue-50 p-4">
                <Card className="w-full max-w-md shadow-xl border-slate-200 animate-scale-in">
                    <CardHeader className="text-center pb-2">
                        <div className="mx-auto w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-xl shadow-lg shadow-blue-600/20 mb-4">
                            {session.title.charAt(0).toUpperCase()}
                        </div>
                        <CardTitle className="text-2xl font-bold text-slate-900">{session.title}</CardTitle>
                        <CardDescription>
                            {session.requireName ? 'Please enter your name to join' : 'Enter your name (optional)'}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleJoin} className="space-y-4 mt-4">
                            <div className="space-y-2">
                                <Input
                                    placeholder={session.requireName ? "Your Name" : "Your Name (or join anonymously)"}
                                    value={studentName}
                                    onChange={(e) => setStudentName(e.target.value)}
                                    required={session.requireName}
                                    className="h-12 text-lg"
                                    autoFocus
                                    disabled={joining}
                                />
                            </div>
                            <Button
                                type="submit"
                                className="w-full h-12 text-base font-semibold bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-600/20 transition-all hover:-translate-y-0.5"
                                disabled={joining || (session.requireName && !studentName.trim())}
                            >
                                {joining ? (
                                    <>
                                        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                                        Joining...
                                    </>
                                ) : (
                                    <>
                                        Join Session <ArrowRight className="ml-2 h-5 w-5" />
                                    </>
                                )}
                            </Button>
                        </form>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <WebSocketProvider sessionId={session.id} role="student" name={studentName}>
            <ConnectedStudentView session={session} shareToken={id} />
        </WebSocketProvider>
    );
}
