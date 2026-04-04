'use client';

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import * as Ably from 'ably';
import { StateUpdatePayload } from 'shared';
import { shouldApplyStateUpdate } from './state-updates';
import { getOrCreateParticipantId } from './participant-id';
import { createClientRequestId, httpFetch, HttpRequestError, type HttpErrorKind } from '@/lib/http';
import { safeLocalStorageGet, safeLocalStorageSet } from '@/lib/storage';

// Cross-tab connection sharing using BroadcastChannel
// Only one tab (the "leader") maintains the actual Ably connection
// Other tabs receive messages via BroadcastChannel
// Includes automatic leader failover when leader tab closes

interface TabMessage {
    type: 'ABLY_MESSAGE' | 'REQUEST_LEADER' | 'LEADER_ANNOUNCE' | 'LEADER_PING' | 'LEADER_PONG' | 'LEADER_GOODBYE' | 'STATE_SYNC';
    sessionId?: string;
    tabId?: string;
    message?: { name: string; data: any };
    timestamp?: number;
    leaderSince?: number; // When this tab became leader (for priority)
    currentState?: {
        state: any;
        voteResults: Record<string, Record<string, number>>;
        questions: any[];
        voteSequence?: number;
        qaSequence?: number;
    };
}

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

// Generate unique tab ID with creation timestamp for priority
const TAB_ID = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2);

// Leader health check interval (ms)
const LEADER_PING_INTERVAL = 5000;
const LEADER_PING_TIMEOUT = 3000;
const ELECTION_BASE_DELAY = 100;
const ELECTION_RANDOM_DELAY = 400;

// Track if this tab is the leader for each session
const leaderStatus = new Map<string, boolean>();
const broadcastChannels = new Map<string, BroadcastChannel>();

interface WebSocketContextType {
    isConnected: boolean;
    isConnecting: boolean;
    connectionError: string | null;
    state: StateUpdatePayload | null;
    initialStateError: string | null;
    voteResults: Record<string, Record<string, number>>;
    sendMessage: (type: string, payload: any, options?: { clientRequestId?: string }) => Promise<SendAck>;
    refreshState: () => Promise<SendAck>;
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
    const [ablyClient, setAblyClient] = useState<Ably.Realtime | null>(null);
    const [myVotes, setMyVotes] = useState<Record<string, string[]>>({});

    // Initialize participantId synchronously to avoid race condition with Ably connection.
    // Students get a session-scoped ID so separate browsers never collapse into one clientId.
    const participantIdRef = useRef<string>(getOrCreateParticipantId(role, sessionId, {
        get: safeLocalStorageGet,
        set: (key, value) => {
            safeLocalStorageSet(key, value);
        },
    }));
    const ablyClientRef = useRef<Ably.Realtime | null>(null);
    const isLeaderRef = useRef<boolean>(false);
    const leaderSinceRef = useRef<number>(0); // When we became leader
    const leaderCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const leaderPingIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const leaderPongTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const bcRef = useRef<BroadcastChannel | null>(null);
    const isMountedRef = useRef<boolean>(true);
    const isRefreshingRef = useRef<boolean>(false); // Track if auto-refresh is in progress
    const initialStateLoadedRef = useRef<boolean>(false); // Track if initial state fetched

    // Message buffer for failover gap
    const messageBufferRef = useRef<Array<{ name: string; data: any; timestamp: number }>>([]);
    const isInFailoverRef = useRef<boolean>(false);

    // State refs for sharing during failover
    const stateRef = useRef<StateUpdatePayload | null>(null);
    const voteResultsRef = useRef<Record<string, Record<string, number>>>({});
    const questionsRef = useRef<any[]>([]);
    const voteSequenceRef = useRef<number>(0);
    const qaSequenceRef = useRef<number>(0);
    const lastRealtimeMessageAtRef = useRef<number | null>(null);

    // Keep refs in sync with state
    useEffect(() => { stateRef.current = state; }, [state]);
    useEffect(() => { voteResultsRef.current = voteResults; }, [voteResults]);
    useEffect(() => { questionsRef.current = questions; }, [questions]);

    // Fetch initial state IMMEDIATELY on mount (before Ably connection)
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

