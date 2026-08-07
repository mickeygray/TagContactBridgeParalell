"use strict";

// CR-6 — the composite source.
//
// The integration is one wrapper, so the tests are about the three ways a
// wrapper can quietly break the loop it wraps: starving the base source,
// losing its place, or emitting a case the base already owns.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCallRecoveryCompositeSource } = require(
  "../../packages/shared-services/src/callRecoveryCompositeSource");

const NOW = new Date("2026-08-03T18:00:00Z");

const EPISODE = (n) => ({
  episodeId: `ep:${n}`, programKey: "callrail-mail-long-call-v1",
  domain: "TAG", caseId: String(1000 + n), normalizedPhone: "7249674387",
  state: "eligible",
  firstQualifyingCallAt: new Date("2026-07-30T18:00:00Z"),
  eligibleFrom: new Date("2026-07-31T14:50:00Z"),
  expiresAt: new Date("2026-11-27T18:00:00Z"),
});

const ADMITTABLE = {
  caseState: { allowedProspectStatus: true, convertedAt: null, paymentCount: 0, totalPaid: 0 },
  dncState: { result: "clean", checkedAt: new Date("2026-08-02T18:00:00Z") },
  contactWindowOpen: true,
  existingWorkItem: null,
};

function harness({ cadencePages = [[]], episodes = [], delivery = true, inputs = ADMITTABLE } = {}) {
  let page = 0;
  const base = {
    async readBatch() {
      const items = cadencePages[page] || [];
      const done = page >= cadencePages.length - 1;
      page += 1;
      return { items, nextCursor: done ? null : `c${page}`, done };
    },
  };
  const repository = {
    async listEpisodesForConsideration({ after, limit }) {
      const start = after ? episodes.findIndex((e) => e.episodeId === after) + 1 : 0;
      return episodes.slice(start, start + Math.min(limit, 2));
    },
    async findActiveEpisode(domain, caseId) {
      return episodes.find((episode) => (
        episode.domain === String(domain).toUpperCase()
        && String(episode.caseId) === String(caseId)
      )) || null;
    },
  };
  const decisions = [];
  const src = createCallRecoveryCompositeSource({
    base, repository,
    activation: { delivery },
    resolveAdmissionInputs: async () => inputs,
    onDecision: (d) => decisions.push(d),
  });
  return { src, decisions };
}

async function drain(src) {
  const all = [];
  let cursor = null;
  for (let i = 0; i < 20; i += 1) {
    const b = await src.readBatch({ cursor, limit: 250, now: NOW });
    all.push(...(b.items || []));
    if (b.done) return all;
    cursor = b.nextCursor;
  }
  throw new Error("cursor never completed — the composite is looping");
}

test("cadence drains FIRST — recovery can never starve fresh leads", async () => {
  // Fresh bought leads are perishable; a recovery episode is good for 120 days.
  const { src } = harness({
    cadencePages: [[{ caseId: "fresh-1" }], [{ caseId: "fresh-2" }]],
    episodes: [EPISODE(1)],
  });
  const items = await drain(src);
  assert.deepEqual(items.slice(0, 2).map((i) => i.caseId), ["fresh-1", "fresh-2"]);
  assert.equal(items.at(-1).sourceKind, "call_recovery");
});

test("the cursor SURVIVES the runtime's two-scalar persistence and resumes in the right half", async () => {
  // leadDeliveryService does not store the cursor object — it stores
  // repairCursorCreatedAt (Date) and repairCursorId (String) and rebuilds
  // {createdAt, id} on resume. The first codec returned {kind, inner}, which
  // has neither field: both scalars persisted as undefined, every incomplete
  // page lost its position, and recovery restarted at page one each tick. So
  // the assertion here is the ROUND TRIP, not the in-memory shape.
  const { src } = harness({ cadencePages: [[]], episodes: [EPISODE(1), EPISODE(2), EPISODE(3)] });
  const first = await src.readBatch({ cursor: null, limit: 250, now: NOW });
  assert.equal(first.done, false);
  assert.equal(typeof first.nextCursor.id, "string", "the cursor must fit repairCursorId");
  assert.ok(first.nextCursor.createdAt instanceof Date, "and repairCursorCreatedAt");
  assert.match(first.nextCursor.id, /^recovery:/, "the id prefix says WHICH half it is walking");

  // The exact persistence round trip the runtime performs.
  const persisted = {
    createdAt: new Date(first.nextCursor.createdAt),
    id: String(first.nextCursor.id),
  };
  const second = await src.readBatch({ cursor: persisted, limit: 250, now: NOW });
  const ids = [...first.items, ...second.items].map((i) => i.episodeId);
  assert.equal(new Set(ids).size, ids.length, "a persisted-and-rebuilt cursor must not repeat a row");
});

