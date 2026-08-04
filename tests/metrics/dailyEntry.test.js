"use strict";

// The daily entry worker. Sequential gatherers, one in-memory object, one post.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildDailyEntry } = require("../../packages/shared-services/src/dailyEntryService");

// `existingFacts` is what the day already holds — the worker reads it to honour
// the write-once rule before deciding what to set.
const fakeModel = (captured, existingFacts = {}) => ({
  findOne: () => ({ select: () => ({ lean: async () => ({ facts: existingFacts }) }) }),
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

test("every section is SANITIZED — the entry is statistics, not a customer store", async () => {
  // Caught by comparing the worker against the record the email produced for the
  // same day: statusMovement arrived carrying keyChanges[].caseId and byAgent
  // carried connectRate. The email's writer had always sanitized; this one had
  // not, so it would have written customer case ids into the day.
  const r = await buildDailyEntry({
    dateKey: "2026-08-03",
    gatherers: {
      statusMovement: async () => ({
        suspended: 4,
        keyChanges: [{ domain: "WYNN", caseId: 103266, lane: "suspended" }],
      }),
      byAgent: async () => ({ dials: 120, connectRate: 10.6 }),
      calls: async () => ({ links: 73, phone: "5625551234" }),
    },
  });
  assert.equal(r.facts.statusMovement.suspended, 4, "the statistic survives");
  assert.ok(!("keyChanges" in r.facts.statusMovement), "customer rows must not");
  assert.equal(r.facts.byAgent.dials, 120);
  assert.ok(!("connectRate" in r.facts.byAgent),
    "a per-day ratio must be recomputed by a longer report, never averaged");
  assert.equal(r.facts.calls.links, 73);
  assert.ok(!("phone" in r.facts.calls), "no phone numbers, ever");
});

test("once the day's spend is set, the day is set", async () => {
  // Mickey 2026-08-04: "reading the sheet should only read the day, and once the
  // day is set the day is set — we don't add mail spend to the day more than
  // once." The mail sheet keeps growing after a day closes, so a later read is
  // not a better read: 2026-08-03 was reported at $1,584.48 by the email and
  // read $2,193.96 from the sheet a day later.
  const writes = [];
  const model = {
    findOne: () => ({ select: () => ({ lean: async () => ({ facts: { spend: { total: 1584.48 } } }) }) }),
    findOneAndUpdate: async (f, u) => { writes.push(u); return { revision: 2 }; },
  };
  const r = await buildDailyEntry({
    dateKey: "2026-08-03", apply: true, Model: model,
    gatherers: {
      spend: async () => ({ total: 2193.96 }),
      calls: async () => ({ links: 12 }),
    },
  });
  assert.deepEqual(r.preserved, ["spend"], "the stored day is reported as kept");
  assert.ok(!("facts.spend" in writes[0].$set), "spend must not be rewritten");
  assert.equal(writes[0].$set["facts.calls"].links, 12, "other sections still update");
});

test("a day with no spend yet accepts one", async () => {
  const writes = [];
  const model = {
    findOne: () => ({ select: () => ({ lean: async () => ({ facts: {} }) }) }),
    findOneAndUpdate: async (f, u) => { writes.push(u); return { revision: 1 }; },
  };
  const r = await buildDailyEntry({
    dateKey: "2026-08-03", apply: true, Model: model,
    gatherers: { spend: async () => ({ total: 1584.48 }) },
  });
  assert.deepEqual(r.preserved, []);
  assert.equal(writes[0].$set["facts.spend"].total, 1584.48);
});

test("a frozen section can be corrected DELIBERATELY, never by accident", async () => {
  const writes = [];
  const model = {
    findOne: () => ({ select: () => ({ lean: async () => ({ facts: { spend: { total: 1 } } }) }) }),
    findOneAndUpdate: async (f, u) => { writes.push(u); return { revision: 3 }; },
  };
  const r = await buildDailyEntry({
    dateKey: "2026-08-03", apply: true, Model: model, overwrite: ["spend"],
    gatherers: { spend: async () => ({ total: 2193.96 }) },
  });
  assert.deepEqual(r.preserved, [], "nothing preserved when the caller asked to overwrite");
  assert.equal(writes[0].$set["facts.spend"].total, 2193.96);
});
