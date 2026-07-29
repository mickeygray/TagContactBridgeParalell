"use strict";

// REPORT OPS — the deterministic verbs every report and cohort is built from.
//
// Guide Part 3.1. PURE: no I/O, no clock, no model. Given the same material
// these return the same numbers forever, which is what makes a model-authored
// plan safe to execute — the model chooses WHICH ops, never what they compute.
//
// Two rules learned the hard way and encoded here:
//   · a dimension belongs to a MATERIAL. Grouping payments by "agent" is a
//     category error and rejects, rather than yielding empty buckets that
//     look like an answer.
//   · anything that can silently match nothing says so. A filter that hits
//     zero rows, a compare against a bucket that does not exist, a cohort
//     with no attribution — each surfaces instead of returning zeros.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── dimensions, scoped to the material they belong to ────────────────────
const DIMENSIONS = Object.freeze({
  payments: ["officer", "source", "cohort", "domain", "day", "month", "tag", "method"],
  declines: ["officer", "source", "domain", "day", "month", "method"],
  queue: ["agent", "stream"],
  dials: ["agent", "pool", "day"],
  events: ["kind", "domain", "day", "createdBy"],
});

const MEASURES = Object.freeze([
  "cash", "newCash", "recurringCash", "deals", "payments", "count",
  "declines", "declinedAmount", "dials", "connects", "responses", "spend",
]);

/** The one place that knows how to read a dimension off a payment row. */
function dimensionValue(row, dimension) {
  switch (dimension) {
    // "(no snapshot)" means we never captured who closed it; "(unassigned)"
    // means we looked and nobody owns it. Different problems, different fixes.
    case "officer":
      if (row.officerAtSale) return row.officerAtSale;
      return row.attributionSnapshot === "missing" ? "(no snapshot)" : "(unassigned)";
    case "source":
      if (row.sourceAtSale) return row.sourceAtSale;
      return row.attributionSnapshot === "missing" ? "(no snapshot)" : "(unsourced)";
    case "cohort": {
      // The attribution snapshot is the ONLY honest cohort source. Falling
      // back to payment year would quietly file a 2021 client under 2026 —
      // so an unattributed row gets its own bucket and stays visible.
      const first = row.metricsTreatment?.firstPaidDateKey;
      return first ? String(first).slice(0, 4) : "(unattributed)";
    }
    case "domain": return String(row.domain || "").toUpperCase() || "(none)";
    case "day": return String(row.paymentDateKey || "").slice(0, 10) || "(undated)";
    case "month": return String(row.paymentDateKey || "").slice(0, 7) || "(undated)";
    case "tag": return row.tag?.name || "(untagged)";
    case "method": return row.method?.name || "(unknown)";
    case "agent": return row.agent || row.officer || "(unknown)";
    case "stream": return row.stream || "(unknown)";
    case "pool": return row.originPool || "(unknown)";
    case "kind": return row.kind || "(unknown)";
    case "createdBy": return row.createdBy || "(unknown)";
    default: return "(unknown)";
  }
}

function assertDimension(material, dimension) {
  const allowed = DIMENSIONS[material];
  if (!allowed) throw new Error(`unknown material "${material}" — have: ${Object.keys(DIMENSIONS).join(", ")}`);
  if (!allowed.includes(dimension)) {
    throw new Error(`"${dimension}" is not a dimension of ${material} — have: ${allowed.join(", ")}`);
  }
  return dimension;
}

/** Group rows into buckets. Returns an ARRAY so order is explicit. */
function groupBy(rows = [], dimension, { material = "payments" } = {}) {
  assertDimension(material, dimension);
  const map = new Map();
  for (const row of rows) {
    const key = dimensionValue(row, dimension);
    if (!map.has(key)) map.set(key, { key, dimension, rows: [] });
    map.get(key).rows.push(row);
  }
  return [...map.values()];
}

