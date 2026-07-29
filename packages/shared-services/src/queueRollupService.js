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

const DAY_MS = 86400000;

function dayKeys(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const INBOUND_STREAMS = new Set(["MAILER", "BCD"]);

/**
 * Read one day from RingCentral and shape it. Does not write.
 *
 * Returns the same shape the live day-loop builds, so the capture and the
 * live path can be compared directly on any day both cover.
 */
async function captureQueueDay({ dateKey, logger = null } = {}) {
  const { readStreamConnections, normalizePhoneBurnerAgent } = require("./mailerQueueService");
  const { readLdDials } = require("./nightReportService");
  const { canonicalStaffName } = require("../../shared-config/src/staffRoster");

  const byAgent = new Map();
  const row = (name) => {
    const key = canonicalStaffName(name);
    if (!byAgent.has(key)) byAgent.set(key, { agent: key, taken: 0, made: 0, byStream: {} });
    return byAgent.get(key);
  };

  const streams = [];
  let partial = false;
  let partialReason = null;

  const q = await readStreamConnections({ dateKey, maxPages: 6, logger });
  for (const [key, s] of Object.entries(q.streams || {})) {
    streams.push({
      stream: key, calls: s.calls || 0, connected: s.connected || 0, missed: s.missed || 0,
    });
    for (const [agent, n] of Object.entries(s.byAgent || {})) {
      const r = row(agent);
      r.byStream[key] = (r.byStream[key] || 0) + n;
      if (INBOUND_STREAMS.has(key)) r.taken += n;
      else r.made += n;
    }
  }
  if (q.rateLimited || q.truncated) {
    // A floor is not a total. Any range containing this day has to say so.
    partial = true;
    partialReason = q.rateLimited ? "rate limited" : "truncated";
  }

  try {
    const ld = await readLdDials(dateKey);
    for (const [id, n] of Object.entries(ld.byAgent || {})) {
      const r = row(normalizePhoneBurnerAgent(id));
      r.byStream.LD = (r.byStream.LD || 0) + n;
      r.made += n;
    }
  } catch (error) {
    partial = true;
    partialReason = `LD dials unavailable — ${String(error.message).slice(0, 60)}`;
  }

  return { dateKey, agents: [...byAgent.values()], streams, partial, partialReason };
}

/** Capture and store. Idempotent: re-running a day replaces that day. */
async function persistQueueDay({ dateKey, logger = null } = {}) {
  const day = await captureQueueDay({ dateKey, logger });
  await DailyQueueRollup.updateOne(
    { dateKey },
    { $set: { ...day, capturedAt: new Date() } },
    { upsert: true },
  );
  return day;
}

/**
 * Any range, from Mongo, with NO RingCentral calls.
 *
 * Reports which days are missing rather than silently summing the ones that
 * exist — a 12-of-28-day month presented as a month is the failure this whole
 * exercise was about.
 */
async function readQueueRange({ from, to } = {}) {
  const wanted = dayKeys(from, to);
  const docs = await DailyQueueRollup.find({ dateKey: { $gte: from, $lte: to } }).lean();
  const have = new Set(docs.map((d) => d.dateKey));
  const missing = wanted.filter((d) => !have.has(d));

  const byAgent = {};
  const streams = {};
  for (const doc of docs) {
    for (const a of doc.agents || []) {
      byAgent[a.agent] = byAgent[a.agent] || {};
      for (const [k, n] of Object.entries(a.byStream || {})) {
        byAgent[a.agent][k] = (byAgent[a.agent][k] || 0) + n;
      }
    }
    for (const s of doc.streams || []) {
      streams[s.stream] = streams[s.stream] || { calls: 0, connected: 0, missed: 0 };
      streams[s.stream].calls += s.calls || 0;
      streams[s.stream].connected += s.connected || 0;
      streams[s.stream].missed += s.missed || 0;
    }
  }

  const partialDays = docs.filter((d) => d.partial).map((d) => d.dateKey);
  return {
    queueByAgent: byAgent,
    queueStreams: streams,
    coverage: {
      daysRequested: wanted.length,
      daysStored: docs.length,
      missing,
      partialDays,
      // Complete ONLY when every requested day is present and whole. The
      // report layer keys its "unavailable" wording off this.
      complete: missing.length === 0 && partialDays.length === 0,
    },
  };
}

module.exports = {
  captureQueueDay,
  dayKeys,
  persistQueueDay,
  readQueueRange,
};
