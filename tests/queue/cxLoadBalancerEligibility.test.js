"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CX_LEAD_SERVING_ALLOWED_AGENT_TOKENS = "agent 101,agent 102,101,102";
process.env.CX_LEAD_SERVING_EXCLUDED_AGENT_TOKENS = "";
process.env.RC_CX_REQUIRE_WORKSPACE_ACTIVE = "false";

const {
  buildEligibility,
  rankAgentsForQueueItem,
} = require("../../packages/shared-services/src/cxLoadBalancerService");

function agent(extensionId, overrides = {}) {
  const baseQueuePolicy = {
    fresh: {
      eligible: true,
      firstTouchEligible: true,
      targetOpen: 15,
      priorityWeight: 100,
    },
    day2to15: { targetOpen: 15 },
    day16to30: { targetOpen: 5 },
    aged: { targetOpen: 5 },
  };
  return {
    extensionId,
    name: `Agent ${extensionId}`,
    userAccount: {
      email: `agent${extensionId}@taxadvocategroup.com`,
      role: "agent",
      audience: "agent",
      status: "active",
      cxQueuePolicy: baseQueuePolicy,
    },
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

test("work-pause agent is invisible to regular cadence assignment", () => {
  const paused = agent("101", {
    activityState: "idle",
    cxRouting: {
      enabled: true,
      desiredAvailability: "unavailable",
      reason: "manual-unavailable",
      pauseType: "work-pause",
      assignmentStats: {
        date: "2026-07-08",
        totalAssigned: 0,
        freshDay1Assigned: 0,
        freshDay2to10Assigned: 0,
        agedAssigned: 0,
        openAssignments: 0,
      },
    },
  });
  const available = agent("102");

  const result = buildEligibility(paused, { queueFamily: "aged" });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "manual-unavailable");

  const ranking = rankAgentsForQueueItem([paused, available], { queueFamily: "aged" });
  assert.equal(ranking.selected.extensionId, "102");
  assert.equal(ranking.ranked[1].extensionId, "101");
  assert.equal(ranking.ranked[1].eligibility.reason, "manual-unavailable");
});

test("buildEligibility lets explicit fresh targets beat the global cap", () => {
  const result = buildEligibility(agent("101", {
    cxQueuePolicyExplicit: true,
    cxQueuePolicy: {
      tier: "fresh_priority",
      enabled: true,
      fresh: {
        eligible: true,
        targetOpen: 999,
        priorityWeight: 1000,
      },
      day2to15: { targetOpen: 0 },
      aged: { targetOpen: 0 },
    },
  }), {
    queueFamily: "fresh-day1",
    openAssignments: 500,
    maxOpenAssignments: 5,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "available");
  assert.equal(result.maxOpenAssignments, 999);
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
  const originals = {
    RC_CX_EX_BUSY_GATE_ENABLED: process.env.RC_CX_EX_BUSY_GATE_ENABLED,
    RC_CX_RUNTIME_MODE: process.env.RC_CX_RUNTIME_MODE,
    CX_RUNTIME_MODE: process.env.CX_RUNTIME_MODE,
    VITE_CX_WORKSPACE_MODE: process.env.VITE_CX_WORKSPACE_MODE,
    CX_DIAL_RUNTIME_DEFAULT: process.env.CX_DIAL_RUNTIME_DEFAULT,
    CX_DIAL_RUNTIME_BULK_LOAD_ENABLED: process.env.CX_DIAL_RUNTIME_BULK_LOAD_ENABLED,
    RC_CX_EX_ARTIFACT_MODE: process.env.RC_CX_EX_ARTIFACT_MODE,
  };
  process.env.RC_CX_EX_BUSY_GATE_ENABLED = "true";
  process.env.CX_DIAL_RUNTIME_BULK_LOAD_ENABLED = "false";
  delete process.env.RC_CX_RUNTIME_MODE;
  delete process.env.CX_RUNTIME_MODE;
  delete process.env.VITE_CX_WORKSPACE_MODE;
  delete process.env.CX_DIAL_RUNTIME_DEFAULT;
  delete process.env.RC_CX_EX_ARTIFACT_MODE;
  try {
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
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("buildEligibility ignores EX artifacts in CX-only runtime mode", () => {
  const originalGate = process.env.RC_CX_EX_BUSY_GATE_ENABLED;
  const originalMode = process.env.RC_CX_RUNTIME_MODE;
  process.env.RC_CX_EX_BUSY_GATE_ENABLED = "true";
  process.env.RC_CX_RUNTIME_MODE = "cx-only";
  try {
    const result = buildEligibility(agent("101", {
      status: "onCall",
      activityState: "onCall",
      exTelephonyStatus: "CallConnected",
      currentCall: {
        channel: "ex",
        direction: "Inbound",
        sessionId: "connected",
      },
      cxRouting: {
        enabled: true,
        desiredAvailability: "unavailable",
        reason: "ex-busy",
      },
    }));
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "available");
    assert.equal(result.exArtifactsSuppressed, true);
  } finally {
    if (originalGate == null) delete process.env.RC_CX_EX_BUSY_GATE_ENABLED;
    else process.env.RC_CX_EX_BUSY_GATE_ENABLED = originalGate;
    if (originalMode == null) delete process.env.RC_CX_RUNTIME_MODE;
    else process.env.RC_CX_RUNTIME_MODE = originalMode;
  }
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

test("rankAgentsForQueueItem no longer avoids an agent only because they touched the green lead today", () => {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(new Date());
  const ranking = rankAgentsForQueueItem([
    agent("101"),
    agent("102"),
  ], {
    queueFamily: "fresh-day1",
    caseId: 123,
    metadata: {
      dailyAgentTouchDateKey: today,
      dailyAgentTouchedExtensionIds: ["101"],
    },
  });

  assert.equal(ranking.selected.extensionId, "101");
});

test("rankAgentsForQueueItem treats unlimited low-priority green agents as overflow", () => {
  const regular = agent("101");
  const overflow = agent("102", {
    cxQueuePolicyExplicit: true,
    cxQueuePolicy: {
      tier: "fresh_priority",
      enabled: true,
      fresh: {
        eligible: true,
        targetOpen: 999,
        priorityWeight: 0,
      },
      day2to15: { targetOpen: 0 },
      aged: { targetOpen: 0 },
    },
  });
  const queueItem = { queueFamily: "fresh-day1", caseId: 123, placedCalls: 1 };

  const normalPass = rankAgentsForQueueItem([regular, overflow], queueItem, {
    openAssignmentMap: new Map([
      ["101", 0],
      ["102", 0],
    ]),
    maxOpenAssignments: 5,
    scopedOpenAssignmentMap: true,
  });
  assert.equal(normalPass.selected.extensionId, "101");

  const overflowPass = rankAgentsForQueueItem([regular, overflow], queueItem, {
    openAssignmentMap: new Map([
      ["101", 5],
      ["102", 0],
    ]),
    maxOpenAssignments: 5,
    scopedOpenAssignmentMap: true,
  });
  assert.equal(overflowPass.selected.extensionId, "102");
});
