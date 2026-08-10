"use strict";

// callRecoveryAdmissionService — CR-5, CR-6, CR-7.
//
// Three jobs, one file, because they are the same question asked at three
// moments:
//
//   CR-5 admitEpisode()          may this episode become callable work?
//   CR-6 buildRecoverySourceRow() what does that work look like to delivery?
//   CR-7 applyCallEndToEpisode()  what did the call do to the episode?
//
// WHAT THIS FILE IS NOT: a decision owner. Pool, priority, cap, timing and
// outcome policy all live in `leadDeliveryService` (§15.1, §17) and are called
// from here, never re-derived. If a number appears in this file that also
// appears there, one of them is about to drift — that is precisely how the
// tenant rule ended up in one block out of four.
//
// THE GOVERNING RULE, everywhere below: an unavailable, missing or
// contradictory read is a retryable HOLD. It is never permission. "Could not
// verify that they closed" must never round down to "did not close", because
// the cost of that rounding is dialling somebody who bought, or somebody who
// asked us to stop.

const {
  CALL_RECOVERY_CONTACT_POLICY_ID,
  CALL_RECOVERY_INVENTORY_CLASS,
  decideRecoveryOutcomeState,
  resolveLeadDeliveryContactPolicy,
} = require("./leadDeliveryService");

// §14.2 — checkpoints measured from firstQualifyingCallAt, then expiry.
const DNC_CHECKPOINT_DAYS = Object.freeze([30, 60, 90]);
const DAY_MS = 86400000;

// §14.1 — a clean DNC result may be reused inside this window rather than
// re-billing the provider for the same phone on consecutive days.
const DNC_REUSE_WINDOW_MS = 7 * DAY_MS;

/** Hold/terminal/admit verdicts, all carrying a bounded machine reason. */
const admit = (extra = {}) => ({ decision: "admit", reason: null, ...extra });
const hold = (reason, extra = {}) => ({ decision: "hold", reason, retryable: true, ...extra });
const terminal = (reason, extra = {}) => ({ decision: "terminal", reason, retryable: false, ...extra });
const review = (reason, extra = {}) => ({ decision: "review", reason, retryable: false, ...extra });

function asDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * §14.2 — the next DNC checkpoint, or null when the program has run out.
 *
 * Measured from the FIRST qualifying call, not from the last check, so a late
 * check cannot push the schedule past day 120 and buy the program extra life.
 */
function nextDncCheckpointAt(firstQualifyingCallAt, { now = new Date(), checkpoints = DNC_CHECKPOINT_DAYS } = {}) {
  const first = asDate(firstQualifyingCallAt);
  if (!first) return null;
  for (const day of checkpoints) {
    const at = new Date(first.getTime() + day * DAY_MS);
    if (at > now) return at;
  }
  return null;
}

/**
 * CR-5 — may this episode be offered to delivery right now?
 *
 * Runs at admission AND immediately before every provider claim (§5). A clean
 * nightly snapshot cannot authorize a call after the case moved during the day,
 * so this is deliberately cheap to re-run and deliberately paranoid.
 *
 * Every input is injected. There is no Mongo and no HTTP in this function,
 * which is what makes the fail-closed behaviour provable.
 */
