"use strict";

// CR-2 gate: the model and the atomic repository.
//
// Everything here is about the same class of bug — two things touching one
// episode at the same time, or the same thing touching it twice. A nightly
// discovery task, a delivery tick and a callback drain all write these records,
// and processes restart mid-pass, so "it worked when I ran it once" proves
// nothing.
//
// Mongo is stubbed at the model boundary. What is under test is the repository's
// ORDER OF OPERATIONS and its guards, not mongoose.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const MODEL_PATH = require.resolve("../../packages/shared-models/src/CallRecoveryLead");
const REPO_PATH = require.resolve("../../packages/shared-repositories/src/callRecoveryLeadRepository");

const real = require(MODEL_PATH);

/**
 * A tiny in-memory stand-in for the collection, with the two unique indexes
 * that actually carry the invariants:
 *   - one active episode per (programKey, domain, caseId)
 *   - one episodeId
 */
function makeFakeModel() {
  const rows = [];
  const match = (row, q) => Object.entries(q).every(([k, v]) => {
    const actual = k.includes(".")
      ? k.split(".").reduce((o, part) => (o == null ? o : o[part]), row)
      : row[k];
    if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
      if ("$in" in v) return v.$in.includes(actual);
      if ("$nin" in v) return !v.$nin.includes(actual);
      if ("$ne" in v) return actual !== v.$ne;
      if ("$lte" in v) return actual != null && actual <= v.$lte;
      if ("$gt" in v) return actual != null && actual > v.$gt;
      return true;
    }
    if (Array.isArray(actual)) return actual.includes(v);
    return actual === v;
  });

  const model = {
    _rows: rows,
    async create(doc) {
      const dup = rows.find((r) => r.episodeId === doc.episodeId
        || (doc.activeEpisode === true && r.activeEpisode === true
          && r.programKey === doc.programKey && r.domain === doc.domain && r.caseId === doc.caseId));
      if (dup) { const e = new Error("E11000 duplicate key"); e.code = 11000; throw e; }
      const row = { ...doc, _id: `id-${rows.length + 1}`, qualifyingCallIds: [...(doc.qualifyingCallIds || [])] };
      rows.push(row);
      return { toObject: () => ({ ...row }) };
    },
    findOne(q) {
      let list = rows.filter((r) => match(r, q));
      const api = {
        sort(spec) {
          const [k, dir] = Object.entries(spec)[0];
          list = [...list].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir);
          return api;
        },
        lean: async () => (list[0] ? { ...list[0] } : null),
        then: (res) => Promise.resolve(list[0] ? { ...list[0] } : null).then(res),
      };
      return api;
    },
    findOneAndUpdate(q, update, opts = {}) {
      const row = rows.find((r) => match(r, q));
      if (!row) return Object.assign(Promise.resolve(null), { lean: async () => null });
      if (update.$set) {
        for (const [k, v] of Object.entries(update.$set)) {
          if (k.includes(".")) {
            const parts = k.split(".");
            let target = row;
            for (const p of parts.slice(0, -1)) { target[p] = target[p] || {}; target = target[p]; }
            target[parts.at(-1)] = v;
          } else row[k] = v;
        }
      }
      if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) row[k] = (row[k] || 0) + v;
      if (update.$unset) for (const k of Object.keys(update.$unset)) delete row[k];
      if (update.$addToSet) {
        for (const [k, v] of Object.entries(update.$addToSet)) {
          row[k] = row[k] || [];
          if (!row[k].includes(v)) row[k].push(v);
        }
      }
      if (update.$max) {
        for (const [k, v] of Object.entries(update.$max)) {
          if (row[k] == null || v > row[k]) row[k] = v;
        }
      }
      if (!opts.new) return Object.assign(Promise.resolve(null), { lean: async () => null });
      const snapshot = { ...row };
      return Object.assign(Promise.resolve(snapshot), { lean: async () => ({ ...snapshot }) });
    },
    async updateOne() { return { acknowledged: true }; },
    find(q) {
      let list = rows.filter((r) => match(r, q));
      const api = {
        sort(spec) {
          const keys = Object.entries(spec);
          list = [...list].sort((a, b) => {
            for (const [k, dir] of keys) {
              const av = k.includes(".") ? k.split(".").reduce((o, p) => o?.[p], a) : a[k];
              const bv = k.includes(".") ? k.split(".").reduce((o, p) => o?.[p], b) : b[k];
              if (av > bv) return dir; if (av < bv) return -dir;
            }
            return 0;
          });
          return api;
        },
        limit(n) { list = list.slice(0, n); return api; },
        lean: async () => list.map((r) => ({ ...r })),
      };
      return api;
    },
    async aggregate() {
      const counts = {};
      for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1;
      return Object.entries(counts).map(([k, n]) => ({ _id: k, n }));
    },
  };
  Object.assign(model, {
    PROGRAM_KEY: real.PROGRAM_KEY,
    STATES: real.STATES,
    TRANSITIONS: real.TRANSITIONS,
    EVIDENCE_CALL_ID_CAP: real.EVIDENCE_CALL_ID_CAP,
    DNC_RESULTS: real.DNC_RESULTS,
  });
  return model;
}

