"use strict";

// G1 gate — the ops library must reproduce numbers already measured against
// live data this session. If a primitive cannot rebuild the thing that
// motivated it, it is a second implementation, not a generalisation.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const ops = require("../../packages/shared-services/src/reportOpsService");

// ── fixtures cut from real shapes ────────────────────────────────────────
const pay = (o) => ({
  domain: "TAG", transactionStatus: "SUCCESS", isChargeback: false,
  paymentType: "recurring", ...o,
});

// Bruce's 2026-07-27 deals, and one 2024-cohort recurring payment.
const PAYMENTS = [
  pay({ caseId: 420201, amount: 200, paymentType: "initial", officerAtSale: "Bruce Allen", sourceAtSale: "3rd Day (Pink) Urgent Third State", paymentDateKey: "2026-07-27", metricsTreatment: { firstPaidDateKey: "2026-07-27" } }),
  pay({ caseId: 423090, amount: 1216.67, paymentType: "initial", officerAtSale: "Bruce Allen", sourceAtSale: "Urgent Third State", paymentDateKey: "2026-07-27", metricsTreatment: { firstPaidDateKey: "2026-07-27" } }),
  pay({ caseId: 426256, amount: 300, paymentType: "initial", officerAtSale: "Bruce Allen", sourceAtSale: "Affordability Federal", paymentDateKey: "2026-07-27", metricsTreatment: { firstPaidDateKey: "2026-07-27" } }),
  pay({ caseId: 423568, amount: 300, paymentType: "initial", officerAtSale: "Phil Olson", sourceAtSale: "3rd Day (Pink) Urgent Third State", paymentDateKey: "2026-07-27", metricsTreatment: { firstPaidDateKey: "2026-07-27" } }),
  pay({ caseId: 419604, amount: 1226.33, paymentType: "initial", officerAtSale: "Phil Olson", sourceAtSale: "Urgent Third Pink State", paymentDateKey: "2026-07-27", metricsTreatment: { firstPaidDateKey: "2026-07-27" } }),
  pay({ caseId: 111, amount: 500, officerAtSale: null, sourceAtSale: null, paymentDateKey: "2026-07-27", metricsTreatment: { firstPaidDateKey: "2024-03-02" } }),
  pay({ caseId: 222, amount: 250, officerAtSale: null, sourceAtSale: null, paymentDateKey: "2026-07-26", metricsTreatment: {} }),  // unattributed
];

test("groupBy officer + measure reproduces the 2026-07-27 officer table", () => {
  const buckets = ops.groupBy(PAYMENTS, "officer");
  const bruce = ops.findBucket(buckets, "Bruce Allen");
  const phil = ops.findBucket(buckets, "Phil Olson");
  assert.deepEqual(ops.measure(bruce, ["deals", "newCash"]), { deals: 3, newCash: 1716.67 });
  assert.deepEqual(ops.measure(phil, ["deals", "newCash"]), { deals: 2, newCash: 1526.33 });
});

test("cohort puts a missing attribution in its OWN bucket, never payment-year", () => {
  const buckets = ops.groupBy(PAYMENTS, "cohort");
  const keys = buckets.map((b) => b.key).sort();
  assert.ok(keys.includes("2024"), "the 2024-cohort payment lands in 2024");
  assert.ok(keys.includes("(unattributed)"), "no snapshot ⇒ unattributed, not 2026");
  const twentyFour = ops.findBucket(buckets, "2024");
  assert.equal(ops.measure(twentyFour, ["cash"]).cash, 500);
});

test("a dimension from the wrong material REJECTS instead of returning empties", () => {
  assert.throws(() => ops.groupBy(PAYMENTS, "agent"), /not a dimension of payments/);
  assert.throws(() => ops.groupBy(PAYMENTS, "nonsense"), /not a dimension of payments/);
  assert.doesNotThrow(() => ops.groupBy([{ agent: "chris_bolt" }], "agent", { material: "dials" }));
});

test("shareOf denominator is explicit — filtered vs all differ", () => {
  const bruceOnly = PAYMENTS.filter((p) => p.officerAtSale === "Bruce Allen");
  const buckets = ops.groupBy(bruceOnly, "cohort");
  const filtered = ops.shareOf(buckets, "cash", { of: "filtered" });
  assert.equal(filtered[0].share, 100, "all of Bruce's money is one cohort");
  const all = ops.shareOf(buckets, "cash", { of: "all", allRows: PAYMENTS });
  assert.ok(all[0].share < 100, "as a share of EVERYONE it must be less");
  assert.throws(() => ops.shareOf(buckets, "cash", { of: "all" }), /requires allRows/);
});

