"use strict";

const { CaseProfile } = require("../../shared-models/src");

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
    { primaryPhone: regex },
  ];

  if (digits) {
    orConditions.push({ normalizedPhones: digits });
  }

  if (Number.isFinite(numericCaseId) && value === String(numericCaseId)) {
    orConditions.push({ caseId: numericCaseId });
  }

  return { $or: orConditions };
}

async function findCaseProfile(domain, caseId) {
  return CaseProfile.findOne({
    domain: String(domain || "").toUpperCase(),
    caseId: Number(caseId),
  });
}

async function upsertCaseProfile(domain, caseId, update = {}) {
  return CaseProfile.findOneAndUpdate(
    {
      domain: String(domain || "").toUpperCase(),
      caseId: Number(caseId),
    },
    { $set: update },
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
  return CaseProfile.find(query)
    .sort({ updatedAt: -1, caseId: -1 })
    .limit(limit)
    .lean();
}

module.exports = {
  countCaseProfilesByDomain,
  countCaseProfilesWithPayments,
  findCaseProfile,
  findCaseProfilesDueForAiCaseReview,
  listCaseProfiles,
  upsertCaseProfile,
};
