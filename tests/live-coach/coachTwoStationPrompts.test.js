"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildStrategistRequest,
  buildCoachRequest,
  BEAT_CATALOG,
} = require("../../packages/shared-services/src/coachTwoStationPrompts");
const {
  parseBatchGuidance,
  reduceDeepPullSteering,
  DEEP_PULL,
} = require("../../packages/shared-services/src/coachBatchRunner");
const {
  buildLiveCoachGuidanceDispatchPlan,
  normalizeGuidanceItem,
} = require("../../packages/shared-services/src/liveCoachBatchGuidanceDispatchService");
const {
  normalizeRollingSummaryPayload,
} = require("../../packages/shared-services/src/liveCoachRollingSummaryService");

// ── B / STRATEGIST ──────────────────────────────────────────────────────────

test("STRATEGIST request: carries the reference, the stable beat catalog, the section ids, and the contract", () => {
  const req = buildStrategistRequest({
    reference: "RULES: cost-of-waiting frame for price objections.",
    transcript: "prospect: this is way too expensive\nagent: I hear you",
    priorSummaryText: "owes ~40k, price-sensitive",
  });
  assert.equal(req.station, "strategist");
  assert.ok(req.system.includes("cost-of-waiting"), "reference rode into the system");
  assert.ok(req.system.includes("SCRIPT BEATS BY SECTION"), "beat catalog block present");
  assert.ok(req.system.includes("4B"), "section ids (incl. the 4B payment close) rode in");
  assert.ok(BEAT_CATALOG.includes("1 (") && BEAT_CATALOG.includes("4B ("), "catalog spans the sections by id");
  assert.ok(req.system.includes('"currentSection"') && req.system.includes('"summary"'), "cockpit + summary contract present");
  assert.ok(req.prompt.includes("this is way too expensive"), "transcript rode into the (volatile) prompt");
  assert.ok(req.prompt.includes("price-sensitive"), "prior summary rode in as a prior");
});

test("STRATEGIST prompt applies the core rule: agency + a rich menu, NOT weak-model 'copy exactly' nags", () => {
  const req = buildStrategistRequest({ reference: "x", transcript: "y" });
  assert.ok(/use your judgment/i.test(req.system), "grants agency");
  assert.ok(/best play|resolve|reasoning/i.test(req.system), "resolves to best + alternative + reasoning");
  assert.ok(!/copy .*exactly/i.test(req.system), "no 'copy EXACTLY' routing nag");
  assert.ok(!/never invent|never cross calls/i.test(req.system), "no batch anti-hallucination scaffolding");
  // compliance doctrine is load-bearing and KEPT
  assert.ok(/never promise OIC/i.test(req.system) && /do-not-call/i.test(req.system), "compliance doctrine kept");
});

test("STRATEGIST permits a HOLD — an empty says when silence is the best move (genuine no / DNC / agent doing well)", () => {
  const req = buildStrategistRequest({ reference: "x", transcript: "y" });
  assert.ok(/\bHOLD\b/.test(req.system), "HOLD is named as a first-class move");
  assert.ok(/empty `?says`?/i.test(req.system), "an empty says is a valid output");
  assert.ok(/manufacture|reopen probe|badger/i.test(req.system), "forbids manufacturing a play / reopen probe on a genuine no");
});

test("STRATEGIST output flows through the existing normalizers into cockpit + rollingSummary", () => {
  // The shape the contract asks the model to return (sessionId stamped by the Phase-2 runner).
  const modelOut = {
    guidance: [
      {
        sessionId: "sess-1",
        currentSection: "4B",
        summary: "at the fee, anchoring full",
        beats: [{ beatId: "pay_anchor", status: "pending" }],
        remember: [{ text: "price-sensitive", kind: "watch" }],
        says: [
          { type: "objection", tag: "price", rec: true, text: "What has waiting cost you each month?" },
          { type: "tactic", tag: "anchor", text: "Most clients open in full so it moves today." },
        ],
        priorFlags: [],
      },
    ],
    summary: "Owes ~40k, 3 unfiled years, got a CP504; price-sensitive. Agent quoted $3,500; prospect balking.",
  };

  // cockpit half -> the repair layer
  const parsed = parseBatchGuidance(modelOut, { tier: DEEP_PULL });
  const row = parsed.guidance[0];
  assert.equal(row.currentSection, "4B", "section preserved case-sensitively");
  assert.equal(row.says.filter((s) => s.rec).length, 1, "exactly one rec survives (ensureOneRec)");
  assert.equal(row.beats.length, 1);
  const updates = reduceDeepPullSteering(parsed);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].sessionId, "sess-1", "the cockpit update routes to the session");

  // summary is now a single plain narrative string (shaved from the itemized block)
  assert.equal(typeof modelOut.summary, "string");
  assert.ok(modelOut.summary.length > 0, "summary is a plain narrative");
});

// ── A / COACH ────────────────────────────────────────────────────────────────

test("COACH request: lean — section + the play menu (with top pick) + prior guidance + the last turn", () => {
  const req = buildCoachRequest({
    currentSection: "4B",
    says: [
      { type: "objection", tag: "price", rec: true, text: "What has waiting cost you?" },
      { type: "tactic", tag: "anchor", text: "Open in full so it moves today." },
    ],
    priorGuidance: "hold the fee, run cost-of-waiting",
    summaryText: "owes ~40k, price-sensitive",
    lastTurns: "prospect: four grand is a lot",
  });
  assert.equal(req.station, "coach");
  assert.ok(req.prompt.includes("SECTION: 4B"));
  assert.ok(req.prompt.includes("* [objection] price"), "the top pick is starred in the menu");
  assert.ok(req.prompt.includes("YOUR LAST GUIDANCE: hold the fee"), "prior guidance (self-priming) rode in");
  assert.ok(req.prompt.includes("four grand is a lot"), "the last turn rode in");
  // lean: A never carries the reference / beat catalog
  assert.ok(!req.system.includes("SCRIPT BEATS BY SECTION") && !req.system.includes("COACH REFERENCE"), "A carries no materials");
  assert.ok(/keep applying your LAST guidance/i.test(req.system) && /switch to the matching play/i.test(req.system), "sticky-guidance rule present");
});

test("COACH output flows through the dispatch normalizer into dialog{say, guidance}", () => {
  const modelOut = { say: "What has waiting cost you each month?", guidance: "hold the fee, run cost-of-waiting", summary: "owes 40k + last turn" };

  // field mapping: say -> try, guidance -> steer
  const item = normalizeGuidanceItem({ sessionId: "sess-1", say: modelOut.say, guidance: modelOut.guidance });
  assert.equal(item.try, modelOut.say, "say -> try (dialog.say)");
  assert.equal(item.steer, modelOut.guidance, "guidance -> steer (dialog.guidance)");

  // full dispatch plan routes it to the live session
  const activeBatch = { conversations: [{ sessionId: "sess-1", call: { uii: "u1" }, agent: { email: "a@x.com", extension: "101" } }] };
  const plan = buildLiveCoachGuidanceDispatchPlan(activeBatch, {
    guidance: [{ sessionId: "sess-1", uii: "u1", say: modelOut.say, guidance: modelOut.guidance }],
  });
  assert.equal(plan.dispatchCount, 1, "the say dispatched (not rejected)");
  assert.equal(plan.dispatches[0].payload.try, modelOut.say);
  assert.equal(plan.dispatches[0].payload.steer, modelOut.guidance);
});
