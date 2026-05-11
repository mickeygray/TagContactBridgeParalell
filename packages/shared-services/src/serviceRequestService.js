"use strict";

const { createEvent } = require("../../event-core/src");

/**
 * Service-request emissions. When any backend chain (attribution,
 * transcription, promotion, payment roll-up, …) finishes with an
 * incomplete step, it emits a service-request event here. A separate
 * generalized sweeper (hourly / end-of-day) consumes these and works
 * through the backlog, calling back into the relevant chain with the
 * retry hint.
 *
 * Why EventRecord (not ReviewQueueItem):
 *   - ReviewQueueItem = human-visible review queue (wrong source, manual
 *     intervention, service alerts).
 *   - EventRecord = machine-consumed async work ledger, already has
 *     retry/dead-letter/claim semantics. Exactly what a sweeper needs.
 *
 * Event type namespace is reserved per-chain so the sweeper can route
 * by prefix. Current types:
 *
 *   attribution.retry-pending       — CallLog row needs another resolver
 *                                     pass. Typical cause: RC call-log
 *                                     hadn't populated yet, CallRail
 *                                     miss, Logics transient error.
 *   attribution.case-binding-missing — source resolved but no caseId.
 *                                     Hourly should re-query Logics /
 *                                     MasterProspect in case the case
 *                                     was created after this call.
 *   calllog.transcription-pending   — CallLog needs Whisper + Claude.
 *                                     Fired after a successful
 *                                     attribution write for Outbound
 *                                     agent calls.
 *   caseprofile.promotion-failed    — promotion threw. Retry with same
 *                                     payload.
 *
 * All events carry `aggregateType: "call-log"` + `aggregateId:
 * telephonySessionId` so the sweeper can rehydrate the CallLog row and
 * work from there.
 */

async function emitServiceRequest({
  eventType,
  telephonySessionId,
  domain = null,
  caseId = null,
  reason = null,
  payload = {},
  sourceService = "attribution-resolver",
  delayMs = 0,
  logger = null,
}) {
  if (!eventType || !telephonySessionId) return null;
  try {
    return await createEvent({
      eventType,
      sourceService,
      aggregateType: "call-log",
      aggregateId: String(telephonySessionId),
      // Dedupe per-event-type so the sweeper doesn't see 10 retry events
      // for the same session. When the sweeper succeeds it marks the
      // event completed; if the chain re-emits before then, dedupe wins.
      dedupeKey: `${eventType}:${telephonySessionId}`,
      delayMs,
      payload: {
        telephonySessionId: String(telephonySessionId),
        domain,
        caseId,
        reason,
        ...payload,
      },
    });
  } catch (error) {
    // Never let a service-request emission block the chain. If the event
    // ledger is down, CallLog.status: pending-retry is still the backup
    // query the sweeper can fall back to — but surface the error so it
    // shows up in service logs rather than vanishing silently.
    const warn = logger?.warn || console.warn;
    warn("service-request.emit_failed", {
      eventType,
      telephonySessionId,
      error: error.message,
    });
    return null;
  }
}

module.exports = {
  emitServiceRequest,
};
