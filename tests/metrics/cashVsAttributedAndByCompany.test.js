"use strict";

// Month-end needs two different numbers, and the board must carry both.
//
//   FINANCE  wants cash: what actually moved in the window. Ties to the bank.
//   MARKETING wants deals credited to the piece that sold them, which means
//            initial money follows the SALE across month boundaries.
//
// Those diverge the moment a chargeback or a first-invoice installment
// crosses a month. Reporting only the attributed figure gives finance a
// number that reconciles to nothing.
//
// Also: WYNN and TAG are different businesses (TAG sells off the mail
// pieces, WYNN off lead data), so money is broken out per company.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSimpleNightlyPaymentRollup,
} = require("../../packages/shared-services/src/simpleMarketingReadService");

function pay(overrides = {}) {
  return {
    domain: "TAG", caseId: 1, transactionStatus: "SUCCESS",
    paymentType: "initial", amount: 1000, paymentDateKey: "2026-07-05",
    raw: { csv: { sourceName: "Affordability Federal" } },
    ...overrides,
  };
}

const activeContext = { pieces: new Set(["Affordability Federal"]), sheetToCanonical: new Map() };

test("cash reports the window's OWN rows, attributed reports the sale", () => {
  // July's view: a June deal's chargeback landed in July. Cash left the
  // business in July; the deal it reverses belongs to June.
  const julyCash = [
    pay({ caseId: 500, amount: 1000 }),
    pay({ caseId: 365360, amount: -3200, paymentDateKey: "2026-07-10" }),
  ];
  const attributed = [pay({ caseId: 500, amount: 1000 })]; // reversal moved to June

  const result = buildSimpleNightlyPaymentRollup({
    dayPayments: attributed,
    cashPayments: julyCash,
    profiles: [],
    activeContext,
  });

  assert.equal(result.totals.cashCollected, -2200, "cash is what moved: 1000 - 3200");
  assert.equal(result.totals.totalAmount, 1000, "attributed excludes June's chargeback");
  assert.equal(result.totals.initialDealCount, 1, "one client sold in July");
});

test("cash defaults to the same rows when nothing is reconciled", () => {
  const rows = [pay({ caseId: 1, amount: 250 })];
  const result = buildSimpleNightlyPaymentRollup({
    dayPayments: rows, profiles: [], activeContext,
  });
  assert.equal(result.totals.cashCollected, 250);
  assert.equal(result.totals.cashCollected, result.totals.totalAmount);
});

test("money is broken out per company", () => {
  const rows = [
    pay({ domain: "TAG", caseId: 1, amount: 1000 }),
    pay({ domain: "TAG", caseId: 2, amount: 500 }),
    pay({ domain: "WYNN", caseId: 3, amount: 400 }),
    pay({ domain: "AMITY", caseId: 4, amount: 900, paymentType: "recurring" }),
  ];
  const result = buildSimpleNightlyPaymentRollup({
    dayPayments: rows, cashPayments: rows, profiles: [], activeContext,
  });

  const byDomain = Object.fromEntries(result.byDomain.map((d) => [d.domain, d]));
  assert.equal(byDomain.TAG.deals, 2);
  assert.equal(byDomain.TAG.initialsNet, 1500);
  assert.equal(byDomain.TAG.cashCollected, 1500);

  assert.equal(byDomain.WYNN.deals, 1);
  assert.equal(byDomain.WYNN.cashCollected, 400);

  // AMITY took recurring money but sold nobody — it must still appear, or
  // its revenue silently vanishes from a per-company read.
  assert.equal(byDomain.AMITY.deals, 0);
  assert.equal(byDomain.AMITY.initialsNet, 0);
  assert.equal(byDomain.AMITY.cashCollected, 900);
});

test("per-company cash sums to the total", () => {
  const rows = [
    pay({ domain: "TAG", caseId: 1, amount: 1000 }),
    pay({ domain: "WYNN", caseId: 2, amount: 400 }),
    pay({ domain: "AMITY", caseId: 3, amount: -50, paymentType: "recurring" }),
  ];
  const result = buildSimpleNightlyPaymentRollup({
    dayPayments: rows, cashPayments: rows, profiles: [], activeContext,
  });
  const summed = result.byDomain.reduce((s, d) => s + d.cashCollected, 0);
  assert.equal(Math.round(summed * 100) / 100, result.totals.cashCollected);
});

test("failed payments never count as cash", () => {
  const rows = [
    pay({ caseId: 1, amount: 1000 }),
    pay({ caseId: 2, amount: 5000, transactionStatus: "DECLINED" }),
    pay({ caseId: 3, amount: 7000, transactionStatus: "FAILURE" }),
  ];
  const result = buildSimpleNightlyPaymentRollup({
    dayPayments: rows, cashPayments: rows, profiles: [], activeContext,
  });
  assert.equal(result.totals.cashCollected, 1000, "declines are not money");
});
