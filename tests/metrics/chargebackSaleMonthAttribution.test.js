"use strict";

// Chargebacks restate the month of the SALE, not the month the money moved
// back (Mickey, 2026-07-24: "update June metrics and not tax July metrics").
//
// Live case that forced this: TAG 365360 sold +$3,200 on 2026-06-01 and was
// reversed -$3,200 on 2026-07-10. Attributed by payment date, July loses a
// deal it never made — reading 31 net deals against 32 actually sold.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  attributePaymentsToSaleWindow,
  groupSuccessfulPaymentsByCase,
  isReversalPayment,
  resolveAttributionDateKey,
  rollupCasePaymentGroups,
  casePaymentKey,
} = require("../../packages/shared-services/src/simpleDealMathService");

const SALE = {
  domain: "TAG", caseId: 365360, amount: 3200, paymentType: "initial",
  transactionStatus: "SUCCESS", paymentDateKey: "2026-06-01",
};
const REVERSAL = {
  domain: "TAG", caseId: 365360, amount: -3200, paymentType: "initial",
  transactionStatus: "SUCCESS", paymentDateKey: "2026-07-10",
};
const JULY_DEAL = {
  domain: "TAG", caseId: 400001, amount: 1500, paymentType: "initial",
  transactionStatus: "SUCCESS", paymentDateKey: "2026-07-13",
};

const saleDates = new Map([[casePaymentKey("TAG", 365360), "2026-06-01"]]);

test("a reversal is recognised only when it is a successful negative initial", () => {
  assert.equal(isReversalPayment(REVERSAL), true);
  assert.equal(isReversalPayment(SALE), false);
  assert.equal(
    isReversalPayment({ ...REVERSAL, paymentType: "recurring" }), false,
    "a recurring refund is not a deal reversal",
  );
  assert.equal(
    isReversalPayment({ ...REVERSAL, transactionStatus: "DECLINED" }), false,
    "a failed reversal reverses nothing",
  );
});

test("a reversal attributes to its sale date, other rows to their own", () => {
  assert.equal(resolveAttributionDateKey(REVERSAL, saleDates), "2026-06-01");
  assert.equal(resolveAttributionDateKey(SALE, saleDates), "2026-06-01");
  assert.equal(resolveAttributionDateKey(JULY_DEAL, saleDates), "2026-07-13");
});

test("July is not taxed for a June deal reversed in July", () => {
  const { rows, pulledIn, pushedOut } = attributePaymentsToSaleWindow({
    rows: [REVERSAL, JULY_DEAL],
    firstInitialDateByCase: saleDates,
    from: "2026-07-01",
    to: "2026-07-31",
  });

  assert.deepEqual(rows, [JULY_DEAL], "the June reversal leaves July entirely");
  assert.equal(pushedOut.length, 1);
  assert.equal(pushedOut[0].caseId, 365360);
  assert.equal(pushedOut[0].soldOn, "2026-06-01");
  assert.equal(pushedOut[0].paidOn, "2026-07-10");
  assert.equal(pulledIn.length, 0);

  const totals = rollupCasePaymentGroups(groupSuccessfulPaymentsByCase(rows));
  assert.equal(totals.initialDealCount, 1, "July keeps the deal it actually sold");
  assert.equal(totals.initialAmount, 1500);
});

test("June absorbs the reversal even though it landed in July", () => {
  const { rows, pulledIn, pushedOut } = attributePaymentsToSaleWindow({
    // June's own rows plus the later reversal the caller must supply.
    rows: [SALE, REVERSAL],
    firstInitialDateByCase: saleDates,
    from: "2026-06-01",
    to: "2026-06-30",
  });

  assert.equal(rows.length, 2, "the July reversal is pulled back into June");
  assert.equal(pulledIn.length, 1);
  assert.equal(pulledIn[0].paidOn, "2026-07-10");
  assert.equal(pushedOut.length, 0);

  const totals = rollupCasePaymentGroups(groupSuccessfulPaymentsByCase(rows));
  // June sold the deal and then gave the money back: the deal still counts,
  // the dollars do not.
  assert.equal(totals.initialDealCount, 1, "June keeps the deal it sold");
  assert.equal(totals.initialAmount, 0, "but June loses the money");
});

test("a same-month chargeback still nets out inside that month", () => {
  // TAG 381862: +$2,850 on 6/15, -$2,850 on 6/30. Nothing should move.
  const sale = { ...SALE, caseId: 381862, amount: 2850, paymentDateKey: "2026-06-15" };
  const reversal = { ...REVERSAL, caseId: 381862, amount: -2850, paymentDateKey: "2026-06-30" };
  const { rows, pulledIn, pushedOut } = attributePaymentsToSaleWindow({
    rows: [sale, reversal],
    firstInitialDateByCase: new Map([[casePaymentKey("TAG", 381862), "2026-06-15"]]),
    from: "2026-06-01",
    to: "2026-06-30",
  });
  assert.equal(rows.length, 2);
  assert.equal(pulledIn.length, 0, "nothing crossed a boundary");
  assert.equal(pushedOut.length, 0);
  const sameMonth = rollupCasePaymentGroups(groupSuccessfulPaymentsByCase(rows));
  assert.equal(sameMonth.initialDealCount, 1, "the sale still counts in its own month");
  assert.equal(sameMonth.initialAmount, 0, "the money nets out inside the month");
});

test("a reversal with no recoverable sale stays where it landed", () => {
  // Fail safe: without an original we cannot restate, so the money must not
  // silently vanish from every window.
  const { rows, pushedOut } = attributePaymentsToSaleWindow({
    rows: [REVERSAL],
    firstInitialDateByCase: new Map(),
    from: "2026-07-01",
    to: "2026-07-31",
  });
  assert.deepEqual(rows, [REVERSAL]);
  assert.equal(pushedOut.length, 0);
});

test("a reversal landing outside the window and selling outside it is ignored", () => {
  const { rows, pulledIn, pushedOut } = attributePaymentsToSaleWindow({
    rows: [REVERSAL],
    firstInitialDateByCase: saleDates,
    from: "2026-05-01",
    to: "2026-05-31",
  });
  assert.deepEqual(rows, []);
  assert.equal(pulledIn.length, 0);
  assert.equal(pushedOut.length, 0);
});

test("attribution is required to be given a window", () => {
  assert.throws(() => attributePaymentsToSaleWindow({ rows: [], from: "2026-07-01" }), TypeError);
  assert.throws(() => attributePaymentsToSaleWindow({ rows: "nope", from: "a", to: "b" }), TypeError);
});