/** Compute measures over a bucket (or any row array). */
function measure(bucketOrRows, measures = ["count"]) {
  const rows = Array.isArray(bucketOrRows) ? bucketOrRows : (bucketOrRows?.rows || []);
  const out = {};
  for (const name of measures) {
    if (!MEASURES.includes(name)) throw new Error(`unknown measure "${name}" — have: ${MEASURES.join(", ")}`);
    switch (name) {
      case "count": out.count = rows.length; break;
      case "payments": out.payments = rows.length; break;
      case "cash": out.cash = round2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)); break;
      case "newCash": out.newCash = round2(rows.filter((r) => r.paymentType === "initial").reduce((s, r) => s + (Number(r.amount) || 0), 0)); break;
      case "recurringCash": out.recurringCash = round2(rows.filter((r) => r.paymentType !== "initial").reduce((s, r) => s + (Number(r.amount) || 0), 0)); break;
      // A DEAL is a SALE, not a payment row. A first invoice paid in two
      // installments is two initial rows and one deal; counting rows
      // inflates every deal-based ratio (cost per acquisition falls, close
      // rate rises) for exactly the cases that were hardest to collect.
      case "deals": out.deals = new Set(rows.filter((r) => r.paymentType === "initial")
        .map((r) => `${r.domain}:${r.caseId}`)).size; break;
      case "declines": out.declines = rows.length; break;
      case "declinedAmount": out.declinedAmount = round2(rows.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0)); break;
      case "dials": out.dials = rows.reduce((s, r) => s + (Array.isArray(r.attempts) ? r.attempts.length : 1), 0); break;
      case "connects": out.connects = rows.reduce((s, r) => s + (Array.isArray(r.attempts) ? r.attempts.filter((a) => a?.connected).length : (r.connected ? 1 : 0)), 0); break;
      case "responses": out.responses = rows.reduce((s, r) => s + (Number(r.responses) || 0), 0); break;
      case "spend": out.spend = round2(rows.reduce((s, r) => s + (Number(r.spend) || 0), 0)); break;
      default: break;
    }
  }
  return out;
}

/**
 * Share of a measure across buckets.
 *
 * `of` is EXPLICIT because the natural follow-up question changes the
 * denominator: "what share of BRUCE's money" (filtered) is a different
 * question from "what share of ALL money is Bruce's" (all), and a tool that
 * silently picks one will answer the wrong one half the time.
 */
function shareOf(buckets = [], measureName = "cash", { of = "filtered", allRows = null } = {}) {
  const measured = buckets.map((b) => ({ ...b, ...measure(b, [measureName]) }));
  let denominator;
  if (of === "all") {
    if (!Array.isArray(allRows)) throw new Error('shareOf({ of: "all" }) requires allRows (the pre-filter population)');
    denominator = measure(allRows, [measureName])[measureName] || 0;
  } else {
    denominator = measured.reduce((s, b) => s + (b[measureName] || 0), 0);
  }
  return measured.map((b) => ({
    ...b,
    denominator,
    denominatorOf: of,
    share: denominator > 0 ? Math.round(((b[measureName] || 0) / denominator) * 1000) / 10 : null,
  }));
}

/** Prefix/exact match, the same rule filters use, so "Urgent" finds the piece. */
function findBucket(buckets, selector) {
  const want = String(selector || "").toLowerCase();
  return buckets.find((b) => String(b.key).toLowerCase() === want)
    || buckets.find((b) => String(b.key).toLowerCase().startsWith(want))
    || null;
}

/** Compare two buckets head to head. Hard-errors with the available keys. */
function compare(buckets = [], { a, b } = {}, measures = ["cash", "deals"]) {
  const left = findBucket(buckets, a);
  const right = findBucket(buckets, b);
  const missing = [];
  if (!left) missing.push(a);
  if (!right) missing.push(b);
  if (missing.length) {
    throw new Error(`compare: no bucket matching ${missing.map((m) => `"${m}"`).join(" or ")} — available: ${buckets.map((x) => x.key).join(", ") || "(none)"}`);
  }
  const lm = measure(left, measures);
  const rm = measure(right, measures);
  const deltas = {};
  for (const name of measures) {
    const lv = Number(lm[name]) || 0;
    const rv = Number(rm[name]) || 0;
    deltas[name] = { a: lv, b: rv, delta: round2(lv - rv), ratio: rv !== 0 ? round2(lv / rv) : null };
  }
  return { a: left.key, b: right.key, measures: deltas };
}

