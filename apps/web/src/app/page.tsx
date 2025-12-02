'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Session } from 'shared';
import { getSessions, createSession, duplicateSession, archiveSession, restoreSession } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Plus, Play, BarChart, Copy, Archive, RotateCcw, LogOut, Loader2 } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoadingState, EmptyState, CardSkeleton } from '@/components/ui/loading';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

export default function Dashboard() {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [authChecking, setAuthChecking] = useState(true);
  const [user, setUser] = useState<{ name: string } | null>(null);
  const [activeTab, setActiveTab] = useState("active");

  // Dialog States
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'duplicate' | 'archive' | 'restore', id: string, title: string } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Create Session Form State
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [allowQuestions, setAllowQuestions] = useState(true);
  const [requireName, setRequireName] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('token');
    const userStr = localStorage.getItem('user');
    if (!token || !userStr) {
      router.push('/login');
      return;
    }
    setUser(JSON.parse(userStr));
    setAuthChecking(false);
    loadSessions("active");
  }, [router]);

  function handleLogout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    router.push('/login');
  }

  async function loadSessions(status: string) {
    setLoading(true);
    try {
      const data = await getSessions(status === "active" ? "" : "archived");
      setSessions(data);
    } catch (e) {
      console.error(e);
      toast.error("Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!newSessionTitle.trim()) return;

    setActionLoading(true);
    try {
      await createSession(newSessionTitle, allowQuestions, requireName);
      toast.success("Session created successfully");
      setIsCreateOpen(false);
      setNewSessionTitle('');
      setAllowQuestions(true);
      setRequireName(false);
      loadSessions(activeTab);
    } catch (e) {
      toast.error("Failed to create session");
    } finally {
      setActionLoading(false);
    }
  }

  function openConfirmDialog(type: 'duplicate' | 'archive' | 'restore', id: string, title: string) {
    setConfirmAction({ type, id, title });
    setIsConfirmOpen(true);
  }

  async function handleConfirmAction() {
    if (!confirmAction) return;

    setActionLoading(true);
    try {
      if (confirmAction.type === 'duplicate') {
        await duplicateSession(confirmAction.id);
        toast.success("Session duplicated");
      } else if (confirmAction.type === 'archive') {
        await archiveSession(confirmAction.id);
        toast.success("Session archived");
      } else if (confirmAction.type === 'restore') {
        await restoreSession(confirmAction.id);
        toast.success("Session restored");
      }
      loadSessions(activeTab);
      setIsConfirmOpen(false);
    } catch (e) {
      toast.error(`Failed to ${confirmAction.type} session`);
    } finally {
      setActionLoading(false);
    }
  }

  // Show loading screen while checking auth
  if (authChecking) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 bg-gradient-to-br from-blue-600 to-blue-700 rounded-xl flex items-center justify-center text-white font-bold text-2xl shadow-lg shadow-blue-600/20 animate-pulse">C</div>
          <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-gradient-to-br from-blue-600 to-blue-700 rounded-xl flex items-center justify-center text-white font-bold text-lg shadow-lg shadow-blue-600/20">C</div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">ClassColab</h1>
          </div>
          <div className="flex items-center gap-4">
            {user && (
              <div className="hidden md:flex items-center gap-3 px-4 py-2 bg-slate-50 rounded-full border border-slate-200">
                <div className="w-7 h-7 bg-gradient-to-br from-blue-500 to-blue-600 rounded-full flex items-center justify-center text-xs font-bold text-white shadow-sm">
                  {user.name.charAt(0).toUpperCase()}
                </div>
                <span className="text-sm font-medium text-slate-700">{user.name}</span>
              </div>
            )}
            <Button variant="ghost" onClick={handleLogout} size="sm" className="text-slate-600 hover:text-red-600 hover:bg-red-50 gap-2">
              <LogOut className="w-4 h-4" /> Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-12">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-4 animate-slide-up">
          <div>
            <h2 className="heading-2 text-slate-900">My Sessions</h2>
            <p className="text-slate-500 mt-2 body-base">Manage your presentations and interactive classes.</p>
          </div>
          <div className="flex gap-3">
            <Link href="/student/join">
              <Button variant="outline" className="border-slate-200 hover:bg-slate-50 hover:text-slate-900">
                Join as Student
              </Button>
            </Link>
            <Button onClick={() => setIsCreateOpen(true)} className="shadow-lg shadow-blue-600/20 hover:-translate-y-0.5 transition-all bg-blue-600 hover:bg-blue-700">
              <Plus className="mr-2 h-4 w-4" /> New Session
            </Button>
          </div>
        </div>

        <Tabs defaultValue="active" className="w-full animate-fade-in" onValueChange={(val: string) => { setActiveTab(val); loadSessions(val); }}>
          <TabsList className="mb-8 bg-white p-1.5 rounded-xl border border-slate-200 shadow-sm inline-flex">
            <TabsTrigger value="active" className="rounded-lg px-5 py-2.5 text-sm font-semibold transition-all data-[state=active]:bg-blue-50 data-[state=active]:text-blue-700 data-[state=active]:shadow-sm">
              Active Sessions
            </TabsTrigger>
            <TabsTrigger value="archived" className="rounded-lg px-5 py-2.5 text-sm font-semibold transition-all data-[state=active]:bg-slate-100 data-[state=active]:text-slate-900 data-[state=active]:shadow-sm">
              Archived
            </TabsTrigger>
          </TabsList>

          <TabsContent value="active" className="mt-0">
            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {[1, 2, 3].map(i => (
                  <CardSkeleton key={i} />
                ))}
              </div>
            ) : (
              <SessionGrid
                sessions={sessions}
                onDuplicate={(id, title) => openConfirmDialog('duplicate', id, title)}
                onArchive={(id, title) => openConfirmDialog('archive', id, title)}
                isArchived={false}
              />
            )}
          </TabsContent>

          <TabsContent value="archived" className="mt-0">
            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {[1, 2, 3].map(i => (
                  <CardSkeleton key={i} />
                ))}
              </div>
            ) : (
              <SessionGrid
                sessions={sessions}
                onDuplicate={(id, title) => openConfirmDialog('duplicate', id, title)}
                onArchive={(id, title) => openConfirmDialog('restore', id, title)}
                isArchived={true}
              />
            )}
          </TabsContent>
        </Tabs>
      </main>

      {/* Create Session Dialog */}
      <Dialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Create New Session"
        description="Set up a new interactive session for your class."
      >
        <form onSubmit={handleCreateSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="title">Session Title</Label>
            <Input
              id="title"
              placeholder="e.g. Introduction to Physics"
              value={newSessionTitle}
              onChange={(e) => setNewSessionTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 border rounded-lg hover:bg-slate-50 transition-colors cursor-pointer" onClick={() => setAllowQuestions(!allowQuestions)}>
              <div>
                <Label className="cursor-pointer">Allow Questions</Label>
                <p className="text-xs text-slate-500">Students can ask questions on any slide</p>
              </div>
              <input
                type="checkbox"
                checked={allowQuestions}
                onChange={(e) => setAllowQuestions(e.target.checked)}
                className="w-5 h-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
            </div>

            <div className="flex items-center justify-between p-3 border rounded-lg hover:bg-slate-50 transition-colors cursor-pointer" onClick={() => setRequireName(!requireName)}>
              <div>
                <Label className="cursor-pointer">Require Name</Label>
                <p className="text-xs text-slate-500">Students must enter a name to join</p>
              </div>
              <input
                type="checkbox"
                checked={requireName}
                onChange={(e) => setRequireName(e.target.checked)}
                className="w-5 h-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!newSessionTitle.trim() || actionLoading}>
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Session
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* Confirmation Dialog */}
      <Dialog
        isOpen={isConfirmOpen}
        onClose={() => setIsConfirmOpen(false)}
        title={confirmAction?.type === 'duplicate' ? 'Duplicate Session' : confirmAction?.type === 'archive' ? 'Archive Session' : 'Restore Session'}
        description={`Are you sure you want to ${confirmAction?.type} "${confirmAction?.title}"?`}
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setIsConfirmOpen(false)}>Cancel</Button>
          <Button
            variant={confirmAction?.type === 'archive' ? 'destructive' : 'default'}
            onClick={handleConfirmAction}
            disabled={actionLoading}
          >
            {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmAction?.type === 'duplicate' ? 'Duplicate' : confirmAction?.type === 'archive' ? 'Archive' : 'Restore'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

function SessionGrid({ sessions, onDuplicate, onArchive, isArchived }: { sessions: Session[], onDuplicate: (id: string, title: string) => void, onArchive: (id: string, title: string) => void, isArchived: boolean }) {
  if (sessions.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-dashed border-slate-300">
        <EmptyState
          icon={<BarChart className="w-16 h-16 text-slate-300" />}
          title={isArchived ? "No archived sessions" : "No active sessions"}
          description={isArchived ? "Archived sessions will appear here." : "Get started by creating a new presentation session for your class."}
        />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {sessions.map((session) => (
        <Card key={session.id} className="group hover:shadow-xl hover:shadow-slate-200/50 hover:border-slate-300 transition-all duration-300 overflow-hidden flex flex-col animate-scale-in">
          <CardHeader className="pb-4 border-b border-slate-100 bg-gradient-to-br from-slate-50 to-white">
            <div className="flex justify-between items-start mb-3">
              <div className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide border shadow-sm ${session.status === 'published'
                ? 'bg-blue-50 text-blue-700 border-blue-100'
                : 'bg-slate-100 text-slate-600 border-slate-200'
                }`}>
                {session.status}
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors" onClick={() => onDuplicate(session.id, session.title)} title="Duplicate">
                  <Copy className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors" onClick={() => onArchive(session.id, session.title)} title={isArchived ? "Restore" : "Archive"}>
                  {isArchived ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <CardTitle className="text-xl font-bold text-slate-900 leading-tight line-clamp-2 min-h-[3.5rem]" title={session.title}>
              {session.title}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6 flex-1">
            <div className="flex items-center gap-4 text-sm text-slate-500">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center">
                  <BarChart className="w-4 h-4 text-slate-600" />
                </div>
                <span className="font-medium">{session.slideCount || 0} {session.slideCount === 1 ? 'Slide' : 'Slides'}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
                <span>Updated {new Date(session.updatedAt).toLocaleDateString()}</span>
              </div>
            </div>
          </CardContent>
          <CardFooter className="pt-0 pb-6 px-6">
            <Link href={`/staff/session/${session.id}`} className="w-full">
              <Button className="w-full bg-white border-2 border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-blue-400 hover:text-blue-600 group-hover:border-blue-500 group-hover:bg-blue-600 group-hover:text-white transition-all shadow-sm">
                {isArchived ? 'View Session' : 'Open Editor'} <Play className="ml-2 w-3.5 h-3.5 opacity-70 group-hover:opacity-100" />
              </Button>
            </Link>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
