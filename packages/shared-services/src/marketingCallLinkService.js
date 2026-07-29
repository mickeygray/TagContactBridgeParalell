"use strict";

// CAPTURE THE DAY'S MARKETING CALL LINKS, THEN READ ANY RANGE FROM MONGO.
//
// Mickey 2026-07-29: "you have a pool of links and those are attached to the
// call. so youre grabbing and organzing the link info for marketing calls."
//
// CallRail hands out recording URLs ONE CALL AT A TIME — `getCallRecording(id)`
// per call — so any report wanting listen links pays a round-trip per call
// every time it runs. A finished call's URL never changes, so capturing it
// once a night turns that into a Mongo read and the link survives whether or
// not a report ever asks for that day.
//
// MARKETING ONLY. CallRail also tracks servicing lines ("Client Contact -
// TAG", 26 calls in July). Those are real calls but they are not marketing,
// and letting them into the pool is how an existing client ringing support
// starts to look like a fresh response.

const MarketingCallLink = require("../../shared-models/src/MarketingCallLink");
const { sourceChannel } = require("../../shared-config/src/activeSources");

const DAY_MS = 86400000;

function dayKeys(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Pull one day's marketing calls and their recording links.
 *
 * `apply: false` does everything except write, so the nightly task can show
 * what it would capture.
 */
async function captureCallLinks({
  dateKey, domain = "TAG", apply = false, concurrency = 3, logger = null,
} = {}) {
  const { createCallrailClient } = require("../../shared-integrations/src");
  const { mapLimit } = require("./paymentTruthService");
  const dom = String(domain).toUpperCase();
  const cr = createCallrailClient(dom);

  const stats = {
    dateKey, domain: dom, calls: 0, marketing: 0, servicing: 0,
    withRecording: 0, noRecording: 0, alreadyHad: 0, written: 0, failed: 0,
  };

  let res = null;
  try {
    res = await cr.listInboundCallsForRange({ startDate: dateKey, endDate: dateKey });
  } catch (error) {
    logger?.warn?.("call_links.callrail_unavailable", { dateKey, error: String(error.message).slice(0, 120) });
    return { ...stats, error: String(error.message).slice(0, 160) };
  }

  const calls = res?.calls || [];
  stats.calls = calls.length;

  // Only calls that arrived on a tracked MARKETING line.
  const marketing = calls.filter((c) => {
    const ch = sourceChannel(c.source_name);
    if (ch === "other") { stats.servicing += 1; return false; }
    return true;
  });
  stats.marketing = marketing.length;

  // Which of these do we already hold? Skips the per-call round-trip entirely
  // on a re-run — the point of the pool.
  const existing = await MarketingCallLink.find({
    domain: dom, callId: { $in: marketing.map((c) => String(c.id)) },
  }).select("callId listenUrl").lean();
  const have = new Map(existing.map((e) => [e.callId, e.listenUrl]));

  const rows = await mapLimit(marketing, Math.max(1, concurrency), async (c) => {
    const callId = String(c.id);
    let listenUrl = have.get(callId) ?? null;
    if (listenUrl) stats.alreadyHad += 1;
    else {
      try {
        listenUrl = (await cr.getCallRecording(c.id))?.url || null;
      } catch {
        // No recording is a FACT (unanswered, too short), not a failure.
        listenUrl = null;
      }
    }
    if (listenUrl) stats.withRecording += 1; else stats.noRecording += 1;
    return {
      domain: dom,
      callId,
      dateKey,
      phone: c.customer_phone_number || null,
      callerName: c.customer_name || null,
      source: c.source_name || null,
      sourceChannel: sourceChannel(c.source_name),
      startedAt: c.start_time ? new Date(c.start_time) : null,
      durationSec: Number(c.duration) || 0,
      answered: c.answered === undefined ? null : Boolean(c.answered),
      listenUrl,
    };
  });

  if (apply && rows.length) {
    try {
      await MarketingCallLink.bulkWrite(rows.map((r) => ({
        updateOne: {
          filter: { domain: r.domain, callId: r.callId },
          // $set so a re-capture converges on the same row rather than
          // duplicating, and a later capture can fill a link that was
          // missing the first time.
          update: { $set: { ...r, capturedAt: new Date() } },
          upsert: true,
        },
      })), { ordered: false });
      stats.written = rows.length;
    } catch (error) {
      stats.failed = rows.length;
      logger?.error?.("call_links.write_failed", { dateKey, error: String(error.message).slice(0, 160) });
    }
  }

  return { ...stats, rows };
}

/**
 * Read links for a range straight from the pool. No CallRail calls.
 *
 * Reports coverage rather than silently returning whatever happens to be
 * stored — a half-captured range presented as complete is the failure this
 * whole exercise keeps circling.
 */
async function readCallLinks({
  from, to, domain = "TAG", minDurationSec = 0, channel = null, phones = null,
} = {}) {
  const dom = String(domain).toUpperCase();
  const query = {
    domain: dom,
    dateKey: { $gte: from, $lte: to },
    listenUrl: { $ne: null },
  };
  if (minDurationSec > 0) query.durationSec = { $gte: minDurationSec };
  if (channel) query.sourceChannel = channel;
  if (phones?.length) query.phone = { $in: phones };

  const links = await MarketingCallLink.find(query).sort({ durationSec: -1 }).lean();
  const wanted = dayKeys(from, to);
  const captured = await MarketingCallLink.distinct("dateKey", {
    domain: dom, dateKey: { $gte: from, $lte: to },
  });
  const missing = wanted.filter((d) => !captured.includes(d));

  return {
    links,
    coverage: {
      daysRequested: wanted.length,
      daysCaptured: captured.length,
      missing,
      complete: missing.length === 0,
    },
  };
}

module.exports = { captureCallLinks, dayKeys, readCallLinks };
