"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function naturalKey(record = {}) {
  const receivedAt = normalizeDate(record.receivedAt);
  return [
    normalizeDomain(record.domain || record.company),
    record.caseId == null ? "" : String(Number(record.caseId)),
    String(record.email || "").trim().toLowerCase(),
    normalizePhone(record.phone),
    receivedAt ? receivedAt.toISOString() : "",
    String(record.source || "").trim().toLowerCase(),
  ].join("|");
}

function mapLegacyConsentRecord(row = {}) {
  const receivedAt = normalizeDate(row.receivedAt) || normalizeDate(row.createdAt) || new Date();
  const domain = normalizeDomain(row.domain || row.company || "TAG");
  const now = new Date();
  const legacyMirror = {
    sourceCollection: "consentrecords",
    sourceId: row._id ? String(row._id) : null,
    mirroredFromDb: row._mirroredFromDb || null,
    mirroredAt: row._mirroredAt || null,
    mirrorRunId: row._mirrorRunId || null,
  };

  return {
    _id: row._id,
    domain,
    company: normalizeDomain(row.company || domain),
    source: row.source || null,
    caseId: row.caseId == null || row.caseId === "" ? null : Number(row.caseId),
    email: row.email || null,
    phone: row.phone || null,
    trustedFormCertUrl: row.trustedFormCertUrl || null,
    jornayaLeadId: row.jornayaLeadId || null,
    receivedAt,
    ip: row.ip || null,
    userAgent: row.userAgent || null,
    intakeRoute: row.intakeRoute || "legacy-consent-vault",
    intakeSource: row.intakeSource || row.source || "legacy-consent-vault",
    payloadSnapshot: {
      migratedFromLegacyConsentVault: true,
      legacyMirror,
      originalPayloadSnapshot: row.payloadSnapshot || null,
    },
    createdAt: normalizeDate(row.createdAt) || receivedAt,
    updatedAt: now,
    __v: 0,
  };
}

async function main() {
  const commit = process.argv.includes("--commit");
  const config = getSharedConfig();
  if (!config.mongoUri) throw new Error("Missing MONGO_URI");

  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  try {
    const db = mongoose.connection.db;
    const source = db.collection("consentrecords");
    const target = db.collection("controlplaneconsentrecords");

    const [sourceRows, targetRows] = await Promise.all([
      source.find({}).toArray(),
      target.find({}).project({
        domain: 1,
        company: 1,
        caseId: 1,
        email: 1,
        phone: 1,
        receivedAt: 1,
        source: 1,
      }).toArray(),
    ]);

    const targetIds = new Set(targetRows.map((row) => String(row._id)));
    const targetNaturalKeys = new Set(targetRows.map(naturalKey));
    const inserts = sourceRows
      .filter((row) => !targetIds.has(String(row._id)))
      .filter((row) => !targetNaturalKeys.has(naturalKey(row)))
      .map(mapLegacyConsentRecord);

    const summary = {
      db: mongoose.connection.name,
      commit,
      sourceCollection: "consentrecords",
      targetCollection: "controlplaneconsentrecords",
      sourceRows: sourceRows.length,
      targetRowsBefore: targetRows.length,
      insertableRows: inserts.length,
    };

    console.log(JSON.stringify(summary, null, 2));
    if (!commit || inserts.length === 0) {
      console.log(commit ? "No rows to insert." : "Dry run only. Re-run with --commit to merge.");
      return;
    }

    const result = await target.insertMany(inserts, { ordered: false });
    console.log(JSON.stringify({
      inserted: Object.keys(result.insertedIds || {}).length,
      targetRowsAfter: await target.estimatedDocumentCount(),
    }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(error.stack || error.message || error);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
