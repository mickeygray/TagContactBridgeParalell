"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MINIMUM_RECOVERY_DURATION_SECONDS,
  normalizeCallRailCallFact,
  qualifyCallRailRecoveryFact,
} = require("../../packages/shared-services/src/callrailCallFactService");
const {
  CALL_RECOVERY_CONTACT_POLICY_ID,
  CALL_RECOVERY_DNC_POLICY_ID,
  CALL_RECOVERY_INVENTORY_CLASS,
  CALL_RECOVERY_LOGICS_POLICY_ID,
  POOLS,
  comparePoolItems,
  compareRecoveryPoolItems,
  dailyAttemptLimitForLeadAge,
  decideRecoveryOutcomeState,
  resolveLeadDeliveryContactPolicy,
  resolveCallRecoveryLogicsEligibility,
  resolveRecoveryEpisodeTiming,
  retryDelayMinutesForLeadAge,
} = require("../../packages/shared-services/src/leadDeliveryService");

function qualifyingRaw(overrides = {}) {
  return {
    id: "call-1",
    direction: "inbound",
    answered: true,
    duration: 600,
    start_time: "2026-07-30T22:00:00.000Z",
    customer_phone_number: "+1 (310) 555-0100",
    tracking_phone_number: "+1 (818) 555-0101",
    source_name: "Mail Piece",
    ...overrides,
  };
}

function provedEvidence() {
  return {
    mailSourceEvidence: { status: "proved" },
    humanAnswerEvidence: { status: "proved" },
    caseIdentityEvidence: { status: "proved" },
    currentCaseEvidence: { status: "clear" },
  };
}

function recoveryItem(overrides = {}) {
  return {
    domain: "TAG",
    caseId: 1001,
    receivedAt: "2026-07-01T17:00:00.000Z",
    contactPolicyId: CALL_RECOVERY_CONTACT_POLICY_ID,
    eligibleFrom: "2026-07-02T14:50:00.000Z",
    expiresAt: "2026-10-29T17:00:00.000Z",
    dailyAttemptDateKey: "2026-07-30",
    dailyAttemptCount: 0,
    ...overrides,
  };
}

test("CallRail fact normalization keeps only the bounded recovery fact contract", () => {
  const fact = normalizeCallRailCallFact(qualifyingRaw({
    recording_duration: 590,
    first_call: true,
    prior_calls: 2,
    ignored_raw_payload: { secret: true },
  }));
  assert.deepEqual(Object.keys(fact), [
    "provider",
    "providerCallId",
    "tenantDomain",
    "direction",
    "answered",
    "durationSec",
    "recordingDurationSec",
    "startedAt",
    "endedAt",
    "customerPhone",
    "trackingPhone",
    "sourceName",
    "firstCall",
    "priorCalls",
  ]);
  assert.equal(fact.durationSec, 600);
  assert.equal(fact.customerPhone, "3105550100");
  assert.equal(fact.trackingPhone, "8185550101");
  assert.equal(fact.endedAt.toISOString(), "2026-07-30T22:10:00.000Z");
  assert.equal("ignored_raw_payload" in fact, false);
});

test("599 seconds rejects and 600 seconds qualifies", () => {
  const short = qualifyCallRailRecoveryFact(qualifyingRaw({ duration: 599 }), provedEvidence());
  const exact = qualifyCallRailRecoveryFact(qualifyingRaw({ duration: 600 }), provedEvidence());
  assert.deepEqual([short.status, short.reason], ["rejected", "duration-below-threshold"]);
  assert.deepEqual([exact.status, exact.reason], ["qualified", "qualified"]);
  assert.equal(MINIMUM_RECOVERY_DURATION_SECONDS, 600);
});

test("answered false rejects even when duration is long", () => {
  const result = qualifyCallRailRecoveryFact(
    qualifyingRaw({ answered: false, duration: 3_600 }),
    provedEvidence(),
  );
  assert.deepEqual([result.status, result.reason], ["rejected", "not-answered"]);
});

test("missing human-answer proof enters review instead of qualifying", () => {
  const evidence = provedEvidence();
  evidence.humanAnswerEvidence = null;
  const result = qualifyCallRailRecoveryFact(qualifyingRaw(), evidence);
  assert.deepEqual([result.status, result.reason], ["review", "human-answer-unproven"]);
});

