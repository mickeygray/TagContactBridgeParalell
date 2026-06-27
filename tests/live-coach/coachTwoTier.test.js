"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDeepPullRequest, parseDeepPull, DEEP_PULL_SYSTEM } = require("../../packages/shared-services/src/coachDeepPull");
const { buildReactorRequest, parseReactor, renderSteering, REACTOR_SCHEMA } = require("../../packages/shared-services/src/coachReactor");

// ---- coachDeepPull (the once/min Opus strategist) ----

test("deep-pull system carries the Tax Group method backbone + asks for the four parts", () => {
  assert.match(DEEP_PULL_SYSTEM, /strategic tier/);
  assert.match(DEEP_PULL_SYSTEM, /APPROVED REPRESENTATION METHODOLOGY/); // the reference body is embedded
  assert.match(DEEP_PULL_SYSTEM, /focus/);
  assert.match(DEEP_PULL_SYSTEM, /callFlow/);
  assert.match(DEEP_PULL_SYSTEM, /summary/);
  assert.match(DEEP_PULL_SYSTEM, /watchFor/);
});

test("buildDeepPullRequest feeds prior summary + spine + the transcript", () => {
  const req = buildDeepPullRequest({
    transcript: "Agent: hi\nProspect: I owe 32k and they're garnishing me",
    priorSummary: "Confirmed identity; captured 32k federal.",
    priorSpine: { accomplished: ["confirmed identity"], next: ["pitch representation"], phase: "discovery" },
  });
  assert.match(req.prompt, /PRIOR summary: Confirmed identity/);
  assert.match(req.prompt, /accomplished: confirmed identity/);
  assert.match(req.prompt, /garnishing me/);
  assert.equal(req.schema.required.includes("focus"), true);
});

test("parseDeepPull returns the steering shape the reactor consumes", () => {
  const steering = parseDeepPull({ json: {
    focus: "Recoiled at the fee — anchor full, then walk the ladder.",
    callFlow: { accomplished: ["quoted $1800 fee"], next: ["handle the cost", "collect SSN"], phase: "payment" },
    summary: "W-2, $32k federal, 2 unfiled years, active garnishment; quoted $1800.",
    watchFor: [
      { cue: "can you do payments?", steer: "two-month split first, frame as structure" },
      { cue: "let me think about it", steer: "isolate cost vs trust" },
    ],
  }});
  assert.equal(steering.focus, "Recoiled at the fee — anchor full, then walk the ladder.");
  assert.deepEqual(steering.callFlow.next, ["handle the cost", "collect SSN"]);
  assert.equal(steering.callFlow.phase, "payment");
  assert.equal(steering.watchFor.length, 2);
  assert.equal(steering.watchFor[0].cue, "can you do payments?");
});

test("parseDeepPull: empty/failed => null", () => {
  assert.equal(parseDeepPull({ json: { focus: "", callFlow: {}, summary: "" } }), null);
  assert.equal(parseDeepPull({ ok: false, error: "spawn down" }), null);
});

// ---- coachReactor (the per-turn Haiku reactor) ----

test("reactor caches [reference + steering] in system, keeps only the turn volatile", () => {
  const steering = parseDeepPull({ json: {
    focus: "Anchor full, then split.",
    callFlow: { accomplished: ["quoted fee"], next: ["handle cost"], phase: "payment" },
    summary: "Quoted $1800.",
    watchFor: [{ cue: "too much", steer: "boomerang the garnishment" }],
  }});
  const req = buildReactorRequest({
    reference: "OBJECTIONS: price -> anchor full, walk the ladder.",
    steering,
    recentTurns: "Prospect: eighteen hundred is a lot",
  });
  // stable, cacheable system carries the reference + the steering
  assert.match(req.system, /RULES \/ OBJECTIONS/);
  assert.match(req.system, /CURRENT STRATEGY/);
  assert.match(req.system, /FOCUS .*Anchor full/);
  assert.match(req.system, /WATCH FOR:/);
  assert.match(req.system, /if \[too much\] -> boomerang/);
  // the only volatile part is the latest turn, in the prompt
  assert.match(req.prompt, /eighteen hundred is a lot/);
  assert.equal(req.system.includes("eighteen hundred"), false); // the turn must NOT leak into the cached system
});

test("renderSteering degrades gracefully with no steering yet", () => {
  assert.match(renderSteering(null), /no strategy yet/);
});

test("parseReactor returns the live line; empty say => null", () => {
  assert.deepEqual(parseReactor({ json: { say: "Anchor full first, then offer the split.", flag: "price" } }), {
    say: "Anchor full first, then offer the split.",
    flag: "price",
  });
  assert.equal(parseReactor({ json: { say: "" } }), null);
  assert.equal(parseReactor({ ok: false }), null);
  assert.equal(REACTOR_SCHEMA.required.includes("say"), true);
});

// ---- the contract: deep-pull output -> reactor input, end to end ----

test("the two tiers compose: deep-pull steering flows straight into the reactor prompt", () => {
  const steering = parseDeepPull({ json: {
    focus: "He's burned before — proof, not persuasion.",
    callFlow: { accomplished: ["captured CP504"], next: ["earn trust"], phase: "expert-guidance" },
    summary: "$18k, CP504, burned by a prior firm.",
    watchFor: [{ cue: "prove it", steer: "name the firm + invite a live look-up" }],
  }});
  const req = buildReactorRequest({ reference: "rules...", steering, recentTurns: "Prospect: how do I know you're legit" });
  // no transformation needed between the tiers — the parsed steering renders directly
  assert.match(req.system, /proof, not persuasion/);
  assert.match(req.system, /if \[prove it\] -> name the firm/);
});
