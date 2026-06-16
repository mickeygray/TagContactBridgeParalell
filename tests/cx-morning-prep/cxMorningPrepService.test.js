"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createCxMorningPrepService,
  mergeAgentGroupIdIntoMetadata,
  isRecentlyActive,
  identityResolvable,
  hasStoredGroup,
} = require("../../packages/shared-services/src/cxMorningPrepService");

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function agent(over = {}) {
  const a = {
    email: over.email || "a@x.com",
    extensionId: "extensionId" in over ? over.extensionId : "ext-1",
    cxAgentId: "cxAgentId" in over ? over.cxAgentId : "cx-1",
    company: over.company || "TAG",
    lastSeenAt: "lastSeenAt" in over ? over.lastSeenAt : new Date(NOW - DAY).toISOString(),
    metadata: over.metadata || {},
    id: over.id || "id-1",
  };
  return a;
}

// A recording deps harness. selfHeal/persist/buildQueue default to benign spies; tests can
// override behavior. Every call is recorded so we can assert "was/wasn't called".
function harness(over = {}) {
  const calls = { roster: [], selfHeal: [], persist: [], buildQueue: [], emit: [] };
  const deps = {
    loadRoster: async (filters) => { calls.roster.push(filters); return over.roster || []; },
    selfHeal: async (account, opts) => {
      calls.selfHeal.push({ account, opts });
      if (over.selfHeal) return over.selfHeal(account, opts);
      return { ok: true, reason: "already-enabled", patched: false, agentGroupId: "grp-1" };
    },
    persistAgentGroupId: async (account, groupId) => {
      calls.persist.push({ account, groupId });
      if (over.persist) return over.persist(account, groupId);
      return { ok: true };
    },
    buildQueue: async (domain, extensionId, opts) => {
      calls.buildQueue.push({ domain, extensionId, opts });
      if (over.buildQueue) return over.buildQueue(domain, extensionId, opts);
      return { ok: true, built: 5 };
    },
    now: () => over.now || NOW,
    emit: (event, payload) => { calls.emit.push({ event, payload }); },
    logger: null,
  };
  return { calls, service: createCxMorningPrepService(deps) };
}

// ── pure helpers ────────────────────────────────────────────────────────────

test("mergeAgentGroupIdIntoMetadata merges without clobbering other keys", () => {
  const out = mergeAgentGroupIdIntoMetadata({ foo: "bar", ringcxRcUserId: "rc1" }, "grp-9");
  assert.deepEqual(out, { foo: "bar", ringcxRcUserId: "rc1", ringcxAgentGroupId: "grp-9" });
});

test("mergeAgentGroupIdIntoMetadata tolerates null/undefined metadata", () => {
  assert.deepEqual(mergeAgentGroupIdIntoMetadata(null, "g"), { ringcxAgentGroupId: "g" });
  assert.deepEqual(mergeAgentGroupIdIntoMetadata(undefined, "g"), { ringcxAgentGroupId: "g" });
});

test("identityResolvable / hasStoredGroup read the right fields", () => {
  assert.equal(identityResolvable({ extensionId: "e", cxAgentId: "c" }), true);
  assert.equal(identityResolvable({ extensionId: "e", cxAgentId: "" }), false);
  assert.equal(identityResolvable({ extensionId: "", cxAgentId: "c" }), false);
  assert.equal(hasStoredGroup({ metadata: { ringcxAgentGroupId: "g" } }), true);
  assert.equal(hasStoredGroup({ metadata: {} }), false);
});

test("isRecentlyActive: window filters by lastSeenAt; null window passes all; never-seen excluded", () => {
  assert.equal(isRecentlyActive({ lastSeenAt: new Date(NOW - DAY).toISOString() }, NOW, 4 * DAY), true);
  assert.equal(isRecentlyActive({ lastSeenAt: new Date(NOW - 10 * DAY).toISOString() }, NOW, 4 * DAY), false);
  assert.equal(isRecentlyActive({ lastSeenAt: null }, NOW, 4 * DAY), false);
  assert.equal(isRecentlyActive({ lastSeenAt: null }, NOW, null), true); // filter disabled
});

// ── dry run: ZERO side effects ──────────────────────────────────────────────

test("dry run performs NO side effects and reports per-agent readiness", async () => {
  const roster = [
    agent({ email: "has@x.com", metadata: { ringcxAgentGroupId: "g1" } }),
    agent({ email: "missing@x.com", metadata: {} }),
    agent({ email: "noident@x.com", cxAgentId: "" }),
  ];
  const { calls, service } = harness({ roster });

  const out = await service.runMorningPrep({ apply: false });

  assert.equal(out.apply, false);
  assert.equal(calls.selfHeal.length, 0, "dry run must not call self-heal");
  assert.equal(calls.persist.length, 0, "dry run must not write");
  assert.equal(calls.buildQueue.length, 0, "dry run must not touch the queue");
  assert.equal(out.rosterTotal, 3);
  assert.equal(out.processed, 3);
  assert.equal(out.totals.groupStored, 1);
  assert.equal(out.totals.identityResolvable, 2);
  // the key metric: resolvable agents currently missing a stored group (the full-scan population)
  assert.equal(out.totals.missingGroup, 1);
});

