"use strict";

const mongoose = require("mongoose");
const {
  CaseProfile,
  LeadCadence,
  MasterProspectIndex,
  SourceCanonical,
} = require("../../shared-models/src");
const { legacyReadDb } = require("./legacyReadDb");
const paymentLedgerRepository = require("./paymentLedgerRepository");

// ── Legacy-collection read path ──────────────────────────────────────
//
// Legacy fallback for the pre-cutover `rb_caseprofiles` collection.
// Runtime reads now default to ControlPlaneCaseProfile after the raw
// legacy migration. Set CASE_PROFILE_LEGACY_READS_ENABLED=true only
// when doing an emergency comparison against the old app database.
//
// Field deltas vs. our parallel CaseProfile schema:
//   • rb uses single `phone` (formatted "(216)299-4926") — we use
//     `primaryPhone` + `normalizedPhones[]`. We rewrite both shapes
//     into the result so callers reading either field path still work.
//   • rb has `attributionChain[]` array; ours has `attribution{}`
//     object. Pass-through; consumers that need attribution should
//     read from the live tier going forward.
//
function legacyCaseProfileCollection() {
  return legacyReadDb(mongoose).collection("rb_caseprofiles");
}

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function legacyCaseProfileReadsEnabled() {
  return boolFromEnv(process.env.CASE_PROFILE_LEGACY_READS_ENABLED, false);
}

// Translate an rb_caseprofiles doc into the shape the rest of the code
// expects (primaryPhone + normalizedPhones[]). Keeps the original `phone`
// for callers that read it directly.
function normalizeLegacyCaseProfile(doc) {
  if (!doc) return null;
  const phone = doc.phone || doc.phoneFormatted || null;
  const digits = phone ? String(phone).replace(/\D/g, "") : "";
  const normalized = digits.length >= 10 ? digits.slice(-10) : null;
  return {
    ...doc,
    primaryPhone: doc.primaryPhone || phone || null,
    normalizedPhones: doc.normalizedPhones || (normalized ? [normalized] : []),
  };
}

const CASE_PROFILE_SOURCE_NAME_OVERRIDES = new Map([
  ["affordability federal snap", "Affordability Federal"],
  ["affordability federal snpa", "Affordability Federal"],
  ["affordability pink state snap", "Affordability Pink State"],
  ["citation state", "Citation State PC"],
  ["aged data", "CallFire"],
  ["callfire", "CallFire"],
]);

function normalizePreferredSourceName(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  return CASE_PROFILE_SOURCE_NAME_OVERRIDES.get(normalized) || text;
}

function mergeDefinedFields(base = {}, overlay = {}) {
  const next = { ...base };
  for (const [key, value] of Object.entries(overlay || {})) {
    if (value === null || value === undefined) continue;
    next[key] = value;
  }
  return next;
}

function normalizeCanonicalId(value) {
  if (value === null || value === undefined || value === "") return null;
  const id = String(value).trim();
  if (!id) return null;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new Error(`Invalid sourceCanonicalId: ${id}`);
  }
  return id;
}

function sameCanonicalId(left, right) {
  const leftId = left === null || left === undefined ? null : String(left);
  const rightId = right === null || right === undefined ? null : String(right);
  return leftId === rightId;
}

