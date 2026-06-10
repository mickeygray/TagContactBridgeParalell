"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createLiveCoachBus,
} = require("../../packages/shared-services/src/liveCoachBusService");

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "live-coach-bus-"));
}

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("live coach bus writes sanitized transcript, mini context, and dialog artifacts", async () => {
  const rootDir = makeTempRoot();
  const bus = createLiveCoachBus({ rootDir });
  const started = bus.startSession({
    source: "test",
    agentName: "Chris",
    firmName: "Tax Advocate Group",
    uii: "uii-test-1",
  });

  const result = await bus.appendInput(started.id, {
    text: "I got a CP504 from the IRS and I'm scared they will levy my paycheck.",
    role: "prospect",
    source: "unit-test",
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.action, "compose_dialog");
  assert.equal(result.result.context.jurisdiction, "irs");
  assert.equal(result.result.dialog.status, "ready");
  assert.match(result.result.dialog.promptPayload.user, /Agent name: Chris/);
  assert.match(result.result.dialog.promptPayload.user, /Mini compact memory for this turn/);
  assert.match(result.result.dialog.promptPayload.user, /Transcript snippet/);
  assert.equal(result.result.context.memoryBrief.activeIssues[0].status, "new");
  assert.equal(result.session.memory.transcripts.length, 1);
  assert.equal(result.session.memory.contexts.length, 1);
  assert.equal(result.session.memory.coachingSuggestions.length, 1);
  assert.equal(result.session.memory.holds.length, 0);

  const transcriptFile = path.join(rootDir, "runtime", "ai-bus", "live-coach", started.id, "ai", "transcript.ndjson");
  const contextFile = path.join(rootDir, "runtime", "ai-bus", "live-coach", started.id, "ai", "context.ndjson");
  const dialogFile = path.join(rootDir, "runtime", "ai-bus", "live-coach", started.id, "ai", "dialog.ndjson");
  assert.equal(fs.existsSync(transcriptFile), true);
  assert.equal(fs.existsSync(contextFile), true);
  assert.equal(fs.existsSync(dialogFile), true);
  assert.match(fs.readFileSync(contextFile, "utf8"), /irs_notice/);
});

test("live coach bus accepts RingCX plus aliases for the same agent email", async () => {
  const rootDir = makeTempRoot();
  const bus = createLiveCoachBus({ rootDir });
  const started = bus.startSession({
    source: "test",
    agentName: "Chris",
    agentEmail: "cbolt+50810001_8283@taxadvocategroup.com",
    agentExtension: "4545",
    firmName: "Wynn Tax Solutions",
    uii: "uii-plus-alias",
  });

  const result = await bus.appendInput(started.id, {
    text: "I got a CP504 from the IRS and I am worried about a levy.",
    role: "prospect",
    agentEmail: "cbolt@taxadvocategroup.com",
    agentExtensionId: "4545",
    source: "unit-test",
  });

  assert.equal(result.ok, true);
  assert.notEqual(result.statusCode, 409);

  const mismatch = await bus.appendInput(started.id, {
    text: "This should not attach to another agent.",
    role: "prospect",
    agentEmail: "cbolt@taxadvocategroup.com",
    agentExtensionId: "3344",
    source: "unit-test",
  });

  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, "agent-mismatch");
});

