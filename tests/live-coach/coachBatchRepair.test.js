"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEEP_PULL,
  REACTOR,
  repairGuidanceRow,
  parseBatchGuidance,
} = require("../../packages/shared-services/src/coachBatchRunner");

const DEEP_KEYS = ["sessionId", "uii", "agentEmail", "currentSection", "beats", "remember", "says", "priorFlags"];
const REACTOR_KEYS = ["sessionId", "uii", "agentEmail", "mode", "read", "steer", "say", "try"];

test("deep repair: a near-empty row still gets EVERY key (arrays default [])", () => {
  const out = repairGuidanceRow({ sessionId: "coach-A" }, DEEP_PULL);
  for (const k of DEEP_KEYS) assert.ok(k in out, `missing key ${k}`);
  assert.equal(out.currentSection, null);
  assert.deepEqual(out.beats, []);
  assert.deepEqual(out.remember, []);
  assert.deepEqual(out.says, []);
  assert.deepEqual(out.priorFlags, []);
});

test("deep repair: beats given as bare strings become {point, status:'pending'}", () => {
  const out = repairGuidanceRow({ sessionId: "coach-A", beats: ["State the fee", { point: "Anchor full", status: "HIT" }] }, DEEP_PULL);
  assert.equal(out.beats.length, 2);
  assert.deepEqual(out.beats[0], { point: "State the fee", status: "pending" });
  assert.equal(out.beats[1].status, "hit", "enum is lowercased + validated");
});

test("deep repair: a point-less beat survives when it carries a beatId (compact status overlay)", () => {
  const out = repairGuidanceRow({ sessionId: "a", beats: [{ beatId: "anchor_full", status: "hit" }, { status: "pending" }] }, DEEP_PULL);
  assert.equal(out.beats.length, 1, "the beatId-only beat is kept; the truly-empty one is dropped");
  assert.equal(out.beats[0].beatId, "anchor_full");
  assert.equal(out.beats[0].status, "hit");
  assert.ok(!("point" in out.beats[0]), "no point key when none supplied (client renders it from the catalog)");
});

test("deep repair: a bad status / kind / say-type is clamped to the safe default", () => {
  const out = repairGuidanceRow({
    sessionId: "coach-A",
    beats: [{ point: "x", status: "banana" }],
    remember: [{ text: "y", kind: "whatever" }],
    says: [{ type: "spaceship", text: "z" }],
  }, DEEP_PULL);
  assert.equal(out.beats[0].status, "pending");
  assert.equal(out.remember[0].kind, "watch");
  assert.equal(out.says[0].type, "line");
});

test("deep repair: exactly one say is rec — none marked -> first wins; many -> first marked", () => {
  const none = repairGuidanceRow({ sessionId: "a", says: [{ type: "objection", text: "1" }, { type: "tactic", text: "2" }] }, DEEP_PULL);
  assert.equal(none.says.filter((s) => s.rec).length, 1);
  assert.equal(none.says[0].rec, true);

  const many = repairGuidanceRow({ sessionId: "a", says: [{ text: "1" }, { rec: true, text: "2" }, { rec: true, text: "3" }] }, DEEP_PULL);
  assert.equal(many.says.filter((s) => s.rec).length, 1);
  assert.equal(many.says[1].rec, true, "the first marked rec survives");
});

test("deep repair: says as a bare string is wrapped into a line", () => {
  const out = repairGuidanceRow({ sessionId: "a", says: ["just say this"] }, DEEP_PULL);
  assert.equal(out.says.length, 1);
  assert.deepEqual(out.says[0], { type: "line", tag: null, rec: true, text: "just say this" });
});

test("reactor repair: a line that landed at the top level is recovered into say", () => {
  const fromTry = repairGuidanceRow({ sessionId: "a", mode: "reaction", read: "r", steer: "s", try: "say this" }, REACTOR);
  assert.equal(fromTry.say.text, "say this");
  assert.equal(fromTry.say.type, "line");
  assert.equal(fromTry.try, "say this", "try mirrors say.text for the dispatch path");

  const fromText = repairGuidanceRow({ sessionId: "a", mode: "reaction", text: "or this" }, REACTOR);
  assert.equal(fromText.say.text, "or this");
});

test("reactor repair: mode is inferred when missing or bad (say -> reaction; none -> quiet)", () => {
  const withSay = repairGuidanceRow({ sessionId: "a", say: { type: "objection", text: "x" } }, REACTOR);
  assert.equal(withSay.mode, "reaction");
  const noSay = repairGuidanceRow({ sessionId: "a", read: "just a read" }, REACTOR);
  assert.equal(noSay.mode, "quiet");
  assert.equal(noSay.say, null);
  assert.equal(noSay.try, null);
  const badMode = repairGuidanceRow({ sessionId: "a", mode: "GUIDEPOST", say: { text: "x" } }, REACTOR);
  assert.equal(badMode.mode, "reaction", "an off-enum mode falls back to inference");
});

test("reactor repair: every key present even on a bare row", () => {
  const out = repairGuidanceRow({ sessionId: "a" }, REACTOR);
  for (const k of REACTOR_KEYS) assert.ok(k in out, `missing key ${k}`);
});

test("repair never throws on garbage rows", () => {
  for (const junk of [null, undefined, 42, "a string", [], { say: 5 }]) {
    const deep = repairGuidanceRow(junk, DEEP_PULL);
    const react = repairGuidanceRow(junk, REACTOR);
    assert.ok(deep && typeof deep === "object");
    assert.ok(react && typeof react === "object");
    assert.ok("_dropReason" in deep, "no routing keys -> flagged droppable");
  }
});

test("parse: a SINGLE object (not wrapped in guidance[]) is recovered", () => {
  const single = { sessionId: "coach-A", uii: "uii-A", currentSection: "2", beats: [{ point: "ask owed", status: "pending" }] };
  const parsed = parseBatchGuidance(single, { tier: DEEP_PULL });
  assert.equal(parsed.guidance.length, 1, "the lone object became one guidance row");
  assert.equal(parsed.guidance[0].sessionId, "coach-A");
  assert.equal(parsed.guidance[0].beats.length, 1);
});

test("parse auto-detects the tier per row when not told", () => {
  const mixed = {
    guidance: [
      { sessionId: "deep-one", beats: [{ point: "x", status: "hit" }] },
      { sessionId: "react-one", mode: "reaction", say: { type: "objection", text: "go" } },
    ],
  };
  const parsed = parseBatchGuidance(mixed); // no tier passed
  assert.ok(Array.isArray(parsed.guidance[0].beats), "row 1 repaired as deep");
  assert.equal(parsed.guidance[1].say.text, "go", "row 2 repaired as reactor");
});
