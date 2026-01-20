"use client";

export const runtime = 'edge';

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Slide {
    id: string;
    type: string;
    content: any;
    orderIndex: number;
    stats?: {
        votes?: Record<string, number>;
    };
}

interface Question {
    id: string;
    content: string;
    upvotes: number;
    createdAt: string;
    slideId?: string;
}

interface SessionData {
    id: string;
    title: string;
    status: string;
    createdAt: string;
    slides: Slide[];
    questions: Question[];
    participants: { id: string; name: string; joinedAt: string }[];
}

export default function SharedSessionPage() {
    const params = useParams();
    const token = params.token as string;
    const [session, setSession] = useState<SessionData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!token) return;

        const fetchSession = async () => {
            try {
                const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'}/api/share/${token}`);
                if (!res.ok) {
                    throw new Error("Session not found");
                }
                const data = await res.json();
                if (data.success) {
                    setSession(data.data);
                } else {
                    setError("Failed to load session");
                }
            } catch (err: any) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        };

        fetchSession();
        // Poll every 5 seconds for updates
        const interval = setInterval(fetchSession, 5000);
        return () => clearInterval(interval);
    }, [token]);

    if (loading) return <div className="p-8 text-center">Loading session data...</div>;
    if (error) return <div className="p-8 text-center text-red-500">Error: {error}</div>;
    if (!session) return <div className="p-8 text-center">Session not found</div>;

    return (
        <div className="min-h-screen bg-gray-50 p-8">
            <div className="max-w-4xl mx-auto space-y-8">
                <div className="text-center">
                    <h1 className="text-3xl font-bold text-gray-900">{session.title}</h1>
                    <p className="text-gray-500">Session Results Dashboard</p>
                </div>

                <div className="grid gap-6">
                    <h2 className="text-2xl font-semibold text-gray-800">Slides Overview</h2>
                    {session.slides.map((slide, index) => (
                        <Card key={slide.id}>
                            <CardHeader>
                                <CardTitle className="text-lg flex justify-between">
                                    <span>Slide {index + 1}: {slide.type.toUpperCase()}</span>
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="mb-4">
                                    <h3 className="font-medium text-gray-700 mb-2">Content:</h3>
                                    <div className="p-4 bg-gray-100 rounded-md">
                                        {slide.type === 'poll' ? (
                                            <div>
                                                <p className="font-medium mb-2">{slide.content.question}</p>
                                                <ul className="list-disc pl-5">
                                                    {slide.content.options?.map((opt: any) => (
                                                        <li key={opt.id}>{opt.text}</li>
                                                    ))}
                                                </ul>
                                            </div>
                                        ) : (
                                            <pre className="whitespace-pre-wrap text-sm">{JSON.stringify(slide.content, null, 2)}</pre>
                                        )}
                                    </div>
                                </div>

                                {(slide.type === 'poll' || slide.type === 'quiz') && slide.stats?.votes && (
                                    <div>
                                        <h3 className="font-medium text-gray-700 mb-2">Results:</h3>
                                        <div className="space-y-2">
                                            {slide.content.options?.map((opt: any) => {
                                                const count = slide.stats?.votes?.[opt.id] || 0;
                                                const total = Object.values(slide.stats?.votes || {}).reduce((a, b) => a + b, 0);
                                                const percentage = total > 0 ? Math.round((count / total) * 100) : 0;

                                                return (
                                                    <div key={opt.id} className="flex items-center gap-4">
                                                        <div className="w-1/3 text-sm truncate">{opt.text}</div>
                                                        <div className="flex-1 h-4 bg-gray-200 rounded-full overflow-hidden">
                                                            <div
                                                                className="h-full bg-blue-500 transition-all duration-500"
                                                                style={{ width: `${percentage}%` }}
                                                            />
                                                        </div>
                                                        <div className="w-16 text-sm text-right">{count} ({percentage}%)</div>
                                                    </div>
                                                );
                                            })}
                                            <div className="mt-2 text-sm text-gray-500 text-right">
                                                Total Votes: {Object.values(slide.stats?.votes || {}).reduce((a, b) => a + b, 0)}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    ))}
                </div>

                <div className="space-y-6">
                    <h2 className="text-2xl font-semibold text-gray-800">Q&A Session</h2>
                    {session.questions.length === 0 ? (
                        <p className="text-gray-500 italic">No questions asked yet.</p>
                    ) : (
                        <div className="grid gap-4">
                            {session.questions.map((q) => {
                                const slide = session.slides.find(s => s.id === q.slideId);
                                const slideIndex = session.slides.findIndex(s => s.id === q.slideId);
                                const slideLabel = slide ? `Slide ${slideIndex + 1}` : 'Global';

                                return (
                                    <Card key={q.id}>
                                        <CardContent className="pt-6 flex justify-between items-start gap-4">
                                            <div>
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${q.slideId ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                                                        {slideLabel}
                                                    </span>
                                                </div>
                                                <p className="text-gray-900 font-medium">{q.content}</p>
                                                <p className="text-xs text-gray-500 mt-1">
                                                    {new Date(q.createdAt).toLocaleString()}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-1 bg-gray-100 px-3 py-1 rounded-full">
                                                <span className="text-sm font-bold text-blue-600">{q.upvotes}</span>
                                                <span className="text-xs text-gray-500">votes</span>
                                            </div>
                                        </CardContent>
                                    </Card>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="space-y-6">
                    <h2 className="text-2xl font-semibold text-gray-800">Participants ({session.participants.length})</h2>
                    {session.participants.length === 0 ? (
                        <p className="text-gray-500 italic">No participants yet.</p>
                    ) : (
                        <div className="grid gap-3">
                            {session.participants.map((p) => (
                                <Card key={p.id}>
                                    <CardContent className="pt-6 flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-400 to-purple-600 flex items-center justify-center text-white font-bold shadow-sm">
                                            {p.name.substring(0, 2).toUpperCase()}
                                        </div>
                                        <div>
                                            <p className="font-semibold text-gray-900">{p.name}</p>
                                            <p className="text-xs text-gray-500">
                                                Joined {new Date(p.joinedAt).toLocaleString()}
                                            </p>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
