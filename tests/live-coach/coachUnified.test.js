"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildUnifiedRequest, parseUnifiedResult, summarizeSpine, UNIFIED_SYSTEM } = require("../../packages/shared-services/src/coachUnified");

test("the unified system carries the method backbone + asks for all three parts", () => {
  assert.match(UNIFIED_SYSTEM, /THE TAX GROUP METHOD/);
  assert.match(UNIFIED_SYSTEM, /guidance/);
  assert.match(UNIFIED_SYSTEM, /spine/);
  assert.match(UNIFIED_SYSTEM, /packets/);
  assert.match(UNIFIED_SYSTEM, /APPROVED REPRESENTATION METHODOLOGY/); // the reference body is embedded
});

test("buildUnifiedRequest feeds the full transcript + the prior spine", () => {
  const req = buildUnifiedRequest({
    transcript: "Agent: hi\nProspect: I owe 32k and they're garnishing me",
    priorSpine: { accomplished: ["confirmed identity", "captured balance"], next: ["get collection status"], phase: "discovery" },
  });
  assert.match(req.prompt, /PRIOR call-spine/);
  assert.match(req.prompt, /confirmed identity; captured balance/);
  assert.match(req.prompt, /garnishing me/);
  assert.equal(req.schema.required.includes("guidance"), true);
});

test("summarizeSpine handles cold start + a populated spine", () => {
  assert.match(summarizeSpine(null), /start of call/);
  assert.match(summarizeSpine({ accomplished: ["a"], next: ["b"], phase: "pitch" }), /accomplished: a/);
});

test("parseUnifiedResult returns the three-part object", () => {
  const r = parseUnifiedResult({ json: {
    guidance: { read: "price resistance", steer: "anchor full then split", try: "half today, balance in 30" },
    spine: { accomplished: ["quoted fee"], next: ["handle the cost", "collect SSN"], phase: "payment" },
    packets: [
      { cue: "I need to think about it", read: "stall", steer: "isolate the real reason", try: "is it cost or trust?" },
      { cue: "talk to my spouse", read: "decision maker", steer: "get them on the line" },
    ],
  }});
  assert.equal(r.guidance.steer, "anchor full then split");
  assert.deepEqual(r.spine.next, ["handle the cost", "collect SSN"]);
  assert.equal(r.spine.phase, "payment");
  assert.equal(r.packets.length, 2);
  assert.equal(r.packets[0].id, "pkt0");
  assert.equal(r.packets[0].cue, "I need to think about it");
});

test("parseUnifiedResult: empty guidance => null; missing packets => []", () => {
  assert.equal(parseUnifiedResult({ json: { guidance: { read: "", steer: "", try: "" }, spine: {} } }), null);
  const r = parseUnifiedResult({ json: { guidance: { steer: "do x" }, spine: { accomplished: [], next: [] } } });
  assert.deepEqual(r.packets, []);
  assert.deepEqual(r.spine.accomplished, []);
});

test("parseUnifiedResult: a failed runner result yields null (never crashes the loop)", () => {
  assert.equal(parseUnifiedResult({ ok: false, error: "spawn down" }), null);
});
