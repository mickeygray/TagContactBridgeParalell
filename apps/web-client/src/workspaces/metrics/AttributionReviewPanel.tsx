import * as React from "react";
import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Input, Label } from "@/components/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/ui/StatusPill";
import { toast } from "@/components/ui/Toaster";
import {
  useIgnoreMetricsAttributionReview,
  useMetricsAttributionReview,
  useReopenMetricsAttributionReview,
  useResolveMetricsAttributionReview,
} from "@/lib/api/queries/metrics";
import type { MetricsAttributionReviewItem } from "@/lib/api/types";
import { formatCurrency, formatNumber, formatRelative } from "@/lib/utils/format";

const STATUS_FILTERS = [
  { key: "open", label: "Open" },
  { key: "reviewed", label: "Resolved" },
  { key: "dismissed", label: "Ignored" },
  { key: "all", label: "All" },
] as const;

const CHANNEL_OPTIONS = [
  { value: "mailer", label: "Mailer" },
  { value: "bcd", label: "BCD" },
  { value: "ld", label: "LD" },
  { value: "ld-posting", label: "LD Posting" },
  { value: "affiliate", label: "Affiliate" },
  { value: "meta", label: "Meta" },
  { value: "paid-social", label: "Paid Social" },
  { value: "dialer", label: "Dialer" },
  { value: "callfire", label: "CallFire" },
  { value: "other", label: "Other" },
] as const;

const CHANNEL_VALUE_SET: Set<string> = new Set(CHANNEL_OPTIONS.map((option) => option.value));

type DraftState = {
  resolvedSource: string;
  resolvedChannel: string;
  note: string;
};

function toneForStatus(status?: string | null) {
  if (status === "reviewed") return "success";
  if (status === "dismissed") return "neutral";
  return "warning";
}

function labelForStatus(status?: string | null) {
  if (status === "reviewed") return "Resolved";
  if (status === "dismissed") return "Ignored";
  return "Open";
}

function summarizeObserved(item: MetricsAttributionReviewItem) {
  const observed = item.observed || {};
  const parts: string[] = [];
  if ((observed.spend ?? 0) > 0) parts.push(`Spend ${formatCurrency(observed.spend, true)}`);
  if ((observed.totalCollected ?? 0) > 0) {
    parts.push(`Collected ${formatCurrency(observed.totalCollected, true)}`);
  }
  if ((observed.initialPayments ?? 0) > 0) {
    parts.push(
      `${formatNumber(observed.initialPaymentCount)} initial / ${formatCurrency(observed.initialPayments, true)}`,
    );
  }
  if ((observed.leads ?? 0) > 0) parts.push(`${formatNumber(observed.leads)} leads`);
  if ((observed.reportedLeads ?? 0) > 0) {
    parts.push(`${formatNumber(observed.reportedLeads)} reported leads`);
  }
  if ((observed.calls ?? 0) > 0) parts.push(`${formatNumber(observed.calls)} calls`);
  if ((observed.callsOver5 ?? 0) > 0) parts.push(`${formatNumber(observed.callsOver5)} > 5m`);
  if ((observed.dncToday ?? 0) > 0) parts.push(`${formatNumber(observed.dncToday)} DNC`);
  if ((observed.postdateToday ?? 0) > 0) parts.push(`${formatNumber(observed.postdateToday)} postdate`);
  return parts;
}

function normalizeChannelValue(value: string | null | undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "other";
  if (normalized === "mail") return "mailer";
  if (normalized === "paid social") return "paid-social";
  return CHANNEL_VALUE_SET.has(normalized) ? normalized : "other";
}

function buildDefaultDraft(item: MetricsAttributionReviewItem): DraftState {
  const rawSource = String(item.raw?.source || "").trim();
  const rawChannel = normalizeChannelValue(item.raw?.channel);
  return {
    resolvedSource:
      String(item.resolution?.source || "").trim() ||
      (rawSource.toLowerCase() === "unknown" ? "" : rawSource),
    resolvedChannel: normalizeChannelValue(item.resolution?.channel || rawChannel),
    note: String(item.resolution?.note || "").trim(),
  };
}

