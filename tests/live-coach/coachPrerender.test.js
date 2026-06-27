"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseOpportunities,
  predictOpportunities,
  prerenderCard,
  prerenderCards,
  matchCard,
} = require("../../packages/shared-services/src/coachPrerender");

test("predictOpportunities runs the reader and normalizes the list", async () => {
  const runner = async () => ({ ok: true, json: { opportunities: [
    { id: "o1", label: "price objection", cue: "that's a lot, can't pay all at once", skillKey: null, priority: 9 },
    { label: "asks how long", cue: "how long does this take" }, // missing id -> defaulted
    { nope: true }, // no label -> dropped
  ] } });
  const opps = await predictOpportunities({ transcript: "...", phase: "payment", runner });
  assert.equal(opps.length, 2);
  assert.equal(opps[0].label, "price objection");
  assert.equal(opps[1].id, "opp1"); // defaulted id
});

test("the agent's interview is fodder — case context reaches the reader + the pre-render", async () => {
  let predictPrompt = "";
  let renderPrompt = "";
  const reader = async (req) => { predictPrompt = req.prompt; return { ok: true, json: { opportunities: [{ id: "o1", label: "price", cue: "too much" }] } }; };
  const composerRunner = async (req) => { renderPrompt = req.prompt; return { ok: true, json: { action: "compose", read: "r", steer: "s" } }; };
  const caseContext = "owes $32k federal, 2 unfiled years, wage garnishment active";

  const opps = await predictOpportunities({ transcript: "...", phase: "payment", caseContext, runner: reader });
  await prerenderCard(opps[0], { composerRunner, phase: "payment", caseContext });

  assert.match(predictPrompt, /wage garnishment active/); // reader predicts around the case
  assert.match(renderPrompt, /wage garnishment active/); // cards written around the case
});

test("predictOpportunities never breaks — no runner or throw yields []", async () => {
  assert.deepEqual(await predictOpportunities({ transcript: "x" }), []);
  const boom = async () => { throw new Error("down"); };
  assert.deepEqual(await predictOpportunities({ transcript: "x", runner: boom }), []);
});

test("prerenderCard renders an opportunity into a ready card via the composer", async () => {
  const composerRunner = async (req) => ({ ok: true, json: { action: "compose", kind: "objection", severity: "warn", read: "cost resistance", steer: "anchor value", try: "most handle it at once" } });
  const card = await prerenderCard({ id: "o1", label: "price objection", cue: "eighteen hundred is a lot", skillKey: null }, { composerRunner, phase: "payment", now: 1000 });
  assert.equal(card.label, "price objection");
  assert.equal(card.card.kind, "objection");
  assert.equal(card.card.read, "cost resistance");
});

test("prerenderCards renders the whole set in parallel (the blast), dropping failures", async () => {
  let n = 0;
  const composerRunner = async () => {
    n += 1;
    if (n === 2) throw new Error("one spawn failed");
    return { ok: true, json: { action: "compose", read: "r", steer: "s" } };
  };
  const opps = [
    { id: "a", label: "x", cue: "alpha" },
    { id: "b", label: "y", cue: "bravo" },
    { id: "c", label: "z", cue: "charlie" },
  ];
  const cards = await prerenderCards(opps, { composerRunner, phase: "pitch" });
  assert.equal(cards.length, 2); // the failed one dropped, others survive
});

test("matchCard instantly surfaces a pre-rendered card by skill-key match (no model)", () => {
  const cards = [
    { id: "a", label: "not interested", cue: "not interested no thanks", skillKey: "obj_not_interested", card: { read: "..." } },
    { id: "b", label: "trust", cue: "sounds like a scam", skillKey: "obj_dont_trust_tax_companies", card: { read: "..." } },
  ];
  const hit = matchCard({ role: "prospect", text: "honestly i'm not interested, no thanks" }, cards);
  assert.equal(hit.id, "a");
});

test("matchCard falls back to cue-word overlap, and returns null on no match", () => {
  const cards = [{ id: "a", label: "timeline", cue: "how long does this whole process take", skillKey: null, card: {} }];
  assert.equal(matchCard({ text: "okay but how long does this process take exactly" }, cards).id, "a");
  assert.equal(matchCard({ text: "the weather is nice today" }, cards), null);
});
