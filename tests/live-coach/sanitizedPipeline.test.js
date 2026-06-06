"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeVoicemail,
  buildMiniContextFrame,
  buildSonnetPromptPayload,
  classifyJurisdiction,
  createSanitizedLiveCoachPipeline,
  createSonnetDialogDraft,
  deriveConversationTactics,
  findContextMatches,
  normalizeSttTranscript,
  normalizeTaxTerms,
} = require("../../packages/shared-services/src/liveCoachSanitizedPipeline");

test("STT normalization repairs common tax terms before routing", () => {
  const normalized = normalizeTaxTerms("i got a c p 504 from the i r s about a ten ninety nine and w2");
  assert.match(normalized, /CP504/);
  assert.match(normalized, /IRS/);
  assert.match(normalized, /1099/);
  assert.match(normalized, /W-2/);

  const transcript = normalizeSttTranscript({
    text: normalized,
    speaker: "client",
    provider: "openai",
    model: "gpt-4o-transcribe",
  });
  assert.equal(transcript.role, "prospect");
  assert.equal(transcript.provider, "openai");
  assert.equal(transcript.model, "gpt-4o-transcribe");
  assert.equal(transcript.isFinal, true);
});

test("deterministic voicemail phrases reject the first transcript item", () => {
  const pipeline = createSanitizedLiveCoachPipeline({
    metadata: { agentName: "Chris", firmName: "Tax Advocate Group", uii: "u1" },
  });
  const result = pipeline.handleTranscript({
    text: "At the tone, please record your message.",
    role: "prospect",
  });
  assert.equal(analyzeVoicemail(result.transcript.text).isVoicemail, true);
  assert.equal(result.action, "reject_voicemail");
  assert.equal(result.context, null);
  assert.equal(result.dialog.status, "rejected");
  assert.match(result.dialog.label, /voicemail/i);
});

test("natural voicemail greetings with inserted words are rejected", () => {
  const pipeline = createSanitizedLiveCoachPipeline({
    metadata: { agentName: "Chris", firmName: "Tax Advocate Group", uii: "u1b" },
  });
  const text = "Hey, this is Tom. Leave me a quick message and I'll get back to you as soon as I can.";
  const result = pipeline.handleTranscript({
    text,
    role: "prospect",
  });
  assert.equal(analyzeVoicemail(text).isVoicemail, true);
  assert.equal(result.action, "reject_voicemail");
  assert.equal(result.context, null);
  assert.equal(result.dialog.status, "rejected");
  assert.match(result.dialog.guidance, /leave a message/i);
});

test("call screeners are held and never sent to the mini context or Sonnet dialog stages", () => {
  const pipeline = createSanitizedLiveCoachPipeline({
    metadata: { agentName: "Brad", firmName: "Tax Advocate Group", uii: "u2" },
  });
  const result = pipeline.handleTranscript({
    text: "I'll see if this person is available.",
    role: "prospect",
  });
  assert.equal(result.action, "hold_call_screener");
  assert.equal(result.context, null);
  assert.equal(result.dialog, null);
  assert.match(result.transcript.nonProspectReason, /call_screener/);
});

test("mini router holds fragments until the phrase has enough semantic context", () => {
  const pipeline = createSanitizedLiveCoachPipeline({
    metadata: { agentName: "Sean", firmName: "Tax Advocate Group", uii: "u3" },
  });
  const first = pipeline.handleTranscript({
    text: "I got a letter from",
    role: "prospect",
  });
  assert.equal(first.action, "hold_for_more_context");
  assert.equal(first.context, null);
  assert.equal(first.dialog, null);
  assert.match(first.hold.pendingText, /letter from$/);

  const second = pipeline.handleTranscript({
    text: "the IRS and I'm scared they can garnish my paycheck",
    role: "prospect",
  });
  assert.equal(second.action, "compose_dialog");
  assert.equal(second.context.shouldCompose, true);
  assert.match(second.context.phraseText, /letter from the IRS/i);
  assert.ok(second.context.matches.some((match) => match.key === "irs_notice"));
  assert.ok(second.context.matches.some((match) => match.key === "emotional_pressure"));
  assert.ok(second.context.matches.some((match) => match.key === "collection_pressure"));
  assert.equal(second.dialog.status, "ready");
});

