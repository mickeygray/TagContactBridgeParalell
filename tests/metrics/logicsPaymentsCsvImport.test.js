"use strict";

// Regression cover for the duplicate-collapse and wrong-row-claim bugs in
// the Logics Payments CSV importer (handoff 2026-07-24, "Do Not Apply
// Alerts Yet" item 1). Both were latent: the helpers existed but the
// import loop still ran its own inline findOne.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const PaymentLedger = require("../../packages/shared-models/src/PaymentLedger");
const {
  importLogicsPaymentsCsv,
} = require("../../packages/shared-services/src/logicsPaymentsCsvImportService");

const HEADER = [
  "Case ID", "Client Name", "Settlement Officer", "Amount", "Payment Type",
  "Payment Method", "Payment Status", "Source Name", "Tag", "PaidDate",
  "Transaction Time", "Comment",
].join(",");

function csvRow({
  caseId, amount, type = "Initial", method = "Credit Card",
  status = "Success", paid = "7/21/2026 12:00:00 AM", comment = "",
}) {
  return [
    caseId, "Test Client", "Officer", amount, type, method, status,
    "Affordability Federal", "tag", paid, paid, `"${comment}"`,
  ].join(",");
}

function buildCsv(rows) {
  return Buffer.from([HEADER, ...rows].join("\n"), "utf8");
}

// Minimal in-memory stand-in that honours the filter shapes the importer
// actually builds: _id $nin, transactionStatus, raw.csv.txnId, and the
// paymentDate window.
function fakeLedger(docs) {
  const matches = (doc, filter) => {
    for (const [key, expected] of Object.entries(filter)) {
      if (key === "$or") {
        if (!expected.some((sub) => matches(doc, sub))) return false;
        continue;
      }
      if (key === "_id" && expected?.$nin) {
        if (expected.$nin.includes(doc._id)) return false;
        continue;
      }
      if (key === "raw.csv.txnId") {
        const actual = doc?.raw?.csv?.txnId ?? null;
        if (expected && typeof expected === "object") {
          if ("$exists" in expected && expected.$exists === false && actual != null) return false;
          continue;
        }
        if (actual !== expected) return false;
        continue;
      }
      if (key === "paymentDate" && expected?.$gte) {
        const at = new Date(doc.paymentDate).getTime();
        if (at < expected.$gte.getTime() || at > expected.$lte.getTime()) return false;
        continue;
      }
      if (doc[key] !== expected) return false;
    }
    return true;
  };
  return (filter) => {
    const hits = docs.filter((doc) => matches(doc, filter));
    return {
      sort() {
        return Promise.resolve(hits[0] || null);
      },
    };
  };
}

async function runImport(docs, rows) {
  const originalFindOne = PaymentLedger.findOne;
  const originalUpdateOne = PaymentLedger.updateOne;
  const writes = [];
  PaymentLedger.findOne = fakeLedger(docs);
  PaymentLedger.updateOne = async (filter, update, options) => {
    writes.push({ filter, update, options });
    return { acknowledged: true };
  };
  try {
    const summary = await importLogicsPaymentsCsv({
      domain: "TAG",
      buffer: buildCsv(rows),
    });
    return { summary, writes };
  } finally {
    PaymentLedger.findOne = originalFindOne;
    PaymentLedger.updateOne = originalUpdateOne;
  }
}

