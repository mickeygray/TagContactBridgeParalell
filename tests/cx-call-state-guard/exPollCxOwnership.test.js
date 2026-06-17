"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { decideExPollCxOwnership } = require("../../packages/shared-services/src/cxCallStateGuard");

const UII = "202606151320473610000136381455";

// ── flag OFF is provably inert (the deployed default) ─────────────────────────
test("disabled => always no-op, regardless of any other input", () => {
  assert.deepEqual(
    decideExPollCxOwnership({ enabled: false, previousHasCxCall: true, previousCxIdentity: UII, exActiveIsBridge: true }),
    { cxOwnsCallState: false, forceExNoCall: false },
  );
  assert.deepEqual(decideExPollCxOwnership({}), { cxOwnsCallState: false, forceExNoCall: false });
});

// ── enabled: nothing to protect ───────────────────────────────────────────────
test("enabled but no held CX call => no-op", () => {
  assert.deepEqual(
    decideExPollCxOwnership({ enabled: true, previousHasCxCall: false, previousCxIdentity: null }),
    { cxOwnsCallState: false, forceExNoCall: false },
  );
  assert.deepEqual(
    decideExPollCxOwnership({ enabled: true, previousHasCxCall: true, previousCxIdentity: null }),
    { cxOwnsCallState: false, forceExNoCall: false },
  );
});

// ── the incident: held CX call + the bridge leg => preserve + force NoCall ─────
test("held CX call, EX active call is the bridge => own CX state and force exTelephony NoCall", () => {
  assert.deepEqual(
    decideExPollCxOwnership({
      enabled: true, previousHasCxCall: true, previousCxIdentity: UII,
      exActiveIdentity: UII, exActiveIsBridge: true,
    }),
    { cxOwnsCallState: true, forceExNoCall: true },
  );
});

// ── EX NoCall path: held CX call, no EX active call => preserve (no force needed) ─
test("held CX call, no EX active call => own CX state, no force", () => {
  assert.deepEqual(
    decideExPollCxOwnership({
      enabled: true, previousHasCxCall: true, previousCxIdentity: UII,
      exActiveIdentity: null, exActiveIsBridge: false,
    }),
    { cxOwnsCallState: true, forceExNoCall: false },
  );
});

// ── same call surfacing on EX (not flagged bridge) => still own it ────────────
test("held CX call, EX active call has the SAME identity => own CX state", () => {
  assert.deepEqual(
    decideExPollCxOwnership({
      enabled: true, previousHasCxCall: true, previousCxIdentity: UII,
      exActiveIdentity: UII, exActiveIsBridge: false,
    }),
    { cxOwnsCallState: true, forceExNoCall: false },
  );
});

// ── a GENUINE separate EX call must NOT be hijacked ───────────────────────────
test("held CX call but a different NON-bridge EX call is active => defer to EX (no-op)", () => {
  assert.deepEqual(
    decideExPollCxOwnership({
      enabled: true, previousHasCxCall: true, previousCxIdentity: UII,
      exActiveIdentity: "SOME-OTHER-EX-SESSION", exActiveIsBridge: false,
    }),
    { cxOwnsCallState: false, forceExNoCall: false },
  );
});

test("cx-owned mode: held CX call wins even when EX sees a different session", () => {
  assert.deepEqual(
    decideExPollCxOwnership({
      enabled: true, mode: "cx-owned", previousHasCxCall: true, previousCxIdentity: UII,
      exActiveIdentity: "SOME-OTHER-EX-SESSION", exActiveIsBridge: false,
    }),
    { cxOwnsCallState: true, forceExNoCall: true },
  );
});

test("cx-owned mode still requires the caller to enable EX/CX decoupling", () => {
  assert.deepEqual(
    decideExPollCxOwnership({
      enabled: false, mode: "cx-owned", previousHasCxCall: true, previousCxIdentity: UII,
      exActiveIdentity: "SOME-OTHER-EX-SESSION", exActiveIsBridge: false,
    }),
    { cxOwnsCallState: false, forceExNoCall: false },
  );
});

test("held CX call, different identity but flagged as bridge => still own it (bridge, not a real EX call)", () => {
  assert.deepEqual(
    decideExPollCxOwnership({
      enabled: true, previousHasCxCall: true, previousCxIdentity: UII,
      exActiveIdentity: "BRIDGE-LEG-SESSION", exActiveIsBridge: true,
    }),
    { cxOwnsCallState: true, forceExNoCall: true },
  );
});
