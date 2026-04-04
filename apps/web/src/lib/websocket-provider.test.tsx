import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import React from "react";

// ─── Module Mocks (hoisted by vi.mock) ─────────────────────────────────────

// --- Mock: Ably SDK ---
vi.mock("ably", () => {
  const Realtime = vi.fn(function _RealtimeCtor(this: any, _opts: unknown) {
    this.connection = {
      state: "connecting" as string,
      on: vi.fn(),
      off: vi.fn(),
    };
    this.channels = {
      get: vi.fn().mockReturnValue({
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        publish: vi.fn(),
      }),
    };
    this.close = vi.fn();
  });
  return { Realtime };
});

// --- Mock: httpFetch ---
vi.mock("@/lib/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http")>();
  return {
    ...actual,
    httpFetch: vi.fn(),
  };
});

// --- Mock: participant-id ---
vi.mock("@/lib/participant-id", () => ({
  getOrCreateParticipantId: vi.fn(() => "test-participant-abc"),
}));

// --- Mock: storage ---
vi.mock("@/lib/storage", () => ({
  safeLocalStorageGet: vi.fn(() => null),
  safeLocalStorageSet: vi.fn(),
}));

// ─── BroadcastChannel Mock (installed on globalThis) ────────────────────────

interface TabMessage {
  type: string;
  sessionId?: string;
  tabId?: string;
  message?: { name: string; data: unknown };
  timestamp?: number;
  leaderSince?: number;
  currentState?: {
    state: unknown;
    voteResults: Record<string, Record<string, number>>;
    questions: unknown[];
    voteSequence?: number;
    qaSequence?: number;
  };
}

class MockBroadcastChannel {
  name: string;
  onmessage: ((event: MessageEvent<TabMessage>) => void) | null = null;
  private closed = false;

  constructor(name: string) {
    this.name = name;
    MockBCRegistry.add(this);
  }

  postMessage(msg: TabMessage): void {
    if (this.closed) return;
    MockBCRegistry.deliver(this, msg);
  }

  close(): void {
    this.closed = true;
    this.onmessage = null;
    MockBCRegistry.remove(this);
  }

  receive(msg: TabMessage): void {
    if (this.closed) return;
    this.onmessage?.(new MessageEvent("message", { data: msg }));
  }
}

class MockBCRegistry {
  static channels = new Set<MockBroadcastChannel>();

  static add(ch: MockBroadcastChannel) { this.channels.add(ch); }
  static remove(ch: MockBroadcastChannel) { this.channels.delete(ch); }

  static deliver(sender: MockBroadcastChannel, msg: TabMessage) {
    for (const ch of this.channels) {
      if (ch !== sender) ch.receive(msg);
    }
  }

  static reset() {
    for (const ch of this.channels) ch.close();
    this.channels.clear();
  }

  static all() { return [...this.channels]; }
}

const OriginalBC = (globalThis as any).BroadcastChannel;

beforeEach(() => {
  (globalThis as any).BroadcastChannel = MockBroadcastChannel;
  MockBCRegistry.reset();
});

afterEach(() => {
  MockBCRegistry.reset();
  if (OriginalBC) {
    (globalThis as any).BroadcastChannel = OriginalBC;
  } else {
    delete (globalThis as any).BroadcastChannel;
  }
});

// ─── Import After Mocks ────────────────────────────────────────────────────

import { WebSocketProvider, useWebSocket, SendAck } from "./websocket";
import * as Ably from "ably";
import { httpFetch } from "@/lib/http";

const mockAbly = Ably.Realtime as unknown as ReturnType<typeof vi.fn>;
const mockHttp = httpFetch as unknown as ReturnType<typeof vi.fn>;

// Helper type matching the WebSocketContextType from websocket.tsx
interface WSContext {
  isConnected: boolean;
  isConnecting: boolean;
  connectionError: string | null;
  state: any | null;
  initialStateError: string | null;
  voteResults: Record<string, Record<string, number>>;
  sendMessage: (type: string, payload: any) => Promise<any>;
  refreshState: () => Promise<any>;
  updateState: (updates: Partial<any>) => void;
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
  myVotes: Record<string, string[]>;
}

// ─── Test Utilities ────────────────────────────────────────────────────────

