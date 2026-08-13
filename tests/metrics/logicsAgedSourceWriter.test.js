"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AGED_CASE_REFS } = require("../../packages/shared-config/src/activeSources");
const {
  AGED_SOURCE_IDS,
  agedRefsFromReport,
  eligibleReport,
  sourceIdForLabel,
  syncAgedLogicsSourcesFromReport,
} = require("../../packages/shared-services/src/logicsAgedSourceWriterService");

const definition = (over = {}) => ({
  name: "financial",
  domain: null,
  filters: [],
  ...over,
});

function reportWith(refs, over = {}) {
  const rows = [{ source: "Aged / inactive source", deals: refs.length }];
  Object.defineProperty(rows, AGED_CASE_REFS, { value: refs, enumerable: false });
  return {
    source: "live",
    sections: [{ id: "source", data: rows }],
    ...over,
  };
}

test("TAG Aged Data uses the independently confirmed tenant source id", () => {
  assert.equal(AGED_SOURCE_IDS.TAG, 72);
  assert.equal(AGED_SOURCE_IDS.WYNN, undefined, "tenant-local ids must never be guessed");
  assert.equal(sourceIdForLabel("TAG", "BCD"), 64);
  assert.equal(sourceIdForLabel("TAG", "Urgent Third State"), 73);
  assert.equal(sourceIdForLabel("TAG", "unknown source"), null);
});

test("only the canonical live one-day report may write Aged", () => {
  const range = { from: "2026-08-10", to: "2026-08-10" };
  assert.equal(eligibleReport({ def: definition(), range, report: reportWith([]) }).eligible, true);
  assert.equal(eligibleReport({ def: definition({ domain: "TAG" }), range, report: reportWith([]) }).eligible, false);
  assert.equal(eligibleReport({ def: definition(), range, report: reportWith([], { source: "record" }) }).eligible, false);
  assert.equal(eligibleReport({ def: definition(), range: { from: "2026-08-09", to: "2026-08-10" }, report: reportWith([]) }).eligible, false);
});

