import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  DeployAction,
  DeployActionResult,
  LocalDeployAction,
  LocalDeployActionResult,
  DeployRun,
  DeployState,
  DeployWorkspaceData,
  OkEnvelope,
} from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

export function useDeployWorkspace(domain: string) {
  return useQuery({
    queryKey: queryKeys.deploy.workspace(domain),
    queryFn: () =>
      api
        .get<OkEnvelope<DeployWorkspaceData>>(`/api/read/deploy/${domain}`)
        .then((env) => env.result),
    enabled: Boolean(domain),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useDeployRuns(target?: string | null, limit = 20) {
  return useQuery({
    queryKey: [...queryKeys.deploy.all(), "runs", target ?? "all", limit] as const,
    queryFn: () =>
      api
        .get<OkEnvelope<{ configured: boolean; runs: DeployRun[] }>>(
          "/api/read/deploy/runs",
          { query: { target: target ?? undefined, limit } },
        )
        .then((env) => env.result),
    staleTime: 5_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

type CommandPath = "full" | "content-push" | "restart-service";
const COMMAND_PATHS: Record<DeployAction, CommandPath> = {
  full: "full",
  content: "content-push",
  restart: "restart-service",
};

function invalidateDeployScope(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: queryKeys.deploy.all() });
  qc.invalidateQueries({ queryKey: queryKeys.workflows.all() });
}

export function useTriggerDeploy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      targetKey,
      action,
      note,
      confirm,
    }: {
      targetKey: string;
      action: DeployAction;
      note?: string;
      /** Required for destructive actions (full, restart). Backend checks === targetKey. */
      confirm?: string;
    }) =>
      api
        .post<OkEnvelope<DeployActionResult>>(
          `/api/commands/deploy/${COMMAND_PATHS[action]}`,
          { targetKey, note, confirm },
        )
        .then((env) => env.result),
    onSuccess: () => invalidateDeployScope(qc),
  });
}

export function useTriggerLocalDeploy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      targetKey,
      action,
      note,
      confirm,
    }: {
      targetKey: string;
      action: LocalDeployAction;
      note?: string;
      confirm?: string;
    }) =>
      api
        .post<OkEnvelope<LocalDeployActionResult>>(
          `/api/commands/deploy/local/${encodeURIComponent(action)}`,
          { targetKey, note, confirm },
        )
        .then((env) => env.result),
    onSuccess: () => invalidateDeployScope(qc),
  });
}

export function useCancelDeployRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, targetKey }: { runId: string; targetKey: string }) =>
      api
        .post<OkEnvelope<{ ok: true; cancelled: boolean; runId: string }>>(
          `/api/commands/deploy/cancel/${encodeURIComponent(runId)}`,
          { targetKey },
        )
        .then((env) => env.result),
    onSuccess: () => invalidateDeployScope(qc),
  });
}

export type { DeployState, DeployRun };