function mockResponse(ok: boolean, data?: unknown, status = 200) {
  return { ok, status, json: async () => data };
}

function resetMocks() {
  mockHttp.mockReset();
}

/** Wait for the Ably connection to be created for a specific session. */
async function waitForAblyConnection(sessionId: string) {
  await waitFor(() => {
    const calls = mockAbly.mock.calls;
    const found = calls.some((c: unknown[]) => {
      const url = (c[0] as any)?.authUrl ?? "";
      return typeof url === "string" && url.includes(sessionId);
    });
    expect(found).toBe(true);
  });
}
function lastAblyInstance() {
  return mockAbly.mock.results[mockAbly.mock.results.length - 1]?.value;
}

/** Helper: get the connection object of the last Ably instance. */
function lastAblyConnection() {
  return lastAblyInstance()?.connection;
}

/** Helper: get the channel object of the last Ably instance. */
function lastAblyChannel() {
  const inst = lastAblyInstance();
  return inst?.channels.get.mock.results[0]?.value;
}

/** Trigger an Ably connection state change. */
function triggerAblyConnectionState(state: string) {
  const conn = lastAblyConnection();
  if (!conn) throw new Error("No Ably instance created yet");
  conn.state = state;
  const handler = conn.on.mock.calls.find(
    (c: unknown[]) => (c as [string])[0] === state
  );
  if (handler) (handler as [string, () => void])[1]();
}

/** Trigger an incoming Ably message. */
function triggerAblyMessage(name: string, data: unknown) {
  const channel = lastAblyChannel();
  if (!channel) throw new Error("No channel subscribed");
  const handler = channel.subscribe.mock.calls[0]?.[0];
  if (!handler) throw new Error("No subscribe handler registered");
  handler({ name, data });
}

/** Consumer component that captures the WebSocket context. */
function ContextCapturer({
  onCapture,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onCapture: (ctx: any) => void;
}) {
  const ctx = useWebSocket();
  React.useEffect(() => { onCapture(ctx); });
  return <span data-testid="capturer" />;
}

// ─── Phase 1: Initial State Fetch ──────────────────────────────────────────

describe("WebSocketProvider - Initial State Fetch", () => {
  beforeEach(() => {
    resetMocks();
    MockBCRegistry.reset();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8080/api");
    vi.stubEnv("NEXT_PUBLIC_DISABLE_ABLY", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    MockBCRegistry.reset();
  });

  it("fetches state from /sessions/:id/state on mount", async () => {
    mockHttp.mockResolvedValue({
      response: mockResponse(true, { currentSlideId: "slide-1" }),
      requestId: "req-1",
    });

    render(
      <WebSocketProvider sessionId="sess-abc" role="staff">
        <span data-testid="child" />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(mockHttp).toHaveBeenCalledWith(
        "http://localhost:8080/api/sessions/sess-abc/state",
        expect.objectContaining({ idempotent: true })
      );
    });
  });

  it("fetches state exactly once (double-fetch prevention)", async () => {
    mockHttp.mockResolvedValue({
      response: mockResponse(true, { currentSlideId: "slide-1" }),
      requestId: "req-1",
    });

    render(
      <WebSocketProvider sessionId="sess-def" role="staff">
        <span data-testid="child" />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(mockHttp).toHaveBeenCalledTimes(1);
    });
  });

  it("populates questions from fetch response", async () => {
    const questions = [{ id: "q1", text: "What is this?", upvotes: 2 }];
    mockHttp.mockResolvedValue({
      response: mockResponse(true, { currentSlideId: "slide-1", questions }),
      requestId: "req-1",
    });

    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-q" role="staff">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(ctx?.questions).toEqual(questions);
    });
  });

  it("populates voteCounts from fetch response", async () => {
    const voteCounts = { "slide-1": { "opt-a": 5, "opt-b": 3 } };
    mockHttp.mockResolvedValue({
      response: mockResponse(true, { currentSlideId: "slide-1", voteCounts }),
      requestId: "req-1",
    });

    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-v" role="staff">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(ctx?.voteResults).toEqual(voteCounts);
    });
  });

  it("sets initialStateError on HTTP failure", async () => {
    mockHttp.mockResolvedValue({
      response: mockResponse(false, null, 500),
      requestId: "req-1",
    });

    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-err" role="staff">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(ctx?.initialStateError).toBe("HTTP 500");
    });
  });

  it("does NOT create Ably connection when NEXT_PUBLIC_DISABLE_ABLY=1", async () => {
    vi.stubEnv("NEXT_PUBLIC_DISABLE_ABLY", "1");
    mockHttp.mockResolvedValue({
      response: mockResponse(true, {}),
      requestId: "req-1",
    });

    render(
      <WebSocketProvider sessionId="sess-disabled" role="staff">
        <span data-testid="child" />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(mockHttp).toHaveBeenCalled();
    });

    expect(mockAbly).not.toHaveBeenCalled();
  });
});

