"use strict";

const { ActivityAiReview } = require("../../shared-models/src");

async function createActivityAiReview(payload) {
  return ActivityAiReview.create(payload);
}

async function findLatestActivityAiReview(domain, caseId, reviewType = "contact-safety") {
  return ActivityAiReview.findOne({
    domain: String(domain || "").toUpperCase(),
    caseId: Number(caseId),
    reviewType,
  })
    .sort({ reviewedAt: -1 })
    .lean();
}

module.exports = {
  createActivityAiReview,
  findLatestActivityAiReview,
};
