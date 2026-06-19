const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveActivityState,
  deriveCxRouting,
  deriveFreshLeadGate,
} = require("../../packages/shared-services/src/agentAvailabilityService");

// SCENARIO: Environment variable pre-set to "true" before tests run
console.log("[SETUP] Initial RC_CX_EX_BUSY_GATE_ENABLED:", process.env.RC_CX_EX_BUSY_GATE_ENABLED);

test("manual CX unavailable survives connected EX calls", () => {
  const original = process.env.RC_CX_EX_BUSY_GATE_ENABLED;
  process.env.RC_CX_EX_BUSY_GATE_ENABLED = "true";
  console.log("[TEST 1] Set to: true, original was:", original);
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
    if (original == null) {
      console.log("[TEST 1 CLEANUP] Deleting RC_CX_EX_BUSY_GATE_ENABLED");
      delete process.env.RC_CX_EX_BUSY_GATE_ENABLED;
    } else {
      console.log("[TEST 1 CLEANUP] Restoring to:", original);
      process.env.RC_CX_EX_BUSY_GATE_ENABLED = original;
    }
  }
});

test("EX ringing alone does not suppress CX lead serving", () => {
  console.log("[TEST 2] RC_CX_EX_BUSY_GATE_ENABLED at start:", process.env.RC_CX_EX_BUSY_GATE_ENABLED);
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
