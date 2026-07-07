"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { agentStateRepository } = require("../../packages/shared-repositories/src");
const {
  touchCxWorkspacePresence,
} = require("../../packages/shared-services/src/agentAvailabilityService");

async function captureWorkspacePresencePatch(existingState) {
  const originalFind = agentStateRepository.findAgentStateByExtensionId;
  const originalUpdate = agentStateRepository.updateAgentState;
  let capturedExtensionId = null;
  let capturedPatch = null;

  agentStateRepository.findAgentStateByExtensionId = async () => existingState;
  agentStateRepository.updateAgentState = async (extensionId, patch) => {
    capturedExtensionId = extensionId;
    capturedPatch = patch;
    return { ...(existingState || {}), extensionId, ...patch };
  };

  try {
    await touchCxWorkspacePresence("63914587004", {
      active: true,
      source: "cx-workspace",
      userEmail: "bhansen@taxadvocategroup.com",
    });
  } finally {
    agentStateRepository.findAgentStateByExtensionId = originalFind;
    agentStateRepository.updateAgentState = originalUpdate;
  }

  return { capturedExtensionId, capturedPatch };
}

test("active CX workspace heartbeat heals stale logout routing for an idle available agent", async () => {
  const { capturedExtensionId, capturedPatch } = await captureWorkspacePresencePatch({
    extensionId: "63914587004",
    status: "available",
    activityState: "idle",
    activePlatform: "none",
    currentCall: {},
    cxRouting: {
      enabled: true,
      desiredAvailability: "unavailable",
      reason: "logout",
      lastSource: "cx-workspace",
      pauseType: "logout",
      assignmentStats: { openAssignments: 0 },
    },
  });

  assert.equal(capturedExtensionId, "63914587004");
  assert.equal(capturedPatch["cxRouting.desiredAvailability"], "available");
  assert.equal(capturedPatch["cxRouting.reason"], "manual-available");
  assert.equal(capturedPatch["cxRouting.lastSource"], "cx-workspace");
  assert.equal(capturedPatch["cxRouting.pauseType"], null);
  assert.equal(capturedPatch["cxRouting.manualUnavailableAt"], null);
});

test("active CX workspace heartbeat does not clear a real manual pause", async () => {
  const { capturedPatch } = await captureWorkspacePresencePatch({
    extensionId: "63914587004",
    status: "available",
    activityState: "idle",
    activePlatform: "none",
    currentCall: {},
    cxRouting: {
      enabled: true,
      desiredAvailability: "unavailable",
      reason: "manual-unavailable",
      lastSource: "cx-workspace",
      pauseType: "short-break",
      assignmentStats: { openAssignments: 0 },
    },
  });

  assert.equal(capturedPatch["cxRouting.desiredAvailability"], undefined);
  assert.equal(capturedPatch["cxRouting.reason"], undefined);
  assert.equal(capturedPatch["cxRouting.pauseType"], undefined);
});
