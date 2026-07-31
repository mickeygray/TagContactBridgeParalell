"use strict";

// callRecoveryDiscoveryService — turn a completed Pacific day of CallRail calls
// into recovery episodes.
//
// Work order CR-3/CR-4 (`.ai/context/CALLRAIL_LONG_CALL_RECOVERY_WORK_ORDER_2026-07-31.md`).
//
// THIS SERVICE PRODUCES EVIDENCE, NOT PERMISSION. Nothing here decides that a
// case may be dialled — it decides that a case is a MEMBER of the program and
// that the program is open. Admission (§5, CR-5) re-proves status, sale and DNC
// at claim time, because a clean snapshot taken last night cannot authorize a
// call made this afternoon.
//
// Two properties do most of the work:
//
//  1. EVERY REJECTION IS COUNTED, BY REASON. A discovery pass that qualifies
//     nothing is normal; a pass that qualifies nothing *for a new reason* is the
//     signal. The funnel is the whole observability story (§23) and it is
//     count-only — no names, phones, case ids or call ids ever leave here.
//
//  2. UNPROVEN IS NOT REJECTED. `review` and `rejected` are different verdicts
//     on purpose: rejected means "this call is not a candidate", review means
//     "we could not tell", and the second one must never quietly become the
//     first. Failing closed is the entire safety model of the program.

const {
  qualifyCallRailRecoveryFact,
  MINIMUM_RECOVERY_DURATION_SECONDS,
} = require("./callrailCallFactService");
const { sourceChannel } = require("../../shared-config/src/activeSources");

const PACIFIC_TIME_ZONE = "America/Los_Angeles";

// §11 — a leg has to be a PERSON. A shared queue or system line answering for
// ten minutes is a phone system doing its job, not a prospect conversation.
const SHARED_LINE_HINTS = [
  "queue", "shared", "ivr", "voicemail", "vm", "auto", "system",
  "main", "reception", "front", "overflow", "ring", "hunt",
];

// How far a CallRail call and an internal leg may sit apart and still be the
// same conversation. Wide enough for clock skew between two providers, narrow
// enough that two different calls from one household do not collide.
const LEG_MATCH_WINDOW_MS = 5 * 60 * 1000;

