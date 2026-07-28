"use strict";

// MAILER QUEUE PERFORMANCE — who actually takes the mail calls we pay for.
//
// Mickey 2026-07-28: "mail still uses the ex architecture ... callrail api is
// more robust in terms of getting hammered so ring central is always a fall
// back or targeted slow trickle. we dont really need to get by the queue at
// the granular level by piece because piece metrics dont care about
// settlement officer so you can just grab connections on the mailer queue."
//
// So the division of labour is deliberate:
//   CallRail  → HOW MANY mail calls came in (robust, already polled daily)
//   RingCentral → WHO CONNECTED on the mailer queue (a slow, bounded trickle)
//
// ── RATE DISCIPLINE (non-negotiable) ────────────────────────────────────
// The RC client caches its OAuth token in module state (60s expiry buffer),
// so requests do NOT re-authenticate — an auth-per-request pattern is how
// you collect thousands of 429s in seconds. On top of that this reader:
//   · fetches ONE page at a time, never in parallel
//   · sleeps between pages (default 1.5s)
//   · stops at a hard page cap
//   · aborts the whole read on the first 429 and returns what it has
// It is a reporting nicety. It must never threaten the phones.

const { createRingCentralClient } = require("../../shared-integrations/src");

const DEFAULT_QUEUE_PATTERNS = [/^mailer$/i];

// ── STREAMS ─────────────────────────────────────────────────────────────
// Mickey 2026-07-28: "agent performance by stream." One pass over the same
// call-log pages classifies every queue call into a paid stream — no extra
// RingCentral traffic for the extra dimension.
//
// Mickey 2026-07-28: "so bcd ex queue, mailer ex queue, ld phone burner
// data." Three paid streams, TWO sources — RingCentral answers only for the
// two EX queues (ext 500 Mailer, ext 910 Origination BCD, live-verified
// against the account's 82 department extensions). LD never touches RC: the
// dialer IS PhoneBurner, and DailyDial already holds every attempt with its
// agent, so asking RC for it would be both redundant and extra load.
const STREAMS = Object.freeze([
  { key: "MAILER", label: "Mail", patterns: [/(^|[^a-z])mailer([^a-z]|$)/i] },
  { key: "BCD", label: "BCD", patterns: [/origination[ ]*bcd/i, /(^|[^a-z])bcd([^a-z]|$)/i] },
]);

function classifyStream(queueName) {
  const name = String(queueName || "").trim();
  if (!name) return null;
  for (const s of STREAMS) {
    if (s.patterns.some((re) => re.test(name))) return s.key;
  }
  return null;
}

/** Every candidate queue name on a record. The FIRST named Accept leg is
 * frequently the caller's CNAM ("WIRELESS CALLER"), not the queue, and
 * names arrive composite ("Mailer - WIRELESS CALLER") — so collect them all
 * and let the classifier decide. */
function queueNamesOf(record) {
  const names = [];
  for (const leg of record?.legs || []) {
    if (leg.legType !== "Accept") continue;
    for (const n of [leg.to?.name, leg.from?.name]) {
      const v = String(n || "").trim();
      if (v) names.push(v);
    }
  }
  return names;
}

/** Back-compat single-name accessor. */
function queueNameOf(record) {
  return queueNamesOf(record)[0] || null;
}

