import * as React from "react";
import {
  ChevronDown,
  ChevronUp,
  Clock3,
  ExternalLink,
  Mail,
  MessageCircleMore,
  Phone,
  RefreshCw,
  Save,
  Search,
  UserCheck,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { CaseLink } from "@/components/ui/CaseLink";
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
  flattenCxSearch,
  useCxAssignCaseToMe,
  useCxCallQueue,
  useCxCallQueueMulti,
  useCxCaseActivities,
  useCxCaseInvoices,
  useCxCasePayments,
  useCxCaseTasks,
  useCxCaseLogicsInfo,
  useCxCommLog,
  useCxLogicsNotes,
  useCxDialAny,
  useCxDisposition,
  useCxEmail,
  useCxLeadCandidates,
  useCxLeadLookup,
  useCxLogicsActivity,
  useCxLogicsAmortization,
  useCxLogicsCreateCase,
  useCxLogicsInvoice,
  useCxLogicsTask,
  useCxLogicsUpdateCase,
  useCxSearch,
  useCxSetStatus,
  useCxSimulateCallAny,
  useCxText,
  useCxWorkspace,
} from "@/lib/api/queries/cx";
import { useClientDetail } from "@/lib/api/queries/clients";
import type {
  ClientCaseCall,
  ClientCaseMessage,
  ClientSearchMatch,
  CxCallQueueItem,
  CxLeadCandidate,
  CxLeadLookupMatch,
  CxLeadLookupSource,
  FreshLeadGate,
} from "@/lib/api/types";
import type { CommLogEntry } from "@/lib/api/queries/cx";
import { KNOWN_DOMAINS, useDomainStore } from "@/lib/domain/domainStore";
import { useSession } from "@/lib/auth/useSession";
import { formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type SearchScope = "all" | "prospects" | "clients";

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
  // Legacy fields — still preserved for the lookup ladder + Logics
  // create payload, but no longer surfaced in the identity strip.
  sourceName: string;
  notes: string;
  caseId: string;
};

type CaseFormField = keyof CaseForm;
type CaseFormDirty = Record<CaseFormField, boolean>;

type LibraryEntry = {
  id: string;
  label: string;
  body: string;
  subject?: string;
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

function unwrapMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractLogicsFieldText(payload: unknown, ...keys: string[]): string {
  const outer = asRecord(unwrapMaybeJson(payload));
  const result = asRecord(unwrapMaybeJson(outer.result));
  const candidates = [
    result.data,
    result.Data,
    outer.data,
    outer.Data,
    payload,
  ];
  for (const candidate of candidates) {
    const unwrapped = unwrapMaybeJson(candidate);
    if (typeof unwrapped === "string" && unwrapped.trim()) return unwrapped;
    const record = asRecord(unwrapped);
    const value = readString(record, ...keys);
    if (value) return value;
  }
  return "";
}

function extractLogicsNotesText(payload: unknown): string {
  return extractLogicsFieldText(payload, "Notes", "notes", "CaseNotes", "caseNotes");
}

function extractLogicsActivityNotesText(payload: unknown): string {
  return extractLogicsFieldText(payload, "ActivityNotes", "activityNotes");
}

function normalizeComparablePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function buildTextLibrary(domain: string): LibraryEntry[] {
  return [
    {
      id: "intro",
      label: "Fresh reachout",
      body: "Hi {{firstName}}, this is {{agentName}} with {{domainLabel}}. I'm following up on your inquiry and can help today.",
    },
    {
      id: "callback",
      label: "Callback nudge",
      body: "Hi {{firstName}}, I missed you earlier. Text me here if you want me to call back at a better time.",
    },
    {
      id: "status",
      label: `${domain} status touch`,
      body: "Hi {{firstName}}, quick status check from {{domainLabel}}. I'm here if you want to review your next step.",
    },
  ];
}

// Entries here mirror the server's template catalog in
// `packages/shared-services/src/emailTemplateService.js`. The `id`
// matches a real `templateKey` so the send path renders server-side
// with full brand-aware header / signature / footer.
function buildEmailLibrary(_domain: string): LibraryEntry[] {
  return [
    {
      id: "direct-intro",
      label: "Direct intro",
      subject: "Introduction — {{domainLabel}}",
      body: "Hi {{firstName}},\n\nThis is {{agentName}} with {{domainLabel}}. I wanted to reach out directly so you have a clear point of contact going forward.\n\nIf any questions come up, reply here or call me at {{phone}}.\n\nTalk soon,\n{{agentName}}",
    },
    {
      id: "call-scheduled",
      label: "Call scheduled",
      subject: "Confirming our call",
      body: "Hi {{firstName}},\n\nConfirming our call on [time]. I'll reach out to [phone] at that time.\n\nIf you need to reschedule, reply here or text me at {{phone}}.\n\n{{agentName}}",
    },
    {
      id: "documents-requested",
      label: "Documents requested",
      subject: "Documents we'll need — next step",
      body: "Hi {{firstName}},\n\nTo keep things moving on your case, could you send over the items below? Any legible photo or scan works.\n\n[list]\n\nIf anything doesn't apply, just let me know. {{agentName}}",
    },
    {
      id: "status-update",
      label: "Status update",
      subject: "Quick update on your case",
      body: "Hi {{firstName}},\n\nQuick update — [summary]\n\nI'll keep you posted. Anything on your end, reply here or call {{phone}}.\n\n{{agentName}}",
    },
  ];
}

function buildTemplateContext(
  domain: string,
  agentName: string,
  selected: ContactContext | null,
  fallbackPhone: string,
) {
  const fullName = selected?.name || "there";
  const firstName = fullName.split(" ")[0] || fullName;
  return {
    domainLabel: domain,
    agentName: agentName || "your agent",
    firstName,
    phone: selected?.phone || fallbackPhone || "",
  };
}

function renderTemplate(template: string, context: Record<string, string>) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => context[key] ?? "");
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

function contactFromCurrentCall(raw: Record<string, unknown> | null | undefined): ContactContext | null {
  if (!raw) return null;
  // For inbound calls the lead's phone is `from` (caller); for outbound
  // it's `to` (callee). The snapshot stores both, so pick by direction
  // — otherwise the lookup ladder ends up scrambling against the
  // agent's own DID.
  const direction = String(readString(raw, "direction") || "").toLowerCase();
  const isOutbound = direction === "outbound";
  const phone =
    readString(raw, "phone") ||
    (isOutbound
      ? readString(raw, "to", "from", "ani")
      : readString(raw, "from", "ani", "to"));
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

function contactFromSearch(match: ClientSearchMatch): ContactContext {
  return {
    caseId: match.caseId,
    name: match.name || null,
    phone: match.phone || null,
    email: match.email || null,
    status: match.status || null,
    source: match.domain || null,
  };
}

type QueueFamilyKey = "fresh-day1" | "fresh-day2to10" | "aged" | "unassigned";
type QueueAdvanceMode = "manual" | "auto";

type QueueFamilyDisplay = {
  label: string;
  sortRank: number;
  dotClassName: string;
};

const AUTO_SERVE_DELAY_SECONDS = 5;
const QUEUE_ADVANCE_MODE_STORAGE_KEY = "parallel.cx.queueAdvanceMode";

const QUEUE_FAMILY_DISPLAY: Record<QueueFamilyKey, QueueFamilyDisplay> = {
  "fresh-day1": {
    label: "New",
    sortRank: 0,
    dotClassName: "bg-emerald-500",
  },
  "fresh-day2to10": {
    label: "2-15",
    sortRank: 1,
    dotClassName: "bg-sky-500",
  },
  aged: {
    label: "Aged",
    sortRank: 2,
    dotClassName: "bg-red-500",
  },
  unassigned: {
    label: "Other",
    sortRank: 3,
    dotClassName: "bg-muted-foreground",
  },
};

const QUEUE_LEGEND_FAMILIES: QueueFamilyKey[] = ["fresh-day1", "fresh-day2to10", "aged"];

function normalizeQueueFamily(raw: string | null | undefined): QueueFamilyKey | null {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "fresh-day1" || value === "day0" || value === "fresh" || value === "hot") {
    return "fresh-day1";
  }
  if (
    value === "fresh-day2to10"
    || value === "fresh-day2to15"
    || value === "day2to10"
    || value === "day2to15"
    || value === "day2_15"
    || value === "day1"
    || value === "day10"
    || value === "day15"
    || value.includes("day 2")
    || value.includes("day2")
    || value.includes("2-10")
    || value.includes("2-15")
  ) {
    return "fresh-day2to10";
  }
  if (value === "aged" || value.includes("aged") || value.includes("prospect")) {
    return "aged";
  }
  return null;
}

