"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeVoicemail,
  buildAskPrompt,
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

test("DNC revocation is terminal compliance, never an overcome input", () => {
  // "Stop calling" routes to the compliance directive — alone, no doctrine,
  // no advance plays, and it preempts any other matched objection.
  const matches = findContextMatches("stop calling me, I'm not interested");
  const dnc = matches.find((m) => m.key === "dnc_revocation");
  assert.ok(dnc, "stop calling must match the DNC rule");
  assert.equal(dnc.family, "compliance_dnc");

  const payload = buildSonnetPromptPayload({
    contextFrame: {
      role: "prospect",
      shouldCompose: true,
      phraseText: "stop calling me, I'm not interested",
      matches,
    },
    metadata: { agentName: "Chris", firmName: "Tax Advocate Group" },
  });
  assert.match(payload.user, /DO-NOT-CALL REVOCATION DETECTED/);
  assert.match(payload.user, /confirm removal immediately/i);
  assert.doesNotMatch(payload.user, /Objection doctrine/);
  assert.doesNotMatch(payload.user, /keeps the conversation alive/);

  // Plain "not interested" (no removal demand) stays coachable.
  const coachable = findContextMatches("yeah I'm really not interested honestly");
  assert.ok(coachable.some((m) => m.key === "obj_not_interested"));
  assert.ok(!coachable.some((m) => m.key === "dnc_revocation"));
});

test("objection playbook: phrase match rides the catalog and attaches strategy to the prompt", () => {
  const matches = findContextMatches("I need to talk to my wife before I spend that kind of money");
  const spouse = matches.find((m) => m.key === "obj_spouse_consult");
  assert.ok(spouse, "spouse-consult objection must match");
  assert.equal(spouse.family, "objection_playbook");

  const payload = buildSonnetPromptPayload({
    contextFrame: {
      role: "prospect",
      shouldCompose: true,
      phraseText: "I need to talk to my wife before I spend that kind of money",
      matches,
    },
    metadata: { agentName: "Chris", firmName: "Tax Advocate Group" },
  });
  assert.match(payload.user, /Objection playbook for this turn:/);
  assert.match(payload.user, /joint return/i);
  assert.match(payload.user, /adapt, never read verbatim/);

  // Classic distrust objection also matches.
  const distrust = findContextMatches("honestly this sounds like a scam, I don't trust tax relief companies");
  assert.ok(distrust.some((m) => m.key === "obj_dont_trust_tax_companies"));
});

test("call strategy from interview rides the composer prompt when present", () => {
  const payload = buildSonnetPromptPayload({
    contextFrame: {
      role: "prospect",
      shouldCompose: true,
      phraseText: "I owe about forty grand.",
      callStrategy: "Lead with the levy deadline; prospect is retired on fixed income — frame fees against garnishment exposure.",
    },
    metadata: { agentName: "Chris", firmName: "Tax Advocate Group" },
  });
  assert.match(payload.user, /Pre-call strategy for this prospect/);
  assert.match(payload.user, /levy deadline/);
});

// UNIFIED-ON-PURPOSE (2026-06-12, user call: "do everything, we can back off
// later"): every phase — including the prospect's first turn — runs the full
// navigator prompt. The opening phase is still STAMPED in the user payload so
// the navigator knows where it is. To back off, restore the phase check in
// getSonnetSystemPrompt (SONNET_OPENING_SYSTEM_PROMPT is kept for exactly
// that) and revert this test to the scripted-opening assertions.
test("unified navigator: opening turns get the full coach with the phase stamped", () => {
  const opening = buildSonnetPromptPayload({
    contextFrame: { role: "prospect", callPhase: "opening", prospectTurnCount: 1, shouldCompose: true, phraseText: "Hello?" },
    metadata: { agentName: "Chris", firmName: "Tax Advocate Group", contactName: "Maria Lopez" },
  });
  assert.match(opening.system, /live call NAVIGATOR/);
  assert.doesNotMatch(opening.system, /OPENING moments/); // scripted opening is unrouted by design
  assert.match(opening.user, /Prospect name: Maria Lopez/);
  assert.match(opening.user, /Call phase: OPENING \(prospect turn 1\)/);

  const established = buildSonnetPromptPayload({
    contextFrame: { role: "prospect", callPhase: "established", shouldCompose: true, phraseText: "I owe about forty grand from 2021." },
    metadata: { agentName: "Chris", firmName: "Tax Advocate Group" },
  });
  // Same system prompt for both phases — the phase difference rides the
  // user payload, not the system prompt.
  assert.equal(opening.system, established.system);
  assert.doesNotMatch(established.user, /Call phase: OPENING/);
});

