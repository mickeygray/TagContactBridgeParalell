"use strict";

const mongoose = require("mongoose");
const { MailerConfig, SourceCanonical } = require("../../shared-models/src");
const { loadMailerConfigCache } = require("./mailerConfigService");
const { resolveCanonicalSource } = require("./sourceCanonicalService");

function getMirrorDb() {
  return mongoose.connection.db;
}

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
}

function normalizePhone(value) {
  const digits = normalizeDigits(value);
  if (digits.length !== 10) return String(value || "").trim() || null;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function mapLegacySourceCanonical(doc = {}) {
  return {
    canonicalKey: doc.canonicalKey,
    internalName: doc.internalName,
    channel: doc.channel || "unknown",
    domains: Array.isArray(doc.domains) ? doc.domains.map(normalizeDomain) : [],
    active: doc.active !== false,
    aliases: Array.isArray(doc.aliases)
      ? doc.aliases.map((alias) => String(alias?.text || alias || "").trim()).filter(Boolean)
      : [],
    trackingNumbers: Array.isArray(doc.trackingNumbers)
      ? doc.trackingNumbers.map((entry) => normalizeDigits(entry?.number || entry)).filter(Boolean)
      : [],
    phoneNumbers: Array.isArray(doc.phones)
      ? doc.phones.map((entry) => normalizeDigits(entry?.digits || entry?.phone || entry)).filter(Boolean)
      : [],
    sourceIds: Array.isArray(doc.sourceIds)
      ? doc.sourceIds
        .filter((entry) => entry?.domain && Number.isFinite(Number(entry?.sourceId)))
        .map((entry) => ({
          domain: normalizeDomain(entry.domain),
          sourceId: Number(entry.sourceId),
        }))
      : [],
    ringCentralExtensions: Array.isArray(doc.ringCentral)
      ? doc.ringCentral.map((entry) => String(entry?.ext || entry).trim()).filter(Boolean)
      : [],
    flags: {
      mailer: Boolean(doc.flags?.mailer || doc.channel === "mailer"),
      digital: Boolean(doc.flags?.digital),
      needsReview: Boolean(doc.flags?.needsReview),
    },
  };
}

function mapLegacyMailerConfig(doc = {}) {
  return {
    phone: normalizePhone(doc.phone || doc.digits),
    digits: normalizeDigits(doc.digits || doc.phone),
    assignments: Array.isArray(doc.assignments)
      ? doc.assignments.map((assignment) => ({
        mailHouseName: assignment.mailHouseName || assignment.internalName || "Unknown",
        internalName: assignment.internalName || null,
        form: assignment.form || null,
        stream: assignment.stream || null,
        color: assignment.color || null,
        from: assignment.from,
        to: assignment.to || null,
        active: Boolean(assignment.active),
        drops: Number(assignment.drops || 0),
        totalPieces: Number(assignment.totalPieces || 0),
        crTrackerName: assignment.crTrackerName || null,
        crTrackingNumber: assignment.crTrackingNumber || null,
        rcQueueName: assignment.rcQueueName || null,
        rcExt: assignment.rcExt ? String(assignment.rcExt) : null,
      }))
      : [],
    lastUpdated: doc.lastUpdated ? new Date(doc.lastUpdated) : new Date(),
  };
}

async function syncLegacyAttributionMaps() {
  const db = getMirrorDb();
  const [legacyCanonicals, legacyMailers] = await Promise.all([
    db.collection("legacy_rb_sourcecanonicals").find({}).toArray(),
    db.collection("legacy_mailerconfigs").find({}).toArray(),
  ]);

  await Promise.all([
    ...legacyCanonicals.map((doc) => {
      const mapped = mapLegacySourceCanonical(doc);
      return SourceCanonical.findOneAndUpdate(
        { canonicalKey: mapped.canonicalKey },
        { $set: mapped },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }),
    ...legacyMailers.map((doc) => {
      const mapped = mapLegacyMailerConfig(doc);
      return MailerConfig.findOneAndUpdate(
        { digits: mapped.digits },
        { $set: mapped },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }),
  ]);

  await loadMailerConfigCache();

  return {
    sourceCanonicals: legacyCanonicals.length,
    mailerConfigs: legacyMailers.length,
  };
}

function buildCanonicalUpdate(existing = {}, canonical = null, fields = {}) {
  if (!canonical) return null;

  const update = {
    canonicalKey: canonical.canonicalKey,
    matchedBy: canonical.matchedBy,
  };

  if (fields.sourceField) {
    const current = existing[fields.sourceField];
    if (current && current !== canonical.internalName) {
      update[`${fields.sourceField}Original`] = existing[`${fields.sourceField}Original`] || current;
    }
    update[fields.sourceField] = canonical.internalName;
  }

  if (fields.channelField && !existing[fields.channelField]) {
    update[fields.channelField] = canonical.channel;
  }

  return update;
}

async function canonicalizeMirroredMetrics(domain = "TAG") {
  const normalizedDomain = normalizeDomain(domain);
  const db = getMirrorDb();
  const results = {};

  const spendRows = await db.collection("legacy_dailyspends").find({ domain: normalizedDomain }).toArray();
  let spendUpdated = 0;
  for (const row of spendRows) {
    const canonical = await resolveCanonicalSource({
      domain: normalizedDomain,
      internalName: row.source,
      sourceName: row.source,
      rawName: row.source,
      mailHouseName: row.mailHouseName || row.jobName,
      trackerName: row.trackerName,
      trackingNumber: row.trackingNumber || row.phone,
      phone: row.phone,
    });
    const update = buildCanonicalUpdate(row, canonical, { sourceField: "source" });
    if (update) {
      await db.collection("legacy_dailyspends").updateOne({ _id: row._id }, { $set: update });
      spendUpdated += 1;
    }
  }
  results.dailyspends = spendUpdated;

  const paymentRows = await db.collection("legacy_dailypaymentsummaries").find({ domain: normalizedDomain }).toArray();
  let paymentUpdated = 0;
  for (const row of paymentRows) {
    const canonical = await resolveCanonicalSource({
      domain: normalizedDomain,
      internalName: row.sourceName,
      sourceName: row.sourceName,
      rawName: row.sourceName,
    });
    const update = buildCanonicalUpdate(row, canonical, {
      sourceField: "sourceName",
      channelField: "sourceChannel",
    });
    if (update) {
      await db.collection("legacy_dailypaymentsummaries").updateOne({ _id: row._id }, { $set: update });
      paymentUpdated += 1;
    }
  }
  results.dailypaymentsummaries = paymentUpdated;

  const summaryRows = await db.collection("legacy_dailysummaries").find({ domain: normalizedDomain }).toArray();
  let summaryUpdated = 0;
  for (const row of summaryRows) {
    const canonical = await resolveCanonicalSource({
      domain: normalizedDomain,
      internalName: row.source,
      sourceName: row.source,
      rawName: row.source,
    });
    const update = buildCanonicalUpdate(row, canonical, {
      sourceField: "source",
      channelField: "channel",
    });
    if (update) {
      await db.collection("legacy_dailysummaries").updateOne({ _id: row._id }, { $set: update });
      summaryUpdated += 1;
    }
  }
  results.dailysummaries = summaryUpdated;

  const callRows = await db.collection("legacy_rb_dailycallstats").find({}).toArray();
  let callUpdated = 0;
  for (const row of callRows) {
    const canonical = await resolveCanonicalSource({
      internalName: row.piece,
      sourceName: row.piece,
      rawName: row.piece,
      trackingNumber: row.trackingNumber,
      phone: row.tollFree || row.trackingNumber,
      domain: normalizedDomain,
    });
    if (canonical) {
      const update = {
        canonicalKey: canonical.canonicalKey,
        matchedBy: canonical.matchedBy,
      };
      if (row.piece && row.piece !== canonical.internalName) {
        update.pieceOriginal = row.pieceOriginal || row.piece;
      }
      update.piece = canonical.internalName;
      if (!row.channel) update.channel = canonical.channel;
      await db.collection("legacy_rb_dailycallstats").updateOne({ _id: row._id }, { $set: update });
      callUpdated += 1;
    }
  }
  results.rb_dailycallstats = callUpdated;

  return {
    domain: normalizedDomain,
    updated: results,
    completedAt: new Date().toISOString(),
  };
}

module.exports = {
  canonicalizeMirroredMetrics,
  syncLegacyAttributionMaps,
};
