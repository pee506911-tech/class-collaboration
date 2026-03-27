'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Loader2, ArrowRight } from 'lucide-react';
import { mapHttpErrorToUiMessage, formatRequestId } from '@/lib/http-error-ui';
import { getPublicSessionByToken, isValidJoinCode, normalizeJoinCode, writePreloadedPublicSession } from '@/lib/public-session';

export default function StudentJoin() {
    const [code, setCode] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<{ title: string; description: string; requestId?: string; retryable?: boolean } | null>(null);
    const router = useRouter();

    const normalizedCode = useMemo(() => normalizeJoinCode(code), [code]);
    const isValidCode = useMemo(() => isValidJoinCode(normalizedCode), [normalizedCode]);

    async function attemptJoin(token: string) {
        if (isLoading) return;
        setIsLoading(true);
        setError(null);

        const result = await getPublicSessionByToken(token, { timeoutMs: 10_000 });
        setIsLoading(false);

        if (result.ok) {
            writePreloadedPublicSession(token, result.data, result.requestId);
            router.push(`/student/session/${token}`);
            return;
        }

        if (result.status === 404) {
            setError({
                title: 'Invalid or expired code',
                description: 'Double-check the code and try again.',
                requestId: result.requestId,
                retryable: false,
            });
            return;
        }

        const ui = mapHttpErrorToUiMessage(result);
        setError({
            title: ui.title,
            description: ui.description,
            requestId: result.requestId,
            retryable: ui.retryable,
        });
    }

    async function handleJoin(e: React.FormEvent) {
        e.preventDefault();
        if (!isValidCode) {
            setError({
                title: 'Invalid code',
                description: 'Enter the 8-character code from your instructor (e.g. deadbeef).',
                retryable: false,
            });
            return;
        }

        await attemptJoin(normalizedCode);
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
                                placeholder="e.g. deadbeef"
                                value={code}
                                onChange={(e) => {
                                    setCode(e.target.value);
                                    if (error) setError(null);
                                }}
                                className="text-center text-lg tracking-widest uppercase h-12 border-slate-300 focus:border-blue-500 focus:ring-blue-500"
                                autoFocus
                                disabled={isLoading}
                            />
                        </div>
                        {error ? (
                            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-900">
                                <p className="text-sm font-semibold">{error.title}</p>
                                <p className="text-xs text-rose-800 mt-1">{error.description}</p>
                                {formatRequestId(error.requestId) ? (
                                    <p className="text-[10px] text-rose-700 mt-2 font-mono">
                                        Request ID: {formatRequestId(error.requestId)}
                                    </p>
                                ) : null}
                                <div className="mt-3">
                                    {error.retryable ? (
                                        <Button
                                            type="button"
                                            variant="outline"
                                            className="w-full border-rose-200 text-rose-700 hover:bg-rose-100"
                                            onClick={() => void attemptJoin(normalizedCode)}
                                            disabled={!isValidCode || isLoading}
                                        >
                                            Retry
                                        </Button>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}
                        <Button
                            type="submit"
                            className="w-full h-12 text-base font-semibold bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-600/20 transition-all hover:-translate-y-0.5"
                            disabled={!isValidCode || isLoading}
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