test("ambiguous current case state fails closed", () => {
  const evidence = provedEvidence();
  evidence.currentCaseEvidence = null;
  const result = qualifyCallRailRecoveryFact(qualifyingRaw(), evidence);
  assert.deepEqual([result.status, result.reason], ["review", "current-case-state-unproven"]);
});

test("next business window skips the weekend and follows Pacific DST", () => {
  const fall = resolveRecoveryEpisodeTiming("2026-10-31T00:00:00.000Z");
  const spring = resolveRecoveryEpisodeTiming("2026-03-07T00:00:00.000Z");
  assert.equal(fall.eligibleFrom.toISOString(), "2026-11-02T15:50:00.000Z");
  assert.equal(spring.eligibleFrom.toISOString(), "2026-03-09T14:50:00.000Z");
});

test("episode expiry is 120 Pacific calendar days without DST drift", () => {
  const timing = resolveRecoveryEpisodeTiming("2026-03-07T01:15:30.250Z");
  assert.equal(timing.expiresAt.toISOString(), "2026-07-05T00:15:30.250Z");
});

test("recovery policy permits exactly two attempts per Pacific day", () => {
  const now = new Date("2026-07-30T23:00:00.000Z");
  assert.equal(resolveLeadDeliveryContactPolicy(recoveryItem({ dailyAttemptCount: 0 }), { now }).allowed, true);
  assert.equal(resolveLeadDeliveryContactPolicy(recoveryItem({ dailyAttemptCount: 1 }), { now }).allowed, true);
  const capped = resolveLeadDeliveryContactPolicy(recoveryItem({ dailyAttemptCount: 2 }), { now });
  assert.deepEqual([capped.allowed, capped.reason], [false, "daily-attempt-limit"]);
  assert.equal(capped.maximumDailyAttempts, 2);
});

test("recovery policy enforces the 120-minute retry floor", () => {
  const early = resolveLeadDeliveryContactPolicy(recoveryItem({
    lastContactAt: "2026-07-30T20:00:00.000Z",
  }), { now: "2026-07-30T21:59:59.999Z" });
  const boundary = resolveLeadDeliveryContactPolicy(recoveryItem({
    lastContactAt: "2026-07-30T20:00:00.000Z",
  }), { now: "2026-07-30T22:00:00.000Z" });
  assert.deepEqual([early.allowed, early.reason], [false, "recovery-retry-not-due"]);
  assert.equal(early.nextEligibleAt.toISOString(), "2026-07-30T22:00:00.000Z");
  assert.equal(boundary.allowed, true);
});

test("human answer blocks a second same-day recovery attempt", () => {
  const held = resolveLeadDeliveryContactPolicy(recoveryItem({
    lastHumanAnsweredAt: "2026-07-30T19:00:00.000Z",
  }), { now: "2026-07-30T23:00:00.000Z" });
  assert.deepEqual([held.allowed, held.reason], [false, "recovery-human-answered-today"]);
});

test("recovery policy fails closed before start and at expiration", () => {
  const before = resolveLeadDeliveryContactPolicy(recoveryItem({
    eligibleFrom: "2026-07-31T14:50:00.000Z",
  }), { now: "2026-07-30T23:00:00.000Z" });
  const expired = resolveLeadDeliveryContactPolicy(recoveryItem({
    expiresAt: "2026-07-30T23:00:00.000Z",
  }), { now: "2026-07-30T23:00:00.000Z" });
  assert.deepEqual([before.allowed, before.reason], [false, "recovery-not-started"]);
  assert.deepEqual([expired.allowed, expired.reason], [false, "recovery-expired"]);
});

test("ordinary age policy stays behavior-compatible", () => {
  const now = new Date("2026-07-30T23:00:00.000Z");
  for (const receivedAt of [
    "2026-07-30T17:00:00.000Z",
    "2026-07-20T17:00:00.000Z",
    "2026-07-01T17:00:00.000Z",
    "2026-06-01T17:00:00.000Z",
  ]) {
    const item = { receivedAt };
    const resolved = resolveLeadDeliveryContactPolicy(item, { now });
    assert.equal(resolved.maximumDailyAttempts, dailyAttemptLimitForLeadAge(item, { now, maximum: 3 }));
    assert.equal(resolved.minimumRetryMinutes, retryDelayMinutesForLeadAge(item, { now }));
    assert.deepEqual([resolved.allowed, resolved.reason], [true, "ordinary-age-policy"]);
  }
});

