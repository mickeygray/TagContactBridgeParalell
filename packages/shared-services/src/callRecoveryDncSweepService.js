"use strict";

// CR-5, second half — the DNC/litigator sweep for recovery episodes.
//
// Work order §14. This is the gate that actually decides whether a recovery
// call may ever be placed: admission holds on `dnc-unproven` until a real
// RealValidation result exists for that exact phone, so with this unwired the
// program is permanently held. That is the correct default, and this is what
// lifts it — deliberately, one phone at a time, with a recorded verdict.
//
// NO GRACE WINDOW, unlike the cadence recheck. `dncRecheckService` grants fresh
// leads a 30-day TrustedForm grace because a lead that just filled in a form
// has given consent that outranks a stale list entry. A recovery episode is the
// opposite case: an OLD mail prospect with no recent consent artefact, being
// dialled months after the fact. A national or state hit terminates it, full
// stop (§14.1).
//
// Rate-limited to RealValidation's guidance (<=10/sec). The sweep is bounded by
// count and walks oldest-checkpoint-first, so a large backlog drains steadily
// rather than in one burst.

const { createRealPhoneValidationClient } = require("../../shared-integrations/src");

// §14.2 — measured from firstQualifyingCallAt, then the program expires.
const CHECKPOINT_DAYS = Object.freeze([30, 60, 90]);
const DAY_MS = 86400000;
const SLEEP_MS = 120; // ~8/sec, comfortably under the 10/sec guidance

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The next checkpoint after `now`, or null when the program has run out of
 * them. Measured from the FIRST qualifying call so a late check cannot push
 * the schedule past day 120 and buy the episode extra life.
 */
function nextCheckpointAt(firstQualifyingCallAt, now = new Date()) {
  const first = firstQualifyingCallAt ? new Date(firstQualifyingCallAt) : null;
  if (!first || !Number.isFinite(first.getTime())) return null;
  for (const day of CHECKPOINT_DAYS) {
    const at = new Date(first.getTime() + day * DAY_MS);
    if (at > now) return at;
  }
  return null;
}

/**
 * Classify one RealValidation answer.
 *
 * Anything that is not an explicit clean read is NOT clean. A malformed or
 * partial response is `failed`, which holds — the one thing this function must
 * never do is turn "I could not tell" into permission.
 */
function classifyRecoveryDnc(result) {
  if (!result || typeof result !== "object") return { result: "failed", reason: "no-response" };
  if (result.isLitigator === true) return { result: "hit", reason: "known-litigator" };
  if (result.onNationalDNC === true) return { result: "hit", reason: "national-dnc" };
  if (result.onStateDNC === true) return { result: "hit", reason: "state-dnc" };
  // Require the fields to be present and false, not merely absent.
  const answered = result.onNationalDNC === false || result.onStateDNC === false
    || result.isLitigator === false;
  return answered ? { result: "clean", reason: null } : { result: "failed", reason: "incomplete-response" };
}

/**
 * Run one bounded pass.
 *
 * `apply: false` performs the lookups and classifies, but records nothing —
 * so the hit rate can be measured before any episode is terminated.
 */
// ── THE THREE CADENCES ────────────────────────────────────────────────────
//
// Mickey 2026-07-31: "it needs its own discrete load-in check but then after
// that should just get monthly hygiene. also needs to check logics dnc once a
// day."
//
// So three separate things, deliberately not one blended sweep:
//
//   LOAD-IN   one discrete RealValidation lookup before the episode may enter
//             the pool. `mode: "load-in"`. Until it lands, admission holds on
//             `dnc-unproven` and nothing can be dialled.
//
//   MONTHLY   RealValidation again at day 30/60/90, then the program expires.
//             This is the ONLY reason a recovery-specific sweep exists at all:
//             `dncRecheckService` covers the same ground for ordinary leads but
//             enumerates LeadCadence, and a recovery episode deliberately has
//             no LeadCadence row (that is the voice-only guarantee).
//
//   DAILY     Logics DNC. For anything already IN the pool this is already
//             done — `refreshQueuedLeadStatuses` enumerates leaddeliveryitems
//             nightly at maxAgeHours=20 and deactivates on a DNC status, which
//             is the 2026-07-24 bleed fix and applies to recovery items for
//             free. `runCallRecoveryLogicsDncCheck` covers only the gap that
//             leaves: an episode that exists but has not entered the pool yet,
//             whose CaseProfile mirror nothing else is refreshing.
const SWEEP_MODES = Object.freeze(["load-in", "monthly", "all"]);

