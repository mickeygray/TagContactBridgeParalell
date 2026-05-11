import type { ClientTimelineEntry, WorkflowRecord } from "@/lib/api/types";

type WorkflowTone = "default" | "success" | "warning" | "danger" | "info";
export type PresentedWorkflowRecord = WorkflowRecord & ClientTimelineEntry;

const HIDDEN_STAGES = new Set([
  "observed",
  "attempting",
  "selected",
  "checking-suppression",
  "verifying",
  "verified",
  "dispatching",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toNumber(value: unknown): number | null {
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function startCase(value: string) {
  return value
    .split(/[-_.\s]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function humanSubtype(value: string | null | undefined) {
  if (!value) return null;
  return startCase(value);
}

function summarizeCounts(record: WorkflowRecord) {
  const result = asRecord(record.result);
  const callfireSummary = asRecord(result?.callfireSummary);
  const source = callfireSummary ?? result;
  if (!source) return null;

  const selected = toNumber(source.selected);
  const sent = toNumber(source.sent);
  const failed = toNumber(source.failed);
  const skipped = toNumber(source.skipped);

  const parts = [
    sent != null ? `${sent} sent` : null,
    failed != null ? `${failed} failed` : null,
    skipped != null && skipped > 0 ? `${skipped} skipped` : null,
    selected != null ? `${selected} selected` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : null;
}

function deriveTone(record: WorkflowRecord): WorkflowTone {
  if (record.stage === "failed") return "danger";
  if (record.stage === "completed") return "success";
  if (record.stage === "consuming" || record.stage === "requested" || record.stage === "built") {
    return "info";
  }
  return "default";
}

export function isImportantWorkflowRecord(record: WorkflowRecord) {
  if (!record) return false;
  if (record.stage === "failed") return true;
  if (record.stage === "completed") return true;
  if (record.stage === "requested") return true;
  if (record.stage === "built") return true;
  if (record.stage === "consuming") return true;
  if (record.title || record.summary) return !HIDDEN_STAGES.has(String(record.stage || ""));
  return !HIDDEN_STAGES.has(String(record.stage || ""));
}

export function presentWorkflowRecord(record: WorkflowRecord): PresentedWorkflowRecord {
  const timestamp =
    (typeof record.happenedAt === "string" && record.happenedAt) ||
    (typeof record.createdAt === "string" && record.createdAt) ||
    new Date().toISOString();
  const family = String(record.family || "workflow");
  const subtype = humanSubtype(record.subtype);
  const stage = String(record.stage || "updated");
  const stageLabel = startCase(stage);
  const countSummary = summarizeCounts(record);

  let label =
    typeof record.title === "string" && record.title
      ? record.title
      : `${subtype ?? startCase(family)} ${stageLabel}`;

  let detail =
    typeof record.summary === "string" && record.summary
      ? record.summary
      : null;

  if (family === "dispatch") {
    const channel = subtype ?? "Dispatch";
    if (stage === "consuming") {
      label = `${channel} started`;
    } else if (stage === "built") {
      label = `${channel} list built`;
    } else if (stage === "completed") {
      label = `${channel} finished`;
    } else if (stage === "failed") {
      label = `${channel} needs review`;
    }
  } else if (family === "outbound") {
    if (stage === "completed") label = "Contact process finished";
    if (stage === "failed") label = "Contact process failed";
  } else if (family === "ringcentral" && stage === "completed") {
    label = record.title || record.summary || "Call workflow finished";
  }

  if (countSummary) {
    detail = detail ? `${detail} · ${countSummary}` : countSummary;
  }

  return {
    timestamp,
    eventType: [record.family, record.subtype, record.stage].filter(Boolean).join("."),
    label,
    detail,
    tone: deriveTone(record),
    important: isImportantWorkflowRecord(record),
    ...record,
  };
}

export function presentImportantWorkflowRecords(records: WorkflowRecord[] = [], limit?: number): PresentedWorkflowRecord[] {
  const presented = records
    .filter(isImportantWorkflowRecord)
    .map(presentWorkflowRecord);

  return typeof limit === "number" ? presented.slice(0, limit) : presented;
}
