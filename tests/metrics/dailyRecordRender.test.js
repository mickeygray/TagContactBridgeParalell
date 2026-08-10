"use strict";

// E12 — the second producer of the nightly report shape.
//
// The whole point is that the email template cannot tell the difference. So
// these tests assert on the SHAPE the template consumes, not on prose.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ROLLUP, canRenderFromRecord, renderReportFromRecord, sectionsFromFact, sectionsFromRange,
} = require("../../packages/shared-services/src/dailyRecordRenderService");
const { BY_ID } = require("../../packages/shared-services/src/reportBlocksService");

const factDoc = (over = {}) => ({
  dateKey: "2026-08-05",
  capturedAt: new Date("2026-08-06T03:04:43.000Z"),
  revision: 2,
  facts: {
    financial: { cash: 12000, spend: 1584, net: 10416, deals: 3 },
    bySource: [{ source: "LD", deals: 2, totalCash: 8000 }],
    byAgent: { agents: [{ agent: "Monica", inbound: 4, deals: 1 }] },
    statusMovement: { dnc: 4, postdate: 2, suspended: 7 },
    spend: { total: 1584, ldSpend: 444 },
    calls: { status: "pending", rowsObservedInEmail: 0 },
  },
  coverage: { reportDegraded: false, sectionErrors: [] },
  ...over,
});

const modelReturning = (doc) => ({ findOne: () => ({ lean: async () => doc }) });
const rangeModelReturning = (docs) => ({
  find: (query) => ({
    select: () => ({
      sort: () => ({
        lean: async () => docs.filter((doc) => (
          doc.dateKey >= query.dateKey.$gte && doc.dateKey <= query.dateKey.$lte
        )),
      }),
    }),
  }),
});

// ── the shape the template consumes ────────────────────────────────────────

test("a rendered section carries a live block object, not just data", async () => {
  // toTemplateData calls s.block.csv(s.data) and reads s.block.termsShort —
  // FUNCTIONS, which cannot survive Mongo. The record stores ids only, so the
  // renderer has to re-attach the block from the registry or the email throws.
  const report = await renderReportFromRecord({ dateKey: "2026-08-05", Model: modelReturning(factDoc()) });
  for (const section of report.sections) {
    assert.ok(section.block, `${section.id} must carry a block`);
    assert.equal(typeof section.block.csv, "function", `${section.id}.block.csv must be callable`);
    assert.equal(section.block, BY_ID.get(section.id), "must be the registry's own block object");
    assert.equal(typeof section.label, "string");
  }
});

test("a supplied section has data and NO error key; an unknown one is the reverse", async () => {
  // The composer's two shapes exactly: {id,label,data,block} and
  // {id,label,error,block}. `error: null` is not the same thing and would make
  // a good section look failed.
  const report = await renderReportFromRecord({ dateKey: "2026-08-05", Model: modelReturning(factDoc()) });
  const topline = report.sections.find((s) => s.id === "topline");
  assert.ok(topline.data, "topline is stored in full");
  assert.equal("error" in topline, false, "a good section must not carry an error key at all");

  const longcalls = report.sections.find((s) => s.id === "longcalls");
  assert.match(longcalls.error, /^UNKNOWN/);
  assert.equal("data" in longcalls, false, "an unknown section must not carry a data key");
});

test("the report envelope matches composeReport's key set", async () => {
  const report = await renderReportFromRecord({ dateKey: "2026-08-05", Model: modelReturning(factDoc()) });
  for (const key of [
    "from", "to", "domain", "selection", "filters", "filtered", "unknown",
    "source", "gathered", "gatherStats", "notes", "failures", "advisories",
    "spend", "sections",
  ]) {
    assert.ok(key in report, `composeReport emits ${key}; so must this`);
  }
  assert.equal(report.from, "2026-08-05");
  assert.equal(report.to, "2026-08-05", "the record is one day, always");
  assert.deepEqual(report.selection, [...ROLLUP]);
});

test("source says 'record', which is what tells the two producers apart", async () => {
  const report = await renderReportFromRecord({ dateKey: "2026-08-05", Model: modelReturning(factDoc()) });
  assert.equal(report.source, "record");
});

