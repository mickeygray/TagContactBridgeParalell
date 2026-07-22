import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { toast } from "@/components/ui/Toaster";
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
  completed?: CxBulkLoadCurrent[];
  lastOutcome?: CxBulkLoadCurrent | null;
  reviewHoldUntil?: string | null;
  reviewHoldReason?: string | null;
  completedCount: number;
  stats: Record<string, unknown>;
  controls?: {
    outcomes?: boolean;
    queue?: boolean;
    appointmentFallback?: boolean;
  };
  lastError?: unknown;
  // present only on the disposition response
  dispositionOk?: boolean;
  dispositionResult?: {
    ok?: boolean;
    reason?: string | null;
  };
  buttonAction?: {
    ok?: boolean;
    action?: string | null;
    reason?: string | null;
    error?: string | null;
  };
  buttonRefill?: {
    ok?: boolean;
    reason?: string | null;
    error?: string | null;
    outstanding?: number | null;
    target?: number | null;
  };
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

export interface CxBulkLoadDispositionRequest {
  [key: string]: unknown;
  sessionId: string;
  disposition: "answered" | "did_not_connect" | "bad_number" | "voicemail";
  expectedExternId: string;
  expectedUii: string;
  nextAction: "call_wrap" | "cadence" | "logics_dnc" | "ringcx_vm_drop";
  agentEmail?: string;
}

function bulkLoadQueryKey(agentEmail?: string | null) {
  return [...queryKeys.cx.all(), "bulk-load", agentEmail || "me"] as const;
}

function invalidateBulkLoad(qc: ReturnType<typeof useQueryClient>, agentEmail?: string | null) {
  return qc.invalidateQueries({ queryKey: bulkLoadQueryKey(agentEmail) });
}

