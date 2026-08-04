"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const DailyReportFact = require("../../packages/shared-models/src/DailyReportFact");
const service = require("../../packages/shared-services/src/dailyReportFactService");
const { captureDeliveredDailyFact } = require("../../packages/shared-services/src/reportDefinitionService");

const report = (overrides = {}) => ({
  from: "2026-08-03",
  to: "2026-08-03",
  domain: "ALL",
  selection: [...service.REQUIRED_SECTIONS],
  failures: [],
  sections: [
    {
      id: "topline",
      data: { deals: 3, cash: 2500, spend: 400, roi: 6.25, caseId: 123 },
    },
    { id: "source", data: { rows: [{ source: "LD", spend: 300, deals: 2, cases: [1, 2] }] } },
    {
      id: "ldcalls",
      data: {
        cases: 14,
        rows: [{ agent: "Chris Bolt", dials: 20, phone: "redacted" }],
        worthHearing: [{ caseId: 99, minutes: 20, listenUrl: "https://example.invalid/drop" }],
      },
    },
    { id: "status", data: { dnc: 2, postdate: 1, keyChanges: [{ caseId: 1 }] } },
    { id: "longcalls", data: [{ minutes: 15, phone: "redacted", listenUrl: "https://example.invalid/a" }] },
  ],
  ...overrides,
});

const definition = (overrides = {}) => ({
  name: "financial roll up with calls",
  sendEmail: true,
  domain: null,
  filters: [],
  ...overrides,
});

test("only the canonical unfiltered one-day rollup captures a daily fact", () => {
  assert.equal(service.isDailyFactCaptureCandidate(
    definition(), report(), { from: "2026-08-03", to: "2026-08-03" },
  ).capture, true);
  assert.equal(service.isDailyFactCaptureCandidate(
    definition({ name: "vendor roll up with calls" }), report(),
    { from: "2026-08-03", to: "2026-08-03" },
  ).reason, "not-canonical-definition");
  assert.equal(service.isDailyFactCaptureCandidate(
    definition({ domain: "WYNN" }), report(), { from: "2026-08-03", to: "2026-08-03" },
  ).reason, "tenant-scoped");
  assert.equal(service.isDailyFactCaptureCandidate(
    definition({ filters: ["source=LD"] }), report(), { from: "2026-08-03", to: "2026-08-03" },
  ).reason, "filtered");
  assert.equal(service.isDailyFactCaptureCandidate(
    definition(), report(), { from: "2026-08-01", to: "2026-08-03" },
  ).reason, "not-one-day");
});

test("one combined day stores all non-call sections and reserves Claude's call slot", () => {
  const fact = service.buildDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: "financial roll up with calls",
    report: report(),
    emailAcceptedAt: new Date("2026-08-04T03:01:00.000Z"),
  });
  assert.equal(fact.dateKey, "2026-08-03");
  assert.equal(fact.facts.financial.cash, 2500);
  assert.equal(fact.facts.bySource.rows[0].spend, 300);
  assert.equal(fact.facts.byAgent.rows[0].agent, "Chris Bolt");
  assert.equal(fact.facts.byAgent.cases, 14);
  assert.equal("worthHearing" in fact.facts.byAgent, false);
  assert.equal(fact.facts.statusMovement.dnc, 2);
  assert.deepEqual(fact.facts.calls, { status: "pending", rowsObservedInEmail: 1 });
  assert.equal(fact.coverage.coreComplete, true);
  assert.equal(fact.coverage.complete, false, "the day stays explicit until Claude attaches call facts");

  const encoded = JSON.stringify(fact);
  assert.doesNotMatch(encoded, /redacted|example\.invalid/);
  assert.equal("caseId" in fact.facts.financial, false);
  assert.equal("roi" in fact.facts.financial, false, "range reports must recompute ratios");
  assert.equal("keyChanges" in fact.facts.statusMovement, false);
});

test("daily facts discard unfamiliar locator and provider/customer identity aliases", () => {
  const fact = service.buildDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: service.CANONICAL_DEFINITION_NAME,
    report: report({
      sections: [
        { id: "topline", data: { deals: 1, hiddenCapability: "https://example.invalid/private" } },
        { id: "source", data: { rows: [{ source: "LD", spend: 3 }] } },
        {
          id: "ldcalls",
          data: {
            rows: [{
              agent: "Chris Bolt",
              dials: 1,
              providerCallId: "provider-call-secret",
              sessionId: "provider-session-secret",
              customerName: "Customer Secret",
              sourceUri: "http://example.invalid/audio",
              unexpectedEmailField: "customer@example.invalid",
            }],
          },
        },
        { id: "status", data: { dnc: 0 } },
        { id: "longcalls", data: [] },
      ],
    }),
  });

  const encoded = JSON.stringify(fact);
  assert.doesNotMatch(encoded, /example\.invalid|provider-call-secret|provider-session-secret|Customer Secret/);
  assert.equal(fact.facts.byAgent.rows[0].agent, "Chris Bolt");
  assert.equal(fact.facts.byAgent.rows[0].dials, 1);
});

