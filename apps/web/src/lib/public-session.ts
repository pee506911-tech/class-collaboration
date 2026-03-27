import { httpFetch, HttpRequestError, type RetryConfig } from "@/lib/http";
import {
  safeSessionStorageGetJson,
  safeSessionStorageRemove,
  safeSessionStorageSetJson,
} from "@/lib/storage";
import type { ApiResponse } from "shared";

const PRELOAD_TTL_MS = 30_000;
const PRELOAD_KEY_PREFIX = "preloaded_session_";

type PreloadedPublicSession = {
  expiresAt: number;
  requestId: string;
  data: any;
};

export type PublicSessionLookupOk = {
  ok: true;
  requestId: string;
  data: any;
};

export type PublicSessionLookupErr = {
  ok: false;
  requestId: string;
  status?: number;
  kind?: "offline" | "timeout" | "aborted" | "network" | "http";
  message: string;
  retryable: boolean;
};

export type PublicSessionLookupResult = PublicSessionLookupOk | PublicSessionLookupErr;

export function normalizeJoinCode(input: string): string {
  return input.trim().toLowerCase().replace(/[\s-]+/g, "");
}

export function isValidJoinCode(normalizedCode: string): boolean {
  return /^[0-9a-f]{8}$/.test(normalizedCode);
}

function preloadKey(token: string): string {
  return `${PRELOAD_KEY_PREFIX}${token}`;
}

export function readPreloadedPublicSession(token: string): { requestId: string; data: any } | null {
  const normalized = normalizeJoinCode(token);
  if (!isValidJoinCode(normalized)) return null;

  const value = safeSessionStorageGetJson<PreloadedPublicSession>(preloadKey(normalized));
  if (!value) return null;

  if (typeof value.expiresAt !== "number" || value.expiresAt < Date.now()) {
    safeSessionStorageRemove(preloadKey(normalized));
    return null;
  }

  return { requestId: value.requestId, data: value.data };
}

export function writePreloadedPublicSession(token: string, data: any, requestId: string) {
  const normalized = normalizeJoinCode(token);
  if (!isValidJoinCode(normalized)) return;

  safeSessionStorageSetJson(preloadKey(normalized), {
    expiresAt: Date.now() + PRELOAD_TTL_MS,
    requestId,
    data,
  } satisfies PreloadedPublicSession);
}

const PUBLIC_LOOKUP_RETRY: RetryConfig = {
  maxRetries: 2,
  baseDelayMs: 300,
  maxDelayMs: 1200,
};

export async function getPublicSessionByToken(
  token: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<PublicSessionLookupResult> {
  const normalized = normalizeJoinCode(token);
  const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/api";
  const url = `${apiBase}/session-by-token/${encodeURIComponent(normalized)}`;

  try {
    const { response, requestId } = await httpFetch(url, {
      method: "GET",
      timeoutMs: options?.timeoutMs ?? 10_000,
      signal: options?.signal,
      idempotent: true,
      retry: PUBLIC_LOOKUP_RETRY,
      throwOnHttpError: false,
    });

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const json = (await response.clone().json()) as Partial<ApiResponse<any>>;
        if (typeof json.error === "string" && json.error.length > 0) {
          message = json.error;
        }
      } catch {
        // ignore
      }

      return {
        ok: false,
        requestId,
        status: response.status,
        kind: "http",
        message,
        retryable: response.status >= 500 || response.status === 429 || response.status === 408,
      };
    }

    const json = (await response.json()) as ApiResponse<any>;
    if (!json.success) {
      return {
        ok: false,
        requestId,
        status: response.status,
        kind: "http",
        message: json.error || "Failed to load session",
        retryable: false,
      };
    }

    return { ok: true, requestId, data: json.data };
  } catch (error: unknown) {
    if (error instanceof HttpRequestError) {
      return {
        ok: false,
        requestId: error.requestId,
        status: error.status,
        kind: error.kind,
        message: error.message || "Request failed",
        retryable: error.retriable,
      };
    }

    return {
      ok: false,
      requestId: "",
      kind: "network",
      message: error instanceof Error ? error.message : "Request failed",
      retryable: true,
    };
  }
}

