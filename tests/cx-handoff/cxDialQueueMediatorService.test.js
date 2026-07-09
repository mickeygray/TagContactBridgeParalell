"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  applyCxBucketActiveCallObservation,
  applyCxBucketTerminalOutcome,
  buildCxBucketReadRow,
  buildCxBucketLogPayload,
  hashPhone,
  normalizeCxBucketCandidate,
  normalizeCxCallBuckets,
  reconcileCxBucketCurrentCalls,
  upsertCxBucketCandidate,
} = require("../../packages/shared-services/src/cxDialQueueMediatorService");

function queueItem(overrides = {}) {
  return {
    _id: "queue-1",
    domain: "WYNN",
    caseId: 12345,
    phone: "(310) 666-5997",
    name: "Mickey Test",
    assignment: { extensionId: "101", agentName: "Agent One" },
    metadata: {
      actionKey: "cx-day0-1",
      lastDialExecutionUii: "uii-1",
      lastRingcxPublishedExternId: "parallel:WYNN:12345:queue-1",
      lastRingcxPublishedCampaignId: "campaign-1",
      lastRingcxPublishedDialGroupId: "dial-group-1",
    },
    ...overrides,
  };
}

test("normalizes candidates without keeping raw full phone in the candidate", () => {
  const candidate = normalizeCxBucketCandidate(queueItem());

  assert.equal(candidate.queueItemId, "queue-1");
  assert.equal(candidate.domain, "WYNN");
  assert.equal(candidate.caseId, 12345);
  assert.equal(candidate.phoneLast4, "5997");
  assert.equal(candidate.phoneHash, hashPhone("(310) 666-5997"));
  assert.equal(candidate.normalizedPhone, undefined);
  assert.equal(JSON.stringify(candidate).includes("3106665997"), false);
});

test("upserting candidates does not create currentCall and does not duplicate rows", () => {
  let bucket = normalizeCxCallBuckets(null, "101");
  const first = upsertCxBucketCandidate(bucket, queueItem(), { now: new Date("2026-06-19T12:00:00Z") });
  bucket = first.bucket;
  const second = upsertCxBucketCandidate(bucket, queueItem({ name: "Updated Name" }), {
    now: new Date("2026-06-19T12:00:01Z"),
  });

  assert.equal(second.bucket.newCalls.length, 1);
  assert.equal(second.bucket.newCalls[0].displayName, "Updated Name");
  assert.equal(second.bucket.currentCall, null);
});

test("captured UII observation promotes matching candidate to active", () => {
  let bucket = upsertCxBucketCandidate(normalizeCxCallBuckets(null, "101"), queueItem()).bucket;
  const observed = applyCxBucketActiveCallObservation(bucket, {
    agentExtensionId: "101",
    queueItem: queueItem(),
    activeCall: { uii: "uii-1", state: "connected" },
    matchResult: { queueItem: queueItem(), score: 100, reasons: ["uii"] },
  });

  assert.equal(observed.promoted, true);
  assert.equal(observed.bucket.currentCall.phase, "active");
  assert.equal(observed.bucket.currentCall.uii, "uii-1");
  assert.equal(observed.bucket.currentCall.matchedBy, "uii");
  assert.equal(observed.bucket.currentCall.telephonyActive, true);
});

test("owned active telephony without UII promotes to confirming", () => {
  const bucket = upsertCxBucketCandidate(normalizeCxCallBuckets(null, "101"), queueItem()).bucket;
  const observed = applyCxBucketActiveCallObservation(bucket, {
    agentExtensionId: "101",
    queueItem: queueItem(),
    activeCall: { state: "connected" },
    matchResult: { queueItem: queueItem(), score: 4, reasons: ["agentId"] },
  });

  assert.equal(observed.promoted, true);
  assert.equal(observed.bucket.currentCall.phase, "confirming");
  assert.equal(observed.bucket.currentCall.uii, null);
  assert.equal(observed.bucket.currentCall.telephonyActive, true);
});

test("ambiguous match does not promote currentCall", () => {
  const bucket = upsertCxBucketCandidate(normalizeCxCallBuckets(null, "101"), queueItem()).bucket;
  const observed = applyCxBucketActiveCallObservation(bucket, {
    agentExtensionId: "101",
    queueItem: queueItem(),
    activeCall: { state: "connected" },
    matchResult: { ambiguous: true, score: 10, reasons: ["phone"] },
  });

  assert.equal(observed.promoted, false);
  assert.equal(observed.rejected, true);
  assert.equal(observed.reason, "ambiguous");
  assert.equal(observed.bucket.currentCall, null);
});

