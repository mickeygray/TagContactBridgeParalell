import * as React from "react";
import { Headset, Radio, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusPill } from "@/components/ui/StatusPill";
import { api } from "@/lib/api/client";
import {
  isLiveCoachRejected,
  isLiveCoachTerminal,
  streamLiveCoachEventsWithRetry,
  type LiveCoachCallEvent,
  type LiveCoachContext,
  type LiveCoachDialog,
  type LiveCoachEvent,
  type LiveCoachSession,
  type LiveCoachStreamStatus,
  type LiveCoachTranscript,
} from "@/lib/liveCoach/stream";
import { cn } from "@/lib/utils/cn";

type AgentLane = {
  key: string;
  label: string;
  aliases: string[];
  fallback?: boolean;
  dynamic?: boolean;
};

type LaneFlash = {
  text: string;
  at: string;
  guidance?: string;
  phone?: string;
  expiresAt: number;
};

type LaneTone = "idle" | "live" | "good" | "warn" | "danger";

type LaneDiagnosticEvent = {
  id: string;
  at: string;
  label: string;
  detail?: string;
  tone: LaneTone;
  deltaMs?: number | null;
};

type LaneState = {
  session: LiveCoachSession | null;
  waitingCall: LiveCoachCallEvent | null;
  transcript: LiveCoachTranscript | null;
  coachTranscript: LiveCoachTranscript | null;
  context: LiveCoachContext | null;
  dialog: LiveCoachDialog | null;
  streamStatus: LiveCoachStreamStatus | null;
  flash: LaneFlash | null;
  stage: string;
  stageTone: LaneTone;
  stageDetail?: string;
  diagnostics: LaneDiagnosticEvent[];
};

type DashboardPayload = {
  ok: boolean;
  sessions?: LiveCoachSession[];
  callEvents?: LiveCoachCallEvent[];
  retiredFromCallEvents?: {
    checkedAgents?: number | null;
    retiredCount?: number | null;
  } | null;
};

type SyncCurrentPayload = {
  ok: boolean;
  callEventCount?: number | null;
  checkedAgents?: number | null;
  activeCount?: number | null;
  ensuredCount?: number | null;
  retiredCount?: number | null;
};

// Pinned lanes always render. Any OTHER agent with a live session or fresh
// call event gets a dynamic lane derived from their identity — the coach works
// for everyone with a stream attached, not just the names pinned here.
// Identity-less streams share the Unbound lane (shown only when one exists).
const PINNED_AGENTS: AgentLane[] = [
  { key: "cbolt", label: "Chris Bolt", aliases: ["cbolt", "cbolt@", "chris bolt", "chrisbolt", "63914586004"] },
  { key: "bhansen", label: "Brad Hansen", aliases: ["bhansen", "bhansen@", "brad hansen", "bradhansen", "63914587004"] },
  { key: "jsharp", label: "J. Sharp", aliases: ["jsharp", "jsharp@", "james sharp", "jay sharp", "63914621004"] },
];
// (No "Unbound Stream" lane: identity-less sessions are optimistically claimed
// into agent lanes by event-phone match and healed by bridge enrichment;
// persistent orphans get a per-phone lane via dynamicLaneFromIdentity.)

function sessionHasAgentIdentity(session: LiveCoachSession) {
  const metadata = session.metadata || {};
  return Boolean(String(
    metadata.agentExtension || metadata.agentEmail || metadata.agentName || "",
  ).trim());
}

function sessionAgeMs(session: LiveCoachSession) {
  const createdMs = Date.parse(session.createdAt || "") || 0;
  return createdMs ? Date.now() - createdMs : 0;
}

function agentRecentEventPhones(agent: AgentLane, callEvents: LiveCoachCallEvent[]) {
  const phones = new Set<string>();
  const maxAgeMs = 3 * 60 * 1000;
  for (const event of callEvents) {
    const ms = callEventSortMs(event);
    if (!ms || Date.now() - ms > maxAgeMs) continue;
    if (!callMatches(agent, event)) continue;
    const digits = phoneDigits(event.phone);
    if (digits) phones.add(digits);
  }
  return phones;
}

// Optimistic attribution: an identity-less session whose phone matches one of
// this agent's fresh call events belongs in this agent's lane NOW; bridge
// enrichment makes it authoritative moments later (healing).
function sessionMatchesAgentOptimistically(agent: AgentLane, session: LiveCoachSession, callEvents: LiveCoachCallEvent[]) {
  if (agentMatches(agent, session)) return true;
  if (sessionHasAgentIdentity(session)) return false;
  const digits = phoneDigits(session.metadata?.phone);
  if (!digits) return false;
  return agentRecentEventPhones(agent, callEvents).has(digits);
}

function dynamicLaneFromIdentity(
  ext?: string | null,
  email?: string | null,
  name?: string | null,
  phone?: string | null,
  session?: LiveCoachSession | null,
): AgentLane | null {
  const cleanExt = String(ext || "").trim();
  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanName = String(name || "").trim();
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  if (!cleanExt && !cleanEmail && !cleanName) {
    // Last-resort visibility: only a PERSISTENT orphan (alive >60s with no
    // attribution) earns a phone lane — transient pre-event gaps stay
    // invisible because optimistic attribution or enrichment claims them.
    if (!cleanPhone || cleanPhone.length < 7) return null;
    if (!session || sessionAgeMs(session) < 60_000) return null;
    return {
      key: `dyn-ph-${cleanPhone}`,
      label: `Phone ${cleanPhone.replace(/^(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3")}`,
      aliases: [cleanPhone],
      dynamic: true,
    };
  }
  const key = `dyn-${(cleanExt || cleanEmail || cleanName).toLowerCase().replace(/[^a-z0-9@._-]+/g, "-").slice(0, 60)}`;
  const aliases = [
    cleanExt,
    cleanEmail,
    cleanEmail ? cleanEmail.split("@")[0] : "",
    cleanName.toLowerCase(),
  ].filter(Boolean);
  const label = cleanName || (cleanEmail ? cleanEmail.split("@")[0] : `Ext ${cleanExt}`);
  return { key, label, aliases, dynamic: true };
}

