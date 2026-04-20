"use strict";

const { QualityReview } = require("../../shared-models/src");

async function createQualityReview(payload) {
  return QualityReview.create(payload);
}

async function findLatestQualityReview(domain, caseId, reviewType = null) {
  const query = {
    domain: String(domain || "").toUpperCase(),
    caseId: Number(caseId),
  };
  if (reviewType) query.reviewType = reviewType;

  return QualityReview.findOne(query).sort({ reviewedAt: -1, createdAt: -1 }).lean();
}

module.exports = {
  createQualityReview,
  findLatestQualityReview,
};