/** last-10 digits — the cross-tenant identity key. */
const last10 = (v) => String(v || "").replace(/[^0-9]/g, "").slice(-10);

/**
 * FUNNEL GAP — everything in A whose join key is absent from B.
 *
 * The shape behind every cohort question: "did X but not Y". The AMITY
 * audit is funnelGap(ucfsApprovals, tagLoansPosted, { by: "phone" }).
 */
function funnelGap(populationA = [], populationB = [], { by = "case", keyOfA = null, keyOfB = null } = {}) {
  const keyFor = (row, custom) => {
    if (typeof custom === "function") return custom(row);
    if (by === "phone") return last10(row.phone || row.normalizedPhone);
    if (by === "person") return String(row.name || row.clientName || "").trim().toLowerCase();
    return `${String(row.domain || "").toUpperCase()}:${row.caseId}`;
  };
  const bKeys = new Set(populationB.map((r) => keyFor(r, keyOfB)).filter(Boolean));
  const gap = [];
  const unkeyed = [];
  for (const row of populationA) {
    const key = keyFor(row, keyOfA);
    if (!key) { unkeyed.push(row); continue; }
    if (!bKeys.has(key)) gap.push({ ...row, gapKey: key });
  }
  return {
    gap,
    matched: populationA.length - gap.length - unkeyed.length,
    // Rows that cannot be keyed are NOT silently in the gap — an AMITY case
    // with no phone on file is unknown, not proven-missing.
    unkeyed,
    by,
  };
}

/**
 * Dial attempts before a case closed.
 *
 * TWO traps, both live-observed:
 *  · DailyDial.caseId is a STRING, PaymentTruth.caseId is a Number.
 *  · Day granularity: the modal deal closes the SAME DAY it was dialed (all
 *    5 of 2026-07-27's deals did), so "before close" at day resolution is
 *    ambiguous. Same-day attempts are counted AND reported separately so the
 *    pattern stays visible rather than being smeared either way.
 */
function joinAttempts(payments = [], dials = [], { closeDateKey = "paymentDateKey" } = {}) {
  const dialsByCase = new Map();
  for (const d of dials) {
    const key = `${String(d.domain || "").toUpperCase()}:${String(d.caseId)}`;
    if (!dialsByCase.has(key)) dialsByCase.set(key, []);
    dialsByCase.get(key).push(d);
  }
  const out = [];
  for (const p of payments) {
    const key = `${String(p.domain || "").toUpperCase()}:${String(p.caseId)}`;
    const closedOn = String(p[closeDateKey] || "").slice(0, 10);
    const rows = dialsByCase.get(key) || [];
    let before = 0; let sameDay = 0; let after = 0;
    for (const d of rows) {
      const attempts = Array.isArray(d.attempts) ? d.attempts : [];
      const day = String(d.dateKey || "").slice(0, 10);
      const n = attempts.length || 1;
      if (!closedOn || !day) continue;
      if (day < closedOn) before += n;
      else if (day === closedOn) sameDay += n;
      else after += n;
    }
    out.push({
      domain: p.domain, caseId: p.caseId, closedOn,
      attemptsBeforeClose: before,
      sameDayAttempts: sameDay,
      attemptsAfterClose: after,
      totalAttempts: before + sameDay + after,
      // The honest headline: everything up to and including the close day.
      attemptsToClose: before + sameDay,
      hadDialRecord: rows.length > 0,
    });
  }
  return out;
}

/** Days between a call and the payment it preceded. */
// Sources that are NOT mail and therefore may legitimately belong to any
// tenant: the broadcast dialer, and anything named for the tenant itself.
// NO backslash escapes on purpose. A word-boundary escape written through a
// generator layer has silently become a literal 0x08 backspace three times in
// this codebase — a regex that matches nothing and fails open. A bare /bcd/i
// is the opposite failure: it also matches "ABCDEF".
const BCD_SOURCE = /(?:^|[^A-Za-z])BCD(?:[^A-Za-z]|$)/i;

/**
 * May a call on `source` count as evidence for a deal in `domain`?
 *
 * Mail is bought for one tenant (TAG), so a mail-sourced call matching a WYNN
 * case is an artifact of the shared CallRail account. BCD runs for several
 * tenants, so it matches anywhere.
 */
