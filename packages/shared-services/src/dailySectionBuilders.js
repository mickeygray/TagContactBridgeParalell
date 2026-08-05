"use strict";

// THE ATOMIC SECTION BUILDERS.
//
// Mickey 2026-08-05: "since we know we have working parts, let's just one-shot
// formalize the system — make atomic builders, create one object, use the object
// to make an email that can handle and process anywhere from 1 to infinity
// records."
//
// One registry entry per section. Each knows three things and nothing else:
//
//   build(ctx)      how to produce this section for ONE day
//   merge(values)   how to fold N of those into one
//   frozen          which fields a later read may not restate
//
// `merge` is what makes the range case work. A day is one record; a week is
// seven; a year is 365. The email does not care which, because it renders the
// merged object and the merge is defined here, once, beside the thing it merges.
//
// ── THE RULE THAT GOVERNS EVERY MERGE ───────────────────────────────────────
//
// SUM THE PARTS, RECOMPUTE THE RATIOS. Never average a per-day rate. A month
// whose ROI is the mean of thirty daily ROIs is wrong — it weights a $40 day
// equally with a $4,000 one. This is also why the fact sanitizer strips
// `roi`, `costPerLead`, `connectRate` and friends: a stored ratio invites
// exactly that mistake, so the numerator and denominator are stored instead and
// the ratio is derived at read time.
//
// A missing day is NOT a zero day. merge() sees only the values it was given;
// deciding whether an absent day is "nothing happened" or "we never looked" is
// the reader's job, and readEntryRange reports coverage separately for it.

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const num = (v) => (v == null ? null : Number(v));

/** Sum a field across values, ignoring nulls. Returns null if NOTHING had it. */
function sumField(values, field) {
  let total = 0;
  let seen = false;
  for (const v of values) {
    const n = v?.[field];
    if (n == null || Number.isNaN(Number(n))) continue;
    total += Number(n);
    seen = true;
  }
  return seen ? round2(total) : null;
}

/** Max a field across values. */
function maxField(values, field) {
  let best = null;
  for (const v of values) {
    const n = v?.[field];
    if (n == null) continue;
    best = best == null ? Number(n) : Math.max(best, Number(n));
  }
  return best;
}

/** Merge {key: count} maps by summing. */
function mergeCountMaps(values, field) {
  const out = {};
  let seen = false;
  for (const v of values) {
    const map = v?.[field];
    if (!map || typeof map !== "object") continue;
    seen = true;
    for (const [k, n] of Object.entries(map)) out[k] = (out[k] || 0) + Number(n || 0);
  }
  return seen ? out : null;
}

/**
 * Merge arrays of rows keyed by an identity field, summing the numeric columns.
 * Non-numeric columns take the first non-null value seen — a source's NAME does
 * not change because it appeared on two days.
 */
function mergeRowsBy(values, identity, numericFields) {
  const byKey = new Map();
  let seen = false;
  for (const rows of values) {
    if (!Array.isArray(rows)) continue;
    seen = true;
    for (const row of rows) {
      const key = String(row?.[identity] ?? "");
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, { ...row });
      else {
        const acc = byKey.get(key);
        for (const f of numericFields) {
          if (row[f] == null) continue;
          acc[f] = round2(Number(acc[f] || 0) + Number(row[f]));
        }
      }
    }
  }
  return seen ? [...byKey.values()] : null;
}

