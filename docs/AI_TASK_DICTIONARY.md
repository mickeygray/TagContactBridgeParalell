# AI Task Dictionary

The lookup table for the AI bus migration. Every live AI invocation in the app, labeled by **core task** and **primitive verb**, with its prompt location, tool/output **schema** (the contract), **cache** config, and model/env. The migration reads from this: to move a task to the bus, pull its row here.

Built 2026-06-17 from a 4-agent extraction over the live code. Prompts are **referenced** (file:line + constant) not copied — the source stays single. Schemas are **inline** because they become the bus contracts.

## Legend

- **Verbs** (`aiPrimitives.js`): `aiRead` · `aiWrite` · `aiJudge` · `aiScore` · `aiTranscribe` · `aiImage` · `aiSpeak` (+ aliases `aiReact`/`aiRespond`/`aiGuide`=aiWrite, `aiGrade`=aiScore)
- **Kinds** (adapter capability): `compose` (text) · `json` (structured) · `classify` (labelled json) · `transcribe` · `image` · `tts`
- **Status**: `on-bus` (runs on :7000 today) · `direct` (still a direct provider call)
- **Cache**: Anthropic `cache_control:ephemeral` on a system block, or OpenAI `prompt_cache_key` (+`prompt_cache_retention`,`service_tier`)

## The schema descriptor — `verb({ schema, prompt, model })`

Each row below **is a schema**: the durable *plumbing* descriptor. The call is `verb({ schema, prompt, model })` — plumbing / what's fed / what's used. Descriptor fields (all optional):

| Field | Meaning | Wired? |
|---|---|---|
| `output` | the JSON output shape. Present ⇒ structured result; on `aiWrite`, structured *generation* | ✅ |
| `cache` | `{ anthropic:{ephemeralSystem:true}, openai:{promptCacheKey,retention,serviceTier} }` | ✅ |
| `family` / `label` | spend attribution (coach/blog/scrubber…) | ✅ |
| `validate` | `(result,payload)⇒{ok,reason}` — enforce a shape without a named contract | ✅ |
| `next` | the next step id in a pipeline | ⏳ carried, not executed (orchestrator phase) |
| `providerRules` | per-provider knobs (thinking/effort/etc.) | ⏳ reserved, not yet wired |

Registry `ai.*` tasks supply the defaults for kind/providerOrder/models/caps; the call's `schema` overrides per call. A **named task** = a frozen named schema.

## Summary

| Core task | System | Verb | Kind | Provider | Status | Cache |
|---|---|---|---|---|---|---|
| liveCoach.callStrategy | coach | aiWrite | compose | anthropic | on-bus | anthropic-ephemeral |
| liveCoach.dialogComposer | coach | aiWrite | compose | anthropic | on-bus | anthropic-ephemeral |
| liveCoach.rollingDigest | coach | aiRead | json | openai | on-bus | openai-key |
| liveCoach.contextJudge | coach | aiJudge | json | openai | on-bus | openai-key |
| liveCoach.callGrader | coach | aiScore | json | openai | on-bus | openai-key |
| sms.classify | sms | aiJudge | classify | anthropic | direct | none |
| activity.contactSafetyReview | scrubber | aiJudge | json | anthropic | direct | none |
| resolution.pitch | resolution | aiWrite | compose+fence | anthropic | on-bus | anthropic-ephemeral |
| transcriptionScoring.transcribe | scoring | aiTranscribe | transcribe | openai | direct | none |
| transcriptionScoring.score | scoring | aiScore | json | anthropic | direct | none |
| salesTrainer.liveTurn | trainer | aiWrite | compose | anthropic | direct | anthropic-ephemeral |
| salesTrainer.roleplayer | trainer | aiWrite | compose | openai | direct | none |
| salesTrainer.audioTranscribe | trainer | aiTranscribe | transcribe | openai | direct | none |
| salesTrainer.audioSynthesis | trainer | **aiSpeak** | tts | openai | direct | none |
| salesTrainer.generateProfile | trainer | aiWrite+schema | json | anthropic | direct | none |
| salesTrainer.generatePlaybook | trainer | aiWrite+schema | json | anthropic | direct | anthropic-ephemeral |
| salesTrainer.coachNarration | trainer | aiWrite | compose | anthropic | direct | none |
| blogger.write | blogger | aiWrite+schema | json | anthropic | direct | none |
| blogger.currentEvent | blogger | aiWrite+schema | json+**web_search** | anthropic | direct | none |
| blogger.failureRecovery | blogger | aiJudge | classify | anthropic | direct | none |
| blogger.image | blogger | aiImage | image | openai | direct | none |
| misc.caseNotesSummary | ops | aiRead | classify | anthropic | direct | none |

