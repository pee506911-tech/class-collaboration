import { safeLocalStorageGet } from "@/lib/storage";

export type HttpErrorKind = "offline" | "timeout" | "aborted" | "network" | "http";

export class HttpRequestError extends Error {
  kind: HttpErrorKind;
  url: string;
  method: string;
  status?: number;
  requestId: string;
  retriable: boolean;

  constructor(
    message: string,
    options: {
      kind: HttpErrorKind;
      url: string;
      method: string;
      requestId: string;
      status?: number;
      retriable?: boolean;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = "HttpRequestError";
    this.kind = options.kind;
    this.url = options.url;
    this.method = options.method;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retriable = options.retriable ?? false;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export type RetryConfig = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
};

const DEFAULT_TIMEOUT_MS = 15000;

export function createClientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function classifyNetworkError(
  error: unknown,
  didTimeout: boolean
): { kind: HttpErrorKind; retriable: boolean; message: string } {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);

  if (name === "AbortError") {
    if (didTimeout) return { kind: "timeout", retriable: true, message: "Request timed out" };
    return { kind: "aborted", retriable: false, message: "Request was aborted" };
  }

  // fetch() network failures are typically TypeError in browsers
  const offline =
    typeof navigator !== "undefined" &&
    Object.prototype.hasOwnProperty.call(navigator, "onLine") &&
    navigator.onLine === false;
  if (offline) return { kind: "offline", retriable: true, message: "You appear to be offline" };

  return { kind: "network", retriable: true, message };
}

async function readErrorBody(response: Response): Promise<string | undefined> {
  try {
    const cloned = response.clone();
    const contentType = cloned.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const json = (await cloned.json()) as any;
      if (json && typeof json.error === "string" && json.error.length > 0) {
        return json.error;
      }
      if (json && typeof json.message === "string" && json.message.length > 0) {
        return json.message;
      }
    }
    const text = await cloned.text();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function mergeHeaders(
  base: HeadersInit | undefined,
  extra: Record<string, string>
): HeadersInit {
  const headers = new Headers(base ?? {});
  Object.entries(extra).forEach(([k, v]) => headers.set(k, v));
  return headers;
}

export async function httpFetch(
  url: string,
  options: RequestInit & {
    timeoutMs?: number;
    clientRequestId?: string;
    retry?: RetryConfig | false;
    idempotent?: boolean;
    throwOnHttpError?: boolean;
  } = {}
): Promise<{ response: Response; requestId: string }> {
  const method = (options.method || "GET").toUpperCase();
  const requestId = options.clientRequestId || createClientRequestId();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const throwOnHttpError = options.throwOnHttpError ?? true;
  const retryConfig =
    options.retry === false ? null : options.retry ?? (options.idempotent ? DEFAULT_RETRY : null);

  let lastError: HttpRequestError | null = null;

  for (let attempt = 0; attempt <= (retryConfig?.maxRetries ?? 0); attempt++) {
    let abortListener: (() => void) | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    let didTimeout = false;

    try {
      if (options.signal) {
        if (options.signal.aborted) {
          controller.abort();
        } else {
          abortListener = () => controller.abort();
          options.signal.addEventListener("abort", abortListener);
        }
      }

      timeoutId = setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, timeoutMs);

      const headers = mergeHeaders(options.headers, { "X-Client-Request-Id": requestId });
      const response = await fetch(url, { ...options, headers, signal: controller.signal });

      if (!response.ok) {
        const retriable = isRetryableStatus(response.status);
        if (retryConfig && retriable && attempt < retryConfig.maxRetries) {
          const delay = Math.min(
            retryConfig.baseDelayMs * Math.pow(2, attempt),
            retryConfig.maxDelayMs
          );
          await sleep(delay);
          continue;
        }

        if (!throwOnHttpError) {
          return { response, requestId };
        }

        const bodyMessage = await readErrorBody(response);
        const message = bodyMessage || `HTTP ${response.status}`;
        throw new HttpRequestError(message, {
          kind: "http",
          url,
          method,
          requestId,
          status: response.status,
          retriable,
        });
      }

      return { response, requestId };
    } catch (error: unknown) {
      const { kind, retriable, message } = classifyNetworkError(error, didTimeout);
      lastError =
        error instanceof HttpRequestError
          ? error
          : new HttpRequestError(message, {
              kind,
              url,
              method,
              requestId,
              retriable,
              cause: error,
            });

      // Caller-aborted requests should not retry
      if (options.signal?.aborted || kind === "aborted") {
        break;
      }

      if (retryConfig && retriable && attempt < retryConfig.maxRetries) {
        const delay = Math.min(
          retryConfig.baseDelayMs * Math.pow(2, attempt),
          retryConfig.maxDelayMs
        );
        await sleep(delay);
        continue;
      }

      break;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (abortListener && options.signal) {
        options.signal.removeEventListener("abort", abortListener);
      }
    }
  }

  throw lastError ?? new HttpRequestError("Request failed", { kind: "network", url, method, requestId, retriable: true });
}

export function getAuthToken(): string | null {
  return safeLocalStorageGet("token");
}
