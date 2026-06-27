"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEEP_PULL,
  REACTOR,
  buildBatchGuidanceRequest,
  parseBatchGuidance,
  shouldFireCoach,
  reduceDeepPullSteering,
} = require("../../packages/shared-services/src/coachBatchRunner");

// Codex's REAL services — we run our output through them, not a copy.
const {
  buildActiveLiveCoachBatch,
  buildActiveLiveCoachChangeSet,
} = require("../../packages/shared-services/src/liveCoachBatchProjectionService");
const {
  buildLiveCoachGuidanceDispatchPlan,
} = require("../../packages/shared-services/src/liveCoachBatchGuidanceDispatchService");

const REFERENCE = "RULES: never promise a specific dollar outcome. OBJECTIONS: price -> cost-of-waiting frame.";

function nowIso() {
  return new Date().toISOString();
}

function sessionsFixture() {
  const now = nowIso();
  return [
    {
      id: "coach-A",
      status: "listening",
      lastEventAt: now,
      updatedAt: now,
      metadata: {
        source: "grpc-mongo",
        agentEmail: "sean@tag.com",
        agentName: "Sean",
        domain: "WYNN",
        caseId: "123456",
        uii: "uii-A",
      },
      memory: {
        transcripts: [
          { role: "agent", text: "So based on the analysis we can file the FTA." },
          { role: "prospect", text: "Honestly that sounds too expensive for me right now." },
        ],
      },
      callStrategy: "Resolve the fee objection with the cost-of-waiting frame, then re-anchor on the FTA.",
      callSummary: "WYNN case 123456; prospect raised price right after the FTA pitch.",
    },
    {
      id: "coach-B",
      status: "listening",
      lastEventAt: now,
      updatedAt: now,
      metadata: {
        source: "grpc-mongo",
        agentEmail: "dana@tag.com",
        domain: "TAG",
        uii: "uii-B",
      },
      memory: {
        transcripts: [{ role: "prospect", text: "What forms do I actually need to send in?" }],
      },
    },
  ];
}

test("reactor request: reference is in the cached system, the live turn is NOT", () => {
  const batch = buildActiveLiveCoachBatch(sessionsFixture(), {});
  const req = buildBatchGuidanceRequest(batch, { tier: REACTOR, reference: REFERENCE });

  assert.equal(req.tier, REACTOR);
  assert.equal(req.conversationCount, 2);
  // Reference + contract live in the stable system (the cacheable prefix).
  assert.ok(req.system.includes(REFERENCE), "reference must be in system");
  assert.ok(req.system.includes("Copy sessionId/uii/agentEmail EXACTLY"), "fill-in contract must be in system");
  assert.ok(req.system.includes('"say"'), "the response object skeleton must be fed to the model");
  // The volatile latest turn must be in the prompt, never baked into the cached system.
  assert.ok(req.prompt.includes("too expensive"), "latest turn must be in the prompt");
  assert.ok(!req.system.includes("too expensive"), "latest turn must NOT leak into the cached system");
  // The deep pull's steering rides into the prompt so the reactor can follow it.
  assert.ok(req.prompt.includes("cost-of-waiting frame"), "strategy must be rendered for the reactor");
  // Routing keys are surfaced so the model can echo them back.
  assert.ok(req.prompt.includes("sessionId=coach-A"), "sessionId must be visible to the model");
  assert.ok(req.prompt.includes("uii=uii-A"), "uii must be visible to the model");
});

test("deep schema carries the strategic state; reactor schema carries the live nudge", () => {
  const batch = buildActiveLiveCoachBatch(sessionsFixture(), {});
  const req = buildBatchGuidanceRequest(batch, { tier: DEEP_PULL, reference: REFERENCE });
  assert.equal(req.tier, DEEP_PULL);
  assert.ok(req.prompt.includes("full pass"), "deep pull does a full pass");
  // Deep pull = the strategic cockpit state.
  const props = req.schema.properties.guidance.items.properties;
  assert.ok(props.currentSection && props.beats && props.remember && props.says && props.priorFlags,
    "deep schema must carry currentSection/beats/remember/says/priorFlags");
  assert.ok(!props.read && !props.steer && !props.say, "deep schema omits the live nudge fields");
  // Reactor = the live nudge.
  const rp = buildBatchGuidanceRequest(batch, { tier: REACTOR }).schema.properties.guidance.items.properties;
  assert.ok(rp.read && rp.steer && rp.say, "reactor schema carries read/steer/say");
  assert.ok(!rp.beats && !rp.says, "reactor schema omits the deep state");
});

