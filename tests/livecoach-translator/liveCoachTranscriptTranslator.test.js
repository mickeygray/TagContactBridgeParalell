"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createTranscriptTranslator } = require("../../packages/shared-services/src/liveCoachTranscriptTranslator");

function fakeRunner(handler) {
  return { runAiTask: (taskId, payload, options) => Promise.resolve().then(() => handler(taskId, payload, options)) };
}
function ok(result, provider = "openai") {
  return { ok: true, provider, model: provider === "openai" ? "gpt-5.4-mini" : "claude-haiku-4-5", result };
}

test("cleans the line via the runner and reports the provider (OpenAI = cost-split)", async () => {
  const runner = fakeRunner(async () =>
    ok({ text: "I got an Offer in Compromise", changed: true, corrections: ["offer and compromise -> Offer in Compromise"] }),
  );
  const r = await createTranscriptTranslator({ runner }).translate("i got an offer and compromise", { role: "prospect" });
  assert.equal(r.text, "I got an Offer in Compromise");
  assert.equal(r.changed, true);
  assert.equal(r.provider, "openai");
  assert.equal(r.fellBack, false);
  assert.ok(r.corrections.length >= 1);
});

test("routes through liveCoach.translate; the model sees the regex-normalized text", async () => {
  let seenTask = "";
  let seenUser = "";
  const runner = fakeRunner(async (taskId, payload) => {
    seenTask = taskId;
    seenUser = payload.user;
    return ok({ text: "did you get a CP501", changed: false, corrections: [] });
  });
  await createTranscriptTranslator({ runner }).translate("did you get a c p 501", {});
  assert.equal(seenTask, "liveCoach.translate");
  assert.match(seenUser, /CP501/); // normalizeTaxTerms ran before the model
});

test("reports the failover provider (Claude) when the runner used it", async () => {
  const runner = fakeRunner(async () => ok({ text: "we can do an installment agreement", changed: false, corrections: [] }, "anthropic"));
  const r = await createTranscriptTranslator({ runner }).translate("we can do an installment agreement", {});
  assert.equal(r.provider, "anthropic");
});

test("short lines skip the runner entirely", async () => {
  let called = false;
  const runner = fakeRunner(async () => {
    called = true;
    return ok({ text: "x", changed: false, corrections: [] });
  });
  const r = await createTranscriptTranslator({ runner }).translate("yeah", {});
  assert.equal(called, false);
  assert.equal(r.usedModel, false);
  assert.equal(r.text, "yeah");
});

test("fails open to regex text when the runner throws", async () => {
  const runner = fakeRunner(async () => {
    throw new Error("boom");
  });
  const r = await createTranscriptTranslator({ runner }).translate("tell me about the lien on your house", {});
  assert.equal(r.fellBack, true);
  assert.equal(r.text, "tell me about the lien on your house");
  assert.ok(r.error);
});

test("fails open on a timeout", async () => {
  const runner = {
    runAiTask: () => new Promise((resolve) => setTimeout(() => resolve(ok({ text: "late", changed: true, corrections: [] })), 40)),
  };
  const r = await createTranscriptTranslator({ runner, timeoutMs: 10 }).translate("what is currently not collectible here", {});
  assert.equal(r.fellBack, true);
  assert.match(String(r.error), /timeout/);
});

test("fails open when the task is disabled / every provider failed (ok:false)", async () => {
  const runner = fakeRunner(async () => ({ ok: false, code: "disabled", safeFallback: null }));
  const r = await createTranscriptTranslator({ runner }).translate("they put a lien on the house", {});
  assert.equal(r.fellBack, true);
  assert.equal(r.code, "disabled");
  assert.equal(r.text, "they put a lien on the house");
});

test("fails open when the result is missing text", async () => {
  const runner = fakeRunner(async () => ok({ changed: true, corrections: [] }));
  const r = await createTranscriptTranslator({ runner }).translate("trust fund recovery penalty question", {});
  assert.equal(r.fellBack, true);
});
