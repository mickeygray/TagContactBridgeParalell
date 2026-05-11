"use strict";

// Walks the full attribution chain for a single case:
//
//   CallRail call → RingCentral session legs → Logics CaseInfo → SourceCanonical
//
// Each leg of the chain provides a signal (tracking number, queue
// extension, source-campaign id, phone). `resolveCanonicalSource`
// already knows how to score those signals and pick the best
// canonical row. This module is the orchestrator that gathers the
// signals, calls the resolver, and (optionally) writes the updated
// attribution back to `CaseProfile` + `PaymentLedger` so tonight's
// email reflects any manual corrections you made in Logics during
// the day.
//
// Public entry points:
//   walkAttributionLoop(domain, caseId, options) -> resolved payload
//   applyAttributionUpdates(domain, caseId, resolved, opts) -> writes
//   refreshAttributionForCases(domain, cases, opts) -> bulk variant for nightly
//
// Returned shape:
//   {
//     domain, caseId,
//     signals: {
//       logics:   { sourceId, sourceName, cellPhone, statusId, ... } | null
//       callRail: { trackingNumber, sourceName, callId, startTime } | null
//       ringCentral: { extensionId, sourceQueue, sessionId } | null
//     },
//     resolved: {
//       canonicalKey, internalName, channel,
//       matchedBy: 'sourceId'|'internalName'|'alias'|'trackingNumber'|'phoneNumber'|'ringCentralExtension',
//       confidence: 'high'|'medium'|'low',
//       sourceCanonicalId,
//     } | null,
//     conflict: bool,                                  // signals point at different canonicals
//     updates: { caseProfile: bool, paymentLedger: bool, fields: {...} },
//     errors: string[]
//   }

const mongoose = require("mongoose");
const {
  CaseProfile,
  PaymentLedger,
  SourceCanonical,
} = require("../../shared-models/src");
const { callLogRepository } = require("../../shared-repositories/src");
const { createLogicsFacade } = require("./logicsFacadeService");
const { lookupInboundCall } = require("./callrailLookupService");
const { resolveCanonicalSource } = require("./sourceCanonicalService");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.slice(-10);
}

// ── Forward-only invariant helpers ──────────────────────────────────
//
// The nightly + hourly attribution loop pulls Logics SourceCampaignID
// as its highest-confidence signal. For mail-house cases that signal
// is "ABC" (the catch-all) — we don't write our refined attribution
// back to Logics, so Logics never agrees with our Parallel-side
// rescues. Without these guards, every loop pass walks specific
// attributions back to ABC.
//
// Rule: specific > generic, monotonically. The loop may UPGRADE a
// case (null/generic → specific) but must never DOWNGRADE (specific →
// generic). Once a CallRail rescue or operator action has refined a
// case to "Urgent Third Pink State" or similar, that's sticky.

const GENERIC_NAMES = new Set([
  "abc",
  "bcd",
  ...String(process.env.LOGICS_GENERIC_SOURCE_NAMES || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean),
]);

function isGenericInternalName(name) {
  if (!name) return false;
  return GENERIC_NAMES.has(String(name).trim().toLowerCase());
}

// matchedBy values written by rescue scripts and manual operator
// actions — these are sticky and the loop must not silently overwrite
// them with a generic Logics signal. Any value ending in "-rescue" is
// also treated as sticky so future rescue scripts inherit protection
// without code changes here.
const STICKY_MATCHED_BY = new Set([
  "abc-callrail-rescue",
  "abc-callrail-multiphone-rescue",
  "abc-rc-legs-rescue",
  "abc-tracking-number-rescue",
  "logics-source-rescue",
  "logics-discovery-rescue",
  "manual",
  "operator",
]);

function isStickyMatchedBy(value) {
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  if (STICKY_MATCHED_BY.has(normalized)) return true;
  return /-rescue$/.test(normalized);
}

function confidenceFromMatchedBy(matchedBy) {
  // Match priority mirrors `sourceCanonicalService.matchPriority`:
  // sourceId is the most authoritative signal because it ties Logics
  // CaseInfo directly to a campaign id; tracking number is also high
  // because CallRail issues unique numbers per source.
  switch (matchedBy) {
    case "sourceId":
    case "trackingNumber":
      return "high";
    case "internalName":
    case "alias":
      return "medium";
    case "phoneNumber":
    case "ringCentralExtension":
      return "low";
    default:
      return "low";
  }
}