function deriveDynamicLanes(sessions: LiveCoachSession[], callEvents: LiveCoachCallEvent[]): AgentLane[] {
  const dynamic = new Map<string, AgentLane>();
  // 1. Event-derived agent lanes first (events always carry agent identity)
  //    so identity-less sessions can be optimistically claimed by them.
  const maxEventAgeMs = 3 * 60 * 1000;
  for (const event of callEvents) {
    const ms = callEventSortMs(event);
    if (!ms || Date.now() - ms > maxEventAgeMs) continue;
    if (PINNED_AGENTS.some((agent) => callMatches(agent, event))) continue;
    const lane = dynamicLaneFromIdentity(event.extensionId, event.agentEmail, event.agentName);
    if (lane && !dynamic.has(lane.key)) dynamic.set(lane.key, lane);
  }
  // 2. Session-derived lanes: identity-less sessions claimed by ANY lane's
  //    fresh event-phone stay laneless (they render inside that agent's lane);
  //    persistent orphans (>60s, unclaimed) earn a last-resort phone lane.
  const claimLanes = PINNED_AGENTS.concat([...dynamic.values()]);
  for (const session of sessions) {
    if (isLiveCoachTerminal(session.status) || isLiveCoachRejected(session)) continue;
    if (claimLanes.some((agent) => sessionMatchesAgentOptimistically(agent, session, callEvents))) continue;
    const metadata = session.metadata || {};
    const lane = dynamicLaneFromIdentity(metadata.agentExtension, metadata.agentEmail, metadata.agentName, metadata.phone, session);
    if (lane && !dynamic.has(lane.key)) dynamic.set(lane.key, lane);
  }
  return [...dynamic.values()].sort((a, b) => a.label.localeCompare(b.label));
}

const VOICEMAIL_FLASH_MS = 5000;

function formatTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function sessionSortMs(session: LiveCoachSession | null | undefined) {
  return Date.parse(session?.lastEventAt || session?.updatedAt || session?.createdAt || "") || 0;
}

function callEventSortMs(event: LiveCoachCallEvent | null | undefined) {
  return Date.parse(event?.createdAt || "") || 0;
}

function compactSessionAgent(session: LiveCoachSession) {
  const metadata = session.metadata || {};
  return [
    metadata.agentEmail || "",
    metadata.agentEmail ? String(metadata.agentEmail).split("@")[0] : "",
    metadata.agentName || "",
    metadata.agentExtension || "",
    // Phone digits so identity-less sessions can match their per-phone lane
    // (live dialogInits carry no agent identity — phone is often all we have).
    String(metadata.phone || "").replace(/\D/g, ""),
  ].join(" ").toLowerCase().replace(/[^a-z0-9@+._ -]+/g, "");
}

function compactCallAgent(event: LiveCoachCallEvent) {
  return [
    event.agentEmail || "",
    event.agentEmail ? String(event.agentEmail).split("@")[0] : "",
    event.agentName || "",
    event.extensionId || "",
  ].join(" ").toLowerCase().replace(/[^a-z0-9@+._ -]+/g, "");
}

function agentMatches(agent: AgentLane, session: LiveCoachSession) {
  const haystack = compactSessionAgent(session);
  return agent.aliases.some((alias) => haystack.includes(alias.toLowerCase()));
}

function callMatches(agent: AgentLane, event: LiveCoachCallEvent) {
  const haystack = compactCallAgent(event);
  return agent.aliases.some((alias) => haystack.includes(alias.toLowerCase()));
}

function phoneDigits(value?: string | null) {
  return String(value || "").replace(/\D/g, "");
}

function eventMatchesFinishedSession(agent: AgentLane, event: LiveCoachCallEvent, sessions: LiveCoachSession[]) {
  return sessions.some((session) => {
    if (!isLiveCoachTerminal(session.status) || !agentMatches(agent, session)) return false;
    const metadata = session.metadata || {};
    if (event.uii && metadata.uii && event.uii === metadata.uii) return true;
    if (event.queueItemId && metadata.queueItemId && event.queueItemId === metadata.queueItemId) return true;
    const leftPhone = phoneDigits(event.phone);
    const rightPhone = phoneDigits(metadata.phone);
    return Boolean(leftPhone && rightPhone && leftPhone === rightPhone);
  });
}

// Prefer sessions with real signal over empty control-plane shells (sync-current
// re-ensures coach-cx shells every 10s, keeping their recency fresh). Signal
// counts only while fresh (30s): flowing audio refreshes lastEventAt every ~2.5s.
function sessionSignalScore(session: LiveCoachSession) {
  const latest = session.latest || {};
  let score = 0;
  if (latest.dialog) score += 4;
  if (latest.transcript?.text || latest.provisionalTranscript?.text) score += 4;
  if (latest.context) score += 2;
  if (Number(session.counters?.input || 0) > 0) score += 2;
  if (latest.streamStatus) score += 1;
  if (session.metadata?.streamId) score += 1;
  return score;
}

function sessionPickRank(session: LiveCoachSession) {
  const updatedMs = sessionSortMs(session);
  if (!updatedMs || Date.now() - updatedMs > 30_000) return 0;
  return sessionSignalScore(session);
}

function pickSession(agent: AgentLane, sessions: LiveCoachSession[], allLanes: AgentLane[], callEvents: LiveCoachCallEvent[]) {
  const candidates = agent.fallback
    ? sessions.filter((session) =>
      !allLanes.some((lane) => !lane.fallback && agentMatches(lane, session)))
    : sessions.filter((session) => sessionMatchesAgentOptimistically(agent, session, callEvents));
  return candidates
    .filter((session) => !isLiveCoachTerminal(session.status))
    .sort((a, b) => {
      const rankDelta = sessionPickRank(b) - sessionPickRank(a);
      if (rankDelta) return rankDelta;
      return sessionSortMs(b) - sessionSortMs(a);
    })[0] || null;
}

function pickRecentRejected(agent: AgentLane, sessions: LiveCoachSession[]) {
  const now = Date.now();
  return sessions
    .filter((session) => isLiveCoachRejected(session) && agentMatches(agent, session))
    .filter((session) => now - sessionSortMs(session) <= VOICEMAIL_FLASH_MS)
    .sort((a, b) => sessionSortMs(b) - sessionSortMs(a))[0] || null;
}

function pickWaitingCall(agent: AgentLane, callEvents: LiveCoachCallEvent[], sessions: LiveCoachSession[]) {
  const now = Date.now();
  return callEvents
    .filter((event) => callMatches(agent, event))
    .filter((event) => !eventMatchesFinishedSession(agent, event, sessions))
    .filter((event) => {
      const at = callEventSortMs(event);
      return at && now - at <= 3 * 60 * 1000;
    })
    .sort((a, b) => callEventSortMs(b) - callEventSortMs(a))[0] || null;
}