test("DIVIDE: parsed guidance routes through Codex's real dispatch plan, per agent", () => {
  const batch = buildActiveLiveCoachBatch(sessionsFixture(), {});

  // A model response: one good row, one uii-mismatch, one ghost session, one quiet.
  const modelRaw = {
    guidance: [
      {
        sessionId: "coach-A",
        uii: "uii-A",
        agentEmail: "sean@tag.com",
        mode: "reaction",
        read: "Price objection right after the pitch.",
        steer: "Run the cost-of-waiting frame before re-anchoring.",
        try: "What has waiting on this already cost you?",
        confidence: "high",
      },
      { sessionId: "coach-A", uii: "uii-WRONG", mode: "reaction", try: "should be rejected" },
      { sessionId: "coach-GHOST", mode: "reaction", try: "no such session" },
      { sessionId: "coach-B", agentEmail: "dana@tag.com", mode: "quiet" },
    ],
  };

  const parsed = parseBatchGuidance(modelRaw, { generatedAt: nowIso() });
  assert.equal(parsed.schemaVersion, "live-coach.batch-guidance.v2");

  const plan = buildLiveCoachGuidanceDispatchPlan(batch, parsed);

  // coach-A (valid) + coach-B (quiet is dispatchable) route; the other two reject.
  assert.equal(plan.dispatchCount, 2, "two rows should dispatch");
  assert.equal(plan.rejectedCount, 2, "two rows should be rejected");

  const reasons = plan.rejected.map((r) => r.reason).sort();
  assert.deepEqual(reasons, ["session-not-active", "uii-mismatch"]);

  // The good dispatch lands on the right agent/session — divided correctly.
  const seanDispatch = plan.dispatches.find((d) => d.target.agentEmail === "sean@tag.com");
  assert.ok(seanDispatch, "Sean's guidance must dispatch");
  assert.equal(seanDispatch.target.sessionId, "coach-A");
  assert.equal(seanDispatch.target.uii, "uii-A");
  assert.equal(seanDispatch.payload.try, "What has waiting on this already cost you?");

  // No guidance crossed to the wrong agent.
  const danaDispatch = plan.dispatches.find((d) => d.target.agentEmail === "dana@tag.com");
  assert.equal(danaDispatch.target.sessionId, "coach-B");
});

test("GATE: shouldFireCoach blocks when no one is on the phone", () => {
  // Empty floor -> never fire, either tier.
  const empty = buildActiveLiveCoachChangeSet([], {});
  assert.equal(shouldFireCoach(empty, { tier: REACTOR }).fire, false);
  assert.equal(shouldFireCoach(empty, { tier: DEEP_PULL }).fire, false);
  assert.equal(shouldFireCoach(empty, { tier: REACTOR }).reason, "no-active-conversations");
});

test("GATE: reactor fires only on changes; deep pull fires whenever calls are live", () => {
  const sessions = sessionsFixture();

  // First change-set vs an empty cursor -> everything is 'new' -> hasChanges true.
  const firstChanges = buildActiveLiveCoachChangeSet(sessions, {});
  assert.equal(firstChanges.activeConversationCount, 2);
  assert.equal(firstChanges.hasChanges, true);
  assert.equal(shouldFireCoach(firstChanges, { tier: REACTOR }).fire, true);

  // Feed that cursor back with the SAME sessions -> nothing changed.
  const steadyChanges = buildActiveLiveCoachChangeSet(sessions, { cursor: firstChanges.cursor });
  assert.equal(steadyChanges.activeConversationCount, 2);
  assert.equal(steadyChanges.hasChanges, false);

  // Reactor stays quiet on a no-change tick; deep pull still allowed (calls are live).
  assert.equal(shouldFireCoach(steadyChanges, { tier: REACTOR }).fire, false);
  assert.equal(shouldFireCoach(steadyChanges, { tier: REACTOR }).reason, "no-changes");
  assert.equal(shouldFireCoach(steadyChanges, { tier: DEEP_PULL }).fire, true);
});