export function useCxBulkLoadSession(enabled = false, agentEmail?: string | null) {
  return useQuery<CxBulkLoadSession | null>({
    queryKey: bulkLoadQueryKey(agentEmail),
    queryFn: ({ signal }) =>
      api
        .get<{ ok: true; result: CxBulkLoadSession | null }>("/api/cx/bulk-load/session", {
          query: { agentEmail: agentEmail || undefined },
          signal,
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

function buildBulkLoadCommandHook<TBody extends Record<string, unknown> = Record<string, unknown>>(path: string) {
  return function useCxBulkLoadCommand() {
    const qc = useQueryClient();
    return useMutation<CxBulkLoadSession | null, Error, TBody>({
      mutationFn: (body: TBody) =>
        api
          .post<{ ok: true; result: CxBulkLoadSession | null }>(`/api/cx/bulk-load/${path}`, body)
          .then((r) => r.result),
      onMutate: async (vars) => {
        const agentEmail = typeof vars?.agentEmail === "string" ? vars.agentEmail : null;
        await qc.cancelQueries({ queryKey: bulkLoadQueryKey(agentEmail) });
      },
      onSuccess: (result, vars) => {
        const agentEmail = typeof vars?.agentEmail === "string" ? vars.agentEmail : null;
        if (result && (result.status !== "running" || !result.current)) {
          qc.setQueryData(bulkLoadQueryKey(agentEmail), result);
        }
      },
      onSettled: (_result, _error, vars) => {
        const agentEmail = typeof vars?.agentEmail === "string" ? vars.agentEmail : null;
        return invalidateBulkLoad(qc, agentEmail);
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
export const useCxBulkLoadDisposition = buildBulkLoadCommandHook<CxBulkLoadDispositionRequest>("disposition");
export const useCxBulkLoadGetLeads = buildBulkLoadCommandHook("get-leads");
export const useCxBulkLoadPauseProgressive = buildBulkLoadSideEffectHook("pause-progressive");
export const useCxBulkLoadResumeProgressive = buildBulkLoadSideEffectHook("resume-progressive");
export const useCxBulkLoadSkip = buildBulkLoadCommandHook("skip");
export const useCxBulkLoadKill = buildBulkLoadCommandHook("kill");

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

// CALL WRAP CARDS (docs/CX_CALL_WRAP_QUEUE_DESIGN_2026-07-06.md). Server answers
// {enabled:false, cards:[]} when CX_CALL_WRAP_QUEUE_ENABLED is off — the bar renders
// nothing and the feature is invisible by default.
export type CxWrapCard = {
  idemKey: string;
  name: string | null;
  caseId: number | null;
  queueItemId: string | null;
  uii: string | null;
  calledAt: string | null;
  expiresAt: string | null;
  systemDisposition: string | null;
  appointmentOnly?: boolean;
  coachSummary: string | null;
};

export type CxLaneCall = {
  lane: "firstTouch" | "appointment";
  uii: string;
  externId: string;
  callState: string | null;
  caseId: number | null;
  name: string | null;
  domain: string | null;
  meta?: {
    mintedAt?: string | null;
    phone?: string | null;
    phoneLast4?: string | null;
    appointmentAt?: string | null;
    bookedBy?: string | null;
  };
};

export type CxLaneDispositionResult = {
  ok: boolean;
  dispositionOk: boolean;
  reason?: string | null;
  laneCall?: CxLaneCall | null;
  outcome?: string | null;
  disposition?: string | null;
  persisted?: boolean;
  terminal?: Record<string, unknown> | null;
  postDispositionHangup?: Record<string, unknown> | null;
};

export type CxLaneCallResult = { enabled?: boolean; laneCall: CxLaneCall | null };

export function useCxLaneCall(enabled: boolean) {
  return useQuery({
    queryKey: ["cx-lane-call"],
    queryFn: ({ signal }) =>
      api
        .get<{ ok: true; result: CxLaneCallResult }>("/api/cx/bulk-load/lane-call", { signal })
        .then((r) => r.result),
    enabled,
    staleTime: 1_000,
    // ONE PROBE DECIDES (rollout note 2026-07-08): lanes off server-side -> polling stops
    // entirely, so dormant floors carry zero moving parts. A flag flip re-arms on the
    // next page load (rollout = restart + refresh anyway).
    refetchInterval: (query) =>
      enabled && query.state.data?.enabled !== false ? 2_000 : false,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}

export function useCxLaneCallDisposition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown> = {}) =>
      api
        .post<{ ok: true; result: CxLaneDispositionResult }>("/api/cx/bulk-load/lane-call/disposition", body)
        .then((r) => r.result),
    onMutate: () => qc.cancelQueries({ queryKey: ["cx-lane-call"] }),
    onSettled: () => {
      return Promise.all([
        qc.invalidateQueries({ queryKey: ["cx-lane-call"] }),
        invalidateBulkLoad(qc),
      ]);
    },
  });
}

export type CxWrapCardsResult = { enabled: boolean; cards: CxWrapCard[] };

export function useCxWrapCards(enabled: boolean) {
  return useQuery({
    queryKey: ["cx-wrap-cards"],
    queryFn: () =>
      api
        .get<{ ok: true; result: CxWrapCardsResult }>("/api/cx/bulk-load/wrap-cards")
        .then((r) => r.result),
    enabled,
    staleTime: 2_000,
    // the fast-mint route cards a call ~1s after the disposition — a 5s poll keeps the
    // sidebar within a breath of the terminal event without hammering anything
    refetchInterval: enabled ? 5_000 : false,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}

export type CxWrapResolveResult = {
  resolution: string | null;
  noop: boolean;
  effects?: {
    interviewOk: boolean | null;
    correctionOk: boolean | null;
    appointmentOk: boolean | null;
    logicsStatusOk: boolean | null;
    cadenceOk: boolean | null;
  };
  failedEffects?: { name: string; error: string }[];
};

export function useCxWrapCardResolve() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      idemKey: string;
      action: "dnc" | "appointment" | "dismiss";
      appointmentAt?: string;
      appointmentDate?: string;
      appointmentTime?: string;
      appointmentTimezone?: string;
    }) =>
      api
        .post<{ ok: true; result: CxWrapResolveResult }>(
          "/api/cx/bulk-load/wrap-cards/resolve",
          body,
        )
        .then((r) => r.result),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["cx-wrap-cards"] });
      // Cert blocker #5: a failed external effect must never hide behind a resolved
      // card. Loud and specific — the operator repair path starts with knowing.
      const failed = result?.failedEffects ?? [];
      if (failed.length) {
        const detail = failed.map((f) => `${f.name}: ${f.error}`).join("; ");
        // persistent (no auto-dismiss) — the repair path starts with knowing, but a
        // blocking alert is wrong for the floor (review note 2026-07-08).
        toast.error("Card resolved, but an external write FAILED — tell an admin", {
          description: detail,
          duration: Infinity,
        });
      }
    },
  });
}