function sourceFitsDomain(source, domain, { mailTenant = "TAG" } = {}) {
  const dom = String(domain || "").toUpperCase();
  if (dom === String(mailTenant).toUpperCase()) return true;
  const name = String(source || "");
  if (!name) return false;                    // unknown source: do not assume
  if (BCD_SOURCE.test(name)) return true;     // broadcast dialer runs everywhere
  return name.toUpperCase().includes(dom);    // e.g. "WYNN TAX SOLUTIONS - ..."
}

/**
 * THE attribution call for a deal.
 *
 * Mickey 2026-07-28: "attribution for me is longest call on the day the deal
 * closed." So: of the calls on the close day, the longest wins (latest breaks
 * a tie). No close-day call → the longest call on the latest day BEFORE the
 * close. Calls after the close never attribute. This replaces first-call-wins
 * and most-recent-wins, which both existed and disagreed.
 */
function pickAttributionCall(calls = [], closeDateKey) {
  if (!closeDateKey) return { call: null, basis: null };
  const day = (c) => String(c.dateKey || c.startedAt || c.start_time || c.startTime || "").slice(0, 10);
  const dur = (c) => Number(c.durationSec ?? c.durationSeconds ?? c.duration) || 0;
  const at = (c) => Date.parse(c.startedAt || c.start_time || c.startTime || 0) || 0;
  const best = (list) => list.slice().sort((a, b) => dur(b) - dur(a) || at(b) - at(a))[0] || null;

  const onDay = calls.filter((c) => day(c) === String(closeDateKey));
  if (onDay.length) return { call: best(onDay), basis: "longest-close-day" };

  const before = calls.filter((c) => day(c) && day(c) < String(closeDateKey));
  if (!before.length) return { call: null, basis: null };
  const lastDay = before.map(day).sort().pop();
  return { call: best(before.filter((c) => day(c) === lastDay)), basis: "longest-prior-day" };
}

function lag(payments = [], calls = [], { by = "phone", mailTenant = "TAG" } = {}) {
  const callsByKey = new Map();
  for (const c of calls) {
    const key = by === "phone" ? last10(c.phone || c.customer_phone_number) : `${c.domain}:${c.caseId}`;
    if (!key) continue;
    if (!callsByKey.has(key)) callsByKey.set(key, []);
    callsByKey.get(key).push(c);
  }
  return payments.map((p) => {
    // A case has several numbers (cell/home/work/spouse) and the client calls
    // in on whichever they like — matching only the "primary" one silently
    // reports a covered deal as uncovered.
    const keys = by === "phone"
      ? [...new Set([p.phone, ...(p.phones || [])].map(last10).filter(Boolean))]
      : [`${p.domain}:${p.caseId}`];
    // CallRail is ONE account shared by the tenants, so a match is only
    // evidence if the SOURCE could plausibly belong to this domain.
    // Mickey 2026-07-28: "all the bcd will be in call rail but mail is all in
    // tag" — so BCD (and a tenant's own named sources) match anywhere, while
    // a mail piece matching a non-TAG case is a false positive by construction.
    const eligible = keys.flatMap((k) => callsByKey.get(k) || [])
      .filter((c) => sourceFitsDomain(c.source || c.source_name, p.domain, { mailTenant }));
    const rejectedMail = !eligible.length
      && keys.flatMap((k) => callsByKey.get(k) || []).length > 0;
    const matches = eligible
      .slice().sort((a, b) => Date.parse(a.startedAt || a.start_time || 0) - Date.parse(b.startedAt || b.start_time || 0));
    const first = matches[0] || null;
    const callAt = first ? (first.startedAt || first.start_time) : null;
    // Timing is first-call (how long from first contact to money); the SOURCE
    // follows the attribution rule (longest call on the close day).
    const attribution = pickAttributionCall(matches, p.paymentDateKey);
    const paidAt = p.paymentDateKey || null;
    const days = callAt && paidAt
      ? Math.round((Date.parse(`${paidAt}T12:00:00Z`) - Date.parse(callAt)) / 86400000)
      : null;
    return {
      domain: p.domain, caseId: p.caseId, amount: p.amount, name: p.name || null,
      callAt: callAt || null, firstCallAt: callAt || null, paidAt, days,
      source: attribution.call
        ? (attribution.call.source || attribution.call.source_name || null)
        : (first ? (first.source || first.source_name || null) : null),
      attributionBasis: attribution.basis || (first ? "first-call-fallback" : null),
      calls: matches.length,
      // "no phone on file" is a different gap from "we have the number and
      // no call came in" — the first is our record-keeping, the second is
      // a real marketing fact. Keep them apart.
      // CallRail only sees calls to TRACKING numbers. A call to the main DID
      // or a direct extension lives in CallLog and can never appear here, so
      // "no match" means CallRail did not see it — NOT that nobody called.
      // A 45-minute inbound call on case 275341 was proved to exist in
      // CallLog while this matcher reported no call at all.
      reason: first ? null
        : rejectedMail ? "mail-source-is-tag-only"
          : (keys.length ? "no-callrail-match" : "no-phone-on-file"),
      priorCalls: first?.priorCalls ?? null,
      firstCall: first?.firstCall ?? null,
      // Coverage is TAG-only for CallRail; a WYNN deal with no call is
      // "not covered", not "zero days".
      coverage: first ? "matched" : "no-call-coverage",
    };
  });
}

