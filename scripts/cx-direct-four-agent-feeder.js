#!/usr/bin/env node
"use strict";

// Temporary floor rail: LeadCadence -> four agent-owned RingCX campaigns.
// It deliberately bypasses CxDialQueue, sessions, presence, and the web app.
// Dry-run is the default. Nothing reaches RingCX without --apply.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
// This operational script reports aggregate counts itself. Do not let the shared
// alpha tracer print thousands of extern IDs at the transport boundary.
process.env.CX_ALPHA_TRACE_ENABLED = "false";

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { createRingcxVoiceClient } = require("../packages/shared-integrations/src");
const { CaseProfile, LeadCadence } = require("../packages/shared-models/src");
const { buildBlockedReason, resolveCaseContactEligibility } = require("../packages/shared-services/src/contactEligibilityService");
const { publishBatchToRingcx } = require("../packages/shared-services/src/cxBulkLoadRingcxPublisher");
const { parseAgentQueueMap } = require("../packages/shared-services/src/cxLaneRegistry");

const AGENTS = Object.freeze([
  { key: "chris", email: "cbolt@taxadvocategroup.com" },
  { key: "brad", email: "bhansen@taxadvocategroup.com" },
  { key: "sean", email: "slucas@taxadvocategroup.com" },
  { key: "phil", email: "polson@taxadvocategroup.com" },
]);
const NON_DIALABLE_STAGE = /\b(dnc|do not call|post\s*date|post-date|sold|deal|bad inactive|inactive)\b/i;
const FEED_VERSION = "direct-four-v1";
const LOCK_MS = 25 * 60 * 1000;
const STALE_PUBLISH_MS = 30 * 60 * 1000;

