"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  DAILY_SECTION_KEYS,
  REPORT_SECTION_IDS,
  REPORT_TO_DAILY_SECTION,
  ROLLUP_SECTION_IDS,
} = require("../../packages/shared-services/src/dailyReportContract");
const DailyReportFact = require("../../packages/shared-models/src/DailyReportFact");
const { CAPTURE_VERSION } = require("../../packages/shared-services/src/dailyReportFactService");
const { PRESETS } = require("../../packages/shared-services/src/reportBlocksService");
const {
  mergeSection,
  SECTION_KEYS,
} = require("../../packages/shared-services/src/dailySectionBuilders");

test("the report preset and stored-day vocabulary share one contract", () => {
  assert.deepEqual(PRESETS.rollup, [...ROLLUP_SECTION_IDS]);
  assert.equal(REPORT_TO_DAILY_SECTION[REPORT_SECTION_IDS.TOPLINE], DAILY_SECTION_KEYS.FINANCIAL);
  assert.equal(REPORT_TO_DAILY_SECTION[REPORT_SECTION_IDS.BY_AGENT], DAILY_SECTION_KEYS.BY_AGENT);
  assert.equal(
    REPORT_TO_DAILY_SECTION[REPORT_SECTION_IDS.LONG_CALLS],
    DAILY_SECTION_KEYS.CALL_HIGHLIGHTS,
    "actionable rows have their own slot and never alias aggregate call facts",
  );
});

test("the model declares every daily section from the same vocabulary", () => {
  for (const key of SECTION_KEYS) {
    assert.ok(DailyReportFact.schema.path(`facts.${key}`), `facts.${key} must be declared`);
    assert.ok(DailyReportFact.schema.path(`detail.${key}`), `detail.${key} must be declared`);
  }
  assert.deepEqual([...SECTION_KEYS].sort(), Object.values(DAILY_SECTION_KEYS).sort());
  assert.equal(CAPTURE_VERSION, 2);
  assert.equal(DailyReportFact.schema.path("captureVersion").defaultValue, 2);
});

test("financial ranges merge the fields the topline block actually emits", () => {
  const merged = mergeSection(DAILY_SECTION_KEYS.FINANCIAL, [
    {
      deals: 2, cash: 150, newCash: 100, recurring: 50,
      spend: 30, mailSpend: 20, ldSpend: 10,
      mailCalls: 4, responses: 3, ldDials: 10,
      ldLeads: 5, ldLeadsBilled: 4, mailPieces: 100,
      mailApplies: true, vendorBoard: false,
    },
    {
      deals: 1, cash: 250, newCash: 200, recurring: 50,
      spend: 60, mailSpend: 40, ldSpend: 20,
      mailCalls: 6, responses: 2, ldDials: 20,
      ldLeads: 7, ldLeadsBilled: 6, mailPieces: 200,
      mailApplies: true, vendorBoard: false,
    },
  ]);

  assert.equal(merged.cash, 400);
  assert.equal(merged.newCash, 300);
  assert.equal(merged.recurring, 100);
  assert.equal(merged.mailCalls, 10);
  assert.equal(merged.ldDials, 30);
  assert.equal(merged.ldLeads, 12);
  assert.equal(merged.mailPieces, 300);
  assert.equal(merged.net, 310);
  assert.equal("dials" in merged, false, "the merger does not invent a second field name");
});

test("source ranges merge real source rows and recompute their ratios", () => {
  const merged = mergeSection(DAILY_SECTION_KEYS.BY_SOURCE, [
    [{ source: "LD", deals: 1, newCash: 100, recurringCash: 50, totalCash: 150, spend: 30, responses: 3, leads: 5 }],
    [{ source: "LD", deals: 2, newCash: 200, recurringCash: 25, totalCash: 225, spend: 60, responses: 2, leads: 7 }],
  ]);
  const ld = merged.find((row) => row.source === "LD");

  assert.equal(ld.deals, 3);
  assert.equal(ld.newCash, 300);
  assert.equal(ld.recurringCash, 75);
  assert.equal(ld.totalCash, 375);
  assert.equal(ld.spend, 90);
  assert.equal(ld.responses, 5);
  assert.equal(ld.leads, 12);
  assert.equal(ld.net, 285);
  assert.equal(ld.costPer, 18);
});

