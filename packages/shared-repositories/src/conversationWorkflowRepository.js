"use strict";

const { ConversationWorkflow } = require("../../shared-models/src");

async function upsertConversationWorkflow(domain, phone, update = {}) {
  return ConversationWorkflow.findOneAndUpdate(
    {
      domain: String(domain || "").toUpperCase(),
      phone: String(phone || "").replace(/\D/g, ""),
      channel: update.channel || "sms",
    },
    {
      $set: {
        ...update,
        domain: String(domain || "").toUpperCase(),
        phone: String(phone || "").replace(/\D/g, ""),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function findConversationWorkflow(domain, phone, channel = "sms") {
  return ConversationWorkflow.findOne({
    domain: String(domain || "").toUpperCase(),
    phone: String(phone || "").replace(/\D/g, ""),
    channel,
  }).lean();
}

module.exports = {
  findConversationWorkflow,
  upsertConversationWorkflow,
};