test("compare names the available buckets when a selector misses", () => {
  const buckets = ops.groupBy(PAYMENTS, "source");
  const ok = ops.compare(buckets, { a: "Urgent Third State", b: "Affordability" }, ["newCash"]);
  assert.equal(ok.measures.newCash.a, 1216.67);
  assert.equal(ok.measures.newCash.b, 300);
  assert.throws(
    () => ops.compare(buckets, { a: "Urgent Third State", b: "Nonexistent Piece" }),
    /no bucket matching "Nonexistent Piece" — available:/,
  );
});

// ── the AMITY gate: the audit expressed as funnelGap ─────────────────────
test("funnelGap reproduces the AMITY UCFS shape (46 approved → 36 gap)", () => {
  // 46 approvals; 10 of them have a TAG loan posted against the same phone.
  const approvals = Array.from({ length: 46 }, (_, i) => ({
    domain: "AMITY", caseId: 90000 + i, phone: `70000000${String(i).padStart(2, "0")}`,
  }));
  const tagLoans = approvals.slice(0, 10).map((a) => ({ domain: "TAG", caseId: 40000 + a.caseId, phone: a.phone }));
  const result = ops.funnelGap(approvals, tagLoans, { by: "phone" });
  assert.equal(result.gap.length, 36, "the ask: approvals with no TAG loan");
  assert.equal(result.matched, 10);
  assert.equal(result.unkeyed.length, 0);
});

test("funnelGap never counts an UNKEYABLE row as a gap", () => {
  // An AMITY case with no phone on file is UNKNOWN, not proven-missing —
  // putting it in the gap would invent a finding.
  const approvals = [{ domain: "AMITY", caseId: 1, phone: "7015712905" }, { domain: "AMITY", caseId: 2, phone: null }];
  const result = ops.funnelGap(approvals, [], { by: "phone" });
  assert.equal(result.gap.length, 1);
  assert.equal(result.unkeyed.length, 1);
  assert.equal(result.unkeyed[0].caseId, 2);
});

// ── the same-day trap ────────────────────────────────────────────────────
test("joinAttempts separates same-day from before-close (the modal case)", () => {
  const payments = [{ domain: "TAG", caseId: 426256, paymentDateKey: "2026-07-27" }];
  const dials = [
    // caseId is a STRING on DailyDial — the coercion trap.
    { domain: "tag", caseId: "426256", dateKey: "2026-07-25", attempts: [{}, {}] },
    { domain: "tag", caseId: "426256", dateKey: "2026-07-27", attempts: [{}] },
    { domain: "tag", caseId: "426256", dateKey: "2026-07-28", attempts: [{}] },
  ];
  const [row] = ops.joinAttempts(payments, dials);
  assert.equal(row.attemptsBeforeClose, 2);
  assert.equal(row.sameDayAttempts, 1, "same-day is reported, not smeared either way");
  assert.equal(row.attemptsAfterClose, 1);
  assert.equal(row.attemptsToClose, 3, "the honest headline includes the close day");
  assert.equal(row.hadDialRecord, true);
});

test("lag marks uncovered deals rather than calling them zero days", () => {
  const payments = [
    { domain: "TAG", caseId: 1, phone: "4192170047", paymentDateKey: "2026-07-27", amount: 300 },
    { domain: "WYNN", caseId: 2, phone: "5551234567", paymentDateKey: "2026-07-27", amount: 500 },
  ];
  const calls = [{ phone: "419-217-0047", startedAt: "2026-07-25T17:00:00Z" }];
  const rows = ops.lag(payments, calls);
  assert.equal(rows[0].coverage, "matched");
  assert.equal(rows[0].days, 2);
  assert.equal(rows[1].coverage, "no-call-coverage", "a WYNN deal with no CallRail is uncovered, not same-day");
  assert.equal(rows[1].days, null);
});