function admitEpisode({
  episode,
  now = new Date(),
  caseState = null,          // §13 — conversion/payment/status/appointment
  dncState = null,           // §14 — provider verdict + entity suppression
  contactWindowOpen = null,  // §5 — supported timezone/window
  existingWorkItem = undefined, // §15.3 — undefined means "not read yet"
} = {}) {
  if (!episode) throw new Error("admitEpisode requires an episode");

  // 0. The program's own clock beats every other consideration. An expired
  //    episode is not a hold — there is nothing left to wait for.
  const expiresAt = asDate(episode.expiresAt);
  if (expiresAt && expiresAt <= now) return terminal("program-expired", { expire: true });
  const eligibleFrom = asDate(episode.eligibleFrom);
  if (eligibleFrom && eligibleFrom > now) return hold("before-eligible-window");
  if (episode.state === "terminal" || episode.state === "expired") {
    return terminal("episode-closed", { alreadyClosed: true });
  }
  if (episode.state === "review") return review("episode-in-review");

  // 1. ENTITY SUPPRESSION FIRST (§14.3). It outranks inquiry timing, program
  //    membership and everything below — if this person said stop, nothing
  //    else in this function is relevant.
  if (!dncState) return hold("dnc-unproven");
  if (dncState.entityDnc === true) return terminal("entity-dnc");
  if (dncState.optOut === true) return terminal("opt-out");
  if (dncState.stopContact === true) return terminal("stop-contact");
  if (dncState.result === "hit") return terminal("dnc-hit");
  if (dncState.result === "failed") return hold("dnc-lookup-failed");
  if (dncState.result !== "clean") return hold("dnc-unproven");
  // A stale clean result is not a current clean result.
  const checkedAt = asDate(dncState.checkedAt);
  if (!checkedAt) return hold("dnc-unproven");
  const nextCheckAt = asDate(dncState.nextCheckAt);
  const firstQualifyingCallAt = asDate(episode.firstQualifyingCallAt);
  const finalCheckpointAt = firstQualifyingCallAt
    ? new Date(firstQualifyingCallAt.getTime() + Math.max(...DNC_CHECKPOINT_DAYS) * DAY_MS)
    : null;
  const finalCheckpointComplete = finalCheckpointAt && checkedAt >= finalCheckpointAt;
  if (nextCheckAt) {
    if (nextCheckAt <= now) return hold("dnc-stale");
  } else if (!finalCheckpointComplete
    && now.getTime() - checkedAt.getTime() > DNC_REUSE_WINDOW_MS) {
    // Legacy/incomplete records without a durable checkpoint keep the strict
    // seven-day fallback. A normal recovery episode carries nextCheckAt and is
    // valid exactly until its 30/60/90 checkpoint becomes due.
    return hold("dnc-stale");
  }

  // 2. Identity and reachability.
  if (!/^\d{10}$/.test(String(episode.normalizedPhone || ""))) return review("phone-invalid");
  if (contactWindowOpen === false) return hold("outside-contact-window");
  if (contactWindowOpen !== true) return hold("contact-window-unproven");

  // 3. "DID NOT CLOSE" (§13), re-proved against CURRENT state. The original
  //    CallRail call is discovery evidence; it is never the sale authority, so
  //    a sale posted after that call still removes the case here.
  if (!caseState) return hold("case-state-unproven");
  if (caseState.convertedAt) return terminal("converted");
  if (Number(caseState.paymentCount) > 0 || Number(caseState.totalPaid) > 0) return terminal("paid");
  if (caseState.retainedClient === true) return terminal("retained-client");
  if (caseState.activeAppointment === true) return terminal("active-appointment");
  if (caseState.allowedProspectStatus === false) return terminal("not-a-prospect");
  if (caseState.allowedProspectStatus !== true) return hold("status-unproven");

  // 4. Existing delivery conflict (§15.3). `undefined` means the caller has not
  //    read it — which is a hold, not an absence.
  if (existingWorkItem === undefined) return hold("work-item-unproven");
  if (existingWorkItem) {
    const state = String(existingWorkItem.state || "").toLowerCase();
    if (existingWorkItem.terminalAt || state === "terminal") {
      return existingWorkItem.terminalBusinessReason
        ? terminal("existing-item-terminal", { mirrorReason: existingWorkItem.terminalBusinessReason })
        : hold("existing-item-terminal-unexplained");
    }
    if (["review", "delivery_failed", "in_call", "provider_accepted"].includes(state)) {
      return hold("existing-delivery-busy");
    }
    // A live ordinary item owns the case; recovery waits rather than competing
    // for the same person with a second policy.
    return hold("existing-delivery-owns-case");
  }

  return admit();
}

/**
 * CR-6 — normalize an admitted episode into a delivery source row (§15.2).
 *
 * Notably ABSENT: `leadCadenceId`. Manufacturing one would hand this case the
 * SMS/email/RVM schedule actions that a LeadCadence row carries, and this
 * program is voice-only by policy — the absence is the enforcement.
 *
 * The contact policy is resolved through `leadDeliveryService`, never inlined,
 * so a code path that reaches for the ordinary age-based cap is a test failure
 * rather than a silent six-attempt day (§17).
 */
