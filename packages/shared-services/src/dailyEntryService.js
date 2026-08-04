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
    out.facts[name] = value === undefined ? null : sanitizeFactValue(value);
  } catch (error) {
    out.facts[name] = null;
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
  Model = DailyReportFact,
  logger = null,
} = {}) {
  if (!DATE_RE.test(String(dateKey || ""))) {
    throw new Error(`buildDailyEntry: dateKey must be YYYY-MM-DD, got ${dateKey}`);
  }

  const out = { dateKey, facts: {}, errors: [], posted: false, revision: null };

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
  const setFacts = {};
  for (const [k, v] of Object.entries(out.facts)) setFacts[`facts.${k}`] = v;

  const res = await Model.findOneAndUpdate(
    { dateKey },
    {
      $set: { ...setFacts, entryBuiltAt: new Date() },
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
    dateKey, sections: out.sectionsGathered.length, errors: out.errors.length,
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
