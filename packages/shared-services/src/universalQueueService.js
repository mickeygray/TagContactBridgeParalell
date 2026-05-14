"use strict";

const {
  queueItemRepository,
  poolBudgetRepository,
  leadCadenceRepository,
} = require("../../shared-repositories/src");
const { deriveUcqAgeBucket } = require("../../shared-normalizers/src");
const { getConfig } = require("./pacingConfigService");
const { formatHourBucket, isOperatingNow } = require("./businessHoursGuard");

const CX_DUE_ACTION_STATUSES = ["pending", "requested"];
const DEFAULT_REFILL_DOMAINS = ["WYNN", "TAG"];

// universalQueueService — refills the global UCQ pool from cadence-due
// items, keeping at least `teamHourlyTarget` items present at all times.
// FIFO append: new items go to the bottom (newer enteredQueueAt).
//
// Refill triggers (caller):
//   1. Hourly orchestrator at hour rollover
//   2. Pool emptiness watcher (when inPoolCount drops to 0)
//   3. Morning prep cron at 7am M-F
//   4. Manual via admin endpoint
//
// This service does NOT decide WHICH items become QueueItems — it
// reads cadence-due items and dedupes against existing queue entries.
// The cadence engine remains the source of truth for what's due.

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeUsPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function configuredRefillDomains() {
  const raw = String(
    process.env.UCQ_REFILL_DOMAINS
      || process.env.PACING_QUEUE_DOMAINS
      || "",
  ).trim();
  const domains = raw
    ? raw.split(",").map(normalizeDomain).filter(Boolean)
    : DEFAULT_REFILL_DOMAINS;
  return Array.from(new Set(domains));
}

function buildQueueLeadId({ domain = null, caseId = null, fallbackId = null, explicitLeadId = null } = {}) {
  const explicit = String(explicitLeadId || "").trim();
  if (explicit && explicit.includes(":")) return explicit;
  const normalizedDomain = normalizeDomain(domain);
  const numericCaseId = Number(caseId);
  if (normalizedDomain && Number.isFinite(numericCaseId)) {
    return `${normalizedDomain}:${numericCaseId}`;
  }
  return explicit || String(fallbackId || "").trim();
}

function resolveAgeBucketFromAction(action = {}, cadence = {}) {
  return deriveUcqAgeBucket(action, cadence);
}

function extractLeadCadencePhone(cadence = {}) {
  const payload = cadence.payloadSnapshot && typeof cadence.payloadSnapshot === "object"
    ? cadence.payloadSnapshot
    : {};
  const leadBody = payload.leadBody && typeof payload.leadBody === "object" ? payload.leadBody : {};
  return normalizeUsPhone(
    cadence.primaryPhone
      || cadence.normalizedPhone
      || payload.phone
      || payload.cellPhone
      || payload.primaryPhone
      || leadBody.phone
      || leadBody.cellPhone
      || leadBody.primaryPhone
      || "",
  );
}

function pickDueCxAction(cadence = {}, asOf = new Date()) {
  const nowMs = new Date(asOf).getTime();
  return (Array.isArray(cadence.schedule?.actions) ? cadence.schedule.actions : [])
    .filter((action) => {
      const scheduledAt = action?.scheduledFor ? new Date(action.scheduledFor).getTime() : NaN;
      return action?.channel === "cx"
        && CX_DUE_ACTION_STATUSES.includes(String(action.status || "").trim())
        && Number.isFinite(scheduledAt)
        && scheduledAt <= nowMs;
    })
    .sort((left, right) => new Date(left.scheduledFor).getTime() - new Date(right.scheduledFor).getTime())[0] || null;
}

