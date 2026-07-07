import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, CheckCircle2, Clock3, Coffee, PhoneCall, Utensils } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queries/keys";
import {
  useCxBulkLoadPauseProgressive,
  useCxBulkLoadResumeProgressive,
  useCxBulkLoadSession,
} from "@/lib/api/queries/cxBulkLoad";
import { useSession } from "@/lib/auth/useSession";
import { toast } from "@/components/ui/Toaster";
import { cn } from "@/lib/utils/cn";

/**
 * CxAvailabilityToggle — agent's quick "I'm here / I'm not" switch.
 *
 * Lives in the CXShell header. Reads the agent's own AgentState every
 * 10s (cheap GET) and renders Available / Unavailable buttons that map
 * to the existing endpoints:
 *
 *   POST /api/agents/:extensionId/available    → activityState: "idle"
 *   POST /api/agents/:extensionId/unavailable  → activityState: "unavailable"
 *
 * Behavior nuances:
 *   - When activityState ∈ {dialing, onCall, dispositioning}, both
 *     buttons are disabled and a status badge shows the in-flight state.
 *     The toggle is for SELF-DRIVEN unavail/avail; you can't manually
 *     "set yourself onCall" — that's driven by RC presence.
 *   - When state is "wrapup" we still allow toggle so an agent can mark
 *     themselves unavail right after a call before the next slice.
 *   - Optimistic UI: button click flips the state immediately; if the
 *     mutation fails, it reverts and shows a toast.
 *
 * Visible to admins too (they have an extensionId most of the time).
 * If the user has no extensionId, the toggle hides itself.
 */

type AgentStateResponse = {
  ok: true;
  agent: {
    extensionId: string;
    name: string;
    role?: string;
    company?: string;
    activityState?: string;
    cxRouting?: {
      enabled?: boolean;
      desiredAvailability?: "available" | "unavailable";
      reason?: string;
      pauseType?: string | null;
      pauseReleaseAt?: string | null;
      breakUsage?: Record<string, unknown> | null;
    } | null;
    lastActivityAt?: string | null;
  };
};

const TOGGLE_DISABLED_STATES = new Set(["dialing", "onCall", "dispositioning"]);
const CX_WORKSPACE_STATUS_DOMAIN = "WYNN";

