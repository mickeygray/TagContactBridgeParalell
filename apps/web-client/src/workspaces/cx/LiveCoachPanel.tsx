import * as React from "react";
import { MessageSquareQuote, MessagesSquare, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api/client";
import {
  streamLiveCoachEventsWithRetry,
  type LiveCoachContext,
  type LiveCoachDialog,
  type LiveCoachEvent,
  type LiveCoachSession,
  type LiveCoachTranscript,
} from "@/lib/liveCoach/stream";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { cn } from "@/lib/utils/cn";

type LiveCoachPanelProps = {
  agentEmail?: string | null;
  agentExtension?: string | null;
  agentName?: string | null;
  currentUii?: string | null;
  currentCallSessionId?: string | null;
  queueItemId?: string | null;
  caseId?: string | null;
  contactName?: string | null;
  releaseKey?: string | null;
  releaseReason?: string | null;
};

type ConversationItem = {
  id: string;
  at: string;
  side: "prospect" | "agent" | "system";
  label: string;
  text: string;
  provisional?: boolean;
  lowConfidence?: boolean;
};

type CoachStageTone = "idle" | "active" | "good" | "warn" | "danger";

type CoachStage = {
  label: string;
  detail?: string;
  at?: string;
  tone: CoachStageTone;
};

type BridgeStatus = "disabled" | "connecting" | "connected" | "error";

type CoachState = {
  session: LiveCoachSession | null;
  provisionalTranscript: LiveCoachTranscript | null;
  prospectTranscript: LiveCoachTranscript | null;
  context: LiveCoachContext | null;
  dialog: LiveCoachDialog | null;
  stage: CoachStage;
  conversationItems: ConversationItem[];
  bridgeStatus: BridgeStatus;
  error: string;
};

const INITIAL_STAGE: CoachStage = {
  label: "waiting",
  detail: "Waiting for active call",
  tone: "idle",
};

const INITIAL_COACH_STATE: CoachState = {
  session: null,
  provisionalTranscript: null,
  prospectTranscript: null,
  context: null,
  dialog: null,
  stage: INITIAL_STAGE,
  conversationItems: [],
  bridgeStatus: "connecting",
  error: "",
};

type CoachAction =
  | { type: "reset"; status: BridgeStatus; message?: string }
  | { type: "stage"; stage: CoachStage }
  | { type: "bridge"; status: BridgeStatus; error?: string; stage?: CoachStage }
  | { type: "session"; session: LiveCoachSession }
  | { type: "clearItems"; stage?: CoachStage }
  | { type: "event"; payload: LiveCoachEvent };

// Pure transform: fold a fetched/streamed session snapshot into coach state.
// Mirrors the former multi-setState applySession exactly, but as one update.
function reduceSession(state: CoachState, next: LiveCoachSession): CoachState {
  let items = state.conversationItems;
  let provisionalTranscript = state.provisionalTranscript;
  let prospectTranscript = state.prospectTranscript;
  let context = state.context;
  let dialog = state.dialog;

  // Snapshot seeding: an empty thread + a session carrying call memory means
  // we just (re)connected mid-call — paint the WHOLE conversation, not just
  // the latest line. Live events keep appending on top.
  if (!items.length && Array.isArray(next.memory?.transcripts) && next.memory.transcripts.length) {
    for (const row of next.memory.transcripts) {
      items = mergeConversationItem(items, transcriptToConversationItem(row));
    }
  }

  const latestProvisional = next.latest?.provisionalTranscript || null;
  if (latestProvisional) {
    items = mergeConversationItem(items, transcriptToConversationItem({ ...latestProvisional, provisional: true }));
  }
  provisionalTranscript = latestProvisional?.role === "prospect" ? latestProvisional : null;
  const latestTranscript = next.latest?.transcript || null;
  if (latestTranscript) {
    items = mergeConversationItem(items, transcriptToConversationItem(latestTranscript));
  }
  if (latestTranscript?.role === "prospect") {
    prospectTranscript = latestTranscript;
    provisionalTranscript = null;
  }
  if (next.latest?.context) context = next.latest.context;
  if (next.latest?.dialog) dialog = next.latest.dialog;

  return {
    ...state,
    session: next,
    stage: {
      label: next.status === "listening" ? "stream attached" : next.status || "session",
      detail: next.metadata?.streamId ? `stream ${next.metadata.streamId.slice(-8)}` : "Coach session bound",
      tone: next.status === "listening" ? "active" : "idle",
      at: next.lastEventAt || next.updatedAt || new Date().toISOString(),
    },
    conversationItems: items,
    provisionalTranscript,
    prospectTranscript,
    context,
    dialog,
  };
}

// Pure transform: fold one SSE event into coach state in a SINGLE pass.
// Consolidates the former ~7 setState calls per event into one update.
function reduceEvent(state: CoachState, payload: LiveCoachEvent): CoachState {
  let next = state;
  const patch = (changes: Partial<CoachState>) => {
    next = { ...next, ...changes };
  };
  const addItem = (transcript: LiveCoachTranscript) => {
    patch({ conversationItems: mergeConversationItem(next.conversationItems, transcriptToConversationItem(transcript)) });
  };

  const transcript = payload.transcript;
  if (payload.session) next = reduceSession(next, payload.session);

  if (payload.provisionalTranscript) {
    addItem({ ...payload.provisionalTranscript, provisional: true });
  }
  if (payload.provisionalTranscript?.role === "prospect") {
    patch({
      provisionalTranscript: payload.provisionalTranscript,
      stage: {
        label: "STT live",
        detail: "Words are arriving",
        tone: "active",
        at: payload.provisionalTranscript.at || payload.at || new Date().toISOString(),
      },
    });
  }
  if (transcript?.role === "prospect") {
    addItem(transcript);
    patch({
      prospectTranscript: transcript,
      provisionalTranscript: null,
      stage: {
        label: "VAD final",
        detail: "Mini queued",
        tone: "active",
        at: transcript.at || payload.at || new Date().toISOString(),
      },
    });
  } else if (transcript) {
    addItem(transcript);
  }
  if (payload.type === "context.judge.start") {
    patch({
      stage: {
        label: "mini checking",
        detail: payload.candidateCount ? `${payload.candidateCount} candidates` : "Reading released phrase",
        tone: "active",
        at: payload.at || new Date().toISOString(),
      },
    });
  }
  if (payload.type === "context.judge.done") {
    patch({
      stage: {
        label: payload.shouldCompose ? "mini kept" : "mini held",
        detail: [
          payload.elapsedMs ? `${payload.elapsedMs}ms` : "",
          Array.isArray(payload.selectedKeys) && payload.selectedKeys.length
            ? payload.selectedKeys.slice(0, 3).join(", ")
            : payload.actionReason || "",
        ].filter(Boolean).join(" | "),
        tone: payload.shouldCompose ? "good" : "idle",
        at: payload.at || new Date().toISOString(),
      },
    });
  }
  if (payload.type === "pipeline.hold") {
    patch({
      stage: {
        label: "held",
        detail: payload.action || payload.hold?.reason || "No coachable phrase yet",
        tone: "idle",
        at: payload.at || new Date().toISOString(),
      },
    });
  }
  if (payload.type === "context.clear") {
    patch({
      prospectTranscript: {
        at: payload.at || payload.transcript?.at || new Date().toISOString(),
        role: "system",
        text: payload.transcript?.text
          ? `Screener/hold prompt detected. Context cleared. ${payload.transcript.text}`
          : "Screener/hold prompt detected. Context cleared.",
        source: "system context gate",
        wordCount: 0,
      },
      provisionalTranscript: null,
      context: null,
      dialog: null,
      stage: {
        label: "screener hold",
        detail: payload.hold?.match || payload.hold?.reason || "Listening for next prospect phrase",
        tone: "idle",
        at: payload.at || new Date().toISOString(),
      },
    });
  }
  if (payload.context) {
    patch({ context: payload.context });
  }
  if (payload.type === "compose.start") {
    patch({
      stage: {
        label: "coach writing",
        detail: payload.dialogId ? `dialog ${payload.dialogId.slice(-8)}` : "Streaming response",
        tone: "active",
        at: payload.at || new Date().toISOString(),
      },
    });
  }
  if (payload.type === "compose.deduped" || payload.type === "compose.rate_limited") {
    patch({
      stage: {
        label: payload.type === "compose.deduped" ? "deduped" : "rate limited",
        detail: payload.type === "compose.deduped"
          ? "Similar phrase already coached"
          : `${payload.rateLimitPerMinute || 0}/min cap`,
        tone: "warn",
        at: payload.at || new Date().toISOString(),
      },
    });
  }
  if (payload.dialog) {
    patch({ dialog: payload.dialog });
    if (payload.dialog.status === "rejected") {
      const voicemailTranscript = payload.transcript || null;
      patch({
        prospectTranscript: {
          ...(voicemailTranscript || {}),
          at: payload.at || voicemailTranscript?.at || new Date().toISOString(),
          role: "prospect",
          text: voicemailTranscript?.text
            ? `Voicemail detected. ${voicemailTranscript.text}`
            : "Voicemail detected. Coach cleared this call.",
          source: "voicemail gate",
        },
        dialog: null,
        stage: {
          label: "voicemail",
          detail: payload.dialog.guidance || "Call cleared",
          tone: "danger",
          at: payload.at || new Date().toISOString(),
        },
      });
    } else {
      patch({
        stage: {
          label: payload.dialog.status === "streaming" ? "coach streaming" : "line ready",
          detail: payload.dialog.composer || payload.dialog.model || payload.dialog.label || "",
          tone: payload.dialog.status === "ready" ? "good" : "active",
          at: payload.dialog.at || payload.at || new Date().toISOString(),
        },
      });
    }
  }
  if (payload.type === "dialog.error") {
    patch({
      stage: {
        label: "coach error",
        detail: payload.error || payload.dialog?.composerError || "Composer failed",
        tone: "danger",
        at: payload.at || new Date().toISOString(),
      },
    });
  }
  if (payload.type === "voicemail.reject") {
    const voicemailTranscript = payload.transcript;
    patch({
      prospectTranscript: {
        ...(voicemailTranscript || {}),
        at: payload.at || voicemailTranscript?.at || new Date().toISOString(),
        role: "prospect",
        text: voicemailTranscript?.text
          ? `Voicemail detected. ${voicemailTranscript.text}`
          : "Voicemail detected. Coach cleared this call.",
        source: "voicemail gate",
      },
      provisionalTranscript: null,
      dialog: null,
      stage: {
        label: "voicemail",
        detail: payload.dialog?.guidance || "Call cleared",
        tone: "danger",
        at: payload.at || new Date().toISOString(),
      },
    });
  }
  if (payload.type === "session.stop" || payload.type === "session.stale" || payload.type === "session.pruned") {
    // Clear conversation items when the session ends so a stale board
    // doesn't carry the prior call's transcript into the next one.
    patch({
      conversationItems: [],
      stage: {
        label: payload.type === "session.stale" ? "stale" : "released",
        detail: payload.actionReason || "Session ended",
        tone: payload.type === "session.stale" ? "warn" : "idle",
        at: payload.at || new Date().toISOString(),
      },
    });
  }
  return next;
}

function coachReducer(state: CoachState, action: CoachAction): CoachState {
  switch (action.type) {
    case "reset":
      return {
        ...INITIAL_COACH_STATE,
        bridgeStatus: action.status,
        error: action.message || "",
        stage: {
          label: action.status === "disabled" ? "off" : action.status === "connecting" ? "binding" : "waiting",
          detail:
            action.message
            || (action.status === "connecting" ? "Binding coach to current call" : "Waiting for active call"),
          tone: action.status === "error" ? "danger" : action.status === "connecting" ? "active" : "idle",
          at: new Date().toISOString(),
        },
      };
    case "stage":
      return { ...state, stage: action.stage };
    case "bridge":
      return {
        ...state,
        bridgeStatus: action.status,
        ...(action.error !== undefined ? { error: action.error } : {}),
        ...(action.stage ? { stage: action.stage } : {}),
      };
    case "session":
      return reduceSession(state, action.session);
    case "clearItems":
      // Mirrors the former connectEvents reset: clears transcripts/context/
      // dialog/items but preserves the session set by applySession.
      return {
        ...state,
        provisionalTranscript: null,
        prospectTranscript: null,
        context: null,
        dialog: null,
        conversationItems: [],
        ...(action.stage ? { stage: action.stage } : {}),
      };
    case "event":
      return reduceEvent(state, action.payload);
    default:
      return state;
  }
}

const LIVE_COACH_API_BASE = "/api/ai/live-coach";

function formatCoachTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Coach bridge unavailable";
}

