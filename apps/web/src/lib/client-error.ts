import { httpFetch } from "@/lib/http";

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + "…";
}

function safeString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback || String(value);
  }
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(safeString(value, "Unknown error"));
}

function inferContextFromPathname(pathname: string): { sessionId?: string; role?: string } {
  const match =
    pathname.match(/^\/staff\/session\/([^/]+)/) ||
    pathname.match(/^\/projector\/session\/([^/]+)/) ||
    pathname.match(/^\/projector\/([^/]+)/) ||
    pathname.match(/^\/student\/session\/([^/]+)/);

  const sessionId = match?.[1];

  const role = pathname.startsWith("/staff")
    ? "staff"
    : pathname.startsWith("/student")
      ? "student"
      : pathname.startsWith("/projector")
        ? "projector"
        : undefined;

  return { sessionId, role };
}

export async function reportClientError(
  error: unknown,
  options?: {
    source?: string;
    errorInfo?: unknown;
    context?: { sessionId?: string; role?: string; participantId?: string };
    clientRequestId?: string;
  }
) {
  if (typeof window === "undefined") return;

  try {
    const err = toError(error);
    const url = window.location.href;
    const userAgent = navigator.userAgent;
    const timestamp = Date.now();

    const inferred = inferContextFromPathname(window.location.pathname);
    const context = { ...inferred, ...(options?.context ?? {}) };

    const body = {
      name: truncate(err.name || "Error", 100),
      message: truncate(err.message || "Unknown error", 2000),
      stack: truncate(err.stack || "", 8000),
      url: truncate(url, 2048),
      userAgent: truncate(userAgent, 512),
      timestamp,
      source: truncate(options?.source || "unknown", 100),
      clientRequestId: options?.clientRequestId,
      context,
      errorInfo:
        options?.errorInfo !== undefined
          ? truncate(safeString(options.errorInfo, ""), 2000)
          : undefined,
    };

    const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/api";
    await httpFetch(`${apiBase}/client-error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 5000,
      retry: false,
      // Helps send during unload/navigation in some browsers
      keepalive: true,
      idempotent: true,
    });
  } catch {
    // Never let telemetry crash the app
  }
}

