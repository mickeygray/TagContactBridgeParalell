"use strict";

// BCD — pay-per-call. Calls ARE the cost basis: calls x $4.
//
// Mickey 2026-07-28: "adding back bcd today which is approximately the number
// of calls *4."  Mickey 2026-08-03: "fix bcd there is a few different versions
// but right now they are dialing on bcd v3."
//
// ── WHY THIS IS A SERVICE AND NOT A REGEX ──────────────────────────────────
//
// The matcher was `/^bcd$/i`, an EXACT match. The vendor moved to a piece
// named "BCD V3" and the board silently reported BCD 0 calls / $0.00 — while
// those calls, filed under channel "mailer" with syncSource "callrail-direct",
// were quietly summed into MAIL responses instead. So BCD's cost vanished and
// mail's cost-per-response was computed against calls it never bought.
//
// The obvious fix — loosen to /^bcd\b/i — DOUBLE COUNTS, which is worse.
// Both rows coexisted during the changeover:
//
//     date      legacy "BCD" (channel bcd)    "BCD V3" (callrail-direct)
//     07-27                              2                            2
//     07-28                              9                            9
//     07-29                              1                           10   <- legacy went stale
//     07-30                              -                           14
//
// 07-29 is the tell: the legacy row was no longer being maintained, so it is
// not merely a duplicate — it is a WRONG duplicate. Summing both would have
// billed 11 calls on a day with 10.
//
// So the rule is per-day PREFERENCE, not a filter: when a day has a
// callrail-direct row, that row is the truth and the legacy row is ignored.
// A blanket `syncSource: "callrail-direct"` filter would instead zero out
// every day before the changeover, quietly rewriting history.

const DEFAULT_BCD_COST_PER_CALL = 4;

function bcdCostPerCall() {
  const parsed = Number(process.env.BCD_COST_PER_CALL);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BCD_COST_PER_CALL;
}

/**
 * Is this piece/source name a BCD line, in any of its versions?
 *
 * Word-boundary anchored: matches "BCD", "BCD V3", "BCD v4", "BCD Legacy" —
 * and NOT "BCDX" or a piece that merely starts with those letters.
 */
function isBcdPiece(name) {
  return /^bcd\b/i.test(String(name || "").trim());
}

/** The Mongo condition that finds every BCD row, any version. */
const BCD_MATCH = Object.freeze({
  $or: [{ channel: "bcd" }, { piece: /^bcd\b/i }],
});

/**
 * Collapse raw rows to one call count per day, preferring the live feed.
 *
 * Exported so it can be tested without a database — the double-count this
 * prevents is invisible in aggregate and only shows up on changeover days.
 */
function foldBcdRows(rows = []) {
  const byDay = {};
  for (const r of rows) {
    const day = String(r.date || "").slice(0, 10) || "-";
    const live = String(r.syncSource || "") === "callrail-direct";
    const e = byDay[day] || (byDay[day] = { live: 0, legacy: 0, hasLive: false });
    if (live) { e.live += Number(r.totalCalls) || 0; e.hasLive = true; }
    else e.legacy += Number(r.totalCalls) || 0;
  }
  const callsByDay = {};
  let calls = 0;
  for (const [day, e] of Object.entries(byDay)) {
    // The live feed wins the whole day when it exists; see the header.
    const n = e.hasLive ? e.live : e.legacy;
    callsByDay[day] = n;
    calls += n;
  }
  return { calls, callsByDay, supersededLegacyDays: Object.entries(byDay)
    .filter(([, e]) => e.hasLive && e.legacy > 0).map(([d]) => d) };
}

/**
 * Read BCD calls and derive the cost for a date range, inclusive.
 *
 * `unavailable` distinguishes "no BCD calls" from "could not ask" — a zero
 * that means the vendor sent nothing and a zero that means the query failed
 * must never render the same.
 */
async function readBcdCalls({ from, to = from, DailyCallStat = null } = {}) {
  const Model = DailyCallStat || require("../../shared-models/src/DailyCallStat");
  const rate = bcdCostPerCall();
  try {
    const rows = await Model.find({
      date: { $gte: from, $lte: to },
      ...BCD_MATCH,
      active: { $ne: false },
    }).select("date piece channel syncSource totalCalls").lean();

    const { calls, callsByDay, supersededLegacyDays } = foldBcdRows(rows);
    const spendByDay = {};
    for (const [day, n] of Object.entries(callsByDay)) spendByDay[day] = Math.round(n * rate * 100) / 100;
    return {
      calls, rate, spend: Math.round(calls * rate * 100) / 100,
      callsByDay, spendByDay, rows: rows.length, supersededLegacyDays, unavailable: null,
    };
  } catch (error) {
    return {
      calls: 0, rate, spend: 0, callsByDay: {}, spendByDay: {}, rows: 0,
      supersededLegacyDays: [], unavailable: String(error.message).slice(0, 160),
    };
  }
}

module.exports = {
  readBcdCalls,
  foldBcdRows,
  isBcdPiece,
  bcdCostPerCall,
  BCD_MATCH,
  DEFAULT_BCD_COST_PER_CALL,
};
