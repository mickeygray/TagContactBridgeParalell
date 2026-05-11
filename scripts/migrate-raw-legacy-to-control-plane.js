"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  CallLog,
  CaseProfile,
  DailyCallStat,
  LeadCadence,
  MasterProspectIndex,
  PaymentLedger,
  SpendEntry,
} = require("../packages/shared-models/src");
const {
  buildSpendEntryIdentity,
} = require("../packages/shared-repositories/src/spendEntryRepository");

const DEFAULT_DB = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
const BATCH_SIZE = Number(process.env.LEGACY_CONTROL_PLANE_MIGRATION_BATCH_SIZE || 500);

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function readArg(argv, name, fallback = null) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toUpperCase();
  return domain || null;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length >= 10) return digits.slice(-10);
  return null;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateKeyToDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return new Date(`${text}T12:00:00.000Z`);
  }
  return toDate(value);
}

function cleanString(value) {
  const text = String(value || "").trim();
  return text || null;
}

function splitName(name) {
  const text = cleanString(name);
  if (!text) return { firstName: null, lastName: null };
  const parts = text.split(/\s+/);
  return {
    firstName: parts[0] || null,
    lastName: parts.slice(1).join(" ") || null,
  };
}

function syntheticCaseId(row) {
  const seed = String(row?._id || row?.pbContactId || row?.phone || crypto.randomUUID());
  const hex = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return -1 * (parseInt(hex, 16) % 900000000 + 1000000);
}

function validCaseIdOrSynthetic(row) {
  const caseId = Number(row?.caseId);
  if (Number.isFinite(caseId) && caseId > 0) {
    return { caseId, synthetic: false };
  }
  return { caseId: syntheticCaseId(row), synthetic: true };
}

function sourceSnapshot(row, fields) {
  const snapshot = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      snapshot[field] = row[field];
    }
  }
  return snapshot;
}

function buildCaseProfileFromLegacy(row, now) {
  const domain = normalizeDomain(row.domain || row.company);
  const caseId = Number(row.caseId);
  if (!domain || !Number.isFinite(caseId) || caseId <= 0) return null;

  const phone = row.primaryPhone || row.cellPhone || row.phone || row.homePhone || null;
  const normalizedPhone = normalizePhone(phone);
  const firstName = cleanString(row.firstName);
  const lastName = cleanString(row.lastName);
  const name = cleanString(row.name) || [firstName, lastName].filter(Boolean).join(" ") || null;
  const caseCreatedDate = toDate(row.createdInLogicsAt) || toDate(row.caseCreatedDate) || toDate(row.createdAt);
  const firstPaymentDate = toDate(row.firstPaymentDate);
  const initialPayment = toNumber(row.initialPayment, 0);
  const totalPaid = toNumber(row.totalPaid || row.ltv, 0);

  return {
    domain,
    caseId,
    firstName,
    lastName,
    name,
    email: cleanString(row.email),
    primaryPhone: phone || null,
    homePhone: row.homePhone || null,
    normalizedPhones: normalizedPhone ? [normalizedPhone] : [],
    address: cleanString(row.address),
    city: cleanString(row.city),
    state: cleanString(row.state),
    zip: cleanString(row.zip),
    sourceName: cleanString(row.sourceName),
    sourceChannel: cleanString(row.sourceChannel),
    statusId: row.statusId == null ? null : Number(row.statusId),
    statusCategory: cleanString(row.statusCategory) || "prospect",
    caseCreatedDate,
    firstPaymentDate,
    initialPayment,
    totalPaid,
    paymentsCount: toNumber(row.paymentsCount, 0),
    lastPaymentAmount: toNumber(row.lastPaymentAmount, 0),
    callHistorySummary: {
      totalCalls: toNumber(row.totalCalls, 0),
      inboundCalls: toNumber(row.totalInbound, 0),
      outboundCalls: Math.max(toNumber(row.totalCalls, 0) - toNumber(row.totalInbound, 0), 0),
      callsOver2: 0,
      callsOver5: 0,
      uniquePhoneCount: normalizedPhone ? 1 : 0,
      recentCalls: [],
    },
    paymentReconcile: {
      lastCheckedAt: toDate(row.lastSweepAt),
      lastResult: row.lastSweepAt ? "legacy-sweep-migrated" : null,
    },
    createdAt: toDate(row.createdAt) || caseCreatedDate || now,
    updatedAt: now,
  };
}

