"use strict";

// PINS for the substance-floored turn accumulator (2026-07-08). The rules here are
// NOT invented — they replicate scripts/coach-eval/run-determinism2.js, whose ROBUST
// mode was the validated answer to the ~70% noise overfire. The last test replays the
// eval's own raw-stream expansion over a real fixture and asserts production fires
// EXACTLY as the validated eval math does.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  createCoachTurnAccumulator,
  classifyTurn,
  substWordCount,
  isGarble,
  MIN_WORDS,
} = require("../../packages/shared-services/src/coachTurnAccumulator");

test("partials NEVER count, no matter how substantive", () => {
  const acc = createCoachTurnAccumulator();
  const v = acc.commit({ text: "I owe forty thousand dollars to the IRS", final: false });
  assert.equal(v.counted, false);
  assert.equal(v.reason, "partial");
  assert.equal(acc.peek().sinceLastFire, 0);
});

test("substance floor: pure backchannel and sub-2-word turns are ticks, not counts", () => {
  const acc = createCoachTurnAccumulator();
  for (const noise of ["yeah", "mm-hm", "okay right", "No.", "uh um"]) {
    const v = acc.commit({ text: noise });
    assert.equal(v.counted, false, `"${noise}" should not count`);
    assert.equal(v.reason, "backchannel");
  }
  assert.equal(acc.peek().totalCounted, 0);
});

test("garble drop: bracketed / IVR / repeated-token noise never counts", () => {
  const acc = createCoachTurnAccumulator();
  for (const g of ["[static]", "[music playing]", "press one", "the the uh"]) {
    const v = acc.commit({ text: g });
    assert.equal(v.counted, false, `"${g}" should not count`);
    assert.equal(v.reason, "garble");
  }
  // the validated boundary (eval semantics, kept deliberately): a garble-pattern turn
  // that still carries >= 2 real words counts — the deterministic layer drops only
  // LITERAL noise and never judges meaning (that judgment belongs to A's gate).
  assert.equal(classifyTurn({ text: "press one for english" }).counted, true);
});

test("meaningful short turns DO count ('How much?' clears the floor; a lone 'No.' does not)", () => {
  assert.equal(classifyTurn({ text: "How much?" }).counted, true);
  assert.equal(classifyTurn({ text: "No." }).counted, false);
  assert.equal(substWordCount("How much?"), 2);
});

test("dedup: the same phrase can't be committed twice in a row", () => {
  const acc = createCoachTurnAccumulator();
  assert.equal(acc.commit({ text: "I already have someone handling it" }).counted, true);
  const dupe = acc.commit({ text: "I already have someone   handling it" }); // whitespace-normalized
  assert.equal(dupe.counted, false);
  assert.equal(dupe.reason, "duplicate");
  // a DIFFERENT turn then counts again
  assert.equal(acc.commit({ text: "And they charge me monthly" }).counted, true);
});

test("fires exactly on the Nth substantive turn, then resets the window", () => {
  const acc = createCoachTurnAccumulator({ threshold: 3 });
  const turns = [
    "I got your letter in the mail yesterday",  // 1
    "mm-hm",                                     // noise
    "What is this going to cost me?",            // 2
    "[static]",                                  // noise
    "Because I already tried settling this once", // 3 -> FIRE
    "That was two years ago maybe",              // 1 again
  ];
  const fires = turns.map((t) => acc.commit({ text: t }).fire);
  assert.deepEqual(fires, [false, false, false, false, true, false]);
  assert.equal(acc.peek().sinceLastFire, 1);
});

test("PARITY: production fires exactly as the validated eval math on a real fixture stream", () => {
  // replicate run-determinism2.js expandToStream + ROBUST fires() over fixture-tax-call-01
  const fx = require(path.join("..", "..", "scripts", "coach-eval", "fixture-tax-call-01.js"));
  const events = [];
  fx.turns.forEach((t, i) => {
    const words = String(t.text).split(/\s+/);
    if (words.length > 6) events.push({ final: false, text: words.slice(0, 3).join(" ") });
    if (words.length > 12) events.push({ final: false, text: words.slice(0, 8).join(" ") });
    events.push({ final: true, text: t.text });
    if (i % 2 === 1) events.push({ final: true, text: ["mm-hm", "yeah", "okay", "right"][i % 4] });
    if (i % 5 === 4) events.push({ final: true, text: "[static]" });
  });

  // the eval's ROBUST counter (verbatim math, minus its dedup-free simplification)
  let since = 0;
  let expectedFires = 0;
  for (const e of events) {
    if (!e.final) continue;
    const noise = isGarble(e.text) || substWordCount(e.text) < MIN_WORDS;
    if (!noise) since += 1;
    if (since >= 3) { expectedFires += 1; since = 0; }
  }

  const acc = createCoachTurnAccumulator({ threshold: 3 });
  let actualFires = 0;
  for (const e of events) {
    if (acc.commit({ text: e.text, final: e.final }).fire) actualFires += 1;
  }
  assert.ok(expectedFires > 0, "fixture must produce fires");
  assert.equal(actualFires, expectedFires, `production ${actualFires} != eval ${expectedFires}`);
});
