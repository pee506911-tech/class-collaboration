'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Loader2, ArrowRight } from 'lucide-react';

export default function StudentJoin() {
    const [code, setCode] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const router = useRouter();

    function handleJoin(e: React.FormEvent) {
        e.preventDefault();
        if (code.trim()) {
            setIsLoading(true);
            // Simulate a small delay for better UX or just push
            router.push(`/student/session/${code.trim()}`);
        }
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
            <Card className="w-full max-w-md shadow-xl border-slate-200 animate-scale-in">
                <CardHeader className="text-center pb-2">
                    <div className="mx-auto w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-xl shadow-lg shadow-blue-600/20 mb-4">
                        C
                    </div>
                    <CardTitle className="text-2xl font-bold text-slate-900">Join Session</CardTitle>
                    <CardDescription>Enter the code provided by your instructor</CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleJoin} className="space-y-4 mt-4">
                        <div className="space-y-2">
                            <Input
                                placeholder="e.g. abc-123"
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                className="text-center text-lg tracking-widest uppercase h-12 border-slate-300 focus:border-blue-500 focus:ring-blue-500"
                                autoFocus
                                disabled={isLoading}
                            />
                        </div>
                        <Button
                            type="submit"
                            className="w-full h-12 text-base font-semibold bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-600/20 transition-all hover:-translate-y-0.5"
                            disabled={!code.trim() || isLoading}
                        >
                            {isLoading ? (
                                <>
                                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                                    Joining...
                                </>
                            ) : (
                                <>
                                    Join Class <ArrowRight className="ml-2 h-5 w-5" />
                                </>
                            )}
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </div>
    );
}