const BUILDERS = Object.freeze([
  {
    key: "spend",
    label: "Spend",
    // Mail arrives from a sheet that keeps growing after a day closes, so a
    // later read is not a better read. LD and BCD are counted from events we
    // already hold, so a recount IS better and must stay live.
    frozen: Object.freeze(["mail", "mailPieces"]),
    build: (ctx) => ctx.report?.spend ?? null,
    merge(values) {
      const out = {
        mail: sumField(values, "mail"),
        mailPieces: sumField(values, "mailPieces"),
        ld: sumField(values, "ld"),
        ldLeads: sumField(values, "ldLeads"),
        bcd: sumField(values, "bcd"),
        bcdCalls: sumField(values, "bcdCalls"),
      };
      // Recomputed, never summed from the stored totals. Summing totals would
      // double-count the moment one day's total disagreed with its own parts.
      out.total = round2(Number(out.mail || 0) + Number(out.ld || 0) + Number(out.bcd || 0));
      return out;
    },
  },
  {
    key: "financial",
    label: "Money",
    build: (ctx) => ctx.section("topline"),
    merge(values) {
      const out = {
        cash: sumField(values, "cash"),
        spend: sumField(values, "spend"),
        mailSpend: sumField(values, "mailSpend"),
        deals: sumField(values, "deals"),
        recurring: sumField(values, "recurring"),
        ldLeads: sumField(values, "ldLeads"),
        dials: sumField(values, "dials"),
        calls: sumField(values, "calls"),
      };
      out.net = round2(Number(out.cash || 0) - Number(out.spend || 0));
      // Derived HERE from summed parts, deliberately not carried from any day.
      // A zero denominator yields null, never Infinity or 0 — "no spend" is not
      // "infinite return", and it is certainly not "no return".
      out.roi = Number(out.spend) > 0 ? round2(Number(out.cash) / Number(out.spend)) : null;
      out.costPerLead = Number(out.ldLeads) > 0 ? round2(Number(out.spend) / Number(out.ldLeads)) : null;
      return out;
    },
  },
  {
    key: "calls",
    label: "Calls",
    build: (ctx) => ctx.callFacts ?? null,
    merge(values) {
      return {
        links: sumField(values, "links"),
        significant: sumField(values, "significant"),
        durable: sumField(values, "durable"),
        mintOnRead: sumField(values, "mintOnRead"),
        excluded: sumField(values, "excluded"),
        byProvider: mergeCountMaps(values, "byProvider"),
        bySignificance: mergeCountMaps(values, "bySignificance"),
        totalTalkSec: sumField(values, "totalTalkSec"),
        // The longest call in a RANGE is the longest single call, not a sum.
        longestSec: maxField(values, "longestSec"),
      };
    },
  },
  {
    key: "activity",
    label: "Activity",
    build: (ctx) => ctx.activitySection ?? null,
    merge(values) {
      return {
        rowsScanned: sumField(values, "rowsScanned"),
        documentUploads: sumField(values, "documentUploads"),
        excludedUploads: sumField(values, "excludedUploads"),
        noticeUploadCases: sumField(values, "noticeUploadCases"),
        suspendedStatusChanges: sumField(values, "suspendedStatusChanges"),
        suspendedStillCurrent: sumField(values, "suspendedStillCurrent"),
        dncToday: sumField(values, "dncToday"),
        postdateToday: sumField(values, "postdateToday"),
        aiReviewedCases: sumField(values, "aiReviewedCases"),
        profilesStamped: sumField(values, "profilesStamped"),
      };
    },
  },
  {
    key: "bySource",
    label: "By source",
    build: (ctx) => ctx.section("source"),
    merge: (values) => mergeRowsBy(values, "source", ["cash", "spend", "deals", "leads", "calls"]),
  },
  {
    key: "byAgent",
    label: "By officer",
    build: (ctx) => ctx.section("ldcalls"),
    merge: (values) => mergeRowsBy(values, "agent", ["dials", "connects", "talkSec", "deals", "cash"]),
  },
  {
    key: "statusMovement",
    label: "Status movement",
    build: (ctx) => ctx.section("status"),
    merge(values) {
      return {
        suspended: sumField(values, "suspended"),
        postdate: sumField(values, "postdate"),
        dnc: sumField(values, "dnc"),
      };
    },
  },
]);

const BY_KEY = new Map(BUILDERS.map((b) => [b.key, b]));

/** Every section key, in registry order. */
const SECTION_KEYS = Object.freeze(BUILDERS.map((b) => b.key));

/** Fields that must not be restated once a day has them. */
function frozenFieldsFor(key) {
  return BY_KEY.get(key)?.frozen || null;
}

/**
 * Fold N days' worth of one section into one value.
 *
 * @param {string} key
 * @param {Array}  dayValues  one entry per day; nulls are dropped, because a day
 *                            that did not produce the section contributes
 *                            nothing to the sum — it does not contribute a zero.
 * @returns {Object|Array|null} null when NO day had it
 */
function mergeSection(key, dayValues = []) {
  const builder = BY_KEY.get(key);
  if (!builder) throw new Error(`mergeSection: unknown section "${key}"`);
  const present = dayValues.filter((v) => v != null);
  if (!present.length) return null;
  if (present.length === 1 && typeof builder.merge !== "function") return present[0];
  return builder.merge(present);
}

module.exports = {
  BUILDERS,
  SECTION_KEYS,
  frozenFieldsFor,
  mergeSection,
  // exported for tests and for reuse by any future section
  sumField,
  maxField,
  mergeCountMaps,
  mergeRowsBy,
};
