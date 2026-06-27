# AI Live Coach Transcript/Semantic Audit - 2026-06-23

## Goal

Audit the current live-coach AI implementation with one narrow question:

> How do we move accuracy work away from transcription prompts and into cheap semantic/logic layers without slowing live reactions or letting prompt vocabulary bleed back into the transcript?

This is read-only guidance. No live flags or service behavior changed.

## Current Chain

The active live coach path is:

```text
RingCX gRPC audio
  -> scripts/ringcx-grpc-live-coach-bridge.js
  -> OpenAI realtime STT
      fast channel: server_vad, cheap model, provisionals, UI/deterministic catching
      turn channel: semantic_vad, full model, completed thought, compose trigger
  -> apps/ai-bus/src/server.js on :7000
  -> liveCoachBusService
  -> liveCoachStreamWatcherService
  -> liveCoachSanitizedPipeline
  -> optional OpenAI mini context judge
  -> Anthropic composer for coach guidance
```

The important split already exists:

- `fast` transcript rows paint the UI and feed deterministic packet catching.
- `turn` transcript rows are canonical memory and the compose trigger.
- agent STT is context-only; it is stored as `role:"agent"` and does not trigger mini/determinism.
- low-confidence / primer-echo rows are delivered to the UI but not coachable.

That is the right direction.

## Good Pieces Already In Place

1. **Dual-VAD architecture is directionally correct.**
   Fast STT is additive and visual. Semantic VAD is the slower, more deliberate compose trigger. This protects the coach from every fast fragment while keeping the screen alive.

2. **Deterministic gates are strong and cheap.**
   `liveCoachStreamWatcherService` and `liveCoachSanitizedPipeline` catch voicemail, screeners, system prompts, and local context matches before mini or Sonnet spend.

3. **Mini is acting like a fuzzy filter, not the whole brain.**
   `LIVE_COACH_CONTEXT_JUDGE_ENABLED` routes deterministic matches + VAD text to mini for relevance/ranking. That is exactly the right use: over-inclusive local lookup first, cheap semantic filter second.

4. **Composer guards are real now.**
   Dedup, rate cap, single-flight supersede, WAIT refund, and timing logs exist in `liveCoachBusService`. These directly address Sonnet overlap and runaway cost.

5. **Transcript translator exists and is fail-open.**
   `liveCoachTranscriptTranslator.js` is a good sidecar primitive: regex first, then `liveCoach.translate`, OpenAI-first, Claude failover, 700ms default timeout, disabled by default, and never throws.

## Main Risk

The STT primer is still doing too much.

In `scripts/ringcx-grpc-live-coach-bridge.js`, `DEFAULT_STT_DOMAIN_PRIMER` includes terms like:

```text
CP504, CP503, CP501, LT11, Letter 1058, levy, lien, wage garnishment,
offer in compromise, installment agreement, currently not collectible,
penalty abatement, unfiled returns, 941, 1099, W-2, revenue officer,
Wynn Tax Solutions
```

That primer is currently sent into realtime transcription for both the fast and turn channels through `buildCallSttPrimer`.

The code knows this is dangerous:

- energy gate avoids transcribing silence;
- low-signal filters suppress obvious junk;
- logprobs create a confidence mark;
- `detectPrimerEcho` flags finals whose words are mostly primer vocabulary;
- `liveCoachSanitizedPipeline` prevents `primerEcho` / `lowConfidence` rows from becoming coachable.

Those are good mitigations, but they are still downstream of the problem. If the model hears noise and emits "CP504 lien levy Wynn Tax Solutions," we are already cleaning up after prompt bleed.

## Recommended Direction

### 1. Make STT the raw ears again

Default should be:

- no broad tax vocabulary primer in live floor STT;
- possibly no primer at all for fast channel;
- maybe a very small name-only primer for the turn channel, behind a flag, after testing.

Reason:

- fast channel feeds deterministic matchables; a tax primer can self-match and make false context feel real;
- turn channel is canonical memory and compose trigger; primer bleed there is more dangerous than a misspelled CP notice;
- `normalizeTaxTerms`, match bank aliases, mini filtering, and Sonnet are better places to repair meaning.

Suggested flags:

```text
LIVE_COACH_FAST_STT_PRIMER_MODE=off|names|domain
LIVE_COACH_TURN_STT_PRIMER_MODE=off|names|domain
```

Default recommendation:

```text
fast = off
turn = names or off
```

Do not use broad domain vocabulary until A/B shows it improves more than it hallucinates.

### 2. Treat correction as annotation, not transcript replacement

`liveCoachTranscriptTranslator` should not write back into `transcript.text` and should never call `appendInput` again.

Correct shape:

```json
{
  "type": "transcript.corrected",
  "transcriptId": "tr-0012",
  "rawText": "they put a lean on my house",
  "normalizedText": "they put a lien on my house",
  "correctedText": "they put a lien on my house",
  "changed": true,
  "corrections": ["lean -> lien"],
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "latencyMs": 420
}
```

The UI may update the displayed line with a subtle corrected badge. Memory/search/closeout may prefer corrected text. But the hot coach path should keep the original final + deterministic normalized terms as the source of truth unless we deliberately opt in later.

Hard rule:

```text
STT final -> deterministic/semantic/coach
STT final -> async translator -> annotation

Never:
translator output -> STT input
translator output -> second VAD final
translator output -> immediate second coach compose
```

### 3. Keep the live reaction path narrow

Live coaching should stay:

```text
turn final
  -> normalizeTaxTerms
  -> deterministic match bank
  -> mini filters/ranks matches
  -> Sonnet decides WAIT vs guidance and streams guidance
```

The translator should not sit between turn final and Sonnet. At 700ms it is fine for UI polish and later memory, but it is too expensive to make a required stage in a 1-5 second reaction loop.

### 4. Put semantic cleanup in the match bank first

The cheapest correction is not a model. It is aliases.

For tax/sales terms, expand `liveCoachContextMatchBank` / `normalizeTaxTerms` before adding translator spend:

- "lean" -> lien only when nearby words include tax/IRS/property/filed;
- "offer and compromise" -> Offer in Compromise;
- "see pee five oh four" -> CP504;
- "letter ten fifty eight" -> Letter 1058;
- "wage attachment" -> garnishment / levy context;
- Spanish tax terms should remain Spanish when valid; only garbage foreign-character leakage should be marked low-confidence/noise.

This gives mini better candidate summaries without asking STT to guess tax language.

### 5. Use mini for meaning, not spelling

Mini context judge should receive:

```json
{
  "vad": "i owe the irs",
  "matchableTerms": ["owe", "irs"],
  "matched": [
    {
      "term": "owe",
      "candidates": [
        {"key":"money_pressure","summary":"Financial anxiety / ability to pay"},
        {"key":"tax_debt","summary":"Unresolved balance"}
      ]
    },
    {
      "term": "irs",
      "candidates": [
        {"key":"irs_notice","summary":"Federal tax issue"},
        {"key":"collection_pressure","summary":"Possible enforcement context"}
      ]
    }
  ],
  "recentFiltered": [],
  "unresolvedVadBuffer": []
}
```

Mini decides which keys matter and writes a compact `contextBrief`.

It should not be asked to "fix spelling" in the same call. That makes the prompt do two jobs and risks causing the exact feedback loop we are trying to remove.

### 6. Use Sonnet for judgement and guidance

Sonnet should read:

- current raw/normalized VAD;
- approved keys + snippets;
- recent memory/facts;
- strategy/form context;
- recent agent line context;
- optional correctedText if it exists already, clearly labeled as non-authoritative annotation.

Sonnet decides:

- WAIT if the thought is incomplete;
- guidepost vs reaction vs objection;
- what the agent should do next.

It should not see the STT primer. It should not be asked to repair transcription as a primary task.

## Specific Bug Button-Up: Prompt Bleed

The least disruptive fix is not to remove all primer machinery. It is to stop broad domain primers from riding the hot STT channel by default.

Recommended first patch:

1. Add primer mode config per channel.
2. Default fast channel primer to `off`.
3. Default turn channel primer to `names` or `off`.
4. Keep `LIVE_COACH_STT_DOMAIN_PRIMER_ENABLED` as a compatibility umbrella, but make channel-specific flags win.
5. Log primer mode per channel in `stt.realtime.model_select` / `stt.realtime.ready`.
6. Keep `detectPrimerEcho`; if a line is primer-echo, emit it visually but never store it as canonical memory and never compose on it.

The reason this is better than only adding more filtering:

- filtering happens after spend and after hallucinated words exist;
- disabling broad primer removes the self-match vector;
- semantic correction can still recover tax terms cheaply after STT.

## Where The Current Implementation Is Weak

1. **Translator is not clearly wired to the live coach session lifecycle.**
   It exists, it has tests, and it has a harness, but the live bus path does not appear to emit corrected transcript annotations yet.

2. **AI task docs are partly stale.**
   `AI_BUS_AUDIT_GUIDE.md` says the bus is not mounted/no real calls; `apps/ai-bus/src/server.js` now mounts `aiTaskRoutes` and `liveCoach.translate` is registered. The implementation has moved faster than the audit doc.

3. **OpenAI usage telemetry is split.**
   Live coach context judge/digest/grader call OpenAI directly inside `apps/ai-bus/src/server.js`; generic AI tasks use `aiTaskRunner` telemetry. Spend attribution will stay foggy until all paths emit the same `taskId/family/provider/model/usage/elapsedMs`.

4. **Broad STT primer is a hidden quality/cost knob.**
   Because it sits upstream of everything, it can make deterministic matches look stronger while actually being an STT hallucination.

5. **Fast channel can still visually display text that later gets marked suspect.**
   This is acceptable if the UI treats it as provisional/low-confidence. It is not acceptable if it creates coach state or memory.

## Proposed Implementation Order

### Phase A - no behavior risk

- Add channel primer-mode logging.
- Add metrics for:
  - primerEcho count by channel/model;
  - lowConfidence count by channel/model;
  - correction changed count;
  - translator fallback count;
  - translator p50/p95 latency.
- Add a `transcript.corrected` event type but do not render it yet.

### Phase B - prompt-bleed reduction

- Set fast primer mode to `off`.
- Set turn primer mode to `names` or `off`.
- Keep `normalizeTaxTerms` + deterministic alias bank doing tax-term repair.
- Watch if context match recall drops.

### Phase C - sidecar correction

- Run `createTranscriptTranslator().translate()` asynchronously after final transcript commit.
- Write `corrected-transcript.ndjson`.
- Emit `transcript.corrected`.
- UI may update the line or show "corrected" without changing the original transcript row id.

### Phase D - use corrected text only where safe

Safe consumers:

- transcript display;
- call summary;
- call grader;
- searchable session artifacts;
- maybe rolling digest on the next cycle.

Unsafe consumers:

- VAD release trigger;
- immediate deterministic gate;
- immediate mini context judge;
- immediate Sonnet compose trigger;
- any path that creates a second compose for the same final.

## Acceptance Tests

1. Primer echo:
   - Input silence/noise with primer enabled.
   - Expect `primerEcho:true`, no context matches, no compose, no memory canonicalization.

2. Translator annotation:
   - Final transcript `"they put a lean on my house"`.
   - Expect `transcript.text` unchanged or regex-normalized by existing policy, plus `transcript.corrected.correctedText = "they put a lien on my house"`.
   - Expect no second `context` or `dialog` event.

3. Latency:
   - Coach guidance must not wait for translator.
   - `vadToFirstDeltaMs` should be unchanged with translator enabled.

4. Deterministic recall:
   - With STT primer off, CP504 / LT11 / 1058 / lien / levy examples still produce the right match keys via regex + aliases.

5. Spend:
   - Translator disabled means zero task calls.
   - Translator enabled logs task usage under `liveCoach.translate`.
   - No translator call for 1-word/filler lines.

## Bottom Line

Do not try to make transcription smarter by loading more tax words into STT. That is the source of the bleed.

Make transcription narrower and dumber:

```text
hear speech -> emit words
```

Then make the app smarter after STT:

```text
regex normalize -> deterministic candidate lookup -> mini meaning filter -> Sonnet guidance
```

And make transcript correction a non-blocking sidecar:

```text
raw final -> async cleanup annotation -> UI/memory/closeout polish
```

That gives us the thing we actually want: better semantic understanding, lower prompt bleed risk, and no added delay before the agent sees guidance.

## Next Generation Live Coach Shape

The next version should stop feeling like "live lines of dialog" and start
feeling like a real-time sales guide:

```text
fixed call guide
  -> phase benchmarks
  -> AI tracks what has/hasn't been accomplished
  -> live objections/reactions
  -> tax/sales/human context references
  -> agent asks targeted questions when needed
```

The coach should have two jobs running in parallel:

1. **Long-term call progression tracking**
   - Load a fixed guide based on the case/source/sales information before or at call start.
   - Define clear phase goals: opening legitimacy, discovery, tax facts, pain/urgency, money/ability to pay, expert opinion, fee/pitch, close/next step.
   - Track which required items have been captured.
   - Tell the agent what is missing before they move on.
   - Keep the guidance broad and strategic: "you are still in discovery; get tax year, agency, balance, and enforcement risk before talking price."

2. **Live reactions to important moments**
   - Listen for objections, questions, buying signals, fear, price resistance, legitimacy concerns, DNC/hostility, and specific tax concepts.
   - React quickly with a short interpretation and a suggested way to steer.
   - If the moment is grounded in a tax issue, attach the relevant tax-speaking guidance without overexplaining the law.
   - Prefer "how to handle this moment" over canned scripts.

## Guide Backbone

The guide should be deterministic/static first, then AI-read:

```json
{
  "phase": "discovery",
  "requiredBenchmarks": [
    {"id":"agency", "label":"IRS or state?", "status":"missing"},
    {"id":"balance", "label":"Approximate amount owed", "status":"captured"},
    {"id":"taxYears", "label":"Years involved", "status":"missing"},
    {"id":"enforcement", "label":"Lien/levy/garnishment/deadline", "status":"unknown"},
    {"id":"income", "label":"W-2, 1099, business, payroll", "status":"missing"},
    {"id":"abilityToPay", "label":"Can they afford resolution?", "status":"unknown"}
  ],
  "advanceWhen": "core tax facts and urgency are known",
  "agentInstruction": "Stay in discovery until agency, years, balance, and urgency are captured."
}
```

This backbone should not depend on the model inventing the call structure. The
AI can update statuses and explain the next best move, but the benchmark list is
owned by the app/config.

## Runtime Panels

The UI should map directly to the model responsibilities:

1. **Transcript**
   - Fast, readable, scrollable.
   - Shows raw/corrected/low-confidence state if available.
   - Clicking a line can feed "Ask the coach" as context.

2. **Guideposts**
   - Long-term phase guidance.
   - "Where are we in the call?"
   - "What benchmarks are done?"
   - "What is missing before the next phase?"
   - "What should the agent focus on now?"

3. **Reactions / Objections**
   - Moment-specific feedback.
   - Objection handling.
   - Buying signal handling.
   - Tax-topic explanation guidance when the objection/question is tax-grounded.

4. **Ask the Coach**
   - Agent can click transcript lines, guideposts, reactions, objections, or form fields into a question.
   - The ask should carry structured context items, not force the agent to retype the call.
   - Multiple context items should be allowed.
   - Answers should appear in their own guidance/history area, separate from automatic reactions.

5. **Form / Call Details**
   - Agent-entered facts improve the guide.
   - Form values feed strategy and phase benchmarks.
   - The form should not block live reactions.

## Model Responsibilities

### Deterministic layer

Owns cheap and exact work:

- voicemail / machine / screener gates;
- source/case guide selection;
- benchmark schema;
- keyword and alias match bank;
- DNC/compliance hard stops;
- tax-topic candidate lookup;
- stopword filtering;
- dedupe/rate caps.

### Mini layer

Owns semantic filtering and progress updates:

- read the current VAD/final transcript;
- read deterministic candidate matches;
- decide which keys are actually relevant;
- update phase benchmark statuses;
- write a compact memory/progress brief;
- identify whether a live reaction is needed.

Mini should return structured state, not prose:

```json
{
  "phaseUpdate": {
    "phase": "discovery",
    "captured": ["balance"],
    "missing": ["taxYears", "agency", "enforcement"],
    "advanceReady": false,
    "nextFocus": "Get IRS/state, years, and enforcement deadline before price."
  },
  "reaction": {
    "needed": true,
    "type": "price_objection",
    "keys": ["money_pressure", "fee_objection"],
    "snippet": "I can't afford that",
    "instruction": "Acknowledge pressure, tie fee to stopping the immediate risk, then qualify ability to pay."
  }
}
```

### Sonnet layer

Owns writing and judgement:

- turn mini's structured state into useful guidance;
- decide WAIT vs guide when the thought is incomplete;
- produce guidepost text and reaction text;
- apply psychology/humor/sales doctrine;
- avoid repeating old advice;
- keep wording agent-usable and short.

Sonnet output should be structured for UI placement:

```json
{
  "guidepost": {
    "title": "Stay in discovery",
    "body": "You still need agency, years, and whether anything is being levied or garnished. Do not move to price yet.",
    "phase": "discovery"
  },
  "reaction": {
    "title": "Price concern",
    "body": "Slow down and validate. Tie cost to the immediate risk, then ask what they can reasonably do today.",
    "relatedKeys": ["money_pressure", "fee_objection"]
  },
  "dialogSuggestion": "I hear you. Before we talk dollars, let me make sure we know exactly what they can do to you and how fast."
}
```

## Live Reaction Rules

- Do not react to every line.
- React when the line changes call strategy, reveals a tax fact, shows an objection, shows pain, shows buying intent, or creates compliance risk.
- Guideposts can update more slowly than reactions.
- Reactions should be fast and short.
- Guideposts should be stable and cumulative.
- The transcript correction sidecar should never trigger a second live reaction by itself.

## Call-End Products

The same tracked state should feed the end-of-call cleaner:

- sparse Logics activity summary;
- communication-panel call summary;
- agent feedback email when duration/substance thresholds are met;
- manager outlier email for very high/low longer calls;
- call grader using guide benchmarks + transcript + reactions + outcome;
- full context reset after drain.

The live loop should not wait on any of that. At call end, dump the structured call state to the worker and move on.

## Implementation Direction

1. Build the fixed guide schema and phase benchmark config.
2. Make mini update benchmark state and reaction candidates as structured JSON.
3. Make Sonnet return separate `guidepost`, `reaction`, and optional `dialogSuggestion`.
4. Render those as three panels without changing the transcript stream first.
5. Wire Ask the Coach to accept structured context items from transcript/guidepost/reaction/form.
6. Keep transcript correction as an annotation sidecar only.
7. Add telemetry:
   - phase changes;
   - benchmark captured/missing;
   - reaction type counts;
   - guidepost latency;
   - reaction latency;
   - ask count and answer latency;
   - model usage by component.

The north star: the agent should always know where they are in the call, what is
missing, what objection just happened, and what to do next.

## High-Level Feature Boundaries

The next coach should be thought of as six separate features that talk to each
other, not one monolithic "coach response" surface.

1. **Transcript**
   - The live record of what is being said.
   - Fast, readable, scrollable, and selectable.
   - May show raw and corrected/translated text, but the transcript itself is a
     feature, not the coach.

2. **Long-Term Call Guidance**
   - The call structure and benchmark tracker.
   - Watches the whole call arc: opening, discovery, diagnosis,
     representation, financial qualification, close.
   - Tells the agent what has been accomplished, what is missing, and what phase
     they should stay in or move toward.

3. **Short-Term Reactions**
   - Moment-specific feedback only.
   - Fires for objection identification, important buying signals, compliance
     risk, and specific tax issues.
   - Should not react to every line or become a second transcript.

4. **Semantic Transcript Translation**
   - A sidecar that makes messy STT more useful.
   - Corrects/normalizes tax terms, names, notice codes, and garbled phrasing
     where confidence allows.
   - Should improve display, memory, summaries, and Ask the Coach context
     without slowing the live reaction path.

5. **Interview Form**
   - The agent-entered structured facts.
   - Feeds the long-term guide and Ask the Coach.
   - Should improve guidance without blocking transcript/reaction flow.