export function AttributionReviewPanel({ domain }: { domain: string }) {
  const [statusFilter, setStatusFilter] = React.useState<string>("open");
  const [drafts, setDrafts] = React.useState<Record<string, DraftState>>({});

  const query = useMetricsAttributionReview(domain, {
    status: statusFilter,
    limit: 50,
  });
  const resolveMutation = useResolveMetricsAttributionReview();
  const ignoreMutation = useIgnoreMetricsAttributionReview();
  const reopenMutation = useReopenMetricsAttributionReview();

  const items = query.data?.items ?? [];
  const counts = query.data?.counts;

  const getDraft = React.useCallback(
    (item: MetricsAttributionReviewItem) => drafts[item.id] || buildDefaultDraft(item),
    [drafts],
  );

  const patchDraft = React.useCallback((id: string, patch: Partial<DraftState>) => {
    setDrafts((current) => ({
      ...current,
      [id]: {
        ...(current[id] || { resolvedSource: "", resolvedChannel: "other", note: "" }),
        ...patch,
      },
    }));
  }, []);

  const handleResolve = React.useCallback(
    async (item: MetricsAttributionReviewItem) => {
      const draft = getDraft(item);
      const resolvedSource = draft.resolvedSource.trim();
      if (!resolvedSource) {
        toast.error("Resolved source is required.");
        return;
      }
      try {
        await resolveMutation.mutateAsync({
          id: item.id,
          resolvedSource,
          resolvedChannel: normalizeChannelValue(draft.resolvedChannel),
          note: draft.note.trim() || undefined,
        });
        toast.success("Attribution resolved.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to resolve attribution.");
      }
    },
    [getDraft, resolveMutation],
  );

  const handleIgnore = React.useCallback(
    async (item: MetricsAttributionReviewItem) => {
      const draft = getDraft(item);
      try {
        await ignoreMutation.mutateAsync({
          id: item.id,
          note: draft.note.trim() || undefined,
        });
        toast.success("Attribution item ignored.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to ignore attribution item.");
      }
    },
    [getDraft, ignoreMutation],
  );

  const handleReopen = React.useCallback(
    async (item: MetricsAttributionReviewItem) => {
      try {
        await reopenMutation.mutateAsync({ id: item.id });
        toast.success("Attribution item reopened.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to reopen attribution item.");
      }
    },
    [reopenMutation],
  );

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Attribution review
            </CardTitle>
            <CardDescription>
              Unknown or uncertain source rows wait here and stay out of nightly vendor reporting until resolved.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill tone={(counts?.open ?? 0) > 0 ? "warning" : "success"}>
              {(counts?.open ?? 0) > 0
                ? `${formatNumber(counts?.open)} open`
                : "All clear"}
            </StatusPill>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => query.refetch()}
              isLoading={query.isFetching}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_FILTERS.map((filter) => (
            <Button
              key={filter.key}
              variant={statusFilter === filter.key ? "primary" : "secondary"}
              size="sm"
              onClick={() => setStatusFilter(filter.key)}
            >
              {filter.label}
            </Button>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{formatNumber(counts?.open)} open</span>
            <span>{formatNumber(counts?.reviewed)} resolved</span>
            <span>{formatNumber(counts?.dismissed)} ignored</span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : null}
        {query.isLoading ? <SkeletonRow count={4} /> : null}
        {!query.isLoading && !query.isError && items.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck />}
            title={statusFilter === "open" ? "No unresolved attribution items" : "No items in this filter"}
            description="Anything we can’t confidently place will show up here for manual routing."
          />
        ) : null}

        {!query.isLoading && !query.isError
          ? items.map((item) => {
              const draft = getDraft(item);
              const observedParts = summarizeObserved(item);
              const pending =
                resolveMutation.isPending || ignoreMutation.isPending || reopenMutation.isPending;

              return (
                <div key={item.id} className="rounded-lg border border-border bg-card/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-semibold text-foreground">
                          {item.title || "Attribution review"}
                        </div>
                        <StatusPill tone={toneForStatus(item.status)}>
                          {labelForStatus(item.status)}
                        </StatusPill>
                        {item.domain ? <StatusPill tone="info">{item.domain}</StatusPill> : null}
                        {item.kind ? <StatusPill tone="neutral">{item.kind}</StatusPill> : null}
                      </div>
                      {item.summary ? (
                        <div className="text-xs text-muted-foreground">{item.summary}</div>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                        {item.raw?.source ? <span>Raw source: {item.raw.source}</span> : null}
                        {item.raw?.channel ? <span>Raw channel: {item.raw.channel}</span> : null}
                        {item.dateKey ? <span>Date: {item.dateKey}</span> : null}
                        {item.updatedAt ? <span>Updated {formatRelative(item.updatedAt)}</span> : null}
                      </div>
                    </div>
                  </div>

                  {observedParts.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {observedParts.map((part) => (
                        <StatusPill key={part} tone="accent">
                          {part}
                        </StatusPill>
                      ))}
                    </div>
                  ) : null}

                  {item.status === "open" ? (
                    <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.4fr)_200px_minmax(0,1fr)_auto]">
                      <div className="space-y-1">
                        <Label htmlFor={`resolved-source-${item.id}`}>Resolved source</Label>
                        <Input
                          id={`resolved-source-${item.id}`}
                          value={draft.resolvedSource}
                          onChange={(event) =>
                            patchDraft(item.id, { resolvedSource: event.target.value })
                          }
                          placeholder="LD Posting, BCD, Mailer X, VF..."
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>Resolved channel</Label>
                        <Select
                          value={draft.resolvedChannel || "other"}
                          onValueChange={(value) =>
                            patchDraft(item.id, { resolvedChannel: normalizeChannelValue(value) })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Pick a channel" />
                          </SelectTrigger>
                          <SelectContent>
                            {CHANNEL_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`resolved-note-${item.id}`}>Note</Label>
                        <Input
                          id={`resolved-note-${item.id}`}
                          value={draft.note}
                          onChange={(event) => patchDraft(item.id, { note: event.target.value })}
                          placeholder="Optional note for why this was routed here"
                        />
                      </div>
                      <div className="flex items-end gap-2">
                        <Button
                          size="sm"
                          onClick={() => void handleResolve(item)}
                          isLoading={resolveMutation.isPending}
                          disabled={pending}
                        >
                          Resolve
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void handleIgnore(item)}
                          isLoading={ignoreMutation.isPending}
                          disabled={pending}
                        >
                          Ignore
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
                      <div className="space-y-1 text-xs text-muted-foreground">
                        {item.resolution?.source ? (
                          <div>
                            Routed to <span className="font-medium text-foreground">{item.resolution.source}</span>
                            {item.resolution?.channel ? ` via ${item.resolution.channel}` : ""}
                          </div>
                        ) : (
                          <div>
                            {item.status === "dismissed"
                              ? "Ignored from nightly reporting."
                              : "Resolved without a saved source label."}
                          </div>
                        )}
                        {item.resolution?.note ? <div>Note: {item.resolution.note}</div> : null}
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleReopen(item)}
                        isLoading={reopenMutation.isPending}
                        disabled={pending}
                      >
                        Reopen
                      </Button>
                    </div>
                  )}
                </div>
              );
            })
          : null}
      </CardContent>
    </Card>
  );
}
