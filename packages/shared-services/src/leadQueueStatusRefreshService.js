"use strict";

// Queue-wide Logics status refresh — the DNC bleed fix (2026-07-24).
//
// Incident: WYNN case 137190 was delivered to an agent twice in one day
// while its Logics status was "[Bad/Inactive]-DO NOT CALL". The delivery
// gate (sourceEligibility) decides DNC from CaseProfile.statusId, which is
// a MIRROR of Logics — and the only thing refreshing it nightly was
// runNightlyLeadCadenceCaseRefresh, which is scoped to leads CREATED that
// same day (createdAtAfter/Before = dateKey). A lead that lives in the
// queue for weeks therefore got exactly one status check, on its creation
// day, and stayed dialable on that frozen status forever after.
//
// Measured on the live queue the day of the incident: 1,720 leads never
// status-checked, 6,966 last checked more than a week earlier — ~94% of
// 9,485 running on stale or absent status.
//
// This pass closes that hole: every lead still sitting in the delivery
// queue (any non-terminal state) gets its Logics status re-verified, so
// a case that goes DNC after intake stops being dialable by the next
// nightly run at the latest.

const mongoose = require("mongoose");
const { caseProfileRepository } = require("../../shared-repositories/src");
const { LeadCadence } = require("../../shared-models/src");
const { createLogicsClient } = require("../../shared-integrations/src/logicsClient");
const { resolveStatus } = require("../../shared-config/src/statusMap");
const { buildCaseProfilePhonePatch } = require("./casePhoneFoldService");

// DNC is decided by the STATUS CATALOG's category, never by a hardcoded
// id list — status ids are tenant-specific and collide across tenants
// (2026-07-24): WYNN 173 = "DO NOT CALL" (dnc), TAG 39 AND 173 = DNC, and
// 176 means "Post-Date" in TAG but "New Lead" in WYNN. A hardcoded [173]
// silently missed TAG's 39 and would misread 176.
//
// This also keeps LOGICS DNC (a case status set in the CRM) distinct from
// a channel/agent DNC (the prospect telling us to stop on a channel) —
// they are different facts and must not be counted as one.
function isLogicsDncStatus(domain, statusId) {
  if (!Number.isFinite(statusId)) return false;
  return resolveStatus(domain, statusId)?.category === "dnc";
}
const DEFAULT_STATES = Object.freeze([
  "eligible",
  "follow_up_wait",
  "review",
  "provider_accepted",
  "delivery_failed",
]);

function staleBefore(maxAgeHours) {
  const hours = Number.isFinite(Number(maxAgeHours)) ? Number(maxAgeHours) : 20;
  return new Date(Date.now() - Math.max(0, hours) * 60 * 60 * 1000);
}

/**
 * Re-verify Logics status for every lead still in the delivery queue.
 * Only refreshes profiles whose lastStatusCheckAt is older than
 * `maxAgeHours` (or missing), so a nightly run is cheap once caught up.
 *
 * Returns a summary including the DNC leads it found sitting in the queue
 * — those are the ones that would otherwise have been dialed.
 */
/**
 * Retire a lead the moment Logics says DNC.
 *
 * Business rule (Mickey, 2026-07-24): an opted-in lead is ours for 30
 * days, but "if we Logics DNC it, it needs to go away." Blocking it at
 * the delivery gate is not enough — the lead leaves the queue entirely,
 * the same way an agent's own `dnc` disposition retires it
 * (leadDeliveryService terminal-dnc-path: terminal / no next contact /
 * attempt closed). Deactivating the LeadCadence row also drops it from
 * the delivery universe, since readSourceBatch filters on active: true.
 */
async function retireDncLead({ db, item, statusName = null, dryRun = false }) {
  const caseIdText = String(item.caseId);
  const domain = String(item.domain || "").toUpperCase();
  const now = new Date();
  if (dryRun) return { retired: false, dryRun: true };

  await db.collection("leaddeliveryitems").updateOne(
    { _id: item._id },
    {
      $set: {
        state: "terminal",
        activeAttempt: false,
        lastOutcome: "dnc",
        terminalAt: now,
        nextContactAt: null,
        reservedAgentId: null,
        reservationExpiresAt: null,
        updatedAt: now,
        "metadata.retiredReason": "logics-dnc-status",
        "metadata.retiredStatusName": statusName,
        "metadata.retiredAt": now,
      },
    },
  );
  // Drop it out of the cadence universe too — readSourceBatch reads
  // LeadCadence with { domain, active: true }, so deactivating here is
  // what actually stops re-delivery.
  //
  // Use the MODEL, not a collection name: the live collection is
  // `controlplaneleadcadences`. There is also a legacy `leadcadences`
  // collection (3,942 docs, tenant keyed as `company`, domain null) that
  // is NOT what the delivery path reads — writing there is a silent no-op.
  // caseId is stored numeric here; match both forms defensively.
  const cadenceResult = await LeadCadence.updateMany(
    {
      domain,
      $or: [{ caseId: Number(caseIdText) }, { caseId: caseIdText }],
      active: true,
    },
    { $set: { active: false, updatedAt: now } },
  );
  return { retired: true, cadenceDeactivated: cadenceResult?.modifiedCount || 0 };
}

