"use strict";

// FORWARD-LOOKING SOURCE SANITIZER — put the mail piece INTO Logics.
//
// Mickey 2026-07-28: "this is the problem solved by setting the lead source to
// the mailer it was called on in logics … dont have to look it up again once
// you set it there" and "forward looking only cares about active pieces so
// those 3 can stay abc but updating the active leads for their piece is the
// idea. if its not in logics with a match skip it and for now its just those 3."
//
// DIRECTION OF THE JOIN — the whole design.
//
// The obvious version walks active cases asking each "what piece are you?".
// Measured: 12,670 cases for a 7-day window, and 106 of every 120 are
// freshly-opened [Active Prospect] shells with EVERY phone field blank —
// cell, home, work AND spouse. Nothing to match on, 12,670 Logics calls to
// find that out.
//
// Inverted, it is Mickey's sentence literally: the source IS the mailer it was
// called on. Start from the CallRail calls that landed on an active piece —
// a few hundred, each already carrying both the piece and the caller's
// number — then ask Logics whose case that number is. Measured on the same
// week: 52 cases moved off ABC instead of 2.
//
// RULES
//   · Only the ACTIVE pieces in LOGICS_SOURCE_REGISTRY are ever written.
//     Inactive pieces, near-miss names, unmapped tenants: skipped, left on
//     ABC. No fuzzy matching — the live library holds "URGENT THIRD PINK
//     DAY 1" and "Affordability Pink State" as genuinely DIFFERENT pieces.
//   · MONOTONIC: generic/absent → specific only. A case already carrying a
//     specific piece is never re-pointed, even by a newer call.
//   · A 404 from Logics is a FINDING (that caller is not a client), never an
//     error. Most inbound callers are strangers.

const { createLogicsClient, createCallrailClient } = require("../../shared-integrations/src");
const { unwrapLogics, mapLimit } = require("./paymentTruthService");
const {
  LOGICS_SOURCE_REGISTRY, resolveLogicsSourceId, writeLogicsCaseSource,
} = require("./logicsSourceWriterService");

const DAY_MS = 86400000;

const shiftKey = (key, d) => new Date(Date.parse(`${key}T00:00:00Z`) + d * DAY_MS).toISOString().slice(0, 10);

