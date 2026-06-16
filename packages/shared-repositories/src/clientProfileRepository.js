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
// Card projection — the trimmed fields the bank grid + suggestion cards need.
// The full dossier (pitch thread, document hashes, whole shorthand ledger) loads
// only when a card is opened.
const CARD_PROJECTION = [
  "profileKey", "caseNumber", "domain", "credit", "funding", "payments",
  "touches", "temperature", "pursuit", "lifecycle",
  "shorthand.logics_billing", "shorthand.logics_notice_alerts", "shorthand.logics_status",
].join(" ");
// Suggestions additionally need the fields the candidate predicate reads.
const SUGGESTION_PROJECTION = `${CARD_PROJECTION} opportunities upsell`;

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
    .select(CARD_PROJECTION)
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

// ── Upsell-suggestion suppression ("not now" / "check again on") ──────────────
const DEFAULT_UPSELL_SNOOZE_DAYS = 30;

// "not now" pushes the next eligible suggestion out by N days (config
// RESOLUTION_UPSELL_SNOOZE_DAYS, default 30). An explicit checkAgainOn date wins.
// Returns a future Date, or null ONLY if an explicit checkAgainOn is unparseable.
function resolveUpsellCheckAgainOn({ now = new Date(), checkAgainOn = null, days = null } = {}) {
  if (checkAgainOn) {
    const explicit = new Date(checkAgainOn);
    return Number.isNaN(explicit.getTime()) ? null : explicit;
  }
  const envDays = Number(process.env.RESOLUTION_UPSELL_SNOOZE_DAYS);
  const span = Number.isFinite(Number(days)) && Number(days) > 0
    ? Number(days)
    : (Number.isFinite(envDays) && envDays > 0 ? envDays : DEFAULT_UPSELL_SNOOZE_DAYS);
  return new Date(new Date(now).getTime() + span * 86_400_000);
}

// A client is suppressed from upsell suggestions while checkAgainOn is in the future.
function isUpsellSuppressed(profile, now = new Date()) {
  const when = profile && profile.upsell ? profile.upsell.checkAgainOn : null;
  if (!when) return false;
  const date = new Date(when);
  return !Number.isNaN(date.getTime()) && date.getTime() > new Date(now).getTime();
}

// An opportunity counts as "open" unless explicitly closed out. The gem-scan
// status vocabulary isn't fixed, so treat anything NOT in the closed set as
// open (tighten the closed set as the vocabulary settles).
const CLOSED_OPPORTUNITY_STATUSES = new Set([
  "dismissed", "rejected", "complete", "completed", "done", "closed", "won", "lost",
]);

function hasOpenUpsellOpportunity(profile) {
  const opps = profile && Array.isArray(profile.opportunities) ? profile.opportunities : [];
  return opps.some(
    (o) => o && !CLOSED_OPPORTUNITY_STATUSES.has(String(o.status || "").trim().toLowerCase()),
  );
}

// A client is a "look into this" upsell suggestion when it's active, not snoozed
// ("not now" / check-again-on in the future), and has at least one open
// UPSELLERATOR opportunity. Pure — the list query filters on this predicate.
function isUpsellSuggestionCandidate(profile, now = new Date()) {
  if (!profile) return false;
  if (profile.lifecycle && profile.lifecycle.status === "retired") return false;
  if (isUpsellSuppressed(profile, now)) return false;
  return hasOpenUpsellOpportunity(profile);
}

// upsell may be null on legacy/seeded rows; Mongo can't create a dot-path inside an
// explicit null ("Cannot create field ... in element {upsell: null}"). Normalize
// null/missing → {} first — mirrors the shorthand guard above. Idempotent, and it
// never touches a row whose upsell is already an object.
async function ensureUpsellSubdoc(identity) {
  await ClientProfile.updateOne(
    { ...profileIdentityFilter(identity), upsell: null },
    { $set: { upsell: {} } },
  );
}

// "not now": dismiss a surfaced upsell suggestion and snooze re-suggestion.
async function snoozeUpsell(caseNumber, { domain = DEFAULT_DOMAIN, days = null, checkAgainOn = null, by = null, reason = null, now = new Date() } = {}) {
  const identity = normalizeClientProfileIdentity(caseNumber, domain);
  if (!identity.caseNumber) return null;
  await claimLegacyProfileKey(identity);
  await ensureUpsellSubdoc(identity);
  const checkAgain = resolveUpsellCheckAgainOn({ now, checkAgainOn, days });
  return ClientProfile.findOneAndUpdate(
    profileIdentityFilter(identity),
    {
      $set: {
        "upsell.checkAgainOn": checkAgain,
        "upsell.dismissedAt": new Date(now),
        "upsell.dismissedBy": by ? String(by).slice(0, 120) : null,
        "upsell.dismissReason": reason ? String(reason).slice(0, 200) : null,
      },
    },
    { new: true },
  ).lean();
}

// Clear a snooze so the client can be suggested again immediately.
async function clearUpsellSnooze(caseNumber, { domain = DEFAULT_DOMAIN } = {}) {
  const identity = normalizeClientProfileIdentity(caseNumber, domain);
  if (!identity.caseNumber) return null;
  await claimLegacyProfileKey(identity);
  await ensureUpsellSubdoc(identity);
  return ClientProfile.findOneAndUpdate(
    profileIdentityFilter(identity),
    { $set: { "upsell.checkAgainOn": null, "upsell.dismissedAt": null, "upsell.dismissReason": null } },
    { new: true },
  ).lean();
}

// Today's "look into these" upsell list: active clients with at least one open
// opportunity, minus anyone snoozed via "not now". The query narrows to
// active + has-opportunity; isUpsellSuggestionCandidate (snooze + open-opp) is
// the source of truth applied in-memory. Best-prospect-first by pursuit score.
async function listUpsellSuggestions({ domain = null, limit = 100, now = new Date() } = {}) {
  const query = { "lifecycle.status": "active", "opportunities.0": { $exists: true } };
  if (domain) query.domain = normalizeDomain(domain);
  const rows = await ClientProfile.find(query)
    .sort({ "pursuit.score": -1 })
    .limit(Math.min(Number(limit) || 100, 500))
    .select(SUGGESTION_PROJECTION)
    .lean();
  return rows.filter((profile) => isUpsellSuggestionCandidate(profile, now));
}

module.exports = {
  DEFAULT_DOMAIN,
  normalizeDomain,
  listUpsellSuggestions,
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
  resolveUpsellCheckAgainOn, // exported for unit tests (upsell snooze)
  isUpsellSuppressed, // exported for unit tests (upsell snooze)
  hasOpenUpsellOpportunity, // exported for unit tests (upsell suggestions)
  isUpsellSuggestionCandidate, // exported for unit tests (upsell suggestions)
  snoozeUpsell,
  clearUpsellSnooze,
};
