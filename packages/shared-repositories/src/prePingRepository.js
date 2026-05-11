"use strict";

const { PrePing } = require("../../shared-models/src");

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeHash(value) {
  return String(value || "").trim().toLowerCase();
}

async function upsertPrePing(domain, emailHash, callbackUrl = null) {
  return PrePing.findOneAndUpdate(
    {
      domain: normalizeDomain(domain),
      emailHash: normalizeHash(emailHash),
    },
    {
      $set: {
        callbackUrl: callbackUrl || null,
        createdAt: new Date(),
      },
      $setOnInsert: {
        domain: normalizeDomain(domain),
        emailHash: normalizeHash(emailHash),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function consumePrePing(domain, emailHash) {
  return PrePing.findOneAndDelete({
    domain: normalizeDomain(domain),
    emailHash: normalizeHash(emailHash),
  }).lean();
}

async function findPrePing(domain, emailHash) {
  return PrePing.findOne({
    domain: normalizeDomain(domain),
    emailHash: normalizeHash(emailHash),
  }).lean();
}

module.exports = {
  consumePrePing,
  findPrePing,
  upsertPrePing,
};
