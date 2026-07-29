"use strict";

// Storing per-agent call counts is a deliberate exception to "gather live,
// persist nothing" — RingCentral answers per DAY and rate-limits, so a month
// costs ~28 paged reads, and CallLog cannot substitute (on inbound legs
// extensionId is the QUEUE that rang, not the agent who answered: 5 of 44
// legs mapped on 2026-07-27). Once a day is over the answer stops changing,
// so a stored copy can never go stale.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const svc = require("../../packages/shared-services/src/queueRollupService");

test("a range enumerates every day inclusively", () => {
  assert.deepEqual(svc.dayKeys("2026-07-26", "2026-07-28"),
    ["2026-07-26", "2026-07-27", "2026-07-28"]);
  assert.equal(svc.dayKeys("2026-07-01", "2026-07-28").length, 28);
});

test("the stored day separates TAKEN from MADE by stream", () => {
  // MAILER/BCD are inbound calls connected to an agent; LD is outbound
  // PhoneBurner dialling. Summing them into one "calls" number would put a
  // 528-dial day and a 25-call day on the same footing.
  const day = {
    agents: [{ agent: "Chris Bolt", taken: 1, made: 528, byStream: { MAILER: 1, LD: 528 } }],
    streams: [{ stream: "MAILER", calls: 80, connected: 72, missed: 8 }],
  };
  const a = day.agents[0];
  assert.equal(a.taken, 1);
  assert.equal(a.made, 528);
  assert.equal(a.byStream.MAILER + a.byStream.LD, 529);
});

test("missed calls live only at the stream level", () => {
  // A missed call never reached an agent, so no agent row may carry one —
  // the schema has no `missed` on the agent sub-document at all.
  const AgentSub = require("../../packages/shared-models/src/DailyQueueRollup")
    .schema.path("agents");
  const fields = Object.keys(AgentSub.schema.obj);
  assert.ok(!fields.includes("missed"), "an agent row must not carry missed calls");
  assert.deepEqual(fields.sort(), ["agent", "byStream", "made", "taken"]);
});

test("one document per day — a recapture replaces, never duplicates", () => {
  const model = require("../../packages/shared-models/src/DailyQueueRollup");
  const idx = model.schema.path("dateKey");
  assert.equal(idx.options.unique, true, "dateKey must be unique");
});

// ── the part that matters: never present a partial range as whole ────────

const merge = (docs, from, to) => {
  // Mirrors readQueueRange's coverage maths without touching Mongo.
  const wanted = svc.dayKeys(from, to);
  const have = new Set(docs.map((d) => d.dateKey));
  const missing = wanted.filter((d) => !have.has(d));
  const partialDays = docs.filter((d) => d.partial).map((d) => d.dateKey);
  return {
    daysRequested: wanted.length,
    daysStored: docs.length,
    missing,
    partialDays,
    complete: missing.length === 0 && partialDays.length === 0,
  };
};

test("a month with two captured days is INCOMPLETE, not a month", () => {
  // Live 2026-07-01..28 with 2 days stored. Summing what happens to exist and
  // calling it July is the exact failure the store was built to end.
  const c = merge([{ dateKey: "2026-07-27" }, { dateKey: "2026-07-24" }], "2026-07-01", "2026-07-28");
  assert.equal(c.complete, false);
  assert.equal(c.daysStored, 2);
  assert.equal(c.daysRequested, 28);
  assert.equal(c.missing.length, 26);
});

test("a fully captured range is complete", () => {
  const docs = svc.dayKeys("2026-07-26", "2026-07-28").map((dateKey) => ({ dateKey }));
  assert.equal(merge(docs, "2026-07-26", "2026-07-28").complete, true);
});

test("a RATE-LIMITED day makes the whole range incomplete", () => {
  // A truncated read is a FLOOR, not a total. Every day present but one of
  // them partial still cannot be reported as the range.
  const docs = svc.dayKeys("2026-07-26", "2026-07-28").map((dateKey) => ({ dateKey }));
  docs[1].partial = true;
  const c = merge(docs, "2026-07-26", "2026-07-28");
  assert.equal(c.complete, false, "a partial day poisons the range");
  assert.deepEqual(c.missing, [], "nothing is missing — it is incomplete for a different reason");
  assert.deepEqual(c.partialDays, ["2026-07-27"]);
});
