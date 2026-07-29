# Sales Trainer Curriculum + Call Review Design

**Date:** 2026-07-28  
**Status:** Product and architecture design only  
**Scope:** Local Sales Trainer, curriculum, simulation, post-call review, and the bridge to Live Coach  
**Not authorized by this document:** live deployment, service restart, production data access, or changes to CX/RingCX

## 1. Decision

Build one training system with four kinds of evidence:

1. **Knowledge** — can the agent recall and explain the rule?
2. **Guided execution** — can the agent perform the tactic in a constrained Gauntlet?
3. **Transfer** — can the agent recognize and use it in a natural Free Call?
4. **Real-call evidence** — can the agent use it on an actual customer call?

The system should not treat these as interchangeable. A quiz pass is not call mastery, a Gauntlet pass is not proof of natural transfer, and an AI finding from a noisy real recording is not a disciplinary fact.

The product loop is:

```text
Learn
  → retrieve the rule
  → recognize the moment
  → say the move
  → pass a targeted Gauntlet
  → try a Free Call
  → review a real call
  → receive the next targeted assignment
```

All four experiences must use the same versioned `ruleId` vocabulary. That is what lets the Trainer, Call Review, and Live Coach become parts of one system instead of three unrelated AI features.

## 2. Product shape

### 2.1 Three connected stations

```text
┌──────────────────────────┐
│ COURSE + SIMULATOR       │
│ Learn, quiz, Gauntlet,   │
│ Free Call                │
└────────────┬─────────────┘
             │ same rule IDs, tactics, evidence contracts
┌────────────▼─────────────┐
│ CALL REVIEW              │
│ Real recording, cited    │
│ moments, reflection,     │
│ prescribed remediation   │
└────────────┬─────────────┘
             │ same weak-skill and mastered-skill ledger
┌────────────▼─────────────┐
│ LIVE COACH               │
│ Quiet, advisory guidance │
│ during actual calls      │
└──────────────────────────┘
```

Call Review is the bridge. It takes an authentic call, analyzes only supportable evidence, and sends the agent back to the exact lesson or exercise that addresses the observed miss.

### 2.2 The two practice modes

#### Gauntlet

- Targets one phase, tactic, or hard rule.
- Uses an explicit scenario graph and deterministic gates.
- The prospect remains naturally resistant until the required behavior is demonstrated.
- The model writes natural dialogue but does not decide whether the gate passed.
- A failed move produces a meaningful prospect reaction, not a hidden arbitrary score.
- Retry preserves the tested objective while varying wording and persona.

The current live-turn prompt deliberately retires objections after reasonable engagement and
forbids prolonged stonewalling. That is appropriate for Free Call, but directly conflicts with
a tactic-gated Gauntlet. Gauntlet should therefore be a separate runtime contract, not a prompt
flag layered onto the current conversation behavior.

#### Free Call

- The prospect behaves like a person rather than a test fixture.
- No artificial phase locks force the call down one path.
- The Coach remains advisory and can choose silence.
- Assessment happens from the complete call evidence.
- Free Call checkpoints test transfer after a cluster of lessons and Gauntlets.

`direction` (`inbound` or `outbound`) and `experienceMode` (`gauntlet` or `free`) must be separate fields. The current code overloads `mode` for both concepts.

## 3. Evidence already in the repository

The repository already contains enough material to seed the first course:

- 114 Field Manual entries, 94 embedded drills, and 47 compliance blocks across ten content modules.
- Stable manual entry IDs and stable objection-bank keys.
- A drill grader that already grades substance instead of word-for-word mimicry.
- Caller-profile generation, story playbooks, inbound/outbound direction, difficulty, voice selection, STT, TTS, and simulated-call recording.
- Deterministic call-phase steps, recognition markers, context keys, tactic keys, and an objection playbook.
- End-of-call facts/assessment separation, verbatim-evidence requirements, stronger-alternative fields, and a named teaching-principle catalog.
- A partial “My Calls” recording picker and on-demand scoring route.

Important local references:

- `apps/web-client/src/workspaces/field-manual/content/index.ts`
- `apps/web-client/src/workspaces/trainer/drillBank.ts`
- `apps/web-client/src/workspaces/trainer/TrainingCenterPanels.tsx`
- `packages/shared-services/src/taxResolutionSalesTrainerPrompt.md`
- `packages/shared-services/src/taxResolutionSalesTrainerPrompt.liveTurn.md`
- `packages/shared-services/src/taxResolutionSalesTrainerService.js`
- `packages/shared-services/src/coachPhaseSteps.js`
- `packages/shared-services/src/liveCoachObjectionBank.js`
- `packages/shared-services/src/cxNightlyCallGradeService.js`
- `packages/shared-services/src/transcriptionScoringService.js`
- `docs/COACH_ANALYST_DOCTRINE_2026-07-20.md`
- `docs/LIVE_PROSPECT_COACH_PLAYBOOK.md`

### 3.1 What cannot be treated as settled doctrine yet

The current corpus contains conflicts that a model must not be asked to arbitrate:

- The Analyst Doctrine says coaching is demeanor-conditional, advisory, and rarely verbatim; the “approved representation script” contains prescriptive lines and a fixed payment ladder.
- Current outbound material alternates among opted-in web inquiries, purchased form leads, and public-record provenance.
- One DNC path says acknowledge and end immediately; another allows one question if the caller remains engaged.
- The Trainer, UI, and shared Coach use different phase taxonomies.
- Manual IDs, Coach tactic keys, and prompt principle names overlap semantically but are not one registry.
- The current “My Calls” button invokes a vendor **lead-quality** grader, not an agent-performance Coach grader.

The curriculum must therefore be generated from a reviewed rule registry, not by declaring every existing sentence equally authoritative.

## 4. Curriculum map

