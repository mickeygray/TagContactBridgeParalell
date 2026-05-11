"use strict";

const { ConversationWorkflow } = require("../../shared-models/src");

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function buildQuery(domain, filters = {}) {
  const query = {
    domain: normalizeDomain(domain),
  };

  if (filters.channel) query.channel = filters.channel;
  if (filters.status) query.status = filters.status;
  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.optOutDetected != null) query.optOutDetected = Boolean(filters.optOutDetected);

  // By default, hide threads the auto-responder already handled —
  // operator attention should go to needs_human / error / un-drafted
  // threads, not to the bot's clean DNC confirms and callback prompts.
  // `includeAutoResponded: true` flips the filter off for admin views
  // that want the full list.
  if (!filters.includeAutoResponded) {
    query.aiRecommendedAction = {
      $nin: ["auto_dnc_confirm", "auto_callback_prompt"],
    };
  }

  const search = String(filters.search || "").trim();
  if (search) {
    const numericSearch = search.replace(/\D/g, "");
    const or = [];
    if (numericSearch) {
      or.push({ phone: numericSearch });
      if (!Number.isNaN(Number(numericSearch))) {
        or.push({ caseId: Number(numericSearch) });
      }
    }
    or.push({ latestInboundText: { $regex: search, $options: "i" } });
    query.$or = or;
  }

  return query;
}

async function upsertConversationWorkflow(domain, phone, update = {}) {
  return ConversationWorkflow.findOneAndUpdate(
    {
      domain: normalizeDomain(domain),
      phone: normalizePhone(phone),
      channel: update.channel || "sms",
    },
    {
      $set: {
        ...update,
        domain: normalizeDomain(domain),
        phone: normalizePhone(phone),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function findConversationWorkflow(domain, phone, channel = "sms") {
  return ConversationWorkflow.findOne({
    domain: normalizeDomain(domain),
    phone: normalizePhone(phone),
    channel,
  }).lean();
}

async function findConversationWorkflowById(id) {
  return ConversationWorkflow.findById(id).lean();
}

async function updateConversationWorkflowById(id, update = {}) {
  return ConversationWorkflow.findByIdAndUpdate(
    id,
    { $set: update },
    { new: true },
  ).lean();
}

async function listConversationWorkflows(domain, filters = {}) {
  const query = buildQuery(domain, filters);
  const limit = Math.min(Number(filters.limit) || 50, 200);
  return ConversationWorkflow.find(query)
    .sort({ latestInboundAt: -1, updatedAt: -1, createdAt: -1 })
    .limit(limit)
    .lean();
}

async function countConversationWorkflows(domain, filters = {}) {
  return ConversationWorkflow.countDocuments(buildQuery(domain, filters));
}

module.exports = {
  countConversationWorkflows,
  findConversationWorkflow,
  findConversationWorkflowById,
  listConversationWorkflows,
  updateConversationWorkflowById,
  upsertConversationWorkflow,
};
