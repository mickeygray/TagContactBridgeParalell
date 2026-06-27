"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { BASE_CONTRACT, PHASE_DOCTRINE, selectComposerSystem } = require("../../packages/shared-services/src/coachComposerSystems");

test("every phase the machine knows has a specialist doctrine", () => {
  for (const phase of ["intro", "discovery", "expert", "pitch", "payment", "info", "close"]) {
    assert.ok(typeof PHASE_DOCTRINE[phase] === "string" && PHASE_DOCTRINE[phase].length > 0, `${phase} has doctrine`);
  }
});

test("selectComposerSystem returns the shared contract + the phase doctrine", () => {
  const pay = selectComposerSystem("payment");
  assert.match(pay, /Read \(what's happening\)/); // the shared contract
  assert.match(pay, /anchor the flat fee/); // payment-specific
  assert.match(pay, /penalties, liens, wage garnishment/);

  const disc = selectComposerSystem("discovery");
  assert.match(disc, /Do NOT pitch or quote a fee/); // discovery-specific
  assert.equal(/anchor the flat fee/.test(disc), false); // not the payment doctrine
});

test("a specialist is distinct per phase (different Haiku for a different task)", () => {
  assert.notEqual(selectComposerSystem("discovery"), selectComposerSystem("payment"));
  assert.notEqual(selectComposerSystem("pitch"), selectComposerSystem("close"));
});

test("an unknown phase falls back to the generalist base contract", () => {
  assert.equal(selectComposerSystem("???"), BASE_CONTRACT);
});

test("an optional hint is appended as context", () => {
  const s = selectComposerSystem("payment", "prospect is a small-business owner");
  assert.match(s, /CONTEXT: prospect is a small-business owner/);
});