test("private Aged refs dedupe and never depend on rendered rows", () => {
  const report = reportWith([
    { domain: "tag", caseId: 1, expectedSource: "BCD" },
    { domain: "TAG", caseId: 1, expectedSource: "BCD" },
  ]);
  assert.deepEqual(agedRefsFromReport(report), [
    { domain: "TAG", caseId: 1, expectedSource: "BCD", expectedSourceId: null },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /caseId|expectedSource/);
});

test("a current BCD case classified Aged is written to TAG Aged Data", async () => {
  const prior = process.env.LOGICS_SOURCE_WRITER_ENABLED;
  process.env.LOGICS_SOURCE_WRITER_ENABLED = "true";
  const writes = [];
  try {
    const result = await syncAgedLogicsSourcesFromReport({
      def: definition(),
      range: { from: "2026-08-10", to: "2026-08-10" },
      report: reportWith([{ domain: "TAG", caseId: 10, expectedSource: "BCD" }]),
      clientFactory: () => ({ getCaseInfo: async () => ({ Data: { SourceCampaignID: 64 } }) }),
      writer: async (input) => { writes.push(input); return { written: true }; },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.written, 1);
    assert.equal(result.failed, 0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].sourceId, 72);
    assert.equal(writes[0].sourceName, "Aged Data");
    assert.equal(writes[0].sourceChannel, "aged");
  } finally {
    if (prior === undefined) delete process.env.LOGICS_SOURCE_WRITER_ENABLED;
    else process.env.LOGICS_SOURCE_WRITER_ENABLED = prior;
  }
});

test("a source changed after the report is never overwritten", async () => {
  const prior = process.env.LOGICS_SOURCE_WRITER_ENABLED;
  process.env.LOGICS_SOURCE_WRITER_ENABLED = "true";
  let writes = 0;
  try {
    const result = await syncAgedLogicsSourcesFromReport({
      def: definition(),
      range: { from: "2026-08-10", to: "2026-08-10" },
      report: reportWith([{ domain: "TAG", caseId: 11, expectedSource: "BCD" }]),
      clientFactory: () => ({ getCaseInfo: async () => ({ Data: { SourceCampaignID: 73 } }) }),
      writer: async () => { writes += 1; return { written: true }; },
    });
    assert.equal(result.sourceChanged, 1);
    assert.equal(result.written, 0);
    assert.equal(writes, 0);
  } finally {
    if (prior === undefined) delete process.env.LOGICS_SOURCE_WRITER_ENABLED;
    else process.env.LOGICS_SOURCE_WRITER_ENABLED = prior;
  }
});

test("the live source id lets an old unregistered piece age without guessing", async () => {
  const prior = process.env.LOGICS_SOURCE_WRITER_ENABLED;
  process.env.LOGICS_SOURCE_WRITER_ENABLED = "true";
  let writes = 0;
  try {
    const result = await syncAgedLogicsSourcesFromReport({
      def: definition(),
      range: { from: "2026-08-10", to: "2026-08-10" },
      report: reportWith([{
        domain: "TAG",
        caseId: 14,
        expectedSource: "Retired Historical Piece",
        expectedSourceId: 88,
      }]),
      clientFactory: () => ({ getCaseInfo: async () => ({ Data: { SourceCampaignID: 88 } }) }),
      writer: async () => { writes += 1; return { written: true }; },
    });
    assert.equal(result.written, 1);
    assert.equal(result.unverifiableSource, 0);
    assert.equal(writes, 1);
  } finally {
    if (prior === undefined) delete process.env.LOGICS_SOURCE_WRITER_ENABLED;
    else process.env.LOGICS_SOURCE_WRITER_ENABLED = prior;
  }
});

test("WYNN and an unrecognized current source fail closed", async () => {
  const prior = process.env.LOGICS_SOURCE_WRITER_ENABLED;
  process.env.LOGICS_SOURCE_WRITER_ENABLED = "true";
  try {
    const result = await syncAgedLogicsSourcesFromReport({
      def: definition(),
      range: { from: "2026-08-10", to: "2026-08-10" },
      report: reportWith([
        { domain: "WYNN", caseId: 12, expectedSource: "BCD" },
        { domain: "TAG", caseId: 13, expectedSource: "Retired Mystery Piece" },
      ]),
      clientFactory: () => { throw new Error("must not read an unsupported candidate"); },
      writer: async () => { throw new Error("must not write"); },
    });
    assert.equal(result.unsupportedTenant, 1);
    assert.equal(result.unverifiableSource, 1);
    assert.equal(result.written, 0);
  } finally {
    if (prior === undefined) delete process.env.LOGICS_SOURCE_WRITER_ENABLED;
    else process.env.LOGICS_SOURCE_WRITER_ENABLED = prior;
  }
});

test("Aged writes stop at their nightly time budget", async () => {
  const prior = process.env.LOGICS_SOURCE_WRITER_ENABLED;
  process.env.LOGICS_SOURCE_WRITER_ENABLED = "true";
  let now = 0;
  let reads = 0;
  try {
    const result = await syncAgedLogicsSourcesFromReport({
      def: definition(),
      range: { from: "2026-08-10", to: "2026-08-10" },
      report: reportWith([
        { domain: "TAG", caseId: 21, expectedSource: "BCD" },
        { domain: "TAG", caseId: 22, expectedSource: "BCD" },
      ]),
      maxRunMs: 1000,
      clock: () => now,
      clientFactory: () => ({ getCaseInfo: async () => {
        reads += 1;
        now = 1000;
        return { Data: { SourceCampaignID: 64 } };
      } }),
      writer: async () => ({ written: true }),
    });
    assert.equal(reads, 1);
    assert.equal(result.written, 1);
    assert.equal(result.deferred, 1);
    assert.equal(result.status, "partial");
  } finally {
    if (prior == null) delete process.env.LOGICS_SOURCE_WRITER_ENABLED;
    else process.env.LOGICS_SOURCE_WRITER_ENABLED = prior;
  }
});
