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

test("mail is frozen once set; LD and BCD still correct themselves", async () => {
  // Mickey 2026-08-04: "we dont add mail spend to the day more than once" — and
  // then: "the stored spend might include bcd and ld". Freezing the whole
  // section would freeze the wrong two. Mail arrives from a sheet that keeps
  // growing after the day closes; LD and BCD are counted from events we already
  // hold, so a recount is a BETTER answer, not merely a later one.
  const writes = [];
  const model = {
    findOne: () => ({ select: () => ({ lean: async () => ({ facts: {
      spend: { total: 2039.48, mail: 1584.48, mailPieces: 1800, ld: 423, bcd: 32 },
    } }) }) }),
    findOneAndUpdate: async (f, u) => { writes.push(u); return { revision: 2 }; },
  };
  const r = await buildDailyEntry({
    dateKey: "2026-08-03", apply: true, Model: model,
    gatherers: {
      // The sheet grew AND a late lead event landed.
      spend: async () => ({ total: 2675.96, mail: 2193.96, mailPieces: 2438, ld: 450, bcd: 32 }),
    },
  });
  const stored = writes[0].$set["facts.spend"];
  assert.equal(stored.mail, 1584.48, "mail holds — a later sheet read is not a better one");
  assert.equal(stored.mailPieces, 1800);
  assert.equal(stored.ld, 450, "LD corrects — a late lead event is a better count");
  assert.deepEqual(r.preserved, ["spend.mail", "spend.mailPieces"], "and it says what it kept");

  // The whole point of recomputing rather than freezing the total: a frozen
  // mail figure beside a fresh LD figure makes any stored total wrong.
  assert.equal(stored.total, 2066.48);
  assert.equal(stored.total, Math.round((stored.mail + stored.ld + stored.bcd) * 100) / 100,
    "total must always equal its own parts");
});

test("a day with no spend yet accepts one whole", async () => {
  const writes = [];
  const r = await buildDailyEntry({
    dateKey: "2026-08-03", apply: true, Model: fakeModel(writes),
    gatherers: { spend: async () => ({ total: 1584.48, mail: 1584.48 }) },
  });
  assert.deepEqual(r.preserved, []);
  // fakeModel captures {filter, update, opts} — the raw update is one level in.
  assert.equal(writes[0].update.$set["facts.spend"].mail, 1584.48);
});

test("a frozen field can be corrected DELIBERATELY, never by accident", async () => {
  const writes = [];
  const model = {
    findOne: () => ({ select: () => ({ lean: async () => ({ facts: { spend: { mail: 1, total: 1 } } }) }) }),
    findOneAndUpdate: async (f, u) => { writes.push(u); return { revision: 3 }; },
  };
  const r = await buildDailyEntry({
    dateKey: "2026-08-03", apply: true, Model: model, overwrite: ["spend"],
    gatherers: { spend: async () => ({ total: 2193.96, mail: 2193.96 }) },
  });
  assert.deepEqual(r.preserved, []);
  assert.equal(writes[0].$set["facts.spend"].mail, 2193.96);
});

test("the entry keeps BOTH views: facts aggregates, detail is complete", async () => {
  // Mickey 2026-08-04: "it needs to be a complete useful snapshot — needs the
  // urls, needs the case ids, because if it works for a day ... it'll work for a
  // week or a month or a year."
  //
  // Kept as two views rather than by relaxing `facts`, because they are read for
  // different reasons: `facts` is summed across a range, and that path should
  // not drag customer identifiers through it; `detail` is opened for ONE day,
  // when somebody wants the calls and cases behind a number.
  const writes = [];
  await buildDailyEntry({
    dateKey: "2026-08-03", apply: true, Model: fakeModel(writes),
    gatherers: {
      statusMovement: async () => ({ suspended: 4, keyChanges: [{ caseId: 103266 }] }),
      calls: async () => ({ links: 73, rows: [{ caseId: 812345, listenUrl: "https://x/rec" }] }),
    },
  });
  const set = writes[0].update.$set;
  assert.equal(set["facts.statusMovement"].suspended, 4);
  assert.ok(!("keyChanges" in set["facts.statusMovement"]), "facts stays aggregation-safe");
  assert.equal(set["detail.statusMovement"].keyChanges[0].caseId, 103266, "detail is complete");
  assert.equal(set["detail.calls"].rows[0].listenUrl, "https://x/rec", "and keeps the urls");
});

test("both views agree about a frozen day's cost", async () => {
  // The two views must never disagree about money. detail copies the MERGED
  // spend rather than re-deriving it, so a frozen mail figure is frozen in both.
  const writes = [];
  const model = {
    findOne: () => ({ select: () => ({ lean: async () => ({ facts: {
      spend: { total: 2039.48, mail: 1584.48, ld: 423, bcd: 32 },
    } }) }) }),
    findOneAndUpdate: async (f, u) => { writes.push(u); return { revision: 2 }; },
  };
  await buildDailyEntry({
    dateKey: "2026-08-03", apply: true, Model: model,
    gatherers: { spend: async () => ({ total: 2675.96, mail: 2193.96, ld: 450, bcd: 32 }) },
  });
  const set = writes[0].$set;
  assert.equal(set["facts.spend"].mail, 1584.48);
  assert.deepEqual(set["detail.spend"], set["facts.spend"],
    "detail must carry the same frozen cost, not a re-derived one");
});