// ─── Phase 2: Ably Connection Lifecycle ────────────────────────────────────

describe("WebSocketProvider - Connection State via Context", () => {
  beforeEach(() => {
    resetMocks();
    MockBCRegistry.reset();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8080/api");
    vi.stubEnv("NEXT_PUBLIC_DISABLE_ABLY", undefined);
    mockHttp.mockResolvedValue({
      response: mockResponse(true, {}),
      requestId: "req-1",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    MockBCRegistry.reset();
  });

  it("starts with isConnecting=true and isConnected=false", () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-state" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    expect(ctx?.isConnecting).toBe(true);
    expect(ctx?.isConnected).toBe(false);
  });

  it("creates Ably.Realtime with authUrl", async () => {
    render(
      <WebSocketProvider sessionId="sess-conn" role="staff">
        <span />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(mockAbly).toHaveBeenCalledWith(
        expect.objectContaining({
          authUrl: expect.stringContaining("/auth/ably"),
        })
      );
    });
  });

  it("includes sessionId and role in authUrl", async () => {
    render(
      <WebSocketProvider sessionId="sess-params" role="student">
        <span />
      </WebSocketProvider>
    );

    await waitFor(() => {
      const call = mockAbly.mock.calls[mockAbly.mock.calls.length - 1]?.[0];
      expect(call?.authUrl).toContain("sessionId=sess-params");
      expect(call?.authUrl).toContain("role=student");
    });
  });

  it("includes participantId in authUrl", async () => {
    render(
      <WebSocketProvider sessionId="sess-pid" role="student">
        <span />
      </WebSocketProvider>
    );

    await waitFor(() => {
      const call = mockAbly.mock.calls[mockAbly.mock.calls.length - 1]?.[0];
      expect(call?.authUrl).toContain("participantId=");
    });
  });

  it("subscribes to session:{sessionId} channel", async () => {
    render(
      <WebSocketProvider sessionId="my-session-123" role="student">
        <span />
      </WebSocketProvider>
    );

    await waitFor(() => {
      const inst = lastAblyInstance();
      expect(inst?.channels.get).toHaveBeenCalledWith("session:my-session-123");
    });
  });

  it("sets isConnected=true, isConnecting=false on connected event", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-state2" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(mockAbly).toHaveBeenCalled();
    });

    triggerAblyConnectionState("connected");

    await waitFor(() => {
      expect(ctx?.isConnected).toBe(true);
      expect(ctx?.isConnecting).toBe(false);
    });
  });

  it("sets isConnected=false on disconnected event", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-state3" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockAbly).toHaveBeenCalled(); });

    triggerAblyConnectionState("connected");
    await waitFor(() => { expect(ctx?.isConnected).toBe(true); });

    triggerAblyConnectionState("disconnected");

    await waitFor(() => {
      expect(ctx?.isConnected).toBe(false);
    });
  });

  it("sets connectionError on failed event", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-state4" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockAbly).toHaveBeenCalled(); });

    triggerAblyConnectionState("failed");

    await waitFor(() => {
      expect(ctx?.connectionError).not.toBeNull();
    });
  });
});

// ─── Phase 3: Role-Based Behavior ──────────────────────────────────────────