test("phone-only weak match does not promote currentCall", () => {
  const bucket = upsertCxBucketCandidate(normalizeCxCallBuckets(null, "101"), queueItem()).bucket;
  const observed = applyCxBucketActiveCallObservation(bucket, {
    agentExtensionId: "101",
    queueItem: queueItem(),
    activeCall: { state: "connected", phone: "3106665997" },
    matchResult: { queueItem: queueItem(), score: 10, reasons: ["phone"] },
  });

  assert.equal(observed.promoted, false);
  assert.equal(observed.rejected, true);
  assert.equal(observed.reason, "phone-only");
  assert.equal(observed.bucket.currentCall, null);
});

test("terminal outcome buffers completion and clears matching currentCall", () => {
  const active = applyCxBucketActiveCallObservation(normalizeCxCallBuckets(null, "101"), {
    agentExtensionId: "101",
    queueItem: queueItem(),
    activeCall: { uii: "uii-1" },
    matchResult: { queueItem: queueItem(), score: 100, reasons: ["uii"] },
  }).bucket;
  const completed = applyCxBucketTerminalOutcome(active, {
    agentExtensionId: "101",
    queueItemId: "queue-1",
    uii: "uii-1",
    outcome: "did-not-answer",
  });

  assert.equal(completed.bucket.currentCall, null);
  assert.equal(completed.bucket.completionBuffer.length, 1);
  assert.equal(completed.bucket.completionBuffer[0].uiiFinalizationStatus, "captured");
  assert.equal(completed.bucket.completionBuffer[0].outcome, "did-not-answer");
});

test("terminal outcome without UII buffers pending finalization", () => {
  const confirming = applyCxBucketActiveCallObservation(normalizeCxCallBuckets(null, "101"), {
    agentExtensionId: "101",
    queueItem: queueItem(),
    activeCall: { state: "connected" },
    matchResult: { queueItem: queueItem(), score: 4, reasons: ["agentId"] },
  }).bucket;
  const completed = applyCxBucketTerminalOutcome(confirming, {
    agentExtensionId: "101",
    queueItemId: "queue-1",
    outcome: "answered",
  });

  assert.equal(completed.bucket.currentCall, null);
  assert.equal(completed.bucket.completionBuffer[0].uii, null);
  assert.equal(completed.bucket.completionBuffer[0].uiiFinalizationStatus, "pending");
});

test("trusted terminal drain buffers current call and clears it without explicit identity", () => {
  const active = applyCxBucketActiveCallObservation(normalizeCxCallBuckets(null, "101"), {
    agentExtensionId: "101",
    queueItem: queueItem(),
    activeCall: { uii: "uii-1" },
    matchResult: { queueItem: queueItem(), score: 100, reasons: ["uii"] },
  }).bucket;
  const completed = applyCxBucketTerminalOutcome(active, {
    agentExtensionId: "101",
    outcome: "cx-call-state-clear",
    drainCurrentCall: true,
  });

  assert.equal(completed.drainedCurrentCall, true);
  assert.equal(completed.drainReason, "trusted-terminal-drain");
  assert.equal(completed.bucket.currentCall, null);
  assert.equal(completed.bucket.completionBuffer[0].queueItemId, "queue-1");
  assert.equal(completed.bucket.completionBuffer[0].uii, "uii-1");
});

test("terminal outcome without identity does not clear current call unless trusted", () => {
  const active = applyCxBucketActiveCallObservation(normalizeCxCallBuckets(null, "101"), {
    agentExtensionId: "101",
    queueItem: queueItem(),
    activeCall: { uii: "uii-1" },
    matchResult: { queueItem: queueItem(), score: 100, reasons: ["uii"] },
  }).bucket;
  const completed = applyCxBucketTerminalOutcome(active, {
    agentExtensionId: "101",
    outcome: "late-or-untrusted-completion",
  });

  assert.equal(completed.drainedCurrentCall, false);
  assert.equal(completed.bucket.currentCall.uii, "uii-1");
  assert.equal(completed.bucket.completionBuffer.length, 1);
});

test("bucket log payload exposes identity state without raw phone", () => {
  const active = applyCxBucketActiveCallObservation(normalizeCxCallBuckets(null, "101"), {
    agentExtensionId: "101",
    queueItem: queueItem(),
    activeCall: { uii: "uii-1" },
    matchResult: { queueItem: queueItem(), score: 100, reasons: ["uii"] },
  }).bucket;
  const payload = buildCxBucketLogPayload(active, "cx.bucket.active_match", { reason: "test" });

  assert.equal(payload.bucketPhase, "active");
  assert.equal(payload.bucketUii, "uii-1");
  assert.equal(payload.matchedBy, "uii");
  assert.equal(JSON.stringify(payload).includes("3106665997"), false);
});

