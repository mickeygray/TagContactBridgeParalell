"use strict";

// SEAN FIRST-TOUCH DRIP PINS (2026-07-08). The fresh-touch tee for the one-agent
// pilot: occasional, Sean-only, dry-runnable, claim-CAS'd, publish-or-release.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildClaimFilter,
  buildClaimPatch,
  buildFreshCandidateQuery,
  buildLegacyExternId,
  buildRecentSelectionQuery,
  buildReleaseFilter,
  buildReleasePatch,
  createCxSeanFirstTouchDrip,
} = require("../../packages/shared-services/src/cxSeanFirstTouchDripService");

const ENV_KEYS = [
  "CX_SEAN_FIRST_TOUCH_TEST_ENABLED",
  "CX_SEAN_FIRST_TOUCH_DRY_RUN",
  "CX_SEAN_FIRST_TOUCH_EXTENSION_ID",
  "CX_SEAN_FIRST_TOUCH_AGENT_EMAIL",
  "CX_SEAN_FIRST_TOUCH_AGENT_NAME",
  "CX_SEAN_FIRST_TOUCH_CAMPAIGN_ID",
  "CX_SEAN_FIRST_TOUCH_MAX_PER_TICK",
  "CX_SEAN_FIRST_TOUCH_MIN_GAP_MINUTES",
  "CX_SEAN_FIRST_TOUCH_WINDOW_MINUTES",
  "CX_SEAN_FIRST_TOUCH_DOMAIN",
];
const saved = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const silentLogger = { info: () => {}, warn: () => {}, log: () => {}, error: () => {} };
const NOW = new Date("2026-07-08T16:30:00.000Z");

function cfg(overrides = {}) {
  return {
    enabled: true,
    dryRun: false,
    extensionId: "63756126004",
    agentEmail: "slucas@taxadvocategroup.com",
    agentName: "Sean Lucas",
    campaignId: "2831",
    maxPerTick: 1,
    minGapMinutes: 10,
    windowMinutes: 30,
    domain: "WYNN",
    ...overrides,
  };
}

function freshRow(overrides = {}) {
  return {
    _id: "68aa000000000000000000a1",
    domain: "WYNN",
    caseId: 134999,
    phone: "8185551234",
    name: "Freshly Minted",
    createdAt: new Date(),
    ...overrides,
  };
}

test("candidate query is floor-safe: only new unassigned fresh-day1 intake rows", () => {
  const query = buildFreshCandidateQuery(cfg(), NOW);

  assert.equal(query.domain, "WYNN");
  assert.equal(query.state, "ready");
  assert.equal(query.queueFamily, "fresh-day1");
  assert.deepEqual(query.placedCalls, { $in: [0, null] });
  assert.equal(query["assignment.extensionId"], null);
  assert.equal(query["metadata.requestedBy"], "intake-first-contact");
  assert.deepEqual(query["metadata.seanFirstTouchTest"], { $exists: false });
  assert.deepEqual(query["metadata.firstTouchPending"], { $ne: true });
  assert.deepEqual(query["metadata.appointmentPending"], { $in: [null, false] });
  assert.equal(query.createdAt.$gte.toISOString(), "2026-07-08T16:00:00.000Z");
});

test("recent-selection guard is domain-scoped and uses the durable drip stamp", () => {
  const query = buildRecentSelectionQuery(cfg(), NOW);

  assert.equal(query.domain, "WYNN");
  assert.equal(
    query["metadata.seanFirstTouchTest.selectedAt"].$gte.toISOString(),
    "2026-07-08T16:20:00.000Z",
  );
});

test("claim CAS rechecks the floor-safe shape at write time", () => {
  const row = freshRow({ _id: "row-claim" });
  const filter = buildClaimFilter(row, cfg());
  const patch = buildClaimPatch(cfg(), NOW);

  assert.deepEqual(filter, {
    _id: "row-claim",
    domain: "WYNN",
    state: "ready",
    queueFamily: "fresh-day1",
    placedCalls: { $in: [0, null] },
    "assignment.extensionId": null,
    "metadata.requestedBy": "intake-first-contact",
    "metadata.seanFirstTouchTest": { $exists: false },
    "metadata.firstTouchPending": { $ne: true },
    "metadata.appointmentPending": { $in: [null, false] },
  });
  assert.equal(patch.$set.state, "claimed");
  assert.equal(patch.$set["assignment.extensionId"], "63756126004");
  assert.equal(patch.$set["assignment.queueFamilySnapshot"], "fresh-day1");
  assert.equal(patch.$set["metadata.seanFirstTouchTest"].agentEmail, "slucas@taxadvocategroup.com");
});

test("publish-failure release only frees the Sean-held undialed claim", () => {
  const filter = buildReleaseFilter("row-release", cfg());
  const patch = buildReleasePatch(NOW);

  assert.deepEqual(filter, {
    _id: "row-release",
    state: "claimed",
    placedCalls: { $in: [0, null] },
    "assignment.extensionId": "63756126004",
    "metadata.seanFirstTouchTest.agentEmail": "slucas@taxadvocategroup.com",
  });
  assert.equal(patch.$set.state, "ready");
  assert.equal(patch.$set["assignment.extensionId"], null);
  assert.equal(patch.$set["metadata.seanFirstTouchTest.releasedAt"], NOW.toISOString());
});

test("legacy extern keeps the regular floor identity shape", () => {
  assert.equal(
    buildLegacyExternId(freshRow()),
    "parallel:WYNN:134999:68aa000000000000000000a1",
  );
});