function sessionWaitingForRingCxStream(session: LiveCoachSession | null | undefined) {
  if (!session || isLiveCoachTerminal(session.status)) return false;
  const metadata = session.metadata || {};
  const source = String(metadata.source || "").toLowerCase();
  const inputCount = Number(session.counters?.input || 0);
  const hasTranscript = Boolean(session.latest?.provisionalTranscript?.text || session.latest?.transcript?.text);
  return (source === "mongo-cx" || source === "control-plane-cx") && !metadata.streamId && inputCount <= 0 && !hasTranscript;
}

function voicemailFlashFromSession(session: LiveCoachSession): LaneFlash {
  const transcript = session.latest?.transcript;
  const dialog = session.latest?.dialog;
  return {
    text: transcript?.text
      ? `Voicemail detected. ${transcript.text}`
      : "Voicemail detected. Coach cleared this call.",
    at: dialog?.at || transcript?.at || session.lastEventAt || new Date().toISOString(),
    guidance: dialog?.guidance || "",
    phone: session.metadata?.phone || "",
    expiresAt: Date.now() + VOICEMAIL_FLASH_MS,
  };
}

function voicemailFlashFromEvent(payload: LiveCoachEvent): LaneFlash {
  return {
    text: payload.transcript?.text
      ? `Voicemail detected. ${payload.transcript.text}`
      : "Voicemail detected. Coach cleared this call.",
    at: payload.at || payload.transcript?.at || new Date().toISOString(),
    guidance: payload.dialog?.guidance || "",
    phone: payload.session?.metadata?.phone || "",
    expiresAt: Date.now() + VOICEMAIL_FLASH_MS,
  };
}

function contextText(context: LiveCoachContext | null) {
  if (!context) return "";
  const candidateKeys = (context.deterministicCandidates || []).map((row) => row.key || row.label).filter(Boolean);
  const keptKeys = [
    ...(context.miniJudgement?.selectedKeys || []),
    ...(context.matches || []).map((row) => row.key || row.label || ""),
  ].filter(Boolean);
  const rejectedKeys = (context.miniJudgement?.rejected || []).map((row) => row.key).filter(Boolean);
  return [
    context.phraseText || context.text || "",
    candidateKeys.length ? `Candidates: ${candidateKeys.slice(0, 6).join(", ")}` : "",
    keptKeys.length ? `Mini kept: ${Array.from(new Set(keptKeys)).slice(0, 6).join(", ")}` : "Mini kept: none",
    rejectedKeys.length ? `Mini rejected: ${rejectedKeys.slice(0, 5).join(", ")}` : "",
    context.actionReason ? `Action: ${context.actionReason}` : "",
  ].filter(Boolean).join("\n");
}

function metaPills(items: Array<string | null | undefined>) {
  return items.filter(Boolean);
}

const DIAGNOSTIC_LIMIT = 9;

function shortId(value?: string | null, length = 10) {
  const clean = String(value || "").trim();
  if (!clean) return "";
  return clean.length <= length ? clean : clean.slice(-length);
}

function formatBytes(value?: number | null) {
  const bytes = Number(value || 0);
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatDeltaMs(value?: number | null) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `+${Math.round(ms)}ms`;
  return `+${(ms / 1000).toFixed(1)}s`;
}

function toneClasses(tone: LaneTone) {
  return cn(
    tone === "good" && "border-emerald-200 bg-emerald-50 text-emerald-700",
    tone === "live" && "border-sky-200 bg-sky-50 text-sky-700",
    tone === "warn" && "border-amber-200 bg-amber-50 text-amber-700",
    tone === "danger" && "border-red-200 bg-red-50 text-red-700",
    tone === "idle" && "border-border bg-muted text-muted-foreground",
  );
}

function diagnosticId(type: string, at: string, payload: LiveCoachEvent) {
  return [
    at,
    type,
    payload.dialogId || payload.dialog?.id || payload.transcript?.id || payload.provisionalTranscript?.id || payload.sessionId || "",
  ].join(":");
}

