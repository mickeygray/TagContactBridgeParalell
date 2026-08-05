"use strict";

// THE DAILY ENTRY WORKER.
//
// Mickey 2026-08-04: "it's sorta to me a synchronous worker that creates fields
// to an in-memory object then posts to the database." And: "group like services
// so that they save to sections of the same collection entry at once — spend
// sync does spend, logics activity does statuses and financial, call log does
// calls, then create an entry for the day."
//
// So: run the gatherers in order, hang each result on ONE object, post it once.
// No service writes; this does.
//
// ── WHY ASSEMBLE-THEN-WRITE RATHER THAN ATTACH-AS-YOU-GO ────────────────────
//
// The earlier shape had each service patch the day itself. Both attach helpers
// require the entry to ALREADY EXIST — they findOne(dateKey) and return
// "missing-day" otherwise — while the entry was created by the report at the end
// of the pass. Any section produced before that point was silently dropped, and
// it looked like success: no throw, no error, a tidy status string. Assembling
// first means there is no window in which a section can be written to a day that
// does not exist.
//
// ── WHAT A NULL SECTION MEANS ───────────────────────────────────────────────
//
// null  = this gatherer did not run, or could not read its source.
// {...} = it ran and this is the answer, including a legitimately empty one.
//
// They are not the same day and the distinction is load-bearing: this codebase
// has repeatedly rendered "we could not look" as "nothing happened". A gatherer
// that throws leaves its section null and records why in `errors` — it never
// takes the other sections down with it.

const DailyReportFact = require("../../shared-models/src/DailyReportFact");
const { sanitizeFactValue } = require("./dailyReportFactService");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── ONCE THE DAY IS SET, THE DAY IS SET ─────────────────────────────────────
//
// Mickey 2026-08-04: "reading the sheet should only read the day, and once the
// day is set the day is set — we don't add mail spend to the day more than
// once."
//
// Spend is the section where a later read is not a better read. The mail sheet
// keeps growing after a day closes, so re-running a past day would quietly
// restate what it cost: 2026-08-03 was reported at $1,584.48 by the email and
// read $2,193.96 from the sheet a day later. Whichever is right, a completed
// day's cost must not drift every time somebody re-runs the worker, or no
// report ever reconciles against another.
//
// Not immutable — CORRECTABLE. `overwrite: ["spend"]` re-sets it deliberately.
// The rule is that drift must be an act, not a side effect.
//
// FROZEN AT FIELD LEVEL, NOT SECTION LEVEL. `spend` is three sources with
// different volatility, and freezing the whole section would freeze the wrong
// two:
//
//   mail   arrives from a sheet that keeps growing after the day closes. This
//          is the one Mickey's rule is about.
//   ld     new leads x rate on a closed 20:00->20:00 Pacific day.
//   bcd    calls x rate on a closed day.
//
// LD and BCD are counted from events we already hold, so a recount is a better
// answer, not a later one — a late-arriving lead event SHOULD correct them.
// Freezing them would pin a day to whatever happened to have landed by 19:50.
//
// `total` is therefore never frozen: it is recomputed from the frozen mail plus
// the fresh LD and BCD, so it always equals its own parts. Storing a frozen
// total beside fresh components is how a day starts disagreeing with itself.
const FROZEN_SPEND_FIELDS = Object.freeze(["mail", "mailPieces"]);

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * Merge a freshly gathered spend section over the stored one.
 *
 * Mail fields keep their stored value — the sheet grows after a day closes, so
 * a later read is not a better read. LD and BCD take the fresh count, because
 * those are counted from events we already hold and a recount genuinely is
 * better. `total` is recomputed so it always equals its own parts.
 */
