"use strict";

// Review finding #2: snapshotCurrentCall/cloneCall must carry callSessionId + uii (the identity
// fields the shared guard's callIdentity falls back to), or an EX active call identified only by
// those yields a null identity and decideExPollCxOwnership mis-decides ownership.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  snapshotCurrentCall,
  cloneCall,
  callSignature,
} = require("../../packages/shared-services/src/ringcentralExService");
const { callIdentity } = require("../../packages/shared-services/src/cxCallStateGuard");

test("snapshotCurrentCall preserves callSessionId and uii", () => {
  const snap = snapshotCurrentCall({ callSessionId: "cs-1", uii: "uii-1", direction: "Inbound" });
  assert.equal(snap.callSessionId, "cs-1");
  assert.equal(snap.uii, "uii-1");
});

test("REGRESSION: an EX active call identified ONLY by callSessionId keeps a non-null identity through the snapshot", () => {
  const snap = snapshotCurrentCall({ callSessionId: "cs-only" });
  assert.equal(callIdentity(snap), "cs-only"); // before the fix this was null (field dropped)
});

test("REGRESSION: an EX active call identified ONLY by uii keeps a non-null identity through the snapshot", () => {
  const snap = snapshotCurrentCall({ uii: "uii-only" });
  assert.equal(callIdentity(snap), "uii-only");
});

test("cloneCall preserves callSessionId and uii", () => {
  const cloned = cloneCall({ callSessionId: "cs-2", uii: "uii-2", sessionId: "s" });
  assert.equal(cloned.callSessionId, "cs-2");
  assert.equal(cloned.uii, "uii-2");
  assert.equal(callIdentity(cloned), "s"); // telephony/session still wins priority
});

test("callSignature includes callSessionId and uii (change-detection sees them)", () => {
  const a = callSignature({ sessionId: "s", callSessionId: "x" });
  const b = callSignature({ sessionId: "s", callSessionId: "y" });
  assert.notEqual(a, b);
});