test("recovery ranks ahead of generic aged inventory only inside older_available", () => {
  const recovery = {
    workItemId: "recovery",
    inventoryClass: CALL_RECOVERY_INVENTORY_CLASS,
    lastContactAt: "2026-07-29T17:00:00.000Z",
    nextContactAt: "2026-07-30T20:00:00.000Z",
  };
  const ordinary = {
    workItemId: "ordinary",
    lastContactAt: null,
    nextContactAt: "2026-07-30T19:00:00.000Z",
  };
  assert.equal(compareRecoveryPoolItems(POOLS.OLDER_AVAILABLE, recovery, ordinary), -1);
  assert.equal(
    compareRecoveryPoolItems(POOLS.FOLLOW_UP_DUE, recovery, ordinary),
    comparePoolItems(POOLS.FOLLOW_UP_DUE, recovery, ordinary),
  );
});

test("recovery outcome table schedules retry, holds answered, and freezes unknown", () => {
  const noAnswer = decideRecoveryOutcomeState({
    normalizedOutcome: "no answer",
    completedAt: "2026-07-30T20:00:00.000Z",
    dailyAttemptCount: 1,
  });
  const answered = decideRecoveryOutcomeState({
    normalizedOutcome: "answered",
    completedAt: "2026-07-30T20:00:00.000Z",
    dailyAttemptCount: 1,
  });
  const unknown = decideRecoveryOutcomeState({
    normalizedOutcome: "mystery",
    completedAt: "2026-07-30T20:00:00.000Z",
    dailyAttemptCount: 1,
  });
  assert.equal(noAnswer.nextContactAt.toISOString(), "2026-07-30T22:00:00.000Z");
  assert.deepEqual([answered.state, answered.nextContactAt, answered.reason], [
    "follow_up_wait",
    null,
    "recovery-human-answered-day-hold",
  ]);
  assert.deepEqual([unknown.state, unknown.nextContactAt, unknown.reason], [
    "review",
    null,
    "recovery-outcome-review",
  ]);
});

// ── the three defects the first draft shipped with ────────────────────────
//
// All three were found by reading the code rather than by running it: the
// suite above was fully green with every one of them present. Worth saying,
// because "14/14 pass" was not evidence that the tenancy rule worked.

const {
  CALLRAIL_TENANT_DOMAIN,
} = require("../../packages/shared-services/src/callrailCallFactService");

const PROVED = {
  mailSourceEvidence: "proved",
  humanAnswerEvidence: "proved",
  caseIdentityEvidence: "proved",
  currentCaseEvidence: "proved",
};
const LONG_ANSWERED_CALL = {
  id: "CAL-tenant", direction: "inbound", answered: true, duration: 900,
  customer_phone_number: "(724) 967-4387", tracking_phone_number: "1-800-555-1212",
};

test("only the TAG CallRail tenant can qualify — the guard must actually bite", () => {
  // As first written, `fact.tenantDomain` was COPIED from the `tenantDomain`
  // option and then compared back to that same option, so the check could only
  // fail on an empty string. `tenantDomain: "WYNN"` returned `qualified`.
  // Work order §2.1(3) is "call belongs to the TAG CallRail tenant", and an
  // unenforced rule that reads as enforced is worse than no rule.
  const tag = qualifyCallRailRecoveryFact(LONG_ANSWERED_CALL, { tenantDomain: "TAG", ...PROVED });
  assert.equal(tag.status, "qualified");

  for (const other of ["WYNN", "AMITY", "LEGACY"]) {
    const r = qualifyCallRailRecoveryFact(LONG_ANSWERED_CALL, { tenantDomain: other, ...PROVED });
    assert.equal(r.status, "rejected", `tenant ${JSON.stringify(other)} must not qualify`);
    assert.equal(r.reason, "not-the-callrail-tenant");
  }

  // What is NOT a different tenant: case, whitespace, and absence. "tag " is
  // the TAG tenant; omitting the option, or passing empty, means "the CallRail
  // tenant" and resolves to the same place. The guard is about tenancy, not
  // string hygiene.
  for (const sameThing of ["tag ", "", undefined]) {
    assert.equal(
      qualifyCallRailRecoveryFact(LONG_ANSWERED_CALL, { tenantDomain: sameThing, ...PROVED }).status,
      "qualified",
      `${JSON.stringify(sameThing)} is the TAG tenant`,
    );
  }
});