describe("WebSocketProvider - Role-Based Behavior", () => {
  beforeEach(() => {
    resetMocks();
    MockBCRegistry.reset();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8080/api");
    vi.stubEnv("NEXT_PUBLIC_DISABLE_ABLY", undefined);
    mockHttp.mockResolvedValue({
      response: mockResponse(true, {}),
      requestId: "req-1",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    MockBCRegistry.reset();
  });

  it("student role creates its own Ably connection", async () => {
    render(
      <WebSocketProvider sessionId="sess-student" role="student">
        <span />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(mockAbly).toHaveBeenCalled();
    });

    expect(lastAblyInstance()).toBeDefined();
  });

  it("staff role creates BroadcastChannel", async () => {
    render(
      <WebSocketProvider sessionId="sess-staff" role="staff">
        <span />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(MockBCRegistry.all().length).toBeGreaterThan(0);
    });
  });

  it("projector role creates BroadcastChannel", async () => {
    render(
      <WebSocketProvider sessionId="sess-proj" role="projector">
        <span />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(MockBCRegistry.all().length).toBeGreaterThan(0);
    });
  });

  it("student fetchs my-votes on mount", async () => {
    mockHttp
      .mockResolvedValueOnce({ response: mockResponse(true, {}), requestId: "r1" })
      .mockResolvedValueOnce({
        response: mockResponse(true, { data: { votes: {} } }),
        requestId: "r2",
      });

    render(
      <WebSocketProvider sessionId="sess-votes" role="student" name="Alice">
        <span />
      </WebSocketProvider>
    );

    await waitFor(() => {
      const calls = mockHttp.mock.calls;
      expect(calls.some((c: unknown[]) => (c[0] as string).includes("/my-votes"))).toBe(true);
    });
  });

  it("student registers participant when name is provided", async () => {
    mockHttp.mockResolvedValue({
      response: mockResponse(true, {}),
      requestId: "req-1",
    });

    render(
      <WebSocketProvider sessionId="sess-reg" role="student" name="Bob">
        <span />
      </WebSocketProvider>
    );

    await waitFor(() => {
      const calls = mockHttp.mock.calls;
      expect(
        calls.some(
          (c: unknown[]) =>
            (c[0] as string).includes("/register-participant") &&
            (c[1] as any)?.body?.includes("Bob")
        )
      ).toBe(true);
    });
  });

  it("student skips registration when name is empty", async () => {
    mockHttp.mockResolvedValue({
      response: mockResponse(true, {}),
      requestId: "req-1",
    });

    render(
      <WebSocketProvider sessionId="sess-noreg" role="student" name="">
        <span />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(mockHttp).toHaveBeenCalledWith(
        expect.stringContaining("/state"),
        expect.any(Object)
      );
    });

    await new Promise((r) => setTimeout(r, 100));

    const calls = mockHttp.mock.calls;
    expect(
      calls.some((c: unknown[]) => (c[0] as string).includes("/register-participant"))
    ).toBe(false);
  });
});

// ─── Phase 4: Message Handling ─────────────────────────────────────────────

