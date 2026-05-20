import * as React from "react";
import {
  ArrowDownAZ,
  ArrowUpDown,
  Clock,
  PhoneIncoming,
  PhoneOutgoing,
  Play,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { StatusPill } from "@/components/ui/StatusPill";
import { ErrorState } from "@/components/ui/ErrorState";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import {
  useAgentCallReviewToday,
  type CallReviewRow,
} from "@/lib/api/queries/callReview";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type SortKey = "time" | "duration";

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

function durationTone(sec: number | null | undefined): "info" | "warning" | "success" | "accent" {
  if (!sec || sec < 30) return "info";
  if (sec < 120) return "accent";
  if (sec < 480) return "success";
  return "warning"; // 8+ min — flag for review
}

interface CallsTodayPanelProps {
  extensionId: string | null;
  domain?: string;
  onCaseClick?: (caseId: number) => void;
}

export function CallsTodayPanel({
  extensionId,
  domain = "TAG",
  onCaseClick,
}: CallsTodayPanelProps) {
  const [sort, setSort] = React.useState<SortKey>("time");
  const [expandedCallId, setExpandedCallId] = React.useState<string | null>(
    null,
  );
  const query = useAgentCallReviewToday(extensionId, { domain, sort });

  if (!extensionId) {
    return (
      <EmptyState
        title="No extension"
        description="This account isn't paired to a CX extension yet."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Calls today
          {query.data ? (
            <span className="ml-2 font-normal normal-case text-foreground/80">
              · {query.data.summary.callCount} call
              {query.data.summary.callCount === 1 ? "" : "s"}
              {query.data.summary.callCount > 0 ? (
                <>
                  {" · "}
                  {formatDuration(query.data.summary.totalDurationSec)} total
                  {" · longest "}
                  {formatDuration(query.data.summary.longestDurationSec)}
                </>
              ) : null}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={() => setSort(sort === "time" ? "duration" : "time")}
            aria-label="Toggle sort"
          >
            {sort === "duration" ? (
              <ArrowDownAZ className="h-3 w-3" />
            ) : (
              <ArrowUpDown className="h-3 w-3" />
            )}
            {sort === "duration" ? "duration" : "time"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1"
            onClick={() => query.refetch()}
            isLoading={query.isFetching && !query.isLoading}
            aria-label="Refresh calls today"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.isLoading ? (
        <SkeletonRow count={3} />
      ) : !query.data || query.data.calls.length === 0 ? (
        <EmptyState
          title="No calls today"
          description="This agent hasn't placed or received a call yet today."
        />
      ) : (
        <ul className="space-y-2">
          {query.data.calls.map((call) => (
            <CallRow
              key={call.id}
              call={call}
              expanded={expandedCallId === call.id}
              onToggle={() =>
                setExpandedCallId(
                  expandedCallId === call.id ? null : call.id,
                )
              }
              onCaseClick={onCaseClick}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CallRow({
  call,
  expanded,
  onToggle,
  onCaseClick,
}: {
  call: CallReviewRow;
  expanded: boolean;
  onToggle: () => void;
  onCaseClick?: (caseId: number) => void;
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
            <span className="font-mono text-[10px] text-muted-foreground">
              {call.callStartTime
                ? formatRelative(call.callStartTime)
                : "—"}
            </span>
            {call.phone ? (
              <span className="truncate font-medium">{call.phone}</span>
            ) : null}
            {call.caseId ? (
              <button
                type="button"
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-primary/10 hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  if (onCaseClick && call.caseId) onCaseClick(call.caseId);
                }}
                title="View who dialed this lead today"
              >
                #{call.caseId}
              </button>
            ) : null}
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
            ) : (
              // TODO(call-review-status-shift): swap placeholder for
              // real correlation once available.
              <span aria-hidden="true">—</span>
            )}
          </div>
        </div>
        <Button
          variant={call.recording.available ? "primary" : "ghost"}
          size="sm"
          className="h-7 px-2"
          disabled={!call.recording.available}
          onClick={onToggle}
          aria-label={
            call.recording.available
              ? "Play recording"
              : "Recording not available yet"
          }
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
          {/* Existing /api/read/cx/recordings/play/:fileId proxy supports
              Range so HTML5 <audio> scrubbing works for free. */}
          <audio
            controls
            preload="none"
            src={call.recording.playbackUrl}
            className="w-full"
          />
          <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
            <span title={formatDateTime(call.callStartTime)}>
              Started{" "}
              {call.callStartTime
                ? formatDateTime(call.callStartTime)
                : "—"}
            </span>
            {call.recording.driveFileId ? (
              <span className="font-mono">
                {call.recording.driveFileId.slice(0, 8)}…
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}