6. **Ask The Coach**
   - Agent-initiated questions based on selected context.
   - Can use transcript lines, guide benchmarks, reaction cards, tax concepts,
     translated text, and form fields.
   - Answers should clearly show what context the agent asked about.

The UI should preserve these boundaries. The transcript can feed guidance.
Guidance can reference the transcript. Reactions can create Ask context. The
form can improve guidance. But each feature should remain independently
understandable and testable.

## Middle Section Call Guide Plan

Sources reviewed for this plan:

- `docs/LIVE_PROSPECT_COACH_PLAYBOOK.md`
- `packages/shared-services/src/universalSalesScript.md`
- `packages/shared-services/src/taxResolutionSalesTrainerPrompt.liveTurn.md`
- `packages/shared-services/src/taxResolutionSalesTrainerPrompt.md`
- `packages/shared-services/src/resolutionPitchDoctrine.md`
- `docs/COACH_DICTIONARY_MATRIX.md`

The middle section should be built from the sales guide, not from whatever the
model feels like saying on a given transcript chunk. The fixed guide owns the
call structure. AI listens to the call, marks progress with evidence, and
suggests the next move.

### Middle Section Job

The middle section should answer four questions at all times:

1. Where are we in the call?
2. What has already been captured?
3. What is missing before the agent moves forward?
4. What just happened that needs an immediate reaction?

It should not be a scrolling script. It should be a live operating panel:

```text
Current phase
  -> required benchmarks
  -> captured facts with transcript evidence
  -> missing facts
  -> current risk/objection
  -> next best question or steering move
```

The agent should be able to glance at it and know: stay in discovery, move to
representation, gather financials, hold price, or close.

### Middle Section Layout

Recommended center panel:

1. **Phase Header**
   - Current phase label.
   - Confidence.
   - One-sentence purpose.
   - "Advance only when..." condition.

2. **Benchmark Checklist**
   - Required items for the phase.
   - Status: `missing`, `captured`, `unclear`, `blocked`.
   - Small evidence snippet when captured.
   - No benchmark should be marked complete without transcript or form evidence.

3. **Next Move**
   - The single most useful next question or steering instruction.
   - Short enough for an agent to act on during a live call.
   - Example: "Get agency, years, and enforcement before talking price."

4. **Live Reaction Card**
   - Appears only when the prospect says something response-worthy.
   - Objection, pain point, buying signal, tax concept, compliance risk, or
     decision-maker friction.
   - Should include: what happened, why it matters, how to respond.

5. **Context Chips**
   - Tax concepts detected.
   - Objections retired/active.
   - Compliance warnings.
   - Agent can click chips into Ask the Coach.

The middle section should be stable. Reactions can flash in and out; the phase
guide should not jerk around on every sentence.

## Call Phases And Benchmarks

These phases combine the universal sales script, live prospect playbook, and
sales trainer phase definitions. The agent-facing labels can be simpler than
the backend keys.

### Phase 0 - Pre-Call Guide Load

This is not visible as a call phase, but it powers the first view.

Load from case/source/form:

1. Brand/domain: TAG or WYNN.
2. Inbound/outbound mode.
3. Lead source: form, mailer, public record, callback, appointment.
4. Known opt-in/source details.
5. Known tax issue hints: debt range, state, notice, lien, unfiled, 1099,
   payroll, state, audit.
6. Known contact facts: name, phone, email, city/state.
7. Known risk flags: DNC, prior bad contact, existing client/resolution-only,
   language preference.

AI should listen for:

- whether the agent uses the correct brand;
- whether the agent references the right source;
- whether the prospect recognizes the source or challenges it;
- whether the opening should be trust-first or problem-first.

Middle section first instruction:

```text
Open with firm identity, source context, and permission. Do not diagnose until
trust/gate is passed.
```

### Phase 1 - Opening, Gate, And Legitimacy

Goal: earn enough trust to continue and confirm basic identity/contact facts.

Line-by-line accomplishments:

1. State agent name and firm name.
2. Clearly say the firm is not the IRS or government.
3. For outbound, reference the opt-in/source and approximate timing.
4. Ask permission to continue or confirm they have a minute.
5. Confirm the right person.
6. Confirm or gather best callback number.
7. Confirm or gather email.
8. Confirm city/state.
9. Get a verbal signal that they want help or are willing to hear the process.
10. Handle trust objections without defensiveness.

AI listens for:

- "who are you";
- "are you the IRS";
- "is this a scam";
- "how did you get my number";
- "I never signed up";
- "I'm busy";
- "not interested";
- "take me off";
- source recognition or source denial;
- permission to continue;
- confirmed name/phone/email/location.

Guidepost behavior:

- If trust is not passed, keep the agent in this phase.
- If the agent asks tax/financial questions before identity/trust, warn:
  "Slow down. Establish firm/source first."
- If DNC/removal is clear, surface terminal compliance instruction.
- If the prospect is busy, steer to a precise callback or 60-second relevance
  check.

Advance when:

- firm/source/permission are handled;
- right person is confirmed;
- at least the basic contact facts are confirmed or already trusted from form;
- prospect gives a meaningful willingness to continue.

### Phase 2 - Tax Problem Discovery

Goal: understand the tax issue before pitching services.

Line-by-line accomplishments:

1. Identify agency: IRS, state, or both.
2. Identify approximate balance.
3. Identify tax years involved.
4. Identify filing status: all filed or unfiled years.
5. Identify notice type or document if known.
6. Identify notice date/deadline when relevant.
7. Identify collection activity: lien, levy, garnishment, bank freeze,
   revenue officer, state action.
8. Identify whether enforcement is active now or only threatened.
9. Identify income category: W-2, 1099/self-employed, business, payroll/941.
10. Identify prior attempts: payment plan, CPA, tax firm, IRS direct contact.
11. Identify life impact: paycheck, bank, home, business, family, stress.
12. Reflect back the issue in the prospect's words.

AI listens for tax concepts:

- IRS/federal: IRS, CP501, CP503, CP504, CP2000, LT11, Letter 1058, 1040,
  1099, W-2, 941, 940, transcript, POA.
- State: state, FTB, EDD, franchise tax board, state levy, state garnishment,
  sales tax, unemployment tax.
- Collection pressure: levy, lien, wage garnishment, bank levy, frozen funds,
  revenue officer, final notice.
- Compliance: unfiled, years behind, substitute return, SFR, missing W-2,
  missing 1099, estimated taxes.
- Business/payroll: 941, 940, trust fund, responsible person, employee
  withholding, business still operating.
- Audit/adjustment: audit, exam, CP2000, underreporter, proposed assessment,
  receipts, documentation.
- Spouse/identity: ex-spouse, divorce, joint return, innocent spouse, identity
  theft, debt is not mine.

Guidepost behavior:

- Keep the agent from jumping to services or price before facts.
- Prefer one next fact at a time.
- If a notice is named, explain only enough to ask the next escalation question.
- If CP504/LT11/1058/levy/garnishment appears, mark urgency and ask whether
  money is being taken now.
- If state appears, screen for federal issues without dismissing state.
- If 1099/self-employed appears, ask years and records/expenses.
- If payroll appears, separate business and personal exposure.

Advance when:

- agency, balance, years, filing status, and collection/enforcement status are
  known or explicitly unknown;
- at least one pain/urgency point is captured;
- prior attempts or current representation status is known;
- agent has reflected the situation back.

### Phase 3 - Diagnosis And Representation Frame

Goal: connect the discovered problem to what the firm actually does, without
promising a result.

Line-by-line accomplishments:

1. Summarize the case in the prospect's language.
2. Name the active risk or uncertainty.
3. Explain that strategy depends on records/transcripts/notices.
4. Explain representation as lawful access and communication, not magic.
5. Tie POA/authorization/transcript pull to the discovered problem.
6. Tie filing/compliance work to unfiled/SFR/missing return facts.
7. Tie collection response to levy/lien/garnishment/final notice facts.
8. Tie state authorization to state facts when present.
9. Avoid naming a specific resolution program unless qualified.
10. Confirm the prospect wants help organizing and resolving it.

AI listens for:

- agent giving generic pitch before diagnosis;
- agent promising "we can stop it" or "we can settle it";
- prospect asking "what do you actually do";
- prospect asking "how does this work";
- prospect asking "can you guarantee";
- prospect asking "can I just call the IRS";
- prospect saying they have CPA/attorney/tax guy;
- prospect saying a prior firm failed.

Guidepost behavior:

- If the agent is generic, show: "Tie the service to the exact facts: years,
  notices, and enforcement."
- If the prospect asks for guarantee, hard-stop any guarantee language.
- If the prospect has a CPA, distinguish filing from resolution/collection.
- If prior firm failed, instruct the agent to ask what happened before
  differentiating.

Advance when:

- the prospect understands the first-step representation/review process;
- services are tied to facts;
- no unsupported program promise is made;
- prospect is still engaged.

### Phase 4 - Financial Snapshot And Qualification

Goal: gather enough financial context to know what options and payment
structure are plausible.

Line-by-line accomplishments:

1. Employment/work type.
2. Monthly or yearly income range.
3. Self-employed/business income if relevant.
4. Household size and dependents.
5. Major expenses: rent/mortgage, car, childcare, medical, unusual expenses.
6. Bank/cash pressure where relevant.
7. Assets: home/property, retirement, business assets.
8. Ability to pay for professional help.
9. Decision-maker/payment authority.
10. Confirm whether they can start today if the scope makes sense.

AI listens for:

- money pressure;
- "I can't afford it";
- job loss, illness, divorce, family pressure;
- high expenses/hardship;
- assets/funding ability;
- spouse/advisor needs;
- reluctance to share financials.

Guidepost behavior:

- Do not let financial questions happen before tax problem/value context unless
  the agent needs one narrow fact.
- If money pressure appears early, acknowledge it but defer price until scope is
  clear.
- If the prospect truly cannot pay, steer to honest qualification instead of
  pressure.
- If they can pay, help the agent move toward close without overexplaining.

Advance when:

- income/employment and basic household/expense picture are captured;
- ability-to-pay is at least roughly known;
- payment authority/decision-maker is known;
- agent has enough to quote responsibly.

### Phase 5 - Quote, Close, And Onboarding

Goal: quote with confidence, justify scope, handle late objections, and collect
the information needed to start.

Line-by-line accomplishments:

1. Recap problem and urgency.
2. Recap what is included.
3. State the fee plainly.
4. Pause after the number.
5. If needed, explain payment structure as structure, not discount.
6. Handle one money objection honestly.
7. Handle decision objections: spouse/advisor, think about it, email me.
8. Avoid fake urgency.
9. Avoid guarantees.
10. Collect legal name/address/DOB/SSN only when commitment/authorization is
    appropriate.
11. Confirm payment method and terms.
12. Explain documents/signature/POA next step.
13. Set expectation for welcome call or next contact.

AI listens for:

- fee/price/cost/how much;
- "too expensive";
- "I need to think";
- "send me paperwork";
- "talk to spouse";
- "what am I paying for";
- "how long will this take";
- "success rate";
- "guarantee";
- payment method and card concern;
- SSN/DOB hesitation.

Guidepost behavior:

- Do not allow price objection handling before the package is clear. If price is
  raised early, treat it as a scope/value question.
- Money objection fires once; after handled, retire it and move to decision or
  process concerns.
- If the agent drops price without scope reason, flag it.
- If the agent guarantees an outcome, flag it immediately.
- If the prospect asks for paperwork, keep the call alive: send/review while on
  the line or schedule a specific callback.

Advance/complete when:

- fee and scope are stated;
- money/process objections are handled;
- prospect agrees to proceed or a specific next step is scheduled;
- required onboarding facts are captured if closing.

## AI Listening Taxonomy

The AI should listen in three layers.

### 1. Progress signals

These update the guide checklist:

- source/permission passed;
- contact facts confirmed;
- agency captured;
- balance captured;
- years captured;
- filing status captured;
- notice/deadline captured;
- enforcement status captured;
- pain/urgency captured;
- prior attempts captured;
- representation process explained;
- services tied to facts;
- financial snapshot captured;
- quote delivered;
- payment terms delivered;
- commitment captured.

### 2. Live reaction signals

These create a reaction card:

- trust/identity concern;
- source/opt-in concern;
- DNC/removal;
- hostility;
- busy/timing issue;
- prior firm failure;
- already represented;
- spouse/advisor;
- need to think;
- price/affordability;
- guarantee/success-rate trap;
- buying signal;
- emotional pressure;
- money/life pressure;
- active enforcement;
- high-value tax concept;
- compliance risk.

### 3. Compliance/safety signals

These override normal coaching:

- do-not-call/remove me;
- government affiliation confusion;
- false guarantee;
- fake urgency;
- payment before quote/scope accepted;
- unsupported legal/tax conclusion;
- harassment after refusal;
- disclosing unrelated caller information.

## Structured State Contract

Mini should own benchmark classification and return a compact structured state.
Sonnet should own the final wording. The app owns the benchmark definitions.

Recommended mini output:

```json
{
  "phase": {
    "key": "tax_discovery",
    "confidence": 0.82,
    "reason": "Prospect is discussing balance, years, and levy risk."
  },
  "benchmarks": [
    {
      "id": "agency",
      "status": "captured",
      "value": "IRS",
      "evidence": "the IRS sent me a CP504"
    },
    {
      "id": "taxYears",
      "status": "missing",
      "value": null,
      "evidence": null
    }
  ],
  "reactionCandidate": {
    "needed": true,
    "type": "collection_pressure",
    "severity": "high",
    "snippet": "they said they can garnish me",
    "keys": ["collection_pressure", "irs_notice"],
    "instruction": "Confirm whether money is being taken now, then get notice date and year."
  },
  "riskFlags": [],
  "nextMissing": ["taxYears", "noticeDate", "activeEnforcement"],
  "objections": {
    "active": [],
    "retired": ["how_got_number"]
  }
}
```

Recommended Sonnet/UI output:

```json
{
  "guidepost": {
    "phase": "tax_discovery",
    "title": "Stay in discovery",
    "body": "You have agency and possible levy risk. Get the year, notice date, balance, and whether money is being taken now before talking price.",
    "nextBestQuestion": "What tax year and date are on that CP504, and has anything actually been garnished yet?"
  },
  "reaction": {
    "type": "collection_pressure",
    "title": "Levy risk",
    "body": "Calm urgency. Do not promise a stop. Confirm if enforcement is active, then move to representation and records.",
    "tryLine": "That can become urgent, so first I need to know whether they are taking money now or whether this is still a warning."
  }
}
```

## Update Rules

1. A benchmark can only become `captured` with transcript or form evidence.
2. Captured facts should not be re-asked unless the caller contradicts them.
3. Guideposts update on completed thoughts, not every partial delta.
4. Reactions can update quickly, but only for response-worthy moments.
5. Price objection guidance is gated until scope/package is explained.
6. Money objections are retired after one real handling attempt.
7. DNC/removal overrides every other guide.
8. Tax facts should be surface-level guidance plus next question, not deep legal
   advice.
9. Transcript correction can improve display/memory but must not create a second
   reaction by itself.
10. The call-end worker uses the same benchmark state; the live loop does not
    wait on grading, summaries, Logics updates, or emails.

## Implementation Plan

1. Create a fixed call guide config.
   - File shape: phase definitions, benchmark ids, labels, advance rules,
     allowed objection types, and guardrails.
   - The config should be app-owned and versioned, not model-invented.

2. Map match-bank keys to guide concepts.
   - `legitimacy` -> Phase 1 trust/source.
   - `irs_notice`, `state_tax`, `collection_pressure`, `unfiled_returns`,
     `payroll_tax`, `self_employment`, `audit_adjustment`, `spouse_identity`
     -> Phase 2 tax discovery.
   - `representation` -> Phase 3 representation frame.
   - `money_pressure`, `fees_close` -> Phase 4/5 qualification and close.
   - `objection` plus objection-bank type -> reaction card.

3. Add a mini progress updater.
   - Input: latest completed transcript, recent memory, form facts, current
     guide state, deterministic candidate keys.
   - Output: phase, benchmark status changes, reaction candidate, risk flags,
     next missing facts.
   - Keep this JSON-only and cache-friendly.

4. Add a Sonnet guide/reaction writer.
   - Input: mini structured state, fixed guide text for current phase, relevant
     objection/tax guidance, recent memory.
   - Output: guidepost, reaction, optional `tryLine`.
   - Sonnet decides WAIT vs output, but not the benchmark schema.

5. Render the middle section from state.
   - Phase header.
   - Checklist.
   - Evidence snippets.
   - Next move.
   - Reaction card.
   - Context chips for Ask the Coach.

6. Wire Ask the Coach to structured context.
   - Any benchmark, reaction, transcript line, tax concept, or form field can be
     added as context.
   - Ask answers should reference selected context explicitly so the agent knows
     what the answer is about.

7. Add telemetry.
   - Phase changes.
   - Benchmark captured/missing counts.
   - Reaction count by type.
   - Risk/compliance override count.
   - Mini latency.
   - Sonnet latency.
   - Ask latency.
   - Model cost by component.

8. Add tests before live use.
   - Opening trust objection keeps phase at opening.
   - IRS CP504 moves to tax discovery and asks year/date/enforcement.
   - State issue screens for federal without ignoring state.
   - Price question before scope becomes a value/scope guide, not a money
     objection.
   - DNC/removal suppresses normal coaching.
   - Guarantee language triggers compliance warning.
   - Captured benchmark has evidence.
   - Call-end summary can be built from the same state without live-loop work.

The simplest version worth building first is:

```text
fixed guide config
  -> mini updates phase/checklist/reactionCandidate
  -> Sonnet writes guidepost/reaction
  -> UI renders phase checklist + next move + reaction card
```

That gets the middle section out of "dialog line" mode and into "call control"
mode without slowing the transcript or making the model invent the structure.

## Code Audit And Transition Plan

This audit is based on the current local code in place. The important finding is
that the app already has most of the raw material for the six-feature coach, but
the boundaries are fused together. Transcript, memory, guidepost, reaction, and
Ask all exist, but the backend still mostly emits `context` plus a `dialog.say`
string, and the frontend reverse-engineers guideposts/reactions from that string.

### Current Code Map

Frontend:

- `apps/web-client/src/lib/liveCoach/stream.ts`
  - Defines the wire contract:
    - `LiveCoachTranscript`
    - `LiveCoachContext`
    - `LiveCoachDialog`
    - `LiveCoachSession`
    - `LiveCoachEvent`
    - `LiveCoachAsk`
  - This file is the right place to add optional structured fields before any UI
    behavior changes.

- `apps/web-client/src/workspaces/cx/LiveCoachPanel.tsx`
  - Owns the agent-facing coach rendering.
  - Already keeps:
    - transcript rows as `conversationItems`;
    - durable memory as `factLedger` and `callSummary`;
    - ask context and multiple ask drafts;
    - local `guidepostHistory`;
    - local `reactionHistory`.
  - It already supports `panelView = "coach" | "interview" | "guidance"` and a
    `contentOverride`, so the UI can evolve without inventing a new mount point.
  - The weak spot is `parseNavigatorSay()`: it parses `Read:`, `Steer:`, and
    `Try:` out of one text string. That is fine as a compatibility bridge, but
    it should not be the permanent data model.

Backend:

- `packages/shared-services/src/liveCoachBusService.js`
  - Main session/event bus.
  - The central live path is:
    - `processText`
    - `processContextAndDialog`
    - `semanticContextJudge`
    - `createSonnetDialogDraft`
    - `requestDialogComposition`
  - Durable memory already exists through:
    - `buildRecentCallMemory`
    - rolling digest
    - `factLedger`
    - `callSummary`
    - `context.digest` events.
  - Ask already exists as a separate pull channel through `coach.answer` events.

- `packages/shared-services/src/liveCoachSanitizedPipeline.js`
  - Deterministic match bank, voicemail/screener gates, context rules, tactics,
    prompt payloads, and dialog draft creation.
  - The rules are useful and should stay, but their output needs to feed
    structured guide/reaction state, not only a prompt.
  - Current Sonnet prompt asks for `Read`, `Steer`, and optional `Try`. That is
    conceptually close to the desired split, but it is still serialized as one
    string.

