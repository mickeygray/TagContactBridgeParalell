import * as React from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ClipboardList, MessageSquareQuote, MessagesSquare, Send, Sparkles, Target, Wand2, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api/client";
import {
  streamLiveCoachEventsWithRetry,
  type LiveCoachAsk,
  type LiveCoachContext,
  type LiveCoachDialog,
  type LiveCoachEvent,
  type LiveCoachFactLedger,
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
  // Agent-initiated asks: the coach CHAT thread. coach.answer events upsert by
  // id (thinking → streaming → ready, in place); snapshots reseed finished
  // asks. One ask in flight per session, enforced server-side.
  asks: LiveCoachAsk[];
  // Durable whole-call memory from the mini scribe: facts never roll off; the
  // summary is the cumulative story so far.
  factLedger: LiveCoachFactLedger;
  callSummary: string;
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
  asks: [],
  factLedger: {},
  callSummary: "",
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

  // Snapshot seeding for the scribe's durable memory: facts ledger + summary
  // ride the session whole, so reconnects/late joins land fully informed.
  const factLedger = next.factLedger && Object.keys(next.factLedger).length
    ? next.factLedger
    : state.factLedger;
  const callSummary = String(next.callSummary || "").trim() || state.callSummary;
  // Chat reseeding: an empty thread + finished asks in memory means a
  // reconnect/late join — repaint the coach chat. Live events keep upserting.
  const asks = !state.asks.length && Array.isArray(next.memory?.asks) && next.memory.asks.length
    ? next.memory.asks.filter((row) => row?.id)
    : state.asks;

  return {
    ...state,
    session: next,
    factLedger,
    callSummary,
    asks,
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

  // Agent-initiated ask streaming back (coach.answer events): upsert into the
  // chat thread by id — thinking → streaming deltas → ready, in place.
  if (payload.ask?.id) {
    const ask = payload.ask;
    const existingIndex = next.asks.findIndex((row) => row.id === ask.id);
    patch({
      asks: existingIndex >= 0
        ? next.asks.map((row, index) => (index === existingIndex ? { ...row, ...ask } : row))
        : [...next.asks, ask].slice(-30),
    });
  }
  // Scribe updates: facts ledger + cumulative call summary ride the digest.
  if (payload.type === "context.digest") {
    patch({
      ...(payload.factLedger && Object.keys(payload.factLedger).length ? { factLedger: payload.factLedger } : {}),
      ...(String(payload.callSummary || "").trim() ? { callSummary: String(payload.callSummary || "").trim() } : {}),
    });
  }

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
        asks: [],
        factLedger: {},
        callSummary: "",
        ...(action.stage ? { stage: action.stage } : {}),
      };
    case "event":
      return reduceEvent(state, action.payload);
    default:
      return state;
  }
}

const LIVE_COACH_API_BASE = "/api/ai/live-coach";

// The coach chat docks into the workspace when this slot exists. CXWorkspace
// renders it under Appointments in the reclaimed right rail.
// Without a slot the chat falls back to the floating dock's bottom row, so
// the panel keeps working in any host.
export const COACH_CHAT_SLOT_ID = "cx-coach-chat-slot";

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

