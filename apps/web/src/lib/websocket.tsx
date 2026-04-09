'use client';

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { StateUpdatePayload } from 'shared';
import { shouldApplyStateUpdate } from './state-updates';
import { getOrCreateParticipantId } from './participant-id';
import { createClientRequestId, httpFetch, HttpRequestError, type HttpErrorKind } from '@/lib/http';
import { safeLocalStorageGet, safeLocalStorageSet } from '@/lib/storage';
import { fetchWsToken } from './ws-auth';
import { createReconnect } from './ws-reconnect';
import { trimTrailingSlash } from './url';

// Every tab maintains its own direct WebSocket connection.
// There is no cross-tab coordination or leader election.

function syncSequenceRefs(
    voteSequenceRef: React.MutableRefObject<number>,
    qaSequenceRef: React.MutableRefObject<number>,
    snapshot?: { voteSequence?: number; qaSequence?: number } | null,
) {
    if (typeof snapshot?.voteSequence === 'number') {
        voteSequenceRef.current = Math.max(voteSequenceRef.current, snapshot.voteSequence);
    }

    if (typeof snapshot?.qaSequence === 'number') {
        qaSequenceRef.current = Math.max(qaSequenceRef.current, snapshot.qaSequence);
    }
}

function shouldRetryConnectionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return !(
        message.includes('Authentication required') ||
        message.includes('HTTP 400') ||
        message.includes('HTTP 401') ||
        message.includes('HTTP 403') ||
        message.includes('HTTP 404')
    );
}

interface WebSocketContextType {
    isConnected: boolean;
    isConnecting: boolean;
    connectionError: string | null;
    state: StateUpdatePayload | null;
    initialStateError: string | null;
    voteResults: Record<string, Record<string, number>>;
    sendMessage: (type: string, payload: any, options?: { clientRequestId?: string }) => Promise<SendAck>;
    refreshState: (options?: { includeMyVotes?: boolean }) => Promise<SendAck>;
    updateState: (updates: Partial<StateUpdatePayload>) => void;
    lostCount: number;
    serverTimeOffset: number;
    slideStartTime: number | null;
    questions: any[];
    activeParticipants: number;
    lastSlideUpdate: number;
    lastStateSyncAt: number | null;
    lastRealtimeMessageAt: number | null;
    socket: any | null;
    initialStateLoaded: boolean;
    participantId: string;
    myVotes: Record<string, string[]>; // slide_id -> [option_ids]
}