test("lag matches ANY number on the case, not just the primary", () => {
  // Live: our CaseProfile mirror had a phone for 1 of 8 deals, and clients
  // call in on the cell/work/spouse line as often as the primary. Matching
  // one field reported 0 of 8 covered when 7 of 8 really were.
  const payments = [{
    domain: "TAG", caseId: 420024, phone: null, phones: ["6105700165", "2158675309"],
    paymentDateKey: "2026-07-24", amount: 300,
  }];
  const calls = [{ phone: "+12158675309", startedAt: "2026-07-20T15:00:00Z", source: "Urgent Third State" }];
  const [row] = ops.lag(payments, calls);
  assert.equal(row.coverage, "matched");
  assert.equal(row.days, 4);
  assert.equal(row.source, "Urgent Third State", "the call's source travels with the match");
});

test("lag separates no-phone-on-file from no-callrail-match", () => {
  // Our record-keeping gap and a real marketing fact must not share a bucket.
  const [noPhone] = ops.lag([{ domain: "TAG", caseId: 1, paymentDateKey: "2026-07-27" }], []);
  assert.equal(noPhone.reason, "no-phone-on-file");
  const [noCall] = ops.lag([{ domain: "TAG", caseId: 2, phone: "4192170047", paymentDateKey: "2026-07-27" }], []);
  // NOT "no-inbound-call": CallRail only sees TRACKING numbers, so a call to
  // the main DID is invisible here. Case 275341 was reported as call-free
  // while CallLog held a 45-minute inbound call on its pay day.
  assert.equal(noCall.reason, "no-callrail-match");
});

test("mail is TAG-only, so a WYNN deal never inherits a mailer's call", () => {
  // CallRail is ONE account shared by the tenants. Mickey 2026-07-28: "mail is
  // all in tag" and "95 percent of the work in call rail is mail matches" — so
  // a WYNN case matching a mail-sourced call is an artifact of the shared
  // account, and would credit a TAG mail piece with a WYNN deal.
  const wynn = [{ domain: "WYNN", caseId: 9, phone: "4192170047", paymentDateKey: "2026-07-27" }];
  const mail = [{ phone: "419-217-0047", startedAt: "2026-07-25T17:00:00Z", source: "Urgent Third State" }];
  const [row] = ops.lag(wynn, mail);
  assert.equal(row.coverage, "no-call-coverage");
  assert.equal(row.reason, "mail-source-is-tag-only");
  assert.equal(row.source, null, "a WYNN deal must never inherit a TAG mailer source");
  // The identical TAG case still matches.
  const [tag] = ops.lag([{ ...wynn[0], domain: "TAG" }], mail);
  assert.equal(tag.coverage, "matched");
});

test("BCD runs for several tenants, so a WYNN deal DOES match a BCD call", () => {
  // Mickey 2026-07-28: "there will be some bcd in wynn and some bcd and tag
  // and all the bcd will be in call rail". A blanket TAG-only rule threw
  // these away.
  const wynn = [{ domain: "WYNN", caseId: 9, phone: "4192170047", paymentDateKey: "2026-07-27" }];
  const bcd = [{ phone: "419-217-0047", startedAt: "2026-07-25T17:00:00Z", source: "BCD V3" }];
  const [row] = ops.lag(wynn, bcd);
  assert.equal(row.coverage, "matched");
  assert.equal(row.days, 2);
  assert.equal(row.source, "BCD V3");
});

test("source-to-domain fitness: BCD anywhere, mail only TAG, no guessing", () => {
  assert.equal(ops.sourceFitsDomain("Urgent Third State", "TAG"), true);
  assert.equal(ops.sourceFitsDomain("Urgent Third State", "WYNN"), false);
  assert.equal(ops.sourceFitsDomain("BCD V3", "WYNN"), true);
  assert.equal(ops.sourceFitsDomain("BCD", "WYNN"), true);
  // A bare /bcd/i would match this. It is a mailer, not the broadcast dialer.
  assert.equal(ops.sourceFitsDomain("ABCDEF Mailer", "WYNN"), false);
  assert.equal(ops.sourceFitsDomain("WYNN TAX SOLUTIONS - FB Prospect", "WYNN"), true);
  // An unknown source is not evidence for a tenant that did not buy the mail.
  assert.equal(ops.sourceFitsDomain(null, "WYNN"), false);
  assert.equal(ops.sourceFitsDomain(null, "TAG"), true);
});

