"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildLiveCoachGuidanceDispatchPlan,
} = require("../../packages/shared-services/src/liveCoachBatchGuidanceDispatchService");

function conversation(overrides = {}) {
  return {
    sessionId: "coach-1",
    agent: {
      email: "agent@example.com",
      name: "Agent One",
      extension: "101",
    },
    call: {
      uii: "uii-1",
      callSessionId: "call-1",
      queueItemId: "queue-1",
    },
    ...overrides,
  };
}

function batch(conversations = [conversation()]) {
  return {
    schemaVersion: "live-coach.active-conversation-batch.v1",
    generatedAt: "2026-06-26T12:00:00.000Z",
    conversations,
  };
}

test("dispatch plan routes a model return by exact session id", () => {
  const plan = buildLiveCoachGuidanceDispatchPlan(batch(), {
    generatedAt: "2026-06-26T12:01:00.000Z",
    guidance: [
      {
        sessionId: "coach-1",
        uii: "uii-1",
        agentEmail: "agent@example.com",
        mode: "reaction",
        read: "price objection",
        steer: "reframe value",
        try: "Let's look at what waiting costs.",
      },
    ],
  });

  assert.equal(plan.dispatchCount, 1);
  assert.equal(plan.rejectedCount, 0);
  assert.equal(plan.dispatches[0].target.sessionId, "coach-1");
  assert.equal(plan.dispatches[0].payload.schemaVersion, "live-coach.agent-guidance-delta.v1");
  assert.equal(plan.dispatches[0].payload.mode, "reaction");
});

test("dispatch plan can route by unique uii plus agent email when session id is absent", () => {
  const plan = buildLiveCoachGuidanceDispatchPlan(batch(), {
    guidance: [
      {
        uii: "uii-1",
        agentEmail: "agent@example.com",
        mode: "guidepost",
        steer: "finish discovery",
      },
    ],
  });

  assert.equal(plan.dispatchCount, 1);
  assert.equal(plan.dispatches[0].target.agentEmail, "agent@example.com");
});

test("dispatch plan rejects stale uii for a known session", () => {
  const plan = buildLiveCoachGuidanceDispatchPlan(batch(), {
    guidance: [
      {
        sessionId: "coach-1",
        uii: "old-uii",
        mode: "reaction",
        steer: "do not show this",
      },
    ],
  });

  assert.equal(plan.dispatchCount, 0);
  assert.equal(plan.rejectedCount, 1);
  assert.equal(plan.rejected[0].reason, "uii-mismatch");
});

test("dispatch plan rejects wrong-agent returns for a known session", () => {
  const plan = buildLiveCoachGuidanceDispatchPlan(batch(), {
    guidance: [
      {
        sessionId: "coach-1",
        agentEmail: "other@example.com",
        mode: "reaction",
        steer: "do not show this",
      },
    ],
  });

  assert.equal(plan.dispatchCount, 0);
  assert.equal(plan.rejected[0].reason, "agent-mismatch");
});

test("dispatch plan rejects ambiguous uii-only routing", () => {
  const plan = buildLiveCoachGuidanceDispatchPlan(batch([
    conversation({ sessionId: "coach-1", agent: { email: "a@example.com" } }),
    conversation({ sessionId: "coach-2", agent: { email: "b@example.com" } }),
  ]), {
    guidance: [
      {
        uii: "uii-1",
        mode: "reaction",
        steer: "ambiguous without agent",
      },
    ],
  });

  assert.equal(plan.dispatchCount, 0);
  assert.equal(plan.rejected[0].reason, "ambiguous-uii-match");
});

test("dispatch plan rejects empty model rows", () => {
  const plan = buildLiveCoachGuidanceDispatchPlan(batch(), {
    guidance: [
      {
        sessionId: "coach-1",
        mode: "reaction",
      },
    ],
  });

  assert.equal(plan.dispatchCount, 0);
  assert.equal(plan.rejected[0].reason, "empty-guidance");
});