function buildMasterProspectFromProfile(row, now) {
  const profile = buildCaseProfileFromLegacy(row, now);
  if (!profile) return null;
  return {
    domain: profile.domain,
    caseId: profile.caseId,
    statusId: profile.statusId,
    statusLabelRaw: cleanString(row.statusLabel),
    statusCategory: profile.statusCategory || "prospect",
    sourceId: row.sourceId == null ? null : Number(row.sourceId),
    firstName: profile.firstName,
    lastName: profile.lastName,
    name: profile.name,
    email: profile.email,
    cellPhone: profile.primaryPhone,
    normalizedPhones: profile.normalizedPhones,
    address: profile.address,
    city: profile.city,
    state: profile.state,
    zip: profile.zip,
    firstSeenAt: profile.caseCreatedDate || profile.createdAt || now,
    lastSeenAt: now,
    convertedAt: profile.initialPayment > 0 ? profile.firstPaymentDate || profile.caseCreatedDate || now : null,
    metadata: {
      intakeSource: cleanString(row.sourceName),
      sourceName: cleanString(row.sourceName),
      sourceChannel: cleanString(row.sourceChannel),
      notes: ["migrated-from-rb_caseprofiles"],
    },
    createdAt: profile.createdAt,
    updatedAt: now,
  };
}

function buildLeadCadence(row, now) {
  const domain = normalizeDomain(row.domain || row.company);
  if (!domain) return null;
  const identity = validCaseIdOrSynthetic(row);
  const phone = row.primaryPhone || row.phone || row.cellPhone || null;
  const normalizedPhone = normalizePhone(phone);
  const nameParts = splitName(row.name);
  const firstName = cleanString(row.firstName) || nameParts.firstName;
  const lastName = cleanString(row.lastName) || nameParts.lastName;
  const createdAt = toDate(row.createdAt) || now;

  return {
    domain,
    caseId: identity.caseId,
    externalLeadId: cleanString(row.externalLeadId) || cleanString(row.pbContactId) || `legacy-leadcadence-${row._id}`,
    intakeRoute: cleanString(row.intakeRoute) || cleanString(row.source) || "legacy",
    intakeSource: cleanString(row.intakeSource) || cleanString(row.source) || "legacy",
    partnerSource: cleanString(row.partnerSource) || cleanString(row.source),
    firstName,
    lastName,
    name: cleanString(row.name) || [firstName, lastName].filter(Boolean).join(" ") || null,
    email: cleanString(row.email),
    primaryPhone: phone || null,
    normalizedPhone,
    city: cleanString(row.city),
    state: cleanString(row.state),
    sourceName: cleanString(row.source),
    sourceChannel: cleanString(row.sourceChannel),
    vendorSourceName: cleanString(row.vendorSourceName) || cleanString(row.source),
    statusId: row.statusId == null ? null : Number(row.statusId),
    active: row.active !== false,
    currentStage: cleanString(row.pbCurrentFolder) || (row.active === false ? "inactive" : "legacy"),
    cadenceMode: "legacy-time-count",
    cadenceCounters: {
      sms: toNumber(row.textsSent, 0),
      email: toNumber(row.emailsSent, 0),
      rvm: toNumber(row.rvmsSent, 0),
      cx: toNumber(row.callsMade, 0),
    },
    lastTouched: {
      sms: toDate(row.lastTextedAt),
      email: toDate(row.lastEmailedAt),
      rvm: toDate(row.lastRvmAt) || toDate(row.lastRvmActivityAt),
      cx: toDate(row.lastCalledAt),
    },
    counterCadence: {
      locks: {},
      deferUntil: {},
      lastDailyBatchKey: {},
      lastDispatchAt: toDate(row.updatedAt),
      lastFailureAt: null,
      lastResult: {
        lastLogicsStatus: row.lastLogicsStatus || null,
        pbCurrentFolder: row.pbCurrentFolder || null,
        pbPushed: Boolean(row.pbPushed),
        syntheticCaseId: identity.synthetic,
      },
      rvmDeliveries: row.lastRvmActivityToken
        ? [{ activityToken: row.lastRvmActivityToken, migratedAt: now }]
        : [],
    },
    firstContactRequestedAt: toDate(row.createdAt),
    firstContactEventId: null,
    schedule: {
      planVersion: "legacy-time-count-v1",
      timezone: "America/Los_Angeles",
      nextActionType: cleanString(row.nextOutreachType),
      nextActionAt: null,
      actions: [],
    },
    cadenceState: {
      caps: {},
      completedByChannel: {},
      failedByChannel: {},
      pendingByChannel: {},
      exhaustedChannels: [],
      engagementChannelsExhausted: false,
      nextChannel: cleanString(row.nextOutreachType),
      lastCompletedAtByChannel: {},
      lastEvaluatedAt: now,
      channelDnc: {},
      dncCheck: null,
    },
    validationContext: {
      ...(row.validationDetails || {}),
      phoneConnected: row.phoneConnected == null ? null : Boolean(row.phoneConnected),
      phoneIsCell: row.phoneIsCell == null ? null : Boolean(row.phoneIsCell),
      emailValid: row.emailValid == null ? null : Boolean(row.emailValid),
      source: "legacy-leadcadences",
    },
    attributionContext: {
      source: cleanString(row.source),
      pbContactId: cleanString(row.pbContactId),
      pbCurrentFolder: cleanString(row.pbCurrentFolder),
      legacyCaseId: Number(row.caseId) || 0,
      syntheticCaseId: identity.synthetic,
    },
    payloadSnapshot: sourceSnapshot(row, [
      "_id",
      "_mirrorRunId",
      "_mirroredAt",
      "company",
      "caseId",
      "source",
      "pbContactId",
      "pbCurrentFolder",
      "pbPushed",
      "pbPushedAt",
      "caseAge",
      "caseAgeUpdatedDate",
      "lastLogicsCheckAt",
      "lastLogicsStatus",
    ]),
    createdAt,
    updatedAt: now,
  };
}

