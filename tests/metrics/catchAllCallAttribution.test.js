"use strict";

// A CATCH-ALL IS A MISSING ANSWER, NOT A FINAL ONE.
//
// Mickey 2026-08-03: "not attributing deals".
//
// Logics often holds a catch-all campaign for a fresh sale (ABC is campaign
// 57) because the sanitiser has not written the real source back yet. The old
// resolver saw a catch-all and stopped, so on 2026-08-03 all three deals read
// as unattributed — while the long-calls section on the SAME board happily
// showed case 436545 as Affordability Federal and 434175 as 3rd Day (Pink),
// off the CallRail call the prospect actually made.
//
// The call names the piece. Same evidence, same day, now used in both places.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { resolveSourceRow, attributionSourceResolver } = require("../../packages/shared-services/src/reportOpsService");

const RANGE = { rangeStart: "2026-08-03", rangeEnd: "2026-08-03" };

const payment = (over = {}) => ({
  domain: "TAG", caseId: 1, paymentType: "initial", amount: 500,
  isChargeback: false, paymentDateKey: "2026-08-03", phone: "5550001111",
  sourceAtSale: null, sourceOrigin: "catch-all", catchAllLabel: "ABC",
  metricsTreatment: { firstPaidDateKey: "2026-08-03" },
  ...over,
});

const call = (over = {}) => ({
  phone: "5550001111", source: "Affordability Federal",
  dateKey: "2026-08-03", durationSec: 600, ...over,
});

test("a deal on a catch-all takes the piece its call rang in on", () => {
  const row = resolveSourceRow(payment(), {
    ...RANGE, attributionCallDate: "2026-08-03", attributionCallSource: "Affordability Federal",
  });
  assert.equal(row, "Affordability Federal");
});

test("with no call, a catch-all stays a catch-all — nothing is invented", () => {
  const row = resolveSourceRow(payment(), { ...RANGE, attributionCallSource: null });
  assert.match(row, /catch-all/i);
});

test("a REAL stored source always beats the call", () => {
  // The call fills a blank; it never overrides an answer Logics already has.
  const row = resolveSourceRow(
    payment({ sourceAtSale: "Urgent Third State", sourceOrigin: null, catchAllLabel: null }),
    { ...RANGE, attributionCallDate: "2026-08-03", attributionCallSource: "Affordability Federal" },
  );
  assert.equal(row, "Urgent Third State");
});

test("a catch-all CALL cannot rescue a catch-all case", () => {
  // Two buckets do not make an answer.
  const row = resolveSourceRow(payment(), { ...RANGE, attributionCallSource: "ABC" });
  assert.match(row, /catch-all/i);
});

test("the resolver picks the same call the date resolver does", () => {
  const sourceFor = attributionSourceResolver([
    call({ source: "Urgent Third State", durationSec: 60 }),
    call({ source: "Affordability Federal", durationSec: 900 }),
  ]);
  // "attribution is the longest call on the day the deal closed".
  assert.equal(sourceFor(payment()), "Affordability Federal");
});

test("a servicing call never names a source", () => {
  // An existing client ringing support must not make their case look freshly
  // sourced — the marketing-line filter is inherited, not re-implemented.
  const sourceFor = attributionSourceResolver([call({ source: "Client Contact" })]);
  assert.equal(sourceFor(payment()), null);
});

test("a payment with no phone resolves to nothing, not to a guess", () => {
  const sourceFor = attributionSourceResolver([call()]);
  assert.equal(sourceFor(payment({ phone: null, phones: [] })), null);
});
