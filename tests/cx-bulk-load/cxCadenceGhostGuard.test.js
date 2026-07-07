"use strict";

// Pins for the ghost-lead guard (2026-07-06 incident): a queue row's RingCX copy can
// exist through TWO publish contracts — legacy rcxVisibility* or bulk lastRingcxPublished*.
// The old guard read only the legacy fields, so bulk rows skipped the RingCX unload on
// release and their leads stayed loaded (RingCX dialed one; the answered call went
// unrecorded). resolveRingcxPublishedCopies is the pure decision these pins lock.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { resolveRingcxPublishedCopies } = require("../../packages/shared-services/src/cxCadenceService");

test("bulk-published row (the incident shape) yields a bulk copy with extern/campaign overrides", () => {
  const copies = resolveRingcxPublishedCopies({
    lastRingcxPublishedExternId: "cxbl-wynn-19be7194d8c3-6a355aab74fd3164e8e3beac",
    lastRingcxPublishedCampaignId: "2306",
    lastRingcxPublishedAt: new Date("2026-07-06T15:22:22.315Z"),
    // legacy channel empty — exactly what made the old guard skip
    rcxVisibilityStatus: null,
  });
  assert.equal(copies.length, 1);
  assert.equal(copies[0].channel, "bulk");
  assert.equal(copies[0].externId, "cxbl-wynn-19be7194d8c3-6a355aab74fd3164e8e3beac");
  assert.equal(copies[0].campaignId, "2306");
});

test("legacy visibility-published row keeps the legacy channel (no behavior change)", () => {
  const copies = resolveRingcxPublishedCopies({
    rcxVisibilityStatus: "published",
    rcxVisibilityExternId: "parallel:WYNN:1:abc",
    rcxVisibilityCampaignId: "2306",
  });
  assert.deepEqual(copies, [{ channel: "legacy" }]);
});

test("no publish evidence on either channel yields no copies (skip stays skip)", () => {
  assert.deepEqual(resolveRingcxPublishedCopies({}), []);
  assert.deepEqual(resolveRingcxPublishedCopies({
    rcxVisibilityStatus: "stale-cancelled",
    lastRingcxPublishedExternId: "cxbl-x",
    // no campaign, no publishedAt -> not a live copy
  }), []);
});

test("cancel-after-publish clears the bulk copy; republish after cancel revives it", () => {
  const base = {
    lastRingcxPublishedExternId: "cxbl-wynn-abc-item1",
    lastRingcxPublishedCampaignId: "2306",
  };
  // cancelled AFTER the publish -> copy is gone
  assert.deepEqual(resolveRingcxPublishedCopies({
    ...base,
    lastRingcxPublishedAt: new Date("2026-07-06T15:22:00.000Z"),
    rcxVisibilityCancelledAt: new Date("2026-07-06T15:40:00.000Z"),
  }), []);
  // republished AFTER the last cancel -> copy is live again
  const revived = resolveRingcxPublishedCopies({
    ...base,
    lastRingcxPublishedAt: new Date("2026-07-06T16:10:00.000Z"),
    rcxVisibilityCancelledAt: new Date("2026-07-06T15:40:00.000Z"),
  });
  assert.equal(revived.length, 1);
  assert.equal(revived[0].channel, "bulk");
});

test("SCHEMA DECLARATION GUARD: every LeadCadence path the drain's counter writes target is declared (strict mode strips undeclared paths from their own $set — the dead-replay-guard bug, 2026-07-07)", () => {
  const { LeadCadence } = require("../../packages/shared-models/src");
  const mustExist = [
    "counterCadence.lastCxTerminalCountedUii", // the June replay-drift CAS guard field
    "counterCadence.lastCxDncAt",
    "counterCadence.cxAnsweredContacts",
    "counterCadence.cxNoAnswerCalls",
    "counterCadence.lastCxDialedAt",
  ];
  const missing = mustExist.filter((path) => !LeadCadence.schema.path(path));
  assert.deepEqual(missing, [], `undeclared LeadCadence paths (writes to these are silently stripped): ${missing.join(", ")}`);
});
