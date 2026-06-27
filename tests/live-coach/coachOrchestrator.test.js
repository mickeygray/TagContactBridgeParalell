"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCoachOrchestrator } = require("../../packages/shared-services/src/coachOrchestrator");

// A fake runner = a stand-in for the Haiku `claude -p` spawn. Records every call so
// we can assert WHEN the orchestrator spawns, and returns a canned feedback item.
function makeFakeRunner(json = { action: "compose", kind: "objection", severity: "warn", read: "price resistance", steer: "anchor the value", try: "most clients handle it at once" }) {
  const calls = [];
  const runner = async (req) => {
    calls.push(req);
    return { ok: true, json };
  };
  return { runner, calls };
}

test("a substantive prospect turn spawns the composer and the item lands in the channel", async () => {
  const { runner, calls } = makeFakeRunner();
  const orch = createCoachOrchestrator({ runner, now: () => 1000 });
  const r = await orch.ingestTurn({ role: "prospect", text: "That fee is a lot, I can't pay all at once." });
  assert.equal(r.spawned, true);
  assert.equal(calls.length, 1);
  assert.equal(r.state.feedback.length, 1);
  assert.equal(r.state.feedback[0].kind, "objection");
  assert.equal(r.state.feedback[0].source, "composer");
  assert.equal(r.mode, "reaction");
});

test("agent turns drive phase + the passive checklist but NEVER spawn a composer", async () => {
  const { runner, calls } = makeFakeRunner();
  const orch = createCoachOrchestrator({ runner, now: () => 1000 });
  const r = await orch.ingestTurn({ role: "agent", text: "Hi, this is Marcus calling from Wynn Tax — am I speaking with Linda?" });
  assert.equal(r.spawned, false);
  assert.equal(calls.length, 0);
  const steps = r.state.phase.steps;
  assert.ok(steps.find((s) => s.id === "identify_self").done);
  assert.ok(steps.find((s) => s.id === "identify_company").done);
  assert.ok(steps.find((s) => s.id === "confirm_prospect").done);
});

test("the DNC backstop pre-empts the composer (deterministic, no spawn) and forces compliance mode", async () => {
  const { runner, calls } = makeFakeRunner();
  const orch = createCoachOrchestrator({ runner, now: () => 1000 });
  const r = await orch.ingestTurn({ role: "prospect", text: "Take me off your list and stop calling me." });
  assert.equal(calls.length, 0); // the expensive model was never spawned for a DNC
  assert.equal(r.state.feedback[0].kind, "compliance");
  assert.equal(r.state.feedback[0].severity, "block");
  assert.equal(r.mode, "compliance");
});

test("a short filler prospect turn does not spawn", async () => {
  const { runner, calls } = makeFakeRunner();
  const orch = createCoachOrchestrator({ runner, now: () => 1000 });
  const r = await orch.ingestTurn({ role: "prospect", text: "uh huh" });
  assert.equal(r.spawned, false);
  assert.equal(calls.length, 0);
  assert.equal(r.mode, "quiet");
});

test("a WAIT from the composer spawns but yields no feedback item", async () => {
  const { runner } = makeFakeRunner({ action: "wait" });
  const orch = createCoachOrchestrator({ runner, now: () => 1000 });
  const r = await orch.ingestTurn({ role: "prospect", text: "okay sure that makes sense to me i guess" });
  assert.equal(r.spawned, true); // it DID spawn
  assert.equal(r.state.feedback.length, 0); // but WAIT => nothing rendered
  assert.equal(r.mode, "quiet");
});

test("a matched objection pulls its situation skill into the composer's system (90% pre-written) + tags the item", async () => {
  const { runner, calls } = makeFakeRunner();
  const orch = createCoachOrchestrator({ runner, now: () => 1000 });
  const r = await orch.ingestTurn({ role: "prospect", text: "honestly, i'm not interested, no thanks." });
  assert.equal(r.spawned, true);
  assert.match(calls[0].system, /Objection detected: Not interested/); // the pulled skill reached the spawn
  assert.ok(r.item.skillKeys.includes("obj_not_interested")); // provenance tagged on the item
});

test("the spawn gets a PHASE-specialized system (payment doctrine once the call is at payment)", async () => {
  const { runner, calls } = makeFakeRunner();
  const orch = createCoachOrchestrator({ runner, now: () => 1000 });
  await orch.ingestTurn({ role: "agent", text: "Can I ask a few quick questions?" });
  await orch.ingestTurn({ role: "prospect", text: "I owe about thirty grand, didn't file 2021 or 2022, and they're garnishing me." });
  await orch.ingestTurn({ role: "agent", text: "We file a Power of Attorney, Form 2848. The flat legal fee is $1,800." });
  const r = await orch.ingestTurn({ role: "prospect", text: "That's a lot, I can't pay all at once." });
  assert.ok(["pitch", "payment"].includes(orch.phase), `phase was ${orch.phase}`);
  const lastReq = calls[calls.length - 1];
  // the composer that fired on the objection was pre-loaded with the phase doctrine
  assert.match(lastReq.system, /FOCUS —/);
  if (orch.phase === "payment") assert.match(lastReq.system, /anchor the flat fee|cost of inaction/);
  void r;
});

test("recall is handed the turn + state and its candidates reach the composer prompt", async () => {
  const { runner, calls } = makeFakeRunner();
  const recall = (turn, ctx) => [{ label: "money_pressure", guidance: "acknowledge cost, reframe to value of representation" }];
  const orch = createCoachOrchestrator({ runner, recall, now: () => 1000 });
  await orch.ingestTurn({ role: "prospect", text: "Eighteen hundred is steep for me right now." });
  assert.match(calls[0].prompt, /money_pressure/);
  assert.match(calls[0].prompt, /reframe to value/);
});

test("end to end: a scripted call advances phase and spawns ONLY on prospect substance", async () => {
  const { runner, calls } = makeFakeRunner();
  const orch = createCoachOrchestrator({ runner, now: () => 1000 });
  const turns = [
    { role: "agent", text: "Hi Linda, this is Marcus with Wynn Tax. Can I ask a few quick questions?" },
    { role: "prospect", text: "Sure. It's federal, around thirty-two thousand, I didn't file 2021 or 2022, and they're garnishing my wages." },
    { role: "agent", text: "Here's what we typically see in cases like yours." },
    { role: "agent", text: "We file a Power of Attorney, Form 2848, to get you represented. The flat legal fee is $1,800." },
    { role: "prospect", text: "That's a lot of money, I'm really not sure I can do that." },
  ];
  let last;
  for (const turn of turns) last = await orch.ingestTurn(turn);

  // composers fired ONLY on the two substantive prospect turns
  assert.equal(calls.length, 2);
  // the call walked the arc toward the pitch/payment
  assert.ok(["pitch", "payment"].includes(orch.phase), `phase was ${orch.phase}`);
  // discovery was captured along the way and shows on the passive checklist
  assert.ok(last.state.discovery.items.find((i) => i.id === "balance").captured);
  assert.ok(last.state.discovery.items.find((i) => i.id === "collection_status").captured);
  // rev advanced once per turn (server-authoritative, ordered)
  assert.equal(last.state.rev, turns.length);
});
