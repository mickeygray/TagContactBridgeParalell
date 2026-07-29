"use strict";

// Payments-sheet reconcile pass (2026-07-24) — the "one sheet corrects
// everything" step Mickey asked for. Runs after the daily Logics
// PaymentsReport import, scoped to the cases the file actually contains.
//
// What one upload now fixes, measured on the 2026-07-24 TAG export
// (300 rows, 244 cases):
//   - 29 paying clients had NO CaseProfile at all — legacy payment-plan
//     clients who never came through the lead flow. They get profiles, so
//     the upsell tooling can see them and the delivery gate's
//     payment-or-converted check protects them from ever being dialed.
//   - 59 cases where the sheet carries a REAL mailer/source name and the
//     profile has none (null/ABC/Unknown) — the sheet fixes attribution.
//   - Payment rollups (totalPaid, paymentsCount, first/last payment) are
//     recomputed from the ledger via the existing
//     caseProfilePaymentSyncService drift machinery.
//
// Hard rules:
//   - NEVER overwrite a real profile source with the sheet's. The
//     attribution hierarchy stays manual > profile > payment. A true
//     conflict is REPORTED, not resolved.
//   - Names fill only when the profile has none ("we won't always have the
//     case name" — when we do, take it; never clobber).
//   - Everything is idempotent and dry-runnable.

const CaseProfile = require("../../shared-models/src/CaseProfile");
const { caseProfileRepository } = require("../../shared-repositories/src");
const { isMissingDealSource } = require("./simpleDealMathService");
const { SOURCE_ALIASES } = require("./simpleMarketingReadService");
// Namespace (not destructured) so tests can stub the rollup pass.
const caseProfilePaymentSync = require("./caseProfilePaymentSyncService");

function canonicalSourceName(value) {
  const name = String(value || "").trim();
  if (!name) return null;
  return SOURCE_ALIASES[name] || name;
}
// NOTE (Mickey, 2026-07-24, FORWARD-LOOKING — do not encode into current
// data): a fee captured via a different contact method (dialer / hand
// dial) is no longer attributed to the origin source, and the future model
// makes mail generically "Mail" by State/Federal with costs in Logics —
// "Aged sorta goes away". Until that lands, profile-vs-sheet disagreements
// like BCD vs "CallFire Dialer" stay REPORTED conflicts; they are explained
// by the capture rule but nothing is rewritten. See memory:
// deal-count-and-chargeback-doctrine.

function splitClientName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name) return { firstName: null, lastName: null };
  const parts = name.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * Collapse the file's rows to one record per case: client name plus the
 * set of non-generic source names the sheet asserts for it.
 */
function collectSheetCases(rows = []) {
  const byCase = new Map();
  for (const row of rows) {
    const caseId = Number(row.caseId);
    if (!Number.isFinite(caseId) || caseId <= 0) continue;
    let entry = byCase.get(caseId);
    if (!entry) {
      entry = { caseId, clientName: null, sources: new Set() };
      byCase.set(caseId, entry);
    }
    if (!entry.clientName && String(row.client || "").trim()) {
      entry.clientName = String(row.client).trim();
    }
    const source = String(row.sourceName || "").trim();
    if (source && !isMissingDealSource(source)) {
      entry.sources.add(canonicalSourceName(source));
    }
  }
  return byCase;
}

/**
 * Reconcile case/client profiles for every case in one imported sheet.
 *
 * `rows` are parsePaymentsCsv rows (already SUCCESS-filtered upstream is
 * fine — profile facts are the same either way).
 */
