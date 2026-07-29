"use strict";

// The two-implementations guard.
//
// `scripts/ask.js` and the `source` report block answer the same question by
// different routes. Twice this drifted: once the pink piece split across three
// spellings with spend landing on only one of them, and once the ask tool
// skipped attribution entirely and quietly moved a deal per row into Aged.
// Both times the two tools printed confident, different numbers.
//
// These tests pin the SHARED resolvers rather than either caller, because the
// fix was to delete the second copy — and the way that regresses is someone
// re-inlining "just this one bit" back into a caller.

const test = require("node:test");
const assert = require("node:assert/strict");

const ops = require("../../packages/shared-services/src/reportOpsService");
const { AGED_LABEL } = require("../../packages/shared-config/src/activeSources");

const RANGE = { rangeStart: "2026-07-01", rangeEnd: "2026-07-31" };

test("resolveSourceRow folds every spelling of a piece onto one row", () => {
  const aliases = [
    "3rd Day (Pink) Urgent Third State 800-921-9263",
    "3rd Day (Pink) Urgent Third State",
    "Urgent Third Pink State",
  ];
  const rows = aliases.map((sourceAtSale) => ops.resolveSourceRow(
    {
      domain: "TAG",
      sourceAtSale,
      caseId: 1,
      caseCreatedDate: "2026-07-10",
      paymentDateKey: "2026-07-15",
    },
    { ...RANGE, attributionCallDate: "2026-07-14" },
  ));
  assert.equal(new Set(rows).size, 1, `expected one row, got ${JSON.stringify(rows)}`);
});

test("the mail-house placeholder is a catch-all, not a mail piece", () => {
  const row = ops.resolveSourceRow(
    { domain: "TAG", sourceAtSale: "ABC", caseId: 394513, caseCreatedDate: "2026-07-10" },
    RANGE,
  );
  assert.match(row, /catch-all/, "literal ABC must not masquerade as a piece");
});

test("a payment with no source is unsourced, never zero-attributed to a piece", () => {
  const row = ops.resolveSourceRow({ domain: "TAG", sourceAtSale: null, caseId: 2 }, RANGE);
  assert.equal(row, "(unsourced)");
});

test("an old case on a dead source demotes to Aged", () => {
  // The failure this rule exists to stop: an upsell to a years-old client
  // wearing a live piece's name, which is how BCD once reached 23,125% on $8.
  const row = ops.resolveSourceRow(
    {
      domain: "TAG",
      sourceAtSale: "BCD",
      caseId: 3,
      caseCreatedDate: "2023-02-01",
      paymentDateKey: "2026-07-15",
    },
    { ...RANGE, attributionCallDate: null },
  );
  assert.equal(row, AGED_LABEL);
});

test("foldSourceKey lands spend on the row the money landed on", () => {
  const moneyRow = ops.resolveSourceRow(
    {
      domain: "TAG",
      sourceAtSale: "3rd Day (Pink) Urgent Third State 800-921-9263",
      caseId: 4,
      caseCreatedDate: "2026-07-10",
      paymentDateKey: "2026-07-15",
    },
    { ...RANGE, attributionCallDate: "2026-07-14" },
  );
  const spendRow = ops.foldSourceKey("3rd Day (Pink) Urgent Third State");
  assert.equal(spendRow, moneyRow, "spend and deals must meet on one row or every cost-per reads —");
});

test("spend on a source nobody runs any more folds to Aged", () => {
  assert.equal(ops.foldSourceKey("Some Retired 2019 Mailer"), AGED_LABEL);
});

test("a deal is a SALE, not a payment row", () => {
  // A first invoice paid in two installments is two initial rows, one deal.
  const rows = [
    { domain: "TAG", caseId: 900, paymentType: "initial", amount: 500 },
    { domain: "TAG", caseId: 900, paymentType: "initial", amount: 500 },
    { domain: "TAG", caseId: 901, paymentType: "initial", amount: 250 },
    { domain: "TAG", caseId: 901, paymentType: "recurring", amount: 100 },
  ];
  const m = ops.measure(rows, ["deals", "newCash", "cash"]);
  assert.equal(m.deals, 2, "two cases sold, regardless of how many rows they paid in");
  assert.equal(m.newCash, 1250, "but every initial dollar still counts");
  assert.equal(m.cash, 1350);
});

test("attributionDateResolver picks the longest call on the closing day", () => {
  const calls = [
    { phone: "5551234567", dateKey: "2026-07-10", durationSec: 900, source: "Urgent Third State" },
    { phone: "5551234567", dateKey: "2026-07-15", durationSec: 120, source: "Urgent Third State" },
    { phone: "5551234567", dateKey: "2026-07-15", durationSec: 800, source: "Urgent Third State" },
  ];
  const resolve = ops.attributionDateResolver(calls);
  const at = resolve({ phone: "555-123-4567", paymentDateKey: "2026-07-15" });
  assert.equal(at, "2026-07-15");
});

test("a servicing call is not evidence that a case was freshly sourced", () => {
  // CallRail also tracks support lines. An existing client ringing in must not
  // keep years-old money attached to a live marketing piece.
  const resolve = ops.attributionDateResolver([
    { phone: "5559876543", dateKey: "2026-07-15", durationSec: 900, source: "Client Contact - TAG" },
  ]);
  assert.equal(resolve({ phone: "5559876543", paymentDateKey: "2026-07-15" }), null);
});

test("a payment with no call evidence resolves to null, not to today", () => {
  const resolve = ops.attributionDateResolver([]);
  assert.equal(resolve({ phone: "5550000000", paymentDateKey: "2026-07-15" }), null);
});