test("there is exactly one CallRail tenant and it is TAG", () => {
  // Not a default to be overridden — it is the tenancy fact the whole feature
  // rests on, and the same reason a WYNN board can never carry a CallRail call.
  assert.equal(CALLRAIL_TENANT_DOMAIN, "TAG");
});

test("phone normalization is the canonical helper, not a second copy", () => {
  // The draft carried its own normalizer. This repo has twice paid for a second
  // copy of a shared rule drifting from the first, so it now borrows
  // casePhoneFoldService's (which is dependency-free, so CR-1 stays pure).
  const { normalizePhone } = require("../../packages/shared-services/src/casePhoneFoldService");
  for (const raw of ["(724) 967-4387", "1-724-967-4387", "7249674387", "+1 724 967 4387"]) {
    const viaFact = normalizeCallRailCallFact({ customer_phone_number: raw }).customerPhone;
    assert.equal(viaFact, normalizePhone(raw), `drifted on ${raw}`);
    assert.equal(viaFact, "7249674387");
  }
  // And the shapes that must NOT become a phone.
  for (const bad of ["", null, "555-1212", "911", "1234567890123"]) {
    assert.equal(normalizeCallRailCallFact({ customer_phone_number: bad }).customerPhone,
      normalizePhone(bad), `drifted on ${JSON.stringify(bad)}`);
  }
});

test("the inventory class is spelled the way the work order specifies", () => {
  // CR-6 persists this onto LeadDeliveryItem. A mismatch between the contract
  // and the stored value would be invisible until it was in live rows.
  assert.equal(CALL_RECOVERY_INVENTORY_CLASS, "callrail_long_call_recovery");
  assert.equal(CALL_RECOVERY_CONTACT_POLICY_ID, "long_call_recovery_120d_2x");
  assert.equal(CALL_RECOVERY_DNC_POLICY_ID, "full_dnc_loadin_30_60_90_logics_daily_v1");
  assert.equal(CALL_RECOVERY_LOGICS_POLICY_ID, "tag_active_prospect_only_v1");
});

test("recovery Logics policy allows only a proved TAG active prospect", () => {
  const byId = resolveCallRecoveryLogicsEligibility({ domain: "TAG", statusId: 1 });
  const byText = resolveCallRecoveryLogicsEligibility({
    domain: "TAG", statusText: "[Active Prospect]-Opened",
  });
  assert.deepEqual([byId.decision, byId.allowedProspectStatus, byId.entityDnc], ["allow", true, false]);
  assert.deepEqual([byText.decision, byText.allowedProspectStatus], ["allow", true]);
});

test("recovery Logics policy terminates proved DNC and non-prospect states", () => {
  const dnc = resolveCallRecoveryLogicsEligibility({ domain: "TAG", statusId: 39 });
  const client = resolveCallRecoveryLogicsEligibility({ domain: "TAG", statusId: 210 });
  assert.deepEqual([dnc.decision, dnc.entityDnc, dnc.reason], ["terminal", true, "logics-dnc"]);
  assert.deepEqual(
    [client.decision, client.allowedProspectStatus, client.reason],
    ["terminal", false, "not-active-prospect"],
  );
});

test("recovery Logics policy holds wrong-tenant, unmapped, and conflicting evidence", () => {
  for (const input of [
    { domain: "WYNN", statusId: 1 },
    { domain: "TAG", statusId: 99999 },
    { domain: "TAG", statusId: 1, statusText: "[TIER 1]-ACTIVE" },
  ]) {
    const result = resolveCallRecoveryLogicsEligibility(input);
    assert.deepEqual([result.decision, result.allowedProspectStatus], ["hold", null]);
  }
});

test("CR-1 stays pure — no Mongo, HTTP, flags or provider code", () => {
  // The phase contract is "pure qualification"; the value of that is being able
  // to prove the rules without a network. Reaching for mongoose or an env flag
  // here is what quietly ends that.
  const fs = require("node:fs");
  const src = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/callrailCallFactService"), "utf8");
  for (const forbidden of ["mongoose", "process.env", "axios", "fetch(", "require(\"../../shared-models"]) {
    assert.ok(!src.includes(forbidden), `callrailCallFactService reached for ${forbidden}`);
  }
});