This is the proposed first course. Each numbered section ends in an integrated checkpoint; a Free Call follows every major skill cluster.

| Section | Teaching goal | Targeted practice | Checkpoint |
|---|---|---|---|
| 0. Baseline | Establish current skill without pre-teaching | One short inbound and one short outbound call | Diagnostic only; no lock |
| 1. Trust, identity, and permission | Become safe and credible before selling | Identity, provenance, permission, DNC, sensitive-information timing | Free Call: skeptical opening |
| 2. Listening and discovery | Read the person and earn the real problem | Underlying concern, acknowledge-first, silence, four discovery pillars, summary/transition | Free Call: incomplete and emotional facts |
| 3. Tax fluency without overclaiming | Classify the issue and know what to ask next | IRS/state/mixed, notices, collections, unfiled returns, payroll, spouse, escalation boundaries | Free Call: layered tax stack |
| 4. Representation, scope, and value | Explain what the firm does before price | 2848/8821/state POA, work product, process, expectations, capability objections | Free Call: “What am I paying for?” |
| 5. Fee, money, and decision | Handle price after value and close without pressure | Early-price question, itemization, affordability, silence, spouse/decision maker, think-it-over | Free Call: quote through next step |
| 6. Resistance and edge cases | Stay calm when the normal play breaks | Burned before, competitor/CPA, hostility, bad-actor/fishing, real hard stops | Adversarial Free Call |
| 7. Integrated calls | Combine skills without visible rails | Long inbound and outbound calls with varied profiles | Final simulated capstone |
| 8. Real-call transfer | Learn from actual behavior | Personal recording review, self-diagnosis, Coach review, assigned remediation | Human-confirmed certification policy TBD |

### 4.1 Standard lesson rhythm

Every teachable rule should use the same learning rhythm:

1. **Learn** — a short rule card with why, when, steps, examples, and counterexamples.
2. **Retrieve** — answer from memory, not by rereading.
3. **Recognize** — identify what the prospect is actually concerned about.
4. **Sequence** — put the required actions in order.
5. **Say it** — give a usable response in the agent’s own words.
6. **Gauntlet** — demonstrate the behavior across two to five prospect turns.
7. **Reflect** — diagnose one real moment and propose a better move.
8. **Transfer** — encounter the same rule inside a Free Call later.

This structure intentionally combines retrieval practice and self-explanation with practice in context. Retrieval practice has been shown to improve later retention, and self-explanation helps learners connect an example to underlying principles. See Roediger & Karpicke, “Test-Enhanced Learning” (2006) and Chi et al., “Self-Explanations” (1989).

### 4.2 Exercise types

| Type | What the agent does | Grading |
|---|---|---|
| Rule recall | States the rule and its reason | Deterministic key concepts + semantic completeness |
| Classify the moment | Names the real concern, phase, or hard-stop condition | Canonical answer set |
| Order the move | Orders acknowledge, clarify, answer, advance | Deterministic |
| Listen and choose | Hears one of several prospect clips and chooses the next action | Deterministic, then explanation |
| What would you say? | Gives a natural response | Semantic rubric against required actions and forbidden actions |
| Repair the line | Rewrites a weak agent response | Rule-linked semantic rubric |
| Micro-Gauntlet | Handles a two-to-five-turn targeted exchange | Deterministic gates plus semantic evidence |
| Phase Gauntlet | Clears a complete opening, discovery, pitch, or close | Ordered rule gates |
| Free Call | Navigates a natural complete or partial call | Post hoc evidence review |
| Real Call Review | Diagnoses and improves an authentic moment | Evidence-linked Coach review; consequential flags need human confirmation |

## 5. Canonical rule registry

Create one server-owned, tenant-versioned `TrainingRuleRegistry`. It is the source for lessons, quizzes, Gauntlet gates, Free Call grading, real-call review, and Live Coach lookups.

```text
TrainingRule
  ruleId
  revision
  tenant/company overlay
  title
  type: fact | tactic | sequence | hard_rule
  phaseId
  prerequisites[]
  appliesWhen
  requiredActions[]          ordered where necessary
  forbiddenActions[]
  deterministicDetectors[]
  semanticCriteria[]
  severity
  approvedExamples[]
  counterExamples[]
  sourceReferences[]
  lessonIds[]
  scenarioFamilyIds[]
  remediationItemIds[]
  status: draft | approved | retired
```

Existing manual IDs, objection-bank keys, context keys, and prompt principle names become aliases, not competing authorities.

### 5.1 Rule classes

- **Hard rules:** non-negotiable conduct. A confirmed violation can fail an exercise.
- **Required sequences:** actions that must occur before another action.
- **Tactics:** approved ways to handle a situation; several good phrasings may satisfy one tactic.
- **Knowledge facts:** technical facts an agent must know or must escalate rather than state.
- **Judgment guidance:** demeanor-conditional coaching that should not become a rigid script.

### 5.2 Rules safe to draft now

These are repeated consistently enough to create draft registry entries, pending final management approval:

- Never claim government affiliation.
- Never claim a personal license or credential the agent does not hold.
- Never promise a tax outcome, savings figure, agency decision, or unsupported timeline.
- Do not invent tax facts, notices, dollar figures, or customer details.
- Explain the purpose before requesting sensitive information.
- Distinguish the firm from the IRS early.
- Diagnose before prescribing.
- Support every graded real-call finding with transcript/audio evidence.
- Treat low-confidence transcription or speaker identity as `uncertain`, not as failure.
- Keep UI/Coach payloads out of TTS dialogue.
- Let the Coach hold when it has nothing load-bearing to add.

Exact DNC behavior, price sequencing, payment steps, sensitive-data prerequisites, and licensed-staff claims remain unresolved below.

## 6. Reusable conversation and TTS system

### 6.1 Scenario blueprint