test("context matcher separates IRS, state, and mixed tax signals", () => {
  const irs = findContextMatches("I got a CP503 from the IRS.");
  assert.ok(irs.some((match) => match.key === "irs_notice"));
  assert.equal(classifyJurisdiction("I got a CP503 from the IRS.", irs), "irs");

  const state = findContextMatches("The FTB sent me a state tax lien.");
  assert.ok(state.some((match) => match.key === "state_tax"));
  assert.equal(classifyJurisdiction("The FTB sent me a state tax lien.", state), "state");

  const mixed = findContextMatches("I owe the IRS and California FTB.");
  assert.equal(classifyJurisdiction("I owe the IRS and California FTB.", mixed), "mixed");
});

test("Sonnet prompt payload uses fixed instructions and does not invent names or firms", () => {
  const transcript = normalizeSttTranscript({
    id: "tr-1",
    text: "I have a CP504 and I'm worried they'll levy my bank account.",
    role: "prospect",
  });
  const contextFrame = buildMiniContextFrame({
    phraseText: transcript.text,
    transcript,
    metadata: {
      agentName: "Anthony",
      firmName: "Tax Advocate Group",
      uii: "u4",
    },
  });
  const payload = buildSonnetPromptPayload({
    contextFrame,
    metadata: {
      agentName: "Anthony",
      firmName: "Tax Advocate Group",
    },
  });
  assert.equal(payload.shouldCompose, true);
  assert.match(payload.system, /live tax-resolution sales dialog composer/);
  // Standing directives now live in the cacheable system prefix, not the per-turn user message.
  assert.equal(payload.systemCacheable, true);
  assert.match(payload.system, /Use tax comprehension/);
  assert.match(payload.system, /Do not invent people/);
  assert.match(payload.user, /Agent name: Anthony/);
  assert.match(payload.user, /Firm name: Tax Advocate Group/);
  assert.match(payload.user, /Conversation tactic:/);
  // The big instruction block must NOT bleed into the per-turn user payload.
  assert.doesNotMatch(payload.user, /Do not invent people/);
});

test("conversation tactics derive psychology and humor posture from selected tax and sales keys", () => {
  const transcript = normalizeSttTranscript({
    id: "tr-tactic-1",
    text: "I got a CP504 and I'm scared they are going to levy my bank account.",
    role: "prospect",
  });
  const contextFrame = buildMiniContextFrame({
    phraseText: transcript.text,
    transcript,
    metadata: { agentName: "Chris", firmName: "Tax Advocate Group" },
  });

  assert.ok(contextFrame.matches.some((match) => match.key === "collection_pressure"));
  assert.deepEqual(
    contextFrame.tactics.slice(0, 2).map((tactic) => tactic.key),
    ["calm_urgency", "human_reassurance"],
  );
  assert.match(contextFrame.tactics[0].humor, /No humor/i);

  const payload = buildSonnetPromptPayload({ contextFrame });
  assert.match(payload.user, /Calm urgency/);
  assert.match(payload.user, /Human reassurance/);
  assert.match(payload.user, /Humor boundary: No humor/);
});

test("legitimacy and mild confusion route to permission posture instead of joke-first copy", () => {
  const matches = findContextMatches("Who are you and why are you calling me about taxes?");
  const tactics = deriveConversationTactics({
    phraseText: "Who are you and why are you calling me about taxes?",
    matches,
    jurisdiction: "ambiguous",
  });

  assert.equal(tactics[0].key, "permission_legitimacy");
  assert.match(tactics[0].guidance, /identify/i);
  assert.match(tactics[0].humor, /No jokes/i);
});

test("Sonnet draft stays service-selling and avoids DIY resolution advice", () => {
  const transcript = normalizeSttTranscript({
    id: "tr-2",
    text: "I got a CP504 and I have not filed in three years.",
    role: "prospect",
  });
  const contextFrame = buildMiniContextFrame({
    phraseText: transcript.text,
    transcript,
    metadata: { agentName: "Bruce", firmName: "Tax Advocate Group" },
  });
  const draft = createSonnetDialogDraft({
    contextFrame,
    metadata: { agentName: "Bruce", firmName: "Tax Advocate Group" },
  });
  assert.equal(draft.status, "ready");
  assert.match(draft.say, /Before we talk solutions|facts straight|last year/i);
  assert.doesNotMatch(draft.say, /pay what you can/i);
  assert.doesNotMatch(draft.say, /installment agreement/i);
  assert.doesNotMatch(draft.say, /request a hold/i);
});
