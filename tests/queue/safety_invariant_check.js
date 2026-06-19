// Safety check: does the code respect the invariant that
// "EX ringing alone does not block CX serving"
// regardless of RC_CX_EX_BUSY_GATE_ENABLED value?

const {
  deriveCxRouting,
} = require("../../packages/shared-services/src/agentAvailabilityService");

const testInput = {
  cxAgentId: "20563",
  status: "ringing",
  exTelephonyStatus: "Ringing",
  currentCall: {
    channel: "ex",
    direction: "Inbound",
    sessionId: "queue-ring",
  },
};

const routingInput = {
  enabled: true,
  desiredAvailability: "available",
  reason: "ex-idle",
  lastSource: "ringbridge",
};

// Test with RC_CX_EX_BUSY_GATE_ENABLED = "true"
process.env.RC_CX_EX_BUSY_GATE_ENABLED = "true";
const r1 = deriveCxRouting(testInput, routingInput);
console.log("With RC_CX_EX_BUSY_GATE_ENABLED=true:");
console.log("  desiredAvailability:", r1.desiredAvailability);
console.log("  reason:", r1.reason);

// Test with RC_CX_EX_BUSY_GATE_ENABLED = "false"
process.env.RC_CX_EX_BUSY_GATE_ENABLED = "false";
const r2 = deriveCxRouting(testInput, routingInput);
console.log("With RC_CX_EX_BUSY_GATE_ENABLED=false:");
console.log("  desiredAvailability:", r2.desiredAvailability);
console.log("  reason:", r2.reason);

// Test with RC_CX_EX_BUSY_GATE_ENABLED undefined
delete process.env.RC_CX_EX_BUSY_GATE_ENABLED;
const r3 = deriveCxRouting(testInput, routingInput);
console.log("With RC_CX_EX_BUSY_GATE_ENABLED=undefined:");
console.log("  desiredAvailability:", r3.desiredAvailability);
console.log("  reason:", r3.reason);

// Verify all are the same
if (r1.desiredAvailability === "available" && r1.reason === "ex-idle" &&
    r2.desiredAvailability === "available" && r2.reason === "ex-idle" &&
    r3.desiredAvailability === "available" && r3.reason === "ex-idle") {
  console.log("\n✓ INVARIANT HOLDS: EX ringing does not suppress CX serving regardless of env vars");
  process.exit(0);
} else {
  console.log("\n✗ INVARIANT VIOLATED!");
  process.exit(1);
}