test("a cadence cursor passes through UNMARKED — the persisted legacy shape resumes", async () => {
  // The cadence inner cursor already IS {createdAt, id}; wrapping it would
  // break every cursor persisted before the composite existed.
  const { src } = harness({
    cadencePages: [[{ caseId: "a" }], [{ caseId: "b" }]], episodes: [],
  });
  const first = await src.readBatch({ cursor: null, limit: 250, now: NOW });
  // Whatever the base emits passes through IDENTICALLY — no wrapper object, so
  // nothing exists for the two-scalar persistence to drop.
  assert.equal(first.nextCursor, "c1", "the base's own cursor, untouched");
});

test("a legacy bare cursor still resumes the cadence half", async () => {
  // The composite has to be droppable into a pass that started before it
  // existed, or arming it mid-day loses whatever the loop was walking.
  const { src } = harness({ cadencePages: [[{ caseId: "a" }], [{ caseId: "b" }]] });
  const b = await src.readBatch({ cursor: "legacy-cursor-string", limit: 250, now: NOW });
  assert.deepEqual(b.items.map((i) => i.caseId), ["a"]);
});

test("cadence-to-recovery handoff preserves the base high-water", async () => {
  const highWater = { createdAt: NOW, id: "cadence-high-water" };
  const src = createCallRecoveryCompositeSource({
    base: {
      readBatch: async () => ({ items: [], nextCursor: null, done: true, highWater }),
    },
    repository: { listEpisodesForConsideration: async () => [] },
    activation: { delivery: true },
    resolveAdmissionInputs: async () => ADMITTABLE,
  });
  const batch = await src.readBatch({ now: NOW });
  assert.deepEqual(batch.highWater, highWater);
  assert.equal(batch.done, true);
});

test("nothing recovery-shaped is emitted while delivery is dark", async () => {
  const { src } = harness({ episodes: [EPISODE(1), EPISODE(2)], delivery: false });
  const items = await drain(src);
  assert.equal(items.filter((i) => i.sourceKind === "call_recovery").length, 0);
});

test("disarming mid-walk stops on the NEXT page, not the next restart", async () => {
  // A kill switch that only takes effect on restart is not a kill switch.
  const base = { async readBatch() { return { items: [], nextCursor: null, done: true }; } };
  const repository = {
    async listEpisodesForConsideration() { return [EPISODE(1), EPISODE(2)]; },
  };
  const activation = { delivery: true };
  const src = createCallRecoveryCompositeSource({
    base, repository, activation,
    resolveAdmissionInputs: async () => ADMITTABLE,
  });
  const first = await src.readBatch({ cursor: null, limit: 250, now: NOW });
  assert.ok(first.items.length > 0);
  activation.delivery = false;
  const second = await src.readBatch({ cursor: first.nextCursor, limit: 250, now: NOW });
  assert.deepEqual(second.items, []);
  assert.equal(second.done, true);
});

test("admission runs on EVERY pass, not once at discovery", async () => {
  // A clean nightly snapshot cannot authorize a call this afternoon.
  const { src, decisions } = harness({
    episodes: [EPISODE(1)],
    inputs: { ...ADMITTABLE, caseState: { allowedProspectStatus: true, paymentCount: 1 } },
  });
  const items = await drain(src);
  assert.equal(items.length, 0, "a case that has since paid must not be emitted");
  assert.equal(decisions[0].decision.decision, "terminal");
  assert.equal(decisions[0].decision.reason, "paid");
});

test("an unreadable admission input HOLDS — it never falls through as admitted", async () => {
  const base = { async readBatch() { return { items: [], nextCursor: null, done: true }; } };
  const repository = { async listEpisodesForConsideration() { return [EPISODE(1)]; } };
  const seen = [];
  const src = createCallRecoveryCompositeSource({
    base, repository, activation: { delivery: true },
    resolveAdmissionInputs: async () => { throw new Error("Logics timeout"); },
    onDecision: (d) => seen.push(d.decision),
  });
  const b = await src.readBatch({ cursor: null, limit: 250, now: NOW });
  assert.deepEqual(b.items, []);
  assert.equal(seen[0].decision, "hold");
  assert.equal(seen[0].retryable, true);
});

