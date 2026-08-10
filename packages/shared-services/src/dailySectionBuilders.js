"use strict";

const { AGED_LABEL } = require("../../shared-config/src/activeSources");
const { applyFunctions } = require("./reportOpsService");
const {
  AGENT_ROW_ADDITIVE_FIELDS,
  AGENT_SUMMARY_ADDITIVE_FIELDS,
  DAILY_SECTION_KEYS,
  REPORT_SECTION_IDS,
  SOURCE_ROW_ADDITIVE_FIELDS,
  STATUS_ADDITIVE_FIELDS,
  TOPLINE_ADDITIVE_FIELDS,
} = require("./dailyReportContract");

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
//
// ── AGGREGATABLE vs NEEDS CONFIRMING ────────────────────────────────────────
//
// Mickey 2026-08-05: "for stuff like that you can aggregate certain facts, but
// need to run activities over the range to confirm certain things that may have
// been cleaned up."
//
// This is the events-vs-state rule reaching the range case. Summing a month of
// daily snapshots is correct for anything that HAPPENED — money collected,
// calls placed, leads received. Each is an event, and an event does not stop
// having happened.
//
// It is WRONG for anything that describes an outstanding condition. A case that
// went DNC on the 3rd may have been worked and cleared by the 30th. The EVENT
// ("went DNC on the 3rd") is durable and sums correctly; the IMPLICATION ("is a
// redline to chase") is current state, and current state is exactly what this
// system refuses to serve from Mongo.
//
// So a section declares `confirms: [...]` naming the fields whose merged value
// is a claim about NOW rather than a count of what happened. A range read
// surfaces that rather than quietly presenting a month-old chase list as live
// work — the same list is honest as history and dishonest as a to-do.
//
// The activity review already models this correctly for one day, which is why
// it reports `suspendedStatusChanges` beside `suspendedStillCurrent`: what
// moved, and what is still that way.

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const round4 = (n) => Math.round(Number(n || 0) * 10000) / 10000;
const finiteNumber = (v) => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const num = finiteNumber;

/** Sum a field across values, ignoring nulls. Returns null if NOTHING had it. */
function sumField(values, field) {
  let total = 0;
  let seen = false;
  for (const v of values) {
    const n = finiteNumber(v?.[field]);
    if (n == null) continue;
    total += n;
    seen = true;
  }
  return seen ? round2(total) : null;
}

/** Max a field across values. */
function maxField(values, field) {
  let best = null;
  for (const v of values) {
    const n = finiteNumber(v?.[field]);
    if (n == null) continue;
    best = best == null ? n : Math.max(best, n);
  }
  return best;
}

/** Merge {key: count} maps by summing. */
function mergeCountMaps(values, field) {
  const out = new Map();
  let seen = false;
  for (const v of values) {
    const map = v?.[field];
    if (!map || typeof map !== "object") continue;
    seen = true;
    for (const [k, n] of Object.entries(map)) {
      const numeric = Number(n);
      if (!Number.isFinite(numeric)) continue;
      out.set(k, (out.get(k) || 0) + numeric);
    }
  }
  return seen ? Object.fromEntries(out) : null;
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
      if (!byKey.has(key)) {
        const initial = { ...row };
        for (const field of numericFields) {
          if (initial[field] != null && finiteNumber(initial[field]) == null) initial[field] = null;
        }
        byKey.set(key, initial);
      }
      else {
        const acc = byKey.get(key);
        for (const f of numericFields) {
          const incoming = finiteNumber(row[f]);
          if (incoming == null) continue;
          acc[f] = round2((finiteNumber(acc[f]) || 0) + incoming);
        }
      }
    }
  }
  return seen ? [...byKey.values()] : null;
}

const presentObjects = (values) => values.filter((v) => v && typeof v === "object");

