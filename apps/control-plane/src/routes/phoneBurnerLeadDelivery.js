"use strict";

const crypto = require("crypto");
const express = require("express");
const leadDeliveryRepository = require("../../../../packages/shared-repositories/src/leadDeliveryRepository");
const {
  buildCapturedEventUpgrade,
  buildEventDedupeKey,
  classifyCapturedProviderEvent,
  resolveProviderEventItem,
} = require("../../../../packages/shared-services/src/leadDeliveryService");

const CALLBACK_HOOKS = Object.freeze({
  "contact-displayed": Object.freeze({ sourceHook: "contact_displayed", eventType: "contact_displayed" }),
  "call-begin": Object.freeze({ sourceHook: "call_begin", eventType: "call_begin" }),
  "call-done": Object.freeze({ sourceHook: "call_done", eventType: "call_done" }),
  disposition: Object.freeze({ sourceHook: "disposition", eventType: "call_done" }),
  // The recording does not exist when the call ends — it is still being
  // written. So a URL may arrive LATER, on the disposition callback or on a
  // dedicated recording callback. Both map to call_done so that
  // buildCapturedEventUpgrade's `recordingEvidenceUpgrade` patches the URL
  // onto the attempt already recorded, instead of creating a second event.
  // Registered ahead of need: if PhoneBurner is configured to post one, we
  // accept it; until then it is simply never called.
  recording: Object.freeze({ sourceHook: "recording", eventType: "call_done" }),
  "recording-ready": Object.freeze({ sourceHook: "recording_ready", eventType: "call_done" }),
});

function boundedText(value, maxLength = 256) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function providerId(value) {
  const normalized = boundedText(value, 32);
  return normalized && /^[1-9]\d*$/.test(normalized) ? normalized : null;
}

function opaqueProviderIdentity(value) {
  const normalized = boundedText(value, 256);
  return normalized && /^[A-Za-z0-9._:-]+$/.test(normalized) ? normalized : null;
}

function callbackBoolean(value) {
  if (value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true") return true;
  if (value === false || value === 0 || value === "0" || String(value).toLowerCase() === "false") return false;
  return null;
}

function nonNegativeIntegerOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function callbackAgentId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(normalized) ? normalized : null;
}

