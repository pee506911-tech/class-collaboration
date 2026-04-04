/**
 * Native WebSocket connection manager for the class-collaboration frontend.
 *
 * Replaces the Ably SDK with a direct WebSocket connection to the backend.
 * Handles:
 * - Token-based authentication
 * - Automatic reconnection with exponential backoff
 * - Message dispatch to handlers
 * - Connection state management
 */

import { fetchWsToken } from './ws-auth';
import { createReconnect } from './ws-reconnect';

export interface WsConnection {
    isConnected: boolean;
    isConnecting: boolean;
    connectionError: string | null;
    connect: () => void;
    disconnect: () => void;
    onMessage: (handler: (name: string, data: any) => void) => void;
}

export interface WsConnectionOptions {
    sessionId: string;
    role: 'staff' | 'student' | 'projector';
    participantId?: string;
    participantIdRef?: React.MutableRefObject<string>;
    onStateChange?: (state: { isConnected: boolean; isConnecting: boolean; error: string | null }) => void;
    apiUrl?: string;
    wsUrl?: string;
}

export function createWsConnection(options: WsConnectionOptions): WsConnection {
    const {
        sessionId,
        role,
        participantId,
        participantIdRef,
        onStateChange,
    } = options;

    const apiBase = options.apiUrl || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
    const wsBase = options.wsUrl || process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8080';

    let ws: WebSocket | null = null;
    let messageHandler: ((name: string, data: any) => void) | null = null;
    let isConnecting = false;
    let isConnected = false;
    let connectionError: string | null = null;
    let isDestroyed = false;

    const reconnect = createReconnect({
        baseDelay: 1000,
        maxDelay: 30000,
        maxAttempts: 10,
        onReconnect: (attempt) => {
            if (!isDestroyed) {
                console.log(`[WS] Reconnecting (attempt ${attempt + 1})...`);
                connect();
            }
        },
        onMaxAttempts: () => {
            if (!isDestroyed) {
                connectionError = 'Connection lost. Please refresh the page.';
                isConnecting = false;
                notifyStateChange();
            }
        },
    });

    function notifyStateChange() {
        onStateChange?.({
            isConnected,
            isConnecting,
            error: connectionError,
        });
    }

    async function connect() {
        if (isDestroyed || ws?.readyState === WebSocket.OPEN) return;

        isConnecting = true;
        connectionError = null;
        notifyStateChange();

        try {
            // Fetch WS token
            const token = await fetchWsToken({
                sessionId,
                role,
                participantId: participantIdRef?.current || participantId,
                apiUrl: options.apiUrl,
            });

            if (isDestroyed) return;

            // Close existing connection if any
            if (ws) {
                ws.onclose = null;
                ws.onerror = null;
                ws.onmessage = null;
                ws.close();
            }

            // Create WebSocket connection
            const wsUrl = `${wsBase}/api/ws?token=${encodeURIComponent(token)}`;
            console.log(`[WS] Connecting to ${wsUrl}`);
            ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                if (isDestroyed) return;

                console.log('[WS] Connected');
                isConnected = true;
                isConnecting = false;
                connectionError = null;
                reconnect.reset();
                notifyStateChange();
            };

            ws.onmessage = (event: MessageEvent) => {
                if (isDestroyed) return;

                try {
                    const message = JSON.parse(event.data);
                    const { type, ...data } = message;

                    if (messageHandler) {
                        messageHandler(type, data);
                    }
                } catch (e) {
                    console.error('[WS] Failed to parse message:', e);
                }
            };

            ws.onclose = (event: CloseEvent) => {
                if (isDestroyed) return;

                console.log(`[WS] Disconnected (code: ${event.code}, reason: ${event.reason})`);
                isConnected = false;
                isConnecting = false;

                // Don't reconnect if we were intentionally closed
                if (event.code !== 1000) {
                    reconnect.schedule();
                }
            };

            ws.onerror = (event: Event) => {
                if (isDestroyed) return;

                console.error('[WS] Connection error');
                connectionError = 'Connection failed.';
            };
        } catch (e) {
            if (isDestroyed) return;

            console.error('[WS] Failed to connect:', e);
            isConnecting = false;
            connectionError = e instanceof Error ? e.message : 'Connection failed';
            notifyStateChange();
            reconnect.schedule();
        }
    }

    function disconnect() {
        isDestroyed = true;
        reconnect.cancel();

        if (ws) {
            ws.onclose = null;
            ws.onerror = null;
            ws.onmessage = null;
            ws.close(1000, 'Client disconnect');
            ws = null;
        }

        isConnected = false;
        isConnecting = false;
        notifyStateChange();
    }

    function onMessage(handler: (name: string, data: any) => void) {
        messageHandler = handler;
    }

    // Start the connection
    connect();

    return {
        get isConnected() { return isConnected; },
        get isConnecting() { return isConnecting; },
        get connectionError() { return connectionError; },
        connect,
        disconnect,
        onMessage,
    };
}
