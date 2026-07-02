"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  detectPollMismatch,
  exPresencePollMode,
  normalizePresencePollMode,
  reconcilePolledPresence,
  seedPresenceForAgents,
} = require("../../packages/shared-services/src/ringcentralExService");
const {
  getCxRuntimeMode,
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

async function withEnv(patch, fn) {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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

test("bulk-load alpha resolves CX runtime to cx-only and boots EX presence polling", async () => {
  await withEnv(
    {
      RC_CX_RUNTIME_MODE: undefined,
      CX_RUNTIME_MODE: undefined,
      RC_CX_EX_PRESENCE_POLL_MODE: undefined,
      RC_EX_PRESENCE_POLL_MODE: undefined,
      CX_DIAL_RUNTIME_BULK_LOAD_ENABLED: "true",
      VITE_CX_WORKSPACE_MODE: "bulk_load",
    },
    async () => {
      assert.equal(getCxRuntimeMode(), "cx-only");
      assert.equal(exPresencePollMode(), "off");
      const seeded = await seedPresenceForAgents({ info() {} });
      assert.equal(seeded.skipped, true);
      assert.equal(seeded.reason, "presence-poll-off");
      assert.equal(seeded.checked, 0);
    },
  );
});

test("runtime mode parser does not alias cx-owned write mode into cx-only runtime mode", () => {
  assert.equal(normalizeCxRuntimeMode("cx-only"), "cx-only");
  assert.equal(normalizeCxRuntimeMode("ringcx-only"), "cx-only");
  assert.equal(normalizeCxRuntimeMode("cx-owned"), null);
});
