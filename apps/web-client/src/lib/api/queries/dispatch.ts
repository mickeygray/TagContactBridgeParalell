import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  DispatchBuildRequest,
  DispatchList,
  OkEnvelope,
} from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

export interface CampaignAudienceSample {
  caseId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  status: string | null;
  lastSeenAt: string | null;
}

export interface CampaignAudienceResult {
  domain: string;
  channel: string;
  audienceSource: string;
  statusId: number;
  total: number;
  returned: number;
  truncated: boolean;
  excludedCount?: number;
  caseIds: number[];
  sample: CampaignAudienceSample[];
}

export function useCampaignAudience(
  domain: string,
  filters: {
    channel: "sms" | "email" | "rvm" | "callfire" | "any";
    audienceSource?: string;
    statusId?: number;
    search?: string;
    maxSize?: number;
    /** Optional. YYYY-MM-DD — server interprets as 00:00 PT (inclusive). */
    createdAtAfter?: string;
    /** Optional. YYYY-MM-DD — server interprets as 23:59:59.999 PT (inclusive). */
    createdAtBefore?: string;
  },
  enabled = true,
) {
  return useQuery({
    queryKey: [
      "dispatch",
      "audience",
      domain,
      filters.channel,
      filters.audienceSource ?? "default",
      filters.statusId ?? 2,
      filters.search ?? "",
      filters.maxSize ?? 5000,
      // Date range goes into the queryKey so changing it re-runs the
      // audience preview automatically — same staleness model as the
      // other filters.
      filters.createdAtAfter ?? "",
      filters.createdAtBefore ?? "",
    ] as const,
    queryFn: () =>
      api
        .get<OkEnvelope<CampaignAudienceResult>>(
          `/api/dispatch/audience/${domain}`,
          {
            query: {
              channel: filters.channel,
              audienceSource: filters.audienceSource,
              statusId: filters.statusId,
              search: filters.search,
              maxSize: filters.maxSize,
              createdAtAfter: filters.createdAtAfter || undefined,
              createdAtBefore: filters.createdAtBefore || undefined,
            },
          },
        )
        .then((env) => env.result),
    enabled: enabled && Boolean(domain),
    staleTime: 15_000,
  });
}

export function useDispatchLists(domain: string) {
  return useQuery({
    queryKey: queryKeys.dispatch.list(domain),
    queryFn: () =>
      api
        .get<{ ok: true; lists: DispatchList[] }>(`/api/dispatch/${domain}`)
        .then((r) => r.lists),
    enabled: Boolean(domain),
    staleTime: 15_000,
    refetchInterval: 5_000,
  });
}

export function useDispatchItem(id: string | null) {
  return useQuery({
    queryKey: queryKeys.dispatch.item(id ?? ""),
    queryFn: () =>
      api
        .get<OkEnvelope<DispatchList> | { ok: true; list: DispatchList }>(
          `/api/dispatch/item/${id}`,
        )
        .then((r) => ("result" in r ? r.result : r.list)),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

export function useBuildDispatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DispatchBuildRequest) =>
      api.post<{ ok: true; list: DispatchList }>("/api/dispatch/build", body),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.dispatch.list(vars.domain) });
    },
  });
}

/**
 * 5001's POST /api/dispatch/queue today performs a *build + queue* in one
 * step using the full input payload (it internally calls buildDispatchList).
 * There is currently no "re-queue an existing list by id" endpoint, so this
 * hook takes the same shape as useBuildDispatch. A future id-scoped command
 * (POST /api/dispatch/:id/queue) should get its own hook.
 */
interface QueueDispatchResult {
  list: DispatchList;
  queued: boolean;
  reason?: string;
  event?: { eventId?: string; queued?: boolean } | null;
}

export function useQueueDispatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DispatchBuildRequest) =>
      api.post<{ ok: true; result: QueueDispatchResult }>(
        "/api/dispatch/queue",
        body,
      ),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.dispatch.list(vars.domain) });
    },
  });
}

export function useWorklists(domain: string) {
  return useQuery({
    queryKey: queryKeys.worklists.list(domain),
    queryFn: () =>
      api
        .get<{ ok: true; lists: DispatchList[] }>(`/api/worklists/${domain}`)
        .then((r) => r.lists),
    enabled: Boolean(domain),
    staleTime: 15_000,
  });
}
