#!/usr/bin/env node
"use strict";

// Return pipe for cx-direct-four-agent-feeder:
// RingCX terminal facts -> today's durable result -> July attempt 2/3 after 90m.
// Dry-run by default. --apply is required for writes and retry uploads.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
process.env.CX_ALPHA_TRACE_ENABLED = "false";

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { createRingcxVoiceClient } = require("../packages/shared-integrations/src");
const { LeadCadence } = require("../packages/shared-models/src");
const { cxTerminalOutboxRepository } = require("../packages/shared-repositories/src");
const { publishBatchToRingcx } = require("../packages/shared-services/src/cxBulkLoadRingcxPublisher");
const { AGENTS, normalizePhone, resolveRoutes } = require("./cx-direct-four-agent-feeder");

const DOMAIN = "WYNN";
// All four bulk + all four First Contact campaigns were read back on 2026-07-10:
// maxPasses=3, passDelayMin=60, requeueType=ADVANCED. RingCX owns attempts 2/3.
// This reader must never manufacture additional retry copies.
const RINGCX_OWNS_RETRIES = true;
const TERMINAL_STATES = new Set(["COMPLETE", "COMPLETED", "DONE", "TERMINAL", "DISPOSITIONED"]);

function str(value) { return String(value == null ? "" : value).trim(); }

function rowsFromSearch(value) {
  if (Array.isArray(value)) return value;
  for (const key of ["leads", "records", "data"]) if (Array.isArray(value?.[key])) return value[key];
  throw new Error("RingCX lead search returned an unexpected response");
}

function outcomeFromLead(row = {}) {
  const token = str(
    row.lastPassDispo || row.lastPassDisposition || row.outboundDisposition
      || row.systemDisposition || row.agentDisposition || row.agentDispostion,
  ).toUpperCase();
  if (token.includes("DNC") || token.includes("DO NOT CALL")) return "dnc";
  if (token.includes("BAD") || token.includes("WRONG") || token.includes("INVALID")) return "bad_number";
  if (token.includes("MACHINE") || token.includes("VOICEMAIL") || token.includes("VM DROP")) return "voicemail";
  if (["NOANSWER", "NO ANSWER", "NO_ANSWER", "BUSY", "CONGESTION", "INTERCEPT", "ABANDON", "DISCONNECT"]
    .some((value) => token.includes(value))) return "did_not_connect";
  if (["ANSWER", "SALE", "APPOINT", "CLIENT", "CONNECTED"].some((value) => token.includes(value))) return "answered";
  return "unknown";
}

function leadState(row = {}) {
  return str(row.leadState || row.state || row.physicalState).toUpperCase();
}

function terminalAt(row = {}, fallback = new Date()) {
  for (const value of [row.lastCallTime, row.lastPassTime, row.lastPassDate, row.lastPassDts, row.stateDts, row.callEndTime, row.endTime, row.updatedAt, row.modifyDate]) {
    const parsed = new Date(value || 0);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > 0) return parsed;
  }
  return fallback;
}

function pacificDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function isJulyLead(date) {
  const d = date instanceof Date ? date : new Date(date || 0);
  return !Number.isNaN(d.getTime()) && pacificDateKey(d).startsWith("2026-07-");
}

function retryExtern(caseId, attempt) {
  return `cx-direct-${DOMAIN.toLowerCase()}-${Number(caseId)}-a${Number(attempt)}`;
}

async function searchCampaign(client, campaignId, docs) {
  const found = new Map();
  for (let start = 0; start < docs.length; start += 250) {
    const batch = docs.slice(start, start + 250);
    const cid = Number(campaignId) || campaignId;
    const response = await client.searchLeads({
      campaignId: cid, campaignIds: [cid], externIds: batch.map((row) => row.externId),
      listIds: [], agentDispositions: [], systemDispositions: [], leadStates: [],
      physicalStates: [], leadTimezones: [], suppressed: "ALL",
    });
    for (const row of rowsFromSearch(response)) {
      const id = str(row.externId || row.externalId);
      if (id) found.set(id, row);
    }
  }
  return found;
}