describe("WebSocketProvider - Message Handling via Ably", () => {
  beforeEach(() => {
    resetMocks();
    MockBCRegistry.reset();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8080/api");
    vi.stubEnv("NEXT_PUBLIC_DISABLE_ABLY", undefined);
    mockHttp.mockResolvedValue({
      response: mockResponse(true, { currentSlideId: "slide-1" }),
      requestId: "req-1",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    MockBCRegistry.reset();
  });

  it("STATE_UPDATE applies payload to context state", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-msg1" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(ctx?.state).not.toBeNull(); });

    triggerAblyMessage("STATE_UPDATE", {
      payload: { currentSlideId: "slide-new", isBlackout: true },
    });

    await waitFor(() => {
      expect(ctx?.state?.currentSlideId).toBe("slide-new");
      expect(ctx?.state?.isBlackout).toBe(true);
    });
  });

  it("STATE_UPDATE updates questions when present", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-msg2" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockAbly).toHaveBeenCalled(); });

    const questions = [{ id: "q1", text: "Hello?", upvotes: 0 }];
    triggerAblyMessage("STATE_UPDATE", {
      payload: { currentSlideId: "slide-1", questions },
    });

    await waitFor(() => {
      expect(ctx?.questions).toEqual(questions);
    });
  });

  it("STATE_UPDATE updates voteCounts when present", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-msg3" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockAbly).toHaveBeenCalled(); });

    const voteCounts = { "slide-1": { a: 3, b: 5 } };
    triggerAblyMessage("STATE_UPDATE", {
      payload: { currentSlideId: "slide-1", voteCounts },
    });

    await waitFor(() => {
      expect(ctx?.voteResults).toEqual(voteCounts);
    });
  });

  it("VOTE_UPDATE merges results for the given slideId", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-vote1" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockAbly).toHaveBeenCalled(); });

    triggerAblyMessage("VOTE_UPDATE", {
      slideId: "slide-x",
      results: { "opt-1": 10, "opt-2": 5 },
    });

    await waitFor(() => {
      expect(ctx?.voteResults["slide-x"]).toEqual({ "opt-1": 10, "opt-2": 5 });
    });
  });

  it("QA_UPDATE replaces questions list (nested payload format)", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-qa1" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockAbly).toHaveBeenCalled(); });

    const newQuestions = [{ id: "q-new", text: "New question", upvotes: 1 }];
    triggerAblyMessage("QA_UPDATE", {
      payload: { questions: newQuestions },
      sequence: 1,
    });

    await waitFor(() => {
      expect(ctx?.questions).toEqual(newQuestions);
    });
  });

  it("QA_UPDATE handles direct questions format (not nested)", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-qa2" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockAbly).toHaveBeenCalled(); });

    const newQuestions = [{ id: "q-direct", text: "Direct format", upvotes: 2 }];
    triggerAblyMessage("QA_UPDATE", {
      questions: newQuestions,
      sequence: 1,
    });

    await waitFor(() => {
      expect(ctx?.questions).toEqual(newQuestions);
    });
  });

  it("PARTICIPANT_COUNT_UPDATE sets active participants", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-part" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockAbly).toHaveBeenCalled(); });

    triggerAblyMessage("PARTICIPANT_COUNT_UPDATE", { count: 42 });

    await waitFor(() => {
      expect(ctx?.activeParticipants).toBe(42);
    });
  });

  it("SLIDES_UPDATE updates lastSlideUpdate timestamp", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-slides" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockAbly).toHaveBeenCalled(); });

    const before = ctx?.lastSlideUpdate ?? 0;
    triggerAblyMessage("SLIDES_UPDATE", { slides: [] });

    await waitFor(() => {
      expect(ctx?.lastSlideUpdate).toBeGreaterThan(before);
    });
  });

  it("unknown message type is silently ignored", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-unknown" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    // Wait for initial state to be loaded (not just Ably connection)
    await waitFor(() => {
      expect(ctx?.state).not.toBeNull();
    });

    const prevState = { ...ctx!.state! };
    triggerAblyMessage("NONEXISTENT_EVENT", { foo: "bar" });

    // State should remain unchanged (deep equality check)
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx?.state).toEqual(prevState);
  });
});

// ─── Phase 5: Sequence Number Deduplication ────────────────────────────────

