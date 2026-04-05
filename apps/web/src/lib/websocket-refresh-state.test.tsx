import React from "react";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http")>();
  return {
    ...actual,
    httpFetch: vi.fn(),
  };
});

vi.mock("./ws-auth", () => ({
  fetchWsToken: vi.fn(async () => "test-ws-token"),
}));

vi.mock("@/lib/participant-id", () => ({
  getOrCreateParticipantId: vi.fn(() => "participant-test-1"),
}));

vi.mock("@/lib/storage", () => ({
  safeLocalStorageGet: vi.fn(() => null),
  safeLocalStorageSet: vi.fn(),
}));

import { httpFetch } from "@/lib/http";
import { WebSocketProvider, useWebSocket } from "./websocket";

const mockHttp = httpFetch as unknown as ReturnType<typeof vi.fn>;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    setTimeout(() => {
      this.onopen?.(new Event("open"));
    }, 0);
  }

  close(_code?: number, _reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
  }
}

function mockResponse(ok: boolean, data?: unknown, status = 200) {
  return { ok, status, json: async () => data };
}

function ContextCapturer({ onCapture }: { onCapture: (ctx: any) => void }) {
  const ctx = useWebSocket();

  React.useEffect(() => {
    onCapture(ctx);
  }, [ctx, onCapture]);

  return null;
}

describe("WebSocketProvider refreshState vote fetch policy", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    mockHttp.mockReset();
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8080/api");

    mockHttp.mockImplementation(async (url: string) => {
      if (url.includes("/my-votes")) {
        return {
          response: mockResponse(true, { data: { votes: { "slide-1": ["opt-1"] } } }),
          requestId: "req-my-votes",
        };
      }

      return {
        response: mockResponse(true, {
          currentSlideId: "slide-1",
          stateVersion: 1,
          isPresentationActive: true,
        }),
        requestId: "req-state",
      };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.WebSocket = originalWebSocket;
  });

  it("keeps manual student refresh fetching my-votes by default", async () => {
    let ctx: any = null;

    render(
      <WebSocketProvider sessionId="sess-manual-refresh" role="student">
        <ContextCapturer onCapture={(value) => { ctx = value; }} />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(ctx?.initialStateLoaded).toBe(true);
    });

    mockHttp.mockClear();

    const result = await ctx.refreshState();

    expect(result.ok).toBe(true);
    expect(mockHttp.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      "http://localhost:8080/api/sessions/sess-manual-refresh/state",
      "http://localhost:8080/api/sessions/sess-manual-refresh/my-votes?participantId=participant-test-1",
    ]);
  });

  it("skips my-votes during stale realtime recovery refreshes", async () => {
    let ctx: any = null;

    render(
      <WebSocketProvider sessionId="sess-stale-refresh" role="student">
        <ContextCapturer onCapture={(value) => { ctx = value; }} />
      </WebSocketProvider>
    );

    await waitFor(() => {
      expect(ctx?.initialStateLoaded).toBe(true);
    });

    mockHttp.mockClear();

    const result = await ctx.refreshState({ includeMyVotes: false });

    expect(result.ok).toBe(true);
    expect(mockHttp).toHaveBeenCalledTimes(1);
    expect(mockHttp.mock.calls[0]?.[0]).toBe(
      "http://localhost:8080/api/sessions/sess-stale-refresh/state"
    );
  });
});
