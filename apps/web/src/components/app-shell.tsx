"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { reportClientError } from "@/lib/client-error";
import { safeSessionStorageGet, safeSessionStorageSet } from "@/lib/storage";

type ErrorBoundaryFallbackProps = {
  error: Error;
  reset: () => void;
};

class AppErrorBoundary extends React.Component<
  {
    children: React.ReactNode;
    onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
    fallback: (props: ErrorBoundaryFallbackProps) => React.ReactNode;
  },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.props.onError?.(error, errorInfo);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return this.props.fallback({ error: this.state.error, reset: this.reset });
    }
    return this.props.children;
  }
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

function isChunkLoadError(error: unknown): boolean {
  const err = asError(error);
  const message = (err.message || "").toLowerCase();

  return (
    message.includes("chunkloaderror") ||
    message.includes("loading chunk") && message.includes("failed") ||
    message.includes("dynamically imported module") && message.includes("failed") ||
    message.includes("failed to fetch dynamically imported module")
  );
}

function ErrorScreen({
  title,
  description,
  primaryAction,
  secondaryAction,
  details,
}: {
  title: string;
  description: string;
  primaryAction: React.ReactNode;
  secondaryAction?: React.ReactNode;
  details?: string;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-xl shadow-xl">
        <CardHeader>
          <CardTitle className="text-2xl">{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-slate-600">{description}</p>
          <div className="flex flex-col sm:flex-row gap-2">
            {primaryAction}
            {secondaryAction}
          </div>
          {details ? (
            <details className="text-sm text-slate-500 whitespace-pre-wrap">
              <summary className="cursor-pointer">Technical details</summary>
              <div className="mt-2 rounded-lg bg-slate-100 p-3">{details}</div>
            </details>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

const CHUNK_RELOAD_FLAG = "__classcolab_chunk_reload_attempted__";

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [hardRefreshRequired, setHardRefreshRequired] = useState<Error | null>(null);

  const handleHardRefresh = useCallback((error: unknown) => {
    const err = asError(error);
    const attempted = safeSessionStorageGet(CHUNK_RELOAD_FLAG);
    if (!attempted) {
      const persisted = safeSessionStorageSet(CHUNK_RELOAD_FLAG, "1");
      if (persisted) {
        window.location.reload();
        return;
      }
    }

    setHardRefreshRequired(err);
  }, []);

  const handleGlobalError = useCallback(
    (error: unknown, source: string) => {
      if (isChunkLoadError(error)) {
        handleHardRefresh(error);
        return;
      }

      reportClientError(error, { source });
    },
    [handleHardRefresh]
  );

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      handleGlobalError(event.error ?? event.message, "window.error");
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      handleGlobalError(event.reason, "window.unhandledrejection");
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [handleGlobalError]);

  const onGoHome = useCallback(() => router.push("/"), [router]);
  const onReload = useCallback(() => window.location.reload(), []);

  const boundaryFallback = useMemo(() => {
    return ({ error, reset }: ErrorBoundaryFallbackProps) => (
      <ErrorScreen
        title="Something went wrong"
        description="The app crashed unexpectedly. You can try again or reload the page."
        primaryAction={
          <Button onClick={reset} className="w-full sm:w-auto">
            Try again
          </Button>
        }
        secondaryAction={
          <>
            <Button variant="outline" onClick={onReload} className="w-full sm:w-auto">
              Reload
            </Button>
            <Button variant="ghost" onClick={onGoHome} className="w-full sm:w-auto">
              Go home
            </Button>
          </>
        }
        details={error?.stack || error?.message}
      />
    );
  }, [onGoHome, onReload]);

  if (hardRefreshRequired) {
    return (
      <ErrorScreen
        title="Update detected"
        description="The app was updated while you were using it. Please refresh the page to load the latest version."
        primaryAction={
          <Button onClick={onReload} className="w-full sm:w-auto">
            Refresh now
          </Button>
        }
        secondaryAction={
          <Button variant="ghost" onClick={onGoHome} className="w-full sm:w-auto">
            Go home
          </Button>
        }
        details={hardRefreshRequired?.message}
      />
    );
  }

  return (
    <AppErrorBoundary
      onError={(error, errorInfo) => {
        if (isChunkLoadError(error)) {
          handleHardRefresh(error);
          return;
        }
        reportClientError(error, { source: "react.errorboundary", errorInfo });
      }}
      fallback={boundaryFallback}
    >
      {children}
    </AppErrorBoundary>
  );
}
