"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const DailyReportFact = require("../../packages/shared-models/src/DailyReportFact");
const service = require("../../packages/shared-services/src/dailyReportFactService");
const { captureDeliveredDailyFact } = require("../../packages/shared-services/src/reportDefinitionService");
const { AGED_LABEL } = require("../../packages/shared-config/src/activeSources");

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
  name: "financial",
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
    definition({ name: "vendor" }), report(),
    { from: "2026-08-03", to: "2026-08-03" },
  ).reason, "not-canonical-definition");
  assert.equal(service.isDailyFactCaptureCandidate(
    definition({ name: "financial stored verification", renderSource: "record" }), report(),
    { from: "2026-08-03", to: "2026-08-03" },
  ).reason, "not-canonical-definition",
  "the parity shadow reads the canonical snapshot and must never write a second one");
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

test("one combined day is report-complete while reserving the aggregate call slot", () => {
  const fact = service.buildDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: "financial",
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
  assert.equal(fact.facts.calls, null,
    "optional aggregate counts stay empty instead of leaving unfinished work");
  assert.equal(fact.coverage.coreComplete, true);
  assert.equal(fact.coverage.reportComplete, true);
  assert.equal(fact.coverage.complete, true,
    "a clean long-call section completes the report without waiting on auxiliary aggregate counts");

  const encoded = JSON.stringify(fact);
  assert.doesNotMatch(encoded, /redacted|example\.invalid/);
  assert.equal("caseId" in fact.facts.financial, false);
  assert.equal("roi" in fact.facts.financial, false, "range reports must recompute ratios");
  assert.equal("keyChanges" in fact.facts.statusMovement, false);
});

test("the daily fact preserves Aged as a named source row", () => {
  const sections = report().sections.map((section) => (
    section.id === "source"
      ? {
        ...section,
        data: {
          rows: [
            { source: "LD", deals: 2, newCash: 2000, totalCash: 2000, spend: 300 },
            {
              source: AGED_LABEL,
              deals: 1,
              newCash: 500,
              recurringCash: 100,
              totalCash: 600,
              spend: 0,
              roas: null,
              roi: null,
            },
          ],
        },
      }
      : section
  ));
  const fact = service.buildDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: service.CANONICAL_DEFINITION_NAME,
    report: report({ sections }),
  });
  const aged = fact.facts.bySource.rows.find((row) => row.source === AGED_LABEL);
  assert.deepEqual(aged, {
    source: AGED_LABEL,
    deals: 1,
    newCash: 500,
    recurringCash: 100,
    totalCash: 600,
    spend: 0,
  });
  assert.equal("roas" in aged, false, "daily facts store inputs, not rendered ratios");
  assert.equal("roi" in aged, false, "daily facts store inputs, not rendered ratios");
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
    definitionName: "financial",
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
    definitionName: "financial",
    report: report(),
  }, { Model });
  assert.equal(result.status, "captured");
  assert.deepEqual(write[0], { dateKey: "2026-08-03" });
  assert.equal(write[1].$inc.revision, 1);
  assert.equal(write[2].upsert, true);
});

test("a snapshot rerun preserves closed mail spend but refreshes event-backed spend", async () => {
  let write = null;
  const originalSpendCapture = new Date("2026-08-04T03:00:00.000Z");
  const Model = {
    findOne: () => ({
      select: () => ({
        lean: async () => ({
          facts: { spend: { mail: 100, mailPieces: 50, ld: 20, bcd: 5, total: 125 } },
          detail: { spend: { mail: 100, mailPieces: 50, ld: 20, bcd: 5, total: 125 } },
          spendCapturedAt: originalSpendCapture,
        }),
      }),
    }),
    updateOne: async (...args) => { write = args; return { acknowledged: true }; },
  };
  const fact = service.buildDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: service.CANONICAL_DEFINITION_NAME,
    report: report({ spend: { mail: 999, mailPieces: 999, ld: 30, bcd: 7, total: 1036 } }),
    dailyEntry: {
      errors: [],
      facts: { spend: { mail: 999, mailPieces: 999, ld: 30, bcd: 7, total: 1036 } },
      detail: { spend: { mail: 999, mailPieces: 999, ld: 30, bcd: 7, total: 1036 } },
    },
  });

  await service.persistBuiltDailyReportFact(fact, { Model });
  const factsSpend = write[1].$set["facts.spend"];
  assert.deepEqual(factsSpend, {
    mail: 100, mailPieces: 50, ld: 30, bcd: 7, total: 137,
  });
  assert.deepEqual(write[1].$set["detail.spend"], factsSpend,
    "the complete and additive views must agree about the frozen day");
  assert.equal(write[1].$set.spendCapturedAt.getTime(), originalSpendCapture.getTime(),
    "an unrelated rerun must not claim frozen spend was refreshed");
});