function buildMasterProspectFromLead(row, now) {
  const cadence = buildLeadCadence(row, now);
  if (!cadence) return null;
  return {
    domain: cadence.domain,
    caseId: cadence.caseId,
    statusId: cadence.statusId,
    statusLabelRaw: null,
    statusCategory: "prospect",
    firstName: cadence.firstName,
    lastName: cadence.lastName,
    name: cadence.name,
    email: cadence.email,
    cellPhone: cadence.primaryPhone,
    normalizedPhones: cadence.normalizedPhone ? [cadence.normalizedPhone] : [],
    city: cadence.city,
    state: cadence.state,
    intakeRoute: cadence.intakeRoute,
    partnerSource: cadence.partnerSource,
    firstSeenAt: cadence.createdAt || now,
    lastSeenAt: now,
    needsStatusRefresh: !cadence.attributionContext.syntheticCaseId,
    needsSourceRefresh: !cadence.attributionContext.syntheticCaseId,
    metadata: {
      intakeSource: cadence.intakeSource,
      sourceName: cadence.sourceName,
      sourceChannel: cadence.sourceChannel,
      vendorSourceName: cadence.vendorSourceName,
      notes: ["migrated-from-leadcadences"],
      validation: cadence.validationContext,
    },
    createdAt: cadence.createdAt,
    updatedAt: now,
  };
}

function buildCaseProfileFromLead(row, now) {
  const cadence = buildLeadCadence(row, now);
  if (!cadence) return null;
  return {
    domain: cadence.domain,
    caseId: cadence.caseId,
    firstName: cadence.firstName,
    lastName: cadence.lastName,
    name: cadence.name,
    email: cadence.email,
    primaryPhone: cadence.primaryPhone,
    normalizedPhones: cadence.normalizedPhone ? [cadence.normalizedPhone] : [],
    city: cadence.city,
    state: cadence.state,
    sourceName: cadence.sourceName,
    sourceChannel: cadence.sourceChannel,
    statusId: cadence.statusId,
    statusCategory: "prospect",
    caseCreatedDate: cadence.attributionContext.syntheticCaseId ? null : cadence.createdAt,
    paymentReconcile: {
      lastCheckedAt: null,
      lastResult: cadence.attributionContext.syntheticCaseId ? "legacy-lead-without-logics-case" : null,
    },
    createdAt: cadence.createdAt,
    updatedAt: now,
  };
}