function loadRepo() {
  const model = makeFakeModel();
  const realLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (/CallRecoveryLead$/.test(request)) return model;
    return realLoad.apply(this, [request, parent, isMain]);
  };
  delete require.cache[REPO_PATH];
  let repo;
  try { repo = require(REPO_PATH); } finally {
    Module._load = realLoad;
    delete require.cache[REPO_PATH];
  }
  return { repo, model };
}

const CALL = (over = {}) => ({
  domain: "TAG", caseId: "421385", normalizedPhone: "7249674387",
  providerCallId: "CAL-1", callAt: new Date("2026-07-30T18:00:00Z"), durationSec: 900,
  eligibleFrom: new Date("2026-07-31T15:00:00Z"),
  expiresAt: new Date("2026-11-27T18:00:00Z"),
  sourceDateKey: "2026-07-30",
  ...over,
});

test("the same CallRail call twice is one episode and one piece of evidence", async () => {
  const { repo, model } = loadRepo();
  const first = await repo.recordQualifyingCall(CALL());
  const second = await repo.recordQualifyingCall(CALL());
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.duplicate, true);
  assert.equal(model._rows.length, 1);
  assert.deepEqual(model._rows[0].qualifyingCallIds, ["CAL-1"]);
  assert.deepEqual(model._rows[0].qualifyingDateKeys, ["2026-07-30"]);
});

test("a later qualifying day joins the same episode and remains daily-queryable", async () => {
  const { repo, model } = loadRepo();
  await repo.recordQualifyingCall(CALL());
  await repo.recordQualifyingCall(CALL({
    providerCallId: "CAL-2",
    sourceDateKey: "2026-08-05",
    callAt: new Date("2026-08-05T18:00:00Z"),
  }));
  assert.deepEqual(model._rows[0].qualifyingDateKeys, ["2026-07-30", "2026-08-05"]);
});

test("a second qualifying call joins the OPEN episode without extending its clock", async () => {
  // The 120 days run from the FIRST qualifying call. If a later call moved
  // firstQualifyingCallAt or expiresAt, a case that keeps ringing in would never
  // age out of the program.
  const { repo, model } = loadRepo();
  await repo.recordQualifyingCall(CALL());
  const later = await repo.recordQualifyingCall(CALL({
    providerCallId: "CAL-2",
    callAt: new Date("2026-08-05T18:00:00Z"),
    durationSec: 1500,
  }));
  assert.equal(model._rows.length, 1);
  assert.equal(later.evidenceAdded, true);
  const row = model._rows[0];
  assert.deepEqual(row.qualifyingCallIds, ["CAL-1", "CAL-2"]);
  assert.equal(row.firstQualifyingCallAt.toISOString(), "2026-07-30T18:00:00.000Z");
  assert.equal(row.expiresAt.toISOString(), "2026-11-27T18:00:00.000Z", "the clock must not move");
  assert.equal(row.latestQualifyingCallAt.toISOString(), "2026-08-05T18:00:00.000Z");
  assert.equal(row.maximumObservedDurationSec, 1500, "max duration tracks independently of the cap");
});