test("a late-document repair may deliberately replace the frozen spend section", async () => {
  let write = null;
  let readExisting = false;
  const Model = {
    findOne: () => ({
      select: () => ({
        lean: async () => {
          readExisting = true;
          return { facts: { spend: { mail: 100, mailPieces: 50, ld: 20, bcd: 5, total: 125 } } };
        },
      }),
    }),
    updateOne: async (...args) => { write = args; return { acknowledged: true }; },
  };
  const fact = service.buildDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: service.CANONICAL_DEFINITION_NAME,
    report: report({ spend: { mail: 999, mailPieces: 400, ld: 30, bcd: 7, total: 1036 } }),
    dailyEntry: {
      errors: [],
      facts: { spend: { mail: 999, mailPieces: 400, ld: 30, bcd: 7, total: 1036 } },
      detail: { spend: { mail: 999, mailPieces: 400, ld: 30, bcd: 7, total: 1036 } },
    },
  });

  await service.persistBuiltDailyReportFact(fact, { Model, overwriteFrozen: ["spend"] });
  assert.equal(readExisting, false, "an explicit repair must not merge the stale frozen value back in");
  assert.deepEqual(write[1].$set["facts.spend"], {
    mail: 999, mailPieces: 400, ld: 30, bcd: 7, total: 1036,
  });
  assert.deepEqual(write[1].$set["detail.spend"], write[1].$set["facts.spend"]);
  assert.ok(write[1].$set.spendCapturedAt instanceof Date,
    "a deliberate late repair advances the spend-specific freshness marker");
});

test("the nightly write touches facts.<key>, never the whole facts object", async () => {
  // $set: { facts: {...} } REPLACES the subdocument in Mongo. That is fine while
  // this is the only writer and destructive the moment anything else contributes a
  // section — facts.activity comes from the activity review and from nowhere here.
  let write = null;
  const Model = { updateOne: async (...args) => { write = args; return { acknowledged: true }; } };
  await service.persistDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: "financial",
    report: report(),
  }, { Model });

  const $set = write[1].$set;
  assert.equal("facts" in $set, false, "must not write the whole facts object");
  for (const key of ["financial", "spend", "bySource", "byAgent", "statusMovement"]) {
    assert.ok(`facts.${key}` in $set, `expected a dotted path for facts.${key}`);
  }
  // Sections this path does not own are left alone rather than nulled or stamped:
  // `activity` comes from the activity review, and `calls` only when this path is
  // actually handed call facts — see the placeholder test below.
  assert.equal("facts.activity" in $set, false);
  assert.equal("facts.calls" in $set, false);
});

test("an ungatherable section writes an explicit null rather than leaving a stale value", async () => {
  // This is what makes dotted paths safe here: every key is always written, so
  // dropping one can never leave yesterday's number sitting in today's document.
  let write = null;
  const Model = { updateOne: async (...args) => { write = args; return { acknowledged: true }; } };
  const bare = report();
  bare.sections = bare.sections.filter((s) => s.id !== "source");
  await service.persistDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: "financial",
    report: bare,
  }, { Model });
  assert.ok("facts.bySource" in write[1].$set);
  assert.equal(write[1].$set["facts.bySource"], null);
});

test("the collection enforces exactly one document per dateKey", () => {
  assert.equal(DailyReportFact.schema.path("dateKey").options.unique, true);
});