function numberFrom(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function remainingBreaks(usage: Record<string, unknown>, usedKey: string, remainingKey: string, allowance: number) {
  const explicit = Number(usage[remainingKey]);
  if (Number.isFinite(explicit)) return Math.max(explicit, 0);
  return Math.max(allowance - numberFrom(usage[usedKey]), 0);
}

export function CxAvailabilityToggle() {
  const { user } = useSession();
  const qc = useQueryClient();
  const extensionId = user?.extensionId || "";
  const agentEmail = user?.email || null;

  const stateQuery = useQuery({
    queryKey: queryKeys.agentState.detail(extensionId),
    queryFn: () =>
      api.get<AgentStateResponse>(`/api/agents/${encodeURIComponent(extensionId)}`),
    enabled: Boolean(extensionId),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
  const bulk = useCxBulkLoadSession(Boolean(extensionId), agentEmail);
  const pauseProgressive = useCxBulkLoadPauseProgressive();
  const resumeProgressive = useCxBulkLoadResumeProgressive();

  const setStatus = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ ok: true; result: Record<string, unknown> }>(
        `/api/commands/cx/${CX_WORKSPACE_STATUS_DOMAIN}/set-status`,
        body,
      ),
    onSuccess: (response) => {
      const result = response?.result && typeof response.result === "object" ? response.result : {};
      const commandResponse = result.response && typeof result.response === "object"
        ? result.response as { cxRouting?: AgentStateResponse["agent"]["cxRouting"] }
        : null;
      if (commandResponse?.cxRouting) {
        qc.setQueryData<AgentStateResponse | undefined>(
          queryKeys.agentState.detail(extensionId),
          (previous) => previous
            ? {
                ...previous,
                agent: {
                  ...previous.agent,
                  cxRouting: commandResponse.cxRouting || previous.agent.cxRouting,
                },
              }
            : previous,
        );
      }
      qc.invalidateQueries({ queryKey: queryKeys.agentState.detail(extensionId) });
      qc.invalidateQueries({ queryKey: queryKeys.cx.all() });
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast.error("Could not update CX availability", { description: msg });
    },
  });

  if (!extensionId) return null;

  const data = stateQuery.data?.agent;
  const activityState = data?.activityState || "offline";
  const platformReady = user?.cxAuth?.oauthRequired === false || Boolean(user?.cxAuth?.isOAuthValidated);
  const cxAvailable = data?.cxRouting?.desiredAvailability === "available";
  const cxUnavailable = data?.cxRouting?.desiredAvailability === "unavailable";
  const breakUsage = data?.cxRouting?.breakUsage || {};
  const pauseType = String(data?.cxRouting?.pauseType || "").trim();
  const shortBreaksRemaining = remainingBreaks(breakUsage, "shortBreaksUsed", "shortBreaksRemaining", 2);
  const mealBreaksRemaining = remainingBreaks(breakUsage, "mealBreaksUsed", "mealBreaksRemaining", 1);
  const bulkSessionId = bulk.data?.status === "running" ? bulk.data.sessionId : null;
  const inFlight = setStatus.isPending || pauseProgressive.isPending || resumeProgressive.isPending;
  const lockedByCall = TOGGLE_DISABLED_STATES.has(activityState);
  const isAvailable = activityState === "idle" && cxAvailable;
  const isUnavailable = activityState === "unavailable" || cxUnavailable;
  const breakLabel =
    pauseType === "meal-break"
      ? "15 min break"
      : pauseType === "short-break"
        ? "5 min break"
        : "Break";

  async function changeAvailability(next: "available" | "unavailable", breakType?: "short-break" | "meal-break") {
    if (bulkSessionId && next === "unavailable") {
      await pauseProgressive.mutateAsync({
        sessionId: bulkSessionId,
        reason: breakType ? `bulk-${breakType}` : "bulk-manual-unavailable",
        holdUntilResume: true,
      });
    }

    const result = await setStatus.mutateAsync({
      status: next,
      reason: next === "available" ? "manual-available" : "manual-unavailable",
      ...(next === "unavailable" && breakType ? { breakType } : {}),
    });
    const commandResult = result?.result && typeof result.result === "object" ? result.result : {};
    const commandResponse = commandResult.response && typeof commandResult.response === "object"
      ? commandResult.response as { cxRouting?: { desiredAvailability?: string; reason?: string; pauseType?: string | null } | null }
      : null;
    const resolvedRouting = commandResponse?.cxRouting || null;
    const resolvedAvailability = resolvedRouting?.desiredAvailability || next;
    const resolvedPauseType = resolvedRouting?.pauseType || breakType || "";

    if (next === "available" && resolvedAvailability === "unavailable" && resolvedRouting?.reason === "ex-busy") {
      toast.warning("Held unavailable - EX call active", {
        description: "CX availability will flip back when EX returns idle.",
      });
      return;
    }

    if (bulkSessionId && next === "available") {
      await resumeProgressive.mutateAsync({
        sessionId: bulkSessionId,
        reason: "bulk-manual-available",
      });
    }

    toast(resolvedAvailability === "available" ? "Dialing resumed" : "Break started", {
      description: resolvedAvailability === "available"
        ? "Go off hook in RingCX to resume work."
        : resolvedPauseType === "meal-break"
          ? "You are on a 15 minute break."
          : "You are on a 5 minute break.",
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {lockedByCall ? (
        <span
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-500/10 px-2.5 py-1 text-xs font-medium text-blue-600"
          title={`Activity state: ${activityState}`}
        >
          <PhoneCall className="h-3.5 w-3.5" />
          {activityState === "onCall" ? "On call"
            : activityState === "dialing" ? "Dialing"
            : "Wrapping up"}
        </span>
      ) : (
        <>
          <button
            type="button"
            disabled={inFlight || isAvailable || !platformReady}
            onClick={() => void changeAvailability("available").catch(() => null)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              isAvailable
                ? "bg-emerald-500/10 text-emerald-600 cursor-default"
                : "bg-muted text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-600",
              inFlight && "opacity-60 cursor-wait",
            )}
            title={platformReady ? "Mark yourself available for CX leads" : "Connect RingCentral first"}
          >
            {setStatus.isPending || resumeProgressive.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            Available
          </button>
          {isUnavailable ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600"
              title="Use Available to resume work."
            >
              <Clock3 className="h-3.5 w-3.5" />
              {breakLabel}
            </span>
          ) : (
            <>
              <button
                type="button"
                disabled={inFlight || !platformReady || shortBreaksRemaining <= 0}
                onClick={() => void changeAvailability("unavailable", "short-break").catch(() => null)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  "bg-muted text-muted-foreground hover:bg-amber-500/10 hover:text-amber-700",
                  inFlight && "opacity-60 cursor-wait",
                )}
                title={
                  shortBreaksRemaining <= 0
                    ? "Both 5 minute breaks are used for this work block."
                    : "Start a 5 minute break."
                }
              >
                {pauseProgressive.isPending && pauseType === "short-break" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Coffee className="h-3.5 w-3.5" />
                )}
                5 min ({shortBreaksRemaining})
              </button>
              <button
                type="button"
                disabled={inFlight || !platformReady || mealBreaksRemaining <= 0}
                onClick={() => void changeAvailability("unavailable", "meal-break").catch(() => null)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  "bg-muted text-muted-foreground hover:bg-amber-500/10 hover:text-amber-700",
                  inFlight && "opacity-60 cursor-wait",
                )}
                title={
                  mealBreaksRemaining <= 0
                    ? "The 15 minute break is used for this work block."
                    : "Start a 15 minute break."
                }
              >
                {pauseProgressive.isPending && pauseType === "meal-break" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Utensils className="h-3.5 w-3.5" />
                )}
                15 min ({mealBreaksRemaining})
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
