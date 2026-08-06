"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const MODEL_PATH = require.resolve("../../packages/shared-models/src/CallRecoveryDailyCohort");
const REPO_PATH = require.resolve("../../packages/shared-repositories/src/callRecoveryDailyCohortRepository");
const POLICY_IDS = Object.freeze({
  cadence: "long_call_recovery_120d_2x",
  dnc: "full_dnc_loadin_30_60_90_logics_daily_v1",
  logics: "tag_active_prospect_only_v1",
});

function loadRepo() {
  let stored = null;
  const models = {
    CallRecoveryLead: {
      PROGRAM_KEY: "callrail-mail-long-call-v1",
      find() {
        const chain = {
          select() { return chain; },
          sort() { return chain; },
          lean: async () => [{ _id: "episode-object-1" }, { _id: "episode-object-2" }],
        };
        return chain;
      },
    },
    CallRecoveryDailyCohort: {
      findOne() { return { lean: async () => stored && { ...stored } }; },
      findOneAndUpdate(filter, update) {
        stored = {
          ...(stored || {}),
          dateKey: filter.dateKey,
          ...update.$set,
        };
        return { lean: async () => ({ ...stored }) };
      },
    },
  };
  const realLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (/shared-models[\\/]src$/.test(request)) return models;
    return realLoad.apply(this, [request, parent, isMain]);
  };
  delete require.cache[REPO_PATH];
  try {
    return require(REPO_PATH);
  } finally {
    Module._load = realLoad;
    delete require.cache[REPO_PATH];
  }
}

test("one completed Pacific day materializes one idempotent reference-only cohort", async () => {
  const repo = loadRepo();
  const input = {
    dateKey: "2026-08-04",
    discoveryResult: {
      factsRead: 12,
      qualified: 2,
      errors: 0,
      rejectedByReason: { "duration-below-threshold": 10 },
    },
    policyIds: POLICY_IDS,
  };
  const first = await repo.captureCompletedDay(input);
  const replay = await repo.captureCompletedDay(input);
  assert.equal(first.inserted, true);
  assert.equal(first.cohort.status, "complete");
  assert.equal(first.cohort.candidateCount, 2);
  assert.equal(first.cohort.cadencePolicyId, POLICY_IDS.cadence);
  assert.equal(first.cohort.dncPolicyId, POLICY_IDS.dnc);
  assert.equal(first.cohort.logicsPolicyId, POLICY_IDS.logics);
  assert.equal(first.cohort.revision, 1);
  assert.equal(replay.unchanged, true);
  assert.equal(replay.cohort.revision, 1);
});

test("a policy-version change corrects the same day and increments its revision", async () => {
  const repo = loadRepo();
  const base = {
    dateKey: "2026-08-04",
    discoveryResult: { factsRead: 2, qualified: 2, errors: 0 },
    policyIds: POLICY_IDS,
  };
  const first = await repo.captureCompletedDay(base);
  const corrected = await repo.captureCompletedDay({
    ...base,
    policyIds: { ...POLICY_IDS, logics: "tag_active_prospect_only_v2" },
  });
  assert.equal(first.cohort.revision, 1);
  assert.equal(corrected.updated, true);
  assert.equal(corrected.cohort.revision, 2);
  assert.equal(corrected.cohort.logicsPolicyId, "tag_active_prospect_only_v2");
});

test("an unreadable day is persisted as incomplete rather than a confident zero", async () => {
  const repo = loadRepo();
  const result = await repo.captureCompletedDay({
    dateKey: "2026-08-04",
    discoveryResult: { factsRead: 0, qualified: 0, errors: 1, readFailed: "unavailable" },
    policyIds: POLICY_IDS,
  });
  assert.equal(result.cohort.status, "incomplete");
  assert.equal(result.cohort.errorCount, 1);
});

test("daily cohort schema is a manifest, not a second customer/provider store", () => {
  const Model = require(MODEL_PATH);
  const paths = Object.keys(Model.schema.paths);
  for (const banned of [/phone/i, /name/i, /email/i, /caseId/i, /provider/i, /payload/i, /url/i]) {
    assert.equal(paths.find((field) => banned.test(field)), undefined);
  }
  assert.ok(paths.includes("dateKey"));
  assert.ok(paths.includes("candidateEpisodeIds"));
  assert.ok(paths.includes("cadencePolicyId"));
  assert.ok(paths.includes("dncPolicyId"));
  assert.ok(paths.includes("logicsPolicyId"));
});

test("daily cohort requires all three versioned recovery policies", async () => {
  const repo = loadRepo();
  await assert.rejects(
    repo.captureCompletedDay({ dateKey: "2026-08-04", discoveryResult: {}, policyIds: {} }),
    /cadencePolicyId is required/,
  );
});
