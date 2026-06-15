"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  shouldClearOrphanCxDisposition,
} = require("../../packages/shared-services/src/idleReaperService");

const NOW = new Date("2026-06-15T17:30:00.000Z");
const ENDED_LONG_AGO = "2026-06-15T17:19:27.000Z"; // ~10 min before NOW, past the 90s orphan window
const UII = "202606151320473610000136381455";

function orphanAgent(over = {}) {
  return {
    extensionId: "63914586004",
    activityState: "dispositioning",
    activePlatform: "CX",
    currentCall: { channel: "cx", telephonySessionId: UII },
    lastCallEndedAt: ENDED_LONG_AGO,
    ...over,
  };
}

// The incident: a CX call that still carries a UII identity is HELD, not reaped on age —
// release must come from a UII-matched terminal, never from age or EX presence.
test("UII-bearing orphan CX disposition is HELD (not reaped) even past the 90s window", () => {
  assert.equal(shouldClearOrphanCxDisposition(orphanAgent(), NOW), false);
});

test("EX presence is IGNORED: a stale exTelephonyStatus does not change the decision", () => {
  // Whatever EX reports, the UII identity is what holds the call.
  assert.equal(shouldClearOrphanCxDisposition(orphanAgent({ exTelephonyStatus: "NoCall" }), NOW), false);
  assert.equal(shouldClearOrphanCxDisposition(orphanAgent({ exTelephonyStatus: "CallConnected" }), NOW), false);
});

test("identity-less orphan (no UII to wait on) is still reaped after the window", () => {
  const noUii = orphanAgent({ currentCall: { channel: "cx" } }); // no sessionId/telephonySessionId/uii
  assert.equal(shouldClearOrphanCxDisposition(noUii, NOW), true);
});

test("non-EX absolute backstop: a UII-bearing orphan older than the cap IS reaped", () => {
  const prev = process.env.RC_CX_ORPHAN_DISPOSITION_UII_MAX_HOLD_MS;
  process.env.RC_CX_ORPHAN_DISPOSITION_UII_MAX_HOLD_MS = String(30 * 60 * 1000); // 30 min
  try {
    // ended ~10 min ago -> within cap -> still held
    assert.equal(shouldClearOrphanCxDisposition(orphanAgent(), NOW), false);
    // ended ~40 min ago -> past cap -> reaped
    const old = orphanAgent({ lastCallEndedAt: new Date(NOW.getTime() - 40 * 60 * 1000).toISOString() });
    assert.equal(shouldClearOrphanCxDisposition(old, NOW), true);
  } finally {
    if (prev === undefined) delete process.env.RC_CX_ORPHAN_DISPOSITION_UII_MAX_HOLD_MS;
    else process.env.RC_CX_ORPHAN_DISPOSITION_UII_MAX_HOLD_MS = prev;
  }
});

test("within the 90s orphan window => not yet eligible (UII present)", () => {
  const recent = new Date(NOW.getTime() - 30 * 1000).toISOString();
  assert.equal(shouldClearOrphanCxDisposition(orphanAgent({ lastCallEndedAt: recent }), NOW), false);
});

test("not in a disposition state (onCall) => never reaped", () => {
  assert.equal(shouldClearOrphanCxDisposition(orphanAgent({ activityState: "onCall" }), NOW), false);
});

test("non-CX disposition => not handled here", () => {
  assert.equal(
    shouldClearOrphanCxDisposition(orphanAgent({ activePlatform: "EX", currentCall: { channel: "ex" } }), NOW),
    false,
  );
});
