'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { SessionDashboard } from '@/components/session-dashboard';
import { Card, CardContent } from '@/components/ui/card';
import { BarChart2, Lock, AlertCircle } from 'lucide-react';
import { WebSocketProvider } from '@/lib/websocket';
import { getPublicSessionByShareToken } from '@/lib/api';

export default function PublicDashboardPage() {
    const params = useParams();
    const shareToken = params?.shareToken as string;
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [sessionTitle, setSessionTitle] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        async function fetchSessionInfo() {
            try {
                const session = await getPublicSessionByShareToken(shareToken);
                setSessionId(session.id);
                setSessionTitle(session.title);
            } catch (err: unknown) {
                setError(err instanceof Error ? err.message : 'Failed to load dashboard');
            } finally {
                setLoading(false);
            }
        }

        if (shareToken) {
            fetchSessionInfo();
        }
    }, [shareToken]);

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                    <p className="text-slate-500 font-medium">Loading dashboard...</p>
                </div>
            </div>
        );
    }

    if (error || !sessionId) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-4">
                <Card className="max-w-md w-full">
                    <CardContent className="p-8 text-center">
                        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                            <AlertCircle className="w-8 h-8 text-red-600" />
                        </div>
                        <h2 className="text-xl font-bold text-slate-900 mb-2">Dashboard Not Available</h2>
                        <p className="text-slate-600">{error || 'Invalid or expired share link'}</p>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
            {/* Header */}
            <div className="bg-white border-b shadow-sm sticky top-0 z-10">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-blue-100 rounded-lg">
                                <BarChart2 className="w-6 h-6 text-blue-600" />
                            </div>
                            <div>
                                <h1 className="text-xl font-bold text-slate-900">{sessionTitle}</h1>
                                <p className="text-sm text-slate-500">Live Dashboard</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-slate-500">
                            <Lock className="w-4 h-4" />
                            <span className="hidden sm:inline">Public View</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Dashboard Content */}
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                <WebSocketProvider sessionId={sessionId} role="staff">
                    <SessionDashboard sessionId={sessionId} isPublic={true} />
                </WebSocketProvider>
            </div>

            {/* Footer */}
            <div className="bg-white border-t mt-12">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
                    <p className="text-center text-sm text-slate-500">
                        This is a read-only public dashboard. Data updates automatically.
                    </p>
                </div>
            </div>
        </div>
    );
}