function dueCadenceToLead(cadence = {}, action = null) {
  const domain = normalizeDomain(cadence.domain || "TAG");
  const caseId = Number(cadence.caseId);
  const selectedAction = action || pickDueCxAction(cadence);
  const ageBucket = resolveAgeBucketFromAction(selectedAction || {}, cadence);
  const phoneNumber = extractLeadCadencePhone(cadence);
  return {
    leadId: buildQueueLeadId({
      domain,
      caseId,
      fallbackId: cadence._id,
    }),
    phoneNumber,
    phone: phoneNumber,
    domain,
    ageBucket,
    partition: ["just_came_in", "second_contact", "third_contact"].includes(ageBucket)
      ? "fresh"
      : "non_fresh",
    nextDueAt: selectedAction?.scheduledFor || cadence.schedule?.nextActionAt || null,
    cadenceDueAt: selectedAction?.scheduledFor || cadence.schedule?.nextActionAt || null,
    cadenceTaskId: selectedAction?.key || null,
    logicsCaseId: Number.isFinite(caseId) ? caseId : null,
  };
}

// ── Pool occupancy snapshot (cheap, runs after every refill) ───────

async function refreshPoolOccupancy() {
  const counts = await queueItemRepository.countByAgeBucket();
  const inPoolByAgeBucket = {
    just_came_in: 0,
    second_contact: 0,
    third_contact: 0,
    day2_10: 0,
    aged: 0,
  };
  let inPoolCount = 0;
  for (const row of counts) {
    if (row._id in inPoolByAgeBucket) {
      inPoolByAgeBucket[row._id] = row.count;
      inPoolCount += row.count;
    }
  }
  const inPoolByPartition = {
    fresh:
      inPoolByAgeBucket.just_came_in
      + inPoolByAgeBucket.second_contact
      + inPoolByAgeBucket.third_contact,
    non_fresh: inPoolByAgeBucket.day2_10 + inPoolByAgeBucket.aged,
  };
  await poolBudgetRepository.snapshotOccupancy({
    inPoolCount,
    inPoolByPartition,
    inPoolByAgeBucket,
  });
  return { inPoolCount, inPoolByPartition, inPoolByAgeBucket };
}

// ── Read cadence-due items not already in queue ────────────────────
//
// `leadCadenceRepository` is the existing source. We assume it exposes
// (or we'll wrap) a method that returns items where `nextDueAt <= now`
// and the lead is still active. This service stays decoupled from the
// cadence engine's internal state — we only read the surface.
//
// If the repository doesn't expose the old `findDueLeads` hook, read
// the parallel LeadCadence schedule actions directly for due CX work.
// The caller still treats an empty result as a no-op refill.

async function readDueLeads({ limit = 500, asOf = new Date() } = {}) {
  if (typeof leadCadenceRepository.findDueLeads === "function") {
    return leadCadenceRepository.findDueLeads({ limit, asOf });
  }
  if (typeof leadCadenceRepository.listDueLeadCadenceByChannel !== "function") {
    return [];
  }

  const due = [];
  for (const domain of configuredRefillDomains()) {
    const rows = await leadCadenceRepository.listDueLeadCadenceByChannel(domain, {
      channel: "cx",
      now: asOf,
      limit,
      statuses: CX_DUE_ACTION_STATUSES,
    });
    for (const cadence of rows) {
      const action = pickDueCxAction(cadence, asOf);
      if (!action) continue;
      due.push(dueCadenceToLead(cadence, action));
      if (due.length >= limit) return due;
    }
  }
  return due;
}

// Convert a cadence-due lead into a QueueItem payload. The cadence
// engine determines the bucket; we just translate.
function leadToQueueItemPayload(lead) {
  const domain = normalizeDomain(lead.domain || "TAG");
  const logicsCaseId = lead.logicsCaseId ?? lead.caseId ?? lead.sourceLogicsCaseId ?? null;
  const leadId = buildQueueLeadId({
    domain,
    caseId: logicsCaseId,
    fallbackId: lead._id,
    explicitLeadId: lead.leadId,
  });
  const partition = lead.partition || (
    ["just_came_in", "second_contact", "third_contact"].includes(lead.ageBucket)
      ? "fresh"
      : "non_fresh"
  );
  return {
    leadId,
    phoneNumber: lead.phoneNumber || lead.phone || "",
    domain,
    partition,
    ageBucket: lead.ageBucket || "day2_10",
    state: "in_pool",
    enteredQueueAt: lead.enteredQueueAt || new Date(),
    cadenceDueAt: lead.nextDueAt || lead.cadenceDueAt || null,
    sourceCadenceTaskId: lead.cadenceTaskId || null,
    sourceLogicsCaseId: logicsCaseId != null ? String(logicsCaseId) : null,
    recycleCount: 0,
  };
}

