"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  activeMigrationFilter,
  buildPacificDateRange,
  buildSimpleNightlyPaymentRollup,
  buildSimpleTotals,
  currentPacificDateKey,
  normalizeSimpleMarketingDomain,
} = require("../../packages/shared-services/src/simpleMarketingReadService");

test("simple marketing scope is explicit and fail-closed", () => {
  assert.equal(normalizeSimpleMarketingDomain("all"), "ALL");
  for (const value of [undefined, "", "TAG", "WYNN"]) {
    assert.throws(
      () => normalizeSimpleMarketingDomain(value),
      (error) => error.status === 400 && error.code === "SIMPLE_MARKETING_SCOPE_REQUIRED",
    );
  }
});

test("Pacific date ranges are real-calendar, inclusive-day and DST-safe", () => {
  const summer = buildPacificDateRange({ from: "2026-07-24", to: "2026-07-24" });
  assert.equal(summer.start.toISOString(), "2026-07-24T07:00:00.000Z");
  assert.equal(summer.endExclusive.toISOString(), "2026-07-25T07:00:00.000Z");

  const spring = buildPacificDateRange({ from: "2026-03-08", to: "2026-03-08" });
  assert.equal((spring.endExclusive - spring.start) / 3_600_000, 23);
  const fall = buildPacificDateRange({ from: "2026-11-01", to: "2026-11-01" });
  assert.equal((fall.endExclusive - fall.start) / 3_600_000, 25);

  assert.throws(() => buildPacificDateRange({ from: "2026-02-31", to: "2026-03-01" }));
  assert.throws(() => buildPacificDateRange({ from: "2026-07-02", to: "2026-07-01" }));
});

test("Pacific coverage never admits future-dated feed rows", () => {
  assert.equal(currentPacificDateKey(new Date("2026-07-24T06:59:59.999Z")), "2026-07-23");
  assert.equal(currentPacificDateKey(new Date("2026-07-24T07:00:00.000Z")), "2026-07-24");
  assert.throws(() => currentPacificDateKey("not-an-instant"));
});

test("migration-safe reads exclude only explicitly retired rows", () => {
  assert.deepEqual(activeMigrationFilter(), { active: { $ne: false } });
});

test("headline calls include PhoneBurner/LD calls without mixing LD leads into responses", () => {
  assert.deepEqual(buildSimpleTotals([
    { source: "mailer", responses: 2, calls: 3, spend: 10 },
    { source: "LD", responses: 5, calls: 17, spend: 15 },
  ]), {
    responses: 2,
    calls: 20,
    deals: 0,
    initialsNet: 0,
    totalCollected: 0,
    spend: 25,
    ldLeads: 5,
  });
});

