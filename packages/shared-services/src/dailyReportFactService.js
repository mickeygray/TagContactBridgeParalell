"use strict";

const DailyReportFact = require("../../shared-models/src/DailyReportFact");
const { PRESETS } = require("./reportBlocksService");

const CAPTURE_VERSION = 1;
const REQUIRED_SECTIONS = Object.freeze([...(PRESETS.rollup || [])]);
const CALL_SECTION = "longcalls";
/**
 * The key inside `facts`, which is NOT the same string as the report section that
 * feeds it. `longcalls` is a block in the nightly email; `calls` is the stored slot.
 */
const CALL_SECTION_FACT = "calls";
const CANONICAL_DEFINITION_NAME = "financial roll up with calls";

// Daily facts are statistics, not a second customer/call store. The report may
// contain actionable rows, phones, case ids, and listen links; those already
// have owners elsewhere and are intentionally excluded from this collection.
const OMIT_KEYS = new Set([
  "block", "columns", "emailcolumns", "listenurl", "recordingurl",
  "recordingreference", "url", "phone", "caller", "email", "client",
  "caseid", "dealcases", "keychanges", "worthhearing", "raw", "payload",
  // These are daily presentation values, not additive facts. Longer reports
  // must recompute them from the stored numerator/denominator totals.
  "roi", "roas", "rate", "answerrate", "connectrate", "closerate",
  "costper", "costperlead", "costpercall", "costperacquisition",
  "profitmargin", "shareofconnected", "percentage", "percent",
  // Provider/customer correlation is not an aggregate fact. Keep this list
  // explicit so a newly attached calls payload cannot smuggle identifiers
  // into the day document under a common alias.
  "callid", "providercallid", "providercontactid", "provideridentity",
  "contactid", "externalid", "sessionid", "recordingarchive", "sourceuri",
  "mediauri", "mediaurl", "downloadurl", "downloadlink", "listenlink",
  "href", "link", "transcript", "transcription", "token", "signature",
  "phonenumber", "emailaddress", "casenumber", "customername", "clientname",
  "callername", "leadname", "prospectname", "customeraddress", "mailingaddress",
]);

function unsafeScalarText(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  // Daily facts must never become a capability/locator store. This also
  // catches an unfamiliar URL field name that the key deny-list has not seen.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return true;
  // Email addresses are customer data regardless of the property name used
  // by a future report block.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return true;
  return false;
}

function safeText(value, max = 500) {
  return String(value == null ? "" : value).slice(0, max);
}