async function reconcileSheetCases({
  domain,
  rows = [],
  dryRun = false,
  // Rollup recompute touches the ledger per case; cap protects against a
  // pathological file. 244-case daily files are nowhere near this.
  maxRollupCases = 2000,
  logger = null,
} = {}) {
  const normalizedDomain = String(domain || "").trim().toUpperCase();
  if (!normalizedDomain) throw new TypeError("domain is required");

  const sheetCases = collectSheetCases(rows);
  const summary = {
    domain: normalizedDomain,
    dryRun: Boolean(dryRun),
    cases: sheetCases.size,
    profilesCreated: 0,
    namesFilled: 0,
    sourcesFilled: 0,
    sourceConflicts: [],
    rollupsChecked: 0,
    rollupsCorrected: 0,
    rollupErrors: 0,
    actions: [],
  };
  if (!sheetCases.size) return summary;

  const caseIds = [...sheetCases.keys()];
  const profiles = await CaseProfile.find({
    domain: normalizedDomain,
    caseId: { $in: caseIds },
  })
    .select("caseId name firstName lastName sourceName")
    .lean();
  const profileByCase = new Map(profiles.map((p) => [Number(p.caseId), p]));

  for (const [caseId, entry] of sheetCases) {
    const profile = profileByCase.get(caseId) || null;
    // One real source, deterministically chosen. Multi-source cases are
    // rare and ambiguous — report, don't guess.
    const sheetSources = [...entry.sources];
    const sheetSource = sheetSources.length === 1 ? sheetSources[0] : null;
    if (sheetSources.length > 1) {
      summary.sourceConflicts.push({
        caseId,
        kind: "sheet-ambiguous",
        sheet: sheetSources,
      });
    }

    if (!profile) {
      // A paying client with no profile: the legacy back book. Create it.
      const { firstName, lastName } = splitClientName(entry.clientName);
      summary.profilesCreated += 1;
      summary.actions.push({
        action: "create-profile",
        caseId,
        name: entry.clientName || null,
        sourceName: sheetSource,
      });
      if (!dryRun) {
        await caseProfileRepository.upsertCaseProfile(normalizedDomain, caseId, {
          firstName: firstName || undefined,
          lastName: lastName || undefined,
          name: entry.clientName || undefined,
          sourceName: sheetSource || undefined,
          // They are paying clients, whatever their lead history was.
          statusCategory: "client",
        });
      }
      continue;
    }

    const update = {};
    const hasName = Boolean(
      String(profile.name || "").trim()
      || String(profile.firstName || "").trim()
      || String(profile.lastName || "").trim(),
    );
    if (!hasName && entry.clientName) {
      const { firstName, lastName } = splitClientName(entry.clientName);
      update.name = entry.clientName;
      if (firstName) update.firstName = firstName;
      if (lastName) update.lastName = lastName;
      summary.namesFilled += 1;
    }

    const profileSource = String(profile.sourceName || "").trim();
    const profileHasReal = profileSource && !isMissingDealSource(profileSource);
    if (sheetSource && !profileHasReal) {
      update.sourceName = sheetSource;
      summary.sourcesFilled += 1;
    } else if (
      sheetSource
      && profileHasReal
      && canonicalSourceName(profileSource).toLowerCase() !== sheetSource.toLowerCase()
    ) {
      // Both real, and they disagree even after aliasing: a human question.
      summary.sourceConflicts.push({
        caseId,
        kind: "profile-vs-sheet",
        profile: profileSource,
        sheet: sheetSource,
      });
    }

    if (Object.keys(update).length) {
      summary.actions.push({ action: "update-profile", caseId, ...update });
      if (!dryRun) {
        await caseProfileRepository.upsertCaseProfile(normalizedDomain, caseId, update);
      }
    }
  }

  // Payment rollups — reuse the drift machinery the hourly sweep already
  // trusts, per case, now that every case has a profile. In dryRun the
  // profiles for the 29 don't exist yet, so processCandidateCase would
  // no-op on them; skip the pass entirely rather than report half-truths.
  if (!dryRun) {
    const rollupIds = caseIds.slice(0, maxRollupCases);
    for (const caseId of rollupIds) {
      try {
        const outcome = await caseProfilePaymentSync.processCandidateCase({
          normalizedDomain,
          caseId,
          dryRun: false,
          logger,
        });
        summary.rollupsChecked += 1;
        if (outcome?.drifted) summary.rollupsCorrected += 1;
      } catch (error) {
        summary.rollupErrors += 1;
        logger?.warn?.("payments_sheet_reconcile.rollup_failed", {
          domain: normalizedDomain,
          caseId,
          error: String(error.message).slice(0, 160),
        });
      }
    }
    if (caseIds.length > maxRollupCases) {
      summary.rollupsTruncatedAt = maxRollupCases;
    }
  }

  return summary;
}

module.exports = {
  canonicalSourceName,
  collectSheetCases,
  reconcileSheetCases,
  splitClientName,
};
