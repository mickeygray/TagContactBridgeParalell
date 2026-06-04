"use strict";

// One-off cleanup/reawakening for dormant LeadCadence rows.
//
// Dry-run by default. This script handles two intentionally separate jobs:
//   1. Remove inactive NCOA/mail staging rows from LeadCadence only. The
//      durable mail-import records live elsewhere.
//   2. For inactive non-mailer rows that have no obvious stored DNC/block
//      signal, optionally run a fresh RealValidation DNCLookup and promote
//      clean 30+ day rows into the aged/filler pool. That pool is already
//      materialized by the CX workspace with a 14-day delay, so these do not
//      re-enter the fresh 3x/day cadence.
//
// Usage:
//   node scripts/cleanup-dormant-leadcadences.js
//   node scripts/cleanup-dormant-leadcadences.js --lookup
//   node scripts/cleanup-dormant-leadcadences.js --lookup --apply
//   node scripts/cleanup-dormant-leadcadences.js --lookup --apply --domain WYNN --limit 500

const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  LeadCadence,
  MasterProspectIndex,
} = require("../packages/shared-models/src");
const {
  createRealPhoneValidationClient,
} = require("../packages/shared-integrations/src");
const {
  defaultMonthTag,
} = require("../packages/shared-services/src/fillerPoolRefreshService");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    apply: false,
    lookup: false,
    cleanupMailers: true,
    domain: null,
    limit: 0,
    concurrency: 2,
    minAgeDays: 30,
    tag: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--lookup") args.lookup = true;
    else if (arg === "--skip-mailers") args.cleanupMailers = false;
    else if (arg === "--domain") {
      args.domain = String(argv[i + 1] || "").trim().toUpperCase() || null;
      i += 1;
    } else if (arg === "--limit") {
      args.limit = Math.max(Number(argv[i + 1]) || 0, 0);
      i += 1;
    } else if (arg === "--concurrency") {
      args.concurrency = Math.max(Number(argv[i + 1]) || 1, 1);
      i += 1;
    } else if (arg === "--min-age-days") {
      args.minAgeDays = Math.max(Number(argv[i + 1]) || 30, 0);
      i += 1;
    } else if (arg === "--tag") {
      args.tag = String(argv[i + 1] || "").trim();
      i += 1;
    }
  }
  return args;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length === 10 ? digits : null;
}