function sanitizeFactValue(value, depth = 0) {
  if (depth > 10 || value == null) return value == null ? null : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return unsafeScalarText(value) ? undefined : safeText(value);
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Set) return sanitizeFactValue([...value], depth + 1);
  if (value instanceof Map) return sanitizeFactValue(Object.fromEntries(value), depth + 1);
  if (Array.isArray(value)) {
    return value.slice(0, 5000)
      .map((entry) => sanitizeFactValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  const source = typeof value.toObject === "function" ? value.toObject() : value;
  const out = {};
  for (const [key, entry] of Object.entries(source).slice(0, 500)) {
    const normalizedKey = String(key).toLowerCase();
    if (OMIT_KEYS.has(normalizedKey)) continue;
    // Keep an aggregate `cases: 42`, never a list of customer cases.
    if (normalizedKey === "cases" && typeof entry !== "number") continue;
    const clean = sanitizeFactValue(entry, depth + 1);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

/**
 * Is this stored day complete? — E13 / decision D7, answered COMPUTE ON READ.
 *
 * `coverage.complete` is stored too, and stays stored, because a document
 * written by an older captureVersion has to keep meaning what it meant. But
 * every READER goes through here instead of trusting the field, for one
 * reason: completeness is a function of REQUIRED_SECTIONS, and that list is
 * derived from the rollup preset. The day the preset gains a section, every
 * document written before it is still stamped `complete: true` and is now
 * lying — it is missing a section nobody had heard of when it was written.
 *
 * Computing it on read means the answer moves when the definition of complete
 * moves, which is the only version that stays true. A stored `complete: true`
 * on a day that no longer satisfies the current required set now reads as
 * INCOMPLETE, which is the safe direction: it re-gathers rather than serving a
 * report that silently lacks a section.
 */
function isFactComplete(fact) {
  if (!fact) return false;
  const captured = new Set(fact.coverage?.capturedSections || []);
  const errors = (fact.coverage?.sectionErrors || []).length;
  const core = REQUIRED_SECTIONS.filter((id) => id !== CALL_SECTION);
  const coreComplete = core.every((id) => captured.has(id)) && errors === 0;
  return coreComplete && fact.coverage?.callProjection === "complete";
}

function sectionMap(report) {
  return new Map((report?.sections || []).map((section) => [String(section.id), section]));
}

function sectionRowCount(section) {
  const value = section?.data;
  if (Array.isArray(value)) return value.length;
  for (const key of ["rows", "agents", "calls", "emailRows"]) {
    if (Array.isArray(value?.[key])) return value[key].length;
  }
  return 0;
}

function isDailyFactCaptureCandidate(def, report, range) {
  if (!def?.sendEmail) return { capture: false, reason: "email-disabled" };
  if (String(def.name || "").trim().toLowerCase() !== CANONICAL_DEFINITION_NAME) {
    return { capture: false, reason: "not-canonical-definition" };
  }
  if (!range?.from || range.from !== range.to) return { capture: false, reason: "not-one-day" };
  if (def.domain) return { capture: false, reason: "tenant-scoped" };
  if ((def.filters || []).filter(Boolean).length) return { capture: false, reason: "filtered" };
  const selected = new Set(report?.selection || []);
  const missing = REQUIRED_SECTIONS.filter((id) => !selected.has(id));
  if (missing.length) return { capture: false, reason: `missing-rollup-sections:${missing.join(",")}` };
  return { capture: true, reason: null };
}

function buildDailyReportFact({
  dateKey,
  definitionName,
  report,
  emailAcceptedAt = new Date(),
  callFacts = null,
} = {}) {
  const key = String(dateKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error("daily fact dateKey must be YYYY-MM-DD");
  if (report?.from !== key || report?.to !== key) throw new Error("daily fact requires a one-day report");

  const sections = sectionMap(report);
  const capturedSections = REQUIRED_SECTIONS.filter((id) => sections.has(id) && !sections.get(id)?.error);
  const missingSections = REQUIRED_SECTIONS.filter((id) => !sections.has(id));
  const sectionErrors = REQUIRED_SECTIONS
    .filter((id) => sections.get(id)?.error)
    .map((id) => `${id}:${safeText(sections.get(id).error, 160)}`);
  if ((report?.failures || []).length) sectionErrors.push(`source-failures:${report.failures.length}`);

  const coreRequired = REQUIRED_SECTIONS.filter((id) => id !== CALL_SECTION);
  const coreComplete = coreRequired.every((id) => capturedSections.includes(id))
    && sectionErrors.length === 0;
  const callSection = sections.get(CALL_SECTION);
  const callProjection = callFacts
    ? "complete"
    : (callSection?.error ? "unavailable" : "pending");

  return {
    dateKey: key,
    captureVersion: CAPTURE_VERSION,
    definitionName: safeText(definitionName || "nightly rollup", 160),
    selection: [...new Set(report.selection || [])].map((id) => safeText(id, 80)),
    emailAcceptedAt: new Date(emailAcceptedAt),
    capturedAt: new Date(),
    facts: {
      financial: sanitizeFactValue(sections.get("topline")?.data ?? null),
      // ALL COSTS BY SOURCE — total, LD (with lead count), mail (with pieces),
      // BCD (with call count and rate). Added 2026-08-04: a stored day used to
      // carry revenue with no denominator, so cost-per-lead could never be
      // recomputed from the fact alone.
      //
      // Read off report.spend, NOT a rendered section: the `spend` block is not
      // in the rollup preset, and putting it there to reach the number would
      // have added a section to the nightly email.
      spend: sanitizeFactValue(report.spend ?? null),
      bySource: sanitizeFactValue(sections.get("source")?.data ?? null),
      byAgent: sanitizeFactValue(sections.get("ldcalls")?.data ?? null),
      statusMovement: sanitizeFactValue(sections.get("status")?.data ?? null),
      calls: callFacts
        ? sanitizeFactValue(callFacts)
        : { status: callProjection, rowsObservedInEmail: sectionRowCount(callSection) },
    },
    coverage: {
      requiredSections: [...REQUIRED_SECTIONS],
      capturedSections,
      missingSections,
      sectionErrors,
      reportDegraded: Boolean((report?.failures || []).length || sectionErrors.length),
      coreComplete,
      callProjection,
      complete: coreComplete && callProjection === "complete",
    },
  };
}

/**
 * Flatten the fact into an update that touches only the keys this path owns.
 *
 * `$set: { facts: {...} }` REPLACES the whole `facts` subdocument in Mongo — every
 * key not in the new object disappears. That was harmless while this was the only
 * writer, and stops being harmless the moment anything else contributes a section:
 * `facts.activity` is produced by the activity review and by nothing here, so a
 * whole-object write silently deletes it, and any frozen `facts.spend` merge goes
 * with it.
 *
 * Writing `facts.<key>` instead means the two writers can share a day.
 *
 * Dropping a key no longer clears it, which is a real difference — but not one that
 * bites here, because buildDailyReportFact always emits all six keys, using null for
 * a section it could not gather. There is no path where a key silently keeps a stale
 * value; an absent section writes an explicit null.
 */
function flattenFactUpdate(fact) {
  const { facts, ...rest } = fact;
  const set = { ...rest };
  for (const [key, value] of Object.entries(facts || {})) {
    // A PLACEHOLDER MUST NOT OVERWRITE REAL DATA.
    //
    // This path never has call facts — the call index produces them and the daily
    // entry worker posts them. What it writes here is a marker, {status:"pending"},
    // saying "somebody else owns this". Writing that marker over counts the worker
    // already stored would destroy the only real numbers in the document, and on a
    // nightly schedule it would do so every single night.
    //
    // Leaving the key absent loses nothing: coverage.callProjection already records
    // "pending" for the day, so the state is still stated, just not stated twice in
    // a place another writer owns.
    if (key === CALL_SECTION_FACT && value && value.status === "pending") continue;
    set[`facts.${key}`] = value;
  }
  return set;
}

/**
 * Persist a fact that is ALREADY BUILT.
 *
 * Split out because the two callers hand over different things and one of them
 * was silently failing. writeDailySnapshot builds the fact itself — it needs
 * `coverage.complete` for its own return value — and then handed that fact to
 * its `writer`, whose default was persistDailyReportFact, whose first line
 * builds AGAIN. The second build receives a fact, a fact has no `report` key,
 * and buildDailyReportFact rejects that: "daily fact requires a one-day
 * report". Every night, caught by writeDailySnapshot's own try, downgraded to
 * {status:"failed"}, and raised as a high-severity alert.
 *
 * It survived because production is the ONLY caller that takes the default
 * writer — the dry-run script and every test inject their own, so the broken
 * path was the one path with no coverage.
 */
async function persistBuiltDailyReportFact(fact, { Model = DailyReportFact } = {}) {
  if (!fact || !fact.dateKey) throw new Error("a built daily fact requires a dateKey");
  await Model.updateOne(
    { dateKey: fact.dateKey },
    { $set: flattenFactUpdate(fact), $inc: { revision: 1 } },
    { upsert: true },
  );
  return { status: "captured", dateKey: fact.dateKey };
}

async function persistDailyReportFact(input, { Model = DailyReportFact } = {}) {
  const fact = buildDailyReportFact(input);
  await Model.updateOne(
    { dateKey: fact.dateKey },
    { $set: flattenFactUpdate(fact), $inc: { revision: 1 } },
    { upsert: true },
  );
  return {
    status: "captured",
    dateKey: fact.dateKey,
    complete: fact.coverage.complete,
    coreComplete: fact.coverage.coreComplete,
    callProjection: fact.coverage.callProjection,
  };
}

async function attachDailyCallFacts({ dateKey, callFacts, status = "complete" } = {}, {
  Model = DailyReportFact,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) {
    throw new Error("daily call facts dateKey must be YYYY-MM-DD");
  }
  if (!new Set(["complete", "unavailable"]).has(status)) {
    throw new Error("daily call facts status must be complete or unavailable");
  }
  const existing = await Model.findOne({ dateKey }).select("coverage.coreComplete").lean();
  if (!existing) return { status: "missing-day", dateKey };
  const complete = Boolean(existing.coverage?.coreComplete) && status === "complete";
  await Model.updateOne(
    { dateKey },
    {
      $set: {
        "facts.calls": sanitizeFactValue(callFacts || {}),
        "coverage.callProjection": status,
        "coverage.complete": complete,
      },
      $inc: { revision: 1 },
    },
  );
  return { status: "attached", dateKey, complete };
}

function dayKeys(from, to) {
  const out = [];
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return out;
  for (let at = start; at <= end; at += 86400000) out.push(new Date(at).toISOString().slice(0, 10));
  return out;
}

async function readDailyReportFactRange({ from, to } = {}, { Model = DailyReportFact } = {}) {
  const wanted = dayKeys(from, to);
  const docs = await Model.find({ dateKey: { $gte: from, $lte: to } }).sort({ dateKey: 1 }).lean();
  const have = new Set(docs.map((doc) => doc.dateKey));
  const missing = wanted.filter((day) => !have.has(day));
  // COMPUTED, not read off the document — see isFactComplete. A day stamped
  // complete under an older required-section list is not complete now.
  const incomplete = docs.filter((doc) => !isFactComplete(doc)).map((doc) => doc.dateKey);
  const callsPending = docs.filter((doc) => doc.coverage?.callProjection === "pending").map((doc) => doc.dateKey);
  return {
    days: docs,
    coverage: {
      daysRequested: wanted.length,
      daysStored: have.size,
      missing,
      incomplete,
      callsPending,
      complete: missing.length === 0 && incomplete.length === 0,
    },
  };
}

module.exports = {
  CANONICAL_DEFINITION_NAME,
  CAPTURE_VERSION,
  REQUIRED_SECTIONS,
  attachDailyCallFacts,
  buildDailyReportFact,
  flattenFactUpdate,
  isDailyFactCaptureCandidate,
  isFactComplete,
  persistBuiltDailyReportFact,
  persistDailyReportFact,
  readDailyReportFactRange,
  sanitizeFactValue,
};
