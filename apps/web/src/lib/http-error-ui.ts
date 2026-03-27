import type { HttpErrorKind } from "@/lib/http";

export type UiMappableRequestFailure = {
  kind?: HttpErrorKind;
  status?: number;
  message?: string;
};

export function mapHttpErrorToUiMessage(
  failure: UiMappableRequestFailure
): { title: string; description: string; retryable: boolean } {
  const status = failure.status;
  const kind = failure.kind;

  if (kind === "offline") {
    return {
      title: "You appear to be offline",
      description: "Check your internet connection and try again.",
      retryable: true,
    };
  }

  if (kind === "timeout") {
    return {
      title: "Request timed out",
      description: "The server took too long to respond. Try again.",
      retryable: true,
    };
  }

  if (kind === "network") {
    return {
      title: "Network error",
      description: "Couldn't reach the server. Try again.",
      retryable: true,
    };
  }

  if (kind === "http") {
    if (status === 404) {
      return {
        title: "Not found",
        description: "The requested resource was not found.",
        retryable: false,
      };
    }

    if (status === 429) {
      return {
        title: "Too many requests",
        description: "You're being rate limited. Please wait and try again.",
        retryable: true,
      };
    }

    if (typeof status === "number" && status >= 500) {
      return {
        title: "Server error",
        description: "Something went wrong on our side. Try again.",
        retryable: true,
      };
    }

    return {
      title: "Request failed",
      description: failure.message || (status ? `HTTP ${status}` : "Request failed."),
      retryable: false,
    };
  }

  return {
    title: "Request failed",
    description: failure.message || "Something went wrong. Try again.",
    retryable: true,
  };
}

export function formatRequestId(requestId: string | null | undefined): string | null {
  const id = requestId?.trim();
  if (!id) return null;
  return id;
}