async function collectResults({ client, feed, apply, now }) {
  const open = await feed.find({
    $or: [{ status: "accepted" }, { status: "terminal", outcome: "unknown" }],
  }).toArray();
  const byCampaign = new Map();
  for (const row of open) {
    const key = str(row.campaignId);
    if (!key || !row.externId) continue;
    if (!byCampaign.has(key)) byCampaign.set(key, []);
    byCampaign.get(key).push(row);
  }
  const observations = [];
  const states = {};
  for (const [campaignId, docs] of byCampaign) {
    const found = await searchCampaign(client, campaignId, docs);
    for (const doc of docs) {
      const row = found.get(doc.externId);
      if (!row) continue;
      const state = leadState(row) || "UNKNOWN";
      states[state] = (states[state] || 0) + 1;
      const pass = Math.max(0, Number(row.leadPasses || 0));
      const correction = doc.status === "terminal" && doc.outcome === "unknown";
      if (pass <= Number(doc.observedPasses || 0) && !correction) continue;
      const outcome = outcomeFromLead(row);
      const at = terminalAt(row, now);
      observations.push({ doc, row, outcome, at, pass, terminal: TERMINAL_STATES.has(state), correction });
    }
  }
  if (apply) {
    for (const item of observations) {
      const caseId = Number(String(item.doc._id).split(":").pop());
      const attemptCount = Math.max(1, item.pass || Number(item.doc.attemptCount || 1));
      const systemDisposition = str(item.row.lastPassDispo || item.row.systemDisposition || item.row.lastPassDisposition) || null;
      const uii = str(item.row.uii || item.row.callUii || item.row.sessionId) || null;
      const updated = await feed.updateOne(
        {
          _id: item.doc._id,
          externId: item.doc.externId,
          $or: [
            { observedPasses: { $lt: item.pass } },
            { observedPasses: { $exists: false } },
            { status: "terminal", outcome: "unknown" },
          ],
        },
        { $set: {
          ...(item.terminal ? { status: "terminal", outcome: item.outcome, terminalAt: item.at } : {}),
          observedPasses: item.pass, lastObservedOutcome: item.outcome, lastPassAt: item.at,
          nextEligibleAt: null, attemptCount, systemDisposition, uii, updatedAt: now,
        } },
      );
      if ((updated.modifiedCount || 0) !== 1) continue;
      await cxTerminalOutboxRepository.insertOnce({
        idemKey: `cx-direct:${item.doc.externId}:pass:${item.pass || 1}${item.correction ? ":correction" : ""}`,
        sessionId: "cx-direct-four-agent",
        rail: item.doc.lane || "bulk",
        domain: DOMAIN,
        queueItemId: null,
        uii,
        caseId,
        agentEmail: AGENTS.find((agent) => agent.key === item.doc.agent)?.email || null,
        externId: item.doc.externId,
        outcome: item.outcome,
        source: "cx-direct-ringcx-result",
        payload: {
          domain: DOMAIN, caseId, uii, externId: item.doc.externId, outcome: item.outcome,
          systemDisposition, at: item.at.toISOString(), outcomeAt: item.at.toISOString(),
          source: "cx-direct-ringcx-result", nextAction: null,
        },
      });
    }
  }
  return {
    searched: open.length,
    states,
    passResultsFound: observations.length,
    terminalFound: observations.filter((row) => row.terminal).length,
  };
}