function inferQueueFamily(item: CxCallQueueItem): QueueFamilyKey {
  const snapshot = asRecord(item.payloadSnapshot);
  const leadBody = asRecord(item.leadBody);
  const merged = Object.keys(leadBody).length > 0 ? { ...snapshot, ...leadBody } : snapshot;
  const explicit =
    normalizeQueueFamily(item.queueFamily)
    || normalizeQueueFamily(readString(merged, "queueFamily", "queueTier", "leadQueueFamily"))
    || normalizeQueueFamily(item.currentStage)
    || normalizeQueueFamily(item.nextActionType);
  if (explicit) return explicit;

  const activeDayRaw = merged.callPlan && typeof merged.callPlan === "object"
    ? asRecord(merged.callPlan).activeDay
    : item.queueDayIndex;
  const activeDay = Number(activeDayRaw);
  if (Number.isFinite(activeDay)) {
    if (activeDay <= 0) return "fresh-day1";
    if (activeDay <= 15) return "fresh-day2to10";
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

function getQueueSortRank(item: CxCallQueueItem) {
  const family = inferQueueFamily(item);
  if (family === "fresh-day1") {
    return isFreshFirstContactQueueItem(item) ? 0 : 1.5;
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

function humanizeCxRoutingReason(reason: string | null | undefined) {
  const value = String(reason || "").trim().toLowerCase();
  if (!value) return "";
  if (value === "ex-busy") return "auto-blocked by EX activity";
  if (value === "manual-unavailable") return "manually paused";
  if (value === "manual-available") return "manually resumed";
  if (value === "ex-idle") return "ready for new CX leads";
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
  onCancel,
}: {
  remaining: number | null;
  totalSeconds?: number;
  onCancel: () => void;
}) {
  const safeTotal = Math.max(1, Number(totalSeconds) || AUTO_SERVE_DELAY_SECONDS);
  const safeRemaining = Math.max(0, Math.min(safeTotal, Number(remaining ?? safeTotal)));
  const progress = Math.max(0, Math.min(100, ((safeTotal - safeRemaining) / safeTotal) * 100));

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
              Next call in {safeRemaining}s
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              Auto serve is preparing the next lead.
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Cancel
        </button>
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
  fill("notes", match.notes);
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

function formatDuration(sec?: number | null) {
  if (!sec || sec < 0) return "—";
  const mins = Math.floor(sec / 60);
  const rem = Math.floor(sec % 60);
  return `${mins}:${String(rem).padStart(2, "0")}`;
}

// ─── Collapsible section shell ──────────────────────────────────────────────

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

// ─── Template preview modal ─────────────────────────────────────────────────

type TemplatePreviewModalProps = {
  open: boolean;
  onClose: () => void;
  entry: LibraryEntry | null;
  context: Record<string, string>;
  onInsert: (entry: LibraryEntry) => void;
};

function TemplatePreviewModal({ open, onClose, entry, context, onInsert }: TemplatePreviewModalProps) {
  if (!entry) {
    return (
      <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : null)}>
        <DialogContent />
      </Dialog>
    );
  }
  const renderedSubject = entry.subject ? renderTemplate(entry.subject, context) : "";
  const renderedBody = renderTemplate(entry.body, context);
  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : null)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{entry.label}</DialogTitle>
          <DialogDescription>
            Preview below uses the current case context. Insert replaces the compose fields.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {renderedSubject ? (
            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Subject
              </div>
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
                {renderedSubject}
              </div>
            </div>
          ) : null}
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Body
            </div>
            <div className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
              {renderedBody}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onInsert(entry)}>Insert</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Contact history rendering ──────────────────────────────────────────────

function CallRow({ call }: { call: ClientCaseCall }) {
  const tone =
    call.direction === "inbound" ? "info" : call.direction === "outbound" ? "accent" : "neutral";
  const when = call.callStartTime || call.callEndTime;
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusPill tone={tone}>{call.direction || "call"}</StatusPill>
          <span className="text-sm text-foreground">
            {call.direction === "inbound"
              ? call.fromNumber || call.toNumber || "Unknown caller"
              : call.toNumber || call.fromNumber || "Unknown callee"}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{formatDuration(call.durationSec)}</span>
          <span>{when ? formatRelative(when) : "—"}</span>
        </div>
      </div>
      {call.agentName ? (
        <div className="text-[11px] text-muted-foreground">Agent: {call.agentName}</div>
      ) : null}
      {call.transcription?.recordingUri ? (
        <audio
          controls
          preload="none"
          src={call.transcription.recordingUri}
          className="w-full"
        />
      ) : null}
      {call.transcription?.text ? (
        <div className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {call.transcription.text}
        </div>
      ) : null}
    </div>
  );
}

