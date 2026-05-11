import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type { AuthUser, SendCodeResponse, VerifyCodeResponse } from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

export function useMeQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.auth.me(),
    queryFn: () => api.get<AuthUser>("/api/auth/me"),
    enabled,
    staleTime: 60_000,
  });
}

export function useSendCodeMutation() {
  return useMutation({
    mutationFn: (email: string) =>
      api.post<SendCodeResponse>(
        "/api/auth/send-code",
        { email },
        { auth: false, bodyEncoding: "form" },
      ),
  });
}

export function useVerifyCodeMutation() {
  return useMutation({
    mutationFn: (vars: { email: string; code: string; challengeId?: string }) =>
      api.post<VerifyCodeResponse>(
        "/api/auth/verify-code",
        vars,
        { auth: false, bodyEncoding: "form" },
      ),
  });
}