```text
ScenarioBlueprint
  blueprintId / version
  duration: micro | phase | long
  targetRuleIds[]
  phaseScope[]
  facts / hidden facts
  ordered graph nodes[]
  required evidence per node
  retry / pass / terminal transitions
  prospect utterance variant sets
  allowed dynamic escape behavior
  difficulty knobs
  hint policy
```

One long call should compose reusable phase blueprints rather than use one giant unique prompt.

### 6.2 Controlled variation without rote memorization

For each semantic event, author four to ten approved prospect variants:

```text
event: trust.burned-before.first-objection.v2
  “I already paid one company and got nothing.”
  “How do I know you aren’t like the last people?”
  “I did this once. Four grand disappeared.”
  “Another tax outfit burned me, so I’m not doing that again.”
```

The tested invariant is not the sentence. It is the behavior:

```text
acknowledge the prior harm
→ ask what happened
→ listen before differentiating
→ differentiate with verifiable process, not promises
```

Variation may change wording, emotion, pacing, tax facts, persona, voice, and objection order. It must not silently change the rule being tested.

### 6.3 Hybrid generation

**Pre-generate and reuse:**

- lesson narration;
- listening prompts;
- quiz and Gauntlet setup clips;
- Gauntlet graph nodes;
- common openings and objection anchors;
- approved remediation examples.

**Generate dynamically:**

- a Free Call response that must engage unexpected trainee language;
- connective dialogue in a long call;
- a bounded escape from a Gauntlet graph;
- personalized post-attempt reflection questions.

Gauntlet target audio must be all-or-nothing. The current sentence-parallel TTS path can return partial speech if one chunk fails; omitting the sentence containing the tested objection invalidates the attempt.

### 6.4 Audio cache

Use immutable content-addressed synthetic audio:

```text
SHA256(
  provider + model + exactText + punctuation +
  voiceProfileId + instructions + speed + format +
  assetSchemaVersion
)
```

- Keep punctuation because it changes prosody.
- Store one audio object and reference it from manifests.
- Pin the voice profile server-side for the full attempt.
- Avoid a repeat until the seeded variant pool is exhausted.
- Never put real-call or trainee audio in the globally reusable cache.
- Do not correlate difficulty or negative behavior with race, sex, age, or accent.
- Keep the required AI-voice disclosure on applicable surfaces.

### 6.5 Prompt stack

Split prompts into:

1. **Immutable prompt pack** — role boundary, schema, safety, and universal rules.
2. **Stable scenario block** — blueprint, profile, playbook, facts, voice, and target rule versions.
3. **Volatile turn block** — current graph node, controller decision, recent turns, and permitted speech acts.

The current session header includes changing prospect state inside the nominally cacheable block. Separating stable and volatile content is necessary for useful prompt-cache reuse.

Use distinct model contracts:

- **Prospect:** writes only in-character dialogue and structured speech-act metadata.
- **Controller:** owns current node, rule evidence, progression, retry, and termination.
- **Coach:** interprets the moment and offers advisory guidance or `HOLD`.
- **Grader:** assesses a completed attempt using cited evidence and canonical rules.
- **Review Coach:** asks reflection questions and prescribes remediation after a simulated or real call.

Only one component owns mutable session state. Observer work must be serialized per session or use expected-turn compare-and-swap so stale completions cannot overwrite newer state.

## 7. Grading and reflection

### 7.1 Evaluation order

1. Run deterministic detectors for exact requirements, sequence, and candidate hard-rule events.
2. Give the semantic evaluator only the relevant rule text and bounded transcript window.
3. Require segment or turn IDs for every semantic conclusion.
4. Server-validate that quoted evidence is truly present.
5. Let the deterministic controller apply pass/unlock policy.
6. Record model, prompt, registry, scenario, and grader versions.

The model supplies evidence and interpretation. It does not directly unlock the course or declare mastery.

### 7.2 Rule result

```json
{
  "ruleId": "objection.burned-before.listen-before-differentiate",
  "ruleRevision": 2,
  "result": "pass",
  "criteria": [
    {
      "criterionId": "acknowledged-prior-harm",
      "result": "pass",
      "evidenceSegmentIds": ["turn-7"],
      "confidence": 0.94
    }
  ],
  "forbiddenActionIds": [],
  "confidence": 0.91
}
```

Any uncited model conclusion is discarded. Serious compliance candidates from real calls must be human-reviewable at the exact audio timestamp.

### 7.3 Model-graded self-reflection

Reflection happens before the Coach reveals its full analysis:

> Prospect, 02:14: “I already paid another company and got burned.”  
> You, 02:18: “We have great reviews and can help.”  
> 1. What was the underlying concern?  
> 2. Which rule or tactic applied?  
> 3. What was missing from your response?  
> 4. What would you say next?

Grade reflection separately on:

- diagnosis of the concern;
- recall of the applicable rule;
- identification of the gap;
- usable alternative response.

Reflection is formative. Its score must not rewrite the observed call-performance score; otherwise a strong explanation after the fact could hide weak execution on the call.

### 7.4 Mastery dimensions

```text
knowledgeBest   — quizzes and rule recall
guidedBest      — targeted Gauntlets
transferBest    — Free Calls
realCallBest    — evidence from actual calls
```

A reasonable prototype policy is:

- quiz: demonstrate rule recall and avoid hard-rule errors;
- Gauntlet: clear all required gates on two wording variants;
- Free Call: complete and reflect; use score for remediation rather than the first unlock;
- final capstone: pass an integrated rubric;
- real call: inform mastery only when transcript/speaker confidence is adequate.

Exact thresholds and whether real-call review affects certification require management rulings.

## 8. Real Call Review bridge

### 8.1 Current local gap

The current `My Calls` panel is a useful visual scaffold but not the desired product:

