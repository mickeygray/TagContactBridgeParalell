import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";

interface ErrorStateProps {
  title?: string;
  error: unknown;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ title = "Something went wrong", error, onRetry, className }: ErrorStateProps) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");

  return (
    <div
      className={cn(
        "flex flex-col items-start gap-3 rounded-lg border border-rose-200 bg-rose-50/60 p-5",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-rose-700">
        <AlertTriangle className="h-4 w-4" />
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <pre className="w-full overflow-x-auto whitespace-pre-wrap rounded-md bg-white/60 p-3 text-xs text-rose-900/80">
        {message}
      </pre>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}