function buildRecoverySourceRow(episode, { now = new Date(), firstName: suppliedFirstName = null, lastName: suppliedLastName = null } = {}) {
  if (!episode) throw new Error("buildRecoverySourceRow requires an episode");
  const nameParts = String(episode.displayName || "").trim().split(/\s+/).filter(Boolean);
  const firstName = String(suppliedFirstName || "").trim() || nameParts.shift() || null;
  const lastName = String(suppliedLastName || "").trim() || (nameParts.length ? nameParts.join(" ") : null);
  // Shaped as the WORK ITEM the resolver expects, then handed to it — the
  // policy numbers are re-derived from checked-in code every time and never
  // trusted from stored metadata (§17).
  const policy = resolveLeadDeliveryContactPolicy({
    inventoryClass: CALL_RECOVERY_INVENTORY_CLASS,
    contactPolicyId: CALL_RECOVERY_CONTACT_POLICY_ID,
    receivedAt: episode.firstQualifyingCallAt,
    eligibleFrom: episode.eligibleFrom,
    expiresAt: episode.expiresAt,
    lastHumanAnsweredAt: episode.lastHumanAnsweredAt || null,
  }, { now });
  return {
    sourceKind: "call_recovery",
    sourceProgramId: episode.programKey,
    episodeId: episode.episodeId,
    domain: String(episode.domain || "").toUpperCase(),
    caseId: String(episode.caseId ?? ""),
    normalizedPhone: episode.normalizedPhone,
    displayName: episode.displayName || [firstName, lastName].filter(Boolean).join(" ") || null,
    firstName,
    lastName,
    // The episode's own clock, NOT today. Pretending an old case arrived this
    // morning would put it in new_today and jump the queue ahead of genuinely
    // fresh leads (§7 of the design).
    receivedAt: asDate(episode.firstQualifyingCallAt),
    firstQualifyingCallAt: asDate(episode.firstQualifyingCallAt),
    eligibleFrom: asDate(episode.eligibleFrom),
    expiresAt: asDate(episode.expiresAt),
    inventoryClass: CALL_RECOVERY_INVENTORY_CLASS,
    contactPolicyId: policy.contactPolicyId,
    policy,
    // classifyPool runs before persistence and therefore needs the source row
    // to carry its eligible state. The generic ingester still owns the final
    // persisted state and active-attempt fields.
    state: "eligible",
    activeAttempt: true,
    // The admission decision has already re-proved current Logics status,
    // DNC, contact window, program clock, and canonical-item ownership. The
    // generic pool classifier still requires that proof on the normalized
    // source row; dropping it here turns every admitted recovery episode into
    // an `eligibility-not-proven` skip.
    callable: true,
    eligibility: {
      ok: true,
      reason: "call-recovery-admitted",
      retryable: false,
    },
    dailyAttemptCount: Number(episode.dailyAttemptCount || 0),
    totalAttemptCount: Number(episode.totalAttemptCount || 0),
    lastContactAt: episode.lastContactAt || null,
    // No leadCadenceId — see above. Voice-only is structural here.
    leadCadenceId: null,
  };
}

/**
 * CR-7 — what a completed PhoneBurner call does to the episode (§19, §20).
 *
 * Only an EXACT persisted Call End reaches here. Placement, folder movement,
 * reconciliation, watchdog refill and discovery never count an attempt, and
 * `effectKey` makes a replayed callback a successful no-op rather than a second
 * attempt against the cap.
 */