test("live coach bus lets semantic judge hold before dialog composition", async () => {
  const rootDir = makeTempRoot();
  const bus = createLiveCoachBus({
    rootDir,
    semanticContextJudge: async () => ({
      shouldCompose: false,
      completeThought: true,
      selectedKeys: [],
      rejected: [{ key: "irs_notice", reason: "not actually about an IRS notice" }],
      transcriptMeaning: "The statement is not actionable enough for live coaching.",
      actionReason: "semantic_context_not_actionable",
      confidence: 0.86,
      provider: "test",
      model: "fake-mini",
    }),
    dialogComposer: async () => {
      throw new Error("dialog composer should not run");
    },
  });
  const started = bus.startSession({
    source: "test",
    agentName: "Chris",
    firmName: "Tax Advocate Group",
    uii: "uii-judge-hold",
  });

  const result = await bus.appendInput(started.id, {
    text: "I got an IRS notice but never mind, I am just checking if this thing works.",
    role: "prospect",
    source: "unit-test",
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.action, "hold_semantic_context");
  assert.equal(result.result.dialog, null);
  assert.equal(result.session.counters.context, 1);
  assert.equal(result.session.counters.dialog, 0);
  assert.equal(result.session.memory.contexts.length, 1);
  assert.equal(result.session.memory.contexts[0].held, true);
  assert.equal(result.session.memory.holds.length, 1);
  assert.equal(result.result.context.miniJudgement.modelRole, "semantic_context_judge");
});

test("live coach bus lets semantic judge recover catalog keys beyond deterministic hints", async () => {
  const rootDir = makeTempRoot();
  const bus = createLiveCoachBus({
    rootDir,
    semanticContextJudge: async ({ deterministicCandidates }) => ({
      shouldCompose: true,
      completeThought: true,
      selectedKeys: [{ key: "self_employment", confidence: 0.91, reason: "platform income maps to 1099/self-employment" }],
      rejected: deterministicCandidates.map((candidate) => ({ key: candidate.key, reason: "not the best fit" })),
      transcriptMeaning: "The prospect has platform income that likely created a self-employment tax issue.",
      memoryBrief: {
        whatHappened: "The prospect has platform income and owes taxes.",
        activeIssues: [{ key: "self_employment", snippet: "paid through a platform", status: "new" }],
        continueFrom: "Ask what kind of income forms they received and move into discovery.",
      },
      actionReason: "semantic_context_judge_selected",
      confidence: 0.91,
      provider: "test",
      model: "fake-mini",
    }),
  });
  const started = bus.startSession({
    source: "test",
    agentName: "Chris",
    firmName: "Wynn Tax Solutions",
    uii: "uii-judge-fuzzy-recovery",
  });

  const result = await bus.appendInput(started.id, {
    text: "I got paid through a platform and now I owe taxes.",
    role: "prospect",
    source: "unit-test",
    contextCandidates: [],
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.action, "compose_dialog");
  assert.equal(result.result.context.miniJudgement.modelRole, "semantic_context_judge");
  assert.ok(result.result.context.matches.some((match) => match.key === "self_employment"));
  assert.equal(result.result.context.primaryContextKey, "self_employment");
  assert.match(result.result.dialog.promptPayload.user, /1099 \/ self-employment/);
  assert.match(result.result.dialog.promptPayload.user, /paid through a platform/);
});

test("live coach bus can emit transcript before async context judge finishes", async () => {
  const rootDir = makeTempRoot();
  let judgeStarted = false;
  const bus = createLiveCoachBus({
    rootDir,
    asyncContextPipeline: true,
    semanticContextJudge: async () => {
      judgeStarted = true;
      await wait(25);
      return {
        shouldCompose: false,
        completeThought: true,
        selectedKeys: [],
        rejected: [{ key: "irs_notice", reason: "test hold" }],
        transcriptMeaning: "The transcript was accepted before context judgement finished.",
        actionReason: "semantic_context_not_actionable",
        confidence: 0.8,
        provider: "test",
        model: "fake-mini",
      };
    },
  });
  const started = bus.startSession({
    source: "test",
    agentName: "Chris",
    firmName: "Tax Advocate Group",
    uii: "uii-async-context",
  });

  const result = await bus.appendInput(started.id, {
    text: "I got a CP504 from the IRS and I'm worried about it.",
    role: "prospect",
    source: "unit-test",
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.action, "compose_dialog_pending");
  assert.equal(result.session.counters.transcript, 1);
  assert.equal(result.session.counters.context, 0);
  assert.equal(result.session.latest.transcript.text, "I got a CP504 from the IRS and I'm worried about it.");
  assert.equal(result.session.latest.context, null);

  await wait(60);
  const after = bus.getSession(started.id);
  assert.equal(judgeStarted, true);
  assert.equal(after.memory.holds.length, 1);
  assert.equal(after.memory.transcripts.length, 1);
});

test("live coach bus dedupes duplicate composer requests", async () => {
  const rootDir = makeTempRoot();
  let composeCalls = 0;
  const bus = createLiveCoachBus({
    rootDir,
    composeDedupWindowMs: 5000,
    dialogComposer: async () => {
      composeCalls += 1;
      await wait(30);
      return { say: "I can help you unpack that notice.", composer: "test" };
    },
  });
  const started = bus.startSession({
    source: "test",
    agentName: "Chris",
    firmName: "Tax Advocate Group",
    uii: "uii-dedupe",
  });

  await bus.appendInput(started.id, {
    text: "I got a CP504 from the IRS and I'm worried about a levy.",
    role: "prospect",
    source: "unit-test",
  });
  await bus.appendInput(started.id, {
    text: "I got a CP504 from the IRS and I'm worried about a levy.",
    role: "prospect",
    source: "unit-test",
  });
  await wait(60);

  assert.equal(composeCalls, 1);
  const events = bus.getSession(started.id).events;
  assert.equal(events.some((event) => event.type === "compose.deduped"), true);
});

test("live coach bus rate limits composer starts per session", async () => {
  const rootDir = makeTempRoot();
  let composeCalls = 0;
  const bus = createLiveCoachBus({
    rootDir,
    composeDedupWindowMs: 0,
    composeRateLimitPerMinute: 1,
    dialogComposer: async () => {
      composeCalls += 1;
      return { say: "Let's slow this down and get the facts.", composer: "test" };
    },
  });
  const started = bus.startSession({
    source: "test",
    agentName: "Chris",
    firmName: "Tax Advocate Group",
    uii: "uii-rate-limit",
  });

  await bus.appendInput(started.id, {
    text: "I got a CP504 from the IRS and I'm worried about a levy.",
    role: "prospect",
    source: "unit-test",
  });
  await wait(10);
  await bus.appendInput(started.id, {
    text: "I also have unfiled tax returns for the last three years.",
    role: "prospect",
    source: "unit-test",
  });
  await wait(20);

  const session = bus.getSession(started.id);
  assert.equal(composeCalls, 1);
  assert.equal(session.events.some((event) => event.type === "compose.rate_limited"), true);
  assert.equal(session.latest.dialog.composerSkipped, "rate_limited");
});

test("live coach bus keeps one composer in flight and supersedes with latest dialog", async () => {
  const rootDir = makeTempRoot();
  let composeCalls = 0;
  let active = 0;
  let maxActive = 0;
  const bus = createLiveCoachBus({
    rootDir,
    composeDedupWindowMs: 0,
    composeRateLimitPerMinute: 10,
    dialogComposer: ({ abortSignal }) => new Promise((resolve) => {
      composeCalls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      let settled = false;
      const finish = (say) => {
        if (settled) return;
        settled = true;
        active -= 1;
        resolve({ say, composer: "test" });
      };
      const timer = setTimeout(() => finish("latest line"), 40);
      abortSignal?.addEventListener?.("abort", () => {
        clearTimeout(timer);
        finish("");
      }, { once: true });
    }),
  });
  const started = bus.startSession({
    source: "test",
    agentName: "Chris",
    firmName: "Tax Advocate Group",
    uii: "uii-single-flight",
  });

  await bus.appendInput(started.id, {
    text: "I got a CP504 from the IRS and I'm worried about a levy.",
    role: "prospect",
    source: "unit-test",
  });
  await bus.appendInput(started.id, {
    text: "I also have payroll tax problems from my business.",
    role: "prospect",
    source: "unit-test",
  });
  await wait(100);

  const session = bus.getSession(started.id);
  assert.equal(composeCalls, 2);
  assert.equal(maxActive, 1);
  assert.equal(session.events.some((event) => event.type === "compose.supersede"), true);
  assert.equal(session.latest.dialog.status, "ready");
  assert.equal(session.latest.dialog.say, "latest line");
});

test("live coach bus marks voicemail sessions rejected without writing context", async () => {
  const rootDir = makeTempRoot();
  const bus = createLiveCoachBus({ rootDir });
  const started = bus.startSession({
    source: "test",
    agentName: "Brad",
    firmName: "Tax Advocate Group",
    uii: "uii-test-2",
  });

  const result = await bus.appendInput(started.id, {
    text: "Please record your message after the tone.",
    role: "prospect",
    source: "unit-test",
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.action, "reject_voicemail");
  assert.equal(result.session.status, "voicemail_rejected");
  assert.equal(result.result.context, null);

  const contextFile = path.join(rootDir, "runtime", "ai-bus", "live-coach", started.id, "ai", "context.ndjson");
  assert.equal(fs.existsSync(contextFile), false);
});

test("live coach bus rejects voicemail from streaming deltas before mini or Sonnet", async () => {
  const rootDir = makeTempRoot();
  const bus = createLiveCoachBus({
    rootDir,
    semanticContextJudge: async () => {
      throw new Error("semantic judge should not run for streaming voicemail");
    },
    dialogComposer: async () => {
      throw new Error("dialog composer should not run for streaming voicemail");
    },
  });
  const started = bus.startSession({
    source: "test",
    agentName: "Chris",
    firmName: "Wynn Tax Solutions",
    uii: "uii-stream-vm",
  });

  const result = await bus.appendInput(started.id, {
    text: "At the tone please record your",
    role: "prospect",
    source: "unit-test-delta",
    type: "conversation.item.input_audio_transcription.delta",
    provisional: true,
    final: false,
    itemId: "vm-item-1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.action, "reject_voicemail");
  assert.equal(result.session.status, "voicemail_rejected");
  assert.equal(result.session.counters.voicemailRejected, 1);
  assert.equal(result.session.counters.context, 0);
  assert.equal(result.session.counters.dialog, 0);
  assert.equal(result.result.dialog.status, "rejected");
  assert.match(result.result.dialog.guidance, /at the tone/i);
});

test("live coach bus accepts provisional transcript without invoking context or dialog", async () => {
  const rootDir = makeTempRoot();
  const bus = createLiveCoachBus({ rootDir });
  const started = bus.startSession({
    source: "test",
    agentName: "Chris",
    firmName: "Tax Advocate Group",
    uii: "uii-provisional",
  });

  const provisional = await bus.appendInput(started.id, {
    text: "I got a letter from the IRS and",
    role: "prospect",
    source: "unit-test",
    type: "conversation.item.input_audio_transcription.delta",
    itemId: "item-1",
  });

  assert.equal(provisional.ok, true);
  assert.equal(provisional.result.action, "provisional");
  assert.equal(provisional.session.counters.provisional, 1);
  assert.equal(provisional.session.counters.transcript, 0);
  assert.equal(provisional.session.latest.provisionalTranscript.text, "I got a letter from the IRS and");
  assert.equal(provisional.session.latest.transcript, null);
  assert.equal(provisional.session.latest.dialog, null);
  assert.ok(provisional.result.watcher.candidates.some((candidate) => candidate.key === "irs_notice"));
  assert.equal(provisional.session.counters.context, 0);
  assert.equal(provisional.session.counters.dialog, 0);
  assert.equal(provisional.session.memory.provisionalTranscripts.length, 1);
  assert.equal(provisional.session.memory.transcripts.length, 0);
  assert.equal(provisional.session.memory.contexts.length, 0);
  assert.equal(provisional.session.memory.coachingSuggestions.length, 0);

  const contextFile = path.join(rootDir, "runtime", "ai-bus", "live-coach", started.id, "ai", "context.ndjson");
  assert.equal(fs.existsSync(contextFile), false);

  const final = await bus.appendInput(started.id, {
    text: "I got a letter from the IRS and I'm worried they might levy my paycheck.",
    role: "prospect",
    source: "unit-test",
    itemId: "item-1",
  });

  assert.equal(final.ok, true);
  assert.equal(final.result.action, "compose_dialog");
  assert.equal(final.session.latest.provisionalTranscript, null);
  assert.equal(final.session.counters.transcript, 1);
  assert.equal(final.session.latest.dialog.status, "ready");
  assert.equal(final.session.memory.transcripts.length, 1);
  assert.equal(final.session.memory.contexts.length, 1);
  assert.equal(final.session.memory.coachingSuggestions.length, 1);
});

test("live coach bus provisional fixture streams deltas before final transcript", async () => {
  const rootDir = makeTempRoot();
  const bus = createLiveCoachBus({ rootDir });

  const result = await bus.runProvisionalFixture({
    agentName: "Chris",
    text: "I got a CP504 from the IRS and I'm worried they might levy my paycheck.",
    delayMs: 0,
    chunkWords: 4,
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.action, "compose_dialog");
  assert.equal(result.provisionalCount > 0, true);
  assert.equal(result.session.counters.provisional, result.provisionalCount);
  assert.equal(result.session.counters.transcript, 1);
  assert.equal(result.session.latest.provisionalTranscript, null);
  assert.equal(result.session.latest.dialog.status, "ready");
  assert.equal(result.session.memory.provisionalTranscripts.length, result.provisionalCount);
  assert.equal(result.session.memory.transcripts.length, 1);
  assert.equal(result.session.memory.contexts.length, 1);
  assert.equal(result.session.memory.coachingSuggestions.length, 1);

  const provisionalFile = path.join(
    rootDir,
    "runtime",
    "ai-bus",
    "live-coach",
    result.session.id,
    "ai",
    "provisional-transcript.ndjson",
  );
  assert.equal(fs.existsSync(provisionalFile), true);
});


test("live coach bus ensureSession reuses binding session without wiping artifacts", async () => {
  const rootDir = makeTempRoot();
  const bus = createLiveCoachBus({ rootDir });
  const first = bus.ensureSession({
    sessionId: "coach-cx-4545-uii-active",
    source: "grpc-mongo",
    agentName: "Chris",
    agentExtension: "4545",
    uii: "uii-active",
    binding: { status: "active", reason: "matched-cx-call-placed" },
  });
  const input = await bus.appendInput(first.id, {
    text: "I got an IRS notice and I need help.",
    role: "prospect",
    source: "unit-test",
  });
  assert.equal(input.ok, true);
  assert.equal(input.session.counters.transcript, 1);

  const second = bus.ensureSession({
    sessionId: "coach-cx-4545-uii-active",
    source: "grpc-mongo",
    agentName: "Chris Bolt",
    agentExtension: "4545",
    uii: "uii-active",
    caseId: "124930",
    binding: { status: "active", reason: "matched-cx-call-placed" },
  });

  assert.equal(second.id, first.id);
  assert.equal(second.metadata.agentName, "Chris Bolt");
  assert.equal(second.metadata.caseId, "124930");
  assert.equal(second.counters.transcript, 1);
});

test("live coach bus stales a session when transcript input has a mismatched uii", async () => {
  const rootDir = makeTempRoot();
  const bus = createLiveCoachBus({ rootDir });
  const started = bus.ensureSession({
    sessionId: "coach-cx-4545-uii-old",
    source: "grpc-mongo",
    agentName: "Chris",
    agentExtension: "4545",
    uii: "uii-old",
  });

  const result = await bus.appendInput(started.id, {
    text: "I got a notice.",
    role: "prospect",
    source: "unit-test",
    uii: "uii-new",
    agentExtension: "4545",
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, "uii-mismatch");
  assert.equal(result.session.status, "stale");
});

test("live coach bus retires older live sessions for the same agent when current call changes", () => {
  const rootDir = makeTempRoot();
  const bus = createLiveCoachBus({ rootDir });
  const oldSession = bus.ensureSession({
    sessionId: "coach-cx-4545-uii-old",
    source: "grpc-mongo",
    agentName: "Chris",
    agentExtension: "4545",
    uii: "uii-old",
  });
  const keepOtherAgent = bus.ensureSession({
    sessionId: "coach-cx-3344-uii-other",
    source: "grpc-mongo",
    agentName: "Brad",
    agentExtension: "3344",
    uii: "uii-other",
  });

  const retired = bus.retireReplacedSessions({
    metadata: {
      agentExtension: "4545",
      uii: "uii-new",
    },
    event: {
      extensionId: "4545",
      uii: "uii-new",
    },
  });

  assert.equal(retired.retiredCount, 1);
  assert.equal(bus.getSession(oldSession.id).status, "stale");
  assert.equal(bus.getSession(keepOtherAgent.id).status, "listening");
});

test("live coach bus cleanupDeadStreams compares sessions to latest agent binding", async () => {
  const rootDir = makeTempRoot();
  const bus = createLiveCoachBus({ rootDir });
  const oldSession = bus.ensureSession({
    sessionId: "coach-cx-4545-uii-old",
    source: "grpc-mongo",
    agentExtension: "4545",
    uii: "uii-old",
  });

  const result = await bus.cleanupDeadStreams({
    apply: true,
    maxIdleMs: 60_000,
    resolveBinding: async () => ({
      status: "active",
      binding: {
        active: true,
        reason: "matched-cx-call-placed",
        metadata: {
          agentExtension: "4545",
          uii: "uii-new",
        },
        event: {
          extensionId: "4545",
          uii: "uii-new",
        },
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.staleCount, 1);
  assert.equal(result.stale[0].reason, "agent-current-call-changed");
  assert.equal(bus.getSession(oldSession.id).status, "stale");
});

test("live coach bus prunes terminal sessions from hot memory", () => {
  const rootDir = makeTempRoot();
  const bus = createLiveCoachBus({ rootDir });
  const sessions = ["a", "b", "c"].map((suffix) => bus.startSession({
    sessionId: `coach-cx-4545-uii-prune-${suffix}`,
    source: "grpc-mongo",
    agentExtension: "4545",
    uii: `uii-prune-${suffix}`,
  }));

  for (const session of sessions) {
    const stopped = bus.stopSession(session.id, { reason: "unit-test-stop" });
    assert.equal(stopped.ok, true);
  }

  const dryRun = bus.pruneTerminalSessions({
    apply: false,
    maxTerminalSessions: 1,
  });
  assert.equal(dryRun.terminalCount, 3);
  assert.equal(dryRun.prunedCount, 2);
  assert.equal(bus.listSessionSummaries().length, 3);

  const applied = bus.pruneTerminalSessions({
    apply: true,
    maxTerminalSessions: 1,
  });
  assert.equal(applied.prunedCount, 2);
  assert.equal(bus.listSessionSummaries().length, 1);
  assert.equal(bus.getSummary().total, 1);
});

test("live coach bus treats released sessions as terminal", async () => {
  const rootDir = makeTempRoot();
  const bus = createLiveCoachBus({ rootDir });
  const started = bus.startSession({
    sessionId: "coach-cx-4545-uii-released",
    source: "grpc-mongo",
    agentExtension: "4545",
    uii: "uii-released",
  });

  const stopped = bus.stopSession(started.id, {
    status: "released",
    reason: "client-release",
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.session.status, "released");

  const input = await bus.appendInput(started.id, {
    text: "I have an IRS notice.",
    role: "prospect",
    source: "unit-test",
  });
  assert.equal(input.ok, false);
  assert.match(input.error, /released/);
});

test("live coach bus exposes summaries and flushes terminal persistence asynchronously", async () => {
  const rootDir = makeTempRoot();
  const saves = [];
  const bus = createLiveCoachBus({
    rootDir,
    persistenceIntervalMs: 60_000,
    persistence: {
      async saveSessionSnapshot(snapshot, input) {
        saves.push({ snapshot, input });
      },
    },
  });
  const started = bus.startSession({
    sessionId: "coach-cx-4545-uii-persist",
    source: "grpc-mongo",
    agentExtension: "4545",
    uii: "uii-persist",
  });

  await bus.appendInput(started.id, {
    text: "I got an IRS letter.",
    role: "prospect",
    source: "unit-test",
  });

  const summaries = bus.listSessionSummaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, started.id);
  assert.equal(Object.prototype.hasOwnProperty.call(summaries[0], "events"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(summaries[0], "memory"), false);
  assert.equal(saves.length, 0);

  bus.stopSession(started.id, { reason: "unit-test-stop" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(saves.length, 1);
  assert.equal(saves[0].input.reason, "session.stop");
  assert.equal(saves[0].snapshot.status, "stopped");
  assert.equal(saves[0].snapshot.memory.transcripts.length, 1);
});
