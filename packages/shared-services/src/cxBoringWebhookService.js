"use strict";

// Fresh Boring runtime boundary:
//   RingCX webhook -> durable call memory + durable action row -> immediate ACK.
// External work (Logics, appointments, cadence) is drained later and can never
// hold the RingCX agent session open.

const ACTIONS = Object.freeze({
  LOGICS_DNC: "logics_dnc",
  APPOINTMENT: "appointment",
  APPOINTMENT_PROMPT: "appointment_prompt",
  CADENCE: "cadence",
});

const OUTCOMES = Object.freeze({
  ANSWERED: "answered",
  APPOINTMENT: "appointment",
  CLIENT: "client",
  DNC: "dnc",
  DID_NOT_CONNECT: "did_not_connect",
  VOICEMAIL: "voicemail",
});

function str(value) {
  return String(value == null ? "" : value).trim();
}

function scalar(body, ...keys) {
  for (const key of keys) {
    const value = body && Object.prototype.hasOwnProperty.call(body, key) ? body[key] : null;
    if (["string", "number", "boolean"].includes(typeof value) && str(value)) return str(value);
  }
  return "";
}

function token(value) {
  return str(value)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeAgentEmail(value) {
  const email = str(value).toLowerCase();
  const match = email.match(/^([^@+]+)(?:\+[^@]+)?@(.+)$/);
  return match ? `${match[1]}@${match[2]}` : email || null;
}

function normalizePhone(value) {
  const digits = str(value).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function parseDirectExternId(value) {
  const match = str(value).match(/^cx-direct-([a-z0-9_]+)-(\d+)$/i);
  if (!match) return null;
  const caseId = Number(match[2]);
  return Number.isFinite(caseId) && caseId > 0
    ? { domain: match[1].toUpperCase(), caseId }
    : null;
}

function classifyDisposition(value) {
  const normalized = token(value);
  const compact = normalized.replace(/_/g, "");
  if (!normalized || compact === "autodispo" || compact === "none") return null;
  if (["dnc", "donotcall", "badlead", "badnumber", "wrongnumber", "invalidnumber", "outofservice", "disconnected"].includes(compact)) {
    return OUTCOMES.DNC;
  }
  if (["appointment", "appt", "setappointment", "appointmentscheduled", "booked"].includes(compact)) {
    return OUTCOMES.APPOINTMENT;
  }
  if (["client", "sold", "sale", "converted"].includes(compact)) return OUTCOMES.CLIENT;
  if (["voicemail", "vmdrop", "leftmessage", "leftvoicemail", "answeringmachine", "machinedetected"].includes(compact)) {
    return OUTCOMES.VOICEMAIL;
  }
  if (["noanswer", "didnotconnect", "noconnect", "notconnected", "busy", "congestion", "intercept", "fax", "abandoned"].includes(compact)) {
    return OUTCOMES.DID_NOT_CONNECT;
  }
  if (["answer", "answered", "connected"].includes(compact)) return OUTCOMES.ANSWERED;
  return null;
}

function normalizeRingcxWebhook(body = {}, { receivedAt = new Date() } = {}) {
  const agentDisposition = scalar(body, "agent_disposition", "agentDisposition", "disposition");
  const passDisposition = scalar(body, "pass_disposition", "passDisposition", "system_disposition", "systemDisposition");
  const explicitOutcome = classifyDisposition(agentDisposition);
  const outcome = explicitOutcome || classifyDisposition(passDisposition);
  const leadState = scalar(body, "lead_state", "leadState", "state").toUpperCase() || null;
  const externId = scalar(body, "extern_id", "externId", "external_id", "externalId") || null;
  const directIdentity = parseDirectExternId(externId);
  const appointmentAt = scalar(body, "appointment_at", "appointmentAt") || null;
  const appointmentDate = scalar(body, "appointment_date", "appointmentDate") || null;
  const appointmentTime = scalar(body, "appointment_time", "appointmentTime") || null;
  const appointmentTimezone = scalar(body, "appointment_timezone", "appointmentTimezone") || null;
  const durationRaw = scalar(body, "duration", "duration_sec", "durationSec");
  const durationSec = Number(durationRaw);
  return {
    campaignId: scalar(body, "campaign_id", "campaignId") || null,
    externId,
    uii: scalar(body, "uii", "call_id", "callId", "session_id", "sessionId") || null,
    agentId: scalar(body, "agent_id", "agentId") || null,
    agentUsername: scalar(body, "agent_username", "agentUsername") || null,
    agentEmail: normalizeAgentEmail(scalar(body, "agent_username", "agentUsername")),
    agentDisposition: agentDisposition || null,
    passDisposition: passDisposition || null,
    leadState,
    outcome,
    explicitOutcome,
    domain: directIdentity?.domain || null,
    caseId: directIdentity?.caseId || null,
    appointmentAt,
    appointmentDate,
    appointmentTime,
    appointmentTimezone,
    callStart: scalar(body, "call_start", "callStart") || null,
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
    observedAt: receivedAt instanceof Date ? receivedAt : new Date(receivedAt),
  };
}

function actionForEvent(event = {}, { cadenceDelayMs = 60 * 60 * 1000 } = {}) {
  if (!event.uii || !event.outcome) return null;
  if (event.outcome === OUTCOMES.DNC) return { type: ACTIONS.LOGICS_DNC };
  if (event.outcome === OUTCOMES.APPOINTMENT) {
    const hasDateTime = Boolean(event.appointmentAt || (event.appointmentDate && event.appointmentTime));
    return { type: hasDateTime ? ACTIONS.APPOINTMENT : ACTIONS.APPOINTMENT_PROMPT };
  }
  if ([OUTCOMES.DID_NOT_CONNECT, OUTCOMES.VOICEMAIL].includes(event.outcome)) {
    return {
      type: ACTIONS.CADENCE,
      nextEligibleAt: new Date(event.observedAt.getTime() + Math.max(Number(cadenceDelayMs) || 0, 0)),
    };
  }
  return null;
}

function memoryStatus(event = {}) {
  if (["ACTIVE", "PENDING", "RINGING", "DIALING", "OUTDIAL", "CONNECTED", "ENGAGED"].includes(event.leadState)) return "active";
  if (event.leadState === "COMPLETE" || event.outcome) return "completed";
  return "observed";
}

function createCxBoringWebhookService({ repository, resolveLead = null, cadenceDelayMs } = {}) {
  if (!repository || typeof repository.upsertCallMemory !== "function" || typeof repository.enqueueAction !== "function") {
    throw new Error("createCxBoringWebhookService requires repository call-memory and action methods");
  }

  async function ingest(body = {}, options = {}) {
    const event = normalizeRingcxWebhook(body, options);
    if (!event.uii || !event.externId) {
      return { accepted: true, remembered: false, actionQueued: false, reason: "missing-call-identity" };
    }
    const resolved = typeof resolveLead === "function" ? await resolveLead(event) : null;
    const identity = {
      domain: resolved?.domain || event.domain || null,
      caseId: Number(resolved?.caseId || event.caseId) || null,
      queueItemId: str(resolved?.queueItemId) || null,
      name: str(resolved?.name) || null,
      phone: normalizePhone(resolved?.phone) || null,
      agentEmail: resolved?.agentEmail || event.agentEmail || null,
    };
    const memory = {
      ...event,
      ...identity,
      status: memoryStatus(event),
      completedAt: memoryStatus(event) === "completed" ? event.observedAt : null,
    };
    await repository.upsertCallMemory(memory);
    const planned = actionForEvent(memory, { cadenceDelayMs });
    if (!planned || !identity.domain || !identity.caseId) {
      return {
        accepted: true,
        remembered: true,
        actionQueued: false,
        reason: planned ? "missing-lead-context" : "memory-only",
        event: memory,
      };
    }
    const action = {
      id: `${event.uii}:${planned.type}`,
      type: planned.type,
      outcome: event.outcome,
      uii: event.uii,
      externId: event.externId,
      campaignId: event.campaignId,
      domain: identity.domain,
      caseId: identity.caseId,
      queueItemId: identity.queueItemId,
      agentId: event.agentId,
      agentEmail: identity.agentEmail,
      name: identity.name,
      phone: identity.phone,
      disposition: event.agentDisposition || event.passDisposition || null,
      appointmentAt: event.appointmentAt,
      appointmentDate: event.appointmentDate,
      appointmentTime: event.appointmentTime,
      appointmentTimezone: event.appointmentTimezone,
      nextEligibleAt: planned.nextEligibleAt || null,
      observedAt: event.observedAt,
    };
    const queued = await repository.enqueueAction(action);
    return { accepted: true, remembered: true, actionQueued: Boolean(queued), duplicate: !queued, event: memory, action };
  }

  return { ingest };
}

function createCxBoringWebhookActionDrain({ repository, handlers = {}, logger = console } = {}) {
  if (!repository || typeof repository.listPendingActions !== "function") {
    throw new Error("createCxBoringWebhookActionDrain requires repository.listPendingActions");
  }

  async function drainOnce({ limit = 50 } = {}) {
    const rows = await repository.listPendingActions(limit);
    let completed = 0;
    let failed = 0;
    for (const row of rows) {
      const handler = handlers[row.type];
      if (typeof handler !== "function") {
        await repository.markActionFailed(row.id, `no-handler:${row.type}`);
        failed += 1;
        continue;
      }
      try {
        const result = await handler(row);
        if (result?.ok === false) throw new Error(result.error || result.reason || `${row.type}-failed`);
        await repository.markActionCompleted(row.id, result || null);
        completed += 1;
      } catch (error) {
        await repository.markActionFailed(row.id, error?.message || String(error));
        logger.warn?.("cx.boring_webhook.action_failed", { id: row.id, type: row.type, error: error?.message });
        failed += 1;
      }
    }
    return { scanned: rows.length, completed, failed };
  }

  return { drainOnce };
}

function extractRingcxActiveCalls(response) {
  const rows = Array.isArray(response)
    ? response
    : ["activeCalls", "results", "items", "records", "data", "calls"]
      .map((key) => response?.[key])
      .find(Array.isArray);
  if (!Array.isArray(rows)) throw new Error("RingCX active-call response was not a list");
  return rows.map((row) => ({
    uii: str(row?.uii || row?.callId) || null,
    externId: str(row?.externalId || row?.externId || row?.outboundExternid) || null,
    agentId: str(row?.agentId || row?.username) || null,
    campaignId: str(row?.campaignId) || null,
    callState: str(row?.callState || row?.state) || "ACTIVE",
  })).filter((row) => row.uii && row.externId);
}

function createCxBoringWebhookCallPoller({ client, service, repository, logger = console } = {}) {
  if (!client || typeof client.listActiveCalls !== "function") {
    throw new Error("createCxBoringWebhookCallPoller requires client.listActiveCalls");
  }
  if (!service || typeof service.ingest !== "function") {
    throw new Error("createCxBoringWebhookCallPoller requires the webhook service");
  }
  if (!repository || typeof repository.retireMissingActive !== "function") {
    throw new Error("createCxBoringWebhookCallPoller requires repository.retireMissingActive");
  }

  async function pollOnce({ now = new Date() } = {}) {
    const response = await client.listActiveCalls({ product: "ACCOUNT" });
    const calls = extractRingcxActiveCalls(response);
    let remembered = 0;
    for (const call of calls) {
      try {
        const result = await service.ingest({
          uii: call.uii,
          extern_id: call.externId,
          agent_id: call.agentId,
          campaign_id: call.campaignId,
          lead_state: call.callState || "ACTIVE",
        }, { receivedAt: now });
        if (result?.remembered) remembered += 1;
      } catch (error) {
        logger.warn?.("cx.boring_webhook.poll_call_failed", { uii: call.uii, error: error?.message });
      }
    }
    const retired = await repository.retireMissingActive(calls.map((call) => call.uii), { now });
    return { active: calls.length, remembered, retired: Number(retired?.modifiedCount || 0) };
  }

  return { pollOnce };
}

module.exports = {
  ACTIONS,
  OUTCOMES,
  actionForEvent,
  classifyDisposition,
  createCxBoringWebhookActionDrain,
  createCxBoringWebhookCallPoller,
  createCxBoringWebhookService,
  extractRingcxActiveCalls,
  normalizeAgentEmail,
  normalizeRingcxWebhook,
  parseDirectExternId,
};