test("two identical CSV rows do not collapse onto one ledger row", async () => {
  // A client genuinely paid $500 twice on the same day. The ledger only
  // caught one of them. The second CSV row must INSERT, not silently
  // re-claim the row the first row already matched.
  const { summary, writes } = await runImport(
    [{
      _id: "ledger-a", domain: "TAG", caseId: 1234, amount: 500,
      paymentDate: new Date("2026-07-21T12:00:00.000Z"),
      transactionStatus: "SUCCESS", paymentType: "unknown",
    }],
    [csvRow({ caseId: 1234, amount: 500 }), csvRow({ caseId: 1234, amount: 500 })],
  );

  assert.equal(summary.parsed, 2);
  assert.equal(summary.matchedUpdated, 1, "first row updates the existing ledger row");
  assert.equal(summary.inserted, 1, "second row must insert, not collapse");
  assert.equal(summary.matchedAlreadyCorrect, 0);

  // Both dollars survive.
  assert.equal(summary.totalAmount, 1000);

  const inserts = writes.filter((w) => w.options?.upsert);
  assert.equal(inserts.length, 1);
  assert.ok(
    inserts[0].filter.casePaymentId < 0,
    "inserted row uses a synthetic negative casePaymentId",
  );
});

test("three identical rows produce three distinct synthetic identities", async () => {
  const { summary, writes } = await runImport(
    [],
    Array.from({ length: 3 }, () => csvRow({ caseId: 1234, amount: 500 })),
  );
  assert.equal(summary.inserted, 3);
  const ids = writes.filter((w) => w.options?.upsert).map((w) => w.filter.casePaymentId);
  assert.equal(new Set(ids).size, 3, `synthetic ids collided: ${ids.join(", ")}`);
});

test("re-importing the same CSV is idempotent (ordinals stay stable)", async () => {
  const rows = [csvRow({ caseId: 1234, amount: 500 }), csvRow({ caseId: 1234, amount: 500 })];
  const first = await runImport([], rows);
  const firstIds = first.writes.filter((w) => w.options?.upsert).map((w) => w.filter.casePaymentId);

  // Second run sees what the first run inserted.
  const ledger = firstIds.map((casePaymentId, index) => ({
    _id: `synthetic-${index}`, domain: "TAG", caseId: 1234, amount: 500,
    casePaymentId, paymentDate: new Date("2026-07-21T12:00:00.000Z"),
    transactionStatus: "SUCCESS", paymentType: "initial",
    authoritativeSource: "logics-csv",
  }));
  const second = await runImport(ledger, rows);

  assert.equal(second.summary.inserted, 0, "re-import must not create new rows");
  assert.equal(second.summary.matchedAlreadyCorrect, 2);
});

test("a SUCCESS CSV row never claims a DECLINED ledger row", async () => {
  // The old matcher had no transactionStatus filter and sorted paymentDate
  // ascending — so a card that declined and then succeeded (same case,
  // same amount, a day apart) had its DECLINE claimed and overwritten as an
  // authoritative successful initial. 32 such pairs exist since June 1.
  const { summary, writes } = await runImport(
    [
      {
        _id: "declined-row", domain: "TAG", caseId: 4321, amount: 3200,
        paymentDate: new Date("2026-07-20T12:00:00.000Z"),
        transactionStatus: "DECLINED", paymentType: "unknown",
      },
      {
        _id: "success-row", domain: "TAG", caseId: 4321, amount: 3200,
        paymentDate: new Date("2026-07-21T12:00:00.000Z"),
        transactionStatus: "SUCCESS", paymentType: "unknown",
      },
    ],
    [csvRow({ caseId: 4321, amount: 3200 })],
  );

  assert.equal(summary.matchedUpdated, 1);
  assert.equal(summary.inserted, 0);
  const target = writes.find((w) => !w.options?.upsert);
  assert.equal(target.filter._id, "success-row", "must correct the SUCCESS row, not the decline");
});

test("an exact transaction id outranks a same-amount neighbour", async () => {
  const { writes } = await runImport(
    [
      {
        _id: "fuzzy-older", domain: "TAG", caseId: 777, amount: 250,
        paymentDate: new Date("2026-07-19T12:00:00.000Z"),
        transactionStatus: "SUCCESS", paymentType: "unknown",
      },
      {
        _id: "exact-txn", domain: "TAG", caseId: 777, amount: 250,
        paymentDate: new Date("2026-07-23T12:00:00.000Z"),
        transactionStatus: "SUCCESS", paymentType: "unknown",
        raw: { csv: { txnId: "998877" } },
      },
    ],
    [csvRow({ caseId: 777, amount: 250, comment: "Transaction ID: 998877" })],
  );
  const target = writes.find((w) => !w.options?.upsert);
  assert.equal(target.filter._id, "exact-txn", "txn id must win over the earlier fuzzy match");
});