function transcriptLabel(role: string | null | undefined) {
  if (role === "agent") return "Agent";
  if (role === "system") return "System";
  if (role === "unknown") return "Unknown";
  return "Prospect";
}

function sideForTranscript(role: string | null | undefined): ConversationItem["side"] {
  if (role === "agent") return "agent";
  if (role === "system" || role === "unknown") return "system";
  return "prospect";
}

function transcriptToConversationItem(transcript: LiveCoachTranscript): ConversationItem | null {
  const text = transcript.text?.trim();
  if (!text) return null;
  const role = transcript.role || "prospect";
  return {
    id: transcript.provisional
      ? `pv:${transcript.itemId || transcript.id || role}`
      : `tr:${transcript.itemId || transcript.id || transcript.at || text}`,
    at: transcript.at || new Date().toISOString(),
    side: sideForTranscript(role),
    label: transcriptLabel(role),
    text,
    provisional: Boolean(transcript.provisional),
    lowConfidence: Boolean(transcript.lowConfidence),
  };
}

function mergeConversationItem(items: ConversationItem[], item: ConversationItem | null) {
  if (!item) return items;
  const withoutReplacedProvisional = item.provisional
    ? items
    : items.filter((existing) => !(existing.provisional && existing.side === item.side));
  const existingIndex = withoutReplacedProvisional.findIndex((existing) => existing.id === item.id);
  const next = existingIndex >= 0
    ? withoutReplacedProvisional.map((existing, index) => (index === existingIndex ? item : existing))
    : [...withoutReplacedProvisional, item];
  return next
    .sort((left, right) => (Date.parse(left.at) || 0) - (Date.parse(right.at) || 0))
    .slice(-120);
}

