"use strict";

const { EventRecord } = require("../../event-core/src");
const {
  CallLog,
  CxDialQueue,
  LeadCadence,
} = require("../../shared-models/src");
const {
  callLogRepository,
} = require("../../shared-repositories/src");
const {
  syncCallLedgerFromCallLog,
} = require("./callLedgerService");
const {
  buildTimezoneDateWindow,
} = require("./timezoneDateWindowService");

const DEFAULT_TIMEZONE = "America/Los_Angeles";

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeDomains(domains = null) {
  if (!Array.isArray(domains) || domains.length === 0) return [];
  return [...new Set(domains.map(normalizeDomain).filter(Boolean))];
}

function normalizeExternalId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length >= 10) return digits.slice(-10);
  return digits || null;
}

function buildSyntheticCxSessionId(queueItemId, placedAt = new Date()) {
  const id = normalizeExternalId(queueItemId);
  if (!id) return null;
  const date = toDate(placedAt) || new Date();
  return `cx-synth:${id}:${date.getTime()}`;
}

function pacificDateKey(value) {
  const date = toDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function ringcxSessionDateKey(value) {
  const match = String(value || "").trim().match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function isMetadataSessionIdCompatible(value, placedAt) {
  const sessionDateKey = ringcxSessionDateKey(value);
  if (!sessionDateKey) return Boolean(normalizeExternalId(value));
  return sessionDateKey === pacificDateKey(placedAt);
}

function pickFirstDate(...values) {
  for (const value of values) {
    const date = toDate(value);
    if (date) return date;
  }
  return null;
}

function inWindow(date, start, end) {
  return date && date >= start && date <= end;
}

function pickTerminalOutcome(queueItem = {}) {
  const metadata = queueItem.metadata || {};
  return String(
    metadata.lastTerminalOutcomeNormalized ||
      metadata.lastTerminalOutcome ||
      metadata.lastDisposition ||
      "",
  ).trim().toLowerCase();
}

function isMissedOutcome(outcome) {
  return [
    "no_answer",
    "no-answer",
    "voicemail",
    "answering_machine",
    "busy",
    "failed",
    "cancelled",
  ].includes(String(outcome || "").trim().toLowerCase());
}

function pickRingcxStamp(metadata = {}) {
  return {
    agentId: metadata.rcxVisibilityAgentId ? String(metadata.rcxVisibilityAgentId) : null,
    agentGroupId: metadata.rcxVisibilityAgentGroupId ? String(metadata.rcxVisibilityAgentGroupId) : null,
    agentUsername: metadata.rcxVisibilityAgentUsername || null,
    campaignId: metadata.rcxVisibilityCampaignId ? String(metadata.rcxVisibilityCampaignId) : null,
    dialGroupId: metadata.rcxVisibilityDialGroupId ? String(metadata.rcxVisibilityDialGroupId) : null,
    accountId: metadata.rcxVisibilityAccountId ? String(metadata.rcxVisibilityAccountId) : null,
    externId: metadata.rcxVisibilityExternId || null,
  };
}

function pickSessionId(queueItem, startedAt) {
  const metadata = queueItem.metadata || {};
  const metadataIds = [
    metadata.lastQueueAttemptUii,
    metadata.lastTerminalOutcomeUii,
    metadata.lastDialExecutionUii,
    metadata.lastRingcxMonitorUii,
  ].map(normalizeExternalId).filter(Boolean);
  const compatible = metadataIds.find((value) => isMetadataSessionIdCompatible(value, startedAt));
  return compatible || buildSyntheticCxSessionId(queueItem._id, startedAt);
}

function pickEventSessionId(event = {}, queueItem = {}, startedAt) {
  const payload = event.payload || {};
  const explicit = normalizeExternalId(
    payload.uii ||
      payload.telephonySessionId ||
      payload.callSessionId ||
      payload.sessionId ||
      payload.dialogId ||
      payload.interactionId,
  );
  if (explicit && isMetadataSessionIdCompatible(explicit, startedAt)) return explicit;
  return buildSyntheticCxSessionId(payload.queueItemId || payload.queueTicketId || queueItem?._id, startedAt);
}

function compactObject(input = {}) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

async function recoverCxCallLogs({ start, end, dryRun = false, limit = 25000, domains = null, logger = null } = {}) {
  const startDate = toDate(start);
  const endDate = toDate(end);
  if (!startDate || !endDate) {
    throw new Error("start and end dates are required");
  }
  const selectedDomains = normalizeDomains(domains);
  const domainFilter = selectedDomains.length > 0
    ? { "payload.domain": { $in: selectedDomains } }
    : {};

  const placedEvents = await EventRecord.find(
    {
      eventType: "cx.call.placed",
      createdAt: { $gte: startDate, $lte: endDate },
      ...domainFilter,
    },
    {
      eventType: 1,
      sourceService: 1,
      payload: 1,
      status: 1,
      createdAt: 1,
      processedAt: 1,
      dedupeKey: 1,
      lastError: 1,
    },
  )
    .sort({ createdAt: -1 })
    .limit(Math.max(Number(limit) || 25000, 1))
    .lean();

  const eventQueueIds = [...new Set(
    placedEvents
      .map((event) => normalizeExternalId(event.payload?.queueItemId || event.payload?.queueTicketId))
      .filter(Boolean),
  )];

  const queueFilters = [
    { lastPlacedAt: { $gte: startDate, $lte: endDate } },
    { "metadata.lastQueueAttemptAt": { $gte: startDate, $lte: endDate } },
    { "metadata.lastTerminalOutcomeAt": { $gte: startDate, $lte: endDate } },
    { updatedAt: { $gte: startDate, $lte: endDate }, placedCalls: { $gt: 0 } },
    ...(eventQueueIds.length > 0 ? [{ _id: { $in: eventQueueIds } }] : []),
  ];
  const queueQuery = {
    $or: queueFilters,
    ...(selectedDomains.length > 0 ? { domain: { $in: selectedDomains } } : {}),
  };

  const candidates = await CxDialQueue.find(
    queueQuery,
    {
      domain: 1,
      caseId: 1,
      phone: 1,
      sourceName: 1,
      sourceChannel: 1,
      intakeRoute: 1,
      assignment: 1,
      metadata: 1,
      lastPlacedAt: 1,
      placedCalls: 1,
      state: 1,
      updatedAt: 1,
      createdAt: 1,
    },
  )
    .sort({ updatedAt: -1 })
    .limit(Math.max(Number(limit) || 25000, 1))
    .lean();

  const queueById = new Map(candidates.map((row) => [String(row._id), row]));

  const leadKeys = new Map();
  for (const row of candidates) {
    const domain = normalizeDomain(row.domain);
    const caseId = Number(row.caseId);
    if (domain && Number.isFinite(caseId)) leadKeys.set(`${domain}:${caseId}`, { domain, caseId });
  }

  const leadsByKey = new Map();
  for (const domain of [...new Set([...leadKeys.values()].map((item) => item.domain))]) {
    const caseIds = [...leadKeys.values()]
      .filter((item) => item.domain === domain)
      .map((item) => item.caseId);
    if (caseIds.length === 0) continue;
    const leads = await LeadCadence.find(
      { domain, caseId: { $in: caseIds } },
      {
        domain: 1,
        caseId: 1,
        sourceName: 1,
        sourceChannel: 1,
        routeCampaignKey: 1,
        routeCampaignName: 1,
      },
    ).lean();
    for (const lead of leads) {
      leadsByKey.set(`${normalizeDomain(lead.domain)}:${Number(lead.caseId)}`, lead);
    }
  }

  const preparedBySession = new Map();
  let preparedFromEvents = 0;
  let preparedFromQueueRows = 0;
  const addPrepared = (row, source) => {
    if (!row?.domain || !row?.telephonySessionId) return false;
    const key = `${row.domain}:${row.telephonySessionId}`;
    if (preparedBySession.has(key)) return false;
    preparedBySession.set(key, row);
    if (source === "event") preparedFromEvents += 1;
    if (source === "queue") preparedFromQueueRows += 1;
    return true;
  };

  for (const event of placedEvents) {
    const payload = event.payload || {};
    const queueItemId = normalizeExternalId(payload.queueItemId || payload.queueTicketId);
    const row = queueItemId ? queueById.get(queueItemId) : null;
    const metadata = row?.metadata || {};
    const startedAt = pickFirstDate(payload.placedAt, payload.requestedAt, event.createdAt);
    if (!inWindow(startedAt, startDate, endDate)) continue;

    const domain = normalizeDomain(payload.domain || row?.domain);
    const caseId = Number(payload.caseId || row?.caseId);
    const lead = leadsByKey.get(`${domain}:${caseId}`) || null;
    const sessionId = pickEventSessionId(event, row, startedAt);
    if (!sessionId) continue;

    const sourceName = payload.sourceName || metadata.sourceName || row?.sourceName || lead?.sourceName || null;
    const sourceChannel =
      payload.sourceChannel ||
      metadata.sourceChannel ||
      row?.sourceChannel ||
      lead?.sourceChannel ||
      row?.intakeRoute ||
      null;
    const routeCampaignKey = payload.routeCampaignKey || metadata.routeCampaignKey || lead?.routeCampaignKey || null;
    const routeCampaignName =
      payload.routeCampaignName || metadata.routeCampaignName || lead?.routeCampaignName || null;

    addPrepared(compactObject({
      domain,
      telephonySessionId: sessionId,
      callSessionId: sessionId.startsWith("cx-synth:") ? null : sessionId,
      direction: "outbound",
      callStartTime: startedAt,
      callEndTime: null,
      durationSec: null,
      missed: false,
      caseId: Number.isFinite(caseId) ? caseId : null,
      caseDomain: domain,
      phone: payload.phone || metadata.lastQueueAttemptPhone || row?.phone || null,
      normalizedPhone: normalizeDigits(payload.phone || metadata.lastQueueAttemptPhone || row?.phone),
      extensionId:
        payload.assignedExtensionId ||
        payload.extensionId ||
        row?.assignment?.extensionId ||
        metadata.assignedExtensionId ||
        null,
      agentName:
        payload.assignedAgentName ||
        payload.agentName ||
        row?.assignment?.agentName ||
        metadata.assignedAgentName ||
        null,
      executionOwner: "ringcentral-cx",
      platform: "cx",
      sourceName: sourceName || undefined,
      sourceChannel: sourceChannel || undefined,
      routeCampaignKey: routeCampaignKey || undefined,
      routeCampaignName: routeCampaignName || undefined,
      ringcx: {
        ...pickRingcxStamp(metadata),
        queueItemId: queueItemId || (row?._id ? String(row._id) : null),
        agentEmail: payload.agentEmail || metadata.assignedAgentEmail || null,
        actionKey: payload.actionKey || metadata.actionKey || null,
      },
      audit: {
        dispatchSource: "cx-call-placed-event-backlog",
        eventId: String(event._id),
        eventStatus: event.status || null,
        eventCreatedAt: event.createdAt || null,
        queueItemId: queueItemId || (row?._id ? String(row._id) : null),
        queueState: row?.state || null,
        placedCalls: Number(row?.placedCalls || 0),
        syntheticSessionId: sessionId.startsWith("cx-synth:"),
      },
    }), "event");
  }

  for (const row of candidates) {
    const metadata = row.metadata || {};
    const startedAt = pickFirstDate(
      metadata.lastQueueAttemptAt,
      row.lastPlacedAt,
      metadata.lastDialExecutionAt,
      row.updatedAt,
      row.createdAt,
    );
    if (!inWindow(startedAt, startDate, endDate)) continue;

    const domain = normalizeDomain(row.domain);
    const caseId = Number(row.caseId);
    const lead = leadsByKey.get(`${domain}:${caseId}`) || null;
    const terminalAt = pickFirstDate(metadata.lastTerminalOutcomeAt);
    const terminalOutcome = pickTerminalOutcome(row);
    const sessionId = pickSessionId(row, startedAt);
    if (!sessionId) continue;

    const durationSec = terminalAt && terminalAt >= startedAt
      ? Math.max(Math.round((terminalAt.getTime() - startedAt.getTime()) / 1000), 0)
      : null;
    const sourceName = metadata.sourceName || row.sourceName || lead?.sourceName || null;
    const sourceChannel =
      metadata.sourceChannel ||
      row.sourceChannel ||
      lead?.sourceChannel ||
      row.intakeRoute ||
      null;
    const routeCampaignKey = metadata.routeCampaignKey || lead?.routeCampaignKey || null;
    const routeCampaignName = metadata.routeCampaignName || lead?.routeCampaignName || null;

    addPrepared(compactObject({
      domain,
      telephonySessionId: sessionId,
      callSessionId: sessionId.startsWith("cx-synth:") ? null : sessionId,
      direction: "outbound",
      callStartTime: startedAt,
      callEndTime: terminalAt || null,
      durationSec,
      missed: isMissedOutcome(terminalOutcome),
      caseId: Number.isFinite(caseId) ? caseId : null,
      caseDomain: domain,
      phone: metadata.lastQueueAttemptPhone || row.phone || null,
      normalizedPhone: normalizeDigits(metadata.lastQueueAttemptPhone || row.phone),
      extensionId: row.assignment?.extensionId || metadata.assignedExtensionId || null,
      agentName: row.assignment?.agentName || metadata.assignedAgentName || null,
      executionOwner: "ringcentral-cx",
      platform: "cx",
      sourceName: sourceName || undefined,
      sourceChannel: sourceChannel || undefined,
      routeCampaignKey: routeCampaignKey || undefined,
      routeCampaignName: routeCampaignName || undefined,
      ringcx: {
        ...pickRingcxStamp(metadata),
        queueItemId: String(row._id),
        agentEmail: metadata.assignedAgentEmail || null,
        actionKey: metadata.actionKey || null,
      },
      audit: {
        dispatchSource: "cx-call-placed-queue-backlog",
        queueItemId: String(row._id),
        queueState: row.state || null,
        placedCalls: Number(row.placedCalls || 0),
        terminalOutcome: terminalOutcome || null,
        syntheticSessionId: sessionId.startsWith("cx-synth:"),
      },
    }), "queue");
  }

  const prepared = [...preparedBySession.values()];
  const sessionIds = prepared.map((row) => row.telephonySessionId);
  const existing = sessionIds.length
    ? await CallLog.find({ telephonySessionId: { $in: sessionIds } }, { telephonySessionId: 1 }).lean()
    : [];
  const existingSet = new Set(existing.map((row) => String(row.telephonySessionId)));

  const summary = {
    dryRun: Boolean(dryRun),
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    domains: selectedDomains,
    scannedCallPlacedEvents: placedEvents.length,
    scannedQueueItems: candidates.length,
    preparedRows: prepared.length,
    preparedFromEvents,
    preparedFromQueueRows,
    existingRows: prepared.filter((row) => existingSet.has(row.telephonySessionId)).length,
    wouldInsertRows: prepared.filter((row) => !existingSet.has(row.telephonySessionId)).length,
    upsertedRows: 0,
    ledgerSynced: 0,
    ledgerErrors: 0,
    errors: [],
    samples: prepared.slice(0, 10).map((row) => ({
      domain: row.domain,
      telephonySessionId: row.telephonySessionId,
      caseId: row.caseId,
      extensionId: row.extensionId,
      sourceName: row.sourceName || null,
      routeCampaignKey: row.routeCampaignKey || null,
      callStartTime: row.callStartTime?.toISOString?.() || null,
    })),
  };

  if (dryRun) return summary;

  for (const row of prepared) {
    try {
      const upserted = await callLogRepository.upsertCallLog(row);
      summary.upsertedRows += 1;
      try {
        const ledger = await syncCallLedgerFromCallLog(upserted, { syncedAt: new Date() });
        if (!ledger?.skipped) summary.ledgerSynced += 1;
      } catch (ledgerError) {
        summary.ledgerErrors += 1;
        summary.errors.push({
          type: "ledger",
          telephonySessionId: row.telephonySessionId,
          error: ledgerError.message,
        });
      }
    } catch (error) {
      summary.errors.push({
        type: "calllog-upsert",
        telephonySessionId: row.telephonySessionId,
        error: error.message,
      });
    }
  }

  if (summary.upsertedRows > 0 || summary.ledgerErrors > 0 || summary.errors.length > 0) {
    logger?.info?.("cx.call_activity_backfill", {
      domains: selectedDomains,
      scannedCallPlacedEvents: summary.scannedCallPlacedEvents,
      preparedRows: summary.preparedRows,
      upsertedRows: summary.upsertedRows,
      ledgerSynced: summary.ledgerSynced,
      ledgerErrors: summary.ledgerErrors,
      errors: summary.errors.length,
    });
  }

  return summary;
}

async function recoverCxCallLogsForDate({ date, timezone = DEFAULT_TIMEZONE, ...options } = {}) {
  if (!date) throw new Error("date is required");
  const { start, end } = buildTimezoneDateWindow(date, timezone);
  return recoverCxCallLogs({
    ...options,
    start,
    end,
  });
}

module.exports = {
  recoverCxCallLogs,
  recoverCxCallLogsForDate,
};