test("dry run recency filter excludes stale agents from eligible", async () => {
  const roster = [
    agent({ email: "recent@x.com", lastSeenAt: new Date(NOW - DAY).toISOString() }),
    agent({ email: "stale@x.com", lastSeenAt: new Date(NOW - 30 * DAY).toISOString() }),
  ];
  const { service } = harness({ roster });
  const out = await service.runMorningPrep({ apply: false, recentlyActiveWithinMs: 4 * DAY });
  assert.equal(out.eligible, 1);
  assert.equal(out.skippedStale, 1);
  assert.equal(out.perAgent.length, 1);
  assert.equal(out.perAgent[0].email, "recent@x.com");
});

// ── apply: self-heal + persist (idempotent) ─────────────────────────────────

test("apply self-heals each eligible agent and persists the resolved group only when it changed", async () => {
  const roster = [
    agent({ email: "same@x.com", metadata: { ringcxAgentGroupId: "grp-1" } }), // resolves grp-1 -> no write
    agent({ email: "new@x.com", metadata: {} }), // resolves grp-1 -> write
  ];
  const { calls, service } = harness({ roster }); // default selfHeal resolves "grp-1"

  const out = await service.runMorningPrep({ apply: true, recentlyActiveWithinMs: null });

  assert.equal(calls.selfHeal.length, 2, "self-heal runs for every eligible agent");
  assert.equal(calls.persist.length, 1, "persist only fires when the group actually changed");
  assert.equal(calls.persist[0].account.email, "new@x.com");
  assert.equal(calls.persist[0].groupId, "grp-1");
  assert.equal(out.totals.selfHealOk, 2);
  assert.equal(out.totals.groupsResolved, 2);
  assert.equal(out.totals.groupsPersisted, 1);
});

test("apply does NOT call the queue build by default (queue phase off)", async () => {
  const { calls, service } = harness({ roster: [agent()] });
  await service.runMorningPrep({ apply: true, recentlyActiveWithinMs: null });
  assert.equal(calls.buildQueue.length, 0, "queue phase must be opt-in");
});

test("apply with queue phase on builds each agent's queue with (company, extensionId)", async () => {
  const { calls, service } = harness({ roster: [agent({ company: "WYNN", extensionId: "ext-9" })] });
  const out = await service.runMorningPrep({
    apply: true,
    recentlyActiveWithinMs: null,
    phases: { selfHeal: true, persistGroup: true, queue: true },
  });
  assert.equal(calls.buildQueue.length, 1);
  assert.equal(calls.buildQueue[0].domain, "WYNN");
  assert.equal(calls.buildQueue[0].extensionId, "ext-9");
  assert.equal(out.totals.queuesBuilt, 1);
  assert.equal(out.totals.queueItemsBuilt, 5);
});

// ── apply: robustness ───────────────────────────────────────────────────────

test("a failure on one agent is isolated and the batch continues", async () => {
  const roster = [agent({ email: "boom@x.com" }), agent({ email: "ok@x.com" })];
  const { calls, service } = harness({
    roster,
    selfHeal: (account) => {
      if (account.email === "boom@x.com") throw new Error("ringcx 500");
      return { ok: true, reason: "already-enabled", agentGroupId: "grp-1" };
    },
  });
  const out = await service.runMorningPrep({ apply: true, recentlyActiveWithinMs: null });
  assert.equal(out.processed, 2, "both agents are attempted");
  assert.equal(out.totals.errors, 1);
  const boom = out.perAgent.find((r) => r.email === "boom@x.com");
  assert.match(boom.error, /ringcx 500/);
  const ok = out.perAgent.find((r) => r.email === "ok@x.com");
  assert.equal(ok.error, null);
  assert.equal(calls.selfHeal.length, 2);
});

test("self-heal returning ok:false is counted as failed and does not persist a group", async () => {
  const { calls, service } = harness({
    roster: [agent({ metadata: {} })],
    selfHeal: () => ({ ok: false, reason: "agent-not-found" }),
  });
  const out = await service.runMorningPrep({ apply: true, recentlyActiveWithinMs: null });
  assert.equal(out.totals.selfHealFailed, 1);
  assert.equal(out.totals.selfHealOk, 0);
  assert.equal(calls.persist.length, 0, "no group resolved -> no persist");
});

test("maxAgents caps how many are processed", async () => {
  const roster = [agent({ email: "1@x" }), agent({ email: "2@x" }), agent({ email: "3@x" })];
  const { service } = harness({ roster });
  const out = await service.runMorningPrep({ apply: true, recentlyActiveWithinMs: null, maxAgents: 2 });
  assert.equal(out.processed, 2);
});

test("bounded concurrency still processes every eligible agent", async () => {
  const roster = Array.from({ length: 7 }, (_, i) => agent({ email: `a${i}@x`, id: `id-${i}` }));
  const { calls, service } = harness({ roster });
  const out = await service.runMorningPrep({ apply: true, recentlyActiveWithinMs: null, concurrency: 3 });
  assert.equal(out.processed, 7);
  assert.equal(calls.selfHeal.length, 7);
});

test("emit fires a summary event for both dry-run and apply", async () => {
  const { calls, service } = harness({ roster: [agent()] });
  await service.runMorningPrep({ apply: false });
  await service.runMorningPrep({ apply: true, recentlyActiveWithinMs: null });
  assert.equal(calls.emit.length, 2);
  assert.equal(calls.emit[0].event, "cx.morning_prep.dry_run");
  assert.equal(calls.emit[1].event, "cx.morning_prep.apply");
});

test("loadRoster is asked for routing-enabled agents in the configured companies", async () => {
  const { calls, service } = harness({ roster: [] });
  await service.runMorningPrep({ apply: false, companies: ["TAG"] });
  assert.deepEqual(calls.roster[0], { companies: ["TAG"], routingEnabled: true });
});