export type SendAck =
    | { ok: true; requestId: string }
    | { ok: false; requestId: string; message: string; status?: number; kind?: HttpErrorKind; error?: unknown };

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export function WebSocketProvider({
    children,
    sessionId,
    role,
    name
}: {
    children: React.ReactNode;
    sessionId: string;
    role: 'staff' | 'student' | 'projector';
    name?: string;
}) {
    const [isConnected, setIsConnected] = useState(false);
    const [isConnecting, setIsConnecting] = useState(true);
    const [connectionError, setConnectionError] = useState<string | null>(null);
    const [state, setState] = useState<StateUpdatePayload | null>(null);
    const [initialStateLoaded, setInitialStateLoaded] = useState(false);
    const [initialStateError, setInitialStateError] = useState<string | null>(null);
    const [lastStateSyncAt, setLastStateSyncAt] = useState<number | null>(null);
    const [lastRealtimeMessageAt, setLastRealtimeMessageAt] = useState<number | null>(null);
    const [voteResults, setVoteResults] = useState<Record<string, Record<string, number>>>({});
    const [lostCount] = useState(0);
    const [serverTimeOffset] = useState(0);
    const [slideStartTime] = useState<number | null>(null);
    const [questions, setQuestions] = useState<any[]>([]);
    const [activeParticipants, setActiveParticipants] = useState(0);
    const [lastSlideUpdate, setLastSlideUpdate] = useState(0);
    const [wsConnection, setWsConnection] = useState<WebSocket | null>(null);
    const [myVotes, setMyVotes] = useState<Record<string, string[]>>({});

    // Initialize participantId synchronously to avoid race condition with WebSocket connection.
    // Students get a session-scoped ID so separate browsers never collapse into one clientId.
    const participantIdRef = useRef<string>(getOrCreateParticipantId(role, sessionId, {
        get: safeLocalStorageGet,
        set: (key, value) => {
            safeLocalStorageSet(key, value);
        },
    }));
    const wsRef = useRef<WebSocket | null>(null);
    const wsReconnectRef = useRef<ReturnType<typeof createReconnect> | null>(null);
    const isMountedRef = useRef<boolean>(true);
    const isRefreshingRef = useRef<boolean>(false);
    const initialStateLoadedRef = useRef<boolean>(false);
    const hasOpenedSocketRef = useRef<boolean>(false);
    const refreshStateRef = useRef<((options?: { includeMyVotes?: boolean }) => Promise<SendAck>) | null>(null);
    const stateRef = useRef<StateUpdatePayload | null>(null);

    // State refs for sequence tracking
    const voteSequenceRef = useRef<number>(0);
    const qaSequenceRef = useRef<number>(0);

    // Embedded WS token from the initial state response (eliminates separate token fetch).
    const wsTokenRef = useRef<string | null>(null);

    // Reconnect state persisted across effect re-runs
    const reconnectAttemptRef = useRef<number>(0);
    const reconnectTimeoutIdRef = useRef<NodeJS.Timeout | null>(null);
    const maxReconnectAttempts = 10;

    // Name ref to avoid triggering effect re-run when name prop changes
    const nameRef = useRef<string | undefined>(name);
    useEffect(() => {
        nameRef.current = name;
    }, [name]);

    useEffect(() => {
        stateRef.current = state;
    }, [state]);

    // Fetch initial state IMMEDIATELY on mount (before WebSocket connection)
    // This prevents the flash of incorrect UI state
    useEffect(() => {
        if (!sessionId || initialStateLoaded) return;

        const controller = new AbortController();

        const fetchInitialStateEarly = async () => {
            try {
                const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
                setInitialStateError(null);
                const { response: res } = await httpFetch(`${apiBase}/sessions/${sessionId}/state`, {
                    idempotent: true,
                    timeoutMs: 10_000,
                    throwOnHttpError: false,
                    signal: controller.signal,
                });
                if (res.ok) {
                    const data = await res.json();
                    setState(data);
                    if (data.questions) setQuestions(data.questions);
                    if (data.voteCounts) setVoteResults(data.voteCounts);
                    syncSequenceRefs(voteSequenceRef, qaSequenceRef, data);
                    setLastStateSyncAt(Date.now());

                    // Capture embedded WS token if present (backend optimization)
                    if (data.wsToken && typeof data.wsToken === 'string') {
                        wsTokenRef.current = data.wsToken;
                    }
                } else {
                    setInitialStateError(`HTTP ${res.status}`);
                }
            } catch (e) {
                if (e instanceof DOMException && e.name === 'AbortError') {
                    return; // Component unmounted, skip error state
                }
                console.error('Failed to fetch initial state early:', e);
                setInitialStateError(e instanceof Error ? e.message : 'Failed to fetch initial state');
            } finally {
                initialStateLoadedRef.current = true; // Set ref to prevent double-fetch
                setInitialStateLoaded(true);
            }
        };

        fetchInitialStateEarly();

        // Cleanup: abort fetch on unmount
        return () => {
            controller.abort();
        };
    }, [sessionId, initialStateLoaded]);

    // participantId is now initialized synchronously in useRef above
    // This effect is kept for backwards compatibility but the ref is already set

    // Handle incoming WebSocket messages
    const handleAblyMessage = useCallback((messageName: string, data: any) => {
        if (!isMountedRef.current) return;

        const now = Date.now();
        setLastRealtimeMessageAt(prev => {
            if (!prev || now - prev > 1000) return now;
            return prev;
        });

        const payload = data;

        if (messageName === 'STATE_UPDATE') {
            const stateData = payload?.payload || payload;
            if (stateData) {
                if (!shouldApplyStateUpdate(stateRef.current, stateData)) {
                    return;
                }

                syncSequenceRefs(voteSequenceRef, qaSequenceRef, stateData);
                setState(prev => ({ ...prev, ...stateData }));
                if (stateData.questions) setQuestions(stateData.questions);
                if (stateData.voteCounts) setVoteResults(stateData.voteCounts);
            }
        } else if (messageName === 'VOTE_UPDATE') {
            const incomingSequence = typeof payload?.sequence === 'number' ? payload.sequence : undefined;
            if (incomingSequence !== undefined) {
                if (incomingSequence <= voteSequenceRef.current) {
                    return;
                }
                voteSequenceRef.current = incomingSequence;
            }
            setVoteResults(prev => ({
                ...prev,
                [payload.slideId]: payload.results
            }));
        } else if (messageName === 'QA_UPDATE') {
            const incomingSequence = typeof payload?.sequence === 'number' ? payload.sequence : undefined;
            if (incomingSequence !== undefined) {
                if (incomingSequence <= qaSequenceRef.current) {
                    return;
                }
                qaSequenceRef.current = incomingSequence;
            }

            const questionsPayload = payload.payload?.questions ?? payload.questions;
            if (questionsPayload) {
                setQuestions(questionsPayload);
            }
        } else if (messageName === 'PARTICIPANT_COUNT_UPDATE') {
            setActiveParticipants(payload.count || 0);
        } else if (messageName === 'SLIDES_UPDATE') {
            setLastSlideUpdate(Date.now());
        }
    }, []);

    useEffect(() => {
        if (!sessionId) return;

        isMountedRef.current = true;
        let ws: WebSocket | null = null;

        const fetchAbortController = new AbortController();

        const fetchInitialState = async () => {
            // Guard against double-fetch: skip if initial state was already loaded
            // by the fetchInitialStateEarly effect (see lines ~156-192)
            if (initialStateLoadedRef.current) {
                return;
            }

            try {
                const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
                setInitialStateError(null);
                const { response: res } = await httpFetch(`${apiBase}/sessions/${sessionId}/state`, {
                    idempotent: true,
                    throwOnHttpError: false,
                    signal: fetchAbortController.signal,
                });
                if (res.ok && isMountedRef.current) {
                    const data = await res.json();
                    setState(data);
                    if (data.questions) setQuestions(data.questions);
                    if (data.voteCounts) setVoteResults(data.voteCounts);
                    syncSequenceRefs(voteSequenceRef, qaSequenceRef, data);
                    setLastStateSyncAt(Date.now());

                    // Capture embedded WS token if present
                    if (data.wsToken && typeof data.wsToken === 'string' && !wsTokenRef.current) {
                        wsTokenRef.current = data.wsToken;
                    }
                } else if (!res.ok && isMountedRef.current) {
                    setInitialStateError(`HTTP ${res.status}`);
                }
            } catch (e) {
                if (e instanceof DOMException && e.name === 'AbortError') {
                    return; // Component unmounted, skip error state
                }
                console.error('Failed to fetch initial state:', e);
                if (isMountedRef.current) {
                    setInitialStateError(e instanceof Error ? e.message : 'Failed to fetch initial state');
                }
            }

            if (role === 'student') {
                const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';

                // Fetch previous votes to restore state after app reopen
                try {
                    console.log('[DEBUG] Fetching my-votes for participantId:', participantIdRef.current);
                    const { response: votesRes } = await httpFetch(`${apiBase}/sessions/${sessionId}/my-votes?participantId=${encodeURIComponent(participantIdRef.current)}`, {
                        idempotent: true,
                        throwOnHttpError: false,
                        signal: fetchAbortController.signal,
                    });
                    console.log('[DEBUG] my-votes response status:', votesRes.status);
                    if (votesRes.ok && isMountedRef.current) {
                        const votesData = await votesRes.json();
                        console.log('[DEBUG] my-votes data:', votesData);
                        if (votesData.data?.votes) {
                            setMyVotes(votesData.data.votes);
                            const voteKeyPrefix = `${sessionId}_${participantIdRef.current || 'anon'}`;
                            // Also update localStorage to keep it in sync
                            Object.entries(votesData.data.votes as Record<string, string[]>).forEach(([slideId, optionIds]) => {
                                if (optionIds.length > 0) {
                                    safeLocalStorageSet(`voted_${voteKeyPrefix}_${slideId}`, 'true');
                                    if (optionIds.length === 1) {
                                        safeLocalStorageSet(`voted_option_${voteKeyPrefix}_${slideId}`, optionIds[0]);
                                    } else {
                                        safeLocalStorageSet(`voted_options_${voteKeyPrefix}_${slideId}`, JSON.stringify(optionIds));
                                    }
                                }
                            });
                        }
                    } else {
                        console.log('[DEBUG] my-votes failed or component unmounted');
                    }
                } catch (e) {
                    console.error('[DEBUG] Failed to fetch previous votes:', e);
                }
                
                // Only register participant if they have a name
                // When requireName is true, students must provide a name before joining
                // When requireName is false, we still register them but only if they provided a name
                const currentName = nameRef.current;
                if (currentName && currentName.trim()) {
                    void httpFetch(`${apiBase}/sessions/${sessionId}/register-participant`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            participantId: participantIdRef.current,
                            name: currentName.trim()
                        }),
                        idempotent: true,
                        throwOnHttpError: false,
                    }).catch(() => { });
                }
            }
        };

    const createWebSocketConnection = async () => {
        if (ws?.readyState === WebSocket.OPEN) return;

        setIsConnecting(true);
        setConnectionError(null);

        try {
            // Use embedded WS token from initial state response if available,
            // otherwise fall back to fetching a separate token (backward compat).
            let token: string;
            if (wsTokenRef.current) {
                token = wsTokenRef.current;
                console.log('[WS] Using embedded WS token from state response');
            } else {
                console.log('[WS] Fetching WS token from /api/auth/ws-token');
                token = await fetchWsToken({
                    sessionId,
                    role,
                    participantId: participantIdRef.current,
                });
            }

            if (!isMountedRef.current) return;

            // Close existing connection
            if (ws) {
                ws.onclose = null;
                ws.onerror = null;
                ws.onmessage = null;
                ws.close();
            }

            // Create WebSocket connection
            const wsUrl = trimTrailingSlash(process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8080');
            const wsEndpoint = `${wsUrl}/api/ws?token=${encodeURIComponent(token)}`;
            console.log(`[WS] Connecting to ${wsEndpoint}`);
            ws = new WebSocket(wsEndpoint);
            wsRef.current = ws;
            setWsConnection(ws);

            ws.onopen = () => {
                if (!isMountedRef.current) return;
                console.log('[WS] Connected');
                setIsConnected(true);
                setIsConnecting(false);
                setConnectionError(null);
                resetReconnect();

                const hasOpenedBefore = hasOpenedSocketRef.current;
                hasOpenedSocketRef.current = true;

                if (hasOpenedBefore && refreshStateRef.current && !isRefreshingRef.current) {
                    isRefreshingRef.current = true;
                    void refreshStateRef.current({ includeMyVotes: false }).finally(() => {
                        isRefreshingRef.current = false;
                    });
                }
            };

            ws.onmessage = (event: MessageEvent) => {
                if (!isMountedRef.current) return;

                try {
                    const message = JSON.parse(event.data);
                    const { type, ...data } = message;
                    handleAblyMessage(type, data);
                } catch (e) {
                    console.error('[WS] Failed to parse message:', e);
                }
            };

            ws.onclose = (event: CloseEvent) => {
                if (!isMountedRef.current) return;
                console.log(`[WS] Disconnected (code: ${event.code})`);
                setIsConnected(false);
                setIsConnecting(false);

                // Schedule reconnect if not intentional close
                if (event.code !== 1000) {
                    scheduleReconnect();
                }
            };

            ws.onerror = () => {
                if (!isMountedRef.current) return;
                console.error('[WS] Connection error');
                setConnectionError('Connection failed.');
            };

            // Fetch initial state after setting up connection
            await fetchInitialState();
        } catch (e) {
            if (!isMountedRef.current) return;
            console.error('[WS] Failed to connect:', e);
            setIsConnecting(false);
            setConnectionError(e instanceof Error ? e.message : 'Connection failed');
            if (shouldRetryConnectionError(e)) {
                scheduleReconnect();
            }
        }
    };

    const scheduleReconnect = () => {
        if (reconnectTimeoutIdRef.current) {
            clearTimeout(reconnectTimeoutIdRef.current);
        }

        if (reconnectAttemptRef.current >= maxReconnectAttempts) {
            setConnectionError('Connection lost. Please refresh the page.');
            return;
        }

        const baseDelay = 1000;
        const maxDelay = 30000;
        const delay = Math.min(baseDelay * Math.pow(2, reconnectAttemptRef.current), maxDelay);
        const jitteredDelay = delay * (0.5 + Math.random());

        console.log(`[WS] Scheduling reconnect in ${jitteredDelay}ms (attempt ${reconnectAttemptRef.current + 1})`);

        reconnectTimeoutIdRef.current = setTimeout(() => {
            reconnectAttemptRef.current++;
            createWebSocketConnection();
        }, jitteredDelay);
    };

    const resetReconnect = () => {
        reconnectAttemptRef.current = 0;
        if (reconnectTimeoutIdRef.current) {
            clearTimeout(reconnectTimeoutIdRef.current);
            reconnectTimeoutIdRef.current = null;
        }
    };

        // Every tab has its own direct WebSocket connection
        createWebSocketConnection();

        return () => {
            isMountedRef.current = false;
            fetchAbortController.abort();

            if (reconnectTimeoutIdRef.current) {
                clearTimeout(reconnectTimeoutIdRef.current);
                reconnectTimeoutIdRef.current = null;
            }

            if (ws) {
                try {
                    ws.onclose = null;
                    ws.onerror = null;
                    ws.onmessage = null;
                    ws.close(1000, 'Component unmount');
                } catch (e) { }
                ws = null;
                wsRef.current = null;
                setWsConnection(null);
            }
        };
    }, [sessionId, role, handleAblyMessage]);

    const refreshState = useCallback(async (
        options?: { includeMyVotes?: boolean }
    ): Promise<SendAck> => {
        const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
        const requestId = createClientRequestId();
        const includeMyVotes = options?.includeMyVotes ?? true;

        try {
            const { response, requestId: rid } = await httpFetch(`${apiBase}/sessions/${sessionId}/state`, {
                timeoutMs: 10_000,
                idempotent: true,
                clientRequestId: requestId,
                throwOnHttpError: true,
            });

            const data = await response.json();
            if (isMountedRef.current) {
                setState(data);
                if (data.questions) setQuestions(data.questions);
                if (data.voteCounts) setVoteResults(data.voteCounts);
                syncSequenceRefs(voteSequenceRef, qaSequenceRef, data);
                setInitialStateError(null);
                setLastStateSyncAt(Date.now());
            }

            if (role === 'student' && includeMyVotes) {
                try {
                    const { response: votesRes } = await httpFetch(
                        `${apiBase}/sessions/${sessionId}/my-votes?participantId=${encodeURIComponent(participantIdRef.current)}`,
                        {
                            timeoutMs: 10_000,
                            idempotent: true,
                            throwOnHttpError: false,
                        }
                    );
                    if (votesRes.ok && isMountedRef.current) {
                        const votesData = await votesRes.json();
                        if (votesData.data?.votes) {
                            setMyVotes(votesData.data.votes);
                        }
                    }
                } catch (e) {
                    // Best-effort; ignore
                }
            }

            return { ok: true, requestId: rid };
        } catch (e) {
            const status = e instanceof HttpRequestError ? e.status : undefined;
            const kind = e instanceof HttpRequestError ? e.kind : undefined;
            const message = e instanceof Error ? e.message : 'Request failed';
            const rid = e instanceof HttpRequestError ? e.requestId : requestId;
            if (isMountedRef.current) {
                setInitialStateError(message);
            }
            return { ok: false, requestId: rid, message, status, kind, error: e };
        }
    }, [role, sessionId]);

    useEffect(() => {
        refreshStateRef.current = refreshState;
    }, [refreshState]);

    // Auto-refresh state when connection is stale (no updates for 15 seconds)
    useEffect(() => {
        if (!isConnected || !sessionId) return;

        const checkStaleness = () => {
            const lastUpdateAt = lastRealtimeMessageAt ?? lastStateSyncAt;
            const isStale = isConnected && typeof lastUpdateAt === 'number' && Date.now() - lastUpdateAt > 15_000;

            if (isStale && !isRefreshingRef.current) {
                isRefreshingRef.current = true;
                refreshState({ includeMyVotes: false }).finally(() => {
                    isRefreshingRef.current = false;
                });
            }
        };

        // Check every 5 seconds
        const intervalId = setInterval(checkStaleness, 5_000);

        return () => {
            clearInterval(intervalId);
        };
    }, [isConnected, sessionId, lastRealtimeMessageAt, lastStateSyncAt, refreshState]);

    const sendMessage = async (type: string, payload: any, options?: { clientRequestId?: string }): Promise<SendAck> => {
        const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
        const requestId = options?.clientRequestId ?? createClientRequestId();

        try {
            switch (type) {
                case 'SUBMIT_VOTE':
                    console.log('[DEBUG] Submitting vote with participantId:', participantIdRef.current);
                    await httpFetch(`${apiBase}/sessions/${sessionId}/vote`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...payload, participantId: participantIdRef.current }),
                        retry: false,
                        clientRequestId: requestId,
                    });
                    return { ok: true, requestId };
                case 'SUBMIT_ANSWER':
                    await httpFetch(`${apiBase}/sessions/${sessionId}/vote`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            slideId: payload.slideId,
                            optionId: payload.answer,
                            participantId: participantIdRef.current,
                            timeRemaining: payload.timeRemaining
                        }),
                        retry: false,
                        clientRequestId: requestId,
                    });
                    return { ok: true, requestId };
                case 'SUBMIT_QUESTION':
                    await httpFetch(`${apiBase}/sessions/${sessionId}/questions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...payload, participantId: participantIdRef.current }),
                        retry: false,
                        clientRequestId: requestId,
                    });
                    return { ok: true, requestId };
                case 'UPVOTE_QUESTION':
                    await httpFetch(`${apiBase}/sessions/${sessionId}/questions/${payload.questionId}/upvote`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ participantId: participantIdRef.current }),
                        retry: false,
                        clientRequestId: requestId,
                    });
                    return { ok: true, requestId };
                case 'SET_SLIDE':

                    const token = safeLocalStorageGet('token');
                    await httpFetch(`${apiBase}/sessions/${sessionId}/current-slide`, {
                        method: 'PUT',
                        headers: { 
                            'Content-Type': 'application/json',
                            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                        },
                        body: JSON.stringify(payload),
                        idempotent: true,
                        clientRequestId: requestId,
                    });
                    return { ok: true, requestId };
                case 'STATE_UPDATE':
                    if (payload.showResults !== undefined) {
                        const authToken = safeLocalStorageGet('token');
                        await httpFetch(`${apiBase}/sessions/${sessionId}/results-visibility`, {
                            method: 'PUT',
                            headers: { 
                                'Content-Type': 'application/json',
                                ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
                            },
                            body: JSON.stringify({ visible: payload.showResults }),
                            idempotent: true,
                            clientRequestId: requestId,
                        });
                    }
                    return { ok: true, requestId };
                default:
                    return {
                        ok: false,
                        requestId,
                        message: `Unsupported message type: ${type}`,
                    };
            }
        } catch (e) {
            console.error('Error sending message:', e);
            const status = e instanceof HttpRequestError ? e.status : undefined;
            const kind = e instanceof HttpRequestError ? e.kind : undefined;
            const message = e instanceof Error ? e.message : 'Request failed';
            return { ok: false, requestId, message, status, kind, error: e };
        }
    };

    const updateState = (updates: Partial<StateUpdatePayload>) => {
        setState(prev => prev ? { ...prev, ...updates } : updates as StateUpdatePayload);
    };

    return (
        <WebSocketContext.Provider value={{
            isConnected,
            isConnecting,
            connectionError,
            state,
            initialStateError,
            voteResults,
            sendMessage,
            refreshState,
            updateState,
            lostCount,
            serverTimeOffset,
            slideStartTime,
            questions,
            activeParticipants,
            lastSlideUpdate,
            lastStateSyncAt,
            lastRealtimeMessageAt,
            socket: wsConnection,
            initialStateLoaded,
            participantId: participantIdRef.current,
            myVotes
        }}>
            {children}
        </WebSocketContext.Provider>
    );
}

export function useWebSocket() {
    const context = useContext(WebSocketContext);
    if (!context) {
        throw new Error('useWebSocket must be used within a WebSocketProvider');
    }
    return context;
}