/** First name on the record that maps to a known stream. */
function classifyRecordStream(record) {
  const names = queueNamesOf(record);
  for (const n of names) {
    const key = classifyStream(n);
    if (key) return { key, queueName: n };
  }
  return { key: null, queueName: names[0] || null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip the tenant suffix so "Bruce Allen - TAG" folds into "Bruce Allen". */
function normalizeAgentName(name) {
  return String(name || "")
    .replace(/\s*-\s*(TAG|WYNN|AMITY)\s*$/i, "")
    .trim();
}

function isMailerQueueCall(record, patterns) {
  for (const leg of record?.legs || []) {
    if (leg.legType !== "Accept") continue;
    const name = leg.to?.name || leg.from?.name || "";
    if (patterns.some((re) => re.test(String(name).trim()))) return true;
  }
  return false;
}

/** The answering party: the leg that actually connected, named. */
function connectedAgent(record) {
  for (const leg of record?.legs || []) {
    if (leg.result !== "Call connected") continue;
    const name = normalizeAgentName(leg.to?.name);
    if (name) return name;
  }
  return null;
}

/**
 * Read mailer-queue connections for a day.
 *
 * Returns counts only — no per-piece breakdown, because piece economics and
 * agent performance are different questions and joining them per-piece
 * multiplies RC traffic for no analytical gain.
 */
async function readMailerQueueConnections({
  dateKey,
  queuePatterns = DEFAULT_QUEUE_PATTERNS,
  perPage = 250,
  maxPages = 8,
  pageDelayMs = 1500,
  client = null,
  logger = null,
} = {}) {
  const rc = client || createRingCentralClient();
  await rc.ensureAuthenticated();

  const out = {
    queueCalls: 0,
    connected: 0,
    missed: 0,
    byAgent: {},
    pagesFetched: 0,
    truncated: false,
    rateLimited: false,
  };

  for (let page = 1; page <= maxPages; page += 1) {
    let payload;
    try {
      payload = await rc.apiRequest("GET", "/restapi/v1.0/account/~/call-log", {
        query: {
          dateFrom: `${dateKey}T07:00:00.000Z`,
          dateTo: `${dateKey}T23:59:59.000Z`,
          view: "Detailed",
          direction: "Inbound",
          perPage,
          page,
        },
      });
    } catch (error) {
      // A 429 means back off entirely — never retry into a rate limit.
      if (/429/.test(String(error.message))) {
        out.rateLimited = true;
        logger?.warn?.("mailer_queue.rate_limited", { dateKey, page });
      } else {
        logger?.warn?.("mailer_queue.read_failed", { dateKey, page, error: String(error.message).slice(0, 140) });
      }
      out.truncated = true;
      break;
    }

    const records = payload?.records || [];
    out.pagesFetched = page;

    for (const record of records) {
      if (!isMailerQueueCall(record, queuePatterns)) continue;
      out.queueCalls += 1;
      const agent = connectedAgent(record);
      if (agent) {
        out.connected += 1;
        out.byAgent[agent] = (out.byAgent[agent] || 0) + 1;
      } else {
        out.missed += 1;
      }
    }

    if (records.length < perPage) break;         // last page
    if (page === maxPages) out.truncated = true; // hit the cap
    else await sleep(pageDelayMs);               // trickle, never hammer
  }

  return out;
}

/**
 * Join the two halves: CallRail says how many mail calls (and what they
 * cost); RingCentral says who connected. Cost-per-call is an AGGREGATE —
 * mail spend over mail calls — then attributed by connection share.
 */
function buildMailerPerformance({ mailSpend = 0, mailCalls = 0, queue = null } = {}) {
  const costPerCall = mailCalls > 0 && mailSpend > 0
    ? Math.round((mailSpend / mailCalls) * 100) / 100
    : null;
  const rows = Object.entries(queue?.byAgent || {})
    .map(([agent, connections]) => ({
      agent,
      connections,
      shareOfConnected: queue?.connected ? Math.round((connections / queue.connected) * 1000) / 10 : null,
      // What that agent's share of the mail spend bought, at the aggregate
      // rate. NOT a commission and NOT a cost attribution to the person —
      // it is "this much marketing money reached this agent's phone".
      valueHandled: costPerCall != null ? Math.round(connections * costPerCall * 100) / 100 : null,
    }))
    .sort((a, b) => b.connections - a.connections);

  return {
    costPerCall,
    mailSpend,
    mailCalls,
    queueCalls: queue?.queueCalls ?? null,
    connected: queue?.connected ?? null,
    missed: queue?.missed ?? null,
    answerRate: queue?.queueCalls ? Math.round((queue.connected / queue.queueCalls) * 1000) / 10 : null,
    rows,
    partial: Boolean(queue?.truncated || queue?.rateLimited),
  };
}

/**
 * Agent performance BY STREAM — one bounded read, every paid stream.
 *
 * Same trickle discipline as the mailer read: one page at a time, sleep
 * between pages, hard cap, abort on 429.
 */
async function readStreamConnections({
  dateKey, perPage = 250, maxPages = 8, pageDelayMs = 1500, client = null, logger = null,
} = {}) {
  const rc = client || createRingCentralClient();
  await rc.ensureAuthenticated();

  const out = {
    dateKey,
    streams: {},          // key → { calls, connected, missed, byAgent }
    unmatchedQueues: {},  // queue name → count (so a new queue is visible)
    pagesFetched: 0, truncated: false, rateLimited: false,
  };
  const bucket = (key) => (out.streams[key] = out.streams[key]
    || { key, label: STREAMS.find((s) => s.key === key)?.label || key, calls: 0, connected: 0, missed: 0, byAgent: {} });

  for (let page = 1; page <= maxPages; page += 1) {
    let payload;
    try {
      payload = await rc.apiRequest("GET", "/restapi/v1.0/account/~/call-log", {
        query: {
          dateFrom: `${dateKey}T07:00:00.000Z`, dateTo: `${dateKey}T23:59:59.000Z`,
          view: "Detailed", direction: "Inbound", perPage, page,
        },
      });
    } catch (error) {
      if (/429/.test(String(error.message))) {
        out.rateLimited = true;
        logger?.warn?.("stream_queue.rate_limited", { dateKey, page });
      } else {
        logger?.warn?.("stream_queue.read_failed", { dateKey, page, error: String(error.message).slice(0, 140) });
      }
      out.truncated = true;
      break;
    }

    const records = payload?.records || [];
    out.pagesFetched = page;
    for (const record of records) {
      const { key, queueName } = classifyRecordStream(record);
      if (!key) {
        if (queueName) out.unmatchedQueues[queueName] = (out.unmatchedQueues[queueName] || 0) + 1;
        continue;
      }
      const b = bucket(key);
      b.calls += 1;
      const agent = connectedAgent(record);
      if (agent) { b.connected += 1; b.byAgent[agent] = (b.byAgent[agent] || 0) + 1; }
      else b.missed += 1;
    }

    if (records.length < perPage) break;
    if (page === maxPages) out.truncated = true;
    else await sleep(pageDelayMs);
  }
  return out;
}

/**
 * Agent × stream matrix, with a cost basis where one exists.
 *   MAILER → mail spend / mail calls (aggregate)
 *   BCD    → fixed rate per call (pay-per-call vendor)
 * Streams with no cost basis still report connections — volume is useful
 * even when the money question does not apply.
 */
function buildStreamPerformance({ streams = {}, costBasis = {} } = {}) {
  const rows = [];
  const agents = new Map();
  for (const [key, s] of Object.entries(streams)) {
    const rate = costBasis[key] ?? null;
    rows.push({
      key, label: s.label, calls: s.calls, connected: s.connected, missed: s.missed,
      answerRate: s.calls ? Math.round((s.connected / s.calls) * 1000) / 10 : null,
      costPerCall: rate,
      spendHandled: rate != null ? Math.round(s.connected * rate * 100) / 100 : null,
    });
    for (const [agent, n] of Object.entries(s.byAgent)) {
      if (!agents.has(agent)) agents.set(agent, { agent, total: 0, byStream: {}, valueHandled: 0 });
      const a = agents.get(agent);
      a.total += n;
      a.byStream[key] = n;
      if (rate != null) a.valueHandled = Math.round((a.valueHandled + n * rate) * 100) / 100;
    }
  }
  return {
    streams: rows.sort((a, b) => b.calls - a.calls),
    agents: [...agents.values()].sort((a, b) => b.total - a.total),
  };
}

/** Fold PhoneBurner agent ids ("chris_bolt") onto display names so the LD
 * stream can sit in the same table as the RC queues. */
function normalizePhoneBurnerAgent(agentId) {
  return String(agentId || "")
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")
    .trim();
}

/**
 * The three paid streams in one table: MAILER + BCD from the EX queues,
 * LD from PhoneBurner's own dial records.
 *
 * `ldDials` is the shape readLdDials returns ({ byAgent, dials, connected }).
 */
function buildAgentPerformanceByStream({
  streams = {}, ldDials = null, costBasis = {},
} = {}) {
  const merged = { ...streams };
  if (ldDials && (ldDials.connected || ldDials.dials)) {
    const byAgent = {};
    for (const [id, n] of Object.entries(ldDials.byAgent || {})) {
      const name = normalizePhoneBurnerAgent(id);
      byAgent[name] = (byAgent[name] || 0) + n;
    }
    merged.LD = {
      key: "LD", label: "LD / PhoneBurner",
      calls: ldDials.dials || 0,
      connected: ldDials.connected || 0,
      missed: Math.max(0, (ldDials.dials || 0) - (ldDials.connected || 0)),
      byAgent,
      source: "phoneburner",
    };
  }
  return buildStreamPerformance({ streams: merged, costBasis });
}

module.exports = {
  DEFAULT_QUEUE_PATTERNS,
  buildAgentPerformanceByStream,
  normalizePhoneBurnerAgent,
  STREAMS,
  buildStreamPerformance,
  classifyRecordStream,
  classifyStream,
  queueNameOf,
  queueNamesOf,
  readStreamConnections,
  buildMailerPerformance,
  connectedAgent,
  isMailerQueueCall,
  normalizeAgentName,
  readMailerQueueConnections,
};
