"use strict";

// Compact case lists. Mickey 2026-08-05: "instead of one row per thing it's a
// list sorted by database ... so instead of a thing that's 50 lines long you can
// fit maybe 10 keys per row."

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  groupCaseIds, formatCaseList, formatCaseListInline,
} = require("../../packages/shared-services/src/caseListFormatter");
const { BLOCKS } = require("../../packages/shared-services/src/reportBlocksService");

const statusBlock = BLOCKS.find((b) => b.id === "status");

test("a case that flipped twice in a range is ONE case to chase", () => {
  // Printing it twice implies two cases and two calls.
  const grouped = groupCaseIds([
    { domain: "TAG", caseId: 1234 },
    { domain: "TAG", caseId: 1234 },
    { domain: "TAG", caseId: 5678 },
  ]);
  assert.deepEqual(grouped.TAG, ["1234", "5678"]);
});

test("ids sort numerically — 1000 after 999, not before it", () => {
  const grouped = groupCaseIds([
    { domain: "TAG", caseId: 1000 }, { domain: "TAG", caseId: 999 },
  ]);
  assert.deepEqual(grouped.TAG, ["999", "1000"]);
});

test("databases appear in reporting order, not alphabetical", () => {
  const grouped = groupCaseIds([
    { domain: "AMITY", caseId: 1 }, { domain: "WYNN", caseId: 2 }, { domain: "TAG", caseId: 3 },
  ]);
  assert.deepEqual(Object.keys(grouped), ["TAG", "WYNN", "AMITY"]);
});

test("a capped list SAYS what it did not print", () => {
  // A board showing the first 10 of 300 without saying so reads as the whole
  // answer, which is worse than showing none.
  const rows = Array.from({ length: 25 }, (_, i) => ({ domain: "TAG", caseId: 1000 + i }));
  const lines = formatCaseList(rows, { label: "Redlines", maxPerDomain: 10 });
  assert.match(lines.join("\n"), /and 15 more not shown/);
  // And the header still states the TRUE total, not the shown count.
  assert.match(lines[0], /Redlines \(25\)/);
});

test("nothing to show renders nothing at all", () => {
  assert.deepEqual(formatCaseList([], { label: "Redlines" }), []);
  assert.equal(formatCaseListInline([]), "");
});

test("the status block packs a month of redlines into a handful of rows", () => {
  const keyChanges = [];
  for (let i = 0; i < 23; i++) keyChanges.push({ domain: "TAG", caseId: 100000 + i, lane: "suspended" });
  for (let i = 0; i < 11; i++) keyChanges.push({ domain: "WYNN", caseId: 200000 + i, lane: "suspended" });
  for (let i = 0; i < 9; i++) keyChanges.push({ domain: "TAG", caseId: 400000 + i, lane: "dnc" });

  const out = statusBlock.csv({ dnc: 9, postdate: 0, suspended: 34, keyChanges });
  // Old layout: one case per cell, as deep as the busiest lane — 34 rows.
  assert.ok(out.emailRows.length <= 8, `expected a handful of rows, got ${out.emailRows.length}`);
  assert.ok(out.emailRows.every((r) => r.cases.split(", ").length <= 10), "at most ten per row");

  // The lane and database label the FIRST row of their run only.
  const suspendedTag = out.emailRows.filter((r) => r.cases.startsWith("100"));
  assert.equal(suspendedTag[0].lane, "SUSPENDED");
  assert.equal(suspendedTag[0].db, "tag");
  assert.equal(suspendedTag[1].lane, "", "a continuation repeats neither label");
  assert.equal(suspendedTag[1].db, "");
});

test("the CSV keeps one row per case — compaction is for the EMAIL only", () => {
  // The email is a board somebody reads; the CSV is data somebody filters.
  const keyChanges = [
    { domain: "TAG", caseId: 1, lane: "dnc" },
    { domain: "TAG", caseId: 2, lane: "dnc" },
  ];
  const out = statusBlock.csv({ dnc: 2, postdate: 0, suspended: 0, keyChanges });
  assert.equal(out.rows.length, 2, "the CSV stays per-case");
  assert.ok(out.columns.some((c) => c.header === "case"));
});
