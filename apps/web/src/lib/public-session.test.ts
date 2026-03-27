import { describe, expect, it } from "vitest";
import { isValidJoinCode, normalizeJoinCode } from "@/lib/public-session";

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