test("agent ranges preserve the block's summary-plus-agents shape", () => {
  const merged = mergeSection(DAILY_SECTION_KEYS.BY_AGENT, [
    {
      cases: 2, attempts: 10, attemptsKnown: 8, attemptsUnknown: 2,
      connected: 4, longCalls: 1, talkMinutes: 20,
      newInventory: 3, newInventoryUntouched: 1, newLeadsTouched: 2,
      newLeadsKnown: true, byOutcome: { review: 8, dnc: 2 },
      agents: [{ agent: "Agent A", dials: 10, connected: 4, talkSec: 1200, talkMinutes: 20, deals: 1, cash: 100 }],
      longThresholdMinutes: 5, worthHearingWithLink: 1,
    },
    {
      cases: 3, attempts: 5, attemptsKnown: 5, attemptsUnknown: 0,
      connected: 1, longCalls: 2, talkMinutes: 5,
      newInventory: 2, newInventoryUntouched: 0, newLeadsTouched: 2,
      newLeadsKnown: true, byOutcome: { review: 5 },
      agents: [{ agent: "Agent A", dials: 5, connected: 1, talkSec: 300, talkMinutes: 5, deals: 2, cash: 200 }],
      longThresholdMinutes: 5, worthHearingWithLink: 2,
    },
  ]);

  assert.equal(merged.attempts, 15);
  assert.equal(merged.connected, 5);
  assert.equal(merged.connectRate, 38.5);
  assert.equal(merged.avgTalkMinutes, 5);
  assert.deepEqual(merged.byOutcome, { review: 13, dnc: 2 });
  assert.equal(merged.agents.length, 1);
  assert.equal(merged.agents[0].dials, 15);
  assert.equal(merged.agents[0].connected, 5);
  assert.equal(merged.agents[0].cash, 300);
});

test("agent attribution sums dollars and never turns a failed day green", () => {
  const attribution = (ok) => ({
    mailApplies: true,
    readable: { mail: true, bcd: true, ld: true },
    mailOffered: 3, mailMissed: 1, bcdOffered: 1, bcdMissed: 0,
    ldLeadsBought: 2,
    spend: { mail: 30, bcd: 10, ld: 20, applicable: 60 },
    unattributed: { mail: 10, bcd: 0, ld: 0, total: 10 },
    unattributedByMissed: { mail: 10, bcd: 0 },
    reconciliation: {
      ok, expected: 60, attributed: 50, unattributed: 10, drift: 0, failures: [],
    },
  });
  const merged = mergeSection(DAILY_SECTION_KEYS.BY_AGENT, [
    { attribution: attribution(true), agents: [] },
    { attribution: attribution(false), agents: [] },
  ]);

  assert.deepEqual(merged.attribution.spend, { mail: 60, bcd: 20, ld: 40, applicable: 120 });
  assert.equal(merged.attribution.mailRate, 10);
  assert.equal(merged.attribution.reconciliation.expected, 120);
  assert.equal(merged.attribution.reconciliation.ok, false);
});

test("a day missing attribution evidence cannot merge into a green range", () => {
  const complete = {
    readable: { mail: true, bcd: true, ld: true },
    spend: { mail: 10, bcd: 0, ld: 5, applicable: 15 },
    reconciliation: { ok: true, expected: 15, attributed: 15, unattributed: 0, failures: [] },
  };
  const merged = mergeSection(DAILY_SECTION_KEYS.BY_AGENT, [
    { attribution: complete, agents: [] },
    { agents: [] },
  ]);
  assert.deepEqual(merged.attribution.readable, { mail: false, bcd: false, ld: false });
  assert.equal(merged.attribution.reconciliation.ok, false);
});

test("status ranges do not discard conversions or uncategorized changes", () => {
  const merged = mergeSection(DAILY_SECTION_KEYS.STATUS, [
    { dnc: 1, postdate: 2, suspended: 3, conversions: 4, other: 5 },
    { dnc: 2, postdate: 3, suspended: 4, conversions: 5, other: 6 },
  ]);
  assert.equal(merged.dnc, 3);
  assert.equal(merged.postdate, 5);
  assert.equal(merged.suspended, 7);
  assert.equal(merged.conversions, 9);
  assert.equal(merged.other, 11);
});

test("call highlights count everything but keep only five longest recordings per agent", () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({
    officer: "Agent A",
    minutes: 10 + index * 5,
    direction: "outbound",
    listenUrl: index === 0 ? null : `https://example.invalid/${index}`,
  }));
  rows.push({ officer: "Agent B", minutes: 31, direction: "inbound", listenUrl: "https://example.invalid/b" });
  const merged = mergeSection(DAILY_SECTION_KEYS.CALL_HIGHLIGHTS, [rows]);

  assert.equal(merged.total, 8);
  assert.equal(merged.over30Minutes, 4);
  assert.equal(merged.withRecording, 7);
  assert.equal(merged.rows.filter((row) => row.officer === "Agent A").length, 5);
  assert.equal(merged.rows.filter((row) => row.officer === "Agent B").length, 1);
  assert.ok(merged.rows.every((row) => row.listenUrl), "the review list must be playable");
});

test("call highlight math rejects non-finite and negative durations", () => {
  const merged = mergeSection(DAILY_SECTION_KEYS.CALL_HIGHLIGHTS, [[
    { officer: "Agent A", minutes: Infinity, listenUrl: "https://example.invalid/a" },
    { officer: "Agent A", minutes: -30, listenUrl: "https://example.invalid/b" },
    { officer: "Agent A", minutes: 35, listenUrl: "https://example.invalid/c" },
  ]]);
  assert.equal(merged.total, 3);
  assert.equal(merged.totalMinutes, 35);
  assert.equal(merged.over30Minutes, 1);
  assert.equal(merged.rows[0].minutes, 35);
});
