#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const { createRingcxVoiceClient, getRingcxVoiceRateLimitState } = require("../packages/shared-integrations/src");
const {
  AgentState,
  CxBulkLoadSession,
  CxDialQueue,
  CxSlowLaneSession,
  UserAccount,
} = require("../packages/shared-models/src");

const DEFAULT_AGENTS = Object.freeze([
  "cbolt@taxadvocategroup.com",
  "bhansen@taxadvocategroup.com",
  "slucas@taxadvocategroup.com",
  "polson@taxadvocategroup.com",
  "ballen@taxadvocategroup.com",
]);

const QUEUE_SORT = Object.freeze({
  queueFamilyRank: 1,
  dailyPlacedCalls: 1,
  progressiveStageIndex: 1,
  lastPlacedAt: 1,
  priorityScore: -1,
  releaseAt: 1,
  createdAt: 1,
});

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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function splitArg(value) {
  return str(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function last4(value) {
  const digits = str(value).replace(/\D/g, "");
  return digits ? digits.slice(-4) : null;
}

function queueItemKey(value = {}) {
  return str(value.queueItemId || value.cxQueueRecordId || value.queueTicketId || value._id || value.id);
}

function candidateEventKey(value = {}) {
  return [
    str(value.uii || value.rcxUii || value.callUii),
    str(value.externId || value.externalId || value.ringcx?.externId),
    queueItemKey(value),
    str(value.caseId),
  ].join("|");
}

function compactActiveCall(call = {}) {
  return {
    uii: str(call.uii || call.callUii || call.id || call.callId) || null,
    externId: str(call.externId || call.externalId || call.outboundExternid || call.outboundExternalId) || null,
    agentId: str(call.agentId || call.agentLoginId || call.agent?.agentId || call.username) || null,
    username: str(call.username || call.agentEmail || call.agent?.username || call.agent?.email) || null,
    callState: call.callState || call.state || call.status || null,
    phoneLast4: last4(call.dnis || call.ani || call.phone || call.destination || call.leadPhone),
  };
}

function safeCandidate(source, item = {}) {
  if (!item || typeof item !== "object") return null;
  const queueItemId = queueItemKey(item);
  const externId = str(item.externId || item.externalId || item.ringcx?.externId || item.ringcxExternalId);
  const uii = str(item.uii || item.rcxUii || item.callUii);
  const caseId = item.caseId != null ? Number(item.caseId) : null;
  const hasCaseId = Number.isFinite(caseId) && caseId > 0;
  if (!queueItemId && !externId && !uii && !hasCaseId) return null;
  return {
    source,
    queueItemId: queueItemId || null,
    externId: externId || null,
    uii: uii || null,
    domain: upper(item.domain) || null,
    caseId: hasCaseId ? caseId : null,
    name: str(item.displayName || item.name || item.prospectName || item.contactName || item.fromName) || null,
    phoneLast4: last4(item.phone || item.phoneNumber || item.to || item.from),
    queueFamily: str(item.queueFamily || item.assignment?.queueFamilySnapshot) || null,
    phase: item.phase || item.status || item.state || null,
    campaignId: str(item.campaignId || item.rcxCampaignId || item.ringcx?.campaignId) || null,
    dialGroupId: str(item.dialGroupId || item.rcxDialGroupId || item.ringcx?.dialGroupId) || null,
    seenAt: toIso(item.seenAt || item.firstSeenAt || item.updatedAt || item.createdAt),
  };
}

function sameCandidate(left = {}, right = {}) {
  const lq = queueItemKey(left);
  const rq = queueItemKey(right);
  if (lq && rq) return lq === rq;
  const le = lower(left.externId || left.externalId || left.ringcx?.externId);
  const re = lower(right.externId || right.externalId || right.ringcx?.externId);
  if (le && re) return le === re;
  const lu = lower(left.uii || left.rcxUii || left.callUii);
  const ru = lower(right.uii || right.rcxUii || right.callUii);
  if (lu && ru) return lu === ru;
  return false;
}

function removeCandidate(queue = [], candidate = {}) {
  const index = queue.findIndex((item) => sameCandidate(item, candidate));
  if (index < 0) return { next: queue, removed: null };
  const next = queue.slice();
  const [removed] = next.splice(index, 1);
  return { next, removed };
}

function uniqueCandidates(items = []) {
  const out = [];
  for (const item of items) {
    if (!item) continue;
    if (out.some((existing) => sameCandidate(existing, item))) continue;
    out.push(item);
  }
  return out;
}

function familyCounts(items = []) {
  const counts = {};
  for (const item of items) {
    const key = item.queueFamily || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function normalizeBucketQueue(agentState = {}) {
  const buckets = agentState.cxCallBuckets && typeof agentState.cxCallBuckets === "object"
    ? agentState.cxCallBuckets
    : {};
  return uniqueCandidates(asArray(buckets.newCalls).map((item) => safeCandidate("agentstate.cxCallBuckets.newCalls", item)));
}

function normalizeBucketCurrent(agentState = {}) {
  const buckets = agentState.cxCallBuckets && typeof agentState.cxCallBuckets === "object"
    ? agentState.cxCallBuckets
    : {};
  return safeCandidate("agentstate.cxCallBuckets.currentCall", buckets.currentCall || {});
}

function normalizeBucketCompletions(agentState = {}) {
  const buckets = agentState.cxCallBuckets && typeof agentState.cxCallBuckets === "object"
    ? agentState.cxCallBuckets
    : {};
  return asArray(buckets.completionBuffer)
    .map((item) => safeCandidate("agentstate.cxCallBuckets.completionBuffer", item))
    .filter(Boolean);
}

function normalizeAgentCurrent(agentState = {}) {
  const candidates = [
    safeCandidate("agentstate.currentCall", agentState.currentCall || {}),
    safeCandidate("agentstate.cxCall", agentState.cxCall || {}),
    normalizeBucketCurrent(agentState),
  ].filter(Boolean);
  return candidates;
}

function normalizeBulkPending(session = null) {
  return uniqueCandidates(asArray(session?.acceptedBuffer).map((item) => safeCandidate("bulk.acceptedBuffer", item)));
}

function normalizeBulkCurrent(session = null) {
  return safeCandidate("bulk.current", session?.current || {});
}

function normalizeBulkCompletions(session = null) {
  return asArray(session?.completed).map((item) => safeCandidate("bulk.completed", item)).filter(Boolean);
}

function normalizeSlowCurrent(session = null) {
  return safeCandidate("slow.current", session?.current || {});
}

function sourcePending(agentState, bulkSession) {
  return uniqueCandidates([
    ...normalizeBucketQueue(agentState || {}),
    ...normalizeBulkPending(bulkSession || null),
  ]);
}

function sourceCurrentCandidates(agentState, bulkSession, slowSession) {
  return uniqueCandidates([
    ...normalizeAgentCurrent(agentState || {}),
    normalizeBulkCurrent(bulkSession || null),
    normalizeSlowCurrent(slowSession || null),
  ]);
}

function sourceTerminalCandidates(agentState, bulkSession, slowSession) {
  const slowLast = safeCandidate("slow.lastOutcome", slowSession?.lastOutcome || {});
  return uniqueCandidates([
    ...normalizeBucketCompletions(agentState || {}),
    ...normalizeBulkCompletions(bulkSession || null),
    slowLast,
  ]);
}

function domainsFrom(items = [], fallback = "TAG") {
  const domains = Array.from(new Set(items.map((item) => upper(item?.domain)).filter(Boolean)));
  return domains.length ? domains : [upper(fallback) || "TAG"];
}

function agentKey(agent = {}) {
  return lower(agent.email || agent.extensionId || agent.name);
}

function callMatchesAgentIdentity(call = {}, agent = {}) {
  const summary = compactActiveCall(call);
  const ids = new Set([
    lower(agent.cxAgentId),
    lower(agent.extensionId),
    lower(agent.email),
    lower(agent.name),
  ].filter(Boolean));
  return ids.has(lower(summary.agentId)) || ids.has(lower(summary.username));
}

function matchActiveCall({ agent, activeCalls, candidates }) {
  const calls = asArray(activeCalls).map(compactActiveCall).filter((call) => call.uii || call.externId);
  const byExtern = new Set(candidates.map((candidate) => lower(candidate.externId)).filter(Boolean));
  const byUii = new Set(candidates.map((candidate) => lower(candidate.uii)).filter(Boolean));

  const externMatches = calls.filter((call) => call.externId && byExtern.has(lower(call.externId)));
  if (externMatches.length === 1) {
    const call = externMatches[0];
    const candidate = candidates.find((item) => lower(item.externId) === lower(call.externId)) || null;
    return { status: "matched", reason: "externId", confidence: "high", call, candidate };
  }
  if (externMatches.length > 1) {
    return { status: "ambiguous", reason: "multiple-externId", confidence: "none", calls: externMatches, candidate: null };
  }

  const uiiMatches = calls.filter((call) => call.uii && byUii.has(lower(call.uii)));
  if (uiiMatches.length === 1) {
    const call = uiiMatches[0];
    const candidate = candidates.find((item) => lower(item.uii) === lower(call.uii)) || null;
    return { status: "matched", reason: "uii", confidence: "medium", call, candidate };
  }
  if (uiiMatches.length > 1) {
    return { status: "ambiguous", reason: "multiple-uii", confidence: "none", calls: uiiMatches, candidate: null };
  }

  const ownedCalls = calls.filter((call) => callMatchesAgentIdentity(call, agent));
  if (ownedCalls.length === 1) {
    return { status: "owned-unmatched", reason: "agent-identity-no-candidate", confidence: "low", call: ownedCalls[0], candidate: null };
  }
  if (ownedCalls.length > 1) {
    return { status: "ambiguous", reason: "multiple-owned-unmatched", confidence: "none", calls: ownedCalls, candidate: null };
  }

  return { status: "empty", reason: "no-owned-active-call", confidence: "none", call: null, candidate: null };
}

function buildCurrentFromMatch(match = {}) {
  if (match.status !== "matched") return null;
  return {
    ...(match.candidate || {}),
    source: match.candidate?.source || "ringcx.matched",
    uii: match.call?.uii || match.candidate?.uii || null,
    externId: match.call?.externId || match.candidate?.externId || null,
    callState: match.call?.callState || null,
    matchReason: match.reason,
    confidence: match.confidence,
    activeSeenAt: new Date().toISOString(),
  };
}

function eventCandidate(candidate = null) {
  if (!candidate) return null;
  return {
    queueItemId: candidate.queueItemId || null,
    caseId: candidate.caseId || null,
    name: candidate.name || null,
    externId: candidate.externId || null,
    uii: candidate.uii || null,
    domain: candidate.domain || null,
    source: candidate.source || null,
    queueFamily: candidate.queueFamily || null,
  };
}

async function resolveAgents(tokens = []) {
  const wanted = tokens.length ? tokens : DEFAULT_AGENTS;
  const accounts = await UserAccount.find({ email: { $in: wanted.map(lower) } }).lean();
  const byEmail = new Map(accounts.map((account) => [lower(account.email), account]));
  const regexes = wanted.map((token) => new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  const states = await AgentState.find({
    $or: [
      { "appPresence.userEmail": { $in: wanted.map(lower) } },
      { extensionId: { $in: accounts.map((account) => account.extensionId).filter(Boolean) } },
      { cxAgentId: { $in: accounts.map((account) => account.cxAgentId).filter(Boolean) } },
      { name: { $in: regexes } },
    ],
  }).sort({ "appPresence.lastSeenAt": -1, updatedAt: -1 }).lean();

  const byExtension = new Map(states.filter((state) => state.extensionId).map((state) => [str(state.extensionId), state]));
  return wanted.map((token) => {
    const account = byEmail.get(lower(token)) ||
      accounts.find((item) => str(item.extensionId) === token || str(item.cxAgentId) === token) ||
      null;
    const state = account?.extensionId
      ? byExtension.get(str(account.extensionId))
      : states.find((item) => lower(item.appPresence?.userEmail) === lower(token) || lower(item.name).includes(lower(token)));
    return {
      email: lower(account?.email || state?.appPresence?.userEmail || token),
      name: str(account?.name || state?.name || token),
      extensionId: str(account?.extensionId || state?.extensionId),
      cxAgentId: str(account?.cxAgentId || state?.cxAgentId),
      accountId: str(account?.ringcxAccountId || account?.cxAccountId || ""),
    };
  }).filter((agent) => agent.email || agent.extensionId || agent.cxAgentId);
}

async function loadAgentSources(agent) {
  const [agentState, bulkSession, slowSession] = await Promise.all([
    agent.extensionId
      ? AgentState.findOne({ extensionId: agent.extensionId }).lean()
      : AgentState.findOne({ "appPresence.userEmail": agent.email }).lean(),
    CxBulkLoadSession.findOne({
      status: "running",
      $or: [
        agent.email ? { agentEmail: agent.email } : null,
        agent.extensionId ? { agentExtensionId: agent.extensionId } : null,
      ].filter(Boolean),
    }).sort({ updatedAt: -1 }).lean(),
    CxSlowLaneSession.findOne({
      status: "running",
      $or: [
        agent.email ? { agentEmail: agent.email } : null,
        agent.extensionId ? { agentExtensionId: agent.extensionId } : null,
      ].filter(Boolean),
    }).sort({ updatedAt: -1 }).lean(),
  ]);
  return { agentState, bulkSession, slowSession };
}

async function readActiveCallsByAccount(client, accountId) {
  const payload = await client.listActiveCalls({
    product: "ACCOUNT",
    productId: accountId,
    maxRows: 200,
  });
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.activeCalls)) return payload.activeCalls;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function readWouldRefillRows({ domains, excludeIds, limit }) {
  const query = {
    state: "ready",
    domain: { $in: domains },
    releaseAt: { $lte: new Date() },
  };
  const validIds = Array.from(excludeIds || [])
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (validIds.length) query._id = { $nin: validIds };
  const rows = await CxDialQueue.find(query).sort(QUEUE_SORT).limit(limit).lean();
  return rows.map((row) => safeCandidate("ready-pool.simulated-refill", row)).filter(Boolean);
}

function makeInitialState(agent, pending, terminals, at, options) {
  const terminalKeys = new Set(asArray(terminals).map(candidateEventKey).filter(Boolean));
  const initialPending = pending.filter((candidate) => !terminalKeys.has(candidateEventKey(candidate)));
  return {
    agent,
    rail: {
      mode: "shadow_unified",
      targetBuffer: Number(options.targetBuffer || 35),
      refillThreshold: Number(options.threshold || 5),
      refillSize: Number(options.refillSize || 30),
      publishPriority: "READ_ONLY",
      publishTiming: "simulated",
    },
    pending: initialPending,
    current: null,
    terminalBuffer: asArray(terminals).map((candidate) => ({
      ...candidate,
      terminalSource: candidate.source || "initial-source-terminal",
      terminalObservedAt: at,
    })),
    consumedKeys: new Set(terminalKeys),
    sourcePendingIds: new Set(initialPending.map(queueItemKey).filter(Boolean)),
    sourceTerminalKeys: new Set(terminalKeys),
    currentMisses: 0,
    refill: {
      inFlight: false,
      count: 0,
      lastAttemptAt: null,
      lastResult: null,
      lastAtPendingCount: null,
    },
    health: {
      initializedAt: at,
      lastWatcherAt: null,
      lastRingcxError: null,
      lastProjectionMismatch: null,
    },
  };
}

function syncSourcePending(state, source, at, events) {
  const nextIds = new Set(source.pending.map(queueItemKey).filter(Boolean));
  const added = source.pending.filter((item) => !state.sourcePendingIds.has(queueItemKey(item)));
  const removedIds = Array.from(state.sourcePendingIds).filter((id) => !nextIds.has(id));
  if (added.length || removedIds.length) {
    events.push({
      type: "source-pending-changed",
      at,
      agent: state.agent,
      addedCount: added.length,
      removedCount: removedIds.length,
      added: added.slice(0, 8).map(eventCandidate),
      removed: removedIds.slice(0, 8),
      sourcePendingCount: source.pending.length,
      shadowPendingCount: state.pending.length,
    });
  }
  for (const item of added) {
    const key = candidateEventKey(item);
    if (key && state.consumedKeys.has(key)) continue;
    if (!state.pending.some((existing) => sameCandidate(existing, item))) {
      state.pending.push(item);
    }
  }
  for (const id of removedIds) {
    if (state.pending.some((item) => queueItemKey(item) === id)) {
      state.pending = state.pending.filter((item) => queueItemKey(item) !== id);
      events.push({
        type: "shadow-removed-source-pending",
        at,
        agent: state.agent,
        queueItemId: id,
        reason: "source-pending-removed",
      });
    }
  }
  state.sourcePendingIds = nextIds;
}

function appendTerminal(state, candidate, source, at, events) {
  const key = candidateEventKey(candidate);
  if (!key || state.sourceTerminalKeys.has(key)) return false;
  state.sourceTerminalKeys.add(key);
  state.terminalBuffer.push({
    ...candidate,
    terminalSource: source,
    terminalObservedAt: at,
  });
  state.consumedKeys.add(key);
  const pendingRemoval = removeCandidate(state.pending, candidate);
  if (pendingRemoval.removed) state.pending = pendingRemoval.next;
  if (state.current && sameCandidate(state.current, candidate)) state.current = null;
  events.push({
    type: "terminal-buffered",
    at,
    agent: state.agent,
    source,
    candidate: eventCandidate(candidate),
    pendingRemoved: Boolean(pendingRemoval.removed),
    pendingCount: state.pending.length,
    terminalBufferCount: state.terminalBuffer.length,
  });
  return true;
}

function syncSourceTerminals(state, source, at, events) {
  for (const terminal of source.terminals) {
    appendTerminal(state, terminal, terminal.source || "source-terminal", at, events);
  }
}

function applyRingcxCurrent(state, source, match, at, options, events) {
  state.health.lastWatcherAt = at;
  if (match.status === "matched") {
    const nextCurrent = buildCurrentFromMatch(match);
    const changed = !state.current || !sameCandidate(state.current, nextCurrent) || str(state.current.uii) !== str(nextCurrent.uii);
    if (changed && state.current) {
      appendTerminal(state, state.current, "ringcx-current-switched", at, events);
    }
    const removed = removeCandidate(state.pending, nextCurrent);
    if (removed.removed) state.pending = removed.next;
    state.current = nextCurrent;
    state.currentMisses = 0;
    state.consumedKeys.add(candidateEventKey(nextCurrent));
    events.push({
      type: changed ? "current-set-from-ringcx" : "current-refreshed-from-ringcx",
      at,
      agent: state.agent,
      current: eventCandidate(nextCurrent),
      match: {
        status: match.status,
        reason: match.reason,
        confidence: match.confidence,
      },
      removedFromPending: Boolean(removed.removed),
      pendingCount: state.pending.length,
    });
    return;
  }

  if (match.status === "owned-unmatched") {
    events.push({
      type: "ringcx-owned-active-unmatched",
      at,
      agent: state.agent,
      call: match.call,
      candidateCount: source.candidates.length,
      pendingCount: state.pending.length,
      reason: "RingCX shows this agent active, but no queue/current candidate matched by externId or UII",
    });
    return;
  }

  if (match.status === "ambiguous") {
    state.health.lastProjectionMismatch = { at, reason: match.reason };
    events.push({
      type: "ringcx-active-ambiguous",
      at,
      agent: state.agent,
      reason: match.reason,
      calls: asArray(match.calls).slice(0, 8),
      candidateCount: source.candidates.length,
    });
    return;
  }

  if (!state.current) return;
  state.currentMisses += 1;
  if (state.currentMisses < options.releaseMisses) {
    events.push({
      type: "current-missing-waiting",
      at,
      agent: state.agent,
      current: eventCandidate(state.current),
      currentMisses: state.currentMisses,
      releaseMisses: options.releaseMisses,
    });
    return;
  }
  appendTerminal(state, state.current, "ringcx-no-longer-active", at, events);
  state.current = null;
  state.currentMisses = 0;
}

async function maybeSimulateRefill(state, defaultDomain, at, options, events) {
  if (state.pending.length > options.threshold) {
    state.refill.lastAtPendingCount = null;
    return;
  }
  if (state.refill.lastAtPendingCount === state.pending.length) return;
  state.refill.lastAtPendingCount = state.pending.length;
  state.refill.lastAttemptAt = at;

  const excludeIds = new Set([
    ...state.pending.map(queueItemKey).filter(Boolean),
    ...state.terminalBuffer.map(queueItemKey).filter(Boolean),
    state.current ? queueItemKey(state.current) : "",
  ].filter(Boolean));
  const domains = domainsFrom([...state.pending, ...state.terminalBuffer, state.current].filter(Boolean), defaultDomain);
  const rows = await readWouldRefillRows({ domains, excludeIds, limit: options.refillSize });
  if (rows.length) {
    state.pending = uniqueCandidates([...state.pending, ...rows]);
    state.refill.count += 1;
  }
  state.refill.lastResult = {
    accepted: rows.length,
    requested: options.refillSize,
    domains,
  };
  events.push({
    type: rows.length ? "refill-simulated" : "refill-empty",
    at,
    agent: state.agent,
    requested: options.refillSize,
    accepted: rows.length,
    domains,
    pendingCount: state.pending.length,
    families: familyCounts(rows),
    firstRows: rows.slice(0, 10).map(eventCandidate),
  });
}

function summarizeState(state, source, match) {
  return {
    agent: state.agent,
    rail: state.rail,
    source: {
      pendingCount: source.pending.length,
      currentCandidateCount: source.currentCandidates.length,
      terminalCount: source.terminals.length,
    },
    ringcx: {
      matchStatus: match.status,
      reason: match.reason,
      confidence: match.confidence,
      call: match.call || null,
    },
    state: {
      pendingCount: state.pending.length,
      current: eventCandidate(state.current),
      terminalBufferCount: state.terminalBuffer.length,
      refill: state.refill,
      families: familyCounts(state.pending),
      health: state.health,
    },
  };
}

function appendJsonl(file, rows = []) {
  if (!file || !rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
  const dbName = process.env.PARALLEL_DB_NAME || process.env.MONGO_DB_NAME || process.env.DB_NAME || "tagcontactbridge";
  if (!mongoUri) throw new Error("Missing MONGO_URI");

  const agentsArg = splitArg(argValue("agents"));
  const defaultDomain = upper(argValue("domain", "TAG")) || "TAG";
  const durationSec = Math.max(Number(argValue("durationSec", "3600")) || 3600, 1);
  const intervalMs = Math.max(Number(argValue("intervalMs", "1000")) || 1000, 500);
  const once = hasFlag("once");
  const json = hasFlag("json");
  const options = {
    threshold: Math.max(Number(argValue("threshold", "5")) || 5, 1),
    refillSize: Math.max(Number(argValue("refillSize", "30")) || 30, 1),
    targetBuffer: Math.max(Number(argValue("targetBuffer", "35")) || 35, 1),
    releaseMisses: Math.max(Number(argValue("releaseMisses", "2")) || 2, 1),
  };
  const out = argValue(
    "out",
    path.resolve(__dirname, "..", "runtime", "cx-floor-shadow", `agent-queue-state-shadow-${Date.now()}.jsonl`),
  );

  await mongoose.connect(mongoUri, { dbName });
  const client = createRingcxVoiceClient();
  const accountId = argValue("accountId", client.config?.accountId || "");
  if (!accountId) throw new Error("Missing RingCX account id");

  const agents = await resolveAgents(agentsArg);
  if (!agents.length) throw new Error("No agents resolved");

  const states = new Map();
  const eventCounts = {};
  const started = Date.now();
  const ticks = once ? 1 : Math.ceil((durationSec * 1000) / intervalMs);

  for (let tick = 0; tick < ticks; tick += 1) {
    const at = new Date().toISOString();
    const events = [];
    let activeCalls = [];
    let ringcxError = null;
    try {
      activeCalls = await readActiveCallsByAccount(client, accountId);
    } catch (error) {
      ringcxError = error;
      events.push({
        type: "ringcx-active-read-error",
        at,
        accountId,
        error: error.message || String(error),
        status: error.status || error.statusCode || error.response?.status || null,
      });
    }

    const snapshots = [];
    for (const agent of agents) {
      const key = agentKey(agent);
      const sources = await loadAgentSources(agent);
      const source = {
        pending: sourcePending(sources.agentState || {}, sources.bulkSession || null),
        currentCandidates: sourceCurrentCandidates(sources.agentState || {}, sources.bulkSession || null, sources.slowSession || null),
        terminals: sourceTerminalCandidates(sources.agentState || {}, sources.bulkSession || null, sources.slowSession || null),
      };
      source.candidates = uniqueCandidates([
        ...source.pending,
        ...source.currentCandidates,
      ]);

      let state = states.get(key);
      if (!state) {
        state = makeInitialState(agent, source.pending, source.terminals, at, options);
        states.set(key, state);
        events.push({
          type: "state-initialized",
          at,
          agent,
          pendingCount: state.pending.length,
          terminalBufferCount: state.terminalBuffer.length,
          families: familyCounts(state.pending),
        });
      } else {
        syncSourcePending(state, source, at, events);
      }

      syncSourceTerminals(state, source, at, events);
      const match = ringcxError
        ? { status: "error", reason: "ringcx-read-error", confidence: "none", call: null, candidate: null }
        : matchActiveCall({ agent, activeCalls, candidates: source.candidates });
      if (!ringcxError) {
        applyRingcxCurrent(state, source, match, at, options, events);
      } else {
        state.health.lastRingcxError = { at, error: ringcxError.message || String(ringcxError) };
      }
      await maybeSimulateRefill(state, defaultDomain, at, options, events);
      snapshots.push(summarizeState(state, source, match));
    }

    for (const event of events) eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
    appendJsonl(out, [{
      type: "snapshot",
      at,
      tick,
      accountId,
      activeCallCount: activeCalls.length,
      options,
      agents: snapshots,
      rateLimit: getRingcxVoiceRateLimitState ? getRingcxVoiceRateLimitState() : null,
    }, ...events]);

    if (!json) {
      console.log(`[agent-queue-state-shadow] ${at} tick=${tick} activeCalls=${activeCalls.length} events=${events.length} out=${out}`);
      for (const row of snapshots) {
        console.log(
          `  ${row.agent.name}: sourcePending=${row.source.pendingCount} shadowPending=${row.state.pendingCount} current=${row.state.current?.queueItemId || "none"} match=${row.ringcx.matchStatus}/${row.ringcx.reason}`,
        );
      }
    }
    if (once || tick === ticks - 1) break;
    const elapsed = Date.now() - started;
    await sleep(Math.max(((tick + 1) * intervalMs) - elapsed, 0));
  }

  const summary = {
    mode: "read-only-agent-queue-state-shadow",
    accountId,
    agents,
    options,
    ticks,
    outputJsonl: out,
    eventCounts,
    rateLimit: getRingcxVoiceRateLimitState ? getRingcxVoiceRateLimitState() : null,
  };
  if (json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`[agent-queue-state-shadow] complete ${JSON.stringify(eventCounts)} jsonl=${out}`);

  await mongoose.disconnect();
}

main().catch(async (error) => {
  try { await mongoose.disconnect(); } catch {}
  console.error("[agent-queue-state-shadow] failed:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