function makeDeps(overrides = {}) {
  const calls = { claimed: [], published: [], stamped: [], released: [] };
  const deps = {
    logger: silentLogger,
    listCandidates: async () => [freshRow()],
    countRecentSelections: async () => 0,
    claimRow: async (row) => {
      calls.claimed.push(String(row._id));
      return true;
    },
    publishBatch: async (client, input) => {
      calls.published.push(input);
      return { accepted: [{ externId: input.candidates[0].externId }], rejected: [] };
    },
    stampPublished: async (id, fields) => {
      calls.stamped.push({ id: String(id), fields });
    },
    releaseRow: async (id) => {
      calls.released.push(String(id));
    },
    ...overrides,
  };
  return { deps, calls };
}

test("flag off (the default): tick is a no-op env read", async () => {
  const { deps, calls } = makeDeps();
  const drip = createCxSeanFirstTouchDrip(deps);
  const result = await drip.tickOnce();
  assert.deepEqual(result, { skipped: true, reason: "flag-off" });
  assert.equal(calls.claimed.length + calls.published.length, 0);
});

test("dry run: candidate narrated, ZERO writes", async () => {
  process.env.CX_SEAN_FIRST_TOUCH_TEST_ENABLED = "true";
  process.env.CX_SEAN_FIRST_TOUCH_DRY_RUN = "true";
  const { deps, calls } = makeDeps();
  const drip = createCxSeanFirstTouchDrip(deps);
  const result = await drip.tickOnce();
  assert.equal(result.dryRun, true);
  assert.equal(result.candidates, 1);
  assert.equal(result.published, 0);
  assert.equal(calls.claimed.length, 0);
  assert.equal(calls.published.length, 0);
  assert.equal(calls.stamped.length, 0);
});

test("min-gap guard: a recent selection makes the tick skip ('occasional' is crash-safe)", async () => {
  process.env.CX_SEAN_FIRST_TOUCH_TEST_ENABLED = "true";
  const { deps, calls } = makeDeps({ countRecentSelections: async () => 1 });
  const drip = createCxSeanFirstTouchDrip(deps);
  const result = await drip.tickOnce();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "min-gap");
  assert.equal(calls.claimed.length, 0);
});

test("happy path: claim -> IMMEDIATE publish into the FIRST TOUCH campaign with a LEGACY extern -> stamps", async () => {
  process.env.CX_SEAN_FIRST_TOUCH_TEST_ENABLED = "true";
  const { deps, calls } = makeDeps();
  const drip = createCxSeanFirstTouchDrip(deps);
  const result = await drip.tickOnce();
  assert.equal(result.published, 1);
  assert.equal(result.failed, 0);
  assert.equal(calls.claimed.length, 1);
  const publish = calls.published[0];
  assert.equal(publish.campaignId, "2831"); // First Touch, NOT the 2344 bulk/live route
  assert.equal(publish.dialPriority, "IMMEDIATE");
  assert.equal(
    publish.candidates[0].externId,
    "parallel:WYNN:134999:68aa000000000000000000a1", // legacy convention — lands like a floor lead
  );
  const stamp = calls.stamped[0];
  assert.equal(stamp.fields["metadata.rcxVisibilityCampaignId"], "2831");
  assert.equal(stamp.fields["metadata.rcxVisibilityExternId"], publish.candidates[0].externId);
  assert.equal(calls.released.length, 0);
});

test("claim CAS lost (a floor claimer won the race): their lead by design — no publish", async () => {
  process.env.CX_SEAN_FIRST_TOUCH_TEST_ENABLED = "true";
  const { deps, calls } = makeDeps({ claimRow: async () => false });
  const drip = createCxSeanFirstTouchDrip(deps);
  const result = await drip.tickOnce();
  assert.equal(result.published, 0);
  assert.equal(calls.published.length, 0);
  assert.equal(calls.released.length, 0); // nothing to release — we never held it
});

test("publish rejected: the claim is RELEASED back to the floor pool", async () => {
  process.env.CX_SEAN_FIRST_TOUCH_TEST_ENABLED = "true";
  const { deps, calls } = makeDeps({
    publishBatch: async () => ({ accepted: [], rejected: [{ reason: "campaign-closed" }] }),
  });
  const drip = createCxSeanFirstTouchDrip(deps);
  const result = await drip.tickOnce();
  assert.equal(result.failed, 1);
  assert.equal(result.published, 0);
  assert.equal(calls.released.length, 1);
  assert.equal(calls.stamped.length, 0);
});

test("max-per-tick caps the batch even when more candidates exist", async () => {
  process.env.CX_SEAN_FIRST_TOUCH_TEST_ENABLED = "true";
  process.env.CX_SEAN_FIRST_TOUCH_MAX_PER_TICK = "2";
  const rows = [
    freshRow({ _id: "68aa000000000000000000b1", caseId: 1 }),
    freshRow({ _id: "68aa000000000000000000b2", caseId: 2 }),
    freshRow({ _id: "68aa000000000000000000b3", caseId: 3 }),
  ];
  const { deps, calls } = makeDeps({ listCandidates: async () => rows });
  const drip = createCxSeanFirstTouchDrip(deps);
  const result = await drip.tickOnce();
  assert.equal(result.published, 2);
  assert.equal(calls.published.length, 2);
});

test("flag overrides flow through: campaign + extension come from env, not hardcode", async () => {
  process.env.CX_SEAN_FIRST_TOUCH_TEST_ENABLED = "true";
  process.env.CX_SEAN_FIRST_TOUCH_CAMPAIGN_ID = "9999";
  const { deps, calls } = makeDeps();
  const drip = createCxSeanFirstTouchDrip(deps);
  await drip.tickOnce();
  assert.equal(calls.published[0].campaignId, "9999");
});