function mergeSpend(stored, fresh, out) {
  const merged = { ...fresh };
  const kept = [];
  for (const f of FROZEN_SPEND_FIELDS) {
    if (stored[f] == null) continue;
    if (JSON.stringify(stored[f]) !== JSON.stringify(fresh[f])) kept.push(f);
    merged[f] = stored[f];
  }
  // Recompute rather than trusting either total. A frozen mail figure beside a
  // fresh LD figure makes the stored total wrong under both readings.
  if (["mail", "ld", "bcd"].some((k) => merged[k] != null)) {
    merged.total = round2(Number(merged.mail || 0) + Number(merged.ld || 0) + Number(merged.bcd || 0));
  }
  if (kept.length) out.preserved.push(...kept.map((f) => `spend.${f}`));
  return merged;
}

/**
 * Run one gatherer into its section without letting it cost the others.
 * Sequential on purpose — these hit Logics, CallRail and Mongo, and the point of
 * the consolidation was to stop asking those the same thing twice at once.
 */
async function section(name, fn, out) {
  if (typeof fn !== "function") { out.facts[name] = null; return; }
  try {
    const value = await fn();
    // EVERY SECTION IS SANITIZED. This is not optional tidying — the sanitizer
    // is what keeps this collection from becoming a second customer store. It
    // strips case ids, phones, names, urls and per-day presentation ratios that
    // a longer report must recompute rather than average.
    //
    // Caught by comparing this worker's output against the record the email
    // produced for the same day: statusMovement arrived carrying
    // keyChanges[].caseId, and byAgent carried connectRate. The email's own
    // writer had always sanitized; this one had not, so it would have written
    // customer case ids into the day.
    //
    // undefined means "returned nothing" and is stored as null, not dropped —
    // an absent key would be indistinguishable from a key nobody declared.
    const raw = value === undefined ? null : value;
    // TWO VIEWS OF ONE GATHER. detail keeps the urls, case ids and rows that
    // make a stored day worth opening; facts is the same thing with customer
    // identifiers and per-day ratios stripped, so a year-long rollup never has
    // to drag them through it.
    out.detail[name] = raw;
    out.facts[name] = raw === null ? null : sanitizeFactValue(raw);
  } catch (error) {
    out.facts[name] = null;
    out.detail[name] = null;
    out.errors.push(`${name}: ${String(error.message || error).slice(0, 160)}`);
  }
}

/**
 * Build and store one day's entry.
 *
 * @param {string} dateKey            YYYY-MM-DD, the COMPLETED day
 * @param {Object} gatherers          { spend, activity, financial, calls, bySource, byAgent, statusMovement }
 *                                    each an async () => sectionValue. Omitted = null section.
 * @param {boolean} apply             false (default) = build it, do not post it
 * @returns {{dateKey, facts, errors, posted, revision}}
 */
