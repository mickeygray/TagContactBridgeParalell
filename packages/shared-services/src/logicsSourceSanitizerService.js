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
 * @returns {{plan: Array, stats: object, inactivePieces: Array, offRosterPieces: Array, window: object}}
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
    // Cases reached only because a secondary number (spouse / second cell /
    // work line) was on the case — Logics' phone search misses those.
    matchedBySecondaryPhone: 0,
    // Calls on a line that is NOT an active mail piece — servicing numbers,
    // the website pool, social, retired pieces, BCD. Mickey 2026-07-30:
    // "noise, we only need to track active mail pieces." Counted purely so the
    // skip is visible; this is the intended outcome, NOT a registry gap to be
    // closed. Do not register these to make the number go down.
    offRosterPiece: 0,
    alreadyOtherSpecific: 0, unreadable: 0, planned: 0,
  };
  if (!registry) {
    return {
      plan: [], stats, inactivePieces: [], offRosterPieces: [], window,
      skipped: `no source registry for ${dom} — every piece would be skipped`,
    };
  }
  const ACTIVE_IDS = new Set(Object.values(registry));

  // ── 1. calls that landed on an ACTIVE piece ──
  const cr = createCallrailClient(dom);
  const byPhone = new Map();
  // piece name -> call count for lines that are not active mail. Diagnostic
  // only; these are intentionally never written.
  const offRoster = new Map();
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
      if (!sourceId) {
        // Not an active mail piece — servicing lines, the website pool, social,
        // BCD, retired pieces. Skipping is the POINT: the registry is the
        // active-mail roster, so anything absent from it is deliberately not
        // attributed. Counted only so the skip is visible in the plan.
        stats.offRosterPiece += 1;
        offRoster.set(piece, (offRoster.get(piece) || 0) + 1);
        continue;
      }
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
      if (!isNotFound(error)) { stats.unreadable += 1; return; }
      ids = [];
    }
    if (!ids.length) {
      // THE SPOUSE NUMBER. Logics' phone search only resolves the number in the
      // case's primary slot, so a call from a spouse / second cell / work line
      // dead-ends here even though that number is ON the case. Measured on July
      // 2026: case 394513 sold the day its spouse number made a 55-minute call
      // to Affordability Federal, and the whole deal stayed in the ABC bucket
      // because the primary number never rang.
      //
      // Our CaseProfile mirror already folds every Logics number into
      // normalizedPhones, so ask it before giving up. Logics stays the
      // authority for the WRITE; this only answers "whose case is this?".
      try {
        const CaseProfile = require("../../shared-models/src/CaseProfile");
        const owners = await CaseProfile.find({
          domain: dom,
          normalizedPhones: hit.phone,
        }).select("caseId").limit(5).lean();
        ids = owners.map((o) => Number(o.caseId)).filter(Boolean);
        if (ids.length) stats.matchedBySecondaryPhone += ids.length;
      } catch {
        // mirror unavailable — fall through to noCase rather than guess
      }
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

  // Lines that took calls but are not active mail. Visible, never actioned.
  const offRosterPieces = [...offRoster.entries()]
    .map(([piece, calls]) => ({ piece, calls }))
    .sort((a, b) => b.calls - a.calls);
  return { plan, stats, inactivePieces, offRosterPieces, window };
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
