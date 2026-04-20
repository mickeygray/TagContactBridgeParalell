"use strict";

const { MasterProspectIndex } = require("../../shared-models/src");

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
    { cellPhone: regex },
    { homePhone: regex },
    { workPhone: regex },
  ];

  if (digits) {
    orConditions.push({ normalizedPhones: digits });
  }

  if (Number.isFinite(numericCaseId) && value === String(numericCaseId)) {
    orConditions.push({ caseId: numericCaseId });
  }

  return { $or: orConditions };
}

async function findMasterProspect(domain, caseId) {
  return MasterProspectIndex.findOne({
    domain: String(domain || "").toUpperCase(),
    caseId: Number(caseId),
  });
}

async function upsertMasterProspect(domain, caseId, update = {}) {
  return MasterProspectIndex.findOneAndUpdate(
    {
      domain: String(domain || "").toUpperCase(),
      caseId: Number(caseId),
    },
    { $set: update },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function listProspectsNeedingStatusRefresh(limit = 1000) {
  return MasterProspectIndex.find({
    needsStatusRefresh: true,
    convertedAt: null,
  })
    .sort({ lastStatusCheckAt: 1, createdAt: 1 })
    .limit(limit)
    .lean();
}

async function listProspectsByStatusIds(domain, statusIds = []) {
  return MasterProspectIndex.find({
    domain: String(domain || "").toUpperCase(),
    statusId: { $in: statusIds.map((value) => Number(value)) },
    convertedAt: null,
  })
    .select("domain caseId statusId statusCategory sourceId sourceCanonicalId")
    .lean();
}

async function bulkUpsertMasterProspects(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };

  const operations = rows.map((row) => ({
    updateOne: {
      filter: {
        domain: String(row.domain || "").toUpperCase(),
        caseId: Number(row.caseId),
      },
      update: {
        $set: row.update || {},
        $setOnInsert: {
          domain: String(row.domain || "").toUpperCase(),
          caseId: Number(row.caseId),
          firstSeenAt: row.firstSeenAt || new Date(),
        },
      },
      upsert: true,
    },
  }));

  return MasterProspectIndex.bulkWrite(operations, { ordered: false });
}

async function listMasterProspects(domain, filters = {}) {
  const query = {
    domain: String(domain || "").toUpperCase(),
  };

  if (filters.statusCategory) query.statusCategory = filters.statusCategory;
  if (filters.statusId != null) query.statusId = Number(filters.statusId);
  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.converted === true) query.convertedAt = { $ne: null };
  if (filters.converted === false) query.convertedAt = null;
  if (filters.search) Object.assign(query, buildSearchQuery(filters.search));

  const limit = Math.min(Number(filters.limit) || 50, 200);
  return MasterProspectIndex.find(query)
    .sort({ updatedAt: -1, caseId: -1 })
    .limit(limit)
    .lean();
}

async function countMasterProspects(domain, filters = {}) {
  const query = {
    domain: String(domain || "").toUpperCase(),
  };

  if (filters.statusCategory) query.statusCategory = filters.statusCategory;
  if (filters.statusId != null) query.statusId = Number(filters.statusId);
  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.converted === true) query.convertedAt = { $ne: null };
  if (filters.converted === false) query.convertedAt = null;
  if (filters.search) Object.assign(query, buildSearchQuery(filters.search));

  return MasterProspectIndex.countDocuments(query);
}

module.exports = {
  bulkUpsertMasterProspects,
  countMasterProspects,
  findMasterProspect,
  listMasterProspects,
  listProspectsByStatusIds,
  listProspectsNeedingStatusRefresh,
  upsertMasterProspect,
};