test("live read classifies stale bucket current after legacy moved idle", () => {
  const now = new Date("2026-06-19T12:01:00Z");
  const row = buildCxBucketReadRow({
    extensionId: "101",
    name: "Agent One",
    company: "WYNN",
    activityState: "idle",
    activePlatform: "none",
    currentCall: {},
    cxCall: {
      phase: "dispositioning",
      uii: "uii-1",
      queueItemId: "queue-1",
      lastObservedAt: "2026-06-19T12:00:00Z",
    },
    cxCallBuckets: {
      agentExtensionId: "101",
      currentCall: {
        ...normalizeCxBucketCandidate(queueItem()),
        phase: "active",
        telephonyActive: true,
        uii: "uii-1",
        activeObservedAt: "2026-06-19T12:00:00Z",
        matchedBy: "uii",
        confidence: "high",
        outcome: null,
      },
      newCalls: [],
      completionBuffer: [],
      stats: {},
      updatedAt: "2026-06-19T12:00:00Z",
    },
  }, { now, staleCurrentMs: 15_000 });

  assert.equal(row.verdict.bucket, "stale-terminal-bridge");
  assert.equal(row.comparisons.staleBucketCurrent, true);
  assert.equal(row.verdict.nextLook, "terminal-or-orphan-clear-helper");
});

test("live read classifies legacy active with queued candidates as missing active match", () => {
  const now = new Date("2026-06-19T12:01:00Z");
  const row = buildCxBucketReadRow({
    extensionId: "101",
    name: "Agent One",
    company: "WYNN",
    activityState: "onCall",
    activePlatform: "CX",
    currentCall: {
      queueItemId: "queue-1",
      caseId: 12345,
      uii: "uii-1",
      startTime: "2026-06-19T12:00:50Z",
    },
    cxCallBuckets: {
      agentExtensionId: "101",
      currentCall: null,
      newCalls: [normalizeCxBucketCandidate(queueItem())],
      completionBuffer: [],
      stats: {},
      updatedAt: "2026-06-19T12:00:55Z",
    },
  }, { now, staleCurrentMs: 15_000 });

  assert.equal(row.verdict.bucket, "missing-active-match");
  assert.equal(row.comparisons.missingActiveMatch, true);
  assert.equal(row.verdict.nextLook, "active-call-matcher-inputs");
});

test("stale bucket reconciler skips when the active-call snapshot is unknown", async () => {
  const previous = process.env.CX_BUCKET_SHADOW_ENABLED;
  process.env.CX_BUCKET_SHADOW_ENABLED = "true";
  const writes = [];
  const repository = {
    async listAgentStates() { throw new Error("should not read agents without active-call evidence"); },
    async updateAgentState(...args) { writes.push(args); },
  };
  try {
    const result = await reconcileCxBucketCurrentCalls({
      now: new Date("2026-06-19T12:01:00Z"),
      repository,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "active-identities-unknown");
    assert.equal(writes.length, 0);
  } finally {
    if (previous === undefined) delete process.env.CX_BUCKET_SHADOW_ENABLED;
    else process.env.CX_BUCKET_SHADOW_ENABLED = previous;
  }
});

test("stale bucket reconciler clears only after an explicit active-call snapshot", async () => {
  const previous = process.env.CX_BUCKET_SHADOW_ENABLED;
  process.env.CX_BUCKET_SHADOW_ENABLED = "true";
  const agent = {
    extensionId: "101",
    activityState: "idle",
    activePlatform: "none",
    currentCall: {},
    cxCallBuckets: {
      agentExtensionId: "101",
      currentCall: {
        ...normalizeCxBucketCandidate(queueItem()),
        phase: "active",
        telephonyActive: true,
        uii: "uii-1",
        activeObservedAt: "2026-06-19T12:00:00Z",
      },
      newCalls: [],
      completionBuffer: [],
      stats: {},
      updatedAt: "2026-06-19T12:00:00Z",
    },
  };
  const writes = [];
  const repository = {
    async listAgentStates() { return [agent]; },
    async findAgentStateByExtensionId() { return agent; },
    async updateAgentState(extensionId, patch) {
      writes.push({ extensionId, patch });
      return { ...agent, ...patch };
    },
  };
  try {
    const result = await reconcileCxBucketCurrentCalls({
      activeIdentities: new Set(),
      activeIdentitiesKnown: true,
      now: new Date("2026-06-19T12:01:00Z"),
      repository,
    });
    assert.equal(result.reconciledCount, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].patch.cxCallBuckets.currentCall, null);
    assert.equal(writes[0].patch.cxCallBuckets.stats.staleCurrentClears, 1);
  } finally {
    if (previous === undefined) delete process.env.CX_BUCKET_SHADOW_ENABLED;
    else process.env.CX_BUCKET_SHADOW_ENABLED = previous;
  }
});
