"use strict";

// RENDER THE NIGHTLY REPORT FROM THE STORED DAY, instead of gathering it again.
//
// Mickey 2026-08-06: "the goal would be to migrate one of those so its being
// produced by the mongo collection so we can look at them side by side."
//
// This is the second producer. It returns the SAME SHAPE composeReport returns,
// so `renderText`, `toTemplateData` and report.hbs render it unchanged — the
// email template never learns there are two sources.
//
// ── WHAT THE RECORD CAN AND CANNOT DO ──────────────────────────────────────
//
// Measured against the live collection, 2026-08-06. The nightly email is the
// `rollup` preset — topline, source, ldcalls, status, longcalls — and the
// stored day now has a compact long-tail representation of those sections:
//
//   topline    FULL      one day uses detail; ranges sum additive facts
//   source     FULL      range ratios are recomputed from summed parts
//   ldcalls    FULL      range rates are recomputed from summed parts
//   status     EVENTS    one day keeps chase rows; ranges show event counts
//   longcalls  DETAIL    one day keeps every retained row; a range keeps the
//                        five longest linked calls per agent while counting all
//
// Ratios are recomputed from stored numerators and denominators rather than
// averaged. Multi-day detail is intentionally curated: status becomes counts
// and calls become totals plus the five longest linked calls per agent.
// Historical documents that predate a detail section remain visibly partial.
//
// ── WHY UNKNOWN AND NOT ZERO ───────────────────────────────────────────────
//
// toTemplateData turns any null/undefined/"" cell into a muted em-dash. That is
// fine for one missing number inside a table that is otherwise real. It is NOT
// fine for a whole section the record never stored: `block.csv(null)` yields a
// table with zero rows, and a zero-row "Calls worth hearing" reads as "nothing
// worth hearing happened today" rather than "we did not keep this". So a
// section the record cannot supply is emitted in the composer's OWN error
// shape — {id, label, error, block}, no `data` key — which is what the template
// already renders as a visible problem.

const { BY_ID } = require("./reportBlocksService");
const DailyReportFact = require("../../shared-models/src/DailyReportFact");
const { readEntryRange } = require("./dailyEntryService");
const {
  REPORT_SECTION_IDS,
  REPORT_TO_DAILY_SECTION,
  ROLLUP_SECTION_IDS,
  isValidDateKey,
} = require("./dailyReportContract");

const ROLLUP = Object.freeze([...ROLLUP_SECTION_IDS]);

/** Sections the stored record can reconstruct at all, and from which fact key. */
const FACT_FOR_SECTION = Object.freeze({
  ...REPORT_TO_DAILY_SECTION,
  spend: "spend",
});

const unknownSection = (id, why) => {
  const block = BY_ID.get(id);
  return {
    id,
    label: block?.label || id,
    // The composer's failed-section shape: `error` present, `data` ABSENT.
    error: `UNKNOWN — ${why}`.slice(0, 140),
    block,
  };
};

/**
 * Build the sections array from a stored fact document.
 *
 * Exported for tests: it is pure, takes no database and no clock.
 */
function sectionsFromFact(fact, selection = ROLLUP) {
  const facts = fact?.facts || {};
  const detail = fact?.detail || {};
  const sectionErrors = new Map(
    (fact?.coverage?.sectionErrors || [])
      .map((entry) => String(entry))
      .filter((entry) => entry.includes(":"))
      .map((entry) => [entry.slice(0, entry.indexOf(":")), entry.slice(entry.indexOf(":") + 1)]),
  );

  return selection.map((id) => {
    const block = BY_ID.get(id);
    if (!block) return unknownSection(id, `no such block "${id}"`);

    // A section that failed on the night it was captured stays failed. Losing
    // that would turn a known-bad night into a clean-looking one.
    if (sectionErrors.has(id)) {
      return unknownSection(id, `failed when captured — ${sectionErrors.get(id)}`);
    }

    const key = FACT_FOR_SECTION[id];
    if (!key) return unknownSection(id, "no fact key feeds this section");

    // New entries carry both views from the same gather. One-day rendering may
    // use the complete view; legacy rows safely fall back to sanitized facts.
    const data = detail[key] ?? facts[key];
    // null is "we could not gather it", which is exactly what UNKNOWN means.
    // An empty object/array, by contrast, is a real answer and renders.
    if (data === null || data === undefined) {
      return unknownSection(id, `facts.${key} is empty for this day`);
    }
    return { id, label: block.label, data, block };
  });
}

/** Build the compact long-tail sections from a merged stored range. */
function sectionsFromRange(range, selection = ROLLUP) {
  const facts = range?.sections || {};
  const detail = range?.detailSections || {};
  return selection.map((id) => {
    const block = BY_ID.get(id);
    if (!block) return unknownSection(id, `no such block "${id}"`);
    const key = FACT_FOR_SECTION[id];
    if (!key) return unknownSection(id, "no stored section feeds this block");

    if (id === REPORT_SECTION_IDS.LONG_CALLS) {
      // Facts span every compatible stored day; detail may exist only on newer
      // captures. Counts therefore come from facts, while the playable review
      // rows come from whatever detail was actually retained. Choosing detail
      // for both silently undercounted mixed legacy/current ranges.
      const summary = facts[key] || detail[key];
      const retained = detail[key];
      if (!summary) return unknownSection(id, `facts.${key} is empty for this range`);
      const rows = Array.isArray(retained?.rows) ? [...retained.rows] : [];
      // Array metadata is consumed only while rendering this report. The stored
      // detail remains ordinary rows, and the facts remain aggregate counts.
      Object.assign(rows, {
        rangeSummary: true,
        totalObserved: Number(summary.total || 0),
        over30Minutes: Number(summary.over30Minutes || 0),
        withRecording: Number(summary.withRecording || 0),
        topPerAgent: Number(retained?.topPerAgent || 5),
      });
      return { id, label: block.label, data: rows, block };
    }

    const storedData = facts[key];
    const data = id === REPORT_SECTION_IDS.STATUS && storedData && typeof storedData === "object"
      ? { ...storedData, rangeSummary: true }
      : storedData;
    if (data === null || data === undefined) {
      return unknownSection(id, `facts.${key} is empty for this range`);
    }
    return { id, label: block.label, data, block };
  });
}

