"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  emptyProspectState,
  parseProspectState,
  stripProspectStateTag,
  mergeProspectState,
  disclosureAllowances,
  formatProspectStateForHeader,
  DISCLOSURE_GATES,
} = require("../../packages/shared-services/src/trainerProspectStateService");

// ── the anti-bimodality physics: trust moves at most +/-1 per turn ──────────

test("ROLL-OVER is impossible: model wanting trust 2 -> 9 is clamped to +1", () => {
  const prior = emptyProspectState({ trust: 2 });
  const next = mergeProspectState(prior, { trust: 9 });
  assert.equal(next.trust, 3, "a cliff jump up is clamped to a single step");
});

test("WALL is impossible: model wanting trust 6 -> 1 is clamped to -1", () => {
  const prior = { ...emptyProspectState(), trust: 6 };
  const next = mergeProspectState(prior, { trust: 1 });
  assert.equal(next.trust, 5, "a cliff jump down is clamped to a single step");
});

test("the middle emerges: a warming call climbs one point per turn", () => {
  let s = emptyProspectState({ trust: 2 });
  const path = [s.trust];
  for (const want of [10, 10, 10, 10, 10, 10, 10, 10, 10]) {
    s = mergeProspectState(s, { trust: want });
    path.push(s.trust);
  }
  assert.deepEqual(path, [2, 3, 4, 5, 6, 7, 8, 9, 10, 10], "trust rises gradually, then holds at the ceiling");
});

test("trust stays within [0,10] and defaults to prior when the model omits it", () => {
  const prior = { ...emptyProspectState(), trust: 4 };
  assert.equal(mergeProspectState(prior, {}).trust, 4, "no proposed trust -> hold");
  assert.equal(mergeProspectState({ ...emptyProspectState(), trust: 0 }, { trust: -5 }).trust, 0, "floor");
  assert.equal(mergeProspectState({ ...emptyProspectState(), trust: 10 }, { trust: 99 }).trust, 10, "ceiling");
});

// ── disclosure is monotonic (you don't un-tell your name) ────────────────────

test("disclosure only ever turns ON", () => {
  const prior = { ...emptyProspectState(), disclosed: { name: true, problem: false, numbers: false, sensitive: false } };
  const next = mergeProspectState(prior, { disclosed: { name: false, problem: true } });
  assert.equal(next.disclosed.name, true, "name stays disclosed even if the model says false");
  assert.equal(next.disclosed.problem, true, "problem newly disclosed");
  assert.equal(next.disclosed.numbers, false);
});

// ── concern recall: resolved stays resolved; parked resurfaces once ──────────

test("a RESOLVED concern cannot be re-raised (no objection replay)", () => {
  const prior = { ...emptyProspectState(), concerns: [{ id: "price", topic: "the fee is a lot", status: "resolved", intensity: 3, raisedTurn: 1 }] };
  const next = mergeProspectState(prior, { concerns: [{ id: "price", topic: "wait, the fee again", status: "live", intensity: 5 }] });
  const price = next.concerns.find((c) => c.id === "price");
  assert.equal(price.status, "resolved", "resolved is sticky — the wall/replay loop can't happen");
});

test("a PARKED concern may resurface at most once, softer", () => {
  let s = { ...emptyProspectState(), concerns: [{ id: "spouse", topic: "need to ask my wife", status: "parked", intensity: 4, raisedTurn: 2, resurfacedOnce: false }] };
  s = mergeProspectState(s, { concerns: [{ id: "spouse", topic: "still, my wife", status: "live", intensity: 5 }] });
  let spouse = s.concerns.find((c) => c.id === "spouse");
  assert.equal(spouse.status, "live", "first resurfacing allowed");
  assert.ok(spouse.intensity <= 4, "resurfaces softer, not harder");
  assert.equal(spouse.resurfacedOnce, true);

  s = mergeProspectState({ ...s, concerns: s.concerns.map((c) => ({ ...c, status: "parked" })) }, { concerns: [{ id: "spouse", topic: "my wife again", status: "live", intensity: 5 }] });
  spouse = s.concerns.find((c) => c.id === "spouse");
  assert.equal(spouse.status, "parked", "second resurfacing is refused");
});

test("brand-new concerns are always allowed (fresh objections still fire)", () => {
  const prior = emptyProspectState();
  const next = mergeProspectState(prior, { concerns: [{ id: "scam", topic: "is this a scam", status: "live", intensity: 4 }] });
  assert.equal(next.concerns.length, 1);
  assert.equal(next.concerns[0].status, "live");
});

// ── disclosure gates map trust to the chain of the sale ──────────────────────

test("disclosure allowances follow the trust gates", () => {
  assert.deepEqual(disclosureAllowances(2), { name: false, problem: false, numbers: false, hearPitch: false, fee: false, close: false });
  const at5 = disclosureAllowances(5);
  assert.equal(at5.name, true);
  assert.equal(at5.problem, true);
  assert.equal(at5.numbers, true);
  assert.equal(at5.hearPitch, false, "won't sit for the pitch until trust 6");
  assert.equal(disclosureAllowances(8).close, true, "close opens at 8");
  assert.equal(DISCLOSURE_GATES.close, 8);
});

// ── tag parse/strip ──────────────────────────────────────────────────────────

test("parseProspectState reads the last tag; strip removes all", () => {
  const text = 'I owe about forty grand. <PROSPECT_STATE>{"trust":4,"mood":"warming"}</PROSPECT_STATE>';
  const parsed = parseProspectState(text);
  assert.equal(parsed.trust, 4);
  assert.equal(stripProspectStateTag(text).trim(), "I owe about forty grand.");
  assert.equal(parseProspectState("no tag here"), null);
});

test("fishing flag is set at session start and the model cannot flip it", () => {
  const prior = emptyProspectState({ fishing: true });
  const next = mergeProspectState(prior, { fishing: false, trust: 3 });
  assert.equal(next.fishing, true, "fishing persona is locked for the session");
});

test("formatProspectStateForHeader renders the ledger + the movement rules", () => {
  const header = formatProspectStateForHeader({ turn: 3, trust: 4, mood: "warming", disclosed: { name: true }, concerns: [{ id: "price", topic: "fee is a lot", status: "engaged", intensity: 3 }], fishing: false });
  assert.ok(header.includes("Trust: 4/10"));
  assert.ok(header.includes("fee is a lot [engaged"));
  assert.ok(/AT MOST 1 point/.test(header), "the clamp rule is stated to the model too");
  assert.ok(/STAYS resolved/.test(header), "recall rule stated");
});