function ageDays(createdAt, now = new Date()) {
  const time = new Date(createdAt).getTime();
  if (!Number.isFinite(time)) return null;
  return (now.getTime() - time) / MS_PER_DAY;
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

function blockedChannels(lead = {}) {
  const channelDnc = lead.cadenceState?.channelDnc || {};
  return ["sms", "email", "rvm", "cx"].filter((channel) => channelDnc[channel]?.blocked);
}

function storedBlockReasons(lead = {}) {
  const reasons = [];
  const state = lead.cadenceState || {};
  const validation = lead.validationContext || {};
  const payload = lead.payloadSnapshot || {};
  const stage = String(lead.currentStage || "").trim().toLowerCase();
  const channels = blockedChannels(lead);

  if (stage === "contact-blocked") reasons.push("currentStage.contact-blocked");
  if (channels.length) reasons.push(`cadenceState.channelDnc.${channels.join(",")}`);
  if (lead.dncCheckpoints?.hit) reasons.push("dncCheckpoints.hit");
  if (hasDncSignal(state.dncCheck?.initialResult)) reasons.push("cadenceState.dncCheck.initialResult");
  if (hasDncSignal(state.dncCheck?.lastResult)) reasons.push("cadenceState.dncCheck.lastResult");
  if (hasDncSignal(payload.dncCheck?.initialResult)) reasons.push("payloadSnapshot.dncCheck.initialResult");
  if (hasDncSignal(payload.dncCheck?.lastResult)) reasons.push("payloadSnapshot.dncCheck.lastResult");
  if (hasDncSignal(validation.phone)) reasons.push("validationContext.phone");
  if (validation.phoneCanCall === false) reasons.push("validationContext.phoneCanCall=false");
  if (validation.phoneValid === false) reasons.push("validationContext.phoneValid=false");
  if (validation.onNationalDNC || validation.onNationalDnc) reasons.push("validationContext.national-dnc");
  if (validation.onStateDNC || validation.onStateDnc) reasons.push("validationContext.state-dnc");
  if (validation.isLitigator) reasons.push("validationContext.litigator");

  return reasons;
}

function dirtyReasonFromLookup(lookup) {
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
    isCell: lookup?.isCell == null ? null : Boolean(lookup.isCell),
    checkedAt: now,
    source: lookup?.source || lookup?.mode || "dormant-leadcadence-cleanup",
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
        results[idx] = { lead: items[idx], error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function promoteCleanDormantLead(lead, { now, tag, lookup, apply }) {
  if (!apply) return { leadUpdated: 0, mpiUpdated: 0 };
  const domain = lead.domain;
  const caseId = Number(lead.caseId);
  const phone = normalizePhone(lead.normalizedPhone || lead.primaryPhone);
  const [leadResult, mpiResult] = await Promise.all([
    LeadCadence.updateOne(
      { _id: lead._id },
      {
        $set: {
          "dncCheckpoints.count": 3,
          "dncCheckpoints.lastAt": now,
          "dncCheckpoints.nextAt": null,
          "dncCheckpoints.cleared": true,
          "dncCheckpoints.hit": false,
          "dncCheckpoints.source": "dormant-reawaken-clean",
          "dncCheckpoints.reason": null,
          "payloadSnapshot.dormantReawakenedAt": now,
          "payloadSnapshot.dormantReawakenedPoolTag": tag,
        },
      },
    ),
    MasterProspectIndex.updateOne(
      { domain, caseId },
      {
        $set: {
          domain,
          caseId,
          normalizedPhones: phone ? [phone] : [],
          cellPhone: phone || null,
          firstName: lead.firstName || null,
          lastName: lead.lastName || null,
          name: lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() || null,
          state: lead.state || null,
          lastSeenAt: now,
          dnc: buildDncSubdoc(lookup, now),
          pool: {
            tag,
            source: "dormant-leadcadence-reawaken",
            builtAt: now,
            dncScrubbedAt: now,
          },
          "metadata.intakeSource": lead.intakeSource || null,
          "metadata.sourceName": lead.sourceName || null,
          "metadata.sourceChannel": lead.sourceChannel || null,
          "metadata.routeCampaignKey": lead.routeCampaignKey || null,
          "metadata.routeCampaignName": lead.routeCampaignName || null,
          "metadata.vendorSourceName": lead.vendorSourceName || null,
          "metadata.dormantReawakenedAt": now,
        },
        $setOnInsert: { firstSeenAt: now },
      },
      { upsert: true },
    ),
  ]);
  return {
    leadUpdated: Number(leadResult.modifiedCount || 0),
    mpiUpdated: Number(mpiResult.modifiedCount || mpiResult.upsertedCount || 0),
  };
}

async function stampDirtyDormantLead(lead, { now, reason, lookup, apply }) {
  if (!apply) return { leadUpdated: 0, mpiUpdated: 0 };
  const domain = lead.domain;
  const caseId = Number(lead.caseId);
  const phone = normalizePhone(lead.normalizedPhone || lead.primaryPhone);
  const [leadResult, mpiResult] = await Promise.all([
    LeadCadence.updateOne(
      { _id: lead._id },
      {
        $set: {
          currentStage: "contact-blocked",
          "dncCheckpoints.count": Number(lead.dncCheckpoints?.count || 0),
          "dncCheckpoints.lastAt": now,
          "dncCheckpoints.nextAt": null,
          "dncCheckpoints.cleared": false,
          "dncCheckpoints.hit": true,
          "dncCheckpoints.hitAt": now,
          "dncCheckpoints.source": "dormant-reawaken-dnc",
          "dncCheckpoints.reason": reason,
        },
      },
    ),
    MasterProspectIndex.updateOne(
      { domain, caseId },
      {
        $set: {
          domain,
          caseId,
          normalizedPhones: phone ? [phone] : [],
          cellPhone: phone || null,
          lastSeenAt: now,
          dnc: buildDncSubdoc(lookup, now, reason),
          pool: null,
          "metadata.dormantRejectedAt": now,
          "metadata.dormantRejectedReason": reason,
        },
        $setOnInsert: { firstSeenAt: now },
      },
      { upsert: true },
    ),
  ]);
  return {
    leadUpdated: Number(leadResult.modifiedCount || 0),
    mpiUpdated: Number(mpiResult.modifiedCount || mpiResult.upsertedCount || 0),
  };
}

function bump(map, key, field = "count") {
  const normalized = key || "null";
  if (!map[normalized]) map[normalized] = { count: 0 };
  map[normalized][field] = Number(map[normalized][field] || 0) + 1;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = getSharedConfig();
  const now = new Date();
  const tag = args.tag || defaultMonthTag(now);
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });

  const mailerQuery = {
    active: false,
    intakeRoute: "ncoa-upload",
    currentStage: "ncoa-uploaded",
  };
  if (args.domain) mailerQuery.domain = args.domain;

  const mailerCount = args.cleanupMailers
    ? await LeadCadence.countDocuments(mailerQuery)
    : 0;
  const mailerDeleteResult = args.cleanupMailers && args.apply
    ? await LeadCadence.deleteMany(mailerQuery)
    : { deletedCount: 0 };

  const minCreatedAt = new Date(now.getTime() - args.minAgeDays * MS_PER_DAY);
  const candidateQuery = {
    active: false,
    intakeRoute: { $ne: "ncoa-upload" },
    createdAt: { $lte: minCreatedAt },
    "payloadSnapshot.dormantReawakenedAt": { $exists: false },
    "dncCheckpoints.hit": { $ne: true },
  };
  if (args.domain) candidateQuery.domain = args.domain;

  const cursor = LeadCadence.find(candidateQuery, {
    _id: 1,
    domain: 1,
    caseId: 1,
    createdAt: 1,
    firstName: 1,
    lastName: 1,
    name: 1,
    state: 1,
    currentStage: 1,
    intakeRoute: 1,
    intakeSource: 1,
    sourceName: 1,
    sourceChannel: 1,
    routeCampaignKey: 1,
    routeCampaignName: 1,
    vendorSourceName: 1,
    primaryPhone: 1,
    normalizedPhone: 1,
    cadenceState: 1,
    validationContext: 1,
    payloadSnapshot: 1,
    dncCheckpoints: 1,
  })
    .sort({ createdAt: 1 })
    .limit(args.limit > 0 ? args.limit : 0)
    .lean()
    .cursor();

  const review = [];
  const eligibleForLookup = [];
  const summary = {
    apply: args.apply,
    lookup: args.lookup,
    tag,
    domain: args.domain || "ALL",
    minAgeDays: args.minAgeDays,
    mailers: {
      cleanupEnabled: args.cleanupMailers,
      deleteCandidates: mailerCount,
      deleted: Number(mailerDeleteResult.deletedCount || 0),
    },
    dormant: {
      scanned: 0,
      skippedMissingPhone: 0,
      skippedStoredBlock: 0,
      eligibleForLookup: 0,
      lookupCleanPromoteCandidates: 0,
      lookupDirtyRejectCandidates: 0,
      lookupErrors: 0,
    },
    writes: {
      cleanLeadStamped: 0,
      dirtyLeadStamped: 0,
      mpiUpdated: 0,
    },
    byDomain: {},
    byStage: {},
    samples: {
      skippedStoredBlock: [],
      cleanPromote: [],
      dirtyReject: [],
      lookupErrors: [],
    },
  };

  for await (const lead of cursor) {
    summary.dormant.scanned += 1;
    bump(summary.byDomain, lead.domain);
    bump(summary.byStage, lead.currentStage || "null");

    const phone = normalizePhone(lead.normalizedPhone || lead.primaryPhone);
    if (!phone) {
      summary.dormant.skippedMissingPhone += 1;
      continue;
    }

    const blockReasons = storedBlockReasons(lead);
    if (blockReasons.length > 0) {
      summary.dormant.skippedStoredBlock += 1;
      if (summary.samples.skippedStoredBlock.length < 15) {
        summary.samples.skippedStoredBlock.push({
          domain: lead.domain,
          caseId: lead.caseId,
          currentStage: lead.currentStage || null,
          reasons: blockReasons,
        });
      }
      continue;
    }

    eligibleForLookup.push({ ...lead, normalizedPhone: phone });
  }

  summary.dormant.eligibleForLookup = eligibleForLookup.length;

  if (args.lookup && eligibleForLookup.length > 0) {
    const client = createRealPhoneValidationClient();
    const lookupResults = await runConcurrent(
      eligibleForLookup,
      args.concurrency,
      async (lead) => ({
        lead,
        lookup: await client.lookupDnc(lead.normalizedPhone),
        error: null,
      }),
    );

    for (const item of lookupResults) {
      const lead = item.lead;
      if (item.error) {
        summary.dormant.lookupErrors += 1;
        if (summary.samples.lookupErrors.length < 15) {
          summary.samples.lookupErrors.push({
            domain: lead.domain,
            caseId: lead.caseId,
            error: item.error.message,
          });
        }
        continue;
      }

      const reason = dirtyReasonFromLookup(item.lookup);
      if (reason) {
        summary.dormant.lookupDirtyRejectCandidates += 1;
        if (summary.samples.dirtyReject.length < 15) {
          summary.samples.dirtyReject.push({
            domain: lead.domain,
            caseId: lead.caseId,
            reason,
          });
        }
        const write = await stampDirtyDormantLead(lead, {
          now,
          reason,
          lookup: item.lookup,
          apply: args.apply,
        });
        summary.writes.dirtyLeadStamped += write.leadUpdated;
        summary.writes.mpiUpdated += write.mpiUpdated;
      } else {
        summary.dormant.lookupCleanPromoteCandidates += 1;
        if (summary.samples.cleanPromote.length < 15) {
          summary.samples.cleanPromote.push({
            domain: lead.domain,
            caseId: lead.caseId,
            currentStage: lead.currentStage || null,
            intakeRoute: lead.intakeRoute || null,
          });
        }
        const write = await promoteCleanDormantLead(lead, {
          now,
          tag,
          lookup: item.lookup,
          apply: args.apply,
        });
        summary.writes.cleanLeadStamped += write.leadUpdated;
        summary.writes.mpiUpdated += write.mpiUpdated;
      }
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!args.apply) {
    console.log("");
    console.log("Dry run only. Add --apply to delete mailer staging rows and stamp clean/dirty dormant rows.");
  }
  if (!args.lookup) {
    console.log("No RealValidation lookups were run. Add --lookup to classify eligible dormant rows.");
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