function buildPayment(row, lookup, now) {
  const domain = normalizeDomain(row.domain || row.company);
  const caseId = Number(row.caseId);
  const casePaymentId = Number(row.casePaymentId || row.paymentId);
  const paymentDateKey = cleanString(row.date);
  const paymentDate = dateKeyToDate(paymentDateKey || row.paymentDate || row.recordedAt);
  if (!domain || !Number.isFinite(caseId) || caseId <= 0 || !Number.isFinite(casePaymentId) || !paymentDateKey || !paymentDate) {
    return null;
  }
  const link = lookup.get(`${domain}:${caseId}`) || {};
  const paymentType = ["initial", "recurring", "unknown"].includes(String(row.type || "").toLowerCase())
    ? String(row.type || "").toLowerCase()
    : "unknown";
  return {
    domain,
    caseId,
    casePaymentId,
    paymentDate,
    paymentDateKey,
    amount: toNumber(row.amount, 0),
    paymentType,
    transactionStatus: cleanString(row.transactionStatus) || "SUCCESS",
    caseProfileId: link.caseProfileId || null,
    masterProspectId: link.masterProspectId || null,
    needsSourceReview: Boolean(row.needsSourceReview),
    reviewReason: row.needsSourceReview ? "legacy-needs-source-review" : null,
    recordedAt: toDate(row.recordedAt) || toDate(row.createdAt) || now,
    raw: sourceSnapshot(row, [
      "_id",
      "domain",
      "caseId",
      "casePaymentId",
      "date",
      "amount",
      "type",
      "sourceName",
      "sourceChannel",
      "needsSourceReview",
      "recordedAt",
    ]),
    createdAt: toDate(row.createdAt) || now,
    updatedAt: now,
  };
}

function buildSpend(row, now) {
  const domain = normalizeDomain(row.domain || row.company);
  const date = cleanString(row.date);
  const channel = cleanString(row.channel) || "unknown";
  const source = cleanString(row.source) || "Unknown";
  if (!domain || !date) return null;
  return {
    date,
    domain,
    channel,
    source,
    sheetId: cleanString(row.sheetId),
    spend: toNumber(row.spend, 0),
    postage: toNumber(row.postage, 0),
    cost: toNumber(row.cost, 0),
    pieces: toNumber(row.pieces, 0),
    impressions: toNumber(row.impressions, 0),
    clicks: toNumber(row.clicks, 0),
    leadsReported: toNumber(row.leadsReported, 0),
    jobNumber: cleanString(row.jobNumber),
    jobName: cleanString(row.jobName),
    phone: cleanString(row.phone),
    form: cleanString(row.form),
    stream: cleanString(row.stream),
    reach: toNumber(row.reach, 0),
    allClicks: toNumber(row.allClicks, 0),
    resultType: cleanString(row.resultType),
    landingPageViews: toNumber(row.landingPageViews, 0),
    campaign: cleanString(row.campaign),
    platform: cleanString(row.platform),
    adSet: cleanString(row.adSet),
    adName: cleanString(row.adName),
    leadsAccepted: toNumber(row.leadsAccepted, 0),
    costPerLead: toNumber(row.costPerLead, 0),
    metaCampaignId: cleanString(row.metaCampaignId),
    metaAdsetId: cleanString(row.metaAdsetId),
    metaAdId: cleanString(row.metaAdId),
    broadcastId: cleanString(row.broadcastId),
    broadcastName: cleanString(row.broadcastName),
    syncedAt: toDate(row.syncedAt) || now,
    raw: row.raw || sourceSnapshot(row, ["_id", "domain", "date", "channel", "source"]),
    createdAt: toDate(row.createdAt) || now,
    updatedAt: now,
  };
}

function buildSpendMigrationFilter(doc) {
  const identity = buildSpendEntryIdentity(doc);
  if (!doc.broadcastId && !doc.campaign && !doc.adName) {
    return identity;
  }

  // A previous migration pass keyed dialer/social rows by plain source
  // before carrying broadcast/campaign/ad identity over. Match that
  // source-only row once, then the canonical identity owns future reruns.
  const sourceOnlyIdentity = {
    date: doc.date,
    domain: doc.domain,
    channel: doc.channel,
    sheetId: doc.sheetId || null,
    source: doc.source || "",
    broadcastId: { $in: [null, ""] },
    campaign: { $in: [null, ""] },
    adName: { $in: [null, ""] },
    jobNumber: { $in: [null, ""] },
  };

  return {
    $or: [
      identity,
      sourceOnlyIdentity,
    ],
  };
}