- `packages/shared-services/src/liveCoachTranscriptTranslator.js`
  - Already designed correctly as a sidecar:
    - deterministic regex normalization first;
    - model cleanup through `liveCoach.translate`;
    - 700ms default timeout;
    - fail-open fallback;
    - explicit instruction that correction must not block guidance.
  - This should power semantic transcript translation as annotation, not as the
    trigger for coaching.

- `packages/shared-services/src/aiSandbox/tasks.js`,
  `packages/shared-services/src/aiSandbox/rules.js`,
  `packages/shared-services/src/aiTaskRegistry.js`
  - The live-coach AI task map already has:
    - `liveCoach.callStrategy`
    - `liveCoach.rollingDigest`
    - `liveCoach.contextJudge`
    - `liveCoach.dialogComposer`
    - `liveCoach.callGrader`
    - `liveCoach.translate`
  - Any new model behavior should be expressed as a task here, not as a direct
    provider call elsewhere.

### What Already Matches The Six Features

1. **Transcript**
   - Already exists as streamed transcript events and frontend conversation rows.
   - Keep this fast and raw. It is the source of timing truth.

2. **Long-Term Call Guidance**
   - Partly exists through `callSummary`, `factLedger`, `memoryBrief`, and the
     `Steer:` portion of `dialog.say`.
   - Missing: first-class phase, benchmark, missing-fact, and next-move state.

3. **Short-Term Reactions**
   - Partly exists through deterministic context matches, tactic rules,
     objection bank entries, and the `Read:` / `Try:` portions of `dialog.say`.
   - Missing: first-class reaction objects with trigger, type, severity, evidence,
     and optional say line.

4. **Semantic Transcript Translation**
   - The translator service exists and has the right fail-open shape.
   - Missing: event wiring and frontend display as a correction/annotation.

5. **Interview Form**
   - The coach already accepts call strategy/form context in metadata and prompt
     payloads.
   - Missing: a stable app-owned guide config that turns form facts into phase
     benchmarks instead of letting prompts improvise structure.

6. **Ask Specific Questions**
   - Already largely exists. Transcript lines, facts, guideposts, and reactions
     can seed Ask context.
   - Missing: structured references to guide benchmark ids and reaction ids, so
     Ask can say exactly what object it is answering about.

### Where The Current Boundaries Are Fused

1. `LiveCoachContext` is carrying too many jobs.
   - It includes raw text, deterministic matches, mini judgement, tactics,
     completeness, memory, and compose gating.
   - It should stay as the "what did mini/determinism detect?" object, but not
     become the final UI object.

2. `LiveCoachDialog.say` is overloaded.
   - Today it is response line, reaction, guidepost, and sometimes coaching
     policy all at once.
   - The UI then parses that string into guide/reaction histories.
   - Transition target: `dialog.say` becomes only optional exact wording. Guide
     and reaction become their own fields/events.

3. Long-term progress and short-term reactions are mixed.
   - A tax fact, objection, pain point, phase movement, and exact line can all be
     emitted in the same dialog.
   - The agent experience should separate:
     - "Where are we in the call?"
     - "What just happened?"
     - "What should I say if wording matters?"

4. Correction is not wired as a first-class transcript annotation.
   - The translator exists, but the live contract does not yet expose a stable
     `rawText -> correctedText` event that the UI can display without retriggering
     coaching.

5. The guide schema is still prompt-shaped.
   - Phases and benchmarks are described in docs/prompts, not as a versioned app
     config.
   - That makes testing and caching harder than it needs to be.

### Transition Strategy

The transition should be additive first, behavioral second. Do not break the
existing `context`/`dialog` flow until structured events have proven they can run
beside it.

#### Phase 0 - Contract Only, No Behavior Change

Add optional types to `stream.ts`:

```ts
export type LiveCoachGuideState = {
  phase?: { id?: string; label?: string; confidence?: number };
  benchmarks?: Array<{
    id: string;
    label: string;
    status: "missing" | "partial" | "captured" | "blocked";
    evidence?: string;
    lastTranscriptId?: string;
  }>;
  nextMove?: string | null;
  watchPoints?: string[];
  updatedAt?: string | null;
};

export type LiveCoachReaction = {
  id?: string | null;
  type?: "objection" | "tax_fact" | "pain_point" | "buying_signal" | "compliance" | "emotion" | "stall";
  trigger?: string | null;
  evidence?: string | null;
  guidance?: string | null;
  tryLine?: string | null;
  severity?: "info" | "medium" | "high";
  sourceContextKeys?: string[];
  transcriptId?: string | null;
};

export type LiveCoachTranscriptCorrection = {
  transcriptId?: string | null;
  rawText: string;
  correctedText: string;
  changed?: boolean;
  corrections?: string[];
  provider?: string | null;
  model?: string | null;
  ms?: number | null;
};
```

Then add optional fields to `LiveCoachEvent` and `LiveCoachSession.latest`:

- `guideState`
- `reaction`
- `correction`

Acceptance: old events still compile and render exactly as before.

#### Phase 1 - App-Owned Guide Config

Create a pure config module, likely:

`packages/shared-services/src/liveCoachCallGuideConfig.js`

It should contain:

- phase ids and labels;
- benchmark ids;
- allowed reactions by phase;
- advance rules;
- compliance stops;
- mapping from context keys to phase/benchmark candidates.

This module should make no model calls. It should be unit-testable with plain
objects.

Acceptance:

- `cp504` / `irs_notice` maps to tax discovery;
- `state_tax` asks whether it is state-only or also IRS;
- price/fee before facts captured does not jump straight to close;
- DNC/removal maps to compliance stop.

#### Phase 2 - Mini Progress Updater

Extend the existing `liveCoach.contextJudge` output, or create a sibling task if
the schema becomes too crowded.

Input:

- latest completed transcript;
- deterministic matches;
- current guide state;
- recent memory summary;
- form facts/call strategy;
- selected context snippets.

Output:

- phase update;
- benchmark status changes;
- missing facts;
- reaction candidate;
- risk/compliance flags;
- whether Sonnet needs to write anything.

Important: mini should not write prose. It should update state and select what
kind of coach output is needed.

Acceptance:

- mini can update guide state without requiring Sonnet;
- a non-coachable but useful fact can update benchmarks silently;
- only objection/tax/pain/buying/compliance moments trigger reactions.

#### Phase 3 - Structured Reaction/Guide Events

Emit new events from `liveCoachBusService.js`:

- `guide.update`
- `reaction.update`
- `transcript.correction`

Keep emitting the legacy `context` and `dialog` events during this phase.

The first implementation can derive `guide.update` and `reaction.update` from
the same `contextFrame` already used for `dialog`. That keeps the two systems
honest while proving the contract.

Acceptance:

- UI can show guide/reaction from structured events if present;
- if structured events are absent, UI falls back to the old parsed
  `dialog.say`;
- no duplicate reaction is emitted for a transcript correction.

#### Phase 4 - Sonnet Writes Only What Needs Writing

Split Sonnet's job:

- Long-term guidepost wording:
  - short, stable, phase-aware;
  - based on guide state and memory;
  - not necessarily every transcript turn.

- Short-term reaction wording:
  - only for objections, specific tax issues, pain points, buying signals, and
    compliance moments;
  - optional `tryLine` when exact words matter.

Compatibility rule:

- During rollout, continue filling `dialog.say` with a readable combination of
  guide/reaction/tryLine so old clients do not go blank.
- New clients should prefer structured `guideState` and `reaction`.

Acceptance:

- `dialog.say` can disappear later without losing the guide panel.
- Sonnet is not called for every harmless transcript line.
- Ask can cite a reaction id or benchmark id.

#### Phase 5 - Semantic Transcript Translation Sidecar

Wire `liveCoachTranscriptTranslator` async after final transcript events.

Rules:

- Never block transcript display.
- Never block guide/reaction.
- Never use correction as the sole trigger for a new reaction.
- Store/display as annotation:
  - raw text;
  - corrected text;
  - correction list;
  - model/provider/timing.

Suggested event:

```json
{
  "type": "transcript.correction",
  "transcriptId": "t123",
  "correction": {
    "rawText": "i got a cp five oh four",
    "correctedText": "I got a CP504",
    "changed": true,
    "corrections": ["cp five oh four -> CP504"]
  }
}
```

Acceptance:

- raw transcript appears immediately;
- corrected text appears later without layout jump;
- memory/closeout can prefer corrected text;
- live reactions still use the original final transcript plus deterministic
  normalized tax terms.

#### Phase 6 - UI Cutover

Update `LiveCoachPanel.tsx` to prefer structured data:

- Transcript panel:
  - `conversationItems`;
  - optional correction annotation.

- Middle guide panel:
  - `guideState.phase`;
  - benchmarks;
  - next missing facts;
  - watch points;
  - call strategy/form facts.

- Reaction panel:
  - latest `reaction`;
  - reaction history;
  - optional `tryLine`.

- Ask panel:
  - context chips can reference:
    - transcript line;
    - correction;
    - benchmark;
    - reaction;
    - form field;
    - fact ledger row.

Keep `parseNavigatorSay()` as fallback until structured event coverage is proven
on live traffic.

### Suggested First Patch

The safest first coding patch is not a model patch. It is a contract/config
patch:

1. Add optional structured types in `stream.ts`.
2. Add reducer fields in `LiveCoachPanel.tsx` for:
   - `guideState`;
   - `reaction`;
   - `correctionsByTranscriptId`.
3. Add `liveCoachCallGuideConfig.js` as pure config.
4. Add unit tests for the config mapping.
5. Do not change prompts, model calls, or rendered layout yet.

That patch gives us a stable place to land structured events without touching
latency-sensitive coaching behavior.

### Second Patch

Add shadow structured emissions:

1. In `processContextAndDialog`, after the mini/context result is known, derive
   a guide candidate and reaction candidate from `contextFrame`.
2. Emit `guide.update` and `reaction.update`.
3. Store them in `session.latest`.
4. Keep `dialog` exactly as-is.
5. Add logs:
   - guide phase;
   - benchmark changes;
   - reaction type;
   - selected keys;
   - mini latency;
   - Sonnet latency if called.

This should be a shadow pass: visible UI can still use the old panels while the
new objects prove themselves.

### Third Patch

Render structured guide/reaction behind a local/client flag:

- If structured guide exists, render the middle guide panel from it.
- If not, use existing parsed guidepost.
- If structured reaction exists, render reaction panel from it.
- If not, use existing parsed reaction.

This keeps the agent screen stable while letting us test the new shape.

### Transition Risks

1. **Latency creep**
   - Do not put translation in the live reaction path.
   - Do not make Sonnet produce every surface every time.
   - Mini updates state; Sonnet writes only when wording/guidance is worth it.

2. **Prompt/cache bloat**
   - Do not paste the full guide into every dynamic prompt.
   - Keep guide config app-owned and pass compact ids/summaries.
   - Put stable doctrine in cacheable system prompts, dynamic call facts in user
     payload.

3. **Double coaching**
   - A final transcript should trigger one context/reaction decision.
   - A correction event must not retrigger coaching by itself.

4. **Mismatched truth**
   - During shadow mode, structured guide/reaction must be derived from the same
     `contextFrame` that produced the legacy dialog.
   - Do not allow separate mini calls to disagree unless the logs explicitly show
     both decisions.

5. **UI churn**
   - Keep one reducer and event-specific slices.
   - Avoid recomputing all panels on every small stream event.

6. **Ask context ambiguity**
   - Ask responses should name the selected object: transcript line, benchmark,
     reaction, form field, or fact.
   - The user should see what they clicked before the answer streams.

7. **Compliance leakage**
   - DNC/removal and voicemail/screener gates stay ahead of all normal coaching.
   - Compliance reactions can suppress normal sales reactions.

### Smoke Test Checklist

Use a replay harness or local fake session before live:

1. Raw transcript appears immediately.
2. Correction arrives later and does not retrigger coaching.
3. "I owe the IRS" updates tax discovery and federal-debt context.
4. "I got a CP504" marks notice/enforcement evidence.
5. "I already have a CPA" creates an objection reaction, not a phase advance.
6. "How much does it cost?" before discovery produces value/scope guidance, not
   a close.
7. "Take me off your list" suppresses normal coaching.
8. Ask seeded from a transcript line includes that exact selected text.
9. Ask seeded from a benchmark references the benchmark.
10. Ask seeded from a reaction references the reaction trigger.
11. Old clients still render `dialog.say`.
12. New clients render structured guide/reaction when present.
13. Mini latency and Sonnet latency are logged separately.
14. No correction/transcript event causes duplicate dialog composition.

### Final Shape

The target loop should look like this:

```text
raw transcript final
  -> deterministic match bank
  -> mini context/progress judge
       -> guideState update
       -> reaction candidate
       -> memory facts
  -> Sonnet only when useful
       -> guide wording and/or reaction wording
  -> UI surfaces:
       transcript
       long-term guide
       short-term reactions
       interview/form facts
       ask coach

correction sidecar
  -> transcript annotation
  -> memory/closeout preference
  -> never a new live reaction by itself
```

This is the clean transition: keep the speed of the current loop, stop parsing a
single prose string as the data model, and let each visible coach surface have
one explicit job.

## Nano Translator Over Deterministic Repair

If we choose nano instead of a larger deterministic repair layer, the split
should be very strict:

```text
STT raw text
  -> nano translator
  -> Sonnet coach decision
```

Nano is not the coach. Nano should not decide phase, objection type, strategy,
importance, or whether to respond. Nano should only make the transcript more
usable.

### Nano Job

Input:

- raw STT text;
- role/channel;
- optional previous one or two transcript lines for local continuity;
- a small cached vocabulary/glossary of tax terms and company names;
- no sales doctrine;
- no coaching instructions.

Output:

```json
{
  "rawText": "i got a cp five oh four",
  "repairedText": "I got a CP504",
  "confidence": "high",
  "changed": true,
  "corrections": [
    {
      "from": "cp five oh four",
      "to": "CP504",
      "reason": "known tax notice term"
    }
  ],
  "suspicious": false,
  "suspiciousReason": null
}
```

Hard rules:

1. Preserve meaning.
2. Never add a tax fact that was not plausibly spoken.
3. Never convert noise/silence into domain terms.
4. When uncertain, leave the word unchanged and mark confidence low.
5. Do not answer, summarize, coach, classify, or infer strategy.
6. Do not emit extra prose outside the JSON contract.

### What Determinism Still Does

Determinism should stay for hard gates and cheap safety checks, not semantic
repair:

- voicemail carrier messages;
- answering service / screener phrases;
- DNC / stop-calling compliance words;
- empty/filler/junk suppression;
- low-signal audio and low-confidence transcript handling;
- primer-echo detection if any STT prompt remains.

This keeps the dangerous rules simple and auditable while letting nano handle
the fuzzier language problem.

### Sonnet Job After Nano

Sonnet receives:

- raw text;
- repaired text;
- nano confidence/corrections;
- current guide state;
- recent call memory;
- form facts;
- transcript snippets;
- hard-gate result;
- optional glossary ids that nano touched.

Sonnet decides:

- what happened;
- whether this matters;
- phase/checklist movement;
- short-term reaction;
- key moments for grading;
- memory patch;
- what, if anything, to show the agent.

### Prompt Caching Shape

This favors a longer, cacheable Sonnet prompt:

- stable sales doctrine;
- phase/checklist definitions;
- reaction taxonomy;
- key moment taxonomy;
- compliance boundaries;
- output JSON schema;
- examples.

The dynamic payload stays small:

- latest repaired transcript;
- raw transcript;
- current guide state;
- compact memory;
- form facts;
- nano correction metadata.

That should be more cache-friendly than spreading meaning across deterministic
rules, mini prompts, and Sonnet prompts.

### Safety Tests Before Live

1. Silence/noise does not become `CP504`, `levy`, or `Wynn Tax Solutions`.
2. Spanish words are preserved when actually spoken.
3. `cp five oh four` becomes `CP504`.
4. `I owe forty thousand` does not invent IRS/state unless the speaker said it.
5. Low-confidence correction stays low-confidence and does not force coaching.
6. Nano output never contains coaching language.
7. Sonnet can still reason from raw text if nano leaves a term unchanged.
8. Correction does not trigger a second coaching event by itself.

### Revised Target Loop

```text
raw transcript final
  -> hard gates
       voicemail / screener / DNC / junk / confidence
  -> nano transcript repair
       repaired text + confidence + corrections
  -> Sonnet coach decision
       guideDelta + reaction + keyMoments + memoryPatch + display
  -> UI
       transcript, guide board, reaction card, ask context
```

The important boundary: nano fixes the words; Sonnet understands the call.

## Refined Four-Step API Architecture

The next target architecture should make the live coach a small chain of explicit
API calls. Each call has one job, one event contract, one timing log, and one
failure mode.

```text
semantic_vad low-eagerness final
  -> nano transcript repair
  -> classifier/router + writer-packet tool
  -> writer response only when needed
```

The guiding principle is: transcript accuracy can wait for the semantic final,
but the response panel should get useful guidance as quickly as the classification
path can produce it.

### Step 1 - STT Final

Source:

- OpenAI Realtime transcription.
- `semantic_vad` with low eagerness.
- No need to stream raw transcript into the visible transcript pane unless a
  later UI test proves it helps.

Output event:

```json
{
  "type": "transcript.final",
  "transcriptId": "t_123",
  "role": "prospect",
  "rawText": "i got a cp five oh four",
  "channel": "turn",
  "model": "gpt-4o-transcribe",
  "confidence": 0.82,
  "at": "..."
}
```

Notes:

- The left pane can show a listening/processing state until the repaired
  transcript arrives.
- Raw transcript should remain available for audit and correction comparison.
- Hard gates still run here or immediately before this event is allowed into the
  coach pipeline:
  - voicemail;
  - answering service / screener;
  - DNC / stop calling;
  - junk/filler;
  - low confidence;
  - primer echo if any STT prompt remains.

### Step 2 - Nano Transcript Repair

Nano is the translator. It does not coach.

Input:

```json
{
  "transcriptId": "t_123",
  "rawText": "i got a cp five oh four",
  "role": "prospect",
  "recentLocalContext": [
    "Agent: What notice did they send you?"
  ],
  "glossaryVersion": "tax-transcript-glossary.v1"
}
```

Output event:

```json
{
  "type": "transcript.repaired",
  "transcriptId": "t_123",
  "rawText": "i got a cp five oh four",
  "repairedText": "I got a CP504",
  "changed": true,
  "confidence": "high",
  "corrections": [
    {
      "from": "cp five oh four",
      "to": "CP504",
      "reason": "known tax notice term"
    }
  ],
  "suspicious": false,
  "suspiciousReason": null,
  "model": "nano",
  "elapsedMs": 0
}
```

Nano hard rules:

1. Fix recognition only.
2. Preserve speaker meaning.
3. Leave uncertain words unchanged.
4. Never add tax facts.
5. Never turn silence/noise into domain terms.
6. Never classify objections, sales tactics, phases, or coaching importance.

Frontend behavior:

- The left pane renders `repairedText` as the transcript line.
- It can optionally expose raw/correction metadata on hover or in an audit view.
- The transcript line becomes selectable Ask context.

### Step 3 - Classifier / Router

The classifier is the live observer. It reads the repaired transcript and current
call guide state, then decides what changed and whether the writer is needed.

Its core jobs:

- detect sales tactic moments;
- detect objection moments;
- detect tax terms / tax knowledge triggers;
- cross checklist items off in the middle guide;
- mark partial evidence;
- reopen incorrect assumptions when needed;
- detect advancing before the prior section is complete;
- decide whether a writer response is worth showing.

Input:

```json
{
  "transcriptId": "t_123",
  "rawText": "i got a cp five oh four",
  "repairedText": "I got a CP504",
  "currentGuideState": {
    "phase": "tax_discovery",
    "completed": ["source_confirmed"],
    "partial": [],
    "missing": ["notice_type", "tax_years", "balance", "enforcement_status"]
  },
  "recentMemory": {
    "summary": "Prospect confirmed they asked for tax help and is discussing an IRS notice.",
    "facts": []
  },
  "formFacts": {},
  "hardGate": {
    "blocked": false,
    "reason": null
  }
}
```