function pacificDateKey(at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

/** A counter that never throws and never records a customer detail. */
function makeFunnel() {
  const counts = Object.create(null);
  return {
    counts,
    bump(reason, n = 1) {
      const key = String(reason || "unknown").slice(0, 60);
      counts[key] = (counts[key] || 0) + n;
      return key;
    },
  };
}

/**
 * §10 — mail-source proof.
 *
 * Historical provenance, NOT current-active configuration: a piece that is
 * inactive today was still mail when the call arrived, and `sourceChannel`
 * already carries the retired pieces for exactly that reason. Anything it
 * cannot place is `review`, never a substring guess — "Client Contact - TAG"
 * contains no mail word and must not be rescued by one.
 */
function proveMailSource(sourceName, { trackingPhoneMap = null, trackingPhone = null } = {}) {
  // 1. exact tracking number -> canonical piece, when the caller supplies a map.
  if (trackingPhoneMap && trackingPhone && trackingPhoneMap[trackingPhone]) {
    const mapped = trackingPhoneMap[trackingPhone];
    if (sourceChannel(mapped.name ?? mapped) === "mail") {
      return { status: "proved", canonicalId: mapped.canonicalId ?? null, name: mapped.name ?? String(mapped) };
    }
    return { status: "rejected", reason: "tracking-number-is-not-mail" };
  }
  // 2/3. exact canonical/registry name.
  const name = String(sourceName || "").trim();
  if (!name) return { status: "unproven", reason: "mail-source-unproven" };
  const channel = sourceChannel(name);
  if (channel === "mail") return { status: "proved", canonicalId: null, name };
  // LD and BCD are explicitly NOT this program (§10). They are rejections, not
  // ambiguities — we know exactly what they are.
  if (channel === "ld" || channel === "bcd") {
    return { status: "rejected", reason: `not-mail-source-${channel}` };
  }
  return { status: "unproven", reason: "mail-source-unproven" };
}

function looksShared(leg) {
  const haystack = `${leg?.agentId || ""} ${leg?.extension || ""} ${leg?.agentName || ""}`.toLowerCase();
  return SHARED_LINE_HINTS.some((hint) => haystack.includes(hint));
}

/**
 * §11 — human-answer proof.
 *
 * The gate that stops a ten-minute hold-music session from being read as a
 * ten-minute conversation. Requires exactly ONE non-shared internal answered
 * leg within the window; zero is unproven, two is ambiguous, and both hold.
 */
function proveHumanAnswer(fact, legs = []) {
  if (!Array.isArray(legs) || legs.length === 0) {
    return { status: "unproven", reason: "no-internal-leg" };
  }
  const startedAt = fact.startedAt ? fact.startedAt.getTime() : null;
  const candidates = legs.filter((leg) => {
    if (!leg) return false;
    if (leg.answered !== true) return false;
    if (String(leg.direction || "").toLowerCase() !== "inbound") return false;
    if (!leg.agentId && !leg.extension) return false;
    if (startedAt != null && leg.callStartTime) {
      const at = new Date(leg.callStartTime).getTime();
      if (!Number.isFinite(at) || Math.abs(at - startedAt) > LEG_MATCH_WINDOW_MS) return false;
    }
    return true;
  });
  if (candidates.length === 0) return { status: "unproven", reason: "no-answered-internal-leg" };

  const human = candidates.filter((leg) => !looksShared(leg));
  if (human.length === 0) return { status: "rejected", reason: "shared-line-only" };
  if (human.length > 1) return { status: "unproven", reason: "multiple-agent-matches" };

  const leg = human[0];
  return {
    status: "proved",
    reason: null,
    agentId: leg.agentId || null,
    extension: leg.extension || null,
    callLogId: leg._id ? String(leg._id) : (leg.callLogId || null),
    leg,
  };
}

/**
 * §12 — case identity proof.
 *
 * Precedence is exact-binding first. `results[0]` from an ambiguous phone
 * lookup is explicitly forbidden, and a phone match alone never crosses
 * TAG/WYNN/AMITY — one household can appear in more than one tenant, and
 * guessing there puts a call on the wrong company's case.
 */
function proveCaseIdentity(fact, { leg = null, attribution = null, logicsMatches = null } = {}) {
  if (leg?.caseId != null && leg.caseDomain) {
    return { status: "proved", domain: String(leg.caseDomain).toUpperCase(), caseId: String(leg.caseId), via: "call-log-binding" };
  }
  if (attribution?.caseId != null && attribution.domain) {
    return { status: "proved", domain: String(attribution.domain).toUpperCase(), caseId: String(attribution.caseId), via: "attribution" };
  }
  if (Array.isArray(logicsMatches)) {
    const tag = logicsMatches.filter((m) => String(m?.domain || "").toUpperCase() === fact.tenantDomain);
    if (tag.length === 1 && tag[0]?.caseId != null) {
      return { status: "proved", domain: fact.tenantDomain, caseId: String(tag[0].caseId), via: "logics-unique" };
    }
    if (tag.length > 1) return { status: "unproven", reason: "multiple-case-matches" };
  }
  return { status: "unproven", reason: "case-identity-unproven" };
}

/**
 * §13 — "did not close" at DISCOVERY time.
 *
 * Deliberately weak here and strong at admission. Discovery only needs to avoid
 * enrolling a case that has obviously already converted; the authoritative
 * re-proof happens before every provider claim, because a sale posted after
 * this call still has to remove the case.
 */
function proveStillOpen(caseState = null) {
  if (!caseState) return { status: "unproven", reason: "current-case-state-unproven" };
  if (caseState.convertedAt) return { status: "rejected", reason: "already-converted" };
  if (Number(caseState.paymentCount) > 0) return { status: "rejected", reason: "already-paid" };
  if (Number(caseState.totalPaid) > 0) return { status: "rejected", reason: "already-paid" };
  if (caseState.dnc === true) return { status: "rejected", reason: "case-dnc" };
  if (caseState.activeAppointment === true) return { status: "rejected", reason: "active-appointment" };
  if (caseState.allowedProspectStatus === false) return { status: "rejected", reason: "not-a-prospect" };
  if (caseState.allowedProspectStatus !== true) return { status: "unproven", reason: "status-unproven" };
  return { status: "proved" };
}

/**
 * Run one discovery pass over a completed Pacific day.
 *
 * `apply: false` is a full dry run — every read, every verdict, every counter,
 * and no write. That is the CR-3 shadow mode and the historical dry run in one
 * code path, so what the funnel reports is what arming it would actually do.
 */
async function runCallRecoveryDiscovery({
  dateKey = pacificDateKey(new Date(Date.now() - 86400000)),
  apply = false,
  limit = 500,
  minimumDurationSec = MINIMUM_RECOVERY_DURATION_SECONDS,
  tenantDomain = "TAG",
  trackingPhoneMap = null,
  logger = null,
  deps = {},
} = {}) {
  const funnel = makeFunnel();
  const started = Date.now();
  const {
    listCallsForDay,
    listInternalLegs = async () => [],
    resolveAttribution = async () => null,
    resolveLogicsMatches = async () => null,
    readCaseState = async () => null,
    resolveEpisodeTiming,
    repository,
  } = deps;

  if (typeof listCallsForDay !== "function") throw new Error("deps.listCallsForDay is required");
  if (typeof resolveEpisodeTiming !== "function") throw new Error("deps.resolveEpisodeTiming is required");
  if (apply && !repository) throw new Error("apply mode requires deps.repository");
  // A HALF-WIRED DEP SET MUST FAIL LOUDLY, NOT REPORT A CLEAN EMPTY FUNNEL.
  //
  // readCaseState defaulted to `async () => null`, and proveStillOpen(null) is
  // `current-case-state-unproven` — so with the dep missing, EVERY call held on
  // the last gate and `qualified` was structurally 0. The nightly task counts
  // `qualified` to decide whether to call apply(), so an operator could arm
  // CALL_RECOVERY_DISCOVERY_ENABLED, watch the task report itself as writing,
  // and persist nothing at all, forever, with no error anywhere.
  //
  // The other two resolvers stay optional — case identity has three independent
  // routes and can legitimately prove via the CallLog binding alone — but the
  // case-state read has no alternative, so its absence is a wiring bug.
  if (typeof deps.readCaseState !== "function") {
    throw new Error("deps.readCaseState is required — without it nothing can ever qualify");
  }

  const result = {
    dateKey,
    apply,
    factsRead: 0,
    qualified: 0,
    episodesInserted: 0,
    episodesUpdated: 0,
    rejectedByReason: funnel.counts,
    errors: 0,
    durationMs: 0,
  };

  let calls = [];
  try {
    calls = await listCallsForDay({ dateKey, limit });
  } catch (error) {
    // §23 — "discovery cannot read a completed business day" is an alert. It is
    // NOT an empty day, and must never be reported as one.
    result.errors += 1;
    result.readFailed = String(error.message).slice(0, 120);
    result.durationMs = Date.now() - started;
    logger?.warn?.("call_recovery.discovery_read_failed", { dateKey });
    return result;
  }

  for (const raw of Array.isArray(calls) ? calls : []) {
    result.factsRead += 1;
    try {
      // Cheap, pure gates first — duration and answered reject most of the day
      // without a single lookup.
      const verdict = qualifyCallRailRecoveryFact(raw, {
        tenantDomain,
        minimumDurationSec,
        // Evidence is resolved below; tell the pure qualifier they are pending
        // so it stops at the first cheap failure instead of demanding them.
        mailSourceEvidence: "proved",
        humanAnswerEvidence: "proved",
        caseIdentityEvidence: "proved",
        currentCaseEvidence: "proved",
      });
      if (verdict.status !== "qualified") { funnel.bump(verdict.reason); continue; }
      const fact = verdict.fact;

      const mail = proveMailSource(fact.sourceName, { trackingPhoneMap, trackingPhone: fact.trackingPhone });
      if (mail.status !== "proved") { funnel.bump(mail.reason || "mail-source-unproven"); continue; }

      const legs = await listInternalLegs({ fact });
      const human = proveHumanAnswer(fact, legs);
      if (human.status !== "proved") { funnel.bump(human.reason); continue; }

      const identity = proveCaseIdentity(fact, {
        leg: human.leg,
        attribution: await resolveAttribution({ fact }),
        logicsMatches: await resolveLogicsMatches({ fact }),
      });
      if (identity.status !== "proved") { funnel.bump(identity.reason); continue; }
      if (identity.domain !== fact.tenantDomain) { funnel.bump("cross-tenant-case"); continue; }

      const open = proveStillOpen(await readCaseState({ domain: identity.domain, caseId: identity.caseId }));
      if (open.status !== "proved") { funnel.bump(open.reason); continue; }

      result.qualified += 1;
      if (!apply) { funnel.bump("would-qualify"); continue; }

      const timing = resolveEpisodeTiming(fact.startedAt);
      const written = await repository.recordQualifyingCall({
        domain: identity.domain,
        caseId: identity.caseId,
        normalizedPhone: fact.customerPhone,
        providerCallId: fact.providerCallId,
        callAt: fact.startedAt,
        durationSec: fact.durationSec,
        mailSourceCanonicalId: mail.canonicalId,
        mailSourceName: mail.name,
        humanAnswerEvidence: {
          status: "proved", agentId: human.agentId, extension: human.extension, callLogId: human.callLogId,
        },
        eligibleFrom: timing.eligibleFrom,
        expiresAt: timing.expiresAt,
        // Straight to awaiting_start: `discovered` is a transient label and an
        // episode that sits in it has no legal edge to `expired` (§6).
        state: "awaiting_start",
        stateReason: "discovered-from-callrail",
      });
      if (written.inserted) result.episodesInserted += 1;
      else if (written.evidenceAdded) result.episodesUpdated += 1;
      else funnel.bump("duplicate-evidence");
    } catch (error) {
      result.errors += 1;
      funnel.bump("discovery-error");
      logger?.warn?.("call_recovery.discovery_item_failed", {
        dateKey, error: String(error.message).slice(0, 120),
      });
    }
  }

  result.durationMs = Date.now() - started;
  return result;
}

/**
 * Resolve the activation ladder (§22).
 *
 * discovery -> shadow -> delivery, each requiring the one before it. Skipping a
 * rung is a CONFIGURATION ERROR rather than a permissive default: delivery
 * without discovery is a system that has been told it may dial with no proven
 * evidence about who, and the failure mode of guessing there is calling
 * somebody who is on a DNC list.
 */
function resolveCallRecoveryActivation(config = {}) {
  const discovery = config.discoveryEnabled === true;
  const shadow = config.shadowEnabled === true;
  const wantsDelivery = config.deliveryEnabled === true;
  const allow = new Set((config.agentAllowlist || [])
    .map((v) => String(v || "").trim().toLowerCase()).filter(Boolean));

  let error = null;
  if (wantsDelivery && !discovery) error = "CALL_RECOVERY_DELIVERY_ENABLED requires discovery to be armed first";
  else if (wantsDelivery && !shadow) error = "CALL_RECOVERY_DELIVERY_ENABLED requires shadow to be armed first";
  const delivery = wantsDelivery && !error;

  return {
    ok: !error,
    error,
    discovery,
    shadow,
    delivery,
    // An empty allowlist means "not narrowed", NOT "everyone" — but it can only
    // ever widen back to what `delivery` already permits, never past it.
    allowsAgent(agentId) {
      if (!delivery) return false;
      if (allow.size === 0) return true;
      return allow.has(String(agentId || "").trim().toLowerCase());
    },
  };
}

module.exports = {
  PACIFIC_TIME_ZONE,
  LEG_MATCH_WINDOW_MS,
  resolveCallRecoveryActivation,
  pacificDateKey,
  proveMailSource,
  proveHumanAnswer,
  proveCaseIdentity,
  proveStillOpen,
  runCallRecoveryDiscovery,
};