test("no regex in reportOpsService contains a literal control character", () => {
  // This exact bug shipped three times: a word-boundary escape becoming 0x08,
  // giving a regex that matches nothing and fails open.
  const src = require("fs").readFileSync(
    require.resolve("../../packages/shared-services/src/reportOpsService"), "utf8",
  );
  const bad = [...src].filter((c) => {
    const n = c.charCodeAt(0);
    return n < 9 || (n > 13 && n < 32);
  });
  assert.equal(bad.length, 0, `found ${bad.length} control character(s)`);
});

test("lag carries CallRail's OWN caller counters rather than re-deriving them", () => {
  const calls = [{ phone: "4192170047", startedAt: "2026-07-25T17:00:00Z", priorCalls: 2, firstCall: false }];
  const [row] = ops.lag([{ domain: "TAG", caseId: 1, phone: "4192170047", paymentDateKey: "2026-07-27" }], calls);
  assert.equal(row.priorCalls, 2);
  assert.equal(row.firstCall, false);
});

test("officer distinguishes an unattributed row from an unlooked-up one", () => {
  // Live, this was $21,996.82 printed as "(unassigned)" — which reads as a
  // management problem when it is really a coverage gap.
  const rows = [
    { domain: "TAG", caseId: 1, amount: 100, attributionSnapshot: "missing" },
    { domain: "TAG", caseId: 2, amount: 200, attributionSnapshot: "found", officerAtSale: null },
  ];
  const keys = ops.groupBy(rows, "officer").map((b) => b.key).sort();
  assert.deepEqual(keys, ["(no snapshot)", "(unassigned)"]);
});

test("distribution reports p90 (blocks ask for it by name)", () => {
  const d = ops.distribution([0, 0, 0, 0, 1, 4]);
  assert.equal(d.p90, 4);
  assert.equal(d.median, 0);
  assert.equal(d.max, 4);
  assert.equal(ops.distribution([]).p90, null);
});

test("spendJoin flags that officer-filtered cost-per uses WHOLE-source spend", () => {
  const buckets = ops.groupBy(PAYMENTS.filter((p) => p.officerAtSale === "Phil Olson"), "source");
  const joined = ops.spendJoin(buckets, { "Urgent Third Pink State": { spend: 979.35 } }, { officerFiltered: true });
  const row = joined.find((b) => b.key === "Urgent Third Pink State");
  assert.equal(row.spend, 979.35);
  assert.equal(row.spendIsWholeSource, true, "the caveat must travel with the number");
});

test("distribution handles the empty set without inventing a median", () => {
  assert.deepEqual(ops.distribution([]).median, null);
  const d = ops.distribution([516, 679, 757, 622, 710]);
  assert.equal(d.n, 5);
  assert.equal(d.median, 679, "matches the measured soft-pull median");
});

// ── the attribution definition ───────────────────────────────────────────
test("attribution = LONGEST call on the day the deal closed", () => {
  // Mickey 2026-07-28: "attribution for me is longest call on the day the
  // deal closed." Three rules existed before this (first-wins in the rescue,
  // most-recent-wins in the sanitizer, first-match in lag) and disagreed.
  const calls = [
    { dateKey: "2026-07-27", startedAt: "2026-07-27T09:00:00Z", durationSec: 120, source: "Urgent Third State" },
    { dateKey: "2026-07-27", startedAt: "2026-07-27T15:00:00Z", durationSec: 2400, source: "Affordability Federal" },
    { dateKey: "2026-07-25", startedAt: "2026-07-25T10:00:00Z", durationSec: 4000, source: "3rd Day (Pink) Urgent Third State" },
  ];
  const r = ops.pickAttributionCall(calls, "2026-07-27");
  assert.equal(r.basis, "longest-close-day");
  assert.equal(r.call.source, "Affordability Federal",
    "the 40-minute close-day call beats both the earlier short call AND the longer prior-day call");
});

test("no close-day call → longest call on the LATEST prior day", () => {
  const calls = [
    { dateKey: "2026-07-20", durationSec: 3000, source: "old-long" },
    { dateKey: "2026-07-25", durationSec: 300, source: "recent-short" },
    { dateKey: "2026-07-25", durationSec: 900, source: "recent-longer" },
  ];
  const r = ops.pickAttributionCall(calls, "2026-07-27");
  assert.equal(r.basis, "longest-prior-day");
  assert.equal(r.call.source, "recent-longer",
    "recency picks the DAY, duration picks the call within it — the old 50-min call does not reach forward");
});

