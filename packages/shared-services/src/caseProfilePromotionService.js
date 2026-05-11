"use strict";

const {
  callLogRepository,
  caseProfileRepository,
  masterProspectRepository,
} = require("../../shared-repositories/src");
const { CallLog } = require("../../shared-models/src");
const { syncCallLedgerBySession } = require("./callLedgerService");
const { syncCaseCallRollup } = require("./caseCallRollupService");

function normalizeDomain(domain) {
  return String(domain || "").toUpperCase();
}

/**
 * Promote / update a CaseProfile.
 *
 * Invariant: a CaseProfile is created only for **engaged** cases. A
 * case is "engaged" when it has caseId AND at least one of:
 *   - source attribution     (we know where it came from)
 *   - payment info           (revenue has landed)
 *   - call evidence          (callLogId or telephonySessionId — i.e.
 *                             an inbound call from this prospect, or
 *                             an agent-initiated outbound dial)
 *
 * caseId alone is still not enough. A bare lead in MPI without any of
 * the above stays in MasterProspect — that's the raw vendor pool, not
 * the refined CaseProfile list.
 *
 * Why call evidence counts: an inbound call to one of our tracking
 * numbers means the prospect chose to contact us; an outbound dial
 * means an agent deliberately worked the case. Both are engagement
 * signals, and downstream services (payment reconcile, metrics
 * rollups, CX queue render) need a CaseProfile to track the case.
 * Without this, payments that arrive AFTER a call but with no source
 * attribution were invisible to the hourly reconciler.
 *
 * Callers:
 *   - `promoteOrUpdateFromResolution` (the attribution path) passes a
 *     `sourceCanonicalId` when the resolver matched, plus the
 *     `callLogId` of the call that drove this promotion.
 *   - A payment ingest service would pass `paymentInfo`, same invariant
 *     still holds.
 *
 * Chain position:
 *   MasterProspectIndex (intake)
 *   → CallLog (attribution decisions)
 *   → CaseProfile (authoritative; payments + metrics)
 *
 * Behavior:
 *   1. If CaseProfile exists + `lockedManual` → append CallLog only.
 *   2. If CaseProfile exists + empty `sourceCanonicalId` and we have
 *      new source → `setAttributionIfEmpty` (race-safe). Append
 *      CallLog either way.
 *   3. If CaseProfile exists + already has `sourceCanonicalId` → append
 *      CallLog only (don't clobber earlier attribution).
 *   4. If CaseProfile doesn't exist AND (source OR payment) → create
 *      via `createCaseProfileIfMissing` (`$setOnInsert` + `$addToSet`
 *      $each on contactActivityIds), also backfill any prior CallLog
 *      rows for this case into the new profile's contact history.
 *   5. After CaseProfile exists (either pre-existing or freshly created)
 *      AND a MasterProspect row exists → mark MP `convertedAt` +
 *      `caseProfileId`. MP is the intake staging list; once the case
 *      has a CaseProfile, the MP row is redundant and a nightly
 *      cleanup removes it after a quiet window.
 *   6. Back-link `CallLog.caseProfileId` so the UI can click through.
 */
