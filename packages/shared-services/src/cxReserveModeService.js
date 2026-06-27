"use strict";

// Reserve-mode policy → familyTargets (M7 §2). Turns the existing per-family `targetOpen`
// depth machinery into the per-family COUNTS the reservation service reserves each cycle,
// honoring RC_CX_RESERVE_MODE and an aged-throughput floor.
//
//   - mode "mix" (DEFAULT): per-family target = getQueueFamilyTargetOpen(policy, family)
//     (~15/10/5/5; aged funded so red can't starve — FM-4). aged.fillRemainder (policy)
//     lets red absorb leftover deficit downstream.
//   - mode "green-first": all of the deficit to fresh-day1; other families 0. Carries NO
//     aged floor of its own — RC_CX_AGED_MIN_RESERVE_PER_CYCLE is the only aged guarantee.
//
// NOTE: `targetOpen` is open-set DEPTH, not dial THROUGHPUT. Holding red at depth 5 does NOT
// mean red gets dialed — RC_CX_AGED_MIN_RESERVE_PER_CYCLE is the throughput floor (FM-4b),
// applied in BOTH modes.

const { getQueueFamilyTargetOpen } = require("./cxQueuePolicyService");

// Local non-negative env-int reader. Inlined on purpose: getNonNegativeEnvNumber is module-
// local to cxWorkspaceService and readEnvNumber is not exported from cxQueuePolicyService, so
// importing either would add a heavy/circular dependency for one tiny read.
function readEnvNonNegInt(name, fallback, env = process.env) {
  if (!Object.prototype.hasOwnProperty.call(env, name)) return fallback;
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

function buildFamilyTargets({ policy, totalDeficit, env = process.env } = {}) {
  const mode = String(env.RC_CX_RESERVE_MODE || "mix").trim().toLowerCase();
  const deficit = Math.max(Number(totalDeficit) || 0, 0);
  const open = (family) => getQueueFamilyTargetOpen(policy, family); // account-aware; 0 when disabled/ineligible
  const disabled = policy && typeof policy === "object" && policy.enabled === false;

  let targets;
  if (mode === "green-first") {
    targets = { "fresh-day1": open("fresh-day1") > 0 ? deficit : 0, "fresh-day2to10": 0, "fresh-day16to30": 0, aged: 0 };
  } else {
    // mix (default)
    targets = {
      "fresh-day1": open("fresh-day1"),
      "fresh-day2to10": open("fresh-day2to10"),
      "fresh-day16to30": open("fresh-day16to30"),
      aged: open("aged"),
    };
  }

  // Aged-throughput floor (FM-4b) — both modes; the only aged guarantee under green-first.
  if (disabled) return targets;
  const agedFloor = readEnvNonNegInt("RC_CX_AGED_MIN_RESERVE_PER_CYCLE", 0, env);
  targets.aged = Math.max(Number(targets.aged) || 0, agedFloor);
  return targets;
}

module.exports = { buildFamilyTargets, readEnvNonNegInt };
