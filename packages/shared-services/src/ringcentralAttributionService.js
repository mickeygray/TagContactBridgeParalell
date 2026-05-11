"use strict";

const { createEvent } = require("../../event-core/src");
const { getRingCentralConfig } = require("../../shared-config/src");
const { createRingCentralClient } = require("../../shared-integrations/src");
const { sourceCanonicalRepository } = require("../../shared-repositories/src");
const { emitHourlyJobEvent } = require("./hourlyJobEventService");

const scheduledSessions = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCandidateStartTime(candidate = {}) {
  return (
    candidate.callStartTime ||
    candidate.startTime ||
    candidate.eventTime ||
    new Date().toISOString()
  );
}

function buildCallLogWindow(candidate = {}) {
  const startTime = new Date(getCandidateStartTime(candidate));
  return {
    startTime: startTime.toISOString(),
    dateFrom: new Date(startTime.getTime() - 90000).toISOString(),
    // Keep the window tight around the actual call start so older matching
    // records are not pushed out by newer calls when RC sorts descending.
    dateTo: new Date(startTime.getTime() + (10 * 60 * 1000)).toISOString(),
  };
}

function recordMatchesCandidate(record = {}, candidate = {}) {
  if (!record) return false;

  if (
    candidate.telephonySessionId &&
    (record.telephonySessionId === candidate.telephonySessionId ||
      (Array.isArray(record.legs) &&
        record.legs.some((leg) => leg.telephonySessionId === candidate.telephonySessionId)))
  ) {
    return true;
  }

  if (
    candidate.sessionId &&
    (record.sessionId === candidate.sessionId ||
      (Array.isArray(record.legs) &&
        record.legs.some((leg) => leg.sessionId === candidate.sessionId)))
  ) {
    return true;
  }

  return false;
}

async function findMatchingCallRecord(fetcher, query, candidate) {
  const payload = await fetcher(query);
  const records = payload.records || [];
  const record = records.find((item) => recordMatchesCandidate(item, candidate));
  return {
    count: records.length,
    record: record || null,
  };
}

function buildSessionKey(candidate) {
  return [
    candidate.telephonySessionId || "unknown-session",
    candidate.extensionId || "unknown-ext",
    candidate.partyId || "unknown-party",
  ].join(":");
}

function isTerminalPartyStatus(party = {}) {
  const code = party.status?.code || null;
  const reason = party.status?.reason || null;

  if (code === "Disconnected" && !reason) return true;
  if (code === "Gone") return true;
  return false;
}

function extractAttributionCandidates(envelope = {}) {
  const body = envelope.body || {};
  const parties = Array.isArray(body.parties) ? body.parties : [];

  return parties
    .filter((party) => isTerminalPartyStatus(party))
    .map((party) => ({
      sessionId: body.sessionId || null,
      telephonySessionId: body.telephonySessionId || null,
      eventTime: body.eventTime || envelope.timestamp || new Date().toISOString(),
      extensionId: party.extensionId || party.to?.extensionId || null,
      partyId: party.id || null,
      fromNumber: party.from?.phoneNumber || null,
      toNumber: party.to?.phoneNumber || null,
      direction: party.direction || null,
      statusCode: party.status?.code || null,
      statusReason: party.status?.reason || null,
    }))
    .filter((candidate) => candidate.telephonySessionId && candidate.extensionId);
}

async function resolveSourceFromDid(phoneNumber) {
  if (!phoneNumber) {
    return {
      matched: false,
      strategy: "did",
      did: null,
      sourceCanonicalId: null,
      internalName: "unknown",
      channel: "unknown",
    };
  }

  const canonical = await sourceCanonicalRepository.findSourceCanonicalByTrackingNumber(phoneNumber);
  if (!canonical) {
    return {
      matched: false,
      strategy: "did",
      did: phoneNumber,
      sourceCanonicalId: null,
      internalName: "unknown",
      channel: "unknown",
    };
  }

  return {
    matched: true,
    strategy: "did",
    did: phoneNumber,
    sourceCanonicalId: String(canonical._id),
    canonicalKey: canonical.canonicalKey,
    internalName: canonical.internalName,
    channel: canonical.channel,
    domainHint:
      Array.isArray(canonical.domains) && canonical.domains.length === 1
        ? canonical.domains[0]
        : null,
  };
}