test("aggregate call facts attach without changing report completeness", async () => {
  let update = null;
  const Model = {
    findOne: () => ({
      select: () => ({
        lean: async () => ({
          dateKey: "2026-08-03",
          coverage: {
            complete: true,
            reportComplete: true,
            capturedSections: [...service.REQUIRED_SECTIONS],
            sectionErrors: [],
          },
        }),
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
  assert.equal("coverage.complete" in update[1].$set, false,
    "an auxiliary writer must not rewrite the report readiness decision");
});

test("range reads report missing days without inventing pending work", async () => {
  const Model = {
    find: () => ({
      sort: () => ({
        lean: async () => [
          // capturedSections is what completeness is COMPUTED from now (E13).
          // A stub carrying only `complete: true` is a day with no evidence
          // behind the claim, and it correctly reads incomplete.
          {
            dateKey: "2026-08-01",
            coverage: {
              complete: true, callProjection: "complete",
              capturedSections: [...service.REQUIRED_SECTIONS], sectionErrors: [],
            },
          },
          {
            dateKey: "2026-08-03",
            coverage: {
              complete: true, callProjection: "complete",
              capturedSections: [...service.REQUIRED_SECTIONS], sectionErrors: [],
            },
          },
        ],
      }),
    }),
  };
  const result = await service.readDailyReportFactRange({
    from: "2026-08-01", to: "2026-08-03",
  }, { Model });
  assert.deepEqual(result.days.map((day) => day.dateKey), ["2026-08-01", "2026-08-03"]);
  assert.deepEqual(result.coverage.missing, ["2026-08-02"]);
  assert.deepEqual(result.coverage.incomplete, [],
    "a fully captured email is complete without an auxiliary dependency");
  assert.deepEqual(result.coverage.callsPending, []);
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

test("sending carries NO persistence concern", () => {
  const src = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/reportDefinitionService"), "utf8",
  );
  assert.ok(!src.includes("result.dailyFactCapture = await captureDeliveredDailyFact"),
    "the send path must not write the daily fact");
  assert.ok(src.includes("await sendMail(def.domain || null"),
    "but it must still send");
});

test("ONE gather feeds both the email and the snapshot", async () => {
  // The snapshot briefly composed its own report — deliberately, so the send
  // path could shed persistence first. This is the merge: the report the email
  // was built from is handed over, so the night asks Logics, CallRail and
  // RingCentral once rather than twice.
  const { writeDailySnapshot } = require("../../packages/shared-services/src/dailySnapshotService");
  const def = {
    name: "financial", sendEmail: true,
    preset: "rollup", selection: null, domain: null, filters: [],
  };
  const range = { from: "2026-08-03", to: "2026-08-03" };
  const report = {
    from: "2026-08-03", to: "2026-08-03",
    selection: ["topline", "source", "ldcalls", "status", "longcalls"],
    sections: [
      { id: "topline", data: { cash: 1 } }, { id: "source", data: [] },
      { id: "ldcalls", data: [] },
      { id: "status", data: { dnc: 1, keyChanges: [{ caseId: 9, lane: "dnc" }] } },
      { id: "longcalls", data: [] },
    ],
    failures: [],
    spend: { total: 471, ld: 423, ldLeads: 141, mail: 0, mailPieces: 0, bcd: 48, bcdCalls: 12 },
  };

  let composes = 0;
  let saved = null;
  const out = await writeDailySnapshot({
    def, range, report,
    compose: async () => { composes += 1; return report; },
    writer: async (fact) => { saved = fact; return { revision: 1 }; },
  });
  assert.equal(composes, 0, "a supplied report must never trigger a second gather");
  assert.equal(out.status, "written");
  assert.equal(saved.facts.spend.ldLeads, 141, "costs by source survive the merge");
  assert.equal(saved.facts.statusMovement.dnc, 1);
  assert.equal("keyChanges" in saved.facts.statusMovement, false,
    "the additive view stays sanitized");
  assert.equal(saved.detail.statusMovement.keyChanges[0].caseId, 9,
    "the same in-memory build also carries the complete one-day view");
  assert.ok(saved.entryBuiltAt instanceof Date);

  // The explicit standalone fallback stays, and is what makes a delayed
  // missed-day/backfill repair runnable without turning it into a scheduler.
  await writeDailySnapshot({
    def, range,
    compose: async () => { composes += 1; return report; },
    writer: async () => ({ revision: 1 }),
  });
  assert.equal(composes, 1, "with no report supplied it still composes one");
});

test("a late document repairs only its historical day and preserves the old email stamp", async () => {
  const { repairDailySnapshots } = require("../../packages/shared-services/src/dailySnapshotService");
  const acceptedAt = new Date("2026-08-04T03:00:00.000Z");
  let write = null;
  let composes = 0;
  const Model = {
    findOne: () => ({
      select: () => ({ lean: async () => ({ emailAcceptedAt: acceptedAt }) }),
    }),
    updateOne: async (...args) => { write = args; return { acknowledged: true }; },
  };
  const repairedReport = report({
    spend: { mail: 1200, mailPieces: 5000, ld: 30, bcd: 8, total: 1238 },
  });
  const out = await repairDailySnapshots({
    dateKeys: ["2026-08-03", "2026-08-03"],
    def: {
      name: service.CANONICAL_DEFINITION_NAME,
      sendEmail: true,
      blocks: ["daily"],
      domain: null,
      filters: [],
    },
    compose: async ({ from, to }) => {
      composes += 1;
      assert.deepEqual({ from, to }, { from: "2026-08-03", to: "2026-08-03" });
      return repairedReport;
    },
    Model,
  });

  assert.equal(composes, 1, "duplicate affected dates pay for one repair gather");
  assert.equal(out.repaired, 1);
  assert.equal(out.failed, 0);
  assert.equal(write[1].$set.emailAcceptedAt.getTime(), acceptedAt.getTime(),
    "repairing factors must not pretend a new email was accepted");
  assert.equal(write[1].$set["facts.spend"].mail, 1200);
  assert.equal(write[1].$set["facts.spend"].mailPieces, 5000);
});

test("a failed late repair remains discoverable until spend is actually recaptured", async () => {
  const { findSpendRepairDateKeys } = require(
    "../../packages/shared-services/src/dailySnapshotService"
  );
  const chain = (rows) => ({ select: () => ({ lean: async () => rows }) });
  const InvoiceModel = {
    find: () => chain([
      { serviceDate: "2026-08-08", spendDerivedAt: new Date("2026-08-11T02:51:00Z") },
      { serviceDate: "2026-08-09", spendDerivedAt: new Date("2026-08-10T02:51:00Z") },
      { serviceDate: "2026-08-10", spendDerivedAt: new Date("2026-08-11T02:51:00Z") },
    ]),
  };
  const FactModel = {
    find: () => chain([
      { dateKey: "2026-08-08", spendCapturedAt: new Date("2026-08-10T03:00:00Z") },
      { dateKey: "2026-08-09", spendCapturedAt: new Date("2026-08-11T03:00:00Z") },
    ]),
  };
  const pending = await findSpendRepairDateKeys({
    from: "2026-08-08", to: "2026-08-10", currentDateKey: "2026-08-10",
    InvoiceModel, FactModel,
  });
  assert.deepEqual(pending, ["2026-08-08"],
    "stale spend retries, already-repaired spend and the current close do not");
});

test("daily repair hints identify only unresolved officer, source, and cost facts", () => {
  const {
    REPAIR_REASON, dailyFactRepairReasons,
  } = require("../../packages/shared-services/src/dailySnapshotService");
  const reasons = dailyFactRepairReasons({
    dateKey: "2026-08-10",
    coverage: { reportDegraded: true, repairHints: [] },
    facts: {
      financial: { mailApplies: true },
      spend: { mail: 0, mailPieces: 0, ld: 30, bcd: 4, total: 34 },
      byAgent: { agents: [{ agent: "(no snapshot)", deals: 1, cash: 900 }] },
      bySource: [
        { source: "(unsourced)", deals: 1, newCash: 900, spend: 0 },
        { source: "LD", leads: 4, spend: 0 },
        { source: "Aged / inactive source", deals: 1, newCash: 500, spend: 0 },
      ],
    },
  });
  assert.deepEqual(new Set(reasons), new Set([
    REPAIR_REASON.OFFICER,
    REPAIR_REASON.MARKETING_SOURCE,
    REPAIR_REASON.MARKETING_COST,
  ]));
  assert.equal(reasons.filter((reason) => reason === REPAIR_REASON.MARKETING_COST).length, 1,
    "Aged carries no cost by design and must not create a second repair reason");
});

test("historical repair scans only the prior seven days and excludes the current close", async () => {
  const {
    findHistoricalDailyFactRepairs,
  } = require("../../packages/shared-services/src/dailySnapshotService");
  let query = null;
  const FactModel = {
    find: (value) => {
      query = value;
      return {
        select: () => ({
          sort: () => ({
            lean: async () => [{
              dateKey: "2026-08-10",
              coverage: { repairHints: ["marketing-cost"] },
              facts: {},
            }],
          }),
        }),
      };
    },
  };
  const rows = await findHistoricalDailyFactRepairs({
    currentDateKey: "2026-08-11", maxAgeDays: 99, FactModel,
  });
  assert.deepEqual(query, { dateKey: { $gte: "2026-08-04", $lte: "2026-08-10" } });
  assert.deepEqual(rows, [{ dateKey: "2026-08-10", reasons: ["marketing-cost"] }]);
});

test("one late sheet read identifies every changed service day, not the fetch day", async () => {
  const { findMailSheetRepairDateKeys } = require(
    "../../packages/shared-services/src/dailySnapshotService"
  );
  const MailSpendModel = {
    find: () => ({
      select: () => ({
        lean: async () => [{ serviceDate: "2026-08-10" }],
      }),
    }),
  };
  const out = await findMailSheetRepairDateKeys({
    from: "2026-08-04",
    to: "2026-08-10",
    currentDateKey: "2026-08-11",
    sheetReader: async () => ({
      unavailable: null,
      rows: [
        { date: "2026-08-07", spend: 400, pieces: 800 },
        { date: "2026-08-07", spend: 600, pieces: 1200 },
        { date: "2026-08-08", spend: 500, pieces: 900 },
        { date: "2026-08-09", spend: 700, pieces: 1300 },
        { date: "2026-08-10", spend: 999, pieces: 999 },
      ],
    }),
    facts: [
      { dateKey: "2026-08-07", facts: { spend: { mail: 400, mailPieces: 800 } } },
      { dateKey: "2026-08-08", facts: { spend: { mail: 500, mailPieces: 900 } } },
      { dateKey: "2026-08-10", facts: { spend: { mail: 1, mailPieces: 1 } } },
    ],
    MailSpendModel,
  });
  assert.deepEqual(out.dateKeys, ["2026-08-07", "2026-08-09"],
    "a changed day and a newly supplied day repair independently");
  assert.equal(out.daysSeen, 4);
  assert.equal(out.invoiceDaysExcluded, 1,
    "the hand-kept sheet never displaces an invoice-backed day");
});

test("the bounded historical scan folds late sheet dates into its repair plan", async () => {
  const {
    findHistoricalDailyFactRepairs,
  } = require("../../packages/shared-services/src/dailySnapshotService");
  const FactModel = {
    find: () => ({
      select: () => ({
        sort: () => ({
          lean: async () => [{
            dateKey: "2026-08-07",
            coverage: { reportDegraded: false, repairHints: [] },
            facts: {
              financial: { mailApplies: true },
              spend: { mail: 100, mailPieces: 100, ld: 30, bcd: 4 },
              byAgent: { agents: [] },
              bySource: [],
            },
          }],
        }),
      }),
    }),
  };
  const MailSpendModel = {
    find: () => ({ select: () => ({ lean: async () => [] }) }),
  };
  const rows = await findHistoricalDailyFactRepairs({
    currentDateKey: "2026-08-11",
    includeMailSheet: true,
    FactModel,
    MailSpendModel,
    sheetReader: async () => ({
      unavailable: null,
      rows: [
        { date: "2026-08-07", spend: 250, pieces: 300 },
        { date: "2026-08-09", spend: 900, pieces: 1200 },
      ],
    }),
  });
  assert.deepEqual(rows, [
    { dateKey: "2026-08-07", reasons: ["marketing-cost"] },
    { dateKey: "2026-08-09", reasons: ["marketing-cost"] },
  ]);
});

test("post-close repair reopens spend only for an uncosted historical day", async () => {
  const {
    REPAIR_REASON, repairHistoricalDailyFacts,
  } = require("../../packages/shared-services/src/dailySnapshotService");
  let repairArgs = null;
  const out = await repairHistoricalDailyFacts({
    currentDateKey: "2026-08-11",
    finder: async () => [
      { dateKey: "2026-08-09", reasons: [REPAIR_REASON.OFFICER] },
      { dateKey: "2026-08-10", reasons: [REPAIR_REASON.MARKETING_COST] },
    ],
    repair: async (args) => {
      repairArgs = args;
      return { status: "completed", repaired: 2, failed: 0 };
    },
  });
  assert.deepEqual(repairArgs.dateKeys, ["2026-08-09", "2026-08-10"]);
  assert.deepEqual(repairArgs.overwriteFrozenByDate, {
    "2026-08-09": [],
    "2026-08-10": ["spend"],
  });
  assert.equal(out.repaired, 2);
  assert.deepEqual(out.countsByReason, {
    "officer-attribution": 1,
    "marketing-cost": 1,
  });
});

test("a resumed historical-repair plan cannot escape its seven-day window", async () => {
  const {
    REPAIR_REASON, repairHistoricalDailyFacts,
  } = require("../../packages/shared-services/src/dailySnapshotService");
  let repairArgs = null;
  const out = await repairHistoricalDailyFacts({
    currentDateKey: "2026-08-11",
    maxAgeDays: 99,
    candidates: [
      { dateKey: "2026-08-03", reasons: [REPAIR_REASON.OFFICER] },
      { dateKey: "2026-08-04", reasons: [REPAIR_REASON.OFFICER] },
      { dateKey: "2026-08-10", reasons: [REPAIR_REASON.MARKETING_COST] },
      { dateKey: "2026-08-11", reasons: [REPAIR_REASON.OFFICER] },
    ],
    repair: async (args) => {
      repairArgs = args;
      return { status: "completed", repaired: args.dateKeys.length, failed: 0 };
    },
  });
  assert.deepEqual(repairArgs.dateKeys, ["2026-08-04", "2026-08-10"]);
  assert.equal(out.scannedDays, 7);
  assert.equal(out.candidates, 2);
});

test("historical repair rejects a supplied plan without a valid close date", async () => {
  const {
    REPAIR_REASON, repairHistoricalDailyFacts,
  } = require("../../packages/shared-services/src/dailySnapshotService");
  let repairs = 0;
  const out = await repairHistoricalDailyFacts({
    currentDateKey: "not-a-date",
    candidates: [{ dateKey: "2026-08-10", reasons: [REPAIR_REASON.OFFICER] }],
    repair: async () => { repairs += 1; },
  });
  assert.equal(out.status, "skipped");
  assert.equal(out.reason, "invalid-current-date");
  assert.equal(out.candidates, 0);
  assert.equal(repairs, 0);
});

test("a missing invoice writes a value-free marketing repair hint", () => {
  const fact = service.buildDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: service.CANONICAL_DEFINITION_NAME,
    report: report({
      spend: { mail: 0, mailPieces: 0, ld: 30, bcd: 4, total: 34 },
      failures: ["NO MAIL SPEND for the day and NO INVOICE was ingested"],
    }),
    emailAcceptedAt: null,
  });
  assert.deepEqual(fact.coverage.repairHints, ["marketing-cost"]);
});

test("the record is saved BEFORE the email is sent, from the same gather", () => {
  // Mickey 2026-08-06: "email logic works so why change what works, just put it in
  // the flow so that it saves a copy then generates the email."
  //
  // The save used to run after the send and only for a delivered email, which made
  // the record a side effect of mailing. It is now the day's record in its own
  // right: written from the report the email was built from, before the send, with
  // emailAcceptedAt left null until the mail is actually accepted.
  const src = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/reportDefinitionService"), "utf8",
  );
  // Anchored on where the report is PRODUCED, not on composeReport specifically:
  // there are two producers now (live compose, or a render from the stored day),
  // and the ordering this test protects is the same for both.
  const produced = src.indexOf("const recordVerdict = canRenderFromRecord(def, range);");
  const composed = src.indexOf("composeReport({", produced);
  const hook = src.indexOf("onComposed", produced);
  const send = src.indexOf("await sendMail(", produced);
  assert.ok(produced >= 0, "the report-production branch must exist");
  assert.ok(composed > produced, "live compose is still the default branch");
  assert.ok(hook > produced, "the hook must follow the report being produced");
  assert.ok(send > hook, "and must run BEFORE the send");
});

test("a failing save never stops the email going out", () => {
  // Re-coupling send to persistence is the one thing the 2026-08-04 split got
  // right and must survive this reordering.
  const src = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/reportDefinitionService"), "utf8",
  );
  // The call site, not the parameter declaration.
  const call = src.indexOf("await onComposed(");
  assert.ok(call > 0, "onComposed must actually be invoked");
  const window = src.slice(call - 200, src.indexOf("await sendMail(", call));
  assert.ok(/try\s*\{/.test(window), "the invocation must sit inside a try");
  assert.ok(/catch\s*\(/.test(window), "with a catch, so a save failure cannot block the send");
  assert.ok(/onComposedError/.test(window), "and the failure must be recorded, not swallowed silently");
});

test("the runtime hands the snapshot writer the run's own range and report", () => {
  const src = fs.readFileSync(
    require.resolve("../../apps/control-plane/src/services/reportScheduleRuntime"), "utf8",
  );
  const snapshot = src.indexOf("writeDailySnapshot(");
  const call = src.slice(snapshot, snapshot + 300);
  // Range AND report must come from the RUN, never re-derived — an independently
  // computed day produced TODAY where the email produced YESTERDAY, writing a
  // second document that silently overwrote the first.
  assert.ok(/range/.test(call) && /report/.test(call),
    "the snapshot must key on the range the email used and be built from its report");
});

test("a completed report without optional aggregate counts does not overwrite them", async () => {
  // This path never has call facts — the call index produces them and the daily
  // entry worker posts them. Stamping {status:"pending"} here would erase real
  // counts every night, on a schedule.
  let write = null;
  const Model = { updateOne: async (...args) => { write = args; return { acknowledged: true }; } };
  await service.persistDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: "financial",
    report: report(),
  }, { Model });
  assert.equal("facts.calls" in write[1].$set, false);
  // The state is still recorded — just in the block this path does own.
  assert.equal(write[1].$set["coverage"].callProjection, "complete");
});

test("real call facts ARE written when this path is given them", async () => {
  let write = null;
  const Model = { updateOne: async (...args) => { write = args; return { acknowledged: true }; } };
  await service.persistDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: "financial",
    report: report(),
    callFacts: { links: 12, significant: 3 },
  }, { Model });
  assert.deepEqual(write[1].$set["facts.calls"], { links: 12, significant: 3 });
  assert.equal(write[1].$set["coverage"].callProjection, "complete");
});

