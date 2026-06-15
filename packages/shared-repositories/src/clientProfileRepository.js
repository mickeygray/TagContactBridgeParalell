"use strict";

// clientProfileRepository — the resolution case bank.
//
// clientProfiles are the per-CLIENT elevation above caseProfiles: seeded from
// the case-master workbook, then maintained by the Logics per-case poller,
// the caseProfiles→clientProfiles elevation mechanic, and document scrapes.

const { ClientProfile } = require("../../shared-models/src");

const DEFAULT_DOMAIN = "TAG";
const NON_STORED_PROFILE_FIELDS = new Set(["clientName", "clientKey"]);

function cleanCaseNumber(value) {
  return String(value || "").trim();
}

function normalizeDomain(value) {
  return String(value || DEFAULT_DOMAIN).trim().toUpperCase() || DEFAULT_DOMAIN;
}

function buildClientProfileKey(domain, caseNumber) {
  const key = cleanCaseNumber(caseNumber);
  return key ? `${normalizeDomain(domain)}:${key}` : "";
}

function normalizeClientProfileIdentity(input, maybeDomain = DEFAULT_DOMAIN) {
  if (input && typeof input === "object") {
    const caseNumber = cleanCaseNumber(input.caseNumber);
    const domain = normalizeDomain(input.domain || maybeDomain);
    const profileKey = String(input.profileKey || buildClientProfileKey(domain, caseNumber)).trim();
    return { caseNumber, domain, profileKey };
  }
  const caseNumber = cleanCaseNumber(input);
  const domain = normalizeDomain(maybeDomain);
  return { caseNumber, domain, profileKey: buildClientProfileKey(domain, caseNumber) };
}

function profileIdentityFilter(identity) {
  return { profileKey: identity.profileKey };
}

function stripNonStoredProfileFields(fields = {}) {
  const out = { ...fields };
  for (const key of NON_STORED_PROFILE_FIELDS) delete out[key];
  return out;
}

async function claimLegacyProfileKey(identity) {
  if (!identity.caseNumber || !identity.profileKey) return;
  await ClientProfile.updateOne(
    {
      caseNumber: identity.caseNumber,
      $and: [
        { $or: [{ profileKey: { $exists: false } }, { profileKey: null }, { profileKey: "" }] },
        { $or: [{ domain: identity.domain }, { domain: { $exists: false } }, { domain: null }, { domain: "" }] },
      ],
    },
    {
      $set: {
        profileKey: identity.profileKey,
        domain: identity.domain,
      },
    },
  ).catch(() => null);
}