test("source failures persist an incomplete day instead of a confident zero", () => {
  const fact = service.buildDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: "financial roll up with calls",
    report: report({ failures: ["queue unavailable"] }),
  });
  assert.equal(fact.coverage.coreComplete, false);
  assert.equal(fact.coverage.reportDegraded, true);
  assert.deepEqual(fact.coverage.sectionErrors, ["source-failures:1"]);
});

test("persistence is one upsert per day and increments its revision", async () => {
  let write = null;
  const Model = { updateOne: async (...args) => { write = args; return { acknowledged: true }; } };
  const result = await service.persistDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: "financial roll up with calls",
    report: report(),
  }, { Model });
  assert.equal(result.status, "captured");
  assert.deepEqual(write[0], { dateKey: "2026-08-03" });
  assert.equal(write[1].$inc.revision, 1);
  assert.equal(write[2].upsert, true);
});

test("the collection enforces exactly one document per dateKey", () => {
  assert.equal(DailyReportFact.schema.path("dateKey").options.unique, true);
});

test("Claude can attach aggregate call facts without creating another daily document", async () => {
  let update = null;
  const Model = {
    findOne: () => ({
      select: () => ({
        lean: async () => ({ dateKey: "2026-08-03", coverage: { coreComplete: true } }),
      }),
    }),
    updateOne: async (...args) => { update = args; return { acknowledged: true }; },
  };
  const result = await service.attachDailyCallFacts({
    dateKey: "2026-08-03",
    callFacts: { total: 12, long: 3, recordingUrl: "https://example.invalid/drop" },
  }, { Model });
  assert.equal(result.complete, true);
  assert.deepEqual(update[0], { dateKey: "2026-08-03" });
  assert.deepEqual(update[1].$set["facts.calls"], { total: 12, long: 3 });
  assert.equal(update[1].$set["coverage.complete"], true);
});

test("range reads return ordered daily inputs and refuse to hide missing or pending days", async () => {
  const Model = {
    find: () => ({
      sort: () => ({
        lean: async () => [
          { dateKey: "2026-08-01", coverage: { complete: true, callProjection: "complete" } },
          { dateKey: "2026-08-03", coverage: { complete: false, callProjection: "pending" } },
        ],
      }),
    }),
  };
  const result = await service.readDailyReportFactRange({
    from: "2026-08-01", to: "2026-08-03",
  }, { Model });
  assert.deepEqual(result.days.map((day) => day.dateKey), ["2026-08-01", "2026-08-03"]);
  assert.deepEqual(result.coverage.missing, ["2026-08-02"]);
  assert.deepEqual(result.coverage.incomplete, ["2026-08-03"]);
  assert.deepEqual(result.coverage.callsPending, ["2026-08-03"]);
  assert.equal(result.coverage.complete, false);
});

test("the delivered-email hook passes the already-built report to one writer", async () => {
  let input = null;
  const built = report();
  const result = await captureDeliveredDailyFact({
    def: definition(),
    report: built,
    range: { from: "2026-08-03", to: "2026-08-03" },
    emailAcceptedAt: new Date("2026-08-04T03:01:00.000Z"),
    writer: async (value) => { input = value; return { status: "captured" }; },
  });
  assert.equal(result.status, "captured");
  assert.equal(input.report, built, "the writer receives the exact report object already emailed");
  assert.equal(input.dateKey, "2026-08-03");
});

test("the fact hook occurs after mail acceptance and never re-gathers", () => {
  const src = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/reportDefinitionService"), "utf8",
  );
  const send = src.indexOf("await sendMail(def.domain || null");
  const capture = src.indexOf("result.dailyFactCapture = await captureDeliveredDailyFact", send);
  assert.ok(send >= 0 && capture > send, "daily capture must occur after provider acceptance");
  const between = src.slice(send, capture);
  assert.ok(!between.includes("composeReport("), "capture must reuse the report, never gather again");
});