// ── THE DEFAULT WRITER REBUILT AN ALREADY-BUILT FACT ───────────────────────
//
// writeDailySnapshot builds a fact and hands it to `writer`. The default writer
// was persistDailyReportFact, whose first line builds AGAIN — and the second
// build gets a fact, which has no `report` key, so it threw
// "daily fact requires a one-day report" every single night.
//
// Nothing caught it because every existing exercise injects a writer: the
// dry-run script and the tests. Production is the only caller that takes the
// default, and production is the one path with no coverage.

test("persisting an already-built fact does not rebuild it", async () => {
  const {
    buildDailyReportFact, persistBuiltDailyReportFact,
  } = require("../../packages/shared-services/src/dailyReportFactService");

  const report = {
    from: "2026-08-05", to: "2026-08-05", domain: "ALL",
    selection: ["topline"],
    sections: [{ id: "topline", label: "Top line", data: { cash: 1200, deals: 3 } }],
    failures: [], advisories: [], notes: [], spend: null,
  };
  const fact = buildDailyReportFact({
    dateKey: "2026-08-05", definitionName: "financial",
    report, emailAcceptedAt: null,
  });
  assert.equal("report" in fact, false, "a built fact carries no report — that is the trap");

  const seen = [];
  const Model = { updateOne: async (...a) => { seen.push(a); return { acknowledged: true }; } };
  const out = await persistBuiltDailyReportFact(fact, { Model });
  assert.equal(out.status, "captured");
  assert.equal(seen.length, 1, "one write");
  assert.deepEqual(seen[0][0], { dateKey: "2026-08-05" }, "keyed on the day");
});

