"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  callIdentity,
  cxClearSkipReason,
  evaluateCxClear,
  getCxMissingUiiMaxHoldMs,
} = require("../../packages/shared-services/src/cxCallStateGuard");

const UII = "202606151320473610000136381455"; // the real incident UII

// ── callIdentity ──────────────────────────────────────────────────────────────
test("callIdentity prefers telephonySessionId, falls back through sessionId/callSessionId/uii", () => {
  assert.equal(callIdentity({ telephonySessionId: "a", sessionId: "b" }), "a");
  assert.equal(callIdentity({ sessionId: "b" }), "b");
  assert.equal(callIdentity({ callSessionId: "c" }), "c");
  assert.equal(callIdentity({ uii: "d" }), "d");
  assert.equal(callIdentity({}), null);
  assert.equal(callIdentity({ sessionId: "  " }), null);
});

// ── legacy behavior preserved ─────────────────────────────────────────────────
test("different live CX call is still blocked (legacy different-active-cx-call)", () => {
  assert.equal(
    cxClearSkipReason({ existingIdentity: "X", requestedIdentity: "Y", activePlatformIsCx: true }),
    "different-active-cx-call",
  );
});

test("matching identity clears (null skip)", () => {
  assert.equal(
    cxClearSkipReason({ existingIdentity: "X", requestedIdentity: "X", activePlatformIsCx: true }),
    null,
  );
});

test("different identity but NON-CX platform clears (legacy: diff-skip only fired on CX)", () => {
  assert.equal(
    cxClearSkipReason({ existingIdentity: "X", requestedIdentity: "Y", activePlatformIsCx: false }),
    null,
  );
});

test("no existing identity => nothing to protect, clears", () => {
  assert.equal(
    cxClearSkipReason({ existingIdentity: null, requestedIdentity: null, activePlatformIsCx: true }),
    null,
  );
});

// ── the NEW missing-UII protection ────────────────────────────────────────────
test("missing UII while CX active (by platform) BLOCKS the clear", () => {
  assert.equal(
    cxClearSkipReason({ existingIdentity: UII, requestedIdentity: null, activePlatformIsCx: true }),
    "missing-uii-active-cx-call",
  );
});

test("missing UII while CX active (by channel only, platform not yet CX) BLOCKS the clear", () => {
  assert.equal(
    cxClearSkipReason({ existingIdentity: UII, requestedIdentity: null, activePlatformIsCx: false, channelIsCx: true }),
    "missing-uii-active-cx-call",
  );
});

test("missing UII while NON-CX clears (no CX call to protect)", () => {
  assert.equal(
    cxClearSkipReason({ existingIdentity: "X", requestedIdentity: null, activePlatformIsCx: false, channelIsCx: false }),
    null,
  );
});

// ── anti-stranding valve ──────────────────────────────────────────────────────
test("missing UII + CX + call older than maxHoldMs => valve allows the clear", () => {
  assert.equal(
    cxClearSkipReason({
      existingIdentity: UII, requestedIdentity: null, activePlatformIsCx: true,
      callStartedAtMs: 1_000_000, nowMs: 1_000_000 + 31 * 60 * 1000, maxHoldMs: 30 * 60 * 1000,
    }),
    null,
  );
});

test("missing UII + CX + call within maxHoldMs => still blocked", () => {
  assert.equal(
    cxClearSkipReason({
      existingIdentity: UII, requestedIdentity: null, activePlatformIsCx: true,
      callStartedAtMs: 1_000_000, nowMs: 1_000_000 + 60 * 1000, maxHoldMs: 30 * 60 * 1000,
    }),
    "missing-uii-active-cx-call",
  );
});

test("valve disabled (maxHoldMs null) => always blocked regardless of age", () => {
  assert.equal(
    cxClearSkipReason({
      existingIdentity: UII, requestedIdentity: null, activePlatformIsCx: true,
      callStartedAtMs: 1, nowMs: 9_999_999_999, maxHoldMs: null,
    }),
    "missing-uii-active-cx-call",
  );
});

// ── getCxMissingUiiMaxHoldMs ───────────────────────────────────────────────────
test("getCxMissingUiiMaxHoldMs: disabled by default, parses a positive env value", () => {
  const prev = process.env.CX_MISSING_UII_MAX_HOLD_MS;
  delete process.env.CX_MISSING_UII_MAX_HOLD_MS;
  assert.equal(getCxMissingUiiMaxHoldMs(), null);
  process.env.CX_MISSING_UII_MAX_HOLD_MS = "1800000";
  assert.equal(getCxMissingUiiMaxHoldMs(), 1_800_000);
  process.env.CX_MISSING_UII_MAX_HOLD_MS = "0";
  assert.equal(getCxMissingUiiMaxHoldMs(), null);
  if (prev === undefined) delete process.env.CX_MISSING_UII_MAX_HOLD_MS;
  else process.env.CX_MISSING_UII_MAX_HOLD_MS = prev;
});

// ── evaluateCxClear: the incident regression, end to end on an agentState shape ─
test("REGRESSION: Tracey's live CX call is NOT cleared by an auto-disposition with no UII", () => {
  const existing = {
    activePlatform: "CX",
    currentCall: {
      channel: "cx",
      sessionId: UII,
      telephonySessionId: UII,
      direction: "outbound",
      startTime: "2026-06-15T17:18:31.000Z",
    },
  };
  const r = evaluateCxClear(existing, null, { nowMs: Date.parse("2026-06-15T17:19:27.000Z"), maxHoldMs: null });
  assert.equal(r.skip, "missing-uii-active-cx-call");
  assert.equal(r.existingIdentity, UII);
  assert.equal(r.requestedIdentity, null);
});

test("a disposition carrying the matching UII DOES clear Tracey's call", () => {
  const existing = {
    activePlatform: "CX",
    currentCall: { channel: "cx", telephonySessionId: UII, startTime: "2026-06-15T17:18:31.000Z" },
  };
  const r = evaluateCxClear(existing, UII, { nowMs: Date.parse("2026-06-15T17:25:00.000Z") });
  assert.equal(r.skip, null);
  assert.equal(r.existingIdentity, UII);
  assert.equal(r.requestedIdentity, UII);
});

test("evaluateCxClear: empty/idle agent state clears (no protection)", () => {
  assert.equal(evaluateCxClear({ activePlatform: "none", currentCall: {} }, null).skip, null);
  assert.equal(evaluateCxClear(null, null).skip, null);
});

test("evaluateCxClear: a different active CX call is still blocked", () => {
  const existing = { activePlatform: "CX", currentCall: { channel: "cx", telephonySessionId: "OTHER" } };
  assert.equal(evaluateCxClear(existing, UII).skip, "different-active-cx-call");
});
