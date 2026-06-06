"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  runStreamLoopFixture,
} = require("../../packages/shared-services/src/liveCoachStreamLoopHarnessService");

test("stream loop fixture runs watcher to mini judgement to Sonnet draft", () => {
  const result = runStreamLoopFixture({
    metadata: { agentName: "Chris", firmName: "Tax Advocate Group", uii: "fixture-1" },
    chunks: [
      { text: "I got certified mail from the Department of Treasury", vadRelease: false },
      { text: "and it says they can take money out of my check.", vadRelease: true },
    ],
  });

  assert.equal(result.status, "ready");
  assert.equal(result.release.action, "vad_release");
  assert.ok(result.contextFrame.miniJudgement.selectedKeys.includes("irs_notice"));
  assert.ok(result.contextFrame.miniJudgement.selectedKeys.includes("collection_pressure"));
  assert.equal(result.dialog.status, "ready");
  assert.match(result.dialog.say, /urgent|levied|garnished|warning/i);
});

test("stream loop fixture stops before mini/Sonnet on voicemail", () => {
  const result = runStreamLoopFixture({
    chunks: [{ text: "At the tone please record your message.", vadRelease: true }],
  });
  assert.equal(result.status, "voicemail_rejected");
  assert.ok(result.events.some((event) => event.action === "reject_voicemail"));
  assert.equal(result.contextFrame, undefined);
});

test("stream loop fixture holds screeners out of coach context", () => {
  const result = runStreamLoopFixture({
    chunks: [{ text: "I'll see if this person is available one moment.", vadRelease: true }],
  });
  assert.equal(result.status, "held_call_screener");
  assert.equal(result.release.action, "hold_call_screener");
  assert.equal(result.contextFrame, undefined);
});