test("the snapshot writer default can persist what the snapshot built", async () => {
  // The end-to-end shape of the production call: writeDailySnapshot with NO
  // writer injected. Before the fix this returned {status:"failed"} and raised
  // a high-severity alert every night.
  const { writeDailySnapshot } = require("../../packages/shared-services/src/dailySnapshotService");
  const {
    REQUIRED_SECTIONS, CANONICAL_DEFINITION_NAME,
  } = require("../../packages/shared-services/src/dailyReportFactService");

  const sections = REQUIRED_SECTIONS.map((id) => ({ id, label: id, data: {} }));
  const report = {
    from: "2026-08-05", to: "2026-08-05", domain: "ALL",
    selection: REQUIRED_SECTIONS.slice(), sections,
    failures: [], advisories: [], notes: [], spend: null,
  };

  const writes = [];
  const result = await writeDailySnapshot({
    def: { name: CANONICAL_DEFINITION_NAME, domain: null, sendEmail: true, filters: [] },
    range: { from: "2026-08-05", to: "2026-08-05" },
    report,
    emailAcceptedAt: null,
    Model: { updateOne: async (...a) => { writes.push(a); return { acknowledged: true }; } },
  });
  assert.equal(result.status, "written",
    `the default writer must persist, not rebuild — got ${result.status}: ${result.reason || ""}`);
  assert.equal(writes.length, 1);
  const set = writes[0][1].$set;
  assert.ok("detail.financial" in set, "the atomic write carries the complete report view");
  assert.equal("detail" in set, false, "detail is field-flattened, never whole-object replaced");
  assert.equal("facts.calls" in set, false, "an unseen call section cannot erase real call facts");
  assert.equal("facts.activity" in set, false, "an unseen activity section cannot erase its writer");
  assert.equal("detail.calls" in set, false, "the same protection applies to call detail");
  assert.equal("detail.activity" in set, false, "the same protection applies to activity detail");
});

