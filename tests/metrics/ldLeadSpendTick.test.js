"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveLdLeadSpend,
  recordRealtimeLdLeadSpend,
  ldSpendDateKey,
} = require("../../packages/shared-services/src/ldSpendService");

// ── pure: resolveLdLeadSpend ──────────────────────────────────────────────────
test("resolveLdLeadSpend maps LD families to their rate ($3 custom/custom-2/custom-3, $1.50 general)", () => {
  assert.deepEqual(resolveLdLeadSpend("ld-custom"), { family: "ld-custom", label: "LD CUSTOM", rate: 3 });
  assert.deepEqual(resolveLdLeadSpend("ld-custom-2"), { family: "ld-custom-2", label: "LD CUSTOM 2", rate: 3 });
  assert.deepEqual(resolveLdLeadSpend("ld-custom-3"), { family: "ld-custom-3", label: "LD CUSTOM 3", rate: 3 });
  assert.deepEqual(resolveLdLeadSpend("ld-general"), { family: "ld-general", label: "LD GENERAL", rate: 1.5 });
});

test("resolveLdLeadSpend is case/whitespace insensitive", () => {
  assert.equal(resolveLdLeadSpend("  LD-Custom ")?.family, "ld-custom");
});

test("resolveLdLeadSpend returns null for non-LD / empty keys", () => {
  for (const k of ["mailer", "ld-posting", "callrail", "", null, undefined, 0]) {
    assert.equal(resolveLdLeadSpend(k), null, `key ${JSON.stringify(k)} should not be an LD family`);
  }
});

test("resolveLdLeadSpend honors injected rates", () => {
  assert.equal(resolveLdLeadSpend("ld-custom", { "ld-custom": 4.25 })?.rate, 4.25);
});

// ── orchestrator: recordRealtimeLdLeadSpend (injected fakes) ──────────────────
function spies({ claimResult = true, incrementThrows = false } = {}) {
  const calls = { claim: [], increment: [], release: [] };
  return {
    calls,
    deps: {
      legacyRealtimeEnabled: true,
      claimLdSpendTick: async (domain, caseId, meta) => { calls.claim.push({ domain, caseId, meta }); return claimResult; },
      incrementSpendEntry: async (identity, deltas, onInsert) => {
        calls.increment.push({ identity, deltas, onInsert });
        if (incrementThrows) throw new Error("mongo down");
      },
      releaseLdSpendTick: async (domain, caseId) => { calls.release.push({ domain, caseId }); return true; },
    },
  };
}

const NOW = new Date("2026-06-16T18:00:00Z");

test("non-LD lead: no claim, no increment, skipped", async () => {
  const { calls, deps } = spies();
  const r = await recordRealtimeLdLeadSpend({ domain: "TAG", caseId: 1, routeCampaignKey: "mailer", now: NOW, deps });
  assert.deepEqual(r, { skipped: true, reason: "not-ld-family" });
  assert.equal(calls.claim.length, 0);
  assert.equal(calls.increment.length, 0);
});

test("missing identity: skipped, no writes", async () => {
  const { calls, deps } = spies();
  const r = await recordRealtimeLdLeadSpend({ domain: "TAG", caseId: null, routeCampaignKey: "ld-custom", now: NOW, deps });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "missing-identity");
  assert.equal(calls.increment.length, 0);
});

test("LD realtime writer is disabled by default so reconciliation is the only spend owner", async () => {
  const calls = { claim: 0, increment: 0 };
  const result = await recordRealtimeLdLeadSpend({
    domain: "TAG",
    caseId: 128300,
    routeCampaignKey: "ld-custom",
    now: NOW,
    deps: {
      claimLdSpendTick: async () => { calls.claim += 1; },
      incrementSpendEntry: async () => { calls.increment += 1; },
    },
  });
  assert.deepEqual(result, {
    skipped: true,
    reason: "single-owner-reconciliation",
    family: "ld-custom",
  });
  assert.deepEqual(calls, { claim: 0, increment: 0 });
});

test("LD lead, claim won: increments the day's SpendEntry once with the right identity/deltas/metadata", async () => {
  const { calls, deps } = spies({ claimResult: true });
  const r = await recordRealtimeLdLeadSpend({ domain: "tag", caseId: 128300, routeCampaignKey: "ld-custom", now: NOW, deps });
  assert.equal(r.ticked, true);
  assert.equal(r.family, "ld-custom");
  assert.equal(r.rate, 3);
  assert.equal(r.date, ldSpendDateKey(NOW));

  assert.equal(calls.claim.length, 1);
  assert.deepEqual(calls.claim[0].meta, { family: "ld-custom", rate: 3, dateKey: ldSpendDateKey(NOW), now: NOW });

  assert.equal(calls.increment.length, 1);
  const inc = calls.increment[0];
  assert.deepEqual(inc.identity, { date: ldSpendDateKey(NOW), domain: "TAG", channel: "lead-data", campaign: "ld-custom" });
  assert.deepEqual(inc.deltas, { spend: 3, leadsReported: 1 });
  assert.equal(inc.onInsert.source, "LD CUSTOM");
  assert.equal(inc.onInsert.costPerLead, 3);
  assert.equal(inc.onInsert.raw.computedBy, "ld-spend-materializer"); // so the nightly reconciles it
});

test("idempotency: claim lost (already counted) => no increment", async () => {
  const { calls, deps } = spies({ claimResult: false });
  const r = await recordRealtimeLdLeadSpend({ domain: "TAG", caseId: 128300, routeCampaignKey: "ld-custom", now: NOW, deps });
  assert.deepEqual(r, { skipped: true, reason: "already-counted", family: "ld-custom" });
  assert.equal(calls.claim.length, 1);
  assert.equal(calls.increment.length, 0, "a lost CAS claim must not double-count");
});

test("increment failure releases the burned claim and re-throws (so intake logs it; re-ingest can re-tick)", async () => {
  const { calls, deps } = spies({ claimResult: true, incrementThrows: true });
  await assert.rejects(
    recordRealtimeLdLeadSpend({ domain: "TAG", caseId: 128300, routeCampaignKey: "ld-custom", now: NOW, deps }),
    /mongo down/,
  );
  assert.equal(calls.claim.length, 1, "claim is attempted");
  assert.equal(calls.increment.length, 1, "increment is attempted");
  assert.equal(calls.release.length, 1, "a failed increment must release the burned claim");
  assert.deepEqual(calls.release[0], { domain: "TAG", caseId: 128300 });
});

test("general LD lead ticks $1.50", async () => {
  const { calls, deps } = spies();
  const r = await recordRealtimeLdLeadSpend({ domain: "WYNN", caseId: 5, routeCampaignKey: "ld-general", now: NOW, deps });
  assert.equal(r.rate, 1.5);
  assert.deepEqual(calls.increment[0].deltas, { spend: 1.5, leadsReported: 1 });
  assert.equal(calls.increment[0].identity.domain, "WYNN");
});
