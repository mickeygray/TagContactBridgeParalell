"use strict";

// LAST-RESORT SOURCE: ASK LOGICS ABOUT THE CASE.
//
// Reported by Mickey 2026-08-05: "the deal in wynn yesterday was bcd but landed
// as unattributed." Diagnosed to case 138819, $166.67, 2026-08-04.
//
// The attribution chain has three tiers and all three missed:
//
//   1. stored `sourceAtSale`   BLANK — as it is on every WYNN initial that day,
//                              and on ~35% of rows generally.
//   2. attribution CALL        no matching call.
//   3. LEAD source             reads CaseProfile.sourceName — and case 138819
//                              HAS NO CaseProfile AT ALL.
//
// So a case that converts before a profile is ever built is structurally
// unattributable, however well the registry is configured. Logics knew the whole
// time: SourceCampaignID = 31, which the registry already maps to WYNN BCD.
//
// This is the fourth tier, and it is the doctrine the rest of the system already
// follows — resolve live off the case rather than trusting a stored field that
// is blank a third of the time.
//
// AFFORDABLE BECAUSE IT IS A LAST RESORT. Only payments that resolved to nothing
// reach here, which is a handful a night, not a fan-out over every deal.

const { labelForSourceId } = require("./logicsSourceWriterService");
const { createLogicsFacade } = require("./logicsFacadeService");
const { mapLimit } = require("./statusConfirmService");

const DEFAULT_CONCURRENCY = 3;

/** Logics wraps its answer; the case body may be the object or the first row. */
function unwrapCase(response) {
  const data = response?.data ?? response;
  return Array.isArray(data) ? data[0] : data;
}

/**
 * Resolve a source name per case, straight from Logics.
 *
 * @param {Array}  cases       [{ domain, caseId }] — ONLY the unresolved ones
 * @returns {Map<string,{sourceName, campaignId, unreadable, reason}>} keyed
 *          `DOMAIN:caseId`
 */
async function resolveCaseSourcesLive({
  cases = [],
  concurrency = DEFAULT_CONCURRENCY,
  facadeFor = createLogicsFacade,
  logger = null,
} = {}) {
  const out = new Map();
  if (!cases.length) return out;

  // De-duplicate: two payments on one case are one lookup.
  const unique = new Map();
  for (const c of cases) {
    if (c?.caseId == null) continue;
    const domain = String(c.domain || "").toUpperCase();
    unique.set(`${domain}:${c.caseId}`, { domain, caseId: c.caseId });
  }

  const facades = new Map();
  const facadeOf = (d) => {
    if (!facades.has(d)) facades.set(d, facadeFor(d));
    return facades.get(d);
  };

  await mapLimit([...unique.values()], Math.max(1, concurrency), async (c) => {
    const key = `${c.domain}:${c.caseId}`;
    try {
      const body = unwrapCase(await facadeOf(c.domain).fetchCaseInfo(c.caseId));
      const campaignId = Number(body?.SourceCampaignID ?? body?.SourceID) || null;
      if (!campaignId) {
        // The case exists and names no source. That is a real answer — the case
        // genuinely has no campaign — and distinct from a failed read.
        out.set(key, { sourceName: null, campaignId: null, unreadable: false, reason: "no-campaign-id" });
        return;
      }
      // The registry is per tenant: BCD is 64 under TAG and 31 under WYNN, so
      // the domain has to travel with the id.
      //
      // labelForSourceId returns the registry ENTRY ({label, catchAll}), not a
      // string — reading it as one rendered "[object Object]" as the source name
      // on the first live run.
      const entry = labelForSourceId(c.domain, campaignId);
      const sourceName = entry?.label || (typeof entry === "string" ? entry : null);
      out.set(key, {
        sourceName,
        campaignId,
        unreadable: false,
        // An id we hold but cannot name is worth surfacing — it usually means a
        // new campaign nobody registered yet, which is a config gap rather than
        // a missing sale.
        reason: sourceName ? null : `unregistered-campaign:${campaignId}`,
      });
    } catch (error) {
      // UNREADABLE IS NOT UNATTRIBUTED. A Logics failure must not silently
      // become "this deal had no source" — that reads as a marketing result.
      logger?.warn?.("case_source_live.unreadable", { domain: c.domain, caseId: c.caseId });
      out.set(key, {
        sourceName: null, campaignId: null, unreadable: true,
        reason: String(error.message || error).slice(0, 120),
      });
    }
  });

  return out;
}

module.exports = { resolveCaseSourcesLive, unwrapCase };