// ── E13 / D7: completeness is COMPUTED ON READ ─────────────────────────────

test("a day stamped complete under an OLDER required-section list reads incomplete", () => {
  // This is the whole point of computing it. REQUIRED_SECTIONS is derived from
  // the rollup preset; the day that preset gains a section, every document
  // written before it still carries `complete: true` and is now lying. The
  // computed answer moves with the definition, and it moves toward re-gathering
  // rather than toward serving a report that silently lacks a section.
  const stale = {
    dateKey: "2026-07-31",
    coverage: {
      complete: true,
      callProjection: "complete",
      capturedSections: ["topline", "source"], // an older, shorter list
      sectionErrors: [],
    },
  };
  assert.equal(stale.coverage.complete, true, "the STORED flag still says complete");
  assert.equal(service.isFactComplete(stale), false, "the COMPUTED answer does not");
});

test("a day whose sections are all present and clean is complete", () => {
  assert.equal(service.isFactComplete({
    coverage: {
      complete: false, // even if the stored flag disagrees
      callProjection: "complete",
      capturedSections: [...service.REQUIRED_SECTIONS],
      sectionErrors: [],
    },
  }), true);
});

test("a section error anywhere makes the day incomplete, whatever was stored", () => {
  assert.equal(service.isFactComplete({
    coverage: {
      complete: true, callProjection: "complete",
      capturedSections: [...service.REQUIRED_SECTIONS],
      sectionErrors: ["source:logics timed out"],
    },
  }), false);
});

