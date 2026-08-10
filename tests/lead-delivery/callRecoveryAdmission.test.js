"use strict";

// CR-5 / CR-6 / CR-7 gate.
//
// Admission is the last thing standing between an evidence record and a real
// phone ringing in somebody's house. Almost every test below asserts that we
// DO NOT call — because the expensive failure here is not a missed lead, it is
// dialling a person who bought, who asked us to stop, or who was never the
// right person to begin with.
//
// The single rule under test throughout: an unavailable, missing or
// contradictory read is a HOLD. It is never permission.

const test = require("node:test");
const assert = require("node:assert/strict");

const svc = require("../../packages/shared-services/src/callRecoveryAdmissionService");

const NOW = new Date("2026-08-03T18:00:00Z"); // Mon 11:00 Pacific

const EPISODE = (over = {}) => ({
  episodeId: "callrail-mail-long-call-v1:TAG:421385:1",
  programKey: "callrail-mail-long-call-v1",
  domain: "TAG", caseId: "421385", normalizedPhone: "7249674387",
  state: "eligible",
  firstQualifyingCallAt: new Date("2026-07-30T18:00:00Z"),
  eligibleFrom: new Date("2026-07-31T14:50:00Z"),
  expiresAt: new Date("2026-11-27T18:00:00Z"),
  ...over,
});

const CLEAN_DNC = { result: "clean", checkedAt: new Date("2026-08-02T18:00:00Z") };
const OPEN_CASE = { allowedProspectStatus: true, convertedAt: null, paymentCount: 0, totalPaid: 0 };
const OK = { now: NOW, caseState: OPEN_CASE, dncState: CLEAN_DNC, contactWindowOpen: true, existingWorkItem: null };

// ── CR-5: admission ───────────────────────────────────────────────────────

test("a clean, open, in-window episode is admitted", () => {
  assert.equal(svc.admitEpisode({ episode: EPISODE(), ...OK }).decision, "admit");
});

test("EVERY unproven read holds — none of them fall through to admit", () => {
  // The table that matters. If any row here ever returns "admit", the program
  // is calling people on the strength of a lookup that did not answer.
  const cases = [
    ["dnc not read", { dncState: null }, "dnc-unproven"],
    ["dnc lookup failed", { dncState: { result: "failed" } }, "dnc-lookup-failed"],
    ["dnc result absent", { dncState: { result: "unknown" } }, "dnc-unproven"],
    ["dnc never timestamped", { dncState: { result: "clean" } }, "dnc-unproven"],
    ["case state not read", { caseState: null }, "case-state-unproven"],
    ["status not proven", { caseState: { allowedProspectStatus: null } }, "status-unproven"],
    ["contact window unknown", { contactWindowOpen: null }, "contact-window-unproven"],
    ["work item not read", { existingWorkItem: undefined }, "work-item-unproven"],
  ];
  for (const [label, patch, reason] of cases) {
    const r = svc.admitEpisode({ episode: EPISODE(), ...OK, ...patch });
    assert.equal(r.decision, "hold", `${label} must hold, got ${r.decision}`);
    assert.equal(r.reason, reason, label);
    assert.equal(r.retryable, true, `${label} must be retryable`);
  }
});

test("a stale clean DNC result is not a current one", () => {
  const r = svc.admitEpisode({
    episode: EPISODE(), ...OK,
    dncState: { result: "clean", checkedAt: new Date("2026-06-01T00:00:00Z") },
  });
  assert.equal(r.decision, "hold");
  assert.equal(r.reason, "dnc-stale");
});

test("a clean recovery DNC result remains valid until its durable checkpoint", () => {
  const episode = EPISODE();
  const nextCheckAt = new Date(new Date(episode.firstQualifyingCallAt).getTime() + 30 * 86400000);
  const r = svc.admitEpisode({
    episode,
    ...OK,
    now: new Date(new Date(episode.firstQualifyingCallAt).getTime() + 20 * 86400000),
    dncState: {
      result: "clean",
      checkedAt: new Date(episode.firstQualifyingCallAt),
      nextCheckAt,
    },
  });
  assert.equal(r.decision, "admit");
});

