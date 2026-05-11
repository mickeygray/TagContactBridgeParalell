"use strict";

/**
 * Unified communication log for a single case (or prospect).
 *
 * Reads from every store that holds an SMS/email/call/cadence event and
 * emits a single chronological list normalized to one entry shape so
 * the SPA can render it as a timeline. Source-agnostic by design: pass
 * either a `caseId`, a `phone`, or both — the resolver fills in
 * whichever's missing so we hit caseId-keyed AND phone-keyed stores in
 * the same call.
 *
 * Write paths are unchanged. This is read-only. Any new write path that
 * lands in any of the source stores below will appear in the log
 * automatically — no reader changes needed.
 *
 * Sources fanned in:
 *   - CaseProfile.communications[]             (unified case timeline)
 *   - CaseProfile.communicationThreads.sms[]    (post-conversion sms)
 *   - CaseProfile.communicationThreads.email[]  (post-conversion email)
 *   - ConversationMessage collection            (sms in/out by phone)
 *   - CallLog collection                        (calls by caseId+phone)
 *   - LeadCadence.schedule.actions[]            (cadence attempts)
 *
 * Dedup: outbound SMS via the CX workspace dual-writes to both
 * `communications`, `communicationThreads.sms`, and `ConversationMessage`. We dedupe on
 * `(channel, direction, phone, providerMessageId-or-body-hash, ts ±1s)`
 * — keeping whichever row has more provider/status detail.
 */

const {
  caseProfileRepository,
  callLogRepository,
  conversationMessageRepository,
  leadCadenceRepository,
  masterProspectRepository,
} = require("../../shared-repositories/src");

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length >= 10) return digits.slice(-10);
  return null;
}

function toMs(value) {
  if (!value) return 0;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isFinite(t) ? t : 0;
}

// ── Identity resolver ────────────────────────────────────────────
//
// Given a partial identity ({ caseId } | { phone } | both), look across
// CaseProfile / MasterProspectIndex / LeadCadence to fill in the missing
// half so we can hit BOTH caseId-keyed AND phone-keyed stores.
async function resolveIdentity(domain, { caseId, phone }) {
  const result = {
    caseId: caseId != null && Number.isFinite(Number(caseId)) ? Number(caseId) : null,
    phone: normalizePhone(phone),
    caseProfile: null,
    masterProspect: null,
    leadCadence: null,
    convertedAt: null,
  };

  // Walk caseProfile first — if the case exists, that's authoritative.
  if (result.caseId != null) {
    result.caseProfile = await caseProfileRepository
      .findCaseProfile(domain, result.caseId)
      .catch(() => null);
    if (result.caseProfile) {
      const cp = result.caseProfile.toObject
        ? result.caseProfile.toObject()
        : result.caseProfile;
      if (!result.phone) {
        result.phone = normalizePhone(
          cp.primaryPhone
            || (Array.isArray(cp.normalizedPhones) ? cp.normalizedPhones[0] : null),
        );
      }
      result.convertedAt = cp.convertedAt || null;
    }
  } else if (result.phone) {
    // Try caseProfile by phone first — it's authoritative when present.
    result.caseProfile = await caseProfileRepository
      .findCaseProfileByPhone(domain, result.phone)
      .catch(() => null);
    if (result.caseProfile) {
      const cp = result.caseProfile.toObject
        ? result.caseProfile.toObject()
        : result.caseProfile;
      result.caseId = cp.caseId != null ? Number(cp.caseId) : null;
      result.convertedAt = cp.convertedAt || null;
    }
  }

  // LeadCadence — fills in the cadence-attempts source for the timeline.
  if (result.caseId != null) {
    result.leadCadence = await leadCadenceRepository
      .findLeadCadence(domain, result.caseId)
      .catch(() => null);
  } else if (result.phone) {
    result.leadCadence = await leadCadenceRepository
      .findLeadCadenceByPhone(domain, result.phone)
      .catch(() => null);
    if (result.leadCadence?.caseId != null) {
      result.caseId = Number(result.leadCadence.caseId);
    }
  }

  // MasterProspect — last fallback for caseId from a phone-only request.
  if (result.caseId == null && result.phone) {
    result.masterProspect = await masterProspectRepository
      .findMasterProspectByNormalizedPhone(domain, result.phone)
      .catch(() => null);
    if (result.masterProspect?.caseId != null) {
      result.caseId = Number(result.masterProspect.caseId);
    }
  }

  return result;
}

// ── Per-source extractors → unified entry shape ─────────────────
//
// Unified entry shape (every source emits this):
//   {
//     ts: Date,
//     channel: "sms" | "email" | "call" | "rvm",
//     direction: "inbound" | "outbound" | "scheduled",
//     status: string,           // "sent"|"delivered"|"failed"|"completed"|...
//     body: string | null,      // sms/email body, call summary, rvm template
//     actor: { email, name } | null,
//     source: "case-profile" | "conversation-message" | "call-log" |
//             "lead-cadence",
//     refId: string,            // _id or telephonySessionId from the source
//     metadata: object,         // channel-specific extras
//   }