async function promoteOrUpdateCaseProfile({
  domain,
  caseId,
  caseDomain,
  trigger = "attribution",           // "attribution" | "payment" | "manual"
  telephonySessionId = null,
  callLogId = null,
  sourceCanonicalId = null,
  strategy = null,
  confidence = null,
  paymentInfo = null,                // { amount, paidAt, paymentId, ... }
  customerPhone = null,
  contactName = null,
  logicsEnrichment = null,
  caseCreatedDate = null,            // From Logics CaseInfo.CreatedDate
  caseSaleDate = null,                // From Logics CaseInfo.SaleDate (nullable)
  logger = null,
}) {
  if (!caseId) {
    return { skipped: true, reason: "no caseId" };
  }
  const effectiveDomain = normalizeDomain(caseDomain || domain);
  if (!effectiveDomain) {
    return { skipped: true, reason: "no domain" };
  }
  const hasSource = Boolean(sourceCanonicalId);
  const hasPayment = Boolean(paymentInfo);
  // Call evidence: a callLogId (we wrote a CallLog row for this) or a
  // telephonySessionId (an active telephony session bound to this
  // case). Either one means the case has been engaged with — see the
  // invariant comment at the top of this function for the full
  // rationale.
  const hasCallEvidence = Boolean(callLogId || telephonySessionId);

  const outcome = {
    domain: effectiveDomain,
    caseId,
    trigger,
    action: null,
    attributionWritten: false,
    paymentApplied: false,
    contactActivityAppended: false,
    prospectDeleted: false,
    caseProfileId: null,
    callLedgerSynced: false,
    callLedgerError: null,
    callRollupSynced: false,
    callRollupError: null,
  };

  const existing = await caseProfileRepository.findCaseProfile(
    effectiveDomain,
    caseId,
  );

  // Rule: caseId alone is insufficient. Need source OR payment OR call
  // evidence. When a profile already exists, we fall through to the
  // update path regardless (adding contact history, maybe filling in
  // attribution).
  if (!existing && !hasSource && !hasPayment && !hasCallEvidence) {
    return {
      ...outcome,
      skipped: true,
      reason: "insufficient-signal",
      rule: "need source, payment, or call evidence on create",
    };
  }

  let profile = existing;

  if (!profile) {
    // ── Create new CaseProfile from MasterProspect + attribution ───────
    //
    // Priority order for identity fields: MasterProspect (richest) →
    // Logics enrichment (when case exists only in Logics, no MP yet) →
    // whatever the call carried (contactName / customerPhone). This
    // guarantees we never write `null null` when Logics returned a real
    // name for the case.
    const prospect = await masterProspectRepository.findMasterProspect(
      effectiveDomain,
      caseId,
    );
    const initialFields = {
      firstName:
        prospect?.firstName || logicsEnrichment?.firstName || null,
      lastName:
        prospect?.lastName || logicsEnrichment?.lastName || null,
      name:
        prospect?.name ||
        logicsEnrichment?.name ||
        contactName ||
        null,
      email: prospect?.email || logicsEnrichment?.email || null,
      primaryPhone:
        prospect?.cellPhone ||
        prospect?.homePhone ||
        logicsEnrichment?.cellPhone ||
        logicsEnrichment?.homePhone ||
        customerPhone ||
        null,
      normalizedPhones: Array.isArray(prospect?.normalizedPhones)
        ? prospect.normalizedPhones
        : [],
      statusId: prospect?.statusId || logicsEnrichment?.statusId || null,
      statusCategory: prospect?.statusCategory || "prospect",
      masterProspectId: prospect?._id || null,
      sourceCanonicalId: sourceCanonicalId || null,
      // Capture the Logics creation date — drives the aged-data override
      // decision for later outbound calls on this case. Fall back to
      // logicsEnrichment (findCaseByPhone mapping) if the CaseInfo fetch
      // wasn't done.
      caseCreatedDate:
        caseCreatedDate ||
        (logicsEnrichment?.createdDate
          ? new Date(logicsEnrichment.createdDate)
          : null),
      attribution: {
        matchedBy: strategy || null,
        confidence: confidence || null,
        lockedManual: false,
        needsReview: false,
        lastResolvedAt: new Date(),
      },
      contactActivityIds: callLogId ? [callLogId] : [],
    };

    // Payment-trigger path seeds payment fields on create. Attribution
    // can still arrive later (a resolver call for this phone would find
    // the profile, see `sourceCanonicalId: null`, and fill it in via
    // `setAttributionIfEmpty`).
    if (paymentInfo) {
      const amount = Number(paymentInfo.amount) || 0;
      const paidAt = paymentInfo.paidAt ? new Date(paymentInfo.paidAt) : null;
      Object.assign(initialFields, {
        firstPaymentDate: paidAt || initialFields.firstPaymentDate || null,
        initialPayment: amount,
        totalPaid: amount,
        paymentsCount: 1,
        lastPaymentDate: paidAt || null,
        lastPaymentAmount: amount,
        convertedAt: paidAt || new Date(),
        statusCategory: "client",
      });
      if (paymentInfo.paymentId) {
        initialFields.paymentIds = [paymentInfo.paymentId];
      }
    }
    // Backfill prior CallLog rows that already exist for this case —
    // they predate the profile (because earlier calls only bound
    // caseId without meeting the source/payment rule). Merging them in
    // on creation gives the case a complete contact history instead of
    // only the CallLog that triggered this promotion.
    try {
      const prior = await CallLog.find({
        domain: effectiveDomain,
        caseId: Number(caseId),
      })
        .select("_id")
        .lean();
      if (prior.length > 0) {
        const seedIds = new Set(
          initialFields.contactActivityIds.map((id) => String(id)),
        );
        for (const row of prior) seedIds.add(String(row._id));
        initialFields.contactActivityIds = [...seedIds];
      }
    } catch (error) {
      logger?.warn?.("caseprofile.prior_calllog_backfill_failed", {
        caseId,
        error: error.message,
      });
    }

    // Race-safe create: identity + attribution seed fields go in
    // `$setOnInsert`, contactActivityIds uses `$addToSet $each`. If two
    // webhooks race on the same session, both produce the same seeded
    // state and both activity IDs make it into the array.
    profile = await caseProfileRepository.createCaseProfileIfMissing(
      effectiveDomain,
      caseId,
      initialFields,
    );
    // Detect whether we actually inserted or someone beat us to it — if
    // the returned doc's sourceCanonicalId matches what we tried to
    // write, we won; otherwise the race winner wrote first and we need
    // to fall back to the update path (attribution + activity append).
    const weCreated =
      sourceCanonicalId
        ? String(profile.sourceCanonicalId || "") === String(sourceCanonicalId)
        : true;
    outcome.action = weCreated ? "created" : "updated-race";
    outcome.attributionWritten = weCreated && Boolean(sourceCanonicalId);
    outcome.contactActivityAppended = Boolean(callLogId);
    if (!weCreated && sourceCanonicalId && !profile.sourceCanonicalId) {
      // Race winner created without a source; try first-touch again.
      const updated = await caseProfileRepository.setAttributionIfEmpty(
        effectiveDomain,
        caseId,
        {
          sourceCanonicalId,
          matchedBy: strategy || null,
          confidence: confidence || null,
        },
      );
      if (updated) {
        profile = updated;
        outcome.attributionWritten = true;
      }
    }
    logger?.info?.("caseprofile.promoted", {
      domain: effectiveDomain,
      caseId,
      strategy,
      sourceCanonicalId,
      action: outcome.action,
    });
  } else {
    outcome.action = "updated";
    // ── Existing profile — maybe update attribution, maybe apply
    // payment, always append any incoming CallLog. Each sub-write is
    // race-safe on its own (setAttributionIfEmpty is conditional,
    // applyPaymentToCaseProfile dedupes on paymentId, appendContactActivity
    // uses $addToSet).
    //
    // Backfill caseCreatedDate if the profile pre-dates this field
    // (older profiles may not have it yet). Only writes when the slot
    // is empty.
    if (caseCreatedDate && !profile.caseCreatedDate) {
      await caseProfileRepository.updateCaseProfile(effectiveDomain, caseId, {
        caseCreatedDate,
      });
    }
    if (
      sourceCanonicalId &&
      !profile.attribution?.lockedManual &&
      !profile.sourceCanonicalId
    ) {
      const updated = await caseProfileRepository.setAttributionIfEmpty(
        effectiveDomain,
        caseId,
        {
          sourceCanonicalId,
          matchedBy: strategy || null,
          confidence: confidence || null,
        },
      );
      if (updated) {
        profile = updated;
        outcome.attributionWritten = true;
      }
    }
    if (paymentInfo) {
      const afterPayment = await caseProfileRepository.applyPaymentToCaseProfile(
        effectiveDomain,
        caseId,
        paymentInfo,
      );
      if (afterPayment) {
        profile = afterPayment;
        outcome.paymentApplied = true;
      }
    }
    if (callLogId) {
      const appended = await caseProfileRepository.appendContactActivity(
        effectiveDomain,
        caseId,
        callLogId,
      );
      if (appended) {
        profile = appended;
        outcome.contactActivityAppended = true;
      }
    }
  }

  outcome.caseProfileId = profile?._id ? String(profile._id) : null;

  // ── Back-link CallLog → CaseProfile ─────────────────────────────────
  if (callLogId && profile?._id && telephonySessionId) {
    try {
      await callLogRepository.linkCaseProfileId(
        effectiveDomain,
        telephonySessionId,
        profile._id,
      );
    } catch (error) {
      logger?.warn?.("caseprofile.calllog_backlink_failed", {
        caseId,
        telephonySessionId,
        error: error.message,
      });
    }
  }

  // ── Mark MasterProspect as converted instead of hard-deleting ──────
  //
  // Hard-delete races with concurrent intake writes — a `bulkUpsert`
  // mid-promotion could re-create a partial MP row moments after we
  // delete it. Instead we flip `convertedAt` + `needsStatusRefresh:
  // false`, which lets the intake pipeline distinguish "already
  // promoted" from "new lead" on its next write. A nightly cleanup
  // sweeps out MP rows with `convertedAt` older than a quiet window.
  if (profile?._id) {
    try {
      const updated = await masterProspectRepository.updateMasterProspect(
        effectiveDomain,
        caseId,
        {
          convertedAt: new Date(),
          needsStatusRefresh: false,
          caseProfileId: profile._id,
        },
      );
      if (updated) {
        outcome.prospectDeleted = true; // kept field name for call sites
        outcome.prospectMarkedConverted = true;
        logger?.info?.("masterprospect.marked_converted_after_promotion", {
          domain: effectiveDomain,
          caseId,
        });
      }
    } catch (error) {
      logger?.warn?.("masterprospect.mark_converted_failed", {
        caseId,
        error: error.message,
      });
    }
  }

  if (telephonySessionId) {
    try {
      const ledgerResult = await syncCallLedgerBySession(
        effectiveDomain,
        telephonySessionId,
      );
      outcome.callLedgerSynced = !ledgerResult?.skipped;
    } catch (error) {
      outcome.callLedgerError = error.message || "ledger_sync_failed";
      logger?.warn?.("caseprofile.call_ledger_sync_failed", {
        domain: effectiveDomain,
        caseId,
        telephonySessionId,
        error: outcome.callLedgerError,
      });
    }
  }

  // Keep case-level call/contact history hot for CX lookup paths as soon as
  // a live call resolves into a case, rather than waiting for hourly hygiene.
  try {
    const rollupResult = await syncCaseCallRollup(effectiveDomain, caseId, {
      recentLimit: 5,
    });
    outcome.callRollupSynced = !rollupResult?.skipped;
  } catch (error) {
    outcome.callRollupError = error.message || "rollup_failed";
    logger?.warn?.("caseprofile.call_rollup_sync_failed", {
      domain: effectiveDomain,
      caseId,
      error: outcome.callRollupError,
    });
  }

  return outcome;
}

// Backwards-compatible alias so the resolver's existing call site keeps
// working under the more general name. Attribution is the default
// trigger when called this way.
async function promoteOrUpdateFromResolution(args = {}) {
  return promoteOrUpdateCaseProfile({ ...args, trigger: "attribution" });
}

/**
 * Convenience wrapper for a future payment-ingest path. Same invariant:
 * caseId + (source OR payment); payment alone is sufficient to create.
 */
async function promoteOrUpdateFromPayment(args = {}) {
  return promoteOrUpdateCaseProfile({ ...args, trigger: "payment" });
}

module.exports = {
  promoteOrUpdateCaseProfile,
  promoteOrUpdateFromPayment,
  promoteOrUpdateFromResolution,
};
