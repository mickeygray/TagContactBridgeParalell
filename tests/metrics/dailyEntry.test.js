"use strict";

// The daily entry worker. Sequential gatherers, one in-memory object, one post.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildDailyEntry } = require("../../packages/shared-services/src/dailyEntryService");

const fakeModel = (captured) => ({
  findOneAndUpdate: async (filter, update, opts) => {
    captured.push({ filter, update, opts });
    return { revision: 1 };
  },
});

test("a gatherer that throws leaves ITS section null and costs no other", async () => {
  const r = await buildDailyEntry({
    dateKey: "2026-08-03",
    gatherers: {
      spend: async () => ({ total: 100 }),
      calls: async () => { throw new Error("CallRail 503"); },
      activity: async () => ({ rowsScanned: 9 }),
    },
  });
  assert.deepEqual(r.facts.spend, { total: 100 });
  assert.deepEqual(r.facts.activity, { rowsScanned: 9 });
  assert.equal(r.facts.calls, null);
  assert.match(r.errors[0], /calls: CallRail 503/);
});

test("a section that did not run is NULL, never an empty object", async () => {
  // null = "did not run / could not read". {} = "ran, found nothing". Reading
  // one as the other is how a failed gather becomes a quiet day.
  const r = await buildDailyEntry({ dateKey: "2026-08-03", gatherers: { spend: async () => ({}) } });
  assert.deepEqual(r.facts.spend, {}, "an empty ANSWER is preserved");
  assert.equal(r.facts.calls, null, "an absent gatherer is null");
  assert.ok(r.sectionsMissing.includes("calls"));
  assert.ok(r.sectionsGathered.includes("spend"));
});

test("a gatherer returning undefined stores null rather than dropping the key", async () => {
  const r = await buildDailyEntry({ dateKey: "2026-08-03", gatherers: { spend: async () => undefined } });
  assert.ok("spend" in r.facts, "the key must exist");
  assert.equal(r.facts.spend, null);
});

test("nothing is posted unless apply is set", async () => {
  const writes = [];
  const r = await buildDailyEntry({
    dateKey: "2026-08-03", Model: fakeModel(writes),
    gatherers: { spend: async () => ({ total: 1 }) },
  });
  assert.equal(writes.length, 0);
  assert.equal(r.posted, false);
});

test("ONE post, upserted on the day, with report-owned fields set only on insert", async () => {
  const writes = [];
  await buildDailyEntry({
    dateKey: "2026-08-03", apply: true, Model: fakeModel(writes),
    gatherers: { spend: async () => ({ total: 1 }), calls: async () => ({ links: 2 }) },
  });
  assert.equal(writes.length, 1, "one write, not one per section");
  const { filter, update, opts } = writes[0];
  assert.deepEqual(filter, { dateKey: "2026-08-03" });
  assert.equal(opts.upsert, true, "upsert so a day with no report still gets an entry");
  assert.equal(update.$set["facts.spend"].total, 1);
  assert.equal(update.$set["facts.calls"].links, 2);
  // definitionName and emailAcceptedAt belong to the report path once it runs.
  // A worker re-run must never overwrite them with its placeholders.
  assert.ok(!("definitionName" in update.$set));
  assert.ok(!("emailAcceptedAt" in update.$set));
  assert.equal(update.$setOnInsert.definitionName, "daily entry");
  assert.equal(update.$setOnInsert.emailAcceptedAt, null);
});

test("a malformed dateKey throws rather than writing somewhere unexpected", async () => {
  await assert.rejects(() => buildDailyEntry({ dateKey: "8/3/2026" }), /YYYY-MM-DD/);
  await assert.rejects(() => buildDailyEntry({}), /YYYY-MM-DD/);
});