/** Median / quartiles / simple buckets over numbers. */
function distribution(values = [], { buckets = null } = {}) {
  const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return { n: 0, median: null, p25: null, p75: null, p90: null, min: null, max: null, buckets: [] };
  const at = (q) => nums[Math.min(nums.length - 1, Math.floor(q * nums.length))];
  const out = {
    n: nums.length, min: nums[0], max: nums[nums.length - 1],
    median: at(0.5), p25: at(0.25), p75: at(0.75), p90: at(0.9),
    mean: round2(nums.reduce((s, v) => s + v, 0) / nums.length),
    buckets: [],
  };
  if (Array.isArray(buckets) && buckets.length) {
    out.buckets = buckets.map((edge, i) => {
      const lo = i === 0 ? -Infinity : buckets[i - 1];
      return { lo: i === 0 ? null : lo, hi: edge, n: nums.filter((v) => v > lo && v <= edge).length };
    });
    out.buckets.push({ lo: buckets[buckets.length - 1], hi: null, n: nums.filter((v) => v > buckets[buckets.length - 1]).length });
  }
  return out;
}

function rank(buckets = [], measureName = "cash", { desc = true } = {}) {
  return buckets
    .map((b) => ({ ...b, ...measure(b, [measureName]) }))
    .sort((x, y) => (desc ? 1 : -1) * ((y[measureName] || 0) - (x[measureName] || 0)));
}

const topN = (buckets, measureName, n = 5) => rank(buckets, measureName).slice(0, Math.max(1, n));

function threshold(buckets = [], measureName = "cash", { op = ">=", value = 0 } = {}) {
  const measured = buckets.map((b) => ({ ...b, ...measure(b, [measureName]) }));
  return measured.filter((b) => {
    const v = Number(b[measureName]) || 0;
    if (op === ">") return v > value;
    if (op === "<") return v < value;
    if (op === "<=") return v <= value;
    if (op === "=") return v === value;
    return v >= value;
  });
}

/**
 * Join spend onto source buckets.
 *
 * Documented asymmetry: spend is per SOURCE, never per officer. So a
 * cost-per computed on an officer-filtered population divides WHOLE-source
 * spend by that officer's slice — which is not that officer's cost. The
 * flag makes the caveat travel with the number instead of living in
 * someone's head.
 */
function spendJoin(buckets = [], spendBySource = {}, { officerFiltered = false } = {}) {
  return buckets.map((b) => {
    const spend = round2(Number(spendBySource[b.key]?.spend ?? spendBySource[b.key] ?? 0));
    const m = measure(b, ["cash", "deals"]);
    return {
      ...b, ...m, spend,
      net: round2(m.cash - spend),
      costPerDeal: m.deals > 0 && spend > 0 ? round2(spend / m.deals) : null,
      spendIsWholeSource: Boolean(officerFiltered) || undefined,
    };
  });
}