/**
 * Extract candidate extension identifiers from a leg. The resolver tries RC
 * ID first (`leg.extension.id`) since that's the most stable identifier,
 * then the short extension number, then any `to.extensionId` fallback.
 */
function legExtensionIds(leg = {}) {
  if (!leg) return [];
  const ids = new Set();
  const add = (value) => {
    const trimmed = String(value || "").trim();
    if (trimmed) ids.add(trimmed);
  };
  add(leg.extension?.id);
  add(leg.extension?.extensionNumber);
  add(leg.extensionId);
  add(leg.to?.extensionId);
  add(leg.to?.extensionNumber);
  return [...ids];
}

/**
 * Leg-based source resolution. Walk legs in order and return the first
 * canonical match — first-match-wins matches the "top layers are more
 * specific" routing rule. Real RC inbound mail calls have legs[0] as an
 * external ingress (no extension attached) and the mail queue owning the
 * tracking DID appears on legs[1]. Iterating all legs avoids missing
 * those entirely, and the first-hit rule still blocks generic hunt-path
 * legs later in the chain from winning attribution.
 */
async function resolveSourceFromLegs(legs = []) {
  if (!Array.isArray(legs) || legs.length === 0) {
    return {
      matched: false,
      strategy: "legs",
      legIndex: null,
      extensionId: null,
      sourceCanonicalId: null,
      internalName: "unknown",
      channel: "unknown",
    };
  }

  for (let legIndex = 0; legIndex < legs.length; legIndex += 1) {
    const leg = legs[legIndex] || {};
    for (const extensionId of legExtensionIds(leg)) {
      const canonical =
        await sourceCanonicalRepository.findSourceCanonicalByRingCentralExtension(
          extensionId,
        );
      if (canonical) {
        return {
          matched: true,
          strategy: `legs[${legIndex}]`,
          legIndex,
          extensionId,
          sourceCanonicalId: String(canonical._id),
          canonicalKey: canonical.canonicalKey,
          internalName: canonical.internalName,
          channel: canonical.channel,
          domainHint:
            Array.isArray(canonical.domains) && canonical.domains.length === 1
              ? canonical.domains[0]
              : null,
        };
      }
    }
  }

  return {
    matched: false,
    strategy: "legs",
    legIndex: null,
    extensionId: null,
    sourceCanonicalId: null,
    internalName: "unknown",
    channel: "unknown",
  };
}

/**
 * Combined resolver that tries legs first (authoritative for mail + BCD),
 * then falls back to the DID lookup. Returns the matched source plus
 * `attempts` for audit.
 */
async function resolveSourceForCallRecord(record = {}) {
  const legsSource = await resolveSourceFromLegs(record.legs || []);
  const didSource = await resolveSourceFromDid(
    record.to?.phoneNumber || null,
  );

  const winner = legsSource.matched
    ? legsSource
    : didSource.matched
      ? didSource
      : { ...didSource, strategy: "none" };

  return {
    ...winner,
    attempts: {
      legs: {
        matched: legsSource.matched,
        legIndex: legsSource.legIndex,
        extensionId: legsSource.extensionId,
        canonicalKey: legsSource.matched ? legsSource.canonicalKey : null,
      },
      did: {
        matched: didSource.matched,
        did: didSource.did,
        canonicalKey: didSource.matched ? didSource.canonicalKey : null,
      },
    },
  };
}

