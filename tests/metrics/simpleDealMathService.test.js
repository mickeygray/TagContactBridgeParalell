"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  casePaymentKey,
  groupSuccessfulPaymentsByCase,
  isMissingDealSource,
  resolveDealSource,
  rollupCasePaymentGroups,
} = require("../../packages/shared-services/src/simpleDealMathService");

function payment(overrides = {}) {
  return {
    domain: "TAG",
    caseId: 100,
    transactionStatus: "SUCCESS",
    paymentType: "initial",
    amount: 100,
    ...overrides,
  };
}

test("groups successful transactions by domain and case without collapsing money", () => {
  const groups = groupSuccessfulPaymentsByCase([
    payment({ caseId: 394513, amount: 250 }),
    payment({ caseId: 394513, amount: 150 }),
    payment({ caseId: 394513, paymentType: "recurring", amount: 75 }),
    payment({ caseId: 394513, transactionStatus: "FAILED", amount: 999 }),
    payment({ domain: "WYNN", caseId: 394513, amount: 50 }),
  ]);

  assert.equal(groups.length, 2);
  const tag = groups.find((group) => group.domain === "TAG");
  assert.deepEqual(tag, {
    key: "TAG:394513",
    domain: "TAG",
    caseId: 394513,
    transactionCount: 3,
    totalAmount: 475,
    initialTransactionCount: 2,
    initialAmount: 400,
    initialDealCount: 1,
    positiveInitialCount: 2,
    negativeInitialCount: 0,
    splitTender: false,
    alerts: ["multiple_positive_initials"],
  });

  assert.equal(groups.find((group) => group.domain === "WYNN").totalAmount, 50);
});

test("counts one net deal per case while preserving transaction sums", () => {
  const groups = groupSuccessfulPaymentsByCase([
    payment({ caseId: 1, amount: 200 }),
    payment({ caseId: 1, amount: -50 }),
    payment({ caseId: 2, amount: 100 }),
    payment({ caseId: 2, amount: -100 }),
    payment({ caseId: 3, amount: -75 }),
    payment({ caseId: 3, paymentType: "recurring", amount: 20 }),
  ]);

  assert.deepEqual(
    groups.map(({ caseId, totalAmount, initialAmount, initialDealCount }) => ({
      caseId,
      totalAmount,
      initialAmount,
      initialDealCount,
    })),
    [
      // Case 2 sold and was charged back: the money nets to zero, the SALE
      // still counts. Case 3 is a bare reversal with no sale in view, so it
      // moves money without ever claiming a deal.
      { caseId: 1, totalAmount: 150, initialAmount: 150, initialDealCount: 1 },
      { caseId: 2, totalAmount: 0, initialAmount: 0, initialDealCount: 1 },
      { caseId: 3, totalAmount: -55, initialAmount: -75, initialDealCount: 0 },
    ],
  );

  assert.deepEqual(rollupCasePaymentGroups(groups), {
    caseCount: 3,
    transactionCount: 6,
    totalAmount: 95,
    initialAmount: 75,
    initialDealCount: 2,
    multiplePositiveInitialCases: 0,
  });
});

test("uses cent arithmetic for equal positive and negative initials", () => {
  const [group] = groupSuccessfulPaymentsByCase([
    payment({ amount: 10.1 }),
    payment({ amount: -10.1 }),
  ]);

  assert.equal(group.totalAmount, 0);
  assert.equal(group.initialAmount, 0);
  // Money nets to zero; the deal still happened.
  assert.equal(group.initialDealCount, 1);
});

test("treats blank, ABC and Unknown sources as missing", () => {
  for (const value of [null, undefined, "", "  ", "ABC", " abc ", "Unknown", "UNKNOWN"]) {
    assert.equal(isMissingDealSource(value), true);
  }
  assert.equal(isMissingDealSource("Aged"), false);
});

test("generic payment source cannot override a specific manual or profile source", () => {
  assert.deepEqual(resolveDealSource({
    manualSource: "Aged",
    profileSource: "BCD",
    paymentSource: "Unknown",
  }), {
    sourceName: "Aged",
    attributionPath: "manual",
    missing: false,
  });

  assert.deepEqual(resolveDealSource({
    manualSource: "ABC",
    profileSource: "Affordability",
    paymentSource: "Unknown",
  }), {
    sourceName: "Affordability",
    attributionPath: "profile",
    missing: false,
  });

  assert.deepEqual(resolveDealSource({
    manualSource: "",
    profileSource: "Unknown",
    paymentSource: "  BCD - OG  ",
  }), {
    sourceName: "BCD - OG",
    attributionPath: "payment",
    missing: false,
  });
});

test("returns an explicit missing source when every candidate is generic", () => {
  assert.deepEqual(resolveDealSource({
    manualSource: "",
    profileSource: "ABC",
    paymentSource: "Unknown",
  }), {
    sourceName: null,
    attributionPath: "missing",
    missing: true,
  });
});

test("normalizes identity keys and fails closed on malformed money or identity", () => {
  assert.equal(casePaymentKey(" tag ", " 0042 "), "TAG:0042");
  assert.throws(() => groupSuccessfulPaymentsByCase([payment({ domain: "" })]), /domain/);
  assert.throws(() => groupSuccessfulPaymentsByCase([payment({ caseId: null })]), /caseId/);
  assert.throws(() => groupSuccessfulPaymentsByCase([payment({ amount: "not-money" })]), /finite/);
});
