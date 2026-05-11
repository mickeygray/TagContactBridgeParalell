"use strict";

// CallLog → CaseProfile bridge sweep.
//
// Self-healing invariant: every CallLog row whose call resolved to a
// caseId should have a corresponding CaseProfile (so payment reconcile,
// metrics rollups, and the CX queue render can find the case). The
// primary path is `caseProfilePromotionService.promoteOrUpdateCaseProfile`
// invoked synchronously from the call attribution resolver, but the
// promotion can fail or get skipped (network blip, transient DB error,
// gate trip on a now-relaxed rule). This sweep catches anything missed.
//
// Looks for CallLog rows in the lookback window with `caseId` set and
// `caseProfileId` null. For each, calls the promotion service. The
// promotion service is idempotent (race-safe upsert), so re-running on a
// row that's already been promoted is a no-op merge.
//
// Wired into the hourly sweeper so missed promotions get reconciled
// within an hour at most.

const { CallLog } = require("../../shared-models/src");
const { caseProfileRepository } = require("../../shared-repositories/src");
const { createLogicsClient } = require("../../shared-integrations/src");
const {
  promoteOrUpdateCaseProfile,
} = require("./caseProfilePromotionService");
const { resolveCanonicalSource } = require("./sourceCanonicalService");

// ABC + BCD are the tenant catch-all source names — they mean "came
// from a mailer / broadcast dialer but we don't know which one." A
// match against one of these is technically a hit but doesn't add
// attribution value; we treat it as no-match and keep looking. Mirrors
// callAttributionResolverService's GENERIC_LOGICS_SOURCE_NAMES set.
const GENERIC_LOGICS_SOURCE_NAMES = new Set([
  "abc",
  "bcd",
  ...String(process.env.LOGICS_GENERIC_SOURCE_NAMES || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean),
]);

function isGenericLogicsSource(internalName) {
  if (!internalName) return true;
  return GENERIC_LOGICS_SOURCE_NAMES.has(String(internalName).trim().toLowerCase());
}

// Fetch a case from Logics, extract SourceCampaignID, resolve to a
// canonical source. Returns { sourceCanonicalId, internalName, caseInfo }
// when matched (and not generic), null otherwise.
//
// Used by the bridge to enrich CaseProfile attribution at create time.
// Without this step, bridge-promoted profiles inherited a null source
// from the originating CallLog (which often had attribution failures
// of its own), leaving paid cases attributed to "Unknown" in metrics.
async function enrichLogicsSource(domain, caseId, logger) {
  if (!domain || !Number.isFinite(Number(caseId))) return null;
  let client;
  try {
    client = createLogicsClient(domain);
  } catch (err) {
    logger?.warn?.("calllog-bridge.logics-client-failed", {
      domain,
      caseId,
      error: err.message,
    });
    return null;
  }
  let info;
  try {
    const payload = await client.getCaseInfo(Number(caseId));
    info = payload?.data || payload?.Data || payload || null;
  } catch (err) {
    if (err?.details?.responseStatus !== 404) {
      logger?.warn?.("calllog-bridge.case-info-failed", {
        domain,
        caseId,
        error: err.message,
      });
    }
    return null;
  }
  if (!info || typeof info !== "object") return null;
  const logicsSourceId =
    info.SourceCampaignID ||
    info.CampaignSourceID ||
    info.CampaignID ||
    info.SourceID ||
    info.SourceId ||
    null;
  if (!logicsSourceId) return { caseInfo: info, sourceCanonicalId: null };

  const canonical = await resolveCanonicalSource({
    domain,
    sourceId: Number(logicsSourceId),
  }).catch(() => null);
  if (!canonical) return { caseInfo: info, sourceCanonicalId: null };
  if (isGenericLogicsSource(canonical.internalName)) {
    // Match against ABC/BCD — keep but don't promote as attributed.
    // Caller decides whether to leave source null (so future strategies
    // can still try) or store the generic source.
    return {
      caseInfo: info,
      sourceCanonicalId: null,
      generic: true,
      internalName: canonical.internalName,
    };
  }
  return {
    caseInfo: info,
    sourceCanonicalId: canonical.doc?._id ? String(canonical.doc._id) : null,
    internalName: canonical.internalName,
    canonicalKey: canonical.canonicalKey,
  };
}

// 4h default. Short enough to NOT drag in legacy-era CallLog rows that
// would otherwise create CaseProfile rows with null source and pollute
// metrics ("Unknown" attribution bucket). Long enough that the hourly
// sweep is forgiving — a missed pass still catches the work on the
// next one. Override via env or per-call option for ad-hoc backfills.
const DEFAULT_LOOKBACK_MS =
  Number(process.env.CALLLOG_BRIDGE_LOOKBACK_MS) || 4 * 60 * 60 * 1000;
const DEFAULT_MAX_ROWS = 200;

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase() || null;
}

/**
 * Run one bridge sweep pass.
 *
 * @param {object} options
 * @param {string} [options.domain]       - if set, scope to a single tenant
 * @param {number} [options.lookbackMs]   - look-back window (default 24h)
 * @param {number} [options.maxRows]      - hard cap per run (default 200)
 * @param {object} [options.logger]
 * @returns {Promise<{scanned, promoted, skipped, errors, byReason}>}
 */
