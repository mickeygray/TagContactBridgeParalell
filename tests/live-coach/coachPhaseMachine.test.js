"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { reduceCoachPhase, PHASES, orderOf } = require("../../packages/shared-services/src/coachPhaseMachine");

// Build a prior phase-state with explicit sticky markers (unit-test shortcut for
// "these markers have already been observed earlier in the call").
const at = (phase, seen = {}) => ({ phase, since: 0, seen });

test("cold start: no state, no signals -> stays in intro", () => {
  const r = reduceCoachPhase(undefined, {});
  assert.equal(r.state.phase, "intro");
  assert.equal(r.changed, false);
});

test("intro -> discovery when the first discovery question is asked", () => {
  const r = reduceCoachPhase(at("intro"), { discoveryAsked: true, turnCount: 3 });
  assert.equal(r.state.phase, "discovery");
  assert.equal(r.changed, true);
});

test("discovery -> expert is GATED: explaining with <2 core facts does not advance", () => {
  const r = reduceCoachPhase(at("discovery"), { expertExplained: true, capturedFacts: ["balance"] });
  assert.equal(r.state.phase, "discovery");
  assert.equal(r.changed, false);
});

test("discovery -> expert when the core facts are captured", () => {
  const r = reduceCoachPhase(at("discovery"), { capturedFacts: ["balance", "unfiled_years", "collection_status"] });
  assert.equal(r.state.phase, "expert");
});

test("expert -> pitch when representation is framed (POA / 2848)", () => {
  const r = reduceCoachPhase(at("expert"), { representationFramed: true });
  assert.equal(r.state.phase, "pitch");
});

test("pitch -> payment when a fee is quoted", () => {
  const r = reduceCoachPhase(at("pitch", { representationFramed: true }), { feeQuoted: true });
  assert.equal(r.state.phase, "payment");
});

test("a stray fee mid-discovery does NOT jump to payment (gate blocks the skip)", () => {
  const r = reduceCoachPhase(at("discovery"), { feeQuoted: true });
  assert.equal(r.state.phase, "discovery");
  assert.equal(r.changed, false);
});

test("navigator forward proposal is honored when its gate holds", () => {
  const r = reduceCoachPhase(at("pitch", { representationFramed: true }), { proposedPhase: "payment" });
  assert.equal(r.state.phase, "payment");
});

test("navigator forward proposal is REJECTED when its gate fails", () => {
  const r = reduceCoachPhase(at("discovery"), { proposedPhase: "payment" });
  assert.equal(r.state.phase, "discovery");
});

test("navigator may regress exactly one step", () => {
  const r = reduceCoachPhase(at("payment", { representationFramed: true, feeQuoted: true }), { proposedPhase: "pitch", proposalReason: "looped back to representation" });
  assert.equal(r.state.phase, "pitch");
  assert.equal(r.changed, true);
});

test("navigator cannot regress two steps in one move", () => {
  const r = reduceCoachPhase(at("payment", { representationFramed: true, feeQuoted: true }), { proposedPhase: "discovery" });
  assert.equal(r.state.phase, "payment");
  assert.equal(r.changed, false);
});

test("payment -> info on PII collection, gated by a prior fee", () => {
  const r = reduceCoachPhase(at("payment", { representationFramed: true, feeQuoted: true }), { infoCollectionStarted: true });
  assert.equal(r.state.phase, "info");
});

test("info -> close on the wrap-up summary", () => {
  const r = reduceCoachPhase(at("info", { representationFramed: true, feeQuoted: true }), { closeSummary: true });
  assert.equal(r.state.phase, "close");
});

test("markers are STICKY: a fee quoted earlier still gates info two turns later", () => {
  // Turn A: in pitch, a fee is quoted -> advance to payment, seen.feeQuoted sticks.
  const a = reduceCoachPhase(at("pitch", { representationFramed: true }), { feeQuoted: true });
  assert.equal(a.state.phase, "payment");
  assert.equal(a.state.seen.feeQuoted, true);
  // Turn B: no fresh feeQuoted signal, but PII collection starts -> info still
  // advances because seen.feeQuoted persisted in state.
  const b = reduceCoachPhase(a.state, { infoCollectionStarted: true });
  assert.equal(b.state.phase, "info");
});

test("stay still merges newly-seen markers into state", () => {
  const r = reduceCoachPhase(at("pitch", { representationFramed: true }), { feeQuoted: false, representationFramed: true });
  assert.equal(r.changed, false);
  assert.equal(r.state.seen.representationFramed, true);
});

test("phase order is the WYNN arc intro..close, monotonically increasing", () => {
  const ids = PHASES.map((p) => p.id);
  assert.deepEqual(ids, ["intro", "discovery", "expert", "pitch", "payment", "info", "close"]);
  for (let i = 1; i < PHASES.length; i += 1) assert.ok(orderOf(ids[i]) > orderOf(ids[i - 1]));
});
