"use strict";

// One read owner for the question "which cases arrived on this date?"
//
// LeadCadence is the primary intake record, but it is not a complete case
// census: Logics/status discovery can create MasterProspectIndex rows and a
// later payment/status refresh can create CaseProfile rows.  Reporting used
// to read LeadCadence alone and silently omit those other cases.  This service
// unions the three durable observations by (domain, caseId), resolves source
// evidence once, and returns explicit coverage/missingness.

const {
  CaseProfile,
  LeadCadence,
  MasterProspectIndex,
  SourceCanonical,
} = require("../../shared-models/src");
const { buildTimezoneDateWindow } = require("./timezoneDateWindowService");

const DEFAULT_LIMIT = 50000;
const HYDRATE_BATCH_SIZE = 2000;

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function toDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "") || null;
}

function uniqueStrings(values = []) {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function chunk(values, size = HYDRATE_BATCH_SIZE) {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

async function leanFind(Model, query, projection, sort, limit) {
  return Model.find(query, projection)
    .sort(sort)
    .limit(limit)
    .lean();
}

async function listByCaseIds(Model, domain, caseIds, projection) {
  const rows = [];
  for (const batch of chunk(caseIds)) {
    rows.push(...await Model.find({ domain, caseId: { $in: batch } }, projection).lean());
  }
  return rows;
}

function addObservedRow(byCaseId, row, observation) {
  const caseId = Number(row?.caseId);
  if (!Number.isFinite(caseId)) return;
  if (!byCaseId.has(caseId)) {
    byCaseId.set(caseId, {
      caseId,
      cadence: null,
      prospect: null,
      profile: null,
      observedToday: new Set(),
    });
  }
  const entry = byCaseId.get(caseId);
  entry[observation] = row;
  entry.observedToday.add(observation);
}

function earliestDate(values = []) {
  return values
    .map(toDate)
    .filter(Boolean)
    .sort((left, right) => left.getTime() - right.getTime())[0] || null;
}

function resolveDiscoveryRow(entry, canonicalById) {
  const cadence = entry.cadence || {};
  const prospect = entry.prospect || {};
  const profile = entry.profile || {};
  const profileCanonical = canonicalById.get(String(profile.sourceCanonicalId || "")) || null;
  const prospectCanonical = canonicalById.get(String(prospect.sourceCanonicalId || "")) || null;
  const canonicalIds = uniqueStrings([
    profile.sourceCanonicalId,
    prospect.sourceCanonicalId,
  ]);
  const rawSources = uniqueStrings([
    profile.sourceName,
    cadence.sourceName,
    cadence.intakeSource,
    cadence.partnerSource,
    prospect.metadata?.sourceName,
    prospect.metadata?.logicsSourceName,
    prospect.metadata?.intakeSource,
    prospect.partnerSource,
  ]);
  const canonicalConflict = canonicalIds.length > 1;
  // Raw labels often differ harmlessly (campaign label vs parent source).
  // Only contradictory canonical IDs are strong enough to block attribution.
  const sourceConflict = canonicalConflict;
  const sourceName = firstValue(
    profileCanonical?.internalName,
    prospectCanonical?.internalName,
    profile.sourceName,
    cadence.sourceName,
    cadence.intakeSource,
    cadence.partnerSource,
    prospect.metadata?.sourceName,
    prospect.metadata?.logicsSourceName,
    prospect.metadata?.intakeSource,
    prospect.partnerSource,
    "Unknown",
  );
  const sourceChannel = firstValue(
    profileCanonical?.channel,
    prospectCanonical?.channel,
    profile.sourceChannel,
    cadence.sourceChannel,
    cadence.intakeRoute,
    prospect.metadata?.sourceChannel,
    prospect.intakeRoute,
  );
  const routeCampaignKey = firstValue(
    cadence.routeCampaignKey,
    prospect.metadata?.routeCampaignKey,
  );
  const routeCampaignName = firstValue(
    cadence.routeCampaignName,
    prospect.metadata?.routeCampaignName,
  );
  const observedToday = [...entry.observedToday].sort();
  const observedAt = earliestDate([
    entry.observedToday.has("cadence") ? cadence.createdAt : null,
    entry.observedToday.has("prospect") ? prospect.firstSeenAt : null,
    entry.observedToday.has("profile") ? profile.caseCreatedDate : null,
  ]);
  const hasSource = normalizeText(sourceName) !== "unknown";

  return {
    caseId: entry.caseId,
    observedAt,
    observedToday,
    cadencePresent: Boolean(entry.cadence),
    prospectPresent: Boolean(entry.prospect),
    profilePresent: Boolean(entry.profile),
    sourceName,
    sourceChannel,
    routeCampaignKey,
    routeCampaignName,
    sourceCanonicalId: firstValue(profile.sourceCanonicalId, prospect.sourceCanonicalId),
    sourceEvidenceCount: rawSources.length,
    sourceConflict,
    attributionState: sourceConflict ? "conflict" : hasSource ? "attributed" : "unattributed",
    intakeSource: firstValue(cadence.intakeSource, prospect.metadata?.intakeSource),
    intakeRoute: firstValue(cadence.intakeRoute, prospect.intakeRoute),
    currentStage: cadence.currentStage || null,
    active: cadence.active !== false,
    firstName: firstValue(cadence.firstName, profile.firstName, prospect.firstName),
    lastName: firstValue(cadence.lastName, profile.lastName, prospect.lastName),
    name: firstValue(cadence.name, profile.name, prospect.name),
    phone: firstValue(cadence.primaryPhone, profile.primaryPhone, prospect.cellPhone),
    email: firstValue(cadence.email, profile.email, prospect.email),
  };
}

function summarizeDiscovery(rows, truncation = {}) {
  const coverage = {
    discovered: rows.length,
    attributed: 0,
    unattributed: 0,
    conflicts: 0,
    observedInCadence: 0,
    observedInProspectIndex: 0,
    observedInCaseProfile: 0,
    missingCadence: 0,
    truncated: Boolean(truncation.cadence || truncation.prospect || truncation.profile),
    truncation,
  };
  for (const row of rows) {
    if (row.attributionState === "attributed") coverage.attributed += 1;
    else if (row.attributionState === "conflict") coverage.conflicts += 1;
    else coverage.unattributed += 1;
    if (row.observedToday.includes("cadence")) coverage.observedInCadence += 1;
    if (row.observedToday.includes("prospect")) coverage.observedInProspectIndex += 1;
    if (row.observedToday.includes("profile")) coverage.observedInCaseProfile += 1;
    if (!row.cadencePresent) coverage.missingCadence += 1;
  }
  return coverage;
}

async function buildMarketingCaseDiscovery(domain, options = {}, deps = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const timeZone = options.timezone || "America/Los_Angeles";
  const dateKey = String(options.date || "").trim();
  if (!normalizedDomain || !dateKey) {
    throw new Error("buildMarketingCaseDiscovery requires domain and date");
  }
  const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_LIMIT, 1), DEFAULT_LIMIT);
  const { start, end } = buildTimezoneDateWindow(dateKey, timeZone);
  const models = {
    CaseProfile: deps.CaseProfile || CaseProfile,
    LeadCadence: deps.LeadCadence || LeadCadence,
    MasterProspectIndex: deps.MasterProspectIndex || MasterProspectIndex,
    SourceCanonical: deps.SourceCanonical || SourceCanonical,
  };
  const queryLimit = limit + 1;
  const [cadenceObserved, prospectObserved, profileObserved] = await Promise.all([
    leanFind(models.LeadCadence, {
      domain: normalizedDomain,
      createdAt: { $gte: start, $lte: end },
    }, null, { createdAt: 1, caseId: 1 }, queryLimit),
    leanFind(models.MasterProspectIndex, {
      domain: normalizedDomain,
      firstSeenAt: { $gte: start, $lte: end },
    }, null, { firstSeenAt: 1, caseId: 1 }, queryLimit),
    leanFind(models.CaseProfile, {
      domain: normalizedDomain,
      caseCreatedDate: { $gte: start, $lte: end },
    }, null, { caseCreatedDate: 1, caseId: 1 }, queryLimit),
  ]);
  const truncation = {
    cadence: cadenceObserved.length > limit,
    prospect: prospectObserved.length > limit,
    profile: profileObserved.length > limit,
  };
  const byCaseId = new Map();
  for (const row of cadenceObserved.slice(0, limit)) addObservedRow(byCaseId, row, "cadence");
  for (const row of prospectObserved.slice(0, limit)) addObservedRow(byCaseId, row, "prospect");
  for (const row of profileObserved.slice(0, limit)) addObservedRow(byCaseId, row, "profile");

  const caseIds = [...byCaseId.keys()];
  if (caseIds.length === 0) {
    return {
      domain: normalizedDomain,
      date: dateKey,
      rows: [],
      coverage: summarizeDiscovery([], truncation),
    };
  }

  const [cadences, prospects, profiles] = await Promise.all([
    listByCaseIds(models.LeadCadence, normalizedDomain, caseIds, null),
    listByCaseIds(models.MasterProspectIndex, normalizedDomain, caseIds, null),
    listByCaseIds(models.CaseProfile, normalizedDomain, caseIds, null),
  ]);
  for (const row of cadences) byCaseId.get(Number(row.caseId)).cadence = row;
  for (const row of prospects) byCaseId.get(Number(row.caseId)).prospect = row;
  for (const row of profiles) byCaseId.get(Number(row.caseId)).profile = row;

  const canonicalIds = uniqueStrings([
    ...profiles.map((row) => row.sourceCanonicalId),
    ...prospects.map((row) => row.sourceCanonicalId),
  ]);
  const canonicals = canonicalIds.length > 0
    ? await models.SourceCanonical.find({ _id: { $in: canonicalIds } }, {
        _id: 1,
        internalName: 1,
        channel: 1,
      }).lean()
    : [];
  const canonicalById = new Map(canonicals.map((row) => [String(row._id), row]));
  const rows = [...byCaseId.values()]
    .map((entry) => resolveDiscoveryRow(entry, canonicalById))
    .sort((left, right) =>
      (left.observedAt?.getTime() || 0) - (right.observedAt?.getTime() || 0) ||
      left.caseId - right.caseId,
    );

  return {
    domain: normalizedDomain,
    date: dateKey,
    rows,
    coverage: summarizeDiscovery(rows, truncation),
  };
}

module.exports = {
  buildMarketingCaseDiscovery,
  resolveDiscoveryRow,
  summarizeDiscovery,
};