/**
 * Render a stored day into composeReport's shape.
 *
 * @param {string}  dateKey    YYYY-MM-DD — the day to read
 * @param {Array}   [selection] block ids; defaults to the rollup preset
 * @param {Object}  [Model]    injectable, for tests
 * @returns {Object|null} the report shape, or null when no record exists
 */
async function renderReportFromRecord({
  dateKey,
  from = dateKey,
  to = from,
  selection = ROLLUP,
  Model = DailyReportFact,
} = {}) {
  const start = String(from || "").trim();
  const end = String(to || "").trim();
  if (!isValidDateKey(start) || !isValidDateKey(end)) {
    throw new Error("renderReportFromRecord needs YYYY-MM-DD from/to");
  }

  const singleDay = start === end;
  const fact = singleDay ? await Model.findOne({ dateKey: start }).lean() : null;
  const range = singleDay ? null : await readEntryRange({
    from: start,
    to: end,
    view: "both",
    detailKeys: [REPORT_TO_DAILY_SECTION[REPORT_SECTION_IDS.LONG_CALLS]],
    Model,
  });
  // A MISSING RECORD IS NOT AN EMPTY DAY. Returning a zeroed report here would
  // email a confident set of zeroes for a night nothing was captured. The
  // caller decides what to do with null; it must not be a silent send.
  if (singleDay ? !fact : !range?.coverage?.daysStored) return null;

  const sections = singleDay
    ? sectionsFromFact(fact, selection)
    : sectionsFromRange(range, selection);
  const unknownSections = sections.filter((s) => s.error);

  const failures = [];
  const advisories = [];
  if (fact?.coverage?.reportDegraded) {
    failures.push("the night this day was captured was already [DEGRADED] — see coverage.sectionErrors");
  }
  if (range?.missingDays?.length) {
    failures.push(`${range.missingDays.length} requested day(s) have no stored entry`);
  }
  if (range?.coverage?.degradedDays?.length) {
    failures.push(`${range.coverage.degradedDays.length} stored day(s) were captured degraded`);
  }
  if (range?.coverage?.incompleteDays?.length) {
    advisories.push(`${range.coverage.incompleteDays.length} stored day(s) are not marked fully complete`);
  }
  if (range?.coverage?.legacyDays?.length) {
    advisories.push(`${range.coverage.legacyDays.length} stored day(s) use an older capture format`);
  }
  if (unknownSections.length) {
    advisories.push(
      `rendered from the stored day: ${unknownSections.length} of ${sections.length} section(s)`
      + ` are UNKNOWN because the record does not store them — `
      + unknownSections.map((s) => s.id).join(", "),
    );
  }

  return {
    from: start,
    to: end,
    // The record is all-domain by construction: isDailyFactCaptureCandidate
    // refuses a tenant-scoped definition, so a per-domain record cannot exist.
    domain: "ALL",
    selection: sections.map((s) => s.id),
    filters: [],
    filtered: null,
    unknown: [],
    // The one field that tells the two producers apart. The comparison script
    // asserts on it, because a run that quietly fell back to composing would
    // otherwise report perfect parity with itself.
    source: "record",
    gathered: null,
    gatherStats: null,
    notes: [singleDay
      ? `rendered from DailyReportFact ${start}`
        + ` (captured ${fact.capturedAt ? new Date(fact.capturedAt).toISOString() : "?"},`
        + ` revision ${fact.revision ?? "?"})`
      : `rendered from ${range.coverage.daysStored} stored day(s), ${start} through ${end}`],
    failures,
    advisories,
    spend: singleDay ? (fact.facts?.spend ?? null) : (range.sections?.spend ?? null),
    sections,
  };
}

/**
 * May this definition be rendered from the record?
 *
 * Guarded on domain because the record has NO domain dimension and the
 * `longcalls` block filters on one: `inboundApplies = !domain || domain ===
 * "TAG"`. A WYNN board rendered from an all-domain record would reinstate a
 * leak the block's own comment records having happened once — it "handed the
 * lead vendor five recordings of OUR mail callers".
 */
function canRenderFromRecord(def, range = null) {
  if (!def) return { ok: false, reason: "no-definition" };
  if (String(def.renderSource || "") !== "record") return { ok: false, reason: "not-record-sourced" };
  if (def.domain) return { ok: false, reason: "tenant-scoped-definition-cannot-use-an-all-domain-record" };
  if ((def.filters || []).filter(Boolean).length) return { ok: false, reason: "filtered-definition" };
  return { ok: true, reason: null };
}

module.exports = {
  ROLLUP,
  canRenderFromRecord,
  renderReportFromRecord,
  sectionsFromFact,
  sectionsFromRange,
};
