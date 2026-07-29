"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildPaymentExceptionCandidates,
  paymentReviewKey,
  validatePaymentTreatment,
} = require("../../packages/shared-services/src/paymentMetricsReviewService");

function payment(overrides = {}) {
  return {
    domain: "TAG",
    caseId: 100,
    casePaymentId: 1,
    transactionStatus: "SUCCESS",
    paymentType: "initial",
    amount: 100,
    raw: { csv: { sourceName: "ABC" } },
    ...overrides,
  };
}

test("multiple positive initials keep all money and raise one case review", () => {
  const rows = [
    payment({ caseId: 394513, casePaymentId: 10, amount: 500 }),
    payment({ caseId: 394513, casePaymentId: 11, amount: 500 }),
  ];
  const [candidate] = buildPaymentExceptionCandidates(rows, []);

  assert.equal(candidate.reviewKey, paymentReviewKey("TAG", 394513));
  assert.equal(candidate.initialAmount, 1000);
  assert.equal(candidate.totalAmount, 1000);
  assert.equal(candidate.positiveInitialCount, 2);
  assert.deepEqual(candidate.reasons, [
    "multiple_positive_initials",
    "missing_source",
  ]);
  assert.equal(candidate.sourceMissing, true);
});

test("fully offset chargeback is accurate without a CallRail or source match", () => {
  const [candidate] = buildPaymentExceptionCandidates([
    payment({ caseId: 409586, casePaymentId: 20, amount: 1000 }),
    payment({ caseId: 409586, casePaymentId: 21, amount: -1000 }),
  ]);

  assert.equal(candidate.initialAmount, 0);
  assert.equal(candidate.totalAmount, 0);
  assert.deepEqual(candidate.reasons, ["offsetting_initial_chargeback"]);
  assert.equal(candidate.sourceMissing, true);
  assert.deepEqual(
    validatePaymentTreatment(
      { treatmentKind: "chargeback-pair" },
      {
        positiveInitialCount: 1,
        negativeInitialCount: 1,
        initialCents: 0,
        reasons: candidate.reasons,
      },
    ),
    {
      treatmentKind: "chargeback-pair",
      reportingBucket: null,
      resolvedSource: null,
    },
  );
});

test("an unsourced positive case can be explicitly reported as Aged", () => {
  const [candidate] = buildPaymentExceptionCandidates([
    payment({ caseId: 220274, casePaymentId: 30, amount: 775.8 }),
  ]);
  assert.deepEqual(candidate.reasons, ["missing_source"]);

  assert.deepEqual(
    validatePaymentTreatment(
      { treatmentKind: "source-override", reportingBucket: "Aged" },
      {
        positiveInitialCount: 1,
        negativeInitialCount: 0,
        initialCents: 77580,
        reasons: candidate.reasons,
      },
    ),
    {
      treatmentKind: "source-override",
      reportingBucket: "Aged",
      resolvedSource: null,
    },
  );
});

test("a standalone negative initial stays signed and requires source review", () => {
  const [candidate] = buildPaymentExceptionCandidates([
    payment({ caseId: 365360, casePaymentId: 35, amount: -3200 }),
  ]);
  assert.deepEqual(candidate.reasons, [
    "negative_initial_payment",
    "missing_source",
  ]);

  assert.throws(
    () => validatePaymentTreatment(
      { treatmentKind: "chargeback-reversal" },
      {
        positiveInitialCount: 0,
        negativeInitialCount: 1,
        initialCents: -320000,
        reasons: candidate.reasons,
      },
    ),
    /requires a reporting source/,
  );

  assert.deepEqual(
    validatePaymentTreatment(
      {
        treatmentKind: "chargeback-reversal",
        resolvedSource: "Affordability Federal",
      },
      {
        positiveInitialCount: 0,
        negativeInitialCount: 1,
        initialCents: -320000,
        reasons: candidate.reasons,
      },
    ),
    {
      treatmentKind: "chargeback-reversal",
      reportingBucket: null,
      resolvedSource: "Affordability Federal",
    },
  );
});

test("count-one-deal also requires a source when the case is unattributed", () => {
  assert.throws(
    () =>
      validatePaymentTreatment(
        { treatmentKind: "count-one-deal" },
        {
          positiveInitialCount: 2,
          negativeInitialCount: 0,
          initialCents: 100000,
          reasons: ["multiple_positive_initials", "missing_source"],
        },
      ),
    /requires a reporting source/,
  );

  assert.deepEqual(
    validatePaymentTreatment(
      {
        treatmentKind: "count-one-deal",
        resolvedSource: "Affordability Federal",
      },
      {
        positiveInitialCount: 2,
        negativeInitialCount: 0,
        initialCents: 100000,
        reasons: ["multiple_positive_initials", "missing_source"],
      },
    ),
    {
      treatmentKind: "count-one-deal",
      reportingBucket: null,
      resolvedSource: "Affordability Federal",
    },
  );
});

test("consistent treatment prevents a reviewed case from reopening", () => {
  const treatment = {
    kind: "count-one-deal",
    groupKey: "TAG:394513",
    reportingBucket: null,
  };
  const [candidate] = buildPaymentExceptionCandidates(
    [
      payment({
        caseId: 394513,
        casePaymentId: 40,
        amount: 500,
        metricsTreatment: treatment,
      }),
      payment({
        caseId: 394513,
        casePaymentId: 41,
        amount: 500,
        metricsTreatment: treatment,
      }),
    ],
    [{ domain: "TAG", caseId: 394513, sourceName: "Affordability Federal" }],
  );
  assert.equal(candidate.treatmentCoversRows, true);
});

test("payment treatment service never writes a Logics source", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "../../packages/shared-services/src/paymentMetricsReviewService.js",
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /logicsSourceWriterService|writeLogicsCaseSource/);
});
