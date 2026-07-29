"use strict";

// ST/FD lead-source branching at Logics posting time (phase 6, FORWARD-ONLY).
//
// Doctrine (Mickey, 2026-07-24/27):
//   - State liens vs Internal Revenue liens carry different lead economics,
//     so a data lead posts to Logics under a BRANCHED source name — the
//     Logics lead-source matrix has "ABC ST" (source id 57) and "ABC FD"
//     (source id 76). Mickey configures the lead COST in Logics himself;
//     we never post dollar amounts, we only pick the right source name.
//   - The branch signal is the lien plaintiff: "INTERNAL REVENUE SERVICE"
//     → FD, "STATE OF …" → ST. Live data is clean and binary (26k IRS
//     rows vs 50k STATE OF rows, no third shape).
//   - Unparseable/missing plaintiff → post the BASE name unbranched, so
//     anything still carrying the bare name in Logics IS the exception
//     list, for free.
//   - FORWARD-ONLY: "im not updating ABC to ABC ST that would back change
//     a ton of stuff." Nothing ever rewrites an existing case, profile, or
//     ledger row. Ships DISABLED (LEAD_SOURCE_BRANCH_ENABLED) until the
//     branched sources exist in Logics.
//   - Urgent thirds / mail: NO branch — one flat state-level cost lives in
//     Logics; a mail piece's true per-lead cost is not derivable and a
//     stated approximation beats fake precision.

// The lead source matrix: base source name → branched names + Logics
// source ids (ids are REFERENCE — the API posts by name). Extendable via
// LEAD_SOURCE_BRANCH_MATRIX (JSON) without a deploy.
const DEFAULT_BRANCH_MATRIX = Object.freeze({
  ABC: {
    ST: { sourceName: "ABC ST", logicsSourceId: 57 },
    FD: { sourceName: "ABC FD", logicsSourceId: 76 },
  },
});

function leadSourceBranchEnabled(env = process.env) {
  return String(env.LEAD_SOURCE_BRANCH_ENABLED ?? "false").toLowerCase() === "true";
}

function branchMatrix(env = process.env) {
  const raw = env.LEAD_SOURCE_BRANCH_MATRIX;
  if (!raw) return DEFAULT_BRANCH_MATRIX;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : DEFAULT_BRANCH_MATRIX;
  } catch {
    return DEFAULT_BRANCH_MATRIX;
  }
}

/**
 * ST | FD | null from the lien plaintiff. Only the two proven shapes are
 * encoded; anything else refuses to guess (null → post unbranched).
 */
function classifyLienBranch({ plaintiff = null, lienType = null } = {}) {
  const type = String(lienType || "").trim().toUpperCase();
  if (type === "FEDERAL" || type === "FD" || type === "IRS") return "FD";
  if (type === "STATE" || type === "ST") return "ST";

  const text = String(plaintiff || "").trim().toUpperCase();
  if (!text) return null;
  if (/^INTERNAL REVENUE/.test(text) || /\bINTERNAL REVENUE SERVICE\b/.test(text)) return "FD";
  if (/^STATE OF\b/.test(text)) return "ST";
  return null;
}

/**
 * The source name a lead should POST under. Identity unless: branching is
 * enabled, the base name is in the matrix, and the lien resolves a branch.
 */
function resolveBranchedSourceName({
  sourceName,
  plaintiff = null,
  lienType = null,
  env = process.env,
} = {}) {
  const base = String(sourceName || "").trim();
  const unbranched = { sourceName: base, branch: null, branched: false, logicsSourceId: null };
  if (!base || !leadSourceBranchEnabled(env)) return unbranched;

  const matrix = branchMatrix(env);
  const entry = matrix[base] || matrix[base.toUpperCase()] || null;
  if (!entry) return unbranched;

  const branch = classifyLienBranch({ plaintiff, lienType });
  if (!branch || !entry[branch]) return unbranched;

  return {
    sourceName: String(entry[branch].sourceName || base),
    branch,
    branched: true,
    logicsSourceId: entry[branch].logicsSourceId ?? null,
  };
}

/**
 * Board classification for branched names: "ABC ST"/"ABC FD" are LEAD DATA,
 * not mailers and not "Aged". (Bare "ABC" stays generic/unattributed —
 * pre-cutover book, per the forward-only rule.)
 */
function isBranchedDataLeadSource(value, env = process.env) {
  const name = String(value || "").trim();
  if (!name) return false;
  const matrix = branchMatrix(env);
  for (const entry of Object.values(matrix)) {
    for (const branch of Object.values(entry || {})) {
      if (branch?.sourceName && branch.sourceName.toLowerCase() === name.toLowerCase()) {
        return true;
      }
    }
  }
  return false;
}

module.exports = {
  DEFAULT_BRANCH_MATRIX,
  branchMatrix,
  classifyLienBranch,
  isBranchedDataLeadSource,
  leadSourceBranchEnabled,
  resolveBranchedSourceName,
};