test("DEEP STATE: deep pull reduces to per-session cockpit state (section/beats/remember/says/flags)", () => {
  const generatedAt = "2026-06-26T12:34:56.000Z";
  const deepRaw = {
    guidance: [
      {
        sessionId: "coach-A",
        uii: "uii-A",
        currentSection: "4B",
        beats: [
          { point: "State fee + PAUSE", status: "hit" },
          { point: "Anchor full first", status: "pending" },
        ],
        remember: [{ text: "Hasn't walked the ladder — anchor full first", kind: "watch" }],
        says: [
          { type: "objection", tag: "stop garnishment", rec: true, text: "Once we're filed the team can request a release." },
          { type: "tactic", tag: "boomerang the cost", text: "Eighteen hundred is fixed; the garnishment isn't." },
        ],
        priorFlags: [{ section: "4", issue: "skipped the full-payment anchor" }],
      },
      { sessionId: "coach-B" }, // no state -> no update
    ],
  };
  const parsed = parseBatchGuidance(deepRaw, { generatedAt });
  const updates = reduceDeepPullSteering(parsed);

  assert.equal(updates.length, 1, "only the row with state produces a writeback");
  const u = updates[0];
  assert.equal(u.sessionId, "coach-A");
  assert.equal(u.currentSection, "4B");
  assert.equal(u.beats.length, 2);
  assert.equal(u.beats[1].status, "pending");
  assert.equal(u.remember.length, 1);
  assert.equal(u.says.length, 2);
  assert.equal(u.says[0].type, "objection");
  assert.equal(u.says[0].rec, true);
  assert.equal(u.priorFlags.length, 1);
  assert.equal(u.generatedAt, generatedAt);
  // callStrategy is a short synthesized aim for the reactor.
  assert.match(u.callStrategy, /4B|request a release/);
});

test("REACTOR say: the typed say maps to the dialog try line (dispatch back-compat)", () => {
  const reactorRaw = {
    guidance: [
      {
        sessionId: "coach-A",
        uii: "uii-A",
        agentEmail: "sean@tag.com",
        mode: "reaction",
        read: "Price objection.",
        steer: "Cost-of-waiting frame.",
        say: { type: "objection", tag: "price", text: "What has waiting on this already cost you?" },
      },
    ],
  };
  const parsed = parseBatchGuidance(reactorRaw);
  const row = parsed.guidance[0];
  assert.equal(row.say.type, "objection");
  assert.equal(row.say.text, "What has waiting on this already cost you?");
  assert.equal(row.try, "What has waiting on this already cost you?", "say.text rides as try for the dispatch/emit path");
  assert.equal(row.read, "Price objection.");
});

test("WIRE 5/6: deep schema enforces the section enum + beatId + per-section summary; catalog is in the system", () => {
  const batch = buildActiveLiveCoachBatch(sessionsFixture(), {});
  const req = buildBatchGuidanceRequest(batch, { tier: DEEP_PULL, reference: REFERENCE });
  const props = req.schema.properties.guidance.items.properties;
  assert.deepEqual(props.currentSection.enum, ["1", "2", "3", "4", "4B", "5", "6", "7"], "section is enum-clamped (incl 4B)");
  assert.ok(props.summary, "deep schema carries a per-section summary");
  assert.ok(props.beats.items.properties.beatId, "beats carry a stable beatId");
  assert.deepEqual(props.priorFlags.items.properties.section.enum, ["1", "2", "3", "4", "4B", "5", "6", "7"]);
  // The beat catalog is fed to the DEEP model so it can pick stable beatIds; the reactor stays lean.
  assert.ok(req.system.includes("SCRIPT BEATS BY SECTION"), "deep system exposes the beat catalog");
  assert.ok(req.system.includes("anchor_full"), "catalog lists the 4B beat ids");
  const reactor = buildBatchGuidanceRequest(batch, { tier: REACTOR, reference: REFERENCE });
  assert.ok(!reactor.system.includes("SCRIPT BEATS BY SECTION"), "reactor system stays lean (no catalog)");
});

