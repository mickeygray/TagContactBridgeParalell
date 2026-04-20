"use strict";

const { agentStateRepository } = require("../../shared-repositories/src");

function isCxRoutingEnabled(snapshot = {}) {
  return (
    Boolean(snapshot.cxAgentId)
    || Boolean(snapshot.cxProfileId)
    || /bruce allen/i.test(String(snapshot.name || ""))
  );
}

function deriveCxRouting(snapshot = {}) {
  const enabled = isCxRoutingEnabled(snapshot);
  const exBusyStatuses = new Set(["CallConnected", "Ringing", "OnHold"]);
  const appBusyStatuses = new Set(["onCall", "ringing"]);

  if (!enabled) {
    return {
      enabled: false,
      desiredAvailability: "available",
      reason: "cx-routing-disabled",
      syncedAt: new Date(),
      lastSource: "ringbridge",
    };
  }

  const exBusy = exBusyStatuses.has(snapshot.exTelephonyStatus);
  const appBusy = appBusyStatuses.has(snapshot.status);
  const busy = exBusy || appBusy;

  return {
    enabled: true,
    desiredAvailability: busy ? "unavailable" : "available",
    reason: busy ? "ex-busy" : "ex-idle",
    syncedAt: new Date(),
    lastSource: "ringbridge",
  };
}

function normalizeSnapshot(snapshot = {}) {
  return {
    extensionId: snapshot.extensionId,
    cxAgentId: snapshot.cxAgentId || null,
    cxProfileId: snapshot.cxProfileId || null,
    name: snapshot.name,
    company: snapshot.company || "TAG",
    pin: snapshot.pin || null,
    status: snapshot.status || "offline",
    exTelephonyStatus: snapshot.exTelephonyStatus || "NoCall",
    exPresenceStatus: snapshot.exPresenceStatus || "Offline",
    currentCall: snapshot.currentCall || {},
    activePlatform: snapshot.activePlatform || "none",
    lastStatusChange: snapshot.lastStatusChange || new Date(),
    lastEventReceived: snapshot.lastEventReceived || null,
    dailyStats: snapshot.dailyStats || {},
    upstream: {
      source: snapshot.upstream?.source || "ringbridge",
      mirroredAt: snapshot.upstream?.mirroredAt || new Date(),
    },
  };
}

async function mirrorAgentState(snapshot = {}) {
  const normalized = normalizeSnapshot(snapshot);
  normalized.cxRouting = deriveCxRouting(normalized);
  return agentStateRepository.upsertAgentState(normalized);
}

async function listCxAgentStates() {
  return agentStateRepository.listAgentStates();
}

async function getCxAgentStateByExtensionId(extensionId) {
  return agentStateRepository.findAgentStateByExtensionId(extensionId);
}

module.exports = {
  deriveCxRouting,
  getCxAgentStateByExtensionId,
  listCxAgentStates,
  mirrorAgentState,
};
