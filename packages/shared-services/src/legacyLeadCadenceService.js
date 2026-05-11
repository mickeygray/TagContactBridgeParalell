"use strict";

const mongoose = require("mongoose");

function getLegacyDbName() {
  return String(process.env.LEGACY_APP_DB_NAME || "test").trim() || "test";
}

function getLegacyDb() {
  return mongoose.connection.useDb(getLegacyDbName(), { useCache: true });
}

function buildSearchQuery(search) {
  const value = String(search || "").trim();
  if (!value) return null;

  const regex = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const digits = value.replace(/\D/g, "");
  const clauses = [
    { name: regex },
    { firstName: regex },
    { lastName: regex },
    { phone: regex },
    { primaryPhone: regex },
    { normalizedPhone: digits || "__no_digits__" },
    { email: regex },
  ];

  return { $or: clauses };
}

function normalizeLegacyLeadCadence(row = {}, domain) {
  const normalizedPhone =
    String(
      row.normalizedPhone
      || row.phoneNormalized
      || row.primaryPhone
      || row.cellPhone
      || "",
    ).replace(/\D/g, "") || null;

  return {
    _id: row._id,
    domain: String(row.domain || row.company || domain || "").toUpperCase(),
    caseId: Number(row.caseId || row.CaseID || row.caseID),
    active: row.active !== false,
    name:
      row.name
      || [row.firstName || row.FirstName, row.lastName || row.LastName].filter(Boolean).join(" ").trim()
      || null,
    firstName: row.firstName || row.FirstName || null,
    lastName: row.lastName || row.LastName || null,
    email: row.email || row.Email || null,
    primaryPhone: row.primaryPhone || row.phone || row.cellPhone || row.CellPhone || null,
    normalizedPhone,
    statusId: row.statusId ?? row.StatusID ?? null,
    currentStage: row.currentStage || row.stage || row.nextOutreachType || null,
    intakeSource: row.intakeSource || row.source || row.sourceName || row.SourceName || null,
    intakeRoute: row.intakeRoute || null,
    sourceName: row.sourceName || row.SourceName || row.source || null,
    masterProspectId: row.masterProspectId || null,
    updatedAt: row.updatedAt || row.lastUpdatedAt || row.createdAt || null,
  };
}

// See leadCadenceRepository.coerceDateBoundary for the contract — same
// shape duplicated here so this helper service stays self-contained
// (legacy/Wynn-only code path; the parallel repository owns the
// canonical version).
function coerceDateBoundary(value, { endOfDay = false } = {}) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  if (dateOnly) {
    const time = endOfDay ? "23:59:59.999" : "00:00:00.000";
    const naiveUtcMs = Date.parse(`${raw}T${time}Z`);
    const wallClockSampler = new Date(naiveUtcMs);
    const tzString = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      timeZoneName: "shortOffset",
    })
      .formatToParts(wallClockSampler)
      .find((part) => part.type === "timeZoneName")?.value || "GMT-08:00";
    const offsetMatch = String(tzString).match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    let offsetMinutes = 0;
    if (offsetMatch) {
      const sign = offsetMatch[1] === "-" ? -1 : 1;
      const hours = Number(offsetMatch[2] || 0);
      const minutes = Number(offsetMatch[3] || 0);
      offsetMinutes = sign * (hours * 60 + minutes);
    }
    const utcMs = naiveUtcMs - offsetMinutes * 60 * 1000;
    return new Date(utcMs);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function listLegacyLeadCadence(domain, filters = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const query = {
    company: normalizedDomain,
  };

  if (typeof filters.active === "boolean") {
    query.active = filters.active;
  }

  // Date-range scoping (createdAt). Optional, additive with active /
  // search. Same semantics as listLeadCadence — date-only inputs map to
  // PT day bounds, full ISO strings or Date instances pass through.
  const createdAfter = coerceDateBoundary(filters.createdAtAfter, { endOfDay: false });
  const createdBefore = coerceDateBoundary(filters.createdAtBefore, { endOfDay: true });
  if (createdAfter || createdBefore) {
    query.createdAt = {};
    if (createdAfter) query.createdAt.$gte = createdAfter;
    if (createdBefore) query.createdAt.$lte = createdBefore;
  }

  const searchQuery = buildSearchQuery(filters.search);
  if (searchQuery) {
    Object.assign(query, searchQuery);
  }

  const limit = Math.min(Number(filters.limit) || 50, 20000);
  const rows = await getLegacyDb()
    .collection("leadcadences")
    .find(query)
    .sort({ updatedAt: -1, caseId: -1 })
    .limit(limit)
    .toArray();

  return rows
    .map((row) => normalizeLegacyLeadCadence(row, normalizedDomain))
    .filter((row) => Number.isFinite(row.caseId));
}

async function listLegacyLeadCadenceByCaseIds(domain, caseIds = []) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedIds = caseIds.map((value) => Number(value)).filter(Number.isFinite);
  if (normalizedIds.length === 0) return [];
  const stringIds = normalizedIds.map((value) => String(value));

  const rows = await getLegacyDb()
    .collection("leadcadences")
    .find({
      $and: [
        {
          $or: [
            { company: normalizedDomain },
            { domain: normalizedDomain },
            { tenant: normalizedDomain },
          ],
        },
        {
          $or: [
            { caseId: { $in: normalizedIds } },
            { caseId: { $in: stringIds } },
            { CaseID: { $in: normalizedIds } },
            { CaseID: { $in: stringIds } },
          ],
        },
      ],
    })
    .sort({ updatedAt: -1, caseId: -1 })
    .toArray();

  return rows
    .map((row) => normalizeLegacyLeadCadence(row, normalizedDomain))
    .filter((row) => Number.isFinite(row.caseId));
}

module.exports = {
  listLegacyLeadCadence,
  listLegacyLeadCadenceByCaseIds,
};