function normalizeCurrentCaseProfile(doc, sourceCanonical = null, legacyDoc = null) {
  const merged = mergeDefinedFields(legacyDoc || {}, doc || {});
  const primaryPhone = merged.primaryPhone || merged.phone || merged.phoneFormatted || null;
  const digits = primaryPhone ? String(primaryPhone).replace(/\D/g, "") : "";
  const normalized = digits.length >= 10 ? digits.slice(-10) : null;
  const normalizedPhones = Array.isArray(merged.normalizedPhones) && merged.normalizedPhones.length > 0
    ? merged.normalizedPhones
    : (normalized ? [normalized] : []);

  return {
    ...merged,
    phone: merged.phone || primaryPhone || null,
    primaryPhone,
    normalizedPhones,
    sourceName:
      normalizePreferredSourceName(doc?.sourceName) ||
      normalizePreferredSourceName(sourceCanonical?.internalName) ||
      normalizePreferredSourceName(legacyDoc?.sourceName) ||
      normalizePreferredSourceName(merged.sourceName) ||
      null,
    sourceChannel:
      sourceCanonical?.channel ||
      doc?.sourceChannel ||
      legacyDoc?.sourceChannel ||
      merged.sourceChannel ||
      null,
  };
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchQuery(search) {
  const value = String(search || "").trim();
  if (!value) return null;

  const regex = new RegExp(escapeRegex(value), "i");
  const digits = value.replace(/\D/g, "");
  const numericCaseId = Number(value);
  const orConditions = [
    { name: regex },
    { firstName: regex },
    { lastName: regex },
    { email: regex },
    // rb_caseprofiles stores phone as a single formatted field (not
    // primaryPhone / normalizedPhones[]), so search both shapes.
    { primaryPhone: regex },
    { phone: regex },
  ];

  if (digits) {
    orConditions.push({ normalizedPhones: digits });
    // rb stores phone formatted "(216)299-4926"; to match by digits
    // alone we need a regex that's loose about punctuation.
    orConditions.push({ phone: new RegExp(digits) });
  }

  if (Number.isFinite(numericCaseId) && value === String(numericCaseId)) {
    orConditions.push({ caseId: numericCaseId });
  }

  return { $or: orConditions };
}

function buildFirstPaymentDateMatch(filters = {}) {
  if (filters.date) {
    const date = new Date(`${String(filters.date)}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return null;
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + 1);
    return {
      $gte: date,
      $lt: next,
    };
  }

  const range = {};
  if (filters.from) {
    const from = new Date(`${String(filters.from)}T00:00:00.000Z`);
    if (!Number.isNaN(from.getTime())) {
      range.$gte = from;
    }
  }
  if (filters.to) {
    const to = new Date(`${String(filters.to)}T23:59:59.999Z`);
    if (!Number.isNaN(to.getTime())) {
      range.$lte = to;
    }
  }

  return Object.keys(range).length > 0 ? range : null;
}

async function findCaseProfile(domain, caseId) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const numericCaseId = Number(caseId);
  const [legacyDoc, currentDoc] = await Promise.all([
    legacyCaseProfileReadsEnabled()
      ? legacyCaseProfileCollection().findOne({
          domain: normalizedDomain,
          caseId: numericCaseId,
        })
      : Promise.resolve(null),
    CaseProfile.findOne({
      domain: normalizedDomain,
      caseId: numericCaseId,
    }).lean(),
  ]);

  const normalizedLegacy = normalizeLegacyCaseProfile(legacyDoc);
  if (!currentDoc) return normalizedLegacy;

  const canonical = currentDoc.sourceCanonicalId
    ? await SourceCanonical.findById(
        String(currentDoc.sourceCanonicalId),
        {
          _id: 1,
          internalName: 1,
          channel: 1,
        },
      ).lean()
    : null;

  return normalizeCurrentCaseProfile(currentDoc, canonical, normalizedLegacy);
}

/**
 * Look up a CaseProfile by any of its phone fields using the normalized
 * 10-digit representation. Used by the call attribution resolver to check
 * whether a case already has attribution before running any lookups.
 */
async function findCaseProfileByPhone(domain, phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  const tenDigit = digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
  if (tenDigit.length !== 10) return null;

  // When multiple profiles share a phone (re-imports, smoke-test
  // residue, dupes), prefer the freshest createdAt so CX scramble
  // lands on the most recent record.
  const normalizedDomain = String(domain || "").toUpperCase();
  const [legacyDoc, currentDoc] = await Promise.all([
    legacyCaseProfileReadsEnabled()
      ? legacyCaseProfileCollection()
          .find({
            domain: normalizedDomain,
            $or: [
              { normalizedPhones: tenDigit },
              { primaryPhone: new RegExp(tenDigit + "$") },
              { phone: new RegExp(tenDigit) },
            ],
          })
          .sort({ createdAt: -1, updatedAt: -1, _id: -1 })
          .limit(1)
          .next()
      : Promise.resolve(null),
    CaseProfile.find({
      domain: normalizedDomain,
      $or: [
        { normalizedPhones: tenDigit },
        { primaryPhone: new RegExp(tenDigit + "$") },
      ],
    })
      .sort({ createdAt: -1, updatedAt: -1, _id: -1 })
      .limit(1)
      .lean()
      .then((rows) => rows[0] || null),
  ]);

  const normalizedLegacy = normalizeLegacyCaseProfile(legacyDoc);
  if (!currentDoc) return normalizedLegacy;

  const canonical = currentDoc.sourceCanonicalId
    ? await SourceCanonical.findById(
        String(currentDoc.sourceCanonicalId),
        {
          _id: 1,
          internalName: 1,
          channel: 1,
        },
      ).lean()
    : null;

  return normalizeCurrentCaseProfile(currentDoc, canonical, normalizedLegacy);
}

async function normalizeCaseProfileSourceUpdate(update = {}) {
  const next = { ...(update || {}) };
  if (Object.prototype.hasOwnProperty.call(next, "sourceName")) {
    next.sourceName = normalizePreferredSourceName(next.sourceName);
  }

  const sourceCanonicalId = String(next.sourceCanonicalId || "").trim();
  if (!sourceCanonicalId) {
    return next;
  }

  const canonical = await SourceCanonical.findById(
    sourceCanonicalId,
    {
      _id: 1,
      internalName: 1,
      channel: 1,
    },
  ).lean();
  if (!canonical) {
    return next;
  }

  next.sourceName =
    normalizePreferredSourceName(next.sourceName) ||
    normalizePreferredSourceName(canonical.internalName) ||
    null;
  next.sourceChannel = canonical.channel || next.sourceChannel || null;
  return next;
}

async function writeSourceAttribution(domain, caseId, opts = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);
  if (!normalizedDomain || !Number.isFinite(normalizedCaseId)) {
    throw new Error("writeSourceAttribution requires domain and numeric caseId");
  }

  const normalizedCanonicalId = normalizeCanonicalId(opts.sourceCanonicalId);
  const canonical = normalizedCanonicalId
    ? await SourceCanonical.findById(
        normalizedCanonicalId,
        {
          _id: 1,
          canonicalKey: 1,
          internalName: 1,
          channel: 1,
        },
      ).lean()
    : null;
  if (normalizedCanonicalId && !canonical) {
    throw new Error(`SourceCanonical not found: ${normalizedCanonicalId}`);
  }

  const current = await CaseProfile.findOne(
    {
      domain: normalizedDomain,
      caseId: normalizedCaseId,
    },
    {
      _id: 1,
      sourceCanonicalId: 1,
      sourceName: 1,
      "attribution.lockedManual": 1,
    },
  ).lean();
  if (!current) {
    return {
      ok: false,
      reason: "case-profile-not-found",
      caseProfileId: null,
      source: null,
    };
  }

  const previousCanonicalId = current.sourceCanonicalId
    ? String(current.sourceCanonicalId)
    : null;
  const canonicalChanged = !sameCanonicalId(previousCanonicalId, normalizedCanonicalId);
  const shouldMirrorSourceName =
    !opts.preserveSourceName &&
    canonical &&
    (canonicalChanged || opts.forceMirrorSourceName);

  const filter = {
    domain: normalizedDomain,
    caseId: normalizedCaseId,
  };
  if (!opts.allowOverwriteLocked) {
    filter.$or = [
      { "attribution.lockedManual": { $ne: true } },
      { "attribution.lockedManual": { $exists: false } },
    ];
  }

  const update = {
    $set: {
      sourceCanonicalId: canonical ? canonical._id : null,
      sourceChannel: canonical?.channel || null,
      "attribution.matchedBy": opts.matchedBy || null,
      "attribution.confidence": opts.confidence || "high",
      "attribution.lastResolvedAt": opts.resolvedAt ? new Date(opts.resolvedAt) : new Date(),
    },
  };
  if (Object.prototype.hasOwnProperty.call(opts, "lockedManual")) {
    update.$set["attribution.lockedManual"] = Boolean(opts.lockedManual);
  }

  if (shouldMirrorSourceName) {
    update.$set.sourceName = normalizePreferredSourceName(canonical.internalName) || null;
  }

  const updated = await CaseProfile.findOneAndUpdate(filter, update, {
    new: true,
  }).lean();
  if (!updated) {
    return {
      ok: false,
      reason: "locked-manual-or-not-found",
      caseProfileId: String(current._id),
      changed: false,
      previousCanonicalId,
      source: canonical
        ? {
            canonicalId: String(canonical._id),
            canonicalKey: canonical.canonicalKey,
            internalName: canonical.internalName,
            channel: canonical.channel || null,
          }
        : null,
    };
  }

  let ledgerSync = null;
  if (
    canonicalChanged &&
    typeof paymentLedgerRepository.syncPaymentLedgerSourceForCase === "function"
  ) {
    ledgerSync = await paymentLedgerRepository.syncPaymentLedgerSourceForCase(
      normalizedDomain,
      normalizedCaseId,
      canonical,
      {
        matchedBy: opts.matchedBy || null,
        previousCanonicalId,
      },
    );
  }

  return {
    ok: true,
    reason: "updated",
    caseProfileId: String(updated._id),
    changed: canonicalChanged || Boolean(shouldMirrorSourceName),
    previousCanonicalId,
    ledgerSync,
    source: canonical
      ? {
          canonicalId: String(canonical._id),
          canonicalKey: canonical.canonicalKey,
          internalName: canonical.internalName,
          channel: canonical.channel || null,
        }
      : null,
  };
}

async function upsertCaseProfile(domain, caseId, update = {}) {
  const normalizedUpdate = await normalizeCaseProfileSourceUpdate(update);
  return CaseProfile.findOneAndUpdate(
    {
      domain: String(domain || "").toUpperCase(),
      caseId: Number(caseId),
    },
    { $set: normalizedUpdate },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

/**
 * Create-only variant of upsert — identity / seed fields go in
 * `$setOnInsert` so concurrent create attempts don't trample each
 * other's initial snapshot. Intended for the first-touch promotion
 * path; subsequent updates go through `setAttributionIfEmpty` or
 * `appendContactActivity`, which are race-safe on their own.
 *
 * `contactActivityIds` is handled as `$addToSet` $each on insert so
 * the loser of a concurrent create still contributes its activity
 * link (rather than getting overwritten).
 */
async function createCaseProfileIfMissing(domain, caseId, seed = {}) {
  const { contactActivityIds, ...rest } = seed;
  const normalizedSeed = await normalizeCaseProfileSourceUpdate(rest);
  const update = {
    $setOnInsert: {
      domain: String(domain || "").toUpperCase(),
      caseId: Number(caseId),
      ...normalizedSeed,
    },
  };
  if (Array.isArray(contactActivityIds) && contactActivityIds.length > 0) {
    update.$addToSet = {
      contactActivityIds: { $each: contactActivityIds },
    };
  }
  return CaseProfile.findOneAndUpdate(
    {
      domain: String(domain || "").toUpperCase(),
      caseId: Number(caseId),
    },
    update,
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

/**
 * Append a CallLog (or other activity) ObjectId to `contactActivityIds`.
 * Uses `$addToSet` so repeat calls don't duplicate the link.
 */
async function appendContactActivity(domain, caseId, activityId) {
  if (!activityId) return null;
  return CaseProfile.findOneAndUpdate(
    {
      domain: String(domain || "").toUpperCase(),
      caseId: Number(caseId),
    },
    { $addToSet: { contactActivityIds: activityId } },
    { new: true },
  );
}

/**
 * Apply a payment to an existing CaseProfile. Idempotent by paymentId
 * (uses `$addToSet`) so replaying the same payment doesn't double-count.
 * `$inc` on counters, `$set` on latest-payment fields when the new
 * paidAt is later than the stored lastPaymentDate. Use for the
 * payment-ingest trigger on the promotion service's update path.
 */
async function applyPaymentToCaseProfile(domain, caseId, payment = {}) {
  const amount = Number(payment.amount) || 0;
  const paidAt = payment.paidAt ? new Date(payment.paidAt) : null;
  const paymentId = payment.paymentId || null;
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);

  // First write: counters + addToSet. `$inc` safe to re-run because it's
  // only applied when paymentId hasn't been seen (guard below).
  const filter = {
    domain: normalizedDomain,
    caseId: normalizedCaseId,
  };
  if (paymentId) {
    filter.paymentIds = { $ne: paymentId };
  }
  const updateOnNewPayment = {
    $inc: { totalPaid: amount, paymentsCount: 1 },
  };
  if (paymentId) {
    updateOnNewPayment.$addToSet = { paymentIds: paymentId };
  }

  const afterInc = await CaseProfile.findOneAndUpdate(
    filter,
    updateOnNewPayment,
    { new: true },
  );
  if (!afterInc) return null; // either profile missing or paymentId already applied

  // Second + third writes: out-of-order-aware first/last payment date.
  //
  // Historical bug: this used to set `firstPaymentDate` only when the
  // doc had it null. If a CaseProfile got created late (e.g. via a
  // rescue script) and the first ledger row processed was a recent
  // monthly payment, firstPaymentDate landed on that date — and never
  // got walked back when older payments arrived afterward. Cases sold
  // months ago looked like fresh "this month" deals in metrics.
  //
  // Fix: walk firstPaymentDate back when paidAt is older. Advance
  // lastPaymentDate when paidAt is newer. Each guarded by a
  // conditional filter so concurrent payment writes for the same case
  // can't lose-update each other.
  if (paidAt) {
    // Walk firstPaymentDate / initialPayment back when this payment is
    // older than (or filling) what's there. Conditional filter makes
    // the write a no-op if a concurrent process already set an even
    // older date.
    await CaseProfile.updateOne(
      {
        domain: normalizedDomain,
        caseId: normalizedCaseId,
        $or: [
          { firstPaymentDate: null },
          { firstPaymentDate: { $exists: false } },
          { firstPaymentDate: { $gt: paidAt } },
        ],
      },
      {
        $set: {
          firstPaymentDate: paidAt,
          initialPayment: amount,
        },
      },
    );

    // Advance lastPaymentDate / lastPaymentAmount when this payment is
    // newer than what's there. Same race-safe conditional pattern.
    await CaseProfile.updateOne(
      {
        domain: normalizedDomain,
        caseId: normalizedCaseId,
        $or: [
          { lastPaymentDate: null },
          { lastPaymentDate: { $exists: false } },
          { lastPaymentDate: { $lt: paidAt } },
        ],
      },
      {
        $set: {
          lastPaymentDate: paidAt,
          lastPaymentAmount: amount,
        },
      },
    );
  }
  return afterInc;
}

/**
 * Reverse a previously-applied payment on CaseProfile. Called when
 * the PaymentLedger flips a row from SUCCESS → FAILED (chargeback /
 * refund). Guards on `paymentIds` containing the id — if the payment
 * was never applied (e.g., we're reversing something that only ever
 * came in as FAILED), this is a no-op.
 *
 * Idempotency: the `$pull` + `paymentIds: { $in: [paymentId] }` filter
 * ensures a re-reversal of the same paymentId doesn't double-decrement.
 * Safe to call multiple times.
 */
async function reversePaymentOnCaseProfile(domain, caseId, payment = {}) {
  const amount = Number(payment.amount) || 0;
  const paymentId = payment.paymentId || null;
  if (!paymentId) return null;

  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);

  const reversed = await CaseProfile.findOneAndUpdate(
    {
      domain: normalizedDomain,
      caseId: normalizedCaseId,
      paymentIds: paymentId, // only decrement if we actually applied it
    },
    {
      $inc: { totalPaid: -amount, paymentsCount: -1 },
      $pull: { paymentIds: paymentId },
    },
    { new: true },
  );

  if (!reversed) return null;

  // Clamp counters if bookkeeping drifted (defensive — shouldn't happen,
  // but $inc by negative can go below zero if the same id was applied
  // twice before the $addToSet guard landed).
  const patch = {};
  if ((reversed.totalPaid ?? 0) < 0) patch.totalPaid = 0;
  if ((reversed.paymentsCount ?? 0) < 0) patch.paymentsCount = 0;
  if (Object.keys(patch).length > 0) {
    await CaseProfile.updateOne(
      { domain: normalizedDomain, caseId: normalizedCaseId },
      { $set: patch },
    );
  }

  return reversed;
}

/**
 * Atomically write initial attribution fields ONLY when the slot is
 * still empty (first-touch wins). A case with `lockedManual: true` or an
 * already-set `sourceCanonicalId` is left untouched. Returns the updated
 * doc, or null if the write was a no-op (slot already claimed).
 */
async function setAttributionIfEmpty(domain, caseId, attribution = {}) {
  return CaseProfile.findOneAndUpdate(
    {
      domain: String(domain || "").toUpperCase(),
      caseId: Number(caseId),
      sourceCanonicalId: null,
      "attribution.lockedManual": { $ne: true },
    },
    {
      $set: {
        sourceCanonicalId: attribution.sourceCanonicalId || null,
        "attribution.matchedBy": attribution.matchedBy || null,
        "attribution.confidence": attribution.confidence || null,
        "attribution.lastResolvedAt": new Date(),
        "attribution.needsReview": Boolean(attribution.needsReview),
      },
    },
    { new: true },
  );
}

async function updateCaseProfile(domain, caseId, update = {}) {
  const normalizedUpdate = await normalizeCaseProfileSourceUpdate(update);
  return CaseProfile.findOneAndUpdate(
    {
      domain: String(domain || "").toUpperCase(),
      caseId: Number(caseId),
    },
    { $set: normalizedUpdate },
    { new: true },
  );
}

function normalizeCommunicationDirection(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "inbound" || normalized === "scheduled") return normalized;
  return "outbound";
}

function buildCommunicationEntry(channel, entry = {}) {
  const normalizedChannel = String(channel || "").toLowerCase();
  const metadata =
    entry.metadata && typeof entry.metadata === "object" ? entry.metadata : null;
  const happenedAt = entry.happenedAt || entry.sentAt || new Date();
  const providerMessageId =
    entry.providerMessageId ||
    metadata?.providerMessageId ||
    null;
  const providerError =
    entry.providerError ||
    metadata?.providerError ||
    metadata?.error ||
    null;

  return {
    channel: normalizedChannel,
    direction: normalizeCommunicationDirection(entry.direction),
    status: entry.status || null,
    provider: entry.provider || null,
    providerMessageId,
    providerError,
    threadKey: entry.threadKey || providerMessageId || null,
    phone: entry.phone || null,
    email: entry.email || null,
    subject: entry.subject || null,
    body: entry.body || null,
    templateKey: entry.templateKey || null,
    workflowId: entry.workflowId ? String(entry.workflowId) : null,
    conversationMessageId: entry.conversationMessageId
      ? String(entry.conversationMessageId)
      : null,
    actorEmail: entry.actorEmail || null,
    actorName: entry.actorName || null,
    happenedAt,
    sentAt: entry.sentAt || happenedAt,
    source: entry.source || "case-profile",
    metadata,
  };
}

async function appendCommunicationThread(domain, caseId, channel, entry = {}) {
  const normalizedChannel = String(channel || "").toLowerCase();
  if (!["sms", "email"].includes(normalizedChannel)) {
    const error = new Error("channel must be sms or email");
    error.status = 400;
    throw error;
  }

  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);
  const communicationEntry = buildCommunicationEntry(normalizedChannel, entry);

  return CaseProfile.findOneAndUpdate(
    {
      domain: normalizedDomain,
      caseId: normalizedCaseId,
    },
    {
      $setOnInsert: {
        domain: normalizedDomain,
        caseId: normalizedCaseId,
      },
      $push: {
        [`communicationThreads.${normalizedChannel}`]: entry,
        communications: communicationEntry,
      },
      $set: {
        "communicationThreads.lastTouchedAt": communicationEntry.happenedAt,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function appendCommunicationEntry(domain, caseId, channel, entry = {}) {
  const normalizedChannel = String(channel || "").toLowerCase();
  if (!["sms", "email", "call", "rvm"].includes(normalizedChannel)) {
    const error = new Error("channel must be sms, email, call, or rvm");
    error.status = 400;
    throw error;
  }

  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);
  const communicationEntry = buildCommunicationEntry(normalizedChannel, entry);

  return CaseProfile.findOneAndUpdate(
    {
      domain: normalizedDomain,
      caseId: normalizedCaseId,
    },
    {
      $setOnInsert: {
        domain: normalizedDomain,
        caseId: normalizedCaseId,
      },
      $push: {
        communications: communicationEntry,
      },
      $set: {
        "communicationThreads.lastTouchedAt": communicationEntry.happenedAt,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function findCaseProfilesDueForAiCaseReview(domain, olderThanDays = 7, limit = 100) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const cutoff = new Date(Date.now() - Number(olderThanDays || 7) * 86400000);
  return CaseProfile.find({
    domain: normalizedDomain,
    $or: [
      { "aiCaseReview.reviewedAt": { $exists: false } },
      { "aiCaseReview.reviewedAt": null },
      { "aiCaseReview.reviewedAt": { $lt: cutoff } },
    ],
  })
    .sort({ "aiCaseReview.reviewedAt": 1, updatedAt: -1 })
    .limit(Math.min(Number(limit) || 100, 500))
    .lean();
}

/**
 * Return CaseProfiles that need a payment-reconcile poll. Round-robin
 * semantics: oldest-checked first, with never-checked rows surfacing
 * first. Caller caps `limit` to keep API usage predictable (Logics
 * `getCasePayments` is per-case, not bulk, so each row here costs one
 * Logics call).
 *
 * Only considers rows with a real `caseId` — CaseProfiles without one
 * can't be reconciled against Logics anyway.
 */
async function findCaseProfilesDueForPaymentReconcile(domain, staleAfterMs, limit = 50) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const cutoff = new Date(Date.now() - Number(staleAfterMs || 60 * 60 * 1000));
  return CaseProfile.find({
    domain: normalizedDomain,
    caseId: { $ne: null },
    $or: [
      { "paymentReconcile.lastCheckedAt": null },
      { "paymentReconcile.lastCheckedAt": { $exists: false } },
      { "paymentReconcile.lastCheckedAt": { $lt: cutoff } },
    ],
  })
    .sort({
      "paymentReconcile.lastCheckedAt": 1,
      lastPaymentDate: -1,
      updatedAt: -1,
      createdAt: -1,
    })
    .limit(Math.min(Number(limit) || 50, 10000))
    .lean();
}

async function countCaseProfilesByDomain(domain) {
  return CaseProfile.countDocuments({
    domain: String(domain || "").toUpperCase(),
  });
}

async function countCaseProfilesWithPayments(domain) {
  return CaseProfile.countDocuments({
    domain: String(domain || "").toUpperCase(),
    paymentsCount: { $gt: 0 },
  });
}

async function listCaseProfiles(domain, filters = {}) {
  const query = {
    domain: String(domain || "").toUpperCase(),
  };

  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.statusCategory) query.statusCategory = filters.statusCategory;
  if (filters.hasPayments === true) query.paymentsCount = { $gt: 0 };
  if (filters.hasPayments === false) query.paymentsCount = { $lte: 0 };
  if (filters.aiStatus) query["aiActivityReview.status"] = filters.aiStatus;
  if (filters.search) Object.assign(query, buildSearchQuery(filters.search));

  const limit = Math.min(Number(filters.limit) || 50, 200);
  if (legacyCaseProfileReadsEnabled()) {
    const [legacyDocs, currentDocs] = await Promise.all([
      legacyCaseProfileCollection()
        .find(query)
        .sort({ updatedAt: -1, caseId: -1 })
        .limit(limit)
        .toArray(),
      CaseProfile.find(query)
        .sort({ updatedAt: -1, caseId: -1 })
        .limit(limit)
        .lean(),
    ]);
    const byCaseId = new Map();
    for (const doc of legacyDocs) {
      const normalized = normalizeLegacyCaseProfile(doc);
      if (normalized?.caseId != null) byCaseId.set(Number(normalized.caseId), normalized);
    }
    for (const doc of currentDocs) {
      byCaseId.set(Number(doc.caseId), normalizeCurrentCaseProfile(doc, null, byCaseId.get(Number(doc.caseId)) || null));
    }
    return Array.from(byCaseId.values())
      .sort((left, right) => {
        const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
        const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
        return rightTime - leftTime;
      })
      .slice(0, limit);
  }

  const docs = await CaseProfile.find(query)
    .sort({ updatedAt: -1, caseId: -1 })
    .limit(limit)
    .lean();
  return docs.map((doc) => normalizeCurrentCaseProfile(doc, null, null));
}

async function listCaseProfilesByCaseIds(domain, caseIds = [], options = {}) {
  const normalizedIds = caseIds.map((value) => Number(value)).filter(Number.isFinite);
  if (normalizedIds.length === 0) return [];

  const normalizedDomain = String(domain || "").toUpperCase();
  const [legacyDocs, currentDocs] = await Promise.all([
    legacyCaseProfileReadsEnabled() && options.currentOnly !== true
      ? legacyCaseProfileCollection()
          .find({
            domain: normalizedDomain,
            caseId: { $in: normalizedIds },
          })
          .toArray()
      : Promise.resolve([]),
    CaseProfile.find({
      domain: normalizedDomain,
      caseId: { $in: normalizedIds },
    }).lean(),
  ]);

  const canonicalIds = [...new Set(
    currentDocs
      .map((doc) => String(doc?.sourceCanonicalId || "").trim())
      .filter(Boolean),
  )];
  const sourceCanonicals = canonicalIds.length > 0
    ? await SourceCanonical.find(
        { _id: { $in: canonicalIds } },
        {
          _id: 1,
          internalName: 1,
          channel: 1,
        },
      ).lean()
    : [];
  const sourceCanonicalById = new Map(
    sourceCanonicals.map((doc) => [String(doc._id), doc]),
  );

  const byCaseId = new Map();
  for (const doc of legacyDocs) {
    const normalizedDoc = normalizeLegacyCaseProfile(doc);
    const caseId = Number(normalizedDoc?.caseId);
    if (!Number.isFinite(caseId)) continue;
    byCaseId.set(caseId, normalizedDoc);
  }

  for (const doc of currentDocs) {
    const caseId = Number(doc?.caseId);
    if (!Number.isFinite(caseId)) continue;
    const legacyDoc = options.currentOnly === true ? null : (byCaseId.get(caseId) || null);
    const canonical = sourceCanonicalById.get(String(doc.sourceCanonicalId || "")) || null;
    byCaseId.set(
      caseId,
      normalizeCurrentCaseProfile(doc, canonical, legacyDoc),
    );
  }

  return normalizedIds
    .map((caseId) => byCaseId.get(Number(caseId)) || null)
    .filter(Boolean);
}

async function listCaseProfilesByPhones(domain, phones = [], options = {}) {
  const normalizedPhones = [...new Set((Array.isArray(phones) ? phones : [])
    .map((value) => {
      const digits = String(value || "").replace(/\D+/g, "");
      if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
      return digits.length === 10 ? digits : null;
    })
    .filter(Boolean))];
  if (!normalizedPhones.length) return [];
  const normalizedDomain = String(domain || "").toUpperCase();
  const phonePatterns = normalizedPhones.map((phone) => new RegExp(`${phone}$`));
  const [legacyDocs, currentDocs] = await Promise.all([
    legacyCaseProfileReadsEnabled() && options.currentOnly !== true
      ? legacyCaseProfileCollection().find({
          domain: normalizedDomain,
          $or: [
            { normalizedPhones: { $in: normalizedPhones } },
            ...phonePatterns.map((pattern) => ({ primaryPhone: pattern })),
            ...phonePatterns.map((pattern) => ({ phone: pattern })),
          ],
        }).sort({ updatedAt: -1, createdAt: -1 }).toArray()
      : Promise.resolve([]),
    CaseProfile.find({
      domain: normalizedDomain,
      $or: [
        { normalizedPhones: { $in: normalizedPhones } },
        ...phonePatterns.map((pattern) => ({ primaryPhone: pattern })),
      ],
    }).sort({ updatedAt: -1, createdAt: -1 }).lean(),
  ]);
  const legacyByCase = new Map(legacyDocs.map((doc) => [Number(doc.caseId), normalizeLegacyCaseProfile(doc)]));
  const currentCaseIds = new Set(currentDocs.map((doc) => Number(doc.caseId)).filter(Number.isFinite));
  return [
    ...currentDocs.map((doc) => normalizeCurrentCaseProfile(doc, null, legacyByCase.get(Number(doc.caseId)) || null)),
    ...legacyDocs
      .filter((doc) => !currentCaseIds.has(Number(doc.caseId)))
      .map(normalizeLegacyCaseProfile),
  ];
}

function buildDealStatusExpression(fieldPath = "$statusCategory") {
  return {
    $or: [
      { $eq: [fieldPath, "client"] },
      {
        $regexMatch: {
          input: { $ifNull: [fieldPath, ""] },
          regex: /^tier/i,
        },
      },
    ],
  };
}

async function summarizeCaseProfilesBySource(domain) {
  const normalizedDomain = String(domain || "").toUpperCase();

  return CaseProfile.aggregate([
    {
      $match: {
        domain: normalizedDomain,
      },
    },
    {
      $lookup: {
        from: SourceCanonical.collection.name,
        localField: "sourceCanonicalId",
        foreignField: "_id",
        as: "sourceCanonical",
      },
    },
    {
      $lookup: {
        from: MasterProspectIndex.collection.name,
        let: {
          caseId: "$caseId",
          domain: "$domain",
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$caseId", "$$caseId"] },
                  { $eq: ["$domain", "$$domain"] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "masterProspect",
      },
    },
    {
      $unwind: {
        path: "$masterProspect",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: SourceCanonical.collection.name,
        localField: "masterProspect.sourceCanonicalId",
        foreignField: "_id",
        as: "prospectSourceCanonical",
      },
    },
    {
      $unwind: {
        path: "$prospectSourceCanonical",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: LeadCadence.collection.name,
        let: {
          caseId: "$caseId",
          domain: "$domain",
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$caseId", "$$caseId"] },
                  { $eq: ["$domain", "$$domain"] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "leadCadence",
      },
    },
    {
      $unwind: {
        path: "$leadCadence",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $unwind: {
        path: "$sourceCanonical",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $addFields: {
        metricSourceName: {
          $ifNull: [
            "$sourceCanonical.internalName",
            {
              $ifNull: [
                "$prospectSourceCanonical.internalName",
                {
                  $ifNull: [
                    "$leadCadence.sourceName",
                    {
                      $ifNull: [
                        "$leadCadence.intakeSource",
                        {
                          $ifNull: ["$masterProspect.metadata.intakeSource", "Unknown"],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        metricSourceChannel: {
          $ifNull: [
            "$sourceCanonical.channel",
            {
              $ifNull: [
                "$prospectSourceCanonical.channel",
                {
                  $ifNull: ["$leadCadence.sourceChannel", null],
                },
              ],
            },
          ],
        },
      },
    },
    {
      $group: {
        _id: {
          source: "$metricSourceName",
          channel: "$metricSourceChannel",
        },
        count: { $sum: 1 },
        prospects: {
          $sum: {
            $cond: [{ $eq: ["$statusCategory", "prospect"] }, 1, 0],
          },
        },
        lifetimeDeals: {
          $sum: {
            $cond: [buildDealStatusExpression(), 1, 0],
          },
        },
        lifetimePaid: {
          $sum: {
            $cond: [buildDealStatusExpression(), { $ifNull: ["$totalPaid", 0] }, 0],
          },
        },
        lifetimeInitials: {
          $sum: {
            $cond: [buildDealStatusExpression(), { $ifNull: ["$initialPayment", 0] }, 0],
          },
        },
        dnc: {
          $sum: {
            $cond: [{ $eq: ["$statusCategory", "dnc"] }, 1, 0],
          },
        },
        attributionNeedsReview: {
          $sum: {
            $cond: [{ $eq: ["$attribution.needsReview", true] }, 1, 0],
          },
        },
      },
    },
    {
      $sort: {
        count: -1,
        lifetimePaid: -1,
        "_id.source": 1,
      },
    },
  ]);
}

async function summarizeInitialPaymentsBySource(domain, filters = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const legacyMatch = {
    domain: normalizedDomain,
    initialPayment: { $gt: 0 },
  };
  const currentMatch = {
    domain: normalizedDomain,
    initialPayment: { $gt: 0 },
  };

  const firstPaymentDateMatch = buildFirstPaymentDateMatch(filters);
  if (firstPaymentDateMatch) {
    legacyMatch.firstPaymentDate = firstPaymentDateMatch;
    currentMatch.firstPaymentDate = firstPaymentDateMatch;
  }

  const [legacyDocs, currentDocs] = await Promise.all([
    legacyCaseProfileReadsEnabled()
      ? legacyCaseProfileCollection()
          .find(
            legacyMatch,
            {
              projection: {
                caseId: 1,
                sourceName: 1,
                sourceChannel: 1,
                initialPayment: 1,
              },
            },
          )
          .toArray()
      : Promise.resolve([]),
    CaseProfile.find(
      currentMatch,
      {
        caseId: 1,
        sourceName: 1,
        sourceChannel: 1,
        sourceCanonicalId: 1,
        initialPayment: 1,
      },
    ).lean(),
  ]);

  const canonicalIds = [...new Set(
    currentDocs
      .map((doc) => String(doc?.sourceCanonicalId || "").trim())
      .filter(Boolean),
  )];

  const sourceCanonicals = canonicalIds.length > 0
    ? await SourceCanonical.find(
        { _id: { $in: canonicalIds } },
        {
          _id: 1,
          internalName: 1,
          channel: 1,
        },
      ).lean()
    : [];
  const sourceCanonicalById = new Map(
    sourceCanonicals.map((doc) => [String(doc._id), doc]),
  );

  const byCaseId = new Map();

  for (const doc of legacyDocs) {
    const caseId = Number(doc.caseId);
    if (!Number.isFinite(caseId)) continue;
    byCaseId.set(caseId, {
      caseId,
      source: String(doc.sourceName || "Unknown"),
      channel: doc.sourceChannel || null,
      initialPayment: Number(doc.initialPayment || 0),
    });
  }

  for (const doc of currentDocs) {
    const caseId = Number(doc.caseId);
    if (!Number.isFinite(caseId)) continue;
    const canonical = sourceCanonicalById.get(String(doc.sourceCanonicalId || "")) || null;
    // Source-of-truth priority for the bucket key: prefer the canonical
    // when set, fall back to the free-text `sourceName` when no canonical
    // attribution exists. Matches `paymentRoiService.resolveRoiPaymentSourceMeta`.
    //
    // The previous order (sourceName → canonical) put cases that had been
    // re-attributed via rescue scripts (which update sourceCanonicalId
    // but not sourceName) under their stale intake-time sourceName,
    // causing a double-count vs. the payment-driven aggregation that
    // already uses the canonical. Symptom: an ABC row that has
    // `Initials > 0` but `Paid = 0` because the same payments are
    // bucketed under the canonical name on the Paid side.
    byCaseId.set(caseId, {
      caseId,
      source: String(canonical?.internalName || doc.sourceName || "Unknown"),
      channel: canonical?.channel || doc.sourceChannel || null,
      initialPayment: Number(doc.initialPayment || 0),
    });
  }

  const grouped = new Map();
  for (const doc of byCaseId.values()) {
    const key = JSON.stringify({
      source: doc.source || "Unknown",
      channel: doc.channel || null,
    });
    if (!grouped.has(key)) {
      grouped.set(key, {
        _id: {
          source: doc.source || "Unknown",
          channel: doc.channel || null,
        },
        initialPaymentCount: 0,
        initialPayments: 0,
      });
    }
    const entry = grouped.get(key);
    entry.initialPaymentCount += 1;
    entry.initialPayments += Number(doc.initialPayment || 0);
  }

  return [...grouped.values()].sort(
    (left, right) =>
      Number(right.initialPayments || 0) - Number(left.initialPayments || 0) ||
      Number(right.initialPaymentCount || 0) - Number(left.initialPaymentCount || 0) ||
      String(left._id?.source || "").localeCompare(String(right._id?.source || "")),
  );
}

module.exports = {
  appendContactActivity,
  appendCommunicationEntry,
  applyPaymentToCaseProfile,
  reversePaymentOnCaseProfile,
  countCaseProfilesByDomain,
  countCaseProfilesWithPayments,
  createCaseProfileIfMissing,
  findCaseProfile,
  findCaseProfileByPhone,
  findCaseProfilesDueForAiCaseReview,
  findCaseProfilesDueForPaymentReconcile,
  listCaseProfiles,
  listCaseProfilesByCaseIds,
  listCaseProfilesByPhones,
  summarizeCaseProfilesBySource,
  summarizeInitialPaymentsBySource,
  setAttributionIfEmpty,
  appendCommunicationThread,
  updateCaseProfile,
  upsertCaseProfile,
  writeSourceAttribution,
};
