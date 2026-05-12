"use strict";

// Source-name backfill: walks CallLog rows in a time window that have a
// caseId set but are missing sourceName/sourceChannel, and stamps both
// fields from the case's LeadCadence record (which carries the canonical
// intake-time attribution — e.g. sourceName="LD Posting",
// sourceChannel="lead-distribution" for LD vendor leads).
//
// Why this exists:
//
//   The CX-cadence write path (`cxCadenceService.upsertCallLog`,
//   `cxWorkspaceService` disposition-hangup defensive write) creates
//   stub CallLog rows keyed by telephonySessionId + caseId. Those stubs
//   intentionally don't carry sourceName at write time — the EX
//   resolver (callAttributionResolverService) is the canonical writer
//   for source attribution and it fires on RC EX presence webhooks. CX
//   pure outbound calls (where there's no EX leg) never see that
//   resolver, so the stub stays sourceName-less.
//
//   The vendor nightly email + metrics workspace + ledger summaries all
//   pivot on CallLog/CallLedger.sourceName via the
//   classifyVendorFamily classifier. A null sourceName means the call
//   is invisible to the vendor pipeline even though we know the caseId.
//
//   This backfill closes the gap on the read side: for every CallLog
//   row that has caseId but no sourceName, look up the case's
//   LeadCadence row and copy its sourceName/sourceChannel onto the
//   CallLog (+ sync the CallLedger). After the backfill runs:
//     • LD lead → CX outbound call → CallLog.sourceName = "LD Posting"
//     • Vendor email + metrics counts the call under "LD Posting" family
//     • Ledger summary picks it up via summarizeCallLedgerBySource
//
// Cadence:
//
//   Cheap enough to run as part of the nightly close pass (right
//   before the email assembles). Also exposed as an on-demand helper
//   so we can backfill historical windows from a script.

const { CallLog } = require("../../shared-models/src");
const {
  leadCadenceRepository,
  masterProspectRepository,
} = require("../../shared-repositories/src");
const { syncCallLedgerFromCallLog } = require("./callLedgerService");
const { buildTimezoneDateWindow } = require("./timezoneDateWindowService");

const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_LIMIT = 5000;

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function buildEmptySourceMatcher() {
  // "sourceName not usefully populated" — null, missing, or empty string.
  return {
    $or: [
      { sourceName: null },
      { sourceName: { $exists: false } },
      { sourceName: "" },
    ],
  };
}

function pickFromCadence(cadence) {
  const sourceName =
    cadence?.sourceName ||
    cadence?.attributionContext?.sourceName ||
    cadence?.metadata?.sourceName ||
    null;
  const sourceChannel =
    cadence?.sourceChannel ||
    cadence?.attributionContext?.sourceChannel ||
    cadence?.metadata?.sourceChannel ||
    null;
  return { sourceName, sourceChannel };
}

function pickFromMasterProspect(prospect) {
  if (!prospect) return { caseId: null, sourceName: null, sourceChannel: null };
  return {
    caseId: Number.isFinite(Number(prospect.caseId)) ? Number(prospect.caseId) : null,
    sourceName: prospect.metadata?.sourceName || null,
    sourceChannel: prospect.metadata?.sourceChannel || null,
  };
}