test("an overdue recovery DNC checkpoint holds until it is refreshed", () => {
  const episode = EPISODE();
  const nextCheckAt = new Date(new Date(episode.firstQualifyingCallAt).getTime() + 30 * 86400000);
  const r = svc.admitEpisode({
    episode,
    ...OK,
    now: new Date(nextCheckAt.getTime() + 1),
    dncState: {
      result: "clean",
      checkedAt: new Date(episode.firstQualifyingCallAt),
      nextCheckAt,
    },
  });
  assert.equal(r.decision, "hold");
  assert.equal(r.reason, "dnc-stale");
});

test("a completed day-90 DNC checkpoint stays valid until program expiry", () => {
  const episode = EPISODE();
  const first = new Date(episode.firstQualifyingCallAt);
  const r = svc.admitEpisode({
    episode,
    ...OK,
    now: new Date(first.getTime() + 100 * 86400000),
    dncState: {
      result: "clean",
      checkedAt: new Date(first.getTime() + 90 * 86400000),
      nextCheckAt: null,
    },
  });
  assert.equal(r.decision, "admit");
});

test("entity suppression outranks everything and terminates", () => {
  // §14.3 — entity-specific DNC always wins over inquiry/relationship timing.
  for (const [patch, reason] of [
    [{ entityDnc: true }, "entity-dnc"],
    [{ optOut: true }, "opt-out"],
    [{ stopContact: true }, "stop-contact"],
    [{ result: "hit" }, "dnc-hit"],
  ]) {
    const r = svc.admitEpisode({ episode: EPISODE(), ...OK, dncState: { ...CLEAN_DNC, ...patch } });
    assert.equal(r.decision, "terminal", reason);
    assert.equal(r.reason, reason);
  }
});

test("suppression is checked BEFORE case state, so a DNC on a converted case still reads as DNC", () => {
  // Ordering is the assertion. If case state were checked first this would
  // terminate as "converted" and the durable DNC effect would never fire.
  const r = svc.admitEpisode({
    episode: EPISODE(), ...OK,
    dncState: { ...CLEAN_DNC, entityDnc: true },
    caseState: { ...OPEN_CASE, convertedAt: new Date() },
  });
  assert.equal(r.reason, "entity-dnc");
});

test("any sale signal terminates — the CallRail call is not the sale authority", () => {
  // §13: a sale posted AFTER the qualifying call still removes the case.
  for (const [patch, reason] of [
    [{ convertedAt: new Date() }, "converted"],
    [{ paymentCount: 1 }, "paid"],
    [{ totalPaid: 250 }, "paid"],
    [{ retainedClient: true }, "retained-client"],
    [{ activeAppointment: true }, "active-appointment"],
    [{ allowedProspectStatus: false }, "not-a-prospect"],
  ]) {
    const r = svc.admitEpisode({ episode: EPISODE(), ...OK, caseState: { ...OPEN_CASE, ...patch } });
    assert.equal(r.decision, "terminal", reason);
    assert.equal(r.reason, reason);
  }
});

test("an existing work item holds recovery rather than competing for the person", () => {
  // §15.3 — one case, one owner. Two policies dialling the same person is the
  // thing the canonical work item exists to prevent.
  const r = svc.admitEpisode({ episode: EPISODE(), ...OK, existingWorkItem: { state: "queued" } });
  assert.equal(r.decision, "hold");
  assert.equal(r.reason, "existing-delivery-owns-case");

  for (const state of ["review", "delivery_failed", "in_call", "provider_accepted"]) {
    const busy = svc.admitEpisode({ episode: EPISODE(), ...OK, existingWorkItem: { state } });
    assert.equal(busy.decision, "hold", state);
    assert.equal(busy.reason, "existing-delivery-busy");
  }
});

test("a terminal work item with a business reason mirrors; without one it holds", () => {
  const mirrored = svc.admitEpisode({
    episode: EPISODE(), ...OK,
    existingWorkItem: { state: "terminal", terminalAt: NOW, terminalBusinessReason: "dnc" },
  });
  assert.equal(mirrored.decision, "terminal");
  assert.equal(mirrored.mirrorReason, "dnc");

  // An unexplained terminal is NOT permission to terminalize the episode —
  // we do not know why it died, so we wait rather than guess.
  const unexplained = svc.admitEpisode({
    episode: EPISODE(), ...OK, existingWorkItem: { state: "terminal", terminalAt: NOW },
  });
  assert.equal(unexplained.decision, "hold");
});