function callbackRecordingUrl(value) {
  const normalized = boundedText(value, 2048);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function callbackHook(value) {
  const key = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  const hook = CALLBACK_HOOKS[key];
  if (!hook) throw new TypeError("unsupported PhoneBurner callback hook");
  return hook;
}

function requestDigest(req = {}) {
  const raw = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(JSON.stringify(req.body || {}));
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function normalizePhoneBurnerCallback(sourceHook, body = {}, {
  receivedAt = new Date(),
  payloadDigest,
  sourceAgentId = null,
} = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("callback body must be an object");
  }
  const hook = callbackHook(sourceHook);
  const received = receivedAt instanceof Date ? new Date(receivedAt.getTime()) : new Date(receivedAt);
  if (!Number.isFinite(received.getTime())) throw new TypeError("receivedAt must be a valid date");
  const digest = boundedText(payloadDigest, 64)?.toLowerCase();
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new TypeError("payloadDigest must be SHA-256 hex");

  const providerCallId = providerId(body.call_id ?? body.callId ?? body.contact?.call_id);
  const providerContactId = providerId(
    body.contact_user_id
    ?? body.contactUserId
    ?? body.contact?.user_id
    ?? body.contact?.contact_user_id,
  );
  const providerExternalLeadId = opaqueProviderIdentity(
    body.lead_id
    ?? body.leadId
    ?? body.contact?.lead_id
    ?? body.contact?.leadId,
  );
  const providerEventId = opaqueProviderIdentity(
    body.event_id ?? body.eventId ?? body.callback_id ?? body.callbackId,
  );
  const dispositionToken = boundedText(
    body.status ?? body.disposition ?? body.agent_disposition,
    128,
  );
  const classification = classifyCapturedProviderEvent({
    eventType: hook.eventType,
    providerEventId,
    providerCallId,
    providerContactId,
    providerExternalLeadId,
    rawDisposition: dispositionToken,
  });
  const normalizedOutcome = classification.normalizedOutcome;
  const knownDisposition = normalizedOutcome
    && normalizedOutcome !== "review"
    ? normalizedOutcome
    : null;
  const dispositionDigest = !knownDisposition && dispositionToken
    ? crypto.createHash("sha256").update(dispositionToken).digest("hex")
    : null;
  const event = {
    provider: "phoneburner",
    providerEventId,
    providerCallId,
    providerContactId,
    providerExternalLeadId,
    eventType: hook.eventType,
    receivedAt: received,
    normalizedOutcome,
    payloadDigest: digest,
    safePayload: {
      schemaVersion: 1,
      sourceHook: hook.sourceHook,
      providerDialSessionId: providerId(body.ds_id ?? body.dialsession_id ?? body.dialSessionId),
      dispositionKey: knownDisposition,
      dispositionDigest,
      connected: callbackBoolean(body.connected),
      durationSeconds: nonNegativeIntegerOrNull(body.duration),
      identityStrength: classification.identityStrength,
      captureReason: classification.reason,
      sourceAgentId: callbackAgentId(sourceAgentId),
      // Capture a recording URL from WHATEVER callback carries it. Gating
      // this on call_done meant a URL arriving on any other hook was
      // silently dropped — and since the file is not ready at call end,
      // "later" is the normal case, not the exception.
      recordingUrl: callbackRecordingUrl(
        body.recording_url
        ?? body.recordingUrl
        ?? body.recording?.url
        ?? body.recording
        ?? body.call?.recording_url
        ?? body.audio_url,
      ),
    },
    status: classification.status,
    attempts: 0,
    nextAttemptAt: null,
  };
  // Processable events require a provider occurrence identity. Malformed or
  // observational events may use the digest only because they stay in review.
  buildEventDedupeKey(event);
  return event;
}

function createPhoneBurnerLeadDeliveryDrain({
  repository = leadDeliveryRepository,
  now = () => new Date(),
  logger = null,
} = {}) {
  for (const method of ["listProviderIdentityCandidates", "listEventsForDrain"]) {
    if (typeof repository?.[method] !== "function") throw new TypeError(`repository.${method} is required`);
  }

  function safeLog(event, details) {
    try { logger?.warn?.(event, details); } catch {}
  }

  async function drainEvent(row) {
    if (!row?._id || !["pending", "failed"].includes(String(row.status))) {
      return { processed: false, replayable: false, reason: "event-not-replayable", actionsEnabled: false };
    }
    try {
      const candidates = await repository.listProviderIdentityCandidates(row);
      const resolution = resolveProviderEventItem(candidates, row);
      return {
        processed: false,
        replayable: true,
        identityResolution: resolution.status,
        reason: resolution.reason,
        actionsEnabled: false,
      };
    } catch {
      safeLog("phoneburner.lead_delivery.preview_failed", { reason: "phase4-preview-failed" });
      return {
        processed: false,
        replayable: true,
        reason: "phase4-preview-failed",
        actionsEnabled: false,
      };
    }
  }

  async function drainOnce({ limit = 50 } = {}) {
    const rows = await repository.listEventsForDrain({ limit, now: now() });
    const results = [];
    for (const row of Array.isArray(rows) ? rows : []) results.push(await drainEvent(row));
    return {
      scanned: Array.isArray(rows) ? rows.length : 0,
      replayable: results.filter((result) => result.replayable).length,
      resolved: results.filter((result) => result.identityResolution === "resolved").length,
      review: 0,
      actionsEnabled: false,
    };
  }

  return { drainEvent, drainOnce };
}

function createPhoneBurnerLeadDeliveryRuntime(options = {}) {
  const router = express.Router();
  const repository = options.repository || leadDeliveryRepository;
  if (typeof repository.insertEventOnce !== "function") throw new TypeError("repository.insertEventOnce is required");
  const captureEnabled = options.captureEnabled === true;
  const actionsEnabled = options.actionsEnabled === true;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const logger = options.logger || null;
  const drain = options.drain || createPhoneBurnerLeadDeliveryDrain({ repository, now, logger });
  const schedule = options.schedule || ((work) => setImmediate(work));
  const allowedAgentIds = new Set((options.allowedAgentIds || [])
    .map(callbackAgentId)
    .filter(Boolean));
  // Kept only for old deterministic harnesses during the no-delete proving
  // window. Production does not enable either legacy owner; exact event drain
  // in leadDeliveryService is the sole callback path.
  // The simple runtime drain is the only production callback owner. The extra
  // compatibility switch prevents an old option bundle from accidentally
  // reviving pulse counters or URL-selected refill ownership.
  const legacyCallbackOwnersEnabled = options.legacyCallbackOwnersEnabled === true;
  const legacyPulseModeEnabled = legacyCallbackOwnersEnabled
    && options.legacyPulseModeEnabled === true;
  const legacyRouteOwnerEnabled = legacyCallbackOwnersEnabled
    && options.legacyRouteOwnerEnabled === true;
  const callEndPulseEvery = legacyPulseModeEnabled
    ? nonNegativeIntegerOrNull(options.callEndPulseEvery) || 0
    : 0;
  const onAgentLowWater = legacyPulseModeEnabled && typeof options.onAgentLowWater === "function"
    ? options.onAgentLowWater
    : null;
  const onFloorLowWater = legacyPulseModeEnabled && typeof options.onFloorLowWater === "function"
    ? options.onFloorLowWater
    : null;
  const onAgentCallEnd = legacyRouteOwnerEnabled && typeof options.onAgentCallEnd === "function"
    ? options.onAgentCallEnd
    : null;
  const callEndCounts = new Map();
  let floorCallEndCount = 0;

  function safeLog(event, details) {
    try { logger?.warn?.(event, details); } catch {}
  }

  function safeInfo(event, details) {
    try { logger?.info?.(event, details); } catch {}
  }

  function safeDrainDetails(result) {
    return {
      status: boundedText(result?.status, 64) || "unknown",
      seen: nonNegativeIntegerOrNull(result?.seen) || 0,
      processed: nonNegativeIntegerOrNull(result?.processed) || 0,
    };
  }

  function scheduleSafely(work) {
    const guarded = () => Promise.resolve().then(work).catch(() => {
      safeLog("phoneburner.lead_delivery.scheduled_preview_failed", { reason: "phase4-preview-failed" });
    });
    try { schedule(guarded); } catch {
      safeLog("phoneburner.lead_delivery.schedule_failed", { reason: "phase4-schedule-failed" });
    }
  }

  async function resolveGenericCallbackAgent(event) {
    const candidates = await repository.listProviderIdentityCandidates(event);
    const resolution = resolveProviderEventItem(candidates, event);
    const agentId = resolution.status === "resolved"
      ? callbackAgentId(resolution.item?.deliveryAgentId)
      : null;
    if (!agentId || !allowedAgentIds.has(agentId)) {
      return {
        agentId: null,
        reason: resolution.status === "resolved"
          ? "resolved-agent-not-enabled"
          : resolution.reason,
      };
    }
    return { agentId, reason: "provider-identity-agent-match" };
  }

  async function meterAgentCallEnd(agentId) {
    const observed = (callEndCounts.get(agentId) || 0) + 1;
    const atLowWater = observed >= callEndPulseEvery;
    callEndCounts.set(agentId, atLowWater ? 0 : observed);
    safeInfo("phoneburner.lead_delivery.call_end_meter", {
      scope: "agent",
      agentId,
      observed: atLowWater ? callEndPulseEvery : observed,
      lowWater: atLowWater,
    });
    if (!atLowWater) return { status: "metered", accepted: 0, agentId };
    const result = await onAgentLowWater({
      agentId,
      observedCallEnds: callEndPulseEvery,
    });
    safeInfo("phoneburner.lead_delivery.synthetic_refill", {
      scope: "agent",
      agentId,
      status: boundedText(result?.status, 64) || "unknown",
      accepted: nonNegativeIntegerOrNull(result?.accepted) || 0,
    });
    return result;
  }

  function capture(sourceHook) {
    return async function capturePhoneBurnerCallback(req, res, next) {
      try {
        if (!captureEnabled) return res.status(503).json({ ok: false, error: "phoneburner-capture-disabled" });
        const requestedAgent = req.params?.agentId ?? req.query?.agent;
        const requestedAgentId = requestedAgent == null
          ? null
          : callbackAgentId(requestedAgent);
        if (requestedAgent != null
          && (!requestedAgentId || !allowedAgentIds.has(requestedAgentId))) {
          return res.status(422).json({ ok: false, error: "invalid-phoneburner-agent" });
        }
        let event;
        try {
          event = normalizePhoneBurnerCallback(sourceHook, req.body, {
            receivedAt: now(),
            payloadDigest: requestDigest(req),
            sourceAgentId: requestedAgentId,
          });
        } catch {
          return res.status(422).json({ ok: false, error: "invalid-phoneburner-callback" });
        }
        let created;
        let inserted = false;
        let upgraded = false;
        try {
          created = await repository.insertEventOnce(event);
          inserted = created !== null;
          if (created === null
            && typeof repository.findEventByDedupeKey === "function"
            && typeof repository.upgradeEventEvidenceCas === "function") {
            const existing = await repository.findEventByDedupeKey(event);
            const upgrade = existing ? buildCapturedEventUpgrade(existing, event) : null;
            if (upgrade) {
              const strengthened = await repository.upgradeEventEvidenceCas({
                eventId: existing._id,
                expectedVersion: existing.version,
                expected: upgrade.expected,
                set: upgrade.set,
              });
              if (strengthened) {
                created = strengthened;
                upgraded = true;
              }
            }
          }
        } catch {
          safeLog("phoneburner.lead_delivery.capture_failed", { reason: "event-persistence-failed" });
          return res.status(503).json({ ok: false, error: "event-capture-unavailable" });
        }
        if (created !== null && (!created || !created._id)) {
          safeLog("phoneburner.lead_delivery.capture_failed", { reason: "invalid-persistence-result" });
          return res.status(503).json({ ok: false, error: "event-capture-unavailable" });
        }
        res.status(200).json({
          ok: true,
          accepted: true,
          duplicate: created === null,
          upgraded,
          actionsEnabled,
        });
        const singleOwnerCallEnd = inserted
          && event.eventType === "call_done"
          && Boolean(event.providerCallId)
          && Boolean(onAgentCallEnd);
        if (singleOwnerCallEnd) {
          scheduleSafely(async () => {
            const resolution = requestedAgentId
              ? { agentId: requestedAgentId, reason: "scoped-route" }
              : await resolveGenericCallbackAgent(event);
            if (!resolution.agentId) {
              safeLog("phoneburner.lead_delivery.call_end_agent_unresolved", {
                reason: boundedText(resolution.reason, 128) || "agent-unresolved",
              });
              const drained = await drain.drainEvent(created);
              safeInfo("phoneburner.lead_delivery.callback_drained", safeDrainDetails(drained));
              return drained;
            }
            const result = await onAgentCallEnd({
              agentId: resolution.agentId,
              eventId: String(created._id),
            });
            safeInfo("phoneburner.lead_delivery.call_end_processed", {
              agentId: resolution.agentId,
              status: boundedText(result?.status, 64) || "unknown",
              accepted: nonNegativeIntegerOrNull(result?.accepted) || 0,
            });
            return result;
          });
        }
        // Legacy pulse/route-owner code is hard-gated for the no-delete proving
        // window. Production falls through to exact drain below.
        if (!singleOwnerCallEnd && inserted
          && event.eventType === "call_done"
          && event.providerCallId
          && callEndPulseEvery > 0) {
          const scopedToAgent = Boolean(requestedAgentId && onAgentLowWater);
          const genericResolvesToAgent = Boolean(!requestedAgentId && onAgentLowWater);
          const scopedToFloor = Boolean(!requestedAgentId && onFloorLowWater);
          if (scopedToAgent) {
            scheduleSafely(() => meterAgentCallEnd(requestedAgentId));
          } else if (genericResolvesToAgent) {
            scheduleSafely(async () => {
              const resolution = await resolveGenericCallbackAgent(event);
              if (!resolution.agentId) {
                safeLog("phoneburner.lead_delivery.call_end_agent_unresolved", {
                  reason: boundedText(resolution.reason, 128) || "agent-unresolved",
                });
                return { status: "agent-unresolved", accepted: 0 };
              }
              return meterAgentCallEnd(resolution.agentId);
            });
          } else if (scopedToFloor) {
          const observed =
            scopedToFloor
              ? floorCallEndCount + 1
              : 0;
          const atLowWater = observed >= callEndPulseEvery;
          if (scopedToFloor) floorCallEndCount = atLowWater ? 0 : observed;
          safeInfo("phoneburner.lead_delivery.call_end_meter", {
            scope: "floor",
            agentId: null,
            observed: atLowWater ? callEndPulseEvery : observed,
            lowWater: atLowWater,
          });
          if (atLowWater) {
            scheduleSafely(async () => {
              const result = scopedToAgent
                ? await onAgentLowWater({
                  agentId: requestedAgentId,
                  observedCallEnds: callEndPulseEvery,
                })
                : await onFloorLowWater({ observedCallEnds: callEndPulseEvery });
              safeInfo("phoneburner.lead_delivery.synthetic_refill", {
                scope: "floor",
                agentId: callbackAgentId(result?.agentId),
                status: boundedText(result?.status, 64) || "unknown",
                accepted: nonNegativeIntegerOrNull(result?.accepted) || 0,
              });
              return result;
            });
          }
          }
        }
        safeInfo("phoneburner.lead_delivery.callback_accepted", {
          sourceHook: event.safePayload.sourceHook,
          eventType: event.eventType,
          normalizedOutcome: event.normalizedOutcome || "review",
          captureStatus: event.status,
          identityStrength: event.safePayload.identityStrength,
          hasProviderCallId: Boolean(event.providerCallId),
          hasProviderContactId: Boolean(event.providerContactId),
          hasProviderExternalLeadId: Boolean(event.providerExternalLeadId),
          duplicate: created === null,
          upgraded,
          actionsEnabled,
        });
        if (!singleOwnerCallEnd && created && ["pending", "failed"].includes(created.status)) {
          scheduleSafely(async () => {
            const result = await drain.drainEvent(created);
            safeInfo("phoneburner.lead_delivery.callback_drained", safeDrainDetails(result));
            return result;
          });
        } else if (created === null) {
          scheduleSafely(async () => {
            const result = await drain.drainOnce({ limit: 50 });
            safeInfo("phoneburner.lead_delivery.callback_drained", safeDrainDetails(result));
            return result;
          });
        }
        return undefined;
      } catch (error) {
        return next(error);
      }
    };
  }

  for (const path of Object.keys(CALLBACK_HOOKS)) router.post(`/${path}`, capture(path));
  router.post("/call-done/:agentId", capture("call-done"));
  return { router, drainOnce: drain.drainOnce, drainEvent: drain.drainEvent };
}

module.exports = {
  CALLBACK_HOOKS,
  callbackHook,
  createPhoneBurnerLeadDeliveryDrain,
  createPhoneBurnerLeadDeliveryRuntime,
  normalizePhoneBurnerCallback,
  requestDigest,
};