- It calls `transcriptionScoringService.scoreWithClaude()`, whose prompt explicitly scores vendor **lead quality**, not agent performance.
- The transcriber requests timestamped segments and then flattens them into one speakerless string.
- The scorer truncates the input, so a long call can be graded without its close.
- The review route accepts a raw storage file ID rather than an opaque, re-authorized recording source.
- Results are returned ephemerally rather than persisted as curriculum evidence.
- Current recording-library scope does not yet prove that “My Calls” means only the signed-in agent’s calls.
- The Metrics/nightly path already parses Logics settlement-officer assignment activity, joins cases to `CallLog`, and retrieves supported PhoneBurner/CallRail recordings, but it does not yet expose one officer-centered Coach workflow.
- Logics `CaseInfo` does not include settlement-officer assignment and the local client has no direct “cases assigned to officer” method. The assignment fold therefore needs a proved baseline plus reassignment/unassignment handling before it can claim to be a current roster.
- Domain-specific settlement-officer IDs exist on `UserAccount`, but Call Review must reload that account server-side because the normal Trainer principal does not currently carry those IDs.

Do not patch this by relabeling the lead score. Build a distinct Coach Review pipeline.

### 8.2 Assigned-case source path

The learner-facing source path is now selected:

```text
authenticated settlement officer
→ fresh server-side UserAccount reload
→ domain-specific Logics settlement-officer identity
→ proved latest-assignment fold
→ currently assigned case references
→ CallLog lookup by domain + case
→ eligible calls with server-held recording locators
→ opaque case/call/recording source IDs
```

The source picker is therefore **Assigned cases → calls → Review**, not a generic Drive folder or “My Calls” bucket. A displayed Review link/button is an application action. It never exposes, accepts, or trusts a raw PhoneBurner, CallRail, Drive, or other provider locator.

Every case list, call list, review creation, review read, playback, and segment request reloads the current authorization facts and fails closed when:

- the settlement-officer identity is absent, ambiguous, or unsupported for the learner's company;
- the Logics assignment snapshot cannot prove the case is currently assigned to that officer;
- a reassignment or unassignment has superseded the previously observed assignment;
- the call does not belong to the authorized domain/case pair;
- the recording source is missing, ambiguous, outside the approved provider allowlist, or cannot be fingerprinted.

The first implementation may reuse the Metrics PhoneBurner/CallRail download and archive transport ideas, but not its notable-call selection or vendor lead-quality grader. EX remains excluded unless separately approved. The current broad Drive library is not an authorization source.

Case assignment answers who may discover and open a source. Agent attribution answers whose performance may be graded. Those are separate checks. Until management rules otherwise, a call without a confident server-side mapping to the learner may be available only as `ineligible` or `uncertain`, never as personalized performance evidence.

### 8.3 Processing workflow

```text
opaque recording source selected from an assigned case
→ fresh assignment and call reauthorization
→ bounded server-side recording download
→ immutable source fingerprint
→ timestamped transcription
→ speaker diarization / role confidence
→ restricted raw transcript
→ redacted grading transcript
→ deterministic rule evidence
→ semantic rule review
→ agent self-reflection
→ evidence-linked Coach review
→ targeted lesson/Gauntlet assignment
```

### 8.4 Segment contract

```text
segmentId
startMs / endMs
text
speakerId
speakerRole: agent | prospect | unknown
asrConfidence
roleConfidence
redactionFlags[]
```

If role or ASR confidence is below policy, the finding is `uncertain`. An authorized user may correct speaker A/B and request a new immutable review generation.

### 8.5 Review output

Each finding includes:

- canonical rule ID and revision;
- observed result (`pass`, `partial`, `miss`, `violation`, or `uncertain`);
- exact transcript segments;
- audio timestamp link;
- what the prospect appeared to need, explicitly marked as interpretation;
- the agent’s self-assessment;
- a concrete stronger alternative when the rule supports one;
- one prescribed lesson or Gauntlet;
- confidence and human-review status.

The top-level review should show:

1. **Here is the tape** — objective excerpts, sequence, and facts.
2. **Here is the Coach read** — interpretation, patterns, risks, and strengths.
3. **Here is your next rep** — one small assigned exercise, not a generic lecture.

Example remediation mappings:

| Observed miss | Canonical rule family | Next exercise |
|---|---|---|
| Pitched before enough discovery | `sequence.diagnose-before-prescribe` | Discovery gate Gauntlet |
| Asked for sensitive data too early | `information.explain-and-earn` | Trust-to-information micro-Gauntlet |
| Promised an outcome | `claims.no-outcome-promise` | Claim-boundary repair drill |
| Dropped price without changing scope | `price.hold-with-scope-reason` | Affordability Gauntlet |
| Filled silence after the fee | `listening.speak-silence` | Quote-and-wait listening drill |
| Failed to identify real outbound provenance | `outbound.source-and-permission` | Outbound opening Gauntlet |
| Talked past "I was burned before" | `objection.burned-before.listen-first` | Trust-repair Gauntlet |

### 8.6 Authorization, privacy, and retention


- The browser receives opaque case, call, and `recordingSourceId` values, never a raw Logics case ID, Drive ID, or provider URL.
- The server reloads the user's account and re-resolves current Logics assignment, case/call membership, and recording eligibility on every source/read/play operation.
- The durable source snapshot records the authorization authority and observation/version time without exposing the raw locator.
- Prefer CallLog-backed identity: domain, case, agent, extension, tenant, telephony session, call time, and provider.
- Enforce bounded downloads with provider allowlists, HTTPS/host and redirect validation, size/time limits, content validation, and a `finally` cleanup path.
- Store a source reference and fingerprint, not a second permanent audio copy.
- Delete temporary downloads immediately.
- Redact SSNs, payment data, DOBs, phone numbers, and emails before model calls and learner display.
- Scope raw audio/transcript access separately from redacted review access.
- Keep trainee, manager, and admin access explicit and auditable.
- Never let a model-only compliance flag automatically drive employment action.