function value(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const inline = argv.find((entry) => entry.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const mode = String(value(argv, "--mode", "initial")).toLowerCase();
  if (!new Set(["initial", "incremental", "resume"]).has(mode)) throw new Error("--mode must be initial, incremental, or resume");
  return {
    apply: argv.includes("--apply"),
    mode,
    domain: String(value(argv, "--domain", "WYNN")).toUpperCase(),
    perAgent: Math.max(1, Number(value(argv, "--per-agent", mode === "initial" ? 1000 : 1000)) || 1000),
    batchSize: Math.min(1000, Math.max(1, Number(value(argv, "--batch-size", 250)) || 250)),
    maxScan: Math.max(100, Number(value(argv, "--max-scan", mode === "initial" ? 50000 : 10000)) || 50000),
  };
}

function routeToken(email) {
  return String(email).toUpperCase().replace(/@/g, "_AT_").replace(/[^A-Z0-9]/g, "_");
}

function resolveRoutes(env = process.env, mode = "initial") {
  const firstContactByEmail = new Map(
    parseAgentQueueMap(env.CX_FIRST_TOUCH_QUEUE_MAP).map((row) => [row.agentEmail, row.campaignId]),
  );
  return AGENTS.map((agent) => {
    const token = routeToken(agent.email);
    const campaignId = String(env[`RINGCX_AGENT_ROUTE_${token}_CAMPAIGN_ID`] || "").trim();
    const dialGroupId = String(env[`RINGCX_AGENT_ROUTE_${token}_DIAL_GROUP_ID`] || "").trim();
    if (!campaignId || !dialGroupId) throw new Error(`Missing RingCX campaign/dial-group route for ${agent.key}`);
    if (mode === "incremental") {
      const firstContactCampaignId = String(firstContactByEmail.get(agent.email) || "").trim();
      if (!firstContactCampaignId) throw new Error(`Missing First Contact campaign route for ${agent.key}`);
      return { ...agent, campaignId: firstContactCampaignId, dialGroupId, lane: "first-contact" };
    }
    return { ...agent, campaignId, dialGroupId, lane: "bulk" };
  });
}

function blockedCadence(doc) {
  if (!doc || doc.active === false) return true;
  if (NON_DIALABLE_STAGE.test(String(doc.currentStage || ""))) return true;
  return Boolean(doc.cadenceState?.channelDnc?.cx?.blocked || doc.dncCheckpoints?.hit);
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : "";
}

function externId(domain, caseId) {
  return `cx-direct-${String(domain).toLowerCase()}-${Number(caseId)}`;
}

function distributeRoundRobin(rows, routes = AGENTS) {
  const groups = routes.map((route) => ({ route, rows: [] }));
  rows.forEach((row, index) => groups[index % groups.length].rows.push(row));
  return groups;
}

function selectionQuery(domain, mode, cutoff) {
  const query = {
    domain,
    active: true,
    "cadenceState.channelDnc.cx.blocked": { $ne: true },
    "dncCheckpoints.hit": { $ne: true },
  };
  if (mode === "incremental") query.createdAt = { $gt: cutoff };
  if (mode === "resume") query.createdAt = { $lte: cutoff };
  return query;
}

async function acquireLock(control, now) {
  const lockUntil = new Date(now.getTime() + LOCK_MS);
  const result = await control.findOneAndUpdate(
    { _id: `${FEED_VERSION}:lock`, $or: [{ lockUntil: { $lte: now } }, { lockUntil: { $exists: false } }] },
    { $set: { lockUntil, lockedAt: now } },
    { upsert: true, returnDocument: "after" },
  ).catch((error) => {
    if (error?.code === 11000) return null;
    throw error;
  });
  if (!result) throw new Error("Another direct feeder run owns the lock");
}

async function releaseLock(control) {
  await control.updateOne({ _id: `${FEED_VERSION}:lock` }, { $set: { lockUntil: new Date(0) } });
}

function claimable(existing, now) {
  if (!existing) return true;
  if (existing.status === "failed") return true;
  return existing.status === "publishing"
    && (!existing.publishingAt || new Date(existing.publishingAt).getTime() <= now.getTime() - STALE_PUBLISH_MS);
}

async function findInChunks(collection, field, values, projection = {}) {
  const rows = [];
  for (let start = 0; start < values.length; start += 5000) {
    const batch = values.slice(start, start + 5000);
    rows.push(...await collection.find({ [field]: { $in: batch } }, { projection }).toArray());
  }
  return rows;
}

async function selectEligible({ options, cutoff, feed }) {
  const target = (options.perAgent + (options.mode === "resume" ? 10 : 0)) * AGENTS.length;
  const rows = [];
  const skips = {};
  const now = new Date();
  const docs = await LeadCadence.find(selectionQuery(options.domain, options.mode, cutoff))
    .sort({ createdAt: -1, _id: -1 })
    .limit(options.maxScan)
    .lean()
    .exec();
  const caseIds = docs.map((doc) => Number(doc.caseId)).filter(Number.isFinite);
  const feedIds = caseIds.map((caseId) => `${options.domain}:${caseId}`);
  const [feedRows, profiles] = await Promise.all([
    findInChunks(feed, "_id", feedIds, { status: 1, publishingAt: 1 }),
    findInChunks(
      mongoose.connection.db.collection(CaseProfile.collection.name),
      "caseId",
      caseIds,
      {
        domain: 1, caseId: 1, statusId: 1, statusCategory: 1, scrubSummary: 1,
        conversationAi: 1, aiActivityReview: 1, aiCaseReview: 1, convertedAt: 1,
        firstPaymentDate: 1, paymentsCount: 1, totalPaid: 1,
      },
    ),
  ]);
  const feedById = new Map(feedRows.map((row) => [row._id, row]));
  const profileByCase = new Map(
    profiles.filter((row) => String(row.domain || "").toUpperCase() === options.domain)
      .map((row) => [Number(row.caseId), row]),
  );
  const sharedConfig = getSharedConfig(options.domain);

  for (const doc of docs) {
    if (rows.length >= target) break;
    const caseId = Number(doc.caseId);
    const phone = normalizePhone(doc.primaryPhone || doc.normalizedPhone);
    const name = String(doc.name || [doc.firstName, doc.lastName].filter(Boolean).join(" ")).trim();
    let reason = null;
    if (!Number.isFinite(caseId)) reason = "invalid-case";
    else if (blockedCadence(doc)) reason = "blocked-cadence";
    else if (!phone || !name) reason = "missing-contact";
    else if (options.mode !== "resume" && !claimable(feedById.get(`${options.domain}:${caseId}`), now)) reason = "already-fed";
    if (reason) {
      skips[reason] = (skips[reason] || 0) + 1;
      continue;
    }
    const block = buildBlockedReason(profileByCase.get(caseId) || null, doc, sharedConfig, now);
    if (block) {
      reason = block.reason || "eligibility-failed";
      skips[reason] = (skips[reason] || 0) + 1;
      continue;
    }
    if (options.mode === "incremental") {
      const fresh = await resolveCaseContactEligibility(options.domain, caseId, {
        now,
        requireFreshLogicsStatus: true,
        enforceStop: false,
        sourceService: "cx-direct-four-agent-feeder",
      });
      if (!fresh?.ok) {
        reason = `fresh-${fresh?.reason || "logics-check-failed"}`;
        skips[reason] = (skips[reason] || 0) + 1;
        continue;
      }
    }
    rows.push({
      feedId: `${options.domain}:${caseId}`,
      queueItemId: String(doc._id),
      domain: options.domain,
      caseId,
      name,
      phone,
      externId: externId(options.domain, caseId),
      createdAt: doc.createdAt || null,
    });
  }
  return { rows, scanned: docs.length, skips };
}

async function guardLogicsBetweenPasses({ client, feed, apply, domain = "WYNN", now = new Date() }) {
  const open = await feed.find({ status: "accepted" }, { projection: { campaignId: 1, externId: 1 } }).toArray();
  const byCampaign = new Map();
  for (const row of open) {
    const campaignId = String(row.campaignId || "").trim();
    if (!campaignId || !row.externId) continue;
    if (!byCampaign.has(campaignId)) byCampaign.set(campaignId, []);
    byCampaign.get(campaignId).push(row);
  }
  const retryCandidates = [];
  for (const [campaignId, docs] of byCampaign) {
    for (let start = 0; start < docs.length; start += 250) {
      const batch = docs.slice(start, start + 250);
      const cid = Number(campaignId) || campaignId;
      const response = await client.searchLeads({
        campaignId: cid, campaignIds: [cid], externIds: batch.map((row) => row.externId),
        listIds: [], agentDispositions: [], systemDispositions: [], leadStates: [],
        physicalStates: [], leadTimezones: [], suppressed: "ALL",
      });
      const known = new Map(rowsFromSearch(response).map((row) => [String(row.externId || row.externalId || "").trim(), row]));
      for (const doc of batch) {
        const row = known.get(doc.externId);
        const state = String(row?.leadState || row?.state || "").trim().toUpperCase();
        const passes = Number(row?.leadPasses || 0);
        if (passes >= 1 && ["READY", "PENDING"].includes(state)) retryCandidates.push({ doc, campaignId, passes });
      }
    }
  }

  const blocked = [];
  let verifiedCallable = 0;
  let transientFailures = 0;
  for (const candidate of retryCandidates) {
    const caseId = Number(String(candidate.doc._id).split(":").pop());
    const eligibility = await resolveCaseContactEligibility(domain, caseId, {
      now,
      requireFreshLogicsStatus: true,
      enforceStop: false,
      sourceService: "cx-direct-logics-between-pass-guard",
    });
    if (eligibility?.ok) verifiedCallable += 1;
    else if (eligibility?.transient) transientFailures += 1;
    else blocked.push({ ...candidate, caseId, reason: eligibility?.reason || "not-contactable" });
  }

  let cancelled = 0;
  if (apply) {
    for (const [campaignId, rows] of [...new Map(blocked.map((row) => [row.campaignId, blocked.filter((x) => x.campaignId === row.campaignId)]))]) {
      const cid = Number(campaignId) || campaignId;
      const response = await client.leadAction("CANCEL_LEADS", {
        campaignLeadSearchCriteria: { campaignId: cid, campaignIds: [cid], externIds: rows.map((row) => row.doc.externId) },
        leadActionParams: {},
      });
      if (response === false) throw new Error("RingCX rejected a confirmed Logics-block cancellation");
      await feed.updateMany(
        { _id: { $in: rows.map((row) => row.doc._id) }, status: "accepted" },
        { $set: { status: "cancelled", cancelledAt: now, cancelReason: "fresh-logics-noncontactable", updatedAt: now } },
      );
      cancelled += rows.length;
    }
  }
  return { open: open.length, retryCandidates: retryCandidates.length, verifiedCallable, confirmedBlocked: blocked.length, transientFailures, cancelled };
}

async function markPublishing(feed, rows, route, runId, now) {
  for (const row of rows) {
    await feed.updateOne(
      { _id: row.feedId },
      { $set: { status: "publishing", agent: route.key, campaignId: route.campaignId, lane: route.lane, externId: row.externId, runId, publishingAt: now, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
  }
}

async function publishGroup({ client, feed, group, options, runId }) {
  let accepted = 0;
  let rejected = 0;
  for (let start = 0; start < group.rows.length; start += options.batchSize) {
    const batch = group.rows.slice(start, start + options.batchSize);
    const now = new Date();
    await markPublishing(feed, batch, group.route, runId, now);
    try {
      const result = await publishBatchToRingcx(client, {
        campaignId: group.route.campaignId,
        dialPriority: "NORMAL",
        candidates: batch,
      });
      const acceptedIds = new Set(result.accepted.map((row) => row.externId));
      const ops = batch.map((row) => ({
        updateOne: {
          filter: { _id: row.feedId, runId },
          update: { $set: acceptedIds.has(row.externId)
            ? { status: "accepted", acceptedAt: new Date(), updatedAt: new Date() }
            : { status: "failed", failedAt: new Date(), failure: "ringcx-rejected", updatedAt: new Date() } },
        },
      }));
      if (ops.length) await feed.bulkWrite(ops, { ordered: false });
      accepted += result.accepted.length;
      rejected += result.rejected.length;
    } catch (error) {
      await feed.updateMany(
        { runId, _id: { $in: batch.map((row) => row.feedId) } },
        { $set: { status: "failed", failedAt: new Date(), failure: String(error?.code || "publish-error"), updatedAt: new Date() } },
      );
      throw error;
    }
  }
  return { agent: group.route.key, attempted: group.rows.length, accepted, rejected };
}

function rowsFromSearch(value) {
  if (Array.isArray(value)) return value;
  for (const key of ["leads", "records", "data"]) if (Array.isArray(value?.[key])) return value[key];
  throw new Error("RingCX lead search returned an unexpected response");
}

async function reconcileGroup({ client, feed, group, options, runId }) {
  const feedIds = group.rows.map((row) => row.feedId);
  const existing = await findInChunks(feed, "_id", feedIds, { status: 1, externId: 1, failure: 1 });
  const byId = new Map(existing.map((row) => [row._id, row]));
  let acceptedCount = await feed.countDocuments({ agent: group.route.key, status: "accepted" });
  if (acceptedCount >= options.perAgent) {
    return { agent: group.route.key, alreadyAccepted: acceptedCount, reconciled: 0, suppressed: 0, published: 0, rejected: 0 };
  }
  const unresolved = group.rows.filter((row) => {
    const status = byId.get(row.feedId)?.status;
    return status && status !== "accepted" && status !== "suppressed";
  });
  const found = new Set();
  for (let start = 0; start < unresolved.length; start += 250) {
    const batch = unresolved.slice(start, start + 250);
    if (!batch.length) continue;
    const campaignId = Number(group.route.campaignId) || group.route.campaignId;
    const response = await client.searchLeads({
      campaignId,
      campaignIds: [campaignId],
      externIds: batch.map((row) => row.externId),
      listIds: [], agentDispositions: [], systemDispositions: [], leadStates: [],
      physicalStates: [], leadTimezones: [], suppressed: "ALL",
    });
    for (const row of rowsFromSearch(response)) {
      const id = String(row?.externId || row?.externalId || "").trim();
      if (id) found.add(id);
    }
  }
  const foundRows = unresolved.filter((row) => found.has(row.externId));
  if (foundRows.length) {
    await feed.updateMany(
      { _id: { $in: foundRows.map((row) => row.feedId) } },
      { $set: { status: "accepted", acceptedAt: new Date(), reconciledAt: new Date(), updatedAt: new Date() } },
    );
  }
  acceptedCount += foundRows.length;
  const suppressedRows = unresolved.filter((row) => (
    !found.has(row.externId)
    && byId.get(row.feedId)?.failure === "ringcx-load-partial-unverified"
  ));
  if (suppressedRows.length) {
    await feed.updateMany(
      { _id: { $in: suppressedRows.map((row) => row.feedId) } },
      { $set: { status: "suppressed", suppressedAt: new Date(), suppression: "not-present-after-ambiguous-load", updatedAt: new Date() } },
    );
  }
  const suppressedIds = new Set(suppressedRows.map((row) => row.feedId));
  const need = Math.max(0, options.perAgent - acceptedCount);
  const publishRows = group.rows.filter((row) => {
    const current = byId.get(row.feedId);
    return !found.has(row.externId)
      && !suppressedIds.has(row.feedId)
      && (!current || (current.status !== "accepted" && current.status !== "suppressed"));
  }).slice(0, need);
  const published = publishRows.length
    ? await publishGroup({ client, feed, group: { ...group, rows: publishRows }, options, runId })
    : { agent: group.route.key, attempted: 0, accepted: 0, rejected: 0 };
  return {
    agent: group.route.key,
    alreadyAccepted: acceptedCount - foundRows.length,
    reconciled: foundRows.length,
    suppressed: suppressedRows.length,
    published: published.accepted,
    rejected: published.rejected,
  };
}

async function main() {
  const options = parseArgs();
  const routes = resolveRoutes(process.env, options.mode);
  const config = getSharedConfig(options.domain);
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  const db = mongoose.connection.db;
  const feed = db.collection("cx_direct_four_agent_feed");
  const control = db.collection("cx_direct_four_agent_control");
  if (options.apply) await feed.createIndex({ status: 1, createdAt: 1 });
  const stateId = `${FEED_VERSION}:${options.domain}`;
  const state = await control.findOne({ _id: stateId });
  const now = new Date();
  const cutoff = state?.initialCutoff ? new Date(state.initialCutoff) : now;
  if (options.mode === "incremental" && !state?.initializedAt) throw new Error("Initial feed has not completed; incremental run refused");
  if (options.mode === "resume" && !state?.initialCutoff) throw new Error("No interrupted initial feed exists to resume");

  if (options.apply) await acquireLock(control, now);
  try {
    if (options.apply && options.mode === "initial" && !state?.initialCutoff) {
      await control.updateOne({ _id: stateId }, { $setOnInsert: { initialCutoff: now, createdAt: now } }, { upsert: true });
    }
    const client = options.mode === "incremental" ? createRingcxVoiceClient() : null;
    const logicsGuard = options.mode === "incremental"
      ? await guardLogicsBetweenPasses({ client, feed, apply: options.apply, domain: options.domain, now })
      : null;
    const selected = await selectEligible({ options, cutoff, feed });
    const groups = distributeRoundRobin(selected.rows, routes);
    console.log(JSON.stringify({
      mode: options.mode,
      apply: options.apply,
      domain: options.domain,
      scanned: selected.scanned,
      selected: selected.rows.length,
      skipped: selected.skips,
      logicsGuard,
      agents: groups.map((group) => ({ agent: group.route.key, selected: group.rows.length, routeReady: true })),
    }, null, 2));
    if (!options.apply) return;

    const runId = `${FEED_VERSION}-${Date.now()}`;
    const publishClient = client || createRingcxVoiceClient();
    const results = [];
    for (const group of groups) {
      results.push(options.mode === "resume"
        ? await reconcileGroup({ client: publishClient, feed, group, options, runId })
        : await publishGroup({ client: publishClient, feed, group, options, runId }));
    }
    if (options.mode === "initial" || options.mode === "resume") {
      const persisted = await control.findOne({ _id: stateId });
      const acceptedByAgent = await feed.aggregate([
        { $match: { status: "accepted", agent: { $in: AGENTS.map((agent) => agent.key) } } },
        { $group: { _id: "$agent", count: { $sum: 1 } } },
      ]).toArray();
      const acceptedMap = new Map(acceptedByAgent.map((row) => [row._id, row.count]));
      if (AGENTS.some((agent) => Number(acceptedMap.get(agent.key) || 0) < options.perAgent)) {
        throw new Error("Initial feed remains incomplete after publish/reconciliation");
      }
      await control.updateOne(
        { _id: stateId },
        { $set: { initializedAt: new Date(), initialCutoff: persisted?.initialCutoff || now, updatedAt: new Date() } },
      );
    } else {
      await control.updateOne({ _id: stateId }, { $set: { lastIncrementalAt: new Date(), updatedAt: new Date() } });
    }
    console.log(JSON.stringify({ runId, results }, null, 2));
  } finally {
    if (options.apply) await releaseLock(control);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  }).finally(() => mongoose.disconnect().catch(() => {}));
}

module.exports = { AGENTS, blockedCadence, distributeRoundRobin, externId, guardLogicsBetweenPasses, normalizePhone, parseArgs, resolveRoutes, routeToken, rowsFromSearch, selectionQuery };