#### Mini / Haiku Classifier Prompt Contract

This is the prompt shape for the cheap classifier model. The model is not the
writer. It decides what kind of beat just happened, whether a catalog lookup is
needed, what guide state changed, and what compact summary should be stored.

System/developer prompt:

```text
You are the live-call classifier for a tax resolution sales coach.

Your job is to read one repaired transcript beat and decide whether it contains
one of three coachable branches:

1. TAX_GUIDANCE
   The prospect or agent mentioned a specific tax issue, notice, agency action,
   form, deadline, balance, year, filing status, levy, lien, garnishment,
   payment plan, unfiled return, audit, state tax issue, IRS process, or tax
   resolution concept that should help the agent ask the next accurate question.
   Tax guidance may be informational only. Do not treat it as an objection unless
   the caller uses it to resist or block progress.

2. OBJECTION
   The prospect created resistance, doubt, delay, mistrust, price/value pressure,
   authority gating, status quo defense, fear, prior-burn hesitation, DIY/self
   representation, guarantee seeking, hopelessness, confusion used as a stall, or
   any other move that blocks the next logical step. DNC/stop-calling signals are
   terminal compliance, not objection overcoming.

3. SALES_OPPORTUNITY
   The beat gives the agent a chance to advance the call: confirm pain, ask for a
   missing fact, isolate the blocker, move phases, ask for commitment, include a
   decision maker, anchor value, schedule next step, or prevent the call from
   drifting past required discovery.

If the beat is one of those branches:
- name the branch;
- define what it is in plain language;
- list the smallest relevant catalog lookup request;
- return candidate search hints;
- say whether a writer response is needed.

If the beat is not one of those branches:
- decide whether it completes, partially completes, reopens, or does not affect
  any call-guide section;
- do not request catalog lookup;
- do not request writer output unless there is a phase warning.

Always return a compact beat summary. The summary is memory, not prose for the
agent. It should be short, factual, and useful for later Ask/summary/grading.

Never invent tax facts.
Never overrule hard compliance gates.
Never write the agent-facing response.
Never make a response just because a keyword exists.
Prefer no writer over a weak writer card.
```

Classifier input:

```json
{
  "transcriptId": "t_123",
  "rawText": "i got a cp five oh four",
  "repairedText": "I got a CP504",
  "speaker": "prospect",
  "currentGuideState": {
    "phase": "tax_discovery",
    "sections": [
      {
        "id": "notice_type",
        "label": "Notice type",
        "status": "missing"
      },
      {
        "id": "tax_years",
        "label": "Tax years",
        "status": "missing"
      }
    ]
  },
  "recentBeatSummaries": [
    "Prospect confirmed they asked for help with a tax issue."
  ],
  "hardGate": {
    "blocked": false,
    "reason": null
  }
}
```

Classifier output:

```json
{
  "type": "coach.beat_classified",
  "transcriptId": "t_123",
  "beatSummary": {
    "oneLine": "Prospect says they received a CP504 notice.",
    "speaker": "prospect",
    "facts": [
      {
        "key": "notice_type",
        "value": "CP504",
        "evidence": "I got a CP504",
        "confidence": "high"
      }
    ],
    "openQuestions": ["tax_years", "balance", "enforcement_status"],
    "memoryTags": ["irs_notice", "cp504", "tax_discovery"]
  },
  "branchDecision": {
    "branch": "tax_guidance",
    "definition": "The caller identified a specific IRS notice that should steer the next discovery question.",
    "confidence": "high",
    "terminalCompliance": false
  },
  "catalogLookup": {
    "needed": true,
    "branch": "tax_guidance",
    "searchHints": ["CP504", "final notice", "levy", "refund offset"],
    "candidateLimit": 3
  },
  "guideDelta": {
    "complete": [
      {
        "id": "notice_type",
        "evidence": "I got a CP504",
        "confidence": "high"
      }
    ],
    "partial": [],
    "reopen": [],
    "stillNeeded": ["tax_years", "balance", "enforcement_status"],
    "phaseWarning": null
  },
  "writerDecision": {
    "needed": true,
    "reason": "tax_guidance_can_steer_next_question",
    "targetPane": "right_alert",
    "goal": "Briefly explain why CP504 matters and what to ask next."
  }
}
```

Non-branch section-completion example:

```json
{
  "type": "coach.beat_classified",
  "transcriptId": "t_456",
  "beatSummary": {
    "oneLine": "Prospect says the notice is for 2021 and 2022.",
    "speaker": "prospect",
    "facts": [
      {
        "key": "tax_years",
        "value": "2021, 2022",
        "evidence": "It's for 2021 and 2022",
        "confidence": "high"
      }
    ],
    "openQuestions": ["balance", "enforcement_status"],
    "memoryTags": ["tax_years"]
  },
  "branchDecision": {
    "branch": "none",
    "definition": "This beat completes guide facts but does not require tax guidance, objection handling, or a sales tactic.",
    "confidence": "high",
    "terminalCompliance": false
  },
  "catalogLookup": {
    "needed": false,
    "branch": null,
    "searchHints": [],
    "candidateLimit": 0
  },
  "guideDelta": {
    "complete": [
      {
        "id": "tax_years",
        "evidence": "It's for 2021 and 2022",
        "confidence": "high"
      }
    ],
    "partial": [],
    "reopen": [],
    "stillNeeded": ["balance", "enforcement_status"],
    "phaseWarning": null
  },
  "writerDecision": {
    "needed": false,
    "reason": "section_completion_only",
    "targetPane": null,
    "goal": null
  }
}
```

Classifier output event:

```json
{
  "type": "coach.classified",
  "transcriptId": "t_123",
  "classifierRead": {
    "meaning": "Prospect identified a CP504 IRS notice.",
    "confidence": "high",
    "phase": "tax_discovery"
  },
  "guideDelta": {
    "phase": "tax_discovery",
    "complete": [
      {
        "id": "notice_type",
        "evidence": "I got a CP504",
        "confidence": "high"
      }
    ],
    "partial": [],
    "reopen": [],
    "stillNeeded": ["tax_years", "balance", "enforcement_status"],
    "phaseWarning": null
  },
  "matches": [
    {
      "type": "tax_term",
      "key": "cp504",
      "evidence": "I got a CP504",
      "shouldShow": true
    }
  ],
  "writerNeeded": true,
  "writerReason": "tax_knowledge_prompt",
  "writerIntent": {
    "pane": "right_alert",
    "goal": "Tell agent what CP504 means and what to ask next.",
    "maxWords": 65,
    "includeTryLine": true
  }
}
```

Vite contract:

- Vite does not infer checklist state.
- Vite applies `guideDelta` directly:
  - `complete` crosses an item off;
  - `partial` shows a half-state / needs confirmation;
  - `reopen` uncrosses an item when new evidence contradicts it;
  - `stillNeeded` drives the "next facts" list;
  - `phaseWarning` feeds the right pane.

Reducer concept:

```ts
nextGuideState = applyGuideDelta(currentGuideState, event.guideDelta);
```

### Objection Intelligence

The objection layer needs to be deeper than "did the prospect say no." In this
system, an objection is any prospect move that blocks, redirects, delays, doubts,
or conditionally accepts the next step of the call.

That includes:

- direct resistance;
- soft exits;
- trust challenges;
- price or value pressure;
- decision-maker gates;
- time/logistics stalls;
- DIY/self-representation claims;
- incumbent-advisor claims;
- prior bad experience;
- no-urgency beliefs;
- hopelessness/shame;
- guarantee traps;
- tax-situation objections;
- compliance stop signals.

The classifier should separate these three classes:

1. **Terminal compliance**
   - Do-not-call, stop calling, remove me.
   - No sales coaching. No objection overcoming. End the call cleanly.

2. **Coachable objection**
   - A block, stall, doubt, question, or resistance that can be advanced.
   - Right pane should show the objection play and, when useful, writer wording.

3. **Not an objection, but coachable context**
   - Buying signal, tax fact, pain point, confusion, emotional disclosure.
   - These may still need a right-pane card, but they should not be treated like
     resistance.

Current bank coverage in `liveCoachObjectionBank.js`:

- `dnc_revocation`
- `obj_not_interested`
- `obj_dont_trust_tax_companies`
- `obj_spouse_consult`
- `obj_need_to_think`
- `obj_cant_afford`
- `obj_price_too_high`
- `obj_diy_self_rep`
- `obj_already_have_cpa`
- `obj_burned_before`
- `obj_send_email`
- `obj_how_got_number`
- `obj_busy_bad_time`
- `obj_guarantee_seeking`
- `obj_no_urgency_sleeping_giant`
- `obj_already_on_payment_plan`
- `obj_early_price_probe`
- `obj_too_complicated_despair`

That is a good seed, but the classifier should recognize broader families even
before every exact phrase is hand-entered into the bank.

#### Objection Family Taxonomy

Each family should have:

- recognition cues;
- false-positive guards;
- whether it blocks the call;
- what guide phase it usually affects;
- which tool material to fetch;
- whether a writer response is usually needed.

```json
{
  "family": "price_value",
  "keys": ["obj_early_price_probe", "obj_price_too_high", "obj_cant_afford"],
  "blocks": ["quote", "close", "payment"],
  "guideImpact": "Do not advance to close until scope/facts are sufficient.",
  "writerDefault": "when_exact_redirect_needed"
}
```

##### 1. Compliance Stop

Examples:

- "Stop calling me."
- "Take me off the list."
- "Do not contact me."
- "Remove my number."

Classifier behavior:

- `terminal = true`
- `coachability = "compliance_only"`
- suppress normal objection, tax, and sales cards;
- emit DNC/removal directive;
- do not call writer except for a fixed compliance line, if needed.

False-positive guard:

- "I do not want to call the IRS" is not DNC.
- "They told me not to call" is not necessarily DNC.
- The stop must be directed at our contact unless context clearly says otherwise.

##### 2. Brush-Off / Reflex No

Examples:

- "Not interested."
- "I'm good."
- "No thanks."
- "We're all set."

What it means:

- Usually a reflex to an unexpected call, not a considered decision.

Coach target:

- anchor to their inquiry;
- make one value/urgency statement;
- ask one low-friction fact question.

Writer usually needed:

- yes, if it happens early and the agent needs a reset line.

##### 3. Time / Availability Stall

Examples:

- "I'm busy."
- "I'm driving."
- "I'm at work."
- "Call me later."
- "Bad time."

What it means:

- Could be real logistics or a dodge.

Coach target:

- get a specific callback time;
- capture one fact before releasing;
- prevent vague "call me sometime" drift.

Writer usually needed:

- often no; lookup-backed card may be enough.
- yes if the stall repeats.

##### 4. Trust / Legitimacy Challenge

Examples:

- "Who are you?"
- "Is this a scam?"
- "How did you get my number?"
- "I don't trust tax companies."
- "Are you legit?"

What it means:

- The prospect may still have a real tax problem, but trust is blocking access
  to facts.

Coach target:

- verify identity/source calmly;
- avoid over-reassurance;
- prove process, not outcome;
- return to one discovery question once legitimacy is stabilized.

Writer usually needed:

- yes, because wording matters and compliance/brand risk is higher.

False-positive guard:

- A normal "who is this?" at call open is a gate, not a hostile objection.
- It should keep the call in opening/trust phase until source is clear.

##### 5. Authority / Decision-Maker Gate

Examples:

- "I need to talk to my wife."
- "My husband handles this."
- "I need to ask my partner."
- "My son/daughter helps me with this."
- "My bookkeeper/accountant handles it."

What it means:

- Could be genuine authority split or a soft exit.

Coach target:

- identify whether the other person is a legal/financial decision maker;
- get them on the call if possible;
- schedule a specific joint call;
- keep gathering facts while waiting.

Guide impact:

- do not mark close/onboarding ready until authority is handled.

##### 6. Stall / "Think About It"

Examples:

- "I need to think about it."
- "Let me sleep on it."
- "Send me something."
- "Email me the details."
- "I'll call you back."

What it means:

- Usually an unspoken blocker: trust, price, fear, spouse, or value.

Coach target:

- isolate the real concern;
- ask what they need to know that they do not know now;
- keep the conversation moving with one relevant fact.

False-positive guard:

- If the agent truly has not explained the offer yet, "send me info" may be a
  normal process request, not a close objection.

##### 7. Price / Value / Affordability

Examples:

- "How much does it cost?"
- "That's too expensive."
- "I can't afford it."
- "I don't have the money."
- "Why is it so much?"

Subtypes:

- early price probe;
- price-too-high value objection;
- real affordability condition;
- comparison-shopping;
- down-payment/payment-plan pressure.

Coach target:

- if early: do not quote before scope;
- if value: tie fee to representation/work/product/risk;
- if affordability: distinguish condition from uncertainty;
- if real hardship: pivot to financial qualification/CNC-style facts.

Guide impact:

- price before facts should trigger right-pane warning:
  "Do not advance to quote until balance, years, enforcement, and ability to pay
  are known."

Writer usually needed:

- yes when the agent needs a redirect line.

##### 8. DIY / Self-Representation

Examples:

- "I'll call the IRS myself."
- "I can do this myself."
- "I'll file it myself."
- "I can use TurboTax."
- "I can apply for an offer myself."

What it means:

- Pride, cost-saving, or belief that case is simple.

Coach target:

- concede genuinely simple cases;
- identify complexity/risk;
- push diagnostic value first;
- ask whether they know years, transcripts, CSED, compliance, and enforcement
  posture.

Writer usually needed:

- maybe. Often lookup-backed prompts are enough unless the prospect is defensive.

##### 9. Incumbent Advisor / Already Represented

Examples:

- "I already have a CPA."
- "My accountant handles it."
- "I have a lawyer."
- "Another company is working on it."
- "Someone filed my taxes."

What it means:

- Could be true representation, tax prep only, or a vague shield.

Coach target:

- separate tax prep from collections representation;
- ask whether someone has POA and is negotiating with IRS/state;
- ask what result they have received so far;
- never attack the incumbent advisor.

Guide impact:

- representation status becomes a checklist item.

##### 10. Prior Bad Experience / Burned Before

Examples:

- "I already paid someone."
- "They didn't do anything."
- "I got ripped off."
- "Tax relief companies are scams."

What it means:

- Trust injury plus sunk cost.

Coach target:

- validate caution;
- identify what failed;
- contrast process and accountability;
- avoid big promises.

Writer usually needed:

- yes, because trust repair language is delicate.

##### 11. No Urgency / Sleeping Giant

Examples:

- "They haven't bothered me."
- "Nothing has happened."
- "It's been sitting for years."
- "I can wait."
- "I'll deal with it later."

What it means:

- The pain has not become visible yet.

Coach target:

- explain quiet accrual/enforcement risk;
- ask for notice/enforcement status;
- avoid fake urgency;
- use transcript/notice facts to make urgency real.

Writer usually needed:

- yes if paired with real tax terms: CP504, levy, garnishment, revenue officer.

##### 12. Already Handled / Payment Plan / Status Quo

Examples:

- "I'm already on a payment plan."
- "I worked something out."
- "They take money every month."
- "I filed already."
- "It's taken care of."

What it means:

- They believe the problem is contained.

Coach target:

- check whether balance is actually going down;
- check default risk;
- check whether cheaper/better programs were evaluated;
- check whether all years are compliant.

Guide impact:

- can satisfy some facts but should not close the issue unless outcome is proven.

##### 13. Guarantee / Outcome Trap

Examples:

- "Can you guarantee it?"
- "Can you settle for pennies?"
- "How much will I save?"
- "Can you wipe it out?"

What it means:

- They may be interested, but they are asking for a legally/commercially risky
  promise.

Coach target:

- reject guarantees as a credibility move;
- offer process certainty instead of result certainty;
- ask for qualifying facts.

Writer usually needed:

- yes, because bad wording here is dangerous.

##### 14. Shame / Despair / Hopelessness

Examples:

- "It's too far gone."
- "I'm buried."
- "No one can help."
- "I've avoided this for years."
- "I'm embarrassed."

What it means:

- Not a normal objection. It is emotional disclosure blocking motion.

Coach target:

- normalize;
- shrink the next step;
- avoid judgment;
- ask one concrete fact.

Writer usually needed:

- often yes; the exact words matter.

##### 15. Confusion / Cognitive Load

Examples:

- "I don't understand."
- "This is confusing."
- "I don't know what that means."
- "What is a levy?"
- "What does CP504 mean?"

What it means:

- Not resistance, but the call cannot advance until understanding improves.

Coach target:

- explain one concept simply;
- return to the next checklist fact.

Writer usually needed:

- maybe. If it is a tax term, lookup-backed card may be enough.

##### 16. Process / Timeline Probe

Examples:

- "How does this work?"
- "How long does it take?"
- "What happens next?"
- "Who do I work with?"

What it means:

- Often a buying signal, not resistance.

Coach target:

- answer briefly and advance to commitment/logistics;
- do not re-pitch value to someone already leaning in.

Writer usually needed:

- only if exact wording is useful.

##### 17. Comparison Shopping

Examples:

- "Another company said..."
- "I can get this cheaper."
- "My CPA charges less."
- "I want to compare."

What it means:

- Value/credibility problem, not just price.

Coach target:

- distinguish scope, representation, and process;
- avoid attacking competitors;
- isolate whether they are comparing same service.

Writer usually needed:

- yes if it happens near quote/close.

##### 18. Risk Avoidance / Fear Of Disclosure

Examples:

- "I don't want to give my information."
- "I don't want to sign anything."
- "I don't want IRS involved."
- "Will this make things worse?"

What it means:

- Fear of exposure or loss of control.

Coach target:

- explain why transcripts/POA reveal what already exists;
- emphasize process boundaries;
- avoid pressure.

Guide impact:

- can block authorization/onboarding until resolved.

##### 19. Tax-Situation Objections

These are tax facts that function like objections because the prospect uses them
as a reason not to move:

- "It's only state."
- "It's just one year."
- "I don't owe; they made a mistake."
- "It was my ex/spouse/business partner."
- "My employer should have withheld."
- "I never got the notice."
- "I don't file anymore."
- "I have no income."
- "I already filed amended returns."

Coach target:

- pull the right tax knowledge section;
- avoid arguing;
- turn the claim into a verification question;
- cross off only what the evidence supports.

Writer usually needed:

- only when the tax fact is being used to resist action.

#### Objection Candidate Schema

The classifier should return objections as structured candidates:

```json
{
  "type": "objection",
  "family": "price_value",
  "key": "obj_early_price_probe",
  "evidence": "How much is this going to cost?",
  "meaning": "Prospect is asking price before scope is known.",
  "confidence": "high",
  "terminal": false,
  "coachability": "advance",
  "blocks": ["quote", "close"],
  "guideImpact": {
    "phase": "tax_discovery",
    "warning": "Price came up before balance, years, enforcement, and ability to pay are known.",
    "stillNeeded": ["tax_years", "balance", "enforcement_status", "ability_to_pay"]
  },
  "selectedKnowledgeQueries": [
    "objection early price before scope",
    "sales tactic value before price"
  ],
  "selectedKnowledgeIds": [
    "objection.obj_early_price_probe",
    "sales_tactic.value_before_price"
  ],
  "writerNeeded": true,
  "writerReason": "exact_redirect_line_needed",
  "writerIntent": {
    "pane": "right_alert",
    "goal": "Tell agent not to quote yet and give one redirect line.",
    "maxWords": 65,
    "includeTryLine": true
  }
}
```

#### Writer-Packet Tool For Objections

The writer-packet tool should know how to build an objection packet:

```json
{
  "eventType": "objection",
  "objectionCandidate": {
    "key": "obj_early_price_probe",
    "family": "price_value",
    "evidence": "How much is this going to cost?",
    "meaning": "Prospect is asking price before scope is known."
  },
  "guideState": {
    "phase": "tax_discovery",
    "missing": ["tax_years", "balance", "enforcement_status"]
  },
  "knowledgeIds": [
    "objection.obj_early_price_probe",
    "sales_tactic.value_before_price"
  ]
}
```

