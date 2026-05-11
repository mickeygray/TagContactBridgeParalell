"use strict";

const { ConversationMessage } = require("../../shared-models/src");

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function toMessageRecord(doc) {
  if (!doc) return null;
  const plain = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    id: String(plain._id),
    workflowId: plain.workflowId ? String(plain.workflowId) : null,
    domain: plain.domain || null,
    phone: plain.phone || null,
    caseId: plain.caseId != null ? Number(plain.caseId) : null,
    channel: plain.channel || "sms",
    direction: plain.direction || null,
    body: plain.body || "",
    provider: plain.provider || null,
    providerMessageId: plain.providerMessageId || null,
    providerStatus: plain.providerStatus || null,
    providerError: plain.providerError || null,
    aiClassification: plain.aiClassification || null,
    autoResponded: Boolean(plain.autoResponded),
    approvedByEmail: plain.approvedByEmail || null,
    approvedAt: plain.approvedAt || null,
    disposition: plain.disposition || null,
    rawPayload: plain.rawPayload || null,
    createdAt: plain.createdAt || null,
    updatedAt: plain.updatedAt || null,
  };
}

async function createInboundMessage(input = {}) {
  const doc = await ConversationMessage.create({
    workflowId: input.workflowId,
    domain: normalizeDomain(input.domain),
    phone: normalizePhone(input.phone),
    caseId: input.caseId != null ? Number(input.caseId) : null,
    channel: input.channel || "sms",
    direction: "inbound",
    body: String(input.body || ""),
    aiClassification: input.aiClassification || null,
    rawPayload: input.rawPayload || null,
  });
  return toMessageRecord(doc);
}

async function createOutboundMessage(input = {}) {
  const doc = await ConversationMessage.create({
    workflowId: input.workflowId,
    domain: normalizeDomain(input.domain),
    phone: normalizePhone(input.phone),
    caseId: input.caseId != null ? Number(input.caseId) : null,
    channel: input.channel || "sms",
    direction: "outbound",
    body: String(input.body || ""),
    provider: input.provider || "callrail",
    providerMessageId: input.providerMessageId || null,
    providerStatus: input.providerStatus || "sent",
    providerError: input.providerError || null,
    autoResponded: Boolean(input.autoResponded),
    approvedByEmail: input.approvedByEmail || null,
    approvedAt: input.approvedByEmail ? new Date() : null,
  });
  return toMessageRecord(doc);
}

async function listMessagesForWorkflow(workflowId, { limit = 200 } = {}) {
  if (!workflowId) return [];
  const docs = await ConversationMessage.find({ workflowId })
    .sort({ createdAt: 1 })
    .limit(Math.min(Number(limit) || 200, 500))
    .lean();
  return docs.map(toMessageRecord);
}

async function listRecentMessagesForPhone(domain, phone, { limit = 50 } = {}) {
  const docs = await ConversationMessage.find({
    domain: normalizeDomain(domain),
    phone: normalizePhone(phone),
  })
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 50, 200))
    .lean();
  return docs.map(toMessageRecord);
}

async function findMessageById(id) {
  if (!id) return null;
  const doc = await ConversationMessage.findById(id).lean();
  return toMessageRecord(doc);
}

/**
 * Flip provider status on an outbound row, typically from a delivery
 * webhook. Silently no-ops if we can't find the message by providerMessageId.
 */
async function updateProviderStatus({
  providerMessageId,
  providerStatus,
  providerError = null,
} = {}) {
  if (!providerMessageId || !providerStatus) return null;
  const doc = await ConversationMessage.findOneAndUpdate(
    { providerMessageId: String(providerMessageId) },
    { $set: { providerStatus, providerError } },
    { new: true },
  ).lean();
  return toMessageRecord(doc);
}

async function setDisposition(id, { label, setByEmail, note } = {}) {
  if (!id) return null;
  const doc = await ConversationMessage.findByIdAndUpdate(
    id,
    {
      $set: {
        disposition: {
          label: label || null,
          setByEmail: setByEmail || null,
          setAt: new Date(),
          note: note || null,
        },
      },
    },
    { new: true },
  ).lean();
  return toMessageRecord(doc);
}

/**
 * Used by the auto-responder cooldown check. Returns the most recent
 * outbound row for this phone/domain, or null.
 *
 * Pass `{ autoRespondedOnly: true }` to scope to bot-sent messages —
 * important for cooldown math, since a real agent manually replying
 * shouldn't block the bot from responding to a subsequent inbound.
 */
async function findLatestOutbound(domain, phone, options = {}) {
  const filter = {
    domain: normalizeDomain(domain),
    phone: normalizePhone(phone),
    direction: "outbound",
  };
  if (options.autoRespondedOnly) {
    filter.autoResponded = true;
  }
  const doc = await ConversationMessage.findOne(filter)
    .sort({ createdAt: -1 })
    .lean();
  return toMessageRecord(doc);
}

module.exports = {
  createInboundMessage,
  createOutboundMessage,
  findLatestOutbound,
  findMessageById,
  listMessagesForWorkflow,
  listRecentMessagesForPhone,
  setDisposition,
  toMessageRecord,
  updateProviderStatus,
};