test("nightly payment rollup counts cases, preserves signed money, and exposes duplicate initials", () => {
  const result = buildSimpleNightlyPaymentRollup({
    dayPayments: [
      { domain: "TAG", caseId: 394513, transactionStatus: "SUCCESS", paymentType: "initial", amount: 250, metricsTreatment: { reportingBucket: "Aged" }, raw: { csv: { sourceName: "Affordability Federal" } } },
      { domain: "TAG", caseId: 394513, transactionStatus: "SUCCESS", paymentType: "initial", amount: 150, raw: { csv: { sourceName: "Affordability Federal" } } },
      { domain: "TAG", caseId: 409586, transactionStatus: "SUCCESS", paymentType: "initial", amount: 100, metricsTreatment: { reportingBucket: "Unknown" }, raw: { csv: { sourceName: "Unknown" } } },
      { domain: "TAG", caseId: 409586, transactionStatus: "SUCCESS", paymentType: "initial", amount: -100, raw: { csv: { sourceName: "Unknown" } } },
      { domain: "TAG", caseId: 220274, transactionStatus: "SUCCESS", paymentType: "initial", amount: 75, raw: { csv: { sourceName: "ABC" } } },
      { domain: "TAG", caseId: 220274, transactionStatus: "SUCCESS", paymentType: "recurring", amount: 25 },
    ],
    profiles: [
      {
        domain: "TAG",
        caseId: 394513,
        sourceName: "Affordability Federal",
        sourceChannel: "lead-data",
      },
      { domain: "TAG", caseId: 409586, sourceName: "Affordability Federal" },
      { domain: "TAG", caseId: 220274, sourceName: "Affordability Federal" },
    ],
    activeContext: {
      pieces: new Set(["Affordability Federal"]),
      sheetToCanonical: new Map(),
    },
  });

  assert.deepEqual(result.totals, {
    caseCount: 3,
    transactionCount: 6,
    totalAmount: 500,
    initialAmount: 475,
    // Three cases sold: 394513 (two rows, one deal), 409586 (sold then
    // charged back — the money nets, the sale still counts), and 220274.
    initialDealCount: 3,
    multiplePositiveInitialCases: 1,
    // No separate cash set supplied, so cash == the same rows.
    cashCollected: 500,
    // No window supplied → recurring vintage is unknowable, and says so.
    cashBreakdown: {
      initial: 475,
      recurringFromThisMonth: 0,
      recurringFromOlderMonths: 0,
      recurringUnknownVintage: 25,
    },
    cashByOfficer: [{ officer: "(unattributed)", cash: 500 }],
  });
  assert.deepEqual(result.initialsBySource.get("Aged"), {
    count: 1, amount: 400, totalCollected: 400,
  });
  assert.deepEqual(result.initialsBySource.get("Affordability Federal"), {
    // 220274 plus 409586 — the charged-back sale still counts as a deal for
    // its source; only its money nets away.
    count: 2, amount: 75, totalCollected: 100,
  });
  assert.deepEqual(result.alerts, [{
    type: "multiple_positive_initials",
    domain: "TAG",
    caseId: 394513,
  }]);
});

test("nightly payment rollup keeps same case IDs separate by domain and treats generic sources as missing", () => {
  const result = buildSimpleNightlyPaymentRollup({
    dayPayments: [
      { domain: "TAG", caseId: 10, transactionStatus: "SUCCESS", paymentType: "initial", amount: 100, raw: { csv: { sourceName: "Unknown" } } },
      { domain: "WYNN", caseId: 10, transactionStatus: "SUCCESS", paymentType: "initial", amount: -25, raw: { csv: { sourceName: "ABC" } } },
    ],
    profiles: [
      { domain: "TAG", caseId: 10, sourceName: "Aged" },
      { domain: "WYNN", caseId: 10, sourceName: "Unknown" },
    ],
    activeContext: { pieces: new Set(), sheetToCanonical: new Map() },
  });

  assert.equal(result.totals.caseCount, 2);
  assert.equal(result.totals.totalAmount, 75);
  // TAG:10 sold; WYNN:10 is a bare reversal with no sale in view.
  assert.equal(result.totals.initialDealCount, 1);
  assert.deepEqual(result.initialsBySource.get("Aged"), {
    count: 1, amount: 100, totalCollected: 100,
  });
  assert.deepEqual(result.initialsBySource.get("Unattributed"), {
    // A bare reversal claws back money without ever claiming a deal, so a
    // source can no longer be charged a NEGATIVE deal count.
    count: 0, amount: -25, totalCollected: -25,
  });
});
test("simple route passes scope and the read exposes PhoneBurner freshness without legacy time hacks", () => {
  const route = fs.readFileSync(
    path.join(__dirname, "../../apps/control-plane/src/routes/readMetrics.js"),
    "utf8",
  );
  const service = fs.readFileSync(
    path.join(__dirname, "../../packages/shared-services/src/simpleMarketingReadService.js"),
    "utf8",
  );
  assert.match(route, /buildSimpleMarketingSummary\(\{\s*domain: req\.params\.domain,/);
  assert.doesNotMatch(service, /active:\s*true/);
  assert.doesNotMatch(service, /T23:59:59-07:00/);
  assert.match(service, /platform: "phoneburner", durationSec: \{ \$gte: 300 \}/);
  assert.match(service, /phoneburner:\s*\{\s*lastProjectedCallAt:/);
  assert.match(service, /date: \{ \$gte: windowStart, \$lte: windowEnd \}/);
  assert.match(service, /date: \{ \$lte: currentPacificDateKey\(\) \}/);
});