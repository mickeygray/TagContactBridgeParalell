import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queries/keys";

export interface CxBulkLoadCurrent {
  queueItemId?: string | null;
  domain?: string | null;
  caseId?: number | string | null;
  name?: string | null;
  phone?: string | null;
  phoneLast4?: string | null;
  phase?: string | null;
  status?: string | null;
  outcome?: string | null;
  uii?: string | null;
  activeAt?: string | null;
  activeCallSummary?: Record<string, unknown> | null;
  matchReasons?: string[];
  externId?: string | null;
  ringcx?: Record<string, unknown> | null;
}

export interface CxBulkLoadSession {
  sessionId: string;
  runtime: "bulk_load" | string;
  status: "running" | "completed" | "killed" | "failed" | string;
  phase: string;
  domain?: string | null;
  agentEmail?: string | null;
  current: CxBulkLoadCurrent | null;
  remainingQueue?: CxBulkLoadCurrent[];
  completed?: CxBulkLoadCurrent[];
  lastOutcome?: CxBulkLoadCurrent | null;
  reviewHoldUntil?: string | null;
  reviewHoldReason?: string | null;
  bufferCount: number;
  completedCount: number;
  stats: Record<string, unknown>;
  lastError?: unknown;
  // present only on the disposition response
  dispositionOk?: boolean;
  getLeads?: {
    ok?: boolean;
    reason?: string | null;
    error?: string | null;
    queueItemId?: string | null;
    elapsedMs?: number | null;
  };
}

export interface CxBulkLoadReviewOutcomeResult {
  ok: boolean;
  updated?: boolean;
  recorded?: boolean;
  deduped?: boolean;
  reason?: string | null;
  sessionId?: string | null;
  queueItemId?: string | null;
  uii?: string | null;
  outcome?: string | null;
}

export interface CxBulkLoadSideEffectStatus {
  ok?: boolean;
  skipped?: boolean;
  reason?: string | null;
  error?: string;
  status?: number | null;
}

export interface CxBulkLoadSideEffectResult {
  ok?: boolean;
  skipped?: boolean;
  reason?: string | null;
  error?: string | null;
  paused?: boolean;
  resumed?: boolean;
  restored?: boolean;
  restoreScheduled?: boolean;
  holdUntilResume?: boolean;
  pauseMs?: number | null;
}

export interface CxBulkLoadAppointmentWrapResult {
  ok: boolean;
  session: CxBulkLoadSession | null;
  appointment: CxBulkLoadSideEffectStatus & {
    result?: Record<string, unknown> | null;
  };
  workbench: CxBulkLoadSideEffectStatus & {
    task?: Record<string, unknown> | null;
    activity?: Record<string, unknown> | null;
  };
  assign: CxBulkLoadSideEffectStatus & {
    result?: Record<string, unknown> | null;
  };
  postdate: CxBulkLoadSideEffectStatus & {
    result?: Record<string, unknown> | null;
  };
  terminal: CxBulkLoadSideEffectStatus & {
    dispositionOk?: boolean;
    result?: Record<string, unknown> | null;
  };
  resume: CxBulkLoadSideEffectStatus & {
    resumed?: boolean;
    restored?: boolean;
  };
}

function bulkLoadQueryKey(agentEmail?: string | null) {
  return [...queryKeys.cx.all(), "bulk-load", agentEmail || "me"] as const;
}

function invalidateBulkLoad(qc: ReturnType<typeof useQueryClient>, agentEmail?: string | null) {
  qc.invalidateQueries({ queryKey: bulkLoadQueryKey(agentEmail) });
}

export function useCxBulkLoadSession(enabled = false, agentEmail?: string | null) {
  return useQuery({
    queryKey: bulkLoadQueryKey(agentEmail),
    queryFn: () =>
      api
        .get<{ ok: true; result: CxBulkLoadSession | null }>("/api/cx/bulk-load/session", {
          query: { agentEmail: agentEmail || undefined },
        })
        .then((r) => r.result),
    enabled,
    staleTime: 500,
    placeholderData: keepPreviousData,
    refetchInterval: enabled ? 1000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 2,
  });
}

function buildBulkLoadCommandHook(path: string) {
  return function useCxBulkLoadCommand() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (body: Record<string, unknown> = {}) =>
        api
          .post<{ ok: true; result: CxBulkLoadSession | null }>(`/api/cx/bulk-load/${path}`, body)
          .then((r) => r.result),
      onSuccess: (result, vars) => {
        const agentEmail = typeof vars?.agentEmail === "string" ? vars.agentEmail : null;
        if (result) {
          qc.setQueryData(bulkLoadQueryKey(agentEmail), result);
        }
        invalidateBulkLoad(qc, agentEmail);
      },
    });
  };
}

function buildBulkLoadSideEffectHook(path: string) {
  return function useCxBulkLoadSideEffectCommand() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (body: Record<string, unknown> = {}) =>
        api
          .post<{ ok: true; result: CxBulkLoadSideEffectResult | null }>(`/api/cx/bulk-load/${path}`, body)
          .then((r) => r.result),
      onSuccess: (_result, vars) => {
        const agentEmail = typeof vars?.agentEmail === "string" ? vars.agentEmail : null;
        invalidateBulkLoad(qc, agentEmail);
      },
    });
  };
}

export const useCxBulkLoadStart = buildBulkLoadCommandHook("start");
export const useCxBulkLoadDisposition = buildBulkLoadCommandHook("disposition");
export const useCxBulkLoadGetLeads = buildBulkLoadCommandHook("get-leads");
export const useCxBulkLoadPauseProgressive = buildBulkLoadSideEffectHook("pause-progressive");
export const useCxBulkLoadResumeProgressive = buildBulkLoadSideEffectHook("resume-progressive");
export const useCxBulkLoadSkip = buildBulkLoadCommandHook("skip");
export const useCxBulkLoadKill = buildBulkLoadCommandHook("kill");
export const useCxBulkLoadAppointmentWrap = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown> = {}) =>
      api
        .post<{ ok: true; result: CxBulkLoadAppointmentWrapResult }>("/api/cx/bulk-load/appointment-wrap", body)
        .then((r) => r.result),
    onSuccess: (result, vars) => {
      const agentEmail = typeof vars?.agentEmail === "string" ? vars.agentEmail : null;
      if (result?.session) {
        qc.setQueryData(bulkLoadQueryKey(agentEmail), result.session);
      }
      invalidateBulkLoad(qc, agentEmail);
    },
  });
};

export function useCxBulkLoadReviewOutcome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown> = {}) =>
      api
        .post<{ ok: true; result: CxBulkLoadReviewOutcomeResult }>("/api/cx/bulk-load/review-outcome", body)
        .then((r) => r.result),
    onSuccess: (_result, vars) => {
      const agentEmail = typeof vars?.agentEmail === "string" ? vars.agentEmail : null;
      invalidateBulkLoad(qc, agentEmail);
    },
  });
}
