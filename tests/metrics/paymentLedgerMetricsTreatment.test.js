"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { PaymentLedger } = require("../../packages/shared-models/src");
const paymentLedgerRepository = require(
  "../../packages/shared-repositories/src/paymentLedgerRepository",
);

function queryResult(value) {
  const query = {
    select() {
      return query;
    },
    async lean() {
      return value;
    },
  };
  return query;
}

function listQueryResult(values, onLimit = null) {
  const query = {
    limit(value) {
      onLimit?.(value);
      return query;
    },
    async lean() {
      return values;
    },
  };
  return query;
}

test("PaymentLedger persists the complete metrics treatment shape", () => {
  const resolvedAt = new Date("2026-07-24T20:00:00.000Z");
  const row = new PaymentLedger({
    domain: "TAG",
    caseId: 394513,
    casePaymentId: -39451301,
    paymentDate: new Date("2026-07-01T12:00:00.000Z"),
    paymentDateKey: "2026-07-01",
    amount: 500,
    paymentType: "initial",
    metricsTreatment: {
      kind: "split_same_deal",
      groupKey: "case:394513",
      reportingBucket: "Affordability Federal",
      resolvedAt,
      resolvedBy: "metrics-review",
      note: "Two payments, one deal",
    },
  });

  assert.equal(row.validateSync(), undefined);
  assert.deepEqual(row.metricsTreatment.toObject(), {
    kind: "split_same_deal",
    groupKey: "case:394513",
    reportingBucket: "Affordability Federal",
    resolvedAt,
    resolvedBy: "metrics-review",
    note: "Two payments, one deal",
  });
});

test("setPaymentLedgerMetricsTreatment normalizes and validates operator input", async () => {
  const originalFindOneAndUpdate = PaymentLedger.findOneAndUpdate;
  let captured = null;
  PaymentLedger.findOneAndUpdate = async (...args) => {
    captured = args;
    return { ok: true };
  };

  try {
    const result = await paymentLedgerRepository.setPaymentLedgerMetricsTreatment("123", {
      kind: " split_same_deal ",
      groupKey: " case:394513 ",
      reportingBucket: " Affordability Federal ",
      resolvedAt: "2026-07-24T20:00:00.000Z",
      resolvedBy: " metrics-review ",
      note: " one deal ",
    });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(captured[0], { casePaymentId: 123 });
    assert.deepEqual(captured[1].$set.metricsTreatment, {
      kind: "split_same_deal",
      groupKey: "case:394513",
      reportingBucket: "Affordability Federal",
      resolvedAt: new Date("2026-07-24T20:00:00.000Z"),
      resolvedBy: "metrics-review",
      note: "one deal",
    });
    assert.deepEqual(captured[2], { new: true, runValidators: true });

    await assert.rejects(
      paymentLedgerRepository.setPaymentLedgerMetricsTreatment(123, {
        resolvedAt: "not-a-date",
      }),
      /resolvedAt must be a valid date/,
    );
  } finally {
    PaymentLedger.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("Logics reconciliation cannot overwrite metrics treatment", async () => {
  const originalFindOne = PaymentLedger.findOne;
  const originalFindOneAndUpdate = PaymentLedger.findOneAndUpdate;
  let capturedUpdate = null;

  PaymentLedger.findOne = () => queryResult({
    authoritativeSource: "logics-csv",
  });
  PaymentLedger.findOneAndUpdate = async (_filter, update) => {
    capturedUpdate = update;
    return {};
  };

  try {
    await paymentLedgerRepository.reconcilePaymentLedger(321, {
      domain: "TAG",
      caseId: 394513,
      amount: 500,
      paymentDate: new Date("2026-07-01T12:00:00.000Z"),
      paymentType: "initial",
      metricsTreatment: {
        kind: "source-payload-must-not-win",
      },
    });

    assert.equal(
      Object.prototype.hasOwnProperty.call(capturedUpdate.$set, "metricsTreatment"),
      false,
    );
  } finally {
    PaymentLedger.findOne = originalFindOne;
    PaymentLedger.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("synthetic-to-real twin promotion preserves treatment without deletion", async () => {
  const originalFindOne = PaymentLedger.findOne;
  const originalFind = PaymentLedger.find;
  const originalFindOneAndUpdate = PaymentLedger.findOneAndUpdate;
  const originalDeleteOne = PaymentLedger.deleteOne;
  const deleted = [];
  let capturedUpdate = null;

  const twin = {
    _id: "synthetic-row",
    casePaymentId: -39451301,
    paymentType: "initial",
    authoritativeAt: new Date("2026-07-24T19:00:00.000Z"),
    metricsTreatment: {
      kind: "split_same_deal",
      groupKey: "case:394513",
      reportingBucket: "Affordability Federal",
      resolvedAt: "2026-07-24T20:00:00.000Z",
      resolvedBy: "metrics-review",
      note: "Preserve this decision",
    },
  };

  PaymentLedger.findOne = () => queryResult(null);
  PaymentLedger.find = () => listQueryResult([twin]);
  PaymentLedger.deleteOne = async (filter) => {
    deleted.push(filter);
    return { deletedCount: 1 };
  };
  PaymentLedger.findOneAndUpdate = async (_filter, update) => {
    capturedUpdate = update;
    return {};
  };

  try {
    await paymentLedgerRepository.reconcilePaymentLedger(654, {
      domain: "TAG",
      caseId: 394513,
      amount: 500,
      paymentDate: new Date("2026-07-01T12:00:00.000Z"),
      paymentType: "unknown",
      metricsTreatment: { kind: "incoming-must-not-win" },
    });

    assert.deepEqual(deleted, []);
    assert.equal(capturedUpdate.$set.casePaymentId, 654);
    assert.equal(capturedUpdate.$set.paymentType, "initial");
    assert.deepEqual(capturedUpdate.$set.metricsTreatment, {
      kind: "split_same_deal",
      groupKey: "case:394513",
      reportingBucket: "Affordability Federal",
      resolvedAt: new Date("2026-07-24T20:00:00.000Z"),
      resolvedBy: "metrics-review",
      note: "Preserve this decision",
    });
  } finally {
    PaymentLedger.findOne = originalFindOne;
    PaymentLedger.find = originalFind;
    PaymentLedger.findOneAndUpdate = originalFindOneAndUpdate;
    PaymentLedger.deleteOne = originalDeleteOne;
  }
});
