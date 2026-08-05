"use strict";

// The fourth attribution tier: ask Logics about the case.
//
// Mickey 2026-08-05: "the deal in wynn yesterday was bcd but landed as
// unattributed." Case 138819, $166.67, 2026-08-04. All three existing tiers
// missed: sourceAtSale was blank, no attribution call, and the lead-source tier
// reads CaseProfile.sourceName — which did not exist for that case at all.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { resolveCaseSourcesLive } = require("../../packages/shared-services/src/caseSourceLiveResolver");

const facadeWith = (byCase, calls = []) => () => ({
  fetchCaseInfo: async (caseId) => {
    calls.push(caseId);
    const v = byCase[caseId];
    if (v instanceof Error) throw v;
    return { ok: true, data: v ?? null };
  },
});

test("a case with no CaseProfile still resolves, straight from Logics", async () => {
  // The exact shape of the reported bug.
  const map = await resolveCaseSourcesLive({
    cases: [{ domain: "WYNN", caseId: 138819 }],
    facadeFor: facadeWith({ 138819: { CaseID: 138819, SourceCampaignID: 31 } }),
  });
  const hit = map.get("WYNN:138819");
  assert.equal(hit.campaignId, 31);
  assert.equal(hit.sourceName, "BCD", "the registry entry's LABEL, not the entry object");
  assert.equal(hit.unreadable, false);
});

test("campaign ids are per tenant — the domain must travel with the id", () => {
  // BCD is 64 under TAG and 31 under WYNN. Resolving 31 against TAG's table
  // would name the wrong source, or none.
  const { labelForSourceId } = require("../../packages/shared-services/src/logicsSourceWriterService");
  assert.equal(labelForSourceId("WYNN", 31)?.label, "BCD");
  assert.notEqual(labelForSourceId("TAG", 31)?.label, "BCD");
});

test("an UNREGISTERED campaign is reported as a config gap, not as no source", async () => {
  // Live data turned up WYNN campaigns 15 and 40 that nothing maps. That is a
  // registry gap to close, not a sale with no marketing behind it.
  const map = await resolveCaseSourcesLive({
    cases: [{ domain: "WYNN", caseId: 101564 }],
    facadeFor: facadeWith({ 101564: { SourceCampaignID: 15 } }),
  });
  const hit = map.get("WYNN:101564");
  assert.equal(hit.sourceName, null);
  assert.equal(hit.campaignId, 15, "the id is kept so the gap is actionable");
  assert.match(hit.reason, /unregistered-campaign:15/);
  assert.equal(hit.unreadable, false, "we read it fine — we just cannot name it");
});

test("UNREADABLE is not UNATTRIBUTED", async () => {
  // A Logics failure must never render as "this deal had no source", which
  // reads as a marketing result rather than an outage.
  const map = await resolveCaseSourcesLive({
    cases: [{ domain: "WYNN", caseId: 1 }],
    facadeFor: facadeWith({ 1: new Error("Logics 504") }),
  });
  const hit = map.get("WYNN:1");
  assert.equal(hit.unreadable, true);
  assert.equal(hit.sourceName, null);
  assert.match(hit.reason, /Logics 504/);
});

test("a case that genuinely names no campaign is distinct from an unreadable one", async () => {
  const map = await resolveCaseSourcesLive({
    cases: [{ domain: "WYNN", caseId: 7 }],
    facadeFor: facadeWith({ 7: { CaseID: 7 } }),
  });
  const hit = map.get("WYNN:7");
  assert.equal(hit.unreadable, false, "we read the case successfully");
  assert.equal(hit.reason, "no-campaign-id");
});

test("two payments on one case cost ONE lookup", async () => {
  const calls = [];
  await resolveCaseSourcesLive({
    cases: [{ domain: "WYNN", caseId: 500 }, { domain: "WYNN", caseId: 500 }],
    facadeFor: facadeWith({ 500: { SourceCampaignID: 31 } }, calls),
  });
  assert.deepEqual(calls, [500]);
});

test("no unresolved payments means no Logics traffic at all", async () => {
  const calls = [];
  const map = await resolveCaseSourcesLive({ cases: [], facadeFor: facadeWith({}, calls) });
  assert.equal(calls.length, 0, "this is a LAST resort, not a fan-out over every deal");
  assert.equal(map.size, 0);
});
