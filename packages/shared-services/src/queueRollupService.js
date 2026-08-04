"use strict";

// CAPTURE ONE DAY OF QUEUE ACTIVITY, THEN READ ANY RANGE FROM MONGO.
//
// Mickey 2026-07-28: "that might be something i dont mind building and storing
// is that agent calls taken via rc."
//
// The problem this solves: RingCentral answers per DAY and rate-limits hard,
// so a month of per-agent call counts costs ~28 paged reads. That is why the
// work log refused ranges over 7 days — and why, before the guard existed, it
// rendered a month as "0 taken, 0 made" for people who had taken dozens of
// calls.
//
// Capture is the nightly half; `readQueueRange` is the reporting half. The
// reporting half NEVER calls RingCentral.

const DailyQueueRollup = require("../../shared-models/src/DailyQueueRollup");
const { canonicalStaffName } = require("../../shared-config/src/staffRoster");

const DAY_MS = 86400000;
const CAPTURE_VERSION = 2;

function dayKeys(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const INBOUND_STREAMS = new Set(["MAILER", "BCD"]);

function countOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function safeReason(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 160) : null;
}

function canonicalQueueAgentName(name) {
  const trimmed = String(name || "")
    .replace(/\s*-\s*(TAG|WYNN|AMITY)\s*$/i, "")
    .trim();
  return canonicalStaffName(trimmed) || trimmed;
}

function normalizeSourceStatus(value, fallback = "complete") {
  const allowed = new Set(["complete", "partial", "unavailable"]);
  const status = allowed.has(value?.status) ? value.status : fallback;
  return { status, reason: safeReason(value?.reason) };
}

/** Reduce a captured day to the durable, count-only contract. */
function normalizeQueueDay(day, dateKey = day?.dateKey) {
  const normalizedDateKey = String(dateKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDateKey)) {
    throw new Error("queue rollup dateKey must be YYYY-MM-DD");
  }
  if (day?.dateKey && String(day.dateKey) !== normalizedDateKey) {
    throw new Error("queue rollup day does not match dateKey");
  }

  const agents = new Map();
  for (const input of day?.agents || []) {
    const agent = canonicalQueueAgentName(input?.agent);
    if (!agent) continue;
    const row = agents.get(agent) || { agent, taken: 0, made: 0, byStream: {} };
    row.taken += countOf(input?.taken);
    row.made += countOf(input?.made);
    for (const [stream, count] of Object.entries(input?.byStream || {})) {
      const key = String(stream || "").trim().toUpperCase();
      if (key) row.byStream[key] = (row.byStream[key] || 0) + countOf(count);
    }
    agents.set(agent, row);
  }

  const streams = new Map();
  for (const input of day?.streams || []) {
    const stream = String(input?.stream || "").trim().toUpperCase();
    if (!stream) continue;
    const row = streams.get(stream) || { stream, calls: 0, connected: 0, missed: 0 };
    row.calls += countOf(input?.calls);
    row.connected += countOf(input?.connected);
    row.missed += countOf(input?.missed);
    streams.set(stream, row);
  }

  const unavailable = Boolean(day?.unavailable);
  const partial = Boolean(day?.partial);
  return {
    dateKey: normalizedDateKey,
    agents: [...agents.values()],
    streams: [...streams.values()],
    captureVersion: CAPTURE_VERSION,
    sourceStatus: {
      ringCentral: normalizeSourceStatus(
        day?.sourceStatus?.ringCentral,
        unavailable ? "unavailable" : (partial ? "partial" : "complete"),
      ),
      phoneBurner: normalizeSourceStatus(
        day?.sourceStatus?.phoneBurner,
        unavailable ? "unavailable" : "complete",
      ),
    },
    capturedAt: day?.capturedAt ? new Date(day.capturedAt) : new Date(),
    partial,
    partialReason: safeReason(day?.partialReason),
    unavailable,
    unavailableReason: safeReason(day?.unavailableReason),
  };
}

/**
 * Read one day from RingCentral and shape it. Does not write.
 *
 * Returns the same shape the live day-loop builds, so the capture and the
 * live path can be compared directly on any day both cover.
 */
