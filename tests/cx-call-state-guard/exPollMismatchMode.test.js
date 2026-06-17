"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  detectPollMismatch,
  normalizePresencePollMode,
  reconcilePolledPresence,
} = require("../../packages/shared-services/src/ringcentralExService");
const {
  normalizeCxRuntimeMode,
} = require("../../packages/shared-services/src/cxRuntimeModeService");

const UII = "202606151320473610000136381455";

function cxAgent() {
  return {
    status: "onCall",
    activePlatform: "CX",
    currentCall: {
      channel: "cx",
      sessionId: UII,
      telephonySessionId: UII,
    },
  };
}

function exPresenceWithDifferentSession() {
  return {
    telephonyStatus: "CallConnected",
    activeCalls: [{ sessionId: "EX-DIFFERENT-SESSION" }],
  };
}

test("legacy mode still detects a session mismatch", () => {
  const mismatch = detectPollMismatch(cxAgent(), exPresenceWithDifferentSession(), {
    cxPollWriteMode: "legacy",
  });
  assert.equal(mismatch?.type, "session_mismatch");
});

test("cx-owned mode ignores EX session mismatch while a CX call is held", () => {
  const mismatch = detectPollMismatch(cxAgent(), exPresenceWithDifferentSession(), {
    cxPollWriteMode: "cx-owned",
  });
  assert.equal(mismatch, null);
});

test("observe-only mode reports a mismatch without reconciling AgentState", async () => {
  const result = await reconcilePolledPresence(cxAgent(), exPresenceWithDifferentSession(), null, {
    cxPollWriteMode: "legacy",
    presencePollMode: "observe-only",
  });
  assert.equal(result.changed, false);
  assert.equal(result.observed, true);
  assert.equal(result.reason, "observe_session_mismatch");
});

test("observe-only mode reports a status change without persisting it", async () => {
  const result = await reconcilePolledPresence(
    {
      extensionId: "101",
      status: "available",
      activePlatform: "none",
      currentCall: {},
    },
    {
      telephonyStatus: "CallConnected",
      presenceStatus: "Available",
      activeCalls: [{ sessionId: "EX-ACTIVE-SESSION", direction: "Outbound" }],
    },
    null,
    { presencePollMode: "observe-only" },
  );
  assert.equal(result.changed, false);
  assert.equal(result.observed, true);
  assert.equal(result.reason, "observe_presence_status_changed");
});

test("presence poll mode parser supports observe-only and off", () => {
  assert.equal(normalizePresencePollMode("observe-only"), "observe-only");
  assert.equal(normalizePresencePollMode("read-only"), "observe-only");
  assert.equal(normalizePresencePollMode("disabled"), "off");
  assert.equal(normalizePresencePollMode("legacy"), "write");
});

test("runtime mode parser does not alias cx-owned write mode into cx-only runtime mode", () => {
  assert.equal(normalizeCxRuntimeMode("cx-only"), "cx-only");
  assert.equal(normalizeCxRuntimeMode("ringcx-only"), "cx-only");
  assert.equal(normalizeCxRuntimeMode("cx-owned"), null);
});
