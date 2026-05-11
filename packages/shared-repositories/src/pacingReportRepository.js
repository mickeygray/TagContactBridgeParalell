"use strict";

const { PacingReport } = require("../../shared-models/src");

async function upsertReport(hourBucket, fields) {
  return PacingReport.findOneAndUpdate(
    { hourBucket },
    { $set: { ...fields, hourBucket, generatedAt: fields.generatedAt || new Date() } },
    { new: true, upsert: true, lean: true },
  );
}

function findByHour(hourBucket) {
  return PacingReport.findOne({ hourBucket }).lean();
}

function listRecent({ limit = 24 } = {}) {
  return PacingReport.find({}).sort({ generatedAt: -1 }).limit(limit).lean();
}

function listInRange(startDate, endDate) {
  return PacingReport.find({
    generatedAt: { $gte: startDate, $lte: endDate },
  })
    .sort({ generatedAt: 1 })
    .lean();
}

module.exports = {
  upsertReport,
  findByHour,
  listRecent,
  listInRange,
};