It returns:

```json
{
  "cacheKey": "live-coach-writer:v2:objection.obj_early_price_probe:sales_tactic.value_before_price",
  "staticSections": [
    {
      "id": "objection.obj_early_price_probe",
      "read": "A buying signal wearing an objection's clothes.",
      "reframe": "Respect the question but refuse false precision before scope.",
      "moves": [
        "Acknowledge price directly.",
        "Explain fee follows diagnosis.",
        "Ask for the missing scope fact."
      ],
      "exampleLines": []
    }
  ],
  "dynamicPayload": {
    "transcript": "How much is this going to cost?",
    "classifierRead": "Prospect is asking price before scope is known.",
    "guideMissing": ["tax_years", "balance", "enforcement_status"],
    "outputContract": {
      "title": true,
      "bodyMaxWords": 45,
      "tryLine": true
    }
  }
}
```

#### When To Show Right-Pane Objection Cards

Show a right-pane objection card when at least one is true:

1. It is terminal compliance.
2. It blocks the current or next guide phase.
3. It has high confidence and a known playbook.
4. It is a risky wording moment: guarantee, DNC, trust/scam, prior bad
   experience, shame/despair, price before scope.
5. It repeats after the agent already tried to move past it.
6. It reveals a gap in the middle checklist.

Do not show a right-pane objection card when:

1. It is a harmless backchannel.
2. It is a normal process question better treated as a buying signal.
3. It is a tax fact with no resistance attached.
4. Confidence is low and no hard safety issue is present.
5. The same card was shown recently with no new evidence.

#### Objection Effects On The Middle Guide

Objections should change the middle guide only when they affect progress:

- Trust objection keeps phase in opening/trust.
- Authority objection creates/marks decision-maker status.
- Early price objection warns not to quote yet.
- Affordability objection can move to financial qualification if it is a real
  condition.
- CPA/incumbent-advisor objection marks representation status as partial until
  active collection representation is confirmed.
- Payment-plan objection marks "status quo claim" but should not mark resolved
  unless the balance/payment facts are proven.
- DNC/compliance stops all normal guide progression.

#### Objection Tool Library Shape

The bank should evolve from a flat playbook into searchable records:

```json
{
  "id": "objection.obj_already_have_cpa",
  "family": "incumbent_advisor",
  "title": "Already has CPA / attorney / tax company",
  "recognition": {
    "phrases": ["my CPA handles it", "I have an accountant"],
    "semanticCues": ["outsourcing responsibility to current advisor"],
    "falsePositiveGuards": ["CPA mentioned only as income preparer, not a block"]
  },
  "coachUse": {
    "read": "Could be real help or a shield.",
    "reframe": "Separate tax prep from active collection representation.",
    "moves": [
      "Ask whether they have POA.",
      "Ask if anyone is negotiating collections.",
      "Never disparage the current advisor."
    ],
    "guideEffects": [
      "representation_status.partial"
    ]
  },
  "writerUse": {
    "defaultGoal": "Distinguish CPA tax prep from collections representation.",
    "maxWords": 60,
    "needsTryLine": true
  }
}
```

This gives the classifier/search tool enough material to identify subtle
objections without bloating the writer prompt.

#### Objection Test Set

Minimum replay/eval set:

1. "Not interested." -> brush-off, coachable, no DNC.
2. "Stop calling me." -> terminal DNC, no overcome play.
3. "Who are you again?" at open -> trust gate, not hostility.
4. "Is this a scam?" -> trust objection, writer needed.
5. "I need to talk to my wife." -> authority gate, schedule/get-on-call play.
6. "Let me think about it." -> stall, isolate hidden blocker.
7. "How much is this going to cost?" before facts -> early price warning.
8. "That's too expensive." after quote -> value/price objection.
9. "I can't afford it." -> affordability condition vs value objection.
10. "I already have a CPA." -> incumbent advisor, separate prep vs collection.
11. "I'm already on a payment plan." -> status quo/payment-plan objection.
12. "They haven't bothered me in years." -> no urgency/sleeping giant.
13. "Can you guarantee pennies on the dollar?" -> guarantee trap.
14. "I already paid a company and got burned." -> prior bad experience.
15. "I'll just call the IRS myself." -> DIY/self-rep.
16. "This is hopeless." -> shame/despair, normalize and shrink next step.
17. "Just email me something." -> info-request stall unless process context says
    otherwise.
18. "It's only state taxes." -> tax-situation objection only if used to resist.
19. "I never got a notice." -> tax-knowledge/verification cue, not necessarily
    objection.
20. "How does this work?" -> buying/process signal, not resistance unless used
    to stall.

#### Classic Sales Frameworks To Encode

Source-backed objection handling is very consistent across the classic sales
literature:

- Highspot's playbook groups most objections into budget, timing, need, or
  authority, and frames objection handling as listening for what blocks forward
  progress rather than pushing harder.
- LAER maps cleanly to the response loop: Listen, Acknowledge, Explore, Respond.
  The important implementation detail is that "respond" comes after exploration,
  not immediately after the objection keyword is heard.
- SPIN gives the call-guide skeleton: Situation, Problem, Implication,
  Need-payoff. In this app, that means the middle pane should know whether the
  agent has gathered facts, developed the tax pain, exposed consequence, and
  earned the next-step conversation.
- Salesforce's objection guidance reinforces that discovery is what makes later
  objections answerable. Thank/empathize/open-ended questions/isolate the blocker
  should become tactic primitives, not prose buried inside a prompt.
- Sandler-style price handling maps to "price belongs in scope and investment
  discovery." Early price questions are not always objections; they are often a
  cue to gather scope, set a range if appropriate, and avoid defending a number
  before value is established.
- Challenger-style constructive tension is useful only for status quo/no-urgency
  objections. It should create productive discomfort with doing nothing, not
  aggression toward the caller.

Implementation consequence: the classifier should not only return an
`objectionKey`. It should return the tactical move the writer should use.

```json
{
  "eventType": "objection",
  "objectionKey": "obj_already_on_payment_plan",
  "objectionFamily": "status_quo",
  "rootConcern": "They believe the current IRS payment plan means the problem is handled.",
  "phaseFit": "tax_discovery",
  "tacticPrimitives": [
    "acknowledge",
    "status_quo_challenge",
    "implication_question",
    "risk_boundary"
  ],
  "needsWriter": true,
  "guidePatch": {
    "crossOff": ["has_current_arrangement"],
    "stillNeeded": ["balance", "payment_amount", "penalty_interest", "enforcement_status"]
  },
  "writerGoal": "Help the agent respect the payment plan while checking whether it actually solves the tax problem."
}
```

The tactic primitive set should be small and stable:

| Primitive | Use when | Writer behavior |
| --- | --- | --- |
| `acknowledge` | Any real resistance | Validate that the concern makes sense without conceding the deal. |
| `clarify` | Meaning is ambiguous | Ask what they mean before responding. |
| `explore_root` | Surface objection may hide the real blocker | Ask one open-ended question to expose why this matters. |
| `isolate_blocker` | Stall, "think about it", "send info" | Check whether this is the only concern or a shield for something else. |
| `authority_map` | Spouse, CPA, attorney, manager, family member | Identify who influences the decision and how to include them. |
| `budget_scope_check` | Early price, affordability, payment hesitation | Tie price to scope and payment feasibility before defending value. |
| `value_anchor` | Price/value objection after facts are known | Connect fee to risk, relief, outcome, or cost of inaction. |
| `implication_question` | No urgency/status quo | Ask about consequence if nothing changes. |
| `need_payoff_question` | Pain is developed but commitment is soft | Get the prospect to say what would improve if solved. |
| `status_quo_challenge` | "I'm fine", "payment plan", "they have not bothered me" | Gently challenge the assumption that current state is safe. |
| `trust_proof` | Scam, legitimacy, prior bad experience | Explain process/proof/identity without overtalking or promising outcomes. |
| `risk_boundary` | Guarantees, legal/compliance risk, DNC | State what cannot be promised or what must be respected. |
| `alternative_next_step` | Not ready for close | Convert resistance into a smaller commitment. |

The objection library should store tactic records separate from prose. That keeps
mini/haiku/nano classifier work cheap and lets the writer receive a compact,
cache-friendly packet.

```json
{
  "key": "sales_tactic.status_quo_challenge",
  "frameworks": ["challenger", "spin"],
  "useWhen": [
    "Prospect says the issue is not urgent.",
    "Prospect says a payment plan or silence from the IRS means they are safe."
  ],
  "avoidWhen": [
    "Prospect is angry or asking to stop contact.",
    "Agent has not gathered enough facts to know the risk."
  ],
  "writerInstruction": "Do not scare them. Ask one open implication question that tests the cost of doing nothing.",
  "exampleMoves": [
    "Ask what happens if penalties keep accruing under the current plan.",
    "Ask whether the payment plan covers every year and agency involved.",
    "Ask what would make them confident the problem is actually contained."
  ]
}
```

Practical mapping for Wynn calls:

| Caller language | Classification | Best tactic |
| --- | --- | --- |
| "Not interested." | Brush-off, unknown root | Acknowledge, clarify, explore root. |
| "How much is this?" before facts | Price probe, not full objection yet | Budget scope check, then return to discovery. |
| "That's too expensive." after scope | Price/value or affordability | Explore root, value anchor, alternative next step. |
| "I need to talk to my wife." | Authority/stakeholder gate | Authority map, schedule a joint next step. |
| "I already have a CPA." | Incumbent advisor | Separate tax prep from tax resolution/collections representation. |
| "I am already on a payment plan." | Status quo | Status quo challenge, implication question, verify scope. |
| "They haven't bothered me in years." | No urgency | Constructive tension, implication question. |
| "Is this a scam?" | Trust gate | Acknowledge, trust proof, explain process. |
| "Can you guarantee it?" | Outcome trap | Risk boundary, explain evaluation process. |
| "This is hopeless." | Despair/shame | Normalize, shrink next step, avoid heavy pitch. |

This is also the cleanest way to make humor/psychology less mystical. The
classifier can decide the emotional posture:

```json
{
  "tonePosture": "steady_reassurance",
  "humorAllowed": false,
  "reason": "Trust objection with fear/prior-burn signal."
}
```

Humor should only be available for low-stakes friction, rapport, or mild
confusion. It should be blocked for DNC, legal threats, affordability distress,
shame/despair, scam fear, and active IRS fear. Psychology should be treated as a
posture selector: calm, clarify, challenge status quo, normalize, or close down
to a smaller next step.

Research sources used for this section:

- Highspot objection handling:
  https://www.highspot.com/blog/objection-handling/
- Sales Outcomes LAER:
  https://salesoutcomes.com/use-laer-for-objection-handling/
- Highspot SPIN selling:
  https://www.highspot.com/blog/spin-selling/
- Salesforce objection handling:
  https://www.salesforce.com/blog/sales/6-techniques-for-effective-objection-handling-blog/
- Sandler price objection:
  https://sandler.com/blog/close-sale-how-overcome-price-objection/
- Challenger constructive tension:
  https://challengerinc.com/blog/tactics-for-dialing-up-constructive-tension/

### Step 3b - Writer Packet Tool

The classifier/router can call a backend tool whose job is not merely search.
The tool should build the writer prompt packet.

This is the tool boundary:

```text
classifier judgement
  -> buildWriterPromptPacket(...)
  -> selected cached guide/tax/objection/sales material
  -> compact dynamic writer payload
```

Tool input:

```json
{
  "eventType": "tax_term",
  "keys": ["cp504"],
  "transcript": "I got a CP504",
  "classifierRead": {
    "meaning": "Prospect identified a CP504 IRS notice.",
    "phase": "tax_discovery",
    "stillNeeded": ["tax_years", "balance", "enforcement_status"]
  },
  "writerIntent": {
    "pane": "right_alert",
    "goal": "Tell agent what CP504 means and what to ask next.",
    "maxWords": 65,
    "includeTryLine": true
  }
}
```

Tool output:

```json
{
  "type": "writer.packet_built",
  "transcriptId": "t_123",
  "packet": {
    "cacheKey": "live-coach-writer:v2:tax_term.cp504",
    "systemPromptId": "liveCoach.writer.v2",
    "staticSectionIds": [
      "tax_term.cp504",
      "phase.tax_discovery.notice_followup"
    ],
    "staticSections": [
      {
        "id": "tax_term.cp504",
        "summary": "CP504 is a final notice of intent to levy/refund offset. It signals urgency but still requires confirming year, balance, and enforcement status.",
        "writerUse": "Explain the urgency briefly, then steer to year/balance/enforcement."
      }
    ],
    "dynamicPayload": {
      "transcript": "I got a CP504",
      "classifierRead": {
        "meaning": "Prospect identified a CP504 IRS notice.",
        "phase": "tax_discovery",
        "stillNeeded": ["tax_years", "balance", "enforcement_status"]
      },
      "outputContract": {
        "pane": "right_alert",
        "maxWords": 65,
        "includeTryLine": true
      }
    }
  }
}
```

Why this matters:

- The guide/tax/objection library can be large.
- The model does not need the whole library in every prompt.
- The classifier can use judgement, then use tools, then synthesize.
- Logs show exactly what knowledge was selected.
- Writer prompts become cache-friendly because stable sections are explicit.

#### Guided Catalog Shape

The current banks grew out of deterministic matching, so they are naturally
keyword-forward. The next version should be branch-forward. The classifier should
first answer:

```text
What does this look like?

1. tax_guidance
2. objection
3. sales_opportunity
4. none / transcript-only
```

Only after picking the branch should it ask the catalog for candidate records.
That keeps the lookup cheap and keeps the model from indexing the entire
collection every turn.

Recommended catalog envelope:

```json
{
  "id": "objection.obj_already_on_payment_plan",
  "branch": "objection",
  "families": ["status_quo", "payment_plan"],
  "matchHints": [
    "already on a payment plan",
    "I pay the IRS every month",
    "they already set me up"
  ],
  "summary": "Prospect believes an existing installment agreement means the problem is handled.",
  "classifierUse": {
    "rootConcern": "current arrangement feels sufficient",
    "distinguishFrom": ["tax_guidance.installment_agreement_info"],
    "triggerIf": "Caller uses payment plan as a reason not to continue."
  },
  "writerUse": {
    "goal": "Respect the payment plan, then verify whether it actually resolves the risk.",
    "tacticPrimitives": ["acknowledge", "status_quo_challenge", "implication_question"],
    "maxWords": 70
  },
  "guideEffects": {
    "crossOff": ["has_current_arrangement"],
    "stillNeeded": ["payment_amount", "balance", "years", "enforcement_status"]
  }
}
```

Branch responsibilities:

| Branch | Purpose | Example keys |
| --- | --- | --- |
| `tax_guidance` | Explain or steer around a specific tax issue, form, notice, agency, balance, levy, lien, garnishment, unfiled return, payment plan, or deadline. | `cp504`, `lt11`, `state_tax`, `wage_garnishment`, `unfiled_returns` |
| `objection` | Detect resistance, fear, stall, authority gate, trust issue, price issue, or status quo defense that blocks progress. | `obj_price_too_high`, `obj_spouse_consult`, `obj_already_on_payment_plan` |
| `sales_opportunity` | Detect moments where the agent should advance the sale, clarify value, isolate a blocker, ask for commitment, or move phases. | `advance_to_scope`, `ask_for_balance`, `confirm_decision_maker`, `close_next_step` |

The important distinction is that tax guidance can be purely informational,
while objections and sales opportunities are tactical. A CP504 mention is tax
guidance if the caller is giving facts. It becomes an objection only if they use
it to resist, minimize, or challenge the need for help.

Classifier lookup sequence:

```text
repaired transcript + recent guide state
  -> classify broad branch
  -> getCatalogCandidates(branch, transcript, guideState)
  -> compare candidates with sentence meaning
  -> return selected keys + tactical primitives + guide patch
  -> writer packet tool fetches only selected records
```

This should be one model pass plus one catalog lookup, not a model wandering
across every category.

#### Coach Response Storage

Every created response should be stored as a first-class call artifact. The
agent should be able to refer back to it later, and Ask the Coach should be able
to use it as context without re-deriving what happened.

Store on every `writer.response`:

```json
{
  "artifactType": "coach_response",
  "callId": "call_123",
  "transcriptId": "t_123",
  "uii": "current-uii",
  "agentExtensionId": "101",
  "createdAt": "2026-06-23T18:00:00.000Z",
  "pane": "right_alert",
  "branch": "objection",
  "sourceKeys": [
    "objection.obj_already_on_payment_plan",
    "sales_tactic.status_quo_challenge"
  ],
  "transcriptSnippet": "I'm already on a payment plan.",
  "classifierRead": {
    "meaning": "Caller is using an existing payment plan as a reason not to continue.",
    "rootConcern": "current arrangement feels sufficient",
    "confidence": 0.82
  },
  "response": {
    "title": "Payment plan is not the whole picture",
    "body": "Respect that they have a plan, then check whether it covers every year and whether penalties or enforcement are still active.",
    "tryLine": "That may be helping, but let's make sure it covers the whole issue. What year and balance is that plan for?"
  },
  "status": "active"
}
```

UI use:

- Right pane shows the newest artifacts.
- The agent can click any response, objection, transcript line, or guide item
  into Ask the Coach.
- Ask context should carry artifact IDs, not just copied text.
- The call guide can mark an item as "addressed by response X" so the middle
  pane reflects what the coach already surfaced.
- End-of-call summary/grader can consume the artifact list instead of
  re-reading the whole call from raw transcript.

Storage should be append-only during the live call. Cleanup/compaction can
archive or summarize after call end, but live artifacts should not be mutated
out from under the UI except for a light `status` change such as `dismissed` or
`used`.

#### Provider Cache Formatting Plan

The prompt builder should be provider-aware while keeping one logical prompt
contract. Both OpenAI and Anthropic benefit from the same core shape:

```text
STATIC PREFIX
  1. role / product contract
  2. branch definitions
  3. output schema
  4. tool definitions
  5. stable catalog records, sorted by id and version
  6. examples / validation rules

DYNAMIC SUFFIX
  7. transcript beat
  8. current guide state
  9. recent memory summary
  10. form facts
  11. prior coach artifact ids / small summaries
  12. request id, uii, timestamps, agent id
```

Never put timestamps, UII, call ids, agent-specific facts, transcript text,
recent memory, or selected live artifacts inside the static prefix. Any changing
token before the cache boundary can poison the hit rate.

OpenAI behavior to optimize for:

- Prompt caching is automatic on recent models when prompts are at least 1024
  tokens.
- Cache hits require exact repeated prefix matches.
- Static instructions, tools, images, messages, and structured output schemas can
  all contribute to the cached prefix.
- `prompt_cache_key` can improve routing for shared prefixes, but a single
  prefix/key combination above roughly 15 requests per minute can overflow to
  extra machines and reduce cache effectiveness.
- Log `usage.prompt_tokens_details.cached_tokens` on every call.

OpenAI request shape:

```json
{
  "model": "gpt-5.4-mini",
  "prompt_cache_key": "livecoach:classifier:v2:branch-router:bucket-a",
  "prompt_cache_retention": "24h",
  "input": [
    {
      "role": "system",
      "content": [
        {
          "type": "input_text",
          "text": "<STATIC_CLASSIFIER_PREFIX_V2>"
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "<DYNAMIC_BEAT_PAYLOAD>"
        }
      ]
    }
  ],
  "text": {
    "format": {
      "type": "json_schema",
      "name": "live_coach_beat_classified_v2",
      "schema": {}
    }
  }
}
```

OpenAI cache key guidance:

- Use stable cache keys per prompt version and coarse use case:
  - `livecoach:classifier:v2:branch-router`
  - `livecoach:writer:v2:tax-guidance`
  - `livecoach:writer:v2:objection`
  - `livecoach:writer:v2:sales-opportunity`
- If traffic through one key is too high, bucket it deliberately:
  `livecoach:classifier:v2:branch-router:bucket-a`.
- Do not include call id, transcript id, agent id, or selected catalog keys in the
  key unless the prefix itself is different and stable for that key.

Anthropic behavior to optimize for:

