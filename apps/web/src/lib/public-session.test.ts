import { describe, expect, it } from "vitest";
import {
  isValidJoinCode,
  normalizeJoinCode,
  readPreloadedPublicSession,
  writePreloadedPublicSession,
} from "@/lib/public-session";
import { safeLocalStorageRemove, safeSessionStorageRemove } from "@/lib/storage";

describe("normalizeJoinCode", () => {
  it("trims, lowercases, and removes whitespace/hyphens", () => {
    expect(normalizeJoinCode(" DEAD-BEEF ")).toBe("deadbeef");
    expect(normalizeJoinCode("de ad - be ef")).toBe("deadbeef");
    expect(normalizeJoinCode("\nDEAD\tBEEF\n")).toBe("deadbeef");
  });
});

describe("isValidJoinCode", () => {
  it("accepts 8-char hex tokens", () => {
    expect(isValidJoinCode("deadbeef")).toBe(true);
    expect(isValidJoinCode("0123abcd")).toBe(true);
  });

  it("rejects invalid tokens", () => {
    expect(isValidJoinCode("dead-beef")).toBe(false);
    expect(isValidJoinCode("deadbee")).toBe(false);
    expect(isValidJoinCode("deadbeef00")).toBe(false);
    expect(isValidJoinCode("deadbeeg")).toBe(false);
  });
});

describe("preloaded public session", () => {
  it("falls back to local storage when session storage is unavailable", () => {
    const token = "cafebabe";
    const key = `preloaded_session_${token}`;
    const payload = { id: "session-1", title: "Session 1" };

    safeSessionStorageRemove(key);
    safeLocalStorageRemove(key);

    writePreloadedPublicSession(token, payload, "request-123");
    safeSessionStorageRemove(key);

    expect(readPreloadedPublicSession(token)).toEqual({
      requestId: "request-123",
      data: payload,
    });
  });
});
