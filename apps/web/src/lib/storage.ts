type StorageKind = "local" | "session";

const memoryLocal = new Map<string, string>();
const memorySession = new Map<string, string>();

let cachedLocalStorage: Storage | null | undefined;
let cachedSessionStorage: Storage | null | undefined;

function getMemory(kind: StorageKind) {
  return kind === "local" ? memoryLocal : memorySession;
}

function getWebStorage(kind: StorageKind): Storage | null {
  if (typeof window === "undefined") return null;

  const cached = kind === "local" ? cachedLocalStorage : cachedSessionStorage;
  if (cached !== undefined) return cached;

  try {
    const storage = kind === "local" ? window.localStorage : window.sessionStorage;
    // Safari can throw on access even if the property exists
    const testKey = "__classcolab_storage_test__";
    storage.setItem(testKey, "1");
    storage.removeItem(testKey);
    if (kind === "local") {
      cachedLocalStorage = storage;
    } else {
      cachedSessionStorage = storage;
    }
    return storage;
  } catch {
    if (kind === "local") {
      cachedLocalStorage = null;
    } else {
      cachedSessionStorage = null;
    }
    return null;
  }
}

function safeToString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeGet(kind: StorageKind, key: string): string | null {
  const storage = getWebStorage(kind);
  if (storage) {
    try {
      return storage.getItem(key);
    } catch {
      // fall through to memory
    }
  }
  return getMemory(kind).get(key) ?? null;
}

function safeSet(kind: StorageKind, key: string, value: string): boolean {
  const storage = getWebStorage(kind);
  if (storage) {
    try {
      storage.setItem(key, value);
      return true;
    } catch {
      // fall through to memory
    }
  }
  getMemory(kind).set(key, value);
  return false;
}

function safeRemove(kind: StorageKind, key: string): boolean {
  const storage = getWebStorage(kind);
  if (storage) {
    try {
      storage.removeItem(key);
      return true;
    } catch {
      // fall through to memory
    }
  }
  getMemory(kind).delete(key);
  return false;
}

export function safeLocalStorageGet(key: string): string | null {
  return safeGet("local", key);
}

export function safeLocalStorageSet(key: string, value: string): boolean {
  return safeSet("local", key, value);
}

export function safeLocalStorageRemove(key: string): boolean {
  return safeRemove("local", key);
}

export function safeSessionStorageGet(key: string): string | null {
  return safeGet("session", key);
}

export function safeSessionStorageSet(key: string, value: string): boolean {
  return safeSet("session", key, value);
}

export function safeSessionStorageRemove(key: string): boolean {
  return safeRemove("session", key);
}

export function safeLocalStorageGetJson<T>(key: string): T | null {
  const raw = safeLocalStorageGet(key);
  if (!raw) return null;
  return safeJsonParse<T>(raw);
}

export function safeLocalStorageSetJson(key: string, value: unknown): boolean {
  return safeLocalStorageSet(key, safeToString(value));
}

export function safeSessionStorageGetJson<T>(key: string): T | null {
  const raw = safeSessionStorageGet(key);
  if (!raw) return null;
  return safeJsonParse<T>(raw);
}

export function safeSessionStorageSetJson(key: string, value: unknown): boolean {
  return safeSessionStorageSet(key, safeToString(value));
}
