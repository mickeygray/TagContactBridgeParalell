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
    staleTime: 15_000,
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
