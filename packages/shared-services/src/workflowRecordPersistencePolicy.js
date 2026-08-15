"use strict";

const DEFAULT_SUMMARY_INTERVAL_MS = 15 * 60 * 1000;
const MAX_CATEGORIES = 64;

// These families duplicate state already owned by purpose-built collections or
// in-memory runtimes. Keep the call sites during the soft-delete proof window,
// but do not keep adding narrative rows to ControlPlaneWorkflowRecord.
const SUPPRESSED_NARRATIVE_FAMILIES = new Set([
  "attribution-reconcile",
  "dispatch",
  "filler-pool",
  "lead",
  "logics",
  "metric",
  "metrics",
  "phoneburner",
]);

const OUTBOUND_READER_STAGES = new Set(["completed", "skipped"]);

function exactTrue(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function safeCategory(value) {
  const normalized = String(value || "none").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(normalized)
    ? normalized
    : "other";
}

function shouldPersistWorkflowRecord(input = {}, env = process.env) {
  // Emergency rollback: restore the former write-through behavior without a
  // source rollback. Exact-on prevents an accidental truthy string enabling it.
  if (exactTrue(env.WORKFLOW_RECORD_NARRATIVE_WRITES_ENABLED)) return true;

  // Dedupe-keyed records are receipts/checkpoints and always remain durable.
  if (String(input.dedupeKey || "").trim()) return true;

  const family = safeCategory(input.family);
  const stage = safeCategory(input.stage);

  // Two readers still use same-day outbound completed/skipped rows to avoid
  // selecting the same case twice. Preserve exactly those reader-facing rows.
  if (family === "outbound") return OUTBOUND_READER_STAGES.has(stage);

  return !SUPPRESSED_NARRATIVE_FAMILIES.has(family);
}

function createWorkflowRecordSoftGate(options = {}) {
  const env = options.env || process.env;
  const now = options.now || (() => new Date());
  const journal = options.journal || ((entry) => console.info(JSON.stringify(entry)));
  const setIntervalFn = options.setIntervalFn || setInterval;
  const summaryIntervalMs = Math.max(
    60_000,
    Number(options.summaryIntervalMs) || DEFAULT_SUMMARY_INTERVAL_MS,
  );

  let intervalStartedAt = null;
  let timer = null;
  let total = 0;
  let overflow = 0;
  let policyAnnounced = false;
  const categories = new Map();

  function categoryFor(input) {
    return {
      family: safeCategory(input.family),
      subtype: safeCategory(input.subtype),
      stage: safeCategory(input.stage),
      sourceService: safeCategory(input.sourceService),
      aggregateType: safeCategory(input.aggregateType),
    };
  }

  function announcePolicy() {
    if (policyAnnounced) return;
    policyAnnounced = true;
    journal({
      event: "workflow-record.soft-gate.active",
      mode: "receipt-and-reader-facing-only",
      rollbackFlag: "WORKFLOW_RECORD_NARRATIVE_WRITES_ENABLED",
      happenedAt: now().toISOString(),
    });
  }

  function flush(reason = "interval") {
    if (!total) return null;
    const endedAt = now();
    const entry = {
      event: "workflow-record.soft-gate.summary",
      reason: safeCategory(reason),
      intervalStartedAt: intervalStartedAt?.toISOString?.() || endedAt.toISOString(),
      intervalEndedAt: endedAt.toISOString(),
      suppressed: total,
      categoryOverflow: overflow,
      categories: [...categories.values()]
        .sort((a, b) => b.count - a.count)
        .map((row) => ({ ...row })),
    };
    journal(entry);
    intervalStartedAt = endedAt;
    total = 0;
    overflow = 0;
    categories.clear();
    return entry;
  }

  function ensureTimer() {
    if (timer) return;
    timer = setIntervalFn(() => flush("interval"), summaryIntervalMs);
    timer?.unref?.();
  }

  function suppress(input = {}) {
    announcePolicy();
    ensureTimer();
    if (!intervalStartedAt) intervalStartedAt = now();
    total += 1;

    const category = categoryFor(input);
    const key = Object.values(category).join("|");
    let row = categories.get(key);
    if (!row && categories.size < MAX_CATEGORIES) {
      row = {
        ...category,
        count: 0,
        withPayload: 0,
        withResult: 0,
        withTitle: 0,
        withSummary: 0,
      };
      categories.set(key, row);
    }
    if (!row) {
      overflow += 1;
    } else {
      row.count += 1;
      if (input.payload != null) row.withPayload += 1;
      if (input.result != null) row.withResult += 1;
      if (input.title != null) row.withTitle += 1;
      if (input.summary != null) row.withSummary += 1;
    }

    return {
      _id: null,
      suppressed: true,
      persistence: "journal-summary-only",
      family: category.family,
      stage: category.stage,
      happenedAt: input.happenedAt instanceof Date ? input.happenedAt : now(),
    };
  }

  function evaluate(input = {}) {
    return shouldPersistWorkflowRecord(input, env)
      ? { persist: true, record: null }
      : { persist: false, record: suppress(input) };
  }

  return {
    evaluate,
    flush,
    shouldPersist: (input) => shouldPersistWorkflowRecord(input, env),
  };
}

const workflowRecordSoftGate = createWorkflowRecordSoftGate();

module.exports = {
  OUTBOUND_READER_STAGES,
  SUPPRESSED_NARRATIVE_FAMILIES,
  createWorkflowRecordSoftGate,
  safeCategory,
  shouldPersistWorkflowRecord,
  workflowRecordSoftGate,
};
