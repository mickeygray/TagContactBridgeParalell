"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCanonicalNoUiiExpiry,
  buildCxCallTransitionLogPayload,
  buildCxCallLifecyclePatch,
  describeCxCallGate,
  isExpiredNoUiiCxCallShell,
  normalizeCxCallUii,
} = require("../../packages/shared-services/src/cxCallLifecycleService");

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("buildCxCallLifecyclePatch is inert until canonical write flag is enabled", () => {
  withEnv({ CX_CANONICAL_CALL_WRITE_ENABLED: "false" }, () => {
    assert.equal(buildCxCallLifecyclePatch({ phase: "active", caseId: 123 }), null);
  });
});

test("buildCxCallLifecyclePatch normalizes identity fields without inventing caseId 0", () => {
  withEnv({ CX_CANONICAL_CALL_WRITE_ENABLED: "true" }, () => {
    const observedAt = new Date("2026-06-18T12:00:00.000Z");
    const patch = buildCxCallLifecyclePatch({
      writer: "test-writer",
      queueItemId: " q-1 ",
      caseId: "",
      phone: "+1 (310) 666-5997",
      uii: " uii-1 ",
      phase: " Active ",
      transitionId: "transition-1",
      lastObservedAt: observedAt,
    });

    assert.equal(patch.phase, "active");
    assert.equal(patch.queueItemId, "q-1");
    assert.equal(patch.caseId, null);
    assert.equal(patch.phone, "3106665997");
    assert.equal(patch.uii, "uii-1");
    assert.equal(patch.transitionId, "transition-1");
    assert.equal(patch.lastWriter, "test-writer");
    assert.equal(patch.lastObservedAt.toISOString(), observedAt.toISOString());
  });
});

test("buildCxCallLifecyclePatch preserves numeric case ids", () => {
  withEnv({ CX_CANONICAL_CALL_WRITE_ENABLED: "true" }, () => {
    const patch = buildCxCallLifecyclePatch({
      phase: "active",
      caseId: "128210",
    });
    assert.equal(patch.caseId, 128210);
  });
});

test("normalizeCxCallUii treats blank and sentinel values as absent", () => {
  assert.equal(normalizeCxCallUii(" uii-a "), "uii-a");
  assert.equal(normalizeCxCallUii("   "), null);
  assert.equal(normalizeCxCallUii("unknown"), null);
  assert.equal(normalizeCxCallUii("NULL"), null);
  assert.equal(normalizeCxCallUii("[object Object]"), null);
});

test("describeCxCallGate blocks different queue item during active phases only", () => {
  const cxCall = {
    phase: "active",
    queueItemId: "queue-a",
    caseId: 128210,
    uii: "uii-a",
    transitionId: "t-a",
  };

  assert.deepEqual(
    {
      decision: describeCxCallGate(cxCall, "queue-b").decision,
      reason: describeCxCallGate(cxCall, "queue-b").reason,
    },
    {
      decision: "block",
      reason: "active-cx-call-in-canonical-state",
    },
  );
  assert.equal(describeCxCallGate(cxCall, "queue-a").decision, "allow");
  assert.equal(describeCxCallGate({ ...cxCall, phase: "released" }, "queue-b").decision, "allow");
});

test("describeCxCallGate blocks when blocking phase has no queue item id", () => {
  const cxCall = {
    phase: "active",
    uii: null,
    expiresAt: new Date("2026-06-18T12:00:01.000Z"),
  };

  const gate = describeCxCallGate(cxCall, "queue-a", {
    now: new Date("2026-06-18T12:00:00.000Z"),
  });

  assert.equal(gate.decision, "block");
  assert.equal(gate.queueItemId, null);
});

test("buildCanonicalNoUiiExpiry uses the configured shell ttl", () => {
  withEnv({ CX_CANONICAL_NO_UII_SHELL_TTL_MS: "1500" }, () => {
    const base = new Date("2026-06-18T12:00:00.000Z");
    assert.equal(buildCanonicalNoUiiExpiry(base).toISOString(), "2026-06-18T12:00:01.500Z");
  });
});

test("buildCxCallLifecyclePatch gives no-UII blocking shells an expiry", () => {
  withEnv({
    CX_CANONICAL_CALL_WRITE_ENABLED: "true",
    CX_CANONICAL_NO_UII_SHELL_TTL_MS: "2500",
  }, () => {
    const observedAt = new Date("2026-06-18T12:00:00.000Z");
    const patch = buildCxCallLifecyclePatch({
      phase: "publishing",
      queueItemId: "queue-a",
      lastObservedAt: observedAt,
    });

    assert.equal(patch.uii, null);
    assert.equal(patch.expiresAt.toISOString(), "2026-06-18T12:00:02.500Z");
  });
});

test("describeCxCallGate allows expired no-UII shells", () => {
  const cxCall = {
    phase: "publishing",
    queueItemId: "queue-a",
    expiresAt: "2026-06-18T12:00:00.000Z",
  };

  const gate = describeCxCallGate(cxCall, "queue-b", {
    now: new Date("2026-06-18T12:00:01.000Z"),
  });

  assert.equal(gate.decision, "allow");
  assert.equal(gate.expiredShell, true);
});

test("describeCxCallGate still blocks unexpired no-UII shells for a different queue item", () => {
  const cxCall = {
    phase: "publishing",
    queueItemId: "queue-a",
    expiresAt: "2026-06-18T12:00:02.000Z",
  };

  const gate = describeCxCallGate(cxCall, "queue-b", {
    now: new Date("2026-06-18T12:00:01.000Z"),
  });

  assert.equal(gate.decision, "block");
  assert.equal(gate.expiredShell, false);
});

test("isExpiredNoUiiCxCallShell only expires no-UII blocking phases", () => {
  const now = new Date("2026-06-18T12:00:01.000Z");
  assert.equal(
    isExpiredNoUiiCxCallShell({
      phase: "active",
      uii: " unknown ",
      expiresAt: "2026-06-18T12:00:00.000Z",
    }, now),
    true,
  );
  assert.equal(
    isExpiredNoUiiCxCallShell({
      phase: "active",
      uii: "uii-a",
      expiresAt: "2026-06-18T12:00:00.000Z",
    }, now),
    false,
  );
  assert.equal(
    isExpiredNoUiiCxCallShell({
      phase: "released",
      expiresAt: "2026-06-18T12:00:00.000Z",
    }, now),
    false,
  );
});

test("buildCxCallTransitionLogPayload captures old and new compact state", () => {
  const payload = buildCxCallTransitionLogPayload({
    agentExtensionId: "101",
    previousCxCall: { phase: "publishing", uii: null, queueItemId: "old-q", transitionId: "old-t" },
    nextCxCall: { phase: "active", uii: "uii-a", queueItemId: "new-q", transitionId: "new-t" },
    writer: "test-writer",
    reason: "confirmed",
    event: "publish-confirmed",
  });

  assert.equal(payload.agentExtensionId, "101");
  assert.equal(payload.oldPhase, "publishing");
  assert.equal(payload.newPhase, "active");
  assert.equal(payload.oldQueueItemId, "old-q");
  assert.equal(payload.newQueueItemId, "new-q");
  assert.equal(payload.reason, "confirmed");
  assert.equal(payload.event, "publish-confirmed");
});
