"use strict";

// PINS for normalizeRingcxLoginDest (WORKORDER_ringcx_defaultLoginDest_normalization,
// 2026-07-08 — the Chris seat outage). RingCX validates defaultLoginDest as
// "10-digit DID or SIP URI" and rejects E.164. The exact §7.1 cases, verbatim.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeRingcxLoginDest, normalizeRingcxPhone } = require("../../packages/shared-integrations/src/ringcxVoiceClient");

test("E.164 login dest strips to bare 10-digit (the Chris failure)", () => {
  assert.equal(normalizeRingcxLoginDest("+18183375982"), "8183375982");
});

test("already-bare 10-digit passes through unchanged", () => {
  assert.equal(normalizeRingcxLoginDest("8183375982"), "8183375982");
});

test("11-digit with leading 1 strips to 10", () => {
  assert.equal(normalizeRingcxLoginDest("18183375982"), "8183375982");
});

test("a SIP URI is passed through untouched", () => {
  assert.equal(
    normalizeRingcxLoginDest("sip:agent@pbx.example.com"),
    "sip:agent@pbx.example.com",
  );
});

test("empty / null yield null", () => {
  assert.equal(normalizeRingcxLoginDest(""), null);
  assert.equal(normalizeRingcxLoginDest(null), null);
  assert.equal(normalizeRingcxLoginDest(undefined), null);
});

test("FENCE: normalizeRingcxPhone itself is untouched (the working dial path uses it)", () => {
  assert.equal(normalizeRingcxPhone("+18183375982"), "8183375982");
  assert.equal(normalizeRingcxPhone("sip:agent@pbx.example.com"), null, "phone normalizer strips all non-digits — which is exactly why it must never see a SIP login dest directly");
});