// ── THE FUNCTIONS ────────────────────────────────────────────────────────
//
// Mickey 2026-07-29 laid the toolkit out as three parts:
//
//   substrates        costs · counts · money (initial and total)
//   factors           piece/source · settlement officer · time range
//   functions         roi · roas · cost per call · cost per lead ·
//                     cost per acquisition · profit margin
//
// These used to live INSIDE the blocks — `source` computed ROAS privately,
// `net` computed ROI privately — so every new combination meant another
// hand-written block. Lifted out here they take a substrate bundle and return
// a number, which is what makes "combine these factors" a composition rather
// than a request for more code. It is also the only shape a model can safely
// drive: it picks from this registry, it never invents arithmetic.
//
// EVERY function returns null rather than a number it cannot honestly compute.
// Dividing by a zero denominator is the difference between "no return" and
// "infinite return", and this codebase has already shipped a 23,125% once.

// What share of collected money is actually ours. A business assumption, so
// it is configurable rather than a magic number buried in a formula.
const PROFIT_MARGIN_RATE = Number(process.env.PROFIT_MARGIN_RATE) > 0
  ? Number(process.env.PROFIT_MARGIN_RATE)
  : 0.8;

const pctOrNull = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const moneyOrNull = (num, den) => (den > 0 ? Math.round((num / den) * 100) / 100 : null);

const FUNCTIONS = Object.freeze({
  roi: {
    label: "ROI",
    unit: "%",
    needs: ["total", "cost"],
    hint: "net return over cost — (total money − cost) / cost",
    compute: ({ total = 0, cost = 0 }) => pctOrNull(total - cost, cost),
  },
  roas: {
    label: "ROAS",
    unit: "%",
    needs: ["initial", "cost"],
    hint: "what the spend recouped in NEW business — initial / cost",
    compute: ({ initial = 0, cost = 0 }) => pctOrNull(initial, cost),
  },
  costPerCall: {
    label: "Cost / call",
    unit: "$",
    needs: ["cost", "calls"],
    hint: "spend divided by calls received",
    compute: ({ cost = 0, calls = 0 }) => moneyOrNull(cost, calls),
  },
  costPerLead: {
    label: "Cost / lead",
    unit: "$",
    needs: ["cost", "leads"],
    hint: "spend divided by leads delivered",
    compute: ({ cost = 0, leads = 0 }) => moneyOrNull(cost, leads),
  },
  costPerAcquisition: {
    label: "Cost / acquisition",
    unit: "$",
    needs: ["cost", "deals"],
    hint: "spend divided by SALES closed — the one that decides if a piece pays",
    compute: ({ cost = 0, deals = 0 }) => moneyOrNull(cost, deals),
  },
  profitMargin: {
    label: "Profit margin",
    unit: "$",
    needs: ["total", "cost"],
    hint: `(total money x ${PROFIT_MARGIN_RATE}) − cost`,
    // Dollars, not a ratio: this is what is left, not a rate of return.
    compute: ({ total = 0, cost = 0 }) => Math.round((total * PROFIT_MARGIN_RATE - cost) * 100) / 100,
  },
});

/**
 * Run the named functions over one substrate bundle.
 *
 * A bundle is { cost, initial, total, calls, leads, deals } — whatever the
 * caller has. A function whose inputs are absent returns null instead of
 * treating a missing count as a zero.
 */
function applyFunctions(substrates = {}, names = Object.keys(FUNCTIONS)) {
  const out = {};
  for (const name of names) {
    const fn = FUNCTIONS[name];
    if (!fn) {
      throw new Error(`unknown function "${name}" — available: ${Object.keys(FUNCTIONS).join(", ")}`);
    }
    const missing = fn.needs.filter((k) => substrates[k] === undefined || substrates[k] === null);
    out[name] = missing.length ? null : fn.compute(substrates);
  }
  return out;
}