test("a stored range keeps source and agent metrics while compressing everything else", async () => {
  const day = (dateKey, cash, minutes) => ({
    dateKey,
    captureVersion: 2,
    facts: {
      financial: { cash, spend: 10, newCash: cash, deals: 1, ldDials: 5, mailCalls: 2 },
      spend: { mail: 5, ld: 5, bcd: 0 },
      bySource: [{ source: "LD", deals: 1, newCash: cash, recurringCash: 0, totalCash: cash, spend: 5, leads: 2 }],
      byAgent: {
        cases: 1, attempts: 5, attemptsKnown: 5, attemptsUnknown: 0,
        connected: 1, talkMinutes: minutes, newLeadsKnown: true,
        agents: [{ agent: "Agent A", dials: 5, connected: 1, talkMinutes: minutes, cash }],
      },
      statusMovement: { dnc: 1, postdate: 0, suspended: 0, conversions: 1, other: 0 },
      callHighlights: { total: 1, over30Minutes: minutes >= 30 ? 1 : 0, withRecording: 1, totalMinutes: minutes },
    },
    detail: {
      callHighlights: [{
        officer: "Agent A", minutes, direction: "outbound",
        listenUrl: `https://example.invalid/${dateKey}`,
      }],
    },
    coverage: { complete: true, reportDegraded: false, sectionErrors: [] },
  });
  const report = await renderReportFromRecord({
    from: "2026-08-04", to: "2026-08-05",
    Model: rangeModelReturning([day("2026-08-04", 100, 25), day("2026-08-05", 200, 35)]),
  });

  assert.equal(report.from, "2026-08-04");
  assert.equal(report.to, "2026-08-05");
  assert.equal(report.sections.find((s) => s.id === "topline").data.cash, 300);
  assert.equal(report.sections.find((s) => s.id === "source").data[0].newCash, 300);
  assert.equal(report.sections.find((s) => s.id === "ldcalls").data.attempts, 10);
  const status = report.sections.find((s) => s.id === "status").data;
  assert.equal(status.conversions, 2);
  assert.equal(status.rangeSummary, true);
  const calls = report.sections.find((s) => s.id === "longcalls").data;
  assert.equal(calls.totalObserved, 2);
  assert.equal(calls.over30Minutes, 1);
  assert.equal(calls.length, 2);
  assert.equal(report.failures.length, 0);
});

test("mixed-format ranges count every fact day but show only retained call rows", () => {
  const sections = sectionsFromRange({
    sections: {
      callHighlights: { total: 3, over30Minutes: 2, withRecording: 2, totalMinutes: 95 },
    },
    detailSections: {
      callHighlights: {
        total: 1, over30Minutes: 1, withRecording: 1, topPerAgent: 5,
        rows: [{ officer: "Agent A", minutes: 35, listenUrl: "https://example.invalid/a" }],
      },
    },
  }, ["longcalls"]);
  const rows = sections[0].data;
  assert.equal(rows.totalObserved, 3, "facts cover legacy and current days");
  assert.equal(rows.over30Minutes, 2);
  assert.equal(rows.withRecording, 2);
  assert.equal(rows.length, 1, "only the retained current-day row is presented");
});

test("a range with counts but no retained call rows still says what happened", () => {
  const sections = sectionsFromRange({
    sections: { callHighlights: { total: 4, over30Minutes: 2, withRecording: 0 } },
    detailSections: {},
  }, ["longcalls"]);
  const text = sections[0].block.renderText(sections[0].data);
  assert.match(text, /4 long call\(s\) observed/);
  assert.match(text, /no retained review rows/);
  assert.doesNotMatch(text, /none over the threshold/);
});

// ── unknown, never zero ────────────────────────────────────────────────────

test("a legacy day without call-highlight detail renders UNKNOWN", async () => {
  // facts.calls holds counts or a "pending" placeholder; the block renders
  // rows. block.csv(null) would emit a zero-row table, and a zero-row "Calls
  // worth hearing" reads as "nothing worth hearing happened".
  const report = await renderReportFromRecord({ dateKey: "2026-08-05", Model: modelReturning(factDoc()) });
  const longcalls = report.sections.find((s) => s.id === "longcalls");
  assert.match(longcalls.error, /callHighlights is empty/);
});

test("a new day renders call rows from detail, not aggregate call statistics", async () => {
  const row = { officer: "Agent A", minutes: 35, listenUrl: "https://example.invalid/call" };
  const report = await renderReportFromRecord({
    dateKey: "2026-08-05",
    Model: modelReturning(factDoc({ detail: { callHighlights: [row] } })),
  });
  const longcalls = report.sections.find((s) => s.id === "longcalls");
  assert.deepEqual(longcalls.data, [row]);
});

