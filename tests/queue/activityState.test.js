"use strict";

// Pure-function tests for deriveActivityState.
// Run via: node --test tests/queue/activityState.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveActivityState,
  deriveCxRouting,
  deriveFreshLeadGate,
} = require("../../packages/shared-services/src/agentAvailabilityService");

test("status=available -> idle", () => {
  assert.equal(deriveActivityState({ status: "available" }), "idle");
});

test("status=onCall -> onCall", () => {
  assert.equal(deriveActivityState({ status: "onCall" }), "onCall");
});

test("status=ringing + outbound call -> dialing", () => {
  assert.equal(
    deriveActivityState({
      status: "ringing",
      currentCall: { channel: "ex", direction: "Outbound", sessionId: "s1" },
    }),
    "dialing",
  );
});

test("status=ringing + inbound/broadcast call stays idle for CX serving", () => {
  assert.equal(
    deriveActivityState({
      status: "ringing",
      currentCall: { channel: "ex", direction: "Inbound", sessionId: "s1" },
    }),
    "idle",
  );
});

test("status=disposition -> dispositioning", () => {
  assert.equal(deriveActivityState({ status: "disposition" }), "dispositioning");
});

test("status=away -> unavailable", () => {
  assert.equal(deriveActivityState({ status: "away" }), "unavailable");
});

test("status=offline -> offline", () => {
  assert.equal(deriveActivityState({ status: "offline" }), "offline");
});

test("missing status -> offline", () => {
  assert.equal(deriveActivityState({}), "offline");
});

test("explicit unavailable existing state wins over snapshot", () => {
  // Even if RC says agent is "available", if they've explicitly toggled
  // unavailable in the SPA, the toggle wins.
  const r = deriveActivityState({ status: "available" }, "unavailable");
  assert.equal(r, "unavailable");
});

test("non-unavailable existing state does NOT override snapshot", () => {
  const r = deriveActivityState({ status: "onCall" }, "idle");
  assert.equal(r, "onCall");
});

test("manual CX unavailable survives an EX idle snapshot", () => {
  const r = deriveCxRouting(
    {
      cxAgentId: "20563",
      status: "available",
      exTelephonyStatus: "NoCall",
      currentCall: {},
    },
    {
      enabled: true,
      desiredAvailability: "unavailable",
      reason: "manual-unavailable",
      lastSource: "cx-workspace",
      assignmentStats: { openAssignments: 7 },
    },
  );

  assert.equal(r.desiredAvailability, "unavailable");
  assert.equal(r.reason, "manual-unavailable");
  assert.equal(r.lastSource, "cx-workspace");
  assert.equal(r.assignmentStats.openAssignments, 7);
});

test("agent-toggle manual unavailable survives legacy rows", () => {
  const r = deriveCxRouting(
    {
      cxAgentId: "20563",
      status: "available",
      exTelephonyStatus: "NoCall",
      currentCall: {},
    },
    {
      enabled: true,
      desiredAvailability: "unavailable",
      reason: "manual-unavailable",
      lastSource: "agent-toggle",
    },
  );

  assert.equal(r.desiredAvailability, "unavailable");
  assert.equal(r.reason, "manual-unavailable");
});

test("manual CX unavailable survives connected EX calls", () => {
  const original = process.env.RC_CX_EX_BUSY_GATE_ENABLED;
  process.env.RC_CX_EX_BUSY_GATE_ENABLED = "true";
  try {
    const r = deriveCxRouting(
      {
        cxAgentId: "20563",
        status: "onCall",
        exTelephonyStatus: "CallConnected",
        currentCall: { channel: "ex", sessionId: "abc" },
      },
      {
        enabled: true,
        desiredAvailability: "unavailable",
        reason: "manual-unavailable",
        lastSource: "cx-workspace",
      },
    );

    assert.equal(r.desiredAvailability, "unavailable");
    assert.equal(r.reason, "manual-unavailable");
  } finally {
    if (original == null) delete process.env.RC_CX_EX_BUSY_GATE_ENABLED;
    else process.env.RC_CX_EX_BUSY_GATE_ENABLED = original;
  }
});

test("EX ringing alone does not suppress CX lead serving", () => {
  const r = deriveCxRouting(
    {
      cxAgentId: "20563",
      status: "ringing",
      exTelephonyStatus: "Ringing",
      currentCall: {
        channel: "ex",
        direction: "Inbound",
        sessionId: "queue-ring",
      },
    },
    {
      enabled: true,
      desiredAvailability: "available",
      reason: "ex-idle",
      lastSource: "ringbridge",
    },
  );

  assert.equal(r.desiredAvailability, "available");
  assert.equal(r.reason, "ex-idle");
});

test("CX-only runtime mode ignores EX busy when deriving CX routing", () => {
  const originalGate = process.env.RC_CX_EX_BUSY_GATE_ENABLED;
  const originalMode = process.env.RC_CX_RUNTIME_MODE;
  process.env.RC_CX_EX_BUSY_GATE_ENABLED = "true";
  process.env.RC_CX_RUNTIME_MODE = "cx-only";
  try {
    const r = deriveCxRouting(
      {
        cxAgentId: "20563",
        status: "onCall",
        exTelephonyStatus: "CallConnected",
        currentCall: { channel: "ex", sessionId: "abc" },
      },
      {
        enabled: true,
        desiredAvailability: "unavailable",
        reason: "ex-busy",
        lastSource: "ringbridge",
      },
    );

    assert.equal(r.desiredAvailability, "available");
    assert.equal(r.reason, "ex-idle");
  } finally {
    if (originalGate == null) delete process.env.RC_CX_EX_BUSY_GATE_ENABLED;
    else process.env.RC_CX_EX_BUSY_GATE_ENABLED = originalGate;
    if (originalMode == null) delete process.env.RC_CX_RUNTIME_MODE;
    else process.env.RC_CX_RUNTIME_MODE = originalMode;
  }
});

test("CX-only runtime mode treats stale ex-busy routing as allowed in the fresh lead gate", () => {
  const originalGate = process.env.RC_CX_EX_BUSY_GATE_ENABLED;
  const originalMode = process.env.RC_CX_RUNTIME_MODE;
  const originalWorkspace = process.env.RC_CX_REQUIRE_WORKSPACE_ACTIVE;
  process.env.RC_CX_EX_BUSY_GATE_ENABLED = "true";
  process.env.RC_CX_RUNTIME_MODE = "cx-only";
  process.env.RC_CX_REQUIRE_WORKSPACE_ACTIVE = "false";
  try {
    const gate = deriveFreshLeadGate({
      status: "onCall",
      exTelephonyStatus: "CallConnected",
      currentCall: { channel: "ex", sessionId: "abc" },
      cxRouting: {
        enabled: true,
        desiredAvailability: "unavailable",
        reason: "ex-busy",
      },
    });

    assert.equal(gate.allowed, true);
    assert.equal(gate.exCallActive, false);
    assert.equal(gate.exArtifactsSuppressed, true);
    assert.equal(gate.source, "none");
  } finally {
    if (originalGate == null) delete process.env.RC_CX_EX_BUSY_GATE_ENABLED;
    else process.env.RC_CX_EX_BUSY_GATE_ENABLED = originalGate;
    if (originalMode == null) delete process.env.RC_CX_RUNTIME_MODE;
    else process.env.RC_CX_RUNTIME_MODE = originalMode;
    if (originalWorkspace == null) delete process.env.RC_CX_REQUIRE_WORKSPACE_ACTIVE;
    else process.env.RC_CX_REQUIRE_WORKSPACE_ACTIVE = originalWorkspace;
  }
});
