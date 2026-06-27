"use strict";

// End-to-end proof of the whole-floor batch coach through the REAL bus:
//   synthetic transcript IN (appendInput)
//     -> the floor loop (real projection + real dispatch plan)
//     -> a fake model transport
//     -> batch guidance OUT the SSE channel (subscribe) for the right agent only
// No real model spend, no server, no Mongo. Proves the wiring + the default-off
// guarantee + per-agent gating + the deterministic agent staying untouched.

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { createLiveCoachBus } = require("../../packages/shared-services/src/liveCoachBusService");
const { createStubTransport } = require("../../apps/ai-bus/src/coachBatchTransports");

function tmpRoot(tag) {
  const dir = path.join(os.tmpdir(), `coach-e2e-${tag}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function startActiveSession(bus, { sessionId, agentEmail, uii }) {
  bus.startSession({
    sessionId,
    source: "grpc-mongo",
    agentEmail,
    agentName: agentEmail.split("@")[0],
    uii,
    domain: "WYNN",
    caseId: "123456",
  });
}

test("DEFAULT-OFF: no transports => floor loop is dormant (startFloorCoach is a no-op)", () => {
  const bus = createLiveCoachBus({ rootDir: tmpRoot("off"), logger: null });
  // No batchModelRunners injected => nothing to run.
  assert.equal(bus.startFloorCoach(), null);
  bus.stopFloorCoach(); // must not throw even though nothing started
});

test("ON for one agent: synthetic transcript in -> batch dialog out the SSE for THAT agent only", async () => {
  let reactorCalls = 0;
  const reactorTransport = async (req) => {
    reactorCalls += 1;
    // The prompt should carry only the batch-mode agent's call (Sean), not Dana.
    assert.ok(req.prompt.includes("coach-sean"), "Sean's call is in the batch prompt");
    assert.ok(!req.prompt.includes("coach-dana"), "Dana (deterministic) is filtered OUT of the batch");
    return {
      guidance: [
        {
          sessionId: "coach-sean",
          uii: "uii-sean",
          agentEmail: "sean@tag.com",
          mode: "reaction",
          read: "Price objection right after the fee.",
          steer: "Run the cost-of-waiting frame.",
          try: "What has waiting on this already cost you?",
          confidence: "high",
        },
      ],
    };
  };

  const bus = createLiveCoachBus({
    rootDir: tmpRoot("on"),
    logger: null,
    // dialogComposer intentionally omitted => the per-turn path is inert here.
    batchModelRunners: { runReactor: reactorTransport, runDeep: null },
    resolveRuntimeMode: (session) => ({
      mode: session?.metadata?.agentEmail === "sean@tag.com" ? "batch" : "deterministic",
    }),
    floorCoach: {
      reference: "RULES: cost-of-waiting frame for price objections.",
      reactorIntervalMs: 9_999_999, // huge => the real timer never fires during the test
      deepIntervalMs: 9_999_999,
      batchOptions: { maxSessions: 12 },
    },
  });

  // Two live calls: Sean (batch) and Dana (deterministic).
  startActiveSession(bus, { sessionId: "coach-sean", agentEmail: "sean@tag.com", uii: "uii-sean" });
  startActiveSession(bus, { sessionId: "coach-dana", agentEmail: "dana@tag.com", uii: "uii-dana" });

  // Push synthetic transcript turns.
  await bus.appendInput("coach-sean", { role: "agent", text: "So the fee to get started is $1,800.", final: true, itemId: "s-a-1" });
  await bus.appendInput("coach-sean", { role: "prospect", text: "Honestly that's way too expensive for me.", final: true, itemId: "s-p-1" });
  await bus.appendInput("coach-dana", { role: "prospect", text: "What forms do I need to send in?", final: true, itemId: "d-p-1" });

  // Subscribe to both agents' SSE channels and capture 'dialog' events.
  const seanEvents = [];
  const danaEvents = [];
  const unsubSean = bus.subscribe("coach-sean", (e) => seanEvents.push(e));
  const unsubDana = bus.subscribe("coach-dana", (e) => danaEvents.push(e));

  // Drive one reactor tick through the real loop (startFloorCoach returns the loop).
  const loop = bus.startFloorCoach();
  assert.ok(loop, "the loop started (a reactor transport is present)");
  const tick = await loop.tickReactor();
  loop.stop();

  assert.equal(tick.fired, true, "the tick fired the model");
  assert.equal(reactorCalls, 1);
  assert.equal(tick.dispatchCount, 1);

  // Sean (batch) got a composed 'dialog' event the cockpit already renders.
  const seanDialog = seanEvents.filter((e) => e.type === "dialog");
  assert.equal(seanDialog.length, 1, "Sean received exactly one batch dialog");
  const say = seanDialog[0].dialog.say;
  assert.match(say, /Read: Price objection/);
  assert.match(say, /Steer: Run the cost-of-waiting/);
  assert.match(say, /Try: "What has waiting on this already cost you\?"/);
  assert.equal(seanDialog[0].dialog.composer, "batch", "tagged as the batch composer");

  // Dana (deterministic) received NO batch guidance — the proven path is untouched.
  const danaDialog = danaEvents.filter((e) => e.type === "dialog");
  assert.equal(danaDialog.length, 0, "the deterministic agent gets no batch guidance");

  // The snapshot slot is painted for late-joiners.
  const seanSession = bus.getSession("coach-sean");
  assert.equal(seanSession.latest.dialog.composer, "batch");

  unsubSean();
  unsubDana();
});

test("GATE: a fully deterministic floor never calls the model (no wasted spend)", async () => {
  let calls = 0;
  const bus = createLiveCoachBus({
    rootDir: tmpRoot("gate"),
    logger: null,
    batchModelRunners: {
      runReactor: async () => {
        calls += 1;
        return { guidance: [] };
      },
      runDeep: null,
    },
    resolveRuntimeMode: () => ({ mode: "deterministic" }), // nobody in batch
    floorCoach: { reference: "R", reactorIntervalMs: 9_999_999, deepIntervalMs: 9_999_999 },
  });
  startActiveSession(bus, { sessionId: "coach-x", agentEmail: "x@tag.com", uii: "uii-x" });
  await bus.appendInput("coach-x", { role: "prospect", text: "too expensive", final: true, itemId: "x-1" });

  const loop = bus.startFloorCoach();
  const tick = await loop.tickReactor();
  loop.stop();

  assert.equal(tick.fired, false, "no batch agents => gate blocks");
  assert.equal(tick.reason, "no-active-conversations");
  assert.equal(calls, 0, "the model was never called on a deterministic floor");
});

test("DEEP: cockpit state is emitted and snapshot-replayed for the batch agent only", async () => {
  let deepCalls = 0;
  const bus = createLiveCoachBus({
    rootDir: tmpRoot("cockpit"),
    logger: null,
    batchModelRunners: {
      runReactor: null,
      runDeep: async (req) => {
        deepCalls += 1;
        assert.equal(req.tier, "deep");
        assert.ok(req.prompt.includes("coach-sean"), "Sean's call is in the deep prompt");
        assert.ok(!req.prompt.includes("coach-dana"), "Dana (deterministic) is filtered OUT of the deep prompt");
        return {
          guidance: [
            {
              sessionId: "coach-sean",
              uii: "uii-sean",
              agentEmail: "sean@tag.com",
              currentSection: "2",
              beats: [
                { point: "Ask amount owed", status: "hit" },
                { point: "Ask unfiled years", status: "pending" },
              ],
              remember: [{ text: "Find deadline before pitching", kind: "watch" }],
              says: [{ type: "objection", tag: "deadline", rec: true, text: "What date did the notice give you?" }],
              priorFlags: [{ section: "1", issue: "No source check" }],
            },
          ],
        };
      },
    },
    resolveRuntimeMode: (session) => ({
      mode: session?.metadata?.agentEmail === "sean@tag.com" ? "batch" : "deterministic",
    }),
    floorCoach: {
      reference: "RULES: keep cockpit state separate from live dialog.",
      reactorIntervalMs: 9_999_999,
      deepIntervalMs: 9_999_999,
      batchOptions: { maxSessions: 12 },
    },
  });

  startActiveSession(bus, { sessionId: "coach-sean", agentEmail: "sean@tag.com", uii: "uii-sean" });
  startActiveSession(bus, { sessionId: "coach-dana", agentEmail: "dana@tag.com", uii: "uii-dana" });
  await bus.appendInput("coach-sean", { role: "prospect", text: "I got a levy notice.", final: true, itemId: "s-p-1" });
  await bus.appendInput("coach-dana", { role: "prospect", text: "What forms do I need?", final: true, itemId: "d-p-1" });

  const seanEvents = [];
  const danaEvents = [];
  const unsubSean = bus.subscribe("coach-sean", (e) => seanEvents.push(e));
  const unsubDana = bus.subscribe("coach-dana", (e) => danaEvents.push(e));

  const loop = bus.startFloorCoach();
  assert.ok(loop, "the loop started (a deep transport is present)");
  const tick = await loop.tickDeep();
  loop.stop();

  assert.equal(tick.fired, true);
  assert.equal(deepCalls, 1);
  assert.equal(tick.stateUpdates, 1);

  const cockpitEvents = seanEvents.filter((e) => e.type === "coach.cockpit");
  assert.equal(cockpitEvents.length, 1, "Sean received exactly one cockpit event");
  assert.equal(cockpitEvents[0].cockpit.currentSection, "2");
  assert.equal(cockpitEvents[0].cockpit.beats.length, 2);
  assert.equal(cockpitEvents[0].cockpit.says[0].rec, true);
  assert.ok(cockpitEvents[0].cockpit.generatedAt, "deep tick timestamp is carried to the cockpit");

  assert.equal(danaEvents.filter((e) => e.type === "coach.cockpit").length, 0);

  const seanSession = bus.getSession("coach-sean");
  assert.equal(seanSession.latest.cockpit.currentSection, "2");
  assert.equal(seanSession.latest.cockpit.generatedAt, cockpitEvents[0].cockpit.generatedAt);

  unsubSean();
  unsubDana();
});

test("DEEP coalesce: a terse second tick keeps the prior beats/says (no minute-long blank flicker)", async () => {
  let deepCalls = 0;
  const bus = createLiveCoachBus({
    rootDir: tmpRoot("coalesce"),
    logger: null,
    batchModelRunners: {
      runReactor: null,
      runDeep: async () => {
        deepCalls += 1;
        return deepCalls === 1
          ? { guidance: [{ sessionId: "coach-sean", uii: "uii-sean", currentSection: "2",
              beats: [{ beatId: "core_questions", status: "hit" }, { beatId: "pain_points", status: "pending" }],
              remember: [{ text: "find the deadline", kind: "watch" }],
              says: [{ type: "objection", tag: "x", text: "go" }] }] }
          // Terse tick, SAME section, empty arrays — must not blank the cockpit.
          : { guidance: [{ sessionId: "coach-sean", uii: "uii-sean", currentSection: "2", beats: [], remember: [], says: [] }] };
      },
    },
    resolveRuntimeMode: () => ({ mode: "batch" }),
    floorCoach: { reference: "R", reactorIntervalMs: 9_999_999, deepIntervalMs: 9_999_999, batchOptions: { maxSessions: 12 } },
  });
  startActiveSession(bus, { sessionId: "coach-sean", agentEmail: "sean@tag.com", uii: "uii-sean" });
  await bus.appendInput("coach-sean", { role: "prospect", text: "I have a levy.", final: true, itemId: "s-1" });

  const loop = bus.startFloorCoach();
  await loop.tickDeep();
  await loop.tickDeep();
  loop.stop();

  const cockpit = bus.getSession("coach-sean").latest.cockpit;
  assert.equal(deepCalls, 2);
  assert.equal(cockpit.currentSection, "2");
  assert.equal(cockpit.beats.length, 2, "the terse tick kept the prior beats (same section)");
  assert.equal(cockpit.says.length, 1, "prior says retained too");
});

test("SUMMARY: rolling-summary tick fills latest.rollingSummary (NOT callSummary), emits coach.summary, advances cursor", async () => {
  let summaryCalls = 0;
  const bus = createLiveCoachBus({
    rootDir: tmpRoot("summary"),
    logger: null,
    batchModelRunners: {
      runReactor: null,
      runDeep: null,
      // The injected summary substrate (a fake here; createSummaryTransport in prod).
      runSummary: async (req) => {
        summaryCalls += 1;
        assert.ok(req.prompt.includes("levy"), "Sean's transcript rows feed the summary prompt");
        return {
          ok: true,
          json: {
            schemaVersion: "live-coach.rolling-summary-result.v1",
            batchId: req.batchId || "b1",
            generatedAt: new Date().toISOString(),
            summaries: [
              {
                sessionId: "coach-sean",
                uii: "uii-sean",
                agentEmail: "sean@tag.com",
                agentExtensionId: "1001",
                summary: [
                  { sequence: 1, kind: "tax_issue", text: "Active levy on file.", sourceTranscriptIds: ["s-p-1"] },
                  { sequence: 2, kind: "fact", text: "Three unfiled years, self-employed.", sourceTranscriptIds: ["s-p-1"] },
                ],
                summaryText: "Active levy; three unfiled years; self-employed.",
                taxIssues: ["Active levy (enforcing)", "Substitute returns inflate the balance"],
                factsCaptured: ["Three unfiled years", "Self-employed"],
                openQuestions: ["Exact balance owed?"],
                objections: [],
                nextBestFocus: "Tie urgency to the levy.",
                confidence: "medium",
              },
            ],
          },
        };
      },
    },
    resolveRuntimeMode: (session) => ({
      mode: session?.metadata?.agentEmail === "sean@tag.com" ? "batch" : "deterministic",
    }),
    floorCoach: {
      reference: "R",
      reactorIntervalMs: 9_999_999,
      deepIntervalMs: 9_999_999,
      summaryIntervalMs: 9_999_999,
      batchOptions: { maxSessions: 12 },
    },
  });

  // The summary batch needs agentExtension (it drops calls lacking it).
  bus.startSession({ sessionId: "coach-sean", source: "grpc-mongo", agentEmail: "sean@tag.com", agentName: "Sean", uii: "uii-sean", agentExtension: "1001", domain: "WYNN", caseId: "123456" });
  bus.startSession({ sessionId: "coach-dana", source: "grpc-mongo", agentEmail: "dana@tag.com", agentName: "Dana", uii: "uii-dana", agentExtension: "1002", domain: "TAG" });
  await bus.appendInput("coach-sean", { role: "prospect", text: "I got a levy notice and haven't filed in three years.", final: true, itemId: "s-p-1" });
  await bus.appendInput("coach-dana", { role: "prospect", text: "What forms do I need?", final: true, itemId: "d-p-1" });

  const seanEvents = [];
  const danaEvents = [];
  const unsubSean = bus.subscribe("coach-sean", (e) => seanEvents.push(e));
  const unsubDana = bus.subscribe("coach-dana", (e) => danaEvents.push(e));

  const loop = bus.startFloorCoach();
  assert.ok(loop, "the loop started (a summary transport is present)");
  const tick = await loop.tickSummary();

  assert.equal(tick.fired, true, "the summary tick fired");
  assert.equal(summaryCalls, 1);
  assert.equal(tick.applyCount, 1, "one session summarized");

  const sean = bus.getSession("coach-sean");
  assert.ok(sean.latest.rollingSummary, "latest.rollingSummary populated");
  assert.deepEqual(sean.latest.rollingSummary.taxIssues, ["Active levy (enforcing)", "Substitute returns inflate the balance"]);
  assert.deepEqual(sean.latest.rollingSummary.factsCaptured, ["Three unfiled years", "Self-employed"]);
  assert.equal(sean.memory.rollingSummary.summaryText, "Active levy; three unfiled years; self-employed.");
  // CRITICAL: callSummary is the rolling DIGEST's field. writeCallSummary:false means the live
  // summary tick wrote rollingSummary but did NOT propagate summaryText into callSummary (no scribe race).
  assert.notEqual(sean.callSummary, sean.latest.rollingSummary.summaryText, "callSummary was NOT overwritten by the summary tick");
  assert.equal(sean.callSummary, "", "callSummary stays digest-owned (untouched, still empty)");

  // A coach.summary event fired for live repaint; Dana (deterministic) got nothing.
  const summaryEvents = seanEvents.filter((e) => e.type === "coach.summary");
  assert.equal(summaryEvents.length, 1, "Sean got one coach.summary event");
  assert.ok(summaryEvents[0].rollingSummary.taxIssues.length, "the event carries the tax memory");
  assert.equal(danaEvents.filter((e) => e.type === "coach.summary").length, 0);

  // Cursor advanced: a second tick with no new transcript rows is a no-op (no wasted model spend).
  const tick2 = await loop.tickSummary();
  loop.stop();
  assert.equal(tick2.fired, false, "no new rows => no second model call");
  assert.equal(tick2.reason, "no-calls");
  assert.equal(summaryCalls, 1, "the model was not called again");

  unsubSean();
  unsubDana();
});

test("DEVPATH: stub transport drives the REAL pipeline (cockpit + dialog) with no model spend", async () => {
  // The productized dev transport: no keys, no model. It echoes the live session's routing
  // keys (parsed from the prompt) so the whole real loop->dispatch/steering->SSE path runs.
  const bus = createLiveCoachBus({
    rootDir: tmpRoot("stub"),
    logger: null,
    batchModelRunners: {
      runReactor: createStubTransport({ kind: "reactor" }),
      runDeep: createStubTransport({ kind: "deep" }),
      runSummary: null,
    },
    resolveRuntimeMode: () => ({ mode: "batch" }),
    floorCoach: { reference: "R", reactorIntervalMs: 9_999_999, deepIntervalMs: 9_999_999, batchOptions: { maxSessions: 12 } },
  });
  startActiveSession(bus, { sessionId: "coach-sean", agentEmail: "sean@tag.com", uii: "uii-sean" });
  await bus.appendInput("coach-sean", { role: "prospect", text: "That's too expensive for me.", final: true, itemId: "s-1" });

  const events = [];
  const unsub = bus.subscribe("coach-sean", (e) => events.push(e));
  const loop = bus.startFloorCoach();
  const deep = await loop.tickDeep();
  const react = await loop.tickReactor();
  loop.stop();

  assert.equal(deep.fired, true, "stub deep fired");
  assert.equal(react.fired, true, "stub reactor fired");

  // The deep stub produced REAL cockpit state on the SSE (routed to the live session).
  const cockpit = events.filter((e) => e.type === "coach.cockpit");
  assert.equal(cockpit.length, 1, "stub produced a real cockpit event");
  assert.equal(cockpit[0].cockpit.says[0].rec, true);
  assert.ok(cockpit[0].cockpit.beats.length >= 1, "stub cockpit carries beats");

  // The reactor stub produced a REAL dialog on the SSE (legacy card path, unchanged).
  const dialog = events.filter((e) => e.type === "dialog");
  assert.equal(dialog.length, 1, "stub produced a real dialog event");
  assert.match(dialog[0].dialog.say, /Read:|Steer:|Try:/);

  unsub();
});

test("SUMMARY DEFAULT-OFF: no runSummary => the summary cadence never fires", async () => {
  const bus = createLiveCoachBus({
    rootDir: tmpRoot("summary-off"),
    logger: null,
    batchModelRunners: { runReactor: async () => ({ guidance: [] }), runDeep: null, runSummary: null },
    resolveRuntimeMode: () => ({ mode: "batch" }),
    floorCoach: { reference: "R", reactorIntervalMs: 9_999_999, deepIntervalMs: 9_999_999, summaryIntervalMs: 9_999_999 },
  });
  startActiveSession(bus, { sessionId: "coach-x", agentEmail: "x@tag.com", uii: "uii-x" });
  await bus.appendInput("coach-x", { role: "prospect", text: "I got a levy notice.", final: true, itemId: "x-1" });

  const loop = bus.startFloorCoach();
  const tick = await loop.tickSummary();
  loop.stop();
  assert.equal(tick.fired, false, "no summary runner => no fire");
  // It reaches the no-runner branch only if there ARE calls; with agentExtension unset there are none.
  assert.ok(["no-runner", "no-calls"].includes(tick.reason), `expected no-runner/no-calls, got ${tick.reason}`);
});