test("a fact key that is null renders UNKNOWN, not an empty table", () => {
  const sections = sectionsFromFact(factDoc({
    facts: { ...factDoc().facts, statusMovement: null },
  }));
  const status = sections.find((s) => s.id === "status");
  assert.match(status.error, /^UNKNOWN/);
  assert.match(status.error, /facts\.statusMovement is empty/);
});

test("an EMPTY answer is a real answer and still renders", () => {
  // {} and [] mean "we looked and there was nothing", which is different from
  // null. Collapsing the two would turn a genuinely quiet day into UNKNOWN.
  const sections = sectionsFromFact(factDoc({
    facts: { ...factDoc().facts, bySource: [] },
  }));
  const source = sections.find((s) => s.id === "source");
  assert.equal("error" in source, false);
  assert.deepEqual(source.data, []);
});

test("a section that FAILED on capture night stays failed", () => {
  // Otherwise a known-bad night re-renders as a clean one a day later.
  const sections = sectionsFromFact(factDoc({
    coverage: { reportDegraded: true, sectionErrors: ["source:logics timed out"] },
  }));
  const source = sections.find((s) => s.id === "source");
  assert.match(source.error, /failed when captured/);
  assert.match(source.error, /logics timed out/);
});

test("a degraded capture night is carried into failures, not silently dropped", async () => {
  const report = await renderReportFromRecord({
    dateKey: "2026-08-05",
    Model: modelReturning(factDoc({ coverage: { reportDegraded: true, sectionErrors: [] } })),
  });
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0], /\[DEGRADED\]/);
});

test("the advisory names exactly which sections the record could not supply", async () => {
  const report = await renderReportFromRecord({ dateKey: "2026-08-05", Model: modelReturning(factDoc()) });
  assert.equal(report.advisories.length, 1);
  assert.match(report.advisories[0], /longcalls/);
  assert.match(report.advisories[0], /1 of 5 section\(s\)/);
});

test("a MISSING record returns null — it must never render a day of zeroes", async () => {
  const report = await renderReportFromRecord({
    dateKey: "2026-08-04", Model: modelReturning(null),
  });
  assert.equal(report, null,
    "a night that was never captured is not a night where nothing happened");
});

test("a malformed dateKey throws rather than reading the wrong day", async () => {
  await assert.rejects(
    () => renderReportFromRecord({ dateKey: "08/05/2026", Model: modelReturning(factDoc()) }),
    /YYYY-MM-DD/,
  );
});

test("an impossible calendar date throws rather than normalizing", async () => {
  await assert.rejects(
    () => renderReportFromRecord({ dateKey: "2026-02-31", Model: modelReturning(null) }),
    /YYYY-MM-DD/,
  );
});

// ── it must not gather ─────────────────────────────────────────────────────

test("the renderer never touches the network", () => {
  // Its whole reason to exist is that it does not re-gather. A stray client
  // construction would make the side-by-side compare two live pulls.
  // Comments stripped before matching: the header explains the relationship to
  // composeReport on purpose, and a bare word match would fail on the very
  // documentation that says this file does not call it.
  const source = require("node:fs")
    .readFileSync(
      require.resolve("../../packages/shared-services/src/dailyRecordRenderService"), "utf8",
    )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  for (const forbidden of [
    /createLogicsClient/, /createCallrailClient/, /createRingCentral/,
    /composeReport/, /reportComposerService/, /axios/, /fetch\(/,
  ]) {
    assert.doesNotMatch(source, forbidden, `must not reach for ${forbidden}`);
  }
  // And it may require only local, pure contracts plus the block registry and
  // model. The shared vocabulary is data-only and cannot gather anything.
  const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(),
    ["../../shared-models/src/DailyReportFact", "./dailyEntryService", "./dailyReportContract", "./reportBlocksService"]);
});

// ── the domain guard ───────────────────────────────────────────────────────

test("a tenant-scoped definition may NOT render from the all-domain record", () => {
  // longcalls filters on domain (inboundApplies = !domain || domain === TAG).
  // The record has no domain dimension, so rendering a WYNN board from it
  // reinstates a leak the block's own comment records having happened once.
  assert.deepEqual(
    canRenderFromRecord({ renderSource: "record", domain: "WYNN" }),
    { ok: false, reason: "tenant-scoped-definition-cannot-use-an-all-domain-record" },
  );
  assert.equal(canRenderFromRecord({ renderSource: "record", domain: null }).ok, true);
});