test("parallel first discovery produces ONE episode, not two", async () => {
  // Both callers see no open episode and both try to insert. The partial unique
  // index rejects the loser, which must then append evidence rather than retry.
  const { repo, model } = loadRepo();
  const [a, b] = await Promise.all([
    repo.recordQualifyingCall(CALL({ providerCallId: "CAL-A" })),
    repo.recordQualifyingCall(CALL({ providerCallId: "CAL-B" })),
  ]);
  assert.equal(model._rows.length, 1, "two episodes for one case is the invariant this protects");
  assert.equal([a.inserted, b.inserted].filter(Boolean).length, 1, "exactly one insert wins");
  assert.equal(model._rows[0].episodeNumber, 1);
});

test("a new inquiry after expiry becomes episode 2, linked to episode 1", async () => {
  const { repo, model } = loadRepo();
  await repo.recordQualifyingCall(CALL());
  const ep1 = model._rows[0];
  // Expire it the way the sweep would.
  await repo.expireEpisode(ep1.episodeId, { from: "discovered" });
  assert.equal(model._rows[0].activeEpisode, undefined, "expiry frees the active slot");

  const next = await repo.recordQualifyingCall(CALL({ providerCallId: "CAL-9" }));
  assert.equal(next.inserted, true);
  assert.equal(model._rows.length, 2);
  assert.equal(model._rows[1].episodeNumber, 2);
  assert.equal(model._rows[1].supersedesEpisodeId, ep1.episodeId);
  assert.equal(model._rows[1].activeEpisode, true);
});

test("a terminal episode can never be reactivated", async () => {
  const { repo, model } = loadRepo();
  await repo.recordQualifyingCall(CALL());
  const id = model._rows[0].episodeId;
  await repo.transitionState(id, { from: "discovered", to: "terminal", reason: "dnc-hit" });

  for (const to of ["eligible", "active", "held", "awaiting_start", "review"]) {
    assert.throws(() => repo.assertTransitionAllowed("terminal", to), /illegal recovery transition/);
  }
  // And evidence for a terminal case does not resurrect it.
  const after = await repo.recordQualifyingCall(CALL({ providerCallId: "CAL-Z" }));
  assert.equal(after.inserted, true, "it opens a NEW episode rather than touching the terminal one");
  assert.equal(model._rows[0].state, "terminal");
});

test("compare-and-set refuses a stale writer", async () => {
  // The delivery tick read version 0, the callback drain already moved it to 1.
  // The tick must lose, not overwrite a newer verdict.
  const { repo, model } = loadRepo();
  await repo.recordQualifyingCall(CALL());
  const id = model._rows[0].episodeId;

  const won = await repo.transitionState(id, { from: "discovered", to: "awaiting_start", expectedVersion: 0 });
  assert.equal(won.ok, true);
  assert.equal(won.episode.version, 1);

  const stale = await repo.transitionState(id, { from: "awaiting_start", to: "eligible", expectedVersion: 0 });
  assert.equal(stale.ok, false, "a stale version must not win");
  assert.equal(model._rows[0].state, "awaiting_start");
});

test("transitionState cannot be used to rewrite identity or the clock", async () => {
  const { repo, model } = loadRepo();
  await repo.recordQualifyingCall(CALL());
  const id = model._rows[0].episodeId;
  for (const key of ["episodeId", "domain", "caseId", "expiresAt", "version", "firstQualifyingCallAt"]) {
    await assert.rejects(
      () => repo.transitionState(id, { from: "discovered", to: "held", set: { [key]: "x" } }),
      /may not set/,
      `${key} must not be patchable`,
    );
  }
});

test("a DNC hit stops the checkpoint schedule instead of booking another one", async () => {
  const { repo, model } = loadRepo();
  await repo.recordQualifyingCall(CALL());
  const id = model._rows[0].episodeId;

  await repo.recordDncResult(id, { result: "clean", nextCheckAt: new Date("2026-08-29T18:00:00Z") });
  assert.equal(model._rows[0].dnc.result, "clean");
  assert.ok(model._rows[0].dnc.nextCheckAt, "a clean result books the day-30 recheck");

  await repo.recordDncResult(id, { result: "hit", reason: "national-dnc", nextCheckAt: new Date() });
  assert.equal(model._rows[0].dnc.result, "hit");
  assert.equal(model._rows[0].dnc.nextCheckAt, null, "a dead episode must not stay in the sweep");
});