function buildDailyCallStat(row, now) {
  const date = cleanString(row.date);
  const piece = cleanString(row.piece);
  if (!date || !piece) return null;
  const totalCalls = toNumber(row.totalCalls, 0);
  const totalDuration = toNumber(row.totalDuration, 0);
  return {
    date,
    piece,
    tollFree: cleanString(row.tollFree),
    trackingNumber: cleanString(row.trackingNumber),
    channel: cleanString(row.channel) || "mailer",
    totalCalls,
    callsOver5: toNumber(row.callsOver5, 0),
    callsOver2: toNumber(row.callsOver2, 0),
    totalDuration,
    avgDuration: row.avgDuration == null
      ? (totalCalls > 0 ? totalDuration / totalCalls : 0)
      : toNumber(row.avgDuration, 0),
    uniqueCallers: toNumber(row.uniqueCallers, 0),
    firstCallTime: cleanString(row.firstCallTime),
    lastCallTime: cleanString(row.lastCallTime),
    syncedAt: toDate(row.syncedAt) || now,
    raw: sourceSnapshot(row, [
      "_id",
      "date",
      "piece",
      "channel",
      "trackingNumber",
      "totalCalls",
      "callsOver2",
      "callsOver5",
    ]),
    createdAt: toDate(row.createdAt) || now,
    updatedAt: now,
  };
}

function firstCaseMatch(row) {
  const matches = Array.isArray(row.allMatches) ? row.allMatches : [];
  return matches.find((match) => Number.isFinite(Number(match?.caseId))) || null;
}

function buildCallLog(row, lookup, now) {
  const domain = normalizeDomain(row.domain || row.company);
  if (!domain) return null;
  const telephonySessionId = cleanString(row.telephonySessionId) || `legacy-contactactivity-${row._id}`;
  const phone = cleanString(row.phoneFormatted) || cleanString(row.phone);
  const normalizedPhone = normalizePhone(phone);
  const directionRaw = cleanString(row.direction);
  const direction = directionRaw ? directionRaw.toLowerCase() : "unknown";
  const match = firstCaseMatch(row);
  const matchedDomain = normalizeDomain(match?.domain || domain);
  const matchedCaseId = Number(match?.caseId);
  const link = Number.isFinite(matchedCaseId)
    ? lookup.get(`${matchedDomain}:${matchedCaseId}`) || {}
    : {};
  const enrichmentStatus = cleanString(row.enrichmentStatus);
  const resolved = enrichmentStatus === "matched" && Number.isFinite(matchedCaseId);

  return {
    domain,
    telephonySessionId,
    callSessionId: cleanString(row.callSessionId),
    callStartTime: toDate(row.callStartTime) || toDate(row.createdAt),
    callEndTime: toDate(row.callEndTime),
    durationSec: row.durationSec == null
      ? (row.durationSeconds == null ? null : toNumber(row.durationSeconds, null))
      : toNumber(row.durationSec, null),
    missed: toNumber(row.durationSeconds, 0) <= 0,
    direction: ["inbound", "outbound"].includes(direction) ? direction : "unknown",
    phone,
    normalizedPhone,
    contactName: cleanString(row.contactName),
    extensionId: cleanString(row.extensionId),
    agentName: cleanString(row.agentName),
    caseId: Number.isFinite(matchedCaseId) ? matchedCaseId : null,
    caseDomain: Number.isFinite(matchedCaseId) ? matchedDomain : null,
    caseProfileId: link.caseProfileId || null,
    sourceName: cleanString(row.sourceName),
    sourceChannel: cleanString(row.sourceChannel),
    strategy: resolved ? "legacy" : "none",
    confidence: resolved ? "high" : "none",
    status: resolved ? "resolved" : "unresolvable",
    retryAttempts: toNumber(row.enrichmentAttempts, 0),
    lastRetryAt: toDate(row.lastEnrichmentAt),
    resolvedAt: resolved ? toDate(row.lastEnrichmentAt) || toDate(row.updatedAt) || now : null,
    resolverActor: "import",
    attempts: {
      legacyEnrichmentStatus: enrichmentStatus,
      legacyMatches: Array.isArray(row.allMatches) ? row.allMatches : [],
      migratedAt: now,
    },
    transcription: row.transcription || { status: "pending" },
    callScore: row.callScore || {},
    createdAt: toDate(row.createdAt) || now,
    updatedAt: now,
  };
}