### 8.7 Idempotency and ordering

Pin every review to:

```text
recordingFingerprint
transcriptEngineVersion
diarizationVersion
rulePackVersion
graderPromptVersion
modelVersion
reviewGeneration
```

Persist immutable results. Update the visible “latest” pointer only if the expected review generation still matches. The same version discipline is required for asynchronous Live Coach observer work.

## 9. Minimal durable data model

### Static, published definitions

1. `TrainingRuleRegistry`
2. `CourseManifest`
3. `ScenarioBlueprint`

### Persisted learner records

1. `TrainingEnrollment`
   - pinned course/rule versions;
   - resume item;
   - per-item state;
   - four-dimensional rule mastery;
   - active remediation assignments.
2. `TrainingAttempt`
   - append-only attempt;
   - item/blueprint/variant versions;
   - transcript turn IDs;
   - answers and reflection;
   - rule evidence and grade provenance;
   - recording-manifest reference.
3. `TrainingCallReview`
   - authorized source reference;
   - async processing status;
   - transcript artifact version;
   - rule findings;
   - reflection;
   - remediation;
   - access and retention policy.

Course enrollments are pinned to a published version. Publishing a new rule pack must not silently rewrite the rubric under an attempt already in progress.

## 10. Course UI

```text
/trainer
  Continue learning
  progress by section
  current remediation
  next checkpoint

/trainer/course/:courseId/item/:itemId
  curriculum rail
  lesson / quiz / Gauntlet / Free Call player
  resume state

/trainer/attempt/:attemptId/results
  tape
  reflection
  Coach read
  rule mastery
  assigned next rep

/trainer/call-review
  authorized personal call picker
  processing status
  completed reviews
  audio evidence player
```

Resume order:

1. active required remediation;
2. in-progress required item;
3. first available required item;
4. optional practice.

The overall experience should borrow the useful course-player pattern: ordered sections containing lessons, quizzes, and practice; visible completion; resume where the learner stopped; and roleplays with goals, feedback, and retry. Udemy documents those primitives in its course curriculum, course player, practice-activity, quiz, and Role Play guidance.

## 11. Rollout plan and proof gates

### Phase 0 — Doctrine lock

- Resolve the blocking questions in section 12.
- Approve one phase taxonomy.
- Publish rule registry v1 with source citations and named approvers.

**Gate:** no unresolved hard rule is embedded in a deterministic failure condition.

### Phase 1 — Durable course spine

- Publish Course Manifest v1.
- Persist enrollments, attempts, answers, grades, resume, and remediation.
- Change quiz calls from client-supplied house answers to server-owned item IDs.

**Gate:** changing browser payload content cannot change the canonical answer or rubric.

### Phase 2 — Targeted lessons and Gauntlets

- Author the first high-risk rules.
- Pre-generate semantic TTS variants.
- Add deterministic controller gates and structured semantic evaluation.

**Gate:** replaying the same blueprint varies wording but tests the same evidence; one failed audio chunk invalidates rather than mutates an attempt.

### Phase 3 — Free Call checkpoints

- Compose reusable phase blueprints into long calls.
- Separate stable prompt content from volatile state.
- Give the controller sole state ownership.

**Gate:** out-of-order observer completion cannot double-advance trust, phase, or mastery.

### Phase 4 — Call Review bridge

- Replace lead-quality scoring with the curriculum Review Coach.
- Add authorized source references, diarized timestamped transcripts, redaction, persistence, reflection, and remediation.

**Gate:** every finding plays the cited evidence; an unknown speaker or low-confidence transcript cannot produce a confirmed agent violation.

### Phase 5 — Live Coach alignment

- Make Live Coach consume the same rule versions and mastery context.
- Keep advice advisory and silence first-class.
- Track whether prescribed drills improve later simulated and real-call evidence.

**Gate:** the same observed behavior maps to the same rule ID in Trainer, Call Review, and Live Coach.

## 12. Mickey ruling ledger

These questions are deliberately written down rather than answered by the model.

### Answered rulings

| ID | Ruling |
|---|---|
| Q01 | Authority order: (1) Mickey's direct rulings, including answers in this design process; (2) the original Tax Resolution Script document; (3) model-generated rules, interpretations, and coaching. Script- or Mickey-grounded instructions are rules the system is built around. Model-generated material is advisory and must be framed as "things to consider," not as mandatory doctrine. |
| Q02 | Gauntlets are section-bounded course units organized around the original Tax Resolution Script. Each Gauntlet presents and tests only the problems belonging to that part of the call, then ends when its section objective is resolved. It must not drift into later phases; for example, a Discovery Gauntlet never progresses to a purchase. |
| Q03 | Opening fundamentals are a foundational unit: identify the agent and firm, explain the ask/reason for contact, and determine whether the prospect is a real/correct person. Teach these through varying difficulty until mastered. Later section-specific Gauntlets begin at their own section and do not repeat the opening; integrated Free Calls continue to test it naturally. |
| Q04 | All legitimate lead sources are valid training scenarios. The source is pinned and explicit, not blended into a generic outbound backstory. Prospect expectations, recognition, suspicion, and objections must reflect the particular source, and the agent must use truthful source-specific provenance. Different sources should be taught through the different problems they bring to the opening and call. |
| Q16 | Add disengagement judgment as an explicit Trainer skill, not an operational DNC mutation. After a simulated call, ask whether the prospect should be treated as DNC or given to another agent. A DNC recommendation is supported by a sustained behavior pattern: the prospect will not share or answer, refuses reciprocal conversation, remains aggressive/combative/angry, and primarily interrogates the agent or fishes for statements. Ordinary skepticism or difficult questions alone are insufficient. There is no fixed attempt count; the Coach judges the overall pattern while accounting for whether the agent made a competent good-faith effort. The agent must distinguish that pattern from a call that failed because the agent could have handled it better, and the reasoning is graded against the tape. |
| Q32 | Cover every accomplishment or event raised by the original Tax Resolution Script with reading, questions, and spoken practice. Repeated or closely related script beats may share one learning bundle when they exercise the same agent tool. The catalog is deduplicated by the tool being practiced, not merely by repeated wording or by script location. |

