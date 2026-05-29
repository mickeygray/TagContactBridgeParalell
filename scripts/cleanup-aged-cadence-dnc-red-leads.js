"use strict";

// One-off cleanup for 30+ day LeadCadence rows:
//   - If cadence already carries a DNC/litigator signal, remove it from
//     operational cadence and active CX queue.
//   - Otherwise, optionally re-check RealValidation DNCLookup and:
//       clean  -> promote to the red/aged pool
//       dirty  -> remove from cadence/queue and stamp MPI DNC
//
// Dry-run by default.
//
// Usage:
//   node scripts/cleanup-aged-cadence-dnc-red-leads.js
//   node scripts/cleanup-aged-cadence-dnc-red-leads.js --lookup
//   node scripts/cleanup-aged-cadence-dnc-red-leads.js --lookup --apply
//   node scripts/cleanup-aged-cadence-dnc-red-leads.js --domain WYNN --limit 100

const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  CxDialQueue,
  LeadCadence,
  MasterProspectIndex,
} = require("../packages/shared-models/src");
const {
  createRealPhoneValidationClient,
} = require("../packages/shared-integrations/src");
const {
  computeNextCheckpoint,
  defaultMonthTag,
} = require("../packages/shared-services/src/fillerPoolRefreshService");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ACTIVE_QUEUE_STATES = ["queued", "ready", "claimed", "serving", "paused"];

function parseArgs(argv) {
  const args = {
    apply: false,
    lookup: false,
    domain: null,
    limit: 0,
    concurrency: 2,
    tag: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--lookup") args.lookup = true;
    else if (arg === "--domain") {
      args.domain = String(argv[i + 1] || "").trim().toUpperCase() || null;
      i += 1;
    } else if (arg === "--limit") {
      args.limit = Math.max(Number(argv[i + 1]) || 0, 0);
      i += 1;
    } else if (arg === "--concurrency") {
      args.concurrency = Math.max(Number(argv[i + 1]) || 1, 1);
      i += 1;
    } else if (arg === "--tag") {
      args.tag = String(argv[i + 1] || "").trim();
      i += 1;
    }
  }
  return args;
}

function hasDncSignal(value) {
  if (!value || typeof value !== "object") return false;
  return Boolean(
    value.onDnc ||
      value.onDNC ||
      value.onNationalDNC ||
      value.onNationalDnc ||
      value.onStateDNC ||
      value.onStateDnc ||
      value.isLitigator ||
      value.litigator,
  );
}

function dncReasonFromValue(value) {
  if (!value || typeof value !== "object") return null;
  if (value.isLitigator || value.litigator) return "litigator";
  if (value.onNationalDNC || value.onNationalDnc || value.onDnc || value.onDNC) return "national";
  if (value.onStateDNC || value.onStateDnc) return "state";
  return null;
}

function storedDncReasons(lead) {
  const reasons = [];
  const state = lead.cadenceState || {};
  const dncCheck = state.dncCheck || {};
  const channelDnc = state.channelDnc || {};

  if (hasDncSignal(dncCheck.lastResult)) reasons.push("cadenceState.dncCheck.lastResult");
  if (hasDncSignal(dncCheck.initialResult)) reasons.push("cadenceState.dncCheck.initialResult");
  if (hasDncSignal(lead.payloadSnapshot?.dncCheck?.lastResult)) reasons.push("payloadSnapshot.dncCheck.lastResult");
  if (hasDncSignal(lead.payloadSnapshot?.dncCheck?.initialResult)) reasons.push("payloadSnapshot.dncCheck.initialResult");
  if (hasDncSignal(lead.validationContext?.phone)) reasons.push("validationContext.phone");
  if (lead.dncCheckpoints?.hit) reasons.push("dncCheckpoints.hit");
  if (channelDnc.cx?.blocked) reasons.push("cadenceState.channelDnc.cx");
  if (channelDnc.rvm?.blocked) reasons.push("cadenceState.channelDnc.rvm");
  return reasons;
}

function storedDncCategory(lead) {
  const state = lead.cadenceState || {};
  const dncCheck = state.dncCheck || {};
  return (
    dncReasonFromValue(dncCheck.lastResult) ||
    dncReasonFromValue(dncCheck.initialResult) ||
    dncReasonFromValue(lead.payloadSnapshot?.dncCheck?.lastResult) ||
    dncReasonFromValue(lead.payloadSnapshot?.dncCheck?.initialResult) ||
    dncReasonFromValue(lead.validationContext?.phone) ||
    (lead.dncCheckpoints?.reason || null) ||
    "stored-dnc"
  );
}


function normalizeDirtyReason(lookup) {
  if (!lookup) return null;
  if (lookup.isLitigator) return "litigator";
  if (lookup.onNationalDNC) return "national";
  if (lookup.onStateDNC) return "state";
  return null;
}