- Prompt caching must be enabled with top-level `cache_control` or explicit
  block-level `cache_control`.
- Static content should be placed first. Anthropic's prefix order is tools,
  system, then messages.
- Explicit cache breakpoints should sit on the last block whose prefix is
  identical across requests.
- Default TTL is 5 minutes. Use 1 hour only when a prompt is reused less often
  than every 5 minutes but likely within an hour, or when pre-warmed latency
  matters.
- The cache lookback window is 20 blocks, so growing conversations should not
  become a long list of tiny message blocks without additional breakpoints or
  compaction.
- Log `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, and
  `usage.input_tokens`.

Anthropic request shape for explicit static-prefix caching:

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 220,
  "system": [
    {
      "type": "text",
      "text": "<STATIC_WRITER_PREFIX_V2>",
      "cache_control": {
        "type": "ephemeral"
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "<DYNAMIC_WRITER_PAYLOAD>"
        }
      ]
    }
  ]
}
```

Anthropic pre-warm option:

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 0,
  "system": [
    {
      "type": "text",
      "text": "<STATIC_WRITER_PREFIX_V2>",
      "cache_control": {
        "type": "ephemeral"
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "warmup"
    }
  ]
}
```

Use pre-warm only for latency-sensitive prompts that are definitely about to be
used, such as the live coach writer prompt at start of day or when the coach is
enabled. Do not pre-warm every possible branch/catalog combination unless logs
show it is worth the write cost.

Prompt-builder implementation rule:

```ts
type LiveCoachPromptParts = {
  staticPrefixId: string;
  staticPrefixText: string;
  dynamicPayloadText: string;
  selectedCatalogIds: string[];
  providerCache: {
    openaiPromptCacheKey?: string;
    openaiPromptCacheRetention?: "24h";
    anthropicCacheControl?: "ephemeral";
    anthropicTtl?: "5m" | "1h";
  };
};
```

The `staticPrefixId` should be a hash/version of:

- prompt role instructions;
- output schema;
- tool definitions;
- branch definitions;
- included stable catalog records.

The `dynamicPayloadText` should contain everything call-specific. It can be JSON,
but the field order must be deterministic so logs and evals are comparable.

Cache hit logging event:

```json
{
  "type": "ai.cache_metrics",
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "promptId": "livecoach.classifier.v2",
  "staticPrefixId": "sha256:abc123",
  "promptCacheKey": "livecoach:classifier:v2:branch-router",
  "inputTokens": 1800,
  "cachedTokens": 1408,
  "cacheReadTokens": null,
  "cacheCreationTokens": null,
  "elapsedMs": 420
}
```

For Anthropic, map the same event as:

```json
{
  "type": "ai.cache_metrics",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "promptId": "livecoach.writer.v2.objection",
  "staticPrefixId": "sha256:def456",
  "inputTokens": 120,
  "cachedTokens": null,
  "cacheReadTokens": 4200,
  "cacheCreationTokens": 0,
  "elapsedMs": 610
}
```

Practical recommendation for this coach:

1. Classifier prompt should have one stable static prefix with branch
   definitions, output contract, and small examples. Put all transcript/guide
   state in the dynamic suffix.
2. Writer prompt should have separate stable prefixes by branch:
   `tax_guidance`, `objection`, and `sales_opportunity`.
3. Selected catalog records should be stable, sorted, and versioned. If selected
   records change every turn, keep only their compact summaries in the dynamic
   payload and cache the general writer doctrine instead.
4. Avoid replaying full chat history. Use compact beat summaries and stored
   artifact IDs.
5. Track cache hit rate before deciding whether Sonnet/Haiku or GPT mini is the
   better economic path. A slightly larger stable prefix can be cheaper if it
   reliably hits cache, but a large dynamic prompt will not help.

#### Prompt Families By Call Chunk

The most cache-friendly writer design is not one giant universal writer prompt
and not a fully dynamic custom prompt per moment. It is a small set of stable
prompt families that mirror broad call chunks and branch types.

The idea:

```text
same language for most calls
  -> same cache prefix
  -> only dynamic bottom keys change:
       transcript beat
       selected catalog ids
       selected tactic primitives
       guide state snippet
       recent artifact ids
```

Recommended prompt families:

| Prompt family | Use when | Stable doctrine inside prefix |
| --- | --- | --- |
| `classifier.branch_router.v2` | Every repaired beat | Branch definitions, guide rules, output schema, catalog lookup policy. |
| `writer.discovery.tax_guidance.v2` | Tax facts/notices/issues during discovery | Explain briefly, ask next missing fact, avoid over-explaining, do not close early. |
| `writer.discovery.objection.v2` | Resistance before pitch/price | LAER, isolate blocker, return to discovery, avoid pressure. |
| `writer.discovery.sales_opportunity.v2` | Pain/facts create a chance to advance | Confirm fact, move to next discovery step, keep agent on phase. |
| `writer.scope_price.objection.v2` | Price/affordability/value concerns | Scope before fee defense, value anchor, payment feasibility, smaller next step. |
| `writer.close.objection.v2` | Late-stage stall/authority/trust | Isolate final blocker, decision-maker map, next commitment. |
| `writer.status_quo.objection.v2` | Payment plan/no urgency/IRS quiet | Constructive tension, implication question, verify risk. |
| `writer.compliance_boundary.v2` | DNC/guarantee/legal boundary | No overcome language, safe boundary, clean next action. |
| `writer.ask_coach.v2` | Agent asks for more detail | Use selected artifact/context, answer the agent directly, cite source keys. |

This lets the prompt builder choose the most specific stable family before it
adds dynamic content. For example:

```json
{
  "promptFamily": "writer.status_quo.objection.v2",
  "staticPrefixId": "writer.status_quo.objection.v2:catalog-2026-06-23",
  "dynamicBottom": {
    "transcript": "I'm already on a payment plan.",
    "selectedKeys": [
      "objection.obj_already_on_payment_plan",
      "sales_tactic.status_quo_challenge"
    ],
    "guideState": {
      "phase": "tax_discovery",
      "stillNeeded": ["balance", "payment_amount", "tax_years"]
    },
    "recentArtifacts": []
  }
}
```

Writer prompt skeleton:

```text
<STATIC PREFIX: writer.status_quo.objection.v2>

You write one short live-coach card for Wynn Tax Solutions agents.

Situation:
- The caller is resisting because the current state feels safe enough.
- Respect the caller's current arrangement.
- Do not scare them.
- Do not attack their current CPA, payment plan, or prior advisor.
- Create productive discomfort with doing nothing by asking one implication
  question.
- Tie the response back to the current guide phase.
- Prefer one clear next question over a speech.

Allowed tactic primitives:
- acknowledge
- status_quo_challenge
- implication_question
- risk_boundary
- alternative_next_step

Output exactly:
{
  "title": string,
  "body": string,
  "tryLine": string | null,
  "guideEffect": string | null,
  "sourceKeys": string[]
}

<DYNAMIC BOTTOM>
transcript: "I'm already on a payment plan."
selectedKeys: [...]
guideState: {...}
recentArtifacts: [...]
```

This is better for cache than generating a new prompt that says "payment plan"
in ten different places. The stable family says what to do with status quo
resistance. The dynamic bottom only says which status quo record and transcript
beat triggered it.

Prompt-family selection rule:

```text
branchDecision + callPhase + objectionFamily / taxFamily / salesMoment
  -> promptFamily
```

Examples:

| Branch decision | Phase | Family | Why |
| --- | --- | --- | --- |
| `tax_guidance:cp504` | `tax_discovery` | `writer.discovery.tax_guidance.v2` | It is a notice fact and next-question moment. |
| `objection:price_probe` | `opening` | `writer.discovery.objection.v2` | Price is premature; return to facts. |
| `objection:price_too_high` | `scope_price` | `writer.scope_price.objection.v2` | Price is now tied to scope/value. |
| `objection:payment_plan` | `tax_discovery` | `writer.status_quo.objection.v2` | Status quo needs implication/risk check. |
| `sales_opportunity:pain_confirmed` | `tax_discovery` | `writer.discovery.sales_opportunity.v2` | Advance the guide, not a full objection card. |

Implementation note: selected catalog records can be handled two ways:

1. **High-cache mode**
   - Catalog summaries for a broad family are included in the static prefix.
   - Dynamic bottom passes only selected keys.
   - Best when family catalog is small and reused constantly.

2. **Low-bloat mode**
   - Static prefix contains doctrine only.
   - Dynamic bottom includes compact summaries for selected keys.
   - Best when selected records vary too much or the family catalog is large.

Default recommendation:

- Classifier: high-cache mode, one stable prefix.
- Writer doctrine: high-cache mode by prompt family.
- Specific catalog records: start in low-bloat mode; promote high-volume,
  high-reuse families into the static prefix only after cache logs show the same
  records are selected repeatedly.

Provider docs used:

- OpenAI prompt caching:
  https://developers.openai.com/api/docs/guides/prompt-caching
- OpenAI prompt migration/cache-prefix guidance:
  https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object
- Anthropic prompt caching:
  https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- Anthropic tool definition guidance:
  https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use

### Step 4 - Writer Response

The writer only runs when the classifier says it is worth writing.

Writer candidates to test:

- Claude Haiku;
- Claude Sonnet;
- GPT-5.4;
- GPT-5.4 mini.

Writer input:

- writer packet from the tool;
- repaired transcript;
- classifier read;
- current guide state;
- selected static sections.

Writer output event:

```json
{
  "type": "writer.response",
  "transcriptId": "t_123",
  "pane": "right_alert",
  "response": {
    "title": "CP504 notice",
    "body": "This is an urgency marker. Confirm the tax years, balance, and whether levy/garnishment has started before explaining resolution options.",
    "tryLine": "Got it. What tax year is that CP504 for, and does it show a balance or levy date?",
    "sourceKeys": ["tax_term.cp504", "phase.tax_discovery.notice_followup"]
  },
  "storedArtifactId": "coach_artifact_123",
  "model": "claude-sonnet",
  "elapsedMs": 0
}
```

Right pane behavior:

- Shows sales tactic, objection, tax term, or phase-warning cards.
- Can show lookup-backed content without writer output.
- Streams writer output only when exact wording or synthesis is useful.
- Does not need to write a response every turn.

### Pane Responsibilities

Left pane: **Nano Transcript**

- Shows repaired transcript lines.
- Can expose raw text/corrections.
- Provides clickable Ask context.

Middle pane: **Hard-Coded Call Guide**

- Versioned phase/checklist.
- Crossed-off items from classifier `guideDelta`.
- Partial items.
- Missing facts.
- Current phase.
- General "helping you accomplish everything" flow.

Right pane: **Live Alerts / Response**

- Sales tactic cards.
- Objection cards.
- Tax term / tax knowledge cards.
- "You moved on before finishing X" reminders.
- Optional custom writer output.

### Incremental Grader / Summary Agent

The grader should not wait until the end and read one massive transcript. It
should be a worker/agent that consumes the same small events as the live coach
and maintains an incremental call evidence state.

Inputs:

- `transcript.repaired`;
- `coach.classified`;
- `writer.packet_built`;
- `writer.response`;
- terminal call outcome;
- agent actions, when available.

Incremental state:

```json
{
  "callSummary": "Prospect confirmed a CP504 notice but years and balance are still missing.",
  "keyMoments": [
    {
      "type": "tax_fact",
      "label": "CP504 notice identified",
      "evidence": "I got a CP504",
      "transcriptId": "t_123",
      "gradeWeight": "medium"
    }
  ],
  "scoreEvidence": {
    "opening": [],
    "discovery": ["notice_type captured"],
    "objections": [],
    "compliance": [],
    "closing": []
  },
  "risks": [],
  "coachingNotes": []
}
```

At call end:

```text
incremental grader state
  + terminal outcome
  + selected transcript snippets
  -> final sparse Logics summary
  -> optional agent email / coaching grade
  -> context cleanup
```

This makes grading more honest because key moments are captured as they happen
with evidence attached. It also prevents a giant end-of-call model read from
becoming both expensive and vague.

### Model Test Matrix

Baseline chain:

```text
semantic_vad low eagerness
  -> nano repair
  -> classifier/router
  -> packet builder tool
  -> writer if needed
```

Classifier candidates:

- Claude Haiku;
- GPT-5.4 mini.

Writer candidates:

- Claude Haiku;
- Claude Sonnet;
- GPT-5.4;
- GPT-5.4 mini.

Score each model on:

- latency;
- schema reliability;
- ability to cross off checklist items correctly;
- ability to avoid false positives;
- objection/tax/sales-tactic selection quality;
- "writerNeeded" restraint;
- right-pane usefulness;
- cost per turn;
- graceful failure behavior.

### API Event Sequence

Happy path:

```text
POST /live-coach/transcript/final
  -> emits transcript.final

POST /live-coach/transcript/repair
  -> emits transcript.repaired

POST /live-coach/classify-turn
  -> emits coach.classified
  -> optionally calls buildWriterPromptPacket
  -> emits writer.packet_built

POST /live-coach/write-alert
  -> emits writer.response
```

Implementation does not need to expose these exact route names immediately, but
the internal service boundaries should follow this shape.

### Failure Behavior

- STT fails: no transcript; UI shows listening/error status.
- Nano fails: use raw transcript, mark `repairStatus = failed`, continue.
- Classifier fails: transcript still displays; middle/right panes do not update.
- Tool lookup fails: classifier card can show generic fallback; writer skipped.
- Writer fails: lookup-backed card still displays; no custom line.
- Grader worker fails: live coach unaffected; retry from event log later.

### Logging Required

Log one timing row per transcript id:

```json
{
  "transcriptId": "t_123",
  "sttMs": 0,
  "nanoMs": 0,
  "classifierMs": 0,
  "toolMs": 0,
  "writerFirstTokenMs": 0,
  "writerDoneMs": 0,
  "writerNeeded": true,
  "writerModel": "claude-sonnet",
  "classifierModel": "haiku",
  "selectedKeys": ["tax_term.cp504"],
  "guideDeltaCount": 1
}
```

This is what lets us compare Haiku, Sonnet, GPT-5.4, and GPT-5.4 mini without
arguing from vibes.

## Production Hardening And Operations

The four-step architecture above specifies what the coach DOES. These sections specify what keeps it safe, isolated, affordable, and operable across a live floor of many simultaneous calls. Four through-lines run the length of the chapter. Every gate is deterministic and fail-closed — the compliance scrub, the output validator, the redaction pass are regex/schema seams, not models. Every degraded path keeps state coherent and prefers a lookup card over a wrong one — the reducer always runs, a dropped turn still leaves the phase guide correct. Every operability signal is alert-driven, because manual verification never gets done — nothing here is a dashboard a human is assumed to watch. And revert is one flip and call-safe — no kill drops a call, tears down STT, or churns a UII.

### Generated-Language Compliance Gate

The classifier guards the INPUT: guarantee-language routes to `writer.compliance_boundary.v2`. Nothing guards the OUTPUT. The writer's own `body` / `tryLine` is text an agent may read aloud on a recorded line. So we add a deterministic scrub between `writer.response` and everything downstream.

The gate is not a model. It is a regex/alias table per tenant. The cheapest correction is not a model. It is aliases.

#### Where it sits

```text
writer.response -> compliance gate -> { pass | suppress | fallback }
  pass     -> store coach_response (active) -> render
  suppress -> drop offending line, store remainder -> render
  fallback -> store lookup-backed card instead, never the generated body
```

It runs at THREE consume points, not one:
- on write of the `coach_response` artifact (append-only),
- on render in Vite (defense in depth; a stored-clean artifact can still be re-scored),
- before the Incremental Grader / Ask-the-Coach re-consume the body or `transcriptSnippet`.

Deterministic, no provider call, off the AI bus. Same table everywhere or the answer disagrees with itself.

#### Forbidden-phrase classes

| class | examples | action |
|---|---|---|
| `guarantee` | "guarantee", "we promise", "100%", "no risk" | suppress line |
| `settlement-promise` | "pennies on the dollar", "settle for $X", "wipe out your debt" | fallback card |
| `specific-program-promise` | "you qualify for OIC", "you'll get CNC" | fallback card |
| `unauthorized-conclusion` | legal/tax conclusion stated as fact, "the IRS will" | fallback card |

`allowed-claims` is tenant-aware and read from `liveCoachCallGuideConfig.js` (app-owned, editable, keyed off the Phase 0 `Brand/domain: TAG or WYNN`). WYNN may phrase a benefit TAG may not; the table is per-tenant, never shared global. A shared mechanism mis-scoped across concurrent calls is the 2026-06-17 doctrine — do not repeat it.

#### Check shape and emission

```json
{
  "type": "coach.compliance_blocked",
  "callId": "...", "uii": "...", "agentExtensionId": "...",
  "brand": "WYNN",
  "writerTaskId": "...", "promptCacheKey": "livecoach:writer:v2:objection",
  "class": "settlement-promise",
  "match": "pennies on the dollar",
  "action": "fallback",
  "field": "tryLine"
}
```

Emitted on every block, alert-driven, not a dashboard a human watches — manual verification never gets done. A spike of `coach.compliance_blocked` by `brand` + `promptCacheKey` means a writer prompt family is leaking guarantee-language and needs a card; that is the signal, not someone reading bodies.

Kill is one flip: `LIVE_COACH_COMPLIANCE_GATE` (`enforce` | `monitor` | `off`). `monitor` emits the event but renders anyway, for tuning the table without blocking the floor. Default `enforce`. There is no mode that ships an unscrubbed generated claim to a render.

Boundary: a generated line that cannot be made compliant is suppressed, never softened. Prefer the lookup-backed card over a writer line we cannot vouch for.

### Writer Output Validation And Repair Contract

Failure Behavior covers a stage that did not answer. This covers a stage that answered with garbage. They are different problems. A model can return HTTP 200, valid-looking JSON, and still cross off the wrong benchmark.

Every model boundary emits strict JSON: `transcript.repaired`, `coach.classified` / `coach.beat_classified`, `writer.response`. Vite does not infer checklist state. `applyGuideDelta` applies `guideDelta` directly. So an unvalidated payload is not a cosmetic bug. It mutates the call.

This section also OWNS the `writerDecision` field. It is one closed enum, one owner:

```text
writerDecision ∈ { output, wait, shed, lookup_fallback, stale_drop }
```

`output` = a writer card was produced; `wait` = the writer chose to hold (thought incomplete); `shed` = the writer was dropped under saturation (Concurrency And Per-Call Session Isolation); `lookup_fallback` = a lookup-backed card stood in for a failed/flipped writer (Live Provider Failover); `stale_drop` = the beat passed its deadline and the writer was abandoned (End-To-End Latency Budget). No other section mints a `writerDecision` value — they reference this set by name. The step-2 enum check below validates `writerDecision` against this closed set; a payload carrying any other value is coerced or fail-softed like any other bad enum.

The damage surface:

| Bad payload | Effect if applied raw |
|---|---|
| `branchDecision.branch` = `"taxes"` | reducer/router has no such branch; throws or no-ops |
| `guideDelta.complete[].id` not in `liveCoachCallGuideConfig.js` | crosses off a benchmark that does not exist |
| `reopen` an id already `captured` elsewhere | phase guide jerks backward, agent re-asks |
| `sourceKeys` cites a key not in `writer.packet_built` | card claims knowledge never selected |
| `body` over `writerIntent.maxWords` | right pane overflows, blows latency budget |
| missing required field | `applyGuideDelta` throws mid-turn, panel goes blank |

So insert a validate/repair/coerce gate between EACH model call and its event emission. Same gate, three call sites. It runs in `liveCoachBusService` before publish, never in the model.

```text
model returns -> validate -> [pass] emit event
                          -> [fixable] coerce -> emit
                          -> [unfixable] one bounded re-ask -> revalidate
                          -> [still bad] fail-soft -> emit degraded