Questions remain below for traceability; an entry in this table supersedes its unanswered wording.

### Blocking doctrine questions

| ID | Ruling needed |
|---|---|
| Q01 | Which source wins when the Analyst Doctrine, Field Manual, objection bank, and “approved representation script” disagree? |
| Q02 | What is the one canonical call-phase taxonomy and required order? |
| Q03 | What exact identity, company, and license statements must an agent give before asking questions? |
| Q04 | For outbound calls, which provenance types actually exist—opted-in form, purchased form lead, public tax record, or several—and what exact truthful wording is approved for each? |
| Q05 | On a clear DNC/revocation, must the agent acknowledge and end immediately, or is any follow-up question ever permitted? |
| Q06 | What exact prerequisites must be satisfied before DOB, SSN, payment information, or DocuSign? |
| Q07 | Which claims are absolutely prohibited: outcomes, savings, timelines, success rates, penalty relief, collection holds, “same-day activation,” or other claims? |
| Q08 | What statements about enrolled agents, attorneys, preparers, legal review, and representation are approved? |
| Q09 | What exact discovery facts are mandatory before diagnosis/pitch, and must the agent also establish impact, urgency, decision maker, and permission to transition? |
| Q10 | Is discovery order fixed, or may the agent skip a gate when the prospect already volunteered valid evidence? |
| Q11 | When a prospect asks price early, must the agent answer, defer, give a range, explain scope first, or follow another sequence? |
| Q12 | Which fee amounts, minimums, split-payment structures, card-on-file rules, and activation claims are current for each company? |
| Q13 | Which tax facts may an agent state, and which topics must be escalated to a licensed professional? |
| Q14 | For each objection family, which tactic is mandatory and which is only an option based on demeanor? |
| Q15 | How many attempts are allowed after “not interested,” “busy,” “send information,” “need to think,” or hostility before the agent must back off? |
| Q16 | What defines a legitimate fishing/bad-actor exit, and who confirms that classification? |
| Q17 | What behaviors instantly fail a Gauntlet versus reduce score and allow recovery? |
| Q33 | What exact legal/trade name, agent title, recording disclosure, jurisdictional disclosure, and wording latitude apply to each inbound and outbound opening? |
| Q34 | Which statements may agents make about levy/garnishment, liens, substitute returns or unfiled years, business/payroll liability, and reporting mismatches, and where must they escalate to a licensed professional? |
| Q35 | When are Forms 2848, 8821, and state authorizations used; who signs, receives, and acts under each; and how may agents describe those roles? |
| Q36 | Which operational claims and service levels are currently supportable, including record retrieval, first-few-weeks work, same-day opening/activation/filing, and the one-business-day welcome contact? |
| Q37 | What evidence and wording are approved for process differentiation and competitor comparison? |
| Q38 | What is the approved secure-payment and recurring-charge workflow, including consent, card-on-file, storage, access, and missed-payment handling? |
| Q39 | What privacy and security wording is approved, what policy or legal source supports it, and which DocuSign or filing-process claims are accurate? |
| Q40 | Which canonical website and review sources may agents offer, when may they offer them, and what text/email permission and delivery workflow apply? |
| Q41 | What exact same-day callback, retry, time-zone, ownership, and no-contact rules govern a pinned soft follow-up? |

### Progress and certification questions

| ID | Ruling needed |
|---|---|
| Q18 | Do early Free Calls require only completion/reflection, or a passing score to unlock the next section? |
| Q19 | What are the quiz, Gauntlet, Free Call, and capstone pass thresholds? |
| Q20 | Must an agent pass two or more wording variants before a rule becomes “guided”? |
| Q21 | Does real-call review affect certification, or only assign remediation until a human confirms it? |
| Q22 | May agents skip ahead, or is the core course sequential with optional practice unlocked? |
| Q23 | What can a manager override, and must overrides retain a reason and audit trail? |

### Call Review and governance questions

| ID | Ruling needed |
|---|---|
| Q24 | Who may see a real-call review: trainee only, direct manager, all managers, admins, or configurable groups? |
| Q25 | What recording-consent, transcription, retention, redaction, and deletion rules apply to simulated and real calls? |
| Q26 | Are real recordings dual-channel? If not, what diarization confidence is required before evidence may affect mastery? |
| Q27 | Should agents choose calls to review, should the system sample them, or both? |
| Q28 | Can any model-only finding affect employment, compensation, discipline, or certification without human confirmation? |
| Q29 | Which rules are universal, and which are overlays for TAG, WYNN, AMITY, campaign, direction, or agent role? |
| Q30 | In post-call teaching, may the Coach give a concrete “stronger line” after the agent tries first, even though live guidance should usually teach an approach rather than a script? |
| Q31 | In a failed Gauntlet, when may the Coach reveal the principle name, then the required ingredients, then an example line? |


## 13. Script-to-learning-bundle coverage matrix

The retained authoritative extraction in `packages/shared-services/src/taxGroupScript.js` contains eight sections and 32 structured beats. Under ruling Q32, those beats map to 28 proposed bundles because four pairs exercise the same underlying agent tool.

Every bundle has three required activity classes:

