import * as React from "react";
import { MessageSquareQuote, MessagesSquare, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { cn } from "@/lib/utils/cn";

type LiveCoachTranscript = {
  id?: string | null;
  itemId?: string | null;
  at?: string | null;
  role?: string | null;
  text?: string | null;
  source?: string | null;
  model?: string | null;
  wordCount?: number | null;
  provisional?: boolean | null;
};

type LiveCoachDialog = {
  id?: string | null;
  at?: string | null;
  status?: string | null;
  label?: string | null;
  say?: string | null;
  guidance?: string | null;
};

type LiveCoachSession = {
  id: string;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastEventAt?: string | null;
  metadata?: {
    agentName?: string | null;
    agentEmail?: string | null;
    uii?: string | null;
  } | null;
  latest?: {
    provisionalTranscript?: LiveCoachTranscript | null;
    transcript?: LiveCoachTranscript | null;
    dialog?: LiveCoachDialog | null;
  } | null;
};

type LiveCoachEvent = {
  type?: string;
  at?: string;
  session?: LiveCoachSession;
  transcript?: LiveCoachTranscript;
  provisionalTranscript?: LiveCoachTranscript;
  dialog?: LiveCoachDialog;
};

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
};

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

function lastSentence(value: string) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const matches = clean.match(/[^.!?]+[.!?]*/g)?.map((part) => part.trim()).filter(Boolean) || [];
  return matches[matches.length - 1] || clean;
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
  fetch(`${LIVE_COACH_API_BASE}/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
    keepalive: true,
  }).catch(() => {
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
  const [session, setSession] = React.useState<LiveCoachSession | null>(null);
  const [provisionalTranscript, setProvisionalTranscript] = React.useState<LiveCoachTranscript | null>(null);
  const [prospectTranscript, setProspectTranscript] = React.useState<LiveCoachTranscript | null>(null);
  const [dialog, setDialog] = React.useState<LiveCoachDialog | null>(null);
  const [contextOpen, setContextOpen] = React.useState(false);
  const [conversationItems, setConversationItems] = React.useState<ConversationItem[]>([]);
  const [bridgeStatus, setBridgeStatus] = React.useState<"disabled" | "connecting" | "connected" | "error">("connecting");
  const [error, setError] = React.useState("");
  const previousBoundRef = React.useRef<{ scopeKey: string; sessionId: string } | null>(null);
  const releasedScopeRef = React.useRef<{ scopeKey: string; releaseKey: string } | null>(null);

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

  const resetCoach = React.useCallback((nextStatus: "disabled" | "connecting" | "connected" | "error", message = "") => {
    setSession(null);
    setProvisionalTranscript(null);
    setProspectTranscript(null);
    setDialog(null);
    setConversationItems([]);
    setBridgeStatus(nextStatus);
    setError(message);
  }, []);

  React.useEffect(() => {
    const previous = previousBoundRef.current;
    if (!previous || previous.scopeKey === scopeKey) return;
    previousBoundRef.current = null;
    stopDashboardSession(previous.sessionId, callScopeKey ? "cx-workspace-current-call-changed" : "cx-workspace-current-call-cleared");
  }, [callScopeKey, scopeKey]);

  React.useEffect(() => {
    if (!scopedReleaseKey || !scopeKey) return;
    releasedScopeRef.current = { scopeKey, releaseKey: scopedReleaseKey };
    const previous = previousBoundRef.current;
    if (previous?.sessionId) {
      stopDashboardSession(previous.sessionId, scopedReleaseReason);
    }
    previousBoundRef.current = null;
    resetCoach("connected", scopedReleaseReason);
  }, [resetCoach, scopeKey, scopedReleaseKey, scopedReleaseReason]);

  React.useEffect(() => {
    if (!agentScopeKey) {
      resetCoach("disabled", "No agent scope");
      return undefined;
    }
    if (!callScopeKey) {
      resetCoach("connected", "Waiting for active call");
      return undefined;
    }
    if (
      scopedReleaseKey &&
      releasedScopeRef.current?.scopeKey === scopeKey &&
      releasedScopeRef.current.releaseKey === scopedReleaseKey
    ) {
      resetCoach("connected", scopedReleaseReason);
      return undefined;
    }

    let cancelled = false;
    let events: EventSource | null = null;
    let activeSessionId = "";
    let retryTimer: number | null = null;
    let attempts = 0;

    const applySession = (next: LiveCoachSession) => {
      setSession(next);
      const latestProvisional = next.latest?.provisionalTranscript || null;
      if (latestProvisional) {
        setConversationItems((items) => mergeConversationItem(items, transcriptToConversationItem({
          ...latestProvisional,
          provisional: true,
        })));
      }
      setProvisionalTranscript(latestProvisional?.role === "prospect" ? latestProvisional : null);
      const latestTranscript = next.latest?.transcript || null;
      if (latestTranscript) {
        setConversationItems((items) => mergeConversationItem(items, transcriptToConversationItem(latestTranscript)));
      }
      if (latestTranscript?.role === "prospect") {
        setProspectTranscript(latestTranscript);
        setProvisionalTranscript(null);
      }
      if (next.latest?.dialog) {
        setDialog(next.latest.dialog);
      }
    };

    const connectEvents = (sessionId: string) => {
      if (activeSessionId === sessionId) return;
      if (events) events.close();
      activeSessionId = sessionId;
      previousBoundRef.current = { scopeKey, sessionId };
      setConversationItems([]);
      setProvisionalTranscript(null);
      setProspectTranscript(null);
      setDialog(null);
      events = new EventSource(`${LIVE_COACH_API_BASE}/sessions/${encodeURIComponent(sessionId)}/events`);
      events.onopen = () => {
        if (!cancelled) {
          setBridgeStatus("connected");
          setError("");
        }
      };
      events.onerror = () => {
        if (!cancelled) {
          setBridgeStatus("error");
          setError("Waiting for coach stream");
        }
      };
      const handleEvent = (event: MessageEvent<string>) => {
        if (cancelled) return;
        try {
          const payload = JSON.parse(event.data) as LiveCoachEvent;
          if (payload.session) applySession(payload.session);
          if (payload.provisionalTranscript) {
            setConversationItems((items) => mergeConversationItem(items, transcriptToConversationItem({
              ...payload.provisionalTranscript,
              provisional: true,
            })));
          }
          if (payload.provisionalTranscript?.role === "prospect") setProvisionalTranscript(payload.provisionalTranscript);
          if (payload.transcript?.role === "prospect") {
            setConversationItems((items) => mergeConversationItem(items, transcriptToConversationItem(payload.transcript || {})));
            setProspectTranscript(payload.transcript);
            setProvisionalTranscript(null);
          } else if (payload.transcript) {
            setConversationItems((items) => mergeConversationItem(items, transcriptToConversationItem(payload.transcript || {})));
          }
          if (payload.dialog) {
            setDialog(payload.dialog);
          }
        } catch {
          // Ignore malformed local playground events.
        }
      };
      events.addEventListener("snapshot", handleEvent);
      events.addEventListener("transcript.provisional", handleEvent);
      events.addEventListener("transcript", handleEvent);
      events.addEventListener("dialog", handleEvent);
      events.addEventListener("voicemail.reject", handleEvent);
      events.addEventListener("session.stop", handleEvent);
    };

    const bindSession = async () => {
      try {
        attempts += 1;
        const params = new URLSearchParams();
        if (scopedAgentExtension) params.set("agentExtensionId", scopedAgentExtension);
        if (scopedAgentEmail) params.set("agentEmail", scopedAgentEmail);
        if (scopedUii) params.set("uii", scopedUii);
        if (scopedQueueItemId) params.set("queueItemId", scopedQueueItemId);
        if (scopedCallSessionId) params.set("callSessionId", scopedCallSessionId);
        if (scopedCaseId) params.set("caseId", scopedCaseId);
        if (scopedContactName) params.set("contactName", scopedContactName);
        if (agentName) params.set("agentName", agentName);
        const response = await fetch(`${LIVE_COACH_API_BASE}/session-for-call?${params.toString()}`);
        if (!response.ok) throw new Error(`Coach bridge returned ${response.status}`);
        const data = await response.json() as { session?: LiveCoachSession | null; reason?: string; status?: string };
        if (cancelled) return;
        if (data.session) {
          applySession(data.session);
          connectEvents(data.session.id);
        } else {
          setBridgeStatus("connected");
          setError(data.reason || data.status || "Waiting for matching stream");
          retryTimer = window.setTimeout(() => void bindSession(), attempts < 8 ? 1250 : 5000);
        }
      } catch (loadError) {
        if (!cancelled) {
          setBridgeStatus("error");
          setError(readErrorMessage(loadError));
          retryTimer = window.setTimeout(() => void bindSession(), attempts < 5 ? 1500 : 5000);
        }
      }
    };

    setBridgeStatus("connecting");
    setError("Binding coach to current call");
    void bindSession();

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      if (events) events.close();
    };
  }, [
    agentName,
    agentScopeKey,
    callScopeKey,
    resetCoach,
    scopedAgentEmail,
    scopedAgentExtension,
    scopedCallSessionId,
    scopedCaseId,
    scopedContactName,
    scopedQueueItemId,
    scopedReleaseKey,
    scopedReleaseReason,
    scopedUii,
    scopeKey,
  ]);

  const heardText = provisionalTranscript?.text?.trim() || prospectTranscript?.text?.trim() || "";
  const heardSentence = lastSentence(heardText);
  const heardAt = provisionalTranscript?.at || prospectTranscript?.at || "";
  const heardIsLive = Boolean(provisionalTranscript?.text?.trim());
  const line = dialog?.say?.trim() || "";
  const rejected = dialog?.status === "rejected";
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
              ) : prospectTranscript?.text ? (
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
              !heardText && "flex items-center text-muted-foreground",
            )}
          >
            {heardSentence || "Waiting for prospect speech..."}
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
        <div className="max-h-[62vh] space-y-3 overflow-y-auto bg-slate-50 px-4 py-4">
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
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between gap-3 text-[10px] font-semibold uppercase tracking-[0.12em] opacity-70">
                      <span>{item.provisional ? `${item.label} live` : item.label}</span>
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
