"use strict";

// The nightly narrative (Mickey, 2026-07-27): "a summary email should go
// out as part of the night that says in a few sentences here's what
// happened with case statuses, money, and lead sources ... we can read
// straight from logics activities and payment sheet for that."
//
// Three sentences, three canonical sources: statuses from the Activities
// rollup, money from the sheet-gated ledger summary, sources from the
// day's attributed deals. Missing inputs are SAID, never zero-filled.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  buildNightlyNarrative,
  buildSimpleNightlyEmailData,
  readActivityStatusCounts,
} = require("../../packages/shared-services/src/simpleNightlyEmailService");

const SUMMARY = {
  dateKey: "2026-07-27",
  rows: [
    { source: "Affordability Federal", initialsCount: 2, responses: 4 },
    { source: "LD", initialsCount: 1, responses: 319 },
    { source: "Urgent Third State", initialsCount: 0, responses: 6 },
  ],
  totals: {
    initialsCount: 3,
    initialsNet: 4200,
    cashCollected: 18450.5,
    totalCollected: 19450.5,
    ldLeads: 319,
    uniqueLeads: 22,
  },
  byDomain: [
    { domain: "TAG", cashCollected: 15100.5 },
    { domain: "WYNN", cashCollected: 2900 },
    { domain: "AMITY", cashCollected: 450 },
  ],
  chargebackRestatement: {
    pushedOut: [{ caseId: 365360, amount: -3200 }],
    pulledIn: [],
  },
};

const COUNTS = { dnc: 4, postdate: 7, casesChanged: 61 };

test("three sentences: statuses, money, lead sources", () => {
  const lines = buildNightlyNarrative({ summary: SUMMARY, statusCounts: COUNTS });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /4 DNC'd and 7 post-dated today, per Logics activities \(61 cases changed status\)/);
  assert.match(lines[1], /3 new clients for \$4,200\.00 in initials/);
  assert.match(lines[1], /\$18,450\.50 cash collected/);
  assert.match(lines[1], /TAG \$15,100\.50 \/ WYNN \$2,900\.00 \/ AMITY \$450\.00/);
  assert.match(lines[1], /1 payment restated to the month of sale/);
  assert.match(lines[2], /deals from Affordability Federal \(2\), LD \(1\)/);
  assert.match(lines[2], /319 LD leads and 22 mail responses in/);
});

test("cash is the money number, never the attributed total", () => {
  const [, moneyLine] = buildNightlyNarrative({ summary: SUMMARY, statusCounts: COUNTS });
  assert.ok(!moneyLine.includes("19,450.50"), "attributed total must not headline the narrative");
});

