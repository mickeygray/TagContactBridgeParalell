"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CxDialQueue, LeadCadence, MasterProspectIndex } = require("../packages/shared-models/src");
const { normalizeLdLeadPayload } = require("../packages/shared-services/src/inboundIntakeService");

const ACTIVE_QUEUE_STATES = ["queued", "ready", "claimed", "serving", "paused"];
const SPLIT_KEYS = new Set(["ld-custom", "ld-general"]);
const SOURCE_ID_BY_KEY = {
  "ld-custom": Number(process.env.LOGICS_LD_CUSTOM_SOURCE_ID || process.env.LD_CUSTOM_SOURCE_ID || 45),
  "ld-general": Number(process.env.LOGICS_LD_GENERAL_SOURCE_ID || process.env.LD_GENERAL_SOURCE_ID || 46),
};

function parseArgs(argv) {
  const args = {
    apply: false,
    all: false,
    days: 14,
    limit: 5000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--all") {
      args.all = true;
    } else if (arg === "--days") {
      args.days = Math.max(Number(argv[index + 1]) || args.days, 1);
      index += 1;
    } else if (arg === "--limit") {
      args.limit = Math.max(Number(argv[index + 1]) || args.limit, 1);
      index += 1;
    }
  }
  return args;
}

function buildDetectionPayload(doc = {}) {
  const snapshot = doc.payloadSnapshot && typeof doc.payloadSnapshot === "object"
    ? { ...doc.payloadSnapshot }
    : {};
  if (!snapshot.vendor && doc.partnerSource) snapshot.vendor = doc.partnerSource;
  if (!snapshot.partner && doc.partnerSource) snapshot.partner = doc.partnerSource;
  if (!snapshot.sourceName && doc.vendorSourceName) snapshot.sourceName = doc.vendorSourceName;
  if (!snapshot.source && doc.sourceName) snapshot.source = doc.sourceName;
  if (!snapshot.company) snapshot.company = doc.domain || "WYNN";
  return snapshot;
}

function detectSplit(doc = {}) {
  const normalized = normalizeLdLeadPayload(buildDetectionPayload(doc), {}, {});
  if (!SPLIT_KEYS.has(normalized.routeCampaignKey)) return null;
  return {
    routeCampaignKey: normalized.routeCampaignKey,
    routeCampaignName: normalized.routeCampaignName,
    sourceName: normalized.sourceName || null,
    logicsSourceName: normalized.logicsSourceName || null,
    logicsCampaignName: normalized.logicsCampaignName || null,
    vendorSourceName: normalized.vendorSourceName || doc.vendorSourceName || null,
    partnerSource: normalized.partnerSource || doc.partnerSource || null,
    ldSubsourceKind: normalized.payloadSnapshot?.ldSubsourceKind || null,
    ldSubsourceLabel: normalized.payloadSnapshot?.ldSubsourceLabel || null,
    ldSubsourceValue: normalized.payloadSnapshot?.ldSubsourceValue || null,
    ldSubsourceField: normalized.payloadSnapshot?.ldSubsourceField || null,
    sourceId: SOURCE_ID_BY_KEY[normalized.routeCampaignKey] || null,
  };
}

function buildLeadCadencePatch(split) {
  const set = {
    routeCampaignKey: split.routeCampaignKey,
    routeCampaignName: split.routeCampaignName,
    sourceName: split.sourceName,
    partnerSource: split.partnerSource,
    vendorSourceName: split.vendorSourceName,
    "attributionContext.routeCampaignKey": split.routeCampaignKey,
    "attributionContext.routeCampaignName": split.routeCampaignName,
    "attributionContext.sourceName": split.sourceName,
    "attributionContext.vendorSourceName": split.vendorSourceName,
    "payloadSnapshot.routeCampaignKey": split.routeCampaignKey,
    "payloadSnapshot.routeCampaignName": split.routeCampaignName,
    "payloadSnapshot.vendorSourceName": split.vendorSourceName,
    "payloadSnapshot.logicsSourceName": split.logicsSourceName,
    "payloadSnapshot.logicsCampaignName": split.logicsCampaignName,
    "payloadSnapshot.sourceId": split.sourceId,
    "payloadSnapshot.SourceName": split.logicsSourceName,
    "payloadSnapshot.CampaignName": split.logicsCampaignName,
    "payloadSnapshot.ldSubsourceKind": split.ldSubsourceKind,
    "payloadSnapshot.ldSubsourceLabel": split.ldSubsourceLabel,
    "payloadSnapshot.ldSubsourceValue": split.ldSubsourceValue,
    "payloadSnapshot.ldSubsourceField": split.ldSubsourceField,
  };
  return { $set: set };
}

