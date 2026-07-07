"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// CADENCE HYGIENE PINS (the 2026-07-07 write audit, executed same night — guide:
// docs/CX_CADENCE_HYGIENE_IMPLEMENTATION_2026-07-07.md). Field-level ownership only
// works if every owner's writes are targeted and every recompute preserves what it
// does not own. These pins hold each fix in place.

const {
  mergeCadenceState,
  splitLeadCadenceUpsertUpdate,
} = require("../../packages/shared-repositories/src/leadCadenceRepository");
const { buildReadyReservationQuery, buildReadyClaimQuery } = (() => {
  const repo = require("../../packages/shared-repositories/src/cxDialQueueRepository");
  return repo;
})();
const { deriveFirstTouchStamp } = require("../../packages/shared-services/src/cxCadenceService");
const { buildBlockedReason } = require("../../packages/shared-services/src/contactEligibilityService");

test("H1: cadenceState recompute PRESERVES what it does not own (dncCheck/bypass/optedOut), rebuilt keys win", () => {
  const prior = {
    caps: { cx: 3 },
    channelDnc: { sms: { blocked: true } },
    dncCheck: { nextCheckAt: "2026-08-01T00:00:00Z", lastCheckedAt: "2026-07-01T00:00:00Z" },
    bypassChannelTiming: { cx: true },
    optedOutChannels: ["email"],
    nextChannel: "stale-value",
  };
  const rebuilt = {
    caps: { cx: 3 },
    channelDnc: { sms: { blocked: true }, cx: { blocked: true } },
    nextChannel: "cx",
    pendingByChannel: { cx: 1 },
  };
  const merged = mergeCadenceState(prior, rebuilt);
  // unowned keys survive the recompute — the federal-DNC recheck schedule lives
  assert.deepEqual(merged.dncCheck, prior.dncCheck, "dncCheck survives");
  assert.deepEqual(merged.bypassChannelTiming, prior.bypassChannelTiming);
  assert.deepEqual(merged.optedOutChannels, prior.optedOutChannels);
  // rebuilt keys win
  assert.equal(merged.nextChannel, "cx");
  assert.equal(merged.channelDnc.cx.blocked, true);
  // degenerate priors never throw
  assert.deepEqual(mergeCadenceState(null, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeCadenceState(undefined, {}), {});
});

test("H2: the intake upsert split — machinery keys land in $setOnInsert only, identity stays $set, no overlap", () => {
  const update = {
    name: "Seed Person", email: "x@y.z", primaryPhone: "8185550100",
    intakeSource: "ld", statusId: 2,
    cadenceCounters: { sms: 0 }, lastTouched: { cx: null }, counterCadence: { locks: {} },
    currentStage: "legacy-cadence-active", schedule: { actions: [] },
    cadenceState: { caps: {} }, active: true, cadenceMode: "legacy-time-count",
    firstContactRequestedAt: null, firstContactEventId: null,
  };
  const { set, setOnInsert } = splitLeadCadenceUpsertUpdate(update);
  const machinery = ["cadenceCounters", "lastTouched", "counterCadence", "currentStage",
    "schedule", "cadenceState", "active", "cadenceMode", "firstContactRequestedAt", "firstContactEventId"];
  for (const key of machinery) {
    assert.ok(key in setOnInsert, `${key} is insert-only`);
    assert.ok(!(key in set), `${key} never re-$sets on re-ingest (the erase-a-DNC-block bug)`);
  }
  for (const key of ["name", "email", "primaryPhone", "intakeSource", "statusId"]) {
    assert.ok(key in set, `${key} refreshes on re-ingest`);
    assert.ok(!(key in setOnInsert));
  }
});

test("H4: the CX channel-DNC flag blocks at the shared eligibility gate (every dial path funnels here)", () => {
  const caseProfile = { statusId: 2, statusCategory: "prospect" };
  const blocked = buildBlockedReason(
    caseProfile,
    { active: true, statusId: 2, cadenceState: { channelDnc: { cx: { blocked: true, reason: "federal-dnc-recheck" } } } },
  );
  assert.equal(blocked?.reason, "channel-dnc-cx", "the flag is now visible at dial time");
  const clean = buildBlockedReason(
    caseProfile,
    { active: true, statusId: 2, cadenceState: { channelDnc: { sms: { blocked: true } } } },
  );
  assert.notEqual(clean?.reason, "channel-dnc-cx", "other channels' blocks do not bleed into cx");
});

test("H5: BOTH ready rails exclude appointment holds and the (inert) lane flags", () => {
  const reservation = buildReadyReservationQuery("WYNN", "green", {}, new Date());
  const claim = buildReadyClaimQuery("WYNN", {});
  for (const [label, q] of [["reservation", reservation], ["claim", claim]]) {
    assert.deepEqual(q["metadata.appointmentId"], { $in: [null, ""] }, `${label}: appointment holds excluded`);
    assert.deepEqual(q["metadata.firstTouchPending"], { $ne: true }, `${label}: first-touch rows excluded once stamped`);
    assert.deepEqual(q["metadata.appointmentPending"], { $in: [null, false] }, `${label}: appointmentPending is an OBJECT — $in, never $ne:true`);
  }
});

test("F0: the first-touch stamp — intake mints stamp when the flag is on, nothing else ever stamps", () => {
  const on = { enabled: true };
  const off = { enabled: false };
  assert.deepEqual(deriveFirstTouchStamp({ requestedBy: "intake-first-contact" }, on), { firstTouchPending: true });
  assert.deepEqual(deriveFirstTouchStamp({ actionKey: "first-cx:101617" }, on), { firstTouchPending: true });
  assert.deepEqual(deriveFirstTouchStamp({ requestedBy: "cadence-engine", actionKey: "cx-day3:x" }, on), {}, "ordinary cadence mints never stamp");
  assert.deepEqual(deriveFirstTouchStamp({ requestedBy: "intake-first-contact" }, off), {}, "flag off = zero stamps (the lane must exist first)");
});
