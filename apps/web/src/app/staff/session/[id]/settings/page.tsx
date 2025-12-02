'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Session } from 'shared';
import { getSession, updateSession, deleteSession } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Save, Trash2, AlertTriangle, Copy, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { SessionDashboard } from '@/components/session-dashboard';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WebSocketProvider } from '@/lib/websocket';

export default function SessionSettingsPage() {
    const params = useParams();
    const router = useRouter();
    const id = params?.id as string;
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);
    const [authChecked, setAuthChecked] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    const [saveLoading, setSaveLoading] = useState(false);

    useEffect(() => {
        // Check auth first
        const token = localStorage.getItem('token');
        if (!token) {
            router.push('/login');
            return;
        }
        setAuthChecked(true);
        
        if (id) {
            loadSession();
        }
    }, [id, router]);

    async function loadSession() {
        try {
            const data = await getSession(id);
            setSession(data);
            setEditTitle(data.title);
        } catch (e) {
            console.error(e);
            toast.error('Failed to load session details');
        } finally {
            setLoading(false);
        }
    }

    const handleSaveSettings = async () => {
        if (!session) return;
        try {
            await updateSession(session.id, editTitle, session.allowQuestions, session.requireName);
            loadSession();
            toast.success('Settings saved successfully');
        } catch (e) {
            toast.error('Failed to save settings');
        }
    };

    const handleDeleteSession = async () => {
        if (!confirm('Are you absolutely sure? This action cannot be undone.')) return;
        try {
            await deleteSession(id);
            toast.success('Session deleted');
            router.push('/');
        } catch (e) {
            toast.error('Failed to delete session');
        }
    };

    if (!id || !authChecked) return null;
    if (loading) return <div className="min-h-screen flex items-center justify-center text-slate-500">Loading...</div>;

    return (
        <WebSocketProvider sessionId={id} role="staff">
            <div className="min-h-screen bg-slate-50/50 p-8 font-sans">
                <div className="max-w-6xl mx-auto space-y-8">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <Link href={`/staff/session/${id}`}>
                                <Button variant="ghost" size="sm" className="hover:bg-slate-100">
                                    <ArrowLeft className="w-4 h-4 mr-2" /> Back to Editor
                                </Button>
                            </Link>
                            <div>
                                <h1 className="text-3xl font-bold tracking-tight text-slate-900">Session Settings</h1>
                                <p className="text-slate-500">Manage your session configuration and view analytics.</p>
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                        {/* Left Column: Settings */}
                        <div className="lg:col-span-1 space-y-6">
                            <Card>
                                <CardHeader>
                                    <CardTitle>General Configuration</CardTitle>
                                    <CardDescription>Basic settings for your session.</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-6">
                                    <div className="space-y-2">
                                        <Label htmlFor="title">Session Title</Label>
                                        <Input
                                            id="title"
                                            value={editTitle}
                                            onChange={(e) => setEditTitle(e.target.value)}
                                            placeholder="Enter session title"
                                        />
                                    </div>

                                    <div className="space-y-4 pt-2">
                                        <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border">
                                            <div className="space-y-0.5">
                                                <Label htmlFor="qa-toggle" className="text-base">Q&A</Label>
                                                <p className="text-xs text-slate-500">Allow students to ask questions</p>
                                            </div>
                                            <input
                                                type="checkbox"
                                                id="qa-toggle"
                                                className="w-5 h-5 accent-blue-600"
                                                checked={session?.allowQuestions || false}
                                                onChange={(e) => {
                                                    if (session) updateSession(session.id, undefined, e.target.checked, undefined).then(loadSession);
                                                }}
                                            />
                                        </div>

                                        <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border">
                                            <div className="space-y-0.5">
                                                <Label htmlFor="name-toggle" className="text-base">Require Name</Label>
                                                <p className="text-xs text-slate-500">Force students to enter a name</p>
                                            </div>
                                            <input
                                                type="checkbox"
                                                id="name-toggle"
                                                className="w-5 h-5 accent-blue-600"
                                                checked={session?.requireName || false}
                                                onChange={(e) => {
                                                    if (session) updateSession(session.id, undefined, undefined, e.target.checked).then(loadSession);
                                                }}
                                            />
                                        </div>
                                    </div>

                                    <Button
                                        onClick={async () => {
                                            if (!session) return;
                                            try {
                                                setSaveLoading(true);
                                                await updateSession(session.id, editTitle, undefined, undefined);
                                                await loadSession(); // Reload to get updated data
                                                toast.success('Session title updated');
                                            } catch (e) {
                                                toast.error('Failed to update title');
                                            } finally {
                                                setSaveLoading(false);
                                            }
                                        }}
                                        className="w-full"
                                        disabled={saveLoading}
                                    >
                                        {saveLoading ? 'Saving...' : 'Save Changes'}
                                    </Button>
                                </CardContent>
                            </Card>

                            {/* Student Join Code Card */}
                            <Card>
                                <CardHeader>
                                    <CardTitle>Student Join Code</CardTitle>
                                    <CardDescription>Share this code or link with students to join the session.</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                                        <p className="text-sm text-green-900 mb-2 font-medium">
                                            🎓 Students use this to join your live session
                                        </p>
                                        <div className="space-y-3">
                                            {/* Join Code */}
                                            <div>
                                                <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1 block">
                                                    Join Code
                                                </label>
                                                <div className="flex gap-2">
                                                    <Input
                                                        readOnly
                                                        value={session?.shareToken || ''}
                                                        className="bg-white font-mono text-2xl font-bold text-center tracking-wider"
                                                    />
                                                    <Button
                                                        variant="outline"
                                                        onClick={() => {
                                                            if (session?.shareToken) {
                                                                navigator.clipboard.writeText(session.shareToken);
                                                                toast.success('Join code copied!');
                                                            }
                                                        }}
                                                    >
                                                        <Copy className="w-4 h-4 mr-2" />
                                                        Copy
                                                    </Button>
                                                </div>
                                            </div>

                                            {/* Join Link */}
                                            <div>
                                                <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1 block">
                                                    Direct Link
                                                </label>
                                                <div className="flex gap-2">
                                                    <Input
                                                        readOnly
                                                        value={`${window.location.origin}/student/session/${session?.shareToken || ''}`}
                                                        className="bg-white font-mono text-sm"
                                                    />
                                                    <Button
                                                        variant="outline"
                                                        onClick={() => {
                                                            if (session?.shareToken) {
                                                                navigator.clipboard.writeText(`${window.location.origin}/student/session/${session.shareToken}`);
                                                                toast.success('Join link copied!');
                                                            }
                                                        }}
                                                    >
                                                        <Copy className="w-4 h-4 mr-2" />
                                                        Copy
                                                    </Button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <p className="text-xs text-slate-500">
                                        Students can either enter the code at the join page, or use the direct link to join instantly.
                                    </p>
                                </CardContent>
                            </Card>

                            {/* Share Dashboard Card */}
                            <Card>
                                <CardHeader>
                                    <CardTitle>Share Dashboard</CardTitle>
                                    <CardDescription>Share a public, read-only dashboard link with anyone.</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                                        <p className="text-sm text-blue-900 mb-2 font-medium">
                                            📊 Anyone with this link can view live analytics
                                        </p>
                                        <div className="flex gap-2">
                                            <Input
                                                readOnly
                                                value={`${window.location.origin}/dashboard/${session?.shareToken || ''}`}
                                                className="bg-white font-mono text-sm"
                                            />
                                            <Button
                                                variant="outline"
                                                onClick={() => {
                                                    if (session?.shareToken) {
                                                        navigator.clipboard.writeText(`${window.location.origin}/dashboard/${session.shareToken}`);
                                                        toast.success('Dashboard link copied!');
                                                    }
                                                }}
                                            >
                                                <Copy className="w-4 h-4 mr-2" />
                                                Copy
                                            </Button>
                                        </div>
                                    </div>
                                    <div className="flex gap-2">
                                        <Button
                                            variant="outline"
                                            className="flex-1"
                                            onClick={() => {
                                                if (session?.shareToken) {
                                                    window.open(`/dashboard/${session.shareToken}`, '_blank');
                                                }
                                            }}
                                        >
                                            <ExternalLink className="w-4 h-4 mr-2" />
                                            Open Dashboard
                                        </Button>
                                    </div>
                                    <p className="text-xs text-slate-500">
                                        The public dashboard updates in real-time and requires no login. Perfect for displaying on external monitors or sharing with stakeholders.
                                    </p>
                                </CardContent>
                            </Card>

                            <Card className="border-red-200 bg-red-50/50">
                                <CardHeader>
                                    <CardTitle className="text-red-600 flex items-center gap-2">
                                        <AlertTriangle className="w-5 h-5" /> Danger Zone
                                    </CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <p className="text-sm text-slate-600 mb-4">
                                        Deleting a session is irreversible. All slides, votes, and questions will be permanently removed.
                                    </p>
                                    <Button variant="destructive" onClick={handleDeleteSession} className="w-full bg-red-600 hover:bg-red-700">
                                        <Trash2 className="w-4 h-4 mr-2" /> Delete Session
                                    </Button>
                                </CardContent>
                            </Card>
                        </div>

                        {/* Right Column: Dashboard */}
                        <div className="lg:col-span-2">
                            <Card className="h-full">
                                <CardHeader>
                                    <CardTitle>Analytics Dashboard</CardTitle>
                                    <CardDescription>Real-time insights and engagement metrics.</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <SessionDashboard sessionId={id} />
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                </div>
            </div>
        </WebSocketProvider>
    );
}
