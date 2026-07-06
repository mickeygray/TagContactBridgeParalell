import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  CalendarClock,
  CalendarPlus,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Clock3,
  Mail,
  MessageCircleMore,
  Phone,
  PhoneOff,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { api } from "@/lib/api/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { CaseLink } from "@/components/ui/CaseLink";
import { consumeUiEvent } from "@/lib/events/consumeUiEvent";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Input, Label } from "@/components/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { StatusPill, toneFromStatus } from "@/components/ui/StatusPill";
import { toast } from "@/components/ui/Toaster";
import {
  useCxAssignCaseToMe,
  useCxCallQueue,
  useCxCallQueueMulti,
  useCxCaseActivities,
  useCxCaseInvoices,
  useCxCasePayments,
  useCxCaseTasks,
  useCxCallAppointmentNowAny,
  useCxCommLog,
  useCxCreateAppointment,
  useCxDialAny,
  useCxDisposition,
  useCxVoicemailDrop,
  useCxInterviewSnapshot,
  useCxLeadCandidates,
  useCxLeadLookup,
  useCxLogicsActivity,
  useCxLogicsAmortization,
  useCxLogicsInvoice,
  useCxLogicsTask,
  useCxLogicsUpdateCase,
  useCxReleaseAppointment,
  useCxSetStatus,
  useCxSimpleLoopAdvance,
  useCxSimpleLoopDisposition,
  useCxSimpleLoopKill,
  useCxSimpleLoopSession,
  useCxSimpleLoopSkip,
  useCxSimpleLoopStart,
  useCxSimulateCallAny,
  useCxWorkspace,
} from "@/lib/api/queries/cx";
import { useClientDetail } from "@/lib/api/queries/clients";
import type { CxSimpleLoopSession } from "@/lib/api/queries/cx";
import type {
  CxCallQueueItem,
  CxAppointment,
  CxLeadCandidate,
  CxLeadLookupMatch,
  CxLeadLookupSource,
  FreshLeadGate,
  WorkflowRecord,
} from "@/lib/api/types";
import type { CommLogEntry } from "@/lib/api/queries/cx";
import { KNOWN_DOMAINS, useDomainStore } from "@/lib/domain/domainStore";
import { useSession } from "@/lib/auth/useSession";
import { cn } from "@/lib/utils/cn";
import { AppointmentList as SharedAppointmentList } from "./AppointmentList";
import { LiveCoachPanel } from "./LiveCoachPanel";
import { CoachCockpit } from "@/workspaces/live-coach/CoachCockpit";

