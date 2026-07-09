"use strict";

// Service entry for the bulk_load rail — the thin boundary the routes call.
//
// It does three jobs and nothing else: resolve the agent context (admin guard),
// apply the runtime gate (only an agent resolved to bulk_load may proceed), and
// delegate to the tested orchestrator with the REAL adapters wired in. The
// orchestrator (cxBulkLoadRuntimeService) stays pure-injectable; this file owns the
// concrete wiring (RingCX client, repo, cadence finalizer). Mirrors the slow lane's
// resolveAgentContext + cadence approach so the two rails finalize consistently.

const crypto = require("crypto");

const { createRingcxVoiceClient } = require("../../shared-integrations/src");
const {
  cxBulkLoadSessionRepository,
  cxDialQueueRepository,
  cxTerminalOutboxRepository,
  agentStateRepository,
  queueItemRepository,
  userAccountRepository,
} = require("../../shared-repositories/src");

const leadSource = require("./cxBulkLoadLeadSourceService");
const publisher = require("./cxBulkLoadRingcxPublisher");
const watcher = require("./cxBulkLoadActiveCallWatcher");
const { createCxBulkLoadOutcomeAdapter, makeOutcomeIdemKey, buildReviewCorrectionRow } = require("./cxBulkLoadOutcomeAdapter");
const { logCxAlpha, redactCxAlphaPayload } = require("./cxAlphaTraceService");
const { createCxBulkLoadRuntimeService } = require("./cxBulkLoadRuntimeService");
const { reduceCxBulkLoadState } = require("./cxBulkLoadStateMachine");
const { createCxQueueReservationService } = require("./cxQueueReservationService");
const { buildFamilyTargets } = require("./cxReserveModeService");
const { resolveCxDialRuntimeMode, isCxBulkLoadRuntime } = require("./cxDialRuntimeModeService");
const {
  isTransientContactEligibilityBlock,
  resolveCaseContactEligibility,
} = require("./contactEligibilityService");
const { handleCxTerminalCallOutcome, resolveRingcxPublishedCopies } = require("./cxCadenceService");
const { cancelPublishedQueueItemInRingcx } = require("./ringcxLeadServingService");
const { executeCxHangupRequest } = require("./ringcxDialExecutionService");
const { getLaneCall, clearLaneCall } = require("./cxLaneCallRegistry");
const { parseLaneExternId } = require("./cxLaneRegistry");

function readEnv(name, fallback = "") {
  const v = process.env[name];
  return v != null && v !== "" ? String(v) : fallback;
}

function readBooleanEnv(name, fallback = false) {
  const value = readEnv(name, "");
  if (!value) return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return fallback;
}