test("missing activity counts are SAID, not zero-filled", () => {
  const [statusLine] = buildNightlyNarrative({ summary: SUMMARY, statusCounts: null });
  assert.match(statusLine, /activity counts unavailable for 2026-07-27/);
  assert.ok(!/0 DNC'd/.test(statusLine), "must not invent zeros");
});

test("a quiet day still reads sensibly", () => {
  const lines = buildNightlyNarrative({
    summary: {
      dateKey: "2026-07-26",
      rows: [],
      totals: { initialsCount: 0, initialsNet: 0, cashCollected: 0, ldLeads: 0, uniqueLeads: 0 },
      byDomain: [],
      chargebackRestatement: { pushedOut: [], pulledIn: [] },
    },
    statusCounts: { dnc: 0, postdate: 0, casesChanged: 1 },
  });
  assert.match(lines[0], /0 DNC'd and 0 post-dated today.*\(1 case changed status\)/);
  assert.match(lines[1], /0 new clients for \$0\.00/);
  assert.ok(!lines[1].includes("restated"), "no restatement clause on a clean day");
  assert.match(lines[2], /no deals attributed today/);
});

test("readActivityStatusCounts reads the review's day JSON and tolerates absence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-"));
  try {
    fs.writeFileSync(
      path.join(dir, "logics-activity-review-ALL-2026-07-27.json"),
      JSON.stringify({ ok: true, processed: { statusChangeCounts: COUNTS } }),
    );
    assert.deepEqual(readActivityStatusCounts("2026-07-27", { outDir: dir }), COUNTS);
    assert.equal(readActivityStatusCounts("2026-07-26", { outDir: dir }), null, "missing day");
    fs.writeFileSync(path.join(dir, "logics-activity-review-ALL-2026-07-25.json"), "{not json");
    assert.equal(readActivityStatusCounts("2026-07-25", { outDir: dir }), null, "malformed file");
    fs.writeFileSync(
      path.join(dir, "logics-activity-review-ALL-2026-07-24.json"),
      JSON.stringify({ processed: { statusChangeCounts: { error: "boom" } } }),
    );
    assert.equal(readActivityStatusCounts("2026-07-24", { outDir: dir }), null, "errored rollup");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Complete-snapshot additions (Mickey, 2026-07-27) ──────────────────────

const {
  buildWynnNightlyEmailData,
} = require("../../packages/shared-services/src/simpleNightlyEmailService");
const {
  buildSimpleNightlyPaymentRollup,
} = require("../../packages/shared-services/src/simpleMarketingReadService");

test("recurring cash splits by client vintage through the first-initial map", () => {
  const pay = (overrides) => ({
    domain: "TAG", transactionStatus: "SUCCESS", paymentType: "recurring",
    amount: 100, paymentDateKey: "2026-07-10", raw: { csv: { officer: "Sean Lucas" } },
    ...overrides,
  });
  const rows = [
    pay({ caseId: 1, paymentType: "initial", amount: 1000 }),          // new-client money
    pay({ caseId: 1, amount: 500 }),                                    // recurring, sold THIS month
    pay({ caseId: 2, amount: 300 }),                                    // recurring, sold MARCH
    pay({ caseId: 3, amount: 200, raw: {} }),                           // recurring, vintage unknown
  ];
  const result = buildSimpleNightlyPaymentRollup({
    dayPayments: rows,
    cashPayments: rows,
    profiles: [],
    activeContext: { pieces: new Set(), sheetToCanonical: new Map() },
    window: {
      from: "2026-07-01",
      to: "2026-07-31",
      firstInitialDateByCase: new Map([
        ["TAG:1", "2026-07-10"],
        ["TAG:2", "2026-03-15"],
      ]),
    },
  });
  assert.deepEqual(result.totals.cashBreakdown, {
    initial: 1000,
    recurringFromThisMonth: 500,
    recurringFromOlderMonths: 300,
    recurringUnknownVintage: 200,
  });
  const officers = Object.fromEntries(result.totals.cashByOfficer.map((row) => [row.officer, row.cash]));
  assert.equal(officers["Sean Lucas"], 1800);
  assert.equal(officers["(unattributed)"], 200);
});

test("the WYNN-only email carries WYNN and only WYNN", () => {
  const data = buildWynnNightlyEmailData(
    {
      dateKey: "2026-07-27",
      byDomain: [
        { domain: "TAG", deals: 25, initialsNet: 29495.17, cashCollected: 331685.48 },
        { domain: "WYNN", deals: 2, initialsNet: 900, cashCollected: 1400 },
      ],
      dealsBySourceByDomain: {
        TAG: [{ source: "Affordability Federal", count: 25, amount: 29495.17 }],
        WYNN: [{ source: "LD", count: 2, amount: 900 }],
      },
    },
    { statusCounts: { byDomain: { WYNN: { dnc: 3, postdate: 1 }, TAG: { dnc: 9, postdate: 4 } } } },
  );
  const text = JSON.stringify(data);
  assert.ok(!text.includes("331,685"), "TAG cash must never appear");
  assert.ok(!text.includes("Affordability Federal"), "TAG sources must never appear");
  assert.match(data.narrativeLines[0], /3 DNC'd and 1 post-dated/);
  assert.match(data.narrativeLines[1], /2 new clients for \$900\.00.*\$1,400\.00 cash/);
  assert.match(data.narrativeLines[2], /LD \(2\)/);
  assert.equal(data.longCalls.length, 0, "calls cannot be split by company — none shown");
});

test("the money sentence now carries the vintage split", () => {
  const lines = buildNightlyNarrative({
    summary: {
      ...SUMMARY,
      totals: {
        ...SUMMARY.totals,
        cashBreakdown: {
          initial: 4200, recurringFromThisMonth: 1250,
          recurringFromOlderMonths: 13000.5, recurringUnknownVintage: 0,
        },
      },
    },
    statusCounts: COUNTS,
  });
  assert.match(lines[1], /\$4,200\.00 new-client money/);
  assert.match(lines[1], /\$1,250\.00 recurring from this month's clients/);
  assert.match(lines[1], /\$13,000\.50 from the back book/);
});

test("RULING: recordings are CallRail or PhoneBurner only — EX never surfaces", () => {
  const {
    LONG_CALL_RECORDING_PLATFORMS,
    buildLongCallFilter,
  } = require("../../packages/shared-services/src/simpleMarketingReadService");

  // Allow-list, not deny-list: EX (and anything new) is excluded until
  // deliberately added. "ex is dangerous" — Mickey, 2026-07-27.
  assert.deepEqual([...LONG_CALL_RECORDING_PLATFORMS].sort(), ["callrail", "phoneburner"]);

  const filter = buildLongCallFilter({
    start: new Date("2026-07-27T07:00:00Z"),
    endExclusive: new Date("2026-07-28T07:00:00Z"),
    minDurationSec: 300,
  });
  assert.deepEqual(filter.platform, { $in: ["phoneburner", "callrail"] });
  assert.ok(!JSON.stringify(filter).includes('"ex"'), "EX must not appear in any form");
  assert.equal(filter.durationSec.$gte, 300);
});

test("failed payments ride the email BODY only, never a dollar total", () => {
  // Replaces the retired financial email's "Payments that didn't process
  // today" section. Doctrine: body-only, never a CSV row, never money.
  const data = buildSimpleNightlyEmailData(SUMMARY, {
    statusCounts: COUNTS,
    failedPayments: [
      { domain: "TAG", caseId: 4321, client: "A CLIENT", amount: -3200, dateKey: "2026-07-27", status: "DECLINED" },
      { domain: "WYNN", caseId: 99, client: "B CLIENT", amount: 250, dateKey: "2026-07-27", status: "FAILURE" },
    ],
  });
  assert.equal(data.failedPayments.length, 2);
  assert.equal(data.failedPayments[0].caseLabel, "TAG 4321");
  assert.equal(data.failedPayments[0].amountLabel, "-$3,200.00");
  assert.equal(data.failedPayments[1].status, "FAILURE");
  // The tiles/narrative must be untouched by failures.
  assert.match(data.narrativeLines[1], /\$18,450\.50 cash collected/);
  assert.equal(data.tiles.find((t) => t.label === "Collected (cash)").value, "$18,450.50");
});

test("no failed payments → no section", () => {
  const data = buildSimpleNightlyEmailData(SUMMARY, { statusCounts: COUNTS });
  assert.deepEqual(data.failedPayments, []);
});
