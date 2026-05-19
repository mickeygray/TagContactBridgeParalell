import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  AccountIdentityResolveInput,
  AccountIdentityResolveResult,
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
 * AgentState with a 5-min staleness window — but the server-side
 * snapshot now gets invalidated immediately when the agent places a
 * confirmed call (see invalidateAgentCallStatsSnapshot in the
 * cxCadenceService call-placed flow). With that invalidation in
 * place, the client can poll at ~5s without re-triggering 5-min-old
 * snapshots: the server will recompute on the next read after a call.
 *
 * Pass `{ refresh: true }` via the returned `refetch` to force a
 * recompute even when no call has fired (e.g. manual admin refresh).
 */
export function useAccountCallStats(id: string | null) {
  return useQuery({
    queryKey: queryKeys.accounts.callStats(id ?? ""),
    queryFn: () =>
      api.get<CallStatsResponse>(`/api/admin/accounts/${id}/call-stats`),
    enabled: Boolean(id),
    // Tightened from 60s → 5s. With the call-end snapshot invalidation
    // landed, the server returns fresh numbers within a polling cycle
    // of any actual dial. 5s matches the accounts-list cadence so the
    // admin board's rows + stats refresh in step.
    staleTime: 5_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
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
          query: { company, live: "true" },
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

export function useResolveAccountIdentity() {
  return useMutation({
    mutationFn: (body: AccountIdentityResolveInput) =>
      api.post<AccountIdentityResolveResult>("/api/admin/accounts/identity/resolve", body),
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

export function useDeactivateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api
        .post<SingleResponse>(`/api/admin/accounts/${id}/deactivate`, {
          reason: "admin-deactivated",
        })
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
