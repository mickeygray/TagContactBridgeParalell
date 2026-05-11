"use strict";

const { listEvents } = require("../../event-core/src");
const {
  agentStateRepository,
  callLogRepository,
  workflowRecordRepository,
} = require("../../shared-repositories/src");
const { getSharedConfig, PORTS } = require("../../shared-config/src");
const {
  listLegacyContactActivities,
} = require("./legacyContactActivityService");

const CALL_WORKFLOW_SUBTYPES = new Set(["call", "call-missed"]);

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function legacyCallLogReadsEnabled() {
  return boolFromEnv(process.env.CALL_LOG_LEGACY_READS_ENABLED, false);
}

function normalizeDomain(domain) {
  return String(domain || "").toUpperCase();
}

function pickNumber(party = {}) {
  if (!party) return null;
  return (
    party.phoneNumber ||
    party.extensionNumber ||
    party.number ||
    null
  );
}

function pickName(party = {}) {
  if (!party) return null;
  return party.name || party.extensionName || party.displayName || null;
}

function durationSecondsBetween(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

/**
 * Fold ringcentral workflow records + attribution events for one telephony
 * session into a single call-shaped row.
 */
function foldSession(sessionId, stages, attribution) {
  const sortedStages = [...stages].sort((a, b) => {
    const aTs = new Date(a.happenedAt || a.createdAt || 0).getTime();
    const bTs = new Date(b.happenedAt || b.createdAt || 0).getTime();
    return aTs - bTs;
  });

  const startStage = sortedStages.find(
    (s) => s.subtype === "call" && s.stage === "requested",
  ) || sortedStages[0];
  const endStage =
    sortedStages.find(
      (s) => s.subtype === "call" && s.stage === "completed",
    ) || null;
  const missedStage =
    sortedStages.find((s) => s.subtype === "call-missed") || null;

  const startedAt = startStage?.happenedAt || startStage?.createdAt || null;
  const endedAt = endStage?.happenedAt || endStage?.createdAt || null;

  const startPayload = startStage?.payload || {};
  const endPayload = endStage?.payload || {};

  const extensionId =
    startPayload.extensionId ||
    endPayload.extensionId ||
    missedStage?.payload?.extensionId ||
    attribution?.payload?.candidate?.extensionId ||
    null;

  const direction =
    attribution?.payload?.record?.direction ||
    startPayload.direction ||
    endPayload.direction ||
    null;

  const fromPayload =
    attribution?.payload?.record?.from ||
    startPayload.from ||
    endPayload.from ||
    {};
  const toPayload =
    attribution?.payload?.record?.to ||
    startPayload.to ||
    endPayload.to ||
    {};

  const record = attribution?.payload?.record || null;
  const durationSec =
    (record && Number.isFinite(Number(record.duration))
      ? Number(record.duration)
      : null) || durationSecondsBetween(startedAt, endedAt);

  const source = attribution?.payload?.source || null;
  const strategy =
    attribution?.payload?.source?.strategy ||
    (attribution?.eventType === "ringcentral.attribution.resolved" ? "did" : null);

  let outcome = "unknown";
  if (missedStage) outcome = "missed";
  else if (record?.result) outcome = String(record.result).toLowerCase();
  else if (endStage) outcome = "completed";
  else if (startStage) outcome = "in-progress";

  return {
    sessionId,
    extensionId,
    direction,
    fromNumber: pickNumber(fromPayload),
    fromName: pickName(fromPayload),
    toNumber: pickNumber(toPayload),
    toName: pickName(toPayload),
    startedAt,
    endedAt,
    durationSec,
    outcome,
    missed: Boolean(missedStage),
    hasRecording: Boolean(record?.recording),
    source: source
      ? {
          matched: Boolean(source.matched),
          canonicalKey: source.canonicalKey || null,
          name: source.internalName || null,
          channel: source.channel || null,
          did: source.did || null,
        }
      : null,
    attribution: attribution
      ? {
          status: attribution.eventType === "ringcentral.attribution.resolved"
            ? "resolved"
            : attribution.eventType === "ringcentral.attribution.missed"
              ? "missed"
              : "pending",
          attempts: attribution.payload?.lookup?.attempts || null,
          strategy,
          confidence: attribution.payload?.source?.confidence || null,
          legIndex: attribution.payload?.source?.legIndex ?? null,
          caseId: attribution.payload?.source?.caseId ?? null,
          caseDomain: attribution.payload?.source?.caseDomain || null,
          intakeSource: attribution.payload?.source?.intakeSource || null,
          reconcile: Boolean(attribution.payload?.reconcile),
        }
      : {
          status: "pending",
          attempts: null,
          strategy: null,
          confidence: null,
          legIndex: null,
          caseId: null,
          caseDomain: null,
          intakeSource: null,
          reconcile: false,
        },
    stages: sortedStages.map((s) => ({
      subtype: s.subtype,
      stage: s.stage,
      at: s.happenedAt || s.createdAt,
    })),
  };
}

function mapMaterializedCallLog(row = {}) {
  const call = row.toObject ? row.toObject() : row;
  const direction = call.direction || null;
  const outcome = call.missed
    ? "missed"
    : call.status === "resolved"
      ? "completed"
      : call.status || "unknown";

  return {
    sessionId: call.telephonySessionId || call.callSessionId || String(call._id || ""),
    extensionId: call.extensionId || null,
    agentName: call.agentName || null,
    agentCompany: call.domain || null,
    direction,
    fromNumber: direction === "inbound" ? call.phone || null : null,
    fromName: direction === "inbound" ? call.contactName || null : call.agentName || null,
    toNumber: direction === "outbound" ? call.phone || null : null,
    toName: direction === "outbound" ? call.contactName || null : null,
    startedAt: call.callStartTime || call.createdAt || null,
    endedAt: call.callEndTime || null,
    durationSec: call.durationSec ?? null,
    outcome,
    missed: Boolean(call.missed),
    hasRecording: Boolean(
      call.transcription?.recordingUri ||
        call.recordingArchive?.driveFileId ||
        call.recordingArchive?.driveWebViewLink,
    ),
    source: call.sourceName || call.sourceCanonicalId
      ? {
          matched: Boolean(call.sourceName || call.sourceCanonicalId),
          canonicalKey: call.mailPieceKey || null,
          name: call.sourceName || null,
          channel: call.sourceChannel || null,
          did: null,
        }
      : null,
    attribution: {
      status: call.status || "pending",
      attempts: call.attempts || null,
      strategy: call.strategy || null,
      confidence: call.confidence || null,
      legIndex: null,
      caseId: call.caseId ?? null,
      caseDomain: call.caseDomain || null,
      intakeSource: call.sourceChannel || null,
      reconcile: call.resolverActor === "reconcile",
    },
    stages: [],
    parallel: {
      recordId: String(call._id || ""),
      resolverActor: call.resolverActor || null,
      transcriptionStatus: call.transcription?.status || null,
      recordingArchiveStatus: call.recordingArchive?.status || null,
      callScoreOverall: call.callScore?.overall ?? null,
    },
  };
}

function summarizeRows(rows, nativeSessions = 0, legacyCount = 0) {
  const summary = rows.reduce(
    (acc, row) => {
      acc.total += 1;
      acc.byDirection[row.direction || "unknown"] =
        (acc.byDirection[row.direction || "unknown"] || 0) + 1;
      acc.byOutcome[row.outcome || "unknown"] =
        (acc.byOutcome[row.outcome || "unknown"] || 0) + 1;
      if (row.missed) acc.missed += 1;
      if (row.attribution?.status === "resolved") acc.attributed += 1;
      if (row.source?.matched) acc.sourceMatched += 1;
      if (row.attribution?.strategy === "legacy") acc.legacy += 1;
      return acc;
    },
    {
      total: 0,
      missed: 0,
      attributed: 0,
      sourceMatched: 0,
      legacy: 0,
      byDirection: {},
      byOutcome: {},
    },
  );
  summary.nativeSessions = nativeSessions;
  summary.legacyMerged = legacyCount;
  summary.unfilteredTotal = rows.length;
  return summary;
}

/**
 * Live aggregation of RingCentral telephony workflow records + attribution
 * events into call-shaped rows. No materialized collection — reads happen
 * on demand.
 */
async function buildCallLog(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  const sourceFilter = filters.source
    ? String(filters.source).toLowerCase()
    : null;

  if (sourceFilter !== "legacy" && sourceFilter !== "workflow") {
    const docs = await callLogRepository.listCallLogs(normalizedDomain, {
      limit,
      direction: filters.direction,
      extensionId: filters.extensionId,
      sinceMs: filters.sinceMs,
      includeLegacy: false,
    });
    let rows = docs.map(mapMaterializedCallLog);
    if (filters.outcome) {
      const want = String(filters.outcome).toLowerCase();
      rows = rows.filter((row) => row.outcome === want);
    }
    const sessionIds = new Set(rows.map((row) => row.sessionId).filter(Boolean));
    return {
      domain: normalizedDomain,
      generatedAt: new Date().toISOString(),
      source: "control-plane-call-log",
      summary: summarizeRows(rows, sessionIds.size, 0),
      calls: rows.slice(0, limit),
    };
  }

  // Pull more workflow records than the requested limit so each session has
  // a chance to include both start and end stages.
  const workflowLimit = Math.min(limit * 6, 500);

  // Source filter flags (declared early so they're in scope for all the
  // gates below). `?source=native` drops legacy; `?source=legacy` shows
  // only legacy; default is both merged.
  const onlyLegacy = sourceFilter === "legacy";
  const onlyNative = sourceFilter === "workflow";
  const includeLegacy =
    legacyCallLogReadsEnabled() && !onlyNative && (onlyLegacy || filters.includeLegacy === true);

  const [workflowRecords, agents] = await Promise.all([
    workflowRecordRepository.listWorkflowRecords({
      domain: normalizedDomain,
      family: "ringcentral",
      aggregateType: "telephony-session",
      limit: workflowLimit,
    }),
    agentStateRepository.listAgentStates({ company: normalizedDomain }),
  ]);

  const agentsByExtension = new Map(
    agents.map((agent) => [String(agent.extensionId || ""), agent]),
  );

  const stagesBySession = new Map();
  for (const record of workflowRecords) {
    if (!CALL_WORKFLOW_SUBTYPES.has(record.subtype)) continue;
    const sessionId = String(record.aggregateId || "").trim();
    if (!sessionId) continue;
    if (!stagesBySession.has(sessionId)) stagesBySession.set(sessionId, []);
    stagesBySession.get(sessionId).push(record);
  }

  const sessionIds = [...stagesBySession.keys()];

  // Fetch attribution events per session. Sequential by necessity — findEvents
  // only accepts one aggregateId at a time today. Cap at the FE-facing limit
  // so we don't fan out 500 lookups for a 50-row view.
  const attributionBySession = new Map();
  const recentSessionIds = sessionIds.slice(0, limit * 2);
  for (const sessionId of recentSessionIds) {
    const events = await listEvents({
      aggregateId: sessionId,
      limit: 5,
    });
    const resolved = events.find(
      (e) => e.eventType === "ringcentral.attribution.resolved",
    );
    const missed = events.find(
      (e) => e.eventType === "ringcentral.attribution.missed",
    );
    if (resolved) attributionBySession.set(sessionId, resolved);
    else if (missed) attributionBySession.set(sessionId, missed);
  }

  const rows = [];
  const nativeSessionIds = new Set();
  if (!onlyLegacy) {
    for (const [sessionId, stages] of stagesBySession.entries()) {
      const row = foldSession(
        sessionId,
        stages,
        attributionBySession.get(sessionId) || null,
      );
      if (row.extensionId) {
        const agent = agentsByExtension.get(String(row.extensionId));
        if (agent) {
          row.agentName = agent.name || null;
          row.agentCompany = agent.company || null;
        }
      }
      rows.push(row);
      nativeSessionIds.add(sessionId);
    }
  }

  // (source filter flags were hoisted to the top of this function.)
  let legacyCount = 0;
  if (includeLegacy) {
    try {
      const legacyRows = await listLegacyContactActivities({
        domain: normalizedDomain,
        limit: limit * 2,
        direction: filters.direction,
        extensionId: filters.extensionId,
      });
      for (const row of legacyRows) {
        if (row.sessionId && nativeSessionIds.has(row.sessionId)) continue;
        rows.push(row);
        legacyCount += 1;
      }
    } catch {
      // Legacy DB may not exist in some envs (dev without the old app) — fall
      // through silently; we still have the native feed.
    }
  }

  rows.sort((a, b) => {
    const at = new Date(a.startedAt || 0).getTime();
    const bt = new Date(b.startedAt || 0).getTime();
    return bt - at;
  });

  let filtered = rows;
  if (filters.direction) {
    const want = String(filters.direction).toLowerCase();
    filtered = filtered.filter(
      (row) => (row.direction || "").toLowerCase() === want,
    );
  }
  if (filters.outcome) {
    const want = String(filters.outcome).toLowerCase();
    filtered = filtered.filter((row) => row.outcome === want);
  }
  if (filters.extensionId) {
    const want = String(filters.extensionId);
    filtered = filtered.filter((row) => String(row.extensionId || "") === want);
  }
  if (filters.sinceMs) {
    const cutoff = Date.now() - Number(filters.sinceMs);
    filtered = filtered.filter((row) => {
      const startedAt = row.startedAt ? new Date(row.startedAt).getTime() : NaN;
      const endedAt = row.endedAt ? new Date(row.endedAt).getTime() : NaN;
      return (Number.isFinite(startedAt) && startedAt >= cutoff)
        || (Number.isFinite(endedAt) && endedAt >= cutoff);
    });
  }

  // Summary is computed from `filtered` so the counts shown in the UI
  // header match the rows rendered in the table. Reducing over the full
  // `rows` array (pre-filter) would produce a "150 missed" label on a
  // table the user has filtered down to 3 rows.
  const summary = filtered.reduce(
    (acc, row) => {
      acc.total += 1;
      acc.byDirection[row.direction || "unknown"] =
        (acc.byDirection[row.direction || "unknown"] || 0) + 1;
      acc.byOutcome[row.outcome || "unknown"] =
        (acc.byOutcome[row.outcome || "unknown"] || 0) + 1;
      if (row.missed) acc.missed += 1;
      if (row.attribution?.status === "resolved") acc.attributed += 1;
      if (row.source?.matched) acc.sourceMatched += 1;
      if (row.attribution?.strategy === "legacy") acc.legacy += 1;
      return acc;
    },
    {
      total: 0,
      missed: 0,
      attributed: 0,
      sourceMatched: 0,
      legacy: 0,
      byDirection: {},
      byOutcome: {},
    },
  );
  summary.nativeSessions = nativeSessionIds.size;
  summary.legacyMerged = legacyCount;
  // Pre-filter total preserved so callers that need "how many sessions
  // exist before filtering" can read it separately.
  summary.unfilteredTotal = rows.length;

  return {
    domain: normalizedDomain,
    generatedAt: new Date().toISOString(),
    summary,
    calls: filtered.slice(0, limit),
  };
}

async function fetchRingcentralCxRuntime() {
  const config = getSharedConfig();
  const secret = String(config.internalServiceSecret || "").trim();
  if (!secret) {
    return { reachable: false, reason: "internal-service-secret-missing" };
  }

  const baseUrl = `http://127.0.0.1:${PORTS.ringcentralCx}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${baseUrl}/api/ringcentral/runtime`, {
      method: "GET",
      headers: { "x-service-secret": secret },
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      return {
        reachable: false,
        status: response.status,
        reason: data?.error || `ringcentral-cx returned ${response.status}`,
      };
    }
    return {
      reachable: true,
      auth: data?.auth || null,
      presencePoller: data?.presencePoller || null,
      telephonyQueue: data?.telephonyQueue || null,
    };
  } catch (error) {
    return {
      reachable: false,
      reason: error.name === "AbortError" ? "timeout" : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function buildRingcentralPollingRuntime(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const runtime = await fetchRingcentralCxRuntime();

  const staleThresholdMs = 90000;
  const lastCompletedAt = runtime?.presencePoller?.lastCompletedAt || null;
  const ageMs = lastCompletedAt
    ? Date.now() - new Date(lastCompletedAt).getTime()
    : null;
  const healthy =
    runtime.reachable &&
    runtime.presencePoller?.enabled &&
    !runtime.presencePoller?.lastError &&
    (ageMs == null || ageMs < staleThresholdMs);

  return {
    domain: normalizedDomain,
    reachable: runtime.reachable,
    healthy,
    staleThresholdMs,
    ageMs,
    presencePoller: runtime.presencePoller || null,
    auth: runtime.auth || null,
    telephonyQueue: runtime.telephonyQueue || null,
    reason: runtime.reason || null,
  };
}

module.exports = {
  buildCallLog,
  buildRingcentralPollingRuntime,
};
