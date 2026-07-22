"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isJulyLead, leadState, outcomeFromLead, retryExtern, rowsFromSearch } = require("../../scripts/cx-direct-four-agent-results");

test("RingCX dispositions are read, not invented", () => {
  assert.equal(outcomeFromLead({ lastPassDispo: "ANSWER" }), "answered");
  assert.equal(outcomeFromLead({ lastPassDispo: "MACHINE" }), "voicemail");
  assert.equal(outcomeFromLead({ lastPassDispo: "CONGESTION" }), "did_not_connect");
  assert.equal(outcomeFromLead({ agentDisposition: "DNC" }), "dnc");
  assert.equal(outcomeFromLead({ agentDisposition: "Wrong Number" }), "bad_number");
  assert.equal(outcomeFromLead({ lastPassDispo: "NEW_VALUE" }), "unknown");
  assert.equal(outcomeFromLead({ lastPassDispo: "ANSWER", agentDispostion: "Auto Dispo" }), "answered");
});

test("only explicit terminal lead states are terminal", () => {
  assert.equal(leadState({ leadState: "READY" }), "READY");
  assert.equal(leadState({ leadState: "COMPLETE" }), "COMPLETE");
});

test("attempt extern IDs are stable and July gate is explicit", () => {
  assert.equal(retryExtern(123, 2), "cx-direct-wynn-123-a2");
  assert.equal(isJulyLead(new Date("2026-07-01T08:00:00Z")), true);
  assert.equal(isJulyLead(new Date("2026-06-30T23:59:59Z")), false);
  assert.equal(isJulyLead(new Date("2026-08-01T12:00:00Z")), false);
});

test("search response must expose a real row array", () => {
  assert.deepEqual(rowsFromSearch({ leads: [{ externId: "x" }] }), [{ externId: "x" }]);
  assert.throws(() => rowsFromSearch({ ok: true }), /unexpected response/);
});
