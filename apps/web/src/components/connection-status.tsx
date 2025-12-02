'use client';

import { useWebSocket } from '@/lib/websocket';
import { AlertCircle, CheckCircle, Loader2 } from 'lucide-react';

export function ConnectionStatus() {
    const { isConnected, isConnecting, connectionError } = useWebSocket();

    if (isConnected) {
        return (
            <div className="flex items-center gap-2 text-xs text-green-600">
                <CheckCircle className="w-3 h-3" />
                <span>Connected</span>
            </div>
        );
    }

    if (isConnecting) {
        return (
            <div className="flex items-center gap-2 text-xs text-blue-600">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Connecting...</span>
            </div>
        );
    }

    if (connectionError) {
        return (
            <div className="flex items-center gap-2 text-xs text-red-600">
                <AlertCircle className="w-3 h-3" />
                <span>{connectionError}</span>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-2 text-xs text-slate-500">
            <div className="w-2 h-2 rounded-full bg-slate-400" />
            <span>Disconnected</span>
        </div>
    );
}