// ── 1. Logics signal ────────────────────────────────────────────────
async function fetchLogicsSignal(domain, caseId) {
  try {
    const facade = createLogicsFacade(domain);
    const info = await facade.fetchCaseInfo(Number(caseId));
    if (!info?.ok || !info?.data) {
      return { ok: false, reason: info?.error || "no-data" };
    }
    const d = info.data;
    return {
      ok: true,
      sourceId: d.SourceCampaignID ?? d.CampaignID ?? d.SourceID ?? d.SourceId ?? null,
      sourceName:
        d.SourceName || d.SourceCampaignName || d.CampaignName || null,
      cellPhone: d.CellPhone || null,
      homePhone: d.HomePhone || null,
      statusId: d.StatusID ?? d.Status ?? null,
      firstName: d.FirstName || null,
      lastName: d.LastName || null,
      raw: d,
    };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// ── 2. CallRail signal ──────────────────────────────────────────────
async function fetchCallRailSignal(domain, phone) {
  if (!phone) return { ok: false, reason: "no-phone" };
  try {
    const result = await lookupInboundCall(domain, phone);
    if (!result?.call) return { ok: false, reason: "no-callrail-match" };
    return {
      ok: true,
      callId: result.call.callId,
      trackingNumber: result.call.trackingNumber,
      sourceName: result.call.sourceName,
      startTime: result.call.startTime,
      durationSeconds: result.call.durationSeconds,
    };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// ── 3. RingCentral signal — via Parallel CallLog ─────────────────────
//
// For attribution we want the most-recent inbound call for this case,
// since outbound dials don't carry the inbound tracking number. The
// hourly/native RingCentral sweep materializes those sessions into
// ControlPlaneCallLog, which is now the runtime source of truth.
async function fetchRingCentralSignal(domain, caseId) {
  try {
    const rows = await callLogRepository.listCallLogsByCaseId(
      normalizeDomain(domain),
      Number(caseId),
      { limit: 25, includeLegacy: false },
    );
    const doc = rows.find(
      (row) => String(row.direction || "").toLowerCase() === "inbound",
    );
    if (!doc) return { ok: false, reason: "no-rc-leg" };
    return {
      ok: true,
      sessionId: doc.telephonySessionId || doc.callSessionId || null,
      extensionId: doc.extensionId || null,
      sourceQueue: doc.sourceName || doc.mailPieceKey || null,
      phone: doc.phone || null,
      callStartTime: doc.callStartTime || doc.createdAt || null,
    };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// ── Walk the loop for a single case ─────────────────────────────────
async function walkAttributionLoop(domain, caseId, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const numericCaseId = Number(caseId);
  const errors = [];

  // Pull the three signal sources in parallel. Each is wrapped to
  // never throw — the loop is graceful when any one source is down.
  const logicsResult = await fetchLogicsSignal(normalizedDomain, numericCaseId);
  if (!logicsResult.ok) errors.push(`logics: ${logicsResult.reason}`);

  // CallRail and RC need the case's phone, which usually only the
  // Logics signal has — chain them off the logics result.
  const phone = logicsResult.cellPhone || logicsResult.homePhone || options.phone || null;

  const [callRailResult, rcResult] = await Promise.all([
    fetchCallRailSignal(normalizedDomain, phone),
    fetchRingCentralSignal(normalizedDomain, numericCaseId),
  ]);
  if (!callRailResult.ok) errors.push(`callrail: ${callRailResult.reason}`);
  if (!rcResult.ok) errors.push(`ringcentral: ${rcResult.reason}`);

  // Build the canonical-resolver query with every signal we have.
  // The resolver scores them and picks the best canonical row.
  const query = {
    domain: normalizedDomain,
    sourceId: logicsResult.ok ? logicsResult.sourceId : null,
    internalName: logicsResult.ok ? logicsResult.sourceName : null,
    sourceName: logicsResult.ok
      ? logicsResult.sourceName
      : callRailResult.ok ? callRailResult.sourceName : null,
    phone: phone ? normalizeDigits(phone) : null,
    trackingNumber: callRailResult.ok ? callRailResult.trackingNumber : null,
    extensionId: rcResult.ok ? rcResult.extensionId : null,
    queueName: rcResult.ok ? rcResult.sourceQueue : null,
  };

  let resolved = null;
  try {
    const match = await resolveCanonicalSource(query);
    if (match) {
      resolved = {
        canonicalKey: match.canonicalKey,
        internalName: match.internalName,
        channel: match.channel,
        matchedBy: match.matchedBy,
        confidence: confidenceFromMatchedBy(match.matchedBy),
        sourceCanonicalId: match.doc?._id ? String(match.doc._id) : null,
        active: match.active,
      };
    }
  } catch (error) {
    errors.push(`canonical: ${error.message}`);
  }

  // Conflict detection: at least two signals carry a name and they
  // disagree on what canonical they'd resolve to. We take a quick
  // pass by name — if Logics says "LD" and CallRail says "Direct
  // Mail" that's a conflict the user should see in the email.
  const signalNames = [
    logicsResult.ok ? logicsResult.sourceName : null,
    callRailResult.ok ? callRailResult.sourceName : null,
  ].filter(Boolean).map((s) => String(s).trim().toLowerCase());
  const conflict = new Set(signalNames).size > 1;

  return {
    domain: normalizedDomain,
    caseId: numericCaseId,
    signals: {
      logics: logicsResult.ok ? logicsResult : null,
      callRail: callRailResult.ok ? callRailResult : null,
      ringCentral: rcResult.ok ? rcResult : null,
    },
    resolved,
    conflict,
    errors,
  };
}

// ── Apply updates back to CaseProfile + PaymentLedger ───────────────
//
// Idempotent: if the profile already has the resolved canonical, no
// write happens. Returns the field-set that was applied so the caller
// can build a "corrected N cases" summary.
async function applyAttributionUpdates(domain, caseId, walk, options = {}) {
  if (!walk?.resolved) {
    return { caseProfile: false, paymentLedger: 0, fields: null, reason: "no-resolved" };
  }

  const normalizedDomain = normalizeDomain(domain);
  const numericCaseId = Number(caseId);
  const fields = {
    sourceName: walk.resolved.internalName,
    sourceChannel: walk.resolved.channel,
    sourceCanonicalId: walk.resolved.sourceCanonicalId,
  };

  // Only update if something is actually changing. Compare against
  // current CaseProfile to avoid no-op writes. Also pull
  // attribution.matchedBy + lockedManual so we can enforce the
  // forward-only invariant.
  let caseProfileUpdated = false;
  let skipReason = null;
  const profile = await CaseProfile.findOne(
    { domain: normalizedDomain, caseId: numericCaseId },
    {
      sourceName: 1,
      sourceChannel: 1,
      sourceCanonicalId: 1,
      "attribution.matchedBy": 1,
      "attribution.lockedManual": 1,
    },
  ).lean();

  if (profile) {
    // ── Guard 1: lockedManual ────────────────────────────────────────
    // Honor explicit operator locks. Mirrors writeSourceAttribution's
    // default behavior so the two write paths never disagree on this.
    if (profile.attribution?.lockedManual) {
      skipReason = "skip-locked-manual";
    }

    const profileIsGeneric = isGenericInternalName(profile.sourceName);
    const profileHasCanonical = Boolean(profile.sourceCanonicalId);
    const resolvedIsGeneric = isGenericInternalName(walk.resolved.internalName);

    // ── Guard 2: forward-only — never downgrade specific → generic ──
    // The case has a refined canonical (e.g. "Urgent Third Pink
    // State") and the resolver is trying to put it back at a generic
    // catch-all (ABC/BCD). Skip; specific wins.
    if (
      !skipReason &&
      profileHasCanonical &&
      !profileIsGeneric &&
      resolvedIsGeneric
    ) {
      skipReason = "skip-generic-downgrade";
    }

    // ── Guard 3: respect rescue/manual matchedBy ─────────────────────
    // attribution.matchedBy starting with "*-rescue" or matching a
    // known operator/manual value means this attribution was set by
    // an audited rescue script or human action. The hourly/nightly
    // loop must not overwrite it with a generic. Specific Logics
    // signals (i.e. resolver picks a non-generic canonical) are
    // still allowed through this guard — they're a legitimate
    // upgrade signal.
    if (
      !skipReason &&
      isStickyMatchedBy(profile.attribution?.matchedBy) &&
      resolvedIsGeneric
    ) {
      skipReason = "skip-rescue-overwrite";
    }

    const changed =
      String(profile.sourceName || "") !== String(fields.sourceName || "") ||
      String(profile.sourceChannel || "") !== String(fields.sourceChannel || "") ||
      String(profile.sourceCanonicalId || "") !== String(fields.sourceCanonicalId || "");

    if (skipReason) {
      // Early-return: no CP write, no inline ledger write.
      return {
        caseProfile: false,
        paymentLedger: 0,
        fields,
        reason: skipReason,
        protectedBy: skipReason.replace(/^skip-/, ""),
      };
    }

    if (changed) {
      await CaseProfile.updateOne(
        { domain: normalizedDomain, caseId: numericCaseId },
        {
          $set: {
            sourceName: fields.sourceName,
            sourceChannel: fields.sourceChannel,
            sourceCanonicalId: fields.sourceCanonicalId
              ? new mongoose.Types.ObjectId(fields.sourceCanonicalId)
              : null,
            "attribution.lastResolvedAt": new Date(),
            "attribution.matchedBy": walk.resolved.matchedBy,
            "attribution.confidence": walk.resolved.confidence,
          },
        },
      );
      caseProfileUpdated = true;
    }
  }

  // Update the PaymentLedger rows for this case so the per-source
  // rollup queries pick up the corrected canonical immediately. Route
  // through the shared helper (`syncPaymentLedgerSourceForCase`) so
  // both this loop and `caseProfileRepository.writeSourceAttribution`
  // funnel through one write path — keeps the forward-only invariant
  // and the env-gated rollback (`SOURCE_ATTRIBUTION_LEDGER_SYNC_ENABLED`)
  // consistent across both attribution write surfaces.
  let ledgerUpdated = 0;
  if (
    fields.sourceCanonicalId &&
    caseProfileUpdated &&
    options.updatePaymentLedger !== false
  ) {
    const { paymentLedgerRepository } = require("../../shared-repositories/src");
    const sync = await paymentLedgerRepository
      .syncPaymentLedgerSourceForCase(
        normalizedDomain,
        numericCaseId,
        fields.sourceCanonicalId,
        { matchedBy: walk.resolved.matchedBy || null },
      )
      .catch(() => ({ modified: 0 }));
    ledgerUpdated = Number(sync?.modified || 0);
  }

  return {
    caseProfile: caseProfileUpdated,
    paymentLedger: ledgerUpdated,
    fields,
    reason: caseProfileUpdated || ledgerUpdated ? "updated" : "no-change",
  };
}

// ── Bulk runner — walk + apply for a set of cases ───────────────────
//
// `cases` is the `dealsByCase` array (or any list of `{ domain,
// caseId }` rows). Returns an audit array showing the resolved
// attribution and update status per case. Failures don't sink the
// batch — each case wrapped in its own try/catch.
async function refreshAttributionForCases(cases = [], options = {}) {
  const out = [];
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 4, 8));
  const queue = [...cases];

  async function worker() {
    while (queue.length > 0) {
      const c = queue.shift();
      if (!c) return;
      try {
        const walk = await walkAttributionLoop(c.domain, c.caseId, {
          phone: c.phone || null,
        });
        const update = await applyAttributionUpdates(c.domain, c.caseId, walk, options);
        out.push({
          domain: c.domain,
          caseId: c.caseId,
          casePaymentId: c.casePaymentId || null,
          previousSource: c.sourceName || null,
          resolved: walk.resolved,
          conflict: walk.conflict,
          update,
          errors: walk.errors,
        });
      } catch (error) {
        out.push({
          domain: c.domain,
          caseId: c.caseId,
          casePaymentId: c.casePaymentId || null,
          error: error.message,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

module.exports = {
  walkAttributionLoop,
  applyAttributionUpdates,
  refreshAttributionForCases,
};