function TextBubble({ message }: { message: ClientCaseMessage }) {
  const isInbound = message.direction === "inbound";
  return (
    <div className={cn("flex", isInbound ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[82%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm shadow-sm",
          isInbound
            ? "rounded-tl-sm border border-border bg-card text-foreground"
            : "rounded-tr-sm bg-primary/10 text-foreground",
        )}
      >
        <div>{message.body}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          {message.createdAt ? (
            <span>{new Date(message.createdAt).toLocaleString()}</span>
          ) : null}
          {message.providerStatus ? (
            <span className="rounded bg-muted px-1 py-0.5 font-medium uppercase tracking-wide">
              {message.providerStatus}
            </span>
          ) : null}
          {message.autoResponded ? (
            <span className="rounded bg-muted px-1 py-0.5 font-medium uppercase tracking-wide">
              auto
            </span>
          ) : null}
        </div>
      </div>
    </div>
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

/**
 * Small badge rendered per search-result row telling the operator
 * which tier the match came from. Logics rows get the loudest tint
 * because they signal "not yet in Mongo — clicking will import it."
 */
function SearchSourcePill({ source }: { source?: string }) {
  if (!source) return null;
  const style =
    source === "caseProfile"
      ? { label: "Case", cls: "border-primary/40 bg-primary/10 text-primary" }
      : source === "masterProspect"
        ? { label: "Prospect", cls: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300" }
        : source === "leadCadence"
          ? { label: "Cadence", cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300" }
          : source === "logics"
            ? { label: "Logics", cls: "border-muted-foreground/40 bg-muted text-muted-foreground" }
            : null;
  if (!style) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm border px-1.5 text-[10px] font-semibold uppercase tracking-wider",
        style.cls,
      )}
      title={
        source === "logics"
          ? "Match found in Logics — not yet saved to our database. Click to pull it in."
          : `Match from ${style.label}`
      }
    >
      {style.label}
    </span>
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

// Per-company Logics web UI subdomain. Logics (IRS Logics, not the
// generic Logiqs SaaS) is a WebForms SPA — the URL is always
// `Default.aspx#` regardless of which case you're on, so there's no
// deep link. Best we can do is open the tenant's home page and drop
// the case id on the clipboard for the operator to paste into the
// in-app search. Different tenants have different subdomains:
//   - TAG  → taxag.irslogics.com
//   - WYNN → (TBD — confirm with ops when flipping on)
const LOGICS_WEB_SUBDOMAIN: Record<string, string> = {
  TAG: "taxag",
  WYNN: "wynn", // placeholder — may need tweak
};

function buildLogicsUrl(domain: string): string {
  const key = String(domain || "TAG").toUpperCase();
  const subdomain = LOGICS_WEB_SUBDOMAIN[key] || "taxag";
  return `https://${subdomain}.irslogics.com/Default.aspx`;
}

async function openCaseInLogics(domain: string, caseId: number | string): Promise<boolean> {
  // Copy the case id first so the operator can paste it into the
  // Logics home page's search. Best-effort — clipboard may fail on
  // insecure contexts; we still open the tab either way.
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(String(caseId));
      copied = true;
    }
  } catch {
    copied = false;
  }
  window.open(buildLogicsUrl(domain), "_blank", "noopener,noreferrer");
  return copied;
}

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
function AmortizationSubsection({
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

// Two-tab section header — used inside merged panels (Activities/Tasks
// and Financials) to switch between subsections without spawning more
// collapsible cards.
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
    <div className="flex gap-1 px-3 pt-2">
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

function NotesSubsection({
  domain,
  resolvedCaseId,
}: {
  domain: string;
  resolvedCaseId: string;
}) {
  const caseIdNum = Number(resolvedCaseId);
  const info = useCxCaseLogicsInfo(domain, caseIdNum);
  const save = useCxLogicsNotes(domain);

  // Pull current value from the live Logics fetch. The route normalizes
  // CaseInfo notes plus note-like activity history into a Notes value,
  // but keep the unwrapping defensive because Logics envelopes vary.
  const liveValue = React.useMemo(() => {
    return extractLogicsNotesText(info.data);
  }, [info.data]);
  const activityNotesValue = React.useMemo(() => {
    return extractLogicsActivityNotesText(info.data);
  }, [info.data]);

  // Local edit state. Initialize from `liveValue` when it first arrives,
  // and re-sync ONLY when the live value changes externally AND the user
  // hasn't started editing in this mount. That keeps Logics-side edits
  // (made in Logics' own UI while this panel is open) from being lost,
  // without clobbering whatever the agent is typing right now.
  const [draft, setDraft] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => {
    if (!dirty) setDraft(liveValue);
  }, [liveValue, dirty]);

  const value = draft ?? liveValue;
  const changed = dirty && value !== liveValue;

  async function handleSave() {
    try {
      await save.mutateAsync({ caseId: caseIdNum, notes: value });
      setDirty(false);
      info.refetch();
      toast("Notes saved", {
        description: "Logics Notes updated for this case.",
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Something went wrong.";
      toast.error("Save failed", { description: msg });
    }
  }

  function handleRevert() {
    setDraft(liveValue);
    setDirty(false);
  }

  return (
    <div className="space-y-2 p-3">
      {info.isLoading && draft == null ? (
        <div className="text-[11px] text-muted-foreground">Loading notes…</div>
      ) : (
        <>
          <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Case notes
            </div>
            <textarea
              className="min-h-[110px] w-full rounded-md border border-input bg-card px-2 py-1.5 text-xs leading-relaxed font-mono"
              value={value}
              onChange={(e) => {
                setDraft(e.target.value);
                setDirty(true);
              }}
              placeholder="No case notes yet."
              spellCheck
            />
          </div>
          {activityNotesValue ? (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Activity notes
              </div>
              <textarea
                className="min-h-[170px] w-full rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs leading-relaxed font-mono text-foreground"
                value={activityNotesValue}
                readOnly
                spellCheck={false}
              />
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] text-muted-foreground">
              {info.isFetching ? (
                <span>Refreshing…</span>
              ) : changed ? (
                <span className="text-amber-600 dark:text-amber-400">Unsaved changes</span>
              ) : (
                <span>Synced with Logics</span>
              )}
            </div>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => info.refetch()}
                disabled={info.isFetching}
                title="Pull the latest Notes from Logics (discards unsaved changes if you've not edited)"
              >
                Refresh
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleRevert}
                disabled={!changed}
              >
                Revert
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={handleSave}
                disabled={!changed || save.isPending}
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </>
      )}
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
    return <div className="p-3 text-[11px] text-muted-foreground">Loading communications…</div>;
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
          {log.data?.counts.callLogs ? <> · {log.data.counts.callLogs} calls</> : null}
          {log.data?.counts.conversationMessages ? <> · {log.data.counts.conversationMessages} messages</> : null}
          {log.data?.counts.leadCadence ? <> · cadence active</> : null}
        </div>
        <button
          type="button"
          onClick={() => log.refetch()}
          disabled={log.isFetching}
          className="text-primary hover:underline disabled:opacity-50"
        >
          {log.isFetching ? "Refreshing…" : "Refresh"}
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
  const dirLabel = entry.direction === "inbound"
    ? "← in"
    : entry.direction === "scheduled"
      ? "▷ scheduled"
      : "→ out";
  const tone =
    entry.status === "failed" || entry.status === "no-answer"
      ? "text-destructive"
      : entry.direction === "inbound"
        ? "text-foreground"
        : "text-muted-foreground";
  const bodyPreview = entry.body
    ? entry.body.replace(/\s+/g, " ").trim().slice(0, 140)
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
            <span className="text-[10px] text-muted-foreground">· {entry.status}</span>
          </div>
          {bodyPreview ? (
            <div className="mt-0.5 truncate text-foreground">{bodyPreview}</div>
          ) : entry.channel === "call" && entry.metadata?.durationSeconds ? (
            <div className="mt-0.5 text-muted-foreground">
              {Math.round(Number(entry.metadata.durationSeconds))}s call
              {entry.actor?.name ? ` · ${entry.actor.name}` : ""}
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
  const [notesOpen, setNotesOpen] = React.useState(true);

  const [commLogOpen, setCommLogOpen] = React.useState(true);

  const [historyOpen, setHistoryOpen] = React.useState(true);
  const [historyTab, setHistoryTab] = React.useState<"activities" | "tasks">("activities");

  const [financialsOpen, setFinancialsOpen] = React.useState(true);
  const [financialsTab, setFinancialsTab] = React.useState<
    "invoices" | "payments" | "amortization"
  >("payments");

  return (
    <div className="space-y-2">
      {/* Notes — single editable text field on the Logics Case object.
         Pre-loaded with the live value, save = overwrite. Distinct from
         the activity-comment chain in the History → Activities tab. */}
      <Collapsible
        title="Notes"
        open={notesOpen}
        onToggle={() => setNotesOpen((v) => !v)}
      >
        <NotesSubsection domain={domain} resolvedCaseId={resolvedCaseId} />
      </Collapsible>

      {/* Communications log — unified read across SMS (case-profile +
         conversation-messages), calls (call-log), and cadence attempts
         (lead-cadence). Newest-first. Source-agnostic so it works
         pre-conversion via phone-only too. */}
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

      {/* History — Activities + Tasks share one card, switched by tabs */}
      <Collapsible
        title="History"
        open={historyOpen}
        onToggle={() => setHistoryOpen((v) => !v)}
      >
        <PanelTabs
          tabs={[
            { key: "activities", label: "Activities" },
            { key: "tasks", label: "Tasks" },
          ]}
          active={historyTab}
          onChange={(k) => setHistoryTab(k as typeof historyTab)}
        />
        {historyTab === "activities" ? (
          <ActivitiesSubsection domain={domain} resolvedCaseId={resolvedCaseId} />
        ) : (
          <TasksSubsection domain={domain} resolvedCaseId={resolvedCaseId} />
        )}
      </Collapsible>

      {/* Financials — Invoices + Payments + Amortization share one card */}
      <Collapsible
        title="Financials"
        open={financialsOpen}
        onToggle={() => setFinancialsOpen((v) => !v)}
      >
        <PanelTabs
          tabs={[
            { key: "payments", label: "Payments" },
            { key: "invoices", label: "Invoices" },
            { key: "amortization", label: "Amortization" },
          ]}
          active={financialsTab}
          onChange={(k) => setFinancialsTab(k as typeof financialsTab)}
        />
        {financialsTab === "payments" ? (
          <PaymentsSubsection domain={domain} resolvedCaseId={resolvedCaseId} />
        ) : financialsTab === "invoices" ? (
          <InvoicesSubsection domain={domain} resolvedCaseId={resolvedCaseId} />
        ) : (
          <AmortizationSubsection domain={domain} resolvedCaseId={resolvedCaseId} />
        )}
      </Collapsible>
    </div>
  );
}

// ─── Main workspace ─────────────────────────────────────────────────────────

export function CXWorkspace() {
  const domain = useDomainStore((s) => s.domain || "TAG");
  const setDomain = useDomainStore((s) => s.setDomain);
  const { user } = useSession();
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
  // Sensitivity toggle for "create from scratch" path — when there's
  // no match ANYWHERE and the operator clicks Save, the first click
  // flips this to true and toasts "no matches, click again to confirm".
  // The second click actually POSTs the new case.
  const [confirmCreateNew, setConfirmCreateNew] = React.useState(false);
  const [searchText, setSearchText] = React.useState("");
  const [searchScope, setSearchScope] = React.useState<SearchScope>("all");
  const [searchDropdownOpen, setSearchDropdownOpen] = React.useState(false);
  const searchRef = React.useRef<HTMLDivElement | null>(null);

  // Compose panel state (collapsible — default expanded)
  const [textOpen, setTextOpen] = React.useState(true);
  const [emailOpen, setEmailOpen] = React.useState(true);

  // Text compose
  const [textPhone, setTextPhone] = React.useState("");
  const [textBody, setTextBody] = React.useState("");
  const [textTemplateId, setTextTemplateId] = React.useState<string | null>(null);

  // Email compose
  const [emailTo, setEmailTo] = React.useState("");
  const [emailSubject, setEmailSubject] = React.useState("");
  const [emailBody, setEmailBody] = React.useState("");
  // Server-side HBS template armed for send. Cleared when either field is edited.
  const [emailTemplateKey, setEmailTemplateKey] = React.useState<string | null>(null);
  const [emailTemplateId, setEmailTemplateId] = React.useState<string | null>(null);

  // Preview modals
  const [textPreview, setTextPreview] = React.useState<LibraryEntry | null>(null);
  const [emailPreview, setEmailPreview] = React.useState<LibraryEntry | null>(null);

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
    notes: "",
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
    notes: false,
    caseId: false,
  };
  const [form, setForm] = React.useState<CaseForm>(BLANK_FORM);
  const [dirty, setDirty] = React.useState<CaseFormDirty>(BLANK_DIRTY);
  const [servingQueueKey, setServingQueueKey] = React.useState<string | null>(null);
  const [servedQueueCaseId, setServedQueueCaseId] = React.useState<string | null>(null);
  const [servedQueueDomain, setServedQueueDomain] = React.useState<string | null>(null);
  const [servedQueueActionKey, setServedQueueActionKey] = React.useState<string | null>(null);
  const [servedQueueTicketId, setServedQueueTicketId] = React.useState<string | null>(null);
  const [servedQueueContact, setServedQueueContact] = React.useState<ContactContext | null>(null);
  const [suppressedCallSessionId, setSuppressedCallSessionId] = React.useState<string | null>(null);
  const [queueAdvanceMode, setQueueAdvanceMode] = React.useState<QueueAdvanceMode>(() => {
    if (typeof window === "undefined") return "manual";
    try {
      return localStorage.getItem(QUEUE_ADVANCE_MODE_STORAGE_KEY) === "auto" ? "auto" : "manual";
    } catch {
      return "manual";
    }
  });
  const [autoServeDueAt, setAutoServeDueAt] = React.useState<number | null>(null);
  const [autoServeRemaining, setAutoServeRemaining] = React.useState<number | null>(null);
  const [suppressedQueueItems, setSuppressedQueueItems] = React.useState<Record<string, number>>({});
  const autoServeInFlightRef = React.useRef(false);

  function clearServedQueueSelection() {
    setServingQueueKey(null);
    setServedQueueCaseId(null);
    setServedQueueDomain(null);
    setServedQueueActionKey(null);
    setServedQueueTicketId(null);
    setServedQueueContact(null);
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
    setConfirmCreateNew(false);
    setTextBody("");
    setTextTemplateId(null);
    setEmailSubject("");
    setEmailBody("");
    setEmailTemplateKey(null);
    setEmailTemplateId(null);
  }

  function cancelAutoServe() {
    setAutoServeDueAt(null);
    setAutoServeRemaining(null);
    autoServeInFlightRef.current = false;
  }

  function scheduleAutoServe(delaySeconds = AUTO_SERVE_DELAY_SECONDS) {
    if (queueAdvanceMode !== "auto") return;
    const safeDelay = Math.max(0, Number(delaySeconds) || 0);
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
    try {
      localStorage.setItem(QUEUE_ADVANCE_MODE_STORAGE_KEY, queueAdvanceMode);
    } catch {
      // Preference persistence is nice-to-have; the visible toggle remains authoritative.
    }
    if (queueAdvanceMode !== "auto") cancelAutoServe();
  }, [queueAdvanceMode]);

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

  // Data
  const workspace = useCxWorkspace(domain);
  const callQueue = useCxCallQueue(domain);
  const multiCallQueues = useCxCallQueueMulti(isAdminUser ? availableDomains : []);
  const search = useCxSearch(domain, searchText, searchScope);

  // The resolved caseId drives everything in the "existing case" part of
  // the center column: it's whichever of the form caseId (operator typed
  // / auto-populated) or the queue-/search-selected caseId is present.
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
  const rawCurrentCall = contactFromCurrentCall(
    (data?.ex.currentCall as Record<string, unknown> | null | undefined) ?? null,
  );
  const rawCurrentCallSessionId = rawCurrentCall?.sessionId || "";
  const currentCallIsSuppressed =
    Boolean(rawCurrentCallSessionId) && rawCurrentCallSessionId === suppressedCallSessionId;
  const currentCall = currentCallIsSuppressed ? null : rawCurrentCall;
  const currentCallPhone = currentCall?.phone || "";

  const textLibrary = React.useMemo(() => buildTextLibrary(domain), [domain]);
  const emailLibrary = React.useMemo(() => buildEmailLibrary(domain), [domain]);

  // detail/selectedPhone/selectedEmail/templateContext + the auto-
  // hydrate effects all need clientDetail.data, which comes from a
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
    //   • selected (queue/search/old-lookup snapshot)
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
    setConfirmCreateNew(false);
    // Wipe outbound message drafts — a draft text/email composed for
    // the previous caller shouldn't sit there when a new call lands.
    setTextBody("");
    setTextTemplateId(null);
    setEmailSubject("");
    setEmailBody("");
    setEmailTemplateKey(null);
    setEmailTemplateId(null);
    if (!keepQueueSelection) clearServedQueueSelection();
  }, [
    currentCallSessionId,
    currentCallPhone,
    selected?.phone,
    servedQueueActionKey,
    servedQueueTicketId,
    servedQueueContact,
  ]);

  // Close search dropdown on outside click.
  React.useEffect(() => {
    if (!searchDropdownOpen) return;
    function onDocClick(evt: MouseEvent) {
      if (!searchRef.current) return;
      if (!searchRef.current.contains(evt.target as Node)) setSearchDropdownOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [searchDropdownOpen]);

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
  //      always wins over a stale selection from the queue/search)
  //   3. case id from a queue/search selection (fallback — only used
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
  const updateCase = useCxLogicsUpdateCase(caseDomain);
  // Case detail (calls + texts) — also case-scoped.
  const clientDetail = useClientDetail(caseDomain, resolvedCaseId);
  const detail = clientDetail.data;
  const selectedPhone = detail?.phone || selected?.phone || "";
  const selectedEmail = detail?.email || selected?.email || "";

  const templateContext = React.useMemo(
    () =>
      buildTemplateContext(
        domain,
        data?.agent.name || data?.agent.email || "Agent",
        selected
          ? {
              ...selected,
              name: detail?.name || selected.name,
              phone: selectedPhone || selected.phone,
            }
          : null,
        data?.agent.activeExShell?.primaryPhone || "",
      ),
    [
      data?.agent.activeExShell?.primaryPhone,
      data?.agent.email,
      data?.agent.name,
      detail?.name,
      domain,
      selected,
      selectedPhone,
    ],
  );

  // Auto-hydrate text/email recipient from selected case (editable)
  React.useEffect(() => {
    setTextPhone(selectedPhone || "");
  }, [selectedPhone]);
  React.useEffect(() => {
    setEmailTo(selectedEmail || "");
  }, [selectedEmail]);

  // ── Operator/case-scoped mutations ──
  // Text routes through the resolved case tenant so the message can be
  // recorded on the right CaseProfile while still using the logged-in
  // agent's assigned EX shell. Email/createCase stay on the active tenant.
  const setCxStatus = useCxSetStatus(domain);
  const text = useCxText(caseDomain);
  const email = useCxEmail(domain);
  const simulateCxCallAny = useCxSimulateCallAny();
  // dialAny accepts { domain, ...body } so a queue pick on a different tenant
  // routes to the correct /api/commands/cx/:domain/dial without waiting for
  // setDomain() to land. (See handleSelectFromQueue.)
  const dialAny = useCxDialAny();
  const createCase = useCxLogicsCreateCase(domain);

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

  async function handleCxAvailabilityChange(next: "available" | "unavailable") {
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
      });
      const response = (result?.response ?? null) as
        | {
            cxRouting?: { desiredAvailability?: string; reason?: string } | null;
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

      toast(`CX availability set to ${resolvedAvailability || next}`, {
        description: resolvedAvailability === "available"
          ? "You'll start receiving CX leads."
          : "You won't be served new CX leads until you go available.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      toast.error("CX availability change failed", {
        description: message,
        action: {
          label: "Retry",
          onClick: () => {
            void handleCxAvailabilityChange(next);
          },
        },
      });
      throw error;
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
  ) {
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
      notes: readString(merged, "notes", "note"),
      caseId: contact.caseId || readString(merged, "caseId"),
    });
    setServedQueueCaseId(contact.caseId || null);
    setServedQueueDomain(queueDomain || null);
    setServedQueueActionKey(extractQueueActionKey(item));
    setServedQueueTicketId(item.queueTicketId || null);
    setServedQueueContact(contact);
    if (queueDomain && queueDomain !== domain) setDomain(queueDomain);
  }

  async function handleSelectFromQueue(
    item: CxCallQueueItem,
    options: { source?: "manual" | "auto" } = {},
  ) {
    if (queueAdvanceMode === "auto" && options.source !== "auto") {
      cancelAutoServe();
    }
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
    const dialRequest = buildQueueDialRequest(item, queueDomain, contact);
    stageQueueLeadInWorkspace(item, contact, queueDomain);
    if (!contact.phone) return;
    setServingQueueKey(queueKey);

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
        toast("CX dial simulated", {
          description: `Serving ${contact.name || contact.phone} through the CX simulator.`,
        });
      } else {
        await dialAny.mutateAsync({ domain: queueDomain, ...dialRequest });
        toast("CX dial queued", {
          description: `Outbound dial requested for ${contact.name || contact.phone}.`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not place the CX call.";
      clearServedQueueSelection();
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

  function handleSelectFromSearch(result: ClientSearchMatch) {
    if (servedQueueTicketId || servedQueueActionKey) {
      const restored = restoreServedQueueLead();
      toast.warning("Finish the current lead first", {
        description: restored
          ? "I brought the unfinished lead back into the center panel."
          : "Choose a Logics action or Call back before opening a different case.",
      });
      return;
    }
    clearServedQueueSelection();
    setSelected(contactFromSearch(result));
    setSearchDropdownOpen(false);
    setSearchText("");
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
      notes: c.notes || "",
      caseId: c.caseId != null ? String(c.caseId) : "",
    }));
  }

  function handleFormChange(field: CaseFormField, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setDirty((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
  }

  function handleResetToLookup() {
    if (!lookupMatch) return;
    // Clear dirty flags first so applyLookupToForm repopulates every
    // field the match supplies.
    setDirty(BLANK_DIRTY);
    setForm((prev) => applyLookupToForm(prev, BLANK_DIRTY, lookupMatch));
  }

  function handleSyncFromLogics() {
    setDirty(BLANK_DIRTY);
    leadLookup.refetch();
  }

  function releaseQueueAfterSuccess(result: unknown, options: { forceEject?: boolean } = {}) {
    const forceEject = options.forceEject === true;
    if (!forceEject && !servedQueueActionKey && !servedQueueTicketId) return;
    const row = asRecord(result);
    if (row.wrapUpRequired === true || row.callHeldOpen === true) return;
    const response = asRecord(row.response);
    const hangup = asRecord(row.hangup);
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
    if (!completed) return;
    if (!cleanupAccepted) return;
    suppressCurrentQueueLead(row);
    if (rawCurrentCallSessionId) {
      setSuppressedCallSessionId(rawCurrentCallSessionId);
    }
    clearServedQueueSelection();
    clearCasePanelForNextQueueLead();
    workspace.refetch();
    callQueue.refetch();
    for (const query of multiCallQueues) {
      query.refetch();
    }
    scheduleAutoServe();
  }

  function optimisticallyEjectCallbackLead() {
    if (!servedQueueActionKey && !servedQueueTicketId && !servedQueueCaseId) return;
    suppressCurrentQueueLead({
      domain: servedQueueDomain || domain,
      caseId: servedQueueCaseId,
      actionKey: servedQueueActionKey,
      queueItemId: servedQueueTicketId,
      queueTicketId: servedQueueTicketId,
      queueOutcome: "rescheduled",
      callbackEjected: true,
    });
    if (rawCurrentCallSessionId) {
      setSuppressedCallSessionId(rawCurrentCallSessionId);
    }
    clearServedQueueSelection();
    clearCasePanelForNextQueueLead();
    workspace.refetch();
    callQueue.refetch();
    for (const query of multiCallQueues) {
      query.refetch();
    }
    scheduleAutoServe();
  }

  function handleSaveCase() {
    const caseIdPayload = formCaseIdValid ? parsedFormCaseId : undefined;
    // Non-destructive: only send fields the operator actually has data
    // in. Empty strings turn into `undefined` so they get stripped from
    // the JSON request body — Logics' updateCase preserves whatever
    // value is already there for any field we omit, instead of nuking
    // it with "". The same payload feeds both create and update paths.
    const trim = (v: string) => (v || "").trim() || undefined;
    const basePayload: Record<string, unknown> = {
      firstName: trim(form.firstName),
      lastName: trim(form.lastName),
      ssn: trim(form.ssn),
      cellPhone: trim(form.cellPhone),
      homePhone: trim(form.homePhone),
      email: trim(form.email),
      spouseFirstName: trim(form.spouseFirstName),
      spouseLastName: trim(form.spouseLastName),
      spouseSsn: trim(form.spouseSsn),
      spouseEmail: trim(form.spouseEmail),
      spouseCellPhone: trim(form.spouseCellPhone),
      spouseHomePhone: trim(form.spouseHomePhone),
      sourceName: trim(form.sourceName),
      notes: trim(form.notes),
    };
    // Strip explicit undefineds so the JSON serializer doesn't include
    // them — keeps the payload minimal + makes the intent crystal-clear
    // when staring at network logs.
    for (const k of Object.keys(basePayload)) {
      if (basePayload[k] === undefined) delete basePayload[k];
    }

    // Two unified modes — Save always writes BOTH Logics + CaseProfile:
    //   • UPDATE: caseId is known (from lookup or operator paste). PUT
    //     Logics with non-empty fields only (preserves existing data),
    //     then the post-success chain re-syncs CaseProfile from Logics.
    //   • CREATE: no caseId anywhere. POST Logics → assigned CaseID
    //     comes back → CaseProfile gets upserted via the same sync.
    // The CaseProfile upsert is automatic on the backend (executeCxLogicsAction
    // calls syncCaseProfileFromLogics after a successful Logics write),
    // so no separate Mongo-only path is needed.
    if (authoritativeLogicsCaseIdNumber != null) {
      void run(
        "Update case",
        () =>
          updateCase.mutateAsync({
            ...basePayload,
            caseId: authoritativeLogicsCaseIdNumber,
            queueActionKey: servedQueueActionKey || undefined,
            queueItemId: servedQueueTicketId || undefined,
            queueTicketId: servedQueueTicketId || undefined,
            skipQueueFinalize: true,
            searchPhone: currentCallPhone || selectedPhone || undefined,
          }),
        {
          retry: () => {
            handleSaveCase();
          },
        },
      ).catch(() => undefined);
      return;
    }
    // Create-from-scratch sensitivity toggle: when there are no
    // candidates anywhere AND the operator hasn't explicitly confirmed,
    // pop a confirm. This prevents accidental "create new case" clicks
    // when really we should be searching harder in MasterProspectIndex.
    // Once they confirm, the form's existing data drives a POST to
    // Logics in the active CX-switcher domain.
    if (leadCandidates.length === 0 && !confirmCreateNew) {
      setConfirmCreateNew(true);
      toast("No matches found anywhere", {
        description: "Click Create case again to confirm a brand-new Logics case in " + domain + ".",
      });
      return;
    }
    void run(
      "Create case",
      () =>
        createCase.mutateAsync({
          ...basePayload,
          caseId: caseIdPayload,
          queueActionKey: servedQueueActionKey || undefined,
          queueItemId: servedQueueTicketId || undefined,
          queueTicketId: servedQueueTicketId || undefined,
          skipQueueFinalize: true,
        }),
      {
        retry: () => {
          handleSaveCase();
        },
      },
    ).catch(() => undefined);
    setConfirmCreateNew(false);
  }

  function handleTextLibraryChange(id: string) {
    const entry = textLibrary.find((l) => l.id === id);
    if (entry) setTextPreview(entry);
  }

  function handleTextInsert(entry: LibraryEntry) {
    setTextBody(renderTemplate(entry.body, templateContext));
    setTextTemplateId(entry.id);
    setTextPreview(null);
  }

  function handleEmailLibraryChange(id: string) {
    const entry = emailLibrary.find((l) => l.id === id);
    if (entry) setEmailPreview(entry);
  }

  function handleEmailInsert(entry: LibraryEntry) {
    setEmailSubject(renderTemplate(entry.subject || "", templateContext));
    setEmailBody(renderTemplate(entry.body, templateContext));
    setEmailTemplateKey(entry.id);
    setEmailTemplateId(entry.id);
    setEmailPreview(null);
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

  React.useEffect(() => {
    if (!activeServingQueueItem) return;
    if (servedQueueTicketId || servedQueueActionKey || servingQueueKey || servedQueueContact) return;
    const contact = contactFromQueue(activeServingQueueItem);
    const queueDomain = String(activeServingQueueItem.domain || domain || "TAG").trim().toUpperCase();
    cancelAutoServe();
    setServingQueueKey(buildQueueItemKey(activeServingQueueItem));
    stageQueueLeadInWorkspace(activeServingQueueItem, contact, queueDomain);
    toast.warning("Lead restored for wrap-up", {
      description: "This call is still waiting for Callback, DNC, Postdate, or Deal.",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeServingQueueItem,
    servedQueueTicketId,
    servedQueueActionKey,
    servingQueueKey,
    servedQueueContact,
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

    return Array.from(deduped.values()).sort((left, right) => {
      const leftFamily = getQueueSortRank(left);
      const rightFamily = getQueueSortRank(right);
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
  const queueHasActiveLead = Boolean(
    servedQueueTicketId || servedQueueActionKey || servingQueueKey || servedQueueContact,
  );
  const canAttemptStartQueueLead =
    queueItems.length > 0 &&
    !dialAny.isPending &&
    !disposition.isPending;
  const canStartNextQueueLead =
    canAttemptStartQueueLead &&
    !queueHasActiveLead &&
    !autoServeInFlightRef.current;

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
    if (queueAdvanceMode !== "auto") return;
    if (autoServeDueAt == null) return;
    if (autoServeRemaining !== 0) return;
    if (!canStartNextQueueLead) return;
    if (autoServeInFlightRef.current) return;
    void startNextQueueLead();
  }, [
    queueAdvanceMode,
    autoServeDueAt,
    autoServeRemaining,
    canStartNextQueueLead,
    queueItems,
  ]);

  React.useEffect(() => {
    if (queueAdvanceMode !== "auto") return;
    if (autoServeDueAt != null) return;
    if (!canStartNextQueueLead) return;
    if (autoServeInFlightRef.current) return;
    const delaySeconds = AUTO_SERVE_DELAY_SECONDS;
    setAutoServeDueAt(Date.now() + delaySeconds * 1000);
    setAutoServeRemaining(delaySeconds);
  }, [
    queueAdvanceMode,
    autoServeDueAt,
    canStartNextQueueLead,
    queueItems.length,
  ]);

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
  const searchResults = flattenCxSearch(search.data);

  const hasAnyDirty = Object.values(dirty).some(Boolean);
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
  const callbackDispositionCaseId = dispositionCaseId;
  const hasServedQueueTarget = Boolean(servedQueueTicketId || servedQueueActionKey);
  const assignCaseId =
    dispositionCaseId ??
    (resolvedCaseId && Number.isFinite(Number(resolvedCaseId)) ? Number(resolvedCaseId) : null);
  const textCaseId = resolvedCaseId || selected?.caseId || null;
  // Two unified modes:
  //   • "update" → a Logics lookup definitively matched an existing case.
  //   • "create" → no Logics match. Use whatever Mongo/source data we
  //     have in the form to create/persist into Logics.
  // Both paths write to BOTH places — Save is the single button for
  // every save scenario (no separate "promote to CaseProfile" branch).
  const saveMode: "create" | "update" =
    authoritativeLogicsCaseIdNumber != null ? "update" : "create";
  const saveLabel =
    saveMode === "update"
      ? "Save"
      : confirmCreateNew
        ? "Confirm — Create new"
        : "Create case";
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
    saveMode === "update"
      ? "Save updates Logics with whatever fields have data — empty fields are preserved, never blanked."
      : hasLookupHit
        ? "Auto-populated from the best source we found. Save will persist that data into Logics and then sync CaseProfile."
        : "Populate fields to create a new case in Logics, or wait for an inbound call to auto-fill.";

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

  const agentTextShell =
    data.agent.exShells?.find((shell) => String(shell.company || "").toUpperCase() === caseDomain) ||
    data.agent.activeExShell ||
    data.agent.requestedExShell ||
    null;
  const agentShellPhone = agentTextShell?.primaryPhone || "";
  const cxRouting = asRecord(data.ex?.cxRouting);
  const freshLeadGate = asRecord(data.ex?.freshLeadGate);
  const currentCallSnapshot = asRecord(data.ex?.currentCall);
  const cxDesiredAvailability = String(cxRouting.desiredAvailability || "").trim().toLowerCase();
  const cxRoutingReason = String(cxRouting.reason || "").trim();
  const currentCallChannel = String(currentCallSnapshot.channel || "").trim().toLowerCase();
  const hasActiveExCall =
    currentCallChannel === "ex" &&
    Boolean(
      currentCallSnapshot.sessionId ||
        currentCallSnapshot.telephonySessionId ||
        currentCallSnapshot.from ||
        currentCallSnapshot.to,
    );
  const exCallGateActive = Boolean(freshLeadGate.exCallActive) || hasActiveExCall || cxRoutingReason === "ex-busy";
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
        ? "Manual pause keeps you out of fresh lead serving."
        : "EX is idle and this agent profile can receive fresh leads.");
  const exCallStateLabel = exCallGateActive ? "On EX call" : "Off EX call";
  const cxRoutingReasonLabel = humanizeCxRoutingReason(cxRoutingReason);

  // ─── Contact history lists ────────────────────────────────────────────────
  const caseCalls: ClientCaseCall[] = detail?.calls ?? [];
  const caseTexts: ClientCaseMessage[] = [...(detail?.textChain ?? [])].reverse();

  // Agent-scope activity stays in the compact right-column panel only.
  const agentRecentActivityCompact = (data.recentWorkflowStages || [])
    .filter((row) => row.family === "cx")
    .slice(0, 6);

  const showSearchDropdown =
    searchDropdownOpen && searchText.trim().length >= 2;

  return (
    <div className="flex min-h-[calc(100vh-6rem)] flex-col gap-4">
      {/* ─── TOP BAR: sticky search ─────────────────────────────────────── */}
      <div
        ref={searchRef}
        className="sticky top-0 z-30 -mx-4 border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      >
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <CxDomainSwitcher
            domain={domain}
            availableDomains={availableDomains}
            onChange={(next) => {
              // The switcher only drives search + queue + new-case
              // creation. It does NOT unload the active case — a
              // resolved case is bound to its own tenant via the
              // lookup result, so flipping the switcher to a different
              // tenant just changes what search is filtering, not
              // what's loaded in the center panel.
              setDomain(next);
              setSearchText("");
              setSearchDropdownOpen(false);
            }}
          />
          <div className="relative flex-1">
            <Input
              value={searchText}
              onChange={(e) => {
                setSearchText(e.target.value);
                setSearchDropdownOpen(true);
              }}
              onFocus={() => setSearchDropdownOpen(true)}
              placeholder="Search cases by name, email, phone, or case id…"
              leadingIcon={<Search />}
            />
            {showSearchDropdown ? (
              <div className="absolute left-0 right-0 top-full z-40 mt-1 max-h-80 overflow-auto rounded-md border border-border bg-popover p-2 shadow-lg">
                {search.isFetching ? <SkeletonRow count={2} /> : null}
                {!search.isFetching && searchResults.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground">
                    No matches.
                  </div>
                ) : null}
                {searchResults.length > 0 ? (
                  <div className="space-y-1">
                    {searchResults.slice(0, 12).map((result) => (
                      <button
                        key={`${result.caseId}-${result.email || result.phone || result.name || ""}`}
                        type="button"
                        onClick={() => handleSelectFromSearch(result)}
                        className="w-full rounded-md border border-border bg-card p-2 text-left hover:bg-muted/40"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1 text-sm font-medium text-foreground">
                            {result.name || `Case ${result.caseId}`}
                          </div>
                          <SearchSourcePill source={result.source} />
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {[result.phone, result.email, result.caseId ? `Case ${result.caseId}` : ""]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="flex gap-1">
            {(["all", "prospects", "clients"] as SearchScope[]).map((value) => (
              <Button
                key={value}
                type="button"
                variant={searchScope === value ? "primary" : "secondary"}
                size="sm"
                onClick={() => setSearchScope(value)}
              >
                {value === "all" ? "All" : value === "prospects" ? "Prospects" : "Clients"}
              </Button>
            ))}
          </div>
        </div>
        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border/70 bg-card/60 px-3 py-2 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Fresh lead gate
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
            <Button
              size="sm"
              variant={!freshLeadBlocked ? "primary" : "secondary"}
              isLoading={setCxStatus.isPending}
              disabled={exCallGateActive}
              title={exCallGateActive ? "EX call is active; fresh leads reopen when EX returns idle." : undefined}
              onClick={() => void handleCxAvailabilityChange("available")}
            >
              Receive fresh leads
            </Button>
            <Button
              size="sm"
              variant={freshLeadBlocked ? "primary" : "secondary"}
              isLoading={setCxStatus.isPending}
              onClick={() => void handleCxAvailabilityChange("unavailable")}
            >
              Pause fresh leads
            </Button>
          </div>
        </div>
      </div>

      {/* ─── THREE-COLUMN BODY ──────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col gap-4 lg:flex-row">
        {/* ── LEFT: CX queue only ──────────────────────────────────────── */}
        <aside className="flex-shrink-0 lg:w-[260px]">
          <div className="lg:sticky lg:top-20">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm">CX queue</CardTitle>
                  <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
                    <button
                      type="button"
                      onClick={() => setQueueAdvanceMode("manual")}
                      className={cn(
                        "inline-flex h-7 items-center gap-1 rounded px-2 text-[11px] font-medium",
                        queueAdvanceMode === "manual"
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      title="Click queue cards to dial"
                    >
                      <Phone className="h-3 w-3" />
                      Click
                    </button>
                    <button
                      type="button"
                      onClick={() => setQueueAdvanceMode("auto")}
                      className={cn(
                        "inline-flex h-7 items-center gap-1 rounded px-2 text-[11px] font-medium",
                        queueAdvanceMode === "auto"
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      title="Serve the next lead after countdown"
                    >
                      <Clock3 className="h-3 w-3" />
                      Auto
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 truncate text-[10px] text-muted-foreground">
                    {queueDebugLine}
                  </div>
                  {queueAdvanceMode === "auto" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[11px]"
                      disabled={!canAttemptStartQueueLead}
                      onClick={() => void startNextQueueLead()}
                      title={
                        queueHasActiveLead
                          ? "Finish the active lead first"
                          : canAttemptStartQueueLead
                            ? "Start next queued lead"
                            : "No queued lead is ready"
                      }
                    >
                      <Phone className="h-3 w-3" />
                      Start
                    </Button>
                  ) : null}
                </div>
                <CxQueueLegend />
              </CardHeader>
              <CardContent>
                {queueAdvanceMode === "auto" && autoServeDueAt != null ? (
                  <div className="mb-2">
                    <AutoServeCountdown
                      remaining={autoServeRemaining}
                      onCancel={cancelAutoServe}
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
                {queueItems.length === 0 ? (
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
                    clickDisabled={queueAdvanceMode === "auto"}
                    onSelect={handleSelectFromQueue}
                  />
                )}
              </CardContent>
            </Card>
          </div>
        </aside>

        {/* ── CENTER: client management ─────────────────────────────────── */}
        <section className="flex min-w-0 flex-1 flex-col gap-3">
          {/* Identity strip — quick-glance + inline edits + DNC / Postdate */}
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
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
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  {leadLookup.isFetching && resolvedCaseId ? <span>refreshing…</span> : null}
                  {leadLookupPhone ? (
                    <span className="font-mono">{leadLookupPhone}</span>
                  ) : null}
                </div>
              </div>
              <div className="text-[11px] text-muted-foreground">{formSubtitle}</div>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
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
              {/* Action row */}
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <Button
                  size="sm"
                  isLoading={createCase.isPending || updateCase.isPending}
                  disabled={!form.lastName.trim() && !form.firstName.trim() && !form.cellPhone.trim()}
                  onClick={handleSaveCase}
                  title={
                    saveMode === "update"
                      ? "PUT identity edits to Logics — only fields with data are sent (existing values preserved). CaseProfile is auto-synced from Logics on success."
                      : "POST a new case to Logics. CaseProfile is auto-created from the assigned CaseID."
                  }
                >
                  <Save className="h-3.5 w-3.5" />
                  {saveLabel}
                </Button>
                {assignCaseId != null ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    isLoading={assignCaseToMe.isPending}
                    onClick={() =>
                      void run("Assign case", () =>
                        assignCaseToMe.mutateAsync({
                          caseId: String(assignCaseId),
                        }),
                      ).catch(() => undefined)
                    }
                    title="Assign this Logics case to you as settlement officer."
                  >
                    <UserCheck className="h-3.5 w-3.5" />
                    Assign to me
                  </Button>
                ) : null}
                {dispositionCaseId != null ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    isLoading={disposition.isPending}
                    onClick={() =>
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
                    }
                    title="Mark this contact as Do-Not-Call (stops cadence on every channel)"
                  >
                    DNC
                  </Button>
                ) : null}
                {dispositionCaseId != null ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    isLoading={disposition.isPending}
                    onClick={() =>
                      void run("Postdate", () =>
                        disposition.mutateAsync({
                          caseId: String(dispositionCaseId),
                          disposition: "postdate",
                          phone: form.cellPhone || selectedPhone || currentCallPhone,
                          searchPhone: currentCallPhone || selectedPhone || undefined,
                          queueActionKey: servedQueueActionKey || undefined,
                          queueItemId: servedQueueTicketId || undefined,
                          queueTicketId: servedQueueTicketId || undefined,
                          assignedExtensionId: currentExtensionId || undefined,
                        }),
                      ).then(releaseQueueAfterSuccess).catch(() => undefined)
                    }
                    title="Set Logics status to post-date (snooze cadence; finance handles the actual schedule)"
                  >
                    Postdate
                  </Button>
                ) : null}
                {dispositionCaseId != null ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    isLoading={disposition.isPending}
                    onClick={() =>
                      void run("Deal handoff", () =>
                        disposition.mutateAsync({
                          caseId: String(dispositionCaseId),
                          disposition: "deal",
                          phone: form.cellPhone || selectedPhone || currentCallPhone,
                          searchPhone: currentCallPhone || selectedPhone || undefined,
                          queueActionKey: servedQueueActionKey || undefined,
                          queueItemId: servedQueueTicketId || undefined,
                          queueTicketId: servedQueueTicketId || undefined,
                          assignedExtensionId: currentExtensionId || undefined,
                          leadName:
                            `${form.firstName} ${form.lastName}`.trim() ||
                            selected?.name ||
                            undefined,
                          notes: form.notes || undefined,
                        }),
                      ).catch(() => undefined)
                    }
                    title="Create a payment handoff without changing Logics status or ending the CX call."
                  >
                    Deal
                  </Button>
                ) : null}
                {hasServedQueueTarget && callbackDispositionCaseId != null ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    isLoading={disposition.isPending}
                    onClick={() => {
                      optimisticallyEjectCallbackLead();
                      void run("Call back", () =>
                        disposition.mutateAsync({
                          caseId: String(callbackDispositionCaseId),
                          disposition: "call-back",
                          phone: form.cellPhone || selectedPhone || currentCallPhone,
                          searchPhone: currentCallPhone || selectedPhone || undefined,
                          queueActionKey: servedQueueActionKey || undefined,
                          queueItemId: servedQueueTicketId || undefined,
                          queueTicketId: servedQueueTicketId || undefined,
                          assignedExtensionId: currentExtensionId || undefined,
                        }),
                      )
                        .then((result) => releaseQueueAfterSuccess(result, { forceEject: true }))
                        .catch(() => {
                          workspace.refetch();
                          callQueue.refetch();
                        });
                    }}
                    title="Finish this lead without a Logics change and recycle it as a callback."
                  >
                    Call back
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleSyncFromLogics}
                  disabled={!leadLookupPhone && !leadLookupCaseId}
                  title="Re-pull from Logics"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Sync
                </Button>
                {authoritativeLogicsCaseIdNumber != null ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Opens Logics home + copies case ID to clipboard (Logics has no deep links)"
                    onClick={async () => {
                      const copied = await openCaseInLogics(
                        caseDomain,
                        String(authoritativeLogicsCaseIdNumber),
                      );
                      toast.success(
                        copied
                          ? `Opened Logics — ${authoritativeLogicsCaseIdNumber} on clipboard, paste into search`
                          : `Opened Logics — paste ${authoritativeLogicsCaseIdNumber} into search`,
                      );
                    }}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Logics
                  </Button>
                ) : null}
                {hasAnyDirty && lookupMatch ? (
                  <Button size="sm" variant="ghost" onClick={handleResetToLookup}>
                    Reset
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {/* Logics workspace — list-first panels (Activities / Tasks / Invoices / Payments / Amortization) */}
          {resolvedCaseId ? (
            <>
              <LogicsWorkspaceCard
                domain={caseDomain}
                resolvedCaseId={resolvedCaseId}
                resolvedPhone={
                  selected?.phone || lookupResult?.match?.phone || currentCallPhone || null
                }
              />

              {/* Communication threads — calls + text chain */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Communication</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        Calls
                      </div>
                      {clientDetail.isFetching ? (
                        <span className="text-[11px] text-muted-foreground">loading…</span>
                      ) : null}
                    </div>
                    <ExpandableList
                      items={caseCalls}
                      initial={8}
                      emptyLabel="No calls on this case yet."
                      render={(call) => (
                        <CallRow
                          key={call._id || call.telephonySessionId || Math.random()}
                          call={call}
                        />
                      )}
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Text chain
                    </div>
                    <ExpandableList
                      items={caseTexts}
                      initial={8}
                      emptyLabel="No text messages on this case yet."
                      render={(msg) => <TextBubble key={msg.id} message={msg} />}
                    />
                  </div>
                </CardContent>
              </Card>
            </>
          ) : null}
        </section>

        {/* ── RIGHT: compose + compact agent history ───────────────────── */}
        <aside className="flex-shrink-0 lg:w-[340px]">
          <div className="lg:sticky lg:top-20 space-y-4">
            {/* Send text */}
            <Collapsible
              title="Send text"
              open={textOpen}
              onToggle={() => setTextOpen((v) => !v)}
              right={
                agentShellPhone ? (
                  <span className="text-[11px] text-muted-foreground">from {agentShellPhone}</span>
                ) : null
              }
            >
              <div className="space-y-3 p-4">
                <div className="space-y-2">
                  <Label>To (phone)</Label>
                  <Input
                    value={textPhone}
                    onChange={(e) => setTextPhone(e.target.value)}
                    placeholder="+1310..."
                    leadingIcon={<Phone />}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Template</Label>
                  <Select
                    value={textTemplateId ?? undefined}
                    onValueChange={handleTextLibraryChange}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a template" />
                    </SelectTrigger>
                    <SelectContent>
                      {textLibrary.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Message</Label>
                  <textarea
                    className="min-h-[120px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
                    value={textBody}
                    onChange={(e) => {
                      setTextBody(e.target.value);
                      setTextTemplateId(null);
                    }}
                    placeholder="Compose or pick a template..."
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    isLoading={text.isPending}
                    disabled={!textPhone.trim() || !textBody.trim()}
                    onClick={() =>
                      run("Text", () =>
                        text.mutateAsync({
                          caseId: textCaseId || undefined,
                          phone: textPhone,
                          body: textBody,
                        }),
                      )
                    }
                  >
                    <MessageCircleMore className="h-4 w-4" />
                    Send SMS
                  </Button>
                </div>
              </div>
            </Collapsible>

            {/* Send email */}
            <Collapsible
              title="Send email"
              open={emailOpen}
              onToggle={() => setEmailOpen((v) => !v)}
              right={
                emailTemplateKey ? (
                  <span className="text-[11px] text-muted-foreground">armed: {emailTemplateKey}</span>
                ) : null
              }
            >
              <div className="space-y-3 p-4">
                <div className="space-y-2">
                  <Label>To (email)</Label>
                  <Input
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    placeholder="name@example.com"
                    leadingIcon={<Mail />}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Template</Label>
                  <Select
                    value={emailTemplateId ?? undefined}
                    onValueChange={handleEmailLibraryChange}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a template" />
                    </SelectTrigger>
                    <SelectContent>
                      {emailLibrary.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Subject</Label>
                  <Input
                    value={emailSubject}
                    onChange={(e) => {
                      setEmailSubject(e.target.value);
                      // Manual edits drop back to free-form so the send
                      // doesn't clobber the edit with the server template.
                      setEmailTemplateKey(null);
                      setEmailTemplateId(null);
                    }}
                    placeholder="Subject line"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Body</Label>
                  <textarea
                    className="min-h-[140px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
                    value={emailBody}
                    onChange={(e) => {
                      setEmailBody(e.target.value);
                      setEmailTemplateKey(null);
                      setEmailTemplateId(null);
                    }}
                    placeholder="Compose or pick a template..."
                  />
                  {emailTemplateKey ? (
                    <div className="text-[11px] text-muted-foreground">
                      Branded template{" "}
                      <code className="rounded bg-muted px-1 py-0.5">{emailTemplateKey}</code>{" "}
                      renders server-side on send. Editing subject or body drops to free-form.
                    </div>
                  ) : null}
                </div>
                <div className="flex justify-end">
                  <Button
                    isLoading={email.isPending}
                    disabled={
                      !emailTo.trim() ||
                      (!emailTemplateKey && (!emailSubject.trim() || !emailBody.trim()))
                    }
                    onClick={() =>
                      run("Email", () =>
                        email.mutateAsync({
                          caseId: selected?.caseId,
                          email: emailTo,
                          subject: emailTemplateKey ? "" : emailSubject,
                          body: emailTemplateKey ? "" : emailBody,
                          templateKey: emailTemplateKey || undefined,
                          variables: emailTemplateKey
                            ? {
                                firstName: selected?.name?.split(" ")[0] || undefined,
                                name: selected?.name || undefined,
                              }
                            : undefined,
                        }),
                      )
                    }
                  >
                    <Mail className="h-4 w-4" />
                    Send email
                  </Button>
                </div>
              </div>
            </Collapsible>

            {/* Compact agent-scope history */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Your recent activity</CardTitle>
              </CardHeader>
              <CardContent>
                {agentRecentActivityCompact.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                    No recent CX touches.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {agentRecentActivityCompact.map((row) => (
                      <div
                        key={row._id || `${row.caseId}-${row.createdAt}`}
                        className="rounded-md border border-border bg-card/50 p-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="truncate text-xs font-medium text-foreground">
                            {row.title || row.summary || row.stage || row.family || "Activity"}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {formatRelative(row.createdAt || row.happenedAt)}
                          </div>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {row.caseId ? `Case ${row.caseId}` : null}
                          {row.subtype ? ` · ${row.subtype}` : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </aside>
      </div>

      {/* ─── Modals ───────────────────────────────────────────────────── */}
      <TemplatePreviewModal
        open={Boolean(textPreview)}
        onClose={() => {
          setTextPreview(null);
          // If the user cancelled without inserting, drop the select value.
          if (!textBody) setTextTemplateId(null);
        }}
        entry={textPreview}
        context={templateContext}
        onInsert={handleTextInsert}
      />
      <TemplatePreviewModal
        open={Boolean(emailPreview)}
        onClose={() => {
          setEmailPreview(null);
          if (!emailBody) setEmailTemplateId(null);
        }}
        entry={emailPreview}
        context={templateContext}
        onInsert={handleEmailInsert}
      />
    </div>
  );
}