test("pending aggregate calls do not veto a complete stored report", () => {
  assert.equal(service.isFactComplete({
    coverage: {
      complete: true, callProjection: "pending",
      capturedSections: [...service.REQUIRED_SECTIONS], sectionErrors: [],
    },
  }), true);
});

test("no fact at all is not complete", () => {
  assert.equal(service.isFactComplete(null), false);
  assert.equal(service.isFactComplete({}), false);
});

test("isFactComplete is NOT the gate for a queue-rollup range — different type", () => {
  // E13 made DailyReportFact completeness computed-on-read, and the composer's
  // long-range cache gate briefly borrowed that predicate. readQueueRange
  // returns a different coverage shape entirely — no capturedSections, no
  // callProjection — so isFactComplete returned false for EVERY possible
  // result. The cache branch became dead code and a fully-stored month
  // rendered as "call data unavailable".
  const fullyCoveredRange = {
    coverage: {
      daysRequested: 30, daysStored: 30,
      missing: [], partialDays: [], unavailableDays: [], legacyDays: [],
      complete: true,
    },
  };
  assert.equal(service.isFactComplete(fullyCoveredRange), false,
    "a queue range is not a daily fact — this predicate cannot judge it");

  const src = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/reportComposerService"), "utf8",
  );
  const gate = src.slice(src.indexOf("const stored = await readQueueRange"));
  const branch = gate.slice(0, gate.indexOf("else if"));
  assert.match(branch, /if \(stored\.coverage\.complete\)/,
    "the range must be judged by its own computed completeness");
  assert.doesNotMatch(branch, /isFactComplete\(stored\)/);
});

test("a stored range that is present but not usable does not say 'only N of N'", () => {
  // daysStored can equal daysRequested while partial/unavailable/legacy days
  // make the range incomplete, so the old message contradicted itself.
  const src = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/reportComposerService"), "utf8",
  );
  assert.match(src, /captured but not all usable/);
});