    // Handle incoming Ably messages (for both leader and follower)
    const handleAblyMessage = useCallback((messageName: string, data: any) => {
        if (!isMountedRef.current) return;

        const now = Date.now();
        if (!lastRealtimeMessageAtRef.current || now - lastRealtimeMessageAtRef.current > 1000) {
            lastRealtimeMessageAtRef.current = now;
            setLastRealtimeMessageAt(now);
        }

        // If in failover, buffer the message
        if (isInFailoverRef.current) {
            messageBufferRef.current.push({ name: messageName, data, timestamp: Date.now() });
            return;
        }

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

    // Process buffered messages after failover
    const processBufferedMessages = useCallback(() => {
        const buffer = messageBufferRef.current;
        messageBufferRef.current = [];
        isInFailoverRef.current = false;

        buffer.forEach(msg => {
            handleAblyMessage(msg.name, msg.data);
        });
    }, [handleAblyMessage]);

    useEffect(() => {
        if (!sessionId) return;

        // IMPORTANT: Disable BroadcastChannel for students so each window gets its own Ably connection
        // This ensures each student has a unique connection even in the same browser
        // BroadcastChannel is only useful for staff who might have multiple tabs open
        const hasBroadcastChannel = typeof window !== 'undefined'
            && typeof (window as any).BroadcastChannel !== 'undefined'
            && role !== 'student';

        isMountedRef.current = true;
        let client: Ably.Realtime | null = null;
        let bc: BroadcastChannel | null = null;
        const channelName = `ably-session-${sessionId}-${role}`;

        // Track when we last heard from a leader and their priority
        let lastLeaderTimestamp = 0;
        let currentLeaderSince = 0;
        let currentLeaderTabId = '';

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
                if (name && name.trim()) {
                    void httpFetch(`${apiBase}/sessions/${sessionId}/register-participant`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            participantId: participantIdRef.current,
                            name: name.trim()
                        }),
                        idempotent: true,
                        throwOnHttpError: false,
                    }).catch(() => { });
                }
            }
        };

    const createAblyConnection = () => {
        if (client) return;

        if (process.env.NEXT_PUBLIC_DISABLE_ABLY === '1') {
            setIsConnecting(false);
            setConnectionError(null);
            return;
        }

        const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
        // Ensure participantId is set before creating connection
        const participantId = participantIdRef.current;
        if (!participantId) {
            console.error('participantId is empty, this will cause connection issues');
        }

        console.log(`Creating Ably connection for ${role} with participantId: ${participantId}`);

        client = new Ably.Realtime({
            authUrl: `${apiBase}/auth/ably?sessionId=${sessionId}&role=${role}&participantId=${participantId}`,
            authMethod: 'GET',
            disconnectedRetryTimeout: 5000,
            suspendedRetryTimeout: 10000,
        });

        ablyClientRef.current = client;
        setAblyClient(client);

        client.connection.on('connected', () => {
            setIsConnected(true);
            setIsConnecting(false);
            setConnectionError(null);

            // End failover mode and process buffered messages
            if (isInFailoverRef.current) {
                setTimeout(processBufferedMessages, 100);
            }

            if (bc) {
                bc.postMessage({
                    type: 'LEADER_ANNOUNCE',
                    sessionId,
                    tabId: TAB_ID,
                    timestamp: Date.now(),
                    leaderSince: leaderSinceRef.current,
                    currentState: {
                        state: stateRef.current,
                        voteResults: voteResultsRef.current,
                        questions: questionsRef.current,
                        voteSequence: voteSequenceRef.current,
                        qaSequence: qaSequenceRef.current,
                    }
                });
            }
        });

        client.connection.on('disconnected', () => {
            setIsConnected(false);
        });

        client.connection.on('failed', () => {
            setIsConnected(false);
            setIsConnecting(false);
            setConnectionError('Connection failed.');
        });

        const channel = client.channels.get(`session:${sessionId}`);
        channel.subscribe((message) => {
            handleAblyMessage(message.name || '', message.data);

            if (bc && isLeaderRef.current) {
                bc.postMessage({
                    type: 'ABLY_MESSAGE',
                    sessionId,
                    message: { name: message.name, data: message.data },
                    timestamp: Date.now()
                });
            }
        });

        fetchInitialState();
    };

        const becomeLeader = () => {
            if (isLeaderRef.current) return;

            const now = Date.now();
            if (now - lastLeaderTimestamp < 1000) {

                return;
            }


            isLeaderRef.current = true;
            leaderSinceRef.current = now;
            leaderStatus.set(sessionId, true);

            if (leaderPingIntervalRef.current) {
                clearInterval(leaderPingIntervalRef.current);
                leaderPingIntervalRef.current = null;
            }
            if (leaderPongTimeoutRef.current) {
                clearTimeout(leaderPongTimeoutRef.current);
                leaderPongTimeoutRef.current = null;
            }

            createAblyConnection();
        };

        const stepDown = (newLeaderTabId: string, newLeaderSince: number) => {
            if (!isLeaderRef.current) return;


            isLeaderRef.current = false;
            leaderStatus.set(sessionId, false);
            currentLeaderTabId = newLeaderTabId;
            currentLeaderSince = newLeaderSince;

            if (client) {
                try {
                    client.close();
                } catch (e) {
                    // Ignore close errors
                }
                client = null;
                ablyClientRef.current = null;
                setAblyClient(null);
            }

            startLeaderHealthCheck();
        };

        const startLeaderHealthCheck = () => {
            if (isLeaderRef.current) return;

            // Clear existing interval
            if (leaderPingIntervalRef.current) {
                clearInterval(leaderPingIntervalRef.current);
            }

            leaderPingIntervalRef.current = setInterval(() => {
                if (!bc || isLeaderRef.current) return;

                bc.postMessage({ type: 'LEADER_PING', sessionId, tabId: TAB_ID });

                leaderPongTimeoutRef.current = setTimeout(() => {
                    if (!isMountedRef.current || isLeaderRef.current) return;


                    isInFailoverRef.current = true;

                    const tabHash = TAB_ID.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
                    const electionDelay = ELECTION_BASE_DELAY + (tabHash % ELECTION_RANDOM_DELAY);

                    setTimeout(() => {
                        if (!isMountedRef.current || isLeaderRef.current) return;

                        bc?.postMessage({ type: 'REQUEST_LEADER', sessionId, tabId: TAB_ID });

                        setTimeout(() => {
                            if (!isMountedRef.current || isLeaderRef.current) return;
                            becomeLeader();
                        }, 300);
                    }, electionDelay);
                }, LEADER_PING_TIMEOUT);
            }, LEADER_PING_INTERVAL);
        };

        const BroadcastChannelCtor = typeof window !== 'undefined'
            ? (window as any).BroadcastChannel
            : undefined;

        if (hasBroadcastChannel && typeof BroadcastChannelCtor === 'function') {
            const broadcastChannel = new BroadcastChannelCtor(channelName) as BroadcastChannel;
            bc = broadcastChannel;
            bcRef.current = broadcastChannel;
            broadcastChannels.set(sessionId, broadcastChannel);

            broadcastChannel.onmessage = (event: MessageEvent<TabMessage>) => {
                const msg = event.data;

                if (msg.sessionId !== sessionId) return;

                if (msg.type === 'ABLY_MESSAGE' && msg.message) {
                    handleAblyMessage(msg.message.name, msg.message.data);

                } else if (msg.type === 'LEADER_ANNOUNCE' && msg.tabId !== TAB_ID) {

                    lastLeaderTimestamp = msg.timestamp || Date.now();
                    const newLeaderSince = msg.leaderSince || Date.now();

                    // Split-brain resolution: older leader wins
                    if (isLeaderRef.current) {
                        if (newLeaderSince < leaderSinceRef.current) {
                            // Other leader is older, we step down

                            stepDown(msg.tabId!, newLeaderSince);
                        } else {
                            // We are older, re-announce

                            broadcastChannel.postMessage({
                                type: 'LEADER_ANNOUNCE',
                                sessionId,
                                tabId: TAB_ID,
                                timestamp: Date.now(),
                                leaderSince: leaderSinceRef.current,
                                currentState: {
                                    state: stateRef.current,
                                    voteResults: voteResultsRef.current,
                                    questions: questionsRef.current,
                                    voteSequence: voteSequenceRef.current,
                                    qaSequence: qaSequenceRef.current,
                                }
                            });
                            return;
                        }
                    }

                    currentLeaderTabId = msg.tabId!;
                    currentLeaderSince = newLeaderSince;
                    isLeaderRef.current = false;
                    leaderStatus.set(sessionId, false);
                    setIsConnected(true);
                    setIsConnecting(false);

                    // End failover mode
                    if (isInFailoverRef.current) {
                        isInFailoverRef.current = false;
                        messageBufferRef.current = [];
                    }

                    if (leaderCheckTimeoutRef.current) {
                        clearTimeout(leaderCheckTimeoutRef.current);
                        leaderCheckTimeoutRef.current = null;
                    }

                    // Apply state from leader if provided
                    if (msg.currentState) {
                        if (msg.currentState.state) setState(msg.currentState.state);
                        if (msg.currentState.voteResults) setVoteResults(msg.currentState.voteResults);
                        if (msg.currentState.questions) setQuestions(msg.currentState.questions);
                        syncSequenceRefs(voteSequenceRef, qaSequenceRef, msg.currentState.state);
                        syncSequenceRefs(voteSequenceRef, qaSequenceRef, msg.currentState);
                        setInitialStateError(null);
                        setLastStateSyncAt(Date.now());
                    } else {
                        fetchInitialState();
                    }

                    startLeaderHealthCheck();

                } else if (msg.type === 'REQUEST_LEADER') {
                    if (isLeaderRef.current) {
                        broadcastChannel.postMessage({
                            type: 'LEADER_ANNOUNCE',
                            sessionId,
                            tabId: TAB_ID,
                            timestamp: Date.now(),
                            leaderSince: leaderSinceRef.current,
                            currentState: {
                                state: stateRef.current,
                                voteResults: voteResultsRef.current,
                                questions: questionsRef.current,
                                voteSequence: voteSequenceRef.current,
                                qaSequence: qaSequenceRef.current,
                            }
                        });
                    }

                } else if (msg.type === 'LEADER_PING' && isLeaderRef.current) {
                    bc?.postMessage({ type: 'LEADER_PONG', sessionId, tabId: TAB_ID });

                } else if (msg.type === 'LEADER_PONG' && msg.tabId !== TAB_ID) {
                    lastLeaderTimestamp = Date.now();
                    if (leaderPongTimeoutRef.current) {
                        clearTimeout(leaderPongTimeoutRef.current);
                        leaderPongTimeoutRef.current = null;
                    }

                } else if (msg.type === 'LEADER_GOODBYE' && msg.tabId !== TAB_ID) {

                    isInFailoverRef.current = true;

                    const tabHash = TAB_ID.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
                    const electionDelay = ELECTION_BASE_DELAY + (tabHash % ELECTION_RANDOM_DELAY);

                    setTimeout(() => {
                        if (!isMountedRef.current || isLeaderRef.current) return;

                        bc?.postMessage({ type: 'REQUEST_LEADER', sessionId, tabId: TAB_ID });

                        setTimeout(() => {
                            if (!isMountedRef.current || isLeaderRef.current) return;
                            becomeLeader();
                        }, 300);
                    }, electionDelay);

                } else if (msg.type === 'STATE_SYNC' && !isLeaderRef.current && msg.currentState) {
                    // Sync state from leader
                    if (msg.currentState.state) setState(msg.currentState.state);
                    if (msg.currentState.voteResults) setVoteResults(msg.currentState.voteResults);
                    if (msg.currentState.questions) setQuestions(msg.currentState.questions);
                    syncSequenceRefs(voteSequenceRef, qaSequenceRef, msg.currentState.state);
                    syncSequenceRefs(voteSequenceRef, qaSequenceRef, msg.currentState);
                    setInitialStateError(null);
                    setLastStateSyncAt(Date.now());
                }
            };

            broadcastChannel.postMessage({
                type: 'REQUEST_LEADER',
                sessionId,
                tabId: TAB_ID
            });

            leaderCheckTimeoutRef.current = setTimeout(() => {
                if (!isMountedRef.current) return;
                becomeLeader();
            }, 200);

        } else {

            becomeLeader();
        }

        return () => {
            isMountedRef.current = false;
            fetchAbortController.abort(); // Cancel any pending fetches

            if (isLeaderRef.current && bc) {

                bc.postMessage({ type: 'LEADER_GOODBYE', sessionId, tabId: TAB_ID });
            }

            if (leaderCheckTimeoutRef.current) clearTimeout(leaderCheckTimeoutRef.current);
            if (leaderPingIntervalRef.current) clearInterval(leaderPingIntervalRef.current);
            if (leaderPongTimeoutRef.current) clearTimeout(leaderPongTimeoutRef.current);

            if (client) {
                try {
                    client.connection.off();
                    client.close();
                } catch (e) { }
            }

            if (bc) {
                bc.close();
                broadcastChannels.delete(sessionId);
            }

            isLeaderRef.current = false;
            leaderStatus.delete(sessionId);
            ablyClientRef.current = null;
            bcRef.current = null;
        };
    }, [sessionId, role, name, handleAblyMessage, processBufferedMessages]);

    const refreshState = useCallback(async (): Promise<SendAck> => {
        const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
        const requestId = createClientRequestId();

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

            if (role === 'student') {
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

    // Auto-refresh state when connection is stale (no updates for 15 seconds)
    useEffect(() => {
        if (!isConnected || !sessionId) return;

        const checkStaleness = () => {
            const lastUpdateAt = lastRealtimeMessageAt ?? lastStateSyncAt;
            const isStale = isConnected && typeof lastUpdateAt === 'number' && Date.now() - lastUpdateAt > 15_000;

            if (isStale && !isRefreshingRef.current) {
                isRefreshingRef.current = true;
                refreshState().finally(() => {
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
            socket: ablyClient,
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