async function runCallRecoveryDncSweep({
  repository,
  now = new Date(),
  limit = 100,
  apply = false,
  client = null,
  logger = null,
  mode = "all",
} = {}) {
  if (!repository) throw new TypeError("repository is required");
  if (!SWEEP_MODES.includes(mode)) throw new TypeError(`unknown sweep mode "${mode}"`);
  const rv = client || createRealPhoneValidationClient();

  // Two populations, kept separable so the load-in check can be run and
  // measured on its own before any recheck machinery is armed.
  const wantsMonthly = mode === "monthly" || mode === "all";
  const wantsLoadIn = mode === "load-in" || mode === "all";

  const due = wantsMonthly ? await repository.listDncCheckpointsDue({ asOf: now, limit }) : [];
  const fresh = (wantsLoadIn && due.length < limit)
    ? await repository.listEpisodesForConsideration({
      states: ["awaiting_start", "eligible", "held"],
      asOf: now,
      limit: limit - due.length,
    })
    : [];
  const unchecked = fresh.filter((e) => (e.dnc?.result || "unknown") === "unknown");

  const seen = new Set();
  const work = [...due, ...unchecked].filter((e) => {
    if (seen.has(e.episodeId)) return false;
    seen.add(e.episodeId);
    return true;
  });

  const out = {
    apply, considered: work.length, checked: 0, clean: 0, hit: 0, failed: 0, terminated: 0, errors: 0,
  };

  for (const episode of work) {
    let verdict;
    try {
      verdict = classifyRecoveryDnc(await rv.lookupDnc(episode.normalizedPhone));
      out.checked += 1;
    } catch (error) {
      // A provider failure is `failed`, which HOLDS. It is never clean.
      verdict = { result: "failed", reason: String(error.message || "lookup-error").slice(0, 80) };
      out.errors += 1;
    }
    out[verdict.result] = (out[verdict.result] || 0) + 1;

    if (apply) {
      try {
        await repository.recordDncResult(episode.episodeId, {
          result: verdict.result,
          reason: verdict.reason,
          checkedAt: now,
          // A hit books no recheck — recordDncResult drops it, and the episode
          // is about to terminate anyway.
          nextCheckAt: verdict.result === "clean"
            ? nextCheckpointAt(episode.firstQualifyingCallAt, now)
            : null,
        });
        if (verdict.result === "hit") {
          // §14.2 — every hit stops the episode and triggers exact-contact
          // removal downstream. Terminal is absorbing; nothing reopens it.
          const moved = await repository.transitionState(episode.episodeId, {
            from: episode.state,
            to: "terminal",
            reason: `dnc-${verdict.reason}`,
          });
          if (moved.ok) out.terminated += 1;
        }
      } catch (error) {
        out.errors += 1;
        logger?.warn?.("call_recovery.dnc_record_failed", {
          // Count-only logging — never the phone or the case.
          error: String(error.message).slice(0, 100),
        });
      }
    }
    await sleep(SLEEP_MS);
  }

  return out;
}

/**
 * DAILY Logics DNC check for episodes NOT yet in the pool.
 *
 * Once an episode has produced a LeadDeliveryItem this is redundant —
 * `refreshQueuedLeadStatuses` walks leaddeliveryitems nightly at
 * maxAgeHours=20 and deactivates on a DNC status. That is the 2026-07-24
 * bleed fix and recovery items inherit it for free.
 *
 * The gap it does not cover is an episode sitting in `eligible` or `held`
 * with no item yet: nothing refreshes its CaseProfile mirror, so a case that
 * goes DNC while it waits would be admitted on a stale read. Admission does
 * re-check status on every ingest pass, but it reads the same mirror — so if
 * the mirror is stale, so is the check.
 *
 * `readCaseDnc` is injected: this service must not own a Logics client, and
 * the caller already has the one the delivery path uses.
 */
async function runCallRecoveryLogicsDncCheck({
  repository,
  readCaseDnc,
  now = new Date(),
  limit = 200,
  apply = false,
  logger = null,
} = {}) {
  if (!repository) throw new TypeError("repository is required");
  if (typeof readCaseDnc !== "function") throw new TypeError("readCaseDnc is required");

  const episodes = await repository.listEpisodesForConsideration({
    states: ["awaiting_start", "eligible", "held"],
    asOf: now,
    limit,
  });
  // Only the ones with no work item yet — the rest are the nightly refresh's.
  const pending = episodes.filter((e) => !e.linkedLeadDeliveryItemId);

  const out = { apply, considered: pending.length, checked: 0, dnc: 0, terminated: 0, errors: 0 };
  for (const episode of pending) {
    let isDnc = null;
    try {
      isDnc = await readCaseDnc({ domain: episode.domain, caseId: episode.caseId });
      out.checked += 1;
    } catch (error) {
      out.errors += 1;
      logger?.warn?.("call_recovery.logics_dnc_check_failed", {
        error: String(error.message).slice(0, 100),
      });
      continue;
    }
    // Only an explicit TRUE terminates. Unknown leaves the episode alone —
    // admission will hold on it anyway, and terminating on a failed read
    // would destroy inventory on a Logics outage.
    if (isDnc !== true) continue;
    out.dnc += 1;
    if (!apply) continue;
    const moved = await repository.transitionState(episode.episodeId, {
      from: episode.state,
      to: "terminal",
      reason: "logics-dnc",
    }).catch(() => ({ ok: false }));
    if (moved.ok) out.terminated += 1;
  }
  return out;
}

module.exports = {
  CHECKPOINT_DAYS,
  SWEEP_MODES,
  nextCheckpointAt,
  classifyRecoveryDnc,
  runCallRecoveryDncSweep,
  runCallRecoveryLogicsDncCheck,
};
