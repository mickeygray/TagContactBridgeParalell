"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  activeCallRows,
  callMatchesAgent,
  decideRecovery,
  isSoftphoneLogin,
  offhookCount,
} = require("../../scripts/cx-suspect-watchdog");

test("active-call truth accepts known response shapes and matches exact agent identity", () => {
  const rows = activeCallRows({ records: [{ agentId: 21812 }, { agent: { id: 20845 } }] });
  assert.equal(rows.length, 2);
  assert.equal(callMatchesAgent(rows[0], "21812"), true);
  assert.equal(callMatchesAgent(rows[0], "21810"), false);
  assert.equal(callMatchesAgent(rows[1], "20845"), true);
});

test("softphone and external off-hook evidence are classified separately", () => {
  assert.equal(isSoftphoneLogin({ agentPhone: "+1877*742@RC_SOFTPHONE" }), true);
  assert.equal(isSoftphoneLogin({ agentPhone: "+18185551212" }), false);
  assert.equal(offhookCount({ agentOffhookSessions: [{ endDts: null }, { endDts: "done" }] }), 1);
  assert.equal(isSoftphoneLogin(null), false);
  assert.equal(offhookCount(null), 0);
});

test("SUSPECT agent with no active call is eligible for a guarded full logout", () => {
  assert.deepEqual(decideRecovery({
    state: "SUSPECT",
    activeCallReadOk: true,
    hasActiveCall: false,
    nowMs: 100,
    nextEligibleAtMs: 0,
    attempts: 0,
    maxAttempts: 6,
  }), { action: "logout-agent", reason: "confirmed-suspect-session" });
});

test("watchdog fails closed on calls, read failures, cooldown, and attempt cap", () => {
  const base = {
    state: "SUSPECT",
    activeCallReadOk: true,
    hasActiveCall: false,
    nowMs: 100,
    nextEligibleAtMs: 0,
    attempts: 0,
    maxAttempts: 6,
  };
  assert.equal(decideRecovery({ ...base, activeCallReadOk: false }).reason, "active-call-read-failed");
  assert.equal(decideRecovery({ ...base, hasActiveCall: true }).reason, "agent-has-active-call");
  assert.equal(decideRecovery({ ...base, nextEligibleAtMs: 101 }).reason, "cooldown");
  assert.equal(decideRecovery({ ...base, attempts: 6 }).reason, "attempt-cap-reached");
  assert.equal(decideRecovery({ ...base, state: "AVAILABLE" }).reason, "not-suspect");
});
