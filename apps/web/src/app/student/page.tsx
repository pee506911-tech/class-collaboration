'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export default function StudentJoin() {
    const [sessionId, setSessionId] = useState('');
    const router = useRouter();

    const handleJoin = (e: React.FormEvent) => {
        e.preventDefault();
        if (sessionId.trim()) {
            router.push(`/student/session/${sessionId.trim()}`);
        }
    };

    return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
            <Card className="w-full max-w-md">
                <CardHeader>
                    <CardTitle className="text-center text-2xl font-bold text-blue-600">ClassColab</CardTitle>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleJoin} className="space-y-4">
                        <div className="space-y-2">
                            <label htmlFor="sessionId" className="text-sm font-medium text-slate-700">
                                Enter Session ID
                            </label>
                            <Input
                                id="sessionId"
                                placeholder="e.g. 123e4567-..."
                                value={sessionId}
                                onChange={(e) => setSessionId(e.target.value)}
                                required
                            />
                        </div>
                        <Button type="submit" className="w-full text-lg h-12">
                            Join Session
                        </Button>
                    </form>
                    <div className="mt-6 text-center text-sm text-slate-500">
                        Are you a presenter? <a href="/" className="text-blue-600 hover:underline">Go to Dashboard</a>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
