import * as React from "react";
import { CalendarClock, CheckCircle2, RefreshCw, RotateCcw } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle, KpiCard } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/ui/StatusPill";
import { toast } from "@/components/ui/Toaster";
import { useCxPostDateHolds, useCxReleasePostDateHold } from "@/lib/api/queries/cx";
import type { PostDateHold, PostDateHoldStatus } from "@/lib/api/types";
import { useActiveDomain } from "@/lib/domain/useActiveDomain";
import { formatDate, formatDateTime, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

const STATUS_FILTERS: Array<{ label: string; value: PostDateHoldStatus | "all" }> = [
  { label: "Active", value: "active" },
  { label: "Review", value: "review" },
  { label: "Released", value: "released" },
  { label: "Paid", value: "payment_verified" },
  { label: "Failed", value: "release_failed" },
  { label: "All", value: "all" },
];

function statusTone(status: string): "success" | "warning" | "danger" | "info" | "neutral" {
  if (status === "payment_verified") return "success";
  if (status === "active") return "warning";
  if (status === "release_failed") return "danger";
  if (status === "released") return "info";
  return "neutral";
}

function compactPhone(value?: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 10) return value || "";
  const d = digits.slice(-10);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function HoldCard({
  hold,
  onRelease,
  releasing,
}: {
  hold: PostDateHold;
  onRelease: (hold: PostDateHold) => void;
  releasing: boolean;
}) {
  const canRelease = hold.status === "active" || hold.status === "review" || hold.status === "release_failed";
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <CardTitle className="truncate">
            {hold.caseName || `Case ${hold.caseId}`}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{hold.domain} #{hold.caseId}</span>
            {hold.phone ? <span>{compactPhone(hold.phone)}</span> : null}
            {hold.sourceName ? <span>{hold.sourceName}</span> : null}
          </div>
        </div>
        <StatusPill tone={statusTone(hold.status)}>
          {hold.status.replace(/_/g, " ")}
        </StatusPill>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-3">
          <div>
            <div className="font-medium text-foreground">Post-date</div>
            <div>{formatDateTime(hold.postDatedAt)}</div>
            <div>{hold.postDatedByName || hold.postDatedByEmail || "Unknown"}</div>
          </div>
          <div>
            <div className="font-medium text-foreground">First payment</div>
            <div>{hold.firstPaymentDateKey || formatDate(hold.firstPaymentDate)}</div>
            <div>{hold.paymentScheduleStatus || "not read"}</div>
          </div>
          <div>
            <div className="font-medium text-foreground">Release</div>
            <div>{hold.releasedAt ? formatDateTime(hold.releasedAt) : "Not released"}</div>
            <div>{hold.releaseReason || hold.releaseStatusLabel || ""}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="text-xs text-muted-foreground">
            Updated {formatRelative(hold.updatedAt)}
          </div>
          {canRelease ? (
            <Button
              size="sm"
              variant="secondary"
              isLoading={releasing}
              onClick={() => onRelease(hold)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Release to open
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function PostDatesWorkspace() {
  const domain = useActiveDomain();
  const [status, setStatus] = React.useState<PostDateHoldStatus | "all">("active");
  const holds = useCxPostDateHolds(domain, { status });
  const releaseHold = useCxReleasePostDateHold(domain);
  const items = holds.data?.items ?? [];
  const summary = holds.data?.summary;

  const handleRelease = React.useCallback(
    (hold: PostDateHold) => {
      const label = hold.caseName || `case ${hold.caseId}`;
      if (!window.confirm(`Release ${label} back to open in Logics?`)) return;
      releaseHold.mutate(
        {
          holdId: hold._id,
          reason: "Released from admin post-date page",
        },
        {
          onSuccess: () => toast.success("Post-date released"),
          onError: (error) =>
            toast.error("Release failed", {
              description: error instanceof Error ? error.message : "Request failed",
            }),
        },
      );
    },
    [releaseHold],
  );

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Admin"
        title="Post Dates"
        actions={
          <Button size="sm" variant="secondary" onClick={() => void holds.refetch()}>
            <RefreshCw className={cn("h-3.5 w-3.5", holds.isFetching && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <KpiCard
          label="Active"
          value={summary?.active ?? 0}
          icon={<CalendarClock className="h-4 w-4" />}
        />
        <KpiCard
          label="With first payment"
          value={summary?.withFirstPaymentDate ?? 0}
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
        <KpiCard label="Needs review" value={summary?.needsScheduleReview ?? 0} />
        <KpiCard label="Released" value={summary?.released ?? 0} />
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((filter) => (
          <Button
            key={filter.value}
            size="sm"
            variant={status === filter.value ? "primary" : "secondary"}
            onClick={() => setStatus(filter.value)}
          >
            {filter.label}
          </Button>
        ))}
      </div>

      {holds.isLoading ? <SkeletonRow count={4} /> : null}
      {holds.isError ? <ErrorState error={holds.error} onRetry={() => void holds.refetch()} /> : null}
      {!holds.isLoading && !holds.isError && items.length === 0 ? (
        <EmptyState
          icon={<CalendarClock />}
          title="No post-date holds"
        />
      ) : null}
      <div className="grid gap-3">
        {items.map((hold) => (
          <HoldCard
            key={hold._id}
            hold={hold}
            releasing={releaseHold.isPending && releaseHold.variables?.holdId === hold._id}
            onRelease={handleRelease}
          />
        ))}
      </div>
    </div>
  );
}