function readDurationEnvMs(name, fallback) {
  const value = Number(readEnv(name, ""));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readIntegerEnv(name, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(readEnv(name, ""));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function isDispositionTraceEnabled() {
  return /^(1|true|yes|on)$/i.test(readEnv("CX_BULK_LOAD_DISPOSITION_TRACE"));
}

function createDispositionTrace(scope) {
  if (!isDispositionTraceEnabled()) return () => {};
  const startedAt = Date.now();
  return (label, extra) => {
    console.log(
      `[DISPTRACE] ${scope}:${label} +${Date.now() - startedAt}ms`,
      extra !== undefined ? extra : "",
    );
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dispositionProbeBase(session = {}, candidate = {}, extra = {}) {
  return {
    rail: session.rail || "bulk_load",
    sessionId: session.sessionId || null,
    agentEmail: session.agentEmail || null,
    agentExtensionId: session.agentExtensionId || null,
    cxAgentId: session.cxAgentId || null,
    accountId: session.ringcx?.accountId || candidate.accountId || candidate.ringcx?.accountId || null,
    domain: session.domain || candidate.domain || null,
    queueItemId: String(candidate.queueItemId || candidate.id || candidate._id || "") || null,
    externId: candidate.externId || candidate.ringcx?.externId || null,
    uii: normalizeExternalId(candidate.uii) || null,
    ...extra,
  };
}

function logDispositionProbe(event, payload = {}) {
  try {
    logCxAlpha(event, redactCxAlphaPayload(payload), { force: true });
  } catch (_err) {
    // Diagnostics must never affect call handling.
  }
}

function summarizeDispositionProbeActiveCall(call = {}) {
  if (!call || typeof call !== "object") return null;
  return redactCxAlphaPayload({
    uii: normalizeExternalId(call.uii) || null,
    externalId: normalizeExternalId(call.externalId || call.externId) || null,
    callState: call.callState || call.state || call.status || null,
    state: call.state || null,
    status: call.status || null,
    direction: call.direction || call.callDirection || null,
    campaignId: call.campaignId || call.campaign?.id || null,
    dialGroupId: call.dialGroupId || call.dialGroup?.id || null,
    ani: call.ani || call.from || call.fromNumber || null,
    dnis: call.dnis || call.to || call.toNumber || null,
    phone: call.phone || call.leadPhone || call.destination || null,
  });
}

function logDispositionProbeSent({ session = {}, candidate = {}, uii, disposition, outcome, response } = {}) {
  const normalizedUii = normalizeExternalId(uii);
  if (!normalizedUii) return;
  logDispositionProbe("cx.alpha.disposition.probe.sent", dispositionProbeBase(session, candidate, {
    uii: normalizedUii,
    outcome,
    disposition,
    callback: false,
    request: { disposition, callback: false },
    response,
  }));
}

async function runPostDispositionHangupProbe(client, { session = {}, candidate = {}, uii, disposition, outcome } = {}) {
  const normalizedUii = normalizeExternalId(uii);
  const base = dispositionProbeBase(session, candidate, {
    uii: normalizedUii,
    outcome,
    disposition,
    callback: false,
  });
  if (String(outcome || "").trim().toLowerCase() === "voicemail") {
    // VM DROP is an xfer:2 disposition — RingCX ends the call BY TRANSFERRING the
    // leg to the drop system, so the leg must stay alive for the playback handoff.
    // Hanging up here kills the drop mid-transfer (field find 2026-07-06: VM DROP
    // accepted, our hangup accepted 1s later, no voicemail ever landed). This
    // probe exists for Auto Dispo (xfer:0), which records but doesn't drop.
    const result = { ok: true, executed: false, skipped: true, reason: "voicemail-transfer-owns-call-end" };
    logDispositionProbe("cx.alpha.disposition.probe.post_hangup.skipped", { ...base, ...result });
    return result;
  }
  if (!client || typeof client.hangupCall !== "function" || !normalizedUii) {
    const result = { ok: false, executed: false, skipped: true, reason: "hangup-unavailable" };
    logDispositionProbe("cx.alpha.disposition.probe.post_hangup.skipped", { ...base, ...result });
    return result;
  }
  logDispositionProbe("cx.alpha.disposition.probe.post_hangup.started", {
    ...base,
    request: { hangupCall: true },
  });
  try {
    const response = await client.hangupCall(normalizedUii);
    const ok = response !== false;
    const result = {
      ok,
      executed: true,
      status: ok ? "accepted" : "returned-false",
      response,
    };
    logDispositionProbe("cx.alpha.disposition.probe.post_hangup.finished", { ...base, ...result });
    return result;
  } catch (error) {
    const alreadyEnded = isAlreadyEndedHangupError(error);
    const result = {
      ok: alreadyEnded,
      executed: true,
      status: alreadyEnded ? "already-ended" : "error",
      alreadyEnded,
      error: error && error.message ? error.message : String(error),
      httpStatus: error && error.status ? error.status : null,
    };
    logDispositionProbe("cx.alpha.disposition.probe.post_hangup.error", { ...base, ...result });
    return result;
  }
}

function scheduleDispositionProbeSnapshots(client, { session = {}, candidate = {}, uii, disposition, outcome, postDispositionHangup = null } = {}) {
  const normalizedUii = normalizeExternalId(uii);
  if (!client || typeof client.listActiveCalls !== "function" || !normalizedUii) return;
  const accountId = session.ringcx?.accountId || candidate.accountId || candidate.ringcx?.accountId || null;
  const startedAt = Date.now();
  const base = dispositionProbeBase(session, candidate, {
    uii: normalizedUii,
    outcome,
    disposition,
    callback: false,
    postDispositionHangup,
  });

  for (const delayMs of [0, 1000, 3000, 8000]) {
    const timer = setTimeout(async () => {
      try {
        const payload = await client.listActiveCalls({
          product: "ACCOUNT",
          productId: accountId || undefined,
          maxRows: 100,
        });
        const calls = activeCallList(payload);
        const matches = calls
          .filter((call) => normalizeExternalId(call?.uii) === normalizedUii)
          .map(summarizeDispositionProbeActiveCall)
          .filter(Boolean);
        logDispositionProbe("cx.alpha.disposition.probe.active_call_snapshot", {
          ...base,
          delayMs,
          elapsedMs: Date.now() - startedAt,
          activeCallCount: calls.length,
          matchedUiiCount: matches.length,
          matchedUiiStillActive: matches.length > 0,
          matches,
        });
      } catch (error) {
        logDispositionProbe("cx.alpha.disposition.probe.active_call_snapshot_error", {
          ...base,
          delayMs,
          elapsedMs: Date.now() - startedAt,
          error: error && error.message ? error.message : String(error),
          status: error && error.status ? error.status : null,
        });
      }
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeExternalId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase() || "TAG";
}

function envToken(value) {
  const token = String(value || "").trim();
  if (!token) return null;
  const normalized = token
    .replace(/@/g, "_AT_")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized || null;
}

function resolveBulkAgentRingcxRoute(agent = {}, input = {}) {
  const account = agent.account || {};
  const tokens = [
    input.agentExtensionId,
    input.extensionId,
    agent.agentExtensionId,
    input.cxAgentId,
    input.ringcxAgentId,
    agent.cxAgentId,
    input.agentEmail,
    agent.agentEmail,
    account.email,
    account.name,
  ];
  for (const token of tokens) {
    const suffix = envToken(token);
    if (!suffix) continue;
    const dialGroupId = normalizeExternalId(readEnv(`RINGCX_AGENT_ROUTE_${suffix}_DIAL_GROUP_ID`));
    const campaignId = normalizeExternalId(readEnv(`RINGCX_AGENT_ROUTE_${suffix}_CAMPAIGN_ID`));
    if (dialGroupId || campaignId) {
      return { dialGroupId, campaignId, matchedToken: String(token) };
    }
  }
  return { dialGroupId: null, campaignId: null, matchedToken: null };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return null;
}

const progressivePauseTokens = new Map();

function progressivePauseKey(agentId, agentGroupId) {
  return `${normalizeExternalId(agentGroupId) || "group?"}:${normalizeExternalId(agentId) || "agent?"}`;
}

function resolveProgressivePauseStateIds() {
  return {
    pauseStateId: firstNonEmpty(
      process.env.CX_BULK_LOAD_PROGRESSIVE_PAUSE_STATE_ID,
      process.env.RINGCX_VOICE_AUX_WORKING_STATE_ID,
      process.env.RINGCX_VOICE_AUX_ON_BREAK_STATE_ID,
      process.env.RINGCX_VOICE_AUX_AWAY_STATE_ID,
    ),
    availableStateId: firstNonEmpty(
      process.env.CX_BULK_LOAD_PROGRESSIVE_AVAILABLE_STATE_ID,
      process.env.RINGCX_VOICE_AUX_AVAILABLE_STATE_ID,
    ),
  };
}

async function restoreProgressivePause({ client, key, agentId, agentGroupId, availableStateId, token, pauseMs }) {
  await sleep(pauseMs);
  if (progressivePauseTokens.get(key) !== token) return { ok: true, skipped: true, reason: "superseded" };
  await client.setAgentState(agentId, availableStateId, agentGroupId);
  if (progressivePauseTokens.get(key) === token) progressivePauseTokens.delete(key);
  return { ok: true, restored: true };
}

async function pauseRingcxProgressiveDialing(client, session = {}, options = {}) {
  if (!readBooleanEnv("CX_BULK_LOAD_PROGRESSIVE_PAUSE_ENABLED", true)) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!client || typeof client.setAgentState !== "function") {
    return { ok: false, skipped: true, reason: "set-agent-state-unavailable" };
  }
  const agentId = normalizeExternalId(session.cxAgentId || options.agentId);
  const agentGroupId = normalizeExternalId(
    session.ringcx?.agentGroupId ||
      options.agentGroupId ||
      process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID,
  );
  if (!agentId || !agentGroupId) {
    return { ok: false, skipped: true, reason: !agentId ? "missing-agent-id" : "missing-agent-group-id" };
  }

  const pauseMs = readDurationEnvMs("CX_BULK_LOAD_PROGRESSIVE_PAUSE_MS", 3000);
  if (pauseMs <= 0) return { ok: true, skipped: true, reason: "zero-duration" };

  const { pauseStateId, availableStateId } = resolveProgressivePauseStateIds();
  if (!pauseStateId || !availableStateId) {
    return {
      ok: false,
      skipped: true,
      reason: !pauseStateId ? "missing-pause-state-id" : "missing-available-state-id",
    };
  }

  const key = progressivePauseKey(agentId, agentGroupId);
  const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  progressivePauseTokens.set(key, token);
  await client.setAgentState(agentId, pauseStateId, agentGroupId);
  console.info("[cx-bulk-load] progressive_pause.set", {
    agentId,
    agentGroupId,
    pauseMs,
    holdUntilResume: options.holdUntilResume === true,
    reason: options.reason || null,
  });

  if (options.holdUntilResume === true) {
    return {
      ok: true,
      paused: true,
      restoreScheduled: false,
      holdUntilResume: true,
      pauseMs,
      reason: options.reason || null,
    };
  }

  const restore = restoreProgressivePause({
    client,
    key,
    agentId,
    agentGroupId,
    availableStateId,
    token,
    pauseMs,
  });
  if (options.waitForRestore === true) {
    const restored = await restore;
    return {
      ok: restored.ok !== false,
      paused: true,
      restored: restored.restored === true,
      pauseMs,
      reason: options.reason || null,
    };
  }
  restore.catch((error) => {
    console.warn("[cx-bulk-load] progressive_pause.restore_failed", {
      agentId,
      agentGroupId,
      reason: options.reason || null,
      error: error && error.message ? error.message : String(error),
    });
  });
  restore.then((result) => {
    if (result?.restored) {
      console.info("[cx-bulk-load] progressive_pause.restored", {
        agentId,
        agentGroupId,
        reason: options.reason || null,
      });
    }
  });
  return {
    ok: true,
    paused: true,
    restoreScheduled: true,
    pauseMs,
    reason: options.reason || null,
  };
}

async function resumeRingcxProgressiveDialing(client, session = {}, options = {}) {
  if (!readBooleanEnv("CX_BULK_LOAD_PROGRESSIVE_PAUSE_ENABLED", true)) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!client || typeof client.setAgentState !== "function") {
    return { ok: false, skipped: true, reason: "set-agent-state-unavailable" };
  }
  const agentId = normalizeExternalId(session.cxAgentId || options.agentId);
  const agentGroupId = normalizeExternalId(
    session.ringcx?.agentGroupId ||
      options.agentGroupId ||
      process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID,
  );
  if (!agentId || !agentGroupId) {
    return { ok: false, skipped: true, reason: !agentId ? "missing-agent-id" : "missing-agent-group-id" };
  }
  const { availableStateId } = resolveProgressivePauseStateIds();
  if (!availableStateId) {
    return { ok: false, skipped: true, reason: "missing-available-state-id" };
  }
  const key = progressivePauseKey(agentId, agentGroupId);
  progressivePauseTokens.delete(key);
  await client.setAgentState(agentId, availableStateId, agentGroupId);
  console.info("[cx-bulk-load] progressive_pause.resumed", {
    agentId,
    agentGroupId,
    reason: options.reason || null,
  });
  return { ok: true, resumed: true, reason: options.reason || null };
}

function activeCallList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.activeCalls)) return payload.activeCalls;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function isAlreadyEndedHangupError(error) {
  if (!error) return false;
  const status = Number(error.status || error.details?.responseStatus || 0);
  if (status === 404 || status === 410) return true;
  const responseBody = error.details?.responseBody;
  const haystack = [
    error.message,
    typeof responseBody === "string" ? responseBody : "",
    responseBody && typeof responseBody === "object" ? JSON.stringify(responseBody) : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /already\s+(ended|complete|completed|disconnected)|no\s+active\s+call|active\s+call\s+not\s+found|call\s+not\s+found|cannot\s+find\s+call/.test(haystack);
}


// GHOST RESCUE decision (pure; 2026-07-06). A ghost call a human answered can be re-adopted
// ("synced") ONLY when the row died innocently. Never rescued: DNC/contact-blocked cancels
// (compliance owns those rows), rows another live session reserved (theirs), and rows in
// claimed/serving (the normal stamp owns those — a miss there is a race, retried next tick).
function deriveRescueDecision(row = null, sessionId = null) {
  if (!row) return { rescue: false, reason: "row-missing" };
  const meta = row.metadata || {};
  // BOTH reason keys: cancelReserved writes metadata.cancelledReason, but the compliance
  // stop path (stopCaseContact → cancelActiveQueueItems) writes metadata.cancelReason —
  // reading only one disarmed this gate against the system's own primary DNC writer
  // (adversarial finding, 2026-07-06).
  const cancelledReason = `${meta.cancelledReason || ""} ${meta.cancelReason || ""}`;
  if (/dnc|contact-blocked/i.test(cancelledReason)) return { rescue: false, reason: "contact-blocked" };
  const owner = String(meta.reservationSessionId || "");
  if (owner && owner !== String(sessionId || "")) return { rescue: false, reason: "reservation-foreign" };
  const state = String(row.state || "").trim().toLowerCase();
  if (!["ready", "cancelled"].includes(state)) return { rescue: false, reason: `state-${state || "unknown"}` };
  return { rescue: true, reason: `rescue-from-${state}` };
}

// Map a bulk call outcome to the REAL RingCX disposition name (the ones actually
// configured on the campaigns). Dispositioning the active call is what ends it
// and advances the dialer — so the name must be one RingCX recognizes.
function bulkOutcomeDisposition(outcome) {
  switch (String(outcome || "").trim().toLowerCase()) {
    case "voicemail":
      return "VM DROP";
    case "dnc":
    case "bad_number":
    case "wrong_number":
      // RingCX only needs the fast close disposition here. The app outcome
      // remains specific in the terminal outbox for app-side handling.
      return "Auto Dispo";
    case "answered":
    case "did-not-answer":
    case "did_not_connect":
    default:
      return "Auto Dispo";
  }
}

function normalizeLaneOutcome(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "did-not-answer" || normalized === "no-answer" || normalized === "no_answer") {
    return "did_not_connect";
  }
  if (["answered", "did_not_connect", "voicemail", "bad_number"].includes(normalized)) return normalized;
  return null;
}

// F2 CONSUMPTION (2026-07-08): a dispositioned lane call persists a REAL terminal into
// the trunk — the same outbox row an ordinary bulk disposition writes, keyed to the REAL
// queue row (the cxft extern carries the row id; the cxapt extern carries the appointment
// key). The drain then does everything it always does: completes the row, counts cadence,
// RELEASES the firstTouchPending mark (the terminal handler consumes it), and an answered
// call mints its wrap card via the fast-mint route. Appointments additionally resolve
// through the existing resolver (completed + resolvedDisposition — kept/missed by verdict).
// deps injectable for pins; fail-soft: consumption failing never un-dispositions the call.
async function persistLaneCallConsumption({ laneCall = {}, session = {}, outcome = null, agentEmail = null, deps = {} } = {}) {
  const parsed = parseLaneExternId(laneCall.externId);
  if (!parsed) return { ok: false, reason: "unparseable-extern" };
  const insertOutboxRow = deps.insertOutboxRow
    || ((row) => cxTerminalOutboxRepository.insertOnce(row));
  const at = new Date().toISOString();

  async function persistTerminalFor(queueItemId, extra = {}) {
    if (!queueItemId) return { ok: false, reason: "no-queue-item" };
    const badNumber = String(outcome || "").trim().toLowerCase().replace(/[\s-]+/g, "_") === "bad_number";
    const idemKey = makeOutcomeIdemKey({
      sessionId: session.sessionId,
      queueItemId,
      uii: laneCall.uii,
      eventType: "terminal",
    });
    const payload = {
      sessionId: session.sessionId || null,
      domain: laneCall.domain || null,
      agentEmail: agentEmail || null,
      queueItemId: String(queueItemId),
      caseId: laneCall.caseId ?? null,
      externId: laneCall.externId || null,
      uii: laneCall.uii || null,
      name: laneCall.name || null,
      outcome,
      eventType: "terminal",
      lane: laneCall.lane || parsed.lane,
      source: "lane-call-disposition",
      sourceService: "cx-lane-call",
      badNumber,
      badNumberReason: badNumber ? "disconnected-or-out-of-service" : null,
      at,
      idemKey,
      ...extra,
    };
    const inserted = await insertOutboxRow({
      idemKey,
      sessionId: session.sessionId || null,
      rail: "lane_call",
      domain: laneCall.domain || null,
      queueItemId: String(queueItemId),
      uii: laneCall.uii || null,
      caseId: laneCall.caseId ?? null,
      agentEmail: agentEmail || null,
      externId: laneCall.externId || null,
      outcome,
      payload,
    });
    return { ok: true, idemKey, duplicate: inserted === null };
  }

  if (parsed.lane === "firstTouch") {
    const terminal = await persistTerminalFor(parsed.queueItemId);
    return { ok: terminal.ok, lane: "firstTouch", terminalPersisted: terminal.ok, idemKey: terminal.idemKey || null, duplicate: terminal.duplicate === true };
  }

  if (parsed.lane === "appointment") {
    const resolveAppointment = deps.resolveAppointment
      || ((input) => require("./cxAppointmentService").resolveCxAppointmentAfterDisposition(input));
    const resolved = await resolveAppointment({
      domain: laneCall.domain || null,
      caseId: laneCall.caseId ?? null,
      // the extern IS the appointment key — hand it to the resolver via the synthetic row
      queueItem: { metadata: { appointmentId: parsed.appointmentId } },
      disposition: outcome,
      actorEmail: agentEmail || "cx-lane-call",
      cancel: false,
    }).catch((error) => ({ ok: false, error: error?.message }));
    const appointment = resolved?.appointment || null;
    const queueItemId = appointment?.cxQueueRecordId ? String(appointment.cxQueueRecordId) : null;
    const terminal = queueItemId ? await persistTerminalFor(queueItemId) : { ok: false, reason: "no-appointment-queue-row" };
    return {
      ok: resolved?.ok !== false,
      lane: "appointment",
      appointmentResolved: resolved?.ok !== false,
      terminalPersisted: terminal.ok === true,
      idemKey: terminal.idemKey || null,
    };
  }

  return { ok: false, reason: "bulk-extern-not-lane" };
}

async function executeLaneCallDisposition({ laneCall = null, outcome = null, client = null, agent = {}, notes = null } = {}) {
  const normalizedOutcome = normalizeLaneOutcome(outcome);
  if (!normalizedOutcome) {
    throw makeHttpError("Unsupported lane call disposition", 400, "cx-lane-call-disposition-unsupported");
  }
  const uii = normalizeExternalId(laneCall?.uii);
  if (!laneCall || !uii) {
    return {
      ok: false,
      dispositionOk: false,
      reason: "missing-lane-call-uii",
      terminal: { ok: false, executed: false, reason: "missing-lane-call-uii" },
    };
  }
  const ringcx = client || createRingcxVoiceClient();
  const disposition = bulkOutcomeDisposition(normalizedOutcome);
  const session = {
    rail: "lane_call",
    sessionId: `lane:${normalizeEmail(agent.agentEmail) || "unknown"}`,
    agentEmail: normalizeEmail(agent.agentEmail) || null,
    agentExtensionId: normalizeExternalId(agent.agentExtensionId || ""),
    domain: laneCall.domain || null,
    ringcx: {},
  };
  const candidate = {
    queueItemId: laneCall.externId || laneCall.uii || null,
    caseId: laneCall.caseId ?? null,
    domain: laneCall.domain || null,
    name: laneCall.name || null,
    uii,
    externId: laneCall.externId || null,
    ringcx: { externId: laneCall.externId || null },
  };

  try {
    const response = await ringcx.dispositionCall(uii, {
      disposition,
      callback: false,
      notes: notes || undefined,
    });
    const accepted = response !== false;
    logDispositionProbeSent({ session, candidate, uii, disposition, outcome: normalizedOutcome, response });
    if (!accepted) {
      logCxAlpha("cx.alpha.disposition.transport", {
        rail: "lane_call",
        lane: laneCall.lane || null,
        agentEmail: session.agentEmail,
        domain: candidate.domain,
        caseId: candidate.caseId,
        externId: candidate.externId,
        uii,
        disposition,
        outcome: normalizedOutcome,
        ok: false,
        executed: true,
        dispositionStatus: "rejected",
      });
      return {
        ok: false,
        dispositionOk: false,
        laneCall,
        outcome: normalizedOutcome,
        disposition,
        terminal: { ok: false, executed: true, dispositionStatus: "rejected", response },
      };
    }
    const postDispositionHangup = await runPostDispositionHangupProbe(ringcx, {
      session,
      candidate,
      uii,
      disposition,
      outcome: normalizedOutcome,
    });
    const consumption = await persistLaneCallConsumption({
      laneCall,
      session,
      outcome: normalizedOutcome,
      agentEmail: session.agentEmail,
    }).catch((error) => ({ ok: false, error: error?.message || "lane-consumption-failed" }));
    logCxAlpha("cx.alpha.disposition.transport", {
      rail: "lane_call",
      lane: laneCall.lane || null,
      agentEmail: session.agentEmail,
      domain: candidate.domain,
      caseId: candidate.caseId,
      externId: candidate.externId,
      uii,
      disposition,
      outcome: normalizedOutcome,
      ok: true,
      executed: true,
      dispositionStatus: "accepted",
      postDispositionHangupOk: postDispositionHangup?.ok === true,
      postDispositionHangupStatus: postDispositionHangup?.status || null,
      persisted: consumption?.ok === true,
      consumption,
    });
    return {
      ok: true,
      dispositionOk: true,
      laneCall,
      outcome: normalizedOutcome,
      disposition,
      terminal: { ok: true, executed: true, dispositionStatus: "accepted", response },
      postDispositionHangup,
      persisted: consumption?.ok === true,
      consumption,
    };
  } catch (error) {
    logDispositionProbe("cx.alpha.disposition.probe.error", dispositionProbeBase(session, candidate, {
      uii,
      outcome: normalizedOutcome,
      disposition,
      callback: false,
      request: { disposition, callback: false },
      error: error && error.message ? error.message : String(error),
      status: error && error.status ? error.status : null,
    }));
    return {
      ok: false,
      dispositionOk: false,
      laneCall,
      outcome: normalizedOutcome,
      disposition,
      terminal: {
        ok: false,
        executed: false,
        dispositionStatus: "error",
        error: error && error.message ? error.message : String(error),
        status: error && error.status ? error.status : null,
      },
    };
  }
}

function buildCampaignLeadCriteria(session = {}, candidate = {}) {
  const campaignId = normalizeExternalId(
    session.ringcx?.campaignId
    || candidate.campaignId
    || candidate.ringcx?.campaignId
    || "",
  );
  const externId = normalizeExternalId(
    candidate.externId
    || candidate.ringcx?.externId
    || "",
  );
  if (!campaignId || !externId) return null;
  return {
    campaignId,
    campaignIds: [campaignId],
    externIds: [externId],
  };
}

function buildBulkAgentReservationParamMap(session = {}) {
  const agentId = normalizeExternalId(session.cxAgentId || "");
  if (!agentId) return null;
  const agentEmail = normalizeExternalId(session.agentEmail || "");
  const extensionId = normalizeExternalId(session.agentExtensionId || "");
  const agentGroupId = normalizeExternalId(session.ringcx?.agentGroupId || "");
  return {
    RESERVATION_AGENT_ID: agentId,
    CALLBACK_DTS: new Date(Date.now() + 1000).toISOString(),
    AGENT_ID: agentId,
    AGENT_USERNAME: agentEmail,
    AGENT_EMAIL: agentEmail,
    USERNAME: agentEmail,
    RC_USER_ID: extensionId,
    EXTENSION_ID: extensionId,
    AGENT_GROUP_ID: agentGroupId,
  };
}

async function runLeadAction(client, action, criteria, leadActionParams = { paramMap: {} }) {
  const startedAt = Date.now();
  try {
    const response = await client.leadAction(action, {
      campaignLeadSearchCriteria: criteria,
      leadActionParams,
    });
    const responseObject = response && typeof response === "object" ? response : null;
    const successFlag = responseObject && Object.prototype.hasOwnProperty.call(responseObject, "success")
      ? responseObject.success !== false
      : response !== false;
    const ok = successFlag && !responseObject?.errorMessage;
    return {
      action,
      ok,
      elapsedMs: Date.now() - startedAt,
      response: response === true ? true : responseObject ? {
        success: responseObject.success ?? null,
        leadUpdateCount: responseObject.leadUpdateCount ?? null,
        dialerRefreshed: responseObject.dialerRefreshed ?? null,
        leadActionType: responseObject.leadActionType ?? null,
        errorMessage: responseObject.errorMessage || null,
      } : undefined,
      error: ok ? null : responseObject?.errorMessage || null,
    };
  } catch (error) {
    return {
      action,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: error && error.message ? error.message : String(error),
      status: error && error.status ? error.status : null,
    };
  }
}

async function requestNativeRingcxGetLeads(client, { session = {}, candidate = {} } = {}) {
  const startedAt = Date.now();
  if (!client || typeof client.leadAction !== "function") {
    return { ok: false, source: "ringcx-native-lead-action", reason: "lead-action-unavailable" };
  }
  const criteria = buildCampaignLeadCriteria(session, candidate);
  if (!criteria) {
    return { ok: false, source: "ringcx-native-lead-action", reason: "missing-campaign-or-extern-id" };
  }

  const ready = await runLeadAction(client, "READY_LEADS", criteria);
  if (!ready.ok) {
    console.info("[cx-bulk-load] native_get_leads", {
      ok: false,
      reason: "ready-leads-failed",
      sessionId: session.sessionId || null,
      candidateId: candidate.queueItemId || candidate._id || null,
      campaignId: criteria.campaignId,
      externId: criteria.externIds?.[0] || null,
      elapsedMs: Date.now() - startedAt,
      actions: [ready],
    });
    return {
      ok: false,
      source: "ringcx-native-lead-action",
      reason: "ready-leads-failed",
      error: ready.error || null,
      elapsedMs: ready.elapsedMs,
      actions: [ready],
    };
  }

  const reservationParamMap = buildBulkAgentReservationParamMap(session);
  if (reservationParamMap) {
    const reservation = await runLeadAction(client, "AGENT_RESERVATION", criteria, {
      paramMap: reservationParamMap,
    });
    console.info("[cx-bulk-load] native_get_leads", {
      ok: reservation.ok,
      reason: reservation.ok ? null : "agent-reservation-failed",
      sessionId: session.sessionId || null,
      candidateId: candidate.queueItemId || candidate._id || null,
      campaignId: criteria.campaignId,
      externId: criteria.externIds?.[0] || null,
      elapsedMs: Date.now() - startedAt,
      actions: [ready, reservation],
    });
    return {
      ok: reservation.ok,
      source: "ringcx-native-lead-action",
      reason: reservation.ok ? null : "agent-reservation-failed",
      error: reservation.error || null,
      elapsedMs: ready.elapsedMs + reservation.elapsedMs,
      actions: [ready, reservation],
    };
  }

  const refresh = await runLeadAction(client, "DIALER_REFRESH", criteria);
  console.info("[cx-bulk-load] native_get_leads", {
    ok: refresh.ok,
    reason: refresh.ok ? null : "dialer-refresh-failed",
    sessionId: session.sessionId || null,
    candidateId: candidate.queueItemId || candidate._id || null,
    campaignId: criteria.campaignId,
    externId: criteria.externIds?.[0] || null,
    elapsedMs: Date.now() - startedAt,
    actions: [ready, refresh],
  });
  return {
    ok: refresh.ok,
    source: "ringcx-native-lead-action",
    reason: refresh.ok ? null : "dialer-refresh-failed",
    error: refresh.error || null,
    elapsedMs: ready.elapsedMs + refresh.elapsedMs,
    actions: [ready, refresh],
  };
}

function isBulkLoginOffhook(summary = {}) {
  if (!summary || typeof summary !== "object") return false;
  if (summary.offHook === false) return false;
  if (summary.ghostLogin === true) return false;
  if (summary.loggedIn === false) return false;
  // The summarizer sets ready = (no failures); failures include agent-session-busy and
  // agent-pending-disposition. A merely-logged-in agent who is mid-call has a truthy
  // sessionId but ready=false — fail CLOSED so a bulk start never reserves/publishes leads
  // into a live RingCX call buffer. (Don't treat a bare sessionId as "off-hook".)
  if (summary.ready === false) return false;
  return (
    summary.offHook === true
    || Boolean(summary.sessionId)
    || Boolean(summary.iqServerId)
    || /connected|off\s*-?\s*hook/i.test(`${summary.status || ""} ${summary.auxState || ""} ${summary.loginType || ""}`)
  );
}

function makeHttpError(message, status = 400, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function bulkSessionBelongsToAgent(session = {}, agent = {}) {
  if (!session || !agent) return false;
  const sessionEmail = normalizeEmail(session.agentEmail);
  const agentEmail = normalizeEmail(agent.agentEmail);
  const sessionExtensionId = normalizeExternalId(session.agentExtensionId);
  const agentExtensionId = normalizeExternalId(agent.agentExtensionId);
  if (sessionEmail && agentEmail && sessionEmail === agentEmail) return true;
  if (sessionExtensionId && agentExtensionId && sessionExtensionId === agentExtensionId) return true;
  return false;
}

async function findOwnedBulkLoadSession(sessionId, agent) {
  const normalized = String(sessionId || "").trim();
  if (!normalized) return null;
  const session = await cxBulkLoadSessionRepository.findBulkLoadSessionById(normalized);
  if (!session) {
    throw makeHttpError("Bulk-load session not found", 404, "cx-bulk-load-session-not-found");
  }
  if (!bulkSessionBelongsToAgent(session, agent)) {
    throw makeHttpError("Cannot access another agent's bulk-load session", 403, "cx-bulk-load-session-forbidden");
  }
  return session;
}

async function resolveAgentContext(input = {}, user = {}) {
  const requesterEmail = normalizeEmail(user.email);
  const targetEmail = normalizeEmail(input.agentEmail || requesterEmail);
  if (!targetEmail) throw makeHttpError("agentEmail is required", 400, "cx-bulk-load-agent-required");
  if (targetEmail !== requesterEmail && String(user.role || "").toLowerCase() !== "admin") {
    throw makeHttpError("Cannot control another agent's bulk-load rail", 403, "cx-bulk-load-agent-forbidden");
  }
  const account = await userAccountRepository.findUserAccountByEmail(targetEmail).catch(() => null);
  return {
    agentEmail: targetEmail,
    account, // M4: surfaced so the start can resolve policy-driven familyTargets
    agentExtensionId: normalizeExternalId(input.agentExtensionId || (account && account.extensionId) || user.extensionId || ""),
    cxAgentId: normalizeExternalId(
      input.cxAgentId ||
        (account && (account.cxAgentId || account.ringcxAgentId)) ||
        user.cxAgentId ||
        user.ringcxAgentId ||
        "",
    ),
    ringcxAgentGroupId: normalizeExternalId(
      input.agentGroupId
        || input.ringcxAgentGroupId
        || (account && account.metadata && (account.metadata.ringcxAgentGroupId || account.metadata.cxAgentGroupId))
        || process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID
        || "",
    ),
  };
}

// The runtime gate: only an agent the resolver places on bulk_load may proceed.
// Default-off — when CX_DIAL_RUNTIME_BULK_LOAD_ENABLED is false the resolver never
// returns bulk_load, so every request 403s.
function assertBulkRuntime(agent) {
  const resolution = resolveCxDialRuntimeMode({ userEmail: agent.agentEmail, extensionId: agent.agentExtensionId });
  if (!isCxBulkLoadRuntime(resolution)) {
    throw makeHttpError(
      `bulk_load runtime not active for ${agent.agentEmail} (${resolution.reason})`,
      403,
      "cx-bulk-load-runtime-inactive",
    );
  }
  return resolution;
}

let _service = null;
function getService() {
  if (_service) return _service;
  const client = createRingcxVoiceClient();
  // M11 gate 2: dispatch one cadence event into the existing finalizer.
  const dispatchCadenceEvent = async (event) =>
    handleCxTerminalCallOutcome({
      queueItemId: event.queueItemId,
      domain: event.domain,
      caseId: event.caseId,
      uii: event.uii,
      externId: event.externId,
      outcome: event.outcome,
      disposition: event.outcome,
      source: event.source || "cx-bulk-load",
      sourceService: "cx-bulk-load",
      actorEmail: event.agentEmail,
      outcomeAt: event.at || new Date().toISOString(),
    });
  const outcomeAdapter = createCxBulkLoadOutcomeAdapter({
    recordCadenceEvent: async (event) => {
      // M11 gate 2: DURABLE terminal recording. The live click path only writes the
      // insert-once outbox row; the control-plane drain replays it into cadence/Logics.
      // That keeps slow business cleanup (especially DNC stop/sync work) out of the
      // call-advance response while preserving crash-safe counting.
      const idemKey = event.idemKey || makeOutcomeIdemKey({
        sessionId: event.sessionId,
        queueItemId: event.queueItemId,
        uii: event.uii,
        eventType: "terminal",
      });
      const inserted = await cxTerminalOutboxRepository
        .insertOnce({
          idemKey,
          sessionId: event.sessionId || null,
          rail: "bulk_load",
          domain: event.domain || null,
          queueItemId: event.queueItemId || null,
          uii: event.uii || null,
          caseId: event.caseId != null ? Number(event.caseId) : null,
          agentEmail: event.agentEmail || null,
          agentName: event.agentName || null,
          externId: event.externId || null,
          phone: event.phone || null,
          phoneLast4: event.phoneLast4 || null,
          durationSec: event.durationSec != null ? Number(event.durationSec) : null,
          coachSessionId: event.coachSessionId || null,
          outcome: event.outcome || null,
          source: event.source || null,
          payload: event,
        })
        .catch(async (err) => {
          // If the outbox itself is unavailable, fail open to the old direct dispatch so terminal
          // events are not silently lost. This is an outage path, not normal flow. The fallback
          // dispatch runs shared DNC stop/sync cleanup and can ALSO throw; if it does, return a
          // structured fallbackFailed status instead of rejecting, so the disposition can still
          // advance the reducer past terminal.started (the call already hung up) and stamp a replay
          // marker rather than leaving the call uncounted with `current` stuck. (#8)
          try {
            await dispatchCadenceEvent(event);
            return { idemKey, fallbackDispatched: true, error: err };
          } catch (dispatchErr) {
            return { idemKey, fallbackDispatched: false, fallbackFailed: true, error: dispatchErr };
          }
        });
      if (inserted === null) {
        return { written: false, idemKey, reason: "duplicate" };
      }
      if (inserted?.fallbackFailed === true) {
        // Double-fault: durable outbox insert AND fallback dispatch both failed. Surface it (do not
        // throw) so the caller advances the reducer + marks for replay rather than stranding. (#8)
        return { written: false, idemKey, fallbackFailed: true, error: inserted.error };
      }
      return {
        written: true,
        idemKey,
        deferred: inserted?.fallbackDispatched !== true,
        fallbackDispatched: inserted?.fallbackDispatched === true,
      };
    },
  });
  const queueStateAdapter = {
    // M11 gate 7: cross-pool publish interlock — is this case already active on a DIFFERENT
    // queue row? Mirrors the slow/legacy publisher's findActiveClaimForCase guard.
    async findActiveSibling({ domain = null, caseId = null, excludeId = null } = {}) {
      return cxDialQueueRepository.findActiveClaimForCase(domain, caseId, excludeId);
    },
    // RESYNC read (2026-07-06): raw queue rows for the watcher's buffer audit — full rows,
    // any state, so the audit can tell row-cancelled from reaped from foreign-reservation.
    // NO per-id error swallow: a transient read failure must reject the WHOLE batch (the
    // caller treats a rejected read as "do nothing this trigger"). Swallowing it made a
    // Mongo blip indistinguishable from a deleted row, and the audit would prune healthy
    // leads as row-missing (adversarial-verify blocker, 2026-07-06).
    async loadCandidateRows(queueItemIds = []) {
      const ids = (Array.isArray(queueItemIds) ? queueItemIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean);
      const rows = [];
      for (const id of ids) {
        const row = await cxDialQueueRepository.findQueueItemById(id);
        if (row) rows.push(row.toObject ? row.toObject() : row);
      }
      return rows;
    },
    // RESYNC → RingCX (Mickey's ruling, 2026-07-06 "the pruner needs to talk to cx very
    // conservatively and say this lead is a problem, stop it"): when the audit prunes a
    // candidate, kill its still-loaded RingCX copy so the ghost cannot dial (again). This
    // is LEAD-LIST surgery only — never a call operation; an in-flight dial is a sunk cost
    // (hangup on RINGING is a no-op, on ACTIVE it drops a human). Reuses the ghost guard's
    // own copy-resolver (single source of truth for "is a copy live") and the stamping
    // canceller (so repeat cancels dedupe via rcxVisibilityCancelledAt). Fail-soft per row:
    // a cancel failure is reported, never thrown — the prune stands either way and the next
    // trigger retries.
    async cancelPrunedCandidateCopies({ removed = [], rows = [] } = {}) {
      const rowById = new Map(
        (Array.isArray(rows) ? rows : [])
          .filter(Boolean)
          .map((row) => [String(row._id || row.queueItemId || ""), row]),
      );
      const results = [];
      for (const entry of Array.isArray(removed) ? removed : []) {
        const queueItemId = String(entry?.queueItemId || "");
        if (String(entry?.why || "") === "reservation-foreign") {
          // Another live session re-reserved this row — its current RingCX copy is THEIRS
          // (their publish overwrote lastRingcxPublished*). Cancelling it would break their
          // session; their lifecycle cleans it up.
          results.push({ queueItemId, cancelled: false, skipped: true, reason: "reservation-foreign-not-ours" });
          continue;
        }
        const row = rowById.get(queueItemId);
        if (!row) {
          results.push({ queueItemId, cancelled: false, skipped: true, reason: "row-not-loaded" });
          continue;
        }
        const copies = resolveRingcxPublishedCopies(row.metadata || {});
        if (!copies.length) {
          results.push({ queueItemId, cancelled: false, skipped: true, reason: "no-live-ringcx-copy" });
          continue;
        }
        for (const copy of copies) {
          const overrides = copy.channel === "bulk"
            ? { externId: copy.externId, campaignId: copy.campaignId }
            : {};
          const attempt = await cancelPublishedQueueItemInRingcx(row, {
            reason: "resync-prune",
            ...overrides,
          }).catch((error) => ({ ok: false, cancelled: false, error: error.message || "ringcx-cancel-failed" }));
          results.push({
            queueItemId,
            channel: copy.channel,
            cancelled: attempt.cancelled === true,
            ok: attempt.ok !== false,
            error: attempt.error || null,
          });
        }
      }
      return results;
    },
    async markCandidatePublished({ session = {}, candidate = {}, externId = null, campaignId = null } = {}) {
      const queueItemId = normalizeExternalId(candidate.queueItemId || candidate.id || candidate._id);
      if (!queueItemId) return null;
      const now = new Date();
      // M11 gate 5: ownership-guarded CAS. The row MUST already be `claimed` by THIS session's
      // reservation — re-assert {state:'claimed', reservationSessionId} so a publish stamp can
      // never land on a row another session reserved or that already advanced. `bulkLoadSessionId`
      // stays as debug metadata only; `reservationSessionId` is the real ownership lock.
      return cxDialQueueRepository.transitionQueueItemState(
        queueItemId,
        ["claimed"],
        {
          state: "claimed",
          claimUntil: null,
          lastClaimedAt: now,
          "metadata.bulkLoadSessionId": session.sessionId || null,
          "metadata.bulkLoadPublishedAt": now,
          "metadata.bulkLoadRuntime": "bulk_load",
          "metadata.lastRingcxPublishedAt": now,
          "metadata.lastRingcxPublishedCampaignId": campaignId || session.ringcx?.campaignId || null,
          "metadata.lastRingcxPublishedDialGroupId": session.ringcx?.dialGroupId || null,
          "metadata.lastRingcxPublishedExternId": externId || candidate.externId || null,
          "metadata.lastDialExecutionUii": null,
          "metadata.lastQueueAttemptUii": null,
          "metadata.servingAt": null,
          "metadata.lastRingcxActiveCall": null,
          "metadata.lastRingcxMatchReasons": [],
          "metadata.lastDialIntentStatus": "bulk-loaded",
          "metadata.lastQueueAttemptHeldForDisposition": false,
          "metadata.wrapUpRequired": false,
          "metadata.lastReleasedAt": null,
          "metadata.lastReleaseReason": null,
          "metadata.lastReleasedExtensionId": null,
          "metadata.lastReleasedAgentName": null,
          "metadata.lastReleasedBy": null,
        },
        { match: { "metadata.reservationSessionId": session.sessionId } },
      );
    },
    async markCandidateServing({ session = {}, candidate = {}, uii = null, activeCallSummary = null, matchReasons = [] } = {}) {
      const queueItemId = normalizeExternalId(candidate.queueItemId || candidate.id || candidate._id);
      if (!queueItemId) return null;
      const now = new Date();
      // M11 gate 5: dead-simple ownership. The watcher may only promote rows this session
      // explicitly reserved. Missing reservation is a data/load bug, not an alternate path.
      const servingPatch = {
        state: "serving",
        claimUntil: null,
        lastClaimedAt: now,
        "assignment.extensionId": session.agentExtensionId || null,
        "assignment.agentName": session.agentEmail || null,
        "assignment.assignedAt": now,
        "assignment.queueFamilySnapshot": candidate.queueFamily || null,
        "metadata.reservationSessionId": session.sessionId || null,
        "metadata.reservationRail": "bulk_load",
        "metadata.bulkLoadSessionId": session.sessionId || null,
        "metadata.bulkLoadActiveAt": now,
        "metadata.bulkLoadRuntime": "bulk_load",
        "metadata.servingAt": now,
        "metadata.lastDialExecutionUii": uii || null,
        "metadata.lastQueueAttemptUii": uii || null,
        "metadata.lastDialExecutionSource": "cx-bulk-load",
        "metadata.lastDialIntentStatus": "active",
        "metadata.lastQueueAttemptHeldForDisposition": true,
        "metadata.wrapUpRequired": true,
        "metadata.wrapUpReason": "bulk-load-active-call",
        "metadata.lastRingcxActiveCall": activeCallSummary || null,
        "metadata.lastRingcxMatchReasons": Array.isArray(matchReasons) ? matchReasons : [],
      };
      return cxDialQueueRepository.transitionQueueItemState(
        queueItemId,
        ["claimed", "serving"],
        servingPatch,
        { match: { "metadata.reservationSessionId": session.sessionId } },
      );
    },
    // GHOST RESCUE (Mickey's ruling, 2026-07-06 "lead is answered, try to sync it"): a ghost
    // call a HUMAN answered is a live prospect stranded outside the app. If the row died for
    // an innocent reason (reaped lease, housekeeping cancel), re-claim it for this session and
    // adopt normally — the agent works the call in OUR app, no RingCX habits. NEVER rescued:
    // DNC/contact-blocked cancels (compliance owns those rows) and rows another live session
    // reserved (theirs). Eligibility re-checks through the SAME gate the loader uses,
    // fail-closed: no verdict = no rescue. The watcher only calls this for calls the connected
    // latch proved ANSWERED — ringing ghosts self-resolve via RingCX ring-out.
    async rescueCandidateServing({ session = {}, candidate = {}, uii = null, activeCallSummary = null, matchReasons = [] } = {}) {
      const queueItemId = normalizeExternalId(candidate.queueItemId || candidate.id || candidate._id);
      if (!queueItemId) return { refused: "candidate-id-missing", definitive: false };
      // A refusal is DEFINITIVE only when the call is provably unworkable (compliance owns
      // the row, another session owns it, or the row is confirmed gone). Transient shapes —
      // a read failure, a healthy row whose serving stamp raced, an eligibility service
      // outage — are NOT definitive: the watcher must not hang up a possibly-good live call
      // on a blip; the next tick simply retries the whole rescue (Mickey's flicker question,
      // 2026-07-06 — this distinction is the answer).
      let row;
      try {
        row = await cxDialQueueRepository.findQueueItemById(queueItemId);
      } catch (error) {
        return { refused: "row-read-failed", definitive: false, error: error.message || String(error) };
      }
      const rowObj = row && row.toObject ? row.toObject() : row;
      const decision = deriveRescueDecision(rowObj, session.sessionId);
      if (!decision.rescue) {
        // Definitive = the CALL is provably unworkable: compliance owns the row, or the row
        // is confirmed gone. reservation-foreign is NOT definitive (adversarial finding: a
        // foreign owner holds only a FUTURE dial intent — the LIVE call on OUR extern may be
        // a genuinely good conversation; hanging it up serves no compliance purpose).
        const definitive = ["contact-blocked", "row-missing"].includes(decision.reason);
        return { refused: decision.reason, definitive };
      }
      // READ-ONLY eligibility, deliberately softer than the loader's: enforceStop:false (a
      // rescue needs a VERDICT, not case-wide enforcement — the loader's enforceStop cancels
      // the whole case's queue inventory, an insane side effect for a hangup decision) and
      // requireFreshLogicsStatus:false (a Logics outage under that flag arrives as a
      // well-formed ok:false and would masquerade as a definitive compliance block — the
      // false-definitive hangup the adversarial pass constructed). Belt-and-suspenders: an
      // infrastructure-flavored block reason is still treated as non-definitive.
      const eligibility = await resolveCaseContactEligibility(
        rowObj.domain || session.domain || null,
        rowObj.caseId,
        {
          enforceStop: false,
          requireFreshLogicsStatus: false,
          currentStage: "contact-blocked",
          sourceService: "cx-bulk-load-rescue",
        },
      ).catch(() => null);
      if (!eligibility) return { refused: "eligibility-unavailable", definitive: false };
      if (eligibility.ok !== true) {
        const infraFlavored = /check-failed|unavailable|timeout|error/i.test(String(eligibility.reason || ""));
        return { refused: "contact-ineligible", definitive: !infraFlavored };
      }
      // TOCTOU lock (adversarial finding, 2026-07-06): the eligibility await is a real race
      // window — a compliance stop landing inside it re-cancels the row, and a from-state
      // CAS alone can't tell an innocent cancel from that fresh block. Re-assert the exact
      // document we DECIDED on via updatedAt: any concurrent write bumps it, the CAS misses,
      // and the next tick re-reads with fresh eyes. No lockable timestamp = no rescue.
      if (!rowObj.updatedAt) return { refused: "row-not-lockable", definitive: false };
      const now = new Date();
      const adopted = await cxDialQueueRepository.transitionQueueItemState(
        queueItemId,
        ["ready", "cancelled"],
        {
          state: "serving",
          claimUntil: null,
          lastClaimedAt: now,
          cancelledAt: null,
          "assignment.extensionId": session.agentExtensionId || null,
          "assignment.agentName": session.agentEmail || null,
          "assignment.assignedAt": now,
          "assignment.queueFamilySnapshot": candidate.queueFamily || null,
          "metadata.reservationSessionId": session.sessionId || null,
          "metadata.reservationRail": "bulk_load",
          "metadata.reservedAt": now,
          "metadata.reservationExpiresAt": new Date(now.getTime() + 10 * 60 * 1000),
          "metadata.bulkLoadSessionId": session.sessionId || null,
          "metadata.bulkLoadActiveAt": now,
          "metadata.bulkLoadRuntime": "bulk_load",
          "metadata.servingAt": now,
          "metadata.lastDialExecutionUii": uii || null,
          "metadata.lastQueueAttemptUii": uii || null,
          "metadata.lastDialExecutionSource": "cx-bulk-load-rescue",
          "metadata.lastDialIntentStatus": "active",
          "metadata.lastQueueAttemptHeldForDisposition": true,
          "metadata.wrapUpRequired": true,
          "metadata.wrapUpReason": "bulk-load-active-call",
          "metadata.lastRingcxActiveCall": activeCallSummary || null,
          "metadata.lastRingcxMatchReasons": Array.isArray(matchReasons) ? matchReasons : [],
          "metadata.rescuedAt": now,
          "metadata.rescuedFromState": rowObj.state || null,
          "metadata.rescuedReason": decision.reason,
        },
        { match: { updatedAt: rowObj.updatedAt } },
      );
      // The row moved between our read and the CAS (e.g. another session claimed it):
      // non-definitive — walk away, no hangup, next tick re-evaluates.
      if (!adopted) return { refused: "rescue-cas-miss", definitive: false };
      return { adopted };
    },
    // GHOST HANGUP (Mickey's ruling, 2026-07-06): a CONNECTED ghost the rescue REFUSED has
    // no compliant way to be worked — if a DNC'd human answered, ending the call IS the
    // compliant action; if it's a voicemail box, dropping costs nothing. Hangup works on
    // ACTIVE legs (the VM-fix saga proved it kills live legs); on a RINGING call it's a
    // documented no-op, which is fine — ringing ghosts self-resolve via ring-out. The system
    // does this so the agent never forms the hang-up-in-CX habit. Fail-soft always.
    async hangupGhostCall({ uii = null } = {}) {
      const normalizedUii = normalizeExternalId(uii);
      if (!normalizedUii || typeof client.hangupCall !== "function") {
        return { ok: false, skipped: true, reason: "hangup-unavailable" };
      }
      try {
        const response = await client.hangupCall(normalizedUii);
        return { ok: response !== false, executed: true, response };
      } catch (error) {
        const alreadyEnded = isAlreadyEndedHangupError(error);
        return { ok: alreadyEnded, executed: true, alreadyEnded, error: error.message || String(error) };
      }
    },
  };
  const agentLifecycleAdapter = {
    async pauseProgressiveDialing({ session = {}, reason = null, waitForRestore = false } = {}) {
      return pauseRingcxProgressiveDialing(client, session, {
        reason: reason || "bulk-progressive-pause",
        waitForRestore,
      }).catch((error) => ({
        ok: false,
        skipped: true,
        reason: "progressive-pause-failed",
        error: error && error.message ? error.message : String(error),
      }));
    },
    async clearTerminalHold({ session = {}, outcome = null } = {}) {
      const extensionId = normalizeExternalId(session.agentExtensionId);
      if (!extensionId) return null;
      const existing = await agentStateRepository.findAgentStateByExtensionId(extensionId).catch(() => null);
      if (String(existing?.cxRouting?.reason || "").trim().toLowerCase() !== "long-call-hold") {
        return null;
      }
      const now = new Date();
      return agentStateRepository.updateAgentState(
        extensionId,
        {
          status: "available",
          activityState: "idle",
          activePlatform: "none",
          currentCall: {},
          "cxRouting.desiredAvailability": "available",
          "cxRouting.reason": "bulk-terminal-cleared",
          "cxRouting.syncedAt": now,
          "cxRouting.lastSource": "cx-bulk-load-terminal",
          "cxRouting.manualUnavailableAt": null,
          "cxRouting.pauseType": null,
          "cxRouting.pauseStartedAt": null,
          "cxRouting.pauseReleaseAt": null,
          lastCallOutcome: outcome || "bulk-terminal",
          lastActivityAt: now,
          lastStatusChange: now,
          "upstream.source": "cx-bulk-load-terminal",
          "upstream.mirroredAt": now,
        },
      );
    },
  };

  _service = createCxBulkLoadRuntimeService({
    repo: cxBulkLoadSessionRepository,
    leadSource,
    publisher,
    watcher,
    outcomeAdapter,
    terminalExecutor: async ({ session = {}, candidate = {}, outcome = null, notes = null } = {}) => {
      // SIMPLEST PATH: no hangup. Dispositioning the active call is what ends it
      // and advances the dialer in RingCX. One call → RingCX disposition, then the
      // runtime writes the terminal outcome to Mongo. (hangupCall was accepted but
      // never dropped a ringing call — verified via [DISPTRACE].)
      const uii = normalizeExternalId(candidate.uii);
      const disposition = bulkOutcomeDisposition(outcome);
      const _step = createDispositionTrace("bulkDispose");
      _step("ENTER", { uii, outcome, disposition });
      // ALPHA observability: one consolidated event per disposition at the RingCX transport boundary
      // (dispositionCall accepted/rejected + UII release verification). The per-step DISPTRACE detail
      // lives under CX_BULK_LOAD_DISPOSITION_TRACE; this surfaces the OUTCOME in the unified cx.alpha.*
      // stream. Pass-through: it returns the result unchanged and never throws, so nothing functional
      // depends on the log firing.
      const traceDisposition = (result) => {
        try {
          logCxAlpha("cx.alpha.disposition.transport", {
            rail: "bulk_load",
            sessionId: session.sessionId || null,
            agentExtensionId: session.agentExtensionId || null,
            domain: session.domain || candidate.domain || null,
            queueItemId: String(candidate.queueItemId || candidate.id || candidate._id || "") || null,
            uii,
            disposition,
            outcome,
            ok: result.ok === true,
            executed: result.executed === true,
            dispositionStatus: result.dispositionStatus || (result.ok === true ? "accepted" : (result.reason || "unknown")),
            releaseStatus: result.releaseStatus || null,
            releaseAttempts: result.releaseAttempts != null ? result.releaseAttempts : null,
            postDispositionHangupOk: result.postDispositionHangup
              ? result.postDispositionHangup.ok === true
              : null,
            postDispositionHangupStatus: result.postDispositionHangup?.status || null,
            postDispositionHangupError: result.postDispositionHangup?.error || null,
            reason: result.reason || null,
            error: result.error || null,
          });
        } catch (_err) { /* logging must never affect the disposition result */ }
        return result;
      };
      if (!uii) {
        _step("NO uii on candidate → cannot disposition");
        return traceDisposition({ ok: false, executed: false, reason: "missing-uii", disposition });
      }
      try {
        const response = await client.dispositionCall(uii, {
          disposition,
          callback: false,
          notes: notes || undefined,
        });
        const ok = response !== false;
        _step("dispositionCall DONE", { ok, response: ok ? "accepted" : response });
        logDispositionProbeSent({ session, candidate, uii, disposition, outcome, response });
        if (!ok) {
          return traceDisposition({
            ok: false,
            executed: true,
            disposition,
            uii,
            dispositionStatus: "rejected",
            response,
          });
        }
        _step("post-disposition hangup START");
        const postDispositionHangup = await runPostDispositionHangupProbe(client, {
          session,
          candidate,
          uii,
          disposition,
          outcome,
        });
        _step("post-disposition hangup DONE", postDispositionHangup);
        scheduleDispositionProbeSnapshots(client, {
          session,
          candidate,
          uii,
          disposition,
          outcome,
          postDispositionHangup,
        });
        if (agentLifecycleAdapter && typeof agentLifecycleAdapter.pauseProgressiveDialing === "function") {
          agentLifecycleAdapter
            .pauseProgressiveDialing({
              session,
              reason: "bulk-disposition-accepted",
              waitForRestore: false,
            })
            .then((pause) => {
              _step("post-disposition progressive pause", pause);
            })
            .catch((error) => {
              _step("post-disposition progressive pause failed", {
                message: error && error.message ? error.message : String(error),
              });
            });
        }
        return traceDisposition({
          ok: true,
          executed: true,
          disposition,
          uii,
          dispositionStatus: "accepted",
          postDispositionHangup,
          response,
        });
      } catch (error) {
        _step("dispositionCall ERROR", {
          status: error && error.status,
          message: error && error.message ? error.message : String(error),
        });
        logDispositionProbe("cx.alpha.disposition.probe.error", dispositionProbeBase(session, candidate, {
          uii,
          outcome,
          disposition,
          callback: false,
          request: { disposition, callback: false },
          error: error && error.message ? error.message : String(error),
          status: error && error.status ? error.status : null,
        }));
        return traceDisposition({
          ok: false,
          executed: false,
          disposition,
          uii,
          error: error && error.message ? error.message : String(error),
        });
      }
    },
    queueStateAdapter,
    agentLifecycleAdapter,
    leadStarter: {
      async getLeads({ session = {}, candidate = {} } = {}) {
        return requestNativeRingcxGetLeads(client, { session, candidate });
      },
    },
    offhookGate: {
      async isAgentOffhook(session = {}, gateOptions = {}) {
        const agentId = normalizeExternalId(session.cxAgentId);
        const agentGroupId = normalizeExternalId(
          session.ringcx?.agentGroupId
          || process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID
          || "",
        );
        if (!agentId || !agentGroupId) {
          return {
            ok: false,
            reason: !agentId ? "missing-agent-id" : "missing-agent-group-id",
          };
        }
        const ringcxClient = gateOptions.client || client;
        if (!ringcxClient || typeof ringcxClient.getAgentLogin !== "function") {
          return { ok: false, reason: "agent-login-unavailable" };
        }
        try {
          const { summarizeRingcxLoginPayload } = require("./dialService");
          const login = await ringcxClient.getAgentLogin(agentId, agentGroupId);
          const summary = summarizeRingcxLoginPayload(login);
          return {
            ok: isBulkLoginOffhook(summary),
            reason: isBulkLoginOffhook(summary) ? "agent-offhook" : "agent-not-offhook",
            summary,
          };
        } catch (error) {
          return {
            ok: false,
            reason: `agent-login-read-failed:${error.message || error}`,
          };
        }
      },
    },
    client,
    listReadyQueueItems: async ({ domain, limit, agentExtensionId, includeUnassignedVisible } = {}) => {
      const visibleExtensionId = normalizeExternalId(agentExtensionId);
      if (!visibleExtensionId) return [];
      return cxDialQueueRepository.listQueueItems({
        domain: domain || undefined,
        states: ["ready"],
        visibleExtensionId,
        includeUnassignedVisible: includeUnassignedVisible === true,
        sort: {
          "assignment.assignedAt": 1,
          createdAt: 1,
          _id: 1,
        },
        limit,
      });
    },
    reduce: reduceCxBulkLoadState,
    // M4: the shared reservation service — the bulk rail's ONLY source of claimed rows.
    // M11 gate 6: inject queueItemRepository so the M5 claim-time cross-pool interlock
    // (assertNotActiveInUcq → existsForLead) is LIVE on this rail, not dormant — a caseId
    // already active in the legacy UCQ pool is dropped+released at reserve time.
    reservationService: createCxQueueReservationService({ cxDialQueueRepository, queueItemRepository }),
    contactEligibilityAdapter: {
      async resolve({ domain, caseId } = {}) {
        const eligibility = await resolveCaseContactEligibility(domain, caseId, {
          enforceStop: true,
          requireFreshLogicsStatus: readBooleanEnv("CX_BULK_LOAD_REQUIRE_FRESH_LOGICS_STATUS", false),
          currentStage: "contact-blocked",
          sourceService: "cx-bulk-load",
        });
        return {
          ok: eligibility.ok,
          reason: eligibility.reason || null,
          detail: eligibility.detail || null,
          transient: isTransientContactEligibilityBlock(eligibility),
          enforced: Boolean(eligibility.enforcement),
        };
      },
    },
    newSessionId: () => `cxbl-${crypto.randomUUID()}`,
  });
  return _service;
}

// Resolve the session id for an operation: explicit, else the agent's active one.
async function resolveSessionId(input, agent) {
  if (input.sessionId) {
    const session = await findOwnedBulkLoadSession(input.sessionId, agent);
    return session.sessionId;
  }
  const active = await cxBulkLoadSessionRepository.findActiveBulkLoadSessionForAgent(agent);
  return active ? active.sessionId : null;
}

// ── public entry functions (what the routes call) ───────────────────────

async function startCxBulkLoadSession(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const agentRoute = resolveBulkAgentRingcxRoute(agent, input);
  // M4/M7: resolve the per-family reservation targets ONCE from the agent's account policy.
  // (A missing/disabled account yields all-zero targets — fail-closed: the rail reserves nothing
  // rather than over-serving.)
  const targetSize = Number(input.targetSize) > 0 ? Number(input.targetSize) : 35; // M11 gate 8: canonical 35
  const familyTargets = buildFamilyTargets({ policy: agent.account, totalDeficit: targetSize, env: process.env });
  return getService().startCxBulkLoadSession({
    agentEmail: agent.agentEmail,
    agentExtensionId: agent.agentExtensionId,
    cxAgentId: agent.cxAgentId,
    domain: normalizeDomain(input.domain),
    targetSize: input.targetSize,
    refillThreshold: input.refillThreshold,
    familyTargets,
    claimMinutes: input.claimMinutes,
    ringcx: {
      accountId: input.accountId || readEnv("RINGCX_VOICE_ACCOUNT_ID"),
      campaignId: input.campaignId || input.rcxCampaignId || agentRoute.campaignId || readEnv("RINGCX_VOICE_DEFAULT_CAMPAIGN_ID"),
      dialGroupId: input.dialGroupId || input.rcxDialGroupId || agentRoute.dialGroupId || readEnv("RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID"),
      agentGroupId: input.agentGroupId || agent.ringcxAgentGroupId || readEnv("RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID"),
      dialPriority: input.dialPriority || "NORMAL",
      agentRoute,
    },
  });
}

async function getCxBulkLoadSession(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  const sessionId = input.sessionId
    ? (await findOwnedBulkLoadSession(input.sessionId, agent)).sessionId
    : null;
  return getService().getCxBulkLoadSession({
    sessionId,
    agentEmail: agent.agentEmail,
    agentExtensionId: agent.agentExtensionId,
  });
}

async function watchCxBulkLoadAccountActiveCalls(input = {}) {
  return getService().watchAccountActiveCalls({
    domain: input.domain,
    accountId: input.accountId,
    sessionId: input.sessionId,
    agentEmail: input.agentEmail,
    agentExtensionId: input.agentExtensionId,
    now: input.now,
  });
}

async function syncCxBulkLoadActiveCall(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const sessionId = await resolveSessionId(input, agent);
  if (!sessionId) return null;
  await getService().watchAccountActiveCalls({
    domain: input.domain,
    accountId: input.accountId,
    sessionId,
    agentEmail: agent.agentEmail,
    agentExtensionId: agent.agentExtensionId,
    now: input.now,
  });
  return getService().getCxBulkLoadSession({
    sessionId,
    agentEmail: agent.agentEmail,
    agentExtensionId: agent.agentExtensionId,
  });
}

async function submitCxBulkLoadDisposition(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const sessionId = await resolveSessionId(input, agent);
  if (!sessionId) return null;
  return getService().submitCxBulkLoadDisposition({
    sessionId,
    disposition: input.disposition || input.outcome,
    callback: input.callback,
    callBackDTS: input.callBackDTS,
    notes: input.notes,
    hangup: input.hangup,
  });
}

async function submitCxLaneCallDisposition(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const laneCall = getLaneCall(agent.agentEmail);
  if (!laneCall) {
    return {
      ok: false,
      dispositionOk: false,
      reason: "missing-lane-call",
      laneCall: null,
      terminal: { ok: false, executed: false, reason: "missing-lane-call" },
    };
  }
  const requestedUii = normalizeExternalId(input.uii);
  const currentUii = normalizeExternalId(laneCall.uii);
  if (requestedUii && currentUii && requestedUii !== currentUii) {
    throw makeHttpError("Lane call UII no longer matches", 409, "cx-lane-call-uii-mismatch");
  }
  const requestedExternId = normalizeExternalId(input.externId);
  const currentExternId = normalizeExternalId(laneCall.externId);
  if (requestedExternId && currentExternId && requestedExternId !== currentExternId) {
    throw makeHttpError("Lane call extern no longer matches", 409, "cx-lane-call-extern-mismatch");
  }
  const result = await executeLaneCallDisposition({
    laneCall,
    outcome: input.disposition || input.outcome,
    client: options.client || null,
    agent,
    notes: input.notes,
  });
  if (result?.dispositionOk === true) {
    clearLaneCall(agent.agentEmail);
  }
  return result;
}

async function submitCxBulkLoadReviewOutcome(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const session = input.sessionId
    ? await findOwnedBulkLoadSession(input.sessionId, agent)
    : await cxBulkLoadSessionRepository.findActiveBulkLoadSessionForAgent(agent);
  if (!session) return null;
  const outcome = String(input.outcome || "").trim();
  if (!["dnc"].includes(outcome)) {
    throw makeHttpError("Unsupported bulk-load review outcome", 400, "cx-bulk-load-review-outcome-unsupported");
  }
  const queueItemId = normalizeExternalId(input.queueItemId);
  const uii = normalizeExternalId(input.uii);
  if (!queueItemId || !uii) {
    throw makeHttpError("Bulk-load review requires queueItemId and uii", 400, "cx-bulk-load-review-identity-required");
  }
  // #4 — rectification lane. Record the DNC correction as its OWN durable outbox row instead of
  // mutating the in-flight terminal row (which races the drain and can silently lose the DNC). The
  // same drain machinery replays this row's payload (outcome="dnc") into the cadence/Logics DNC
  // branch, idempotently, and it works even AFTER the original terminal row drained — so the
  // post-call DNC correction has a guaranteed lane. A repeated review dedups on the distinct
  // "review-dnc" idemKey (insertOnce returns null on a dup, still ok).
  const original = typeof cxTerminalOutboxRepository.findByIdentity === "function"
    ? await cxTerminalOutboxRepository.findByIdentity({ sessionId: session.sessionId, queueItemId, uii })
    : null;
  const row = buildReviewCorrectionRow({
    sessionId: session.sessionId,
    queueItemId,
    uii,
    original,
    domain: session.domain || null,
    agentEmail: agent.agentEmail || agent.email || null,
    caseId: input.caseId != null ? Number(input.caseId) : null,
  });
  const inserted = await cxTerminalOutboxRepository.insertOnce(row);
  return {
    ok: true,
    recorded: inserted !== null,
    deduped: inserted === null,
    sessionId: session.sessionId,
    queueItemId,
    uii,
    outcome,
    idemKey: row.idemKey,
  };
}


async function startCxBulkLoadGetLeads(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const sessionId = await resolveSessionId(input, agent);
  if (!sessionId) return null;
  return getService().startCxBulkLoadGetLeads({ sessionId });
}

async function resolveOwnedBulkSession(input = {}, agent = {}) {
  if (input.sessionId) return findOwnedBulkLoadSession(input.sessionId, agent);
  return cxBulkLoadSessionRepository.findActiveBulkLoadSessionForAgent(agent);
}

async function pauseCxBulkLoadProgressiveDialing(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const session = await resolveOwnedBulkSession(input, agent);
  if (!session) return null;
  return pauseRingcxProgressiveDialing(createRingcxVoiceClient(), session, {
    reason: input.reason || "bulk-progressive-pause",
    holdUntilResume: input.holdUntilResume === true,
    waitForRestore: input.waitForRestore === true,
  });
}

async function resumeCxBulkLoadProgressiveDialing(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const session = await resolveOwnedBulkSession(input, agent);
  if (!session) return null;
  return resumeRingcxProgressiveDialing(createRingcxVoiceClient(), session, {
    reason: input.reason || "bulk-progressive-resume",
  });
}

async function skipCxBulkLoadCurrent(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const sessionId = await resolveSessionId(input, agent);
  if (!sessionId) return null;
  return getService().skipCxBulkLoadCurrent({ sessionId });
}

async function killCxBulkLoadSession(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  // Same gate as every other mutating path: only a bulk_load agent may touch a
  // bulk session. (Cleaning up a stuck session after a global rollback is an
  // ops/reaper concern, not this agent route.)
  assertBulkRuntime(agent);
  const sessionId = await resolveSessionId(input, agent);
  if (!sessionId) return null;
  return getService().killCxBulkLoadSession({ sessionId, reason: input.reason || "manual" });
}

module.exports = {
  persistLaneCallConsumption, // F2 consumption; deps injectable for pins
  startCxBulkLoadSession,
  getCxBulkLoadSession,
  watchCxBulkLoadAccountActiveCalls,
  syncCxBulkLoadActiveCall,
  submitCxBulkLoadDisposition,
  submitCxLaneCallDisposition,
  startCxBulkLoadGetLeads,
  pauseCxBulkLoadProgressiveDialing,
  resumeCxBulkLoadProgressiveDialing,
  skipCxBulkLoadCurrent,
  submitCxBulkLoadReviewOutcome,
  killCxBulkLoadSession,
  _test: {
    bulkOutcomeDisposition,
    executeLaneCallDisposition,
    deriveRescueDecision,
    pauseRingcxProgressiveDialing,
    resumeRingcxProgressiveDialing,
    isBulkLoginOffhook,
    runPostDispositionHangupProbe,
  },
};