1. **Read:** the exact script passage plus any approved company or primary source needed to support its claims.
2. **Answer:** retrieval, recognition, scenario, or self-explanation questions that test the tool rather than memorization alone.
3. **Speak:** a section-bounded Gauntlet that ends when the local objective is met or demonstrably failed.

The exercise designs below are things to consider unless a behavior is expressly grounded in the script or a Mickey ruling.

| Bundle | Script beat coverage | Read objective | Proposed question focus | Proposed bounded spoken Gauntlet |
|---|---|---|---|---|
| S01 Inbound welcome | `inbound_greeting` | Identity, firm, open-help elements | Recall; missing-element detection | Answer an inbound prospect, supply the required identity elements, ask how to help, and pause. |
| S02 Truthful outbound opening | `outbound_opener`, `ask_permission` | Identity, source-specific reason, non-assumptive provenance, permission | Safe/unsafe provenance; sequence; resistance | Open a pinned-source outbound call, answer "why are you calling?", and earn or respect permission without asserting unverified debt. |
| S03 Firm and role scope | `who_we_are` | Representation, fact-gathering, credential, and outcome boundaries | Scope matching; overpromise detection | Explain who the firm is and what it does without promising a resolution or overstating the speaker's role. |
| S04 Discovery inventory | `core_questions` | Amount/jurisdiction, filing, notices/enforcement, prior help | Category recall; missing-fact diagnosis | Obtain all required fact categories, make sensible follow-ups, and summarize what is known. |
| S05 Impact discovery | `pain_points` | Connect tax facts to practical impact without manipulation | Empathy/manipulation discrimination; follow-up construction | Validate one concern, ask open impact questions, and summarize the effect without fear or exaggeration. |
| S06 Discovery bridge | `bridge_to_expert` | Evidence summary, confirmation, and permission to advance | Readiness judgment; incomplete-case correction | Summarize verified facts, confirm accuracy, and bridge to education without prescribing prematurely. |
| S07 Three-factor explanation | `three_factors` | Amount owed, filing status, and agency action on record | Three-part recall; teach-back | Explain the three factors plainly and answer a skeptical follow-up without disparaging an agency. |
| S08 Situation-specific education | `name_the_situation` | One approved issue family and its know/escalate boundary | Scenario classification; misconception correction | Handle a randomly assigned levy/garnishment, lien, unfiled/substitute return, payroll liability, or reporting-mismatch variant; state supported consequences and remaining uncertainty. |
| S09 Reassure without promising | `pain_relief_bridge`, `reinforce_value` | Facts-first reassurance and representation value versus outcome | Claim-safety detection; safe paraphrase | Connect record review to the prospect's concern and answer "can you fix/settle this?" without prediction or guarantee. |
| S10 Choose authorizations | `three_authorizations` | Federal and state authorization selection | Form/scenario matching; conditional-state judgment | Select and introduce only the authorizations appropriate to the assigned case. |
| S11 Explain authorizations | `educate_forms` | Plain-language purpose and limitations of each form | Purpose/limitation matching | Answer why each authorization is needed and what it does not permit without conflating information access and representation. |
| S12 Foundation, not fix | `foundation_not_fix` | Compliance-review workflow and no-immediate-balance-change boundary | Foundation/fix discrimination; sequencing | Correct "signing lowers my balance, right?" and explain the supported next step. |
| S13 Calm urgency | `marathon_urgency` | Notice/deadline triage without invented deadlines | Urgency judgment; false-deadline spotting | Handle an active-notice scenario, obtain or escalate the notice facts, and create urgency without pressure fiction. |
| S14 Evidence-based differentiation | `differentiate`, `differentiate_no_bash` | Supported process differences and no-bashing boundary | Evidence selection; compliant rewrite | Answer "why you?" or compare another provider using verified process differences only. |
| S15 Scope and fee delivery | `fee_line` | Current fee, actual scope, inclusions, and exclusions | Inclusion/exclusion recognition; exact recall | State the assigned approved fee and scope matter-of-factly, then stop. |
| S16 Productive silence | `state_fee_pause` | Tone and pause discipline after price | Pause recognition; snippet critique | Deliver the fee and hold the approved silence before responding to the prospect's actual reaction. |
| S17 Paid-in-full anchor | `anchor_full` | Payment ladder order and accurate activation effect | Sequence; operational-claim validation | Offer paid in full first and accurately describe only its supported operational effect. |
| S18 Payment-plan construction | `two_month_split`, `four_month` | Eligibility, arithmetic, due dates, minimums, and standing | Calculation; edge-case judgment | Calculate and explain an eligible two- or four-payment plan, or correctly say it is unavailable. |
| S19 Secure payment transition | `card_on_file` | Payment-method question, explicit consent, and secure collection | Consent/security; prohibited-handling recognition | Transition to payment, answer a card-on-file question, and use only the approved dummy/tokenized collection path. |
| S20 Autonomous alternative close | `alt_choice_close` | Eligible choices without coercion or hidden status | Coercion spotting; choice construction | Present only valid options, ask which works, and calmly accept that none may work. |
| S21 Intake status boundary | `start_file` | Explicit assent and the difference between preparing a file and active representation | Timing; status-accuracy scenario | After clear assent, begin intake without implying that representation or agency action already exists. |
| S22 Ordered sensitive intake | `gather_info` | Required fields, least privilege, and safe collection timing | Field ordering; privacy-resistance scenario | Collect dummy information in approved order, defer sensitive data until its gate, and transition safely. |
| S23 Explain privacy and security | `reassure_security` | Actual controls, review/sign workflow, and non-absolute reassurance | Claim validation; security-question response | Answer "how do I know this is secure?" accurately without an absolute guarantee. |
| S24 Acknowledge "think it over" | `acknowledge_summarize` | Acknowledge, summarize value once, and avoid arguing | Response selection; concise teach-back | Acknowledge the objection, summarize the relevant value, and pause. |
| S25 Offer proof at the right time | `offer_info_now` | Timing, canonical proof sources, and channel permission | Timing recognition; consent scenario | At the correct objection point, offer approved information and obtain permission for its delivery. |
| S26 Pin or release follow-up | `soft_followup` | Precise time/channel agreement and respect for decline | Pressure-free choice; scheduling | Offer stay-on-line or later follow-up, pin a precise commitment, or respectfully release the prospect. |
| S27 Personalized next-step recap | `summarize_next` | Actual fulfillment sequence and federal/state conditionality | Process ordering; applicability | Give a case-specific recap and answer one question without inventing services or timing. |
| S28 Controlled welcome handoff | `end_welcome` | Correct contact expectation, owner, channel, and SLA | SLA recall; exception handling | Close warmly, state the supported next contact and timing, and handle a weekend/holiday exception. |