test("the program clock beats everything, including a clean case", () => {
  const expired = svc.admitEpisode({
    episode: EPISODE({ expiresAt: new Date("2026-08-01T00:00:00Z") }), ...OK,
  });
  assert.equal(expired.decision, "terminal");
  assert.equal(expired.reason, "program-expired");
  assert.equal(expired.expire, true);

  const early = svc.admitEpisode({
    episode: EPISODE({ eligibleFrom: new Date("2026-09-01T00:00:00Z") }), ...OK,
  });
  assert.equal(early.decision, "hold");
  assert.equal(early.reason, "before-eligible-window");
});

test("a closed episode is never re-admitted", () => {
  for (const state of ["terminal", "expired"]) {
    const r = svc.admitEpisode({ episode: EPISODE({ state }), ...OK });
    assert.equal(r.decision, "terminal");
    assert.equal(r.alreadyClosed, true);
  }
  assert.equal(svc.admitEpisode({ episode: EPISODE({ state: "review" }), ...OK }).decision, "review");
});

test("an unusable phone is a review, not a silent skip", () => {
  const r = svc.admitEpisode({ episode: EPISODE({ normalizedPhone: "555" }), ...OK });
  assert.equal(r.decision, "review");
  assert.equal(r.reason, "phone-invalid");
});

// ── §14.2 checkpoints ─────────────────────────────────────────────────────

test("DNC checkpoints run from the FIRST call and stop before day 120", () => {
  const first = new Date("2026-07-30T18:00:00Z");
  const day = (n) => new Date(first.getTime() + n * 86400000);
  assert.deepEqual(svc.nextDncCheckpointAt(first, { now: day(1) }), day(30));
  assert.deepEqual(svc.nextDncCheckpointAt(first, { now: day(31) }), day(60));
  assert.deepEqual(svc.nextDncCheckpointAt(first, { now: day(61) }), day(90));
  // Past day 90 there is no next check — expiry takes it, and a recheck booked
  // beyond day 120 would imply the program outlives its own clock.
  assert.equal(svc.nextDncCheckpointAt(first, { now: day(91) }), null);
});

// ── CR-6: the source row ──────────────────────────────────────────────────

test("a recovery source row carries NO leadCadenceId — voice-only is structural", () => {
  // A LeadCadence row brings SMS/email/RVM schedule actions with it. The
  // absence of the id is the enforcement, not a policy check somewhere else.
  const row = svc.buildRecoverySourceRow(EPISODE(), { now: NOW });
  assert.equal(row.leadCadenceId, null);
  assert.ok(!("cadenceState" in row));
  assert.ok(!("smsEnabled" in row));
});

test("the source row uses the episode's own clock, not today", () => {
  // Pretending an old case arrived this morning would put it in new_today and
  // jump the queue ahead of genuinely fresh leads.
  const row = svc.buildRecoverySourceRow(EPISODE(), { now: NOW });
  assert.equal(row.receivedAt.toISOString(), "2026-07-30T18:00:00.000Z");
  assert.notEqual(row.receivedAt.getTime(), NOW.getTime());
});

test("the source row carries the contract's inventory class and policy id", () => {
  const row = svc.buildRecoverySourceRow(EPISODE({ displayName: "Private Example Person" }), { now: NOW });
  assert.equal(row.inventoryClass, "callrail_long_call_recovery");
  assert.equal(row.contactPolicyId, "long_call_recovery_120d_2x");
  assert.equal(row.state, "eligible");
  assert.equal(row.activeAttempt, true);
  assert.equal(row.callable, true);
  assert.deepEqual(row.eligibility, {
    ok: true,
    reason: "call-recovery-admitted",
    retryable: false,
  });
  assert.equal(row.sourceKind, "call_recovery");
  assert.equal(row.episodeId, EPISODE().episodeId);
  assert.equal(row.firstQualifyingCallAt.getTime(), EPISODE().firstQualifyingCallAt.getTime());
  assert.equal(row.firstName, "Private");
  assert.equal(row.lastName, "Example Person");
});

test("fresh authoritative case names populate a recovery row when discovery had none", () => {
  const row = svc.buildRecoverySourceRow(EPISODE(), {
    now: NOW,
    firstName: "Private",
    lastName: "Example Person",
  });
  assert.equal(row.displayName, "Private Example Person");
  assert.equal(row.firstName, "Private");
  assert.equal(row.lastName, "Example Person");
});

