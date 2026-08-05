"use strict";

// CONFIRM A RANGE'S STATUS MOVEMENT AGAINST WHAT IS TRUE RIGHT NOW.
//
// Mickey 2026-08-05: "you can aggregate certain facts, but need to run
// activities over the range to confirm certain things that may have been cleaned
// up ... you check the month, get 100 cases, run get-case-by-id, look at its
// status and record it as its status as of right now."
//
// This is the events-vs-state rule made operational for ranges. A stored day
// says a case went DNC on the 3rd — that is an EVENT and it stays true forever.
// Whether that case is still a redline on the 30th is STATE, and this system
// does not serve state from Mongo. So the range supplies the candidates and
// Logics supplies the answer.
//
// ── WHY THIS IS AFFORDABLE, AND WHY IT IS NOT A LOOP OVER THE REPORT ────────
//
// The candidate set is bounded by what MOVED, not by how many cases exist: a
// month of redlines is ~100 cases, not 20,000. That is the whole reason the
// per-case fan-out is acceptable here when it would be indefensible against the
// ActivityReport — which is range-native and must never be called per case.
//
// ── THE RULE THAT MATTERS MOST ──────────────────────────────────────────────
//
// A CASE WE COULD NOT READ IS NOT A CASE THAT WAS CLEARED. An unreadable case
// stays in the list marked `unreadable`, never quietly dropped. Dropping it
// would turn a Logics outage into a suspiciously clean chase list — the exact
// shape of wrong answer this codebase keeps having to correct.

const { createLogicsFacade } = require("./logicsFacadeService");

const DEFAULT_CONCURRENCY = 3;

/** Bounded parallel map. Keeps the fan-out from becoming a stampede. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const pick = (obj, ...keys) => {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return null;
};

/**
 * Look up each case's CURRENT status and record it as of now.
 *
 * @param {Array}  cases        [{ domain, caseId, lane }] — the range's movers
 * @param {number} concurrency  parallel Logics reads (default 3)
 * @param {Function} [facadeFor] injectable for tests
 * @returns {{asOf, checked, rows, unreadable, byDomain}}
 */
async function confirmStatusNow({
  cases = [],
  concurrency = DEFAULT_CONCURRENCY,
  facadeFor = createLogicsFacade,
  logger = null,
} = {}) {
  const asOf = new Date();
  if (!cases.length) {
    return { asOf, checked: 0, rows: [], unreadable: 0, byDomain: {} };
  }

  // One case may appear in two lanes (dnc AND suspended). Read it ONCE and fan
  // the answer back out — the status is a property of the case, not the lane.
  const byCase = new Map();
  for (const c of cases) {
    if (c?.caseId == null) continue;
    const key = `${String(c.domain || "").toUpperCase()}:${c.caseId}`;
    if (!byCase.has(key)) byCase.set(key, { domain: String(c.domain || "").toUpperCase(), caseId: c.caseId, lanes: [] });
    if (c.lane) byCase.get(key).lanes.push(c.lane);
  }
  const unique = [...byCase.values()];

  // Facades are per-domain and worth building once rather than per case.
  const facades = new Map();
  const facadeOf = (domain) => {
    if (!facades.has(domain)) facades.set(domain, facadeFor(domain));
    return facades.get(domain);
  };

  const rows = await mapLimit(unique, Math.max(1, concurrency), async (c) => {
    try {
      const info = await facadeOf(c.domain).fetchCaseInfo(c.caseId);
      if (!info) {
        return { ...c, statusNow: null, statusIdNow: null, unreadable: true, reason: "no-case-info" };
      }
      return {
        ...c,
        statusIdNow: Number(pick(info, "StatusID", "statusId", "Status")) || null,
        statusNow: pick(info, "StatusName", "statusName", "StatusLabel", "Status") || null,
        unreadable: false,
        reason: null,
      };
    } catch (error) {
      // NOT cleared. Unreadable.
      logger?.warn?.("status_confirm.case_unreadable", { domain: c.domain, caseId: c.caseId });
      return {
        ...c, statusNow: null, statusIdNow: null, unreadable: true,
        reason: String(error.message || error).slice(0, 120),
      };
    }
  });

  const byDomain = {};
  for (const r of rows) {
    byDomain[r.domain] = byDomain[r.domain] || { checked: 0, unreadable: 0 };
    byDomain[r.domain].checked += 1;
    if (r.unreadable) byDomain[r.domain].unreadable += 1;
  }

  return {
    asOf,
    checked: rows.length,
    rows,
    unreadable: rows.filter((r) => r.unreadable).length,
    byDomain,
  };
}

/**
 * Split a confirmed set into what is still outstanding and what has been worked.
 *
 * `stillInLane` decides, per lane, whether a current status still counts as that
 * lane — supplied by the caller because the status-id mapping is per tenant and
 * belongs with the tenant config, not here.
 *
 * Unreadable cases go in their OWN bucket. They are neither confirmed nor
 * cleared, and forcing them into either is how an outage becomes a wrong board.
 */
function splitConfirmed(rows = [], stillInLane) {
  const outstanding = [];
  const cleared = [];
  const unknown = [];
  for (const r of rows) {
    if (r.unreadable) { unknown.push(r); continue; }
    const lanes = r.lanes?.length ? r.lanes : [null];
    const anyStill = lanes.some((lane) => stillInLane(r, lane));
    (anyStill ? outstanding : cleared).push(r);
  }
  return { outstanding, cleared, unknown };
}

module.exports = { confirmStatusNow, splitConfirmed, mapLimit };
