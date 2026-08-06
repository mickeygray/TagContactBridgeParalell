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
// stored day reproduces exactly ONE of those five in full:
//
//   topline    FULL      facts.financial carries every field the summary reads
//   source     PARTIAL   roas is stripped by OMIT_KEYS; the column renders "—"
//   ldcalls    PARTIAL   the table is whole; connectRate is stripped, so the
//                        section SUMMARY line cannot be rebuilt
//   status     PARTIAL   keyChanges is stripped by name — and that IS the
//                        section's entire email body, the three-lane chase list
//   longcalls  NONE      the rows are never stored at all. facts.calls holds
//                        counts, or a "pending" placeholder that
//                        flattenFactUpdate deliberately skips
//
// Those gaps are not this renderer's bug and must not be papered over here. The
// fact sanitizer strips ratios ON PURPOSE, so a longer report has to recompute
// them from stored numerators and denominators rather than average an average.
// The consequence for a ONE-DAY render is that the ratio is simply absent.
//
// So the side-by-side will show differences on four of five sections. THAT IS
// THE RESULT, not a failure of the experiment: it is the list of things the
// record must start storing before it can stand in for a live gather.
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

const { BY_ID, PRESETS } = require("./reportBlocksService");
const DailyReportFact = require("../../shared-models/src/DailyReportFact");

const ROLLUP = Object.freeze([...(PRESETS.rollup || [])]);

/** Sections the stored record can reconstruct at all, and from which fact key. */
const FACT_FOR_SECTION = Object.freeze({
  topline: "financial",
  source: "bySource",
  ldcalls: "byAgent",
  status: "statusMovement",
  spend: "spend",
});

/**
 * Sections whose stored value is a COUNT SUMMARY rather than the rows the block
 * renders. Reconstructing a table from these would invent data.
 */
const COUNTS_ONLY = new Set(["longcalls"]);

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

    if (COUNTS_ONLY.has(id)) {
      const stored = facts[id === "longcalls" ? "calls" : id];
      const pending = !stored || stored.status === "pending";
      return unknownSection(id, pending
        ? "the day's call rows were never stored (facts.calls is a placeholder)"
        : "only counts were stored for this section, not the rows it renders");
    }

    const key = FACT_FOR_SECTION[id];
    if (!key) return unknownSection(id, "no fact key feeds this section");

    const data = facts[key];
    // null is "we could not gather it", which is exactly what UNKNOWN means.
    // An empty object/array, by contrast, is a real answer and renders.
    if (data === null || data === undefined) {
      return unknownSection(id, `facts.${key} is empty for this day`);
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
  selection = ROLLUP,
  Model = DailyReportFact,
} = {}) {
  const key = String(dateKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error("renderReportFromRecord needs a YYYY-MM-DD dateKey");

  const fact = await Model.findOne({ dateKey: key }).lean();
  // A MISSING RECORD IS NOT AN EMPTY DAY. Returning a zeroed report here would
  // email a confident set of zeroes for a night nothing was captured. The
  // caller decides what to do with null; it must not be a silent send.
  if (!fact) return null;

  const sections = sectionsFromFact(fact, selection);
  const unknownSections = sections.filter((s) => s.error);

  const failures = [];
  const advisories = [];
  if (fact.coverage?.reportDegraded) {
    failures.push("the night this day was captured was already [DEGRADED] — see coverage.sectionErrors");
  }
  if (unknownSections.length) {
    advisories.push(
      `rendered from the stored day: ${unknownSections.length} of ${sections.length} section(s)`
      + ` are UNKNOWN because the record does not store them — `
      + unknownSections.map((s) => s.id).join(", "),
    );
  }

  return {
    from: key,
    to: key,
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
    notes: [
      `rendered from DailyReportFact ${key}`
      + ` (captured ${fact.capturedAt ? new Date(fact.capturedAt).toISOString() : "?"},`
      + ` revision ${fact.revision ?? "?"})`,
    ],
    failures,
    advisories,
    spend: fact.facts?.spend ?? null,
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
function canRenderFromRecord(def) {
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
};