async function captureQueueDay({ dateKey, logger = null } = {}) {
  const { readStreamConnections, normalizePhoneBurnerAgent } = require("./mailerQueueService");
  const { readLdDials } = require("./nightReportService");

  const byAgent = new Map();
  const row = (name) => {
    const key = canonicalQueueAgentName(name);
    if (!key) return null;
    if (!byAgent.has(key)) byAgent.set(key, { agent: key, taken: 0, made: 0, byStream: {} });
    return byAgent.get(key);
  };

  const streams = [];
  let partial = false;
  const partialReasons = [];
  let unavailable = false;
  const unavailableReasons = [];
  const sourceStatus = {};

  try {
    const q = await readStreamConnections({ dateKey, maxPages: 6, logger });
    for (const [key, s] of Object.entries(q.streams || {})) {
      streams.push({
        stream: key, calls: s.calls || 0, connected: s.connected || 0, missed: s.missed || 0,
      });
      for (const [agent, n] of Object.entries(s.byAgent || {})) {
        const r = row(agent);
        if (!r) continue;
        r.byStream[key] = (r.byStream[key] || 0) + n;
        if (INBOUND_STREAMS.has(key)) r.taken += n;
        else r.made += n;
      }
    }
    if ((q.rateLimited || q.truncated) && !q.pagesFetched) {
      unavailable = true;
      const reason = q.rateLimited ? "rate limited before first page" : "read failed before first page";
      unavailableReasons.push(`RingCentral ${reason}`);
      sourceStatus.ringCentral = { status: "unavailable", reason };
    } else if (q.rateLimited || q.truncated) {
      partial = true;
      const reason = q.rateLimited ? "rate limited" : "truncated";
      partialReasons.push(`RingCentral ${reason}`);
      sourceStatus.ringCentral = { status: "partial", reason };
    } else {
      sourceStatus.ringCentral = { status: "complete", reason: null };
    }
  } catch (error) {
    unavailable = true;
    unavailableReasons.push("RingCentral unavailable");
    sourceStatus.ringCentral = {
      status: "unavailable",
      reason: safeReason(error?.code || error?.name || "request failed"),
    };
  }

  try {
    const ld = await readLdDials(dateKey);
    for (const [id, n] of Object.entries(ld.byAgent || {})) {
      const r = row(normalizePhoneBurnerAgent(id));
      if (!r) continue;
      r.byStream.LD = (r.byStream.LD || 0) + n;
      r.made += n;
    }
    sourceStatus.phoneBurner = { status: "complete", reason: null };
  } catch (error) {
    unavailable = true;
    unavailableReasons.push("PhoneBurner dials unavailable");
    sourceStatus.phoneBurner = {
      status: "unavailable",
      reason: safeReason(error?.code || error?.name || "request failed"),
    };
  }

  return normalizeQueueDay({
    dateKey,
    agents: [...byAgent.values()],
    streams,
    sourceStatus,
    capturedAt: new Date(),
    partial,
    partialReason: partialReasons.join("; ") || null,
    unavailable,
    unavailableReason: unavailableReasons.join("; ") || null,
  });
}

/** Capture and store. Idempotent: re-running a day replaces that day. */
async function persistQueueDay({ dateKey = null, day = null, logger = null } = {}) {
  const captured = day || await captureQueueDay({ dateKey, logger });
  const normalized = normalizeQueueDay(captured, dateKey || captured?.dateKey);
  await DailyQueueRollup.updateOne(
    { dateKey: normalized.dateKey },
    { $set: normalized },
    { upsert: true },
  );
  return normalized;
}

function mergeQueueRollups({ docs = [], from, to } = {}) {
  const wanted = dayKeys(from, to);
  const have = new Set(docs.map((d) => d.dateKey));
  const missing = wanted.filter((d) => !have.has(d));

  const byAgent = {};
  const streams = {};
  for (const doc of docs) {
    for (const a of doc.agents || []) {
      const agent = canonicalQueueAgentName(a.agent);
      if (!agent) continue;
      byAgent[agent] = byAgent[agent] || {};
      for (const [k, n] of Object.entries(a.byStream || {})) {
        byAgent[agent][k] = (byAgent[agent][k] || 0) + countOf(n);
      }
    }
    for (const s of doc.streams || []) {
      streams[s.stream] = streams[s.stream] || { calls: 0, connected: 0, missed: 0 };
      streams[s.stream].calls += countOf(s.calls);
      streams[s.stream].connected += countOf(s.connected);
      streams[s.stream].missed += countOf(s.missed);
    }
  }

  const sortedUniqueDays = (values) => [...new Set(values)].sort();
  const partialDays = sortedUniqueDays(docs.filter((d) => d.partial).map((d) => d.dateKey));
  const unavailableDays = sortedUniqueDays(docs.filter((d) => d.unavailable
    || d.sourceStatus?.ringCentral?.status === "unavailable"
    || d.sourceStatus?.phoneBurner?.status === "unavailable").map((d) => d.dateKey));
  const legacyDays = sortedUniqueDays(docs.filter((d) => countOf(d.captureVersion) < CAPTURE_VERSION)
    .map((d) => d.dateKey));

  return {
    queueByAgent: byAgent,
    queueStreams: streams,
    coverage: {
      daysRequested: wanted.length,
      daysStored: have.size,
      missing,
      partialDays,
      unavailableDays,
      legacyDays,
      complete: missing.length === 0
        && partialDays.length === 0
        && unavailableDays.length === 0
        && legacyDays.length === 0,
    },
  };
}

/**
 * Any range, from Mongo, with NO RingCentral calls.
 *
 * Reports which days are missing rather than silently summing the ones that
 * exist — a 12-of-28-day month presented as a month is the failure this whole
 * exercise was about.
 */
async function readQueueRange({ from, to } = {}) {
  const docs = await DailyQueueRollup.find({ dateKey: { $gte: from, $lte: to } }).lean();
  return mergeQueueRollups({ docs, from, to });
}

module.exports = {
  CAPTURE_VERSION,
  canonicalQueueAgentName,
  captureQueueDay,
  dayKeys,
  mergeQueueRollups,
  normalizeQueueDay,
  persistQueueDay,
  readQueueRange,
};
