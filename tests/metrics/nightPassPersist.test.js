"use strict";

// The attribution stamp writes through `$set: {...t}`, so anything it sets to
// null OVERWRITES a stored value. Attribution can only ever be filled in or
// corrected — never erased by a night whose lookups happened to fail.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const SRC = fs.readFileSync(
  require.resolve("../../packages/shared-services/src/nightPassService"), "utf8",
);

test("the stamp never assigns a bare null over officerAtSale/sourceAtSale", () => {
  // The old form was `t.officerAtSale = entry.officer || null` — on a re-run
  // whose CaseInfo/CallRail block threw (it catches its own errors and leaves
  // entry.source null) that wrote null straight over a good snapshot.
  assert.ok(!SRC.includes("t.officerAtSale = entry.officer || null"),
    "officerAtSale must not be assigned `|| null`");
  assert.ok(!SRC.includes("t.sourceAtSale = entry.source || null"),
    "sourceAtSale must not be assigned `|| null`");
  assert.ok(SRC.includes("if (entry.officer) t.officerAtSale = entry.officer;"),
    "the stamp must be conditional on having a value");
  assert.ok(SRC.includes("if (entry.source) t.sourceAtSale = entry.source;"),
    "the stamp must be conditional on having a value");
});

test("persistOnly collects pending writes so a caller need not re-derive them", () => {
  assert.ok(SRC.includes("night.pending.events.push"), "events must be collected");
  assert.ok(SRC.includes("night.pending.truths.push"), "truths must be collected");
  // Collected only in dry mode; when apply is true the pass persists directly.
  assert.ok(SRC.includes("if (persistOnly && !apply)"),
    "pending writes are collected only when nothing was written");
});

test("both business-critical writes execute BEFORE the persistOnly return", () => {
  // The whole safety property of the split, asserted structurally so a future
  // edit that moves either write past the gate fails here instead of silently
  // losing attribution for every night after the change.
  const gate = SRC.indexOf("if (persistOnly) {");
  assert.ok(gate > 0, "the persistOnly gate must exist");
  for (const call of ["insertActivityEvents(", "persistPaymentTruths("]) {
    const at = SRC.indexOf(call);
    assert.ok(at > 0 && at < gate, `${call} must run BEFORE the persistOnly return`);
  }
});

test("eventsPersisted is actually recorded, not discarded", () => {
  // It is the only operator-facing signal that ActivityEvent persistence
  // happened. The insert result was discarded, so it read 0 forever.
  assert.ok(SRC.includes("eventsPersisted: 0"), "the counter must be declared");
  assert.ok(SRC.includes("night.counters.eventsPersisted += ins.inserted || 0"),
    "the counter must be fed from the insert result");
});

// ── the officer fallback ─────────────────────────────────────────────────

const {
  classifyRow,
} = require("../../packages/shared-services/src/activityEventService");

test("classifyRow reads ActivitySubject/Type — the getActivities shape must be mapped", () => {
  // getActivities returns Subject/ActivityType; classifyRow reads the
  // ActivityReport shape. Passing the raw row classified as "unclassified"
  // and the officer fallback silently found nothing.
  const raw = { Subject: "Assigned to Set. Officer : Phil Olson", ActivityType: "General" };
  assert.equal(classifyRow(raw).kind, "unclassified", "the raw shape does NOT classify");

  const mapped = { ActivitySubject: raw.Subject, Type: raw.ActivityType };
  const cls = classifyRow(mapped);
  assert.equal(cls.kind, "assignment");
  assert.equal(cls.payload.role, "Set. Officer");
  assert.equal(cls.payload.assignee, "Phil Olson");
});

test("the officer fallback maps the row shape before classifying", () => {
  // Structural: the fallback must not pass getActivities rows straight in.
  const i = SRC.indexOf("const history = unwrapLogics(await client.getActivities(deal.caseId));");
  assert.ok(i > 0, "the history fallback must exist");
  const body = SRC.slice(i, i + 1400);
  assert.ok(body.includes("ActivitySubject: row.Subject"),
    "must map Subject -> ActivitySubject");
  assert.ok(body.includes("Type: row.ActivityType"),
    "must map ActivityType -> Type");
});

test("the officer fallback never takes an assignment made AFTER the sale", () => {
  // Attribution AT SALE: whoever held the case when it closed, never someone
  // assigned days later during servicing.
  const i = SRC.indexOf("const history = unwrapLogics(await client.getActivities(deal.caseId));");
  const body = SRC.slice(i, i + 1400);
  assert.ok(body.includes("if (day && day > dateKey) continue;"),
    "assignments after the close day must be skipped");
});

test("the officer fallback only runs when the day's fold found nothing", () => {
  // It costs one Logics call per deal. It must be a fallback, not a default.
  const i = SRC.indexOf("const history = unwrapLogics(await client.getActivities(deal.caseId));");
  const before = SRC.slice(Math.max(0, i - 700), i);
  assert.ok(before.includes("if (!entry.officer)"),
    "the history lookup must be guarded on having no officer yet");
});