function applyCallEndToEpisode({
  episode,
  normalizedOutcome,
  completedAt = new Date(),
  dailyAttemptCount,
  providerCallId = null,
  // The caller owns the effect ledger, so only the caller can know whether this
  // exact effect already landed. See the duplicate guard below.
  alreadyApplied = false,
} = {}) {
  if (!episode) throw new Error("applyCallEndToEpisode requires an episode");

  // §19, last row: a duplicate callback adds NO count, has NO duplicate effect,
  // and leaves the episode unchanged.
  //
  // This used to return `countedAttempt: true` unconditionally and merely hand
  // back an effectKey, trusting every caller to dedupe before believing it. That
  // is a trap rather than a contract: a caller that read `countedAttempt` and
  // acted on it would burn a second attempt against a 2/day cap on the strength
  // of a retried webhook. PhoneBurner redelivers.
  const effectKey = `${episode.episodeId}:${providerCallId || "no-call-id"}`;
  if (alreadyApplied) {
    return {
      effectKey,
      delivery: null,
      countedAttempt: false,
      removeExactContact: false,
      episodeTransition: null,
      duplicate: true,
      reason: "duplicate-callback",
    };
  }

  // A callback with NO provider call id cannot be deduped against another one —
  // they would collapse onto the same effectKey. That is exactly the
  // "unknown/contradictory" row: freeze for review rather than guess whether
  // this is a new attempt or a replay of the last one.
  if (!providerCallId) {
    return {
      effectKey,
      delivery: null,
      countedAttempt: false,
      removeExactContact: true,
      episodeTransition: { to: "review", reason: "call-end-without-provider-call-id" },
      reason: "provider-call-id-missing",
    };
  }

  // Policy for the ATTEMPT lives in leadDeliveryService; this maps its verdict
  // onto the episode. Two owners for one decision is the thing to avoid.
  const delivery = decideRecoveryOutcomeState({
    normalizedOutcome, completedAt, dailyAttemptCount,
  });

  const base = {
    effectKey,
    delivery,
    countedAttempt: true,
    removeExactContact: false,
    episodeTransition: null,
    reason: delivery.reason || null,
  };

  // BRANCH ON THE VERDICT leadDeliveryService ALREADY COMPUTED, never on a
  // private map of raw strings.
  //
  // The first version kept its own `TERMINALS` table keyed on PhoneBurner's raw
  // vocabulary — `sale`, `bad_number`, `wrong_person`, `opt_out`. But
  // `normalizeOutcome` collapses those: "bad number", "wrong number" and
  // "badnumber" all become the canonical `bad_lead`, and anything unrecognised
  // becomes `review`. So seven of the eleven keys were strings that could never
  // arrive, while `bad_lead` — the canonical form of a CONFIRMED WRONG NUMBER —
  // matched nothing and fell through to the retryable tail.
  //
  // Measured before the fix: `bad_lead` returned delivery.state="terminal"
  // alongside episodeTransition="eligible" and removeExactContact=false. One
  // object contradicting itself, and the operational meaning was that we keep
  // redialling a number somebody already told us was wrong. The tests missed it
  // because they fed the dead raw keys.
  //
  // This file's own header says it is not a decision owner. This is that rule
  // applied: `delivery.state` is the classification, `delivery.lastOutcome` is
  // the canonical reason, and neither is re-derived here.
  const canonical = String(delivery.lastOutcome || "review").toLowerCase();
  const atCap = Number(dailyAttemptCount) >= 2;

  if (delivery.state === "terminal") {
    const REASONS = {
      dnc: "dnc",
      bad_lead: "bad-number",
      appointment: "appointment-set",
      client: "retained-client",
    };
    return {
      ...base,
      removeExactContact: true,
      episodeTransition: { to: "terminal", reason: REASONS[canonical] || canonical },
      // §20 — a DNC disposition also drives the durable downstream suppression,
      // which is a separate effect from retiring this episode.
      durableDnc: canonical === "dnc",
    };
  }

  // Unknown or contradictory: freeze, never guess (§19). This is also where a
  // "sale"/"payment" disposition lands, because the canonical vocabulary has no
  // such outcome — which is fail-closed: the episode stops being dialable and a
  // human resolves it, and the admission gate would independently terminate it
  // on the next claim via caseState.convertedAt / paymentCount.
  if (delivery.state === "review" || canonical === "review") {
    return {
      ...base,
      removeExactContact: true,
      episodeTransition: { to: "review", reason: "outcome-unresolved" },
    };
  }

  // A human answered but nothing resolved: no same-day retry. Calling someone
  // back an hour after a real conversation is how a recovery program becomes a
  // nuisance, and the policy is explicit that it waits for the next day.
  if (canonical === "answered") {
    return {
      ...base,
      removeExactContact: true,
      episodeTransition: { to: "eligible", reason: "answered-next-day-hold" },
      nextDayOnly: true,
    };
  }

  // Retryable: no answer, voicemail, busy, congestion, intercept. Stays
  // available under the cap for PhoneBurner's native recycle; at the cap the
  // exact contact is removed and the case reopens on a later Pacific date.
  return {
    ...base,
    removeExactContact: atCap,
    episodeTransition: { to: "eligible", reason: atCap ? "daily-cap-reached" : "retryable-under-cap" },
    nextDayOnly: atCap,
  };
}

module.exports = {
  DNC_CHECKPOINT_DAYS,
  DNC_REUSE_WINDOW_MS,
  nextDncCheckpointAt,
  admitEpisode,
  buildRecoverySourceRow,
  applyCallEndToEpisode,
};
