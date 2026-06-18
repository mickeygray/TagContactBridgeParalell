"use strict";

// THE VERIFICATION LAYER — per-task I/O contract.
// For every core task: what shape goes IN (the request the bus builds) and what
// shape comes OUT (the validated envelope, failover, fail-closed). Driven through
// the real runner + sandbox material with fake providers. Local, no network.
// Building the bus = making/keeping these green; we PULL these, not re-write them.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSandboxRunner } = require("./sandboxHarness");
const sandbox = require("../../packages/shared-services/src/aiSandbox");

// A schema-valid OUT per task (what a healthy provider returns).
const VALID = {
  "liveCoach.callStrategy": () => ({ text: "## Read\n- scared, behind on filing", model: "claude-opus-4-8" }),
  "liveCoach.rollingDigest": () => ({ json: { read: "scared, wants relief", facts: [] }, model: "gpt-5.4-mini" }),
  "liveCoach.contextJudge": () => ({ json: { shouldCompose: true, completeThought: true, approvedKeys: [] }, model: "gpt-5.4-mini" }),
  "liveCoach.callGrader": () => ({ json: { overallScore: 78, scores: { rapport: 8 } }, model: "gpt-5.4" }),
  "sms.classify": () => ({ json: { intent: "irs_notice", tier: "callback_prompt", prospect_state: "scared", suggested_reply: "We can help. - Wynn Tax Solutions", callback_window: "", confidence: 0.8, rationale: "has a CP504", hot_intent_detected: true, hot_intent_reason: "got a cp504, wants help" }, model: "claude-opus-4-6" }),
  "activity.contactSafetyReview": () => ({ json: { status: "stop_contact", confidence: "high", riskFlags: ["attorney"] }, model: "claude-haiku-4-5" }),
  "resolution.pitch": () => ({ text: "Here's the pitch.\n```verdict\n{\"class\":\"DEVELOP\"}\n```", model: "claude-opus-4-8" }),
  "transcriptionScoring.score": () => ({ json: { overall: 7, lead_verdict: "warm", dimensions: {} }, model: "claude-sonnet-4-5" }),
};

// A representative payload per task.
const PAYLOAD = {
  "liveCoach.callStrategy": { input: JSON.stringify({ interview: { debt: 42000 }, contactName: "Ann" }) },
  "liveCoach.rollingDigest": { input: JSON.stringify({ packets: [{ key: "balance" }], priorSummary: "" }) },
  "liveCoach.contextJudge": { input: JSON.stringify({ vad: "I owe like forty grand", matched: [] }) },
  "liveCoach.callGrader": { input: JSON.stringify({ transcriptRows: [], outcome: "pitched" }) },
  "sms.classify": { input: "I got a CP504, can you help?" },
  "activity.contactSafetyReview": { domain: "TAG", caseId: 4242, activities: [{ ActivityType: "Note", Subject: "Attorney letter", Comment: "cease and desist - represented by counsel" }] },
  "resolution.pitch": { input: JSON.stringify({ dossier: { caseNumber: 1 }, ask: "pitch it" }) },
  "transcriptionScoring.score": { input: "Agent: hi. Prospect: I owe 30k." },
};

const CORE = Object.keys(VALID);

// ── IN: the request carries the real prompt + schema + cache + model ─────────
for (const id of CORE) {
  test(`${id}: IN — request carries prompt + schema + cache + model`, async () => {
    const t = sandbox.getSandboxTask(id);
    let captured = null;
    let capturedModel = null;
    const { runner } = buildSandboxRunner({
      result: (p, k, req, opts) => {
        captured = req;
        capturedModel = opts.model;
        return VALID[id]();
      },
    });
    const r = await runner.runAiTask(id, PAYLOAD[id]);
    assert.equal(r.ok, true, `expected ok; got ${JSON.stringify(r)}`);
    if (t.system) assert.ok(captured.system && captured.system.length > 20, "system prompt present");
    if (t.kind === "json" || t.kind === "classify") assert.ok(captured.schema, "structured task attaches a schema");
    assert.deepEqual(captured.cache || null, t.cache || null, "cache policy threaded from the sandbox");
    assert.equal(capturedModel, t.plumbing && t.plumbing.modelDefault, "adapter invoked with the task's resolved default model");
  });
}

// ── OUT: a valid provider result returns the ok envelope ─────────────────────
for (const id of CORE) {
  test(`${id}: OUT — valid result returns the ok envelope`, async () => {
    const { runner } = buildSandboxRunner({ result: () => VALID[id]() });
    const r = await runner.runAiTask(id, PAYLOAD[id]);
    assert.equal(r.ok, true);
    assert.equal(r.taskId, id);
    assert.ok(r.provider, "envelope names the provider that served");
    assert.notEqual(r.result, undefined, "envelope carries a result");
  });
}

// ── OUT: contract-invalid output fails over to the other provider ────────────
test("activity: bad shape on Anthropic fails over to OpenAI", async () => {
  const { runner } = buildSandboxRunner({
    result: (p) => (p === "anthropic" ? { json: {} } : { json: { status: "allow_contact", confidence: "low" } }),
  });
  const r = await runner.runAiTask("activity.contactSafetyReview", PAYLOAD["activity.contactSafetyReview"]);
  assert.equal(r.ok, true);
  assert.equal(r.provider, "openai");
  assert.equal(r.result.status, "allow_contact");
});

// ── OUT: total contract failure returns the task's fail-closed shape ─────────
for (const id of ["sms.classify", "activity.contactSafetyReview"]) {
  test(`${id}: fail-closed shape when every provider returns a bad shape`, async () => {
    const { runner } = buildSandboxRunner({ result: () => ({ json: {} }) }); // missing required fields
    const r = await runner.runAiTask(id, PAYLOAD[id]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.safeFallback, sandbox.getSandboxTask(id).failClosed, "compliance fail-closed shape preserved");
  });
}

// ── Modality: transcribe routes to the audio-capable provider, passes the file ─
test("transcriptionScoring.transcribe: modality routes to OpenAI with the audio", async () => {
  let captured = null;
  const { runner } = buildSandboxRunner({
    result: (p, k, req) => {
      captured = req;
      return { json: { text: "I owe thirty thousand" }, model: "whisper-1" };
    },
  });
  const r = await runner.runAiTask("transcriptionScoring.transcribe", { audio: Buffer.from("pcm") });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "openai");
  assert.ok(captured.file, "audio forwarded as file");
  assert.equal(r.result.text, "I owe thirty thousand");
});

// ── Unknown task is a clean, distinct envelope (not a crash) ─────────────────
test("unknown task returns a clean unknown_task envelope", async () => {
  const { runner } = buildSandboxRunner({ result: () => ({ text: "x" }) });
  const r = await runner.runAiTask("does.not.exist", {});
  assert.equal(r.ok, false);
  assert.equal(r.code, "unknown_task");
});
