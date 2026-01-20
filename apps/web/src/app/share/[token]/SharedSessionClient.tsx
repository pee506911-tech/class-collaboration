"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSharedSession, SharedSessionData } from "@/lib/api";

const POLL_INTERVAL_MS = 5000;

export default function SharedSessionClient({ token }: { token: string }) {
    const [session, setSession] = useState<SharedSessionData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!token) return;

        setLoading(true);
        setError("");

        const controller = new AbortController();
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let isFirstLoad = true;

        const poll = async () => {
            try {
                const data = await getSharedSession(token, { signal: controller.signal });
                setSession(data);
                setError("");
            } catch (err: unknown) {
                if (controller.signal.aborted) return;
                setError(err instanceof Error ? err.message : "Failed to load session");
            } finally {
                if (isFirstLoad) {
                    setLoading(false);
                    isFirstLoad = false;
                }
                if (!controller.signal.aborted) {
                    timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
                }
            }
        };

        void poll();

        return () => {
            controller.abort();
            if (timeoutId) clearTimeout(timeoutId);
        };
    }, [token]);

    const slideIndexById = useMemo(() => {
        const map = new Map<string, number>();
        if (!session) return map;
        session.slides.forEach((slide, index) => map.set(slide.id, index));
        return map;
    }, [session]);

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
                                                    {slide.content.options?.map((opt: { id: string; text: string }) => (
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
                                            {(() => {
                                                const votes: Record<string, number> = slide.stats?.votes ?? {};
                                                const total = Object.values(votes).reduce((a, b) => a + b, 0);

                                                return slide.content.options?.map((opt: { id: string; text: string }) => {
                                                    const count = votes[opt.id] || 0;
                                                    const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
                                                    return (
                                                        <div key={opt.id} className="flex items-center gap-3">
                                                            <div className="w-32 text-sm">{opt.text}</div>
                                                            <div className="flex-1 h-4 bg-gray-200 rounded-full overflow-hidden">
                                                                <div
                                                                    className="h-full bg-blue-500 transition-all duration-500"
                                                                    style={{ width: `${percentage}%` }}
                                                                />
                                                            </div>
                                                            <div className="w-16 text-sm text-right">{count} ({percentage}%)</div>
                                                        </div>
                                                    );
                                                });
                                            })()}
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
                                const slideIndex = q.slideId ? slideIndexById.get(q.slideId) : undefined;
                                const slideLabel = typeof slideIndex === 'number' ? `Slide ${slideIndex + 1}` : 'Global';

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