function countRows(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function selectedKeysFromPayload(payload: LiveCoachEvent) {
  if (Array.isArray(payload.selectedKeys)) return payload.selectedKeys.filter(Boolean);
  if (Array.isArray(payload.context?.miniJudgement?.selectedKeys)) {
    return payload.context.miniJudgement.selectedKeys.filter(Boolean);
  }
  if (Array.isArray(payload.context?.matches)) {
    return payload.context.matches.map((row) => row.key || row.label || "").filter(Boolean);
  }
  return [];
}

function diagnosticFromPayload(eventName: string, payload: LiveCoachEvent): LaneDiagnosticEvent | null {
  const type = String(payload.type || eventName || "");
  const at = payload.at || payload.streamStatus?.at || payload.transcript?.at || payload.dialog?.at || new Date().toISOString();
  let label = "";
  let detail = "";
  let tone: LaneTone = "idle";

  if (type === "snapshot") {
    label = "snapshot";
    detail = payload.session?.status || payload.session?.metadata?.source || "";
    tone = "idle";
  } else if (type === "stream.status" && payload.streamStatus) {
    const status = payload.streamStatus;
    label = "audio";
    detail = [
      `${Math.round(Number(status.durationSec || 0))}s`,
      `active ${Number(status.activePct || 0).toFixed(1)}%`,
      status.bindState ? `bind ${status.bindState}` : "",
      status.bindReason && status.bindState !== "bound" ? status.bindReason : "",
      Number(status.pendingDroppedBytes || 0) > 0 ? `drop ${formatBytes(status.pendingDroppedBytes)}` : "",
    ].filter(Boolean).join(" | ");
    tone = status.bindState && status.bindState !== "bound" ? "warn" : "live";
  } else if (type === "transcript.provisional" || payload.provisionalTranscript) {
    const transcript = payload.provisionalTranscript;
    label = "STT live";
    detail = [
      transcript?.wordCount ? `${transcript.wordCount} words` : "",
      transcript?.model || transcript?.source || "",
    ].filter(Boolean).join(" | ");
    tone = "live";
  } else if (type === "transcript" || payload.transcript) {
    const transcript = payload.transcript;
    label = "VAD final";
    detail = [
      transcript?.wordCount ? `${transcript.wordCount} words` : "",
      transcript?.model || transcript?.source || "",
    ].filter(Boolean).join(" | ");
    tone = "live";
  } else if (type === "watcher.collect" || type === "watcher.vad_release") {
    label = type === "watcher.vad_release" ? "VAD release" : "determinism";
    const candidateCount = countRows(payload.candidates);
    const systemCount = countRows(payload.systemMatches);
    detail = [
      payload.action || "",
      candidateCount ? `${candidateCount} candidates` : "",
      systemCount ? `${systemCount} system` : "",
    ].filter(Boolean).join(" | ");
    tone = payload.action === "reject_voicemail" ? "danger" : systemCount ? "warn" : "live";
  } else if (type === "context.judge.start") {
    label = "mini start";
    detail = payload.candidateCount ? `${payload.candidateCount} candidates` : "reading phrase";
    tone = "live";
  } else if (type === "context.judge.done") {
    const selected = selectedKeysFromPayload(payload);
    label = payload.shouldCompose ? "mini kept" : "mini held";
    detail = [
      payload.elapsedMs ? `${payload.elapsedMs}ms` : "",
      selected.length ? selected.slice(0, 4).join(", ") : payload.actionReason || "",
    ].filter(Boolean).join(" | ");
    tone = payload.shouldCompose ? "good" : "idle";
  } else if (type === "context.judge.error" || type === "dialog.error") {
    label = type === "dialog.error" ? "coach error" : "mini error";
    detail = payload.error || "error";
    tone = "danger";
  } else if (type === "pipeline.hold") {
    label = "hold";
    detail = payload.action || payload.hold?.reason || "not coachable yet";
    tone = "idle";
  } else if (type === "context.clear") {
    label = "context clear";
    detail = payload.hold?.match || payload.hold?.reason || payload.action || "screener/hold";
    tone = "warn";
  } else if (type === "context" || payload.context) {
    const context = payload.context;
    const selected = selectedKeysFromPayload(payload);
    label = context?.shouldCompose ? "context ready" : "context held";
    detail = [
      context?.actionReason || "",
      selected.length ? selected.slice(0, 4).join(", ") : "",
    ].filter(Boolean).join(" | ");
    tone = context?.shouldCompose ? "good" : "idle";
  } else if (type === "compose.start") {
    label = "coach start";
    detail = payload.dialogId ? `dialog ${shortId(payload.dialogId, 8)}` : "streaming response";
    tone = "live";
  } else if (type === "compose.supersede") {
    label = "supersede";
    detail = payload.activeDialogId ? `active ${shortId(payload.activeDialogId, 8)}` : "newer phrase won";
    tone = "warn";
  } else if (type === "compose.deduped") {
    label = "deduped";
    detail = payload.windowMs ? `${payload.windowMs}ms window` : "similar phrase";
    tone = "warn";
  } else if (type === "compose.rate_limited") {
    label = "rate limited";
    detail = payload.rateLimitPerMinute ? `${payload.rateLimitPerMinute}/min cap` : "compose cap";
    tone = "warn";
  } else if (type === "dialog") {
    const dialog = payload.dialog;
    label = dialog?.status === "ready" ? "coach ready" : dialog?.status === "streaming" ? "coach streaming" : "dialog";
    detail = [dialog?.composer || dialog?.model || "", dialog?.label || ""].filter(Boolean).join(" | ");
    tone = dialog?.status === "rejected" ? "danger" : dialog?.status === "ready" ? "good" : "live";
  } else if (type === "voicemail.reject") {
    label = "voicemail";
    detail = payload.dialog?.guidance || "call cleared";
    tone = "danger";
  } else if (type === "session.stop" || type === "session.stale" || type === "session.pruned") {
    label = type === "session.stale" ? "stale" : type === "session.pruned" ? "pruned" : "released";
    detail = "session closed";
    tone = type === "session.stale" ? "warn" : "idle";
  }

  if (!label) return null;
  return { id: diagnosticId(type, at, payload), at, label, detail, tone };
}

function appendDiagnostic(existing: LaneState | undefined, next: LaneDiagnosticEvent | null) {
  const rows = existing?.diagnostics || [];
  if (!next) return rows;
  const previous = rows[rows.length - 1];
  const previousMs = Date.parse(previous?.at || "");
  const nextMs = Date.parse(next.at || "");
  const withDelta = {
    ...next,
    deltaMs: previousMs && nextMs ? Math.max(0, nextMs - previousMs) : null,
  };
  if (previous?.id === withDelta.id) {
    return rows.slice(0, -1).concat(withDelta);
  }
  return rows.concat(withDelta).slice(-DIAGNOSTIC_LIMIT);
}

function diagnosticsFromSession(session: LiveCoachSession | null | undefined) {
  let rows: LaneDiagnosticEvent[] = [];
  for (const event of (session?.events || []).slice(-DIAGNOSTIC_LIMIT)) {
    const diagnostic = diagnosticFromPayload(event.type || "message", event);
    rows = appendDiagnostic({ ...newBlankLane(), diagnostics: rows }, diagnostic);
  }
  return rows;
}

function appendTranscriptText(existing?: string | null, incoming?: string | null) {
  const left = String(existing || "").trim();
  const right = String(incoming || "").trim();
  if (!left) return right;
  if (!right) return left;
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft.endsWith(normalizedRight)) return left;
  if (normalizedRight.startsWith(normalizedLeft)) return right;
  if (/^[.,!?;:%)\]}]/.test(right)) return left + right;
  return `${left} ${right}`;
}

function appendCoachTranscript(existing: LaneState, transcript: LiveCoachTranscript): LiveCoachTranscript {
  const current = existing.coachTranscript;
  const text = current?.awaitingCoach
    ? appendTranscriptText(current.text, transcript.text)
    : String(transcript.text || "").trim();
  return {
    ...(current?.awaitingCoach ? current : transcript),
    ...transcript,
    text,
    wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0,
    coachHeld: true,
    awaitingCoach: true,
  };
}

function newBlankLane(): LaneState {
  return {
    session: null,
    waitingCall: null,
    transcript: null,
    coachTranscript: null,
    context: null,
    dialog: null,
    streamStatus: null,
    flash: null,
    stage: "waiting",
    stageTone: "idle",
    stageDetail: "Waiting for stream",
    diagnostics: [],
  };
}