async function loadDueRetries({ client, feed, apply, now }) {
  if (RINGCX_OWNS_RETRIES) {
    return { owner: "ringcx", maxPasses: 3, passDelayMinutes: 60, due: 0, accepted: 0, rejected: 0 };
  }
  // Pending deletion after floor proof: the code below is deliberately unreachable.
  // It is retained only to honor the repository weed-whack rule against physical deletion.
  const due = await feed.find({
    status: "terminal",
    outcome: { $in: [...RETRYABLE] },
    nextEligibleAt: { $lte: now },
    attemptCount: { $lt: MAX_ATTEMPTS },
  }).sort({ nextEligibleAt: 1 }).toArray();
  const caseIds = due.map((row) => Number(String(row._id).split(":").pop())).filter(Number.isFinite);
  const leads = await LeadCadence.find({ domain: DOMAIN, caseId: { $in: caseIds } }).lean();
  const byCase = new Map(leads.map((row) => [Number(row.caseId), row]));
  const today = pacificDateKey(now);
  const eligible = due.filter((row) => {
    const lead = byCase.get(Number(String(row._id).split(":").pop()));
    return lead && isJulyLead(lead.createdAt) && pacificDateKey(row.terminalAt) === today;
  });
  if (!apply) return { due: eligible.length, accepted: 0, rejected: 0 };

  const routes = new Map(resolveRoutes(process.env, "retry").map((route) => [route.key, route]));
  let accepted = 0;
  let rejected = 0;
  for (const agent of AGENTS) {
    const route = routes.get(agent.key);
    const rows = eligible.filter((row) => row.agent === agent.key);
    if (!rows.length) continue;
    const candidates = [];
    for (const prior of rows) {
      const caseId = Number(String(prior._id).split(":").pop());
      const lead = byCase.get(caseId);
      const attempt = Number(prior.attemptCount || 1) + 1;
      candidates.push({
        feedId: prior._id, queueItemId: String(lead._id), domain: DOMAIN, caseId,
        name: str(lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(" ")),
        phone: normalizePhone(lead.primaryPhone || lead.normalizedPhone),
        externId: retryExtern(caseId, attempt), attempt, prior,
      });
    }
    const result = await publishBatchToRingcx(client, {
      campaignId: route.campaignId, dialPriority: "NORMAL", candidates,
    });
    const acceptedIds = new Set(result.accepted.map((row) => row.externId));
    for (const candidate of candidates) {
      if (acceptedIds.has(candidate.externId)) {
        await feed.updateOne({ _id: candidate.feedId, status: "terminal" }, {
          $push: { history: {
            attempt: candidate.prior.attemptCount, externId: candidate.prior.externId,
            campaignId: candidate.prior.campaignId, lane: candidate.prior.lane,
            outcome: candidate.prior.outcome, terminalAt: candidate.prior.terminalAt,
          } },
          $set: {
            status: "accepted", attemptCount: candidate.attempt, externId: candidate.externId,
            campaignId: route.campaignId, lane: "bulk", acceptedAt: now, terminalAt: null,
            outcome: null, nextEligibleAt: null, systemDisposition: null, uii: null, updatedAt: now,
          },
        });
        accepted += 1;
      } else {
        await feed.updateOne({ _id: candidate.feedId }, {
          $set: { nextEligibleAt: new Date(now.getTime() + 30 * 60 * 1000), updatedAt: now },
        });
        rejected += 1;
      }
    }
  }
  return { due: eligible.length, accepted, rejected };
}

async function main() {
  if (!process.argv.includes("--enable-disposition-read")) {
    console.log(JSON.stringify({ disabled: true, reason: "dispositions-not-enabled" }));
    return;
  }
  const apply = process.argv.includes("--apply");
  const config = getSharedConfig(DOMAIN);
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  const feed = mongoose.connection.db.collection("cx_direct_four_agent_feed");
  const client = createRingcxVoiceClient();
  const now = new Date();
  const collected = await collectResults({ client, feed, apply, now });
  const retries = await loadDueRetries({ client, feed, apply, now: new Date() });
  console.log(JSON.stringify({ apply, collected, retries }, null, 2));
}

if (require.main === module) {
  main().catch((error) => { console.error(error?.stack || error?.message || error); process.exitCode = 1; })
    .finally(() => mongoose.disconnect().catch(() => {}));
}

module.exports = { isJulyLead, leadState, outcomeFromLead, pacificDateKey, retryExtern, rowsFromSearch, terminalAt };
