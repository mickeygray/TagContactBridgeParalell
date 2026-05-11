"use strict";

const { AgentState } = require("../../shared-models/src");

async function upsertAgentState(snapshot) {
  const extensionId = String(snapshot.extensionId || "").trim();
  if (!extensionId) {
    throw new Error("extensionId is required");
  }

  return AgentState.findOneAndUpdate(
    { extensionId },
    {
      $set: {
        ...snapshot,
        extensionId,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );
}

async function updateAgentState(extensionId, update = {}) {
  const normalizedExtensionId = String(extensionId || "").trim();
  if (!normalizedExtensionId) {
    throw new Error("extensionId is required");
  }

  return AgentState.findOneAndUpdate(
    { extensionId: normalizedExtensionId },
    { $set: update },
    {
      new: true,
    },
  );
}

async function findAgentStateByExtensionId(extensionId) {
  return AgentState.findOne({ extensionId: String(extensionId || "").trim() }).lean();
}

async function findAgentStateByName(name) {
  return AgentState.findOne({ name: new RegExp(`^${String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }).lean();
}

async function listAgentStates(filters = {}) {
  const query = {};
  if (filters.company) query.company = filters.company;
  if (typeof filters.routingEnabled === "boolean") query["cxRouting.enabled"] = filters.routingEnabled;

  return AgentState.find(query)
    .sort({ company: 1, name: 1 })
    .lean();
}

module.exports = {
  findAgentStateByExtensionId,
  findAgentStateByName,
  listAgentStates,
  updateAgentState,
  upsertAgentState,
};