function pacificKey(at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

function dayKeys(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const last10 = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

/** 404 = "no such record". FindCaseByPhone 404s for every non-client caller. */
function isNotFound(error) {
  return error?.details?.responseStatus === 404
    || error?.status === 404
    || /: 404$/.test(String(error?.message || ""));
}

/** findCaseByPhone shapes vary; pull case ids out defensively. */
function caseIdsFrom(payload) {
  const data = unwrapLogics(payload);
  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  const ids = [];
  for (const r of rows) {
    const id = Number(r?.CaseID ?? r?.CaseId ?? r?.caseId);
    if (Number.isFinite(id) && id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Work out which cases should move off the catch-all. Read-only: this never
 * writes, so it is always safe to run and is what the runtime shows when it
 * is disarmed.
 *
 * @returns {{plan: Array, stats: object, inactivePieces: Array, window: object}}
 */
async function planSourceSanitization({
  domain = "TAG", from = null, to = null, days = 7,
  concurrency = 3, logger = null,
} = {}) {
  const dom = String(domain).toUpperCase();
  const registry = LOGICS_SOURCE_REGISTRY[dom];
  const window = {
    to: to || pacificKey(),
    from: from || shiftKey(to || pacificKey(), -Math.max(1, Number(days) || 7)),
    domain: dom,
  };
  const stats = {
    calls: 0, callers: 0, noCase: 0, alreadyTarget: 0,
    alreadyOtherSpecific: 0, unreadable: 0, planned: 0,
  };
  if (!registry) {
    return {
      plan: [], stats, inactivePieces: [], window,
      skipped: `no source registry for ${dom} — every piece would be skipped`,
    };
  }
  const ACTIVE_IDS = new Set(Object.values(registry));

  // ── 1. calls that landed on an ACTIVE piece ──
  const cr = createCallrailClient(dom);
  const byPhone = new Map();
  const seenSources = new Map();
  for (const day of dayKeys(window.from, window.to)) {
    let res = null;
    try {
      res = await cr.listInboundCallsForRange({ startDate: day, endDate: day });
    } catch (error) {
      logger?.warn?.("source_sanitizer.callrail_unavailable", { day, error: String(error.message).slice(0, 120) });
      continue;
    }
    for (const c of res?.calls || []) {
      stats.calls += 1;
      const piece = c.source_name || null;
      if (!piece) continue;
      seenSources.set(piece, (seenSources.get(piece) || 0) + 1);
      const sourceId = resolveLogicsSourceId(dom, piece);
      if (!sourceId) continue;
      const key = last10(c.customer_phone_number);
      if (!key) continue;
      const at = c.start_time || day;
      const prev = byPhone.get(key);
      // Most recent call on an active piece wins.
      if (!prev || String(at) > String(prev.at)) byPhone.set(key, { phone: key, piece, sourceId, at });
    }
  }
  stats.callers = byPhone.size;

  // ── 2. whose case is that number? ──
  const client = createLogicsClient(dom);
  const plan = [];
  await mapLimit([...byPhone.values()], Math.max(1, concurrency), async (hit) => {
    let ids = [];
    try {
      ids = caseIdsFrom(await client.findCaseByPhone(hit.phone));
    } catch (error) {
      if (isNotFound(error)) { stats.noCase += 1; return; }
      stats.unreadable += 1;
      return;
    }
    if (!ids.length) { stats.noCase += 1; return; }

    for (const caseId of ids) {
      let info = null;
      try {
        info = unwrapLogics(await client.getCaseInfo(caseId));
      } catch (error) {
        if (isNotFound(error)) { stats.noCase += 1; continue; }
        stats.unreadable += 1;
        continue;
      }
      const camp = Number(info?.SourceCampaignID ?? NaN);
      if (camp === hit.sourceId) { stats.alreadyTarget += 1; continue; }
      if (ACTIVE_IDS.has(camp)) { stats.alreadyOtherSpecific += 1; continue; }
      plan.push({
        domain: dom, caseId, phone: hit.phone,
        fromSourceId: Number.isFinite(camp) ? camp : null,
        piece: hit.piece, sourceId: hit.sourceId,
        calledAt: String(hit.at).slice(0, 10),
        name: [info?.FirstName, info?.LastName].filter(Boolean).join(" ") || null,
        status: info?.StatusName || null,
      });
      stats.planned += 1;
    }
  });

  plan.sort((a, b) => a.sourceId - b.sourceId || a.caseId - b.caseId);
  const inactivePieces = [...seenSources.entries()]
    .filter(([name]) => !resolveLogicsSourceId(dom, name))
    .sort((a, b) => b[1] - a[1])
    .map(([piece, calls]) => ({ piece, calls }));

  return { plan, stats, inactivePieces, window };
}

/**
 * Write a plan to Logics. Refuses unless the writer is armed — arming is an
 * environment decision, never something this module does for you.
 */
async function applySourceSanitization(plan = [], { logger = null } = {}) {
  const armed = String(process.env.LOGICS_SOURCE_WRITER_ENABLED || "false").toLowerCase() === "true";
  const result = { armed, written: 0, alreadyOk: 0, skipped: 0, failed: 0, errors: [] };
  if (!armed) {
    result.refused = "LOGICS_SOURCE_WRITER_ENABLED is not true";
    return result;
  }
  for (const row of plan) {
    try {
      const r = await writeLogicsCaseSource({
        domain: row.domain, caseId: row.caseId, piece: row.piece, logger,
      });
      if (r.written) result.written += 1;
      else if (r.alreadyOk) result.alreadyOk += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      if (result.errors.length < 10) {
        result.errors.push({ caseId: row.caseId, error: String(error.message).slice(0, 160) });
      }
    }
  }
  return result;
}

/** Plan then (optionally) apply. `apply` still obeys the env arm switch. */
async function runSourceSanitizer({ apply = false, logger = null, ...opts } = {}) {
  const planned = await planSourceSanitization({ ...opts, logger });
  if (!apply) return { ...planned, applied: null };
  const applied = await applySourceSanitization(planned.plan, { logger });
  return { ...planned, applied };
}

module.exports = {
  applySourceSanitization,
  caseIdsFrom,
  dayKeys,
  isNotFound,
  last10,
  pacificKey,
  planSourceSanitization,
  runSourceSanitizer,
  shiftKey,
};
