"use strict";

// 1 to infinity. A day is one record, a week is seven, a year is 365 — and the
// caller gets the same shape from all three because every section's merge lives
// beside its builder.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { mergeSection, SECTION_KEYS } = require("../../packages/shared-services/src/dailySectionBuilders");
const { readEntryRange, dayKeysBetween } = require("../../packages/shared-services/src/dailyEntryService");

const modelOf = (days) => ({
  find: (q) => ({
    select: () => ({
      sort: () => ({
        lean: async () => Object.entries(days)
          .filter(([d]) => q.dateKey.$in.includes(d))
          .map(([dateKey, facts]) => ({ dateKey, facts })),
      }),
    }),
  }),
});

test("RATIOS ARE RECOMPUTED FROM SUMMED PARTS, never averaged", async () => {
  // The mistake this exists to prevent: a month whose ROI is the mean of thirty
  // daily ROIs weights a $40 day the same as a $4,000 one.
  const merged = mergeSection("financial", [
    { cash: 100, spend: 100 },     // a 1.0x day
    { cash: 9000, spend: 1000 },   // a 9.0x day
  ]);
  assert.equal(merged.cash, 9100);
  assert.equal(merged.spend, 1100);
  assert.equal(merged.net, 8000);
  // Mean of the daily ratios would be 5.0. The truth is 9100/1100 = 8.27.
  assert.equal(merged.roi, 8.27);
});

test("spend totals are recomputed from parts, not summed from stored totals", async () => {
  // Summing stored totals double-counts the moment one day's total disagrees
  // with its own components — which a frozen mail figure can cause.
  const merged = mergeSection("spend", [
    { total: 999999, mail: 100, ld: 30, bcd: 4 },
    { total: 999999, mail: 200, ld: 60, bcd: 8 },
  ]);
  assert.equal(merged.mail, 300);
  assert.equal(merged.ld, 90);
  assert.equal(merged.total, 402, "recomputed, ignoring the nonsense totals");
});

test("the longest call in a range is the longest single call, not a sum", () => {
  const merged = mergeSection("calls", [
    { links: 10, longestSec: 300, totalTalkSec: 1000, byProvider: { callrail: 10 } },
    { links: 5, longestSec: 3750, totalTalkSec: 500, byProvider: { phoneburner: 5 } },
  ]);
  assert.equal(merged.links, 15);
  assert.equal(merged.longestSec, 3750);
  assert.equal(merged.totalTalkSec, 1500);
  assert.deepEqual(merged.byProvider, { callrail: 10, phoneburner: 5 });
});

test("a day that lacks a section contributes NOTHING, not a zero", () => {
  // Averaging or zero-filling an absent day silently reports a quiet day.
  const merged = mergeSection("activity", [{ rowsScanned: 100 }, null, { rowsScanned: 50 }]);
  assert.equal(merged.rowsScanned, 150);
  // And when NO day had it at all, the answer is null — not an empty shell that
  // reads like a real zero.
  assert.equal(mergeSection("activity", [null, null]), null);
});

test("rows merge by identity, summing numbers and keeping names", () => {
  const merged = mergeSection("bySource", [
    [{ source: "LD Custom", cash: 100, deals: 1 }, { source: "BCD", cash: 50, deals: 1 }],
    [{ source: "LD Custom", cash: 200, deals: 2 }],
  ]);
  const ld = merged.find((r) => r.source === "LD Custom");
  assert.equal(ld.cash, 300);
  assert.equal(ld.deals, 3);
  assert.equal(merged.length, 2, "BCD survives as its own row");
});

test("one record and many records return the same shape", async () => {
  const days = {
    "2026-08-03": { spend: { mail: 100, ld: 30, bcd: 4 }, calls: { links: 10 } },
    "2026-08-04": { spend: { mail: 200, ld: 60, bcd: 8 }, calls: { links: 5 } },
  };
  const one = await readEntryRange({ from: "2026-08-03", to: "2026-08-03", Model: modelOf(days) });
  const two = await readEntryRange({ from: "2026-08-03", to: "2026-08-04", Model: modelOf(days) });
  assert.deepEqual(Object.keys(one.sections), Object.keys(two.sections));
  assert.deepEqual(Object.keys(one.sections), [...SECTION_KEYS]);
  assert.equal(one.sections.spend.total, 134);
  assert.equal(two.sections.spend.total, 402);
});