test("a definition without renderSource is untouched by any of this", () => {
  assert.equal(canRenderFromRecord({ domain: null }).ok, false);
  assert.equal(canRenderFromRecord({ renderSource: null, domain: null }).reason, "not-record-sourced");
});

test("a filtered definition may not render from the record", () => {
  assert.equal(
    canRenderFromRecord({ renderSource: "record", domain: null, filters: ["officer=x"] }).reason,
    "filtered-definition",
  );
});

// ── the schema field this depends on ───────────────────────────────────────

test("renderSource is DECLARED on the schema, or a flip would be dropped silently", () => {
  // ReportDefinition is strict (mongoose default). An updateOne setting an
  // undeclared field is dropped without error and still reports
  // modifiedCount: 1 if anything else in the same $set changed. The renderer
  // would then never run, both definitions would keep composing, and a parity
  // check would report 100% agreement — certifying the bug.
  const ReportDefinition = require("../../packages/shared-models/src/ReportDefinition");
  const path = ReportDefinition.schema.path("renderSource");
  assert.ok(path, "renderSource must exist on the schema BEFORE anything writes it");
  assert.equal(path.options.default, null, "definitions compose live unless told otherwise");
  const doc = new ReportDefinition({ name: "x", renderSource: "record" });
  assert.equal(doc.renderSource, "record", "the value must survive assignment");
});

// ── the routing branch in runDefinition ────────────────────────────────────

test("runDefinition routes a record-sourced definition to the renderer, not the composer", () => {
  // Source-level, because runDefinition's live path gathers against Logics,
  // CallRail and RingCentral and must never be invoked from a test.
  const source = require("node:fs").readFileSync(
    require.resolve("../../packages/shared-services/src/reportDefinitionService"), "utf8",
  );
  assert.match(source, /canRenderFromRecord\(def, range\)/,
    "the guard decides, so a tenant-scoped definition cannot reach the record");
  assert.match(source, /renderFromRecord\(\{/);
  // The composer must remain the DEFAULT — a definition with no renderSource
  // is untouched by any of this.
  assert.match(source, /recordVerdict\.ok[\s\S]{0,600}?composeReport\(\{/,
    "compose is the else branch, not the removed branch");
  // A missing record must throw rather than send.
  assert.match(source, /no DailyReportFact exists for/);
});

// ── AUDIT FIXES ────────────────────────────────────────────────────────────

test("a multi-day range is eligible for the stored long-tail reader", () => {
  // The record is a day. A last7 or monthly definition pointed at it would
  // silently render range.from alone and mail a one-day report under a
  // seven-day subject line.
  const def = { renderSource: "record", domain: null, filters: [] };
  assert.equal(canRenderFromRecord(def, { from: "2026-08-01", to: "2026-08-07" }).ok, true);
  assert.equal(canRenderFromRecord(def, { from: "2026-08-05", to: "2026-08-05" }).ok, true);
  assert.equal(canRenderFromRecord(def).ok, true, "no range supplied means the caller checks");
});

test("emailAcceptedAt null STAYS null — never the Unix epoch", () => {
  // The scheduler writes the record before the send with emailAcceptedAt: null
  // on purpose; new Date(null) is 1970-01-01, so a bounced night carried an
  // "acceptance" that reads as delivered to anything checking presence.
  const { buildDailyReportFact, REQUIRED_SECTIONS, CANONICAL_DEFINITION_NAME } = require(
    "../../packages/shared-services/src/dailyReportFactService",
  );
  const report = {
    from: "2026-08-05", to: "2026-08-05", domain: "ALL",
    selection: REQUIRED_SECTIONS.slice(),
    sections: REQUIRED_SECTIONS.map((id) => ({ id, label: id, data: {} })),
    failures: [], advisories: [], notes: [], spend: null,
  };
  const fact = buildDailyReportFact({
    dateKey: "2026-08-05", definitionName: CANONICAL_DEFINITION_NAME,
    report, emailAcceptedAt: null,
  });
  assert.equal(fact.emailAcceptedAt, null);
  const stamped = buildDailyReportFact({
    dateKey: "2026-08-05", definitionName: CANONICAL_DEFINITION_NAME,
    report, emailAcceptedAt: new Date("2026-08-06T03:10:00Z"),
  });
  assert.equal(stamped.emailAcceptedAt.toISOString(), "2026-08-06T03:10:00.000Z");
});