function entriesFromCaseProfileCommunicationArray(cp) {
  const rows = Array.isArray(cp?.communications) ? cp.communications : [];
  return rows.map((row) => ({
    ts: row.happenedAt || row.sentAt || cp.updatedAt || new Date(0),
    channel: row.channel || "sms",
    direction:
      row.direction === "inbound"
        ? "inbound"
        : row.direction === "scheduled"
          ? "scheduled"
          : "outbound",
    status: row.status || "sent",
    body: row.body || null,
    actor: row.actorEmail || row.actorName
      ? { email: row.actorEmail || null, name: row.actorName || null }
      : null,
    source: "case-profile",
    refId: row._id ? String(row._id) : row.threadKey || `${cp._id}:communication:${toMs(row.happenedAt || row.sentAt)}`,
    metadata: {
      provider: row.provider || null,
      providerMessageId: row.providerMessageId || null,
      providerError: row.providerError || null,
      templateKey: row.templateKey || null,
      subject: row.subject || null,
      workflowId: row.workflowId ? String(row.workflowId) : null,
      conversationMessageId: row.conversationMessageId || null,
      phone: row.phone || null,
      email: row.email || null,
      ...(row.metadata || {}),
    },
  }));
}

function entriesFromCaseProfileThreads(caseProfile) {
  if (!caseProfile) return [];
  const cp = caseProfile.toObject ? caseProfile.toObject() : caseProfile;
  const threads = cp.communicationThreads || {};
  const out = entriesFromCaseProfileCommunicationArray(cp);

  for (const row of Array.isArray(threads.sms) ? threads.sms : []) {
    out.push({
      ts: row.sentAt || cp.updatedAt || new Date(0),
      channel: "sms",
      direction: row.direction === "inbound" ? "inbound" : "outbound",
      status: row.status || "sent",
      body: row.body || null,
      actor: row.actorEmail || row.actorName
        ? { email: row.actorEmail || null, name: row.actorName || null }
        : null,
      source: "case-profile",
      refId: row.threadKey || `${cp._id}:sms:${toMs(row.sentAt)}`,
      metadata: {
        provider: row.provider || null,
        templateKey: row.templateKey || null,
        workflowId: row.workflowId ? String(row.workflowId) : null,
        ...(row.metadata || {}),
      },
    });
  }

  for (const row of Array.isArray(threads.email) ? threads.email : []) {
    out.push({
      ts: row.sentAt || cp.updatedAt || new Date(0),
      channel: "email",
      direction: row.direction === "inbound" ? "inbound" : "outbound",
      status: row.status || "sent",
      body: row.body || null,
      actor: row.actorEmail || row.actorName
        ? { email: row.actorEmail || null, name: row.actorName || null }
        : null,
      source: "case-profile",
      refId: row.threadKey || `${cp._id}:email:${toMs(row.sentAt)}`,
      metadata: {
        provider: row.provider || null,
        templateKey: row.templateKey || null,
        subject: row.subject || null,
        workflowId: row.workflowId ? String(row.workflowId) : null,
        ...(row.metadata || {}),
      },
    });
  }

  return out;
}

function entriesFromConversationMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((row) => {
    const m = row.toObject ? row.toObject() : row;
    return {
      ts: m.createdAt || m.providerSentAt || new Date(0),
      channel: m.channel || "sms",
      direction: m.direction === "inbound" ? "inbound" : "outbound",
      status: m.providerStatus || m.status || (m.direction === "inbound" ? "received" : "sent"),
      body: m.body || null,
      actor: m.approvedByEmail
        ? { email: m.approvedByEmail, name: null }
        : null,
      source: "conversation-message",
      refId: String(m._id),
      metadata: {
        provider: m.provider || null,
        providerMessageId: m.providerMessageId || null,
        providerError: m.providerError || null,
        workflowId: m.workflowId ? String(m.workflowId) : null,
        aiClassification: m.aiClassification || null,
      },
    };
  });
}

function entriesFromCallLogs(callLogs) {
  if (!Array.isArray(callLogs)) return [];
  return callLogs.map((row) => {
    const c = row.toObject ? row.toObject() : row;
    const direction = String(c.direction || "").toLowerCase().startsWith("in")
      ? "inbound"
      : "outbound";
    const durationSec = Number(c.durationSeconds || c.duration || 0) || 0;
    const result = c.result || c.disposition || c.callOutcome || null;
    return {
      ts: c.callStartTime || c.createdAt || new Date(0),
      channel: "call",
      direction,
      status: result || (durationSec > 0 ? "completed" : "no-answer"),
      body: c.summary || null,
      actor: c.agentEmail || c.agentName
        ? { email: c.agentEmail || null, name: c.agentName || null }
        : null,
      source: "call-log",
      refId: c.telephonySessionId || String(c._id),
      metadata: {
        durationSeconds: durationSec,
        recordingUrl: c.recordingUrl || null,
        extensionId: c.extensionId || null,
        phone: c.phone || c.normalizedPhone || null,
        result,
        statusCategory: c.statusCategory || null,
      },
    };
  });
}