test("declined rows are ingested as declines and never move money", async () => {
  // Mickey (2026-07-27) exports the sheet WITH failed payments so the sheet
  // can replace the hourly API sweep entirely — declines power the
  // card-chasing list, but must never touch a dollar total.
  const { summary, writes } = await runImport(
    [],
    [csvRow({ caseId: 555, amount: 100, status: "Declined" })],
  );
  assert.equal(summary.failedInserted, 1);
  assert.equal(summary.inserted, 0, "not counted as a payment insert");
  assert.equal(summary.totalAmount, 0, "a decline must not move the dollar total");
  const insert = writes.find((w) => w.options?.upsert);
  assert.equal(insert.update.$set.transactionStatus, "DECLINED");
  assert.ok(insert.filter.casePaymentId < 0);
});

test("a decline and its same-identity success get DIFFERENT synthetic ids", async () => {
  // Same case, same amount, same day — the card bounced, then went
  // through. Two ledger rows, two identities, or the second upsert would
  // silently overwrite the first.
  const { summary, writes } = await runImport(
    [],
    [
      csvRow({ caseId: 777, amount: 500, status: "Declined" }),
      csvRow({ caseId: 777, amount: 500, status: "Success" }),
    ],
  );
  assert.equal(summary.failedInserted, 1);
  assert.equal(summary.inserted, 1);
  const ids = writes.filter((w) => w.options?.upsert).map((w) => w.filter.casePaymentId);
  assert.equal(new Set(ids).size, 2, `identities collided: ${ids.join(", ")}`);
});

test("a declined CSV row claims a declined ledger row, never the success", async () => {
  const { summary, writes } = await runImport(
    [
      {
        _id: "the-decline", domain: "TAG", caseId: 888, amount: 250,
        paymentDate: new Date("2026-07-21T12:00:00.000Z"),
        transactionStatus: "DECLINED", paymentType: "unknown",
      },
      {
        _id: "the-success", domain: "TAG", caseId: 888, amount: 250,
        paymentDate: new Date("2026-07-21T12:00:00.000Z"),
        transactionStatus: "SUCCESS", paymentType: "unknown",
      },
    ],
    [csvRow({ caseId: 888, amount: 250, status: "Declined" })],
  );
  assert.equal(summary.failedMatched, 1);
  const target = writes.find((w) => !w.options?.upsert);
  assert.equal(target.filter._id, "the-decline");
});

test("anything but success is a failed payment — PENDING included", async () => {
  // Ruling (Mickey 2026-07-27): the status column is binary. Only a blank
  // status carries no signal and is skipped.
  const pending = await runImport([], [csvRow({ caseId: 999, amount: 100, status: "Pending" })]);
  assert.equal(pending.summary.failedInserted, 1);
  assert.equal(pending.summary.totalAmount, 0);

  const blank = await runImport([], [csvRow({ caseId: 998, amount: 100, status: "" })]);
  assert.equal(blank.summary.skippedNonSuccess, 1);
  assert.equal(blank.summary.failedInserted, 0);
  assert.equal(blank.writes.length, 0);
});

test("chargeback is detected from Payment Type as well as Method", async () => {
  const { summary } = await runImport(
    [{
      _id: "cb-target", domain: "TAG", caseId: 654, amount: -300,
      paymentDate: new Date("2026-07-21T12:00:00.000Z"),
      transactionStatus: "SUCCESS", paymentType: "recurring",
    }],
    [csvRow({ caseId: 654, amount: -300, type: "Initial Charge Back", method: "Credit Card" })],
  );
  assert.equal(summary.chargebacksTyped, 1, "type-column chargeback must count");
});
