import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type { HygieneDailyRun, OkEnvelope } from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

export function useHygieneOverview() {
  return useQuery({
    queryKey: queryKeys.hygiene.overview(),
    queryFn: () =>
      api
        .get<OkEnvelope<{ cleanRate?: number; pendingCount?: number; lastRun?: string }>>(
          "/api/hygiene/overview",
        )
        .then((env) => env.result),
    staleTime: 30_000,
  });
}

export function useDailyDeepCutRuns(domain: string) {
  return useQuery({
    queryKey: queryKeys.hygiene.dailyRuns(domain),
    queryFn: () =>
      api
        .get<OkEnvelope<HygieneDailyRun[]>>(
          `/api/hygiene/daily-runs/${domain}`,
        )
        .then((env) => env.result),
    enabled: Boolean(domain),
    staleTime: 15_000,
  });
}

export function useStartDeepCutRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { domain: string }) =>
      api.post<OkEnvelope<{ runId: string; status: string; domain: string }>>(
        "/api/hygiene/daily-runs/start",
        vars,
      ),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.hygiene.dailyRuns(vars.domain) });
    },
  });
}

export function useReviewFeed(domain: string) {
  return useQuery({
    queryKey: queryKeys.hygiene.reviewFeed(domain),
    queryFn: () =>
      api
        .get<OkEnvelope<{ items: Array<Record<string, unknown>>; total?: number }>>(
          `/api/hygiene/review-feed/${domain}`,
        )
        .then((env) => env.result),
    enabled: Boolean(domain),
    staleTime: 15_000,
  });
}