async function upsertClientProfile(input = {}) {
  const identity = normalizeClientProfileIdentity(input);
  if (!identity.caseNumber) {
    const err = new Error("caseNumber is required");
    err.status = 400;
    throw err;
  }
  await claimLegacyProfileKey(identity);
  const {
    caseNumber: _caseNumber,
    domain: _domain,
    profileKey: _profileKey,
    ...fields
  } = input;
  const safeFields = stripNonStoredProfileFields(fields);
  // lifecycle is flattened to dot-paths: a whole-object $set wiped every
  // lifecycle key the caller DIDN'T pass (bit addCaseToBank live —
  // seededFrom stamping erased lastLogicsRefreshAt). Dot-paths merge.
  const set = {
    ...safeFields,
    caseNumber: identity.caseNumber,
    domain: identity.domain,
    profileKey: identity.profileKey,
    "lifecycle.lastRefreshedAt": new Date(),
  };
  if (set.lifecycle && typeof set.lifecycle === "object") {
    for (const [key, value] of Object.entries(set.lifecycle)) {
      set[`lifecycle.${key}`] = value;
    }
    delete set.lifecycle;
  }
  return ClientProfile.findOneAndUpdate(
    profileIdentityFilter(identity),
    { $set: set },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
}

// Atomic shorthand merge: one dot-path $set per field, so concurrent
// writers (document upload vs Logics refresh vs future pollers) never
// clobber each other's keys the way a whole-object replace does. Keys are
// sanitized — "." or "$" in a field name would change the Mongo path.
async function mergeShorthandFields(caseNumber, fields = {}, { domain = DEFAULT_DOMAIN, extraSet = null, upsert = false } = {}) {
  const identity = normalizeClientProfileIdentity(caseNumber, domain);
  if (!identity.caseNumber) return null;
  await claimLegacyProfileKey(identity);
  const set = {
    caseNumber: identity.caseNumber,
    domain: identity.domain,
    profileKey: identity.profileKey,
    "lifecycle.lastRefreshedAt": new Date(),
  };
  let hasShorthandPaths = false;
  for (const [field, entry] of Object.entries(fields || {})) {
    const safe = String(field).replace(/[.$]/g, "_").slice(0, 80);
    if (safe) {
      set[`shorthand.${safe}`] = entry;
      hasShorthandPaths = true;
    }
  }
  if (extraSet && typeof extraSet === "object") Object.assign(set, stripNonStoredProfileFields(extraSet));
  if (hasShorthandPaths) {
    // The schema default is shorthand: null, and Mongo cannot create a
    // dot-path INSIDE an explicit null ("Cannot create field ... in
    // element {shorthand: null}" — bit the first sweep against the seeded
    // bank). Normalize null → {} first; idempotent, race-tolerant.
    if (upsert) {
      await ClientProfile.findOneAndUpdate(
        profileIdentityFilter(identity),
        {
          $setOnInsert: {
            caseNumber: identity.caseNumber,
            domain: identity.domain,
            profileKey: identity.profileKey,
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      );
    }
    await ClientProfile.updateOne(
      { ...profileIdentityFilter(identity), shorthand: null }, // matches null AND missing
      { $set: { shorthand: {} } },
    );
  }
  return ClientProfile.findOneAndUpdate(
    profileIdentityFilter(identity),
    { $set: set },
    { new: true, upsert, setDefaultsOnInsert: true },
  ).lean();
}

// Document-hash memory, atomically: drop any prior entry for this hash
// (force re-parse replaces), append the new one, keep the last 100.
async function recordDocumentHash(caseNumber, { domain = DEFAULT_DOMAIN, hash, docType, parsedAt, label } = {}) {
  const identity = normalizeClientProfileIdentity(caseNumber, domain);
  if (!identity.caseNumber || !hash) return null;
  await claimLegacyProfileKey(identity);
  await ClientProfile.updateOne(profileIdentityFilter(identity), { $pull: { documentHashes: { hash } } });
  return ClientProfile.findOneAndUpdate(
    profileIdentityFilter(identity),
    { $push: { documentHashes: { $each: [{ hash, docType, parsedAt, label }], $slice: -100 } } },
    { new: true },
  ).select("profileKey caseNumber domain").lean();
}

async function getClientProfileByCaseNumber(caseNumber, domain = DEFAULT_DOMAIN) {
  const identity = normalizeClientProfileIdentity(caseNumber, domain);
  if (!identity.caseNumber) return null;
  await claimLegacyProfileKey(identity);
  return ClientProfile.findOne(profileIdentityFilter(identity)).lean();
}

// Bank listing: best-prospect-first by default; filterable by tier,
// temperature, and lifecycle status. Projection trims the heavy fields
// (shorthand/opportunities ride the dossier view, not the table).
async function listClientProfiles({
  domain = null,
  tier = null,
  temperature = null,
  status = "active",
  minScore = null,
  q = null,
  limit = 100,
  skip = 0,
} = {}) {
  const query = {};
  if (domain) query.domain = normalizeDomain(domain);
  if (status) query["lifecycle.status"] = status;
  // Tiers are stored verbatim from the pursuit model ("A-STRONG", "B-GOOD"...)
  // — accept a bare letter and prefix-match it.
  if (tier) {
    const t = String(tier).toUpperCase().replace(/[^A-Z-]/g, "");
    if (t) query["pursuit.tier"] = { $regex: `^${t}` };
  }
  if (temperature) query["temperature.label"] = String(temperature).toLowerCase();
  if (Number.isFinite(Number(minScore)) && minScore !== null) {
    query["pursuit.score"] = { $gte: Number(minScore) };
  }
  // Search across the WHOLE bank (the UI only loads a page; client-side
  // filtering can't see the other 1,900 rows). Case/domain only; private
  // contact identity stays in Logics until an explicit contact lookup.
  const needle = String(q || "").trim();
  if (needle) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { caseNumber: { $regex: `^${escaped}` } },
      { profileKey: { $regex: escaped, $options: "i" } },
      { domain: { $regex: `^${escaped}`, $options: "i" } },
    ];
  }
  const capped = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = await ClientProfile.find(query)
    .sort({ "pursuit.score": -1, updatedAt: -1 })
    .skip(Math.max(0, Number(skip) || 0))
    .limit(capped)
    .select([
      "profileKey",
      "caseNumber",
      "domain",
      "credit",
      "funding",
      "payments",
      "touches",
      "temperature",
      "pursuit",
      "lifecycle",
      "shorthand.logics_billing",
      "shorthand.logics_notice_alerts",
      "shorthand.logics_status",
    ].join(" "))
    .lean();
  const total = await ClientProfile.countDocuments(query);
  return { rows, total };
}

// Pitch designer state: whole-object replace (the route owns thread capping).
async function setPitchState(caseNumber, pitch, { domain = DEFAULT_DOMAIN } = {}) {
  const identity = normalizeClientProfileIdentity(caseNumber, domain);
  if (!identity.caseNumber) return null;
  await claimLegacyProfileKey(identity);
  return ClientProfile.findOneAndUpdate(
    profileIdentityFilter(identity),
    { $set: { pitch: pitch || null } },
    { new: true },
  ).select("profileKey caseNumber domain pitch").lean();
}

async function summarizeBank({ domain = null } = {}) {
  const match = { "lifecycle.status": "active" };
  if (domain) match.domain = normalizeDomain(domain);
  const [byTier, byTemp, byDomain, total, retired] = await Promise.all([
    ClientProfile.aggregate([
      { $match: match },
      { $group: { _id: "$pursuit.tier", count: { $sum: 1 } } },
    ]),
    ClientProfile.aggregate([
      { $match: match },
      { $group: { _id: "$temperature.label", count: { $sum: 1 } } },
    ]),
    ClientProfile.aggregate([
      { $match: match },
      { $group: { _id: "$domain", count: { $sum: 1 } } },
    ]),
    ClientProfile.countDocuments(match),
    ClientProfile.countDocuments({
      "lifecycle.status": "retired",
      ...(domain ? { domain: normalizeDomain(domain) } : {}),
    }),
  ]);
  return {
    total,
    retired,
    tiers: Object.fromEntries(byTier.map((r) => [r._id || "?", r.count])),
    temperatures: Object.fromEntries(byTemp.map((r) => [r._id || "unknown", r.count])),
    domains: Object.fromEntries(byDomain.map((r) => [r._id || "?", r.count])),
  };
}

async function retireClientProfile(caseNumber, reason = "retired", { domain = DEFAULT_DOMAIN } = {}) {
  const identity = normalizeClientProfileIdentity(caseNumber, domain);
  if (!identity.caseNumber) return null;
  await claimLegacyProfileKey(identity);
  return ClientProfile.findOneAndUpdate(
    profileIdentityFilter(identity),
    {
      $set: {
        "lifecycle.status": "retired",
        "lifecycle.retiredAt": new Date(),
        "lifecycle.retiredReason": String(reason || "retired").slice(0, 200),
      },
    },
    { new: true },
  ).lean();
}

module.exports = {
  DEFAULT_DOMAIN,
  normalizeDomain,
  buildClientProfileKey,
  normalizeClientProfileIdentity,
  upsertClientProfile,
  mergeShorthandFields,
  recordDocumentHash,
  getClientProfileByCaseNumber,
  listClientProfiles,
  summarizeBank,
  retireClientProfile,
  setPitchState,
};