function tenDigit(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  // 3-4 digit dialed numbers are extension-to-extension internal calls
  // and never carry case attribution — bail (per operator heuristic).
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

async function backfillCallLogSourceFromLeadCadence({
  domain,
  date = null,
  windowStart = null,
  windowEnd = null,
  timezone = DEFAULT_TIMEZONE,
  limit = DEFAULT_LIMIT,
  syncLedger = true,
  logger = null,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) {
    return { ok: false, error: "domain is required" };
  }

  let start = windowStart instanceof Date ? windowStart : null;
  let end = windowEnd instanceof Date ? windowEnd : null;
  if ((!start || !end) && date) {
    const window = buildTimezoneDateWindow(String(date), timezone);
    start = start || window.start;
    end = end || window.end;
  }
  if (!start || !end) {
    return { ok: false, error: "either {date} or {windowStart, windowEnd} is required" };
  }

  const effectiveLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 50000);
  const summary = {
    ok: true,
    domain: normalizedDomain,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    rowsScanned: 0,
    rowsStamped: 0,
    rowsSkippedNoCadence: 0,
    rowsSkippedNoCaseId: 0,
    rowsPhoneRescued: 0,
    rowsPhoneRescuedFromLeadCadence: 0,
    rowsPhoneRescuedFromMasterProspect: 0,
    rowsPhoneSkippedNoMatch: 0,
    rowsPhoneSkippedShortNumber: 0,
    ledgerResyncs: 0,
    ledgerErrors: 0,
    errors: [],
  };

  // ── Pass 1: caseId-present, sourceName-missing ─────────────────────
  // The common case for CX-cadence stubs. We know the case; just copy
  // the case's intake-time sourceName onto the call.
  const candidateRows = await CallLog.find(
    {
      domain: normalizedDomain,
      callStartTime: { $gte: start, $lte: end },
      caseId: { $ne: null },
      ...buildEmptySourceMatcher(),
    },
    { _id: 1, telephonySessionId: 1, caseId: 1, caseDomain: 1 },
  )
    .limit(effectiveLimit)
    .lean();

  summary.rowsScanned = candidateRows.length;
  if (candidateRows.length === 0) {
    // Fall through to phone-rescue pass anyway — no caseId rows are
    // independent of the "has caseId but no source" pass.
  }

  const caseIds = [...new Set(
    candidateRows
      .map((row) => Number(row.caseId))
      .filter(Number.isFinite),
  )];

  let cadenceRows = [];
  try {
    cadenceRows = await leadCadenceRepository.listLeadCadenceByCaseIds(
      normalizedDomain,
      caseIds,
    );
  } catch (error) {
    summary.errors.push({ step: "lead-cadence-lookup", error: error.message });
    return summary;
  }

  const cadenceByCaseId = new Map();
  for (const cadence of cadenceRows) {
    const key = Number(cadence?.caseId);
    if (Number.isFinite(key)) cadenceByCaseId.set(key, cadence);
  }

  for (const row of candidateRows) {
    const caseId = Number(row.caseId);
    if (!Number.isFinite(caseId)) {
      summary.rowsSkippedNoCaseId += 1;
      continue;
    }
    const cadence = cadenceByCaseId.get(caseId);
    if (!cadence) {
      summary.rowsSkippedNoCadence += 1;
      continue;
    }
    const { sourceName, sourceChannel } = pickFromCadence(cadence);
    if (!sourceName && !sourceChannel) {
      summary.rowsSkippedNoCadence += 1;
      continue;
    }

    const update = {};
    if (sourceName) update.sourceName = sourceName;
    if (sourceChannel) update.sourceChannel = sourceChannel;

    try {
      // Re-check guard: we only stamp if the row STILL has no sourceName.
      // Belt-and-suspenders against a concurrent resolver run that may
      // have written a high-confidence sourceName between the scan and
      // the update — its decision is canonical, ours is fallback.
      const writeResult = await CallLog.updateOne(
        { _id: row._id, ...buildEmptySourceMatcher() },
        { $set: update },
      );
      if (writeResult.modifiedCount === 0) continue;
      summary.rowsStamped += 1;

      if (syncLedger) {
        try {
          const fresh = await CallLog.findById(row._id).lean();
          if (fresh) {
            const ledgerResult = await syncCallLedgerFromCallLog(fresh, {
              syncedAt: new Date(),
            });
            if (!ledgerResult?.skipped) summary.ledgerResyncs += 1;
          }
        } catch (ledgerError) {
          summary.ledgerErrors += 1;
          summary.errors.push({
            step: "ledger-sync",
            telephonySessionId: row.telephonySessionId,
            error: ledgerError.message,
          });
        }
      }
    } catch (error) {
      summary.errors.push({
        step: "calllog-update",
        telephonySessionId: row.telephonySessionId,
        error: error.message,
      });
    }
  }

  // ── Pass 2: phone-rescue (null caseId, 10+ digit phone) ─────────────
  //
  // The EX-resolver gave up on these calls — either Logics findCaseByPhone
  // returned nothing or the resolver bailed earlier in the chain. But we
  // may still have the lead in Parallel-side LeadCadence (intaken via
  // /lead-contact, /api/inbound/ld/lead, the affiliate path, etc.). If
  // a LeadCadence row matches the call's phone number, stamp both
  // caseId and sourceName onto the CallLog.
  //
  // Skip 3-4 digit dialed numbers — those are extension-to-extension
  // internal calls (per `tenDigit()` heuristic), never case-bound.
  const phoneRescueRows = await CallLog.find(
    {
      domain: normalizedDomain,
      callStartTime: { $gte: start, $lte: end },
      $or: [{ caseId: null }, { caseId: { $exists: false } }],
      phone: { $ne: null },
    },
    { _id: 1, telephonySessionId: 1, phone: 1, normalizedPhone: 1, caseDomain: 1 },
  )
    .limit(effectiveLimit)
    .lean();

  for (const row of phoneRescueRows) {
    const phone = tenDigit(row.normalizedPhone || row.phone);
    if (!phone) {
      summary.rowsPhoneSkippedShortNumber += 1;
      continue;
    }
    // Lookup ladder: LeadCadence → MasterProspectIndex. LeadCadence is
    // the canonical Parallel-side intake record; MasterProspectIndex
    // covers a broader set (mail-intake, NCOA, prospect mirror from
    // Logics) so it catches phones that never went through the
    // /lead-contact intake path.
    let cadence = null;
    let cadenceCaseId = null;
    let resolvedSourceName = null;
    let resolvedSourceChannel = null;
    let resolvedSource = null; // "leadCadence" | "masterProspect"

    try {
      cadence = await leadCadenceRepository.findLeadCadenceByPhone(
        normalizedDomain,
        phone,
      );
    } catch (error) {
      summary.errors.push({
        step: "lead-cadence-phone-lookup",
        phone,
        error: error.message,
      });
    }
    if (cadence && Number.isFinite(Number(cadence.caseId))) {
      const picked = pickFromCadence(cadence);
      cadenceCaseId = Number(cadence.caseId);
      resolvedSourceName = picked.sourceName;
      resolvedSourceChannel = picked.sourceChannel;
      resolvedSource = "leadCadence";
    } else {
      try {
        const prospect = await masterProspectRepository
          .findMasterProspectByNormalizedPhone(normalizedDomain, phone);
        const picked = pickFromMasterProspect(prospect);
        if (picked.caseId != null) {
          cadenceCaseId = picked.caseId;
          resolvedSourceName = picked.sourceName;
          resolvedSourceChannel = picked.sourceChannel;
          resolvedSource = "masterProspect";
        }
      } catch (error) {
        summary.errors.push({
          step: "master-prospect-phone-lookup",
          phone,
          error: error.message,
        });
      }
    }

    if (cadenceCaseId == null) {
      summary.rowsPhoneSkippedNoMatch += 1;
      continue;
    }

    const update = { caseId: cadenceCaseId };
    if (!row.caseDomain) update.caseDomain = normalizedDomain;
    if (resolvedSourceName) update.sourceName = resolvedSourceName;
    if (resolvedSourceChannel) update.sourceChannel = resolvedSourceChannel;

    try {
      // Belt-and-suspenders: still null caseId on the write — guard
      // against a concurrent resolver pass landing a stronger answer.
      const writeResult = await CallLog.updateOne(
        {
          _id: row._id,
          $or: [{ caseId: null }, { caseId: { $exists: false } }],
        },
        { $set: update },
      );
      if (writeResult.modifiedCount === 0) {
        summary.rowsPhoneSkippedNoMatch += 1;
        continue;
      }
      summary.rowsPhoneRescued += 1;
      if (resolvedSource === "leadCadence") {
        summary.rowsPhoneRescuedFromLeadCadence += 1;
      } else if (resolvedSource === "masterProspect") {
        summary.rowsPhoneRescuedFromMasterProspect += 1;
      }

      if (syncLedger) {
        try {
          const fresh = await CallLog.findById(row._id).lean();
          if (fresh) {
            const ledgerResult = await syncCallLedgerFromCallLog(fresh, {
              syncedAt: new Date(),
            });
            if (!ledgerResult?.skipped) summary.ledgerResyncs += 1;
          }
        } catch (ledgerError) {
          summary.ledgerErrors += 1;
          summary.errors.push({
            step: "ledger-sync-phone-rescue",
            telephonySessionId: row.telephonySessionId,
            error: ledgerError.message,
          });
        }
      }
    } catch (error) {
      summary.errors.push({
        step: "calllog-update-phone-rescue",
        telephonySessionId: row.telephonySessionId,
        error: error.message,
      });
    }
  }

  if (logger?.info) {
    logger.info("call-log.source-backfill.complete", summary);
  }

  return summary;
}

module.exports = {
  backfillCallLogSourceFromLeadCadence,
};