function mergeAgentAttribution(values) {
  const days = presentObjects(values);
  const attrs = presentObjects(days.map((v) => v?.attribution));
  if (!attrs.length) return null;
  const everyDayAttributed = attrs.length === days.length;

  // Nested attribution values are not top-level section fields, so sum them by
  // an explicit dotted path rather than teaching the generic helper two shapes.
  const sumPath = (path) => {
    const parts = path.split(".");
    let total = 0; let seen = false;
    for (const a of attrs) {
      const value = finiteNumber(parts.reduce((v, p) => v?.[p], a));
      if (value == null) continue;
      total += value; seen = true;
    }
    return seen ? round2(total) : null;
  };

  const spend = {
    mail: sumPath("spend.mail"),
    bcd: sumPath("spend.bcd"),
    ld: sumPath("spend.ld"),
    applicable: sumPath("spend.applicable"),
  };
  const mailOffered = sumPath("mailOffered");
  const bcdOffered = sumPath("bcdOffered");
  const ldLeadsBought = sumPath("ldLeadsBought");
  const expected = sumPath("reconciliation.expected");
  const attributed = sumPath("reconciliation.attributed");
  const unattributedTotal = sumPath("reconciliation.unattributed");
  const drift = expected == null || attributed == null || unattributedTotal == null
    ? null : round2(attributed + unattributedTotal - expected);
  const failures = [...new Set(attrs.flatMap((a) => a.reconciliation?.failures || []))];
  const tested = attrs.every((a) => a.reconciliation?.ok !== null
    && a.reconciliation?.ok !== undefined);
  const everyDayPassed = attrs.every((a) => a.reconciliation?.ok === true);

  return {
    mailApplies: attrs.some((a) => a.mailApplies === true),
    readable: {
      mail: everyDayAttributed && attrs.every((a) => a.readable?.mail === true),
      bcd: everyDayAttributed && attrs.every((a) => a.readable?.bcd === true),
      ld: everyDayAttributed && attrs.every((a) => a.readable?.ld === true),
    },
    mailOffered,
    mailMissed: sumPath("mailMissed"),
    bcdOffered,
    bcdMissed: sumPath("bcdMissed"),
    mailRate: mailOffered > 0 && spend.mail != null ? round4(spend.mail / mailOffered) : null,
    bcdRate: bcdOffered > 0 && spend.bcd != null ? round4(spend.bcd / bcdOffered) : null,
    ldRate: ldLeadsBought > 0 && spend.ld != null ? round4(spend.ld / ldLeadsBought) : null,
    ldLeadsBought,
    spend,
    unattributed: {
      mail: sumPath("unattributed.mail"),
      bcd: sumPath("unattributed.bcd"),
      ld: sumPath("unattributed.ld"),
      total: unattributedTotal,
    },
    unattributedByMissed: {
      mail: sumPath("unattributedByMissed.mail"),
      bcd: sumPath("unattributedByMissed.bcd"),
    },
    reconciliation: {
      ok: !everyDayAttributed
        ? false
        : tested && drift != null
          ? everyDayPassed && Math.abs(drift) < 0.005 && failures.length === 0
          : null,
      expected,
      attributed,
      unattributed: unattributedTotal,
      drift,
      failures,
    },
  };
}

function callHighlightAgent(row) {
  return String(row?.officer || row?.agent || "(unassigned)").trim() || "(unassigned)";
}

function callHighlightMinutes(row) {
  const minutes = Number(row?.minutes);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : 0;
}

function summarizeCallHighlights(rows = []) {
  const safeRows = Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object") : [];
  const byDirection = new Map();
  const byAgent = new Map();
  let over30Minutes = 0;
  let withRecording = 0;
  let totalMinutes = 0;
  for (const row of safeRows) {
    const minutes = callHighlightMinutes(row);
    totalMinutes += minutes;
    if (minutes >= 30) over30Minutes += 1;
    if (row.listenUrl) withRecording += 1;
    const direction = String(row.direction || "unknown");
    byDirection.set(direction, (byDirection.get(direction) || 0) + 1);
    const agent = callHighlightAgent(row);
    byAgent.set(agent, (byAgent.get(agent) || 0) + 1);
  }
  return {
    total: safeRows.length,
    over30Minutes,
    withRecording,
    totalMinutes: round2(totalMinutes),
    byDirection: Object.fromEntries(byDirection),
    byAgent: Object.fromEntries(byAgent),
  };
}