test("dual-VAD: fast channel is additive, turn channel composes, no phrase duplication", () => {
  const pipeline = createSanitizedLiveCoachPipeline({
    metadata: { agentName: "Chris", firmName: "Tax Advocate Group", uii: "u-dual" },
  });
  // Fast quick-final: terms get caught (context built, matches recorded) but
  // it must never trigger compose and must never enter pending.
  const fast = pipeline.handleTranscript({
    text: "I got a CP504 about a wage garnishment and honestly I'm scared",
    role: "prospect",
    channel: "fast",
  });
  assert.equal(fast.action, "hold_for_more_context");
  assert.equal(fast.context.shouldCompose, false);
  assert.equal(fast.context.actionReason, "fast_channel_additive");
  assert.ok((fast.context.matches || []).length > 0, "term catching still runs on the fast channel");

  // The turn channel then delivers the SAME speech as a completed thought:
  // it composes, and the phrase contains the speech once (no pending merge).
  const turn = pipeline.handleTranscript({
    text: "I got a CP504 about a wage garnishment and honestly I'm scared.",
    role: "prospect",
    channel: "turn",
  });
  assert.equal(turn.action, "compose_dialog");
  assert.equal(turn.context.shouldCompose, true);
  const occurrences = (turn.context.phraseText.match(/wage garnishment/gi) || []).length;
  assert.equal(occurrences, 1, "fast decode must not duplicate into the turn phrase");
});

test("marked finals (low confidence / primer echo) inform but never coach", () => {
  const pipeline = createSanitizedLiveCoachPipeline({
    metadata: { agentName: "Chris", firmName: "Tax Advocate Group", uii: "u-lowconf" },
  });
  // A garbled-but-delivered final full of MATCHING words (primer-echo shape)
  // must not run the match bank — echoed banks self-match and ship junk lines.
  const echo = pipeline.handleTranscript({
    text: "levy lien wage garnishment offer in compromise penalty abatement",
    role: "prospect",
    lowConfidence: true,
  });
  assert.equal(echo.action, "store_low_confidence");
  assert.equal(echo.context, null);
  assert.equal(echo.dialog, null);
  assert.equal(echo.transcript.lowConfidence, true);

  // But the voicemail gates run FIRST: a garbled machine greeting still
  // rejects (delivering low-confidence finals to the VM gate was the point).
  const vm = pipeline.handleTranscript({
    text: "At the tone, please record your message.",
    role: "prospect",
    lowConfidence: true,
  });
  assert.equal(vm.action, "reject_voicemail");

  // primerEcho alone (normal confidence band) is also held out of coaching.
  const fresh = createSanitizedLiveCoachPipeline({
    metadata: { agentName: "Chris", firmName: "Tax Advocate Group", uii: "u-echo" },
  });
  const echoOnly = fresh.handleTranscript({
    text: "installment agreement currently not collectible revenue officer",
    role: "prospect",
    primerEcho: true,
  });
  assert.equal(echoOnly.action, "store_low_confidence");
  assert.equal(echoOnly.transcript.primerEcho, true);
});