function entriesFromLeadCadenceActions(leadCadence) {
  if (!leadCadence) return [];
  const lc = leadCadence.toObject ? leadCadence.toObject() : leadCadence;
  const actions = Array.isArray(lc?.schedule?.actions) ? lc.schedule.actions : [];
  return actions.map((a) => {
    const completed = a.status === "completed" || a.status === "requested";
    return {
      // For completed actions, scheduledFor IS effectively the send time
      // (the worker fires it on schedule). For pending/cancelled, it's
      // when the action was supposed to fire.
      ts: a.scheduledFor || lc.updatedAt || new Date(0),
      channel: a.channel || "sms",
      direction: completed ? "outbound" : "scheduled",
      status: a.status || "pending",
      body: null,
      actor: null,
      source: "lead-cadence",
      refId: a.key,
      metadata: {
        type: a.type || null,
        templateKey: a.templateKey || null,
        providerDelivery: a.providerDelivery || null,
        contingentOnActionKey: a.contingentOnActionKey || null,
        contingencyMode: a.contingencyMode || null,
      },
    };
  });
}

// ── Dedup ────────────────────────────────────────────────────────
//
// CX-workspace outbound SMS dual-writes to both communicationThreads.sms
// and ConversationMessage. Without dedup the operator sees the same
// message twice. Match on (channel, direction, body trimmed, ±2s) and
// keep the conversation-message version because it carries provider
// IDs/errors that the thread copy doesn't always have.
function dedupeEntries(entries) {
  const out = [];
  const seen = new Map(); // key → idx-into-out

  function keyFor(e) {
    if (!e.body) return null;
    const trimmedBody = e.body.trim().slice(0, 200);
    const tsBucket = Math.floor(toMs(e.ts) / 2000); // 2s bucket
    return `${e.channel}|${e.direction}|${trimmedBody}|${tsBucket}`;
  }

  for (const e of entries) {
    const k = keyFor(e);
    if (k === null) {
      out.push(e);
      continue;
    }
    if (!seen.has(k)) {
      seen.set(k, out.length);
      out.push(e);
      continue;
    }
    const existingIdx = seen.get(k);
    const existing = out[existingIdx];
    // Prefer conversation-message (richer provider metadata).
    if (
      e.source === "conversation-message"
      && existing.source !== "conversation-message"
    ) {
      out[existingIdx] = e;
    }
    // else: keep existing (first-write wins among ties).
  }

  return out;
}

// ── Public reader ────────────────────────────────────────────────

async function buildCxCommLog(domain, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) {
    const err = new Error("domain is required");
    err.status = 400;
    throw err;
  }

  const id = await resolveIdentity(normalizedDomain, {
    caseId: options.caseId,
    phone: options.phone,
  });

  if (id.caseId == null && !id.phone) {
    return {
      ok: true,
      domain: normalizedDomain,
      caseId: null,
      phone: null,
      identityResolved: false,
      reason: "neither caseId nor phone yields a known identity",
      entries: [],
    };
  }

  const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 1000);

  // Fan out across sources in parallel.
  const [conversationMessages, callLogs] = await Promise.all([
    id.phone
      ? conversationMessageRepository
        .listRecentMessagesForPhone(normalizedDomain, id.phone, { limit })
        .catch(() => [])
      : Promise.resolve([]),
    id.caseId != null
      ? callLogRepository
        .listCallLogsByCaseId(normalizedDomain, id.caseId, { limit })
        .catch(() => [])
      : Promise.resolve([]),
  ]);

  // Build entries from every source.
  const raw = [
    ...entriesFromCaseProfileThreads(id.caseProfile),
    ...entriesFromConversationMessages(conversationMessages),
    ...entriesFromCallLogs(callLogs),
    ...entriesFromLeadCadenceActions(id.leadCadence),
  ];

  const deduped = dedupeEntries(raw);

  // Sort newest first.
  deduped.sort((left, right) => toMs(right.ts) - toMs(left.ts));

  return {
    ok: true,
    domain: normalizedDomain,
    caseId: id.caseId,
    phone: id.phone,
    identityResolved: true,
    convertedAt: id.convertedAt,
    counts: {
      total: deduped.length,
      caseProfile: id.caseProfile ? 1 : 0,
      leadCadence: id.leadCadence ? 1 : 0,
      conversationMessages: conversationMessages.length,
      callLogs: callLogs.length,
    },
    entries: deduped.slice(0, limit),
  };
}

module.exports = {
  buildCxCommLog,
};