describe("WebSocketProvider - Sequence Number Deduplication", () => {
  beforeEach(() => {
    resetMocks();
    MockBCRegistry.reset();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8080/api");
    vi.stubEnv("NEXT_PUBLIC_DISABLE_ABLY", undefined);
    mockHttp.mockResolvedValue({
      response: mockResponse(true, {
        currentSlideId: "slide-1",
        voteSequence: 5,
        qaSequence: 3,
      }),
      requestId: "req-1",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    MockBCRegistry.reset();
  });

  it("VOTE_UPDATE with stale sequence is ignored", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-seq1" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockAbly).toHaveBeenCalled(); });

    triggerAblyMessage("VOTE_UPDATE", {
      slideId: "slide-x",
      results: { "opt-1": 999 },
      sequence: 3,
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(ctx?.voteResults["slide-x"]).toBeUndefined();
  });

  it("VOTE_UPDATE with newer sequence is applied", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-seq2" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockAbly).toHaveBeenCalled(); });

    triggerAblyMessage("VOTE_UPDATE", {
      slideId: "slide-y",
      results: { "opt-a": 10 },
      sequence: 6,
    });

    await waitFor(() => {
      expect(ctx?.voteResults["slide-y"]).toEqual({ "opt-a": 10 });
    });
  });

  it("QA_UPDATE with stale sequence is ignored", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-seq3" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockAbly).toHaveBeenCalled(); });

    triggerAblyMessage("QA_UPDATE", {
      payload: { questions: [{ id: "stale", text: "stale" }] },
      sequence: 1,
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(ctx?.questions.find((q: { id: string }) => q.id === "stale")).toBeUndefined();
  });

  it("STATE_UPDATE without stateVersion always applies", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-seq4" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockAbly).toHaveBeenCalled(); });

    triggerAblyMessage("STATE_UPDATE", {
      payload: { isBlackout: true },
    });

    await waitFor(() => {
      expect(ctx?.state?.isBlackout).toBe(true);
    });
  });
});

// ─── Phase 6: sendMessage Dispatch ─────────────────────────────────────────

describe("WebSocketProvider - sendMessage", () => {
  beforeEach(() => {
    resetMocks();
    MockBCRegistry.reset();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8080/api");
    mockHttp.mockResolvedValue({
      response: mockResponse(true, {}),
      requestId: "req-1",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    MockBCRegistry.reset();
  });

  it("SUBMIT_VOTE → POST /sessions/:id/vote with participantId", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-send1" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockHttp).toHaveBeenCalled(); });

    const result = await ctx!.sendMessage("SUBMIT_VOTE", {
      slideId: "slide-1",
      optionId: "opt-1",
    });

    expect(result.ok).toBe(true);

    const voteCall = mockHttp.mock.calls.find(
      (c: unknown[]) =>
        (c[0] as string).includes("/sessions/sess-send1/vote") &&
        (c[1] as any)?.method === "POST"
    );
    expect(voteCall).toBeDefined();
    const body = JSON.parse(voteCall![1].body);
    expect(body.participantId).toBe("test-participant-abc");
    expect(body.slideId).toBe("slide-1");
    expect(body.optionId).toBe("opt-1");
  });

  it("SUBMIT_QUESTION → POST /sessions/:id/questions", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-send2" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockHttp).toHaveBeenCalled(); });
    mockHttp.mockClear();

    await ctx!.sendMessage("SUBMIT_QUESTION", { text: "What is this?" });

    const qCall = mockHttp.mock.calls.find(
      (c: unknown[]) =>
        (c[0] as string).includes("/sessions/sess-send2/questions") &&
        !(c[0] as string).includes("/upvote")
    );
    expect(qCall).toBeDefined();
  });

  it("UPVOTE_QUESTION → POST /sessions/:id/questions/:id/upvote", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-send3" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockHttp).toHaveBeenCalled(); });
    mockHttp.mockClear();

    await ctx!.sendMessage("UPVOTE_QUESTION", { questionId: "q-42" });

    const upCall = mockHttp.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("/questions/q-42/upvote")
    );
    expect(upCall).toBeDefined();
    expect(JSON.parse(upCall![1].body).participantId).toBe("test-participant-abc");
  });

  it("SET_SLIDE → PUT /sessions/:id/current-slide", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-send4" role="staff">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockHttp).toHaveBeenCalled(); });
    mockHttp.mockClear();

    await ctx!.sendMessage("SET_SLIDE", { slideId: "slide-5" });

    const slideCall = mockHttp.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("/current-slide")
    );
    expect(slideCall).toBeDefined();
    expect(slideCall![1]?.method).toBe("PUT");
  });

  it("unknown type returns { ok: false }", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-send5" role="staff">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockHttp).toHaveBeenCalled(); });

    const result = await ctx!.sendMessage("UNKNOWN_TYPE", {});

    expect(result.ok).toBe(false);
    expect((result as Exclude<SendAck, { ok: true }>).message).toContain("UNKNOWN_TYPE");
  });

  it("HTTP error in sendMessage returns error ack", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-send6" role="student">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockHttp).toHaveBeenCalled(); });

    mockHttp.mockRejectedValueOnce(new Error("HTTP 500"));

    const result = await ctx!.sendMessage("SUBMIT_VOTE", {
      slideId: "s1",
      optionId: "o1",
    });

    expect(result.ok).toBe(false);
    expect((result as Exclude<SendAck, { ok: true }>).message).toBe("HTTP 500");
  });
});

// ─── Phase 7: refreshState ─────────────────────────────────────────────────

