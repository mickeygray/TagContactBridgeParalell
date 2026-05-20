import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { StatusPill } from "@/components/ui/StatusPill";
import { ErrorState } from "@/components/ui/ErrorState";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import {
  Clock,
  PhoneIncoming,
  PhoneOutgoing,
  Play,
  RefreshCw,
} from "lucide-react";
import {
  useCaseCallReviewToday,
  type CallReviewRow,
} from "@/lib/api/queries/callReview";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

interface CaseCallsDrawerProps {
  caseId: number | null;
  domain?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatDuration(sec: number | null | undefined): string {
  if (!sec || sec < 1) return "—";
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function durationTone(
  sec: number | null | undefined,
): "info" | "warning" | "success" | "accent" {
  if (!sec || sec < 30) return "info";
  if (sec < 120) return "accent";
  if (sec < 480) return "success";
  return "warning";
}

export function CaseCallsDrawer({
  caseId,
  domain = "TAG",
  open,
  onOpenChange,
}: CaseCallsDrawerProps) {
  const query = useCaseCallReviewToday(caseId, { domain });
  const [expandedCallId, setExpandedCallId] = React.useState<string | null>(
    null,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Lead #{caseId ?? "—"}
            <StatusPill tone="info">{domain}</StatusPill>
          </DialogTitle>
          <DialogDescription>
            Every call against this lead today — who dialed, how long,
            recording availability.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Per-agent rollup so a glance answers "who worked this lead today?" */}
          {query.data?.agents.length ? (
            <div className="rounded-md border border-border p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  By agent
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1"
                  onClick={() => query.refetch()}
                  isLoading={query.isFetching && !query.isLoading}
                  aria-label="Refresh"
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
              </div>
              <ul className="space-y-1 text-xs">
                {query.data.agents.map((bucket) => (
                  <li
                    key={bucket.extensionId || "unknown"}
                    className="flex items-center justify-between rounded bg-muted/30 px-2 py-1"
                  >
                    <span className="font-medium">
                      {bucket.agentName || bucket.extensionId || "Unknown"}
                    </span>
                    <span className="text-muted-foreground">
                      {bucket.callCount} call
                      {bucket.callCount === 1 ? "" : "s"}
                      {" · "}
                      {formatDuration(bucket.totalDurationSec)}
                      {bucket.lastCallAt ? (
                        <>
                          {" · "}
                          last {formatRelative(bucket.lastCallAt)}
                        </>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              All calls today
              {query.data ? (
                <span className="ml-2 font-normal normal-case text-foreground/80">
                  · {query.data.summary.callCount} total ·{" "}
                  {formatDuration(query.data.summary.totalDurationSec)}{" "}
                  combined
                </span>
              ) : null}
            </div>
            {query.isError ? (
              <ErrorState
                error={query.error}
                onRetry={() => query.refetch()}
              />
            ) : query.isLoading ? (
              <SkeletonRow count={3} />
            ) : !query.data || query.data.calls.length === 0 ? (
              <EmptyState
                title="No calls today"
                description="This lead hasn't been dialed yet today."
              />
            ) : (
              <ul className="space-y-2">
                {query.data.calls.map((call) => (
                  <CaseCallRow
                    key={call.id}
                    call={call}
                    expanded={expandedCallId === call.id}
                    onToggle={() =>
                      setExpandedCallId(
                        expandedCallId === call.id ? null : call.id,
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CaseCallRow({
  call,
  expanded,
  onToggle,
}: {
  call: CallReviewRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const DirectionIcon =
    call.direction === "outbound" ? PhoneOutgoing : PhoneIncoming;
  return (
    <li
      className={cn(
        "rounded-md border border-border bg-card transition-colors",
        expanded && "border-primary/30",
      )}
    >
      <div className="flex items-center gap-2 p-2 text-xs">
        <DirectionIcon
          className={cn(
            "h-4 w-4 shrink-0",
            call.direction === "outbound"
              ? "text-blue-500"
              : "text-amber-500",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">
              {call.agentName || call.extensionId || "Unknown agent"}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {call.callStartTime
                ? formatRelative(call.callStartTime)
                : "—"}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            <StatusPill tone={durationTone(call.durationSec)}>
              {formatDuration(call.durationSec)}
            </StatusPill>
            {call.platform ? (
              <span className="uppercase">{call.platform}</span>
            ) : null}
            {call.statusShift ? (
              <span className="text-foreground/80">
                → {call.statusShift.toStatusLabel || "status changed"}
              </span>
            ) : null}
          </div>
        </div>
        <Button
          variant={call.recording.available ? "primary" : "ghost"}
          size="sm"
          className="h-7 px-2"
          disabled={!call.recording.available}
          onClick={onToggle}
        >
          <Play className="h-3 w-3" />
          {call.recording.available
            ? expanded
              ? "Hide"
              : "Play"
            : "No rec"}
        </Button>
      </div>
      {expanded && call.recording.playbackUrl ? (
        <div className="border-t border-border bg-muted/30 p-2">
          <audio
            controls
            preload="none"
            src={call.recording.playbackUrl}
            className="w-full"
          />
          <div className="mt-1 text-[10px] text-muted-foreground">
            Started{" "}
            {call.callStartTime ? formatDateTime(call.callStartTime) : "—"}
          </div>
        </div>
      ) : null}
    </li>
  );
}
