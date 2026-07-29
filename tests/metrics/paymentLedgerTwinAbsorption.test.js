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

test("twin lookup is limited to successful CSV-authoritative synthetic rows", async () => {
  const originalFindOne = PaymentLedger.findOne;
  const originalFind = PaymentLedger.find;
  const originalFindOneAndUpdate = PaymentLedger.findOneAndUpdate;
  let candidateFilter = null;
  let candidateLimit = null;
  const writes = [];

  PaymentLedger.findOne = () => queryResult(null);
  PaymentLedger.find = (filter) => {
    candidateFilter = filter;
    return listQueryResult([], (value) => {
      candidateLimit = value;
    });
  };
  PaymentLedger.findOneAndUpdate = async (...args) => {
    writes.push(args);
    return { upserted: true };
  };

  try {
    await paymentLedgerRepository.reconcilePaymentLedger(700, {
      domain: "TAG",
      caseId: 394513,
      amount: 500,
      paymentDate: new Date("2026-07-01T12:00:00.000Z"),
      paymentType: "initial",
      transactionStatus: "SUCCESS",
    });

    assert.equal(candidateLimit, 2);
    assert.deepEqual(candidateFilter.casePaymentId, { $lt: 0 });
    assert.equal(candidateFilter.authoritativeSource, "logics-csv");
    assert.equal(candidateFilter.transactionStatus, "SUCCESS");
    assert.equal(candidateFilter.domain, "TAG");
    assert.equal(candidateFilter.caseId, 394513);
    assert.equal(candidateFilter.amount, 500);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0][0], { casePaymentId: 700 });
  } finally {
    PaymentLedger.findOne = originalFindOne;
    PaymentLedger.find = originalFind;
    PaymentLedger.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("a DECLINED incoming row hunts a DECLINED twin, never a success", async () => {
  // The sheet ingests failed payments (2026-07-27), so the API's declined
  // row must absorb the sheet's declined synthetic — and a card that
  // bounced then went through must stay TWO rows: a declined incoming row
  // may only ever match a declined twin.
  const originalFindOne = PaymentLedger.findOne;
  const originalFind = PaymentLedger.find;
  const originalFindOneAndUpdate = PaymentLedger.findOneAndUpdate;
  let candidateFilter = null;

  PaymentLedger.findOne = () => queryResult(null);
  PaymentLedger.find = (filter) => {
    candidateFilter = filter;
    return listQueryResult([]);
  };
  PaymentLedger.findOneAndUpdate = async () => ({ upserted: true });

  try {
    await paymentLedgerRepository.reconcilePaymentLedger(702, {
      domain: "TAG",
      caseId: 888,
      amount: 250,
      paymentDate: new Date("2026-07-21T12:00:00.000Z"),
      paymentType: "unknown",
      transactionStatus: "DECLINED",
    });
    assert.equal(candidateFilter.transactionStatus, "DECLINED");
    assert.equal(candidateFilter.authoritativeSource, "logics-csv");
    assert.deepEqual(candidateFilter.casePaymentId, { $lt: 0 });
  } finally {
    PaymentLedger.findOne = originalFindOne;
    PaymentLedger.find = originalFind;
    PaymentLedger.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

for (const [label, candidates] of [
  ["zero", []],
  [
    "ambiguous",
    [
      { _id: "synthetic-a", casePaymentId: -1 },
      { _id: "synthetic-b", casePaymentId: -2 },
    ],
  ],
]) {
  test(`${label} synthetic candidates fall through without absorption`, async () => {
    const originalFindOne = PaymentLedger.findOne;
    const originalFind = PaymentLedger.find;
    const originalFindOneAndUpdate = PaymentLedger.findOneAndUpdate;
    const writes = [];

    PaymentLedger.findOne = () => queryResult(null);
    PaymentLedger.find = () => listQueryResult(candidates);
    PaymentLedger.findOneAndUpdate = async (...args) => {
      writes.push(args);
      return { upserted: true };
    };

    try {
      await paymentLedgerRepository.reconcilePaymentLedger(701, {
        domain: "TAG",
        caseId: 394513,
        amount: 500,
        paymentDate: new Date("2026-07-01T12:00:00.000Z"),
        paymentType: "initial",
        transactionStatus: "SUCCESS",
      });

      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0][0], { casePaymentId: 701 });
      assert.equal(writes[0][1].$set.casePaymentId, undefined);
      assert.deepEqual(writes[0][2], {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      });
    } finally {
      PaymentLedger.findOne = originalFindOne;
      PaymentLedger.find = originalFind;
      PaymentLedger.findOneAndUpdate = originalFindOneAndUpdate;
    }
  });
}