async function buildDailyEntry({
  dateKey,
  gatherers = {},
  apply = false,
  // Sections to re-set even though they are write-once. Deliberate correction
  // of a day, never a default.
  overwrite = [],
  Model = DailyReportFact,
  logger = null,
} = {}) {
  if (!DATE_RE.test(String(dateKey || ""))) {
    throw new Error(`buildDailyEntry: dateKey must be YYYY-MM-DD, got ${dateKey}`);
  }

  const out = {
    dateKey, facts: {}, errors: [], posted: false, revision: null, preserved: [],
    // The SAME sections, unsanitized. `facts` is what a range sums; `detail` is
    // what one day is opened for, and what the email renders from. Both are
    // built from one gather, so they cannot disagree.
    detail: {},
  };

  // Order matters only in that it is stable and reportable. Nothing here
  // depends on an earlier section's output — if that ever changes, say so
  // explicitly rather than relying on this list.
  await section("spend", gatherers.spend, out);
  await section("activity", gatherers.activity, out);
  await section("financial", gatherers.financial, out);
  await section("calls", gatherers.calls, out);
  await section("bySource", gatherers.bySource, out);
  await section("byAgent", gatherers.byAgent, out);
  await section("statusMovement", gatherers.statusMovement, out);

  out.sectionsGathered = Object.entries(out.facts)
    .filter(([, v]) => v !== null).map(([k]) => k);
  out.sectionsMissing = Object.entries(out.facts)
    .filter(([, v]) => v === null).map(([k]) => k);

  if (!apply) return out;

  // ONE POST. Upsert on the unique dateKey so a re-run updates the day rather
  // than duplicating it, and so a day whose report has not run yet still gets
  // an entry — the "missing-day" problem cannot arise when the writer creates
  // what it needs.
  //
  // $set of the assembled facts only: `coverage`, `emailAcceptedAt` and the
  // rest belong to the report path and must not be clobbered by a worker that
  // knows nothing about them.
  // WRITE-ONCE SECTIONS. Read what the day already holds before deciding what
  // to set. A spend figure that is already recorded stays recorded — the sheet
  // grows after a day closes, and a completed day's cost must not drift because
  // somebody re-ran the worker.
  const existing = await Model.findOne({ dateKey }).select("facts").lean();
  const forced = new Set(overwrite);

  const setFacts = {};
  for (const [k, v] of Object.entries(out.facts)) {
    if (k === "spend" && v && existing?.facts?.spend && !forced.has("spend")) {
      setFacts["facts.spend"] = mergeSpend(existing.facts.spend, v, out);
      continue;
    }
    setFacts[`facts.${k}`] = v;
  }

  // `detail` carries the SAME freeze decisions, so the two views of a day can
  // never disagree about what it cost. Copying the merged facts.spend across
  // rather than re-deriving it is what guarantees that.
  const setDetail = {};
  for (const [k, v] of Object.entries(out.detail)) {
    if (k === "spend" && setFacts["facts.spend"]) {
      setDetail["detail.spend"] = setFacts["facts.spend"];
      continue;
    }
    if (k === "spend" && !("facts.spend" in setFacts)) continue; // frozen whole
    setDetail[`detail.${k}`] = v;
  }

  const res = await Model.findOneAndUpdate(
    { dateKey },
    {
      $set: { ...setFacts, ...setDetail, entryBuiltAt: new Date() },
      $inc: { revision: 1 },
      // Only on CREATE. The report path owns these once it has run, and a
      // worker re-run must never overwrite a real definitionName or an accepted
      // mail timestamp with its own placeholder.
      $setOnInsert: {
        dateKey,
        definitionName: "daily entry",
        captureVersion: 1,
        capturedAt: new Date(),
        emailAcceptedAt: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, projection: { revision: 1 } },
  );
  out.posted = true;
  out.revision = res?.revision ?? null;
  logger?.info?.("daily_entry.posted", {
    dateKey,
    sections: out.sectionsGathered.length,
    preserved: out.preserved.length,
    errors: out.errors.length,
  });
  return out;
}

/**
 * The five sections that come from ONE report gather.
 *
 * financial / bySource / byAgent / statusMovement are rendered sections; spend
 * rides along as data on the report because the `spend` block is not in the
 * rollup preset and adding it there would change the nightly email.
 *
 * Composed ONCE and sliced seven ways — the whole point of the consolidation.
 * Each returned gatherer closes over the same report, so the worker's sequential
 * calls cost one gather between them, not five.
 *
 * @param {Object} report  an already-composed one-day report
 */
function gatherersFromReport(report) {
  const byId = new Map((report?.sections || []).map((s) => [String(s.id), s]));
  // A section that ERRORED is null, not its partial data. The worker's null
  // means "could not read", which is exactly what a section error is.
  const section = (id) => {
    const s = byId.get(id);
    if (!s || s.error) return null;
    return s.data ?? null;
  };
  return {
    financial: async () => section("topline"),
    spend: async () => report?.spend ?? null,
    bySource: async () => section("source"),
    byAgent: async () => section("ldcalls"),
    statusMovement: async () => section("status"),
  };
}

module.exports = { buildDailyEntry, gatherersFromReport };
