"use strict";

const { callLedgerRepository, callLogRepository } = require("../../shared-repositories/src");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function normalizeDirection(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "inbound" || normalized === "outbound") return normalized;
  return "unknown";
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildPacificDateKey(value) {
  const date = toDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function buildCallLedgerEntryFromCallLog(callLog = {}, options = {}) {
  const callStartTime =
    toDate(callLog.callStartTime) ||
    toDate(callLog.callEndTime) ||
    toDate(callLog.resolvedAt) ||
    toDate(callLog.createdAt);
  const callEndTime = toDate(callLog.callEndTime);

  return {
    domain: normalizeDomain(callLog.domain),
    telephonySessionId: String(callLog.telephonySessionId || "").trim(),
    date:
      buildPacificDateKey(callStartTime) ||
      buildPacificDateKey(callLog.createdAt) ||
      buildPacificDateKey(new Date()),
    callStartTime,
    callEndTime,
    durationSec: toNumber(callLog.durationSec),
    missed: Boolean(callLog.missed),
    direction: normalizeDirection(callLog.direction),
    phone: callLog.phone || null,
    normalizedPhone: callLog.normalizedPhone || null,
    contactName: callLog.contactName || null,
    extensionId: callLog.extensionId || null,
    agentName: callLog.agentName || null,
    caseId: Number.isFinite(Number(callLog.caseId)) ? Number(callLog.caseId) : null,
    caseDomain: normalizeDomain(callLog.caseDomain || callLog.domain),
    caseProfileId: callLog.caseProfileId || null,
    sourceCanonicalId: callLog.sourceCanonicalId || null,
    sourceName: callLog.sourceName || null,
    sourceChannel: callLog.sourceChannel || null,
    mailPieceKey: callLog.mailPieceKey || null,
    routeCampaignKey: callLog.routeCampaignKey || null,
    routeCampaignName: callLog.routeCampaignName || null,
    strategy: callLog.strategy || null,
    confidence: callLog.confidence || null,
    status: callLog.status || null,
    resolvedAt: toDate(callLog.resolvedAt),
    transcriptionStatus: callLog?.transcription?.status || null,
    transcriptAvailable: Boolean(String(callLog?.transcription?.text || "").trim()),
    recordingAvailable: Boolean(
      String(callLog?.transcription?.recordingUri || "").trim() ||
      String(callLog?.recordingArchive?.driveFileId || "").trim() ||
      String(callLog?.recordingArchive?.driveWebViewLink || "").trim(),
    ),
    transcribedAt: toDate(callLog?.transcription?.transcribedAt),
    recordingArchiveStatus: callLog?.recordingArchive?.status || null,
    scoreOverall: toNumber(callLog?.callScore?.overall),
    scoreVerdict: callLog?.callScore?.lead_verdict || null,
    scoreSummary: callLog?.callScore?.summary || null,
    scoredAt: toDate(callLog?.callScore?.scoredAt),
    callLogUpdatedAt: toDate(callLog.updatedAt),
    syncedAt: toDate(options.syncedAt) || new Date(),
  };
}

async function syncCallLedgerFromCallLog(callLog = {}, options = {}) {
  const entry = buildCallLedgerEntryFromCallLog(callLog, options);
  if (!entry.domain || !entry.telephonySessionId) {
    return { skipped: true, reason: "invalid-calllog" };
  }
  const doc = await callLedgerRepository.upsertCallLedger(entry);
  return {
    skipped: false,
    domain: entry.domain,
    telephonySessionId: entry.telephonySessionId,
    caseId: entry.caseId,
    date: entry.date,
    id: doc?._id ? String(doc._id) : null,
  };
}

async function syncCallLedgerBySession(domain, telephonySessionId, options = {}) {
  const callLog = await callLogRepository.findCallLog(domain, telephonySessionId);
  if (!callLog) {
    return { skipped: true, reason: "calllog-not-found" };
  }
  return syncCallLedgerFromCallLog(callLog, options);
}

module.exports = {
  buildCallLedgerEntryFromCallLog,
  syncCallLedgerBySession,
  syncCallLedgerFromCallLog,
};