test("WIRE 5/6: deep repair clamps section (4b -> 4B case-preserved), keeps beatId, carries summary", () => {
  const raw = {
    guidance: [{
      sessionId: "coach-A", uii: "uii-A",
      currentSection: "4b", // a model may lowercase it
      summary: "Quoted the fee; prospect paused.",
      beats: [{ beatId: "anchor_full", point: "Anchor full first", status: "pending" }],
      says: [{ type: "objection", tag: "price", text: "What has waiting cost you?" }],
      priorFlags: [{ section: "4", issue: "rushed the fee" }],
    }],
  };
  const parsed = parseBatchGuidance(raw, { tier: DEEP_PULL });
  const row = parsed.guidance[0];
  assert.equal(row.currentSection, "4B", "lowercase 4b clamped to canonical 4B (not 4b)");
  assert.equal(row.summary, "Quoted the fee; prospect paused.");
  assert.equal(row.beats[0].beatId, "anchor_full", "beatId survives repair");
  assert.equal(row.priorFlags[0].section, "4");
  const u = reduceDeepPullSteering(parsed)[0];
  assert.equal(u.currentSection, "4B");
  assert.equal(u.summary, "Quoted the fee; prospect paused.");
  assert.equal(u.beats[0].beatId, "anchor_full");
});

test("WIRE 5: an off-enum section is dropped to null (no junk section reaches the cockpit)", () => {
  const parsed = parseBatchGuidance({ guidance: [{ sessionId: "a", currentSection: "intro", says: [{ type: "line", text: "x" }] }] }, { tier: DEEP_PULL });
  assert.equal(parsed.guidance[0].currentSection, null, "unknown section -> null");
});

test("parse is robust to a fenced JSON string from the model", () => {
  const raw = "```json\n{\"guidance\":[{\"sessionId\":\"coach-A\",\"mode\":\"reaction\",\"try\":\"hi\"}]}\n```";
  const parsed = parseBatchGuidance(raw);
  assert.equal(parsed.guidance.length, 1);
  assert.equal(parsed.guidance[0].sessionId, "coach-A");
  assert.equal(parsed.guidance[0].try, "hi");
});

test("ROLLING SUMMARY: deep pull interprets Codex's structured buckets; reactor stays lean", () => {
  // A session carrying Codex's normalized rolling-summary memory (latest.rollingSummary).
  const now = nowIso();
  const sessions = [
    {
      id: "coach-A",
      status: "listening",
      lastEventAt: now,
      updatedAt: now,
      metadata: { source: "grpc-mongo", agentEmail: "sean@tag.com", domain: "WYNN", caseId: "123456", uii: "uii-A" },
      memory: {
        transcripts: [{ role: "prospect", text: "I need to talk to my wife before I spend anything." }],
      },
      latest: {
        rollingSummary: {
          summaryText: "WYNN case; prospect stalling on price, wants spousal sign-off.",
          factsCaptured: ["Owes ~18k to IRS", "Wage garnishment active"],
          openQuestions: ["Is the spouse a co-filer?"],
          objections: ["Needs spouse approval before paying", "Thinks the fee is too high"],
          taxIssues: ["Form 12153 CDP hearing window is open"],
          nextBestFocus: "Tie urgency to the active garnishment, not the fee.",
        },
      },
    },
  ];

  // Through Codex's REAL projection -> conversation.rollingSummary + callSummary.
  const batch = buildActiveLiveCoachBatch(sessions, {});

  const deep = buildBatchGuidanceRequest(batch, { tier: DEEP_PULL, reference: REFERENCE });
  // The structured buckets land in the deep prompt with their routing labels.
  assert.ok(deep.prompt.includes("Needs spouse approval"), "deep pull sees the surfaced objections");
  assert.ok(deep.prompt.includes("OBJECTIONS RAISED"), "objections carry the overcome-these label");
  assert.ok(deep.prompt.includes("Form 12153"), "deep pull sees the tax issues");
  assert.ok(deep.prompt.includes("TAX ISSUES"), "tax issues carry the tax-memory label");
  assert.ok(deep.prompt.includes("Wage garnishment active"), "deep pull sees the captured facts");
  assert.ok(deep.prompt.includes("Is the spouse a co-filer?"), "deep pull sees the open questions");
  assert.ok(deep.prompt.includes("NEXT-BEST FOCUS"), "deep pull sees the summary's recommended focus");

  // The reactor stays lean: it gets the headline summaryText but NOT the structured buckets.
  const reactorChanges = buildActiveLiveCoachChangeSet(sessions, {});
  const reactor = buildBatchGuidanceRequest(reactorChanges, { tier: REACTOR, reference: REFERENCE });
  assert.ok(reactor.prompt.includes("stalling on price"), "reactor still gets the headline summary text");
  assert.ok(!reactor.prompt.includes("OBJECTIONS RAISED"), "reactor does NOT carry the structured buckets");
  assert.ok(!reactor.prompt.includes("Form 12153"), "reactor stays lean on tax issues");
});