test("policy numbers come from checked-in code, never from the episode", () => {
  // §17 — numeric values are re-derived, not trusted from Mongo metadata. A
  // tampered episode must not be able to buy itself extra attempts.
  const row = svc.buildRecoverySourceRow(
    EPISODE({ maximumDailyAttempts: 99, minimumRetryMinutes: 1 }), { now: NOW },
  );
  assert.equal(row.policy.maximumDailyAttempts, 2);
  assert.equal(row.policy.minimumRetryMinutes, 120);
  assert.equal(row.policy.maximumProgramAgeDays, 120);
});

test("an expired episode produces a policy that refuses, not one that allows", () => {
  const row = svc.buildRecoverySourceRow(EPISODE({ expiresAt: new Date("2026-08-01T00:00:00Z") }), { now: NOW });
  assert.equal(row.policy.allowed, false);
  assert.equal(row.policy.reason, "recovery-expired");
});

// ── CR-7: Call End ────────────────────────────────────────────────────────

const END = (outcome, count = 1) => svc.applyCallEndToEpisode({
  episode: EPISODE(), normalizedOutcome: outcome, dailyAttemptCount: count,
  completedAt: NOW, providerCallId: "PB-1",
});

test("a human answer gets NO same-day retry", () => {
  // Calling somebody back an hour after a real conversation is how a recovery
  // program becomes a nuisance.
  const r = END("answered", 1);
  assert.equal(r.nextDayOnly, true);
  assert.equal(r.removeExactContact, true);
  assert.equal(r.episodeTransition.to, "eligible");
  assert.equal(r.episodeTransition.reason, "answered-next-day-hold");
});

test("retryable outcomes keep the contact under the cap and drop it at the cap", () => {
  for (const outcome of ["no_answer", "voicemail", "busy"]) {
    const under = END(outcome, 1);
    assert.equal(under.removeExactContact, false, `${outcome} under cap keeps the contact for recycle`);
    assert.equal(under.nextDayOnly, false);

    const at = END(outcome, 2);
    assert.equal(at.removeExactContact, true, `${outcome} at cap must remove the exact contact`);
    assert.equal(at.nextDayOnly, true);
    assert.equal(at.episodeTransition.reason, "daily-cap-reached");
  }
});

test("terminal outcomes retire the episode — using the CANONICAL vocabulary", () => {
  // This test used to feed raw PhoneBurner strings (sale, bad_number,
  // wrong_person, non_prospect). normalizeOutcome collapses those: seven of
  // them can never arrive, and the one that matters — bad_lead, the canonical
  // form of a CONFIRMED WRONG NUMBER — was never exercised. It fell through to
  // the retryable tail, so we kept redialling numbers people had already told
  // us were wrong. Feed what the normalizer actually emits.
  for (const [outcome, reason] of [
    ["appointment", "appointment-set"],
    ["client", "retained-client"],
    ["dnc", "dnc"],
    ["bad_lead", "bad-number"],
  ]) {
    const r = END(outcome);
    assert.equal(r.episodeTransition.to, "terminal", outcome);
    assert.equal(r.episodeTransition.reason, reason);
    assert.equal(r.removeExactContact, true, outcome);
  }
});

test("every spelling of a wrong number stops the dialling", () => {
  // The alias set is where this bug actually lived.
  for (const spelling of ["bad_lead", "bad number", "wrong number", "badnumber", "wrongnumber", "bad lead"]) {
    const r = END(spelling);
    assert.equal(r.episodeTransition.to, "terminal", spelling);
    assert.equal(r.removeExactContact, true, spelling);
  }
});

test("the delivery verdict and the episode verdict can never contradict", () => {
  // The shape of the original bug: one return object saying terminal in one
  // field and eligible in another. Sweep the whole vocabulary.
  for (const raw of ["no_answer", "voicemail", "busy", "congestion", "intercept",
    "answered", "dnc", "do not call", "bad_lead", "bad number", "wrong number",
    "appointment", "client", "sale", "payment", "unknown", "", null]) {
    const r = END(raw);
    if (r.delivery && r.delivery.state === "terminal") {
      assert.equal(r.episodeTransition.to, "terminal",
        `${raw}: delivery said terminal but the episode said ${r.episodeTransition.to}`);
      assert.equal(r.removeExactContact, true, `${raw}: a terminal outcome must pull the contact`);
    }
  }
});

