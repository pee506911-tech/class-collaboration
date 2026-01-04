'use client';

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import * as Ably from 'ably';
import { StateUpdatePayload } from 'shared';

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
    };
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
    voteResults: Record<string, Record<string, number>>;
    sendMessage: (type: string, payload: any) => void;
    updateState: (updates: Partial<StateUpdatePayload>) => void;
    lostCount: number;
    serverTimeOffset: number;
    slideStartTime: number | null;
    questions: any[];
    activeParticipants: number;
    lastSlideUpdate: number;
    socket: any | null;
    initialStateLoaded: boolean;
}

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
    const [voteResults, setVoteResults] = useState<Record<string, Record<string, number>>>({});
    const [lostCount] = useState(0);
    const [serverTimeOffset] = useState(0);
    const [slideStartTime] = useState<number | null>(null);
    const [questions, setQuestions] = useState<any[]>([]);
    const [activeParticipants, setActiveParticipants] = useState(0);
    const [lastSlideUpdate, setLastSlideUpdate] = useState(0);
    const [ablyClient, setAblyClient] = useState<Ably.Realtime | null>(null);

    const participantIdRef = useRef<string>('');
    const ablyClientRef = useRef<Ably.Realtime | null>(null);
    const isLeaderRef = useRef<boolean>(false);
    const leaderSinceRef = useRef<number>(0); // When we became leader
    const leaderCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const leaderPingIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const leaderPongTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const bcRef = useRef<BroadcastChannel | null>(null);
    const isMountedRef = useRef<boolean>(true);

    // Message buffer for failover gap
    const messageBufferRef = useRef<Array<{ name: string; data: any; timestamp: number }>>([]);
    const isInFailoverRef = useRef<boolean>(false);

    // State refs for sharing during failover
    const stateRef = useRef<StateUpdatePayload | null>(null);
    const voteResultsRef = useRef<Record<string, Record<string, number>>>({});
    const questionsRef = useRef<any[]>([]);

    // Keep refs in sync with state
    useEffect(() => { stateRef.current = state; }, [state]);
    useEffect(() => { voteResultsRef.current = voteResults; }, [voteResults]);
    useEffect(() => { questionsRef.current = questions; }, [questions]);

    // Fetch initial state IMMEDIATELY on mount (before Ably connection)
    // This prevents the flash of incorrect UI state
    useEffect(() => {
        if (!sessionId || initialStateLoaded) return;
        
        const fetchInitialStateEarly = async () => {
            try {
                const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
                const res = await fetch(`${apiBase}/sessions/${sessionId}/state`);
                if (res.ok) {
                    const data = await res.json();
                    setState(data);
                    if (data.questions) setQuestions(data.questions);
                    if (data.voteCounts) setVoteResults(data.voteCounts);
                }
            } catch (e) {
                console.error('Failed to fetch initial state early:', e);
            } finally {
                setInitialStateLoaded(true);
            }
        };
        
        fetchInitialStateEarly();
    }, [sessionId, initialStateLoaded]);

    useEffect(() => {
        let pid = localStorage.getItem('participantId');
        if (!pid) {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) {
                pid = crypto.randomUUID();
            } else {
                pid = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
            }
            localStorage.setItem('participantId', pid);
        }
        participantIdRef.current = pid;
    }, []);

    // Handle incoming Ably messages (for both leader and follower)
    const handleAblyMessage = useCallback((messageName: string, data: any) => {
        if (!isMountedRef.current) return;

        // If in failover, buffer the message
        if (isInFailoverRef.current) {
            messageBufferRef.current.push({ name: messageName, data, timestamp: Date.now() });
            return;
        }

        const payload = data;

        if (messageName === 'STATE_UPDATE') {
            const stateData = payload?.payload || payload;
            if (stateData) {
                setState(prev => ({ ...prev, ...stateData }));
                if (stateData.questions) setQuestions(stateData.questions);
                if (stateData.voteCounts) setVoteResults(stateData.voteCounts);
            }
        } else if (messageName === 'VOTE_UPDATE') {
            setVoteResults(prev => ({
                ...prev,
                [payload.slideId]: payload.results
            }));
        } else if (messageName === 'QA_UPDATE') {
            if (payload.payload?.questions) {
                setQuestions(payload.payload.questions);
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

        const hasBroadcastChannel = typeof BroadcastChannel !== 'undefined';

        isMountedRef.current = true;
        let client: Ably.Realtime | null = null;
        let bc: BroadcastChannel | null = null;
        const channelName = `ably-session-${sessionId}-${role}`;

        // Track when we last heard from a leader and their priority
        let lastLeaderTimestamp = 0;
        let currentLeaderSince = 0;
        let currentLeaderTabId = '';

        const fetchInitialState = async () => {
            try {
                const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
                const res = await fetch(`${apiBase}/sessions/${sessionId}/state`);
                if (res.ok && isMountedRef.current) {
                    const data = await res.json();
                    setState(data);
                    if (data.questions) setQuestions(data.questions);
                    if (data.voteCounts) setVoteResults(data.voteCounts);
                }
            } catch (e) {
                console.error('Failed to fetch initial state:', e);
            }

            if (role === 'student') {
                const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
                fetch(`${apiBase}/sessions/${sessionId}/register-participant`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        participantId: participantIdRef.current,
                        name: name || 'Anonymous'
                    })
                }).catch(() => { });
            }
        };

        const createAblyConnection = () => {
            if (client) return;

            const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';


            client = new Ably.Realtime({
                authUrl: `${apiBase}/auth/ably?sessionId=${sessionId}&role=${role}&participantId=${participantIdRef.current}`,
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
                            questions: questionsRef.current
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

        if (hasBroadcastChannel) {
            bc = new BroadcastChannel(channelName);
            bcRef.current = bc;
            broadcastChannels.set(sessionId, bc);

            bc.onmessage = (event: MessageEvent<TabMessage>) => {
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

                            bc?.postMessage({
                                type: 'LEADER_ANNOUNCE',
                                sessionId,
                                tabId: TAB_ID,
                                timestamp: Date.now(),
                                leaderSince: leaderSinceRef.current
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
                    } else {
                        fetchInitialState();
                    }

                    startLeaderHealthCheck();

                } else if (msg.type === 'REQUEST_LEADER') {
                    if (isLeaderRef.current) {
                        bc?.postMessage({
                            type: 'LEADER_ANNOUNCE',
                            sessionId,
                            tabId: TAB_ID,
                            timestamp: Date.now(),
                            leaderSince: leaderSinceRef.current,
                            currentState: {
                                state: stateRef.current,
                                voteResults: voteResultsRef.current,
                                questions: questionsRef.current
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
                }
            };


            bc.postMessage({ type: 'REQUEST_LEADER', sessionId, tabId: TAB_ID });

            leaderCheckTimeoutRef.current = setTimeout(() => {
                if (!isMountedRef.current) return;
                becomeLeader();
            }, 200);

        } else {

            becomeLeader();
        }

        return () => {
            isMountedRef.current = false;

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

    const sendMessage = async (type: string, payload: any) => {
        const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';

        try {
            switch (type) {
                case 'SUBMIT_VOTE':
                    await fetch(`${apiBase}/sessions/${sessionId}/vote`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...payload, participantId: participantIdRef.current })
                    });
                    break;
                case 'SUBMIT_ANSWER':
                    await fetch(`${apiBase}/sessions/${sessionId}/vote`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            slideId: payload.slideId,
                            optionId: payload.answer,
                            participantId: participantIdRef.current,
                            timeRemaining: payload.timeRemaining
                        })
                    });
                    break;
                case 'SUBMIT_QUESTION':
                    await fetch(`${apiBase}/sessions/${sessionId}/questions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...payload, participantId: participantIdRef.current })
                    });
                    break;
                case 'UPVOTE_QUESTION':
                    await fetch(`${apiBase}/sessions/${sessionId}/questions/${payload.questionId}/upvote`, {
                        method: 'POST'
                    });
                    break;
                case 'SET_SLIDE':

                    const token = localStorage.getItem('token');
                    await fetch(`${apiBase}/sessions/${sessionId}/current-slide`, {
                        method: 'PUT',
                        headers: { 
                            'Content-Type': 'application/json',
                            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                        },
                        body: JSON.stringify(payload),
                    });
                    break;
                case 'STATE_UPDATE':
                    if (payload.showResults !== undefined) {
                        const authToken = localStorage.getItem('token');
                        await fetch(`${apiBase}/sessions/${sessionId}/results-visibility`, {
                            method: 'PUT',
                            headers: { 
                                'Content-Type': 'application/json',
                                ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
                            },
                            body: JSON.stringify({ visible: payload.showResults }),
                        });
                    }
                    break;
            }
        } catch (e) {
            console.error('Error sending message:', e);
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
            voteResults,
            sendMessage,
            updateState,
            lostCount,
            serverTimeOffset,
            slideStartTime,
            questions,
            activeParticipants,
            lastSlideUpdate,
            socket: ablyClient,
            initialStateLoaded
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
