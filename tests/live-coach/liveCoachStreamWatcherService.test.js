"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMiniContextFrame,
  normalizeSttTranscript,
} = require("../../packages/shared-services/src/liveCoachSanitizedPipeline");

const {
  buildRuleSummaries,
  createLiveCoachStreamWatcher,
  rankContextCandidates,
} = require("../../packages/shared-services/src/liveCoachStreamWatcherService");

test("stream watcher rejects deterministic voicemail words before VAD release", () => {
  const watcher = createLiveCoachStreamWatcher();
  const first = watcher.appendText({ text: "At the tone please record your" });
  assert.equal(first.action, "reject_voicemail");
  assert.equal(first.systemMatch.type, "voicemail");
  assert.equal(first.systemMatch.match, "at the tone");
  assert.equal(first.snapshot.status, "voicemail_rejected");

  const second = watcher.appendText({ text: "message" });
  assert.equal(second.action, "ignored_rejected");
});

test("stream watcher rejects natural voicemail greeting variants", () => {
  const watcher = createLiveCoachStreamWatcher();
  const first = watcher.appendText({
    text: "Hey, this is Tom. Leave me a quick message and I'll call you back.",
  });
  assert.equal(first.action, "reject_voicemail");
  assert.equal(first.systemMatch.type, "voicemail");
  assert.equal(first.systemMatch.match, "leave a message");
  assert.equal(first.snapshot.status, "voicemail_rejected");
});

test("stream watcher holds call screeners but keeps the session alive", () => {
  const watcher = createLiveCoachStreamWatcher();
  const result = watcher.appendText({ text: "I'll see if this person is available one moment" });
  assert.equal(result.action, "hold_call_screener");
  assert.equal(result.snapshot.rejected, false);
  assert.equal(result.snapshot.heldForScreener, true);
  assert.equal(result.systemMatches[0].type, "call_screener");

  const release = watcher.releaseForVad();
  assert.equal(release.action, "hold_call_screener");
  assert.equal(release.candidates.length, 0);
});

test("stream watcher accumulates candidate keys across partial STT text", () => {
  const watcher = createLiveCoachStreamWatcher();
  const first = watcher.appendText({ text: "I got a scary letter from the IRS" });
  assert.equal(first.action, "collect_candidates");
  assert.ok(first.candidates.some((candidate) => candidate.key === "irs_notice"));
  assert.ok(first.candidates.some((candidate) => candidate.key === "emotional_pressure"));

  const second = watcher.appendText({ text: "and I'm worried they can garnish my paycheck" });
  assert.equal(second.action, "collect_candidates");
  assert.ok(second.candidates.some((candidate) => candidate.key === "collection_pressure"));

  const release = watcher.releaseForVad();
  const keys = release.candidates.map((candidate) => candidate.key);
  assert.equal(release.action, "vad_release");
  assert.ok(keys.includes("irs_notice"));
  assert.ok(keys.includes("collection_pressure"));
  assert.ok(keys.includes("emotional_pressure"));
  assert.match(release.phraseText, /IRS/i);
  assert.match(release.phraseText, /garnish/i);
});

test("stream watcher replaces accumulated partial text for the same STT item", () => {
  const watcher = createLiveCoachStreamWatcher();
  const first = watcher.appendText({
    text: "I got",
    itemId: "chunk-1",
  });
  assert.equal(first.action, "collect_candidates");

  const second = watcher.appendText({
    text: "I got a CP504 from the IRS",
    itemId: "chunk-1",
  });
  assert.equal(second.action, "collect_candidates");
  assert.equal(second.snapshot.text, "I got a CP504 from the IRS");

  const duplicate = watcher.appendText({
    text: "I got a CP504 from the IRS",
    itemId: "chunk-1",
  });
  assert.equal(duplicate.action, "ignored_duplicate_item_text");
  assert.equal(duplicate.snapshot.text, "I got a CP504 from the IRS");

  const release = watcher.releaseForVad({
    text: "I got a CP504 from the IRS and I am worried they will levy my wages.",
  });
  assert.equal(release.action, "vad_release");
  assert.equal(release.watcher.text, "I got a CP504 from the IRS");
  assert.equal(watcher.snapshot().text, "");
  assert.equal(watcher.snapshot().lastItemId, "");
});

test("stream watcher replaces corrected final text for the same STT item", () => {
  const watcher = createLiveCoachStreamWatcher();
  watcher.appendText({
    text: "Thankyou.Pleasehold",
    itemId: "chunk-2",
  });

  const final = watcher.appendText({
    text: "Thank you. Please hold while I connect you.",
    itemId: "chunk-2",
  });
  assert.equal(final.snapshot.text, "Thank you. Please hold while I connect you.");

  const release = watcher.releaseForVad({
    text: "Thank you. Please hold while I connect you.",
  });
  assert.equal(release.phraseText, "Thank you. Please hold while I connect you.");
});

test("candidate ranking returns mini-sized summaries, not full coaching prompts", () => {
  const candidates = rankContextCandidates("I have payroll taxes, employees, and a trust fund letter.");
  const payroll = candidates.find((candidate) => candidate.key === "payroll_tax");
  assert.ok(payroll);
  assert.equal(payroll.family, "tax_comprehension");
  assert.ok(payroll.summary.length > 20);
  assert.ok(payroll.summary.length < 300);
  assert.ok(payroll.hits.some((hit) => /payroll|employees|trust fund/i.test(hit)));
});

test("broad deterministic keys catch human tax-language without exact form names", () => {
  const candidates = rankContextCandidates(
    "I got certified mail from the Department of Treasury and it says they can take money out of my check.",
  );
  const keys = candidates.map((candidate) => candidate.key);
  assert.ok(keys.includes("irs_notice"));
  assert.ok(keys.includes("collection_pressure"));
  assert.ok(keys.includes("money_pressure"));
});

test("deterministic keys can over-return while mini rejects unsupported candidates", () => {
  const candidates = rankContextCandidates("I got a letter.");
  assert.ok(candidates.some((candidate) => candidate.key === "irs_notice"));

  const transcript = normalizeSttTranscript({ text: "I got a letter.", role: "prospect" });
  const frame = buildMiniContextFrame({
    phraseText: transcript.text,
    transcript,
    candidateMatches: candidates,
  });

  assert.equal(frame.shouldCompose, false);
  assert.equal(frame.matches.some((match) => match.key === "irs_notice"), false);
  assert.ok(frame.miniJudgement.rejected.some((candidate) => candidate.key === "irs_notice"));
});

test("deterministic keys still catch explicit adjacent sales and tax context", () => {
  const candidates = rankContextCandidates(
    "I haven't done my taxes in years, I drive DoorDash, and my CPA told me to ask what this costs.",
  );
  const keys = candidates.map((candidate) => candidate.key);
  assert.ok(keys.includes("unfiled_returns"));
  assert.ok(keys.includes("self_employment"));
  assert.ok(keys.includes("objection"));
  assert.ok(keys.includes("fees_close"));
});

test("rule summaries expose the small card catalog for mini judgement", () => {
  const summaries = buildRuleSummaries();
  assert.ok(summaries.length > 5);
  assert.ok(summaries.every((summary) => summary.key && summary.summary));
  assert.ok(summaries.some((summary) => summary.key === "irs_notice"));
  assert.ok(summaries.some((summary) => summary.key === "fees_close"));
});