test("a DNC disposition also drives durable downstream suppression", () => {
  // §20 — retiring this episode is not the same as recording that this person
  // said stop. The second one has to outlive the program.
  for (const outcome of ["dnc", "opt_out"]) {
    const r = END(outcome);
    assert.equal(r.episodeTransition.to, "terminal");
    assert.equal(r.durableDnc, true, outcome);
    assert.equal(r.removeExactContact, true);
  }
  assert.notEqual(END("no_answer").durableDnc, true, "an ordinary outcome must not suppress anybody");
});

test("an unknown or contradictory callback freezes for review", () => {
  for (const outcome of ["unknown", "review", "", null]) {
    const r = END(outcome);
    assert.equal(r.episodeTransition.to, "review", JSON.stringify(outcome));
    assert.equal(r.removeExactContact, true, "a frozen episode must not stay dialable");
  }
});

test("replay is identified by call AND episode, so a duplicate callback is a no-op", () => {
  const a = END("no_answer");
  const b = END("no_answer");
  assert.equal(a.effectKey, b.effectKey);
  assert.match(a.effectKey, /^callrail-mail-long-call-v1:TAG:421385:1:PB-1$/);
  // A different call against the same episode is a DIFFERENT effect.
  const other = svc.applyCallEndToEpisode({
    episode: EPISODE(), normalizedOutcome: "no_answer", dailyAttemptCount: 1, providerCallId: "PB-2",
  });
  assert.notEqual(a.effectKey, other.effectKey);
});

test("the attempt decision comes from leadDeliveryService, not from this file", () => {
  // §17 — a code path that re-derives the cap instead of calling the resolver
  // is a test failure. Here: the delivery verdict must be present and carry the
  // recovery numbers, proving it was delegated.
  const r = END("no_answer", 1);
  assert.ok(r.delivery, "the delivery decision must be attached");
  assert.equal(typeof r.delivery.state, "string");
  const fs = require("node:fs");
  const src = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/callRecoveryAdmissionService"), "utf8");
  assert.ok(!/maximumDailyAttempts\s*[:=]\s*\d/.test(src), "no cap literal may live in this file");
  assert.ok(!/minimumRetryMinutes\s*[:=]\s*\d/.test(src), "no retry literal may live in this file");
});

// ── §19's last row: a duplicate callback changes nothing ──────────────────
//
// The first version returned `countedAttempt: true` unconditionally and handed
// back an effectKey, trusting every caller to dedupe before believing it. That
// is a trap, not a contract — PhoneBurner redelivers webhooks, and a caller
// that read the field and acted on it would burn a second attempt against a
// 2/day cap on a replay.

test("a duplicate callback counts nothing and moves nothing", () => {
  const r = svc.applyCallEndToEpisode({
    episode: EPISODE(), normalizedOutcome: "no_answer", dailyAttemptCount: 1,
    providerCallId: "PB-1", alreadyApplied: true,
  });
  assert.equal(r.duplicate, true);
  assert.equal(r.countedAttempt, false, "a replay must not burn an attempt");
  assert.equal(r.episodeTransition, null, "and must not move the episode");
  assert.equal(r.removeExactContact, false);
});

test("the first application of the same effect DOES count", () => {
  const r = svc.applyCallEndToEpisode({
    episode: EPISODE(), normalizedOutcome: "no_answer", dailyAttemptCount: 1,
    providerCallId: "PB-1", alreadyApplied: false,
  });
  assert.equal(r.countedAttempt, true);
  assert.ok(r.episodeTransition);
});

test("a Call End with no provider call id freezes instead of guessing", () => {
  // Two such callbacks would collapse onto one effectKey, so they cannot be
  // told apart — which is the "unknown/contradictory" row, not a free attempt.
  const r = svc.applyCallEndToEpisode({
    episode: EPISODE(), normalizedOutcome: "no_answer", dailyAttemptCount: 1,
    providerCallId: null,
  });
  assert.equal(r.countedAttempt, false);
  assert.equal(r.episodeTransition.to, "review");
  assert.equal(r.removeExactContact, true, "a frozen episode must not stay dialable");
});