*(`caseIntelligence.recordQualityReview` / `recordConversationAi` were returned by the extractor but are **not AI tasks** — they're data-recording sinks. Excluded.)*

## Per-task detail

### Coach (all on-bus, in `apps/ai-bus/src/server.js`)

- **liveCoach.callStrategy** — `aiWrite`/compose — Opus (`LIVE_COACH_STRATEGY_MODEL`=claude-opus-4-8), 30s.
  Prompt: `server.js:309-330` `UNIVERSAL_SALES_SCRIPT` + `CALL_STRATEGIST_INSTRUCTIONS`. Cache: `cache_control:ephemeral` on system prefix.
  Schema: in `{interview,contactName,agentName,caseId,priorStrategy}` → out `{strategy<=2400ch, model, usage}`.
- **liveCoach.dialogComposer** — `aiWrite`/compose — Sonnet ticks (`LIVE_COACH_ANTHROPIC_MODEL`), Opus asks (`LIVE_COACH_ASK_MODEL`), 15s/30s.
  Prompt: `liveCoachSanitizedPipeline.js:1581-1938` `SONNET_PROSPECT_SYSTEM_PROMPT` + `buildSonnetPromptPayload`. Cache: ephemeral, **separate per model** (Sonnet≠Opus).
  Out `{say, composer, model, heldForIncompleteThought}` (Read/Steer/Try format; `say` may be empty on WAIT).
- **liveCoach.rollingDigest** — `aiRead`/json — gpt-5.4-mini, 5s. Prompt `server.js:516-523` `MINI_ROLLING_DIGEST_STATIC_PROMPT`.
  Cache: `prompt_cache_key: live-coach-rolling-digest:{v}`, `retention:in_memory`, `service_tier:priority`.
  Out `{relevantKeys:[{key,snippet,why}], droppedKeys:[], brief:{whatHappened,continueFrom}, read, facts:[{key,value}], callSummary}`.
- **liveCoach.contextJudge** — `aiJudge`/json — gpt-5.4-mini, 6s. Prompt `server.js:270-287` `MINI_CONTEXT_JUDGE_STATIC_PROMPT`.
  Cache: `buildMiniContextJudgeCacheKey({model,metadata,scope})`, retention in_memory, tier priority, scope global.
  Out `{shouldCompose, completeThought, approvedKeys:[{key,confidence,reason,snippet}], rejected:[{key,reason}], contextBrief, thoughtVadIds:[], actionReason, confidence}`.
- **liveCoach.callGrader** — `aiScore`/json — gpt-5.4, 45s. Prompt `server.js:605-617` `CALL_GRADER_STATIC_PROMPT`.
  Cache: `prompt_cache_key: live-coach-call-grader:{v}:{model}`, retention in_memory.
  Out `grade:{overallScore, verdict, callPhaseReached, outcome, scores:{rapport,discovery,control,taxComprehension,salesPivot,compliance,close}, whatWorked[], missedOpportunities[], coachingNotes[], nextCallFocus[], riskFlags[], factsCaptured[], summaryForAgent}`.

### SMS / compliance

- **sms.classify** — `aiJudge`/classify — `SMS_CLASSIFIER_MODEL`=claude-opus-4-6. Prompt `smsClassifierService.js:346-475`. **Compliance-critical (DNC).** No cache.
  Tool `classify_sms` (all fields required): `intent`, `tier`∈[hard_stop,dnc_confirm,soft_defer,callback_prompt,needs_human], `prospect_state`∈[scared,shopping,skeptical,resigned,ready,in_progress,defer,partial_clear,investigating,closing,hostile,unclear], `suggested_reply`(<=320ch, ends " - Wynn Tax Solutions"), `callback_window`, `confidence`(0..1), `rationale`(<=180ch), `hot_intent_detected`(bool), `hot_intent_reason`(4-12 words). **Strict-ready.**
- **activity.contactSafetyReview** — `aiJudge`/json — caller model. Prompt `activityAiReviewService.js:35-56`. No cache.
  Out `{status∈[allow_contact,pause_contact,stop_contact,manual_review], confidence∈[low,medium,high], recommendedAction<=160, rationale<=1200, concerns[<=8], positiveNotes[<=8], evidence[<=8], riskFlags[<=8]}`. **Strict-ready** (already the bus proof task).

### Resolution

- **resolution.pitch** — `aiWrite`/compose+verdict-fence — Opus (`RESOLUTION_AGENT_MODEL`=claude-opus-4-8), 75s, on-bus. Prompt `resolutionPitchDoctrine.md` (loaded `server.js:415-424`). Cache: ephemeral on doctrine prefix; adaptive thinking.
  Output = prose + a ```verdict fence: `{class∈[PITCH_NOW,DEVELOP,NURTURE,PASS], headline<=160, plays[<=8], angle<=280, fee:{low,high,monthly,path}|null, clocks:[{what,by}], missingDocs[<=10], citations[<=20]}`. **Hybrid** (text + structured tail; fence parse is best-effort).

### Scoring (`transcriptionScoringService.js`)

- **transcriptionScoring.transcribe** — `aiTranscribe`/transcribe — `WHISPER_MODEL`=whisper-1, 120s. `verbose_json` + segment timestamps. No cache.
- **transcriptionScoring.score** — `aiScore`/json — `CLAUDE_SCORING_MODEL`=claude-sonnet-4-5, 30s. Prompt `SCORING_SYSTEM_PROMPT` (line 218-259). No cache.
  Out `{overall(1-10), dimensions:{contactability,legitimacy,tax_issue_present,interest_level,qualification}:{score,note}, lead_verdict∈[hot,warm,cold,dead,fake], summary, red_flags[], key_details{...}}`. **Strict-ready.**

### Sales Trainer (`taxResolutionSalesTrainerService.js` + `...Prompt.js`)

- **liveTurn** — `aiWrite`/compose — Sonnet, ephemeral system (~26k) + per-session header. Output: 1-3 sentence prospect line, may carry `<UI_*>` tagged blocks stripped before TTS.
- **roleplayer** — `aiWrite`/compose — **OpenAI** Responses fallback (`SALES_TRAINER_MODEL`=gpt-5-mini) when Anthropic down. Full v2 prompt (~27k). *(Note: this is already a manual cross-provider fallback — the bus replaces it.)*
- **audioTranscribe** — `aiTranscribe`/transcribe — `SALES_TRAINER_STT_MODEL`=gpt-4o-mini-transcribe; domain primer, diarize variants.
- **audioSynthesis** — **`aiSpeak`/tts** — `SALES_TRAINER_TTS_MODEL`=gpt-4o-mini-tts, voice `cedar`, speed 1.35, persona→instructions. *(No primitive for this yet — see Gaps.)*
- **generateProfile** — `aiWrite+schema`/json — Sonnet, tool `submit_caller_profile` (demographics + narrative; server overwrites locked fields). temp 0.95.
- **generatePlaybook** — `aiWrite+schema`/json — Sonnet, tool `submit_caller_playbook` (objectionQueue[3-16], hiddenFacts[1-5], tellLines, trustArc, phaseGuidance). Cached ephemeral per session.
- **coachNarration** — `aiWrite`/compose — Opus, `COACHING_NARRATOR_SYSTEM_PROMPT`. In: compact scorecard JSON → out: 3-5 sentence spoken debrief.

### Blogger (`scripts/blogger-*.js`) + ops

- **blogger.write** — `aiWrite+schema`/json — `SONNET_MODEL`=claude-sonnet-4-5-20250929. Tool `submit_blog_draft{teaser(200-280ch), contentTitle, bodyHtml}`.
- **blogger.currentEvent** — `aiWrite+schema`/json **+ web_search** — Sonnet, ≤8-turn search loop w/ domain allowlist. Tool `submit_current_event_blog{id,title,teaser,contentTitle,bodyHtml,slide{...},sourcesUsed[]}`. *(Agentic — see Gaps.)*
- **blogger.failureRecovery** — `aiJudge`/classify — Sonnet. Tool `propose_recovery_plan{classification∈[rollback-aftermath,dirty-state,build-failure,deploy-failure,unknown], confidence∈[high,medium,low], actions:[{type:git-restore, repo∈[wynn,tag], paths[], reason}], autoExecutable, manualSteps}`. **Strict-ready.**
- **blogger.image** — `aiImage`/image — `OPENAI_IMAGE_MODEL`=gpt-image-1, quality low, 1024x1024; SVG fallback.
- **misc.caseNotesSummary** — `aiRead`/classify — `CASE_NOTES_MODEL`=claude-3-5-haiku-latest, temp 0. Tool `summarize_case{workProduct, servicesPitched, lastThingPitched, clientTemperature∈[hot,warm,cold,unknown], temperamentSignals}`. **Strict-ready.**

## Cache map (must survive migration or warm-prefix savings are lost)

- **Anthropic `cache_control:ephemeral`**: callStrategy, dialogComposer (separate per model), resolution.pitch, salesTrainer.liveTurn (system + session header), salesTrainer.generatePlaybook.
- **OpenAI `prompt_cache_key` + `in_memory` + `service_tier:priority`**: rollingDigest, contextJudge, callGrader.
- **No cache**: everything else.

⚠️ **Adapter gap:** the Anthropic adapter currently sends `system` as a plain string — it cannot emit a cacheable system block. To preserve Anthropic caching on migration it must accept a `cacheableSystem` (array w/ `cache_control`). The OpenAI adapter already passes `promptCacheKey`.

## Strict-schema punch list (for OpenAI native structured output parity)

- **Strict-ready** (all-required + enums, no loose keywords): sms.classify, activity.contactSafetyReview, transcriptionScoring.score, blogger.failureRecovery, caseNotesSummary, generateProfile/Playbook (have min/max items).
- **Needs massaging** (optional/variable-length arrays, char caps, optional-presence fields): liveCoach.contextJudge, liveCoach.callGrader, liveCoach.rollingDigest. For OpenAI strict mode: make every field required-or-nullable, set `additionalProperties:false`, move char caps from schema into prompt guidance.

## Gaps the dictionary surfaced (decisions before migration)

1. **No `aiSpeak`/tts primitive.** `salesTrainer.audioSynthesis` is a real `tts` task with no primitive verb or `ai.tts` registry entry. Add `aiSpeak` + `ai.tts` (OpenAI-only, like the other modalities).
2. **Generative-structured shape isn't covered.** generateProfile/Playbook, blogger.write/currentEvent are "produce a *structured object* from instructions" (tool-use) — neither plain `aiWrite` (compose/text) nor `aiRead` (comprehend input). Cleanest fix: let **`aiWrite` accept an optional `schema`** → when present, route to the `json` kind (structured generation). One verb, two modes.
3. **Agentic tool-loops exist.** `blogger.currentEvent` runs a multi-turn `web_search` loop; trainer profile/playbook use tool-use generation. Simple structured output covers the latter; the *search loop* is the `tool-loop` kind flagged earlier and is **out of scope** for the first migration — leave `blogger.currentEvent` direct until we add an agentic kind.
4. **`resolution.pitch` is a hybrid** (prose + verdict fence). Migrate as `compose` and keep the fence-parse on the caller side; don't force it into `json`.

## How a migration row reads

To migrate `activity.contactSafetyReview`: it's `aiJudge`/json, strict-ready, no cache, Anthropic-default → register the schema above as the bus contract, point the service at `runAiTask("activity.contactSafetyReview", {domain,caseId,activities})`, smoke on both providers. Done.
