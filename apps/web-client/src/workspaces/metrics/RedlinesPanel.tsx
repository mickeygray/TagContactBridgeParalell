import { type UseQueryResult } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/ui/StatusPill";
import type { MetricsRedlines } from "@/lib/api/types";
import { formatNumber } from "@/lib/utils/format";

interface Props {
  query: UseQueryResult<MetricsRedlines>;
}

export function RedlinesPanel({ query }: Props) {
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  if (query.isLoading) {
    return <SkeletonRow count={3} />;
  }

  const data = query.data;
  const counts = data?.counts ?? {};
  const alerts = data?.alerts ?? [];
  const reviewItems = data?.reviewItems ?? [];

  const pending = counts.pending ?? 0;
  const suppressed = counts.suppressed ?? 0;
  const sent = counts.sent ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <Tile icon={<Clock className="h-3.5 w-3.5" />} label="Pending" value={pending} tone="warning" />
        <Tile
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          label="Suppressed"
          value={suppressed}
          tone="danger"
        />
        <Tile
          icon={<CheckCircle2 className="h-3.5 w-3.5" />}
          label="Sent"
          value={sent}
          tone="success"
        />
      </div>

      {alerts.length === 0 && reviewItems.length === 0 ? (
        <EmptyState title="All clear" description="No redlines or review items pending." />
      ) : (
        <ul className="divide-y divide-border text-sm">
          {alerts.slice(0, 6).map((alert, i) => (
            <li key={i} className="flex items-start gap-2 py-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <div className="min-w-0">
                <div className="truncate text-foreground">
                  {(alert.title as string) ??
                    (alert.reason as string) ??
                    (alert.kind as string) ??
                    "Alert"}
                </div>
                {alert.detail ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {String(alert.detail)}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
          {reviewItems.slice(0, 6).map((item, i) => (
            <li key={`r-${i}`} className="flex items-start gap-2 py-2">
              <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-500" />
              <div className="min-w-0">
                <div className="truncate text-foreground">
                  {(item.title as string) ??
                    (item.category as string) ??
                    "Review item"}
                </div>
                {item.caseId ? (
                  <div className="truncate text-xs text-muted-foreground">
                    Case {String(item.caseId)}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Tile({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "warning" | "danger" | "success";
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="numeric text-lg font-semibold">{formatNumber(value)}</span>
        {value === 0 ? null : (
          <StatusPill tone={tone}>
            {tone === "warning" ? "open" : tone === "danger" ? "blocked" : "cleared"}
          </StatusPill>
        )}
      </div>
    </div>
  );
}