test("a missing day is REPORTED, never folded in as zero", async () => {
  const days = { "2026-08-03": { calls: { links: 10 } } };
  const r = await readEntryRange({ from: "2026-08-03", to: "2026-08-05", Model: modelOf(days) });
  assert.deepEqual(r.missingDays, ["2026-08-04", "2026-08-05"]);
  assert.equal(r.coverage.daysRequested, 3);
  assert.equal(r.coverage.daysStored, 1);
  assert.equal(r.coverage.complete, false);
  assert.equal(r.sections.calls.links, 10, "the day we have still counts");
});

test("a reversed range refuses rather than reporting complete", async () => {
  // The fact reader shipped this bug once: {} and reversed ranges returned
  // complete:true.
  const r = await readEntryRange({ from: "2026-08-05", to: "2026-08-03", Model: modelOf({}) });
  assert.equal(r.coverage.complete, false);
  assert.equal(r.coverage.reason, "degenerate-range");
  assert.deepEqual(r.days, []);
});

test("the detail view is opt-in; facts is the default a range reads", async () => {
  await assert.rejects(
    () => readEntryRange({ from: "2026-08-03", view: "everything", Model: modelOf({}) }),
    /view must be/,
  );
  assert.equal(dayKeysBetween("2026-08-03", "2026-08-05").length, 3);
});

test("counts sum across a range, but the redline LIST is flagged unconfirmed", async () => {
  // Mickey 2026-08-05: "you can aggregate certain facts, but need to run
  // activities over the range to confirm certain things that may have been
  // cleaned up." The event (went DNC on the 3rd) is durable; the implication
  // (is a chase today) is current state, which this system never serves stored.
  const days = {
    "2026-08-03": {
      statusMovement: { dnc: 3, suspended: 4, keyChanges: [{ domain: "TAG", caseId: 1, lane: "dnc" }] },
    },
    "2026-08-04": {
      statusMovement: { dnc: 2, suspended: 1, keyChanges: [{ domain: "TAG", caseId: 2, lane: "dnc" }] },
    },
  };
  const range = await readEntryRange({ from: "2026-08-03", to: "2026-08-04", view: "detail", Model: {
    find: (q) => ({ select: () => ({ sort: () => ({ lean: async () => Object.entries(days)
      .filter(([d]) => q.dateKey.$in.includes(d))
      .map(([dateKey, detail]) => ({ dateKey, detail })) }) }) }),
  } });

  assert.equal(range.sections.statusMovement.dnc, 5, "counts sum — those events happened");
  assert.equal(range.sections.statusMovement.keyChanges.length, 2);
  assert.deepEqual(range.unconfirmed, [{ section: "statusMovement", fields: ["keyChanges"], days: 2 }],
    "the list is reported as a claim about now, not silently shown as work");
});

test("a SINGLE day needs no confirmation — the snapshot and now are the same", async () => {
  const days = {
    "2026-08-03": { statusMovement: { dnc: 3, keyChanges: [{ domain: "TAG", caseId: 1, lane: "dnc" }] } },
  };
  const range = await readEntryRange({ from: "2026-08-03", to: "2026-08-03", view: "detail", Model: {
    find: (q) => ({ select: () => ({ sort: () => ({ lean: async () => Object.entries(days)
      .filter(([d]) => q.dateKey.$in.includes(d))
      .map(([dateKey, detail]) => ({ dateKey, detail })) }) }) }),
  } });
  assert.deepEqual(range.unconfirmed, [], "one day's snapshot IS that day's state");
});

test("one case in two lanes is two chases, not one", async () => {
  const merged = mergeSection("statusMovement", [
    { dnc: 1, keyChanges: [{ domain: "TAG", caseId: 500, lane: "dnc" }] },
    { suspended: 1, keyChanges: [{ domain: "TAG", caseId: 500, lane: "suspended" }] },
  ]);
  assert.equal(merged.keyChanges.length, 2, "same case, different lanes — both need chasing");
});

test("the same case flipping the same lane twice is ONE chase", async () => {
  const merged = mergeSection("statusMovement", [
    { dnc: 1, keyChanges: [{ domain: "TAG", caseId: 500, lane: "dnc" }] },
    { dnc: 1, keyChanges: [{ domain: "TAG", caseId: 500, lane: "dnc" }] },
  ]);
  assert.equal(merged.dnc, 2, "two events happened");
  assert.equal(merged.keyChanges.length, 1, "but there is one case to call");
});
