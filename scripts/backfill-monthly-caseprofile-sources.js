"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CaseProfile, SourceCanonical } = require("../packages/shared-models/src");
const { caseProfileRepository } = require("../packages/shared-repositories/src");
const { resolveCanonicalSource } = require("../packages/shared-services/src/sourceCanonicalService");

const SOURCE_NAME_OVERRIDES = new Map([
  ["affordability federal snap", "Affordability Federal"],
  ["affordability federal snpa", "Affordability Federal"],
  ["affordability pink state snap", "Affordability Pink State"],
  ["citation state", "Citation State PC"],
  ["aged data", "CallFire"],
  ["callfire", "CallFire"],
]);

function readFlagValue(argv, name) {
  const prefixed = argv.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1) {
    return argv[index + 1];
  }
  return null;
}

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase() || "TAG";
}

function normalizeSourceName(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  return SOURCE_NAME_OVERRIDES.get(normalized) || text;
}

function normalizePhoneDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
}

function collectNormalizedPhones(...values) {
  const phones = [];
  const seen = new Set();
  for (const value of values) {
    const digits = normalizePhoneDigits(value);
    if (!digits || seen.has(digits)) continue;
    seen.add(digits);
    phones.push(digits);
  }
  return phones;
}

function buildDateRangeMatch(from, to) {
  const range = {};
  if (from) {
    const date = new Date(`${String(from)}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime())) range.$gte = date;
  }
  if (to) {
    const date = new Date(`${String(to)}T23:59:59.999Z`);
    if (!Number.isNaN(date.getTime())) range.$lte = date;
  }
  return Object.keys(range).length > 0 ? range : null;
}

function mergeDefined(base = {}, overlay = {}) {
  const next = { ...base };
  for (const [key, value] of Object.entries(overlay || {})) {
    if (value === null || value === undefined) continue;
    next[key] = value;
  }
  return next;
}

function pickDefined(update = {}) {
  const next = {};
  for (const [key, value] of Object.entries(update || {})) {
    if (value === undefined) continue;
    if (value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    next[key] = value;
  }
  return next;
}

function legacyCollection() {
  const dbName = process.env.LEGACY_APP_DB_NAME || "test";
  return mongoose.connection.useDb(dbName, { useCache: true }).collection("rb_caseprofiles");
}

async function main() {
  const argv = process.argv.slice(2);
  const domain = normalizeDomain(readFlagValue(argv, "--domain") || "TAG");
  const from = readFlagValue(argv, "--from") || "2026-04-01";
  const to = readFlagValue(argv, "--to") || new Date().toISOString().slice(0, 10);
  const outPath = path.resolve(
    readFlagValue(argv, "--out") ||
      `ops/backfill-monthly-caseprofile-sources-${domain.toLowerCase()}-${from}-to-${to}.json`,
  );

  const config = getSharedConfig();
  await connectMongo(config);

  const dateMatch = buildDateRangeMatch(from, to);
  const legacyMatch = {
    domain,
    initialPayment: { $gt: 0 },
  };
  const currentMatch = {
    domain,
    initialPayment: { $gt: 0 },
  };
  if (dateMatch) {
    legacyMatch.firstPaymentDate = dateMatch;
    currentMatch.firstPaymentDate = dateMatch;
  }

  const [legacyDocs, currentDocs] = await Promise.all([
    legacyCollection().find(legacyMatch).toArray(),
    CaseProfile.find(currentMatch).lean(),
  ]);

  const currentCanonicalIds = [...new Set(
    currentDocs
      .map((doc) => String(doc?.sourceCanonicalId || "").trim())
      .filter(Boolean),
  )];
  const currentCanonicals = currentCanonicalIds.length > 0
    ? await SourceCanonical.find(
        { _id: { $in: currentCanonicalIds } },
        {
          _id: 1,
          internalName: 1,
        },
      ).lean()
    : [];
  const currentCanonicalById = new Map(
    currentCanonicals.map((doc) => [String(doc._id), doc]),
  );

  const currentByCaseId = new Map(
    currentDocs
      .map((doc) => [Number(doc.caseId), doc])
      .filter(([caseId]) => Number.isFinite(caseId)),
  );
  const mergedByCaseId = new Map();
  for (const legacyDoc of legacyDocs) {
    const caseId = Number(legacyDoc.caseId);
    if (!Number.isFinite(caseId)) continue;
    mergedByCaseId.set(caseId, {
      legacy: legacyDoc,
      current: currentByCaseId.get(caseId) || null,
    });
  }
  for (const currentDoc of currentDocs) {
    const caseId = Number(currentDoc.caseId);
    if (!Number.isFinite(caseId)) continue;
    if (!mergedByCaseId.has(caseId)) {
      mergedByCaseId.set(caseId, {
        legacy: null,
        current: currentDoc,
      });
    }
  }

  const results = [];
  for (const [caseId, entry] of mergedByCaseId.entries()) {
    const legacyDoc = entry.legacy || null;
    const currentDoc = entry.current || null;
    const currentCanonical = currentCanonicalById.get(String(currentDoc?.sourceCanonicalId || "")) || null;
    const sourceCandidate = normalizeSourceName(
      currentCanonical?.internalName ||
      currentDoc?.sourceName ||
      legacyDoc?.sourceName ||
      null,
    );

    let resolvedCanonical = null;
    if (sourceCandidate) {
      resolvedCanonical = await resolveCanonicalSource({
        domain,
        internalName: sourceCandidate,
        sourceName: sourceCandidate,
      }).catch(() => null);
    }

    const merged = mergeDefined(legacyDoc || {}, currentDoc || {});
    const normalizedPhones = collectNormalizedPhones(
      currentDoc?.primaryPhone,
      ...(Array.isArray(currentDoc?.normalizedPhones) ? currentDoc.normalizedPhones : []),
      legacyDoc?.phone,
      legacyDoc?.cellPhone,
      legacyDoc?.homePhone,
      legacyDoc?.workPhone,
      merged?.primaryPhone,
    );

    const update = pickDefined({
      firstName: merged.firstName,
      lastName: merged.lastName,
      name: merged.name,
      email: merged.email,
      primaryPhone: currentDoc?.primaryPhone || legacyDoc?.phone || null,
      normalizedPhones,
      sourceName: sourceCandidate,
      sourceCanonicalId: resolvedCanonical?.doc?._id || currentDoc?.sourceCanonicalId || null,
      statusId: merged.statusId,
      statusCategory: merged.statusCategory,
      convertedAt: merged.convertedAt || merged.firstPaymentDate,
      caseCreatedDate: merged.caseCreatedDate || merged.createdInLogicsAt,
      firstPaymentDate: merged.firstPaymentDate,
      initialPayment: merged.initialPayment,
      totalPaid: merged.totalPaid,
      paymentsCount: merged.paymentsCount,
      lastPaymentDate: merged.lastPaymentDate,
      lastPaymentAmount: merged.lastPaymentAmount,
    });

    if (!update.sourceName && !update.sourceCanonicalId) {
      continue;
    }

    const changed =
      !currentDoc ||
      String(currentDoc.sourceName || "") !== String(update.sourceName || "") ||
      String(currentDoc.sourceCanonicalId || "") !== String(update.sourceCanonicalId || "");

    if (!changed) {
      continue;
    }

    await caseProfileRepository.upsertCaseProfile(domain, caseId, update);
    results.push({
      caseId,
      previousSourceName: currentDoc?.sourceName || legacyDoc?.sourceName || null,
      nextSourceName: update.sourceName || null,
      previousSourceCanonicalId: currentDoc?.sourceCanonicalId || null,
      nextSourceCanonicalId: update.sourceCanonicalId || null,
      usedLegacy: Boolean(legacyDoc),
      hadCurrent: Boolean(currentDoc),
    });
  }

  const summary = {
    domain,
    from,
    to,
    scannedLegacy: legacyDocs.length,
    scannedCurrent: currentDocs.length,
    updated: results.length,
    results,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));

  await disconnectMongo();
}

main().catch(async (error) => {
  console.error(error && error.stack ? error.stack : error);
  try {
    await disconnectMongo();
  } catch {}
  process.exit(1);
});
