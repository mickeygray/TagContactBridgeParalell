"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildEligibility,
  rankAgentsForQueueItem,
} = require("../../packages/shared-services/src/cxLoadBalancerService");

process.env.CX_LEAD_SERVING_ALLOWED_AGENT_TOKENS = "";
process.env.CX_LEAD_SERVING_EXCLUDED_AGENT_TOKENS = "";

function agent(extensionId, overrides = {}) {
  return {
    extensionId,
    name: `Agent ${extensionId}`,
    status: "available",
    activityState: "idle",
    cxRouting: {
      enabled: true,
      desiredAvailability: "available",
      reason: "ex-idle",
      assignmentStats: {
        date: "2026-05-06",
        totalAssigned: 0,
        freshDay1Assigned: 0,
        freshDay2to10Assigned: 0,
        agedAssigned: 0,
        openAssignments: 0,
        lastAssignedAt: null,
        lastAssignedQueueFamily: null,
      },
    },
    ...overrides,
  };
}

test("buildEligibility blocks agents already busy in app-side CX state", () => {
  for (const activityState of ["dialing", "onCall", "dispositioning", "wrapup", "unavailable", "offline"]) {
    const result = buildEligibility(agent("101", { activityState }));
    assert.equal(result.eligible, false);
    assert.equal(result.reason, `activity-${activityState}`);
  }
});

test("buildEligibility treats idle available agents as eligible", () => {
  const result = buildEligibility(agent("101"));
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "available");
});

test("buildEligibility does not block inbound EX ringing broadcasts", () => {
  const result = buildEligibility(agent("101", {
    status: "ringing",
    activityState: "",
    exTelephonyStatus: "Ringing",
    currentCall: {
      channel: "ex",
      direction: "Inbound",
      sessionId: "broadcast-ring",
    },
  }));
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "available");
});

test("buildEligibility blocks connected EX calls", () => {
  const result = buildEligibility(agent("101", {
    status: "onCall",
    activityState: "onCall",
    exTelephonyStatus: "CallConnected",
    currentCall: {
      channel: "ex",
      direction: "Inbound",
      sessionId: "connected",
    },
  }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "ex-busy");
});

test("rankAgentsForQueueItem skips a busy agent even when their assignment counts are lower", () => {
  const busy = agent("101", {
    activityState: "dialing",
    cxRouting: {
      enabled: true,
      desiredAvailability: "available",
      assignmentStats: {
        date: "2026-05-06",
        totalAssigned: 0,
        freshDay1Assigned: 0,
        freshDay2to10Assigned: 0,
        agedAssigned: 0,
        openAssignments: 0,
      },
    },
  });
  const idle = agent("102", {
    cxRouting: {
      enabled: true,
      desiredAvailability: "available",
      assignmentStats: {
        date: "2026-05-06",
        totalAssigned: 10,
        freshDay1Assigned: 10,
        freshDay2to10Assigned: 0,
        agedAssigned: 0,
        openAssignments: 0,
      },
    },
  });

  const ranking = rankAgentsForQueueItem([busy, idle], {
    queueFamily: "fresh-day1",
  });

  assert.equal(ranking.selected.extensionId, "102");
  assert.equal(ranking.ranked[0].extensionId, "102");
  assert.equal(ranking.ranked[1].eligibility.reason, "activity-dialing");
});
