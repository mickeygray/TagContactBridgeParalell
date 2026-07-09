"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  agentStateRepository,
  cxDialQueueRepository,
} = require("../../packages/shared-repositories/src");
const {
  releaseAssignedCxQueueForAgent,
  releaseManualUnavailableAgentQueues,
} = require("../../packages/shared-services/src/cxCadenceService");

function setEnv(key, value) {
  const original = process.env[key];
  if (value == null) delete process.env[key];
  else process.env[key] = value;
  return () => {
    if (original == null) delete process.env[key];
    else process.env[key] = original;
  };
}

function stubManualUnavailableRepositories(agentState) {
  const originalListAgentStates = agentStateRepository.listAgentStates;
  const originalFindAgentState = agentStateRepository.findAgentStateByExtensionId;
  const originalUpdateAgentState = agentStateRepository.updateAgentState;
  const originalListQueueItems = cxDialQueueRepository.listQueueItems;

  const calls = {
    listedAgents: 0,
    listedQueueItems: 0,
    updatedAgentStates: [],
  };

  agentStateRepository.listAgentStates = async () => {
    calls.listedAgents += 1;
    return agentState ? [agentState] : [];
  };
  agentStateRepository.findAgentStateByExtensionId = async () => agentState;
  agentStateRepository.updateAgentState = async (extensionId, patch) => {
    calls.updatedAgentStates.push({ extensionId, patch });
    return { ...(agentState || {}), extensionId, ...patch };
  };
  cxDialQueueRepository.listQueueItems = async () => {
    calls.listedQueueItems += 1;
    return [];
  };

  return {
    calls,
    restore() {
      agentStateRepository.listAgentStates = originalListAgentStates;
      agentStateRepository.findAgentStateByExtensionId = originalFindAgentState;
      agentStateRepository.updateAgentState = originalUpdateAgentState;
      cxDialQueueRepository.listQueueItems = originalListQueueItems;
    },
  };
}