Coverage proof: the union of S01-S28 contains all 32 structured script beat IDs exactly once. The repeated tools intentionally consolidated are outbound opener plus permission, facts-first reassurance plus value reinforcement, the two differentiation beats, and the two payment-plan variants.

`name_the_situation` remains one script beat but needs distinct sourced variants; a lien cannot stand in for a levy, substitute return, payroll matter, or reporting mismatch. Section 4B tone rules are cross-cutting pass criteria across the close bundles rather than an extra mastered-once bundle.

Mickey ruling Q16 adds a non-script overlay: after appropriate simulated calls, the learner must decide whether the evidence supports a DNC recommendation or another-agent retry and defend that judgment against the tape. The Trainer records the judgment; it does not mutate operational DNC state.

## 14. Recommended first authoring slice

Do not begin with the whole 114-entry corpus. Prove the system with five high-value rule families:

1. identity + outbound provenance + permission;
2. DNC and hard-stop behavior;
3. acknowledge the underlying concern before answering;
4. diagnose before pitch;
5. scope before price and no unsupported promises.

For each family, create:

- one short lesson;
- two retrieval questions;
- two recognition/listening items;
- two “what would you say?” items;
- one micro-Gauntlet with at least four prospect variants;
- one appearance inside a Free Call;
- one real-call review mapping.

That slice proves the entire learning loop before scaling content production.

## 15. External design references

- Udemy, “How to Add Sections, Lectures, and Video Content to Your Course”: https://support.udemy.com/hc/en-us/articles/229605768-How-to-add-sections-lectures-and-video-content-to-your-course
- Udemy, “Practice Activities: Quality Standards”: https://support.udemy.com/hc/en-us/articles/229605248-Practice-activities-Quality-standards
- Udemy, “How to Use the Role Play Feature”: https://support.udemy.com/hc/en-us/articles/31522529224343-How-to-use-the-Role-Play-feature
- Udemy, “How to Use the Course Player and Start Your Course”: https://support.udemy.com/hc/en-us/articles/229603648-How-to-Use-The-Course-Player-and-Start-Your-Course
- Udemy, “Create a Quiz for Your Course”: https://support.udemy.com/hc/en-us/articles/229231627-Create-a-quiz-for-your-course
- Roediger, H. L., & Karpicke, J. D. (2006), “Test-Enhanced Learning”: https://doi.org/10.1111/j.1467-9280.2006.01693.x
- Chi, M. T. H. et al. (1989), “Self-Explanations: How Students Study and Use Examples in Learning to Solve Problems”: https://doi.org/10.1207/s15516709cog1302_1


## 16. 2026-07-28 Case Review implementation ruling

This section records Mickey's later, direct product rulings and supersedes any
earlier Call Review assumption that conflicts with it.

### Case-scoped entry and authorization

- The feature is named **Case Review**, not ?My Calls.?
- A learner explicitly enters a Logics domain and case number.
- The server calls `getActivities(caseId)` for that one case and finds the
  latest created activity matching `Assigned to Set. Officer : <name>`.
- For a non-admin, that latest assignee must match the freshly loaded,
  company-specific Logics name on the authenticated account.
- A latest `--Unassigned--`, missing or ambiguous chronology, missing
  company-specific identity, or mismatch denies access without revealing the
  current assignee.
- Only the `admin` role bypasses the assignment comparison. Domain, case, and
  exact-call membership still must resolve.
- This case-scoped path does not depend on an ActivityReport or a broad
  assignment projection.

### Calls shown and calls eligible for analysis

- List every meaningful connected call associated with the authorized case
  from EX, PhoneBurner, and CallRail.
- ?Meaningful? means actual duration of at least 300 seconds. There are no
  short-call exceptions.
- Show only safe metadata: provider, Pacific start date/time, agent, duration,
  outcome, recording status, and an opaque analysis action.
- Listing a call does not prove that its recording is safe to analyze.
- EX analysis requires an exact `telephonySessionId`-bound recording lookup.
  Broad session/day audio and phone-only fallback are prohibited.
- CallRail analysis requires the exact provider call ID. Phone-only matching is
  prohibited.
- PhoneBurner analysis requires the exact persisted recording URL produced by
  the call-end to DailyDial to CallLog chain.
- The server rechecks current ownership before analysis and before returning a
  saved review. Reassignment fails closed.

### Review behavior

- The server downloads exact audio, preserves a timestamped transcript, and
  stores a versioned review.
- A transcript may be reused only by stable recording identity and
  transcription-version match.
- The original Tax Resolution Script and direct Mickey rulings are
  authoritative. Model-created guidance is labeled **Things to consider**.
- The feature stores case-review evidence, not a personal recording library.
- The existing My Calls experience remains a default-off-feature rollback path
  and is not physically deleted.
- Implementation and synthetic verification are authorized locally. Enabling
  the feature, using live customer data, deploying, or restarting a service
  remains outside this ruling.
