#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const {
  AgentState,
  CxDialQueue,
  UserAccount,
} = require("../packages/shared-models/src");

const QUEUE_SORT = Object.freeze({
  queueFamilyRank: 1,
  dailyPlacedCalls: 1,
  progressiveStageIndex: 1,
  lastPlacedAt: 1,
  priorityScore: -1,
  releaseAt: 1,
  createdAt: 1,
});

const DEFAULT_AGENTS = [
  "cbolt@taxadvocategroup.com",
  "bhansen@taxadvocategroup.com",
  "slucas@taxadvocategroup.com",
  "polson@taxadvocategroup.com",
  "ballen@taxadvocategroup.com",
];

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function str(value) {
  return String(value == null ? "" : value).trim();
}

function lower(value) {
  return str(value).toLowerCase();
}

function upper(value) {
  return str(value).toUpperCase();
}

function splitArg(value) {
  return str(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function queueItemKey(value = {}) {
  return str(value.queueItemId || value.cxQueueRecordId || value._id || value.id);
}

function eventKey(value = {}) {
  return [
    str(value.uii),
    str(value.externalId || value.externId),
    queueItemKey(value),
    str(value.caseId),
  ].join("|");
}

function safeQueueItem(source, item = {}) {
  const id = queueItemKey(item);
  if (!id && !item.caseId && !item.externalId && !item.externId) return null;
  return {
    source,
    queueItemId: id || null,
    externalId: str(item.externalId || item.externId || item.ringcx?.externId) || null,
    domain: upper(item.domain) || null,
    caseId: item.caseId != null ? Number(item.caseId) : null,
    displayName: str(item.displayName || item.name || item.prospectName) || null,
    campaignId: str(item.campaignId || item.rcxCampaignId || item.ringcx?.campaignId) || null,
    dialGroupId: str(item.dialGroupId || item.rcxDialGroupId || item.ringcx?.dialGroupId) || null,
    queueFamily: str(item.queueFamily || item.assignment?.queueFamilySnapshot) || null,
    phase: item.phase || item.status || null,
    uii: str(item.uii || item.rcxUii || item.callUii) || null,
    seenAt: toIso(item.seenAt || item.firstSeenAt || item.updatedAt || item.createdAt),
  };
}

function uniqueByQueueItem(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = queueItemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function compactCounts(items = []) {
  const byFamily = {};
  for (const item of items) {
    const family = item.queueFamily || "unknown";
    byFamily[family] = (byFamily[family] || 0) + 1;
  }
  return byFamily;
}

function normalizeBucketQueue(agentState = {}) {
  const buckets = agentState.cxCallBuckets && typeof agentState.cxCallBuckets === "object"
    ? agentState.cxCallBuckets
    : {};
  return uniqueByQueueItem(asArray(buckets.newCalls).map((item) => safeQueueItem("bucket.newCalls", item)).filter(Boolean));
}

function normalizeCurrent(agentState = {}) {
  const buckets = agentState.cxCallBuckets && typeof agentState.cxCallBuckets === "object"
    ? agentState.cxCallBuckets
    : {};
  const bucketCurrent = safeQueueItem("bucket.currentCall", buckets.currentCall || {});
  if (bucketCurrent && (bucketCurrent.uii || bucketCurrent.queueItemId)) return bucketCurrent;
  const cxCall = agentState.cxCall && typeof agentState.cxCall === "object"
    ? safeQueueItem("agentstate.cxCall", {
        ...agentState.cxCall,
        externalId: agentState.cxCall.externalId || agentState.cxCall.externId,
        displayName: agentState.cxCall.displayName || agentState.cxCall.name,
      })
    : null;
  if (cxCall && (cxCall.uii || cxCall.queueItemId || cxCall.phase === "active")) return cxCall;
  return null;
}

function normalizeCompletions(agentState = {}) {
  const buckets = agentState.cxCallBuckets && typeof agentState.cxCallBuckets === "object"
    ? agentState.cxCallBuckets
    : {};
  return asArray(buckets.completionBuffer)
    .map((item) => safeQueueItem("bucket.completionBuffer", item))
    .filter(Boolean);
}

function removeFromQueue(queue = [], item = null) {
  const key = queueItemKey(item || {});
  if (!key) return { next: queue, removed: null };
  const index = queue.findIndex((candidate) => queueItemKey(candidate) === key);
  if (index < 0) return { next: queue, removed: null };
  const next = queue.slice();
  const [removed] = next.splice(index, 1);
  return { next, removed };
}

async function resolveAgents(tokens = []) {
  const wanted = tokens.length ? tokens : DEFAULT_AGENTS;
  const accounts = await UserAccount.find({ email: { $in: wanted.map(lower) } }).lean();
  const byEmail = new Map(accounts.map((account) => [lower(account.email), account]));
  const stateQuery = {
    $or: [
      { "appPresence.userEmail": { $in: wanted.map(lower) } },
      { extensionId: { $in: accounts.map((account) => account.extensionId).filter(Boolean) } },
      { cxAgentId: { $in: accounts.map((account) => account.cxAgentId).filter(Boolean) } },
      { name: { $in: wanted.map((token) => new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")) } },
    ],
  };
  const states = await AgentState.find(stateQuery).sort({ "appPresence.lastSeenAt": -1, updatedAt: -1 }).lean();
  const byExtension = new Map(states.filter((state) => state.extensionId).map((state) => [str(state.extensionId), state]));
  return wanted.map((token) => {
    const account = byEmail.get(lower(token)) || accounts.find((a) => str(a.extensionId) === token || str(a.cxAgentId) === token) || null;
    const state = account?.extensionId
      ? byExtension.get(str(account.extensionId))
      : states.find((s) => lower(s.appPresence?.userEmail) === lower(token) || lower(s.name).includes(lower(token)));
    return {
      email: lower(account?.email || state?.appPresence?.userEmail || token),
      name: str(account?.name || state?.name || token),
      extensionId: str(account?.extensionId || state?.extensionId),
      cxAgentId: str(account?.cxAgentId || state?.cxAgentId),
    };
  }).filter((agent) => agent.extensionId || agent.cxAgentId || agent.email);
}

async function loadAgentState(agent) {
  const query = agent.extensionId
    ? { extensionId: agent.extensionId }
    : { "appPresence.userEmail": agent.email };
  return AgentState.findOne(query).lean();
}

function domainsFrom(items = [], fallback = "TAG") {
  const domains = Array.from(new Set(items.map((item) => upper(item.domain)).filter(Boolean)));
  return domains.length ? domains : [upper(fallback) || "TAG"];
}

async function readWouldRefillRows({ domains, excludeIds, limit }) {
  const query = {
    state: "ready",
    domain: { $in: domains },
    releaseAt: { $lte: new Date() },
  };
  if (excludeIds.size) {
    query._id = { $nin: Array.from(excludeIds).filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id)) };
  }
  const rows = await CxDialQueue.find(query).sort(QUEUE_SORT).limit(limit).lean();
  return rows.map((row) => safeQueueItem("would-refill.ready-pool", row)).filter(Boolean);
}

function appendJsonl(file, rows = []) {
  if (!file || !rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function summarizeAgent(agent, state, shadow) {
  const actualQueue = normalizeBucketQueue(state || {});
  const current = normalizeCurrent(state || {});
  const completions = normalizeCompletions(state || {});
  return {
    agent,
    actual: {
      queueCount: actualQueue.length,
      current: current ? {
        queueItemId: current.queueItemId,
        caseId: current.caseId,
        phase: current.phase,
        uii: current.uii || null,
      } : null,
      completionCount: completions.length,
      bucketUpdatedAt: toIso(state?.cxCallBuckets?.updatedAt),
    },
    shadow: {
      queueCount: shadow.queue.length,
      consumedCount: shadow.consumedIds.size,
      refillCount: shadow.refillCount,
      families: compactCounts(shadow.queue),
    },
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
  const dbName = process.env.PARALLEL_DB_NAME || process.env.MONGO_DB_NAME || process.env.DB_NAME || "tagcontactbridge";
  if (!mongoUri) throw new Error("Missing MONGO_URI");

  const agentTokens = splitArg(argValue("agents"));
  const durationSec = Math.max(Number(argValue("durationSec", "3600")) || 3600, 1);
  const intervalMs = Math.max(Number(argValue("intervalMs", "1000")) || 1000, 500);
  const threshold = Math.max(Number(argValue("threshold", "5")) || 5, 1);
  const refillSize = Math.max(Number(argValue("refillSize", "30")) || 30, 1);
  const once = hasFlag("once");
  const json = hasFlag("json");
  const out = argValue("out", path.resolve(__dirname, "..", "runtime", "cx-floor-shadow", `queue-shadow-${Date.now()}.jsonl`));
  const defaultDomain = upper(argValue("domain", "TAG")) || "TAG";

  await mongoose.connect(mongoUri, { dbName });
  const agents = await resolveAgents(agentTokens);
  const shadows = new Map();
  const started = Date.now();
  const ticks = once ? 1 : Math.ceil((durationSec * 1000) / intervalMs);
  const allEvents = [];

  for (let tick = 0; tick < ticks; tick += 1) {
    const at = new Date().toISOString();
    const events = [];
    const snapshots = [];
    for (const agent of agents) {
      const key = agent.email || agent.extensionId || agent.name;
      const state = await loadAgentState(agent);
      const actualQueue = normalizeBucketQueue(state || {});
      const actualById = new Set(actualQueue.map(queueItemKey).filter(Boolean));
      const current = normalizeCurrent(state || {});
      const completions = normalizeCompletions(state || {});
      const completionKeys = new Set(completions.map(eventKey));
      let shadow = shadows.get(key);
      let justInitialized = false;
      if (!shadow) {
        shadow = {
          queue: actualQueue.slice(),
          actualIds: actualById,
          completionKeys: new Set(completionKeys),
          consumedIds: new Set(),
          refillCount: 0,
          lowWaterSince: null,
          lastRefillAtCount: null,
        };
        justInitialized = true;
        shadows.set(key, shadow);
        events.push({
          type: "shadow-initialized",
          at,
          agent,
          queueCount: shadow.queue.length,
          families: compactCounts(shadow.queue),
        });
      }

      const previousActualIds = shadow.actualIds || new Set();
      const addedActual = actualQueue.filter((item) => !previousActualIds.has(queueItemKey(item)));
      const removedActual = Array.from(previousActualIds).filter((id) => !actualById.has(id));
      if (addedActual.length || removedActual.length) {
        events.push({
          type: "actual-queue-changed",
          at,
          agent,
          addedCount: addedActual.length,
          removedCount: removedActual.length,
          actualQueueCount: actualQueue.length,
          added: addedActual.slice(0, 8).map((item) => ({ queueItemId: item.queueItemId, caseId: item.caseId, name: item.displayName })),
          removed: removedActual.slice(0, 8),
        });
      }
      shadow.actualIds = actualById;

      if (current && queueItemKey(current) && !shadow.consumedIds.has(queueItemKey(current))) {
        const result = removeFromQueue(shadow.queue, current);
        shadow.queue = result.next;
        shadow.consumedIds.add(queueItemKey(current));
        const ckey = eventKey(current);
        if (ckey) shadow.completionKeys.add(ckey);
        if (result.removed || !justInitialized) {
          events.push({
            type: result.removed ? "shadow-consumed-current" : "current-not-in-shadow-queue",
            at,
            agent,
            current: {
              queueItemId: current.queueItemId,
              caseId: current.caseId,
              name: current.displayName,
              phase: current.phase,
              uii: current.uii || null,
            },
            shadowQueueCount: shadow.queue.length,
          });
        }
      }

      for (const completion of completions) {
        const ckey = eventKey(completion);
        if (!ckey || shadow.completionKeys.has(ckey)) continue;
        shadow.completionKeys.add(ckey);
        const result = removeFromQueue(shadow.queue, completion);
        if (result.removed) shadow.queue = result.next;
        events.push({
          type: result.removed ? "shadow-consumed-completion" : "completion-not-in-shadow-queue",
          at,
          agent,
          completion: {
            queueItemId: completion.queueItemId,
            caseId: completion.caseId,
            name: completion.displayName,
            phase: completion.phase,
            uii: completion.uii || null,
          },
          shadowQueueCount: shadow.queue.length,
        });
      }

      if (actualQueue.length <= threshold) {
        shadow.lowWaterSince = shadow.lowWaterSince || at;
        events.push({
          type: "actual-low-water",
          at,
          agent,
          actualQueueCount: actualQueue.length,
          lowWaterSince: shadow.lowWaterSince,
        });
      } else {
        shadow.lowWaterSince = null;
      }

      if (shadow.queue.length <= threshold && shadow.lastRefillAtCount !== shadow.queue.length) {
        const excludeIds = new Set([
          ...shadow.queue.map(queueItemKey).filter(Boolean),
          ...shadow.consumedIds,
          ...actualQueue.map(queueItemKey).filter(Boolean),
        ]);
        const domains = domainsFrom([...actualQueue, ...shadow.queue, current].filter(Boolean), defaultDomain);
        const refillRows = await readWouldRefillRows({ domains, excludeIds, limit: refillSize });
        shadow.lastRefillAtCount = shadow.queue.length;
        if (refillRows.length) {
          shadow.queue = uniqueByQueueItem([...shadow.queue, ...refillRows]);
          shadow.refillCount += 1;
        }
        events.push({
          type: refillRows.length ? "shadow-refill-simulated" : "shadow-refill-empty",
          at,
          agent,
          domains,
          requested: refillSize,
          accepted: refillRows.length,
          shadowQueueCount: shadow.queue.length,
          families: compactCounts(refillRows),
          firstRows: refillRows.slice(0, 10).map((item) => ({
            queueItemId: item.queueItemId,
            caseId: item.caseId,
            family: item.queueFamily,
          })),
        });
      }

      snapshots.push(summarizeAgent(agent, state, shadow));
    }

    const payload = {
      type: "snapshot",
      at,
      tick,
      threshold,
      refillSize,
      agents: snapshots,
    };
    appendJsonl(out, [payload, ...events]);
    allEvents.push(...events);
    if (!json) {
      console.log(`[queue-shadow] ${at} tick=${tick} events=${events.length} out=${out}`);
      for (const row of snapshots) {
        console.log(`  ${row.agent.name}: actual=${row.actual.queueCount} shadow=${row.shadow.queueCount} current=${row.actual.current?.queueItemId || "none"}`);
      }
    }
    if (once || tick === ticks - 1) break;
    const elapsed = Date.now() - started;
    await sleep(Math.max(((tick + 1) * intervalMs) - elapsed, 0));
  }

  const summary = {
    mode: "read-only-queue-shadow",
    agents,
    ticks: once ? 1 : ticks,
    outputJsonl: out,
    eventCounts: allEvents.reduce((acc, event) => {
      acc[event.type] = (acc[event.type] || 0) + 1;
      return acc;
    }, {}),
  };
  if (json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`[queue-shadow] complete ${JSON.stringify(summary.eventCounts)} jsonl=${out}`);

  await mongoose.disconnect();
}

main().catch(async (error) => {
  try { await mongoose.disconnect(); } catch {}
  console.error("[queue-shadow] failed:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
