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
  CxSlowLaneSession,
  UserAccount,
} = require("../packages/shared-models/src");

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
  return str(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

function stableId(parts = {}) {
  if (!parts || typeof parts !== "object") return "";
  const hasIdentity = parts.uii || parts.externId || parts.queueItemId || parts.caseId;
  if (!hasIdentity) return "";
  return [
    parts.uii || "",
    parts.externId || "",
    parts.queueItemId || "",
    parts.caseId || "",
  ].map(str).join("|");
}

function safeCallSummary(call = {}) {
  return {
    uii: str(call.uii || call.callUii || call.id) || null,
    externId: str(call.externId || call.externalId || call.outboundExternid || call.outboundExternalId) || null,
    agentId: str(call.agentId || call.agentLoginId || call.agent?.agentId || call.username) || null,
    username: str(call.username || call.agentEmail || call.agent?.username || call.agent?.email) || null,
    callState: call.callState || call.state || call.status || null,
    phoneLast4: last4(call.dnis || call.ani || call.phone || call.destination || call.leadPhone),
  };
}

function candidateFrom(source, value = {}) {
  if (!value || typeof value !== "object") return null;
  const externId = str(value.externId || value.externalId || value.ringcx?.externId || value.ringcxExternalId);
  const uii = str(value.uii || value.rcxUii || value.callUii);
  const queueItemId = str(value.queueItemId || value.cxQueueRecordId || value.queueTicketId || value._id || value.id);
  const caseId = value.caseId != null ? Number(value.caseId) : null;
  const name = str(value.name || value.prospectName || value.contactName || value.fromName);
  if (!externId && !uii && !queueItemId && !caseId && !name) return null;
  return {
    source,
    queueItemId: queueItemId || null,
    caseId: Number.isFinite(caseId) ? caseId : null,
    name: name || null,
    externId: externId || null,
    uii: uii || null,
    phase: value.phase || value.status || null,
  };
}

function summarizeAgentState(agentState = {}) {
  return {
    extensionId: str(agentState.extensionId) || null,
    cxAgentId: str(agentState.cxAgentId) || null,
    name: str(agentState.name) || null,
    company: upper(agentState.company) || null,
    status: agentState.status || null,
    activityState: agentState.activityState || null,
    activePlatform: agentState.activePlatform || null,
    currentCall: candidateFrom("agentstate.currentCall", agentState.currentCall),
    cxCall: agentState.cxCall && typeof agentState.cxCall === "object"
      ? {
          phase: agentState.cxCall.phase || null,
          uii: str(agentState.cxCall.uii || agentState.cxCall.currentUii) || null,
          queueItemId: str(agentState.cxCall.queueItemId || agentState.cxCall.currentQueueItemId) || null,
          caseId: agentState.cxCall.caseId || null,
        }
      : null,
    updatedAt: toIso(agentState.updatedAt),
  };
}

function summarizeSession(source, session = null) {
  if (!session) return null;
  return {
    source,
    sessionId: session.sessionId || null,
    status: session.status || null,
    phase: session.phase || null,
    current: candidateFrom(`${source}.current`, session.current),
    bufferCount: asArray(session.acceptedBuffer).length,
    completedCount: asArray(session.completed).length,
    ringcx: session.ringcx || {},
    updatedAt: toIso(session.updatedAt),
  };
}

function collectCandidates(agent = {}) {
  const out = [];
  const add = (candidate) => {
    if (candidate) out.push(candidate);
  };
  add(agent.mongo.agentState?.currentCall);
  if (agent.mongo.agentState?.cxCall) {
    add(candidateFrom("agentstate.cxCall", agent.mongo.agentState.cxCall));
  }
  add(agent.mongo.bulkSession?.current);
  for (const c of asArray(agent.raw.bulkSession?.acceptedBuffer)) {
    add(candidateFrom("bulk.acceptedBuffer", c));
  }
  add(agent.mongo.slowSession?.current);
  return out;
}

function callMatchesAgentIdentity(call = {}, agent = {}) {
  const summary = safeCallSummary(call);
  const ids = new Set([
    lower(agent.cxAgentId),
    lower(agent.extensionId),
    lower(agent.email),
    lower(agent.name),
  ].filter(Boolean));
  return ids.has(lower(summary.agentId)) || ids.has(lower(summary.username));
}

function matchActiveCall(agent = {}, activeCalls = []) {
  const candidates = collectCandidates(agent);
  const byExtern = new Set(candidates.map((c) => lower(c.externId)).filter(Boolean));
  const byUii = new Set(candidates.map((c) => lower(c.uii)).filter(Boolean));

  const externMatches = activeCalls.filter((call) => byExtern.has(lower(safeCallSummary(call).externId)));
  if (externMatches.length === 1) {
    const call = safeCallSummary(externMatches[0]);
    const candidate = candidates.find((c) => lower(c.externId) === lower(call.externId)) || null;
    return { status: "matched", reason: "externId", call, candidate, confidence: "high" };
  }
  if (externMatches.length > 1) {
    return { status: "ambiguous", reason: "multiple-externId", calls: externMatches.map(safeCallSummary), candidates };
  }

  const uiiMatches = activeCalls.filter((call) => byUii.has(lower(safeCallSummary(call).uii)));
  if (uiiMatches.length === 1) {
    const call = safeCallSummary(uiiMatches[0]);
    const candidate = candidates.find((c) => lower(c.uii) === lower(call.uii)) || null;
    return { status: "matched", reason: "uii-from-mongo", call, candidate, confidence: "medium" };
  }
  if (uiiMatches.length > 1) {
    return { status: "ambiguous", reason: "multiple-uii", calls: uiiMatches.map(safeCallSummary), candidates };
  }

  const identityMatches = activeCalls.filter((call) => callMatchesAgentIdentity(call, agent));
  if (identityMatches.length === 1) {
    return {
      status: "matched",
      reason: "agent-identity",
      call: safeCallSummary(identityMatches[0]),
      candidate: null,
      confidence: "low",
    };
  }
  if (identityMatches.length > 1) {
    return { status: "ambiguous", reason: "multiple-agent-identity", calls: identityMatches.map(safeCallSummary), candidates };
  }

  return { status: "empty", reason: "no-owned-active-call", call: null, candidate: null, confidence: "none", candidates };
}

function buildCurrent(agent = {}, match = {}) {
  if (match.status !== "matched") return null;
  return {
    uii: match.call?.uii || match.candidate?.uii || null,
    externId: match.call?.externId || match.candidate?.externId || null,
    queueItemId: match.candidate?.queueItemId || null,
    caseId: match.candidate?.caseId || null,
    name: match.candidate?.name || null,
    callState: match.call?.callState || null,
    matchReason: match.reason,
    confidence: match.confidence,
  };
}

function agentKey(agent = {}) {
  return lower(agent.email || agent.extensionId || agent.name);
}

async function resolveAgents({ domain, tokens, limit }) {
  const company = upper(domain);
  let accounts = [];
  let states = [];

  if (tokens.length) {
    const tokenRegexes = tokens.map((token) => new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    accounts = await UserAccount.find({
      $or: [
        { email: { $in: tokens.map(lower) } },
        { extensionId: { $in: tokens } },
        { cxAgentId: { $in: tokens } },
        { name: { $in: tokenRegexes } },
      ],
    }).lean();
    states = await AgentState.find({
      $or: [
      { extensionId: { $in: tokens } },
      { cxAgentId: { $in: tokens } },
      { name: { $in: tokens.map((token) => new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")) } },
      { extensionId: { $in: accounts.map((a) => a.extensionId).filter(Boolean) } },
      ],
    }).sort({ name: 1 }).limit(Math.max(limit * 2, 20)).lean();
  } else {
    states = await AgentState.find({
      company,
      "cxRouting.enabled": true,
      extensionId: { $nin: [null, ""] },
    })
      .sort({ "appPresence.lastSeenAt": -1, updatedAt: -1, name: 1 })
      .limit(limit)
      .lean();

    if (!states.length) {
      accounts = await UserAccount.find({
        company,
        role: { $in: ["internal-agent", "manager", "admin"] },
        extensionId: { $nin: [null, ""] },
        "cxQueuePolicy.enabled": { $ne: false },
      })
        .sort({ name: 1 })
        .limit(limit)
        .lean();
    }
  }

  if (states.length) {
    const stateExtensions = states.map((s) => str(s.extensionId)).filter(Boolean);
    const stateCxAgentIds = states.map((s) => str(s.cxAgentId)).filter(Boolean);
    const accountMatches = await UserAccount.find({
      $or: [
        { extensionId: { $in: stateExtensions } },
        { cxAgentId: { $in: stateCxAgentIds } },
      ],
    }).lean();
    const seenEmails = new Set(accounts.map((a) => lower(a.email)).filter(Boolean));
    for (const account of accountMatches) {
      if (seenEmails.has(lower(account.email))) continue;
      accounts.push(account);
      seenEmails.add(lower(account.email));
    }
  }

  const accountByExtension = new Map(accounts.filter((a) => a.extensionId).map((a) => [str(a.extensionId), a]));
  const accountByCxAgentId = new Map(accounts.filter((a) => a.cxAgentId).map((a) => [str(a.cxAgentId), a]));
  const stateByExtension = new Map(states.filter((s) => s.extensionId).map((s) => [str(s.extensionId), s]));
  const merged = [];

  for (const state of states) {
    const account = accountByExtension.get(str(state.extensionId)) || accountByCxAgentId.get(str(state.cxAgentId)) || null;
    merged.push({ account, state });
  }
  for (const account of accounts) {
    if (account.extensionId && stateByExtension.has(str(account.extensionId))) continue;
    merged.push({ account, state: null });
  }

  return merged
    .filter((entry) => entry.account || entry.state)
    .slice(0, limit)
    .map((entry) => ({
      email: lower(entry.account?.email || entry.state?.appPresence?.userEmail || ""),
      name: str(entry.account?.name || entry.state?.name),
      extensionId: str(entry.account?.extensionId || entry.state?.extensionId),
      cxAgentId: str(entry.account?.cxAgentId || entry.state?.cxAgentId),
      company,
      account: entry.account || null,
      state: entry.state || null,
    }));
}

async function loadAgentMongo(agent = {}) {
  const [agentState, bulkSession, slowSession] = await Promise.all([
    agent.extensionId
      ? AgentState.findOne({ extensionId: agent.extensionId }).lean()
      : AgentState.findOne({ name: new RegExp(`^${agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }).lean(),
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

  return {
    raw: { agentState, bulkSession, slowSession },
    mongo: {
      agentState: summarizeAgentState(agentState || {}),
      bulkSession: summarizeSession("bulk", bulkSession),
      slowSession: summarizeSession("slow", slowSession),
    },
  };
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

function makeSnapshot({ checkedAt, accountId, agents, activeCalls }) {
  return {
    checkedAt,
    accountId,
    activeCallCount: activeCalls.length,
    agents: agents.map((agent) => {
      const match = matchActiveCall(agent, activeCalls);
      const current = buildCurrent(agent, match);
      return {
        agent: {
          email: agent.email || null,
          name: agent.name || null,
          extensionId: agent.extensionId || null,
          cxAgentId: agent.cxAgentId || null,
        },
        current,
        currentKey: stableId(current || {}),
        match: {
          status: match.status,
          reason: match.reason,
          confidence: match.confidence || null,
          ambiguousCount: Array.isArray(match.calls) ? match.calls.length : 0,
        },
        mongo: agent.mongo,
      };
    }),
  };
}

function diffSnapshot(prevByAgent, snapshot) {
  const events = [];
  for (const row of snapshot.agents) {
    const key = agentKey(row.agent);
    const previous = prevByAgent.get(key) || null;
    const previousKey = previous?.currentKey || "";
    const nextKey = row.currentKey || "";
    if (previous && previousKey !== nextKey) {
      events.push({
        type: "uii-swap",
        at: snapshot.checkedAt,
        agent: row.agent,
        from: previous.current || null,
        to: row.current || null,
        previousMatch: previous.match || null,
        match: row.match || null,
        mongo: row.mongo,
      });
    } else if (!previous && nextKey) {
      events.push({
        type: "uii-seen",
        at: snapshot.checkedAt,
        agent: row.agent,
        from: null,
        to: row.current,
        match: row.match || null,
        mongo: row.mongo,
      });
    }
    prevByAgent.set(key, row);
  }
  return events;
}

function printHumanTick(snapshot, events) {
  console.log(`[cx-floor-shadow] ${snapshot.checkedAt} account=${snapshot.accountId} activeCalls=${snapshot.activeCallCount} swaps=${events.length}`);
  for (const row of snapshot.agents) {
    const label = row.agent.name || row.agent.email || row.agent.extensionId || "unknown-agent";
    const current = row.current
      ? `${row.current.queueItemId || "no-queue"} uii=${row.current.uii || "none"} ${row.current.name || ""}`.trim()
      : "none";
    console.log(`  ${label}: ${row.match.status}/${row.match.reason} ${current}`);
  }
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

  const domain = upper(argValue("domain", "TAG")) || "TAG";
  const limit = Math.max(Number(argValue("limit", "5")) || 5, 1);
  const intervalMs = Math.max(Number(argValue("intervalMs", "1000")) || 1000, 250);
  const durationSec = Math.max(Number(argValue("durationSec", "300")) || 300, 1);
  const once = hasFlag("once");
  const json = hasFlag("json");
  const agentTokens = splitArg(argValue("agents"));
  const out = argValue("out", path.resolve(__dirname, "..", "runtime", "cx-floor-shadow", `floor-shadow-${Date.now()}.jsonl`));

  await mongoose.connect(mongoUri, { dbName });
  const client = createRingcxVoiceClient();
  const accountId = argValue("accountId", client.config?.accountId || "");
  if (!accountId) throw new Error("Missing RingCX account id");

  const agentsBase = await resolveAgents({ domain, tokens: agentTokens, limit });
  if (!agentsBase.length) throw new Error("No agents resolved; pass --agents=email,name,extension or check agentstates/useraccounts");

  const prevByAgent = new Map();
  const allEvents = [];
  const snapshots = [];
  const started = Date.now();
  const ticks = once ? 1 : Math.ceil((durationSec * 1000) / intervalMs);

  for (let i = 0; i < ticks; i += 1) {
    const checkedAt = new Date().toISOString();
    const [activeCalls, hydratedAgents] = await Promise.all([
      readActiveCallsByAccount(client, accountId),
      Promise.all(agentsBase.map(async (agent) => ({ ...agent, ...(await loadAgentMongo(agent)) }))),
    ]);
    const snapshot = makeSnapshot({ checkedAt, accountId, agents: hydratedAgents, activeCalls });
    const events = diffSnapshot(prevByAgent, snapshot);
    allEvents.push(...events);
    snapshots.push(snapshot);
    appendJsonl(out, [
      { type: "snapshot", ...snapshot },
      ...events,
    ]);
    if (!json) printHumanTick(snapshot, events);
    if (once || i === ticks - 1) break;
    const elapsed = Date.now() - started;
    const expectedNext = (i + 1) * intervalMs;
    await sleep(Math.max(expectedNext - elapsed, 0));
  }

  const payload = {
    mode: "read-only-floor-shadow",
    startedAt: snapshots[0]?.checkedAt || null,
    endedAt: snapshots[snapshots.length - 1]?.checkedAt || null,
    accountId,
    domain,
    intervalMs,
    ticks: snapshots.length,
    agentCount: agentsBase.length,
    outputJsonl: out,
    events: allEvents,
    finalSnapshot: snapshots[snapshots.length - 1] || null,
    rateLimit: getRingcxVoiceRateLimitState ? getRingcxVoiceRateLimitState() : null,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`[cx-floor-shadow] complete ticks=${payload.ticks} events=${payload.events.length} jsonl=${out}`);
    console.log(JSON.stringify(payload.events, null, 2));
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  try { await mongoose.disconnect(); } catch {}
  console.error("[cx-floor-shadow] failed:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