test("admission cannot be skipped by omitting the resolver", () => {
  assert.throws(() => createCallRecoveryCompositeSource({
    base: { readBatch: async () => ({ items: [], done: true }) },
    repository: {}, activation: { delivery: true },
  }), /admission cannot be skipped/);
});

test("the rest of the source interface passes through", async () => {
  const base = {
    readBatch: async () => ({ items: [], nextCursor: null, done: true }),
    readOne: async () => ({ caseId: "one" }),
    readWindowBatch: async () => ({ items: ["w"] }),
  };
  const src = createCallRecoveryCompositeSource({
    base, repository: { listEpisodesForConsideration: async () => [] },
    activation: { delivery: true }, resolveAdmissionInputs: async () => ADMITTABLE,
  });
  assert.deepEqual(await src.readOne(), { caseId: "one" });
  assert.deepEqual(await src.readWindowBatch(), { items: ["w"] });
});

test("claim-time readOne falls back to an admitted recovery episode", async () => {
  const episode = EPISODE(7);
  const { src } = harness({ episodes: [episode] });
  const row = await src.readOne({ domain: episode.domain, caseId: episode.caseId, now: NOW });
  assert.equal(row.episodeId, episode.episodeId);
  assert.equal(row.sourceKind, "call_recovery");
  assert.equal(row.state, "eligible");
});

test("claim-time readOne fails closed when recovery admission no longer passes", async () => {
  const episode = EPISODE(8);
  const { src } = harness({
    episodes: [episode],
    inputs: { ...ADMITTABLE, caseState: { ...ADMITTABLE.caseState, paymentCount: 1 } },
  });
  assert.equal(await src.readOne({ domain: episode.domain, caseId: episode.caseId, now: NOW }), null);
});

test("durable new-arrival reads retain the cadence high-water and append recovery", async () => {
  const episode = EPISODE(9);
  const base = {
    readBatch: async () => ({ items: [], nextCursor: null, done: true }),
    readNewerBatch: async ({ after }) => ({
      items: [{ caseId: "fresh" }],
      nextHighWater: { createdAt: NOW, id: "fresh-1" },
      done: true,
      after,
    }),
  };
  const repository = {
    listEpisodesForConsideration: async (input) => {
      assert.equal(input.unlinkedOnly, true);
      return [episode];
    },
    findActiveEpisode: async () => episode,
  };
  const src = createCallRecoveryCompositeSource({
    base,
    repository,
    activation: { delivery: true },
    resolveAdmissionInputs: async () => ADMITTABLE,
  });
  const result = await src.readNewerBatch({
    after: { createdAt: new Date("2026-08-03T17:00:00Z"), id: "old" },
    limit: 10,
    now: NOW,
  });
  assert.deepEqual(result.items.map((item) => item.caseId), ["fresh", episode.caseId]);
  assert.equal(result.nextHighWater.id, "fresh-1");
});

test("the tick's recovery walk is BOUNDED — it is a provider budget", async () => {
  // Every episode on a page costs a live Logics getCaseInfo through
  // resolveAdmissionInputs. The first cut of the starvation fix walked up to 20
  // pages inline, which turned a persistent held head into up to a thousand
  // provider calls per 60-second tick that admitted nothing — and callEndPulse
  // runs this same walk while an agent waits for a refill.
  //
  // Starvation is now relieved by the durable hold cooldown (a held episode
  // drops out of the listing), not by paging past the head every tick.
  const all = Array.from({ length: 400 }, (_, i) => ({
    ...EPISODE(i), episodeId: `ep:${String(i).padStart(4, "0")}`, caseId: `c-${i}`,
  }));
  let evaluated = 0;
  const src = createCallRecoveryCompositeSource({
    base: {
      readBatch: async () => ({ items: [], nextCursor: null, done: true }),
      readNewerBatch: async () => ({ items: [], nextHighWater: null, done: true }),
    },
    repository: {
      listEpisodesForConsideration: async ({ after, limit }) => {
        const start = after ? all.findIndex((e) => e.episodeId === after) + 1 : 0;
        return all.slice(start, start + Math.min(limit, 50));
      },
    },
    activation: { delivery: true },
    resolveAdmissionInputs: async () => {
      evaluated += 1;
      return { ...ADMITTABLE, contactWindowOpen: false }; // everything holds
    },
  });

  await src.readNewerBatch({ after: null, limit: 250, now: NOW });
  assert.ok(evaluated > 0, "it must still look");
  assert.ok(evaluated <= 100,
    `a tick may not evaluate the whole backlog inline; evaluated ${evaluated}`);
});
