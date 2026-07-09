#!/usr/bin/env node
"use strict";

// Read-only morning queue scale audit.
//
// This does not build queues, cancel RingCX rows, publish to RingCX, or mutate Mongo.
// It answers whether the scheduled morning worker is pointed at the expected domain and
// whether the current queue surface has obvious hazards before an apply run.

const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const { getSharedConfig } = require("../packages/shared-config/src");
const { CxDialQueue } = require("../packages/shared-models/src");
const {
  isCxMorningQueueBuilderEnabled,
  readCxMorningQueueBuilderOptionsFromEnv,
  runCxMorningQueueBuilder,
} = require("../packages/shared-services/src/cxMorningQueueBuilderService");

const ACTIVE_STATES = Object.freeze(["queued", "ready", "claimed", "serving", "paused"]);
const FLOOR_FAMILIES = Object.freeze(["fresh-day1", "fresh-day2to10", "fresh-day16to30", "aged"]);

function tokenForEmail(email) {
  return String(email || "").trim().toUpperCase().replace(/@/g, "_AT_").replace(/[^A-Z0-9]/g, "_");
}

function routeForEmail(email) {
  const token = tokenForEmail(email);
  const campaignId = process.env[`RINGCX_AGENT_ROUTE_${token}_CAMPAIGN_ID`];
  const dialGroupId = process.env[`RINGCX_AGENT_ROUTE_${token}_DIAL_GROUP_ID`];
  return {
    accountId: String(process.env.RINGCX_ACCOUNT_ID || "50810001"),
    campaignId: campaignId ? String(campaignId) : null,
    dialGroupId: dialGroupId ? String(dialGroupId) : null,
  };
}

function inc(map, key) {
  const clean = String(key || "(blank)");
  map[clean] = (map[clean] || 0) + 1;
}

function hasPublishStamp(row = {}) {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return Boolean(
    meta.rcxVisibilityExternId
      || meta.lastRingcxPublishedExternId
      || meta.rcxVisibilityCampaignId
      || meta.lastRingcxPublishedCampaignId,
  );
}

function isLaneRow(row = {}) {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return Boolean(
    meta.firstTouchPending
      || meta.firstTouchDispatch
      || meta.firstTouchAssignment
      || meta.appointmentPending
      || meta.appointmentId,
  );
}

function classifyAgentRows(rows = [], route = {}) {
  const counts = {
    total: rows.length,
    byState: {},
    byFamily: {},
    published: 0,
    laneOwned: 0,
    missingRoute: 0,
    routeMismatch: 0,
    nonFloorFamily: 0,
  };
  const samples = {
    routeMismatch: [],
    missingRoute: [],
    laneOwned: [],
    nonFloorFamily: [],
  };

  for (const row of rows) {
    inc(counts.byState, row.state);
    inc(counts.byFamily, row.queueFamily);
    if (hasPublishStamp(row)) counts.published += 1;
    if (isLaneRow(row)) {
      counts.laneOwned += 1;
      if (samples.laneOwned.length < 3) samples.laneOwned.push(sampleRow(row));
    }
    if (!FLOOR_FAMILIES.includes(String(row.queueFamily || "")) && row.queueFamily !== "pilot") {
      counts.nonFloorFamily += 1;
      if (samples.nonFloorFamily.length < 3) samples.nonFloorFamily.push(sampleRow(row));
    }
    const missingRoute = !row.rcxCampaignId || !row.rcxDialGroupId;
    if (missingRoute) {
      counts.missingRoute += 1;
      if (samples.missingRoute.length < 3) samples.missingRoute.push(sampleRow(row));
    }
    const routeMismatch = !isLaneRow(row)
      && row.rcxCampaignId
      && route.campaignId
      && String(row.rcxCampaignId) !== String(route.campaignId);
    const dialGroupMismatch = !isLaneRow(row)
      && row.rcxDialGroupId
      && route.dialGroupId
      && String(row.rcxDialGroupId) !== String(route.dialGroupId);
    if (routeMismatch || dialGroupMismatch) {
      counts.routeMismatch += 1;
      if (samples.routeMismatch.length < 3) samples.routeMismatch.push(sampleRow(row));
    }
  }

  return { counts, samples };
}

function sampleRow(row = {}) {
  return {
    id: String(row._id || ""),
    caseId: row.caseId,
    state: row.state,
    family: row.queueFamily,
    campaignId: row.rcxCampaignId || null,
    dialGroupId: row.rcxDialGroupId || null,
    rank: row.queueFamilyRank ?? null,
    placedCalls: row.placedCalls ?? null,
  };
}