```

Validation order, cheapest first:

1. schema-validate against the family schema (`coach.beat_classified` v2, `writer.response`). OpenAI `json_schema` does most of this; Anthropic tool/text does not, so the gate is mandatory regardless of provider.
2. enum check: `branchDecision.branch` in `{tax_guidance, objection, sales_opportunity, none}`; `writerDecision` in the closed set defined above; `targetPane`, `severity`, `status` against their enums.
3. id-membership check: every `guideDelta` id (`complete`/`partial`/`reopen`/`stillNeeded`) must exist in `liveCoachCallGuideConfig.js` for the current phase. Every `writer.response.sourceKeys` entry must be in the `staticSectionIds` of the matching `writer.packet_built`. An id the model invented is dropped, logged, never applied.
4. bounds: `maxWords`, non-empty `title`/`body`, `tryLine` only if `includeTryLine`.

Repair ladder, in order. Stop at the first that holds.

- **Deterministic coercion** for the cheap stuff: trim unknown ids out of `guideDelta`, truncate `body` to `maxWords`, drop a `sourceKey` not in the packet, lowercase/normalize an enum. No second model call.
- **One bounded re-ask** only when the structure itself is unusable (branch missing, schema fail). Re-ask is capped at one, same `transcriptId`, tightened "return ONLY valid JSON for this schema" suffix. The re-ask reuses the same `staticPrefixId` / `promptCacheKey` — do not append the error text before the cache boundary. Any changing token before the cache boundary can poison the hit rate. Put the correction in the dynamic suffix.
- **Fail-soft** if it still fails: drop to a lookup-backed card with NO `guideDelta`, OR for a classifier failure emit `branch: none` with empty delta. Never apply a partial delta from a payload that failed structural checks. Prefer no writer over a weak writer card; prefer no delta over a wrong delta.

Coercion and re-ask are logged on the per-transcript timing row: `validateMs`, `coerced` (bool), `reaskCount`, `failSoft` (bool), `droppedIds`. This is also a model-quality signal — schema reliability and re-ask rate go straight into the model test matrix, so we compare Haiku, Sonnet, GPT-5.4, and GPT-5.4 mini on how often each forces a coercion, not on vibes.

Flags, default-on, one-flip kill:

```text
LIVE_COACH_OUTPUT_VALIDATION=on      # off => emit raw (debug only, never floor)
LIVE_COACH_VALIDATION_REASK=on       # off => skip re-ask, go straight to fail-soft
LIVE_COACH_VALIDATION_STRICT_IDS=on  # off => log unknown ids but still apply
```

Boundaries:

1. The gate is structural only. It never judges whether the coaching is *good* — that is the classifier's and writer's job. It only guarantees the payload is safe for `applyGuideDelta` and the panes.
2. A re-ask is bounded to one and call-safe; it must not delay `writerFirstTokenMs` past the turn budget. If it would, skip to fail-soft.
3. Fail-soft must be silent to the agent — a degraded card, never an error toast.
4. A mis-scoped validator is its own incident class: the gate keys every check on the payload's own `transcriptId` and the current call's guide config. It never reads or writes another call's state. (2026-06-17 doctrine: a shared mechanism mis-scoped across concurrent calls cascades floor-wide.)
5. `LIVE_COACH_OUTPUT_VALIDATION=off` is the only switch that lets a malformed success reach a pane, and it is debug-only — fail-closed means the floor default is always validate.

### Idempotency, Event Replay, And Reconnect Recovery

The grader is told it can "retry from the event log later." That promise is a lie unless the stream is idempotent and ordered. Specify it.

Every event in the chain carries one key:

```text
eventKey = callId:uii:transcriptId:stage
stage in { final, repaired, classified, writer_built, writer_response }
```

`transcript.final`, `transcript.repaired`, `coach.classified` / `coach.beat_classified`, `writer.packet_built`, `writer.response` all stamp `eventKey`. Delivery is at-least-once. Dedupe is mandatory at every consumer, keyed on `eventKey`. A redelivered `transcript.final` must not re-run the classifier, must not double-apply `guideDelta`, must not emit a second `coach_response`, must not fire a second writer card.

`liveCoachBusService` already does single-flight supersede; extend its dedup/rate cap to be a durable seen-set per `callId`, not just in-flight collapse. The narrow rule "correction must not retrigger a second reaction" is one instance of this, not the general case. Generalize it: any stage whose `eventKey` was already processed is a no-op that returns the prior result.

| Stage | Dedupe owner | On redelivery |
|---|---|---|
| `transcript.repaired` | nano consumer | drop; `repairStatus` already applied |
| `coach.classified` | `applyGuideDelta` reducer | re-apply is safe IFF delta is idempotent |
| `writer.response` | `coach_response` artifact | upsert by `eventKey`, never insert |

`applyGuideDelta` must be set-semantic, not increment-semantic. `complete`/`reopen`/`stillNeeded` are state transitions on `currentGuideState`, replaying the same delta yields the same state. Vite applies `guideDelta` directly; that only stays safe if the delta is a set, not a counter. A benchmark crossed off twice is still crossed off once.

Ordering is per-`callId`, monotonic by `transcriptId` then `stage`. Cross-call ordering is irrelevant and must never be assumed — the 2026-06-17 active-call-gate cascade was a shared mechanism mis-scoped across concurrent calls. Keep the seen-set and ordering window scoped to `callId:uii`. Never a floor-wide structure.

#### Reconnect resync (no recoaching)

When the gRPC bridge (`scripts/ringcx-grpc-live-coach-bridge.js`) or the browser drops and reconnects, it must NOT replay transcripts through the classifier/writer. It requests state, not recomputation:

```json
{ "type": "coach.resync_request",
  "callId": "...", "uii": "...", "agentExtensionId": "...",
  "lastSeenEventKey": "callId:uii:T0041:writer_response" }
```

Server responds with a snapshot: current `currentGuideState`, and the active (`status: active`) `coach_response` artifacts since `lastSeenEventKey`. Dismissed/used cards stay dismissed/used. No new `writer.packet_built`, no AI-bus calls, no `ai.cache_metrics` row. Resync is a read of append-only artifacts plus the reduced guide state. Coaching never re-fires on reconnect.

Acceptance: replay the full event log of any call twice through a cold consumer and the resulting `currentGuideState` and `coach_response` set are byte-identical to one pass.

### Concurrency And Per-Call Session Isolation

The bus at `apps/ai-bus/src/server.js` (:7000) is one process holding many live calls. Every floor agent on TAG and WYNN shares it. So isolation is not a nicety; it is the whole safety story.

The session key is `{uii, callId, agentExtensionId}`. Everything keyed by that triple lives in its own partition: `currentGuideState`, `recentBeatSummaries`, and the `coach_response` artifact stream. No global map of "the current call." `transcript.final` -> `transcript.repaired` -> `coach.beat_classified` -> `writer.response` all carry the session key end to end, and `applyGuideDelta` mutates only that session's `currentGuideState`. Vite already keys on it; the bus must too.

`liveCoachBusService` single-flight supersede is scoped PER SESSION KEY, never globally.

```text
new beat on call A -> supersede in-flight writer for A only
busy writer on call B -> untouched
```

A globally-scoped supersede or in-flight lock is exactly the 2026-06-17 active-call-gate shape: one shared mechanism mis-scoped across concurrent calls, cascading floor-wide. One busy call must not starve, supersede, or gate another. Scope is the fix, not retries.

#### The writer shed (owner of the shed mechanism)

This section OWNS the writer-shed mechanism. When the bus is over its concurrency ceiling, latency, or cost, the shed always does the same thing: **drop the writer, keep nano and the deterministic reducer.** The classifier still runs, `branchDecision` still flows, the guide still advances — only the `writer.response` card is dropped. A shed writer emits `coach.beat_classified` with `writerDecision: "shed"` (the `writerDecision` enum defined in Writer Output Validation And Repair Contract) and no `writer.response` card. No card beats a stale or cross-call card. Emit `ai.cache_metrics` and a `LIVE_COACH_SHED` alert on every shed — fail-closed and alert-driven, not a dashboard a human is assumed to watch. The latency trigger (End-To-End Latency Budget) and the cost trigger (Cost Governors) both call into this shed; they do not re-specify it or emit a differently-shaped event.

Per-bus concurrency ceiling: `LIVE_COACH_MAX_CONCURRENT_WRITERS` (in-flight writer tasks across all sessions). When saturated, shed by tier, not by call:

| tier | path | under saturation |
|------|------|------------------|
| deterministic | `applyGuideDelta`, dedup/rate cap | always runs |
| nano | `transcript.repaired` repair | always runs |
| classifier | `classifier.branch_router.v2` | keep; `branchDecision` still flows |
| writer | `writer.<chunk>.<branch>.v2` | shed first |

Shed order is fixed: drop the writer, keep nano and the deterministic reducer. The guide still advances.

Horizontal scale: shard by session key (consistent hash of `uii`) so a call pins to one bus replica for its lifetime; `coach_response` in `tagcontactbridge_parallel` stays the durable cross-replica record. No cross-session shared mutable state means replicas need no coordination.

Boundaries:

1. No bus state is global; everything is keyed by `{uii, callId, agentExtensionId}`.
2. Supersede and concurrency limits are per session key; saturation sheds the writer first.
3. `LIVE_COACH_DISABLE_WRITER` is the one-flip, call-safe kill — drops to classifier + nano + reducer, no restart.

### Tenant And Brand Isolation (TAG vs WYNN)

The platform is dual-tenant at the top: Phase 0 first field is `Brand/domain: TAG or WYNN`. Everything downstream is accidentally single-tenant. The writer static prefix says "Wynn Tax Solutions agents". `DEFAULT_STT_DOMAIN_PRIMER` / `buildCallSttPrimer` bake in "Wynn Tax Solutions" (already a known hallucination vector). `prompt_cache_key` has no tenant segment. A TAG agent today gets WYNN doctrine and a WYNN primer. Fix it without poisoning the cache.

First, split what is shared from what is brand-scoped.

| Layer | Scope | Where it lives |
| --- | --- | --- |
| writer doctrine, output schema, tactic primitives | SHARED | `writer.<chunk>.<branch>.v2` static prefix |
| `classifier.branch_router.v2` branch defs | SHARED structure, tenant-tuned labels | classifier prompt family |
| brand name, opening legitimacy script, fee/POA language | TENANT | dynamic bottom of the prompt |
| allowed-claims list (compliance) | TENANT | per-brand allow-list passed to writer |
| source mix, guide config, benchmark ids | TENANT | `liveCoachCallGuideConfig.js` |
| STT primer | TENANT | `buildCallSttPrimer(brand)` |

Brand is resolved once, at call open, from Phase 0, then carried on every event (`transcript.final`, `coach.classified`, `writer.response`) as `brand`. No service re-derives it. Brand selects: the guide config that seeds `currentGuideState`, the classifier branch defs, the writer family variant, and the compliance allowed-claims handed to the writer. `applyGuideDelta` stays brand-agnostic — Vite still applies `guideDelta` directly; only the config feeding it differs.

Now the cache. The rule holds: any changing token before the cache boundary poisons the hit rate. So **never** prepend `brand` as a variable into the shared static prefix. Two legal moves:

```text
A. per-tenant stable prefix family
   staticPrefixId = livecoach:writer:v2:wynn:objection
   -> stable string, its own warm cache, no cross-tenant token churn
B. brand in the dynamic bottom only
   shared static prefix (doctrine) -> [cache boundary] -> brand block, primer, allowed-claims
```

Prefer B for the writer doctrine (one warm prefix serves both brands; brand strings ride the dynamic tail). Use A for the STT primer and any brand text that must sit early. Either way `prompt_cache_key` gains a tenant segment: `livecoach:writer:v2:wynn:objection`. Keep brand out of the static body; keep it in the key and the tail.

```json
{ "promptCacheKey": "livecoach:writer:v2:wynn:objection",
  "staticPrefixId": "livecoach:writer:doctrine:v2",
  "brand": "WYNN" }
```

Watch `ai.cache_metrics` per `brand` after rollout. A hit-rate drop on one tenant means a brand token leaked above the boundary.

Boundaries:
1. Brand resolved once at Phase 0, carried on every event, re-derived nowhere.
2. Doctrine and schema are shared; name, scripts, claims, primer, guide config are tenant-scoped.
3. Tenant goes in `prompt_cache_key` and the dynamic tail — never as a changing token before the cache boundary.
4. `LIVE_COACH_BRAND_ISOLATION` is the one-flip kill: off = legacy single-tenant prefix, on = brand-scoped. Mis-scoping a shared mechanism across concurrent calls is how the floor blew up on 2026-06-17; brand must partition, never gate.

### End-To-End Latency Budget, Staleness Deadline, And Backpressure

Today latency is logged, not governed. The timing row tells us what happened; it does not stop a card from landing two turns late. Make it a budget.

A late card is worse than no card.

#### The budget

Target: `transcript.final -> right-pane card` in **1200 ms** p95. Split it across the serial chain. Nano now sits IN FRONT of the classifier, so its cost is on the critical path of every beat, not optional.

| Stage | Field | Budget | Hard cap |
|-------|-------|-------:|--------:|
| repair | `nanoMs` | 150 | 300 |
| classify | `classifierMs` | 250 | 500 |
| packet/tool | `toolMs` | 200 | 400 |
| writer first token | `writerFirstTokenMs` | 600 | 1000 |
| **end-to-end** | sum to first delta | **1200** | **2000** |

Budgets are per-stage so we can read `ai.cache_metrics` and the timing row and say which stage blew it, not argue from vibes. `writerDoneMs` is for cost, not for the card deadline — the card may stream after first token.

#### Staleness deadline

Every beat carries a `beatDeadlineAt = transcript.final ts + LIVE_COACH_BEAT_STALE_MS` (default 2500). The deadline travels with the beat, checked at each stage entry.

```text
transcript.final -> stamp beatDeadlineAt
  at classifier entry: now > deadline -> DROP, emit coach.classified{ branchDecision: stale_drop }
  at writer entry:     now > deadline -> SKIP writer, emit writerDecision: "stale_drop", lookup card only
```

The classifier still updates `currentGuideState` via `applyGuideDelta` even on a stale drop — state must not skip turns. Only the writer card is abandoned: the writer emits `writerDecision: "stale_drop"` (the `writerDecision` enum defined in Writer Output Validation And Repair Contract) and no `writer.response`, never a bare `writerNeeded=false`. Vite applies `guideDelta` directly; a dropped writer leaves the phase guide correct, just wordless.

#### Stale-beat DROP / COALESCE

When the agent has moved ahead, do not coach the past.

```text
inflight beat B0, new transcript.final B2 arrives:
  B0 not past deadline, same branch  -> COALESCE: supersede B0 with B2 (single-flight supersede, WAIT refund)
  B0 past deadline                   -> DROP B0, start B2 clean
  B2 is N>=2 turns ahead of B0       -> DROP B0 unconditionally, never emit its card
```

This is the existing single-flight supersede in `liveCoachBusService`, now driven by the deadline instead of only by arrival.

#### Backpressure

When a stage runs hot (rolling p95 over cap for 10s), shed load before queue depth grows. The writer drop reuses the writer shed defined in Concurrency And Per-Call Session Isolation, triggered here on latency — drop the writer, keep nano + classifier + the deterministic reducer, emit `writerDecision: "shed"`. Only the trigger and flag are distinct:

| Pressure | Action | Flag |
|----------|--------|------|
| writer p95 > cap | invoke writer shed (latency trigger), lookup cards only | `LIVE_COACH_WRITER_SHED_ENABLED` |
| classifier backlog > 2 | drop oldest non-compliance beats | `LIVE_COACH_BEAT_SHED_ENABLED` |
| sustained overload | freeze writer, keep `guideDelta` flowing | `LIVE_COACH_DEGRADE_TO_GUIDE_ONLY` |

Compliance beats (DNC/screener) never shed. Shedding is observational-safe: it removes writer cards, never mutates queue state for another call — the 2026-06-17 active-call-gate doctrine holds, no shared mechanism mis-scoped across concurrent calls.

This promotes **Latency creep** from a Transition Risk to a controlled one. Boundary: the budget is enforced, the deadline drops late beats, and degrade-to-guide-only is one flip and call-safe.

### Live Provider Failover And Degraded-Mode Policy For The Hot Chain

The AI-bus already does OpenAI<->Claude bidirectional failover via `aiProviders`. But that failover was written for `liveCoach.translate` — the translator sidecar, OFF the hot path, where a 4s cold retry is invisible. On the turn-synchronous chain it is not invisible. A mid-call flip changes three things at once:

```text
provider flip -> cold cache prefix family (livecoach:writer:v2:* misses)
             -> structured-output shape (OpenAI json_schema <-> Anthropic tool/text)
             -> new timing profile (writerFirstTokenMs unknown)
```

So on the hot chain, failover is not automatic. It is budget-gated. The latency budget from the budget section is the only authority: if the remaining budget cannot absorb a cold-cache retry plus a schema-shape adapter, we do NOT flip. We degrade.

Per-step degradation order. Same ladder for classifier and writer, different rungs:

| Step | Failure | First | Then | Floor |
|------|---------|-------|------|-------|
| classifier (`classifier.branch_router.v2`) | timeout/error | flip provider IF budget allows cold retry | reuse last `currentGuideState`, emit `coach.classified` with `classifierRead.confidence: 0` and `writerNeeded: false` | reuse last `currentGuideState`, emit no NEW `guideDelta` |
| writer (`writer.<chunk>.<branch>.v2`) | timeout/error | flip provider IF budget allows | drop writer, emit lookup-backed card (no `writer.response`), `writerDecision: "lookup_fallback"` | skip the card |

`writerDecision: "lookup_fallback"` is the `writerDecision` enum value defined in Writer Output Validation And Repair Contract — failover does not mint its own. On the classifier floor we reuse the last `currentGuideState` and emit no NEW `guideDelta` (read-safe), consistent with the latency section's rule that state must not skip turns: a degraded turn keeps state coherent, it just adds no delta.

A flip means the runner re-emits through `aiTaskRunner` with the sibling `family`/`model`, and an adapter normalizes the response into the same `writer.response { title, body, tryLine, guideEffect, sourceKeys }` and the same `guideDelta` shape — Vite never sees which provider answered. `applyGuideDelta` is provider-blind; that property is what makes the flip safe. The cold hit shows up as a miss in `ai.cache_metrics`, expected, not an alarm.

The lookup-backed card is the real safety floor: a `liveCoachCallGuideConfig.js` benchmark card surfaced with no model in the loop. "Prefer no writer over a weak writer card" — and prefer a static card over a panicked flip.

Cost governors share this ladder but trigger differently: they degrade on spend/rate, this degrades on latency/failure. Same rungs, two triggers. Never wire them to flip floor-wide off one call's miss — that is the 2026-06-17 shape. Failover is per-`taskId`, per-call, scoped by `callId/uii/agentExtensionId`.

Operability is fail-closed, not a dashboard. Each degradation emits a timing row (`writerFirstTokenMs`, `vadToFirstDeltaMs`) plus a `degradeReason`; a sustained-flip or sustained-fallback rate over `LIVE_COACH_DEGRADE_ALERT_RATE` alerts, it does not wait to be watched.

Two flags, both one-flip and call-safe:
1. `LIVE_COACH_HOTCHAIN_FAILOVER=off` — disable in-chain flips; degrade straight to lookup/skip.
2. `LIVE_COACH_DEGRADE_FLOOR=lookup|skip` — pick the floor when the budget is blown.

Boundary: the hot chain may flip, fall back, or skip — it may never block the turn waiting on a cold provider.

### Cost Governors, Per-Call Cost Model, And Cache-Hit-Rate Health

One runtime surface. It governs spend, predicts it, and watches the cache that makes the prediction true. All three feed off the same telemetry: `ai.cache_metrics` plus the per-task row (`taskId/family/provider/model/usage/elapsedMs`) and the per-transcript timing row.

#### Governors

Ceilings are per-tenant (TAG / WYNN) AND per-floor. Two limits: TPM and dollars/hour. The governor lives beside `liveCoachBusService` single-flight; it does not live in the model.

```text
ceiling hit -> shed load by LADDER, never by silent drop
429 mid-call -> failover via aiProviders -> if both refuse, descend one rung
```

Degradation ladder. Drop the most expensive, least-floor-critical step first. Rung 1 is the writer shed defined in Concurrency And Per-Call Session Isolation, triggered here on cost — drop the writer, keep nano + classifier + the deterministic reducer, emit `writerDecision: "shed"`. Only the trigger (spend/rate) and the kill flag are distinct:

| rung | active steps | what dies |
|------|-------------|-----------|
| 0 normal | nano + classifier + writer | nothing |
| 1 | nano + classifier | writer shed (cost trigger); `writer.response` suppressed; `guideDelta` still applies |
| 2 | nano + deterministic | classifier off; deterministic reducer + lookup-backed cards only |
| 3 floor-safe | nano only | `transcript.repaired` to corrected-transcript NDJSON |

Rung 2 degrades to the deterministic reducer plus the lookup-backed cards from Live Provider Failover And Degraded-Mode Policy — the same lookup floor, no model in the loop. It does NOT route through `parseNavigatorSay()`; that path is reserved for the floor-wide `legacy` kill in Rollout, Canary, And Floor-Wide Mid-Call Kill Switch, the true legacy fallback. nano + the `applyGuideDelta` reducer never get shed. The checklist must keep moving. Kill is one flip: `LIVE_COACH_COST_LADDER_FLOOR=3`. A mis-scoped shared ceiling is the 2026-06-17 failure mode — `LIVE_COACH_COST_CEILING_SCOPE` must resolve per `callId`, never cancel a concurrent call's writer to pay for this one.

#### Per-call cost model

Cost rolls up the four steps x provider rate x volume:

```text
cost/call = beats * ( nano + classifierRate )
          + beats * writerNeededRate * writerRate