async function fetchCallRecordWithRetry(candidate, options = {}) {
  const rc = createRingCentralClient();
  const config = getRingCentralConfig();
  const baseMs = options.retryBaseMs || config.sessionRetryBaseMs;
  const maxRetries = options.maxRetries || config.sessionMaxRetries;
  const window = buildCallLogWindow(candidate);
  const query = {
    view: "Detailed",
    dateFrom: window.dateFrom,
    dateTo: window.dateTo,
    type: "Voice",
    perPage: 100,
  };

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    // First attempt fires immediately; subsequent attempts wait with
    // increasing backoff. Callers that need pre-sleep settling time
    // (e.g. the live call-end path) enforce it via `sessionBufferMs`
    // upstream; the retry-specific delay only kicks in when we're
    // actually retrying.
    if (attempt > 1) {
      await sleep(baseMs * (attempt - 1));
    }
    try {
      const extensionLookup = await findMatchingCallRecord(
        (lookupQuery) => rc.getExtensionCallLog(candidate.extensionId, lookupQuery),
        query,
        candidate,
      );
      if (extensionLookup.record) {
        return {
          found: true,
          attempts: attempt,
          window,
          strategy: "extension-call-log",
          record: extensionLookup.record,
        };
      }

      const accountLookup = await findMatchingCallRecord(
        (lookupQuery) => rc.getAccountCallLog(lookupQuery),
        query,
        candidate,
      );
      if (accountLookup.record) {
        return {
          found: true,
          attempts: attempt,
          window,
          strategy: "account-call-log",
          record: accountLookup.record,
        };
      }
    } catch (error) {
      // RC rate-limits call-log endpoints aggressively (HTTP 429). On 429,
      // back off for a full minute before retrying — RC's window resets
      // around that interval. For other errors, fall through to the normal
      // incremental delay above. Always surface on the final attempt.
      const status = error?.status || error?.details?.responseStatus || null;
      if (status === 429 && attempt < maxRetries) {
        await sleep(60_000);
        continue;
      }
      if (attempt === maxRetries) {
        throw error;
      }
    }
  }

  return {
    found: false,
    attempts: maxRetries,
    window,
    record: null,
  };
}

async function processTelephonySessionCandidate(candidate, logger, options = {}) {
  const lookup = await fetchCallRecordWithRetry(candidate);
  if (!lookup.record) {
    const result = await createEvent({
      eventType: "ringcentral.attribution.missed",
      sourceService: "ringcentral-cx",
      aggregateType: "telephony-session",
      aggregateId: candidate.telephonySessionId,
      dedupeKey: `missed:${candidate.telephonySessionId}`,
      payload: {
        candidate,
        lookup,
      },
    });
    logger?.warn("ringcentral.attribution.missed", {
      telephonySessionId: candidate.telephonySessionId,
      attempts: lookup.attempts,
      eventId: String(result.event._id),
    });
    await emitHourlyJobEvent({
      lane: "hourly",
      domain: "TAG",
      eventType: "ringcentral.telephony.attribution.reconcile",
      targetService: "control-plane",
      handlerKey: "reconcileTelephonySessionAttribution",
      aggregateType: "telephony-session",
      aggregateId: candidate.telephonySessionId,
      caseId: null,
      payload: {
        candidate,
        lookup,
      },
      resolutionCheckKey: "telephony-session-attributed",
      resolutionContext: {
        telephonySessionId: candidate.telephonySessionId,
        extensionId: candidate.extensionId || null,
      },
      dedupeKey: `telephony-attribution:${candidate.telephonySessionId}`,
      emittedBy: "ringcentral-cx",
      priority: 65,
      severity: "warning",
      alertSummary: "Telephony attribution missed; hourly reconcile queued",
      immediateRetryAttempts: 1,
      immediateRetryDelayMs: 1000,
      provideSummary: false,
      firstError: "No call record resolved for telephony session",
      notify: false,
    }).catch(() => null);
    return { status: "missed", eventId: String(result.event._id), lookup };
  }

  const source = options.resolveSource
    ? await options.resolveSource({
        record: lookup.record,
        candidate,
        telephonySessionId: candidate.telephonySessionId,
      })
    : await resolveSourceForCallRecord(lookup.record);
  const result = await createEvent({
    eventType: "ringcentral.attribution.resolved",
    sourceService: "ringcentral-cx",
    aggregateType: "telephony-session",
    aggregateId: candidate.telephonySessionId,
    dedupeKey: `resolved:${candidate.telephonySessionId}`,
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
    },
  });

  logger?.info("ringcentral.attribution.resolved", {
    telephonySessionId: candidate.telephonySessionId,
    eventId: String(result.event._id),
    matched: source.matched,
    strategy: source.strategy,
    sourceName: source.internalName,
  });

  return {
    status: "resolved",
    eventId: String(result.event._id),
    source,
  };
}