function compactCoachText(value: string | null | undefined, maxLength = 420) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (!clean || clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trim()}...`;
}

// Navigator contract: established-phase coach output is labeled lines —
// "Read:" (what's happening), "Steer:" (direction), "Try:" (optional exact
// words). Opening-phase output stays a plain unlabeled line. Parse both.
function parseNavigatorSay(say: string | null | undefined) {
  const text = String(say || "").trim();
  const read = text.match(/(?:^|\n)\s*Read:\s*([^\n]+)/i)?.[1]?.trim() || "";
  const steer = text.match(/(?:^|\n)\s*Steer:\s*([\s\S]*?)(?=\n\s*Try:|$)/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
  const tryLine = text.match(/(?:^|\n)\s*Try:\s*"?([\s\S]*?)"?\s*$/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
  const labeled = Boolean(read || steer || tryLine);
  return { read, steer, tryLine, labeled, text };
}

function firstStrategyBlock(value: string | null | undefined) {
  const clean = String(value || "").trim();
  if (!clean) return "";
  const withoutHeaders = clean
    .split(/\n+/)
    .filter((line) => !/^#{1,3}\s+/.test(line.trim()))
    .join(" ");
  return compactCoachText(withoutHeaders || clean, 360);
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
  const { session, context, dialog, stage, conversationItems, asks, bridgeStatus, error } = coach;
  const [contextOpen, setContextOpen] = React.useState(false);
  const [focusedTranscriptId, setFocusedTranscriptId] = React.useState("");
  // ── Coach chat ("scramble the AI"): every zone can seed the chat input — a
  // transcript line ("they said this, how do I respond"), a guidepost ("I'm
  // stuck on this objective"), an objection ("more help with this"), a
  // pretyped quick question, or free text. The seed carries kind + context;
  // the agent can add custom words. Answers thread into a chat the agent can
  // follow up on — the bus carries the recent Q&A as context.
  const [askText, setAskText] = React.useState("");
  const [askSeed, setAskSeed] = React.useState<{ kind: string; label: string; lineText?: string } | null>(null);
  const [askError, setAskError] = React.useState("");
  const askInputRef = React.useRef<HTMLInputElement | null>(null);
  const chatScrollRef = React.useRef<HTMLDivElement | null>(null);
  // Workspace chat slot (under Appointments). Looked up after mount because
  // the slot and this panel can render a beat apart while the workspace
  // settles.
  const [chatSlot, setChatSlot] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    const find = () => document.getElementById(COACH_CHAT_SLOT_ID);
    const found = find();
    if (found) {
      setChatSlot(found);
      return undefined;
    }
    const retry = window.setTimeout(() => setChatSlot(find()), 600);
    return () => window.clearTimeout(retry);
  }, []);
  const latestAsk = asks.length ? asks[asks.length - 1] : null;
  const askPending = Boolean(latestAsk && (latestAsk.status === "thinking" || latestAsk.status === "streaming"));
  const seedAsk = React.useCallback((seed: { kind: string; label: string; lineText?: string }) => {
    setAskSeed(seed);
    setAskError("");
    window.setTimeout(() => askInputRef.current?.focus(), 0);
  }, []);
  // Shared POST core: the chat input and the one-tap quick questions both land
  // here. The answer streams back over SSE (coach.answer) into the thread.
  const postAsk = React.useCallback(async (kind: string, question: string, lineText: string) => {
    const sessionId = String(session?.id || "");
    if (!sessionId || askPending || (!question && !lineText)) return;
    setAskError("");
    try {
      const result = await api.post<{ ok?: boolean; error?: string }>(
        `${LIVE_COACH_API_BASE}/sessions/${encodeURIComponent(sessionId)}/ask`,
        { kind, question, lineText },
      );
      if (result && result.ok === false) {
        setAskError(result.error || "Ask failed");
        return;
      }
      setAskText("");
      setAskSeed(null);
    } catch (err) {
      setAskError(err instanceof Error ? err.message : "Ask failed");
    }
  }, [session?.id, askPending]);
  const submitAsk = React.useCallback(
    () => postAsk(askSeed?.kind || "question", askText.trim(), askSeed?.lineText || ""),
    [postAsk, askSeed, askText],
  );
  // Pretyped quick questions — one tap sends. Line-anchored ones ride the
  // pinned/latest prospect line so "that" means what was just said.
  const quickAsk = React.useCallback((kind: string, question: string, useLine: boolean) => {
    const anchor = useLine
      ? (conversationItems.find((item) => item.id === focusedTranscriptId)?.text
        || [...conversationItems].reverse().find((item) => item.side === "prospect")?.text
        || "")
      : "";
    void postAsk(kind, question, anchor);
  }, [postAsk, conversationItems, focusedTranscriptId]);
  // Chat follows its tail while answers stream in.
  React.useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [asks]);
  // ALWAYS-ON DOCK: the coach is its own floating window, fixed to the
  // viewport so it's visible regardless of scroll or where the interview
  // sits. The agent can MINIMIZE it to a pill anytime. It auto-restores ONCE
  // when the first real coach line lands (the quiet-start makes that ~turn 3)
  // so it surfaces when it matters without jumping every turn afterward.
  // NEVER unmounts — minimize is a height change only, so the SSE stream and
  // bind-lock survive.
  const [minimized, setMinimized] = React.useState(false);
  const autoRestoredRef = React.useRef(false);
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
  const inlineTranscriptScrollRef = React.useRef<HTMLDivElement | null>(null);
  // Mid-call the interesting end of the transcript is the bottom: anchor there
  // when the modal opens and keep following as new lines arrive while open.
  React.useEffect(() => {
    if (!contextOpen) return;
    const el = transcriptScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [contextOpen, conversationItems.length]);
  React.useEffect(() => {
    if (focusedTranscriptId) return;
    const el = inlineTranscriptScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationItems.length, focusedTranscriptId]);
  const releasedScopeRef = React.useRef<{ scopeKey: string; releaseKey: string } | null>(null);
  const processedReleaseKeyRef = React.useRef<string>("");
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
    if (processedReleaseKeyRef.current === scopedReleaseKey) return;
    processedReleaseKeyRef.current = scopedReleaseKey;
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
      releasedScopeRef.current?.releaseKey === scopedReleaseKey &&
      releasedScopeRef.current?.scopeKey === scopeKey
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

  // Auto-restore ONCE when the first real coach line lands; warmup/WAIT holds
  // (empty say) don't. After that first restore the agent's minimize choice is
  // respected (no jumping every turn).
  React.useEffect(() => {
    const popworthy =
      ((dialog?.status === "ready" || dialog?.status === "streaming") && Boolean(dialog?.say?.trim())) ||
      dialog?.status === "rejected";
    if (popworthy && !autoRestoredRef.current) {
      autoRestoredRef.current = true;
      setMinimized(false);
    }
  }, [dialog?.status, dialog?.say]);
  // New call (rebind), release (VM drop / disposition), or call cleared:
  // re-arm the one-shot auto-restore for the next call.
  React.useEffect(() => {
    autoRestoredRef.current = false;
    setFocusedTranscriptId("");
    setAskText("");
    setAskSeed(null);
    setAskError("");
  }, [rebindNonce, scopedReleaseKey, callScopeKey]);

  // Rolling ribbon: the WHOLE prospect stream concatenated (memory), only the
  // tail shown. Finals replace their provisional segment in place inside
  // conversationItems, so the ribbon never blinks empty between a final
  // landing and the next provisional starting — there is no "drop" state.
  const prospectItems = conversationItems.filter((item) => item.side === "prospect");
  const lastProspectItem = prospectItems.length ? prospectItems[prospectItems.length - 1] : null;
  const focusedTranscriptItem =
    conversationItems.find((item) => item.id === focusedTranscriptId) ||
    lastProspectItem ||
    null;
  const visibleConversationItems = conversationItems.slice(-16);
  const streamText = prospectItems.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
  const streamTail = streamText.length > 260 ? `…${streamText.slice(-260).trimStart()}` : streamText;
  const heardAt = lastProspectItem?.at || "";
  const heardIsLive = Boolean(lastProspectItem?.provisional);
  const line = dialog?.say?.trim() || "";
  const rejected = dialog?.status === "rejected";
  // Navigator contract: Read → "What changed", Steer → "Stay on track",
  // Try → the sayable line. Unlabeled output (opening phase) stays a line.
  const nav = parseNavigatorSay(line);
  const contextKeys = [
    ...(context?.miniJudgement?.selectedKeys || []),
    ...(context?.matches || []).map((match) => match.key || match.label || ""),
  ].filter(Boolean);
  const uniqueContextKeys = Array.from(new Set(contextKeys)).slice(0, 6);
  const formStrategy = session?.metadata?.callStrategy || "";
  const strategyPreview = firstStrategyBlock(formStrategy);
  const factEntries = Object.entries(coach.factLedger || {})
    .map(([key, row]) => ({ key, value: String(row?.value || "").trim() }))
    .filter((row) => row.value)
    .slice(-10);
  const guidepostPrimary =
    focusedTranscriptId && focusedTranscriptItem
      ? `Focused line: ${focusedTranscriptItem.text}`
      : nav.read
        || context?.miniJudgement?.transcriptMeaning
        || context?.actionReason
        || strategyPreview
        || "Use the interview form to sharpen the coach. Live guidance will update as transcript and context arrive.";
  const guidepostStayOnTrack =
    nav.steer
    || dialog?.guidance
    || context?.actionReason
    || (strategyPreview ? "Follow the form-based strategy and use new transcript lines to adjust the next move." : "")
    || "Keep the call moving through discovery, consequence, offer, price, and close.";
  const guidepostNextMove =
    nav.tryLine
      ? compactCoachText(nav.tryLine, 360)
      : nav.labeled && nav.steer
        ? compactCoachText(nav.steer, 360)
        : line
          ? compactCoachText(line, 360)
          : rejected
            ? "Call rejected for voicemail match."
            : "Waiting for the next coachable moment.";
  // The Reactions card shows ONLY sayable words: the Try line, or the whole
  // output when it's an unlabeled opening-phase line.
  const sayableLine = nav.tryLine || (nav.labeled ? "" : line);
  const focusedLineHelp =
    focusedTranscriptId && focusedTranscriptItem
      ? "This transcript line is pinned for extra consideration."
      : "Click a transcript line to pin it here for more specific feedback.";
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

  // ── Ask-the-coach chat panel ──────────────────────────────────────────────
  // ONE self-contained block: thread + quick questions + seeded input. Portals
  // into the workspace slot under Appointments when it exists (and stays
  // available there even while the dock is minimized); otherwise renders as
  // the dock's bottom row.
  const coachChatPanel = (
    <div className="rounded-md border border-violet-200 bg-white p-2 shadow-sm">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-700">
        <Wand2 className="h-3 w-3" />
        Ask the coach
        {askPending ? (
          <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
        ) : null}
      </div>
      {asks.length ? (
        <div ref={chatScrollRef} className="mb-2 max-h-[300px] space-y-1.5 overflow-y-auto pr-1">
          {asks.map((ask) => (
            <div key={ask.id}>
              <div className="ml-6 rounded-md rounded-br-sm border border-violet-200 bg-violet-50/60 px-2 py-1 text-[11px] leading-snug text-violet-900">
                {compactCoachText(
                  ask.question || (ask.lineText ? `Re: "${ask.lineText}"` : ask.kind || "ask"),
                  160,
                )}
              </div>
              <div className="mr-6 mt-1 whitespace-pre-wrap rounded-md rounded-tl-sm bg-violet-100/70 px-2 py-1 text-sm leading-snug text-slate-950">
                {ask.status === "error"
                  ? `Ask failed: ${ask.error || "coach unavailable"}`
                  : ask.answer
                    || (ask.status === "thinking" || ask.status === "streaming" ? "Thinking..." : "No answer.")}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {[
          { label: "How do I respond?", kind: "line", question: "How do I respond to that?", useLine: true },
          { label: "Objection lines", kind: "objection", question: "Give me lines to get past this.", useLine: true },
          { label: "What am I missing?", kind: "question", question: "What discovery am I still missing on this call?", useLine: false },
          { label: "Move it forward", kind: "question", question: "How do I move this call to the next step right now?", useLine: false },
          { label: "Close it", kind: "question", question: "Give me the close for this call right now - the ask, and the exact words.", useLine: false },
          { label: "Where are we?", kind: "question", question: "Summarize where we are on this call and against the strategy.", useLine: false },
        ].map((quick) => (
          <button
            key={quick.label}
            type="button"
            disabled={!session?.id || askPending}
            onClick={() => quickAsk(quick.kind, quick.question, quick.useLine)}
            className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-800 transition-colors hover:bg-violet-100 disabled:opacity-40"
          >
            {quick.label}
          </button>
        ))}
      </div>
      {askSeed ? (
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className="flex min-w-0 items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-800">
            <span className="truncate">{askSeed.label}</span>
            <button
              type="button"
              onClick={() => setAskSeed(null)}
              className="shrink-0 text-violet-400 hover:text-violet-700"
              aria-label="Clear ask context"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <input
          ref={askInputRef}
          type="text"
          value={askText}
          onChange={(event) => setAskText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submitAsk();
            }
          }}
          placeholder={
            askSeed
              ? "Add your own words (optional), then send..."
              : "Ask the coach anything mid-call..."
          }
          disabled={!session?.id}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm outline-none placeholder:text-muted-foreground focus:border-violet-400 disabled:opacity-50"
        />
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1.5 bg-violet-600 px-3 text-white hover:bg-violet-700"
          disabled={!session?.id || askPending || (!askText.trim() && !askSeed?.lineText)}
          onClick={() => void submitAsk()}
        >
          <Send className="h-3.5 w-3.5" />
          {askPending ? "Coaching..." : "Ask"}
        </Button>
      </div>
      {askError ? (
        <div className="mt-1 text-[11px] text-red-600">{askError}</div>
      ) : null}
    </div>
  );
  const chatPortal = chatSlot ? createPortal(coachChatPanel, chatSlot) : null;

  // ── Minimized pill ────────────────────────────────────────────────────────
  // Always-on dock, tucked away: a small fixed pill in the corner showing the
  // live stage. Click to restore. Stream stays fully alive behind it — and the
  // workspace chat (portaled under Appointments) stays usable.
  if (minimized) {
    return (
      <>
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-sky-300 bg-white px-3 py-2 shadow-lg transition-colors hover:bg-sky-50"
        title="Live coach — click to open"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-600 text-white">
          <Sparkles className="h-3 w-3" />
        </span>
        <span className="text-xs font-medium text-foreground">Coach</span>
        <span
          className={cn(
            "rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em]",
            stageToneClass,
          )}
        >
          {heardIsLive ? "live" : stage.label}
        </span>
        {line ? <span className="h-2 w-2 rounded-full bg-emerald-500" /> : null}
      </button>
      {chatPortal}
      </>
    );
  }

  return (
    <>
    {/* Always-on floating dock — bottom-CENTER, visible regardless of scroll
        or page section. z-50 keeps it above sticky headers/cards. */}
    <div className="fixed bottom-4 left-1/2 z-50 max-h-[86vh] w-[min(1180px,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto">
    <Card className="overflow-hidden border-sky-200/80 bg-sky-50/95 shadow-xl backdrop-blur">
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
          <div className="flex shrink-0 items-center gap-1.5">
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
            <button
              type="button"
              onClick={() => setMinimized(true)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Minimize coach"
              aria-label="Minimize coach"
            >
              <span className="text-sm leading-none">—</span>
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 px-3 py-3 lg:grid-cols-[1.05fr_1.15fr_0.95fr]">
        <section className="rounded-md border border-sky-100 bg-white p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <MessagesSquare className="h-3 w-3" />
              Transcript
            </div>
            <div className="flex items-center gap-1.5">
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
                <span className="text-[10px] text-muted-foreground">{formatCoachTime(heardAt)}</span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px] text-sky-700"
                onClick={() => setContextOpen(true)}
              >
                Full
              </Button>
            </div>
          </div>
          {streamTail ? (
            <div className="mb-2 truncate rounded-md bg-slate-50 px-2 py-1 text-[11px] text-muted-foreground">
              Latest: {streamTail}
            </div>
          ) : null}
          <div ref={inlineTranscriptScrollRef} className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
            {visibleConversationItems.length ? (
              visibleConversationItems.map((item) => {
                const selected = focusedTranscriptId === item.id;
                return (
                  <div key={item.id}>
                    <button
                      type="button"
                      onClick={() => setFocusedTranscriptId((current) => (current === item.id ? "" : item.id))}
                      className={cn(
                        "w-full rounded-md border px-2.5 py-2 text-left text-sm shadow-sm transition",
                        item.side === "prospect" && "border-sky-100 bg-white text-slate-950 hover:border-sky-300",
                        item.side === "agent" && "border-slate-200 bg-slate-900 text-white hover:border-slate-500",
                        item.side === "system" && "border-amber-200 bg-amber-50 text-amber-950 hover:border-amber-300",
                        item.provisional && "border-dashed opacity-75",
                        selected && "ring-2 ring-sky-400",
                      )}
                    >
                      <span className="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] opacity-70">
                        <span>
                          {item.provisional ? `${item.label} live` : item.label}
                          {item.lowConfidence ? " / low confidence" : ""}
                        </span>
                        <span>{formatCoachTime(item.at)}</span>
                      </span>
                      <span className="block whitespace-pre-wrap leading-snug">{item.text}</span>
                    </button>
                    {selected ? (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <Button
                          type="button"
                          variant="subtle"
                          size="sm"
                          className="h-6 gap-1 px-2 text-[10px] text-sky-700"
                          onClick={() => seedAsk({
                            kind: "line",
                            label: `They said: "${compactCoachText(item.text, 70)}"`,
                            lineText: item.text,
                          })}
                        >
                          <Wand2 className="h-3 w-3" />
                          How do I respond?
                        </Button>
                        <Button
                          type="button"
                          variant="subtle"
                          size="sm"
                          className="h-6 gap-1 px-2 text-[10px] text-slate-700"
                          onClick={() => seedAsk({
                            kind: "objection",
                            label: `Objection help: "${compactCoachText(item.text, 60)}"`,
                            lineText: item.text,
                          })}
                        >
                          Objection help
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <div className="flex min-h-[180px] items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50 px-4 text-center text-sm text-muted-foreground">
                Waiting for transcript. Click any line later to pin it for extra guidance.
              </div>
            )}
          </div>
        </section>

        <section className="rounded-md border border-sky-200 bg-white p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-700">
              <Target className="h-3 w-3" />
              Guideposts
            </div>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                stageToneClass,
              )}
            >
              {stage.label}
            </span>
          </div>
          <div className="space-y-2">
            <div className="rounded-md border border-slate-100 bg-slate-50 p-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  What changed
                </span>
                <button
                  type="button"
                  className="text-[10px] font-medium text-sky-700 hover:underline"
                  onClick={() => seedAsk({ kind: "expand", label: "Tell me more about what's happening", lineText: guidepostPrimary })}
                  title="Ask the coach to expand on this"
                >
                  tell me more
                </button>
              </div>
              <div className="whitespace-pre-wrap text-sm font-medium leading-snug text-slate-950">
                {compactCoachText(guidepostPrimary, 520)}
              </div>
            </div>
            <div className="rounded-md border border-slate-100 bg-white p-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Stay on track
                </span>
                <button
                  type="button"
                  className="text-[10px] font-medium text-sky-700 hover:underline"
                  onClick={() => seedAsk({ kind: "expand", label: "I'm stuck on this objective", lineText: guidepostStayOnTrack })}
                  title="Stuck here? Ask the coach for a way through"
                >
                  I'm stuck here
                </button>
              </div>
              <div className="text-sm leading-snug text-slate-700">
                {compactCoachText(guidepostStayOnTrack, 420)}
              </div>
            </div>
            <div className="rounded-md border border-sky-100 bg-sky-50 p-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-sky-700">
                Next move
              </div>
              <div className="whitespace-pre-wrap text-base font-semibold leading-snug text-slate-950">
                {guidepostNextMove}
              </div>
            </div>
            {factEntries.length ? (
              <div className="rounded-md border border-emerald-100 bg-emerald-50/60 p-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                  Key facts so far
                </div>
                <div className="flex flex-wrap gap-1">
                  {factEntries.map((fact) => (
                    <span
                      key={fact.key}
                      className="rounded-full border border-emerald-200 bg-white px-2 py-0.5 text-[10px] text-emerald-900"
                      title={`${fact.key}: ${fact.value}`}
                    >
                      <span className="font-semibold">{fact.key.replace(/_/g, " ")}:</span> {compactCoachText(fact.value, 48)}
                    </span>
                  ))}
                </div>
                {coach.callSummary ? (
                  <div className="mt-1.5 text-[11px] leading-snug text-emerald-900/80">
                    {compactCoachText(coach.callSummary, 300)}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              {focusedLineHelp}
            </span>
            {formStrategy ? (
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                form strategy attached
              </span>
            ) : (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                form improves guidance
              </span>
            )}
            {context?.miniJudgement?.elapsedMs ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                mini {context.miniJudgement.elapsedMs}ms
              </span>
            ) : null}
          </div>
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-700">
              <AlertTriangle className="h-3 w-3 text-amber-600" />
              Reactions
            </div>
            {dialog?.label ? (
              <div className="max-w-[150px] truncate rounded-full border border-sky-100 bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700">
                {dialog.label}
              </div>
            ) : null}
          </div>
          <div className="space-y-2">
            <div className="rounded-md border border-slate-100 bg-slate-50 p-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  <MessageSquareQuote className="h-3 w-3" />
                  Try saying
                </span>
                <button
                  type="button"
                  className="text-[10px] font-medium text-sky-700 hover:underline"
                  onClick={() => seedAsk({
                    kind: "objection",
                    label: "More help with this objection",
                    lineText: focusedTranscriptItem?.text || lastProspectItem?.text || "",
                  })}
                  title="Get the play plus ready lines for the current objection"
                >
                  more help
                </button>
              </div>
              <div
                className={cn(
                  "min-h-[96px] whitespace-pre-wrap text-sm font-semibold leading-snug text-slate-950",
                  !sayableLine && "flex items-center font-medium text-muted-foreground",
                )}
              >
                {sayableLine
                  || (nav.labeled
                    ? "No script needed — follow the guideposts."
                    : rejected
                      ? "Call rejected for voicemail match."
                      : "Waiting for a useful reaction.")}
              </div>
            </div>
            <div className="rounded-md border border-slate-100 bg-white p-2">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                <ClipboardList className="h-3 w-3" />
                Watch points
              </div>
              <div className="text-xs leading-snug text-slate-700">
                {uniqueContextKeys.length
                  ? uniqueContextKeys.join(", ")
                  : "Price pressure, authority, urgency, confusion, spouse approval, and attempts to drift away from discovery."}
              </div>
            </div>
            {focusedTranscriptItem ? (
              <div className="rounded-md border border-sky-100 bg-sky-50 p-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-sky-700">
                    Pinned moment
                  </span>
                  <button
                    type="button"
                    className="text-[10px] font-medium text-sky-700 hover:underline"
                    onClick={() => seedAsk({
                      kind: "line",
                      label: `They said: "${compactCoachText(focusedTranscriptItem.text, 70)}"`,
                      lineText: focusedTranscriptItem.text,
                    })}
                  >
                    how do I respond?
                  </button>
                </div>
                <div className="text-xs leading-snug text-slate-700">
                  {compactCoachText(focusedTranscriptItem.text, 260)}
                </div>
              </div>
            ) : null}
          </div>
        </section>

        {/* Chat fallback: no workspace slot (other hosts) → the full chat
            panel renders as the dock's bottom row. With a slot, the chat
            lives under Appointments via the portal instead. */}
        {chatSlot ? null : <div className="lg:col-span-3">{coachChatPanel}</div>}
      </CardContent>
    </Card>
    </div>
    {chatPortal}
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