test("agent-channel rows bypass the voicemail/screener gates and store as context", () => {
  const pipeline = createSanitizedLiveCoachPipeline({
    metadata: { agentName: "Chris", firmName: "Tax Advocate Group", uii: "u-agent" },
  });
  // Voicemail-shaped phrase spoken by the AGENT (their own mic) must never
  // reject the session — agent rows are composer context, not call-state evidence.
  const agentResult = pipeline.handleTranscript({
    text: "If we get disconnected, just leave me a quick message and I'll call right back.",
    role: "agent",
  });
  assert.equal(agentResult.action, "store_non_prospect");
  assert.equal(agentResult.context, null);
  assert.equal(agentResult.dialog, null);
  // Session still alive: a real prospect line afterwards is processed normally.
  const prospectResult = pipeline.handleTranscript({
    text: "I got a CP504 notice from the IRS about a levy.",
    role: "prospect",
  });
  assert.notEqual(prospectResult.action, "ignore_rejected_session");
  assert.notEqual(prospectResult.action, "reject_voicemail");
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

test("machine-only voicemail phrases reject mid-call after coachable turns (anytime gate)", () => {
  const pipeline = createSanitizedLiveCoachPipeline({
    metadata: { agentName: "Chris", firmName: "Tax Advocate Group", uii: "u-anytime" },
  });
  // A coachable prospect turn first — the start-only voicemail gate is now off.
  const first = pipeline.handleTranscript({
    text: "I got a CP504 notice from the IRS about a levy.",
    role: "prospect",
  });
  assert.equal(first.action, "compose_dialog");
  // Broad-set phrase mid-call must NOT reject (a live human can say this).
  const humanish = pipeline.handleTranscript({
    text: "Just leave me a message later if I drop off.",
    role: "prospect",
  });
  assert.notEqual(humanish.action, "reject_voicemail");
  // Deposit-menu audio is machine-only: reject even after coachable turns.
  const menu = pipeline.handleTranscript({
    text: "To erase and re-record, press three. To continue recording where you left off, press four.",
    role: "prospect",
  });
  assert.equal(menu.action, "reject_voicemail");
  assert.match(menu.dialog.guidance, /mid-call/i);
});

test("contraction greeting forms reject at call start (live miss 2026-06-10)", () => {
  const samples = [
    "This is Nicki, I'm not available, bye.",
    "This is Nikki. Not available. Bye.",
    "Hey, it's Tom — I'm not available, leave it after the beep.",
  ];
  for (const text of samples) {
    const pipeline = createSanitizedLiveCoachPipeline({
      metadata: { agentName: "Chris", firmName: "Tax Advocate Group", uii: `u-vm-${text.length}` },
    });
    const result = pipeline.handleTranscript({ text, role: "prospect" });
    assert.equal(result.action, "reject_voicemail", `expected reject for: ${text}`);
  }
});

test("mined greeting variants reject at call start (Spanish + you've-reached + phone-greeting)", () => {
  const samples = [
    "Se envió al buzón de voz. La persona con la que intentas comunicarte no está disponible. Graba tu mensaje después del tono.",
    "Hi, you've reached Angie. I'm sorry I'm unable to come to the phone right now. Go ahead and leave your name, number, and a message.",
    "This is John Blessing. I can't get to the phone right now. If you leave your name and your number, I'll get back to you.",
    "The person at extension 702-329-5690 is unavailable. Please leave your message after the tone. When done, hang up or press the pound key.",
    "The number you have reached is not in service. Please check the number and dial again.",
    "The person you are trying to reach has a voicemail box that has not been set up yet. Please try your call again later.",
  ];
  for (const text of samples) {
    const pipeline = createSanitizedLiveCoachPipeline({
      metadata: { agentName: "Chris", firmName: "Tax Advocate Group", uii: `u-${text.length}` },
    });
    const result = pipeline.handleTranscript({ text, role: "prospect" });
    assert.equal(result.action, "reject_voicemail", `expected reject for: ${text.slice(0, 60)}`);
  }
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

test("router forwards fragments and defers thought-completeness to the composer", () => {
  const pipeline = createSanitizedLiveCoachPipeline({
    metadata: { agentName: "Sean", firmName: "Tax Advocate Group", uii: "u3" },
  });
  // server_vad cuts on ~1s of silence, so a released segment can be mid-thought. The
  // router no longer holds/aggregates trailing fragments locally: it forwards any
  // non-filler prospect utterance and the composer (Claude) is the turn decider -- it
  // replies WAIT on a partial. completeThought is still computed, carried as a
  // NON-BINDING hint, not a gate.
  const first = pipeline.handleTranscript({
    text: "I got a letter from",
    role: "prospect",
  });
  assert.equal(first.action, "compose_dialog");
  assert.equal(first.context.shouldCompose, true);
  assert.equal(first.context.completeThought, false);

  const second = pipeline.handleTranscript({
    text: "the IRS and I'm scared they can garnish my paycheck",
    role: "prospect",
  });
  assert.equal(second.action, "compose_dialog");
  assert.equal(second.context.shouldCompose, true);
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

test("context matcher keeps phrase aliases on word boundaries", () => {
  const matches = findContextMatches("I am being audited and they disallowed my expenses.");
  assert.ok(matches.some((match) => match.key === "audit_adjustment"));
  assert.ok(!matches.some((match) => match.key === "spouse_identity"));
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
  // Navigator contract: orient (Read/Steer), hand exact words only when needed (Try).
  assert.match(payload.system, /live call NAVIGATOR for tax-resolution sales calls/);
  assert.match(payload.system, /Read:.*\n.*Steer:.*\n.*Try:/);
  assert.match(payload.system, /The Read line IS the psychology/);
  // Standing directives now live in the cacheable system prefix, not the per-turn user message.
  assert.equal(payload.systemCacheable, true);
  assert.match(payload.system, /Do not invent people/);
  assert.match(payload.system, /Never wait for an agent final/);
  const otherPayload = buildSonnetPromptPayload({
    contextFrame,
    metadata: {
      agentName: "Brad",
      firmName: "Wynn Tax Solutions",
    },
  });
  assert.equal(payload.system, otherPayload.system);
  assert.doesNotMatch(payload.system, /Anthony|Brad|Tax Advocate Group|Wynn Tax Solutions/);
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

test("new objection entries fire on their phrases and DNC still preempts everything", () => {
  // Sleeping giant: quiet IRS reads as no-urgency.
  const giant = findContextMatches("they haven't bothered me in years, it can wait");
  assert.ok(giant.some((match) => match.key === "obj_no_urgency_sleeping_giant"));
  // Payment-plan treadmill.
  const plan = findContextMatches("I'm already on a payment plan with the IRS, making payments every month");
  assert.ok(plan.some((match) => match.key === "obj_already_on_payment_plan"));
  // Early price probe — a buying signal, matched as its own entry.
  const price = findContextMatches("before anything else, how much does it cost?");
  assert.ok(price.some((match) => match.key === "obj_early_price_probe"));
  // DNC preemption is untouched by the new entries.
  const dnc = findContextMatches("stop calling me, take me off your list");
  assert.ok(dnc.some((match) => match.key === "dnc_revocation"));
});

test("new tactics: take-the-yes, buying-signal momentum, mirror fallback", () => {
  const yes = deriveConversationTactics({ phraseText: "okay let's do it, what do you need from me?" });
  assert.ok(yes.some((tactic) => tactic.key === "momentum_close"));

  const process = deriveConversationTactics({ phraseText: "so how does this all work, what happens first?" });
  assert.ok(process.some((tactic) => tactic.key === "buying_signal_momentum"));

  // Mirror/label fallback only when NO key matched...
  const noKeys = deriveConversationTactics({ phraseText: "yeah it's been a weird couple of months honestly", matches: [] });
  assert.ok(noKeys.some((tactic) => tactic.key === "mirror_to_open"));
  // ...and stays out when real keys are present.
  const keyed = deriveConversationTactics({
    phraseText: "I got a CP504 about a levy",
    matches: [{ key: "collection_pressure" }],
  });
  assert.ok(!keyed.some((tactic) => tactic.key === "mirror_to_open"));
});

test("ask prompt: objection kind matches third-person paraphrase and rides the playbook", () => {
  const ask = buildAskPrompt({
    kind: "objection",
    question: "he says his CPA already handles this, give me lines",
    metadata: { agentName: "Sean", firmName: "Wynn Tax Solutions", contactName: "Robert" },
  });
  assert.equal(ask.shouldCompose, true);
  assert.equal(ask.systemCacheable, true);
  assert.match(ask.system, /on-demand desk coach/);
  assert.match(ask.user, /Ask kind: objection/);
  // "his CPA" (agent paraphrase) must match the bank's first-person "my cpa".
  assert.match(ask.user, /Objection playbook:/);
  assert.match(ask.user, /Objection doctrine/);
  // System prompt stays name-free (stable cache prefix); names ride the user message.
  assert.doesNotMatch(ask.system, /Sean|Wynn|Robert/);
  assert.match(ask.user, /Agent name: Sean/);
});

test("ask prompt: DNC revocation preempts even in an agent ask", () => {
  const ask = buildAskPrompt({
    kind: "objection",
    question: "she said stop calling me, what do I do",
    metadata: {},
  });
  assert.match(ask.user, /DO-NOT-CALL REVOCATION DETECTED/);
  assert.doesNotMatch(ask.user, /Objection doctrine/);
});

test("ask prompt: chat continuity carries recent Q&A for follow-ups", () => {
  const ask = buildAskPrompt({
    kind: "question",
    question: "what about his wife?",
    metadata: { agentName: "Sean", firmName: "Wynn" },
    recentAsks: [
      { question: "How do I respond to the CPA thing?", answer: "Split preparation from representation." },
      { question: "incomplete row, no answer" },
    ],
  });
  assert.match(ask.user, /Recent coach chat this call/);
  assert.match(ask.user, /Agent asked: How do I respond to the CPA thing\?/);
  assert.match(ask.user, /You answered: Split preparation from representation\./);
  // Unanswered rows never render (a half exchange reads as an instruction).
  assert.doesNotMatch(ask.user, /incomplete row, no answer/);
  assert.match(ask.system, /This is a CHAT/);
});

test("ask prompt: line kind carries the pinned transcript and call memory", () => {
  const ask = buildAskPrompt({
    kind: "line",
    lineText: "my payroll guy said he would take care of the 941s",
    metadata: { agentName: "Sean", firmName: "Wynn" },
    recentMemoryText: "Key facts discovered this call:\n- balance: ~48k",
    callStrategy: "Lead with levy urgency.",
  });
  assert.match(ask.user, /Ask kind: line/);
  // Wording changed with the Ask-pills work: a bare pinned line (no attached
  // context items) now rides as "Pinned context".
  assert.match(ask.user, /Pinned context: "my payroll guy/);
  assert.match(ask.user, /Call memory \(key facts, the call so far, recent lines\):/);
  assert.match(ask.user, /Pre-call strategy for this prospect:/);
  // Objection playbook only rides objection asks.
  assert.doesNotMatch(ask.user, /Objection playbook:/);
  // Pull answers get the larger output hint (live lines stay clamped).
  assert.equal(ask.maxTokensHint, 400);
});