async function scheduleTelephonySessionEnvelope(envelope, logger, options = {}) {
  const config = getRingCentralConfig();
  const candidates = extractAttributionCandidates(envelope);

  // Default to the unified resolver (Logics → CallRail → legs[0] → DID).
  // Lazy require to avoid the circular module edge at module-load time.
  const resolveSource =
    options.resolveSource ||
    (async ({ record, candidate: cand, telephonySessionId }) => {
      // eslint-disable-next-line global-require
      const { resolveInboundCallSource } = require("./callAttributionResolverService");
      return resolveInboundCallSource({
        domain: cand?.domain || envelope?.ownerDomain || "TAG",
        customerPhone:
          cand?.fromNumber ||
          cand?.toNumber ||
          record?.from?.phoneNumber ||
          null,
        record,
        telephonySessionId,
        logger,
      });
    });

  const scheduled = candidates.map((candidate) => {
    const key = buildSessionKey(candidate);
    const existing = scheduledSessions.get(key);
    if (existing) {
      clearTimeout(existing.timeoutId);
    }

    const timeoutId = setTimeout(async () => {
      scheduledSessions.delete(key);
      try {
        await processTelephonySessionCandidate(candidate, logger, { resolveSource });
      } catch (error) {
        logger?.error("ringcentral.attribution.failed", {
          telephonySessionId: candidate.telephonySessionId,
          error: error.message,
        });
      }
    }, config.sessionBufferMs);

    scheduledSessions.set(key, {
      timeoutId,
      candidate,
      scheduledAt: new Date(),
    });

    return {
      key,
      telephonySessionId: candidate.telephonySessionId,
      extensionId: candidate.extensionId,
    };
  });

  return {
    queued: scheduled.length,
    scheduled,
  };
}

function clearScheduledTelephonySessions() {
  for (const entry of scheduledSessions.values()) {
    clearTimeout(entry.timeoutId);
  }
  scheduledSessions.clear();
}

function getScheduledTelephonySessionState() {
  return {
    queued: scheduledSessions.size,
  };
}

async function probeTelephonySessionLookup(extensionId, telephonySessionId, eventTime) {
  const candidate = {
    extensionId,
    telephonySessionId,
    eventTime,
  };
  const lookup = await fetchCallRecordWithRetry(candidate, {
    maxRetries: 1,
    retryBaseMs: 0,
  });
  const source = lookup.record
    ? await resolveSourceForCallRecord(lookup.record)
    : null;

  return {
    candidate,
    lookup,
    source,
  };
}

module.exports = {
  buildSessionKey,
  extractAttributionCandidates,
  fetchCallRecordWithRetry,
  isTerminalPartyStatus,
  probeTelephonySessionLookup,
  processTelephonySessionCandidate,
  resolveSourceFromDid,
  resolveSourceFromLegs,
  resolveSourceForCallRecord,
  scheduleTelephonySessionEnvelope,
  clearScheduledTelephonySessions,
  getScheduledTelephonySessionState,
};
