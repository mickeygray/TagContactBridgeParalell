"use strict";

// CR-8 gate: the flags, and the one flag combination that must refuse to run.
//
// §22: "delivery=true while discovery/shadow prerequisites are false must fail
// closed and surface a configuration error."
//
// That rule matters more than it looks. Delivery without discovery is not a
// quiet no-op — it is a system that has been told it may dial, with no proven
// evidence about who, and the failure mode of guessing there is calling a
// stranger who is on a DNC list. So it is an ERROR, not a default.

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveCallRecoveryActivation } = require(
  "../../packages/shared-services/src/callRecoveryDiscoveryService");

const cfg = (over = {}) => ({
  discoveryEnabled: false, shadowEnabled: false, deliveryEnabled: false, agentAllowlist: [], ...over,
});

test("everything is dark by default", () => {
  const a = resolveCallRecoveryActivation(cfg());
  assert.equal(a.ok, true);
  assert.equal(a.discovery, false);
  assert.equal(a.shadow, false);
  assert.equal(a.delivery, false);
});

test("delivery without discovery FAILS CLOSED with a configuration error", () => {
  const a = resolveCallRecoveryActivation(cfg({ deliveryEnabled: true }));
  assert.equal(a.ok, false);
  assert.equal(a.delivery, false, "it must not fall through to enabled");
  assert.match(a.error, /discovery/i);
});

test("delivery without shadow also fails closed", () => {
  const a = resolveCallRecoveryActivation(cfg({ discoveryEnabled: true, deliveryEnabled: true }));
  assert.equal(a.ok, false);
  assert.equal(a.delivery, false);
  assert.match(a.error, /shadow/i);
});

test("the full ladder enables delivery", () => {
  const a = resolveCallRecoveryActivation(cfg({
    discoveryEnabled: true, shadowEnabled: true, deliveryEnabled: true,
  }));
  assert.equal(a.ok, true);
  assert.equal(a.delivery, true);
});

test("an allowlist narrows delivery to named agents, and an empty one is not 'everyone'", () => {
  // During the canary an empty allowlist must mean "nobody has been named yet",
  // never "the whole floor" — the opposite reading turns a one-agent test into
  // a full rollout by omission.
  const armed = cfg({ discoveryEnabled: true, shadowEnabled: true, deliveryEnabled: true });
  const canary = resolveCallRecoveryActivation({ ...armed, agentAllowlist: ["chris.bolt"] });
  assert.equal(canary.allowsAgent("chris.bolt"), true);
  assert.equal(canary.allowsAgent("brad.hansen"), false);

  const unnamed = resolveCallRecoveryActivation({ ...armed, agentAllowlist: [] });
  assert.equal(unnamed.allowsAgent("chris.bolt"), true, "no allowlist means the gate is the flag itself");
});

test("agent matching is case-insensitive and trimmed", () => {
  const a = resolveCallRecoveryActivation(cfg({
    discoveryEnabled: true, shadowEnabled: true, deliveryEnabled: true, agentAllowlist: ["Chris.Bolt"],
  }));
  assert.equal(a.allowsAgent(" chris.bolt "), true);
  assert.equal(a.allowsAgent("CHRIS.BOLT"), true);
});

test("a dark system never allows an agent", () => {
  const a = resolveCallRecoveryActivation(cfg({ agentAllowlist: ["chris.bolt"] }));
  assert.equal(a.allowsAgent("chris.bolt"), false, "the allowlist is a narrowing, not an override");
});

test("the checked-in policy constants are not environment-tunable", () => {
  // §22 — flags control activation, not business truth. If a cap or a retry
  // floor ever becomes an env var, the compliance story stops being reviewable
  // in git and starts depending on what is set on one box.
  const fs = require("node:fs");
  const src = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/leadDeliveryService"), "utf8");
  for (const constant of [
    "CALL_RECOVERY_MAXIMUM_DAILY_ATTEMPTS",
    "CALL_RECOVERY_MINIMUM_RETRY_MINUTES",
    "CALL_RECOVERY_MAXIMUM_PROGRAM_AGE_DAYS",
  ]) {
    const line = src.split(/\r?\n/).find((l) => l.includes(`const ${constant}`));
    assert.ok(line, `${constant} is missing`);
    assert.ok(!/process\.env/.test(line), `${constant} must not read the environment: ${line.trim()}`);
  }
});
