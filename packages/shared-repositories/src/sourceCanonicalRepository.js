"use strict";

const { SourceCanonical } = require("../../shared-models/src");

async function findSourceCanonicalById(sourceCanonicalId) {
  return SourceCanonical.findById(sourceCanonicalId);
}

async function findSourceCanonicalByKey(canonicalKey) {
  return SourceCanonical.findOne({ canonicalKey });
}

async function findSourceCanonicalByTrackingNumber(phoneNumber) {
  // Normalize to 10-digit — canonicals store digits only, but callers
  // (CallRail, RC) often pass E.164 "+1XXXXXXXXXX" or mixed formats.
  const digits = String(phoneNumber || "").replace(/\D/g, "");
  if (!digits) return null;
  const tenDigit =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.slice(-10);
  if (tenDigit.length !== 10) return null;
  return SourceCanonical.findOne({
    $or: [
      { trackingNumbers: tenDigit },
      { trackingNumbers: String(phoneNumber || "").trim() },
    ],
  });
}

async function findSourceCanonicalByRingCentralExtension(extensionId) {
  return SourceCanonical.findOne({
    ringCentralExtensions: String(extensionId || "").trim(),
  });
}

/**
 * Return piece names (internalName + aliases) that belong to canonicals
 * explicitly assigned to a DIFFERENT domain. DailyCallStat is a
 * cross-company collection by design (single CallRail tenant), so to
 * domain-scope a read we exclude the pieces that are tagged as
 * belonging elsewhere. Pieces with no `domains` assignment stay visible
 * (cross-tenant default — the common case for mail pieces).
 */
async function listPiecesAssignedToOtherDomains(domain) {
  const dom = String(domain || "").toUpperCase();
  if (!dom) return [];
  const canonicals = await SourceCanonical.find({
    domains: { $exists: true, $ne: [] },
    $expr: { $not: { $in: [dom, "$domains"] } },
  })
    .select("internalName aliases")
    .lean();
  const names = new Set();
  for (const canonical of canonicals) {
    if (canonical.internalName) names.add(canonical.internalName);
    if (Array.isArray(canonical.aliases)) {
      for (const alias of canonical.aliases) names.add(alias);
    }
  }
  return [...names];
}

module.exports = {
  findSourceCanonicalById,
  findSourceCanonicalByKey,
  findSourceCanonicalByRingCentralExtension,
  findSourceCanonicalByTrackingNumber,
  listPiecesAssignedToOtherDomains,
};