export function LiveCoachWallboardWorkspace() {
  const [agentLanes, setAgentLanes] = React.useState<AgentLane[]>(PINNED_AGENTS);
  const agentLanesRef = React.useRef<AgentLane[]>(PINNED_AGENTS);
  const [lanes, setLanes] = React.useState<Record<string, LaneState>>(() =>
    Object.fromEntries(PINNED_AGENTS.map((agent) => [agent.key, newBlankLane()])),
  );
  const [liveCount, setLiveCount] = React.useState(0);
  const [updatedAt, setUpdatedAt] = React.useState("");
  const [error, setError] = React.useState("");
  const [syncing, setSyncing] = React.useState(false);
  const [syncSummary, setSyncSummary] = React.useState("");
  const lanesRef = React.useRef(lanes);
  const streamControllersRef = React.useRef<Map<string, AbortController>>(new Map());
  const laneSessionIdsRef = React.useRef<Map<string, string>>(new Map());

  React.useEffect(() => {
    lanesRef.current = lanes;
  }, [lanes]);

  const patchLane = React.useCallback((agentKey: string, patch: Partial<LaneState>) => {
    setLanes((current) => {
      const next = {
        ...current,
        [agentKey]: {
          ...(current[agentKey] || newBlankLane()),
          ...patch,
        },
      };
      lanesRef.current = next;
      return next;
    });
  }, []);

  const closeLaneStream = React.useCallback((agentKey: string) => {
    const existing = streamControllersRef.current.get(agentKey);
    if (existing) existing.abort();
    streamControllersRef.current.delete(agentKey);
    laneSessionIdsRef.current.delete(agentKey);
  }, []);

  const subscribeLane = React.useCallback((agent: AgentLane, session: LiveCoachSession) => {
    const waitingForStream = sessionWaitingForRingCxStream(session);
    const streamStatus = session.latest?.streamStatus || null;
    const existingLane = lanesRef.current?.[agent.key];
    const diagnostics = session.events?.length
      ? diagnosticsFromSession(session)
      : existingLane?.session?.id === session.id
        ? existingLane.diagnostics
        : [];
    patchLane(agent.key, {
      session,
      waitingCall: null,
      flash: null,
      transcript: session.latest?.provisionalTranscript || session.latest?.transcript || null,
      coachTranscript: session.latest?.context?.phraseText
        ? {
          ...(session.latest?.transcript || {}),
          role: "prospect",
          text: session.latest.context.phraseText,
          source: "mini-context",
          model: session.latest.context.miniJudgement?.model || session.latest?.transcript?.model || null,
          wordCount: String(session.latest.context.phraseText || "").trim().split(/\s+/).filter(Boolean).length,
          coachHeld: true,
          awaitingCoach: false,
        }
        : null,
      context: session.latest?.context || null,
      dialog: session.latest?.dialog || null,
      streamStatus,
      stage: waitingForStream ? "stream missing" : streamStatus ? "audio receiving" : "stream attached",
      stageTone: waitingForStream ? "warn" : "live",
      stageDetail: waitingForStream
        ? "Current CX call joined; waiting for RingCX audio"
        : streamStatus
          ? `${Math.round(Number(streamStatus.durationSec || 0))}s audio | active ${Number(streamStatus.activePct || 0).toFixed(1)}% | waiting on STT`
        : session.metadata?.streamId ? `stream ${session.metadata.streamId.slice(-8)}` : "SSE connecting",
      diagnostics,
    });
    if (laneSessionIdsRef.current.get(agent.key) === session.id && streamControllersRef.current.has(agent.key)) return;
    closeLaneStream(agent.key);
    laneSessionIdsRef.current.set(agent.key, session.id);

    const controller = new AbortController();
    streamControllersRef.current.set(agent.key, controller);
    void streamLiveCoachEventsWithRetry(`/api/ai/live-coach/sessions/${encodeURIComponent(session.id)}/events`, {
      signal: controller.signal,
      onEvent: (_eventName, payload) => {
        const diagnostic = diagnosticFromPayload(_eventName, payload);
        if (diagnostic) {
          patchLane(agent.key, {
            diagnostics: appendDiagnostic(lanesRef.current?.[agent.key], diagnostic),
          });
        }
        if (payload.session) {
          patchLane(agent.key, { session: payload.session, streamStatus: payload.session.latest?.streamStatus || null });
        }
        if (payload.type === "stream.status" && payload.streamStatus) {
          patchLane(agent.key, {
            streamStatus: payload.streamStatus,
            stage: "audio receiving",
            stageTone: "live",
            stageDetail: `${Math.round(Number(payload.streamStatus.durationSec || 0))}s audio | active ${Number(payload.streamStatus.activePct || 0).toFixed(1)}% | waiting on STT`,
          });
        }
        if (payload.provisionalTranscript?.role === "prospect") {
          const existing = lanesRef.current?.[agent.key];
          patchLane(agent.key, {
            ...(existing?.coachTranscript?.awaitingCoach ? {} : { transcript: payload.provisionalTranscript }),
            stage: "STT live",
            stageTone: "live",
            stageDetail: "Words arriving",
          });
        }
        if (payload.transcript?.role === "prospect") {
          const existing = lanesRef.current?.[agent.key] || newBlankLane();
          patchLane(agent.key, {
            transcript: payload.transcript,
            coachTranscript: appendCoachTranscript(existing, payload.transcript),
            stage: "VAD final",
            stageTone: "live",
            stageDetail: "Mini queued",
          });
        }
        if (payload.type === "context.judge.start") {
          const existing = lanesRef.current?.[agent.key];
          patchLane(agent.key, {
            ...(existing?.coachTranscript?.text
              ? { coachTranscript: { ...existing.coachTranscript, coachHeld: true, awaitingCoach: true } }
              : {}),
            stage: "mini checking",
            stageTone: "live",
            stageDetail: payload.candidateCount ? `${payload.candidateCount} candidates` : "Reading phrase",
          });
        }
        if (payload.type === "context.judge.done") {
          const existing = lanesRef.current?.[agent.key];
          patchLane(agent.key, {
            ...(!payload.shouldCompose && existing?.coachTranscript?.awaitingCoach ? { coachTranscript: null } : {}),
            stage: payload.shouldCompose ? "mini kept" : "mini held",
            stageTone: payload.shouldCompose ? "good" : "idle",
            stageDetail: [
              payload.elapsedMs ? `${payload.elapsedMs}ms` : "",
              Array.isArray(payload.selectedKeys) && payload.selectedKeys.length
                ? payload.selectedKeys.slice(0, 3).join(", ")
                : payload.actionReason || "",
            ].filter(Boolean).join(" | "),
          });
        }
        if (payload.type === "pipeline.hold") {
          const existing = lanesRef.current?.[agent.key];
          patchLane(agent.key, {
            ...(existing?.coachTranscript?.awaitingCoach ? { coachTranscript: null } : {}),
            stage: "hold",
            stageTone: "idle",
            stageDetail: payload.action || payload.hold?.reason || "No coachable phrase",
          });
        }
        if (payload.type === "context.clear") {
          patchLane(agent.key, {
            transcript: {
              at: payload.at || payload.transcript?.at || new Date().toISOString(),
              role: "system",
              text: payload.transcript?.text
                ? `Screener/hold prompt detected. Context cleared. ${payload.transcript.text}`
                : "Screener/hold prompt detected. Context cleared.",
              source: "system context gate",
              wordCount: 0,
            },
            coachTranscript: null,
            context: null,
            dialog: null,
            stage: "screener hold",
            stageTone: "idle",
            stageDetail: payload.hold?.match || payload.hold?.reason || "Listening for next prospect phrase",
          });
        }
        if (payload.context) {
          const phraseText = payload.context.phraseText || payload.context.text || "";
          const existing = lanesRef.current?.[agent.key];
          patchLane(agent.key, {
            context: payload.context,
            ...(payload.context.shouldCompose && phraseText
              ? {
                coachTranscript: {
                  ...(existing?.transcript || {}),
                  id: payload.context.id || existing?.transcript?.id || null,
                  at: payload.context.at || existing?.transcript?.at || new Date().toISOString(),
                  role: "prospect",
                  text: phraseText,
                  source: "mini-context",
                  model: payload.context.miniJudgement?.model || existing?.transcript?.model || null,
                  wordCount: phraseText.trim().split(/\s+/).filter(Boolean).length,
                  coachHeld: true,
                  awaitingCoach: false,
                },
              }
              : {}),
          });
        }
        if (payload.type === "compose.start") {
          patchLane(agent.key, {
            stage: "coach writing",
            stageTone: "live",
            stageDetail: payload.dialogId ? `dialog ${payload.dialogId.slice(-8)}` : "Streaming response",
          });
        }
        if (payload.type === "compose.deduped" || payload.type === "compose.rate_limited") {
          patchLane(agent.key, {
            stage: payload.type === "compose.deduped" ? "deduped" : "rate limited",
            stageTone: "warn",
            stageDetail: payload.type === "compose.deduped"
              ? "Similar phrase already coached"
              : `${payload.rateLimitPerMinute || 0}/min cap`,
          });
        }
        if (payload.dialog) {
          if (payload.dialog.status === "rejected") {
            patchLane(agent.key, {
              session: null,
              waitingCall: null,
              transcript: null,
              context: null,
              dialog: null,
              flash: voicemailFlashFromEvent(payload),
              stage: "voicemail",
              stageTone: "danger",
              stageDetail: payload.dialog.guidance || "Call cleared",
            });
          } else {
            const existing = lanesRef.current?.[agent.key];
            patchLane(agent.key, {
              dialog: payload.dialog,
              ...(existing?.coachTranscript?.text && (payload.dialog.status === "streaming" || payload.dialog.status === "ready")
                ? { coachTranscript: { ...existing.coachTranscript, coachHeld: true, awaitingCoach: false } }
                : {}),
              stage: payload.dialog.status === "streaming" ? "coach streaming" : "line ready",
              stageTone: payload.dialog.status === "ready" ? "good" : "live",
              stageDetail: payload.dialog.composer || payload.dialog.model || payload.dialog.label || "",
            });
          }
        }
        if (payload.type === "voicemail.reject") {
          closeLaneStream(agent.key);
          patchLane(agent.key, {
            session: null,
            waitingCall: null,
              transcript: null,
              coachTranscript: null,
              context: null,
            dialog: null,
            flash: voicemailFlashFromEvent(payload),
            stage: "voicemail",
            stageTone: "danger",
            stageDetail: payload.dialog?.guidance || "Call cleared",
          });
        }
        if (payload.type === "session.stop" || payload.type === "session.stale" || payload.type === "session.pruned") {
          closeLaneStream(agent.key);
          patchLane(agent.key, {
            session: null,
            waitingCall: null,
            transcript: null,
            coachTranscript: null,
            context: null,
            dialog: null,
            stage: payload.type === "session.stale" ? "stale" : "released",
            stageTone: payload.type === "session.stale" ? "warn" : "idle",
            stageDetail: "Waiting for next call",
          });
        }
      },
      onError: (streamError) => {
        patchLane(agent.key, {
          stage: "stream error",
          stageTone: "danger",
          stageDetail: streamError.message,
        });
      },
    }).catch(() => undefined);
  }, [closeLaneStream, patchLane]);

  const refresh = React.useCallback(async (signal?: AbortSignal) => {
    const data = await api.get<DashboardPayload>("/api/ai/live-coach/dashboard/sessions", {
      query: { summary: 1 },
      signal,
    });
    const sessions = (data.sessions || []).filter((session) => {
      const source = String(session.metadata?.source || "").toLowerCase();
      return source.includes("grpc") || source === "mongo-cx" || source === "control-plane-cx";
    });
    const callEvents = data.callEvents || [];
    setLiveCount(sessions.filter((session) => !isLiveCoachTerminal(session.status)).length);
    setUpdatedAt(new Date().toISOString());
    setError("");

    // Lanes follow the floor: pinned agents plus a dynamic lane for any other
    // agent that has a live session or fresh call event.
    const desiredLanes = PINNED_AGENTS.concat(deriveDynamicLanes(sessions, callEvents));
    const desiredKeys = new Set(desiredLanes.map((lane) => lane.key));
    if (desiredLanes.map((lane) => lane.key).join("|") !== agentLanesRef.current.map((lane) => lane.key).join("|")) {
      for (const key of [...streamControllersRef.current.keys()]) {
        if (!desiredKeys.has(key)) closeLaneStream(key);
      }
      setLanes((current) => {
        const next: Record<string, LaneState> = {};
        for (const lane of desiredLanes) next[lane.key] = current[lane.key] || newBlankLane();
        lanesRef.current = next;
        return next;
      });
      agentLanesRef.current = desiredLanes;
      setAgentLanes(desiredLanes);
    }

    for (const agent of desiredLanes) {
      const session = pickSession(agent, sessions, desiredLanes, callEvents);
      const waitingCall = pickWaitingCall(agent, callEvents, sessions);
      const recentRejected = pickRecentRejected(agent, sessions);
      if (session) {
        subscribeLane(agent, session);
      } else {
        closeLaneStream(agent.key);
        setLanes((current) => {
          const existing = current[agent.key] || newBlankLane();
          const activeFlash = existing.flash && Date.now() < existing.flash.expiresAt ? existing.flash : null;
          const flash = recentRejected ? voicemailFlashFromSession(recentRejected) : activeFlash;
          return {
            ...current,
            [agent.key]: {
              ...newBlankLane(),
              waitingCall,
              flash,
              stage: flash ? "voicemail" : waitingCall ? "waiting stream" : "waiting",
              stageTone: flash ? "danger" : waitingCall ? "live" : "idle",
              stageDetail: flash?.guidance || (waitingCall ? "App fired cx.call.placed" : "Waiting for stream"),
            },
          };
        });
      }
    }
  }, [closeLaneStream, subscribeLane]);

  const syncCurrentCalls = React.useCallback(async (options: { quiet?: boolean; signal?: AbortSignal } = {}) => {
    if (!options.quiet) setSyncing(true);
    try {
      const result = await api.post<SyncCurrentPayload>(
        "/api/ai/live-coach/sync-current",
        {
          lookbackMs: 5 * 60 * 1000,
          limit: 120,
        },
        { signal: options.signal },
      );
      const summary = [
        `${result.activeCount || 0} active`,
        `${result.ensuredCount || 0} joined`,
        result.retiredCount ? `${result.retiredCount} retired` : "",
        result.checkedAgents ? `${result.checkedAgents} agents checked` : "",
      ].filter(Boolean).join(" | ");
      setSyncSummary(summary || "No active calls found");
      if (!options.quiet) await refresh(options.signal);
      return result;
    } catch (syncError) {
      if (!options.quiet) {
        setError(syncError instanceof Error ? syncError.message : "Current-call sync failed");
      }
      return null;
    } finally {
      if (!options.quiet) setSyncing(false);
    }
  }, [refresh]);

  React.useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let syncInFlight = false;
    const controller = new AbortController();
    const tick = () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      refresh(controller.signal)
        .catch((loadError) => {
          if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Live coach dashboard failed");
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const syncTick = () => {
      if (cancelled || syncInFlight) return;
      syncInFlight = true;
      syncCurrentCalls({ quiet: true, signal: controller.signal })
        .finally(() => {
          syncInFlight = false;
        });
    };
    tick();
    syncTick();
    const interval = window.setInterval(tick, 1500);
    const syncInterval = window.setInterval(syncTick, 10_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
      window.clearInterval(syncInterval);
      for (const stream of streamControllersRef.current.values()) stream.abort();
      streamControllersRef.current.clear();
      laneSessionIdsRef.current.clear();
    };
  }, [refresh, syncCurrentCalls]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <Radio className="h-3.5 w-3.5" />
            AI Bus
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Live Coach Wallboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pinned floor lanes plus a dynamic lane for any other agent with a live stream.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill tone={error ? "danger" : liveCount ? "success" : "info"} dotted>
            {error || `${liveCount} live`}
          </StatusPill>
          {syncSummary ? (
            <StatusPill tone="info">
              {syncSummary}
            </StatusPill>
          ) : null}
          <Button type="button" variant="ghost" size="sm" disabled={syncing} onClick={() => void syncCurrentCalls()}>
            <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
            Sync current calls
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}
      >
        {agentLanes.map((agent) => {
          const lane = lanes[agent.key] || newBlankLane();
          const visibleTranscript = lane.flash
            ? {
              text: lane.flash.text,
              at: lane.flash.at,
              source: "voicemail gate",
              model: null,
              wordCount: lane.flash.text.split(/\s+/).length,
              coachHeld: false,
            }
            : lane.coachTranscript || lane.transcript;
          const transcriptPills = metaPills([
            visibleTranscript?.source || visibleTranscript?.model || "",
            visibleTranscript?.at ? formatTime(visibleTranscript.at) : "",
            visibleTranscript?.wordCount ? `${visibleTranscript.wordCount} words` : "",
            visibleTranscript?.coachHeld ? "held until coach advances" : "",
            lane.flash?.phone ? `phone ${lane.flash.phone}` : "",
          ]);
          const contextBody = contextText(lane.context);
          const rejected = lane.dialog?.status === "rejected";
          const waitingForStream = sessionWaitingForRingCxStream(lane.session);
          const streamStatus = lane.streamStatus || lane.session?.latest?.streamStatus || null;
          const metadata = lane.session?.metadata || {};
          const counters = lane.session?.counters || {};
          const diagnosticPills = metaPills([
            lane.session?.id ? `session ${shortId(lane.session.id, 10)}` : "",
            metadata.source ? `src ${metadata.source}` : "",
            metadata.uii ? `uii ${shortId(metadata.uii, 12)}` : "",
            metadata.queueItemId ? `q ${shortId(metadata.queueItemId, 8)}` : "",
            metadata.streamId ? `stream ${shortId(metadata.streamId, 8)}` : "",
            lane.session?.binding?.status ? `binding ${lane.session.binding.status}` : "",
            streamStatus?.bindState ? `bind ${streamStatus.bindState}` : "",
            streamStatus?.bindReason && streamStatus.bindState !== "bound" ? streamStatus.bindReason : "",
            streamStatus ? `${Math.round(Number(streamStatus.durationSec || 0))}s audio` : "",
            streamStatus ? `active ${Number(streamStatus.activePct || 0).toFixed(1)}%` : "",
            Number(streamStatus?.pendingDroppedBytes || 0) > 0 ? `drop ${formatBytes(streamStatus?.pendingDroppedBytes)}` : "",
            [
              Number(counters.input || 0) ? `in ${counters.input}` : "",
              Number(counters.provisional || 0) ? `live ${counters.provisional}` : "",
              Number(counters.transcript || 0) ? `vad ${counters.transcript}` : "",
              Number(counters.context || 0) ? `ctx ${counters.context}` : "",
              Number(counters.dialog || 0) ? `dlg ${counters.dialog}` : "",
            ].filter(Boolean).join(" / "),
          ]);
          return (
            <Card key={agent.key} className="overflow-hidden shadow-none">
              <CardHeader className="border-b border-border px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 truncate text-base">
                      <Headset className="h-4 w-4 text-sky-700" />
                      {agent.label}
                    </CardTitle>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                      {lane.session?.metadata?.phone ? <span>phone {lane.session.metadata.phone}</span> : null}
                      {lane.waitingCall?.phone ? <span>phone {lane.waitingCall.phone}</span> : null}
                      {lane.session?.metadata?.caseId ? <span>case {lane.session.metadata.caseId}</span> : null}
                      {lane.waitingCall?.caseId ? <span>case {lane.waitingCall.caseId}</span> : null}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                      lane.stageTone === "good" && "border-emerald-200 bg-emerald-50 text-emerald-700",
                      lane.stageTone === "live" && "border-sky-200 bg-sky-50 text-sky-700",
                      lane.stageTone === "warn" && "border-amber-200 bg-amber-50 text-amber-700",
                      lane.stageTone === "danger" && "border-red-200 bg-red-50 text-red-700",
                      lane.stageTone === "idle" && "border-border bg-muted text-muted-foreground",
                    )}
                  >
                    {lane.stage}
                  </span>
                </div>
                {lane.stageDetail ? (
                  <div className="mt-2 truncate text-xs text-muted-foreground">{lane.stageDetail}</div>
                ) : null}
              </CardHeader>
              <CardContent className="grid min-h-[680px] grid-rows-[auto_1fr_1fr_1.12fr] gap-3 bg-slate-50/70 p-3">
                <section className="rounded-md border border-border bg-white p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Pipeline
                    </h2>
                    <StatusPill tone={lane.diagnostics.length ? "info" : "neutral"}>
                      {lane.diagnostics.length ? `${lane.diagnostics.length} events` : "quiet"}
                    </StatusPill>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {diagnosticPills.length ? diagnosticPills.map((pill) => (
                      <span key={pill} className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {pill}
                      </span>
                    )) : (
                      <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        no session metadata
                      </span>
                    )}
                  </div>
                  <div className="mt-2 space-y-1">
                    {lane.diagnostics.length ? lane.diagnostics.slice(-5).reverse().map((event) => (
                      <div key={event.id} className="flex items-center gap-2 rounded-md border border-border bg-slate-50 px-2 py-1 text-[11px]">
                        <span className={cn("rounded-full border px-1.5 py-0.5 font-semibold uppercase tracking-[0.08em]", toneClasses(event.tone))}>
                          {event.label}
                        </span>
                        <span className="shrink-0 text-muted-foreground">{formatTime(event.at)}</span>
                        {event.deltaMs ? <span className="shrink-0 text-muted-foreground">{formatDeltaMs(event.deltaMs)}</span> : null}
                        <span className="min-w-0 truncate text-slate-700">{event.detail || "event received"}</span>
                      </div>
                    )) : (
                      <div className="rounded-md border border-dashed border-border px-2 py-2 text-[11px] text-muted-foreground">
                        Waiting for stream diagnostics.
                      </div>
                    )}
                  </div>
                </section>

                <section className="rounded-md border border-border bg-white p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Transcript
                    </h2>
                    <StatusPill tone={lane.flash ? "danger" : visibleTranscript?.text ? "success" : "info"}>
                      {lane.flash ? "voicemail" : waitingForStream ? "stream missing" : visibleTranscript?.coachHeld ? "coaching this" : visibleTranscript?.text ? "heard" : lane.streamStatus ? "audio" : lane.waitingCall ? "waiting stream" : "waiting"}
                    </StatusPill>
                  </div>
                  <div
                    className={cn(
                      "min-h-[94px] whitespace-pre-wrap text-sm font-medium leading-snug",
                      !visibleTranscript?.text && "flex items-center text-muted-foreground",
                      lane.flash && "border-l-4 border-red-400 bg-red-50 px-2 py-1 text-red-800",
                    )}
                  >
                    {visibleTranscript?.text || (
                      waitingForStream
                        ? "Current CX call joined. Waiting for RingCX audio stream..."
                        : lane.streamStatus
                          ? "Prospect audio frames are arriving. Waiting for STT to release speech..."
                          : lane.waitingCall
                            ? "Call event received. Waiting for RingCX stream..."
                            : "Waiting for prospect speech..."
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {transcriptPills.map((pill) => (
                      <span key={pill} className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {pill}
                      </span>
                    ))}
                  </div>
                </section>

                <section className="rounded-md border border-border bg-white p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Context
                    </h2>
                    <StatusPill tone={lane.context?.shouldCompose ? "success" : lane.context ? "info" : "neutral"}>
                      {lane.context?.shouldCompose ? "mini kept" : lane.context ? "mini hold" : "waiting"}
                    </StatusPill>
                  </div>
                  <div className={cn("min-h-[94px] whitespace-pre-wrap text-xs leading-snug", !contextBody && "flex items-center text-muted-foreground")}>
                    {contextBody || "Waiting for mini context..."}
                  </div>
                </section>

                <section className="rounded-md border border-border bg-white p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-700">
                      Dialog
                    </h2>
                    <StatusPill tone={lane.dialog?.status === "ready" ? "success" : lane.dialog?.status === "streaming" ? "info" : "neutral"}>
                      {lane.dialog?.label || lane.dialog?.status || "waiting"}
                    </StatusPill>
                  </div>
                  <div className={cn("min-h-[118px] whitespace-pre-wrap text-base font-semibold leading-snug text-slate-950", !lane.dialog?.say && "flex items-center text-sm font-medium text-muted-foreground")}>
                    {lane.dialog?.say || (rejected ? "Call rejected for voicemail match." : "Coach line will appear here.")}
                  </div>
                  {lane.dialog?.guidance ? (
                    <div className="mt-2 text-[10px] text-muted-foreground">{lane.dialog.guidance}</div>
                  ) : null}
                </section>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="text-xs text-muted-foreground">
        Last refresh {updatedAt ? formatTime(updatedAt) : "not yet"}.
      </div>
    </div>
  );
}
