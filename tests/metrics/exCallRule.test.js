"use strict";

// The RingCentral ("ex") inclusion rule. Mickey 2026-08-04: "we don't have to
// work twice, and the ex API is a lot less friendly for rate limiting. So the
// rules for ex is like calls that are not inter-office or tied to a marketing
// piece — like when an agent talks to an existing client."

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  exSkipReason, resolveProvider,
} = require("../../packages/shared-services/src/callRecordingIndexService");

test("an agent talking to an existing client is KEPT", () => {
  assert.equal(exSkipReason({
    normalizedPhone: "5625551234", caseId: 812345, sourceChannel: null,
  }), null);
});

test("inter-office calls are skipped — an extension is not a client", () => {
  assert.equal(exSkipReason({ normalizedPhone: "1042" }), "inter-office");
  assert.equal(exSkipReason({ phone: "302" }), "inter-office");
});

test("a call tied to a marketing piece belongs to CallRail, not RingCentral", () => {
  // This is the "work twice" case: CallRail already hands out a durable link
  // for the same call, for free. Pulling it again through the rate-limited RC
  // API buys nothing.
  assert.equal(exSkipReason({
    normalizedPhone: "5625551234", mailPieceKey: "BCD-V3-2026-07",
  }), "marketing-piece");
  assert.equal(exSkipReason({
    normalizedPhone: "5625551234", sourceChannel: "callrail",
  }), "marketing-channel");
  assert.equal(exSkipReason({
    normalizedPhone: "5625551234", sourceChannel: "mail",
  }), "marketing-channel");
  assert.equal(exSkipReason({
    normalizedPhone: "5625551234", sourceCanonicalId: "src_9912",
  }), "marketing-source");
});

test("the rule is applied ONLY to RingCentral, because `ex` is a mixed bucket", () => {
  // ~38% of archived `ex` rows are CallRail (1,177 of 3,139 over 90 days).
  // Provider is resolved BEFORE the rule runs, so a CallRail row living in the
  // ex bucket keeps its own handling and is never judged by RC's rules.
  assert.equal(resolveProvider({
    archiveProvider: "callrail", uri: "https://app.callrail.com/calls/1/rec", platform: "ex",
  }), "callrail");
  assert.equal(resolveProvider({
    archiveProvider: "ringcentral", uri: "https://media.ringcentral.com/x", platform: "ex",
  }), "ringcentral");
});

test("a missing phone is not treated as an extension", () => {
  // No number at all is unknown, not inter-office. Rounding it down to
  // "inter-office" would silently drop client calls whose phone failed to
  // normalize.
  assert.equal(exSkipReason({ normalizedPhone: "", phone: "" }), null);
  assert.equal(exSkipReason({}), null);
});