test("manual-unavailable queue release watcher is disabled by default", async () => {
  const restoreEnv = setEnv("RC_CX_MANUAL_UNAVAILABLE_RELEASE_ENABLED", null);
  const stub = stubManualUnavailableRepositories({
    extensionId: "63914587004",
    cxRouting: {
      enabled: true,
      desiredAvailability: "unavailable",
      reason: "manual-unavailable",
    },
  });

  try {
    const result = await releaseManualUnavailableAgentQueues({
      now: new Date("2026-07-07T20:00:00.000Z"),
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "manual-unavailable-release-disabled");
    assert.equal(stub.calls.listedAgents, 0);
    assert.equal(stub.calls.listedQueueItems, 0);
    assert.equal(stub.calls.updatedAgentStates.length, 0);
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test("manual-unavailable timeout release does not stamp an explicit logout", async () => {
  const restoreEnv = setEnv("RC_CX_MANUAL_UNAVAILABLE_RELEASE_ENABLED", "true");
  const now = new Date("2026-07-07T20:00:00.000Z");
  const pauseStartedAt = new Date("2026-07-07T19:50:00.000Z");
  const pauseReleaseAt = new Date("2026-07-07T19:55:00.000Z");
  const stub = stubManualUnavailableRepositories({
    extensionId: "63914587004",
    name: "Test Agent",
    activityState: "unavailable",
    cxRouting: {
      enabled: true,
      desiredAvailability: "unavailable",
      reason: "manual-unavailable",
      lastSource: "cx-workspace",
      manualUnavailableAt: pauseStartedAt,
      pauseStartedAt,
      pauseReleaseAt,
      pauseType: "short-break",
      assignmentStats: { openAssignments: 0 },
    },
    appPresence: {
      cxWorkspaceActive: true,
      sessionId: "workspace-session",
    },
  });

  try {
    const result = await releaseManualUnavailableAgentQueues({ now });

    assert.equal(result.ok, true);
    assert.equal(result.matchedAgents, 1);
    assert.equal(result.released, 0);
    assert.equal(stub.calls.listedQueueItems, 1);
    assert.equal(stub.calls.updatedAgentStates.length, 1);

    const patch = stub.calls.updatedAgentStates[0].patch;
    assert.equal(patch.activityState, "unavailable");
    assert.equal(patch["cxRouting.desiredAvailability"], "unavailable");
    assert.equal(patch["cxRouting.reason"], "manual-unavailable");
    assert.equal(patch["cxRouting.pauseType"], "short-break");
    assert.equal(patch["cxRouting.lastSource"], "cx-workspace");
    assert.equal(patch["upstream.source"], "manual-unavailable-timeout");
    assert.equal(patch["appPresence.cxWorkspaceActive"], undefined);
    assert.equal(patch["appPresence.sessionId"], undefined);
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test("manual work pause is not released by the timed break watcher", async () => {
  const restoreEnv = setEnv("RC_CX_MANUAL_UNAVAILABLE_RELEASE_ENABLED", "true");
  const now = new Date("2026-07-08T20:00:00.000Z");
  const pauseStartedAt = new Date("2026-07-08T15:00:00.000Z");
  const stub = stubManualUnavailableRepositories({
    extensionId: "63914587004",
    name: "Sean Pilot",
    activityState: "unavailable",
    cxRouting: {
      enabled: true,
      desiredAvailability: "unavailable",
      reason: "manual-unavailable",
      lastSource: "cx-workspace",
      manualUnavailableAt: pauseStartedAt,
      pauseStartedAt,
      pauseReleaseAt: null,
      pauseType: "work-pause",
      assignmentStats: { openAssignments: 0 },
    },
    appPresence: {
      cxWorkspaceActive: true,
      sessionId: "workspace-session",
    },
  });

  try {
    const result = await releaseManualUnavailableAgentQueues({ now });

    assert.equal(result.ok, true);
    assert.equal(result.matchedAgents, 0);
    assert.equal(result.released, 0);
    assert.equal(stub.calls.listedQueueItems, 0);
    assert.equal(stub.calls.updatedAgentStates.length, 0);
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test("manual work pause immediate queue release keeps the pause untimed", async () => {
  const now = new Date("2026-07-08T20:00:00.000Z");
  const pauseStartedAt = new Date("2026-07-08T19:45:00.000Z");
  const stub = stubManualUnavailableRepositories({
    extensionId: "63914587004",
    name: "Sean Pilot",
    activityState: "unavailable",
    cxRouting: {
      enabled: true,
      desiredAvailability: "unavailable",
      reason: "manual-unavailable",
      lastSource: "cx-workspace",
      manualUnavailableAt: pauseStartedAt,
      pauseStartedAt,
      pauseReleaseAt: null,
      pauseType: "work-pause",
      assignmentStats: { openAssignments: 3 },
    },
  });

  try {
    const result = await releaseAssignedCxQueueForAgent({
      extensionId: "63914587004",
      now,
      reason: "manual-work-pause",
      actorEmail: "sean@example.test",
      pauseType: "work-pause",
    });

    assert.equal(result.ok, true);
    assert.equal(result.scanned, 0);
    assert.equal(result.released, 0);
    assert.equal(stub.calls.listedQueueItems, 1);
    assert.equal(stub.calls.updatedAgentStates.length, 1);

    const patch = stub.calls.updatedAgentStates[0].patch;
    assert.equal(patch.activityState, "unavailable");
    assert.equal(patch["cxRouting.desiredAvailability"], "unavailable");
    assert.equal(patch["cxRouting.reason"], "manual-unavailable");
    assert.equal(patch["cxRouting.pauseType"], "work-pause");
    assert.equal(patch["cxRouting.pauseReleaseAt"], null);
    assert.equal(patch["cxRouting.lastQueueReleaseAt"].toISOString(), now.toISOString());
    assert.equal(patch["upstream.source"], "manual-work-pause");
  } finally {
    stub.restore();
  }
});
