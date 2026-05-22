import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  MetricsAttributionReview,
  MetricsAttributionReviewItem,
  MetricsCallrailSummary,
  MetricsDailySummary,
  MetricsMailCosts,
  MetricsPulse,
  MetricsRedlines,
  MetricsSources,
  MetricsWorkspace,
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

export function useMetricsWorkspace(domain: string) {
  return useQuery({
    queryKey: queryKeys.metrics.workspace(domain),
    queryFn: () =>
      api
        .get<OkEnvelope<MetricsWorkspace>>(`/api/read/metrics/${domain}`)
        .then(unwrap),
    enabled: Boolean(domain),
    staleTime: 30_000,
  });
}

export function useMetricsSources(domain: string, filters: MetricsRangeFilters = {}) {
  return useQuery({
    queryKey: queryKeys.metrics.sources(domain, filters),
    queryFn: () =>
      api
        .get<OkEnvelope<MetricsSources>>(`/api/read/metrics/sources/${domain}`, {
          query: {
            from: filters.from,
            to: filters.to,
            channel: filters.channel,
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

export function useMetricsDailySummary(domain: string, date?: string) {
  return useQuery({
    queryKey: queryKeys.metrics.daily(domain, date),
    queryFn: () =>
      api
        .get<OkEnvelope<MetricsDailySummary>>(
          `/api/read/metrics/daily-summary/${domain}`,
          { query: { date } },
        )
        .then(unwrap),
    enabled: Boolean(domain),
    staleTime: 30_000,
  });
}

/**
 * Daily Pulse — locked-to-today multi-group snapshot. Polls every 5min.
 * Optional `date` override for testing or historical replay; default
 * lets the backend pick "today in LA timezone".
 */
export function useMetricsPulse(domain: string, date?: string) {
  return useQuery({
    queryKey: ["metrics", "pulse", domain, date ?? "today"],
    queryFn: () =>
      api
        .get<OkEnvelope<MetricsPulse>>(`/api/read/metrics/pulse/${domain}`, {
          query: date ? { date } : {},
        })
        .then(unwrap),
    enabled: Boolean(domain),
    staleTime: 60_000,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: false,
  });
}

export function useMetricsMailCosts(domain: string, filters: MetricsRangeFilters = {}) {
  return useQuery({
    queryKey: queryKeys.metrics.mailCosts(domain, filters),
    queryFn: () =>
      api
        .get<OkEnvelope<MetricsMailCosts>>(`/api/read/metrics/mail-costs/${domain}`, {
          query: {
            from: filters.from,
            to: filters.to,
            date: filters.date,
            channel: filters.channel,
          },
        })
        .then(unwrap),
    enabled: Boolean(domain),
    staleTime: 60_000,
  });
}

export function useMetricsRedlines(domain: string) {
  return useQuery({
    queryKey: queryKeys.metrics.redlines(domain),
    queryFn: () =>
      api
        .get<OkEnvelope<MetricsRedlines>>(`/api/read/metrics/redlines/${domain}`)
        .then(unwrap),
    enabled: Boolean(domain),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useMetricsCallrail(domain: string, filters: MetricsRangeFilters = {}) {
  return useQuery({
    queryKey: queryKeys.metrics.callrail(domain, filters),
    queryFn: () =>
      api
        .get<OkEnvelope<MetricsCallrailSummary>>(
          `/api/read/metrics/callrail/${domain}`,
          {
            query: {
              date: filters.date,
              from: filters.from,
              to: filters.to,
              channel: filters.channel,
            },
          },
        )
        .then(unwrap),
    enabled: Boolean(domain),
    staleTime: 30_000,
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
