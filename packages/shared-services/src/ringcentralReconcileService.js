"use strict";

const { createEvent, listEvents } = require("../../event-core/src");
const {
  workflowRecordRepository,
} = require("../../shared-repositories/src");
const {
  fetchCallRecordWithRetry,
} = require("./ringcentralAttributionService");
const {
  resolveInboundCallSource,
} = require("./callAttributionResolverService");
const { recordWorkflowStage } = require("./workflowStateService");

function normalizeDomain(domain) {
  return String(domain || "").toUpperCase();
}

/**
 * Find completed telephony sessions that never got a
 * `ringcentral.attribution.resolved` event, fetch their call-log record,
 * and resolve via legs-then-DID. This is the hourly safety net for
 * sessions where the live scheduled attribution missed its window (service
 * restart, RC call-log not populated in time, etc).
 */
async function reconcileUnattributedSessions({
  domain,
  sinceMs = 60 * 60 * 1000,
  limit = 100,
  dryRun = false,
  logger = null,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) {
    const err = new Error("domain is required");
    err.status = 400;
    throw err;
  }

  const cutoff = new Date(Date.now() - Math.max(Number(sinceMs) || 0, 5 * 60 * 1000));

  const startedAt = new Date();
  const batchId = `${normalizedDomain}-${startedAt.getTime()}`;

  await recordWorkflowStage({
    domain: normalizedDomain,
    family: "attribution-reconcile",
    subtype: "ringcentral",
    stage: "requested",
    aggregateType: "reconcile-batch",
    aggregateId: batchId,
    sourceService: "control-plane",
    title: "RC attribution reconcile started",
    summary: `sinceMs=${sinceMs} limit=${limit} dryRun=${dryRun}`,
  });

  const completedRecords = await workflowRecordRepository.listWorkflowRecords({
    domain: normalizedDomain,
    family: "ringcentral",
    subtype: "call",
    stage: "completed",
    aggregateType: "telephony-session",
    limit: Math.min(Math.max(Number(limit) || 100, 1), 500) * 3,
  });

  const filtered = completedRecords.filter((record) => {
    const at = new Date(record.happenedAt || record.createdAt || 0).getTime();
    return at >= cutoff.getTime();
  });

  const stats = {
    domain: normalizedDomain,
    scanned: 0,
    alreadyAttributed: 0,
    resolved: 0,
    unmatched: 0,
    errors: 0,
    dryRun,
  };
  const resolved = [];
  const unmatched = [];
  const errors = [];

  const seenSessionIds = new Set();

  for (const record of filtered) {
    const sessionId = String(record.aggregateId || "").trim();
    if (!sessionId || seenSessionIds.has(sessionId)) continue;
    seenSessionIds.add(sessionId);
    if (stats.scanned >= limit) break;
    stats.scanned += 1;

    try {
      const existing = await listEvents({
        aggregateId: sessionId,
        limit: 5,
      });
      if (
        existing.some(
          (event) => event.eventType === "ringcentral.attribution.resolved",
        )
      ) {
        stats.alreadyAttributed += 1;
        continue;
      }

      const extensionId =
        record.payload?.extensionId ||
        record.payload?.candidate?.extensionId ||
        null;
      const candidate = {
        extensionId,
        telephonySessionId: sessionId,
        sessionId: record.payload?.sessionId || null,
        toNumber: record.payload?.to?.phoneNumber || null,
        eventTime: record.happenedAt || record.createdAt,
      };

      const lookup = await fetchCallRecordWithRetry(candidate, {
        maxRetries: 1,
        retryBaseMs: 0,
      });

      if (!lookup.record) {
        stats.unmatched += 1;
        unmatched.push({ sessionId, reason: "no-matching-call-record" });
        if (!dryRun) {
          await createEvent({
            eventType: "ringcentral.attribution.missed",
            sourceService: "control-plane",
            aggregateType: "telephony-session",
            aggregateId: sessionId,
            dedupeKey: `reconcile-missed:${sessionId}`,
            payload: { candidate, lookup, reconcile: true },
          });
        }
        continue;
      }

      const source = await resolveInboundCallSource({
        domain: normalizedDomain,
        customerPhone:
          lookup.record?.from?.phoneNumber ||
          candidate.fromNumber ||
          null,
        record: lookup.record,
        telephonySessionId: sessionId,
        logger,
      });
      if (!dryRun) {
        await createEvent({
          eventType: "ringcentral.attribution.resolved",
          sourceService: "control-plane",
          aggregateType: "telephony-session",
          aggregateId: sessionId,
          dedupeKey: `resolved:${sessionId}`,
          payload: {
            candidate,
            lookup: {
              attempts: lookup.attempts,
              strategy: lookup.strategy || null,
              window: lookup.window,
            },
            record: {
              id: lookup.record.id || null,
              sessionId: lookup.record.sessionId || null,
              telephonySessionId: lookup.record.telephonySessionId || null,
              startTime: lookup.record.startTime || null,
              duration: lookup.record.duration || 0,
              direction: lookup.record.direction || null,
              result: lookup.record.result || null,
              from: lookup.record.from || null,
              to: lookup.record.to || null,
              recording: lookup.record.recording || null,
              legs: lookup.record.legs || [],
            },
            source,
            reconcile: true,
          },
        });
      }
      stats.resolved += 1;
      resolved.push({
        sessionId,
        matched: source.matched,
        strategy: source.strategy,
        canonicalKey: source.canonicalKey || null,
        internalName: source.internalName || null,
        channel: source.channel || null,
      });
      logger?.info?.("ringcentral.reconcile.resolved", {
        sessionId,
        strategy: source.strategy,
        matched: source.matched,
      });
    } catch (error) {
      stats.errors += 1;
      errors.push({ sessionId, error: error.message });
      logger?.warn?.("ringcentral.reconcile.failed", {
        sessionId,
        error: error.message,
      });
    }
  }

  const finishedAt = new Date();
  const result = {
    domain: normalizedDomain,
    startedAt,
    finishedAt,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    cutoff,
    stats,
    resolved,
    unmatched,
    errors: errors.slice(0, 25),
  };

  await recordWorkflowStage({
    domain: normalizedDomain,
    family: "attribution-reconcile",
    subtype: "ringcentral",
    stage: "completed",
    aggregateType: "reconcile-batch",
    aggregateId: batchId,
    sourceService: "control-plane",
    title: "RC attribution reconcile completed",
    summary: `${stats.scanned} scanned · ${stats.resolved} resolved · ${stats.alreadyAttributed} skipped · ${stats.unmatched} unmatched · ${stats.errors} errors`,
    result,
  });

  return result;
}

module.exports = {
  reconcileUnattributedSessions,
};