async function refreshQueuedLeadStatuses({
  states = DEFAULT_STATES,
  maxAgeHours = 20,
  limit = 20000,
  concurrency = 5,
  // "If we Logics DNC it, it needs to go away" — retire on discovery.
  retireDnc = true,
  dryRun = false,
  logger = null,
} = {}) {
  const db = mongoose.connection.db;
  const cutoff = staleBefore(maxAgeHours);
  const summary = {
    scanned: 0,
    refreshed: 0,
    failed: 0,
    skippedFresh: 0,
    dncFound: [],
    retired: 0,
    nonProspectFound: 0,
  };

  const items = await db
    .collection("leaddeliveryitems")
    .find({ state: { $in: [...states] } })
    .project({ caseId: 1, domain: 1, state: 1, normalizedPhone: 1, deliveryAgentId: 1 })
    .limit(Math.max(1, Number(limit) || 20000))
    .toArray();

  // Only re-check what is actually stale.
  const caseIds = items.map((i) => Number(i.caseId)).filter(Number.isFinite);
  const profiles = await db
    .collection("controlplanecaseprofiles")
    .find({ caseId: { $in: caseIds } })
    .project({ caseId: 1, lastStatusCheckAt: 1 })
    .toArray();
  const checkedAtByCase = new Map(
    profiles.map((p) => [Number(p.caseId), p.lastStatusCheckAt ? new Date(p.lastStatusCheckAt) : null]),
  );

  const targets = items.filter((item) => {
    const checkedAt = checkedAtByCase.get(Number(item.caseId));
    if (checkedAt && checkedAt > cutoff) {
      summary.skippedFresh += 1;
      return false;
    }
    return true;
  });
  summary.scanned = targets.length;

  const clients = new Map();
  const clientFor = (domain) => {
    if (!clients.has(domain)) clients.set(domain, createLogicsClient(domain));
    return clients.get(domain);
  };

  const queue = [...targets];
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 5, 10));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) break;
        const caseId = Number(item.caseId);
        const domain = String(item.domain || "").toUpperCase();
        if (!Number.isFinite(caseId) || !domain) continue;
        try {
          const info = await clientFor(domain).getCaseInfo(caseId);
          const data = info?.Data || info?.data || null;
          if (!data) { summary.failed += 1; continue; }
          const statusId = Number(data.StatusID ?? data.Status ?? NaN);
          // Phone fold rides this read for free (work order §3.5): every
          // getCaseInfo payload carries six phone fields, and this sweep
          // already touches the whole queue nightly. Folding here is what
          // finally populates normalizedPhones — including the SPOUSE
          // numbers that attribution sometimes hides behind.
          await caseProfileRepository.upsertCaseProfile(domain, caseId, {
            statusId: Number.isFinite(statusId) ? statusId : null,
            statusCategory: isLogicsDncStatus(domain, statusId) ? "dnc" : undefined,
            firstName: data.FirstName || undefined,
            lastName: data.LastName || undefined,
            ...buildCaseProfilePhonePatch(data),
            lastStatusCheckAt: new Date(),
          });
          summary.refreshed += 1;
          if (isLogicsDncStatus(domain, statusId)) {
            const record = {
              caseId,
              domain,
              phone: item.normalizedPhone || null,
              state: item.state,
              agent: item.deliveryAgentId || null,
              statusName: data.StatusName || null,
            };
            if (retireDnc) {
              const outcome = await retireDncLead({
                db, item, statusName: data.StatusName || null, dryRun,
              });
              record.retired = outcome.retired === true;
              record.cadenceDeactivated = outcome.cadenceDeactivated ?? 0;
              summary.retired += outcome.retired === true ? 1 : 0;
            }
            summary.dncFound.push(record);
          } else if (Number.isFinite(statusId) && ![1, 2].includes(statusId)) {
            summary.nonProspectFound += 1;
          }
        } catch (error) {
          summary.failed += 1;
          logger?.warn?.("lead_queue_status_refresh.case_failed", {
            domain, caseId, error: String(error.message).slice(0, 160),
          });
        }
      }
    }),
  );

  if (summary.dncFound.length) {
    logger?.warn?.("lead_queue_status_refresh.dnc_in_queue", {
      count: summary.dncFound.length,
      cases: summary.dncFound.map((d) => d.caseId),
    });
  }
  return summary;
}

module.exports = {
  DEFAULT_STATES,
  refreshQueuedLeadStatuses,
  retireDncLead,
};
