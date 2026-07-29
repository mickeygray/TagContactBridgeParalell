"use strict";

// The daily payments-sheet gate: no money published until the day's Logics
// export has landed (Mickey, 2026-07-24: "no night time clean up until that
// sheet is present kinda thing").
//
// Driven by a measured fact: against Logics' own export, the ledger held
// $279,500.86 of TAG July against $412,579.15 — 34.6% short, all of it
// recurring. The API alone cannot be the basis of a published number.
//
// The load-bearing test in this file is the LAST one: the gate must never
// hold DNC/lead-status work. A missing spreadsheet must not leave DNC leads
// dialable overnight.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const PaymentsSheetImport = require("../../packages/shared-models/src/PaymentsSheetImport");
const gate = require("../../packages/shared-services/src/paymentsSheetGateService");
const PaymentLedger = require("../../packages/shared-models/src/PaymentLedger");

function withReceipts(receipts, run) {
  const original = PaymentsSheetImport.find;
  PaymentsSheetImport.find = () => ({ async lean() { return receipts; } });
  try { return run(); } finally { PaymentsSheetImport.find = original; }
}

const DAY = "2026-07-24";

test("ready only when every required company's sheet has landed", async () => {
  const status = await withReceipts([
    { domain: "TAG", dateKey: DAY, coversThrough: DAY },
    { domain: "WYNN", dateKey: DAY, coversThrough: DAY },
  ], () => gate.readPaymentsSheetStatus({ dateKey: DAY, domains: ["TAG", "WYNN"] }));

  assert.equal(status.ready, true);
  assert.deepEqual(status.missing, []);
  assert.deepEqual(status.present, ["TAG", "WYNN"]);
  assert.equal(status.reason, null);
});

test("one missing company holds the whole night's money", async () => {
  const status = await withReceipts([
    { domain: "TAG", dateKey: DAY, coversThrough: DAY },
  ], () => gate.readPaymentsSheetStatus({ dateKey: DAY, domains: ["TAG", "WYNN"] }));

  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, ["WYNN"]);
  assert.match(status.reason, /WYNN/);
});

test("a sheet that stops before the close date does NOT close it", async () => {
  // An export pulled at noon does not close the evening.
  const status = await withReceipts([
    { domain: "TAG", dateKey: DAY, coversThrough: "2026-07-23" },
    { domain: "WYNN", dateKey: DAY, coversThrough: DAY },
  ], () => gate.readPaymentsSheetStatus({ dateKey: DAY, domains: ["TAG", "WYNN"] }));

  assert.equal(status.ready, false);
  assert.equal(status.stale.length, 1);
  assert.equal(status.stale[0].domain, "TAG");
  assert.match(status.reason, /stops before/);
});

test("a sheet reaching PAST the close date is fine", async () => {
  const status = await withReceipts([
    { domain: "TAG", dateKey: DAY, coversThrough: "2026-07-25" },
    { domain: "WYNN", dateKey: DAY, coversThrough: DAY },
  ], () => gate.readPaymentsSheetStatus({ dateKey: DAY, domains: ["TAG", "WYNN"] }));
  assert.equal(status.ready, true);
});

test("THE GATE NEVER HOLDS SAFETY WORK", async () => {
  // A finance control must not become a compliance regression. Blocking the
  // DNC / lead-status refresh on a missing spreadsheet would leave DNC
  // leads dialable overnight — the exact bleed fixed on 2026-07-24.
  const decision = await withReceipts([], () =>
    gate.evaluatePaymentsSheetGate({ dateKey: DAY, domains: ["TAG", "WYNN"] }));

  assert.equal(decision.holdMoney, true, "money is held when no sheet landed");
  assert.equal(decision.holdSafetyWork, false, "DNC work must NEVER be gated");
});

test("the domain fingerprint rejects a mis-picked company", async () => {
  // Uploading the TAG export under WYNN would write a whole company's
  // payments to the wrong domain. Case ids are globally unique, so they
  // identify the file independently of the picker.
  const original = PaymentLedger.aggregate;
  PaymentLedger.aggregate = async () => [{ _id: "TAG", cases: [1, 2, 3, 4, 5, 6, 7, 8, 9] }];
  try {
    const bad = await gate.verifyPaymentsCsvDomain({ domain: "WYNN", caseIds: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    assert.equal(bad.ok, false);
    assert.equal(bad.detected, "TAG");

    const good = await gate.verifyPaymentsCsvDomain({ domain: "TAG", caseIds: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    assert.equal(good.ok, true);
  } finally {
    PaymentLedger.aggregate = original;
  }
});

test("an unrecognisable file is allowed through", async () => {
  // The guard catches mis-picks; it does not demand omniscience. A brand
  // new company or a first-ever export must not be blocked.
  const original = PaymentLedger.aggregate;
  PaymentLedger.aggregate = async () => [];
  try {
    const result = await gate.verifyPaymentsCsvDomain({ domain: "WYNN", caseIds: [999999] });
    assert.equal(result.ok, true);
    assert.equal(result.detected, null);
  } finally {
    PaymentLedger.aggregate = original;
  }
});

test("a mixed file below the confidence floor is not rejected", async () => {
  const original = PaymentLedger.aggregate;
  PaymentLedger.aggregate = async () => [
    { _id: "TAG", cases: [1, 2, 3] },
    { _id: "WYNN", cases: [4, 5] },
  ];
  try {
    // 3/5 = 0.6 confidence, below the 0.8 floor — ambiguous, so allow.
    const result = await gate.verifyPaymentsCsvDomain({ domain: "WYNN", caseIds: [1, 2, 3, 4, 5] });
    assert.equal(result.ok, true);
    assert.equal(result.confidence, 0.6);
  } finally {
    PaymentLedger.aggregate = original;
  }
});

test("required domains are configurable and default to the upload UI's two", () => {
  const before = process.env.PAYMENTS_SHEET_REQUIRED_DOMAINS;
  try {
    delete process.env.PAYMENTS_SHEET_REQUIRED_DOMAINS;
    assert.deepEqual(gate.requiredDomains(), ["TAG", "WYNN"]);
    process.env.PAYMENTS_SHEET_REQUIRED_DOMAINS = "tag, wynn ,amity";
    assert.deepEqual(gate.requiredDomains(), ["TAG", "WYNN", "AMITY"]);
  } finally {
    if (before === undefined) delete process.env.PAYMENTS_SHEET_REQUIRED_DOMAINS;
    else process.env.PAYMENTS_SHEET_REQUIRED_DOMAINS = before;
  }
});

test("the gate can be switched off without touching code", async () => {
  const before = process.env.PAYMENTS_SHEET_GATE_ENABLED;
  try {
    process.env.PAYMENTS_SHEET_GATE_ENABLED = "false";
    const decision = await withReceipts([], () =>
      gate.evaluatePaymentsSheetGate({ dateKey: DAY, domains: ["TAG"] }));
    assert.equal(decision.ready, false, "still reports the truth");
    assert.equal(decision.holdMoney, false, "but does not hold");
  } finally {
    if (before === undefined) delete process.env.PAYMENTS_SHEET_GATE_ENABLED;
    else process.env.PAYMENTS_SHEET_GATE_ENABLED = before;
  }
});
