"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCxBoringWebhookRuntime } = require("../../packages/shared-services/src/cxBoringWebhookRuntime");

test("webhook runtime projects call memory without app outcome controls", async () => {
  const runtime = createCxBoringWebhookRuntime({
    repository: {
      async getCurrentForAgent(email) {
        assert.equal(email, "agent@example.com");
        return {
          uii: "u1",
          externId: "cx-direct-wynn-99",
          domain: "WYNN",
          caseId: 99,
          name: "Test Lead",
          status: "active",
          leadState: "ACTIVE",
          observedAt: new Date("2026-07-10T17:00:00.000Z"),
        };
      },
      async countCompletedForAgentToday() { return 4; },
    },
  });
  const session = await runtime.getSession({}, { user: { email: "agent@example.com" } });
  assert.equal(session.runtime, "boring_webhook");
  assert.equal(session.current.uii, "u1");
  assert.equal(session.completedCount, 4);
  assert.deepEqual(session.controls, {
    outcomes: false,
    queue: false,
    appointmentFallback: true,
  });
});

test("get-leads is a no-op because the direct RingCX feeder owns supply", async () => {
  const runtime = createCxBoringWebhookRuntime({
    repository: {
      async getCurrentForAgent() { return null; },
      async countCompletedForAgentToday() { return 0; },
    },
  });
  const session = await runtime.getLeads({}, { user: { email: "agent@example.com" } });
  assert.equal(session.phase, "idle");
  assert.equal(session.refillResult.reason, "direct-ringcx-feeder-owned");
});
