import { describe, expect, it } from "vitest";
import { mapHttpErrorToUiMessage } from "@/lib/http-error-ui";

describe("mapHttpErrorToUiMessage", () => {
  it("maps offline", () => {
    const ui = mapHttpErrorToUiMessage({ kind: "offline", message: "offline" });
    expect(ui.retryable).toBe(true);
    expect(ui.title.toLowerCase()).toContain("offline");
  });

  it("maps 404 not found", () => {
    const ui = mapHttpErrorToUiMessage({ kind: "http", status: 404, message: "not found" });
    expect(ui.retryable).toBe(false);
  });

  it("maps 429 rate limit as retryable", () => {
    const ui = mapHttpErrorToUiMessage({ kind: "http", status: 429, message: "rate limited" });
    expect(ui.retryable).toBe(true);
  });

  it("maps 5xx as retryable", () => {
    const ui = mapHttpErrorToUiMessage({ kind: "http", status: 503, message: "server" });
    expect(ui.retryable).toBe(true);
  });
});

