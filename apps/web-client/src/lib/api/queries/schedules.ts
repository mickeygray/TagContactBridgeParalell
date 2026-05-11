import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  OkEnvelope,
  SchedulesCadence,
  SchedulesOverview,
} from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

type RawSchedulesOverview = {
  domain: string;
  counts?: {
    activeCadence?: number;
    inactiveCadence?: number;
    dueByChannel?: Record<string, number>;
  };
  recentCadence?: Array<Record<string, unknown>>;
};

export function useSchedulesOverview(domain: string) {
  return useQuery({
    queryKey: queryKeys.schedules.overview(domain),
    queryFn: () =>
      api
        .get<OkEnvelope<RawSchedulesOverview>>(
          `/api/read/schedules/overview/${domain}`,
        )
        .then((env) => ({
          domain: env.result.domain,
          activeCadenceCount: env.result.counts?.activeCadence,
          inactiveCadenceCount: env.result.counts?.inactiveCadence,
          dueCounts: env.result.counts?.dueByChannel ?? {},
          recentCadence: env.result.recentCadence ?? [],
        } satisfies SchedulesOverview)),
    enabled: Boolean(domain),
    staleTime: 30_000,
  });
}

export function useSchedulesCadence(
  domain: string,
  filters: { caseId?: string; active?: boolean; intakeSource?: string; limit?: number } = {},
) {
  return useQuery({
    queryKey: queryKeys.schedules.cadence(domain, filters),
    queryFn: () =>
      api
        .get<OkEnvelope<Array<Record<string, unknown>>>>(
          `/api/read/schedules/cadence/${domain}`,
          { query: filters as Record<string, string | number | boolean | undefined> },
        )
        .then((env) => ({
          caseId: filters.caseId,
          active: filters.active,
          intakeSource: filters.intakeSource,
          limit: filters.limit,
          cadenceList: env.result ?? [],
        } satisfies SchedulesCadence)),
    enabled: Boolean(domain),
    staleTime: 15_000,
  });
}
