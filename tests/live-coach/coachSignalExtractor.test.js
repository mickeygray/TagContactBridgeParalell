"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractTurnSignals, extractCapturedFacts } = require("../../packages/shared-services/src/coachSignalExtractor");
const { reduceCoachPhase } = require("../../packages/shared-services/src/coachPhaseMachine");

const agent = (text) => ({ role: "agent", text });
const prospect = (text) => ({ role: "prospect", text });

test("agent markers fire on the WYNN script lines", () => {
  assert.equal(extractTurnSignals(agent("Can I ask a few quick questions?")).discoveryAsked, true);
  assert.equal(extractTurnSignals(agent("once we file a Power of Attorney, Form 2848, we can act for you")).representationFramed, true);
  assert.equal(extractTurnSignals(agent("The flat legal fee for representation is $1,800.")).feeQuoted, true);
  assert.equal(extractTurnSignals(agent("Can I get your Social Security Number to complete the POA?")).infoCollectionStarted, true);
  assert.equal(extractTurnSignals(agent("So to summarize, we'll file your POA — welcome call within one business day.")).closeSummary, true);
  assert.equal(extractTurnSignals(agent("Let me explain what we typically see in cases like yours.")).expertExplained, true);
});

test("agent markers do NOT fire on a prospect turn", () => {
  const s = extractTurnSignals(prospect("The flat fee is $1,800? That's a lot."));
  assert.equal(s.feeQuoted, false);
});

test("prospect turns capture discovery facts", () => {
  assert.deepEqual([...extractCapturedFacts(prospect("It's federal, around thirty-two thousand."))], ["balance"]);
  assert.deepEqual([...extractCapturedFacts(prospect("I didn't file 2021 or 2022."))], ["unfiled_years"]);
  assert.ok(extractCapturedFacts(prospect("they're taking money out of my paycheck")).has("collection_status"));
  assert.ok(extractCapturedFacts(prospect("I'm a W-2 employee at a warehouse")).has("income_type"));
  assert.ok(extractCapturedFacts(prospect("I can't pay that all at once")).has("ability_to_pay"));
});

test("an agent QUESTION does not capture a fact (only the prospect's answer does)", () => {
  assert.equal(extractCapturedFacts(agent("How much do you owe right now?")).size, 0);
});

test("end to end: replaying a mini WYNN call drives the phase machine intro -> payment", () => {
  const turns = [
    agent("Hi Linda, this is Marcus with Wynn Tax. Can I ask a few quick questions?"),
    prospect("Sure. It's federal, around thirty-two thousand."),
    prospect("I didn't file 2021 or 2022, and they're taking money out of my paycheck."),
    prospect("I'm a W-2 employee and honestly I can't pay much all at once."),
    agent("Here's what we typically see in cases like yours."),
    agent("The first step is getting you represented — we file a Power of Attorney, Form 2848."),
    agent("The flat legal fee for representation is $1,800."),
  ];

  let phaseState; // seed undefined
  const captured = new Set();
  const reached = [];
  for (let i = 0; i < turns.length; i += 1) {
    for (const id of extractCapturedFacts(turns[i])) captured.add(id);
    const signals = { ...extractTurnSignals(turns[i]), capturedFacts: [...captured], turnCount: i };
    const r = reduceCoachPhase(phaseState, signals);
    phaseState = r.state;
    reached.push(phaseState.phase);
  }

  // It walks the arc and lands on payment after the fee is quoted, never skipping
  // ahead on a stray signal.
  assert.equal(reached[0], "discovery"); // first agent question
  assert.equal(phaseState.phase, "payment"); // ends on the fee
  assert.ok(reached.includes("expert"));
  assert.ok(reached.includes("pitch"));
  // core discovery was captured along the way
  assert.ok(captured.has("balance") && captured.has("unfiled_years") && captured.has("collection_status"));
});
