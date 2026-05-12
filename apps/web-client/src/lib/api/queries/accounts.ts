import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  AccountRecord,
  CreateAccountInput,
  UnassignedExtension,
  UpdateAccountInput,
} from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

interface ListResponse {
  ok: true;
  accounts: AccountRecord[];
}
interface SingleResponse {
  ok: true;
  account: AccountRecord;
}
interface ExtensionsResponse {
  ok: true;
  extensions: UnassignedExtension[];
}

export function useAccounts(filters: {
  status?: string;
  role?: string;
  audience?: string;
  company?: string;
  search?: string;
  limit?: number;
} = {}) {
  return useQuery({
    queryKey: queryKeys.accounts.list(filters),
    queryFn: () =>
      api
        .get<ListResponse>("/api/admin/accounts", { query: filters })
        .then((r) => r.accounts),
    staleTime: 3_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
}

export function useAccount(id: string | null) {
  return useQuery({
    queryKey: queryKeys.accounts.detail(id ?? ""),
    queryFn: () =>
      api.get<SingleResponse>(`/api/admin/accounts/${id}`).then((r) => r.account),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

export interface CallStatsBucket {
  totalCalls: number;
  outboundCalls: number;
  inboundCalls: number;
  cxCalls: number;
  exCalls: number;
  longestCallSec: number;
  lastCallAt: string | null;
}

export interface CallStatsSnapshot {
  today: CallStatsBucket;
  week: CallStatsBucket;
  month: CallStatsBucket;
  lifetime: CallStatsBucket;
  computedAt: string | null;
}

interface CallStatsResponse {
  ok: true;
  accountId: string;
  extensionId: string | null;
  additionalExtensionIds: string[];
  cached: boolean;
  snapshot: CallStatsSnapshot;
}

/**
 * Per-agent call rollups (today / week / month / lifetime) split by
 * direction (inbound/outbound) and platform (cx/ex). Lazy-cached on
 * AgentState with a 5-min staleness window. Pass `{ refresh: true }`
 * via the returned `refetch` to force a re-aggregation.
 */
export function useAccountCallStats(id: string | null) {
  return useQuery({
    queryKey: queryKeys.accounts.callStats(id ?? ""),
    queryFn: () =>
      api.get<CallStatsResponse>(`/api/admin/accounts/${id}/call-stats`),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useRefreshAccountCallStats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.get<CallStatsResponse>(`/api/admin/accounts/${id}/call-stats`, {
        query: { refresh: "true" },
      }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: queryKeys.accounts.callStats(id) });
    },
  });
}

export function useUnassignedExtensions(company?: string) {
  return useQuery({
    queryKey: queryKeys.accounts.unassignedExtensions(company),
    queryFn: () =>
      api
        .get<ExtensionsResponse>("/api/admin/accounts/unassigned-extensions", {
          query: { company },
        })
        .then((r) => r.extensions),
    staleTime: 15_000,
  });
}

function invalidateAccountScope(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: queryKeys.accounts.all() });
}

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAccountInput) =>
      api
        .post<SingleResponse>("/api/admin/accounts", body)
        .then((r) => r.account),
    onSuccess: () => invalidateAccountScope(qc),
  });
}

export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateAccountInput }) =>
      api
        .put<SingleResponse>(`/api/admin/accounts/${id}`, patch)
        .then((r) => r.account),
    onSuccess: () => invalidateAccountScope(qc),
  });
}

export function useDisableAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api
        .post<SingleResponse>(`/api/admin/accounts/${id}/disable`)
        .then((r) => r.account),
    onSuccess: () => invalidateAccountScope(qc),
  });
}

export function useEnableAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api
        .post<SingleResponse>(`/api/admin/accounts/${id}/enable`)
        .then((r) => r.account),
    onSuccess: () => invalidateAccountScope(qc),
  });
}
