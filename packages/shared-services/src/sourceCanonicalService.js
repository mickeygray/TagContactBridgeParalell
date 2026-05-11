"use strict";

const mongoose = require("mongoose");
const { SourceCanonical } = require("../../shared-models/src");
const {
  resolveMailer,
  resolveMailerByRcExtension,
  resolveMailerByTrackingNumber,
} = require("./mailerConfigService");

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
}

function domainMatches(doc, domain) {
  if (!domain) return true;
  const domains = Array.isArray(doc.domains) ? doc.domains : [];
  if (!domains.length) return true;
  return domains.includes(String(domain).toUpperCase());
}

function matchesQuery(doc, query = {}) {
  const normalizedDomain = String(query.domain || "").toUpperCase();
  if (!domainMatches(doc, normalizedDomain)) return false;

  const aliases = Array.isArray(doc.aliases) ? doc.aliases.map(normalizeText) : [];
  const trackingNumbers = Array.isArray(doc.trackingNumbers)
    ? doc.trackingNumbers.map(normalizeDigits)
    : [];
  const phoneNumbers = Array.isArray(doc.phoneNumbers)
    ? doc.phoneNumbers.map(normalizeDigits)
    : [];
  const rcExtensions = Array.isArray(doc.ringCentralExtensions)
    ? doc.ringCentralExtensions.map((value) => String(value || "").trim())
    : [];
  const sourceIds = Array.isArray(doc.sourceIds) ? doc.sourceIds : [];

  const sourceId = query.sourceId != null ? Number(query.sourceId) : null;
  if (
    Number.isFinite(sourceId) &&
    sourceIds.some(
      (entry) =>
        String(entry.domain || "").toUpperCase() === normalizedDomain &&
        Number(entry.sourceId) === sourceId,
    )
  ) {
    return "sourceId";
  }

  const rawNames = [
    query.internalName,
    query.sourceName,
    query.rawName,
    query.mailHouseName,
    query.trackerName,
    query.queueName,
  ]
    .map(normalizeText)
    .filter(Boolean);

  if (rawNames.some((name) => name === normalizeText(doc.internalName))) {
    return "internalName";
  }

  if (rawNames.some((name) => aliases.includes(name))) {
    return "alias";
  }

  const trackingNumber = normalizeDigits(query.trackingNumber || query.phone || query.mailerPhone);
  if (trackingNumber && trackingNumbers.includes(trackingNumber)) {
    return "trackingNumber";
  }

  const phoneNumber = normalizeDigits(query.phone || query.mailerPhone);
  if (phoneNumber && phoneNumbers.includes(phoneNumber)) {
    return "phoneNumber";
  }

  const extensionId = String(query.extensionId || query.rcExt || "").trim();
  if (extensionId && rcExtensions.includes(extensionId)) {
    return "ringCentralExtension";
  }

  return null;
}

async function listActiveSourceCanonicals(domain) {
  return listSourceCanonicals(domain, { includeInactive: false });
}

async function listSourceCanonicals(domain, options = {}) {
  if (mongoose.connection.readyState !== 1) {
    return [];
  }

  const normalizedDomain = String(domain || "").toUpperCase();
  try {
    const query = {
      $or: [
        { domains: { $size: 0 } },
        { domains: normalizedDomain },
        { domains: { $exists: false } },
      ],
    };
    if (!options.includeInactive) {
      query.active = true;
    }
    const docs = await SourceCanonical.find(query).lean();
    return docs;
  } catch {
    return [];
  }
}

function matchPriority(matchedBy) {
  switch (matchedBy) {
    case "sourceId":
      return 0;
    case "internalName":
      return 1;
    case "alias":
      return 2;
    case "trackingNumber":
      return 3;
    case "phoneNumber":
      return 4;
    case "ringCentralExtension":
      return 5;
    default:
      return 99;
  }
}

async function resolveCanonicalSource(query = {}) {
  const docs = await listSourceCanonicals(query.domain, { includeInactive: true });
  const matches = [];
  for (const doc of docs) {
    const matchedBy = matchesQuery(doc, query);
    if (!matchedBy) continue;
    matches.push({
      canonicalKey: doc.canonicalKey,
      internalName: doc.internalName,
      channel: doc.channel || "unknown",
      active: Boolean(doc.active),
      matchedBy,
      doc,
    });
  }

  matches.sort((left, right) => {
    if (Boolean(left.active) !== Boolean(right.active)) {
      return left.active ? -1 : 1;
    }
    const priorityDiff = matchPriority(left.matchedBy) - matchPriority(right.matchedBy);
    if (priorityDiff !== 0) return priorityDiff;
    const leftUpdated = new Date(left.doc?.updatedAt || left.doc?.createdAt || 0).getTime();
    const rightUpdated = new Date(right.doc?.updatedAt || right.doc?.createdAt || 0).getTime();
    return rightUpdated - leftUpdated;
  });

  if (matches.length > 0) {
    return matches[0];
  }

  if (!query._mailerResolved) {
    const mailerMatch =
      resolveMailerByTrackingNumber(query.trackingNumber || query.phone || query.mailerPhone) ||
      resolveMailerByRcExtension(query.extensionId || query.rcExt) ||
      resolveMailer(query.phone || query.mailerPhone);

    if (mailerMatch) {
      return resolveCanonicalSource({
        ...query,
        _mailerResolved: true,
        internalName: mailerMatch.internalName || query.internalName,
        sourceName: mailerMatch.mailHouseName || query.sourceName,
        trackerName: mailerMatch.crTrackerName || query.trackerName,
        queueName: mailerMatch.rcQueueName || query.queueName,
      });
    }
  }

  return null;
}

module.exports = {
  listSourceCanonicals,
  listActiveSourceCanonicals,
  normalizeDigits,
  normalizeText,
  resolveCanonicalSource,
};