test("calls AFTER the close never attribute", () => {
  const calls = [{ dateKey: "2026-07-28", durationSec: 5000, source: "post-close" }];
  const r = ops.pickAttributionCall(calls, "2026-07-27");
  assert.equal(r.call, null);
  assert.equal(r.basis, null);
});

test("lag reports the attribution call's source, first call's timing", () => {
  const payments = [{ domain: "TAG", caseId: 1, phone: "4192170047", paymentDateKey: "2026-07-27" }];
  const calls = [
    { phone: "4192170047", dateKey: "2026-07-25", startedAt: "2026-07-25T10:00:00Z", durationSec: 60, source: "Urgent Third State" },
    { phone: "4192170047", dateKey: "2026-07-27", startedAt: "2026-07-27T14:00:00Z", durationSec: 1800, source: "Affordability Federal" },
  ];
  const [row] = ops.lag(payments, calls);
  assert.equal(row.days, 2, "timing measures from the FIRST call");
  assert.equal(row.source, "Affordability Federal", "source follows the attribution rule");
  assert.equal(row.attributionBasis, "longest-close-day");
});

// ── the six functions ────────────────────────────────────────────────────
// Mickey 2026-07-29 named these as the toolkit's function layer. They used to
// live inside individual blocks, which is why ROI once meant two things.

test("the six functions are all present and named", () => {
  assert.deepEqual(Object.keys(ops.FUNCTIONS).sort(),
    ["costPerAcquisition", "costPerCall", "costPerLead", "profitMargin", "roas", "roi"]);
});

test("they reproduce the live July pink-piece numbers", () => {
  const r = ops.applyFunctions({
    cost: 13924.35, initial: 18566.54, total: 55387.54, calls: 189, deals: 15,
  });
  assert.equal(r.roi, 297.8, "(total - cost) / cost");
  assert.equal(r.roas, 133.3, "initial / cost");
  assert.equal(r.costPerCall, 73.67);
  assert.equal(r.costPerAcquisition, 928.29, "cost / SALES");
  assert.equal(r.profitMargin, 30385.68, "(total x 0.8) - cost, in dollars");
});

test("profit margin is DOLLARS, not a rate", () => {
  // "(total payment*.8 - cost)" — what is left, not a rate of return.
  assert.equal(ops.applyFunctions({ total: 1000, cost: 500 }, ["profitMargin"]).profitMargin, 300);
  assert.equal(ops.formatFunction("profitMargin", 300), "$300.00");
  assert.equal(ops.formatFunction("roi", 297.8), "297.8%");
});

test("a zero denominator returns null, never Infinity", () => {
  // A 23,125% already shipped once; an infinite one would read as a triumph.
  const r = ops.applyFunctions({ cost: 0, initial: 100, total: 100, calls: 0, leads: 0, deals: 0 });
  for (const k of ["roi", "roas", "costPerCall", "costPerLead", "costPerAcquisition"]) {
    assert.equal(r[k], null, `${k} must be null on a zero denominator`);
  }
  assert.equal(ops.formatFunction("roi", null), "—");
});

test("a missing substrate is null, not treated as zero", () => {
  // No lead count is not "zero leads" — it is "we did not measure leads".
  assert.equal(ops.applyFunctions({ cost: 100 }, ["costPerLead"]).costPerLead, null);
  assert.equal(ops.applyFunctions({ cost: 100, leads: 0 }, ["costPerLead"]).costPerLead, null);
});

test("an unknown function fails loudly, listing what exists", () => {
  // The model layer will drive this registry; it must never silently ignore
  // a function it was asked for.
  assert.throws(() => ops.applyFunctions({ cost: 1 }, ["magicNumber"]),
    /unknown function "magicNumber" — available: roi, roas/);
});

test("a losing period reports a negative return", () => {
  const r = ops.applyFunctions({ cost: 8619, initial: 980, total: 980 }, ["roas", "roi", "profitMargin"]);
  assert.equal(r.roas, 11.4);
  assert.ok(r.roi < 0);
  assert.ok(r.profitMargin < 0, "a loss must read as a loss in dollars too");
});