// ── Main: refill the pool to floor, FIFO append ────────────────────

async function refillPool({ floor = null, hourBucket = null, force = false } = {}) {
  const config = await getConfig();
  if (config.enabled === false && !force) {
    return { skipped: true, reason: "config-disabled" };
  }

  const effectiveFloor = Number.isFinite(floor)
    ? floor
    : (config.teamHourlyTarget || 100);

  const tz = config.businessHoursTimezone || "America/Los_Angeles";
  const effectiveHourBucket = hourBucket || formatHourBucket(new Date(), tz);

  // Read current occupancy
  const occupancy = await refreshPoolOccupancy();
  const need = Math.max(0, effectiveFloor - occupancy.inPoolCount);

  // Always do the snapshot, even if no work
  if (need === 0) {
    return {
      skipped: false,
      addedCount: 0,
      floor: effectiveFloor,
      inPoolCount: occupancy.inPoolCount,
      reason: "at-or-above-floor",
    };
  }

  // Pull cadence-due leads and upsert by leadId. The partial unique
  // index on active QueueItems is the final guard against double issue.
  const due = await readDueLeads({ limit: need * 2 });
  let addedCount = 0;
  for (const lead of due) {
    const payload = leadToQueueItemPayload(lead);
    if (!payload.phoneNumber) continue;
    const result = await queueItemRepository.upsertActiveItemForLead(payload, {
      returnMetadata: true,
    });
    if (result?.inserted) addedCount += 1;
    if (addedCount >= need) break;
  }

  if (!addedCount) {
    return {
      skipped: false,
      addedCount: 0,
      floor: effectiveFloor,
      inPoolCount: occupancy.inPoolCount,
      reason: "no-due-leads-available",
    };
  }

  await poolBudgetRepository.recordRefill({
    floor: effectiveFloor,
    addedCount,
    hourBucket: effectiveHourBucket,
  });

  // Re-snapshot occupancy after the insert
  const newOccupancy = await refreshPoolOccupancy();

  return {
    skipped: false,
    addedCount,
    floor: effectiveFloor,
    inPoolCount: newOccupancy.inPoolCount,
    inPoolByPartition: newOccupancy.inPoolByPartition,
    inPoolByAgeBucket: newOccupancy.inPoolByAgeBucket,
    reason: "refilled",
  };
}

// ── Pool-emptiness watcher tick ────────────────────────────────────
//
// Cheap check: is the pool empty? If yes, kick a refill. Caller
// (60s tick in server.js) invokes this. We only refill if currently
// in operating hours (or `morning-prep` allows off-hours pre-fill).

async function emptinessWatcherTick({ allowOffHours = false } = {}) {
  const config = await getConfig();
  if (config.enabled === false) return { skipped: true, reason: "config-disabled" };
  if (!allowOffHours && !isOperatingNow(config)) {
    return { skipped: true, reason: "outside-hours" };
  }
  const inPoolCount = await queueItemRepository.countInPool();
  if (inPoolCount > 0) {
    return { skipped: false, refilled: false, inPoolCount };
  }
  await poolBudgetRepository.recordEmptied();
  const result = await refillPool({ floor: config.teamHourlyTarget });
  return { skipped: false, refilled: true, ...result };
}

// ── Manual append (for tests / debug / external imports) ───────────

async function enqueueLead(leadPayload) {
  const payload = leadToQueueItemPayload(leadPayload);
  const result = await queueItemRepository.upsertActiveItemForLead(payload, {
    returnMetadata: true,
  });
  await refreshPoolOccupancy();
  if (!result?.inserted) {
    return { skipped: true, reason: "already-queued", item: result?.item || null };
  }
  return { skipped: false, item: result.item };
}

module.exports = {
  refillPool,
  emptinessWatcherTick,
  refreshPoolOccupancy,
  enqueueLead,
  leadToQueueItemPayload,
  buildQueueLeadId,
  readDueLeads,
  resolveAgeBucketFromAction,
};
