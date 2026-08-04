"use strict";

// The snapshot's cost section. A stored day without its denominator cannot
// answer "what did that cost per lead" later, which is the whole reason the
// day is stored.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildDailyReportFact } = require("../../packages/shared-services/src/dailyReportFactService");
// Required directly, not off the barrel — this model is not re-exported there,
// and destructuring it from the barrel yields undefined rather than an error.
const DailyReportFact = require("../../packages/shared-models/src/DailyReportFact");

const reportWith = (spend) => ({
  from: "2026-08-03",
  to: "2026-08-03",
  selection: ["topline", "source", "ldcalls", "status", "longcalls"],
  sections: [
    { id: "topline", data: { cash: 1000 } },
    { id: "source", data: [] },
    { id: "ldcalls", data: [] },
    { id: "status", data: {} },
    { id: "longcalls", data: [] },
  ],
  failures: [],
  spend,
});

test("the snapshot stores all costs by source", () => {
  const fact = buildDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: "financial roll up with calls",
    report: reportWith({
      total: 471, ld: 423, ldLeads: 141, mail: 0, mailPieces: 0, bcd: 48, bcdCalls: 12, bcdRate: 4,
    }),
  });
  assert.equal(fact.facts.spend.total, 471);
  assert.equal(fact.facts.spend.ldLeads, 141, "the lead count rides with the money");
  assert.equal(fact.facts.spend.bcdCalls, 12);
});

test("a missing spend material stores null, never a zero-cost day", () => {
  const fact = buildDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: "financial roll up with calls",
    report: reportWith(undefined),
  });
  assert.equal(fact.facts.spend, null, "unknown cost must not render as $0");
});

test("facts.spend is declared on the schema, or the write is silently dropped", () => {
  // Mongoose strict mode discards undeclared paths without erroring, so an
  // undeclared facts.spend would look like a clean save and store nothing.
  const path = DailyReportFact.schema.path("facts.spend");
  assert.ok(path, "facts.spend must exist on the schema");
});

test("capturing spend does NOT add a section to the email", () => {
  // The spend BLOCK is not in the rollup preset. Reaching the number by adding
  // it there would have changed what the nightly email renders.
  const fact = buildDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: "financial roll up with calls",
    report: reportWith({ total: 100, ld: 100, ldLeads: 33, mail: 0, mailPieces: 0, bcd: 0, bcdCalls: 0 }),
  });
  assert.ok(!fact.selection.includes("spend"),
    "spend must not appear in the rendered selection");
  assert.equal(fact.facts.spend.total, 100, "but it is still stored");
});
