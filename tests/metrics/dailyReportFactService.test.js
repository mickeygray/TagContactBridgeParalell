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

test("the nightly write touches facts.<key>, never the whole facts object", async () => {
  // $set: { facts: {...} } REPLACES the subdocument in Mongo. That is fine while
  // this is the only writer and destructive the moment anything else contributes a
  // section — facts.activity comes from the activity review and from nowhere here.
  let write = null;
  const Model = { updateOne: async (...args) => { write = args; return { acknowledged: true }; } };
  await service.persistDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: "financial roll up with calls",
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
    definitionName: "financial roll up with calls",
    report: bare,
  }, { Model });
  assert.ok("facts.bySource" in write[1].$set);
  assert.equal(write[1].$set["facts.bySource"], null);
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
    name: "financial roll up with calls", sendEmail: true,
    preset: "rollup", selection: null, domain: null, filters: [],
  };
  const range = { from: "2026-08-03", to: "2026-08-03" };
  const report = {
    from: "2026-08-03", to: "2026-08-03",
    selection: ["topline", "source", "ldcalls", "status", "longcalls"],
    sections: [
      { id: "topline", data: { cash: 1 } }, { id: "source", data: [] },
      { id: "ldcalls", data: [] }, { id: "status", data: {} }, { id: "longcalls", data: [] },
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

  // The fallback stays, and is what makes a backfill runnable without a send.
  await writeDailySnapshot({
    def, range,
    compose: async () => { composes += 1; return report; },
    writer: async () => ({ revision: 1 }),
  });
  assert.equal(composes, 1, "with no report supplied it still composes one");
});

test("the snapshot writer is ordered after the email, and only for a delivered one", () => {
  const src = fs.readFileSync(
    require.resolve("../../apps/control-plane/src/services/reportScheduleRuntime"), "utf8",
  );
  const ran = src.indexOf("await runDefinition(def");
  const snapshot = src.indexOf("await writeDailySnapshot(", ran);
  assert.ok(ran >= 0 && snapshot > ran, "the snapshot must follow the send");
  // A day whose mail never went out must not acquire a snapshot claiming it did.
  const between = src.slice(ran, snapshot);
  assert.ok(between.includes("if (result.delivered)"),
    "the snapshot must be gated on actual delivery");
  // Range AND report must come from the RUN, never re-derived — an
  // independently computed day produced TODAY where the email produced
  // YESTERDAY, writing a second document that silently overwrote the first.
  const call = src.slice(snapshot, snapshot + 240);
  assert.ok(call.includes("range: result.range"),
    "the snapshot must key on the range the email actually used");
  assert.ok(call.includes("report: result.report"),
    "and must be built from the report the email was built from — one gather");
});

test("a pending calls placeholder is not written over another writer's real counts", async () => {
  // This path never has call facts — the call index produces them and the daily
  // entry worker posts them. Stamping {status:"pending"} here would erase real
  // counts every night, on a schedule.
  let write = null;
  const Model = { updateOne: async (...args) => { write = args; return { acknowledged: true }; } };
  await service.persistDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: "financial roll up with calls",
    report: report(),
  }, { Model });
  assert.equal("facts.calls" in write[1].$set, false);
  // The state is still recorded — just in the block this path does own.
  assert.equal(write[1].$set["coverage"].callProjection, "pending");
});

test("real call facts ARE written when this path is given them", async () => {
  let write = null;
  const Model = { updateOne: async (...args) => { write = args; return { acknowledged: true }; } };
  await service.persistDailyReportFact({
    dateKey: "2026-08-03",
    definitionName: "financial roll up with calls",
    report: report(),
    callFacts: { links: 12, significant: 3 },
  }, { Model });
  assert.deepEqual(write[1].$set["facts.calls"], { links: 12, significant: 3 });
  assert.equal(write[1].$set["coverage"].callProjection, "complete");
});
