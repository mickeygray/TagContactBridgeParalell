import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type { ConsentRecord, ConsentStats, OkEnvelope } from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

type ConsentQuery = Record<string, string | number | boolean | null | undefined>;

interface ConsentRecordsPage {
  total: number;
  records: ConsentRecord[];
}

export function useConsentStats(filters: ConsentQuery = {}) {
  return useQuery({
    queryKey: queryKeys.consent.stats(filters),
    queryFn: () =>
      api
        .get<OkEnvelope<{ stats: ConsentStats }>>("/api/admin/consent-stats", {
          query: filters,
        })
        .then((env) => env.result.stats ?? {}),
    staleTime: 30_000,
  });
}

export function useConsentRecords(filters: ConsentQuery = {}) {
  return useQuery({
    queryKey: queryKeys.consent.records(filters),
    queryFn: () =>
      api
        .get<{ ok: true; total?: number; records?: ConsentRecord[] }>("/api/admin/consent-records", {
          query: filters,
        })
        .then((env) => ({
          total: env.total ?? env.records?.length ?? 0,
          records: env.records ?? [],
        }) satisfies ConsentRecordsPage),
    staleTime: 30_000,
  });
}
