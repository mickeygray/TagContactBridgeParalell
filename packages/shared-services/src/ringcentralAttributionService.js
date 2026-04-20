"use strict";

const { createEvent } = require("../../event-core/src");
const { getRingCentralConfig } = require("../../shared-config/src");
const { createRingCentralClient } = require("../../shared-integrations/src");
const { sourceCanonicalRepository } = require("../../shared-repositories/src");

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
      did: phoneNumber,
      sourceCanonicalId: null,
      internalName: "unknown",
      channel: "unknown",
    };
  }

  return {
    matched: true,
    did: phoneNumber,
    sourceCanonicalId: String(canonical._id),
    canonicalKey: canonical.canonicalKey,
    internalName: canonical.internalName,
    channel: canonical.channel,
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
    await sleep(baseMs * attempt);
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

async function processTelephonySessionCandidate(candidate, logger) {
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
    return { status: "missed", eventId: String(result.event._id), lookup };
  }

  const source = await resolveSourceFromDid(
    lookup.record.to?.phoneNumber || candidate.toNumber || null,
  );
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
    did: source.did,
    sourceName: source.internalName,
  });

  return {
    status: "resolved",
    eventId: String(result.event._id),
    source,
  };
}

async function scheduleTelephonySessionEnvelope(envelope, logger) {
  const config = getRingCentralConfig();
  const candidates = extractAttributionCandidates(envelope);

  const scheduled = candidates.map((candidate) => {
    const key = buildSessionKey(candidate);
    const existing = scheduledSessions.get(key);
    if (existing) {
      clearTimeout(existing.timeoutId);
    }

    const timeoutId = setTimeout(async () => {
      scheduledSessions.delete(key);
      try {
        await processTelephonySessionCandidate(candidate, logger);
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
    ? await resolveSourceFromDid(lookup.record.to?.phoneNumber || null)
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
  scheduleTelephonySessionEnvelope,
};