function buildMasterProspectPatch(split) {
  return {
    $set: {
      "metadata.routeCampaignKey": split.routeCampaignKey,
      "metadata.routeCampaignName": split.routeCampaignName,
      "metadata.sourceName": split.sourceName,
      "metadata.logicsSourceName": split.logicsSourceName,
      "metadata.logicsCampaignName": split.logicsCampaignName,
      "metadata.sourceId": split.sourceId,
      sourceId: split.sourceId,
      "metadata.vendorSourceName": split.vendorSourceName,
    },
  };
}

function buildQueuePatch(split) {
  return {
    $set: {
      sourceName: split.sourceName,
      "metadata.routeCampaignKey": split.routeCampaignKey,
      "metadata.routeCampaignName": split.routeCampaignName,
      "metadata.sourceName": split.sourceName,
      "metadata.logicsSourceName": split.logicsSourceName,
      "metadata.logicsCampaignName": split.logicsCampaignName,
      "metadata.sourceId": split.sourceId,
    },
  };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });

  const query = {
    domain: "WYNN",
    intakeSource: { $in: ["ld", "ld-posting"] },
  };
  if (!args.all) {
    query.createdAt = {
      $gte: new Date(Date.now() - args.days * 24 * 60 * 60 * 1000),
    };
  }

  const docs = await LeadCadence.find(query, {
    domain: 1,
    caseId: 1,
    createdAt: 1,
    routeCampaignKey: 1,
    routeCampaignName: 1,
    partnerSource: 1,
    vendorSourceName: 1,
    sourceName: 1,
    payloadSnapshot: 1,
  })
    .sort({ createdAt: -1 })
    .limit(args.limit)
    .lean();

  const summary = {
    scanned: docs.length,
    detected: 0,
    byKey: {},
    needsLeadCadenceUpdate: 0,
    masterProspectMatched: 0,
    queueMatched: 0,
    leadCadenceUpdated: 0,
    masterProspectUpdated: 0,
    queueUpdated: 0,
    dryRun: !args.apply,
  };

  for (const doc of docs) {
    const split = detectSplit(doc);
    if (!split) continue;
    summary.detected += 1;
    summary.byKey[split.routeCampaignKey] = (summary.byKey[split.routeCampaignKey] || 0) + 1;
    const cadenceNeedsUpdate =
      doc.routeCampaignKey !== split.routeCampaignKey ||
      doc.routeCampaignName !== split.routeCampaignName ||
      doc.sourceName !== split.sourceName ||
      doc.vendorSourceName !== split.vendorSourceName ||
      doc.partnerSource !== split.partnerSource ||
      doc.payloadSnapshot?.CampaignName !== split.logicsCampaignName ||
      doc.payloadSnapshot?.SourceName !== split.logicsSourceName;
    if (cadenceNeedsUpdate) summary.needsLeadCadenceUpdate += 1;

    const [masterMatchCount, queueMatchCount] = await Promise.all([
      MasterProspectIndex.countDocuments({
        domain: doc.domain,
        caseId: Number(doc.caseId),
      }),
      CxDialQueue.countDocuments({
        domain: doc.domain,
        caseId: Number(doc.caseId),
        state: { $in: ACTIVE_QUEUE_STATES },
      }),
    ]);
    summary.masterProspectMatched += masterMatchCount;
    summary.queueMatched += queueMatchCount;

    if (!args.apply) continue;

    const leadResult = await LeadCadence.updateOne(
      { _id: doc._id },
      buildLeadCadencePatch(split),
    );
    summary.leadCadenceUpdated += Number(leadResult.modifiedCount || 0);

    const masterResult = await MasterProspectIndex.updateOne(
      { domain: doc.domain, caseId: Number(doc.caseId) },
      buildMasterProspectPatch(split),
    );
    summary.masterProspectUpdated += Number(masterResult.modifiedCount || 0);

    const queueResult = await CxDialQueue.updateMany(
      {
        domain: doc.domain,
        caseId: Number(doc.caseId),
        state: { $in: ACTIVE_QUEUE_STATES },
      },
      buildQueuePatch(split),
    );
    summary.queueUpdated += Number(queueResult.modifiedCount || 0);
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!args.apply) {
    console.log("Dry run only. Re-run with --apply to write internal LD split labels to LeadCadence, MasterProspectIndex, and active CxDialQueue rows. This script does not update Logics.");
  }
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore cleanup failure
  }
  process.exit(1);
});