function chunk(items, size = BATCH_SIZE) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function uniqueByIdentity(docs) {
  const byKey = new Map();
  for (const doc of docs) {
    if (!doc?.domain || !Number.isFinite(Number(doc.caseId))) continue;
    const key = `${doc.domain}:${Number(doc.caseId)}`;
    if (!byKey.has(key)) {
      byKey.set(key, doc);
      continue;
    }

    const current = byKey.get(key);
    byKey.set(key, {
      ...doc,
      ...current,
      metadata: {
        ...(doc.metadata || {}),
        ...(current.metadata || {}),
        notes: [
          ...new Set([
            ...((doc.metadata && doc.metadata.notes) || []),
            ...((current.metadata && current.metadata.notes) || []),
          ]),
        ],
      },
      normalizedPhones: Array.from(new Set([
        ...((doc.normalizedPhones || []).filter(Boolean)),
        ...((current.normalizedPhones || []).filter(Boolean)),
      ])),
    });
  }
  return Array.from(byKey.values());
}

function omitKeys(doc, keys = []) {
  const omit = new Set(keys);
  return Object.fromEntries(
    Object.entries(doc || {}).filter(([key]) => !omit.has(key)),
  );
}

async function bulkWrite(collection, operations, commit, label) {
  if (!operations.length) {
    return { label, skipped: 0, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }
  if (!commit) {
    return {
      label,
      skipped: 0,
      dryRunOperations: operations.length,
      matchedCount: 0,
      modifiedCount: 0,
      upsertedCount: 0,
    };
  }

  const result = {
    label,
    matchedCount: 0,
    modifiedCount: 0,
    upsertedCount: 0,
    errors: [],
  };
  for (const batch of chunk(operations)) {
    try {
      const writeResult = await collection.bulkWrite(batch, { ordered: false });
      result.matchedCount += writeResult.matchedCount || 0;
      result.modifiedCount += writeResult.modifiedCount || 0;
      result.upsertedCount += writeResult.upsertedCount || 0;
    } catch (error) {
      result.errors.push(error.message);
      if (Array.isArray(error.writeErrors) && error.writeErrors.length > 0) {
        for (const writeError of error.writeErrors.slice(0, 5)) {
          result.errors.push(writeError.errmsg || writeError.message);
        }
      }
    }
  }
  return result;
}

async function countByDomain(collection, domainField = "domain") {
  return collection.aggregate([
    {
      $group: {
        _id: { $ifNull: [`$${domainField}`, "(none)"] },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]).toArray();
}

async function buildCaseLookup() {
  const lookup = new Map();
  const [profiles, prospects] = await Promise.all([
    CaseProfile.find({}, { _id: 1, domain: 1, caseId: 1 }).lean(),
    MasterProspectIndex.find({}, { _id: 1, domain: 1, caseId: 1 }).lean(),
  ]);
  for (const doc of profiles) {
    lookup.set(`${normalizeDomain(doc.domain)}:${Number(doc.caseId)}`, {
      ...(lookup.get(`${normalizeDomain(doc.domain)}:${Number(doc.caseId)}`) || {}),
      caseProfileId: doc._id,
    });
  }
  for (const doc of prospects) {
    lookup.set(`${normalizeDomain(doc.domain)}:${Number(doc.caseId)}`, {
      ...(lookup.get(`${normalizeDomain(doc.domain)}:${Number(doc.caseId)}`) || {}),
      masterProspectId: doc._id,
    });
  }
  return lookup;
}

async function main() {
  const argv = process.argv.slice(2);
  const commit = hasFlag(argv, "--commit");
  const limit = Number(readArg(argv, "--limit", 0)) || 0;
  const dbName = readArg(argv, "--db", DEFAULT_DB);
  const now = new Date();

  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }

  await mongoose.connect(process.env.MONGO_URI, { dbName });
  const db = mongoose.connection.db;

  console.log("Raw legacy -> ControlPlane migration");
  console.log(`  db:      ${db.databaseName}`);
  console.log(`  mode:    ${commit ? "COMMIT" : "DRY-RUN"}`);
  console.log(`  limit:   ${limit || "(none)"}`);

  const raw = {
    caseProfiles: await db.collection("rb_caseprofiles").find({}).limit(limit || 0).toArray(),
    leadCadences: await db.collection("leadcadences").find({}).limit(limit || 0).toArray(),
    payments: await db.collection("dailypaymentsummaries").find({}).limit(limit || 0).toArray(),
    spends: await db.collection("dailyspends").find({}).limit(limit || 0).toArray(),
    dailyCallStats: await db.collection("rb_dailycallstats").find({}).limit(limit || 0).toArray(),
    contactActivities: await db.collection("rb_contactactivities").find({}).limit(limit || 0).toArray(),
  };

  const before = {
    rb_caseprofiles: await db.collection("rb_caseprofiles").countDocuments(),
    controlplanecaseprofiles: await CaseProfile.countDocuments(),
    leadcadences: await db.collection("leadcadences").countDocuments(),
    controlplaneleadcadences: await LeadCadence.countDocuments(),
    dailypaymentsummaries: await db.collection("dailypaymentsummaries").countDocuments(),
    controlplanepaymentledgers: await PaymentLedger.countDocuments(),
    dailyspends: await db.collection("dailyspends").countDocuments(),
    controlplanespendentries: await SpendEntry.countDocuments(),
    rb_dailycallstats: await db.collection("rb_dailycallstats").countDocuments(),
    controlplanedailycallstats: await DailyCallStat.countDocuments(),
    rb_contactactivities: await db.collection("rb_contactactivities").countDocuments(),
    controlplanecalllogs: await CallLog.countDocuments(),
    controlplanemasterprospectindexes: await MasterProspectIndex.countDocuments(),
  };

  const caseProfileDocs = raw.caseProfiles.map((row) => buildCaseProfileFromLegacy(row, now)).filter(Boolean);
  const caseProfileOps = caseProfileDocs.map((doc) => ({
    updateOne: {
      filter: { domain: doc.domain, caseId: doc.caseId },
      update: {
        $setOnInsert: omitKeys(doc, ["updatedAt"]),
        $set: { updatedAt: now },
      },
      upsert: true,
    },
  }));

  const masterFromProfiles = raw.caseProfiles.map((row) => buildMasterProspectFromProfile(row, now)).filter(Boolean);
  const leadDocs = raw.leadCadences.map((row) => buildLeadCadence(row, now)).filter(Boolean);
  const masterFromLeads = raw.leadCadences.map((row) => buildMasterProspectFromLead(row, now)).filter(Boolean);
  const caseProfilesFromLeads = raw.leadCadences.map((row) => buildCaseProfileFromLead(row, now)).filter(Boolean);

  const masterDocs = uniqueByIdentity([...masterFromProfiles, ...masterFromLeads]);
  const masterOps = masterDocs.map((doc) => ({
    updateOne: {
      filter: { domain: doc.domain, caseId: doc.caseId },
      update: {
        $setOnInsert: omitKeys(doc, ["lastSeenAt", "updatedAt"]),
        $set: { lastSeenAt: now, updatedAt: now },
      },
      upsert: true,
    },
  }));

  const leadCaseProfileOps = caseProfilesFromLeads.map((doc) => ({
    updateOne: {
      filter: { domain: doc.domain, caseId: doc.caseId },
      update: {
        $setOnInsert: omitKeys(doc, ["updatedAt"]),
        $set: { updatedAt: now },
      },
      upsert: true,
    },
  }));

  const leadOps = leadDocs.map((doc) => ({
    updateOne: {
      filter: { domain: doc.domain, caseId: doc.caseId },
      update: {
        $set: doc,
      },
      upsert: true,
    },
  }));

  const writeResults = [];
  writeResults.push(await bulkWrite(CaseProfile.collection, caseProfileOps, commit, "case profiles from rb_caseprofiles"));
  writeResults.push(await bulkWrite(MasterProspectIndex.collection, masterOps, commit, "master prospects from profiles + cadences"));
  writeResults.push(await bulkWrite(CaseProfile.collection, leadCaseProfileOps, commit, "case profiles from leadcadences"));
  writeResults.push(await bulkWrite(LeadCadence.collection, leadOps, commit, "lead cadences"));

  const lookup = commit ? await buildCaseLookup() : new Map();

  const paymentDocs = raw.payments.map((row) => buildPayment(row, lookup, now)).filter(Boolean);
  const paymentOps = paymentDocs.map((doc) => ({
    updateOne: {
      filter: { casePaymentId: doc.casePaymentId },
      update: { $set: doc },
      upsert: true,
    },
  }));
  writeResults.push(await bulkWrite(PaymentLedger.collection, paymentOps, commit, "payment ledger"));

  const spendDocs = raw.spends.map((row) => buildSpend(row, now)).filter(Boolean);
  const spendOps = spendDocs.map((doc) => ({
    updateOne: {
      filter: buildSpendMigrationFilter(doc),
      update: { $set: doc },
      upsert: true,
    },
  }));
  writeResults.push(await bulkWrite(SpendEntry.collection, spendOps, commit, "spend entries"));

  const callStatDocs = raw.dailyCallStats.map((row) => buildDailyCallStat(row, now)).filter(Boolean);
  const callStatOps = callStatDocs.map((doc) => ({
    updateOne: {
      filter: { date: doc.date, piece: doc.piece },
      update: { $set: doc },
      upsert: true,
    },
  }));
  writeResults.push(await bulkWrite(DailyCallStat.collection, callStatOps, commit, "daily call stats"));

  const lookupAfterMetrics = commit ? await buildCaseLookup() : lookup;
  const callLogDocs = raw.contactActivities.map((row) => buildCallLog(row, lookupAfterMetrics, now)).filter(Boolean);
  const callLogOps = callLogDocs.map((doc) => ({
    updateOne: {
      filter: { domain: doc.domain, telephonySessionId: doc.telephonySessionId },
      update: {
        $setOnInsert: doc,
      },
      upsert: true,
    },
  }));
  writeResults.push(await bulkWrite(CallLog.collection, callLogOps, commit, "call logs from rb_contactactivities"));

  const after = {
    controlplanecaseprofiles: await CaseProfile.countDocuments(),
    controlplaneleadcadences: await LeadCadence.countDocuments(),
    controlplanepaymentledgers: await PaymentLedger.countDocuments(),
    controlplanespendentries: await SpendEntry.countDocuments(),
    controlplanedailycallstats: await DailyCallStat.countDocuments(),
    controlplanecalllogs: await CallLog.countDocuments(),
    controlplanemasterprospectindexes: await MasterProspectIndex.countDocuments(),
  };

  const report = {
    mode: commit ? "commit" : "dry-run",
    db: db.databaseName,
    migratedAt: now.toISOString(),
    before,
    sourceLoaded: Object.fromEntries(Object.entries(raw).map(([key, rows]) => [key, rows.length])),
    transformed: {
      caseProfiles: caseProfileDocs.length,
      leadCadences: leadDocs.length,
      syntheticLeadCaseIds: leadDocs.filter((doc) => doc.attributionContext?.syntheticCaseId).length,
      masterProspects: masterDocs.length,
      payments: paymentDocs.length,
      spends: spendDocs.length,
      dailyCallStats: callStatDocs.length,
      callLogs: callLogDocs.length,
    },
    writeResults,
    after,
    domains: {
      rawCaseProfiles: await countByDomain(db.collection("rb_caseprofiles"), "domain"),
      controlPlaneCaseProfiles: await countByDomain(CaseProfile.collection, "domain"),
      rawLeadCadences: await countByDomain(db.collection("leadcadences"), "company"),
      controlPlaneLeadCadences: await countByDomain(LeadCadence.collection, "domain"),
      rawContactActivities: await countByDomain(db.collection("rb_contactactivities"), "company"),
      controlPlaneCallLogs: await countByDomain(CallLog.collection, "domain"),
    },
  };

  const reportDir = path.resolve(__dirname, "..", "ops");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(
    reportDir,
    `raw-legacy-control-plane-migration-${now.toISOString().replace(/[:.]/g, "-")}.json`,
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("\nWrite results:");
  for (const result of writeResults) {
    console.log(
      `  ${result.label}: ops=${result.dryRunOperations ?? ""} matched=${result.matchedCount || 0} modified=${result.modifiedCount || 0} upserted=${result.upsertedCount || 0}`,
    );
    if (result.errors?.length) {
      console.log(`    errors: ${result.errors.slice(0, 3).join(" | ")}`);
    }
  }

  console.log("\nCounts:");
  console.log(JSON.stringify({ before, transformed: report.transformed, after }, null, 2));
  console.log(`\nReport: ${reportPath}`);

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error);
    try {
      await mongoose.disconnect();
    } catch (_) {
      // noop
    }
    process.exit(1);
  });
}

module.exports = {
  buildCallLog,
  buildCaseProfileFromLegacy,
  buildDailyCallStat,
  buildLeadCadence,
  buildPayment,
  buildSpend,
  buildSpendMigrationFilter,
  syntheticCaseId,
  validCaseIdOrSynthetic,
};
