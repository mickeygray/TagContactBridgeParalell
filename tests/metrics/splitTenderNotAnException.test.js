"use strict";

// One initial settled across two cards on the SAME DAY is split tender, not
// an exception (Mickey, 2026-07-24: "he's a $1000 initial that paid maybe 2
// cards or whatever to cover it"). TAG 394513 is $500 + $500 on 2026-07-01.
//
// This is a SUPPRESSION, so it must fail closed: suppress only on proof of a
// single day. Positive initials on different days stay flagged — TAG 336405
// took $500 on 2026-06-08 and another on 2026-07-08, which is an initial
// being paid down over time, not one purchase.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  groupSuccessfulPaymentsByCase,
} = require("../../packages/shared-services/src/simpleDealMathService");
const {
  buildPaymentExceptionCandidates,
} = require("../../packages/shared-services/src/paymentMetricsReviewService");

function initial(overrides = {}) {
  return {
    domain: "TAG",
    caseId: 394513,
    casePaymentId: 1,
    transactionStatus: "SUCCESS",
    paymentType: "initial",
    amount: 500,
    raw: { csv: { sourceName: "Affordability Federal" } },
    ...overrides,
  };
}

test("same-day split tender is one deal, full money, and NO alert", () => {
  const [group] = groupSuccessfulPaymentsByCase([
    initial({ casePaymentId: 67039, paymentDateKey: "2026-07-01" }),
    initial({ casePaymentId: 67041, paymentDateKey: "2026-07-01" }),
  ]);
  assert.equal(group.positiveInitialCount, 2, "two card transactions");
  assert.equal(group.initialDealCount, 1, "but one deal");
  assert.equal(group.initialAmount, 1000, "and the full $1,000");
  assert.equal(group.splitTender, true);
  assert.deepEqual(group.alerts, [], "split tender must not raise an alert");
});

test("positive initials on DIFFERENT days stay flagged", () => {
  // TAG 336405: an initial paid down across two months.
  const [group] = groupSuccessfulPaymentsByCase([
    initial({ caseId: 336405, casePaymentId: 67142, paymentDateKey: "2026-06-08" }),
    initial({ caseId: 336405, casePaymentId: 67141, paymentDateKey: "2026-07-08" }),
  ]);
  assert.equal(group.splitTender, false);
  assert.deepEqual(group.alerts, ["multiple_positive_initials"]);
});

test("unknown payment dates FAIL CLOSED and still flag", () => {
  const [group] = groupSuccessfulPaymentsByCase([
    initial({ casePaymentId: 1 }),
    initial({ casePaymentId: 2 }),
  ]);
  assert.equal(group.splitTender, false, "cannot claim split tender without dates");
  assert.deepEqual(group.alerts, ["multiple_positive_initials"]);
});

test("the review scanner suppresses and flags identically", () => {
  const sameDay = buildPaymentExceptionCandidates([
    initial({ casePaymentId: 67039, paymentDateKey: "2026-07-01" }),
    initial({ casePaymentId: 67041, paymentDateKey: "2026-07-01" }),
  ], []);
  assert.ok(
    !sameDay.some((c) => c.reasons.includes("multiple_positive_initials")),
    "split tender must not become an operator task",
  );

  const acrossDays = buildPaymentExceptionCandidates([
    initial({ caseId: 336405, casePaymentId: 67142, paymentDateKey: "2026-06-08" }),
    initial({ caseId: 336405, casePaymentId: 67141, paymentDateKey: "2026-07-08" }),
  ], []);
  assert.ok(
    acrossDays.some((c) => c.reasons.includes("multiple_positive_initials")),
    "a multi-day initial still needs a human",
  );

  const noDates = buildPaymentExceptionCandidates([
    initial({ casePaymentId: 1 }),
    initial({ casePaymentId: 2 }),
  ], []);
  assert.ok(
    noDates.some((c) => c.reasons.includes("multiple_positive_initials")),
    "scanner must fail closed on unknown dates",
  );
});

test("a single initial is never split tender", () => {
  const [group] = groupSuccessfulPaymentsByCase([
    initial({ amount: 1000, paymentDateKey: "2026-07-01" }),
  ]);
  assert.equal(group.splitTender, false);
  assert.equal(group.initialDealCount, 1);
  assert.deepEqual(group.alerts, []);
});
