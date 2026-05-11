import * as React from "react";
import { AlertTriangle, Home, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Reset the boundary when any of these values change (e.g., route path). */
  resetKeys?: ReadonlyArray<unknown>;
  /** Optional fallback renderer; default is a full-bleed error card. */
  fallback?: (state: {
    error: Error;
    reset: () => void;
  }) => React.ReactNode;
  className?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Keep this visible in the dev console; tests may assert on it.
    // eslint-disable-next-line no-console
    console.error("workspace.error_boundary.caught", error, info);
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (!this.state.error) return;
    const prevKeys = prev.resetKeys ?? [];
    const nextKeys = this.props.resetKeys ?? [];
    const changed =
      prevKeys.length !== nextKeys.length ||
      prevKeys.some((v, i) => !Object.is(v, nextKeys[i]));
    if (changed) this.reset();
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback({
        error: this.state.error,
        reset: this.reset,
      });
    }

    return (
      <DefaultFallback
        error={this.state.error}
        reset={this.reset}
        className={this.props.className}
      />
    );
  }
}

function DefaultFallback({
  error,
  reset,
  className,
}: {
  error: Error;
  reset: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[320px] w-full flex-col items-start gap-4 rounded-lg border border-rose-200 bg-rose-50/60 p-6",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-rose-700">
        <AlertTriangle className="h-4 w-4" />
        <span className="text-sm font-semibold">
          This workspace hit a rendering error
        </span>
      </div>
      <p className="text-sm text-rose-900/80">
        The rest of the app is still running. You can retry this view, or go
        home and try a different workspace.
      </p>
      <pre className="w-full max-w-full overflow-x-auto whitespace-pre-wrap rounded-md bg-white/70 p-3 text-xs text-rose-900/80">
        {error.message}
      </pre>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={reset}>
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            window.location.assign("/");
          }}
        >
          <Home className="h-3.5 w-3.5" />
          Go home
        </Button>
      </div>
    </div>
  );
}
