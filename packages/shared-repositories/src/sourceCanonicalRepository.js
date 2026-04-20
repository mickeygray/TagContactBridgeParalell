"use strict";

const { SourceCanonical } = require("../../shared-models/src");

async function findSourceCanonicalById(sourceCanonicalId) {
  return SourceCanonical.findById(sourceCanonicalId);
}

async function findSourceCanonicalByKey(canonicalKey) {
  return SourceCanonical.findOne({ canonicalKey });
}

async function findSourceCanonicalByTrackingNumber(phoneNumber) {
  return SourceCanonical.findOne({
    trackingNumbers: String(phoneNumber || "").trim(),
  });
}

async function findSourceCanonicalByRingCentralExtension(extensionId) {
  return SourceCanonical.findOne({
    ringCentralExtensions: String(extensionId || "").trim(),
  });
}

module.exports = {
  findSourceCanonicalById,
  findSourceCanonicalByKey,
  findSourceCanonicalByRingCentralExtension,
  findSourceCanonicalByTrackingNumber,
};