async function runCallLogToCaseProfileBridge({
  domain = null,
  lookbackMs = DEFAULT_LOOKBACK_MS,
  maxRows = DEFAULT_MAX_ROWS,
  logger = null,
} = {}) {
  const since = new Date(Date.now() - lookbackMs);
  const query = {
    caseId: { $ne: null, $exists: true },
    caseProfileId: { $in: [null, undefined] },
    $or: [
      { startedAt: { $gte: since } },
      { createdAt: { $gte: since } },
    ],
  };
  if (domain) {
    query.domain = normalizeDomain(domain);
  }

  const rows = await CallLog.find(query)
    .sort({ startedAt: -1, createdAt: -1 })
    .limit(Math.min(Math.max(Number(maxRows) || DEFAULT_MAX_ROWS, 1), 2000))
    .lean();

  const summary = {
    scanned: rows.length,
    promoted: 0,
    skipped: 0,
    errors: 0,
    byReason: {},
  };

  for (const row of rows) {
    const caseId = Number(row.caseId);
    if (!Number.isFinite(caseId)) {
      summary.skipped += 1;
      summary.byReason["bad-caseid"] = (summary.byReason["bad-caseid"] || 0) + 1;
      continue;
    }

    // Cheap pre-check: does the profile already exist? Saves a full
    // promotion pass on rows that just hadn't been back-linked yet
    // (a different fix would handle the back-link separately).
    const existing = await caseProfileRepository
      .findCaseProfile(row.domain, caseId)
      .catch(() => null);
    if (existing) {
      // Just back-link the CallLog to the profile so the next sweep
      // doesn't pick this row up again.
      try {
        await CallLog.updateOne(
          { _id: row._id },
          { $set: { caseProfileId: existing._id } },
        );
        summary.promoted += 1;
        summary.byReason["back-linked-existing"] =
          (summary.byReason["back-linked-existing"] || 0) + 1;
      } catch (error) {
        summary.errors += 1;
        logger?.warn?.("calllog-bridge.backlink-failed", {
          callLogId: String(row._id),
          caseId,
          error: error.message,
        });
      }
      continue;
    }

    // Profile missing — promote via the standard service. The gate
    // accepts callLogId as engagement evidence (per the
    // caseProfilePromotionService invariant), so we always have at
    // least that signal here.
    //
    // Source enrichment: if the originating CallLog had a resolved
    // sourceCanonicalId, pass it through. Otherwise fetch the case
    // from Logics and resolve via SourceCampaignID. Without this step
    // the CaseProfile lands with null source and any payment that
    // arrives later shows as "Unknown" in metrics — which is the
    // attribution gap that motivated this enrichment.
    let resolvedSourceCanonicalId = row.sourceCanonicalId || null;
    let resolvedStrategy = row.strategy || null;
    let resolvedConfidence = row.confidence || null;
    let logicsCaseInfo = null;
    if (!resolvedSourceCanonicalId) {
      const enriched = await enrichLogicsSource(row.domain, caseId, logger);
      if (enriched) {
        logicsCaseInfo = enriched.caseInfo || null;
        if (enriched.sourceCanonicalId) {
          resolvedSourceCanonicalId = enriched.sourceCanonicalId;
          resolvedStrategy = "logics-source";
          resolvedConfidence = "high";
          summary.byReason["enriched-from-logics"] =
            (summary.byReason["enriched-from-logics"] || 0) + 1;
        } else if (enriched.generic) {
          summary.byReason["logics-generic-source"] =
            (summary.byReason["logics-generic-source"] || 0) + 1;
        }
      }
    }

    try {
      const result = await promoteOrUpdateCaseProfile({
        domain: row.domain,
        caseId,
        caseDomain: row.caseDomain || row.domain,
        trigger: "calllog-bridge",
        telephonySessionId: row.telephonySessionId || null,
        callLogId: row._id,
        sourceCanonicalId: resolvedSourceCanonicalId,
        strategy: resolvedStrategy,
        confidence: resolvedConfidence,
        customerPhone:
          row.direction === "inbound"
            ? row.fromNumber || row.normalizedPhone || null
            : row.toNumber || row.normalizedPhone || null,
        contactName: row.contactName || null,
        // Pass Logics case info through so the promotion path's
        // identity-fallback chain (MasterProspect → Logics → call)
        // can use it when MP is missing.
        logicsEnrichment: logicsCaseInfo
          ? {
              firstName: logicsCaseInfo.FirstName || null,
              lastName: logicsCaseInfo.LastName || null,
              name:
                [logicsCaseInfo.FirstName, logicsCaseInfo.LastName]
                  .filter(Boolean)
                  .join(" ")
                  .trim() || null,
              email: logicsCaseInfo.Email || null,
              cellPhone: logicsCaseInfo.CellPhone || null,
              homePhone: logicsCaseInfo.HomePhone || null,
              statusId:
                logicsCaseInfo.StatusID != null
                  ? Number(logicsCaseInfo.StatusID)
                  : null,
              createdDate: logicsCaseInfo.CreatedDate || null,
            }
          : null,
        caseCreatedDate: logicsCaseInfo?.CreatedDate
          ? new Date(logicsCaseInfo.CreatedDate)
          : null,
        caseSaleDate: logicsCaseInfo?.SaleDate
          ? new Date(logicsCaseInfo.SaleDate)
          : null,
        logger,
      });

      if (result?.skipped) {
        summary.skipped += 1;
        summary.byReason[result.reason || "skipped"] =
          (summary.byReason[result.reason || "skipped"] || 0) + 1;
      } else {
        summary.promoted += 1;
        summary.byReason[result?.action || "promoted"] =
          (summary.byReason[result?.action || "promoted"] || 0) + 1;
      }
    } catch (error) {
      summary.errors += 1;
      logger?.warn?.("calllog-bridge.promote-failed", {
        callLogId: String(row._id),
        caseId,
        domain: row.domain,
        error: error.message,
      });
    }
  }

  logger?.info?.("calllog-bridge.summary", summary);
  return summary;
}

module.exports = {
  runCallLogToCaseProfileBridge,
  DEFAULT_LOOKBACK_MS,
  DEFAULT_MAX_ROWS,
};
