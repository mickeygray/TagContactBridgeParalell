import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  OkEnvelope,
  SocialResponderConfigRecord,
  SocialResponderUpdateInput,
  SocialResponderWorkspaceData,
} from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

export function useSocialResponderWorkspace(domain: string) {
  return useQuery({
    queryKey: queryKeys.social.workspace(domain),
    queryFn: () =>
      api
        .get<OkEnvelope<SocialResponderWorkspaceData>>(`/api/read/social/${domain}`)
        .then((env) => env.result),
    enabled: Boolean(domain),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useSaveSocialResponderConfig(domain: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      platform,
      input,
    }: {
      platform: string;
      input: SocialResponderUpdateInput;
    }) =>
      api
        .put<OkEnvelope<SocialResponderConfigRecord>>(
          `/api/commands/social/${domain}/${platform}`,
          input,
        )
        .then((env) => env.result),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.social.workspace(domain) });
    },
  });
}