describe("WebSocketProvider - refreshState", () => {
  beforeEach(() => {
    resetMocks();
    MockBCRegistry.reset();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8080/api");
    mockHttp.mockResolvedValue({
      response: mockResponse(true, { currentSlideId: "slide-1" }),
      requestId: "req-1",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    MockBCRegistry.reset();
  });

  it("fetches state and returns { ok: true }", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-refresh1" role="staff">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockHttp).toHaveBeenCalled(); });

    const result = await ctx!.refreshState();

    expect(result.ok).toBe(true);
  });

  it("returns { ok: false } on HTTP failure", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-refresh2" role="staff">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockHttp).toHaveBeenCalled(); });

    mockHttp.mockRejectedValueOnce(new Error("Server error"));

    const result = await ctx!.refreshState();

    expect(result.ok).toBe(false);
  });
});

// ─── Phase 8: BroadcastChannel Leader Election ─────────────────────────────

describe("WebSocketProvider - Leader Election (BroadcastChannel)", () => {
  beforeEach(() => {
    resetMocks();
    MockBCRegistry.reset();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8080/api");
    vi.stubEnv("NEXT_PUBLIC_DISABLE_ABLY", undefined);
    mockHttp.mockResolvedValue({
      response: mockResponse(true, {}),
      requestId: "req-1",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    MockBCRegistry.reset();
  });

  it("staff role creates BroadcastChannel with session+role in name", async () => {
    render(
      <WebSocketProvider sessionId="staff-leader" role="staff">
        <span />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(MockBCRegistry.all().length).toBeGreaterThan(0);
    });

    const channels = MockBCRegistry.all();
    expect(channels[0].name).toContain("staff-leader");
    expect(channels[0].name).toContain("staff");
  });

  it("student role does NOT create BroadcastChannel", async () => {
    render(
      <WebSocketProvider sessionId="student-no-bc" role="student">
        <span />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(mockAbly).toHaveBeenCalled();
    });

    const channels = MockBCRegistry.all();
    expect(channels.length).toBe(0);
  });

  it("first staff tab becomes leader after timeout", async () => {
    render(
      <WebSocketProvider sessionId="first-tab" role="staff">
        <span />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(mockAbly).toHaveBeenCalled();
    }, { timeout: 3000 });

    expect(lastAblyInstance()).toBeDefined();
  });
});

// ─── Phase 9: Error Handling ───────────────────────────────────────────────

describe("WebSocketProvider - Error Handling", () => {
  beforeEach(() => {
    resetMocks();
    MockBCRegistry.reset();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8080/api");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    MockBCRegistry.reset();
  });

  it("initial state fetch HTTP 500 sets initialStateError", async () => {
    mockHttp.mockResolvedValue({
      response: mockResponse(false, null, 500),
      requestId: "req-1",
    });

    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-err500" role="staff">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(ctx?.initialStateError).toBe("HTTP 500");
    });
  });

  it("initial state fetch network error sets initialStateError", async () => {
    mockHttp.mockRejectedValue(new Error("NetworkError: fetch failed"));

    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-neterr" role="staff">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(ctx?.initialStateError).toContain("fetch failed");
    });
  });
});

// ─── Phase 10: updateState ─────────────────────────────────────────────────

describe("WebSocketProvider - updateState", () => {
  beforeEach(() => {
    resetMocks();
    MockBCRegistry.reset();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8080/api");
    mockHttp.mockResolvedValue({
      response: mockResponse(true, { currentSlideId: "slide-1" }),
      requestId: "req-1",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    MockBCRegistry.reset();
  });

  it("merges partial updates into existing state", async () => {
    let ctx: any = null;
    render(
      <WebSocketProvider sessionId="sess-update" role="staff">
        <ContextCapturer onCapture={(c) => { ctx = c; }} />
      </WebSocketProvider>
    );

    await waitFor(() => { expect(mockHttp).toHaveBeenCalled(); });

    ctx!.updateState({ isBlackout: true });

    await waitFor(() => {
      expect(ctx?.state?.isBlackout).toBe(true);
    });
  });
});

// ─── Phase 11: useWebSocket hook guard ─────────────────────────────────────

describe("useWebSocket hook", () => {
  it("throws when used outside WebSocketProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      render(<ContextCapturer onCapture={() => {}} />);
    }).toThrow("useWebSocket must be used within a WebSocketProvider");

    spy.mockRestore();
  });
});
