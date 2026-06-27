import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queries/keys";

export interface CxSlowSingleCurrent {
  queueItemId?: string | null;
  domain?: string | null;
  caseId?: number | string | null;
  name?: string | null;
  phoneLast4?: string | null;
  phoneHash?: string | null;
  queueFamily?: string | null;
  queueTier?: string | null;
  progressiveStageKey?: string | null;
  state?: string | null;
  phase?: string | null;
  outcome?: string | null;
  uii?: string | null;
  activeAt?: string | null;
  activeCallSummary?: Record<string, unknown> | null;
  matchReasons?: string[];
  firstPollMs?: number | null;
  uiiFoundMs?: number | null;
  ringcx?: Record<string, unknown> | null;
}

export interface CxSlowSingleSession {
  sessionId: string;
  status: "running" | "completed" | "killed" | "failed" | string;
  phase: string;
  agentEmail?: string | null;
  agentExtensionId?: string | null;
  cxAgentId?: string | null;
  domain?: string | null;
  current: CxSlowSingleCurrent | null;
  lastOutcome: CxSlowSingleCurrent | null;
  lastError?: unknown;
  trace: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  startedAt?: string | null;
  updatedAt?: string | null;
}

function slowSingleQueryKey(agentEmail?: string | null) {
  return [...queryKeys.cx.all(), "slow-single", agentEmail || "me"] as const;
}

function invalidateSlowSingle(qc: ReturnType<typeof useQueryClient>, agentEmail?: string | null) {
  qc.invalidateQueries({ queryKey: slowSingleQueryKey(agentEmail) });
  qc.invalidateQueries({ queryKey: queryKeys.cx.all() });
}

export function useCxSlowSingleSession(enabled = false, agentEmail?: string | null) {
  return useQuery({
    queryKey: slowSingleQueryKey(agentEmail),
    queryFn: () =>
      api
        .get<{ ok: true; result: CxSlowSingleSession | null }>("/api/cx/slow-single/session", {
          query: { agentEmail: agentEmail || undefined },
        })
        .then((r) => r.result),
    enabled,
    staleTime: 500,
    refetchInterval: enabled ? 1000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 2,
  });
}

function buildSlowSingleCommandHook(path: string) {
  return function useCxSlowSingleCommand() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (body: Record<string, unknown> = {}) =>
        api
          .post<{ ok: true; result: CxSlowSingleSession | null }>(
            `/api/cx/slow-single/${path}`,
            body,
          )
          .then((r) => r.result),
      onSuccess: (_result, vars) => {
        const agentEmail = typeof vars?.agentEmail === "string" ? vars.agentEmail : null;
        invalidateSlowSingle(qc, agentEmail);
      },
    });
  };
}

export const useCxSlowSingleStart = buildSlowSingleCommandHook("start");
export const useCxSlowSingleWatch = buildSlowSingleCommandHook("watch");
export const useCxSlowSingleOutcome = buildSlowSingleCommandHook("outcome");
export const useCxSlowSingleKill = buildSlowSingleCommandHook("kill");
