"use strict";

const mongoose = require("mongoose");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function getLegacyDbName() {
  return String(process.env.LEGACY_APP_DB_NAME || "test").trim() || "test";
}

function getLegacyDb() {
  return mongoose.connection.useDb(getLegacyDbName(), { useCache: true });
}

function getParallelDb() {
  return mongoose.connection.db;
}

const COLLECTIONS = [
  { key: "dailyspends", legacy: "dailyspends", mirror: "legacy_dailyspends", scopedByDomain: true },
  { key: "dailypaymentsummaries", legacy: "dailypaymentsummaries", mirror: "legacy_dailypaymentsummaries", scopedByDomain: true },
  { key: "dailysummaries", legacy: "dailysummaries", mirror: "legacy_dailysummaries", scopedByDomain: true },
  { key: "rb_dailycallstats", legacy: "rb_dailycallstats", mirror: "legacy_rb_dailycallstats", scopedByDomain: false },
  { key: "rb_paymentalerts", legacy: "rb_paymentalerts", mirror: "legacy_rb_paymentalerts", scopedByDomain: true },
  { key: "rb_sourcecanonicals", legacy: "rb_sourcecanonicals", mirror: "legacy_rb_sourcecanonicals", scopedByDomain: false },
  { key: "mailerconfigs", legacy: "mailerconfigs", mirror: "legacy_mailerconfigs", scopedByDomain: false },
];

function buildScopeMatch(collectionConfig, domain) {
  if (!collectionConfig.scopedByDomain) return {};
  return { domain: normalizeDomain(domain) };
}

async function syncLegacyMetricsMirror(domain) {
  const normalizedDomain = normalizeDomain(domain || "TAG");
  const legacyDb = getLegacyDb();
  const parallelDb = getParallelDb();
  const summary = [];

  for (const collectionConfig of COLLECTIONS) {
    const scopeMatch = buildScopeMatch(collectionConfig, normalizedDomain);
    const sourceCollection = legacyDb.collection(collectionConfig.legacy);
    const targetCollection = parallelDb.collection(collectionConfig.mirror);
    const rows = await sourceCollection.find(scopeMatch).toArray();
    const docs = rows.map((row) => {
      const next = { ...row };
      delete next._id;
      if (collectionConfig.scopedByDomain) {
        next.domain = normalizedDomain;
      }
      next._mirroredAt = new Date();
      next._mirroredFromDb = getLegacyDbName();
      return next;
    });

    await targetCollection.deleteMany(scopeMatch);
    if (docs.length > 0) {
      await targetCollection.insertMany(docs, { ordered: false });
    }

    summary.push({
      key: collectionConfig.key,
      legacyCollection: collectionConfig.legacy,
      mirrorCollection: collectionConfig.mirror,
      scopedByDomain: collectionConfig.scopedByDomain,
      count: docs.length,
    });
  }

  await parallelDb.collection("legacy_metrics_sync_state").updateOne(
    { domain: normalizedDomain },
    {
      $set: {
        domain: normalizedDomain,
        legacyDbName: getLegacyDbName(),
        syncedAt: new Date(),
        collections: summary,
      },
    },
    { upsert: true },
  );

  return {
    domain: normalizedDomain,
    legacyDbName: getLegacyDbName(),
    syncedAt: new Date().toISOString(),
    collections: summary,
  };
}

async function getLegacyMetricsMirrorStatus(domain) {
  const normalizedDomain = normalizeDomain(domain || "TAG");
  const legacyDb = getLegacyDb();
  const parallelDb = getParallelDb();
  const rows = [];

  for (const collectionConfig of COLLECTIONS) {
    const scopeMatch = buildScopeMatch(collectionConfig, normalizedDomain);
    const [legacyCount, mirrorCount] = await Promise.all([
      legacyDb.collection(collectionConfig.legacy).countDocuments(scopeMatch),
      parallelDb.collection(collectionConfig.mirror).countDocuments(scopeMatch),
    ]);

    rows.push({
      key: collectionConfig.key,
      legacyCollection: collectionConfig.legacy,
      mirrorCollection: collectionConfig.mirror,
      scopedByDomain: collectionConfig.scopedByDomain,
      legacyCount,
      mirrorCount,
      inSync: legacyCount === mirrorCount && legacyCount > 0,
    });
  }

  const syncState = await parallelDb.collection("legacy_metrics_sync_state").findOne({
    domain: normalizedDomain,
  });

  return {
    domain: normalizedDomain,
    legacyDbName: getLegacyDbName(),
    syncedAt: syncState?.syncedAt || null,
    collections: rows,
  };
}

module.exports = {
  getLegacyMetricsMirrorStatus,
  syncLegacyMetricsMirror,
};
