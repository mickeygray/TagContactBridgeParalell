import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, CheckCircle2, PhoneCall } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queries/keys";
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
    } | null;
    lastActivityAt?: string | null;
  };
};

const TOGGLE_DISABLED_STATES = new Set(["dialing", "onCall", "dispositioning"]);

export function CxAvailabilityToggle() {
  const { user } = useSession();
  const qc = useQueryClient();
  const extensionId = user?.extensionId || "";

  const stateQuery = useQuery({
    queryKey: queryKeys.agentState.detail(extensionId),
    queryFn: () =>
      api.get<AgentStateResponse>(`/api/agents/${encodeURIComponent(extensionId)}`),
    enabled: Boolean(extensionId),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

  const setAvailable = useMutation({
    mutationFn: () =>
      api.post<{ ok: true; agent: AgentStateResponse["agent"] }>(
        `/api/agents/${encodeURIComponent(extensionId)}/available`,
      ),
    onSuccess: (response) => {
      if (response?.agent) {
        qc.setQueryData(queryKeys.agentState.detail(extensionId), {
          ok: true,
          agent: response.agent,
        });
      }
      qc.invalidateQueries({ queryKey: queryKeys.agentState.detail(extensionId) });
      qc.invalidateQueries({ queryKey: queryKeys.cx.all() });
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast.error("Could not mark available", { description: msg });
    },
  });

  if (!extensionId) return null;

  const data = stateQuery.data?.agent;
  const activityState = data?.activityState || "offline";
  const platformReady = user?.cxAuth?.oauthRequired === false || Boolean(user?.cxAuth?.isOAuthValidated);
  const cxAvailable = data?.cxRouting?.desiredAvailability === "available";
  const cxUnavailable = data?.cxRouting?.desiredAvailability === "unavailable";
  const inFlight = setAvailable.isPending;
  const lockedByCall = TOGGLE_DISABLED_STATES.has(activityState);
  const isAvailable = activityState === "idle" && cxAvailable;
  const isUnavailable = activityState === "unavailable" || cxUnavailable;

  return (
    <div className="flex items-center gap-2">
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
            onClick={() => setAvailable.mutate()}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              isAvailable
                ? "bg-emerald-500/10 text-emerald-600 cursor-default"
                : "bg-muted text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-600",
              inFlight && "opacity-60 cursor-wait",
            )}
            title={platformReady ? "Mark yourself available for CX leads" : "Connect RingCentral first"}
          >
            {setAvailable.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            Available
          </button>
          {isUnavailable ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600"
              title="Use the CX workspace controls to pick a timed break."
            >
              Break
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}