async function duplicateActiveCaseSummary(domain) {
  const [countRow] = await CxDialQueue.aggregate([
    { $match: { domain, state: { $in: ACTIVE_STATES } } },
    { $group: { _id: { domain: "$domain", caseId: "$caseId" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $count: "duplicates" },
  ]);
  const samples = await CxDialQueue.aggregate([
    { $match: { domain, state: { $in: ACTIVE_STATES } } },
    {
      $group: {
        _id: { domain: "$domain", caseId: "$caseId" },
        n: { $sum: 1 },
        states: { $addToSet: "$state" },
        families: { $addToSet: "$queueFamily" },
      },
    },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 10 },
  ]);
  return {
    count: Number(countRow?.duplicates || 0),
    samples: samples.map((row) => ({
      caseId: row._id.caseId,
      count: row.n,
      states: row.states,
      families: row.families,
    })),
  };
}

async function readySupplySummary(domain) {
  const now = new Date();
  const rows = await CxDialQueue.aggregate([
    {
      $match: {
        domain,
        state: "ready",
        releaseAt: { $lte: now },
        queueFamily: { $in: FLOOR_FAMILIES },
        "metadata.firstTouchPending": { $ne: true },
        "metadata.appointmentPending": { $in: [null, false] },
        $or: [
          { "assignment.extensionId": { $exists: false } },
          { "assignment.extensionId": null },
          { "assignment.extensionId": "" },
        ],
      },
    },
    {
      $group: {
        _id: {
          family: "$queueFamily",
          campaignId: "$rcxCampaignId",
          dialGroupId: "$rcxDialGroupId",
        },
        n: { $sum: 1 },
      },
    },
    { $sort: { "_id.family": 1, n: -1 } },
  ]);
  return rows.map((row) => ({
    family: row._id.family,
    campaignId: row._id.campaignId || null,
    dialGroupId: row._id.dialGroupId || null,
    count: row.n,
  }));
}

async function main() {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });

  const envOptions = readCxMorningQueueBuilderOptionsFromEnv(process.env, null);
  const dryRun = await runCxMorningQueueBuilder({
    ...envOptions,
    apply: false,
    confirmAll: false,
    logger: null,
  });
  const domain = envOptions.domain || "WYNN";
  const agentResults = [];

  for (const agentRow of dryRun.agents) {
    const email = String(agentRow.agent?.email || "").trim().toLowerCase();
    const extensionId = String(agentRow.agent?.extensionId || "").trim();
    const route = routeForEmail(email);
    const rows = await CxDialQueue.find({
      domain,
      state: { $in: ACTIVE_STATES },
      "assignment.extensionId": extensionId,
    })
      .select({
        caseId: 1,
        state: 1,
        queueFamily: 1,
        queueFamilyRank: 1,
        placedCalls: 1,
        rcxCampaignId: 1,
        rcxDialGroupId: 1,
        metadata: 1,
      })
      .lean();
    const classified = classifyAgentRows(rows, route);
    agentResults.push({
      email,
      extensionId,
      domain,
      route,
      dryRunDrainCandidates: Number(agentRow.drain?.candidates || 0),
      dryRunMirrorAttempted: agentRow.mirror ? Number(agentRow.mirror.attempted || 0) : null,
      ...classified,
    });
  }

  const duplicateActiveCases = await duplicateActiveCaseSummary(domain);
  const readySupply = await readySupplySummary(domain);
  const hazards = {
    duplicateActiveCases: duplicateActiveCases.count,
    routeMismatches: agentResults.reduce((sum, row) => sum + row.counts.routeMismatch, 0),
    missingRoute: agentResults.reduce((sum, row) => sum + row.counts.missingRoute, 0),
    laneOwnedAssigned: agentResults.reduce((sum, row) => sum + row.counts.laneOwned, 0),
    nonFloorFamilyAssigned: agentResults.reduce((sum, row) => sum + row.counts.nonFloorFamily, 0),
  };

  const report = {
    ok: Object.values(hazards).every((value) => Number(value || 0) === 0),
    enabledFromEnv: isCxMorningQueueBuilderEnabled(process.env),
    envOptions: {
      limit: envOptions.limit,
      build: envOptions.build,
      drain: envOptions.drain,
      mirror: envOptions.mirror,
      companies: envOptions.companies,
      domain: envOptions.domain,
      maxAgents: envOptions.maxAgents,
      agentEmails: envOptions.agentEmails || [],
      extensionIds: envOptions.extensionIds || [],
      allowBroadDiscovery: envOptions.allowBroadDiscovery === true,
    },
    dryRunTotals: dryRun.totals,
    targetAgentCount: dryRun.agents.length,
    hazards,
    duplicateActiveCaseSamples: duplicateActiveCases.samples,
    readySupply,
    agents: agentResults,
    note: "Read-only audit. Morning builder dry-run still does not simulate queue creation; it inspects drain/mirror surface and current assigned/supply shape.",
  };

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(`cx morning queue scale audit failed: ${error.message}`);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore cleanup errors
  }
  process.exit(1);
});