test("a failed DNC lookup is held, never recorded as clean", async () => {
  // "Could not verify" is the single most dangerous thing to round down.
  const { repo, model } = loadRepo();
  await repo.recordQualifyingCall(CALL());
  const id = model._rows[0].episodeId;
  await repo.recordDncResult(id, { result: "failed", reason: "provider-timeout", nextCheckAt: new Date() });
  assert.equal(model._rows[0].dnc.result, "failed");
  assert.notEqual(model._rows[0].dnc.result, "clean");
  assert.throws(() => repo.assertTransitionAllowed("held", "active"),
    /illegal recovery transition/, "held cannot jump straight to active");
});

test("an unchecked episode reads as unknown, not clean", async () => {
  const { repo, model } = loadRepo();
  await repo.recordQualifyingCall(CALL());
  assert.equal(model._rows[0].dnc?.result ?? "unknown", "unknown");
});

test("linking the same canonical work item is idempotent", async () => {
  const { repo } = loadRepo();
  const created = await repo.recordQualifyingCall(CALL());
  const first = await repo.linkLeadDeliveryItem(created.episode.episodeId, "work-1");
  const second = await repo.linkLeadDeliveryItem(created.episode.episodeId, "work-1");
  assert.equal(first.ok, true);
  assert.equal(first.unchanged, false);
  assert.equal(second.ok, true);
  assert.equal(second.unchanged, true);
  assert.equal(second.episode.version, first.episode.version);
});

test("the consideration cursor is deterministic and keyset-paged", async () => {
  const { repo, model } = loadRepo();
  for (let i = 1; i <= 5; i += 1) {
    await repo.recordQualifyingCall(CALL({ caseId: `case-${i}`, providerCallId: `CAL-${i}` }));
    model._rows.at(-1).state = "eligible";
  }
  const asOf = new Date("2026-08-01T18:00:00Z");
  const page1 = await repo.listEpisodesForConsideration({ asOf, limit: 2 });
  const page2 = await repo.listEpisodesForConsideration({ asOf, limit: 2, after: page1.at(-1).episodeId });
  assert.equal(page1.length, 2);
  assert.equal(page2.length, 2);
  const ids = [...page1, ...page2].map((r) => r.episodeId);
  assert.equal(new Set(ids).size, 4, "keyset paging must not repeat a row");
  assert.deepEqual(ids, [...ids].sort(), "and must be stably ordered");
});

test("the cursor excludes anything outside its window", async () => {
  const { repo, model } = loadRepo();
  await repo.recordQualifyingCall(CALL({ caseId: "not-yet", providerCallId: "C1" }));
  model._rows.at(-1).state = "eligible";
  await repo.recordQualifyingCall(CALL({ caseId: "gone", providerCallId: "C2", expiresAt: new Date("2026-07-01T00:00:00Z") }));
  model._rows.at(-1).state = "eligible";

  // asOf sits before the first episode's eligibleFrom and after the second's expiry.
  const rows = await repo.listEpisodesForConsideration({ asOf: new Date("2026-07-31T00:00:00Z") });
  assert.deepEqual(rows.map((r) => r.caseId), [], "not-yet-eligible and expired are both excluded");
});

test("the model persists no payload, recording, transcript or secret", async () => {
  // §7.1. Checked against the schema itself so a future field addition trips it.
  const paths = Object.keys(real.schema.paths);
  for (const banned of [/payload/i, /recording/i, /transcript/i, /token/i, /secret/i, /rawBody/i, /url/i]) {
    const hit = paths.find((p) => banned.test(p));
    assert.equal(hit, undefined, `CallRecoveryLead grew a ${banned} field: ${hit}`);
  }
});

test("the state machine matches the contract exactly", async () => {
  assert.deepEqual([...real.STATES].sort(), [
    "active", "awaiting_start", "discovered", "eligible", "expired", "held", "review", "terminal",
  ]);
  // Absorbing states have no exits at all — that is what makes them absorbing.
  assert.deepEqual(real.TRANSITIONS.terminal, []);
  assert.deepEqual(real.TRANSITIONS.expired, []);
});
