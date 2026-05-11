"use strict";

// Federal-DNC recheck sweep. Runs from the hourly tick — finds active
// leads whose `cadenceState.dncCheck.nextCheckAt` has passed, calls
// the cheap RealValidation `DNCLookup.php` endpoint for each, and:
//
//   - If the lead is now on the National DNC list AND past its
//     30-day TrustedForm grace window → mark cx channel DNC via the
//     standard `markChannelDnc` path. RVM is implicitly disabled
//     since rvm only fires as call fallback. Lead stays active;
//     text + email continue.
//   - Always: stamp `lastCheckedAt`, `lastResult`, and roll
//     `nextCheckAt` forward to the next 1st-or-mid-Mon boundary.
//
// Rate-limited: RealValidation recommends ≤10 calls/sec. Default
// sweep size of 100 with a small inter-call sleep keeps us well
// under that.

const {
  createRealPhoneValidationClient,
} = require("../../shared-integrations/src");
const {
  leadCadenceRepository,
} = require("../../shared-repositories/src");
const { nextRecheckBoundary } = require("./dncRecheckBoundaryService");

const GRACE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function isPastGrace(createdAt, now) {
  if (!createdAt) return true; // missing → treat as old
  return new Date(now).getTime() - new Date(createdAt).getTime() > GRACE_WINDOW_MS;
}

function classifyDncResult(checkResult, lead, now) {
  // What we got back from RealValidation's DNCLookup endpoint.
  // Permanent reasons that should disable cx (and by extension rvm):
  //   - on national DNC + past grace window
  //   - on state DNC + past grace
  //   - now flagged as a known litigator (always disable, even in grace)
  const reasons = [];
  if (checkResult.isLitigator) {
    reasons.push("known-litigator");
  }
  const pastGrace = isPastGrace(lead.createdAt, now);
  if (pastGrace) {
    if (checkResult.onNationalDNC) reasons.push("national-dnc-recheck");
    if (checkResult.onStateDNC) reasons.push("state-dnc-recheck");
  }
  return {
    shouldDisableCx: reasons.length > 0,
    reason: reasons[0] || null,
    allReasons: reasons,
    pastGrace,
  };
}

/**
 * Run one pass of the bimonthly DNC recheck sweep.
 *
 * Idempotent — leads already cx-channelDnc'd are filtered out at
 * query time (`channelDnc.cx.blocked != true`). Each lead is touched
 * at most once per sweep regardless of whether the DNC mark fires.
 *
 * Returns a summary the hourly sweep can log/surface.
 */
async function runDncRecheckSweep({ limit = 100, sleepMsPerCall = 150 } = {}) {
  const now = new Date();
  const due = await leadCadenceRepository.listLeadsDueForDncRecheck({ now, limit });
  if (due.length === 0) {
    return {
      checked: 0,
      disabledCount: 0,
      pastGraceCount: 0,
      withinGraceCount: 0,
      errors: 0,
    };
  }

  const client = createRealPhoneValidationClient();
  let disabledCount = 0;
  let pastGraceCount = 0;
  let withinGraceCount = 0;
  let errors = 0;

  for (const lead of due) {
    try {
      const checkResult = await client.lookupDnc(lead.normalizedPhone);
      const verdict = classifyDncResult(checkResult, lead, now);
      if (verdict.pastGrace) pastGraceCount += 1;
      else withinGraceCount += 1;

      if (verdict.shouldDisableCx) {
        await leadCadenceRepository
          .markChannelDnc(lead.domain, lead.caseId, "cx", verdict.reason)
          .catch(() => null);
        disabledCount += 1;
      }

      await leadCadenceRepository
        .recordDncRecheck(lead.domain, lead.caseId, {
          result: {
            onDnc: Boolean(checkResult.onNationalDNC),
            onStateDnc: Boolean(checkResult.onStateDNC),
            isLitigator: Boolean(checkResult.isLitigator),
            isCell: Boolean(checkResult.isCell),
            source: "real-validation-dnc-lookup",
            allReasons: verdict.allReasons,
          },
          nextCheckAt: nextRecheckBoundary(now),
        })
        .catch(() => null);

      // Pace under RealValidation's 10/s rate limit.
      if (sleepMsPerCall > 0) {
        await new Promise((resolve) => setTimeout(resolve, sleepMsPerCall));
      }
    } catch {
      errors += 1;
    }
  }

  return {
    checked: due.length,
    disabledCount,
    pastGraceCount,
    withinGraceCount,
    errors,
  };
}

module.exports = {
  classifyDncResult,
  isPastGrace,
  runDncRecheckSweep,
};