nano, deterministic = ~0
```

`writerNeededRate` comes from `writerDecision/writerNeeded` on `coach.classified` — most beats are WAIT. Steady-state expectation per pairing, ~14 beats/call, ~22% writerNeeded:

| classifier x writer | $/beat cls | $/writer | est $/call |
|---|---|---|---|
| Haiku x Haiku | low | low | ~$0.02 |
| GPT-5.4 mini x GPT-5.4 mini | low | low | ~$0.03 |
| Haiku x Sonnet | low | high | ~$0.11 |

Break-even is one line: a writer pairing is justified when its marginal $/call x calls/day < incremental closed revenue it drives. Sonnet earns its keep only if the better `writer.response` lifts close rate enough to clear that delta. This section owns the COST side of the deferred Sonnet-vs-mini decision — the marginal $/call data here. It does not own the value side: whether Sonnet's card actually lifts set/close rate is measured in Sales-Outcome Holdout And Lift Measurement. Cost from Cost Governors, value from Sales-Outcome Holdout; neither decides alone.

#### Cache-hit-rate health

Targets per prompt family. Any changing token before the cache boundary can poison the hit rate.

| family | `prompt_cache_key` | target |
|---|---|---|
| `classifier.branch_router.v2` | `livecoach:classifier:v2` | >= 0.90 |
| `writer.<chunk>.<branch>.v2` | `livecoach:writer:v2:<branch>` | >= 0.85 |

Alert (not a dashboard a human watches): if `ai.cache_metrics` hit-rate for a `staticPrefixId` drops below target for 5 min, fire. The usual poison is a timestamp or UII landing before the boundary, or `buildCallSttPrimer` mutating `DEFAULT_STT_DOMAIN_PRIMER` per call. Shift start is expected: cold prefixes -> miss storm -> latency and cost spike together; suppress the alert for the first 3 min, then it must recover.

Acceptance: spend is bounded by ladder, predicted by the model, and the cache alert fires before the bill does.

### Transcript PII Handling, Redaction, And Retention Policy

This coach hears everything an agent hears, and in Phase 5 onboarding it hears legal name, address, DOB, and SSN read aloud. That speech lands in `transcript.final`, gets cleaned by nano into `transcript.repaired`, and from there flows into artifacts we persist and into providers we call for eval. Treat the transcript as carrying live PII by default.

The floor already hard-stops on DNC. PII redaction is the same class of rule: a deterministic seam stage, not a model — the compliance gate in Generated-Language Compliance Gate is "not a model" the same way. It runs before the artifact exists, not after. Redact at the seam, never at read time.

#### What counts as PII

| Class | Pattern source | Redacted form |
|---|---|---|
| SSN | 9-digit / `NNN-NN-NNNN`, Phase 0 onboarding window | `[SSN]` |
| DOB | spoken/structured date in identity beat | `[DOB]` |
| Card PAN | 13-19 digit Luhn | `[CARD]` |
| Bank acct / routing | acct+routing pair near "account/routing" | `[BANK]` |
| Legal name / address | Phase 0 `Brand/domain` identity beat only | `[NAME]` / `[ADDRESS]` |

Detection is regex-first (cheap, deterministic). Redaction is its OWN deterministic pass — a distinct seam stage that runs AFTER nano repair and BEFORE any store or provider send, never folded into the nano call. nano fixes the words; Sonnet understands the call. Redaction is neither: it is a regex scrub between them. It emits `redactStatus` as its own field and costs `redactMs`, a separate budget line, NOT added to nano's `nanoMs` budget (End-To-End Latency Budget). No transcript leaves the seam un-scanned.

#### The redaction seam

```text
transcript.final -> nano(repair) -> redact pass(redactStatus) -> transcript.repaired -> classify/write/persist
```

Everything downstream consumes the redacted stream. The raw `transcript.final` is in-memory on the bridge and on `liveCoachBusService` only; it is never written to disk and never sent to `aiTaskRunner`. `coach_response.transcriptSnippet`, beat summaries, corrected-transcript NDJSON, grader `scoreEvidence`/`keyMoments` — all store the redacted token, never the digits.

Any golden/eval/labeling set stores REDACTED text only. The prompt families `classifier.branch_router.v2` and `writer.<chunk>.<branch>.v2` are tuned and compared on redacted goldens. A real SSN in a golden file is a leak, not a feature.

#### Retention and TTL

| Artifact | TTL | Store |
|---|---|---|
| `transcript.final` (raw) | 0 (RAM only) | bridge / bus |
| `transcript.repaired` NDJSON | 30d | `tagcontactbridge_parallel`, encrypted at rest |
| `coach_response` | 30d | append-only, status-keyed |
| beat summaries / grader state | 90d | closeout store |
| corrected-transcript NDJSON | 90d | eval store, redacted |
| redacted goldens | indefinite | redacted only |

Mongo collections carry a TTL index on `expireAt`; file artifacts carry a sweeper keyed off the same field. Encryption at rest is mandatory on every store that touches a transcript.

#### Right-to-erasure

Deletion is keyed by `callId` / `uii` (the same keys that scope `coach_response`). A `LIVE_COACH_ERASE_REQUESTED` event fans out to every store and emits a per-store `erased` proof; missing proof alerts. Erasure is fail-closed and alert-driven, not a console someone is assumed to watch.

Kill switch is one flip: `LIVE_COACH_REDACTION_REQUIRED=true` is the default and call-safe. If the redact pass cannot confirm `redactStatus`, the artifact is dropped, not stored raw. Prefer no artifact over a leaked SSN.

### Operational SLOs, Quality And Drift Monitoring, And Symptom-To-Action Runbook

We already emit the per-transcript timing row (`sttMs`, `nanoMs`, `classifierMs`, `toolMs`, `writerFirstTokenMs`, `writerDoneMs`, `vadToFirstDeltaMs`) and the `taskId/family/provider/model/usage/elapsedMs` rows. Those are facts. This section turns facts into fail-closed signals. Nobody watches a dashboard. The doctrine holds: manual verification never gets done. So every threshold below is an alert that fires an action, not a chart a human is assumed to read.

#### SLOs and the latency/availability runbook

SLOs are measured per tenant (`Brand/domain: TAG or WYNN`), windowed over a 5-minute rolling count, and evaluated inside `liveCoachBusService` where the timing row already lands.

| SLO | Target (p95) | Alert | First action |
|---|---|---|---|
| `vadToFirstDeltaMs` | < 1200ms | > 2500ms, 5min | degrade writer model down-tier |
| `writerFirstTokenMs` | < 900ms | > 2000ms | drop to `writerNeeded`-only hard branches |
| provider 429 / 5xx rate | < 1% | > 5%, 2min | flip `aiProviders` failover, then `LIVE_COACH_WRITER_ENABLED=false` |
| classifier emit rate | matches `transcript.final` rate within 10% | cards stop | see symptom table |

```text
symptom -> diagnosis -> action (one-flip, call-safe)

cards stopped appearing
  -> classifierMs present, writer.response absent  -> writer stuck:  LIVE_COACH_WRITER_ENABLED=false (classifier + guideDelta still flow)
  -> classifierMs absent                           -> classifier/bus down:  check liveCoachBusService single-flight, restart :7000
latency spiked (writerFirstTokenMs)
  -> usage rows show provider slow  -> LIVE_COACH_WRITER_MODEL=haiku (down-tier), keep Sonnet for objection only
429 storm (ai.cache_metrics shows cache misses climbing)
  -> a changing token crossed the cache boundary  -> pin staticPrefixId, verify promptCacheKey; suspect buildCallSttPrimer churn
nano suspicious=true en masse (transcript.repaired)
  -> STT domain drift  -> bypass repair (emit transcript.final raw), pin DEFAULT_STT_DOMAIN_PRIMER, do NOT let it inject 'Wynn Tax Solutions' into TAG calls
```

Each action is one env flip. Kill is `LIVE_COACH_WRITER_ENABLED=false` — the four-step pipeline keeps classifying and updating `currentGuideState`; only the writer card goes dark. Prefer a silent coach over a mis-scoped one. We learned on 2026-06-17 that a shared mechanism mis-scoped across concurrent calls cascades floor-wide, so every threshold above is keyed and evaluated per `callId/uii/agentExtensionId` — never one global counter.

#### Output-quality and drift monitoring

Quality drift is silent. It does not spike latency. We derive it from the same events and alert on distribution, not on any single call.

| Signal | Source | Alert condition | Action |
|---|---|---|---|
| card spam | `coach.classified.writerNeeded` true rate | > 60% of finals, 10min | raise branch threshold, audit `classifierRead.confidence` floor |
| silent coach | `writerNeeded` true rate | < 5% over 30 calls | suspect classifier collapse; sample `coach.beat_classified` |
| branch skew | `branchDecision` histogram | one branch > 70% | "everything an objection" — re-baseline `classifier.branch_router.v2` |
| nano-suspicious rate | `transcript.repaired.repairStatus` | rising 3x baseline | STT/primer drift; see runbook |
| benchmark drift | `applyGuideDelta` cross-off rate vs `liveCoachCallGuideConfig.js` | completions firing with no matching `stillNeeded` | guideDelta inflation; freeze writer `guideEffect` |
| compliance suppressed | `coach_response` active vs dismissed by branch | compliance reactions dismissed/superseded by sales reactions repeatedly | promote compliance branch priority in supersede order |

These run as a scheduled rollup over the emitted events plus `coach_response` status transitions; the rollup emits an alert task on breach, nothing on green. The writer schema never changes here — Sonnet decides WAIT vs output, not the benchmark. Drift detection reads contracts; it does not author them.

Boundary: a quality alert that cannot name a one-flip action is not an alert. Delete it.

### Golden Call Set And Continuous Regression Gate

Hand lists rot. Eight pre-live safety tests, a 14-item smoke checklist that admits "test infrastructure implied, not yet built", a 20-case objection eval, the phase acceptance tests — all of it collapses into one standing corpus and one gate. We do not compare Haiku, Sonnet, GPT-5.4, GPT-5.4 mini on vibes. We replay them on the same redacted calls and read the diff.

The corpus is versioned NDJSON, one fixture per real recorded call, redacted, with FROZEN expected labels. A fixture carries audio (or pre-recorded `transcript.final` frames) plus the expected `transcript.repaired` corrections, the expected `branchDecision`, `guideDelta`, `writerNeeded`, and objection-family. Frozen means: a change to a label is a code review, not a test flake.

```json
{
  "fixtureId": "golden:wynn:silence-not-levy:0007",
  "brand": "WYNN",
  "transcriptFinal": ["...","..."],
  "expect": {
    "repaired": [{"in":"cp five oh four","out":"CP504"}],
    "branchDecision": "objection",
    "objectionFamily": "price_before_facts",
    "writerNeeded": true,
    "guideDelta": {"complete":["discovery"],"reopen":[],"stillNeeded":["balance"]}
  }
}
```

The gate replays the WHOLE chain — nano repair -> `coach.classified` -> writer, through `aiTaskRunner`/`aiProviders`, ending at `applyGuideDelta`. Not unit stubs. The same path the floor runs.

The hard cases the doc keeps citing are seeded as named fixtures and are never allowed to regress:

| fixture | asserts |
|---|---|
| `silence-not-levy` | silence -> no CP504/levy/Wynn invented (the `buildCallSttPrimer` hallucination vector stays caged) |
| `spanish-preserved` | non-English passes through; `liveCoach.translate` stays off the hot path |
| `cp504-alias` | "cp five oh four" -> CP504 in `transcript.repaired` |
| `price-before-facts` | `branchDecision=objection`, writer fires |
| `dnc-terminal` | DNC is terminal; no writer, no reopen |

Each run emits a drift report: per-fixture pass/fail, plus label diffs and a per-model timing row (`classifierMs`, `writerFirstTokenMs`, `writerDoneMs`) so a swap that passes labels but blows latency still shows red. Cache health rides along via `ai.cache_metrics` — a prompt edit that silently moves `promptCacheKey` shows up as a hit-rate cliff, not a surprise bill.

Gate wiring:

```text
prompt/config/model change -> replay golden set -> label diff + drift report
  any frozen-label miss        -> FAIL, block the flip
  hard-case fixture miss       -> FAIL, page (fail-closed, not a dashboard)
```

The 2026-06-17 doctrine holds: no model or prompt reaches concurrent calls without passing this corpus first. Boundary: a new `LIVE_COACH_*` flag, a new prompt family (`classifier.branch_router.v2`, `writer.<chunk>.<branch>.v2`), or a candidate model ships only on a green golden run. No green run, no flip.

### Rollout, Canary, And Floor-Wide Mid-Call Kill Switch

The transition plan stops at per-feature local flags. Local flags answer "is this writer wired?" They do not answer "is the chain safe to run on live calls right now?" That second question needs one global switch and one promotion gate.

#### Two layers of flag

`LIVE_COACH_CHAIN_MODE` is the master, evaluated per-session at call start, never mid-call (changing it mid-call would tear the prompt cache mid-stream — any changing token before the cache boundary poisons the hit rate, and the same applies to swapping chains under a live writer).

```text
legacy   -> only parseNavigatorSay / dialog.say, next-gen chain dark
shadow   -> next-gen chain runs, coach_response written status=dismissed, agent sees legacy only
canary   -> next-gen renders for agents in LIVE_COACH_CANARY_AGENTS, legacy for the rest
live     -> next-gen renders for all; legacy is fallback only
```

The `legacy` mode here owns `parseNavigatorSay` / `dialog.say` — this is the one true legacy fallback. No other section degrades to `parseNavigatorSay`; the cost ladder's rung 2 (Cost Governors) falls to the deterministic reducer plus lookup cards, not to this path. Shadow is mandatory before canary. In shadow the full chain — `transcript.repaired` -> `coach.classified` -> `writer.response` — runs and emits `coach_response` rows the agent never sees. This produces golden-set comparison data at zero floor risk.

#### Canary scope and promotion gate

Canary opens on WYNN first (smaller benchmark surface in `liveCoachCallGuideConfig.js`), a named agent allow-list, never a tenant-wide flip. Promotion `canary -> live` is automatic only when all three signals hold over a rolling window; any one failing freezes promotion and pages.

| Signal | Source | Promote threshold |
|---|---|---|
| Quality | golden-set vs shadow `coach_response` | >= legacy keyMoments agreement, no new false-WAIT |
| SLO | per-transcript timing row (`vadToFirstDeltaMs`, `writerFirstTokenMs`) | p95 within budget |
| Cost | `aiTaskRunner` usage / `ai.cache_metrics` | per-call cost <= ceiling, cache hit-rate steady |

Promotion is a decision taken from these three, not from vibes. No manager watches a dashboard — manual verification never gets done.

#### The kill switch

One operator action. Set `LIVE_COACH_KILL=1`. `liveCoachBusService` reads it on every beat; on `1` it stops scheduling `writer.packet_built` and routes every active session — mid-shift, mid-call — back to `parseNavigatorSay` / `dialog.say`. No call drops, no STT teardown, no UII churn. In-flight writer single-flights are superseded, not awaited.

```text
LIVE_COACH_KILL=1 -> bus skips classifier+writer
                  -> active sessions fall to dialog.say next beat
                  -> agents keep their call; coaching degrades, never disconnects
```

This is the one mechanism allowed to be floor-wide, because the 2026-06-17 active-call-gate taught that shared mid-call mutations cascade — so the only floor-wide lever is the one that reverts to the known-safe path, evaluated per-beat, additive-to-safe. `LIVE_COACH_KILL` is alert-driven: any SLO or provider-failover breach trips it automatically and pages; an operator can also flip it by hand.

Boundary: kill is one flip, call-safe, and degrades to legacy — never to silence.

### Sales-Outcome Holdout And Lift Measurement

Internal accuracy (classifier confidence, repairStatus, `ai.cache_metrics`) proves the coach is *correct*. It does not prove the coach *sells*. Those are different claims. This section measures the second one.

Outcome is not transcript-shaped. It lands in the CRM hours later. So attribution is a join, not an event: key the coach footprint (`coach_response` rows, `callId`/`uii`/`agentExtensionId`) to the close/set outcome in `tagcontactbridge_parallel`.

Randomize at the **agent-week** in an agent-level switchback, not per-call. Per-call assignment leaks: an agent coached on call N carries the skill into uncoached call N+1. The switchback flips whole agents on/off in weekly blocks behind one flag.

`LIVE_COACH_HOLDOUT_MODE` = `off` | `switchback` | `agent_holdout`. `LIVE_COACH_HOLDOUT_RATIO` (default `0.0`). Assignment is deterministic from `agentExtensionId + isoWeek`, written to a `holdoutArm` field on every CallLog so a coached call can never be silently re-coded as control. One flip to `off` reverts; coaching stays live, only measurement stops. Kill must be call-safe — never gate a dial on holdout state (2026-06-17 doctrine).

| metric | role | source |
|---|---|---|
| set rate | primary (front) | dispo -> appt set |
| close rate | primary (back) | retainer signed |
| ramp days-to-first-close | primary (new agents) | hire date -> first close |
| talk-time / call | guardrail | must not balloon |
| dismiss rate of `coach_response` | guardrail | high = noise, not lift |
| QA score | guardrail | Incremental Grader `scoreEvidence` |

```text
CallLog{callId, uii, agentExtensionId, holdoutArm, brand} -> join coach_response.status(used) -> join CRM outcome -> lift = set_rate(coached) - set_rate(control)
```

Stratify every cut by `brand` (TAG vs WYNN) — never pool the tenants. Pooled lift hides a per-brand regression.

Power: floor close rates ~5-8%, expected lift small. To detect a 2pt absolute set-rate move at 80% power you need ~1.5-2k calls per arm. That is roughly **4-6 weeks** of switchback, not a 3-day read. Do not call it early; switchback's own week-to-week variance is the confound.

Honest confounds, stated: skill carryover across weeks, lead-list quality drift, seasonality, and agents who *feel* watched. The switchback averages over carryover; it does not erase it. Report lift with a confidence interval and the confound list attached — never a single triumphant number.

This is the only number that justifies cost. This section owns the VALUE side of the deferred Sonnet-vs-mini writer decision — set-rate / close-rate lift, measured *here*, not in `writerFirstTokenMs`. It does not own the cost side: the marginal $/call that the lift must clear is computed in Cost Governors, Per-Call Cost Model, And Cache-Hit-Rate Health. Value from Sales-Outcome Holdout, cost from Cost Governors; neither decides alone. A faster cheaper writer that does not move set rate wins; a Sonnet card that adds 2pt earns its tokens.

The boundary: ship no holdout that can change which calls get dialed, and trust no lift read under 4 weeks or pooled across brands.

