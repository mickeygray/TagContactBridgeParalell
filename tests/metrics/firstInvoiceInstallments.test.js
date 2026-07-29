"use strict";

// A payment-plan installment on the FIRST INVOICE is not a new client
// (Mickey, 2026-07-24: "you'll have recurring installments on the first
// invoice, those are not new clients, they are people on a payment plan
// which is most of our clients. So Kye is June and only June").
//
// Logics types those installments `initial`, so without this rule a client
// paying their retainer over three months counts as three deals — one per
// month — and every one of those months claims a client it did not sell.
//
// Live case: TAG 336405 KYE BROOKS took $500 on 2026-06-08 (after four
// declines) and another $500 on 2026-07-08. One June sale.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  attributePaymentsToSaleWindow,
  casePaymentKey,
  groupSuccessfulPaymentsByCase,
  resolveAttributionDateKey,
  rollupCasePaymentGroups,
} = require("../../packages/shared-services/src/simpleDealMathService");

const KYE = casePaymentKey("TAG", 336405);
const saleDates = new Map([[KYE, "2026-06-08"]]);

function row(overrides = {}) {
  return {
    domain: "TAG", caseId: 336405, amount: 500, paymentType: "initial",
    transactionStatus: "SUCCESS", paymentDateKey: "2026-06-08",
    ...overrides,
  };
}

const JUNE_SALE = row();
const JULY_INSTALLMENT = row({ paymentDateKey: "2026-07-08" });

test("a later installment attributes back to the first invoice", () => {
  assert.equal(resolveAttributionDateKey(JULY_INSTALLMENT, saleDates), "2026-06-08");
});

test("July does not claim a client sold in June", () => {
  const { rows, pushedOut } = attributePaymentsToSaleWindow({
    rows: [JULY_INSTALLMENT],
    firstInitialDateByCase: saleDates,
    from: "2026-07-01",
    to: "2026-07-31",
  });

  assert.deepEqual(rows, [], "Kye is June and only June");
  assert.equal(pushedOut.length, 1);
  assert.equal(pushedOut[0].kind, "installment", "labelled an installment, not a chargeback");
  assert.equal(pushedOut[0].soldOn, "2026-06-08");
  assert.equal(pushedOut[0].paidOn, "2026-07-08");
  assert.equal(rollupCasePaymentGroups(groupSuccessfulPaymentsByCase(rows)).initialDealCount, 0);
});

test("June keeps the client and collects the whole first invoice", () => {
  const { rows, pulledIn } = attributePaymentsToSaleWindow({
    rows: [JUNE_SALE, JULY_INSTALLMENT],
    firstInitialDateByCase: saleDates,
    from: "2026-06-01",
    to: "2026-06-30",
  });

  assert.equal(rows.length, 2);
  assert.equal(pulledIn.length, 1);
  assert.equal(pulledIn[0].kind, "installment");

  const totals = rollupCasePaymentGroups(groupSuccessfulPaymentsByCase(rows));
  assert.equal(totals.initialDealCount, 1, "ONE client, not two");
  assert.equal(totals.initialAmount, 1000, "and the full invoice so far");
});

test("one sale is never counted in two months", () => {
  const june = attributePaymentsToSaleWindow({
    rows: [JUNE_SALE, JULY_INSTALLMENT], firstInitialDateByCase: saleDates,
    from: "2026-06-01", to: "2026-06-30",
  });
  const july = attributePaymentsToSaleWindow({
    rows: [JULY_INSTALLMENT], firstInitialDateByCase: saleDates,
    from: "2026-07-01", to: "2026-07-31",
  });
  const deals = (result) =>
    rollupCasePaymentGroups(groupSuccessfulPaymentsByCase(result.rows)).initialDealCount;

  assert.equal(deals(june) + deals(july), 1, "the year must show exactly one Kye Brooks");
});

test("RECURRING revenue is untouched and stays in its own month", () => {
  // Only the first invoice attributes back. Ongoing plan revenue is earned
  // in the month it is collected and must not be dragged to the sale month.
  const recurring = row({ paymentType: "recurring", paymentDateKey: "2026-07-08" });
  assert.equal(resolveAttributionDateKey(recurring, saleDates), "2026-07-08");

  const { rows } = attributePaymentsToSaleWindow({
    rows: [recurring],
    firstInitialDateByCase: saleDates,
    from: "2026-07-01",
    to: "2026-07-31",
  });
  assert.deepEqual(rows, [recurring], "recurring stays in July");
});

test("a first invoice with no known sale date stays where it landed", () => {
  const { rows, pushedOut } = attributePaymentsToSaleWindow({
    rows: [JULY_INSTALLMENT],
    firstInitialDateByCase: new Map(),
    from: "2026-07-01",
    to: "2026-07-31",
  });
  assert.deepEqual(rows, [JULY_INSTALLMENT], "fail safe: money never vanishes");
  assert.equal(pushedOut.length, 0);
});

test("same-day split tender needs no attribution and moves nothing", () => {
  const a = row({ amount: 500, paymentDateKey: "2026-07-01" });
  const b = row({ amount: 500, paymentDateKey: "2026-07-01" });
  const { rows, pulledIn, pushedOut } = attributePaymentsToSaleWindow({
    rows: [a, b],
    firstInitialDateByCase: new Map([[KYE, "2026-07-01"]]),
    from: "2026-07-01",
    to: "2026-07-31",
  });
  assert.equal(rows.length, 2);
  assert.equal(pulledIn.length, 0);
  assert.equal(pushedOut.length, 0);
  assert.equal(rollupCasePaymentGroups(groupSuccessfulPaymentsByCase(rows)).initialDealCount, 1);
});
