import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type { LibraryWorkspaceData, OkEnvelope } from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

export function useLibraryWorkspace(domain: string) {
  return useQuery({
    queryKey: queryKeys.library.workspace(domain),
    queryFn: () =>
      api
        .get<OkEnvelope<LibraryWorkspaceData>>(`/api/read/library/${domain}`)
        .then((env) => env.result),
    enabled: Boolean(domain),
    staleTime: 60_000,
  });
}