function buildDncSubdoc(lookup, now = new Date(), fallbackReason = null) {
  return {
    onNationalDnc: Boolean(lookup?.onNationalDNC || fallbackReason === "national"),
    onStateDnc: Boolean(lookup?.onStateDNC || fallbackReason === "state"),
    onDma: Boolean(lookup?.onDMA),
    isLitigator: Boolean(lookup?.isLitigator || fallbackReason === "litigator"),
    isCell: Boolean(lookup?.isCell),
    checkedAt: now,
    source: lookup?.source || lookup?.mode || "cadence-cleanup",
    nextCheckAt: new Date(now.getTime() + 30 * MS_PER_DAY),
  };
}

async function runConcurrent(items, concurrency, handler) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      try {
        results[idx] = await handler(items[idx], idx);
      } catch (error) {
        results[idx] = { error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function removeFromOperationalCadence(lead, { now, reason, lookup, apply }) {
  const domain = lead.domain;
  const caseId = Number(lead.caseId);
  if (!apply) {
    return {
      cadenceDeleted: 0,
      queueDeleted: 0,
      mpiStamped: 0,
    };
  }
  const [cadenceResult, queueResult, mpiResult] = await Promise.all([
    LeadCadence.deleteOne({ _id: lead._id }),
    CxDialQueue.deleteMany({
      domain,
      caseId,
      state: { $in: ACTIVE_QUEUE_STATES },
    }),
    MasterProspectIndex.updateOne(
      { domain, caseId },
      {
        $set: {
          domain,
          caseId,
          normalizedPhones: lead.normalizedPhone ? [lead.normalizedPhone] : [],
          lastSeenAt: now,
          dnc: buildDncSubdoc(lookup, now, reason),
          pool: null,
        },
        $setOnInsert: { firstSeenAt: now },
      },
      { upsert: true },
    ),
  ]);
  return {
    cadenceDeleted: Number(cadenceResult.deletedCount || 0),
    queueDeleted: Number(queueResult.deletedCount || 0),
    mpiStamped: Number(mpiResult.modifiedCount || mpiResult.upsertedCount || 0),
  };
}

async function promoteToRedPool(lead, { now, tag, lookup, apply }) {
  const domain = lead.domain;
  const caseId = Number(lead.caseId);
  const adv = computeNextCheckpoint(lead.createdAt, Number(lead.dncCheckpoints?.count || 0));
  if (!apply) {
    return {
      leadUpdated: 0,
      mpiUpserted: 0,
      nextAt: adv.nextAt,
    };
  }
  const [leadResult, mpiResult] = await Promise.all([
    LeadCadence.updateOne(
      { _id: lead._id },
      {
        $set: {
          "dncCheckpoints.count": adv.newCount,
          "dncCheckpoints.lastAt": now,
          "dncCheckpoints.nextAt": adv.nextAt,
          "dncCheckpoints.cleared": adv.cleared,
          "dncCheckpoints.hit": false,
          "dncCheckpoints.source": "oneoff-cadence-cleanup",
          "dncCheckpoints.reason": null,
        },
      },
    ),
    MasterProspectIndex.updateOne(
      { domain, caseId },
      {
        $set: {
          domain,
          caseId,
          normalizedPhones: lead.normalizedPhone ? [lead.normalizedPhone] : [],
          lastSeenAt: now,
          dnc: buildDncSubdoc(lookup, now),
          pool: {
            tag,
            source: "oneoff-cadence-cleanup",
            builtAt: now,
            dncScrubbedAt: now,
          },
          "metadata.routeCampaignKey": lead.routeCampaignKey || null,
          "metadata.routeCampaignName": lead.routeCampaignName || null,
        },
        $setOnInsert: { firstSeenAt: now },
      },
      { upsert: true },
    ),
  ]);
  return {
    leadUpdated: Number(leadResult.modifiedCount || 0),
    mpiUpserted: Number(mpiResult.modifiedCount || mpiResult.upsertedCount || 0),
    nextAt: adv.nextAt,
  };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = getSharedConfig();
  const now = new Date();
  const cutoff = new Date(now.getTime() - 30 * MS_PER_DAY);
  const tag = args.tag || defaultMonthTag(now);

  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });

  const query = {
    active: true,
    graduatedAt: null,
    createdAt: { $lte: cutoff },
    "dncCheckpoints.cleared": { $ne: true },
  };
  if (args.domain) query.domain = args.domain;

  const cursor = LeadCadence.find(query, {
    _id: 1,
    domain: 1,
    caseId: 1,
    createdAt: 1,
    name: 1,
    normalizedPhone: 1,
    primaryPhone: 1,
    routeCampaignKey: 1,
    routeCampaignName: 1,
    validationContext: 1,
    payloadSnapshot: 1,
    cadenceState: 1,
    dncCheckpoints: 1,
  })
    .sort({ createdAt: 1 })
    .lean()
    .cursor();

  const storedDncLeads = [];
  const recheckLeads = [];
  let scanned = 0;

  for await (const lead of cursor) {
    if (args.limit > 0 && scanned >= args.limit) break;
    scanned += 1;
    const reasons = storedDncReasons(lead);
    if (reasons.length) {
      storedDncLeads.push({ lead, reasons });
    } else {
      recheckLeads.push(lead);
    }
  }

  const summary = {
    apply: args.apply,
    lookup: args.lookup,
    db: mongoose.connection.name,
    tag,
    domain: args.domain || "ALL",
    cutoff,
    scanned,
    storedDncDeleteCandidates: storedDncLeads.length,
    recheckCandidates: recheckLeads.length,
    lookupCleanPromoteCandidates: 0,
    lookupDirtyDeleteCandidates: 0,
    lookupErrors: 0,
    writes: {
      cadenceDeleted: 0,
      queueDeleted: 0,
      mpiStampedOrUpdated: 0,
      redPromoted: 0,
    },
    byDomain: {},
    samples: {
      storedDnc: storedDncLeads.slice(0, 12).map(({ lead, reasons }) => ({
        domain: lead.domain,
        caseId: lead.caseId,
        reasons,
      })),
      dirtyLookup: [],
      cleanPromote: [],
    },
  };

  function bump(domain, field) {
    if (!summary.byDomain[domain]) {
      summary.byDomain[domain] = {
        scanned: 0,
        storedDncDeleteCandidates: 0,
        recheckCandidates: 0,
        lookupCleanPromoteCandidates: 0,
        lookupDirtyDeleteCandidates: 0,
        lookupErrors: 0,
      };
    }
    summary.byDomain[domain][field] += 1;
  }

  for (const { lead, reasons } of storedDncLeads) {
    bump(lead.domain, "storedDncDeleteCandidates");
    const reason = storedDncCategory(lead);
    const writeResult = await removeFromOperationalCadence(lead, {
      now,
      reason,
      lookup: null,
      apply: args.apply,
    });
    summary.writes.cadenceDeleted += writeResult.cadenceDeleted;
    summary.writes.queueDeleted += writeResult.queueDeleted;
    summary.writes.mpiStampedOrUpdated += writeResult.mpiStamped;
  }
  for (const lead of recheckLeads) bump(lead.domain, "recheckCandidates");

  if (args.lookup && recheckLeads.length > 0) {
    const client = createRealPhoneValidationClient();
    const lookups = await runConcurrent(
      recheckLeads,
      args.concurrency,
      async (lead) => {
        const phone = lead.normalizedPhone || lead.primaryPhone;
        if (!phone) return { lead, lookup: null, error: new Error("missing-phone") };
        const lookup = await client.lookupDnc(phone);
        return { lead, lookup, error: null };
      },
    );

    for (const item of lookups) {
      const lead = item?.lead;
      if (!lead) continue;
      const error = item.error;
      if (error) {
        summary.lookupErrors += 1;
        bump(lead.domain, "lookupErrors");
        continue;
      }
      const lookup = item.lookup;
      const dirtyReason = normalizeDirtyReason(lookup);
      if (dirtyReason) {
        summary.lookupDirtyDeleteCandidates += 1;
        bump(lead.domain, "lookupDirtyDeleteCandidates");
        if (summary.samples.dirtyLookup.length < 12) {
          summary.samples.dirtyLookup.push({
            domain: lead.domain,
            caseId: lead.caseId,
            reason: dirtyReason,
          });
        }
        const writeResult = await removeFromOperationalCadence(lead, {
          now,
          reason: dirtyReason,
          lookup,
          apply: args.apply,
        });
        summary.writes.cadenceDeleted += writeResult.cadenceDeleted;
        summary.writes.queueDeleted += writeResult.queueDeleted;
        summary.writes.mpiStampedOrUpdated += writeResult.mpiStamped;
      } else {
        summary.lookupCleanPromoteCandidates += 1;
        bump(lead.domain, "lookupCleanPromoteCandidates");
        if (summary.samples.cleanPromote.length < 12) {
          summary.samples.cleanPromote.push({
            domain: lead.domain,
            caseId: lead.caseId,
          });
        }
        const writeResult = await promoteToRedPool(lead, {
          now,
          tag,
          lookup,
          apply: args.apply,
        });
        summary.writes.redPromoted += writeResult.leadUpdated;
        summary.writes.mpiStampedOrUpdated += writeResult.mpiUpserted;
      }
    }
  }

  for (const lead of [...storedDncLeads.map((x) => x.lead), ...recheckLeads]) {
    bump(lead.domain, "scanned");
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!args.apply) {
    console.log("");
    console.log("Dry run only. Add --apply to write deletes/promotions.");
  }
  if (!args.lookup) {
    console.log("No RealValidation lookups were run. Add --lookup to price/check the recheck candidates.");
  }

  await mongoose.disconnect();
})().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
