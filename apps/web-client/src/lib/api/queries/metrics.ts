import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  MetricsAttributionReview,
  MetricsAttributionReviewItem,
  OkEnvelope,
} from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

function unwrap<T>(envelope: OkEnvelope<T>): T {
  return envelope.result;
}

function invalidateMetricsScope(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: queryKeys.metrics.all() });
}

export interface MetricsRangeFilters extends Record<string, unknown> {
  date?: string;
  from?: string;
  to?: string;
  channel?: string;
}

export interface MetricsAttributionReviewFilters extends Record<string, unknown> {
  status?: string;
  date?: string;
  limit?: number;
}

export interface SimpleMarketingRow {
  source: string;
  responses: number;
  calls: number;
  over5: number;
  spend: number;
  pieces: number;
  deals: number;
  initialsNet: number;
  totalCollected: number;
  activeDays: number;
  costPerResponse: number | null;
}

export interface SimpleMarketingSummary {
  from: string;
  to: string;
  rows: SimpleMarketingRow[];
  totals: {
    responses: number;
    calls: number;
    spend: number;
    ldLeads: number;
    deals: number;
    initialsNet: number;
    totalCollected: number;
    paymentsCount: number;
    multiplePositiveInitialCases: number;
    costPerResponse: number | null;
  };
  excludedCalls: number;
  activePieces: string[];
  feeds?: {
    callrail: { lastSyncedAt: string | null; latestDay: string | null };
    spend: { lastSyncedAt: string | null; latestDay: string | null };
    phoneburner: { lastProjectedCallAt: string | null };
    payments: { lastReconciledAt: string | null; lastSource: string | null };
  };
}

// The lean read: active mail pieces + one Aged rollup from the two
// declared sources (DailyCallStat + SpendEntry). Sub-second.
export function useMetricsSimpleSources(domain: string, filters: MetricsRangeFilters = {}) {
  return useQuery({
    queryKey: [...queryKeys.metrics.sources(domain, filters), "simple"],
    queryFn: () =>
      api
        .get<OkEnvelope<SimpleMarketingSummary>>(`/api/read/metrics/simple-sources/${domain}`, {
          query: {
            from: filters.from,
            to: filters.to,
          },
        })
        .then(unwrap),
    enabled: Boolean(domain),
    staleTime: 30_000,
  });
}

export function useMetricsAttributionReview(
  domain: string,
  filters: MetricsAttributionReviewFilters = {},
) {
  return useQuery({
    queryKey: queryKeys.metrics.attributionReview(domain, filters),
    queryFn: () =>
      api
        .get<OkEnvelope<MetricsAttributionReview>>(
          `/api/read/metrics/attribution-review/${domain}`,
          {
            query: {
              status: filters.status,
              date: filters.date,
              limit: filters.limit,
            },
          },
        )
        .then(unwrap),
    enabled: Boolean(domain),
    staleTime: 15_000,
  });
}

export function useResolveMetricsAttributionReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      resolvedSource,
      resolvedChannel,
      note,
    }: {
      id: string;
      resolvedSource: string;
      resolvedChannel?: string | null;
      note?: string;
    }) =>
      api
        .post<OkEnvelope<MetricsAttributionReviewItem>>(
          `/api/metrics/attribution-review/${encodeURIComponent(id)}/resolve`,
          { resolvedSource, resolvedChannel, note },
        )
        .then(unwrap),
    onSuccess: () => invalidateMetricsScope(qc),
  });
}

export function useResolveMetricsPaymentReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      treatmentKind,
      resolvedSource,
      reportingBucket,
      note,
    }: {
      id: string;
      treatmentKind:
        | "count-one-deal"
        | "chargeback-pair"
        | "chargeback-reversal"
        | "source-override";
      resolvedSource?: string | null;
      reportingBucket?: "Aged" | null;
      note?: string;
    }) =>
      api
        .post<OkEnvelope<MetricsAttributionReviewItem>>(
          `/api/metrics/attribution-review/${encodeURIComponent(id)}/resolve-payment`,
          {
            treatmentKind,
            resolvedSource,
            reportingBucket,
            note,
          },
        )
        .then(unwrap),
    onSuccess: () => invalidateMetricsScope(qc),
  });
}

export function useIgnoreMetricsAttributionReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      api
        .post<OkEnvelope<MetricsAttributionReviewItem>>(
          `/api/metrics/attribution-review/${encodeURIComponent(id)}/ignore`,
          { note },
        )
        .then(unwrap),
    onSuccess: () => invalidateMetricsScope(qc),
  });
}

export function useReopenMetricsAttributionReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api
        .post<OkEnvelope<MetricsAttributionReviewItem>>(
          `/api/metrics/attribution-review/${encodeURIComponent(id)}/reopen`,
        )
        .then(unwrap),
    onSuccess: () => invalidateMetricsScope(qc),
  });
}