/** Render one function's value the way it should read. */
function formatFunction(name, value) {
  if (value === null || value === undefined) return "—";
  const fn = FUNCTIONS[name];
  if (!fn) return String(value);
  if (fn.unit === "%") return `${value}%`;
  return `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}


/**
 * Which row a payment's money belongs on, in the source view.
 *
 * Extracted so the `source` block and the ad-hoc ask tool cannot drift. Run
 * raw, groupBy("source") splits one mail piece across every spelling it has
 * ever had (measured: the pink piece appeared as three separate rows, with
 * spend landing on only one of them) and lets residual money keep a live
 * piece's name.
 */
function resolveSourceRow(payment, { rangeStart = null, rangeEnd = null, attributionCallDate = null } = {}) {
  const {
    canonicalSourceName, isCatchAllName,
  } = require("./logicsSourceWriterService");
  const { sourceBucket } = require("../../shared-config/src/activeSources");

  const folded = canonicalSourceName(payment.domain, payment.sourceAtSale);
  if (!folded) {
    if (payment.sourceOrigin === "catch-all") {
      return payment.catchAllLabel ? `${payment.catchAllLabel} (catch-all)` : "(Logics catch-all)";
    }
    return "(unsourced)";
  }
  if (isCatchAllName(folded)) return `${folded} (catch-all)`;
  return sourceBucket(folded, {
    firstPaidDateKey: payment.metricsTreatment?.firstPaidDateKey || null,
    caseCreatedDate: payment.caseCreatedDate,
    attributionCallDate,
    rangeStart,
    rangeEnd,
  });
}

/**
 * Fold a SPEND or CALL source spelling onto the row its money lands on.
 *
 * Spend, CallRail responses and payments each arrive under their own
 * spelling of the same piece. Join them raw and the cost sits on one row
 * while the deals sit on another: every cost-per reads "—" and the piece
 * that actually paid for itself shows an infinite return.
 *
 * A spelling nobody is running any more folds to Aged, which is what keeps
 * last year's mail from wearing a live piece's name.
 */
function foldSourceKey(source, { mailTenant = "TAG" } = {}) {
  const { canonicalSourceName, isCatchAllName } = require("./logicsSourceWriterService");
  const { isActiveSource, AGED_LABEL } = require("../../shared-config/src/activeSources");
  const folded = canonicalSourceName(mailTenant, source) || source;
  return isActiveSource(folded) || isCatchAllName(folded) ? folded : AGED_LABEL;
}

/**
 * Build the payment -> attribution-date lookup from a range of calls.
 *
 * Mickey 2026-07-28: "attribution for me is longest call on the day the deal
 * closed." That date decides whether a payment counts for a live piece or
 * demotes to Aged, so a caller that skips it silently reports a DIFFERENT
 * set of deals — which is exactly how ask.js and the source block came to
 * disagree by a deal per row.
 *
 * MARKETING lines only: CallRail also tracks servicing numbers, and an
 * existing client ringing support must not make their case look freshly
 * sourced.
 */
function attributionDateResolver(callsRange = []) {
  const { sourceChannel } = require("../../shared-config/src/activeSources");
  const byPhone = new Map();
  for (const call of callsRange) {
    const k = last10(call.phone);
    if (!k) continue;
    if (sourceChannel(call.source) === "other") continue;
    if (!byPhone.has(k)) byPhone.set(k, []);
    byPhone.get(k).push(call);
  }
  return function attributionDateFor(payment) {
    const keys = [...new Set([payment.phone, ...(payment.phones || [])].map(last10).filter(Boolean))];
    if (!keys.length) return null;
    const calls = keys.flatMap((k) => byPhone.get(k) || []);
    if (!calls.length) return null;
    const picked = pickAttributionCall(calls, payment.paymentDateKey);
    const c = picked.call || calls[0];
    return String(c?.dateKey || c?.startedAt || "").slice(0, 10) || null;
  };
}

module.exports = {
  attributionDateResolver,
  foldSourceKey,
  FUNCTIONS,
  resolveSourceRow,
  PROFIT_MARGIN_RATE,
  applyFunctions,
  formatFunction,
  pickAttributionCall,
  sourceFitsDomain,
  DIMENSIONS,
  MEASURES,
  assertDimension,
  compare,
  dimensionValue,
  distribution,
  findBucket,
  funnelGap,
  groupBy,
  joinAttempts,
  lag,
  last10,
  measure,
  rank,
  shareOf,
  spendJoin,
  threshold,
  topN,
};