function cleanParam(value: string | null | undefined) {
  return String(value || "").trim();
}

function stopDashboardSession(sessionId: string, reason: string) {
  if (!sessionId) return;
  api.post(`${LIVE_COACH_API_BASE}/sessions/${encodeURIComponent(sessionId)}/stop`, { reason }).catch(() => {
    // Best-effort release; stale sweep is the backstop.
  });
}

export function LiveCoachPanel({
  agentEmail,
  agentExtension,
  agentName,
  currentUii,
  currentCallSessionId,
  queueItemId,
  caseId,
  contactName,
  releaseKey,
  releaseReason,
}: LiveCoachPanelProps) {
  // Single reducer so each SSE event triggers exactly one render instead of
  // the former ~7 setState calls. All coach-domain state lives here; only the
  // UI-local dialog-open toggle stays a plain useState.
  const [coach, dispatch] = React.useReducer(coachReducer, INITIAL_COACH_STATE);
  const { session, context, dialog, stage, conversationItems, bridgeStatus, error } = coach;
  const [contextOpen, setContextOpen] = React.useState(false);
  // Bind LOCK: once a session is bound for this call it stays bound. Identity
  // drift (uii arriving late, caseId loading, contactName landing) must NOT
  // re-run the bind effect — every re-run aborts the SSE and kills the session
  // server-side, which is the mid-call flicker. The lock only breaks on a
  // genuine call CONFLICT, a terminal session event, a release, or call end.
  const lockRef = React.useRef<{
    sessionId: string;
    uii: string;
    queueItemId: string;
    callSessionId: string;
  } | null>(null);
  const [rebindNonce, setRebindNonce] = React.useState(0);
  const bumpRebind = React.useCallback(() => setRebindNonce((n) => n + 1), []);
  const transcriptScrollRef = React.useRef<HTMLDivElement | null>(null);
  // Mid-call the interesting end of the transcript is the bottom: anchor there
  // when the modal opens and keep following as new lines arrive while open.
  React.useEffect(() => {
    if (!contextOpen) return;
    const el = transcriptScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [contextOpen, conversationItems.length]);
  const releasedScopeRef = React.useRef<{ scopeKey: string; releaseKey: string } | null>(null);
  const cancelledRef = React.useRef(false);

  const scopedAgentEmail = cleanParam(agentEmail).toLowerCase();
  const scopedAgentExtension = cleanParam(agentExtension);
  const scopedUii = cleanParam(currentUii);
  const scopedCallSessionId = cleanParam(currentCallSessionId);
  const scopedQueueItemId = cleanParam(queueItemId);
  const scopedCaseId = cleanParam(caseId);
  const scopedContactName = cleanParam(contactName);
  const callScopeKey = scopedUii || scopedQueueItemId || scopedCallSessionId;
  const agentScopeKey = scopedAgentExtension || scopedAgentEmail;
  const scopeKey = [agentScopeKey, callScopeKey].filter(Boolean).join(":");
  const scopedReleaseKey = cleanParam(releaseKey);
  const scopedReleaseReason = cleanParam(releaseReason) || "cx-workspace-release";
  // The bind effect keys on PRESENCE of a call, never its drifting identity —
  // bindSession reads the freshest params from this ref at request time.
  const hasCall = Boolean(callScopeKey);
  const paramsRef = React.useRef({
    scopedAgentEmail,
    scopedAgentExtension,
    scopedUii,
    scopedQueueItemId,
    scopedCallSessionId,
    scopedCaseId,
    scopedContactName,
    agentName: cleanParam(agentName),
  });
  paramsRef.current = {
    scopedAgentEmail,
    scopedAgentExtension,
    scopedUii,
    scopedQueueItemId,
    scopedCallSessionId,
    scopedCaseId,
    scopedContactName,
    agentName: cleanParam(agentName),
  };

  const resetCoach = React.useCallback((nextStatus: BridgeStatus, message = "") => {
    dispatch({ type: "reset", status: nextStatus, message });
  }, []);

  // Memoized: one reducer dispatch per SSE event => exactly one render.
  // Terminal session events double as the lock's CLEANOUT: a stopped/stale/
  // pruned session drops the lock and schedules a rebind so a dead session is
  // never held open while a replacement is already streaming on the bus.
  const handleEvent = React.useCallback((_eventName: string, payload: LiveCoachEvent) => {
    if (cancelledRef.current) return;
    try {
      dispatch({ type: "event", payload });
    } catch {
      // Ignore malformed local playground events.
    }
    const type = String(payload?.type || "");
    if ((type === "session.stop" || type === "session.stale" || type === "session.pruned") && lockRef.current) {
      lockRef.current = null;
      window.setTimeout(() => {
        if (!cancelledRef.current) bumpRebind();
      }, 800);
    }
  }, [bumpRebind]);

  // Call-conflict detector: the ONLY identity change that breaks the lock is a
  // direct conflict (locked uii/queueItem/callSession differs from a non-empty
  // scoped value) — that means a genuinely different call. Everything else is
  // the same call learning more about itself; absorb it into the lock.
  React.useEffect(() => {
    const lock = lockRef.current;
    if (!lock) return;
    const conflict =
      (lock.uii && scopedUii && lock.uii !== scopedUii) ||
      (lock.queueItemId && scopedQueueItemId && lock.queueItemId !== scopedQueueItemId) ||
      (lock.callSessionId && scopedCallSessionId && lock.callSessionId !== scopedCallSessionId);
    if (!conflict) {
      if (scopedUii && !lock.uii) lock.uii = scopedUii;
      if (scopedQueueItemId && !lock.queueItemId) lock.queueItemId = scopedQueueItemId;
      if (scopedCallSessionId && !lock.callSessionId) lock.callSessionId = scopedCallSessionId;
      return;
    }
    stopDashboardSession(lock.sessionId, "cx-workspace-call-changed");
    lockRef.current = null;
    bumpRebind();
  }, [bumpRebind, scopedCallSessionId, scopedQueueItemId, scopedUii]);

  React.useEffect(() => {
    if (!scopedReleaseKey || !scopeKey) return;
    releasedScopeRef.current = { scopeKey, releaseKey: scopedReleaseKey };
    const lock = lockRef.current;
    if (lock?.sessionId) {
      stopDashboardSession(lock.sessionId, scopedReleaseReason);
    }
    lockRef.current = null;
    resetCoach("connected", scopedReleaseReason);
  }, [resetCoach, scopeKey, scopedReleaseKey, scopedReleaseReason]);

  React.useEffect(() => {
    if (!agentScopeKey) {
      resetCoach("disabled", "No agent scope");
      return undefined;
    }
    if (!hasCall) {
      // Call ended (or none yet): clean out a held session, then keep an
      // OPTIMISTIC slow poll running — the bus often has the agent's stream
      // before the workspace registers the call, and the server's bus-fallback
      // can hand it to us early.
      const lock = lockRef.current;
      if (lock?.sessionId) {
        stopDashboardSession(lock.sessionId, "cx-workspace-current-call-cleared");
        lockRef.current = null;
      }
      releasedScopeRef.current = null;
      resetCoach("connected", "Waiting for active call");
    }
    if (
      scopedReleaseKey &&
      releasedScopeRef.current?.releaseKey === scopedReleaseKey
    ) {
      resetCoach("connected", scopedReleaseReason);
      return undefined;
    }

    let cancelled = false;
    cancelledRef.current = false;
    let events: AbortController | null = null;
    let activeSessionId = "";
    let retryTimer: number | null = null;
    let attempts = 0;

    const applySession = (next: LiveCoachSession) => {
      dispatch({ type: "session", session: next });
    };

    const connectEvents = (sessionId: string) => {
      if (activeSessionId === sessionId) return;
      if (events) events.abort();
      activeSessionId = sessionId;
      dispatch({
        type: "clearItems",
        stage: {
          label: "streaming",
          detail: "Connected to coach event stream",
          tone: "active",
          at: new Date().toISOString(),
        },
      });
      events = new AbortController();
      const eventController = events;
      // One render per SSE event: a single reducer dispatch folds the whole
      // payload into state (handleEvent is memoized at component scope).
      // streamLiveCoachEventsWithRetry surfaces a transient "Reconnecting..."
      // via onError during backoff and only a fatal error once retries run out.
      void streamLiveCoachEventsWithRetry(`${LIVE_COACH_API_BASE}/sessions/${encodeURIComponent(sessionId)}/events`, {
        signal: eventController.signal,
        onOpen: () => {
          if (!cancelledRef.current) {
            dispatch({ type: "bridge", status: "connected", error: "" });
          }
        },
        onEvent: handleEvent,
        onError: (streamError) => {
          if (cancelledRef.current) return;
          const reconnecting = streamError.message === "Reconnecting...";
          dispatch({
            type: "bridge",
            status: reconnecting ? "connecting" : "error",
            error: streamError.message || "Waiting for coach stream",
            stage: {
              label: reconnecting ? "reconnecting" : "stream error",
              detail: streamError.message || "Waiting for coach stream",
              tone: reconnecting ? "active" : "danger",
              at: new Date().toISOString(),
            },
          });
          if (!reconnecting) {
            // Retries are exhausted — this stream is dead. Drop the lock and
            // re-resolve instead of dead-ending in an error state: the bus
            // may already be serving a replacement session.
            lockRef.current = null;
            window.setTimeout(() => {
              if (!cancelledRef.current) bumpRebind();
            }, 4000);
          }
        },
      }).catch(() => undefined);
    };

    const bindSession = async () => {
      try {
        attempts += 1;
        // Freshest identity at REQUEST time — the effect itself never re-runs
        // on identity drift (that re-run was the mid-call flicker).
        const p = paramsRef.current;
        const params = new URLSearchParams();
        if (p.scopedAgentExtension) params.set("agentExtensionId", p.scopedAgentExtension);
        if (p.scopedAgentEmail) params.set("agentEmail", p.scopedAgentEmail);
        if (p.scopedUii) params.set("uii", p.scopedUii);
        if (p.scopedQueueItemId) params.set("queueItemId", p.scopedQueueItemId);
        if (p.scopedCallSessionId) params.set("callSessionId", p.scopedCallSessionId);
        if (p.scopedCaseId) params.set("caseId", p.scopedCaseId);
        if (p.scopedContactName) params.set("contactName", p.scopedContactName);
        if (p.agentName) params.set("agentName", p.agentName);
        const query = Object.fromEntries(params.entries());
        const data = await api.get<{ session?: LiveCoachSession | null; reason?: string; status?: string }>(
          `${LIVE_COACH_API_BASE}/session-for-call`,
          { query },
        );
        if (cancelled) return;
        if (data.session) {
          // LOCK: remember which call this session belongs to. From here on
          // only a genuine call conflict, a terminal session event, a release,
          // or call end breaks the bind.
          lockRef.current = {
            sessionId: data.session.id,
            uii: cleanParam(data.session.metadata?.uii) || p.scopedUii,
            queueItemId: cleanParam(data.session.metadata?.queueItemId) || p.scopedQueueItemId,
            callSessionId: p.scopedCallSessionId,
          };
          applySession(data.session);
          connectEvents(data.session.id);
        } else {
          dispatch({
            type: "bridge",
            status: "connected",
            error: data.reason || data.status || "Waiting for matching stream",
            stage: {
              label: "waiting stream",
              detail: data.reason || data.status || "Waiting for matching stream",
              tone: "idle",
              at: new Date().toISOString(),
            },
          });
          retryTimer = window.setTimeout(
            () => void bindSession(),
            !hasCall ? 5000 : attempts < 8 ? 1250 : 5000,
          );
        }
      } catch (loadError) {
        if (!cancelled) {
          dispatch({
            type: "bridge",
            status: "error",
            error: readErrorMessage(loadError),
            stage: {
              label: "binding error",
              detail: readErrorMessage(loadError),
              tone: "danger",
              at: new Date().toISOString(),
            },
          });
          retryTimer = window.setTimeout(() => void bindSession(), attempts < 5 ? 1500 : 5000);
        }
      }
    };

    // Locked already (e.g. the effect re-ran for a non-identity reason):
    // reconnect the SAME session's stream instead of re-resolving — the lock
    // is the contract.
    const lock = lockRef.current;
    if (lock?.sessionId && hasCall) {
      connectEvents(lock.sessionId);
      return () => {
        cancelled = true;
        cancelledRef.current = true;
        if (retryTimer) window.clearTimeout(retryTimer);
        if (events) events.abort();
      };
    }

    if (hasCall) {
      dispatch({
        type: "bridge",
        status: "connecting",
        error: "Binding coach to current call",
        stage: {
          label: "binding",
          detail: "Looking for current RingCX stream",
          tone: "active",
          at: new Date().toISOString(),
        },
      });
    }
    void bindSession();

    return () => {
      cancelled = true;
      cancelledRef.current = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      if (events) events.abort();
    };
    // Deps are deliberately MINIMAL: agent identity, call PRESENCE (not its
    // drifting identity), release, and the explicit rebind nonce. Everything
    // else flows through paramsRef so identity drift can't flicker the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentScopeKey, hasCall, scopedReleaseKey, scopedReleaseReason, rebindNonce, handleEvent, resetCoach]);

  // Rolling ribbon: the WHOLE prospect stream concatenated (memory), only the
  // tail shown. Finals replace their provisional segment in place inside
  // conversationItems, so the ribbon never blinks empty between a final
  // landing and the next provisional starting — there is no "drop" state.
  const prospectItems = conversationItems.filter((item) => item.side === "prospect");
  const lastProspectItem = prospectItems.length ? prospectItems[prospectItems.length - 1] : null;
  const streamText = prospectItems.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
  const streamTail = streamText.length > 260 ? `…${streamText.slice(-260).trimStart()}` : streamText;
  const heardAt = lastProspectItem?.at || "";
  const heardIsLive = Boolean(lastProspectItem?.provisional);
  const line = dialog?.say?.trim() || "";
  const rejected = dialog?.status === "rejected";
  const contextKeys = [
    ...(context?.miniJudgement?.selectedKeys || []),
    ...(context?.matches || []).map((match) => match.key || match.label || ""),
  ].filter(Boolean);
  const stageToneClass =
    stage.tone === "good"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : stage.tone === "danger"
        ? "border-red-200 bg-red-50 text-red-700"
        : stage.tone === "warn"
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : stage.tone === "active"
            ? "border-sky-200 bg-sky-50 text-sky-700"
            : "border-border bg-muted text-muted-foreground";
  const statusLabel =
    bridgeStatus === "disabled"
      ? "off"
      : bridgeStatus === "connected"
        ? session?.status || "ready"
        : bridgeStatus === "connecting"
          ? "connecting"
          : "waiting";

  return (
    <>
    <Card className="overflow-hidden border-sky-200/80 bg-sky-50/35 shadow-none">
      <CardHeader className="border-b border-sky-100 bg-white/70 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-600 text-white">
              <Sparkles className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="truncate text-sm">Live coach</CardTitle>
              <div className="truncate text-[10px] text-muted-foreground">
                {session?.metadata?.uii ? `UII ${session.metadata.uii}` : error || "Local coach bridge"}
              </div>
            </div>
          </div>
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
              bridgeStatus === "connected"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : bridgeStatus === "disabled"
                  ? "border-border bg-muted text-muted-foreground"
                  : "border-amber-200 bg-amber-50 text-amber-700",
            )}
          >
            {statusLabel}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
              stageToneClass,
            )}
          >
            {stage.label}
          </span>
          {stage.detail ? (
            <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
              {stage.detail}
            </span>
          ) : null}
          {stage.at ? (
            <span className="text-[10px] text-muted-foreground">{formatCoachTime(stage.at)}</span>
          ) : null}
        </div>
        <div className="rounded-md border border-sky-100 bg-white p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Prospect said
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1.5 px-2 text-[10px] text-sky-700"
                onClick={() => setContextOpen(true)}
              >
                <MessagesSquare className="h-3 w-3" />
                Transcript
                {conversationItems.length ? (
                  <span className="rounded-full bg-sky-100 px-1 text-[9px] text-sky-700">
                    {conversationItems.length}
                  </span>
                ) : null}
              </Button>
              {heardIsLive ? (
                <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                  live
                </span>
              ) : lastProspectItem ? (
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                  final
                </span>
              ) : null}
              {heardAt ? (
                <div className="text-[10px] text-muted-foreground">{formatCoachTime(heardAt)}</div>
              ) : null}
            </div>
          </div>
          <div
            className={cn(
              "min-h-[58px] whitespace-pre-wrap text-sm font-medium leading-snug text-foreground",
              heardIsLive && "text-muted-foreground",
              !streamText && "flex items-center text-muted-foreground",
            )}
          >
            {streamTail || "Waiting for prospect speech..."}
          </div>
        </div>
        <div className="rounded-md border border-slate-100 bg-white p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Context
            </div>
            {context?.miniJudgement?.elapsedMs ? (
              <div className="text-[10px] text-muted-foreground">{context.miniJudgement.elapsedMs}ms</div>
            ) : null}
          </div>
          <div className="text-xs leading-snug text-muted-foreground">
            {context?.miniJudgement?.transcriptMeaning
              || context?.actionReason
              || (contextKeys.length ? `Keys: ${Array.from(new Set(contextKeys)).slice(0, 4).join(", ")}` : "Waiting for mini context...")}
          </div>
        </div>
        <div className="rounded-md border border-sky-200 bg-white p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-700">
              <MessageSquareQuote className="h-3 w-3" />
              Say this next
            </div>
            {dialog?.label ? (
              <div className="max-w-[130px] truncate rounded-full border border-sky-100 bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700">
                {dialog.label}
              </div>
            ) : null}
          </div>
          <div
            className={cn(
              "min-h-[74px] whitespace-pre-wrap text-base font-semibold leading-snug text-slate-950",
              !line && "flex items-center text-sm font-medium text-muted-foreground",
            )}
          >
            {line || (rejected ? "Call rejected for voicemail match." : "Coach line will appear here.")}
          </div>
        </div>
      </CardContent>
    </Card>
    <Dialog open={contextOpen} onOpenChange={setContextOpen}>
      <DialogContent className="max-h-[82vh] max-w-2xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 pb-3 pt-5">
          <DialogTitle className="flex items-center gap-2">
            <MessagesSquare className="h-4 w-4 text-sky-700" />
            Transcript context
          </DialogTitle>
          <DialogDescription>
            Actual call transcript collected for the current coach session.
          </DialogDescription>
        </DialogHeader>
        <div ref={transcriptScrollRef} className="max-h-[62vh] space-y-3 overflow-y-auto bg-slate-50 px-4 py-4">
          {conversationItems.length ? (
            conversationItems.map((item) => {
              const rightSide = item.side === "agent";
              return (
                <div
                  key={item.id}
                  className={cn(
                    "flex w-full",
                    rightSide ? "justify-end" : "justify-start",
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[82%] rounded-lg border px-3 py-2 shadow-sm",
                      item.side === "prospect" && "border-sky-100 bg-white text-slate-950",
                      item.side === "agent" && "border-slate-200 bg-slate-900 text-white",
                      item.side === "system" && "border-amber-200 bg-amber-50 text-amber-950",
                      item.provisional && "border-dashed opacity-75",
                      item.lowConfidence && "opacity-60",
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between gap-3 text-[10px] font-semibold uppercase tracking-[0.12em] opacity-70">
                      <span>
                        {item.provisional ? `${item.label} live` : item.label}
                        {item.lowConfidence ? " · low confidence" : ""}
                      </span>
                      <span>{formatCoachTime(item.at)}</span>
                    </div>
                    <div className="whitespace-pre-wrap text-sm leading-snug">{item.text}</div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="rounded-md border border-dashed border-slate-200 bg-white p-6 text-center text-sm text-muted-foreground">
              Transcript context will fill in as transcript arrives.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
