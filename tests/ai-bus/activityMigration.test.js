"use strict";

// The first real tool migration: activity.contactSafetyReview round-tripping
// 5001 -> 7000 -> 5001 through the bus. Proves the wiring (over real HTTP against
// the synthetic bus), prompt parity, fail-closed fallback, and default-off safety.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  reviewCaseActivities,
  buildUserPrompt,
} = require("../../packages/shared-services/src/activityAiReviewService");
const { createAiTaskClient } = require("../../packages/shared-services/src/aiTaskClient");
const { startLocalBus } = require("../../apps/ai-bus/src/localBusServer");
const sandbox = require("../../packages/shared-services/src/aiSandbox");

const SAMPLE = [
  { ActivityType: "Note", Subject: "Attorney letter", Comment: "cease and desist — represented by counsel", CreatedDate: "2026-06-01" },
  { ActivityType: "Call", Subject: "Left VM", Comment: "no answer", ModifiedDate: "2026-06-03" },
];

function fakeRepos(writes) {
  return {
    activityAiReviewRepository: {
      createActivityAiReview: async (r) => {
        writes.reviews.push(r);
        return { _id: "rev1", reviewedAt: r.reviewedAt };
      },
    },
    caseProfileRepository: {
      upsertCaseProfile: async (domain, caseId, patch) => writes.profiles.push({ domain, caseId, patch }),
    },
  };
}

// ── prompt parity: the bus's user prompt == legacy buildUserPrompt (byte-exact) ─
test("bus and legacy build the IDENTICAL activity-review user prompt", () => {
  const legacy = buildUserPrompt("TAG", 42, SAMPLE);
  const bus = sandbox.prompts.buildActivityReviewUser({
    domain: "TAG",
    caseId: 42,
    activitiesText: sandbox.rules.formatActivities(SAMPLE),
  });
  assert.equal(bus, legacy, "prompt drift between bus and legacy would break the parity smoke");
});

// ── THE ROUND TRIP: 5001 service -> HTTP -> 7000 bus -> envelope -> 5001 ────────
test("activity review round-trips 5001 -> 7000 -> 5001 through the bus", async () => {
  const server = startLocalBus({ port: 0 });
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  const port = server.address().port;
  const client = createAiTaskClient({ baseUrl: `http://127.0.0.1:${port}`, secret: "" });
  const writes = { reviews: [], profiles: [] };
  const deps = {
    activityBusEnabled: () => true,
    aiTaskClient: client,
    facade: { fetchActivities: async () => SAMPLE },
    repositories: fakeRepos(writes),
  };
  try {
    const out = await reviewCaseActivities("TAG", 42, {}, deps);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.via, "bus", "must have gone through the bus, not legacy");
    assert.ok(["allow_contact", "pause_contact", "stop_contact", "manual_review"].includes(out.review.status));
    assert.ok(["low", "medium", "high"].includes(out.review.confidence));
    assert.equal(writes.reviews.length, 1, "persisted the review");
    assert.equal(writes.profiles.length, 1, "upserted the case profile");
    assert.match(writes.reviews[0].model, /synthetic/, "model came from the synthetic bus");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── fail-closed: bus enabled but unreachable -> legacy direct, never throws ────
test("bus enabled but unreachable falls back to legacy (batch never breaks)", async () => {
  const client = createAiTaskClient({ baseUrl: "http://127.0.0.1:1", secret: "" }); // nothing listening
  const writes = { reviews: [], profiles: [] };
  const deps = {
    activityBusEnabled: () => true,
    aiTaskClient: client,
    facade: { fetchActivities: async () => [{ Comment: "hostile" }] },
    repositories: fakeRepos(writes),
    createAnthropicClient: () => ({
      config: { model: "claude-x" },
      createMessage: async () => ({ model: "claude-x", content: [{ type: "text", text: '{"status":"manual_review","confidence":"low"}' }] }),
      extractTextBlocks: (r) => r.content.map((b) => b.text).join(""),
    }),
  };
  const out = await reviewCaseActivities("TAG", 1, {}, deps);
  assert.equal(out.ok, true);
  assert.equal(out.via, "legacy", "unreachable bus must fall back to legacy");
  assert.equal(out.review.status, "manual_review");
});

// ── default off: flag unset -> legacy, the bus is never touched ────────────────
test("default-off keeps the legacy path and never calls the bus", async () => {
  let busTouched = false;
  const deps = {
    activityBusEnabled: () => false,
    aiTaskClient: { runAiTask: async () => ((busTouched = true), { ok: true, result: {} }) },
    facade: { fetchActivities: async () => [{ Comment: "x" }] },
    repositories: fakeRepos({ reviews: [], profiles: [] }),
    createAnthropicClient: () => ({
      config: { model: "c" },
      createMessage: async () => ({ model: "c", content: [{ type: "text", text: '{"status":"allow_contact","confidence":"high"}' }] }),
      extractTextBlocks: (r) => r.content.map((b) => b.text).join(""),
    }),
  };
  const out = await reviewCaseActivities("TAG", 1, {}, deps);
  assert.equal(out.via, "legacy");
  assert.equal(busTouched, false, "flag off must not touch the bus");
});