const LIVE_COACH_PANEL_ENABLED = ["1", "true", "yes", "on"].includes(
  String(import.meta.env.VITE_LIVE_COACH_PANEL_ENABLED || "").trim().toLowerCase(),
);
// The new Focus Card cockpit, default-OFF. Needs the coach panel too (it resolves the
// current call's session id, which the cockpit streams). Drive with no model spend by booting
// the ai-bus with LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED=1 LIVE_COACH_BATCH_TRANSPORT=stub.
const LIVE_COACH_COCKPIT_ENABLED = ["1", "true", "yes", "on"].includes(
  String(import.meta.env.VITE_LIVE_COACH_COCKPIT_ENABLED || "").trim().toLowerCase(),
);
const CX_VOICEMAIL_BUTTON_ENABLED = !["0", "false", "no", "off", "disabled"].includes(
  String(import.meta.env.VITE_CX_VOICEMAIL_BUTTON_ENABLED || "true").trim().toLowerCase(),
);
const CX_SIMPLE_LOOP_PANEL_ENV_ENABLED = ["1", "true", "yes", "on"].includes(
  String(import.meta.env.VITE_CX_SIMPLE_LOOP_PANEL_ENABLED || "").trim().toLowerCase(),
);
const CX_SIMPLE_LOOP_PANEL_EMAILS = new Set(
  String(import.meta.env.VITE_CX_SIMPLE_LOOP_PANEL_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

type ContactContext = {
  caseId?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  status?: string | null;
  source?: string | null;
  note?: string | null;
  // "ex" = call landed on the agent's RingCentral EX desk app (typical
  // for general inbound to a TAG ext number). "cx" = call routed via
  // the CX queue / cadence dialer (typical WYNN-domain). The lookup
  // ladder uses this to pick the fallback order: EX → [TAG, WYNN],
  // CX → [WYNN, TAG]. Optional — when missing, defaults to the
  // operator's primary tenant.
  channel?: "ex" | "cx" | null;
  // RingCentral telephony session id (or sim-XXXX for simulator). Used
  // as the "fresh call" trigger — same phone calling on a new session
  // (e.g. CX→EX re-scramble of the same number) bumps this and forces
  // a clean reset of the form/selection state.
  sessionId?: string | null;
  interviewSnapshot?: Record<string, unknown> | null;
};

type CaseForm = {
  firstName: string;
  lastName: string;
  ssn: string;
  email: string;
  cellPhone: string;        // primary phone
  homePhone: string;        // secondary phone
  // Spouse fields — kept on the case so we can run full onboarding
  // here without bouncing into Logics. Logics' updateCase passes
  // unknown fields through; missing ones land as no-ops.
  spouseFirstName: string;
  spouseLastName: string;
  spouseSsn: string;
  spouseEmail: string;
  spouseCellPhone: string;
  spouseHomePhone: string;
  // Legacy source field — still preserved for the lookup ladder + Logics
  // create payload, but no longer surfaced in the identity strip.
  sourceName: string;
  caseId: string;
};

type CaseFormField = keyof CaseForm;
type CaseFormDirty = Record<CaseFormField, boolean>;
type QueueAdvanceTransition = {
  title: string;
  description: string;
  blocking: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function isCxNextDialAccepted(result: unknown) {
  const row = asRecord(result);
  const nextDial = asRecord(row.nextDial);
  if (Object.keys(nextDial).length === 0) return false;
  const activeCallCapture = asRecord(nextDial.activeCallCapture);
  const hasConfirmedCall =
    Boolean(readString(nextDial, "uii", "callSessionId", "rcxUii")) ||
    Boolean(readString(activeCallCapture, "uii", "callSessionId", "rcxUii")) ||
    nextDial.confirmedCall === true;
  if (nextDial.accepted === true && hasConfirmedCall) return true;
  if (nextDial.ok === true && hasConfirmedCall) return true;
  const status = String(nextDial.status || "").trim().toLowerCase();
  return ["accepted", "dialing"].includes(status) && hasConfirmedCall;
}

function isCxNextDialQueuedButUnconfirmed(result: unknown) {
  if (isCxNextDialAccepted(result)) return false;
  const row = asRecord(result);
  const nextDial = asRecord(row.nextDial);
  if (Object.keys(nextDial).length === 0) return false;
  if (nextDial.accepted === false || nextDial.ok === false) return false;
  const status = String(nextDial.status || "").trim().toLowerCase();
  return (
    nextDial.queued === true ||
    nextDial.pending === true ||
    ["queued", "pending"].includes(status)
  );
}

function normalizeComparablePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function readCxSimpleLoopPanelEnabled(userIdentifier?: string | null) {
  void CX_SIMPLE_LOOP_PANEL_ENV_ENABLED;
  void CX_SIMPLE_LOOP_PANEL_EMAILS;
  void userIdentifier;
  return false;
}

function describeSimpleLoopCurrent(session: CxSimpleLoopSession | null | undefined) {
  const current = session?.current;
  if (!current) return "No current call";
  const bits = [
    current.name || "Unknown",
    current.caseId ? `case ${current.caseId}` : null,
    current.phoneLast4 ? `***${current.phoneLast4}` : null,
    current.phase || current.status || null,
    current.uii ? `UII ${current.uii}` : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

type SimpleLoopDisposition = "answered" | "did-not-answer" | "voicemail";

function describeSimpleLoopMatch(session: CxSimpleLoopSession | null | undefined) {
  const current = session?.current;
  if (!current) return null;
  const activeCallSummary = current.activeCallSummary || {};
  const reasons = Array.isArray(current.matchReasons) ? current.matchReasons.filter(Boolean) : [];
  const bits = [
    activeCallSummary.state ? `CX ${String(activeCallSummary.state)}` : null,
    reasons.length > 0 ? `match ${reasons.join("+")}` : null,
    current.activeEvidenceAt ? `seen ${String(current.activeEvidenceAt).slice(11, 19)}` : null,
  ].filter(Boolean);
  return bits.length > 0 ? bits.join(" · ") : null;
}

function describeSimpleLoopLastCompleted(session: CxSimpleLoopSession | null | undefined) {
  const completed = Array.isArray(session?.completed) ? session.completed : [];
  const last = completed[completed.length - 1];
  if (!last) return null;
  const dispositionResult = last.dispositionResult || {};
  const status =
    dispositionResult.dispositionStatus ||
    dispositionResult.hangupStatus ||
    dispositionResult.reason ||
    last.outcome ||
    "completed";
  return `Last: ${last.name || "Unknown"} · ${last.outcome || "done"} · ${String(status)}`;
}

function SimpleLoopTestPanel({
  session,
  isLoading,
  isFetching,
  error,
  mode,
  setMode,
  limit,
  setLimit,
  reverse,
  setReverse,
  isBusy,
  onStart,
  onStartAndDial,
  onAdvance,
  onDisposition,
  onSkip,
  onKill,
  onRefresh,
}: {
  session: CxSimpleLoopSession | null | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  mode: "single" | "bulk-mirror";
  setMode: (mode: "single" | "bulk-mirror") => void;
  limit: number;
  setLimit: (limit: number) => void;
  reverse: boolean;
  setReverse: (reverse: boolean) => void;
  isBusy: boolean;
  onStart: () => void;
  onStartAndDial: () => void;
  onAdvance: () => void;
  onDisposition: (outcome: SimpleLoopDisposition) => void;
  onSkip: () => void;
  onKill: () => void;
  onRefresh: () => void;
}) {
  const current = session?.current || null;
  const bufferCount = Array.isArray(session?.queue) ? session.queue.length : 0;
  const completedCount = Array.isArray(session?.completed) ? session.completed.length : 0;
  const matchDescription = describeSimpleLoopMatch(session);
  const lastCompletedDescription = describeSimpleLoopLastCompleted(session);
  const events = Array.isArray(session?.events) ? session.events.slice(-5).reverse() : [];
  const statusTone =
    session?.status === "running"
      ? "success"
      : session?.status === "paused"
        ? "warning"
        : session?.status
          ? "neutral"
          : "info";

  return (
    <Card className="mb-3 border-sky-500/30 bg-sky-500/5">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Simple loop test</CardTitle>
          <StatusPill tone={statusTone} dotted>
            {session?.status || (isLoading ? "loading" : "ready")}
          </StatusPill>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Local harness: queue → current → completed. Enable with <span className="font-mono">?cxSimpleLoop=1</span>.
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-[1fr_72px] gap-2">
          <Select value={mode} onValueChange={(value) => setMode(value === "bulk-mirror" ? "bulk-mirror" : "single")}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* M11 gate 11: the legacy "bulk-mirror" mode is the old queue-mirror bulk path (no
                  reservation service) — it is NOT the new reservation-backed bulk rail and is no
                  longer user-selectable. Single publish only. */}
              <SelectItem value="single">Single publish</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="number"
            min={1}
            max={50}
            value={String(limit)}
            onChange={(event) => setLimit(Math.max(1, Math.min(50, Number(event.target.value) || 1)))}
            className="h-8 text-xs"
            title="Target CX buffer size"
          />
        </div>

        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={reverse}
            onChange={(event) => setReverse(event.target.checked)}
          />
          Reverse queue before publish
        </label>

        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" isLoading={isBusy && !session} disabled={isBusy} onClick={onStart}>
            Start
          </Button>
          <Button size="sm" variant="secondary" isLoading={isBusy && !session} disabled={isBusy} onClick={onStartAndDial}>
            Start + dial
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-2">
          <Button size="sm" variant="secondary" isLoading={isBusy && Boolean(session)} disabled={isBusy || !session} onClick={onAdvance}>
            {mode === "bulk-mirror" ? "Mirror/watch" : "Advance"}
          </Button>
        </div>

        <div className="rounded-md border border-border/70 bg-card/70 p-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Current
          </div>
          <div className="mt-1 text-xs text-foreground">
            {describeSimpleLoopCurrent(session)}
          </div>
          {matchDescription ? (
            <div className="mt-1 text-[10px] text-muted-foreground">
              {matchDescription}
            </div>
          ) : null}
          <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
            <span>Buffer {bufferCount}</span>
            <span>·</span>
            <span>Done {completedCount}</span>
            {isFetching ? (
              <>
                <span>·</span>
                <span>polling</span>
              </>
            ) : null}
          </div>
          {lastCompletedDescription ? (
            <div className="mt-1 truncate text-[10px] text-muted-foreground">
              {lastCompletedDescription}
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <Button size="sm" variant="secondary" disabled={isBusy || !current} onClick={() => onDisposition("answered")}>
            Answer
          </Button>
          <Button size="sm" variant="secondary" disabled={isBusy || !current} onClick={() => onDisposition("did-not-answer")}>
            No ans
          </Button>
          <Button size="sm" variant="secondary" disabled={isBusy || !current} onClick={() => onDisposition("voicemail")}>
            VM
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <Button size="sm" variant="ghost" disabled={isBusy || !current} onClick={onSkip}>
            Skip
          </Button>
          <Button size="sm" variant="ghost" disabled={isBusy} onClick={onRefresh}>
            Refresh
          </Button>
          <Button size="sm" variant="destructive" disabled={isBusy || !session} onClick={onKill}>
            Kill
          </Button>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive">
            {error instanceof Error ? error.message : "Simple loop request failed"}
          </div>
        ) : null}

        {events.length > 0 ? (
          <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Last events
            </div>
            {events.map((event, index) => (
              <div key={`${String(event.type || "event")}-${String(event.at || index)}`} className="truncate text-[10px] text-muted-foreground">
                {String(event.at || "").slice(11, 19)} · {String(event.type || "event")}
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function contactFromQueue(item: CxCallQueueItem): ContactContext {
  const snapshot = asRecord(item.payloadSnapshot);
  const leadBody = asRecord(item.leadBody);
  const merged = Object.keys(leadBody).length > 0 ? { ...snapshot, ...leadBody } : snapshot;
  return {
    caseId: item.caseId || readString(merged, "caseId"),
    name: readString(merged, "name", "fullName", "contactName"),
    phone: readString(merged, "phone", "cellPhone", "number"),
    email: readString(merged, "email"),
    source: item.intakeSource || readString(merged, "source", "intakeSource", "sourceName"),
    note: item.nextActionType || undefined,
    channel: "cx",
    interviewSnapshot: item.interviewSnapshot || null,
  };
}

function buildQueueDialRequest(item: CxCallQueueItem, domain: string, contact: ContactContext) {
  const snapshot = asRecord(item.payloadSnapshot);
  const leadBody = asRecord(item.leadBody);
  const merged = Object.keys(leadBody).length > 0 ? { ...snapshot, ...leadBody } : snapshot;
  const queueDomain = String(item.domain || domain || "TAG").trim().toUpperCase();
  return {
    phone: contact.phone || null,
    caseId: contact.caseId || null,
    name: contact.name || null,
    contactName: contact.name || null,
    email: contact.email || null,
    queueKey: buildQueueItemKey(item),
    queueActionKey: extractQueueActionKey(item),
    queueTicketId: item.queueTicketId || null,
    queueItemId: item.queueTicketId || null,
    queueState: item.queueState || null,
    queueFamily: item.queueFamily || null,
    progressiveStageKey: item.progressiveStageKey || null,
    progressiveStageLabel: item.progressiveStageLabel || null,
    assignedExtensionId: item.assignedExtensionId || null,
    assignedAgentName: item.assignedAgentName || null,
    intakeSource: item.intakeSource || readString(merged, "intakeSource", "source") || null,
    intakeRoute: item.intakeRoute || readString(merged, "intakeRoute") || null,
    sourceName: readString(merged, "sourceName", "source", "sourceLabel") || null,
    queueDomain,
    notes: contact.name ? `Queue: ${contact.name}` : null,
    requestedBySurface: "cx-queue-card",
    leadSnapshot: {
      name: contact.name || null,
      phone: contact.phone || null,
      email: contact.email || null,
      sourceName: readString(merged, "sourceName", "source", "sourceLabel") || null,
      intakeSource: item.intakeSource || readString(merged, "intakeSource", "source") || null,
      intakeRoute: item.intakeRoute || readString(merged, "intakeRoute") || null,
    },
  };
}

function phoneValuesCouldMatch(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  const a = normalizeComparablePhone(left);
  const b = normalizeComparablePhone(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && (a.endsWith(b) || b.endsWith(a));
}

function contactFromCurrentCall(raw: Record<string, unknown> | null | undefined): ContactContext | null {
  if (!raw) return null;
  // For inbound calls the lead's phone is `from` (caller); for outbound
  // it's `to` (callee). The snapshot stores both, so pick by direction
  // — otherwise the lookup ladder ends up scrambling against the
  // agent's own DID.
  const direction = String(readString(raw, "direction") || "").toLowerCase();
  const isOutbound = direction === "outbound";
  const explicitFrom = readString(raw, "from", "ani", "sourcePhone", "callerId");
  const explicitTo = readString(raw, "to", "destination", "destinationPhone", "leadPhone", "dnis");
  const genericPhone = readString(raw, "phone", "phoneNumber");
  const genericMatchesFrom =
    Boolean(genericPhone) &&
    Boolean(explicitFrom) &&
    phoneValuesCouldMatch(genericPhone, explicitFrom);
  const phone =
    (isOutbound
      ? explicitTo || (genericMatchesFrom ? "" : genericPhone) || explicitFrom
      : explicitFrom || genericPhone || explicitTo);
  const rawChannel = String(readString(raw, "channel") || "").toLowerCase();
  const channel: "ex" | "cx" | null =
    rawChannel === "ex" ? "ex" : rawChannel === "cx" ? "cx" : null;
  return {
    caseId: readString(raw, "caseId"),
    name: readString(raw, "name", "contactName", "customerName", "fromName"),
    phone,
    email: readString(raw, "email"),
    status: readString(raw, "status", "callStatus"),
    source: readString(raw, "source"),
    note: direction || null,
    channel,
    sessionId: readString(raw, "sessionId", "telephonySessionId"),
  };
}

const INTERNAL_EX_CALLER_NUMBERS = new Set(["8773622426"]);
const INTERNAL_EX_CALLER_NAME_MARKERS = [
  "tax group",
  "tax advocate group",
  "wynn tax",
  "wynn tax solutions",
];

function collectAgentShellPhones(...shellGroups: unknown[]) {
  const phones = new Set<string>();
  for (const group of shellGroups) {
    const shells = Array.isArray(group) ? group : group ? [group] : [];
    for (const shell of shells) {
      const record = asRecord(shell);
      const primary = normalizeComparablePhone(readString(record, "primaryPhone", "phone", "phoneNumber"));
      if (primary) phones.add(primary);
      const loginPhones = Array.isArray(record.loginPhones) ? record.loginPhones : [];
      for (const phone of loginPhones) {
        const normalized = normalizeComparablePhone(String(phone || ""));
        if (normalized) phones.add(normalized);
      }
    }
  }
  return Array.from(phones);
}

function isInternalExShellCurrentCall(
  raw: Record<string, unknown> | null | undefined,
  agentShellPhones: string[],
) {
  if (!raw) return false;
  const channel = String(readString(raw, "channel") || "").trim().toLowerCase();
  if (channel !== "ex") return false;

  const toPhone = normalizeComparablePhone(readString(raw, "to", "dnis"));
  const shellPhoneSet = new Set(agentShellPhones.map(normalizeComparablePhone).filter(Boolean));
  const landsOnAgentShell = Boolean(toPhone && shellPhoneSet.has(toPhone));
  if (!landsOnAgentShell) return false;

  const fromPhone = normalizeComparablePhone(readString(raw, "from", "ani", "phone"));
  const fromName = readString(raw, "fromName", "name", "contactName").toLowerCase();
  const fromLooksInternal =
    INTERNAL_EX_CALLER_NUMBERS.has(fromPhone) ||
    INTERNAL_EX_CALLER_NAME_MARKERS.some((marker) => fromName.includes(marker));

  return fromLooksInternal;
}

type QueueFamilyKey = "fresh-day1" | "fresh-day2to10" | "fresh-day16to30" | "aged" | "dead" | "unassigned";

type QueueFamilyDisplay = {
  label: string;
  sortRank: number;
  dotClassName: string;
};

const AUTO_SERVE_DELAY_SECONDS = 1;
const AUTO_SERVE_HANDOFF_DELAY_SECONDS = 0;
const AUTO_SERVE_STARTUP_DELAY_SECONDS = 8;
const AUTO_SERVE_RETRY_DELAY_SECONDS = 5;
const BACKEND_NEXT_DIAL_HANDOFF_HOLD_MS = 10_000;
// Last-resort watchdog for the app disposition side of the VM flow. The
// RingCX voicemail request is fired in the background; the queue disposition
// owns the button lifecycle so agents are not held on playback/release.
const VOICEMAIL_DROP_WATCHDOG_MS = 180_000;
const DISPOSITION_NEXT_LEAD_DELAY_SECONDS = 2;
const NO_ANSWER_NEXT_LEAD_DELAY_SECONDS = 8;
const DEFER_DISPOSITION_NEXT_DIAL = true;
const QUEUE_RESTORE_DEBOUNCE_MS = 8_000;
const STALE_SERVED_QUEUE_RESET_MS = 20_000;
const SHOW_POSTDATE_DISPOSITION = true;
type AutoServeCountdownMode = "startup" | "next";
type ResumePromptBreakType = "short-break" | "meal-break" | string;
const AUTO_SERVE_BLOCKED_AGENT_STATES = new Set([
  "dialing",
  "dispositioning",
  "offline",
  "oncall",
  "ringing",
  "unavailable",
]);

const QUEUE_FAMILY_DISPLAY: Record<QueueFamilyKey, QueueFamilyDisplay> = {
  "fresh-day1": {
    label: "New",
    sortRank: 0,
    dotClassName: "bg-emerald-500",
  },
  "fresh-day2to10": {
    label: "3-15",
    sortRank: 1,
    dotClassName: "bg-sky-500",
  },
  "fresh-day16to30": {
    label: "16-30",
    sortRank: 2,
    dotClassName: "bg-amber-500",
  },
  aged: {
    label: "31-120",
    sortRank: 3,
    dotClassName: "bg-red-500",
  },
  dead: {
    label: "Dead",
    sortRank: 4,
    dotClassName: "bg-zinc-500",
  },
  unassigned: {
    label: "Other",
    sortRank: 5,
    dotClassName: "bg-muted-foreground",
  },
};

const QUEUE_LEGEND_FAMILIES: QueueFamilyKey[] = ["fresh-day1", "fresh-day2to10", "fresh-day16to30", "aged"];

function cxTimingEnabled(): boolean {
  try {
    if (window.location.search.includes("cxdebug=1")) return true;
    return window.localStorage.getItem("tcbCxTiming") === "1";
  } catch {
    return false;
  }
}

function emitCxTiming(event: string, meta: Record<string, unknown> = {}): void {
  if (!cxTimingEnabled()) return;
  const payload = {
    event,
    at: new Date().toISOString(),
    ...meta,
  };
  try {
    const timeline = ((window as unknown as { __tcbCxTimeline?: unknown[] }).__tcbCxTimeline ?? []) as unknown[];
    timeline.push(payload);
    (window as unknown as { __tcbCxTimeline?: unknown[] }).__tcbCxTimeline = timeline.slice(-250);
  } catch {
    /* best-effort local debugging only */
  }
  console.info("tcb.cx.timing", payload);
}

function normalizeQueueFamily(raw: string | null | undefined): QueueFamilyKey | null {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return null;
  if (
    value === "fresh-day1"
    || value === "day0"
    || value === "day1"
    || value === "fresh"
    || value === "hot"
    || value === "new"
    || value === "green"
    || value === "just_came_in"
    || value === "second_contact"
    || value === "third_contact"
    || value.includes("second-contact")
    || value.includes("third-contact")
  ) {
    return "fresh-day1";
  }
  if (
    value === "fresh-day2to10"
    || value === "fresh-day2to15"
    || value === "day2to10"
    || value === "day2to15"
    || value === "day2_10"
    || value === "day2_15"
    || value === "day10"
    || value === "day15"
    || value === "blue"
    || value.includes("day 2")
    || value.includes("day2")
    || value.includes("2-10")
    || value.includes("2-15")
  ) {
    return "fresh-day2to10";
  }
  if (
    value === "fresh-day16to30"
    || value === "day16to30"
    || value === "day16_30"
    || value === "yellow"
    || value.includes("16-30")
    || value.includes("day16")
  ) {
    return "fresh-day16to30";
  }
  if (value === "aged" || value === "red" || value.includes("aged") || value.includes("prospect")) {
    return "aged";
  }
  if (value === "dead" || value === "expired" || value.includes("do-not-dial")) {
    return "dead";
  }
  return null;
}

function inferQueueFamily(item: CxCallQueueItem): QueueFamilyKey {
  const snapshot = asRecord(item.payloadSnapshot);
  const leadBody = asRecord(item.leadBody);
  const merged = Object.keys(leadBody).length > 0 ? { ...snapshot, ...leadBody } : snapshot;
  const explicit =
    normalizeQueueFamily(item.queueFamily)
    || normalizeQueueFamily(item.ageBucket)
    || normalizeQueueFamily(readString(merged, "queueFamily", "queueTier", "leadQueueFamily"))
    || normalizeQueueFamily(item.currentStage)
    || normalizeQueueFamily(item.nextActionType);
  if (explicit) return explicit;

  const activeDayRaw = merged.callPlan && typeof merged.callPlan === "object"
    ? asRecord(merged.callPlan).activeDay
    : item.queueDayIndex;
  const activeDay = Number(activeDayRaw);
  if (Number.isFinite(activeDay)) {
    if (activeDay <= 2) return "fresh-day1";
    if (activeDay <= 15) return "fresh-day2to10";
    if (activeDay <= 30) return "fresh-day16to30";
    if (activeDay > 120) return "dead";
    return "aged";
  }

  const intakeSource = String(item.intakeSource || readString(merged, "intakeSource", "sourceName")).toLowerCase();
  if (intakeSource.includes("aged") || intakeSource.includes("prospect")) {
    return "aged";
  }

  return "unassigned";
}

function readQueuePlacedCalls(item: CxCallQueueItem) {
  const snapshot = asRecord(item.payloadSnapshot);
  const leadBody = asRecord(item.leadBody);
  const metadata = asRecord(snapshot.metadata);
  const direct = Number(item.placedCalls ?? leadBody.placedCalls ?? snapshot.placedCalls ?? metadata.placedCalls ?? 0);
  return Number.isFinite(direct) ? Math.max(direct, 0) : 0;
}

function isFreshFirstContactQueueItem(item: CxCallQueueItem) {
  const family = inferQueueFamily(item);
  if (family !== "fresh-day1") return false;
  const stageIndex = Number(item.progressiveStageIndex);
  if (Number.isFinite(stageIndex) && stageIndex > 0) return false;
  return readQueuePlacedCalls(item) <= 0;
}

function getPacificHourKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}T${lookup.hour}`;
}

function readQueueHourlyPlacedCalls(item: CxCallQueueItem, now = new Date()) {
  const snapshot = asRecord(item.payloadSnapshot);
  const leadBody = asRecord(item.leadBody);
  const metadata = asRecord(snapshot.metadata);
  const hourKey = getPacificHourKey(now);
  const itemHourKey = String(
    item.hourlyPlacedHourKey
      ?? leadBody.hourlyPlacedHourKey
      ?? snapshot.hourlyPlacedHourKey
      ?? metadata.hourlyPlacedHourKey
      ?? "",
  ).trim();
  if (itemHourKey !== hourKey) return 0;
  const count = Number(
    item.hourlyPlacedCalls
      ?? leadBody.hourlyPlacedCalls
      ?? snapshot.hourlyPlacedCalls
      ?? metadata.hourlyPlacedCalls
      ?? 0,
  );
  return Number.isFinite(count) ? Math.max(Math.trunc(count), 0) : 0;
}

function getQueueSortRank(item: CxCallQueueItem, now = new Date()) {
  const family = inferQueueFamily(item);
  if (family === "fresh-day1") {
    if (isFreshFirstContactQueueItem(item)) return 0;
    return readQueueHourlyPlacedCalls(item, now) >= 2 ? 1 : 0.5;
  }
  return QUEUE_FAMILY_DISPLAY[family].sortRank;
}

function buildQueueItemKey(item: CxCallQueueItem) {
  const contact = contactFromQueue(item);
  const itemDomain = String(item.domain || "domain").trim().toUpperCase();
  if (item.queueTicketId) return `${itemDomain}:queue:${item.queueTicketId}`;
  return [
    itemDomain,
    item.caseId || contact.caseId || "queue",
    extractQueueActionKey(item) || "no-action-key",
    contact.phone || "no-phone",
    item.nextActionAt || "no-next-action",
  ].join(":");
}

function getQueueItemSuppressionKeys(item: CxCallQueueItem) {
  const keys = new Set<string>();
  const itemDomain = String(item.domain || "domain").trim().toUpperCase();
  const ticketId = String(item.queueTicketId || "").trim();
  if (ticketId) keys.add(`${itemDomain}:queue:${ticketId}`);
  keys.add(buildQueueItemKey(item));
  const actionKey = extractQueueActionKey(item);
  if (item.caseId && actionKey) keys.add(`${itemDomain}:case:${item.caseId}:action:${actionKey}`);
  return Array.from(keys).filter(Boolean);
}

function pruneQueueSuppressionMap(
  entries: Record<string, number>,
  now = Date.now(),
) {
  const next: Record<string, number> = {};
  for (const [key, expiresAt] of Object.entries(entries)) {
    if (Number(expiresAt) > now) next[key] = Number(expiresAt);
  }
  return next;
}

function extractTerminalOutcomeWorkflow(record: WorkflowRecord | null | undefined) {
  if (!record) return null;
  if (record.family !== "cx" || record.subtype !== "terminal-call-outcome") return null;
  if (record.stage !== "completed") return null;
  const result = asRecord(record.result);
  const classification = asRecord(result.classification);
  const normalizedOutcome = String(classification.normalizedOutcome || "").trim().toLowerCase();
  if (!["did_not_connect", "voicemail"].includes(normalizedOutcome)) return null;
  const queueItemId = String(record.aggregateId || "").trim();
  return {
    workflowId: String(record._id || `${record.aggregateId || "terminal"}:${record.createdAt || record.happenedAt || ""}`),
    queueItemId,
    caseId: record.caseId != null ? String(record.caseId) : "",
    normalizedOutcome,
    label: normalizedOutcome === "voicemail" ? "Voicemail" : "No answer",
    uii: String(result.uii || "").trim() || null,
    callSessionId: String(result.callSessionId || "").trim() || null,
  };
}

function humanizeCxRoutingReason(reason: string | null | undefined) {
  const value = String(reason || "").trim().toLowerCase();
  if (!value) return "";
  if (value === "ex-busy") return "auto-blocked by EX activity";
  if (value === "manual-unavailable") return "manually paused";
  if (value === "manual-available") return "manually resumed";
  if (value === "long-call-hold") return "long call pause";
  if (value === "cx-call-ended") return "call ended";
  if (value === "ex-idle") return "ready for CX leads";
  if (value === "cx-routing-disabled") return "routing not enabled";
  return value.replace(/[-_]+/g, " ");
}

function extractQueueActionKey(item: CxCallQueueItem) {
  return readString(asRecord(item.cxAction), "key") || null;
}

function getQueueSourceLine(item: CxCallQueueItem) {
  const snapshot = asRecord(item.payloadSnapshot);
  const leadBody = asRecord(item.leadBody);
  const merged = Object.keys(leadBody).length > 0 ? { ...snapshot, ...leadBody } : snapshot;
  return item.intakeSource || readString(merged, "intakeSource", "sourceName", "source") || item.intakeRoute || "";
}

function CxQueueLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
      {QUEUE_LEGEND_FAMILIES.map((family) => {
        const display = QUEUE_FAMILY_DISPLAY[family];
        return (
          <span key={family} className="inline-flex items-center gap-1.5">
            <span
              className={cn("h-2 w-2 rounded-full", display.dotClassName)}
              aria-hidden="true"
            />
            <span>{display.label}</span>
          </span>
        );
      })}
    </div>
  );
}

function AutoServeCountdown({
  remaining,
  totalSeconds = AUTO_SERVE_DELAY_SECONDS,
  mode = "next",
}: {
  remaining: number | null;
  totalSeconds?: number;
  mode?: AutoServeCountdownMode;
}) {
  const safeTotal = Math.max(1, Number(totalSeconds) || AUTO_SERVE_DELAY_SECONDS);
  const safeRemaining = Math.max(0, Math.min(safeTotal, Number(remaining ?? safeTotal)));
  const progress = Math.max(0, Math.min(100, ((safeTotal - safeRemaining) / safeTotal) * 100));
  const isStartup = mode === "startup";

  return (
    <div className="overflow-hidden rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
            <span className="absolute inset-0 animate-ping rounded-full bg-primary/30" />
            <span className="relative">{safeRemaining}</span>
          </span>
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-foreground">
              {isStartup ? `Your day begins in ${safeRemaining}s` : `Next call in ${safeRemaining}s`}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {isStartup
                ? "Make sure your headset and RingCentral are ready."
                : "Auto serve is preparing the next lead."}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-primary/15">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-linear"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

function BreakResumePrompt({
  open,
  breakType,
  remaining,
  isResuming,
  isSigningOut,
  onResume,
  onSignOut,
}: {
  open: boolean;
  breakType: ResumePromptBreakType;
  remaining: number | null;
  isResuming: boolean;
  isSigningOut: boolean;
  onResume: () => void;
  onSignOut: () => void;
}) {
  const safeRemaining = Math.max(0, Number(remaining ?? 0));
  const title = breakType === "meal-break" ? "15 minute break" : "5 minute break";
  const minutes = Math.floor(safeRemaining / 60);
  const seconds = safeRemaining % 60;
  const display = `${minutes}:${String(seconds).padStart(2, "0")}`;

  return (
    <Dialog open={open}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Resume work</DialogTitle>
          <DialogDescription>
            {title} is running. Resume before the timer ends or this session signs out and releases your leads.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-primary/25 bg-primary/5 px-3 py-3">
          <div className="text-[11px] font-semibold uppercase text-muted-foreground">
            Time remaining
          </div>
          <div className="mt-1 text-3xl font-semibold tabular-nums text-foreground">
            {display}
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={isResuming || isSigningOut}
            onClick={onSignOut}
          >
            Sign out
          </Button>
          <Button
            type="button"
            variant="primary"
            isLoading={isResuming}
            disabled={isSigningOut}
            onClick={onResume}
          >
            Resume work
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CxQueueList({
  items,
  selectedCaseId,
  servingQueueKey,
  clickDisabled = false,
  onSelect,
}: {
  items: CxCallQueueItem[];
  selectedCaseId: string | null | undefined;
  servingQueueKey: string | null;
  clickDisabled?: boolean;
  onSelect: (item: CxCallQueueItem) => void | Promise<void>;
}) {
  return (
    <div className="space-y-1.5">
      {items.map((item, idx) => {
        const key = buildQueueItemKey(item);
        const contact = contactFromQueue(item);
        const family = inferQueueFamily(item);
        const familyDisplay = QUEUE_FAMILY_DISPLAY[family];
        const domainStyle = getDomainBadgeStyle(item.domain);
        const caseId = contact.caseId || item.caseId || "";
        const caseLabel = caseId ? `${domainStyle.label} ${caseId}` : domainStyle.label;
        const sourceLine = getQueueSourceLine(item) || item.nextActionType || "";
        const isActive = contact.caseId && contact.caseId === selectedCaseId;
        const isServing = servingQueueKey === key;

        return (
          <button
            key={`${key}:${idx}`}
            type="button"
            onClick={() => {
              if (!clickDisabled) void onSelect(item);
            }}
            aria-disabled={clickDisabled}
            title={clickDisabled ? "Auto serve is on" : undefined}
            className={cn(
              "w-full rounded-md border border-border bg-card px-2.5 py-2 text-left transition-colors hover:bg-muted/40",
              isActive && "border-primary bg-primary/5",
              isServing && "border-primary/70 ring-1 ring-primary/30",
              clickDisabled && "cursor-default hover:bg-card",
            )}
          >
            <div className="flex items-start gap-2">
              <span
                className={cn(
                  "mt-1 h-2.5 w-2.5 shrink-0 rounded-full",
                  familyDisplay.dotClassName,
                )}
                title={familyDisplay.label}
                aria-label={familyDisplay.label}
              />
              <div className="min-w-0 flex-1">
                <div className="break-words text-[13px] font-medium leading-tight text-foreground">
                  {contact.name || contact.phone || (caseId ? `Case ${caseId}` : "Queued lead")}
                </div>
                <div className="truncate text-[11px] leading-tight text-muted-foreground">
                  {contact.phone || sourceLine || "No phone"}
                </div>
              </div>
              <div className="mt-0.5 max-w-[86px] shrink-0 text-right text-[10px] font-semibold uppercase leading-tight text-muted-foreground">
                {caseLabel}
              </div>
            </div>
            {isServing ? (
              <div className="mt-1 text-[10px] font-medium text-primary">dialing...</div>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function ActiveQueueLeadCard({
  contact,
  domain,
  onSelect,
}: {
  contact: ContactContext;
  domain: string | null;
  onSelect: () => void;
}) {
  const normalizedDomain = String(domain || contact.source || "").trim().toUpperCase();
  const domainStyle = getDomainBadgeStyle(normalizedDomain);
  const caseLabel = contact.caseId
    ? `${domainStyle.label} ${contact.caseId}`
    : domainStyle.label || "Current lead";

  return (
    <button
      type="button"
      onClick={onSelect}
      className="mb-2 w-full rounded-md border border-primary/60 bg-primary/5 px-2.5 py-2 text-left ring-1 ring-primary/20 transition-colors hover:bg-primary/10"
    >
      <div className="flex items-start gap-2">
        <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase leading-tight text-primary">
            Current lead
          </div>
          <div className="break-words text-[13px] font-medium leading-tight text-foreground">
            {contact.name || contact.phone || (contact.caseId ? `Case ${contact.caseId}` : "Queue lead")}
          </div>
          <div className="truncate text-[11px] leading-tight text-muted-foreground">
            {contact.phone || "No phone"}
          </div>
        </div>
        <div className="mt-0.5 max-w-[86px] shrink-0 text-right text-[10px] font-semibold uppercase leading-tight text-muted-foreground">
          {caseLabel}
        </div>
      </div>
    </button>
  );
}

// Fold a lookup match into the form while preserving any field the
// operator has flagged as dirty. Fields the match doesn't supply are
// left alone (we don't blank out typed values just because the match
// row has a null email).
function applyLookupToForm(
  prev: CaseForm,
  dirty: CaseFormDirty,
  match: CxLeadLookupMatch,
): CaseForm {
  // Fully REPLACE non-dirty fields with the new match — including
  // wiping fields the new match doesn't have. Otherwise stale data
  // from a prior lookup bleeds in (e.g. previous match's email
  // sticking around when a new caller's record doesn't carry one).
  // Operator-typed (dirty) fields stay untouched.
  const next = { ...prev };
  const fill = (field: CaseFormField, value: string | number | null | undefined) => {
    if (dirty[field]) return;
    next[field] =
      value === null || value === undefined ? "" : String(value);
  };
  fill("firstName", match.firstName);
  fill("lastName", match.lastName);
  fill("cellPhone", match.phone);
  fill("email", match.email);
  fill("sourceName", match.sourceName);
  fill("caseId", match.caseId);
  return next;
}

function sourceBadgeFor(source: CxLeadLookupSource | null):
  | { label: string; tone: "accent" | "info" | "warning" | "neutral" }
  | null {
  if (source === "caseProfile") return { label: "CaseProfile", tone: "accent" };
  if (source === "masterProspect") return { label: "MasterProspect", tone: "info" };
  if (source === "leadCadence") return { label: "LeadCadence", tone: "warning" };
  if (source === "logics") return { label: "Logics", tone: "neutral" };
  if (source === "none") return { label: "New prospect", tone: "neutral" };
  return null;
}

// ─── Collapsible section shell ──────────────────────────────────────────────

function formatAppointmentDateTime(value?: string | null) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toDateInputValue(date = new Date(Date.now() + 60 * 60 * 1000)) {
  const rounded = roundToNextQuarterHour(date);
  const year = rounded.getFullYear();
  const month = String(rounded.getMonth() + 1).padStart(2, "0");
  const day = String(rounded.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function roundToNextQuarterHour(date = new Date()) {
  const rounded = new Date(date);
  const minutes = Math.ceil(rounded.getMinutes() / 15) * 15;
  rounded.setMinutes(minutes, 0, 0);
  return rounded;
}

function toTimeInputValue(date = new Date(Date.now() + 60 * 60 * 1000)) {
  const rounded = roundToNextQuarterHour(date);
  return `${String(rounded.getHours()).padStart(2, "0")}:${String(rounded.getMinutes()).padStart(2, "0")}`;
}

type CollapsibleProps = {
  title: string;
  open: boolean;
  onToggle: () => void;
  right?: React.ReactNode;
  children: React.ReactNode;
};

function Collapsible({ title, open, onToggle, right, children }: CollapsibleProps) {
  return (
    <Card>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left hover:bg-muted/40"
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-sm font-semibold text-foreground">{title}</span>
        </div>
        {right}
      </button>
      {open ? <div className="border-t border-border">{children}</div> : null}
    </Card>
  );
}

type AppointmentModalProps = {
  open: boolean;
  onClose: () => void;
  caseId: string | null;
  prospectName: string;
  phone: string;
  sourceName: string;
  isLoading: boolean;
  canPostdate: boolean;
  canAssign: boolean;
  onSubmit: (payload: {
    appointmentDate?: string;
    appointmentTime?: string;
    appointmentTimezone?: string;
    assignToMe?: boolean;
    postdate?: boolean;
    note?: string;
  }) => void;
};

function AppointmentModal({
  open,
  onClose,
  caseId,
  prospectName,
  phone,
  sourceName,
  isLoading,
  canPostdate,
  canAssign,
  onSubmit,
}: AppointmentModalProps) {
  const [date, setDate] = React.useState(toDateInputValue());
  const [time, setTime] = React.useState(toTimeInputValue());
  const [timezone, setTimezone] = React.useState("America/Los_Angeles");
  const [assignToMe, setAssignToMe] = React.useState(false);
  const [postdate, setPostdate] = React.useState(false);
  const [note, setNote] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    const next = new Date(Date.now() + 60 * 60 * 1000);
    setDate(toDateInputValue(next));
    setTime(toTimeInputValue(next));
    setTimezone("America/Los_Angeles");
    setAssignToMe(false);
    setPostdate(false);
    setNote("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : null)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Set appointment</DialogTitle>
          <DialogDescription>
            Reserve this lead for your queue, pause normal dialing until the appointment time, then move to the next lead.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
            <div className="text-sm font-medium text-foreground">
              {prospectName || "Current lead"}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{caseId ? `Case ${caseId}` : "No case loaded"}</span>
              {phone ? <span>{phone}</span> : null}
              {sourceName ? <span>{sourceName}</span> : null}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Time</Label>
              <Input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Timezone</Label>
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="America/Los_Angeles">Pacific</SelectItem>
                  <SelectItem value="America/Denver">Mountain</SelectItem>
                  <SelectItem value="America/Chicago">Central</SelectItem>
                  <SelectItem value="America/New_York">Eastern</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {(canAssign || canPostdate) ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {canAssign ? (
                <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={assignToMe}
                    onChange={(event) => setAssignToMe(event.target.checked)}
                    className="h-4 w-4 accent-primary"
                  />
                  <span>Assign to me</span>
                </label>
              ) : null}
              {canPostdate ? (
                <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={postdate}
                    onChange={(event) => setPostdate(event.target.checked)}
                    className="h-4 w-4 accent-primary"
                  />
                  <span>Postdate</span>
                </label>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label>Note</Label>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Optional appointment context"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            isLoading={isLoading}
            disabled={!caseId || !date || !time}
            onClick={() =>
              onSubmit({
                appointmentDate: date,
                appointmentTime: time,
                appointmentTimezone: timezone,
                assignToMe,
                postdate,
                note: note.trim() || undefined,
              })
            }
          >
            Set appointment and next lead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AppointmentList({
  appointments,
  onCallNow,
  onRelease,
  callingAppointmentId,
  isReleasing,
  isCallingNow,
}: {
  appointments: CxAppointment[];
  onCallNow: (appointment: CxAppointment) => void;
  onRelease: (appointment: CxAppointment) => void;
  callingAppointmentId?: string | null;
  isReleasing: boolean;
  isCallingNow: boolean;
}) {
  const visible = (appointments || []).filter((appointment) =>
    ["scheduled", "due", "fired", "blocked"].includes(String(appointment.status || "")),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <CalendarClock className="h-4 w-4" />
          Appointments
        </CardTitle>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
            No scheduled callbacks.
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map((appointment) => (
              <div
                key={appointment.appointmentId}
                className="rounded-md border border-border bg-card/50 p-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-foreground">
                      {appointment.prospectName || `Case ${appointment.caseId}`}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {formatAppointmentDateTime(appointment.legalDialAt || appointment.appointmentAt)}
                    </div>
                  </div>
                  <StatusPill tone={appointment.status === "blocked" ? "warning" : "info"}>
                    {appointment.status}
                  </StatusPill>
                </div>
                <div className="mt-1 truncate text-[11px] text-muted-foreground">
                  Case {appointment.caseId}
                  {appointment.phone ? ` | ${appointment.phone}` : ""}
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!appointment.phone || isCallingNow}
                    isLoading={isCallingNow && callingAppointmentId === appointment.appointmentId}
                    onClick={() => onCallNow(appointment)}
                  >
                    <Phone className="h-3.5 w-3.5" />
                    Call now
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isReleasing}
                    onClick={() => onRelease(appointment)}
                  >
                    Release
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Expandable list ────────────────────────────────────────────────────────

function ExpandableList<T>({
  items,
  initial = 8,
  render,
  emptyLabel,
}: {
  items: T[];
  initial?: number;
  render: (item: T, idx: number) => React.ReactNode;
  emptyLabel: string;
}) {
  const [expanded, setExpanded] = React.useState(false);
  if (!items.length) {
    return <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">{emptyLabel}</div>;
  }
  const visible = expanded ? items : items.slice(0, initial);
  return (
    <div className="space-y-2">
      {visible.map((item, idx) => render(item, idx))}
      {items.length > initial ? (
        <button
          type="button"
          className="text-xs font-medium text-primary hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : `Show all ${items.length}`}
        </button>
      ) : null}
    </div>
  );
}

// Per-domain brand accent for the CX domain switcher. CX agents don't
// have the sidebar DomainSwitcher (roles scope them out of admin chrome),
// so the top bar needs both the visual reminder AND the flip control.
// The dropdown is gated to domains where the logged-in agent has a
// Logics pairing (tagLogicsId / wynnLogicsId on their UA) — an agent
// who only works TAG gets a read-only badge; an agent paired to both
// sees both in the dropdown.
const DOMAIN_BADGE_STYLES: Record<string, { label: string; className: string }> = {
  TAG: {
    label: "TAG",
    className:
      "border-orange-500/40 bg-orange-500/15 text-orange-700 hover:bg-orange-500/25 dark:text-orange-300",
  },
  WYNN: {
    label: "WYNN",
    className:
      "border-blue-500/40 bg-blue-500/15 text-blue-700 hover:bg-blue-500/25 dark:text-blue-300",
  },
  AMITY: {
    label: "AMITY",
    className:
      "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300",
  },
};

function getDomainBadgeStyle(domain: string) {
  const key = String(domain || "").toUpperCase();
  return (
    DOMAIN_BADGE_STYLES[key] || {
      label: key || "—",
      className: "border-border bg-muted text-muted-foreground hover:bg-muted/80",
    }
  );
}

function CxDomainSwitcher({
  domain,
  availableDomains,
  onChange,
}: {
  domain: string;
  availableDomains: string[];
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const current = getDomainBadgeStyle(domain);
  const canSwap = availableDomains.length > 1;

  React.useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Read-only badge when the agent has exactly one domain paired —
  // don't show a dropdown they can't use.
  if (!canSwap) {
    return (
      <span
        className={cn(
          "inline-flex h-9 items-center rounded-md border px-3 text-xs font-semibold uppercase tracking-wider",
          current.className,
        )}
        title={`You are operating in the ${current.label} tenant. All sends, dispositions, and Logics actions target this domain.`}
      >
        {current.label}
      </span>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-semibold uppercase tracking-wider transition-colors",
          current.className,
        )}
        title="Switch between TAG and Wynn — every send and Logics action targets the selected tenant."
      >
        {current.label}
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-40 mt-1 min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-lg">
          {availableDomains.map((d) => {
            const style = getDomainBadgeStyle(d);
            const active = d === domain;
            return (
              <button
                key={d}
                type="button"
                onClick={() => {
                  onChange(d);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wider hover:bg-muted",
                  active && "bg-muted",
                )}
              >
                <span>{style.label}</span>
                {active ? (
                  <span className="text-[10px] font-normal text-muted-foreground">active</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ─── Logics workspace helpers ───────────────────────────────────────────────

function formatMaybeDate(value: unknown): string {
  if (!value) return "—";
  if (typeof value !== "string" && typeof value !== "number") return "—";
  try {
    const d = new Date(value as string | number);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString();
  } catch {
    return String(value);
  }
}

// Pull a flat array out of a Logics passthrough response. Shape varies,
// so we try the common shapes (`{ result: { data: [...] } }`, `{ data: [...] }`,
// a raw array) and fall back to `[]`.
function extractPassthroughList(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  const outer = asRecord(data);
  const result = asRecord(outer.result);
  // Logics envelopes use capital `Data`; our route passthroughs use
  // lowercase `data`. Try both at every nesting level so the helper
  // works whether the server pre-extracted or not.
  const candidates = [
    result.data,
    result.Data,
    outer.data,
    outer.Data,
    result.items,
    outer.items,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as Array<Record<string, unknown>>;
  }
  return [];
}

// ─── Tasks subsection ───────────────────────────────────────────────────────

function TasksSubsection({
  domain,
  resolvedCaseId,
}: {
  domain: string;
  resolvedCaseId: string;
}) {
  // Per-case Logics tasks. Replaces the old agent-scoped useCxTasks
  // (which was showing the operator's own tasks across all cases).
  const tasks = useCxCaseTasks(domain, Number(resolvedCaseId));
  const createTask = useCxLogicsTask(domain);

  const [subject, setSubject] = React.useState("");
  const [dueDate, setDueDate] = React.useState("");
  const [reminderAt, setReminderAt] = React.useState("");
  const [taskType, setTaskType] = React.useState("1");
  const [endDate, setEndDate] = React.useState("");
  const [comments, setComments] = React.useState("");

  const rows = React.useMemo(() => {
    try {
      return extractPassthroughList(tasks.data);
    } catch {
      return [] as Array<Record<string, unknown>>;
    }
  }, [tasks.data]);

  async function handleSubmit() {
    if (!subject.trim() || !dueDate || !reminderAt) return;
    try {
      await createTask.mutateAsync({
        caseId: resolvedCaseId,
        subject,
        dueDate,
        reminderAt,
        taskType: Number(taskType) || 1,
        endDate: taskType === "2" ? endDate : undefined,
        comments,
      });
      setSubject("");
      setDueDate("");
      setReminderAt("");
      setTaskType("1");
      setEndDate("");
      setComments("");
      tasks.refetch();
      toast("Task queued", { description: "Logics task create was accepted." });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Something went wrong.";
      toast.error("Task failed", { description: msg });
    }
  }

  const [addOpen, setAddOpen] = React.useState(false);

  return (
    <div className="space-y-2 p-3">
      {tasks.isLoading ? (
        <div className="text-[11px] text-muted-foreground">Loading tasks…</div>
      ) : null}
      <ExpandableList
        items={rows}
        initial={5}
        emptyLabel="No tasks on this case yet."
        render={(row, idx) => {
          const subjectText =
            readString(row, "Subject", "subject", "Title", "title") ||
            `Task ${idx + 1}`;
          const when =
            row.DueDate ?? row.dueDate ?? row.ReminderDate ?? row.reminderAt;
          return (
            <div
              key={String(row.ID ?? row.id ?? idx)}
              className="rounded-md border border-border bg-card/50 px-2 py-1.5 text-xs"
            >
              <div className="font-medium text-foreground">{subjectText}</div>
              <div className="text-[11px] text-muted-foreground">
                Due: {formatMaybeDate(when)}
              </div>
            </div>
          );
        }}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          variant={addOpen ? "ghost" : "secondary"}
          onClick={() => setAddOpen((v) => !v)}
        >
          {addOpen ? "Cancel" : "+ Add task"}
        </Button>
      </div>
      {addOpen ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/20 p-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label>Subject</Label>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Follow up with client"
              />
            </div>
            <div className="space-y-1">
              <Label>Due date</Label>
              <Input
                type="datetime-local"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Reminder</Label>
              <Input
                type="datetime-local"
                value={reminderAt}
                onChange={(e) => setReminderAt(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Type</Label>
              <Select value={taskType} onValueChange={setTaskType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Task</SelectItem>
                  <SelectItem value="2">Event</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {taskType === "2" ? (
              <div className="space-y-1">
                <Label>End date</Label>
                <Input
                  type="datetime-local"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            ) : null}
            <div className="space-y-1 sm:col-span-2">
              <Label>Comments</Label>
              <textarea
                className="min-h-[50px] w-full rounded-md border border-input bg-card px-2 py-1.5 text-xs"
                value={comments}
                onChange={(e) => setComments(e.target.value)}
                placeholder="Optional details..."
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              isLoading={createTask.isPending}
              disabled={!subject.trim() || !dueDate || !reminderAt}
              onClick={async () => {
                await handleSubmit();
                setAddOpen(false);
              }}
            >
              Create task
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Activities subsection ──────────────────────────────────────────────────

// ─── ActivityCard ───────────────────────────────────────────────────────────
//
// One activity from Logics, rendered as an expandable card.
//
// Expanded state shows the full `Comment` field (Logics free-form text,
// often multiline). Operator can append a new comment without clobbering
// the existing one — we read the current Comment locally, prepend a
// timestamp-stamped block, and POST the merged text via updateActivity
// (with `activityId` set). The backend executor stamps the actor name
// onto whatever we send, so the audit trail stays intact.
//
// Empty Comment is fine — append produces a single block with the new
// text; nothing to preserve.
function ActivityCard({
  row,
  caseId,
  domain,
  agentLabel,
  onAfterAppend,
}: {
  row: Record<string, unknown>;
  caseId: string;
  domain: string;
  agentLabel: string;
  onAfterAppend?: () => void;
}) {
  const append = useCxLogicsActivity(domain);
  const [expanded, setExpanded] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const [appendText, setAppendText] = React.useState("");

  const activityId = row.ID ?? row.id ?? row.ActivityID;
  const subjectText =
    readString(row, "Subject", "subject", "Title", "title") || "Activity";
  const typeText =
    readString(row, "ActivityType", "activityType", "Type", "type") || "activity";
  const when = row.CreatedDate ?? row.createdAt ?? row.Date ?? row.date;
  const existingComment =
    readString(row, "Comment", "comment", "Notes", "notes") || "";

  async function handleAppend() {
    if (!appendText.trim()) return;
    // One clean, signed entry, placed BELOW the existing comment (newest
    // at the bottom — chronological reading order). Body first,
    // signature underneath, dashed rule top + bottom — same frame the
    // backend uses on create.
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
    const RULE = "------------------------------";
    const newBlock = `${RULE}\n${appendText.trim()}\n— ${agentLabel} @ ${stamp}\n${RULE}`;
    const merged = existingComment.trim()
      ? `${existingComment}\n\n${newBlock}`
      : newBlock;
    try {
      await append.mutateAsync({
        caseId,
        activityId: activityId != null ? Number(activityId) : undefined,
        comment: merged,
      });
      setAppendText("");
      setAddOpen(false);
      toast("Comment appended", {
        description: "Logics activity update was accepted.",
      });
      onAfterAppend?.();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Something went wrong.";
      toast.error("Append failed", { description: msg });
    }
  }

  return (
    <div className="rounded-md border border-border bg-card/50 text-xs">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-muted/30"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">{subjectText}</div>
          <div className="text-[11px] text-muted-foreground">
            {formatMaybeDate(when)}
          </div>
        </div>
        <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {typeText}
        </span>
      </button>
      {expanded ? (
        <div className="space-y-2 border-t border-border bg-card/30 p-2">
          {existingComment ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 text-[11px] text-foreground">
              {existingComment}
            </pre>
          ) : (
            <div className="rounded-md border border-dashed border-border p-2 text-[11px] text-muted-foreground">
              No comments on this activity yet.
            </div>
          )}
          {addOpen ? (
            <div className="space-y-2">
              <textarea
                className="min-h-[50px] w-full rounded-md border border-input bg-card px-2 py-1.5 text-xs"
                value={appendText}
                onChange={(e) => setAppendText(e.target.value)}
                placeholder="Append a comment — existing content is preserved."
                autoFocus
              />
              <div className="flex justify-end gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAddOpen(false);
                    setAppendText("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  isLoading={append.isPending}
                  disabled={!appendText.trim()}
                  onClick={handleAppend}
                >
                  Append
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setAddOpen(true)}
              >
                + Add comment
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ActivitiesSubsection({
  domain,
  resolvedCaseId,
}: {
  domain: string;
  resolvedCaseId: string;
}) {
  const activities = useCxCaseActivities(domain, Number(resolvedCaseId));
  const createActivity = useCxLogicsActivity(domain);
  // Used to sign each appended comment so the chain shows the real CX
  // agent — Logics' own wrapper just says "Public API" since we auth
  // as a service account.
  const { user } = useSession();
  const agentLabel = user?.name || user?.email || "CX agent";

  const [activityType, setActivityType] = React.useState("General");
  const [subject, setSubject] = React.useState("");
  const [note, setNote] = React.useState("");

  const rows = React.useMemo(() => {
    try {
      return extractPassthroughList(activities.data);
    } catch {
      return [] as Array<Record<string, unknown>>;
    }
  }, [activities.data]);

  async function handleCreate() {
    if (!subject.trim() && !note.trim()) return;
    try {
      await createActivity.mutateAsync({
        caseId: resolvedCaseId,
        activityType,
        subject,
        note,
      });
      setSubject("");
      setNote("");
      activities.refetch();
      toast("Activity created", {
        description: "Logics activity create was accepted.",
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Something went wrong.";
      toast.error("Activity failed", { description: msg });
    }
  }

  const [addOpen, setAddOpen] = React.useState(false);

  return (
    <div className="space-y-2 p-3">
      {activities.isLoading ? (
        <div className="text-[11px] text-muted-foreground">Loading activities…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-2 text-[11px] text-muted-foreground">
          No activities on this case yet.
        </div>
      ) : (
        <ExpandableList
          items={rows}
          initial={5}
          emptyLabel="No activities on this case yet."
          render={(row, idx) => (
            <ActivityCard
              key={String(row.ID ?? row.id ?? idx)}
              row={row}
              caseId={resolvedCaseId}
              domain={domain}
              agentLabel={agentLabel}
              onAfterAppend={() => activities.refetch()}
            />
          )}
        />
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant={addOpen ? "ghost" : "secondary"}
          onClick={() => setAddOpen((v) => !v)}
        >
          {addOpen ? "Cancel" : "+ New activity"}
        </Button>
      </div>
      {addOpen ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/20 p-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Activity type</Label>
              <Input
                value={activityType}
                onChange={(e) => setActivityType(e.target.value)}
                placeholder="General"
              />
            </div>
            <div className="space-y-1">
              <Label>Subject</Label>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Short summary"
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Note</Label>
              <textarea
                className="min-h-[50px] w-full rounded-md border border-input bg-card px-2 py-1.5 text-xs"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Detail..."
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              isLoading={createActivity.isPending}
              disabled={!subject.trim() && !note.trim()}
              onClick={async () => {
                await handleCreate();
                setAddOpen(false);
              }}
            >
              Create activity
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Invoices subsection ────────────────────────────────────────────────────

function InvoicesSubsection({
  domain,
  resolvedCaseId,
}: {
  domain: string;
  resolvedCaseId: string;
}) {
  const invoices = useCxCaseInvoices(domain, Number(resolvedCaseId));
  const createInvoice = useCxLogicsInvoice(domain);

  const [invoiceTypeName, setInvoiceTypeName] = React.useState("Other Fee");
  const [unitPrice, setUnitPrice] = React.useState("");
  const [quantity, setQuantity] = React.useState("1");
  const [date, setDate] = React.useState(() => {
    const now = new Date();
    return now.toISOString().slice(0, 10);
  });
  const [description, setDescription] = React.useState("");

  const rows = React.useMemo(() => {
    try {
      return extractPassthroughList(invoices.data);
    } catch {
      return [] as Array<Record<string, unknown>>;
    }
  }, [invoices.data]);

  async function handleSubmit() {
    const unitPriceNum = Number(unitPrice);
    if (!Number.isFinite(unitPriceNum)) return;
    try {
      await createInvoice.mutateAsync({
        caseId: resolvedCaseId,
        invoiceTypeName,
        unitPrice: unitPriceNum,
        quantity: Number(quantity) || 1,
        date,
        description,
      });
      setUnitPrice("");
      setQuantity("1");
      setDescription("");
      invoices.refetch();
      toast("Invoice queued", { description: "Logics invoice create was accepted." });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Something went wrong.";
      toast.error("Invoice failed", { description: msg });
    }
  }

  const [addOpen, setAddOpen] = React.useState(false);

  return (
    <div className="space-y-2 p-3">
      <ExpandableList
        items={rows}
        initial={5}
        emptyLabel="No invoices on this case yet."
        render={(row, idx) => {
          const typeText =
            readString(row, "InvoiceTypeName", "invoiceTypeName", "Type", "type") ||
            "Invoice";
          const priceRaw =
            row.UnitPrice ?? row.unitPrice ?? row.Amount ?? row.amount;
          const price =
            typeof priceRaw === "number"
              ? `$${priceRaw.toFixed(2)}`
              : priceRaw != null
                ? String(priceRaw)
                : "—";
          const when = row.Date ?? row.date ?? row.CreatedDate;
          return (
            <div
              key={String(row.ID ?? row.id ?? idx)}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/50 px-2 py-1.5 text-xs"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{typeText}</div>
                <div className="text-[11px] text-muted-foreground">
                  {formatMaybeDate(when)}
                </div>
              </div>
              <div className="text-sm font-semibold text-foreground">{price}</div>
            </div>
          );
        }}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          variant={addOpen ? "ghost" : "secondary"}
          onClick={() => setAddOpen((v) => !v)}
        >
          {addOpen ? "Cancel" : "+ Add invoice"}
        </Button>
      </div>
      {addOpen ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/20 p-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label>Invoice type</Label>
              <Input
                value={invoiceTypeName}
                onChange={(e) => setInvoiceTypeName(e.target.value)}
                placeholder="Other Fee"
              />
            </div>
            <div className="space-y-1">
              <Label>Unit price</Label>
              <Input
                type="number"
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1">
              <Label>Quantity</Label>
              <Input
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Date</Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Description</Label>
              <textarea
                className="min-h-[50px] w-full rounded-md border border-input bg-card px-2 py-1.5 text-xs"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional details..."
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              isLoading={createInvoice.isPending}
              disabled={!unitPrice.trim()}
              onClick={async () => {
                await handleSubmit();
                setAddOpen(false);
              }}
            >
              Add invoice
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Amortization subsection ────────────────────────────────────────────────
//
// Same list-first / + Add toggle pattern as the others. Amortizations
// have no GET endpoint we use here, so the list shows whatever Logics
// returns when we POST/refresh — for now this is post-only with no
// historical reader (open question whether Logics exposes a read).
export function AmortizationSubsection({
  domain,
  resolvedCaseId,
}: {
  domain: string;
  resolvedCaseId: string;
}) {
  const createAmortization = useCxLogicsAmortization(domain);

  const [amount, setAmount] = React.useState("");
  const [scheduledDate, setScheduledDate] = React.useState("");
  const [frequency, setFrequency] = React.useState("monthly");
  const [installments, setInstallments] = React.useState("");
  const [addOpen, setAddOpen] = React.useState(false);

  async function handleSubmit() {
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || !scheduledDate) return;
    try {
      await createAmortization.mutateAsync({
        caseId: resolvedCaseId,
        amount: amountNum,
        scheduledDate,
        frequency,
        installments: installments ? Number(installments) : undefined,
      });
      setAmount("");
      setScheduledDate("");
      setFrequency("monthly");
      setInstallments("");
      toast("Amortization queued", {
        description: "Logics amortization create was accepted.",
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Something went wrong.";
      toast.error("Amortization failed", { description: msg });
    }
  }

  return (
    <div className="space-y-2 p-3">
      <div className="rounded-md border border-dashed border-border p-1.5 text-[11px] text-muted-foreground">
        No amortization reader available — schedule below to add one.
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          variant={addOpen ? "ghost" : "secondary"}
          onClick={() => setAddOpen((v) => !v)}
        >
          {addOpen ? "Cancel" : "+ Add amortization"}
        </Button>
      </div>
      {addOpen ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/20 p-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Amount</Label>
              <Input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1">
              <Label>Scheduled date</Label>
              <Input
                type="date"
                value={scheduledDate}
                onChange={(e) => setScheduledDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Frequency</Label>
              <Select value={frequency} onValueChange={setFrequency}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Biweekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Installments</Label>
              <Input
                type="number"
                value={installments}
                onChange={(e) => setInstallments(e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              isLoading={createAmortization.isPending}
              disabled={!amount.trim() || !scheduledDate}
              onClick={async () => {
                await handleSubmit();
                setAddOpen(false);
              }}
            >
              Create amortization
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Payments subsection (read-only) ────────────────────────────────────────
//
// CX agents see payment history but don't post payments here — that lives
// in finance. Pulled live from Logics getCasePayments.
function PaymentsSubsection({
  domain,
  resolvedCaseId,
}: {
  domain: string;
  resolvedCaseId: string;
}) {
  const payments = useCxCasePayments(domain, Number(resolvedCaseId));
  const rows = React.useMemo(() => {
    try {
      return extractPassthroughList(payments.data);
    } catch {
      return [] as Array<Record<string, unknown>>;
    }
  }, [payments.data]);

  const total = rows.reduce((sum, row) => {
    const raw = row.Amount ?? row.amount ?? row.PaymentAmount ?? row.paymentAmount;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);

  return (
    <div className="space-y-2 p-3">
      {rows.length > 0 ? (
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{rows.length} payment{rows.length === 1 ? "" : "s"}</span>
          <span className="font-medium text-foreground">${total.toFixed(2)} total</span>
        </div>
      ) : null}
      <ExpandableList
        items={rows}
        initial={5}
        emptyLabel="No payments on this case yet."
        render={(row, idx) => {
          const status =
            readString(row, "Status", "status", "PaymentStatus", "paymentStatus") || "";
          const amountRaw =
            row.Amount ?? row.amount ?? row.PaymentAmount ?? row.paymentAmount;
          const amount =
            typeof amountRaw === "number"
              ? `$${amountRaw.toFixed(2)}`
              : amountRaw != null
                ? String(amountRaw)
                : "—";
          const when =
            row.PaymentDate ?? row.paymentDate ?? row.Date ?? row.date ?? row.CreatedDate;
          return (
            <div
              key={String(row.ID ?? row.id ?? row.PaymentID ?? idx)}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/50 px-2 py-1.5 text-xs"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{amount}</div>
                <div className="text-[11px] text-muted-foreground">
                  {formatMaybeDate(when)}
                  {status ? ` · ${status}` : ""}
                </div>
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}

// ─── Logics workspace card (composes the four subsections) ──────────────────

// Tab header for compact merged panels.
function PanelTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 px-3 pt-2">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          className={cn(
            "rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors",
            active === tab.key
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted/40",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function CommLogSubsection({
  domain,
  resolvedCaseId,
  resolvedPhone,
}: {
  domain: string;
  resolvedCaseId: string;
  resolvedPhone: string | null;
}) {
  const caseIdNum = Number(resolvedCaseId);
  const log = useCxCommLog(domain, {
    caseId: caseIdNum > 0 ? caseIdNum : null,
    phone: resolvedPhone || null,
    limit: 200,
  });

  const entries = log.data?.entries || [];

  if (log.isLoading && entries.length === 0) {
    return <div className="p-3 text-[11px] text-muted-foreground">Loading communications...</div>;
  }
  if (entries.length === 0) {
    return (
      <div className="p-3">
        <div className="rounded-md border border-dashed border-border p-3 text-[11px] text-muted-foreground">
          No SMS, calls, or cadence attempts recorded for this {caseIdNum > 0 ? "case" : "phone"} yet.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 p-3">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <div>
          <span className="font-medium text-foreground">{log.data?.counts.total ?? 0}</span> entries
          {log.data?.counts.callLogs ? <> | {log.data.counts.callLogs} calls</> : null}
          {log.data?.counts.conversationMessages ? <> | {log.data.counts.conversationMessages} messages</> : null}
          {log.data?.counts.leadCadence ? <> | cadence active</> : null}
        </div>
        <button
          type="button"
          onClick={() => log.refetch()}
          disabled={log.isFetching}
          className="text-primary hover:underline disabled:opacity-50"
        >
          {log.isFetching ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      <ExpandableList
        items={entries}
        initial={10}
        emptyLabel="No communications yet."
        render={(entry: CommLogEntry, idx) => (
          <CommLogRow key={`${entry.refId || idx}:${entry.ts}`} entry={entry} />
        )}
      />
    </div>
  );
}

function CommLogRow({ entry }: { entry: CommLogEntry }) {
  const [expanded, setExpanded] = React.useState(false);
  const channelLabel = entry.channel.toUpperCase();
  const dirLabel =
    entry.direction === "inbound"
      ? "in"
      : entry.direction === "scheduled"
        ? "scheduled"
        : "out";
  const tone =
    entry.status === "failed" || entry.status === "no-answer"
      ? "text-destructive"
      : entry.direction === "inbound"
        ? "text-foreground"
        : "text-muted-foreground";
  const metadata = entry.metadata || {};
  const callDurationSec = Number(metadata.durationSeconds ?? metadata.durationSec ?? 0) || 0;
  const callSubject = typeof metadata.subject === "string" ? metadata.subject : null;
  const bodyPreview = entry.body
    ? entry.body.replace(/\s+/g, " ").trim().slice(0, 140)
    : entry.channel === "call" && callSubject
      ? callSubject
    : null;

  return (
    <div className="rounded-md border border-border bg-card/50 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start justify-between gap-2 px-2 py-1.5 text-left hover:bg-muted/30"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="rounded bg-muted px-1 py-0.5 font-mono uppercase tracking-wide text-muted-foreground">
              {channelLabel}
            </span>
            <span className={cn("font-medium", tone)}>{dirLabel}</span>
            <span className="text-muted-foreground">{formatMaybeDate(entry.ts)}</span>
            <span className="text-[10px] text-muted-foreground">| {entry.status}</span>
          </div>
          {bodyPreview ? (
            <div className="mt-0.5 truncate text-foreground">{bodyPreview}</div>
          ) : entry.channel === "call" && callDurationSec ? (
            <div className="mt-0.5 text-muted-foreground">
              {Math.round(callDurationSec)}s call
              {entry.actor?.name ? ` | ${entry.actor.name}` : ""}
            </div>
          ) : entry.actor?.name ? (
            <div className="mt-0.5 text-muted-foreground">{entry.actor.name}</div>
          ) : null}
        </div>
      </button>
      {expanded && entry.body ? (
        <div className="border-t border-border bg-card/30 p-2">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-[11px] text-foreground">
            {entry.body}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function LogicsWorkspaceCard({
  domain,
  resolvedCaseId,
  resolvedPhone,
}: {
  domain: string;
  resolvedCaseId: string;
  resolvedPhone: string | null;
}) {
  const [commLogOpen, setCommLogOpen] = React.useState(true);
  const [logicsInfoOpen, setLogicsInfoOpen] = React.useState(true);
  const [logicsInfoTab, setLogicsInfoTab] = React.useState<
    "activities" | "tasks" | "payments" | "invoices"
  >("activities");

  return (
    <div className="space-y-2">
      <Collapsible
        title="Communications"
        open={commLogOpen}
        onToggle={() => setCommLogOpen((v) => !v)}
      >
        <CommLogSubsection
          domain={domain}
          resolvedCaseId={resolvedCaseId}
          resolvedPhone={resolvedPhone}
        />
      </Collapsible>

      <Collapsible
        title="Logics info"
        open={logicsInfoOpen}
        onToggle={() => setLogicsInfoOpen((v) => !v)}
      >
        <PanelTabs
          tabs={[
            { key: "activities", label: "Activities" },
            { key: "tasks", label: "Tasks" },
            { key: "payments", label: "Payments" },
            { key: "invoices", label: "Invoices" },
          ]}
          active={logicsInfoTab}
          onChange={(k) => setLogicsInfoTab(k as typeof logicsInfoTab)}
        />
        {logicsInfoTab === "activities" ? (
          <ActivitiesSubsection domain={domain} resolvedCaseId={resolvedCaseId} />
        ) : logicsInfoTab === "tasks" ? (
          <TasksSubsection domain={domain} resolvedCaseId={resolvedCaseId} />
        ) : logicsInfoTab === "payments" ? (
          <PaymentsSubsection domain={domain} resolvedCaseId={resolvedCaseId} />
        ) : (
          <InvoicesSubsection domain={domain} resolvedCaseId={resolvedCaseId} />
        )}
      </Collapsible>
    </div>
  );
}

// ─── Main workspace ─────────────────────────────────────────────────────────

type InterviewSnapshotState = {
  debtAmount: string;
  irsDebt: boolean;
  stateDebt: boolean;
  taxProblems: Record<string, boolean>;
  receivedNotices: string;
  temperature: string;
  employment: string;
  filingStatus: string;
  unfiledYears: string;
  income: string;
  expenses: string;
  selectedFinancials: Record<string, boolean>;
  financials: Record<string, string>;
  flags: Record<string, boolean>;
  personalNotes: string;
};

type CoachAskSeed = {
  kind: string;
  label: string;
  lineText?: string;
};

type CoachAskContextBridge = {
  seedAsk: (seed: CoachAskSeed, mode?: "replace" | "append") => void;
  getDragProps: (seed: CoachAskSeed, mode?: "replace" | "append") => {
    draggable: true;
    onDragStart: (event: React.DragEvent<HTMLElement>) => void;
  };
  askPending: boolean;
  sessionReady: boolean;
};

const INTERVIEW_SNAPSHOT_DEFAULT: InterviewSnapshotState = {
  debtAmount: "",
  irsDebt: false,
  stateDebt: false,
  taxProblems: {},
  receivedNotices: "",
  temperature: "",
  employment: "",
  filingStatus: "",
  unfiledYears: "",
  income: "",
  expenses: "",
  selectedFinancials: {},
  financials: {},
  flags: {},
  personalNotes: "",
};

const INTERVIEW_TAX_PROBLEM_OPTIONS = [
  { key: "balanceDue", label: "Balance due" },
  { key: "unfiledReturns", label: "Unfiled returns" },
  { key: "payroll941", label: "Payroll / 941" },
  { key: "auditExam", label: "Audit / exam" },
  { key: "taxLien", label: "Tax lien" },
  { key: "bankLevy", label: "Bank levy" },
  { key: "wageGarnishment", label: "Wage garnishment" },
  { key: "penaltiesInterest", label: "Penalties / interest" },
  { key: "stateTax", label: "State tax issue" },
  { key: "1099SelfEmployed", label: "1099 / self-employed" },
];

const INTERVIEW_FINANCIAL_INFLOW_OPTIONS = [
  { key: "savings", label: "Savings", placeholder: "Savings amount" },
  { key: "checking", label: "Checking", placeholder: "Checking balance" },
  { key: "availableToday", label: "Available today", placeholder: "Available today" },
  { key: "homeValue", label: "Home value", placeholder: "Home value" },
  { key: "homeEquity", label: "Home equity", placeholder: "Home equity" },
  { key: "vehicleValue", label: "Vehicle value", placeholder: "Vehicle value" },
  { key: "familySupportAmount", label: "Family support", placeholder: "Family support amount" },
  { key: "businessRevenue", label: "Business revenue", placeholder: "Monthly business revenue" },
];

const INTERVIEW_FINANCIAL_OUTFLOW_OPTIONS = [
  { key: "paymentCapacity", label: "Payment capacity", placeholder: "Monthly payment capacity" },
  { key: "rentMortgagePayment", label: "Rent / mortgage payment", placeholder: "Monthly rent or mortgage" },
  { key: "mortgageBalance", label: "Mortgage balance", placeholder: "Mortgage balance" },
  { key: "vehiclePayment", label: "Vehicle payment", placeholder: "Vehicle payment" },
  { key: "medicalExpenses", label: "Medical expenses", placeholder: "Medical expenses" },
  { key: "payrollLiability", label: "Payroll liability", placeholder: "Payroll liability" },
];

const INTERVIEW_FINANCIAL_FIELD_OPTIONS = [
  ...INTERVIEW_FINANCIAL_INFLOW_OPTIONS,
  ...INTERVIEW_FINANCIAL_OUTFLOW_OPTIONS,
];

const INTERVIEW_FLAG_OPTIONS = [
  { key: "retiredFixedIncome", label: "Retired / fixed income" },
  { key: "dependents", label: "Has kids / dependents" },
  { key: "spouseInvolved", label: "Spouse involved" },
  { key: "singleParent", label: "Single parent / head of household" },
  { key: "recentJobLoss", label: "Recent job loss / hours cut" },
  { key: "medicalIssue", label: "Medical issue / disability" },
  { key: "caregiver", label: "Caregiver responsibilities" },
  { key: "transportation", label: "Vehicle / transportation need" },
  { key: "familySupport", label: "Family helping financially" },
];

function checkedLabels(
  options: Array<{ key: string; label: string }>,
  selected: Record<string, boolean> | undefined,
) {
  return options
    .filter((option) => selected?.[option.key])
    .map((option) => option.label);
}

function pushInterviewLine(lines: string[], key: string, value: string | null | undefined) {
  const clean = String(value || "").trim();
  if (!clean) return;
  lines.push(`${key}: ${clean}`);
}

function pushInterviewLines(lines: string[], key: string, values: Array<string | null | undefined>) {
  for (const value of values) pushInterviewLine(lines, key, value);
}

function normalizeInterviewSnapshotState(
  parsed: Partial<InterviewSnapshotState> & { debtType?: unknown; incomeSignal?: unknown },
): InterviewSnapshotState {
  const legacyTaxProblem = String((parsed as { debtType?: unknown }).debtType || "").trim();
  const legacyIncomeSignal = String((parsed as { incomeSignal?: unknown }).incomeSignal || "").trim();
  const migratedTaxProblems = { ...(parsed.taxProblems || {}) };
  if (legacyTaxProblem) {
    const legacyMatch = INTERVIEW_TAX_PROBLEM_OPTIONS.find(
      (option) => option.label.toLowerCase() === legacyTaxProblem.toLowerCase(),
    );
    if (legacyMatch) migratedTaxProblems[legacyMatch.key] = true;
  }
  const migratedSelectedFinancials =
    parsed.selectedFinancials && typeof parsed.selectedFinancials === "object"
      ? { ...parsed.selectedFinancials }
      : {};
  const migratedFinancials =
    parsed.financials && typeof parsed.financials === "object" ? { ...parsed.financials } : {};
  if (migratedSelectedFinancials.rentMortgage && !migratedSelectedFinancials.rentMortgagePayment) {
    migratedSelectedFinancials.rentMortgagePayment = true;
  }
  if (migratedFinancials.rentMortgage && !migratedFinancials.rentMortgagePayment) {
    migratedFinancials.rentMortgagePayment = migratedFinancials.rentMortgage;
  }
  return {
    ...INTERVIEW_SNAPSHOT_DEFAULT,
    ...parsed,
    income: parsed.income || legacyIncomeSignal,
    expenses: parsed.expenses || "",
    taxProblems: migratedTaxProblems,
    selectedFinancials: migratedSelectedFinancials,
    financials: migratedFinancials,
    flags: parsed.flags && typeof parsed.flags === "object" ? parsed.flags : {},
  };
}

function coerceStoredInterviewSnapshot(value: unknown): InterviewSnapshotState | null {
  const wrapper = asRecord(value);
  const nestedSnapshot = asRecord(wrapper.snapshot);
  const source = Object.keys(nestedSnapshot).length ? nestedSnapshot : wrapper;
  if (!Object.keys(source).length) return null;
  return normalizeInterviewSnapshotState(source as Partial<InterviewSnapshotState>);
}

function loadInterviewSnapshot(storageKey: string): InterviewSnapshotState {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return INTERVIEW_SNAPSHOT_DEFAULT;
    const parsed = JSON.parse(raw) as Partial<InterviewSnapshotState>;
    return normalizeInterviewSnapshotState(parsed);
  } catch {
    return INTERVIEW_SNAPSHOT_DEFAULT;
  }
}

function buildInterviewActivityNote(
  snapshot: InterviewSnapshotState,
  prospectName: string,
  caseId: string,
) {
  const selectedFlags = checkedLabels(INTERVIEW_FLAG_OPTIONS, snapshot.flags);
  const selectedTaxProblems = checkedLabels(INTERVIEW_TAX_PROBLEM_OPTIONS, snapshot.taxProblems);
  const financialLines = INTERVIEW_FINANCIAL_FIELD_OPTIONS
    .filter((option) => snapshot.selectedFinancials[option.key])
    .map((option) => {
      const value = String(snapshot.financials[option.key] || "").trim();
      return value ? `${option.label} - ${value}` : option.label;
    });
  const lines: string[] = [];
  pushInterviewLine(lines, "Note Type", "AI-assisted interview snapshot");
  pushInterviewLine(lines, "Prospect", prospectName);
  pushInterviewLine(lines, "Case ID", caseId);
  pushInterviewLine(lines, "Client Temperature", snapshot.temperature || "unknown");
  pushInterviewLines(lines, "Debt Jurisdiction", [
    snapshot.irsDebt ? "IRS debt" : "",
    snapshot.stateDebt ? "State debt" : "",
  ]);
  pushInterviewLines(lines, "Tax Problem", selectedTaxProblems);
  pushInterviewLine(lines, "Debt Amount", snapshot.debtAmount);
  pushInterviewLine(lines, "Received Notices", snapshot.receivedNotices);
  pushInterviewLine(lines, "Unfiled Years", snapshot.unfiledYears);
  pushInterviewLine(lines, "Employment", snapshot.employment);
  pushInterviewLine(lines, "Filing Status", snapshot.filingStatus);
  pushInterviewLine(lines, "Income", snapshot.income);
  pushInterviewLine(lines, "Expenses", snapshot.expenses);
  pushInterviewLines(lines, "Financial", financialLines);
  pushInterviewLines(lines, "Client Context", selectedFlags);
  pushInterviewLine(lines, "Personal / Pitch Notes", snapshot.personalNotes);
  pushInterviewLine(lines, "Source", "CX workspace interview panel");
  return lines.join("\n");
}

function CompactNativeSelect({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none ring-offset-background focus:border-primary focus:ring-2 focus:ring-primary/20"
    >
      {children}
    </select>
  );
}

type InterviewSnapshotTextField = {
  [K in keyof InterviewSnapshotState]: InterviewSnapshotState[K] extends string ? K : never;
}[keyof InterviewSnapshotState];

// Verbose labeled field: a clear question + its own entry. The tabbed layout
// trades the old dense grids for one-question-per-row clarity while the tabs
// keep the card compact on screen.
function InterviewField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-foreground">{label}</div>
      {hint ? <div className="text-[10px] text-muted-foreground">{hint}</div> : null}
      {children}
    </div>
  );
}

function InterviewCheckGrid({
  options,
  selected,
  onChange,
}: {
  options: Array<{ key: string; label: string }>;
  selected: Record<string, boolean> | undefined;
  onChange: (key: string, checked: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
      {options.map((option) => (
        <label key={option.key} className="flex cursor-pointer items-center gap-1.5 text-xs text-foreground">
          <input
            type="checkbox"
            checked={Boolean(selected?.[option.key])}
            onChange={(event) => onChange(option.key, event.target.checked)}
            className="h-3.5 w-3.5 rounded border-input"
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

function InterviewAskPills({
  askCoach,
  seeds,
}: {
  askCoach?: CoachAskContextBridge | null;
  seeds: CoachAskSeed[];
}) {
  if (!askCoach || !seeds.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {seeds.map((seed) => (
        <span
          key={`${seed.kind}:${seed.label}:${seed.lineText || ""}`}
          className="inline-flex overflow-hidden rounded-full border border-violet-200 bg-violet-50 text-[10px] font-medium text-violet-800"
        >
          <button
            type="button"
            className="px-2 py-0.5 transition-colors hover:bg-violet-100"
            title="Click to replace Ask context with this interview item, or drag it onto the Ask box."
            onClick={() => askCoach.seedAsk(seed, "replace")}
            {...askCoach.getDragProps(seed, "replace")}
          >
            Ask: {seed.label}
          </button>
          <button
            type="button"
            className="flex items-center border-l border-violet-200 px-1 transition-colors hover:bg-violet-100"
            title="Add this interview item as another Ask context."
            aria-label={`Add ${seed.label} to Ask context`}
            onClick={() => askCoach.seedAsk(seed, "append")}
          >
            <Plus className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

function InterviewSnapshotCard({
  domain,
  caseId,
  prospectName,
  phone,
  queueActionKey,
  queueItemId,
  queueTicketId,
  initialSnapshot,
  askCoach,
}: {
  domain: string;
  caseId: string;
  prospectName: string;
  phone?: string | null;
  queueActionKey?: string | null;
  queueItemId?: string | null;
  queueTicketId?: string | null;
  initialSnapshot?: Record<string, unknown> | null;
  askCoach?: CoachAskContextBridge | null;
}) {
  const storageKey = React.useMemo(
    () => `cx-interview-snapshot:${caseId || prospectName || "current"}`,
    [caseId, prospectName],
  );
  const initialSnapshotKey = React.useMemo(
    () => JSON.stringify(initialSnapshot || null),
    [initialSnapshot],
  );
  const storedSnapshot = React.useMemo(
    () => coerceStoredInterviewSnapshot(initialSnapshot),
    [initialSnapshotKey],
  );
  const [snapshot, setSnapshot] = React.useState<InterviewSnapshotState>(() => (
    storedSnapshot || loadInterviewSnapshot(storageKey)
  ));
  const [preview, setPreview] = React.useState("");
  const saveSnapshot = useCxInterviewSnapshot(domain);

  React.useEffect(() => {
    setSnapshot(storedSnapshot || loadInterviewSnapshot(storageKey));
    setPreview("");
  }, [storageKey, storedSnapshot]);

  React.useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(snapshot));
    } catch {
      // local snapshot persistence is best-effort only
    }
  }, [snapshot, storageKey]);

  const setField = (field: InterviewSnapshotTextField, value: string) => {
    setSnapshot((current) => ({ ...current, [field]: value }));
  };
  const setDebtFlag = (field: "irsDebt" | "stateDebt", checked: boolean) => {
    setSnapshot((current) => ({ ...current, [field]: checked }));
  };
  const setTaxProblem = (key: string, checked: boolean) => {
    setSnapshot((current) => ({
      ...current,
      taxProblems: { ...current.taxProblems, [key]: checked },
    }));
  };
  const setFinancialSelected = (key: string, checked: boolean) => {
    setSnapshot((current) => ({
      ...current,
      selectedFinancials: { ...current.selectedFinancials, [key]: checked },
    }));
  };
  const setFinancialValue = (key: string, value: string) => {
    setSnapshot((current) => ({
      ...current,
      financials: { ...current.financials, [key]: value },
    }));
  };
  const setFlag = (key: string, checked: boolean) => {
    setSnapshot((current) => ({
      ...current,
      flags: { ...current.flags, [key]: checked },
    }));
  };
  const buildPreview = () => {
    setPreview(buildInterviewActivityNote(snapshot, prospectName, caseId));
  };
  const saveToSystems = async () => {
    const normalizedCaseId = String(caseId || "").trim();
    if (!normalizedCaseId) {
      toast.error("Interview snapshot needs a case", {
        description: "Load or enter a Logics case before saving this snapshot.",
      });
      return;
    }
    const activityNote = buildInterviewActivityNote(snapshot, prospectName, normalizedCaseId);
    setPreview(activityNote);
    try {
      const result = await saveSnapshot.mutateAsync({
        caseId: normalizedCaseId,
        prospectName,
        phone: phone || undefined,
        queueActionKey: queueActionKey || undefined,
        queueItemId: queueItemId || undefined,
        queueTicketId: queueTicketId || undefined,
        snapshot,
        // Server-side strategy persistence (cadence row + Logics) — the
        // browser copy (sessionStorage) is just a working cache.
        callStrategy: strategy || undefined,
        activityNote,
      });
      const response = asRecord((result as { response?: unknown } | undefined)?.response);
      const cadenceMatched = response.cadenceMatched === true;
      toast("Interview snapshot saved", {
        description: cadenceMatched
          ? "Posted to Logics and stored on the matching LeadCadence row."
          : "Posted to Logics. No matching LeadCadence row was found for this case.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      toast.error("Interview snapshot failed", { description: message });
    }
  };
  const clearSnapshot = () => {
    setSnapshot(INTERVIEW_SNAPSHOT_DEFAULT);
    setPreview("");
    setStrategy("");
    try {
      window.localStorage.removeItem(storageKey);
      window.sessionStorage.removeItem(`${storageKey}:strategy`);
      window.sessionStorage.removeItem(`${storageKey}:strategyHash`);
    } catch {
      // no-op
    }
  };

  // ── Call strategy (Opus + cached Universal Sales Script) ──
  const [strategy, setStrategy] = React.useState<string>(() => {
    try {
      return window.sessionStorage.getItem(`${storageKey}:strategy`) || "";
    } catch {
      return "";
    }
  });
  const [strategyPending, setStrategyPending] = React.useState(false);
  // Hash of the interview at last generation — when the form grows past it,
  // the Strategy tab nudges a rewrite (which REVISES, not restarts: the prior
  // strategy rides the request so Opus develops what it already produced).
  const [strategySnapshotHash, setStrategySnapshotHash] = React.useState<string>(() => {
    try {
      return window.sessionStorage.getItem(`${storageKey}:strategyHash`) || "";
    } catch {
      return "";
    }
  });
  React.useEffect(() => {
    try {
      setStrategy(window.sessionStorage.getItem(`${storageKey}:strategy`) || "");
      setStrategySnapshotHash(window.sessionStorage.getItem(`${storageKey}:strategyHash`) || "");
    } catch {
      setStrategy("");
      setStrategySnapshotHash("");
    }
  }, [storageKey]);
  const interviewHash = React.useMemo(() => JSON.stringify(snapshot), [snapshot]);
  const interviewChangedSinceStrategy = Boolean(strategy) && strategySnapshotHash !== "" && interviewHash !== strategySnapshotHash;
  // Two modes, one card: the FORM (tabbed interview) and the STRATEGY screen.
  // Strategy is a primary executable (lives in the action row on every tab),
  // and its output takes over the card — toggle back and forth at will.
  const [view, setView] = React.useState<"form" | "strategy">("form");
  const generateStrategy = async () => {
    setView("strategy");
    setStrategyPending(true);
    const body = {
      caseId: caseId || undefined,
      contactName: prospectName || undefined,
      queueItemId: queueItemId || undefined,
      interview: snapshot,
      // Rewrite-not-restart: prior strategy is the base for the revision.
      priorStrategy: strategy || undefined,
    };
    try {
      // Control-plane (5001) is the ONLY path — auth + agent scoping apply
      // there. The temporary nginx day-bridge to ai-bus (7000) was removed;
      // 7000 is never the browser's security boundary.
      const data = await api.post<{ ok?: boolean; strategy?: string; attachedSessionId?: string | null; error?: string }>(
        "/api/ai/live-coach/call-strategy",
        body,
      );
      const text = String(data?.strategy || "").trim();
      if (!text) throw new Error(data?.error || "No strategy returned");
      setStrategy(text);
      setStrategySnapshotHash(interviewHash);
      try {
        window.sessionStorage.setItem(`${storageKey}:strategy`, text);
        window.sessionStorage.setItem(`${storageKey}:strategyHash`, interviewHash);
      } catch {
        // best-effort persistence
      }
      toast("Call strategy ready", {
        description: data?.attachedSessionId
          ? "Also feeding the live coach on the current call."
          : "The coach picks it up when the call binds.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      const routeMissing = /\b404\b|not found/i.test(message);
      if (routeMissing) {
        toast("Strategy service not reachable", {
          description: "Neither strategy route answered — it lands with the next server deploy.",
        });
      } else {
        toast.error("Strategy generation failed", { description: message });
      }
    } finally {
      setStrategyPending(false);
    }
  };
  const handleGenerateStrategyClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    consumeUiEvent(event);
    void generateStrategy();
  };
  const handleSetFormViewClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    consumeUiEvent(event);
    setView("form");
  };
  const handleSetStrategyViewClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    consumeUiEvent(event);
    setView("strategy");
  };
  const handleSaveSnapshotClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    consumeUiEvent(event);
    void saveToSystems();
  };
  const handleBuildPreviewClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    consumeUiEvent(event);
    buildPreview();
  };
  const handleClearSnapshotClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    consumeUiEvent(event);
    clearSnapshot();
  };

  const interviewAskText = React.useMemo(
    () => buildInterviewActivityNote(snapshot, prospectName, caseId),
    [snapshot, prospectName, caseId],
  );
  const jurisdictionAskSeeds = React.useMemo(() => {
    const seeds: CoachAskSeed[] = [];
    if (snapshot.irsDebt) {
      seeds.push({
        kind: "tax_problem",
        label: "IRS / federal",
        lineText: "Interview fact: prospect has IRS / federal tax debt.",
      });
    }
    if (snapshot.stateDebt) {
      seeds.push({
        kind: "tax_problem",
        label: "State debt",
        lineText: "Interview fact: prospect has state tax debt.",
      });
    }
    return seeds;
  }, [snapshot.irsDebt, snapshot.stateDebt]);
  const taxProblemAskSeeds = React.useMemo(
    () => INTERVIEW_TAX_PROBLEM_OPTIONS
      .filter((option) => snapshot.taxProblems[option.key])
      .map((option) => ({
        kind: "tax_problem",
        label: option.label,
        lineText: `Interview tax problem: ${option.label}. Give context, discovery questions, and the right sales framing.`,
      })),
    [snapshot.taxProblems],
  );
  const clientContextAskSeeds = React.useMemo(
    () => INTERVIEW_FLAG_OPTIONS
      .filter((option) => snapshot.flags[option.key])
      .map((option) => ({
        kind: "client_context",
        label: option.label,
        lineText: `Interview client context: ${option.label}. Explain how this should shape tone, empathy, and next questions.`,
      })),
    [snapshot.flags],
  );
  const financialAskSeeds = React.useMemo<CoachAskSeed[]>(
    () => INTERVIEW_FINANCIAL_FIELD_OPTIONS
      .flatMap((option) => {
        const value = String(snapshot.financials[option.key] || "").trim();
        return value
          ? [{
            kind: "financial_context",
            label: option.label,
            lineText: `Interview financial fact: ${option.label}: ${value}. Explain how to use this in discovery and offer framing.`,
          }]
          : [];
      }),
    [snapshot.financials],
  );

  return (
    <div className="space-y-2 p-4">
      <div className="text-[11px] text-muted-foreground">
        Structured call facts for future Logics activity notes. Do not enter full SSNs, card numbers, or bank account numbers.
      </div>
      <InterviewAskPills
        askCoach={askCoach}
        seeds={[
          {
            kind: "interview_snapshot",
            label: "full interview",
            lineText: `${interviewAskText}\n\nExplain what matters most here and what I should ask next.`,
          },
        ]}
      />
      {view === "strategy" ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-sky-700">
              Call strategy
            </div>
            <Button size="sm" variant="secondary" onClick={handleSetFormViewClick}>
              Back to interview
            </Button>
          </div>
          {interviewChangedSinceStrategy ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
              The interview has new info since this strategy was written — rewrite to fold it in (the prior plan is revised, not restarted).
            </div>
          ) : null}
          {strategyPending ? (
            <div className="flex min-h-[180px] items-center justify-center rounded-md border border-dashed border-sky-200 bg-sky-50/40 text-xs text-muted-foreground">
              Opus is reading the sales guide and this interview…
            </div>
          ) : strategy ? (
            <>
              <InterviewAskPills
                askCoach={askCoach}
                seeds={[{
                  kind: "strategy",
                  label: "call strategy",
                  lineText: `${strategy}\n\nClarify the best next move from this strategy.`,
                }]}
              />
              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-sky-200 bg-sky-50/40 p-3 text-[12px] leading-relaxed text-foreground">
                {strategy}
              </pre>
            </>
          ) : (
            <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
              No strategy yet — generate one from the interview.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              onClick={handleGenerateStrategyClick}
              isLoading={strategyPending}
              disabled={strategyPending}
            >
              {strategy ? "Rewrite with new info" : "Generate call strategy"}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Consumes the whole interview; the live coach carries the result in real time.
            </span>
          </div>
        </div>
      ) : (
      <Tabs defaultValue="problem">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="problem">Tax problem</TabsTrigger>
          <TabsTrigger value="client">Client temp</TabsTrigger>
          <TabsTrigger value="compliance">Compliance</TabsTrigger>
          <TabsTrigger value="financials">Financials</TabsTrigger>
        </TabsList>

        <TabsContent value="problem" className="mt-2 space-y-2.5">
          <InterviewField label="How much do they owe (their best guess)?">
            <Input
              value={snapshot.debtAmount}
              onChange={(event) => setField("debtAmount", event.target.value)}
              placeholder="e.g. $42,000"
              className="h-8 text-xs"
            />
          </InterviewField>
          <InterviewField label="Who do they owe?">
            <InterviewCheckGrid
              options={[
                { key: "irsDebt", label: "IRS / federal" },
                { key: "stateDebt", label: "State" },
              ]}
              selected={{ irsDebt: snapshot.irsDebt, stateDebt: snapshot.stateDebt }}
              onChange={(key, checked) => setDebtFlag(key as "irsDebt" | "stateDebt", checked)}
            />
            <InterviewAskPills askCoach={askCoach} seeds={jurisdictionAskSeeds} />
          </InterviewField>
          <InterviewField label="Have they received notices or letters?">
            <CompactNativeSelect
              value={snapshot.receivedNotices}
              onChange={(value) => setField("receivedNotices", value)}
            >
              <option value="">Select…</option>
              <option>Yes</option>
              <option>No</option>
              <option>Unknown</option>
            </CompactNativeSelect>
          </InterviewField>
          <InterviewField label="What's going on with their taxes?" hint="Check everything that applies.">
            <InterviewCheckGrid
              options={INTERVIEW_TAX_PROBLEM_OPTIONS}
              selected={snapshot.taxProblems}
              onChange={setTaxProblem}
            />
            <InterviewAskPills askCoach={askCoach} seeds={taxProblemAskSeeds} />
          </InterviewField>
        </TabsContent>

        <TabsContent value="client" className="mt-2 space-y-2.5">
          <InterviewField label="How warm is this prospect right now?">
            <CompactNativeSelect
              value={snapshot.temperature}
              onChange={(value) => setField("temperature", value)}
            >
              <option value="">Select…</option>
              <option>Cold</option>
              <option>Cautious</option>
              <option>Warm</option>
              <option>Hot / urgent</option>
              <option>Hostile / do not push</option>
            </CompactNativeSelect>
          </InterviewField>
          <InterviewField label="Life context you heard on the call" hint="Check what applies — this shapes the pitch angle.">
            <InterviewCheckGrid
              options={INTERVIEW_FLAG_OPTIONS}
              selected={snapshot.flags}
              onChange={setFlag}
            />
            <InterviewAskPills askCoach={askCoach} seeds={clientContextAskSeeds} />
          </InterviewField>
          <InterviewField
            label="Personal / pitch notes"
            hint="Spouse name, kids, job details, pressure, why now, financial-services angle."
          >
            <textarea
              value={snapshot.personalNotes}
              onChange={(event) => setField("personalNotes", event.target.value)}
              placeholder="Free notes…"
              className="min-h-[80px] w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </InterviewField>
        </TabsContent>

        <TabsContent value="compliance" className="mt-2 space-y-2.5">
          <InterviewField label="How do they earn — employment type?">
            <CompactNativeSelect
              value={snapshot.employment}
              onChange={(value) => setField("employment", value)}
            >
              <option value="">Select…</option>
              <option>W-2 employee</option>
              <option>1099 / contractor</option>
              <option>Business owner</option>
              <option>Unemployed</option>
              <option>Retired / fixed income</option>
            </CompactNativeSelect>
          </InterviewField>
          <InterviewField label="Filing status?">
            <CompactNativeSelect
              value={snapshot.filingStatus}
              onChange={(value) => setField("filingStatus", value)}
            >
              <option value="">Select…</option>
              <option>Single</option>
              <option>Married filing jointly</option>
              <option>Married filing separately</option>
              <option>Head of household</option>
              <option>Widowed</option>
              <option>Unknown</option>
            </CompactNativeSelect>
          </InterviewField>
          <InterviewField label="Which years are unfiled?" hint="Best guess is fine — e.g. 2019-2022, or 'maybe 5 years'.">
            <Input
              value={snapshot.unfiledYears}
              onChange={(event) => setField("unfiledYears", event.target.value)}
              placeholder="e.g. 2019-2022"
              className="h-8 text-xs"
            />
          </InterviewField>
        </TabsContent>

        <TabsContent value="financials" className="mt-2 space-y-2.5">
          <div className="grid gap-2 md:grid-cols-2">
            <InterviewField label="Monthly income?">
              <Input
                value={snapshot.income}
                onChange={(event) => setField("income", event.target.value)}
                placeholder="e.g. $4,800/mo"
                className="h-8 text-xs"
              />
            </InterviewField>
            <InterviewField label="Monthly expenses?">
              <Input
                value={snapshot.expenses}
                onChange={(event) => setField("expenses", event.target.value)}
                placeholder="e.g. $4,200/mo"
                className="h-8 text-xs"
              />
            </InterviewField>
          </div>
          <InterviewField label="Money coming in / assets" hint="Fill what you learned — blank fields stay out of the note.">
            <div className="grid gap-1.5 md:grid-cols-2">
              {INTERVIEW_FINANCIAL_INFLOW_OPTIONS.map((option) => (
                <Input
                  key={option.key}
                  value={snapshot.financials[option.key] || ""}
                  onChange={(event) => {
                    setFinancialValue(option.key, event.target.value);
                    setFinancialSelected(option.key, event.target.value.trim() !== "");
                  }}
                  placeholder={option.label}
                  className="h-8 text-xs"
                />
              ))}
            </div>
          </InterviewField>
          <InterviewField label="Money going out / liabilities">
            <div className="grid gap-1.5 md:grid-cols-2">
              {INTERVIEW_FINANCIAL_OUTFLOW_OPTIONS.map((option) => (
                <Input
                  key={option.key}
                  value={snapshot.financials[option.key] || ""}
                  onChange={(event) => {
                    setFinancialValue(option.key, event.target.value);
                    setFinancialSelected(option.key, event.target.value.trim() !== "");
                  }}
                  placeholder={option.label}
                  className="h-8 text-xs"
                />
              ))}
            </div>
          </InterviewField>
          <InterviewAskPills askCoach={askCoach} seeds={financialAskSeeds} />
        </TabsContent>

      </Tabs>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {view === "form" ? (
          <>
            <Button
              size="sm"
              onClick={handleGenerateStrategyClick}
              isLoading={strategyPending}
              disabled={strategyPending}
              className="border-sky-500/40 bg-sky-600 text-white hover:bg-sky-700"
            >
              {strategy ? "Rewrite strategy" : "Generate strategy"}
            </Button>
            {strategy ? (
              <Button size="sm" variant="secondary" onClick={handleSetStrategyViewClick}>
                View strategy{interviewChangedSinceStrategy ? " •" : ""}
              </Button>
            ) : null}
          </>
        ) : null}
        <Button
          size="sm"
          onClick={handleSaveSnapshotClick}
          isLoading={saveSnapshot.isPending}
          disabled={!caseId || saveSnapshot.isPending}
        >
          Save snapshot
        </Button>
        <Button size="sm" variant="secondary" onClick={handleBuildPreviewClick}>
          Build note
        </Button>
        <Button size="sm" variant="ghost" onClick={handleClearSnapshotClick}>
          Clear
        </Button>
        <span className="text-[11px] text-muted-foreground">
          Saves to Logics and the matching LeadCadence row.
        </span>
      </div>
      {preview ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/20 p-2 text-[11px] text-foreground">
          {preview}
        </pre>
      ) : null}
    </div>
  );
}

export function CXWorkspace() {
  const domain = useDomainStore((s) => s.domain || "TAG");
  const setDomain = useDomainStore((s) => s.setDomain);
  const navigate = useNavigate();
  const { user, logout } = useSession();
  const isAdminUser = user?.role === "admin" || user?.audience === "admin";
  // Company is one operating group across brands, so CX users can move
  // between all known domains instead of being pinned to account.company.
  const availableDomains = React.useMemo<string[]>(() => {
    return [...KNOWN_DOMAINS];
  }, []);
  const [selected, setSelected] = React.useState<ContactContext | null>(null);
  // When the operator clicks a candidate button (in the "found this
  // number in N places, pick one" bar), we stash its key here so
  // subsequent re-renders don't auto-revert to a different auto-pick.
  // Cleared on fresh-call reset (new sessionId arriving).
  const [pickedCandidateKey, setPickedCandidateKey] = React.useState<string | null>(null);
  // No-phone-match fallback search — operator types name/address pieces
  // and we surface MasterProspectIndex hits as additional candidate
  // buttons. Critical for mail-intake leads (NCOA / Lexis) where we
  // don't have a phone until the prospect calls in.
  const [nameSearchInputs, setNameSearchInputs] = React.useState({
    firstName: "",
    lastName: "",
    address: "",
    city: "",
    state: "",
    zip: "",
  });
  const [nameSearchOpen, setNameSearchOpen] = React.useState(false);
  const [coachWindowTab, setCoachWindowTab] = React.useState<"coach" | "interview" | "guidance">("coach");
  // Resolved by the coach panel (which owns the dashboard-match/lock lifecycle); the new
  // Focus Card cockpit streams this same session id. Null when no call is locked.
  const [coachCockpitSessionId, setCoachCockpitSessionId] = React.useState<string | null>(null);

  const [appointmentModalOpen, setAppointmentModalOpen] = React.useState(false);

  // ─── Center-column case form ────────────────────────────────────────────
  // Per-field dirty flags keep operator edits from being clobbered when a
  // fresh lookup resolves while they're still typing. Flags flip true on
  // the first keystroke after an auto-populate; "Reset to lookup" / "Clear"
  // wipe them back to false.
  const BLANK_FORM: CaseForm = {
    firstName: "",
    lastName: "",
    ssn: "",
    email: "",
    cellPhone: "",
    homePhone: "",
    spouseFirstName: "",
    spouseLastName: "",
    spouseSsn: "",
    spouseEmail: "",
    spouseCellPhone: "",
    spouseHomePhone: "",
    sourceName: "",
    caseId: "",
  };
  const BLANK_DIRTY: CaseFormDirty = {
    firstName: false,
    lastName: false,
    ssn: false,
    email: false,
    cellPhone: false,
    homePhone: false,
    spouseFirstName: false,
    spouseLastName: false,
    spouseSsn: false,
    spouseEmail: false,
    spouseCellPhone: false,
    spouseHomePhone: false,
    sourceName: false,
    caseId: false,
  };
  const [form, setForm] = React.useState<CaseForm>(BLANK_FORM);
  const [dirty, setDirty] = React.useState<CaseFormDirty>(BLANK_DIRTY);
  const [servingQueueKey, setServingQueueKey] = React.useState<string | null>(null);
  const [servedQueueCaseId, setServedQueueCaseId] = React.useState<string | null>(null);
  const [servedQueueDomain, setServedQueueDomain] = React.useState<string | null>(null);
  const [servedQueueActionKey, setServedQueueActionKey] = React.useState<string | null>(null);
  const [servedQueueTicketId, setServedQueueTicketId] = React.useState<string | null>(null);
  // Anti-jitter guards for the restore effect (see clearServedQueueSelection).
  const lastServedClearAtRef = React.useRef(0);
  const lastClearedLeadKeysRef = React.useRef<Set<string>>(new Set());
  const [servedQueueContact, setServedQueueContact] = React.useState<ContactContext | null>(null);
  const [servedQueueStartedAt, setServedQueueStartedAt] = React.useState<number | null>(null);
  const [suppressedCallSessionId, setSuppressedCallSessionId] = React.useState<string | null>(null);
  const [autoServeDueAt, setAutoServeDueAt] = React.useState<number | null>(null);
  const [autoServeRemaining, setAutoServeRemaining] = React.useState<number | null>(null);
  const [autoServeCountdownMode, setAutoServeCountdownMode] =
    React.useState<AutoServeCountdownMode>("next");
  const [backendNextDialHandoffUntil, setBackendNextDialHandoffUntil] =
    React.useState<number | null>(null);
  const [startupAutoServeQueued, setStartupAutoServeQueued] = React.useState(false);
  const [breakResumeDueAt, setBreakResumeDueAt] = React.useState<number | null>(null);
  const [breakResumeRemaining, setBreakResumeRemaining] = React.useState<number | null>(null);
  const [breakAutoLogoutRunning, setBreakAutoLogoutRunning] = React.useState(false);
  const [suppressedQueueItems, setSuppressedQueueItems] = React.useState<Record<string, number>>({});
  const [coachReleaseSignal, setCoachReleaseSignal] =
    React.useState<{ key: string; reason: string } | null>(null);
  const [voicemailDropPending, setVoicemailDropPending] = React.useState(false);
  const [queueAdvanceTransition, setQueueAdvanceTransition] =
    React.useState<QueueAdvanceTransition | null>(null);
  const autoServeInFlightRef = React.useRef(false);
  const breakAutoLogoutFiredRef = React.useRef(false);
  const lastTerminalOutcomeWorkflowRef = React.useRef<string | null>(null);
  const voicemailDropWatchdogRef = React.useRef<number | null>(null);
  const queueAdvanceTransitionTimerRef = React.useRef<number | null>(null);
  const nextDialHandoffTimingRef = React.useRef<{
    startedAt: number;
    dispositionKey: string;
    queueKey: string | null;
    queueItemId: string | null;
    caseId: string | null;
    observedUii: string | null;
  } | null>(null);
  const lastCoachCallIdentityRef = React.useRef<{
    uii: string;
    callSessionId: string;
    queueItemId: string;
    agentExtensionId: string;
    agentEmail: string;
  }>({
    uii: "",
    callSessionId: "",
    queueItemId: "",
    agentExtensionId: "",
    agentEmail: "",
  });

  function clearVoicemailDropWatchdog() {
    if (voicemailDropWatchdogRef.current != null) {
      window.clearTimeout(voicemailDropWatchdogRef.current);
      voicemailDropWatchdogRef.current = null;
    }
  }

  function clearQueueAdvanceTransition() {
    if (queueAdvanceTransitionTimerRef.current != null) {
      window.clearTimeout(queueAdvanceTransitionTimerRef.current);
      queueAdvanceTransitionTimerRef.current = null;
    }
    setQueueAdvanceTransition(null);
  }

  function showQueueAdvanceTransition(
    next: QueueAdvanceTransition,
    autoClearMs?: number,
  ) {
    if (queueAdvanceTransitionTimerRef.current != null) {
      window.clearTimeout(queueAdvanceTransitionTimerRef.current);
      queueAdvanceTransitionTimerRef.current = null;
    }
    setQueueAdvanceTransition(next);
    if (autoClearMs && autoClearMs > 0) {
      queueAdvanceTransitionTimerRef.current = window.setTimeout(() => {
        queueAdvanceTransitionTimerRef.current = null;
        setQueueAdvanceTransition(null);
      }, autoClearMs);
    }
  }

  React.useEffect(() => () => {
    if (queueAdvanceTransitionTimerRef.current != null) {
      window.clearTimeout(queueAdvanceTransitionTimerRef.current);
    }
  }, []);

  // Single settle point for the VM button pending flag: successful queue
  // disposition, disposition failure, and the watchdog all pass through here.
  function settleVoicemailDropPending() {
    clearVoicemailDropWatchdog();
    setVoicemailDropPending(false);
  }

  function clearServedQueueSelection() {
    // Anti-jitter: remember when we cleared and WHICH lead we were holding.
    // For 1-2 poll cycles after an advance, the server can still report the
    // old item as queueState:"serving" — the restore effect must not re-stage
    // it (the A→B→A lead flap). See the debounce + ejected-keys guards there.
    lastServedClearAtRef.current = Date.now();
    const clearedKeys = new Set<string>();
    if (servingQueueKey) clearedKeys.add(servingQueueKey);
    if (servedQueueTicketId) {
      const itemDomain = String(servedQueueDomain || domain || "domain").trim().toUpperCase();
      clearedKeys.add(`${itemDomain}:queue:${servedQueueTicketId}`);
    }
    if (servedQueueCaseId && servedQueueActionKey) {
      const itemDomain = String(servedQueueDomain || domain || "domain").trim().toUpperCase();
      clearedKeys.add(`${itemDomain}:case:${servedQueueCaseId}:action:${servedQueueActionKey}`);
    }
    if (clearedKeys.size) lastClearedLeadKeysRef.current = clearedKeys;
    setServingQueueKey(null);
    setServedQueueCaseId(null);
    setServedQueueDomain(null);
    setServedQueueActionKey(null);
    setServedQueueTicketId(null);
    setServedQueueContact(null);
    setServedQueueStartedAt(null);
  }

  function releaseLiveCoachForCurrentCall(reason: string) {
    setCoachReleaseSignal({
      key: `${Date.now()}-${reason}`,
      reason,
    });
    hardPruneLiveCoachForCurrentCall(reason);
  }

  function hardPruneLiveCoachForCurrentCall(
    reason: string,
    override: Partial<{
      uii: string;
      callSessionId: string;
      queueItemId: string;
      agentExtensionId: string;
      agentEmail: string;
    }> = {},
  ) {
    const snapshot = {
      ...lastCoachCallIdentityRef.current,
      ...override,
    };
    const uii = String(snapshot.uii || "").trim();
    if (!uii) return;
    void api.post("/api/ai/live-coach/call-release", {
      uii,
      callSessionId: snapshot.callSessionId || undefined,
      queueItemId: snapshot.queueItemId || undefined,
      agentExtensionId: snapshot.agentExtensionId || undefined,
      agentEmail: snapshot.agentEmail || undefined,
      reason,
      apply: true,
    }).catch(() => {
      // Best-effort cleanup; ai-bus stale sweep is the backstop.
    });
  }

  function fireVoicemailDropRequest() {
    void voicemailDrop.mutateAsync({
      action: "drop",
      phone: selectedPhone || undefined,
      requireArmed: false,
    })
      .then((response) => {
        const result = ((response as { result?: Record<string, unknown> } | undefined)?.result ?? response) as
          | Record<string, unknown>
          | undefined;
        if (result?.mode === "disposition" && !result?.dropped) {
          console.warn("[cx] voicemail request not confirmed", result);
        } else if (result?.mode && result.mode !== "disposition" && !result?.played) {
          console.warn("[cx] voicemail fallback playback not confirmed", result);
        }
      })
      .catch((error) => {
        console.warn("[cx] voicemail request failed", error);
      });
  }

  function beginVoicemailDrop() {
    if (voicemailDropPending) return; // re-entrancy guard: never fire two drops at once
    setVoicemailDropPending(true);
    clearVoicemailDropWatchdog();
    voicemailDropWatchdogRef.current = window.setTimeout(() => {
      voicemailDropWatchdogRef.current = null;
      setVoicemailDropPending(false);
      toast.error("Voicemail disposition timed out", {
        description: "The app did not finish recording the queue disposition. This call may still need a manual disposition.",
      });
    }, VOICEMAIL_DROP_WATCHDOG_MS);
    releaseLiveCoachForCurrentCall("voicemail-drop-started");
    fireVoicemailDropRequest();
    try {
      submitQueueDisposition("did-not-answer", "Voicemail", {
        deferNextDial: DEFER_DISPOSITION_NEXT_DIAL,
        autoServeDelaySeconds: NO_ANSWER_NEXT_LEAD_DELAY_SECONDS,
      });
    } catch (error) {
      settleVoicemailDropPending();
      toast.error("Voicemail disposition failed", {
        description: error instanceof Error ? error.message : "Advance the queue manually.",
      });
      return;
    }
  }

  function clearCasePanelForNextQueueLead() {
    setSelected(null);
    setDirty(BLANK_DIRTY);
    setForm(BLANK_FORM);
    setPickedCandidateKey(null);
    setNameSearchInputs({
      firstName: "",
      lastName: "",
      address: "",
      city: "",
      state: "",
      zip: "",
    });
    setNameSearchOpen(false);
  }

  function cancelAutoServe() {
    setAutoServeDueAt(null);
    setAutoServeRemaining(null);
    autoServeInFlightRef.current = false;
  }

  function holdAutoServeForBackendNextDial() {
    cancelAutoServe();
    setBackendNextDialHandoffUntil(Date.now() + BACKEND_NEXT_DIAL_HANDOFF_HOLD_MS);
  }

  function scheduleAutoServe(
    delaySeconds = AUTO_SERVE_DELAY_SECONDS,
    mode: AutoServeCountdownMode = "next",
  ) {
    const safeDelay = Math.max(0, Number(delaySeconds) || 0);
    setAutoServeCountdownMode(mode);
    setAutoServeDueAt(Date.now() + safeDelay * 1000);
    setAutoServeRemaining(safeDelay);
  }

  function suppressCurrentQueueLead(result: Record<string, unknown>) {
    const now = Date.now();
    const response = asRecord(result.response);
    const rescheduledFor = String(result.rescheduledFor || response.rescheduledFor || "").trim();
    const rescheduledAt = rescheduledFor ? new Date(rescheduledFor).getTime() : NaN;
    const suppressUntil =
      Number.isFinite(rescheduledAt) && rescheduledAt > now
        ? rescheduledAt
        : now + 2 * 60 * 1000;
    const keys = new Set<string>();
    if (servingQueueKey) keys.add(servingQueueKey);
    const resultDomain = String(result.domain || response.domain || servedQueueDomain || domain || "domain")
      .trim()
      .toUpperCase();
    const resultQueueItemId = String(
      result.queueItemId ||
        result.queueTicketId ||
        response.queueItemId ||
        response.queueTicketId ||
        "",
    ).trim();
    if (resultQueueItemId) keys.add(`${resultDomain}:queue:${resultQueueItemId}`);
    if (servedQueueTicketId) {
      const itemDomain = String(servedQueueDomain || domain || "domain").trim().toUpperCase();
      keys.add(`${itemDomain}:queue:${servedQueueTicketId}`);
    }
    const resultCaseId = String(result.caseId || response.caseId || servedQueueCaseId || "").trim();
    const resultActionKey = String(result.actionKey || response.actionKey || servedQueueActionKey || "").trim();
    if (resultCaseId && resultActionKey) keys.add(`${resultDomain}:case:${resultCaseId}:action:${resultActionKey}`);
    if (servedQueueCaseId && servedQueueActionKey) {
      const itemDomain = String(servedQueueDomain || domain || "domain").trim().toUpperCase();
      keys.add(`${itemDomain}:case:${servedQueueCaseId}:action:${servedQueueActionKey}`);
    }
    if (keys.size === 0) return;
    setSuppressedQueueItems((current) => {
      const next = pruneQueueSuppressionMap(current, now);
      for (const key of keys) next[key] = suppressUntil;
      return next;
    });
  }

  React.useEffect(() => {
    if (autoServeDueAt == null) {
      setAutoServeRemaining(null);
      return undefined;
    }

    const tick = () => {
      const seconds = Math.max(0, Math.ceil((autoServeDueAt - Date.now()) / 1000));
      setAutoServeRemaining(seconds);
    };
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [autoServeDueAt]);

  React.useEffect(() => {
    if (backendNextDialHandoffUntil == null) return undefined;
    const delay = Math.max(0, backendNextDialHandoffUntil - Date.now());
    const timeout = window.setTimeout(() => {
      setBackendNextDialHandoffUntil(null);
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [backendNextDialHandoffUntil]);

  // Data
  const workspace = useCxWorkspace(domain);
  const callQueue = useCxCallQueue(domain);
  const multiCallQueues = useCxCallQueueMulti(isAdminUser ? availableDomains : []);
  const simpleLoopPanelEnabled = React.useMemo(
    () => readCxSimpleLoopPanelEnabled(user?.email || user?.name),
    [user?.email, user?.name],
  );
  // M11 gate 11: default to single — the legacy bulk-mirror path is no longer the default mode.
  const [simpleLoopMode, setSimpleLoopMode] = React.useState<"single" | "bulk-mirror">("single");
  const [simpleLoopLimit, setSimpleLoopLimit] = React.useState(30);
  const [simpleLoopReverse, setSimpleLoopReverse] = React.useState(false);
  const simpleLoopSession = useCxSimpleLoopSession(simpleLoopPanelEnabled);
  const simpleLoopStart = useCxSimpleLoopStart();
  const simpleLoopAdvance = useCxSimpleLoopAdvance();
  const simpleLoopDisposition = useCxSimpleLoopDisposition();
  const simpleLoopSkip = useCxSimpleLoopSkip();
  const simpleLoopKill = useCxSimpleLoopKill();
  const simpleLoopWatchInFlightRef = React.useRef(false);
  const simpleLoopBusy =
    simpleLoopStart.isPending ||
    simpleLoopAdvance.isPending ||
    simpleLoopDisposition.isPending ||
    simpleLoopSkip.isPending ||
    simpleLoopKill.isPending;
  const activeSimpleLoopMode = String(simpleLoopSession.data?.mode || simpleLoopMode);
  const simpleLoopHasMirroredQueue = React.useMemo(() => {
    const queue = Array.isArray(simpleLoopSession.data?.queue) ? simpleLoopSession.data.queue : [];
    return queue.some((candidate) => {
      const status = String(candidate.status || "").trim().toLowerCase();
      const ringcxStatus = String(candidate.ringcx?.status || "").trim().toLowerCase();
      return status === "mirrored" || ringcxStatus === "published";
    });
  }, [simpleLoopSession.data?.queue]);
  React.useEffect(() => {
    const session = simpleLoopSession.data;
    if (!simpleLoopPanelEnabled) return;
    if (!session?.sessionId) return;
    if (String(session.status || "").toLowerCase() !== "running") return;
    if (String(session.mode || activeSimpleLoopMode) !== "bulk-mirror") return;
    if (!simpleLoopHasMirroredQueue) return;
    const tick = () => {
      if (simpleLoopWatchInFlightRef.current) return;
      if (
        simpleLoopStart.isPending ||
        simpleLoopDisposition.isPending ||
        simpleLoopSkip.isPending ||
        simpleLoopKill.isPending
      ) {
        return;
      }
      simpleLoopWatchInFlightRef.current = true;
      simpleLoopAdvance.mutate({
        sessionId: session.sessionId,
        mode: "bulk-mirror",
        force: true,
        timeoutMs: 250,
        intervalMs: 100,
      }, {
        onSettled: () => {
          simpleLoopWatchInFlightRef.current = false;
          void simpleLoopSession.refetch();
        },
      });
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [
    activeSimpleLoopMode,
    simpleLoopAdvance,
    simpleLoopDisposition.isPending,
    simpleLoopHasMirroredQueue,
    simpleLoopKill.isPending,
    simpleLoopPanelEnabled,
    simpleLoopSession,
    simpleLoopSession.data,
    simpleLoopSkip.isPending,
    simpleLoopStart.isPending,
  ]);
  React.useEffect(() => {
    emitCxTiming("workspace.query_state", {
      domain,
      isAdminUser,
      workspaceLoading: workspace.isLoading,
      workspaceFetching: workspace.isFetching,
      workspaceHasData: Boolean(workspace.data),
      workspaceError: workspace.error instanceof Error ? workspace.error.message : null,
      callQueueLoading: callQueue.isLoading,
      callQueueFetching: callQueue.isFetching,
      callQueueCount: Array.isArray(callQueue.data) ? callQueue.data.length : null,
      multiDomainCount: isAdminUser ? availableDomains.length : 0,
    });
  }, [
    domain,
    isAdminUser,
    availableDomains.length,
    workspace.isLoading,
    workspace.isFetching,
    workspace.data,
    workspace.error,
    callQueue.isLoading,
    callQueue.isFetching,
    callQueue.data,
  ]);

  // The resolved caseId drives everything in the "existing case" part of
  // the center column: it's whichever of the form caseId (operator typed
  // / auto-populated) or the queue-selected caseId is present.
  const parsedFormCaseId = form.caseId.trim() ? Number(form.caseId.trim()) : null;
  const formCaseIdValid =
    parsedFormCaseId != null && Number.isFinite(parsedFormCaseId) && parsedFormCaseId > 0;
  // For lookup PRIORITY purposes only count form.caseId if the operator
  // typed it (dirty.caseId). Auto-populated caseIds shouldn't pin the
  // lookup — otherwise a fresh inbound call's phone gets drowned out by
  // whatever caseId the previous match wrote into the form.
  const formCaseIdTypedByOperator = formCaseIdValid && dirty.caseId === true;
  const resolvedCaseId = formCaseIdValid
    ? String(parsedFormCaseId)
    : selected?.caseId || null;
  // Case-scoped queries + mutations are bound *after* the lookup
  // resolves a domain (caseDomain is derived below). Until then we
  // fall back to the active switcher domain for these hooks — but
  // every render after the lookup lands rebinds them to the case's
  // real tenant.
  //
  // Operator-scoped hooks (text/email send routed via the agent's EX
  // shell, new-case create) stay on the active switcher domain — they
  // represent the operator's choice of tenant for outgoing comms or
  // brand-new cases that don't yet have a tenant.

  const data = workspace.data;
  const currentExtensionId =
    String(data?.agent?.extensionId || user?.extensionId || "").trim() || null;
  const currentCallAgentShellPhones = collectAgentShellPhones(
    data?.agent?.exShells,
    data?.agent?.activeExShell,
    data?.agent?.requestedExShell,
  );
  const rawCurrentCallSnapshot =
    (data?.ex.currentCall as Record<string, unknown> | null | undefined) ?? null;
  const internalCurrentCallSuppressed =
    isInternalExShellCurrentCall(rawCurrentCallSnapshot, currentCallAgentShellPhones);
  const rawCurrentCall = contactFromCurrentCall(
    internalCurrentCallSuppressed ? null : rawCurrentCallSnapshot,
  );
  const rawCurrentCallSessionId = rawCurrentCall?.sessionId || "";
  const currentCallIsSuppressed =
    Boolean(rawCurrentCallSessionId) && rawCurrentCallSessionId === suppressedCallSessionId;
  const currentCall = currentCallIsSuppressed ? null : rawCurrentCall;
  const currentCallPhone = currentCall?.phone || "";
  const currentCallUii = currentCallIsSuppressed
    ? ""
    : readString(asRecord(rawCurrentCallSnapshot), "uii", "rcxUii", "callUii");
  React.useEffect(() => {
    const timing = nextDialHandoffTimingRef.current;
    if (!timing || !currentCallUii) return;
    if (timing.observedUii === currentCallUii) return;
    timing.observedUii = currentCallUii;
    emitCxTiming("queue_handoff.uii_observed", {
      elapsedMs: Date.now() - timing.startedAt,
      dispositionKey: timing.dispositionKey,
      queueKey: timing.queueKey,
      queueItemId: timing.queueItemId,
      caseId: timing.caseId,
      currentCallUii,
      currentCallSessionId: currentCall?.sessionId || null,
      backendNextDialHandoffActive:
        backendNextDialHandoffUntil != null && backendNextDialHandoffUntil > Date.now(),
    });
  }, [currentCallUii, currentCall?.sessionId, backendNextDialHandoffUntil]);
  React.useEffect(() => {
    emitCxTiming("workspace.data_state", {
      domain,
      agentEmail: data?.agent?.email || user?.email || null,
      extensionId: currentExtensionId,
      activityState: data?.ex?.status || null,
      desiredAvailability: data?.ex?.cxRouting?.desiredAvailability || null,
      currentCallSessionId: currentCall?.sessionId || null,
      currentCallUii: currentCallUii || null,
      currentCallPhonePresent: Boolean(currentCallPhone),
      callQueueCount: Array.isArray(data?.callQueue) ? data.callQueue.length : null,
      counts: data?.counts || null,
    });
  }, [
    domain,
    data?.agent?.email,
    user?.email,
    currentExtensionId,
    data?.ex?.status,
    data?.ex?.cxRouting?.desiredAvailability,
    currentCall?.sessionId,
    currentCallUii,
    currentCallPhone,
    data?.callQueue,
    data?.counts,
  ]);

  // detail/selectedPhone need clientDetail.data, which comes from a
  // hook declared further down (after lookup resolves caseDomain).
  // They live below the clientDetail block.

  // Auto-select from live call context
  React.useEffect(() => {
    if (!selected && currentCall?.caseId) setSelected(currentCall);
  }, [currentCall, selected]);

  // Fresh-call reset: keyed on the sessionId of currentCall, NOT phone.
  // Reason — same phone can call on a NEW session (e.g. an EX re-scramble
  // after a CX simulate finished, or a real callback within the same
  // shift). If we keyed on phone we'd skip the reset and the previous
  // lookup's auto-populated caseId would pin the form to the wrong case.
  const lastScrambledSessionRef = React.useRef<string | null>(null);
  const currentCallSessionId = currentCall?.sessionId || "";
  React.useEffect(() => {
    const identity = {
      uii: String(currentCallUii || "").trim(),
      callSessionId: String(currentCallSessionId || "").trim(),
      queueItemId: String(servedQueueTicketId || servedQueueActionKey || "").trim(),
      agentExtensionId: String(currentExtensionId || "").trim(),
      agentEmail: String(data?.agent?.email || user?.email || "").trim(),
    };
    if (identity.uii || identity.callSessionId || identity.queueItemId) {
      lastCoachCallIdentityRef.current = identity;
    }
  }, [
    currentCallUii,
    currentCallSessionId,
    servedQueueTicketId,
    servedQueueActionKey,
    currentExtensionId,
    data?.agent?.email,
    user?.email,
  ]);
  React.useEffect(() => {
    if (!suppressedCallSessionId) return;
    if (!rawCurrentCallSessionId || rawCurrentCallSessionId !== suppressedCallSessionId) {
      setSuppressedCallSessionId(null);
    }
  }, [rawCurrentCallSessionId, suppressedCallSessionId]);
  React.useEffect(() => {
    if (!currentCallSessionId) return;
    if (lastScrambledSessionRef.current === currentCallSessionId) return;
    lastScrambledSessionRef.current = currentCallSessionId;
    if (servedQueueActionKey || servedQueueTicketId) {
      if (servedQueueContact) setSelected(servedQueueContact);
      return;
    }
    const normalizedCurrentCallPhone = normalizeComparablePhone(currentCallPhone);
    const keepQueueSelection =
      Boolean(servedQueueActionKey || servedQueueTicketId) &&
      normalizeComparablePhone(selected?.phone) === normalizedCurrentCallPhone;
    // Wipe state that could pin the lookup to a stale case:
    //   • selected (queue/old-lookup snapshot)
    //   • form.caseId (auto-populated from prior match)
    //   • dirty flags (so the new match fully replaces non-typed fields)
    setSelected((current) => {
      if (!current) return current;
      if (normalizeComparablePhone(current.phone) === normalizedCurrentCallPhone) return current;
      return null;
    });
    // Wipe ALL form fields, not just caseId — otherwise the previous
    // caller's identity hangs in the strip while the new lookup is
    // in-flight. With this, the strip goes blank for ~200-500ms,
    // shows the scramble loader, then fills cleanly with the new
    // match. (Operator-typed fields would normally be preserved via
    // dirty flags, but we just cleared dirty too — a fresh call
    // means the operator's prior typing is no longer relevant.)
    setForm(BLANK_FORM);
    setDirty(BLANK_DIRTY);
    setPickedCandidateKey(null);
    setNameSearchInputs({
      firstName: "",
      lastName: "",
      address: "",
      city: "",
      state: "",
      zip: "",
    });
    setNameSearchOpen(false);
    if (!keepQueueSelection) clearServedQueueSelection();
  }, [
    currentCallSessionId,
    currentCallPhone,
    selected?.phone,
    servedQueueActionKey,
    servedQueueTicketId,
    servedQueueContact,
  ]);

  // (Old single-domain Logics-match-on-call effect was removed — it
  // hardcoded the active CX switcher domain, hit Logics for that
  // tenant only, and wrote whatever caseId it found into `selected`.
  // That contaminated the lookup ladder and overrode the WYNN→TAG
  // phone walk. The unified `useCxLeadLookup` below is the single
  // source of truth for all CX scramble behavior now.)

  // ─── Lead lookup (center form auto-populate) ────────────────────────────
  // Priority order for the lookup key:
  //   1. case id explicitly typed into the Case ID input (operator
  //      pasted a specific id — most specific intent)
  //   2. live inbound call phone (whoever is on the line RIGHT NOW —
  //      always wins over a stale queue selection)
  //   3. case id from a queue selection (fallback — only used
  //      when there's no active call and no typed caseId)
  //   4. selected contact's phone (last resort)
  //
  // Phone-first when a call is connected is the rule the operator
  // expects: a fresh call shouldn't keep resolving to whatever case
  // they had highlighted before the call landed.
  const leadLookupCaseId: number | null = formCaseIdTypedByOperator
    ? (parsedFormCaseId as number)
    : servedQueueCaseId
      ? Number(servedQueueCaseId) || null
    : currentCallPhone
      ? null
      : selected?.caseId
        ? Number(selected.caseId) || null
        : null;
  const leadLookupPhone: string = leadLookupCaseId
    ? ""
    : currentCallPhone || selected?.phone || "";
  // Lookup order is intentionally fixed: WYNN Logics first, then TAG
  // Logics, then Mongo tiers. We no longer branch by EX-vs-CX channel
  // here because the operator workflow wants the same authoritative
  // ladder every time.
  const phoneOnlyLookup = !leadLookupCaseId && !!leadLookupPhone;
  const leadLookupFallback: string[] | null = phoneOnlyLookup
    ? ["WYNN", "TAG"]
    : null;
  const leadLookupDomain = servedQueueCaseId && servedQueueDomain
    ? servedQueueDomain
    : domain;
  const strictCxFastPath = Boolean(
    (currentCall?.channel === "cx" && currentCallPhone)
      || servedQueueCaseId,
  );
  const leadLookup = useCxLeadLookup(leadLookupDomain, {
    phone: leadLookupPhone || undefined,
    caseId: leadLookupCaseId,
    skipMongoFallback: strictCxFastPath,
    domainFallback: leadLookupFallback,
  });
  React.useEffect(() => {
    emitCxTiming("lead_lookup.state", {
      domain: leadLookupDomain,
      hasPhone: Boolean(leadLookupPhone),
      caseId: leadLookupCaseId,
      strictCxFastPath,
      isLoading: leadLookup.isLoading,
      isFetching: leadLookup.isFetching,
      hasData: Boolean(leadLookup.data),
      error: leadLookup.error instanceof Error ? leadLookup.error.message : null,
      matchSource: (leadLookup.data?.match as { source?: unknown } | null | undefined)?.source || null,
      matchDomain: (leadLookup.data?.match as { domain?: unknown } | null | undefined)?.domain || null,
      matchCaseId: leadLookup.data?.match?.caseId || null,
    });
  }, [
    leadLookupDomain,
    leadLookupPhone,
    leadLookupCaseId,
    strictCxFastPath,
    leadLookup.isLoading,
    leadLookup.isFetching,
    leadLookup.data,
    leadLookup.error,
  ]);
  // Quiet multi-candidate query. The old CX UI rendered every phone
  // match as operator-selectable pills; the queue workflow now trusts
  // the primary lookup and only keeps this around for create-confirm
  // safety and the hidden fallback data.
  const leadCandidatesQuery = useCxLeadCandidates(domain, {
    phone: leadLookupPhone || undefined,
    caseId: leadLookupCaseId,
    domainFallback: leadLookupFallback,
    enabled: !strictCxFastPath,
  });
  // Name+address fallback search — fires from the no-match panel when
  // the phone walk returned 0 candidates. The operator types whatever
  // they have (last name, address, city) and we hit MasterProspectIndex
  // across both domains so mail-intake leads with no phone yet still
  // surface.
  const nameSearchActive =
    nameSearchInputs.firstName.trim() ||
    nameSearchInputs.lastName.trim() ||
    nameSearchInputs.address.trim() ||
    nameSearchInputs.city.trim() ||
    nameSearchInputs.state.trim() ||
    nameSearchInputs.zip.trim();
  const nameSearchQuery = useCxLeadCandidates(domain, {
    nameSearch: nameSearchActive ? nameSearchInputs : null,
    skipLogics: true,
    domainFallback: leadLookupFallback || ["WYNN", "TAG"],
  });
  const phoneCandidates: CxLeadCandidate[] =
    leadCandidatesQuery.data?.candidates ?? [];
  const nameCandidates: CxLeadCandidate[] = nameSearchActive
    ? nameSearchQuery.data?.candidates ?? []
    : [];
  // Merge — phone matches always come first, then any name-search
  // hits not already represented (dedupe by key).
  const leadCandidates: CxLeadCandidate[] = React.useMemo(() => {
    const seen = new Set(phoneCandidates.map((c) => c.key));
    const merged = [...phoneCandidates];
    for (const c of nameCandidates) {
      if (!seen.has(c.key)) {
        merged.push(c);
        seen.add(c.key);
      }
    }
    return merged;
  }, [phoneCandidates, nameCandidates]);
  const showLegacyPhoneMatchPicker = false;
  const lookupResult = leadLookup.data;
  const lookupMatch: CxLeadLookupMatch | null = lookupResult?.match ?? null;
  const lookupSource: CxLeadLookupSource = lookupResult?.source ?? null;

  // On every fresh inbound call (sessionId change), force-refetch the
  // lookup + candidates queries instead of waiting for the natural
  // queryKey-change refetch tick. The queryKey already changes on
  // phone change, but with a 30s staleTime there's a small window
  // where a near-identical query could serve cached data — refetch
  // here makes the scramble feel instant.
  React.useEffect(() => {
    if (!currentCallSessionId) return;
    leadLookup.refetch();
    if (showLegacyPhoneMatchPicker) {
      leadCandidatesQuery.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCallSessionId]);

  // The case lives in whichever tenant the lookup ladder resolved to —
  // independent of the active CX switcher (which only drives search +
  // queue). Once a case is loaded, every case-scoped read/write
  // (activities, tasks, invoices, payments, save, DNC, postdate,
  // append-comment, identity update) targets THIS domain, not whatever
  // the operator happens to be filtering search by.
  const caseDomain =
    (lookupResult as { domain?: string } | undefined)?.domain || domain;

  // ── Case-scoped mutations (bound to the case's resolved domain) ──
  const assignCaseToMe = useCxAssignCaseToMe(caseDomain);
  const disposition = useCxDisposition(caseDomain);
  const voicemailDrop = useCxVoicemailDrop(caseDomain);
  const createAppointment = useCxCreateAppointment(caseDomain);
  const releaseAppointment = useCxReleaseAppointment(caseDomain);
  const callAppointmentNow = useCxCallAppointmentNowAny();

  React.useEffect(() => {
    if (currentCallSessionId) return;
    hardPruneLiveCoachForCurrentCall("call-session-ended");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCallSessionId]);
  // Leak guard: cancel the drop watchdog if the workspace unmounts mid-call.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => () => {
    clearVoicemailDropWatchdog();
  }, []);
  const updateCase = useCxLogicsUpdateCase(caseDomain);
  // Live CX hot guard (2026-07-03): the shared client-detail route is
  // currently returning 500s on every case detail hydration. Keep the
  // operator loop on projected CX/form state until the backend helper import
  // is fixed and control-plane is restarted.
  const liveCxClientDetailHydrationEnabled = false;
  const clientDetail = useClientDetail(
    caseDomain,
    liveCxClientDetailHydrationEnabled ? resolvedCaseId : null,
  );
  const detail = liveCxClientDetailHydrationEnabled ? clientDetail.data : null;
  const selectedPhone =
    form.cellPhone ||
    currentCallPhone ||
    selected?.phone ||
    servedQueueContact?.phone ||
    "";
  const appointmentItems = data?.agent.appointments || [];

  // ── Operator/case-scoped mutations ──
  // New-case create stays on the active tenant.
  const setCxStatus = useCxSetStatus(domain);
  const simulateCxCallAny = useCxSimulateCallAny();
  // dialAny accepts { domain, ...body } so a queue pick on a different tenant
  // routes to the correct /api/commands/cx/:domain/dial without waiting for
  // setDomain() to land. (See handleSelectFromQueue.)
  const dialAny = useCxDialAny();

  // Dev escape hatch — `?cxDialMode=simulate` keeps the simulator path
  // available for QA / smoke tests. Default behavior on the queue
  // pick is the real `requestCxDial` command, which queues an
  // outbound dial in `ringcentral-cx` instead of synthesizing a fake
  // call locally. The simulator stayed under the same hook so a future
  // dev-tools panel can re-expose it without re-wiring imports.
  const cxDialModeIsSimulate = React.useMemo(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    if (params.get("cxDialMode") === "simulate") return true;
    try {
      return localStorage.getItem("cxDialMode") === "simulate";
    } catch {
      return false;
    }
  }, []);
  const cxDialExecutionModeOverride = React.useMemo<"manual" | "manual-then-campaign" | "ringcx-campaign-queue" | null>(() => {
    if (typeof window === "undefined") return null;
    const normalize = (value: string | null) => {
      const raw = String(value || "").trim().toLowerCase();
      if (["manual", "manual-oneoff", "active-call", "active-calls"].includes(raw)) return "manual";
      if ([
        "manual-then-campaign",
        "manual-fallback",
        "manual-fallback-campaign",
        "try-manual",
        "try-manual-then-campaign",
        "hybrid",
      ].includes(raw)) {
        return "manual-then-campaign";
      }
      if (["campaign", "campaign-queue", "ringcx-campaign-queue", "progressive"].includes(raw)) {
        return "ringcx-campaign-queue";
      }
      return null;
    };
    const params = new URLSearchParams(window.location.search);
    const fromQuery = normalize(params.get("cxDialExecutionMode") || params.get("cxDialMode"));
    if (fromQuery) return fromQuery;
    // Keep execution-mode overrides explicit. A stale localStorage flag from
    // manual-dial testing should never turn normal queue serving into a manual
    // outbound call for agents.
    return null;
  }, []);
  // Repopulate the form when a new lookup resolves, preserving any fields
  // the operator has already touched since the last populate. We key the
  // effect on a stable signature of the match so typing into a non-dirty
  // field doesn't re-fire.
  const lookupSignature = lookupMatch
    ? [
        lookupMatch.caseId,
        lookupMatch.phone,
        lookupMatch.email,
        lookupMatch.firstName,
        lookupMatch.lastName,
        lookupSource,
      ].join("|")
    : "";
  React.useEffect(() => {
    if (!lookupMatch) return;
    setForm((prev) => applyLookupToForm(prev, dirty, lookupMatch));
    // If the lookup resolved a caseId we didn't know, promote it into
    // `selected` so downstream things (clientDetail) light up.
    if (lookupMatch.caseId && !selected?.caseId && !formCaseIdValid) {
      setSelected((current) =>
        current?.caseId ? current : { ...(current || {}), caseId: String(lookupMatch.caseId) },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupSignature]);

  /**
   * Categorize the error so failure toasts can render with the right
   * tone and recovery affordance instead of one generic "X failed".
   * The categories map to the failure-UX cleanup items in
   * `docs/CX_PARALLEL_ASSIGNMENTS.md` (lookup / save / send / dial /
   * permission). `permission` is detected by HTTP status — once
   * tenant authorization lands server-side, 401/403 will route here
   * automatically.
   */
  function classifyCommandError(error: unknown): {
    kind: "permission" | "validation" | "network" | "server";
    title: string;
    description: string;
  } {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    const lowered = message.toLowerCase();
    if (
      lowered.includes("401")
      || lowered.includes("403")
      || lowered.includes("unauthor")
      || lowered.includes("forbidden")
      || lowered.includes("permission")
    ) {
      return {
        kind: "permission",
        title: "Not authorized",
        description:
          "You don't appear to have permission for this action. Try signing in again or switch to a tenant you can act in.",
      };
    }
    if (
      lowered.includes("400")
      || lowered.includes("validation")
      || lowered.includes("required")
      || lowered.includes("invalid")
    ) {
      return {
        kind: "validation",
        title: "Request rejected",
        description: message,
      };
    }
    if (
      lowered.includes("network")
      || lowered.includes("fetch")
      || lowered.includes("timeout")
      || lowered.includes("econnrefused")
    ) {
      return {
        kind: "network",
        title: "Connection problem",
        description: "We couldn't reach the server. Check your connection and retry.",
      };
    }
    return {
      kind: "server",
      title: "Server error",
      description: message,
    };
  }

  /**
   * Wraps a command-style mutation with consistent toasts. Pass
   * `retry` to attach a "Retry" action to error toasts — most queue/
   * Logics commands are idempotent enough to retry cleanly. The
   * default behavior (no retry button) is preserved for callers that
   * don't opt in.
   */
  async function run(
    label: string,
    task: () => Promise<unknown>,
    options: { retry?: () => void } = {},
  ) {
    try {
      const result = await task();
      const row = asRecord(result);
      const completed = row.completed === true;
      toast(completed ? `${label} completed` : `${label} queued`, {
        description: completed ? "The action completed successfully." : "The workflow request was accepted.",
      });
      return result;
    } catch (error) {
      const classified = classifyCommandError(error);
      const errorToast =
        classified.kind === "validation" || classified.kind === "permission" ? toast.error : toast.error;
      errorToast(`${label} — ${classified.title}`, {
        description: classified.description,
        // Retries are pointless on permission / validation failures —
        // re-running won't change the answer. Only attach the action
        // for transient categories or if the caller explicitly opts in.
        action:
          options.retry && classified.kind !== "permission" && classified.kind !== "validation"
            ? {
                label: "Retry",
                onClick: () => {
                  options.retry?.();
                },
              }
            : undefined,
      });
      throw error;
    }
  }

  function currentSimpleLoopSessionId() {
    return String(simpleLoopSession.data?.sessionId || "").trim();
  }

  async function runSimpleLoopAction(
    label: string,
    action: () => Promise<CxSimpleLoopSession | null>,
  ) {
    const startedAt = Date.now();
    try {
      const result = await action();
      const elapsedMs = Date.now() - startedAt;
      toast(label, {
        description: result
          ? `${result.status} · ${describeSimpleLoopCurrent(result)} · ${elapsedMs}ms`
          : `No active simple-loop session · ${elapsedMs}ms`,
      });
      void simpleLoopSession.refetch();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Simple loop request failed.";
      toast.error(`${label} failed`, { description: message });
      void simpleLoopSession.refetch();
      throw error;
    }
  }

  function handleSimpleLoopStart() {
    void runSimpleLoopAction("Simple loop started", () =>
      simpleLoopStart.mutateAsync({
        mode: simpleLoopMode,
        limit: simpleLoopLimit,
        reverse: simpleLoopReverse,
        replaceExisting: true,
      }),
    );
  }

  function handleSimpleLoopStartAndDial() {
    void runSimpleLoopAction("Simple loop started dialing", () =>
      simpleLoopStart.mutateAsync({
        mode: simpleLoopMode,
        limit: simpleLoopLimit,
        reverse: simpleLoopReverse,
        replaceExisting: true,
        autoAdvance: true,
      }),
    );
  }

  function handleSimpleLoopAdvance() {
    const sessionId = currentSimpleLoopSessionId();
    void runSimpleLoopAction(
      simpleLoopMode === "bulk-mirror" ? "Simple loop mirror/watch" : "Simple loop advanced",
      () =>
        simpleLoopAdvance.mutateAsync({
          sessionId: sessionId || undefined,
          mode: simpleLoopMode,
        }),
    );
  }

  function handleSimpleLoopDisposition(outcome: SimpleLoopDisposition) {
    const sessionId = currentSimpleLoopSessionId();
    void runSimpleLoopAction(`Simple loop ${outcome}`, () =>
      simpleLoopDisposition.mutateAsync({
        sessionId: sessionId || undefined,
        outcome,
        disposition: outcome,
        autoAdvance: simpleLoopMode === "bulk-mirror",
        mode: simpleLoopMode,
      }),
    );
  }

  function handleSimpleLoopSkip() {
    const sessionId = currentSimpleLoopSessionId();
    void runSimpleLoopAction("Simple loop skipped", () =>
      simpleLoopSkip.mutateAsync({
        sessionId: sessionId || undefined,
        reason: "local-ui-skip",
        autoAdvance: simpleLoopMode === "bulk-mirror",
        mode: simpleLoopMode,
      }),
    );
  }

  function handleSimpleLoopKill() {
    const sessionId = currentSimpleLoopSessionId();
    void runSimpleLoopAction("Simple loop killed", () =>
      simpleLoopKill.mutateAsync({
        sessionId: sessionId || undefined,
        reason: "local-ui-kill",
        cancelPublished: true,
      }),
    );
  }

  async function handleCxAvailabilityChange(
    next: "available" | "unavailable",
    breakType?: "short-break" | "meal-break",
  ) {
    // We can't use the generic `run()` helper here because the success
    // path needs to detect the EX-busy override the server may apply
    // silently — when the agent has an active EX call, the server
    // ignores the requested "available" and writes "unavailable" with
    // reason="ex-busy". Without surfacing that, the toggle appears to
    // succeed but the agent stays unavailable for CX. We read the
    // resolved cxRouting off the response and either confirm the
    // requested value or warn the operator that EX is overriding it.
    try {
      const result = await setCxStatus.mutateAsync({
        status: next,
        reason: next === "available" ? "manual-available" : "manual-unavailable",
        ...(next === "unavailable" && breakType ? { breakType } : {}),
      });
      const response = (result?.response ?? null) as
        | {
            cxRouting?: { desiredAvailability?: string; reason?: string; pauseType?: string | null } | null;
            freshLeadGate?: FreshLeadGate | null;
          }
        | null;
      const resolvedAvailability = response?.cxRouting?.desiredAvailability;
      const resolvedReason = response?.cxRouting?.reason;

      if (
        next === "available"
        && resolvedAvailability === "unavailable"
        && resolvedReason === "ex-busy"
      ) {
        toast.warning("Held unavailable — EX call active", {
          description:
            "Your CX availability will flip to available automatically when the EX call ends.",
        });
        return;
      }

      const pauseType = String(response?.cxRouting?.pauseType || breakType || "").trim();
      toast(`CX availability set to ${resolvedAvailability || next}`, {
        description: resolvedAvailability === "available"
          ? "You'll start receiving CX leads."
          : pauseType === "meal-break"
            ? "You are on a 15 minute break. Held leads release when that window expires."
            : "You are on a 5 minute break. Held leads release when that window expires.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      toast.error("CX availability change failed", {
        description: message,
        action: {
          label: "Retry",
          onClick: () => {
            void handleCxAvailabilityChange(next, breakType);
          },
        },
      });
      throw error;
    }
  }

  async function handleResumeWorkFromBreak() {
    breakAutoLogoutFiredRef.current = false;
    await handleCxAvailabilityChange("available");
    setBreakResumeDueAt(null);
    setBreakResumeRemaining(null);
    workspace.refetch();
    callQueue.refetch();
  }

  async function handleBreakTimeoutLogout(reason = "break-timeout") {
    if (breakAutoLogoutFiredRef.current) return;
    breakAutoLogoutFiredRef.current = true;
    setBreakAutoLogoutRunning(true);
    cancelAutoServe();
    try {
      if (reason === "break-timeout") {
        toast.warning("Break timer expired", {
          description: "Signing out and releasing held leads.",
        });
      }
      await logout();
    } finally {
      setBreakAutoLogoutRunning(false);
      navigate("/login", { replace: true });
    }
  }

  function restoreServedQueueLead() {
    if (!servedQueueContact) return false;
    setSelected(servedQueueContact);
    if (servedQueueDomain && servedQueueDomain !== domain) setDomain(servedQueueDomain);
    if (servedQueueCaseId) {
      setForm((prev) => ({
        ...prev,
        caseId: servedQueueCaseId,
        cellPhone: prev.cellPhone || servedQueueContact.phone || "",
        email: prev.email || servedQueueContact.email || "",
      }));
    }
    return true;
  }

  function stageQueueLeadInWorkspace(
    item: CxCallQueueItem,
    contact: ContactContext,
    queueDomain: string,
    options: { preserveTransition?: boolean } = {},
  ) {
    if (!options.preserveTransition) clearQueueAdvanceTransition();
    const snapshot = asRecord(item.payloadSnapshot);
    const leadBody = asRecord(item.leadBody);
    const merged = Object.keys(leadBody).length > 0 ? { ...snapshot, ...leadBody } : snapshot;
    const fullName = contact.name || readString(merged, "name", "fullName", "contactName");
    const firstName =
      readString(merged, "firstName", "FirstName") ||
      (fullName ? fullName.split(/\s+/)[0] : "");
    const lastName =
      readString(merged, "lastName", "LastName") ||
      (fullName && fullName.includes(" ") ? fullName.split(/\s+/).slice(1).join(" ") : "");

    setSelected(contact);
    setDirty(BLANK_DIRTY);
    setPickedCandidateKey(null);
    setForm({
      ...BLANK_FORM,
      firstName,
      lastName,
      cellPhone: contact.phone || readString(merged, "cellPhone", "phone", "number"),
      email: contact.email || readString(merged, "email"),
      sourceName: contact.source || readString(merged, "sourceName", "source", "sourceLabel"),
      caseId: contact.caseId || readString(merged, "caseId"),
    });
    setServedQueueCaseId(contact.caseId || null);
    setServedQueueDomain(queueDomain || null);
    setServedQueueActionKey(extractQueueActionKey(item));
    setServedQueueTicketId(item.queueTicketId || null);
    setServedQueueContact(contact);
    setServedQueueStartedAt(Date.now());
    if (queueDomain && queueDomain !== domain) setDomain(queueDomain);
  }

  function stageNextCallHandoffLead(
    item: CxCallQueueItem,
    options: { preserveTransition?: boolean } = {},
  ) {
    const contact = contactFromQueue(item);
    const queueDomain = String(item.domain || domain || "TAG").trim().toUpperCase();
    cancelAutoServe();
    stageQueueLeadInWorkspace(item, contact, queueDomain, options);
    setServingQueueKey(buildQueueItemKey(item));
  }

  async function handleSelectFromQueue(
    item: CxCallQueueItem,
    options: { source?: "manual" | "auto" } = {},
  ) {
    if (options.source !== "auto") cancelAutoServe();
    const contact = contactFromQueue(item);
    const queueKey = buildQueueItemKey(item);
    const queueDomain = String(item.domain || domain || "TAG").trim().toUpperCase();
    const itemTicketId = String(item.queueTicketId || "").trim();
    const sameServedQueueItem =
      (servingQueueKey && queueKey === servingQueueKey) ||
      (servedQueueTicketId && itemTicketId && itemTicketId === String(servedQueueTicketId));
    if ((servedQueueTicketId || servedQueueActionKey) && !sameServedQueueItem) {
      const restored = restoreServedQueueLead();
      toast.warning("Finish the current lead first", {
        description: restored
          ? "I brought the unfinished lead back into the center panel."
          : "Choose a Logics action or Call back before starting the next queue lead.",
      });
      return;
    }
    // Build the dial request against queueDomain rather than the workspace's
    // current `domain`. `setDomain(queueDomain)` below is async — using
    // `domain` here would post the dial to the wrong tenant when the user
    // clicks a queue item from a different domain than the active switcher.
    const dialRequest = {
      ...buildQueueDialRequest(item, queueDomain, contact),
      ...(cxDialExecutionModeOverride ? { executionMode: cxDialExecutionModeOverride } : {}),
    };
    if (!contact.phone) {
      stageQueueLeadInWorkspace(item, contact, queueDomain);
      setServingQueueKey(queueKey);
      return;
    }

    // The simulator path used to be the only option — it spoofs an
    // inbound call locally so the rest of the workspace lights up.
    // Real dial goes through `useCxDialAny` -> `/api/commands/cx/:domain/dial`,
    // which queues an outbound CX dial command in `ringcentral-cx`. Pass
    // `queueDomain` explicitly so a click on a non-active-tenant card
    // doesn't race the setDomain() above.
    // Dev/QA can opt back into the simulator with `?cxDialMode=simulate`.
    try {
      if (cxDialModeIsSimulate) {
        await simulateCxCallAny.mutateAsync({
          domain: queueDomain,
          phone: contact.phone,
          direction: "outbound",
          channel: "cx",
          fromName: contact.name || undefined,
        });
        stageQueueLeadInWorkspace(item, contact, queueDomain);
        setServingQueueKey(queueKey);
        toast("CX dial simulated", {
          description: `Serving ${contact.name || contact.phone} through the CX simulator.`,
        });
      } else {
        await dialAny.mutateAsync({ domain: queueDomain, ...dialRequest });
        stageQueueLeadInWorkspace(item, contact, queueDomain);
        setServingQueueKey(queueKey);
        toast(cxDialExecutionModeOverride === "manual"
          ? "CX manual dial requested"
          : cxDialExecutionModeOverride === "manual-then-campaign"
            ? "CX hybrid dial requested"
            : "CX dial queued", {
          description: `Outbound dial requested for ${contact.name || contact.phone}.`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not place the CX call.";
      clearServedQueueSelection();
      if (options.source === "auto") {
        scheduleAutoServe(AUTO_SERVE_RETRY_DELAY_SECONDS, "next");
      }
      toast.error(cxDialModeIsSimulate ? "CX dial simulation failed" : "CX dial request failed", {
        description: message,
        // Per failure-UX cleanup: dial errors are recoverable — surface
        // a one-click retry instead of forcing the operator to re-pick
        // the queue item.
        action: {
          label: "Retry",
          onClick: () => {
            void handleSelectFromQueue(item, options);
          },
        },
      });
    }
  }

  // Operator picked a specific candidate. Pin it so subsequent
  // auto-scrambles don't override, and fill the form with whatever
  // data the candidate carries.
  //
  // Special case for the no-phone-match → name-search → MasterProspect
  // pick path: the candidate has no phone (mail-intake lead) but the
  // operator IS on a phone call right now. We use the inbound call's
  // phone as the cellPhone — Save will then PUT to Logics with that
  // new phone, effectively tying the caller to the existing case.
  function handlePickCandidate(c: CxLeadCandidate) {
    setServedQueueCaseId(c.caseId != null ? String(c.caseId) : null);
    setServedQueueActionKey(null);
    setServedQueueTicketId(null);
    setPickedCandidateKey(c.key);
    const phoneToUse = c.phone || currentCallPhone || "";
    setSelected({
      caseId: c.caseId != null ? String(c.caseId) : null,
      name: c.name,
      phone: phoneToUse,
      email: c.email,
      status: c.status,
    });
    // Mark cellPhone as DIRTY when we're tying the inbound call's phone
    // to a candidate that didn't have one — that signals Save to push
    // it up to Logics on the next update (otherwise the non-destructive
    // strip would skip empty-but-changed fields).
    const tyingNewPhone = !c.phone && Boolean(currentCallPhone);
    setDirty({ ...BLANK_DIRTY, cellPhone: tyingNewPhone });
    setForm((prev) => ({
      ...prev,
      firstName: c.firstName || "",
      lastName: c.lastName || "",
      email: c.email || "",
      cellPhone: phoneToUse,
      sourceName: c.sourceName || "",
      caseId: c.caseId != null ? String(c.caseId) : "",
    }));
  }

  function handleFormChange(field: CaseFormField, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setDirty((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
  }

  function releaseQueueAfterSuccess(
    result: unknown,
    options: {
      forceEject?: boolean;
      skipAutoServe?: boolean;
      preserveCurrentLead?: boolean;
      skipCurrentLeadSuppression?: boolean;
      autoServeDelaySeconds?: number;
    } = {},
  ) {
    const forceEject = options.forceEject === true;
    if (!forceEject && !servedQueueActionKey && !servedQueueTicketId) return false;
    const row = asRecord(result);
    if (row.wrapUpRequired === true || row.callHeldOpen === true) return false;
    const response = asRecord(row.response);
    const hangup = asRecord(row.hangup);
    const backendNextDialAccepted = isCxNextDialAccepted(row);
    const backendNextDialQueuedButUnconfirmed = isCxNextDialQueuedButUnconfirmed(row);
    if (backendNextDialAccepted || backendNextDialQueuedButUnconfirmed) {
      holdAutoServeForBackendNextDial();
    }
    const queueOutcome = String(row.queueOutcome || "").trim().toLowerCase();
    const responseQueueOutcome = String(response.queueOutcome || "").trim().toLowerCase();
    const callbackEjected = row.callbackEjected === true || response.callbackEjected === true;
    const releaseableOutcomes = new Set([
      "completed",
      "cancelled",
      "rescheduled",
      "cadence-finished",
    ]);
    const cleanupAccepted =
      releaseableOutcomes.has(queueOutcome) ||
      releaseableOutcomes.has(responseQueueOutcome) ||
      (forceEject && callbackEjected) ||
      hangup.ok === true ||
      hangup.acceptedLocally === true ||
      String(hangup.reason || "").toLowerCase() === "no-active-call-after-disposition" ||
      String(hangup.reason || "").toLowerCase() === "disposition-hangup-backgrounded";
    const completed = row.completed === true || cleanupAccepted;
    if (!completed) return false;
    if (!cleanupAccepted) return false;
    if (!options.skipCurrentLeadSuppression) {
      suppressCurrentQueueLead(row);
    }
    if (rawCurrentCallSessionId) {
      setSuppressedCallSessionId(rawCurrentCallSessionId);
    }
    if (!options.preserveCurrentLead) {
      clearServedQueueSelection();
      clearCasePanelForNextQueueLead();
    }
    workspace.refetch();
    callQueue.refetch();
    for (const query of multiCallQueues) {
      query.refetch();
    }
    if (
      !options.skipAutoServe &&
      !options.preserveCurrentLead &&
      !backendNextDialAccepted &&
      !backendNextDialQueuedButUnconfirmed
    ) {
      scheduleAutoServe(options.autoServeDelaySeconds ?? AUTO_SERVE_HANDOFF_DELAY_SECONDS, "next");
    }
    return true;
  }

  const rawQueueItems = React.useMemo(() => {
    return isAdminUser
      ? multiCallQueues.flatMap((query) => {
        const items = Array.isArray(query.data) ? query.data : [];
        return items as CxCallQueueItem[];
      })
      : ((callQueue.data ?? data?.callQueue ?? []) as CxCallQueueItem[]);
  }, [isAdminUser, multiCallQueues, callQueue.data, data?.callQueue]);

  const isQueueItemLocallySuppressed = React.useCallback(
    (item: CxCallQueueItem) => {
      const now = Date.now();
      if (now - lastServedClearAtRef.current < 60_000) {
        const candidateKeys = getQueueItemSuppressionKeys(item);
        if (candidateKeys.some((key) => lastClearedLeadKeysRef.current.has(key))) return true;
      }
      return getQueueItemSuppressionKeys(item).some((key) => Number(suppressedQueueItems[key] || 0) > now);
    },
    [suppressedQueueItems],
  );

  const activeServingQueueItem = React.useMemo(() => {
    return rawQueueItems.find((item) => {
      if (isQueueItemLocallySuppressed(item)) return false;
      const itemQueueState = String(item.queueState || "").trim().toLowerCase();
      if (itemQueueState !== "serving") return false;
      const assignedExtensionId = String(item.assignedExtensionId || "").trim();
      return !assignedExtensionId || assignedExtensionId === currentExtensionId;
    }) || null;
  }, [rawQueueItems, currentExtensionId, isQueueItemLocallySuppressed]);
  const backendNextDialHandoffActive =
    backendNextDialHandoffUntil != null && backendNextDialHandoffUntil > Date.now();

  React.useEffect(() => {
    if (simpleLoopPanelEnabled) return;
    if (!activeServingQueueItem) return;
    if (servedQueueTicketId || servedQueueActionKey || servingQueueKey || servedQueueContact) return;
    const contact = contactFromQueue(activeServingQueueItem);
    const queueDomain = String(activeServingQueueItem.domain || domain || "TAG").trim().toUpperCase();
    const activeServingMetadata = asRecord(asRecord(activeServingQueueItem).metadata);
    const activeServingDialStatus = String(activeServingMetadata.lastDialIntentStatus || "")
      .trim()
      .toLowerCase();
    const isBackendNextDialRestore =
      backendNextDialHandoffUntil != null &&
      backendNextDialHandoffUntil > Date.now() &&
      !["cancelled", "canceled", "failed", "relay-failed"].includes(activeServingDialStatus);
    // ── Anti-jitter guards ────────────────────────────────────────────────
    // ONLY for the wrap-up-restore path. During a BACKEND NEXT-DIAL HANDOFF
    // the dialer is actively serving the next lead (sometimes the SAME lead,
    // requeued) within seconds — guarding there made the workspace refuse to
    // stage the call that was already ringing the agent's phone (Sean's
    // "badly desynced" queue). The handoff window IS the signal that a new
    // serving row is expected: stage it immediately, old behavior.
    if (!isBackendNextDialRestore) {
      // 1. Debounce after an advance: for a few seconds after we cleared the
      //    served lead, the polled queue can still carry the OLD item as
      //    "serving" (server release lag / stale poll). Restoring it produced
      //    the brief A→B lead flap. Wrap-up recovery (reload/crash) doesn't
      //    feel a 4s delay — the next poll re-runs this effect.
      if (Date.now() - lastServedClearAtRef.current < QUEUE_RESTORE_DEBOUNCE_MS) return;
      // 2. Never restore the lead we JUST advanced past — match on every
      //    identity the row can carry (key shape can differ between polls
      //    when ticket ids land late). Time-bounded to 60s so genuinely
      //    requeued callbacks stay restorable.
      const candidateKeys = new Set<string>([buildQueueItemKey(activeServingQueueItem)]);
      const candidateTicketId = String(activeServingQueueItem.queueTicketId || "").trim();
      if (candidateTicketId) candidateKeys.add(`${queueDomain}:queue:${candidateTicketId}`);
      const candidateActionKey = extractQueueActionKey(activeServingQueueItem);
      const candidateCaseId = String(activeServingQueueItem.caseId || "").trim();
      if (candidateCaseId && candidateActionKey) {
        candidateKeys.add(`${queueDomain}:case:${candidateCaseId}:action:${candidateActionKey}`);
      }
      if (Date.now() - lastServedClearAtRef.current < 60_000) {
        for (const key of candidateKeys) {
          if (lastClearedLeadKeysRef.current.has(key)) return;
        }
      }
    }
    cancelAutoServe();
    if (isBackendNextDialRestore) setBackendNextDialHandoffUntil(null);
    if (isBackendNextDialRestore && nextDialHandoffTimingRef.current) {
      const timing = nextDialHandoffTimingRef.current;
      const activeServingCallUii =
        readString(activeServingMetadata, "uii", "rcxUii", "callUii", "lastDialUii", "lastDialIntentUii") ||
        readString(asRecord(activeServingQueueItem), "uii", "rcxUii", "callUii") ||
        null;
      emitCxTiming("queue_handoff.restore_serving", {
        elapsedMs: Date.now() - timing.startedAt,
        dispositionKey: timing.dispositionKey,
        queueKey: timing.queueKey,
        queueItemId: timing.queueItemId,
        caseId: timing.caseId,
        observedUii: timing.observedUii,
        currentCallUii: currentCallUii || null,
        activeServingCallUii,
        activeServingDialStatus,
        restoredQueueKey: buildQueueItemKey(activeServingQueueItem),
        restoredQueueItemId: activeServingQueueItem.queueTicketId || null,
        restoredCaseId: activeServingQueueItem.caseId || null,
      });
      nextDialHandoffTimingRef.current = null;
    }
    setServingQueueKey(buildQueueItemKey(activeServingQueueItem));
    stageQueueLeadInWorkspace(activeServingQueueItem, contact, queueDomain);
    if (isBackendNextDialRestore) {
      toast("Next lead ready", {
        description: "RingCX is dialing the next queue lead.",
      });
    } else {
      toast.warning("Lead restored for wrap-up", {
        description: "This call is still waiting for a disposition.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    simpleLoopPanelEnabled,
    activeServingQueueItem,
    servedQueueTicketId,
    servedQueueActionKey,
    servingQueueKey,
    servedQueueContact,
    backendNextDialHandoffUntil,
    domain,
  ]);

  React.useEffect(() => {
    if (!(servedQueueTicketId || servedQueueCaseId || servingQueueKey || servedQueueContact)) return;
    const recent = Array.isArray(data?.recentWorkflowStages) ? data.recentWorkflowStages : [];
    const terminal = recent
      .map(extractTerminalOutcomeWorkflow)
      .filter(Boolean)
      .find((entry) => {
        if (!entry) return false;
        if (lastTerminalOutcomeWorkflowRef.current === entry.workflowId) return false;
        const hasServedQueueIdentity = Boolean(servedQueueTicketId || servedQueueActionKey || servingQueueKey);
        if (servedQueueStartedAt != null) {
          const record = recent.find((row) => String(row._id || "") === entry.workflowId);
          const recordAt = record?.createdAt || record?.happenedAt || "";
          const recordTime = recordAt ? new Date(recordAt).getTime() : NaN;
          if (Number.isFinite(recordTime) && recordTime + 2_000 < servedQueueStartedAt) return false;
        }
        // Strongest match: the terminal row carries the LIVE call's identity (UII).
        // Exact identity beats the queueItemId/case heuristics — only the current
        // call's own outcome advances the workspace (the clean anti-flicker signal).
        if (entry.uii && currentCallUii && entry.uii === String(currentCallUii).trim()) {
          return true;
        }
        if (servedQueueTicketId && entry.queueItemId && entry.queueItemId === String(servedQueueTicketId)) {
          return true;
        }
        if (servingQueueKey && entry.queueItemId && servingQueueKey.includes(entry.queueItemId)) {
          return true;
        }
        // A terminal CX workflow is written with aggregateId = queue item id.
        // While a concrete served queue item is known, do not fall back to
        // case-only matching: coach/interview submits can refresh recent
        // workflow data and a stale terminal row for the same case would
        // otherwise advance the workspace to the next lead mid-call.
        if (hasServedQueueIdentity) {
          // Observability: a terminal row matched by CASE, but a concrete served
          // queue item is known, so we ignore it (anti-flicker — a stale case-level
          // workflow must not advance a live call). Log only the meaningful case.
          if (servedQueueCaseId && entry.caseId && String(entry.caseId) === String(servedQueueCaseId)) {
            console.info("[cx] terminal workflow ignored — queue identity present", {
              workflowId: entry.workflowId,
              caseId: String(entry.caseId),
              servedQueueTicketId: servedQueueTicketId || null,
              servedQueueActionKey: servedQueueActionKey || null,
              servingQueueKey: servingQueueKey || null,
              entryQueueItemId: entry.queueItemId || null,
              entryUii: entry.uii || null,
              currentCallUii: currentCallUii || null,
            });
          }
          return false;
        }
        if (servedQueueCaseId && entry.caseId && String(entry.caseId) === String(servedQueueCaseId)) {
          return true;
        }
        return false;
      });
    if (!terminal) return;

    lastTerminalOutcomeWorkflowRef.current = terminal.workflowId;
    toast(terminal.label, {
      description: "RingCX reported the outcome; moving to the next lead.",
    });
    suppressCurrentQueueLead({
      domain: servedQueueDomain || domain,
      caseId: terminal.caseId || servedQueueCaseId || "",
      queueItemId: terminal.queueItemId || servedQueueTicketId || "",
      response: {
        queueItemId: terminal.queueItemId || servedQueueTicketId || "",
      },
    });
    clearServedQueueSelection();
    clearCasePanelForNextQueueLead();
    scheduleAutoServe(AUTO_SERVE_HANDOFF_DELAY_SECONDS, "next");
  }, [
    data?.recentWorkflowStages,
    servedQueueTicketId,
    servedQueueCaseId,
    servingQueueKey,
    servedQueueContact,
    servedQueueDomain,
    servedQueueStartedAt,
    currentCallUii,
    domain,
  ]);

  const queueItems = React.useMemo(() => {
    const deduped = new Map<string, CxCallQueueItem>();
    for (const item of rawQueueItems) {
      const itemDomain = String(item.domain || domain || "TAG").trim().toUpperCase();
      const normalizedItem = itemDomain === item.domain ? item : { ...item, domain: itemDomain };
      if (isQueueItemLocallySuppressed(normalizedItem)) continue;
      const assignedExtensionId = String(normalizedItem.assignedExtensionId || "").trim();
      if (assignedExtensionId && assignedExtensionId !== currentExtensionId) continue;
      const itemQueueState = String(normalizedItem.queueState || "").trim().toLowerCase();
      const key = buildQueueItemKey(normalizedItem);
      if (servingQueueKey && key === servingQueueKey) continue;
      if (itemQueueState === "serving") continue;
      if (
        servedQueueTicketId &&
        normalizedItem.queueTicketId &&
        String(normalizedItem.queueTicketId) === String(servedQueueTicketId)
      ) {
        continue;
      }
      if (
        !servedQueueTicketId &&
        servedQueueCaseId != null &&
        String(normalizedItem.caseId || "") === String(servedQueueCaseId) &&
        (!servedQueueDomain || itemDomain === servedQueueDomain)
      ) {
        const itemActionKey = extractQueueActionKey(normalizedItem);
        if (!servedQueueActionKey || !itemActionKey || itemActionKey === servedQueueActionKey) {
          continue;
        }
      }
      if (!deduped.has(key)) deduped.set(key, normalizedItem);
    }

    const sortNow = new Date();
    return Array.from(deduped.values()).sort((left, right) => {
      const leftFamily = getQueueSortRank(left, sortNow);
      const rightFamily = getQueueSortRank(right, sortNow);
      if (leftFamily !== rightFamily) return leftFamily - rightFamily;
      const leftTime = left.nextActionAt ? new Date(left.nextActionAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightTime = right.nextActionAt ? new Date(right.nextActionAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (leftTime !== rightTime) return leftTime - rightTime;
      const leftCase = Number(left.caseId || 0);
      const rightCase = Number(right.caseId || 0);
      if (Number.isFinite(leftCase) && Number.isFinite(rightCase) && leftCase !== rightCase) {
        return leftCase - rightCase;
      }
      return String(left.domain || "").localeCompare(String(right.domain || ""));
    });
  }, [
    rawQueueItems,
    domain,
    servingQueueKey,
    servedQueueTicketId,
    servedQueueCaseId,
    servedQueueDomain,
    servedQueueActionKey,
    isQueueItemLocallySuppressed,
    currentExtensionId,
  ]);

  function pickNextCallHandoffLead() {
    return queueItems.find((item) => Boolean(contactFromQueue(item).phone)) || null;
  }

  function buildNextCallHandoffPayload(item: CxCallQueueItem | null | undefined) {
    const nextQueueLead = item || null;
    if (!nextQueueLead) return null;
    const contact = contactFromQueue(nextQueueLead);
    if (!contact.phone) return null;
    const queueDomain = String(nextQueueLead.domain || domain || "TAG").trim().toUpperCase();
    return {
      domain: queueDomain,
      ...buildQueueDialRequest(nextQueueLead, queueDomain, contact),
      // Terminal-button handoff must always load the next lead into the
      // agent's campaign queue. Manual/active-call execution overrides are
      // only for explicit queue-card QA clicks.
      executionMode: "ringcx-campaign-queue",
      assignedExtensionId: currentExtensionId || nextQueueLead.assignedExtensionId || undefined,
      ringcxDialPriority: "IMMEDIATE",
      requestedBySurface: "cx-next-call-handoff",
    };
  }

  React.useEffect(() => {
    if (!(servedQueueTicketId || servingQueueKey)) return;
    if (servedQueueStartedAt == null) return;
    if (dialAny.isPending || disposition.isPending) return;
    if (Date.now() - servedQueueStartedAt < STALE_SERVED_QUEUE_RESET_MS) return;

    const matchingItem = rawQueueItems.find((item) => {
      const ticketId = String(item.queueTicketId || "").trim();
      if (servedQueueTicketId && ticketId && ticketId === String(servedQueueTicketId)) return true;
      return Boolean(servingQueueKey) && buildQueueItemKey(item) === servingQueueKey;
    });
    const matchingState = String(matchingItem?.queueState || "").trim().toLowerCase();
    if (matchingItem && matchingState === "serving") return;

    clearServedQueueSelection();
    clearCasePanelForNextQueueLead();
    scheduleAutoServe(AUTO_SERVE_HANDOFF_DELAY_SECONDS, "next");
    toast.warning("Queue recovered", {
      description: "The previous lead was no longer active, so the next lead can start.",
    });
  }, [
    rawQueueItems,
    servedQueueTicketId,
    servingQueueKey,
    servedQueueStartedAt,
    dialAny.isPending,
    disposition.isPending,
  ]);

  const queueHasActiveLead = Boolean(
    servedQueueTicketId || servedQueueActionKey || servingQueueKey || servedQueueContact,
  );
  const autoServeExState = asRecord(data?.ex);
  const autoServeRouting = asRecord(autoServeExState.cxRouting);
  const autoServeDesiredAvailability = String(autoServeRouting.desiredAvailability || "")
    .trim()
    .toLowerCase();
  const autoServeAgentState = String(
    readString(autoServeExState, "activityState", "status") || "",
  )
    .trim()
    .toLowerCase();
  const canAutoServeForAgentState =
    autoServeDesiredAvailability === "available"
    && (internalCurrentCallSuppressed || !AUTO_SERVE_BLOCKED_AGENT_STATES.has(autoServeAgentState));
  const canAttemptStartQueueLead =
    queueItems.length > 0 &&
    canAutoServeForAgentState &&
    !simpleLoopPanelEnabled &&
    !backendNextDialHandoffActive &&
    !dialAny.isPending &&
    !disposition.isPending;
  const canStartNextQueueLead =
    canAttemptStartQueueLead &&
    !queueHasActiveLead &&
    !autoServeInFlightRef.current;
  const breakPauseType = String(autoServeRouting.pauseType || "").trim();
  const breakPauseReason = String(autoServeRouting.reason || "").trim().toLowerCase();
  const breakPauseReleaseAtRaw = autoServeRouting.pauseReleaseAt;
  const breakPauseReleaseAtMs =
    typeof breakPauseReleaseAtRaw === "string" || typeof breakPauseReleaseAtRaw === "number"
      ? new Date(breakPauseReleaseAtRaw).getTime()
      : breakPauseReleaseAtRaw instanceof Date
        ? breakPauseReleaseAtRaw.getTime()
        : NaN;
  const isManualTimedBreak =
    autoServeDesiredAvailability === "unavailable" &&
    breakPauseReason === "manual-unavailable" &&
    ["short-break", "meal-break"].includes(breakPauseType) &&
    Number.isFinite(breakPauseReleaseAtMs);

  async function startNextQueueLead() {
    if (queueItems.length === 0) {
      toast("No queued leads", { description: "The queue will keep refreshing." });
      return;
    }
    if (queueHasActiveLead) {
      toast.warning("Current lead still active", {
        description: "Finish the current lead before starting another one.",
      });
      return;
    }
    if (!canAutoServeForAgentState) {
      toast.warning("Queue paused", {
        description: "Resume CX availability before starting the next lead.",
      });
      cancelAutoServe();
      return;
    }
    if (dialAny.isPending || disposition.isPending || autoServeInFlightRef.current) return;

    const [next] = queueItems;
    setAutoServeDueAt(null);
    setAutoServeRemaining(null);
    autoServeInFlightRef.current = true;
    try {
      await handleSelectFromQueue(next, { source: "auto" });
    } finally {
      autoServeInFlightRef.current = false;
    }
  }

  React.useEffect(() => {
    if (autoServeDueAt == null) return;
    if (autoServeRemaining !== 0) return;
    if (!canStartNextQueueLead) return;
    if (autoServeInFlightRef.current) return;
    void startNextQueueLead();
  }, [
    autoServeDueAt,
    autoServeRemaining,
    canStartNextQueueLead,
    queueItems,
  ]);

  React.useEffect(() => {
    if (autoServeDueAt != null) return;
    if (!canStartNextQueueLead) return;
    if (autoServeInFlightRef.current) return;
    const firstRun = !startupAutoServeQueued;
    scheduleAutoServe(
      firstRun ? AUTO_SERVE_STARTUP_DELAY_SECONDS : AUTO_SERVE_DELAY_SECONDS,
      firstRun ? "startup" : "next",
    );
    if (firstRun) setStartupAutoServeQueued(true);
  }, [
    autoServeDueAt,
    canStartNextQueueLead,
    queueItems.length,
    startupAutoServeQueued,
  ]);

  React.useEffect(() => {
    if (!isManualTimedBreak) {
      setBreakResumeDueAt(null);
      setBreakResumeRemaining(null);
      breakAutoLogoutFiredRef.current = false;
      return;
    }
    setBreakResumeDueAt(breakPauseReleaseAtMs);
    setBreakResumeRemaining(Math.max(0, Math.ceil((breakPauseReleaseAtMs - Date.now()) / 1000)));
    breakAutoLogoutFiredRef.current = false;
  }, [isManualTimedBreak, breakPauseReleaseAtMs]);

  React.useEffect(() => {
    if (breakResumeDueAt == null) {
      setBreakResumeRemaining(null);
      return undefined;
    }
    const tick = () => {
      setBreakResumeRemaining(Math.max(0, Math.ceil((breakResumeDueAt - Date.now()) / 1000)));
    };
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [breakResumeDueAt]);

  React.useEffect(() => {
    if (!isManualTimedBreak) return;
    if (breakResumeDueAt == null) return;
    if (breakResumeRemaining !== 0) return;
    void handleBreakTimeoutLogout();
  }, [isManualTimedBreak, breakResumeDueAt, breakResumeRemaining]);

  const queueDebugLine = React.useMemo(() => {
    if (isAdminUser) {
      const parts = availableDomains.map((availableDomain, index) => {
        const query = multiCallQueues[index];
        const count = Array.isArray(query?.data) ? query.data.length : 0;
        const state = query?.isLoading ? "loading" : query?.error ? "err" : count;
        return `${availableDomain}:${state}`;
      });
      return `active ${domain} • ${parts.join(" • ")}`;
    }
    const count = Array.isArray(callQueue.data) ? callQueue.data.length : Array.isArray(data?.callQueue) ? data.callQueue.length : 0;
    const state = callQueue.isLoading ? "loading" : callQueue.error ? "err" : count;
    return `active ${domain} • ${domain}:${state}`;
  }, [isAdminUser, availableDomains, multiCallQueues, domain, callQueue.data, callQueue.isLoading, callQueue.error, data?.callQueue]);
  const sourceBadge = sourceBadgeFor(lookupSource);
  const authoritativeLogicsCaseIdNumber: number | null =
    lookupSource === "logics" && lookupMatch?.caseId
      ? Number(lookupMatch.caseId) || null
      : null;
  const servedQueueCaseText =
    servedQueueCaseId != null ? String(servedQueueCaseId).trim() : "";
  const servedQueueCaseNumber =
    servedQueueCaseText
      ? Number(servedQueueCaseText) || null
      : null;
  const dispositionCaseId = authoritativeLogicsCaseIdNumber ?? servedQueueCaseNumber;
  const hasServedQueueTarget = Boolean(servedQueueTicketId || servedQueueActionKey);
  const assignCaseId =
    dispositionCaseId ??
    (resolvedCaseId && Number.isFinite(Number(resolvedCaseId)) ? Number(resolvedCaseId) : null);

  function submitQueueDisposition(
    dispositionKey: "answered" | "did-not-answer",
    _label: string,
    options: {
      coachReleaseReason?: string;
      deferNextDial?: boolean;
      autoServeDelaySeconds?: number;
    } = {},
  ) {
    if (dispositionCaseId == null) return;
    const shouldDeferNextDial = options.deferNextDial ?? DEFER_DISPOSITION_NEXT_DIAL;
    const defaultAutoServeDelaySeconds =
      dispositionKey === "did-not-answer"
        ? NO_ANSWER_NEXT_LEAD_DELAY_SECONDS
        : DISPOSITION_NEXT_LEAD_DELAY_SECONDS;
    const autoServeDelaySeconds =
      options.autoServeDelaySeconds ??
      (shouldDeferNextDial ? defaultAutoServeDelaySeconds : undefined);
    releaseLiveCoachForCurrentCall(options.coachReleaseReason || `queue-disposition-${dispositionKey}`);
    const nextQueueLead = shouldDeferNextDial ? null : pickNextCallHandoffLead();
    const nextDial = buildNextCallHandoffPayload(nextQueueLead);
    const handoffStartedAt = Date.now();
    const nextQueueKey = nextQueueLead ? buildQueueItemKey(nextQueueLead) : null;
    if (nextDial) {
      nextDialHandoffTimingRef.current = {
        startedAt: handoffStartedAt,
        dispositionKey,
        queueKey: nextQueueKey,
        queueItemId: nextQueueLead?.queueTicketId || null,
        caseId: nextQueueLead?.caseId || null,
        observedUii: null,
      };
    } else {
      nextDialHandoffTimingRef.current = null;
    }
    emitCxTiming("queue_handoff.submit", {
      dispositionKey,
      currentCaseId: dispositionCaseId,
      servedQueueTicketId: servedQueueTicketId || null,
      servedQueueActionKey: servedQueueActionKey || null,
      servedQueueCaseId: servedQueueCaseId || null,
      nextDialRequested: Boolean(nextDial),
      nextQueueKey,
      nextQueueItemId: nextQueueLead?.queueTicketId || null,
      nextCaseId: nextQueueLead?.caseId || null,
      nextPhonePresent: Boolean(nextDial),
    });
    showQueueAdvanceTransition({
      title: "Finishing current lead",
      description: nextDial
        ? "Submitting the disposition and waiting for RingCX to confirm the next call."
        : "Submitting the disposition before the queue advances.",
      blocking: true,
    });

    void disposition.mutateAsync({
        caseId: String(dispositionCaseId),
        disposition: dispositionKey,
        phone: form.cellPhone || selectedPhone || currentCallPhone,
        searchPhone: currentCallPhone || selectedPhone || undefined,
        queueActionKey: servedQueueActionKey || undefined,
        queueItemId: servedQueueTicketId || undefined,
        queueTicketId: servedQueueTicketId || undefined,
        assignedExtensionId: currentExtensionId || undefined,
        nextDial: nextDial || undefined,
      })
      .then((result) => {
        const responseElapsedMs = Date.now() - handoffStartedAt;
        settleVoicemailDropPending();
        const nextDialAccepted = isCxNextDialAccepted(result);
        const nextDialQueuedButUnconfirmed = isCxNextDialQueuedButUnconfirmed(result);
        const nextDialInProgress = nextDialAccepted || nextDialQueuedButUnconfirmed;
        const nextDialResult = asRecord(asRecord(result).nextDial);
        const activeCallCapture = asRecord(nextDialResult.activeCallCapture);
        emitCxTiming("queue_handoff.response", {
          elapsedMs: responseElapsedMs,
          dispositionKey,
          nextDialRequested: Boolean(nextDial),
          nextDialAccepted,
          nextDialQueuedButUnconfirmed,
          nextDialStatus: String(nextDialResult.status || "").trim() || null,
          nextDialReason: String(nextDialResult.reason || "").trim() || null,
          nextDialUii:
            readString(nextDialResult, "uii", "callSessionId", "rcxUii") ||
            readString(activeCallCapture, "uii", "callSessionId", "rcxUii") ||
            null,
        });
        const released = releaseQueueAfterSuccess(result, {
          forceEject: true,
          skipAutoServe: nextDialInProgress,
          preserveCurrentLead: false,
          skipCurrentLeadSuppression: false,
          autoServeDelaySeconds,
        });
        if (nextDialAccepted) {
          holdAutoServeForBackendNextDial();
          showQueueAdvanceTransition({
            title: "Waiting for next call",
            description: "RingCX accepted the handoff. The next lead will appear when the call is confirmed.",
            blocking: true,
          });
        } else if (nextDialQueuedButUnconfirmed) {
          holdAutoServeForBackendNextDial();
          showQueueAdvanceTransition({
            title: "Waiting for RingCX",
            description: "The next lead was queued. It will appear when RingCX confirms the active call.",
            blocking: true,
          });
        } else if (nextDial != null) {
          showQueueAdvanceTransition({
            title: "Loading next lead",
            description: "RingCX did not confirm the handoff yet. Checking the queue for the next call.",
            blocking: true,
          });
          clearServedQueueSelection();
          clearCasePanelForNextQueueLead();
          scheduleAutoServe(autoServeDelaySeconds ?? AUTO_SERVE_HANDOFF_DELAY_SECONDS, "next");
        } else if (released) {
          showQueueAdvanceTransition({
            title: "Loading next lead",
            description: "Disposition saved. The queue is moving to the next call.",
            blocking: false,
          }, 5000);
        }
      })
      .catch(() => {
        settleVoicemailDropPending();
        showQueueAdvanceTransition({
          title: "Checking RingCX",
          description: "Refreshing the queue state before the next lead appears.",
          blocking: true,
        });
        workspace.refetch();
        callQueue.refetch();
      });
  }

  function handleAppointmentSubmit(payload: {
    appointmentDate?: string;
    appointmentTime?: string;
    appointmentTimezone?: string;
    assignToMe?: boolean;
    postdate?: boolean;
    note?: string;
  }) {
    if (assignCaseId == null) return;
    const nextQueueLead = pickNextCallHandoffLead();
    const nextDial = buildNextCallHandoffPayload(nextQueueLead);

    void run("Appointment", async () => {
      const appointmentResult = await createAppointment.mutateAsync({
        caseId: String(assignCaseId),
        appointmentDate: payload.appointmentDate,
        appointmentTime: payload.appointmentTime,
        appointmentTimezone: payload.appointmentTimezone,
        note: payload.note,
        phone: form.cellPhone || selectedPhone || currentCallPhone,
        searchPhone: currentCallPhone || selectedPhone || undefined,
        prospectName:
          `${form.firstName} ${form.lastName}`.trim() ||
          selected?.name ||
          servedQueueContact?.name ||
          undefined,
        sourceName: form.sourceName || selected?.source || servedQueueContact?.source || undefined,
        queueActionKey: servedQueueActionKey || undefined,
        queueItemId: servedQueueTicketId || undefined,
        queueTicketId: servedQueueTicketId || undefined,
        assignedExtensionId: currentExtensionId || undefined,
      });
      const assignResult = payload.assignToMe
        ? await assignCaseToMe.mutateAsync({
            caseId: String(assignCaseId),
            note: payload.note,
          }).catch((error) => ({
            ok: false,
            status: error?.status || null,
            reason: error instanceof Error ? error.message : "Assign-to-me failed.",
          }))
        : null;
      const postdateResult = payload.postdate
        ? await updateCase.mutateAsync({
            caseId: String(assignCaseId),
            CaseID: String(assignCaseId),
            status: "post-date",
            skipQueueFinalize: true,
            notes: payload.note,
          }).catch((error) => ({
            ok: false,
            status: error?.status || null,
            reason: error instanceof Error ? error.message : "Postdate update failed.",
          }))
        : null;
      const nextDialResult = nextDial
        ? await dialAny.mutateAsync(nextDial).catch((error) => ({
            ok: false,
            accepted: false,
            status: error?.status || null,
            reason: error instanceof Error ? error.message : "Next CX dial handoff failed.",
          }))
        : null;
      return {
        appointmentResult,
        assignResult,
        postdateResult,
        nextDial: nextDialResult,
      };
    })
      .then((result) => {
        const appointmentFlowResult = asRecord(result);
        const assignResult = asRecord(appointmentFlowResult.assignResult);
        const postdateResult = asRecord(appointmentFlowResult.postdateResult);
        const nextDialResult = appointmentFlowResult.nextDial;
        setAppointmentModalOpen(false);
        if (assignResult.ok === false) {
          toast.warning("Appointment saved, assign failed", {
            description: String(assignResult.reason || "Assign-to-me did not complete."),
          });
        }
        if (postdateResult.ok === false) {
          toast.warning("Appointment saved, postdate failed", {
            description: String(postdateResult.reason || "Logics postdate did not complete."),
          });
        }
        const nextDialAccepted = isCxNextDialAccepted({ nextDial: nextDialResult });
        const nextDialQueuedButUnconfirmed = isCxNextDialQueuedButUnconfirmed({ nextDial: nextDialResult });
        if (nextDialAccepted) {
          holdAutoServeForBackendNextDial();
          if (nextQueueLead) {
            stageNextCallHandoffLead(nextQueueLead);
          }
          toast("Next call sent", {
            description: "RingCX confirmed the next queue lead.",
          });
        } else if (nextDialQueuedButUnconfirmed) {
          holdAutoServeForBackendNextDial();
          toast("Next call queued", {
            description: "Waiting for RingCX to confirm the active call before showing the next lead.",
          });
        } else if (nextDial != null) {
          const reason = String(asRecord(nextDialResult).reason || "").trim();
          toast.warning("Next call handoff fell back", {
            description: reason || "Auto serve will retry from the queue.",
          });
          clearServedQueueSelection();
          clearCasePanelForNextQueueLead();
          scheduleAutoServe(AUTO_SERVE_HANDOFF_DELAY_SECONDS, "next");
        } else if (servedQueueActionKey || servedQueueTicketId || servedQueueCaseId) {
          suppressCurrentQueueLead({
            domain: servedQueueDomain || caseDomain,
            caseId: servedQueueCaseId || assignCaseId,
            actionKey: servedQueueActionKey,
            queueItemId: servedQueueTicketId,
            queueTicketId: servedQueueTicketId,
            queueOutcome: "rescheduled",
          });
          clearServedQueueSelection();
          clearCasePanelForNextQueueLead();
          scheduleAutoServe(AUTO_SERVE_HANDOFF_DELAY_SECONDS, "next");
        }
        workspace.refetch();
        callQueue.refetch();
      })
      .catch(() => {
        workspace.refetch();
        callQueue.refetch();
      });
  }

  function handleReleaseAppointment(appointment: CxAppointment) {
    void run("Release appointment", () =>
      releaseAppointment.mutateAsync({
        appointmentId: appointment.appointmentId,
        reason: "released-from-cx-workspace",
      }),
    )
      .then(() => {
        workspace.refetch();
        callQueue.refetch();
      })
      .catch(() => undefined);
  }

  function handleCallAppointmentNow(appointment: CxAppointment) {
    callAppointmentNow
      .mutateAsync({
        domain: appointment.domain,
        appointmentId: appointment.appointmentId,
      })
      .then((result) => {
        const row = asRecord(result);
        const deferred = row.deferred === true;
        if (deferred) {
          const fireResult = asRecord(row.fireResult);
          const inner = asRecord(fireResult.result);
          const nextAllowedAt = readString(inner, "nextAllowedAt");
          toast("Appointment held for legal dial window", {
            description: nextAllowedAt
              ? `Next legal time: ${formatAppointmentDateTime(nextAllowedAt)}`
              : "The appointment is still outside the allowed dialing window.",
          });
        } else {
          toast.success("Appointment call queued", {
            description: "CX is dialing this appointment through your agent queue.",
          });
        }
        workspace.refetch();
        callQueue.refetch();
      })
      .catch((error) => {
        const classified = classifyCommandError(error);
        toast.error(`Call now - ${classified.title}`, {
          description: classified.description,
        });
        workspace.refetch();
        callQueue.refetch();
      });
  }

  const isExistingCase = Boolean(resolvedCaseId);
  const hasLookupHit = Boolean(lookupMatch);
  const formHeading = isExistingCase
    ? form.firstName || form.lastName
      ? `${form.firstName} ${form.lastName}`.trim()
      : `Case ${resolvedCaseId}`
    : hasLookupHit
      ? "Match found"
      : "Start a new case";
  const formSubtitle =
    authoritativeLogicsCaseIdNumber != null
      ? "Matched case loaded from Logics. Use the call-cycle buttons above to finish the attempt."
      : hasLookupHit
        ? "Auto-populated from the best source we found. Review the lead, then finish the attempt from the buttons above."
        : "No matched case yet. Ask for enough information to identify the caller before finishing the attempt.";
  const queueAdvanceBlocking = queueAdvanceTransition?.blocking === true;

  if (workspace.isLoading) {
    return <SkeletonRow count={8} />;
  }
  if (workspace.error || !data) {
    return (
      <ErrorState
        title="CX workspace unavailable"
        error={workspace.error || new Error("Workspace unavailable")}
      />
    );
  }

  const cxRouting = asRecord(data.ex?.cxRouting);
  const freshLeadGate = asRecord(data.ex?.freshLeadGate);
  const currentCallSnapshot = asRecord(data.ex?.currentCall);
  const cxDesiredAvailability = String(cxRouting.desiredAvailability || "").trim().toLowerCase();
  const cxRoutingReason = String(cxRouting.reason || "").trim();
  const cxPauseType = String(cxRouting.pauseType || "").trim();
  const cxBreakUsage = asRecord(cxRouting.breakUsage || freshLeadGate.breakUsage);
  const shortBreaksAllowed = Number(cxBreakUsage.shortBreaksAllowed ?? 2);
  const shortBreaksUsed = Number(cxBreakUsage.shortBreaksUsed ?? 0);
  const shortBreaksRemaining = Math.max(
    (Number.isFinite(shortBreaksAllowed) ? shortBreaksAllowed : 2)
      - (Number.isFinite(shortBreaksUsed) ? shortBreaksUsed : 0),
    0,
  );
  const mealBreaksAllowed = Number(cxBreakUsage.mealBreaksAllowed ?? 1);
  const mealBreaksUsed = Number(cxBreakUsage.mealBreaksUsed ?? 0);
  const mealBreaksRemaining = Math.max(
    (Number.isFinite(mealBreaksAllowed) ? mealBreaksAllowed : 1)
      - (Number.isFinite(mealBreaksUsed) ? mealBreaksUsed : 0),
    0,
  );
  const currentCallChannel = String(currentCallSnapshot.channel || "").trim().toLowerCase();
  const hasActiveExCall =
    !internalCurrentCallSuppressed &&
    currentCallChannel === "ex" &&
    Boolean(
      currentCallSnapshot.sessionId ||
        currentCallSnapshot.telephonySessionId ||
        currentCallSnapshot.from ||
        currentCallSnapshot.to,
    );
  const freshLeadGateHasExSignal = Object.prototype.hasOwnProperty.call(freshLeadGate, "exCallActive");
  const exCallGateActive = freshLeadGateHasExSignal
    ? Boolean(freshLeadGate.exCallActive)
    : hasActiveExCall || cxRoutingReason === "ex-busy";
  const freshLeadBlocked =
    typeof freshLeadGate.blocked === "boolean"
      ? freshLeadGate.blocked
      : exCallGateActive || cxDesiredAvailability === "unavailable";
  const cxRoutingLabel =
    String(freshLeadGate.label || "").trim() ||
    (exCallGateActive
      ? "Fresh leads paused: EX call"
      : freshLeadBlocked
        ? "Fresh leads paused"
        : "Fresh leads allowed");
  const cxRoutingTone = freshLeadBlocked ? "warning" : "success";
  const cxRoutingHint =
    String(freshLeadGate.detail || "").trim() ||
    (exCallGateActive
      ? "This agent is on an EX call, so fresh leads stay off until EX returns idle."
      : freshLeadBlocked
        ? "Manual pause keeps you out of CX lead serving."
        : "EX is idle and this agent profile can receive CX leads.");
  const exCallStateLabel = exCallGateActive ? "On EX call" : "Off EX call";
  const cxRoutingReasonLabel = humanizeCxRoutingReason(cxRoutingReason);

  // ─── Contact history lists ────────────────────────────────────────────────
  return (
    <>
      <BreakResumePrompt
        open={isManualTimedBreak && breakResumeDueAt != null}
        breakType={breakPauseType}
        remaining={breakResumeRemaining}
        isResuming={setCxStatus.isPending}
        isSigningOut={breakAutoLogoutRunning}
        onResume={() => {
          void handleResumeWorkFromBreak();
        }}
        onSignOut={() => {
          void handleBreakTimeoutLogout("manual-signout");
        }}
      />
      <div className="flex min-h-[calc(100vh-6rem)] flex-col gap-4">
      {/* ─── TOP BAR: sticky routing controls ───────────────────────────── */}
      <div className="sticky top-0 z-30 -mx-4 border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <CxDomainSwitcher
            domain={domain}
            availableDomains={availableDomains}
            onChange={(next) => {
              // The switcher only drives queue + new-case
              // creation. It does NOT unload the active case — a
              // resolved case is bound to its own tenant via the
              // lookup result, so flipping the switcher to a different
              // tenant does not change the loaded case's comms/actions.
              setDomain(next);
            }}
          />
        </div>
        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border/70 bg-card/60 px-3 py-2 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Lead serving
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <StatusPill tone={cxRoutingTone} dotted>
                {cxRoutingLabel}
              </StatusPill>
              <StatusPill tone={exCallGateActive ? "info" : "neutral"} dotted>
                {exCallStateLabel}
              </StatusPill>
              {cxRoutingReasonLabel ? (
                <span className="text-xs text-muted-foreground">{cxRoutingReasonLabel}</span>
              ) : null}
              {data.ex?.exTelephonyStatus ? (
                <span className="text-[11px] text-muted-foreground">
                  EX: {String(data.ex.exTelephonyStatus)}
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">{cxRoutingHint}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            {cxDesiredAvailability === "unavailable" ? (
              <Button
                size="sm"
                variant="primary"
                isLoading={setCxStatus.isPending}
                disabled={exCallGateActive && cxRoutingReason === "ex-busy"}
                title={
                  exCallGateActive && cxRoutingReason === "ex-busy"
                    ? "EX call is active; CX lead serving reopens when EX returns idle."
                    : undefined
                }
                onClick={() => void handleCxAvailabilityChange("available")}
              >
                Resume
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  isLoading={setCxStatus.isPending && cxPauseType === "short-break"}
                  disabled={setCxStatus.isPending || shortBreaksRemaining <= 0 || freshLeadBlocked}
                  title={
                    shortBreaksRemaining <= 0
                      ? "Both 5 minute breaks are used for this work block."
                      : freshLeadBlocked
                        ? "Lead serving is already blocked."
                        : "Start a 5 minute break."
                  }
                  onClick={() => void handleCxAvailabilityChange("unavailable", "short-break")}
                >
                  5 min ({shortBreaksRemaining})
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  isLoading={setCxStatus.isPending && cxPauseType === "meal-break"}
                  disabled={setCxStatus.isPending || mealBreaksRemaining <= 0 || freshLeadBlocked}
                  title={
                    mealBreaksRemaining <= 0
                      ? "The 15 minute break is used for this work block."
                      : freshLeadBlocked
                        ? "Lead serving is already blocked."
                        : "Start a 15 minute break."
                  }
                  onClick={() => void handleCxAvailabilityChange("unavailable", "meal-break")}
                >
                  15 min ({mealBreaksRemaining})
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ─── THREE-COLUMN BODY ──────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col gap-4 lg:flex-row">
        {/* ── LEFT: CX queue only ──────────────────────────────────────── */}
        <aside className="flex-shrink-0 lg:w-[260px]">
          <div className="lg:sticky lg:top-20">
            {simpleLoopPanelEnabled ? (
              <SimpleLoopTestPanel
                session={simpleLoopSession.data}
                isLoading={simpleLoopSession.isLoading}
                isFetching={simpleLoopSession.isFetching}
                error={simpleLoopSession.error}
                mode={simpleLoopMode}
                setMode={setSimpleLoopMode}
                limit={simpleLoopLimit}
                setLimit={setSimpleLoopLimit}
                reverse={simpleLoopReverse}
                setReverse={setSimpleLoopReverse}
                isBusy={simpleLoopBusy}
                onStart={handleSimpleLoopStart}
                onStartAndDial={handleSimpleLoopStartAndDial}
                onAdvance={handleSimpleLoopAdvance}
                onDisposition={handleSimpleLoopDisposition}
                onSkip={handleSimpleLoopSkip}
                onKill={handleSimpleLoopKill}
                onRefresh={() => void simpleLoopSession.refetch()}
              />
            ) : null}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm">CX queue</CardTitle>
                  <div
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-muted/30 px-2 text-[11px] font-medium text-muted-foreground"
                    title="Leads are served automatically from the top of the queue."
                  >
                    <Clock3 className="h-3 w-3" />
                    Auto
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 truncate text-[10px] text-muted-foreground">
                    {queueDebugLine}
                  </div>
                </div>
                <CxQueueLegend />
              </CardHeader>
              <CardContent>
                {autoServeDueAt != null ? (
                  <div className="mb-2">
                    <AutoServeCountdown
                      remaining={autoServeRemaining}
                      totalSeconds={
                        autoServeCountdownMode === "startup"
                          ? AUTO_SERVE_STARTUP_DELAY_SECONDS
                          : AUTO_SERVE_DELAY_SECONDS
                      }
                      mode={autoServeCountdownMode}
                    />
                  </div>
                ) : null}
                {servedQueueContact ? (
                  <ActiveQueueLeadCard
                    contact={servedQueueContact}
                    domain={servedQueueDomain}
                    onSelect={restoreServedQueueLead}
                  />
                ) : null}
                {queueAdvanceBlocking ? (
                  <EmptyState
                    icon={<Clock3 />}
                    title="Queue updating"
                    description="RingCX is confirming the next call."
                  />
                ) : queueItems.length === 0 ? (
                  <EmptyState
                    icon={<Clock3 />}
                    title="No queued leads"
                    description="Cadence pickups will show up here."
                  />
                ) : (
                  <CxQueueList
                    items={queueItems}
                    selectedCaseId={selected?.caseId || servedQueueCaseId}
                    servingQueueKey={servingQueueKey}
                    clickDisabled
                    onSelect={handleSelectFromQueue}
                  />
                )}
              </CardContent>
            </Card>
          </div>
        </aside>

        {/* ── CENTER: client management ─────────────────────────────────── */}
        <section className="flex min-w-0 flex-1 flex-col gap-3">
          {/* Identity strip — quick-glance + inline edits + call outcome */}
          <Card className="relative overflow-hidden">
            {/* Scramble progress bar — a thin animated stripe across the
                top of the card whenever the lookup query
                is fetching. Gives the operator a clear "we're working"
                signal during the brief window between a fresh call
                landing and the form populating. */}
            {leadLookup.isFetching ? (
              <div
                className="absolute left-0 right-0 top-0 h-0.5 overflow-hidden bg-primary/10"
                aria-hidden="true"
              >
                <div className="h-full w-1/3 animate-[cx-scramble_1.1s_ease-in-out_infinite] bg-primary" />
              </div>
            ) : null}
            <CardHeader className="pb-2">
              {/* Top row: domain badge + case id are the FIRST things the
                  operator sees on a connect — "WYNN · 123456" is the
                  unique routing key for any inbound call. */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {(() => {
                    // Show the RESOLVED domain (where the lookup actually
                    // landed), not just the active CX switcher. With the
                    // WYNN→TAG fallback walk, the case can live in the
                    // OTHER tenant — and the badge needs to reflect that
                    // truth so the operator doesn't think a WYNN case
                    // is a TAG case.
                    const resolvedDomain =
                      (lookupResult as { domain?: string } | undefined)?.domain || domain;
                    const ds = getDomainBadgeStyle(resolvedDomain);
                    const mismatched =
                      resolvedDomain.toUpperCase() !== domain.toUpperCase();
                    return (
                      <span
                        className={cn(
                          "rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em]",
                          ds.className,
                        )}
                        title={
                          mismatched
                            ? `Matched in ${resolvedDomain} (CX switcher is on ${domain})`
                            : undefined
                        }
                      >
                        {ds.label}
                        {mismatched ? " ↗" : ""}
                      </span>
                    );
                  })()}
                  <span className="font-mono text-base font-semibold tabular-nums text-foreground">
                    {resolvedCaseId ? (
                      <CaseLink
                        caseId={resolvedCaseId}
                        domain={
                          (lookupResult as { domain?: string } | undefined)?.domain || domain
                        }
                        compact
                      >
                        {resolvedCaseId}
                      </CaseLink>
                    ) : leadLookup.isFetching ? (
                      <span className="text-muted-foreground">scrambling…</span>
                    ) : (
                      <span className="text-muted-foreground">no case</span>
                    )}
                  </span>
                  <span className="text-base text-muted-foreground">·</span>
                  <CardTitle className="text-base">{formHeading}</CardTitle>
                  {detail?.status ? (
                    <StatusPill tone={toneFromStatus(detail.status)}>{detail.status}</StatusPill>
                  ) : null}
                  {sourceBadge ? (
                    <StatusPill tone={sourceBadge.tone}>{sourceBadge.label}</StatusPill>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {assignCaseId != null ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="border-sky-500/40 bg-sky-600 text-white hover:bg-sky-700"
                      isLoading={createAppointment.isPending || assignCaseToMe.isPending || disposition.isPending}
                      disabled={queueAdvanceBlocking}
                      onClick={(event) => {
                        consumeUiEvent(event);
                        setAppointmentModalOpen(true);
                      }}
                      title="Schedule a callback, or use the same modal for assign-to-me and postdate."
                    >
                      <CalendarPlus className="h-3.5 w-3.5" />
                      Set appointment
                    </Button>
                  ) : null}
                  {dispositionCaseId != null ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      className="bg-red-600 text-white hover:bg-red-700"
                      isLoading={disposition.isPending}
                      disabled={queueAdvanceBlocking}
                      onClick={(event) => {
                        consumeUiEvent(event);
                        releaseLiveCoachForCurrentCall("queue-disposition-dnc");
                        void run("DNC", () =>
                          disposition.mutateAsync({
                            caseId: String(dispositionCaseId),
                            disposition: "dnc",
                            phone: form.cellPhone || selectedPhone,
                            searchPhone: currentCallPhone || selectedPhone || undefined,
                            queueActionKey: servedQueueActionKey || undefined,
                            queueItemId: servedQueueTicketId || undefined,
                            queueTicketId: servedQueueTicketId || undefined,
                            assignedExtensionId: currentExtensionId || undefined,
                          }),
                        ).then(releaseQueueAfterSuccess).catch(() => undefined)
                      }}
                      title="Mark this contact as Do-Not-Call (stops cadence on every channel)"
                    >
                      DNC
                    </Button>
                  ) : null}
                  {hasServedQueueTarget && dispositionCaseId != null ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="border-emerald-500/40 bg-emerald-600 text-white hover:bg-emerald-700"
                      isLoading={disposition.isPending}
                      disabled={queueAdvanceBlocking}
                      onClick={(event) => {
                        consumeUiEvent(event);
                        submitQueueDisposition("answered", "Answered", {
                          deferNextDial: DEFER_DISPOSITION_NEXT_DIAL,
                        });
                      }}
                      title="Mark the queue attempt as answered without DNC or Logics status changes."
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Answer
                    </Button>
                  ) : null}
                  {hasServedQueueTarget && dispositionCaseId != null ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="border-amber-500/50 bg-amber-500 text-amber-950 hover:bg-amber-400"
                      isLoading={disposition.isPending}
                      disabled={queueAdvanceBlocking}
                      onClick={(event) => {
                        consumeUiEvent(event);
                        submitQueueDisposition("did-not-answer", "Did not answer", {
                          deferNextDial: DEFER_DISPOSITION_NEXT_DIAL,
                        });
                      }}
                      title="No answer: count the attempt and reschedule the queue item by cadence rules."
                    >
                      <PhoneOff className="h-3.5 w-3.5" />
                      No answer
                    </Button>
                  ) : null}
                  {CX_VOICEMAIL_BUTTON_ENABLED && hasServedQueueTarget && dispositionCaseId != null ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="border-violet-500/40 bg-violet-600 text-white hover:bg-violet-700"
                      disabled={voicemailDropPending || disposition.isPending || queueAdvanceBlocking}
                      onClick={(event) => {
                        consumeUiEvent(event);
                        beginVoicemailDrop();
                      }}
                      title="Drop your assigned voicemail: the dialer sends this call to your monitor recording and advances your queue."
                    >
                      <MessageCircleMore className="h-3.5 w-3.5" />
                      {voicemailDropPending ? "Dropping VM" : "Voicemail"}
                    </Button>
                  ) : null}
                </div>
              </div>
              {queueAdvanceTransition ? (
                <div
                  className={cn(
                    "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
                    queueAdvanceBlocking
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-950 dark:text-sky-100"
                      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100",
                  )}
                  role="status"
                  aria-live="polite"
                >
                  <Clock3
                    className={cn(
                      "mt-0.5 h-3.5 w-3.5 flex-none",
                      queueAdvanceBlocking ? "animate-spin" : "",
                    )}
                  />
                  <div className="min-w-0">
                    <div className="font-semibold">{queueAdvanceTransition.title}</div>
                    <div className="text-[11px] opacity-80">
                      {queueAdvanceTransition.description}
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="text-[11px] text-muted-foreground">{formSubtitle}</div>
            </CardHeader>
            <CardContent
              className={cn(
                "space-y-2 pt-0 transition-opacity",
                queueAdvanceBlocking ? "pointer-events-none opacity-50" : "",
              )}
            >
              {/* Multi-candidate picker — when the inbound phone matches
                  multiple cases, the operator picks rather than guessing.
                  Once they click one, the rest collapse to a small "(N
                  hidden) show all" link so the strip stays clean. */}
              {showLegacyPhoneMatchPicker && leadCandidates.length > 0 ? (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {pickedCandidateKey
                        ? `Loaded — ${leadCandidates.length - 1} other match${leadCandidates.length - 1 === 1 ? "" : "es"} hidden`
                        : `Found ${leadCandidates.length} match${leadCandidates.length === 1 ? "" : "es"} for ${leadLookupPhone || "this number"} — pick one`}
                    </div>
                    {pickedCandidateKey && leadCandidates.length > 1 ? (
                      <button
                        type="button"
                        className="text-[10px] font-medium text-primary hover:underline"
                        onClick={() => setPickedCandidateKey(null)}
                      >
                        show all
                      </button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(pickedCandidateKey
                      ? leadCandidates.filter((c) => c.key === pickedCandidateKey)
                      : leadCandidates
                    ).map((c) => {
                      const ds = getDomainBadgeStyle(c.domain);
                      const active = pickedCandidateKey === c.key;
                      const tierLabel =
                        c.tier === "logics"
                          ? "Logics"
                          : c.tier === "caseProfile"
                            ? "Case Profile"
                            : c.tier === "masterProspect"
                              ? "Prospect"
                              : "Cadence";
                      const created = c.createdAt
                        ? new Date(c.createdAt).toISOString().slice(0, 10)
                          .replace("T", " ")
                        : null;
                      return (
                        <button
                          key={c.key}
                          type="button"
                          onClick={() => handlePickCandidate(c)}
                          className={cn(
                            "flex items-center gap-1.5 rounded-md border px-2 py-1 text-left text-xs transition-colors",
                            active
                              ? "border-primary bg-primary/10 ring-1 ring-primary"
                              : "border-border bg-card hover:bg-muted/40",
                          )}
                          title={`${c.domain} ${c.tier} · case ${c.caseId ?? "?"} · ${c.name || "no name"}${c.status ? ` · ${c.status}` : ""}`}
                        >
                          <span
                            className={cn(
                              "rounded border px-1 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]",
                              ds.className,
                            )}
                          >
                            {ds.label}
                          </span>
                          <span className="font-mono tabular-nums text-[11px] text-foreground">
                            {c.caseId ?? "—"}
                          </span>
                          <span className="truncate text-[11px] text-foreground">
                            {c.name || "(no name)"}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            · {tierLabel}
                            {created ? ` · ${created}` : ""}
                          </span>
                          {/* Mail-intake context — surfaces address +
                              lien metadata so identical names can be
                              told apart by where the mail was sent. */}
                          {(c.address || c.city || c.state || c.mailIntake?.lienType) ? (
                            <span className="ml-1 truncate text-[10px] text-muted-foreground">
                              {[c.address, c.city, c.state, c.mailIntake?.lienType]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {/* No-match → name+address fallback search. Surfaces only
                  when the phone walk returned 0 candidates. Mail-intake
                  leads (NCOA / Lexis) often land in MasterProspectIndex
                  without a phone, so the operator can ask the caller
                  for their name + address and find the matching prospect
                  here, then tie the inbound phone to that case via
                  Save. */}
              {showLegacyPhoneMatchPicker && phoneCandidates.length === 0 && leadLookupPhone ? (
                <div className="rounded-md border border-dashed border-border bg-muted/20 p-2 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      No phone match for {leadLookupPhone}
                    </div>
                    <button
                      type="button"
                      className="text-[10px] font-medium text-primary hover:underline"
                      onClick={() => setNameSearchOpen((v) => !v)}
                    >
                      {nameSearchOpen ? "hide" : "search by name + address"}
                    </button>
                  </div>
                  {nameSearchOpen ? (
                    <div className="grid gap-1.5 sm:grid-cols-2 md:grid-cols-6">
                      <Input
                        value={nameSearchInputs.firstName}
                        onChange={(e) =>
                          setNameSearchInputs((p) => ({ ...p, firstName: e.target.value }))
                        }
                        placeholder="First"
                        className="text-xs"
                      />
                      <Input
                        value={nameSearchInputs.lastName}
                        onChange={(e) =>
                          setNameSearchInputs((p) => ({ ...p, lastName: e.target.value }))
                        }
                        placeholder="Last"
                        className="text-xs"
                      />
                      <Input
                        value={nameSearchInputs.address}
                        onChange={(e) =>
                          setNameSearchInputs((p) => ({ ...p, address: e.target.value }))
                        }
                        placeholder="Street"
                        className="text-xs sm:col-span-2"
                      />
                      <Input
                        value={nameSearchInputs.city}
                        onChange={(e) =>
                          setNameSearchInputs((p) => ({ ...p, city: e.target.value }))
                        }
                        placeholder="City"
                        className="text-xs"
                      />
                      <Input
                        value={nameSearchInputs.state}
                        onChange={(e) =>
                          setNameSearchInputs((p) => ({
                            ...p,
                            state: e.target.value.toUpperCase().slice(0, 2),
                          }))
                        }
                        placeholder="State"
                        className="text-xs"
                      />
                      {nameSearchActive ? (
                        <div className="text-[10px] text-muted-foreground sm:col-span-6">
                          {nameSearchQuery.isFetching
                            ? "Searching mail-intake records…"
                            : `Found ${nameCandidates.length} record${nameCandidates.length === 1 ? "" : "s"} matching name/address — click any in the bar above to load it.`}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Primary identity */}
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-4">
                <Input
                  value={form.firstName}
                  onChange={(e) => handleFormChange("firstName", e.target.value)}
                  placeholder="First name"
                />
                <Input
                  value={form.lastName}
                  onChange={(e) => handleFormChange("lastName", e.target.value)}
                  placeholder="Last name"
                />
                <Input
                  value={form.email}
                  onChange={(e) => handleFormChange("email", e.target.value)}
                  placeholder="Email"
                  leadingIcon={<Mail />}
                />
                <Input
                  type="password"
                  value={form.ssn}
                  onChange={(e) => handleFormChange("ssn", e.target.value)}
                  placeholder="SSN (leave blank to keep current)"
                  autoComplete="off"
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-4">
                <Input
                  value={form.cellPhone}
                  onChange={(e) => handleFormChange("cellPhone", e.target.value)}
                  placeholder="Cell / phone 1"
                  leadingIcon={<Phone />}
                />
                <Input
                  value={form.homePhone}
                  onChange={(e) => handleFormChange("homePhone", e.target.value)}
                  placeholder="Home / phone 2"
                  leadingIcon={<Phone />}
                />
                <Input
                  value={form.caseId}
                  onChange={(e) => handleFormChange("caseId", e.target.value)}
                  placeholder="Case ID — paste to look up"
                  className="font-mono"
                />
              </div>
              {/* Spouse — same shape, separated by a tiny header so it's
                  obvious where the second person's fields begin. */}
              <div className="pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Spouse
              </div>
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-4">
                <Input
                  value={form.spouseFirstName}
                  onChange={(e) => handleFormChange("spouseFirstName", e.target.value)}
                  placeholder="Spouse first name"
                />
                <Input
                  value={form.spouseLastName}
                  onChange={(e) => handleFormChange("spouseLastName", e.target.value)}
                  placeholder="Spouse last name"
                />
                <Input
                  value={form.spouseEmail}
                  onChange={(e) => handleFormChange("spouseEmail", e.target.value)}
                  placeholder="Spouse email"
                  leadingIcon={<Mail />}
                />
                <Input
                  type="password"
                  value={form.spouseSsn}
                  onChange={(e) => handleFormChange("spouseSsn", e.target.value)}
                  placeholder="Spouse SSN"
                  autoComplete="off"
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-4">
                <Input
                  value={form.spouseCellPhone}
                  onChange={(e) => handleFormChange("spouseCellPhone", e.target.value)}
                  placeholder="Spouse cell / phone 1"
                  leadingIcon={<Phone />}
                />
                <Input
                  value={form.spouseHomePhone}
                  onChange={(e) => handleFormChange("spouseHomePhone", e.target.value)}
                  placeholder="Spouse home / phone 2"
                  leadingIcon={<Phone />}
                />
              </div>
            </CardContent>
          </Card>

          {LIVE_COACH_PANEL_ENABLED ? (
            <LiveCoachPanel
              agentEmail={data?.agent?.email || user?.email || null}
              agentExtension={currentExtensionId}
              agentName={data?.agent?.name || user?.name || null}
              currentUii={currentCallUii || null}
              currentCallSessionId={currentCallSessionId || null}
              queueItemId={servedQueueTicketId || null}
              caseId={resolvedCaseId || servedQueueCaseId || null}
              contactName={
                `${form.firstName} ${form.lastName}`.trim()
                || selected?.name
                || servedQueueContact?.name
                || currentCall?.name
                || null
              }
              releaseKey={coachReleaseSignal?.key || null}
              releaseReason={coachReleaseSignal?.reason || null}
              layout="embedded"
              chatPlacement="inline"
              panelView={coachWindowTab}
              onSessionResolved={LIVE_COACH_COCKPIT_ENABLED ? setCoachCockpitSessionId : undefined}
              headerControls={
                <div className="flex rounded-md border border-sky-200 bg-white p-0.5 shadow-sm">
                  <button
                    type="button"
                    onClick={() => setCoachWindowTab("coach")}
                    className={cn(
                      "rounded px-2 py-1 text-[11px] font-semibold transition-colors",
                      coachWindowTab === "coach"
                        ? "bg-sky-600 text-white"
                        : "text-sky-700 hover:bg-sky-50",
                    )}
                  >
                    Coach
                  </button>
                  <button
                    type="button"
                    onClick={() => setCoachWindowTab("guidance")}
                    className={cn(
                      "rounded px-2 py-1 text-[11px] font-semibold transition-colors",
                      coachWindowTab === "guidance"
                        ? "bg-sky-600 text-white"
                        : "text-sky-700 hover:bg-sky-50",
                    )}
                  >
                    Guidance
                  </button>
                  <button
                    type="button"
                    onClick={() => setCoachWindowTab("interview")}
                    className={cn(
                      "rounded px-2 py-1 text-[11px] font-semibold transition-colors",
                      coachWindowTab === "interview"
                        ? "bg-sky-600 text-white"
                        : "text-sky-700 hover:bg-sky-50",
                    )}
                  >
                    Interview
                  </button>
                </div>
              }
              contentOverride={(askCoach) => (
                coachWindowTab === "interview" ? (
                  <InterviewSnapshotCard
                    domain={caseDomain}
                    caseId={resolvedCaseId || form.caseId || selected?.caseId || ""}
                    prospectName={
                      `${form.firstName} ${form.lastName}`.trim()
                      || selected?.name
                      || [lookupMatch?.firstName, lookupMatch?.lastName].filter(Boolean).join(" ")
                      || servedQueueContact?.name
                      || ""
                    }
                    phone={form.cellPhone || selectedPhone || currentCallPhone || ""}
                    queueActionKey={servedQueueActionKey}
                    queueItemId={servedQueueTicketId}
                    queueTicketId={servedQueueTicketId}
                    initialSnapshot={selected?.interviewSnapshot || servedQueueContact?.interviewSnapshot || null}
                    askCoach={askCoach}
                  />
                ) : null
              )}
            />
          ) : (
            <div className="rounded-md border border-dashed border-sky-200 bg-white p-4 text-sm text-muted-foreground">
              Coach is hidden by feature flag.
            </div>
          )}

          {LIVE_COACH_COCKPIT_ENABLED ? (
            <CoachCockpit sessionId={coachCockpitSessionId} className="mt-3" />
          ) : null}

        </section>

        {/* ── RIGHT: appointments + Logics context ──────────────────────── */}
        <aside className="flex-shrink-0 lg:w-[370px]">
          <div className="lg:sticky lg:top-20 space-y-4">
            <SharedAppointmentList
              appointments={appointmentItems}
              onCallNow={handleCallAppointmentNow}
              onRelease={handleReleaseAppointment}
              callingAppointmentId={String(callAppointmentNow.variables?.appointmentId || "") || null}
              isReleasing={releaseAppointment.isPending}
              isCallingNow={callAppointmentNow.isPending}
            />
            {resolvedCaseId ? (
              <LogicsWorkspaceCard
                domain={caseDomain}
                resolvedCaseId={resolvedCaseId}
                resolvedPhone={
                  selected?.phone || lookupResult?.match?.phone || currentCallPhone || null
                }
              />
            ) : null}
          </div>
        </aside>
      </div>

      {/* ─── Modals ───────────────────────────────────────────────────── */}
      <AppointmentModal
        open={appointmentModalOpen}
        onClose={() => setAppointmentModalOpen(false)}
        caseId={assignCaseId != null ? String(assignCaseId) : null}
        prospectName={`${form.firstName} ${form.lastName}`.trim() || selected?.name || ""}
        phone={form.cellPhone || selectedPhone || currentCallPhone || ""}
        sourceName={form.sourceName || selected?.source || ""}
        isLoading={createAppointment.isPending || assignCaseToMe.isPending || disposition.isPending}
        canAssign={assignCaseId != null}
        canPostdate={SHOW_POSTDATE_DISPOSITION && dispositionCaseId != null}
        onSubmit={handleAppointmentSubmit}
      />
      </div>
    </>
  );
}