function mergeCallHighlights(values) {
  // Detail carries the complete rows. A range turns them into a bounded review
  // list: five longest calls per agent, while counts still cover every row.
  if (values.some(Array.isArray)) {
    const all = values.flatMap((rows) => (Array.isArray(rows) ? rows : []));
    const summary = summarizeCallHighlights(all);
    const byAgent = new Map();
    for (const row of all) {
      const agent = callHighlightAgent(row);
      if (!byAgent.has(agent)) byAgent.set(agent, []);
      byAgent.get(agent).push(row);
    }
    const rows = [...byAgent.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([, agentRows]) => agentRows
        .filter((row) => row.listenUrl)
        .sort((a, b) => callHighlightMinutes(b) - callHighlightMinutes(a))
        .slice(0, 5));
    return { ...summary, topPerAgent: 5, rows };
  }

  return {
    total: sumField(values, "total"),
    over30Minutes: sumField(values, "over30Minutes"),
    withRecording: sumField(values, "withRecording"),
    totalMinutes: sumField(values, "totalMinutes"),
    byDirection: mergeCountMaps(values, "byDirection") || {},
    byAgent: mergeCountMaps(values, "byAgent") || {},
  };
}

const BUILDERS = Object.freeze([
  {
    key: DAILY_SECTION_KEYS.SPEND,
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
    key: DAILY_SECTION_KEYS.FINANCIAL,
    label: "Money",
    build: (ctx) => ctx.section(REPORT_SECTION_IDS.TOPLINE),
    merge(values) {
      const out = Object.fromEntries(
        TOPLINE_ADDITIVE_FIELDS.map((field) => [field, sumField(values, field)]),
      );
      out.mailApplies = values.some((v) => v?.mailApplies === true);
      out.vendorBoard = values.every((v) => v?.vendorBoard === true);
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
    key: DAILY_SECTION_KEYS.CALLS,
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
    key: DAILY_SECTION_KEYS.CALL_HIGHLIGHTS,
    label: "Call highlights",
    build: (ctx) => ctx.section(REPORT_SECTION_IDS.LONG_CALLS),
    facts: summarizeCallHighlights,
    merge: mergeCallHighlights,
  },
  {
    key: DAILY_SECTION_KEYS.ACTIVITY,
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
    key: DAILY_SECTION_KEYS.BY_SOURCE,
    label: "By source",
    build: (ctx) => ctx.section(REPORT_SECTION_IDS.BY_SOURCE),
    merge(values) {
      // `cash` and `calls` are retained for old stored days. New report rows
      // use newCash/recurringCash/totalCash and responses. One contract can
      // read both without renaming the live report's actual fields.
      const rows = mergeRowsBy(
        values,
        "source",
        [...SOURCE_ROW_ADDITIVE_FIELDS, "cash", "calls"],
      );
      if (!rows) return null;
      return rows.map((row) => {
        const hasSplitCash = row.newCash != null || row.recurringCash != null;
        const totalCash = hasSplitCash
          ? round2(Number(row.newCash || 0) + Number(row.recurringCash || 0))
          : num(row.totalCash ?? row.cash);
        const denom = Number(row.responses || row.calls || row.leads || 0);
        return {
          ...row,
          totalCash,
          costPer: denom > 0 && Number(row.spend) > 0
            ? round2(Number(row.spend) / denom) : null,
          net: totalCash == null ? null : round2(totalCash - Number(row.spend || 0)),
          ...(row.source === AGED_LABEL
            ? { roas: null, roi: null, costPerAcquisition: null, profitMargin: null }
            : applyFunctions(
              {
                cost: row.spend,
                initial: row.newCash ?? row.cash,
                total: totalCash,
                deals: row.deals,
                calls: row.responses ?? row.calls,
                leads: row.leads,
              },
              ["roas", "roi", "costPerAcquisition", "profitMargin"],
            )),
        };
      });
    },
  },
  {
    key: DAILY_SECTION_KEYS.BY_AGENT,
    label: "By officer",
    build: (ctx) => ctx.section(REPORT_SECTION_IDS.BY_AGENT),
    merge(values) {
      const out = Object.fromEntries(
        AGENT_SUMMARY_ADDITIVE_FIELDS.map((field) => [field, sumField(values, field)]),
      );
      out.connectRate = Number(out.attemptsKnown) > 0
        ? Math.round((Number(out.connected || 0) / Number(out.attemptsKnown)) * 1000) / 10
        : null;
      out.avgTalkMinutes = Number(out.connected) > 0
        ? Math.round((Number(out.talkMinutes || 0) / Number(out.connected)) * 10) / 10
        : null;
      out.byOutcome = mergeCountMaps(values, "byOutcome") || {};
      out.newLeadsKnown = values.every((v) => v?.newLeadsKnown === true);
      out.dialsUnavailable = [...new Set(values.map((v) => v?.dialsUnavailable).filter(Boolean))].join("; ") || null;
      out.queueUnavailable = [...new Set(values.map((v) => v?.queueUnavailable).filter(Boolean))].join("; ") || null;
      out.longThresholdMinutes = maxField(values, "longThresholdMinutes");
      out.attribution = mergeAgentAttribution(values);
      out.agents = mergeRowsBy(
        values.map((v) => v?.agents),
        "agent",
        AGENT_ROW_ADDITIVE_FIELDS,
      ) || [];
      return out;
    },
  },
  {
    key: DAILY_SECTION_KEYS.STATUS,
    label: "Status movement",
    build: (ctx) => ctx.section(REPORT_SECTION_IDS.STATUS),
    // The COUNTS are events and sum correctly: a case that went DNC on the 3rd
    // went DNC on the 3rd, whatever happened afterwards. The redline LIST is a
    // claim about now — those cases may since have been worked — so over a range
    // it is history, not a to-do, until confirmed against live status.
    confirms: Object.freeze(["keyChanges"]),
    merge(values) {
      return {
        ...Object.fromEntries(
          STATUS_ADDITIVE_FIELDS.map((field) => [field, sumField(values, field)]),
        ),
        // De-duplicated by domain+case+LANE, not by case: one case can go
        // suspended AND dnc in a range, and those are two different chases.
        //
        // Only ever populated when folding the `detail` view — the sanitizer
        // strips keyChanges from `facts`, which is correct, because a range
        // summing facts should not be dragging customer case rows through it.
        keyChanges: mergeRowsBy(
          values
            .map((v) => v?.keyChanges)
            .filter(Array.isArray)
            .map((rows) => rows.map((r) => ({ ...r, _k: `${r.domain}:${r.caseId}:${r.lane}` }))),
          "_k", [],
        ),
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
 * Preserve a section's write-once fields while allowing its event-backed
 * fields to correct themselves on a later pass.
 *
 * Kept beside the registry so every writer applies the same rule. Returning a
 * new object prevents a persistence retry from mutating the in-memory report
 * that is about to be emailed.
 */
function preserveFrozenFields(key, stored, fresh) {
  const frozen = frozenFieldsFor(key);
  if (!frozen || !stored || !fresh || typeof stored !== "object" || typeof fresh !== "object") {
    return { value: fresh, preserved: [] };
  }
  const value = { ...fresh };
  const preserved = [];
  for (const field of frozen) {
    if (stored[field] == null) continue;
    if (JSON.stringify(stored[field]) !== JSON.stringify(fresh[field])) {
      preserved.push(`${key}.${field}`);
    }
    value[field] = stored[field];
  }
  if (key === DAILY_SECTION_KEYS.SPEND
    && ["mail", "ld", "bcd"].some((field) => value[field] != null)) {
    value.total = round2(
      (finiteNumber(value.mail) || 0)
      + (finiteNumber(value.ld) || 0)
      + (finiteNumber(value.bcd) || 0),
    );
  }
  return { value, preserved };
}

/**
 * Fields whose merged value is a claim about NOW, not a count of what happened.
 *
 * Summing them across a range is arithmetically fine and semantically wrong: the
 * cases in a month-old redline list may have been worked since. A caller
 * presenting one of these as outstanding work must confirm it against live
 * status first — over a single day the gap is minutes and the risk is small;
 * over a month it is the difference between a to-do list and a history.
 */
function confirmFieldsFor(key) {
  return BY_KEY.get(key)?.confirms || null;
}

/**
 * Which sections in a merged result carry an unconfirmed claim, and which
 * fields. Empty when the range is a single day, because a day's snapshot and
 * that day's live state are the same thing to within the pass that wrote it.
 */
function unconfirmedIn(sections = {}, { days = 1 } = {}) {
  const out = [];
  for (const [key, value] of Object.entries(sections)) {
    const fields = confirmFieldsFor(key);
    if (!fields || value == null) continue;
    const present = fields.filter((f) => {
      const v = value[f];
      return Array.isArray(v) ? v.length > 0 : v != null;
    });
    if (present.length && days > 1) out.push({ section: key, fields: present, days });
  }
  return out;
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
  preserveFrozenFields,
  confirmFieldsFor,
  unconfirmedIn,
  mergeSection,
  // exported for tests and for reuse by any future section
  sumField,
  maxField,
  mergeCountMaps,
  mergeRowsBy,
  summarizeCallHighlights,
};
