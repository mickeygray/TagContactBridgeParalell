# AI Bus + Codex Agent Walkthrough (2026-06-26)

Purpose: put the Linux Codex agent behind the 7000 AI bus discipline without letting it become another random side door. The bus remains the place that owns task identity, contracts, provider choice, telemetry, failover, and spend controls. Codex is an execution substrate for background/after-hours work first, then a possible provider adapter later.

## Current Proven State

The live Linux box now has Codex installed and smoke-tested under an isolated account home:

```text
codex cli: codex-cli 0.142.2
linux user: parallel
CODEX_HOME: /opt/tagcontactbridge-parallel/runtime/codex-agent-home
auth mode: ChatGPT auth file in the isolated CODEX_HOME
api-key discipline: OPENAI_API_KEY and OPENAI_BASE_URL are stripped from child env
```

Important: do not print, copy into logs, or commit the auth file. The path is a credential boundary even though the file contents are not documented here.

Proven smoke commands:

```bash
sudo -u parallel -H env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  CODEX_HOME=/opt/tagcontactbridge-parallel/runtime/codex-agent-home \
  codex exec --ephemeral --ignore-rules --skip-git-repo-check \
  -C /tmp/codex-agent-isolation-smoke-final --sandbox read-only \
  "Reply with exactly: CODEX_LINUX_READY" </dev/null
```

The MCP wrapper exists locally at:

```text
scripts/codex-agent/codexMcpClient.js
scripts/codex-agent/smoke-codex.js
```

It starts one warm `codex mcp-server`, strips API-key env vars, and exposes:

```js
client.start()
client.listTools()
client.ask(prompt, overrides)
client.reply(threadId, prompt, overrides)
client.stop()
```

Before using the wrapper on Linux, sync `scripts/codex-agent/*` to the live repo. Then smoke it:

```bash
cd /opt/tagcontactbridge-parallel
sudo -u parallel -H env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  CODEX_HOME=/opt/tagcontactbridge-parallel/runtime/codex-agent-home \
  node scripts/codex-agent/smoke-codex.js --probe
```

Then one real call:

```bash
sudo -u parallel -H env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  CODEX_HOME=/opt/tagcontactbridge-parallel/runtime/codex-agent-home \
  node scripts/codex-agent/smoke-codex.js --ask "Reply with exactly READY."
```

Linux currently warns that the sandbox wants broader AppArmor/user-namespace access. Do not loosen host-wide AppArmor settings just to make the warning disappear. Read-only smoke/tool execution works; revisit this only if a real worker needs stronger sandbox behavior.

## How To Read The Existing Bus

Read the bus in this order. This is the path every migrated task should follow.

1. App-side caller:

```text
packages/shared-services/src/aiTaskClient.js
```

This is the 5001 caller. It sends:

```js
POST http://127.0.0.1:7000/api/ai/tasks/:taskId/run
headers: { "x-service-secret": INTERNAL_SERVICE_SECRET }
body: { payload, options }
```

It returns the shared envelope and timing:

```js
{
  ok,
  taskId,
  result,
  safeFallback,
  timing: { roundTripMs, busMs, transportMs }
}
```

2. Bus route:

```text
apps/ai-bus/src/aiTaskRoutes.js
```

This sanitizes caller options, strips privileged flags, propagates request aborts, calls `runner.runAiTask(...)`, and stamps `busMs`.

3. Bus wiring:

```text
apps/ai-bus/src/server.js
```

This creates provider clients, creates the registry, creates the runner, and mounts `/api/ai/tasks`. The internal route must stay behind `x-service-secret`.

4. Task execution:

```text
packages/shared-services/src/aiTaskRunner.js
```

This is the spine. It resolves task config, provider order, model ladder, `preferProvider`, `forceProvider`, failover, validation, fail-closed behavior, and telemetry.

5. Provider-specific code:

```text
packages/shared-services/src/aiProviders.js
```

This is the only place provider adapters belong. Today it registers:

```js
anthropic
openai
```

No route, feature, or caller should shell to Codex directly once this is formalized. Codex should enter either as a worker controlled by 7000, or later as `providers.agent`.

6. Registry and task catalog:

```text
packages/shared-services/src/aiTaskRegistry.js
packages/shared-services/src/aiBusRegistry.js
packages/shared-services/src/aiSandbox/tasks.js
docs/AI_TASK_DICTIONARY.md
```

Current hazard: task ownership is still split. Do not rely on a "right-looking" task id until the registry/catalog merge is complete. The bus-facing task id, output schema, fallback, env flag, and prompt source all need to resolve from one canonical catalog before provider rollover is considered production-safe.

## Where Codex Fits First

Do not start by making Codex a general provider. Start with a batch worker behind the bus.

Recommended Phase A:

```text
5001/app or scheduler
  -> queue/trigger a named AI task intent
7000 AI bus worker
  -> builds a strict task packet
  -> invokes Codex via warm MCP or codex exec
  -> validates JSON/text contract
  -> stores result + telemetry
existing app/drain worker
  -> applies side effects exactly once
```

This keeps Codex out of the live hot path and avoids multi-provider contract lies while we are still cleaning the registry.

Good first tasks:

```text
liveCoach.callGrader          nightly / after-call batch, not inline
blogger.write                 draft only, publish still gated
misc.caseNotesSummary         call notes / communication summary
documentAnalyzer              background read/summarize/classify
resolution research drafts    internal support, not direct mutation
```

Bad first tasks:

```text
liveCoach.contextJudge        hot path
liveCoach.dialogComposer      hot path
sms.classify/send             customer-facing, fail-closed to human first
transcribe/tts                modality tasks; Codex is not the provider
blogger.image                optional Codex imagegen path; harvest `generated_images/**/ig_*.png`
```

## Phase A Implementation Walkthrough

### 1. Add A Pure Codex Runner

Create a small shared runner that does exactly one thing: take a task packet, call Codex, return a validated candidate result.

Suggested file:

```text
packages/shared-services/src/codexAgentTaskRunner.js
```

Shape:

```js
async function runCodexAgentTask({
  taskId,
  prompt,
  schema,
  outputMode,        // "json" | "text"
  baseInstructions,
  cwd,
  timeoutMs,
  idempotencyKey,
  metadata,
}) {
  // 1. invoke warm client
  // 2. parse text/json
  // 3. validate schema
  // 4. return { ok, provider:"agent", model, result, rawText, threadId, timing, error }
}
```

Rules:

- No business side effects.
- No Logics writes.
- No texts/emails/publishing.
- No Mongo mutation except the task-run/outbox row.
- Always strip API-key env vars from the child process.
- Always include `taskId`, `idempotencyKey`, `threadId`, `elapsedMs`, `status`, and `errorCode`.

### 2. Add A Task Run Store

Add a durable record before any real background use.

Suggested model/repository names:

```text
packages/shared-models/src/AiAgentTaskRun.js
packages/shared-repositories/src/aiAgentTaskRunRepository.js
```

Minimum fields:

```js
{
  taskId,
  idempotencyKey,
  status: "queued" | "running" | "succeeded" | "failed" | "applied",
  substrate: "codex",
  provider: "agent",
  model,
  inputDigest,
  inputRef,
  output,
  outputDigest,
  errorCode,
  errorMessage,
  attempts,
  codexThreadId,
  createdAt,
  startedAt,
  finishedAt,
  appliedAt,
}
```

Create a unique index on:

```text
taskId + idempotencyKey
```

That makes retries safe. If the same nightly grader task is started twice, the second run should find the existing row instead of grading twice.

### 3. Add A Worker In 7000

Suggested file:

```text
apps/ai-bus/src/codexAgentWorker.js
```

Responsibilities:

- Pull queued `AiAgentTaskRun` rows.
- Resolve the named task contract from the bus/catalog.
- Build the prompt packet.
- Call `runCodexAgentTask`.
- Validate the result.
- Mark the task run complete/failed.
- Emit one compact log line:

```js
{
  event: "ai_agent_task.run",
  taskId,
  idempotencyKey,
  status,
  elapsedMs,
  provider: "agent",
  model,
  errorCode
}
```

Do not let the worker apply final business side effects. The worker produces an output. Existing drain/apply services should consume validated outputs and do the actual app mutation.

### 4. Add A Manual/Scheduled Trigger

For the first version, prefer a script over a public route.

Suggested script:

```text
scripts/codex-agent/run-agent-task.js
```

Example uses:

```bash
node scripts/codex-agent/run-agent-task.js \
  --task liveCoach.callGrader \
  --input runtime/fixtures/call-grade-input.json \
  --dry-run
```

Then:

```bash
node scripts/codex-agent/run-agent-task.js \
  --task liveCoach.callGrader \
  --input runtime/fixtures/call-grade-input.json \
  --write-task-run
```

Only after this works should cron/worker scheduling call it automatically.

### 5. Use Existing Apply Points

Codex output should feed the same apply/drain surfaces already being built:

```text
packages/shared-services/src/cxTerminalOutboxDrain.js
packages/shared-services/src/cxAgentCallNoteService.js
packages/shared-services/src/liveCoachCloseoutService.js
packages/shared-services/src/liveCoachBatchGuidanceDispatchService.js
```

Target flow for call artifacts:

```text
call ends
  -> terminal/drain creates durable call note packet
  -> coach summary/interview payload attaches to packet
  -> Codex/API grader can read packet later
  -> validated result writes grade email draft, communication summary, and Logics activity through normal committers
```

The model writes drafts/structured facts. The app owns the final mutation.

## After-Hours Work To Defer To Codex

The clean rule:

```text
if a prospect, agent, or compliance decision is waiting right now -> keep it deterministic/API
if it produces a draft, grade, synthesis, research packet, or audit note -> Codex after-hours candidate
```

Codex should not be used as a hidden inline dependency for live buttons. It should consume durable work packets and return validated outputs that the existing app/drain applies later.

### Candidate Ranking

| Priority | Task | Why Codex fits | Why not inline |
| --- | --- | --- | --- |
| P0 | Nightly call grading | Internal QA, high reasoning, latency-tolerant, already has `CxAgentCallNote` candidates | Grading can take 30-120s and must not block call flow |
| P0 | Call note / communication synthesis | Turns transcript/interview/coach artifacts into durable case communication | A summary can arrive minutes later without hurting the call |
| P1 | Blogger draft + current event draft | Slow, agentic, source-heavy, draft-only | Publish still needs deterministic/human gate |
| P1 | Case/document synthesis | Reads extracted facts and case history to produce a resolution packet | Resolution click path should not wait on a subscription agent |
| P1 | Resolution precompute | Useful overnight prep for cases likely to be worked tomorrow | Interactive `/resolution` pitch should keep API fallback |
| P2 | SMS/contact-safety audit review | Good for reviewing questionable backlog and improving rules | Inline SMS/contactability is compliance-sensitive and should fail closed quickly |
| P2 | Metrics/explanation narratives | Internal, slow, useful for daily email/context | Counts themselves must stay deterministic |

### Not Good Codex Candidates

```text
liveCoach.contextJudge       hot path
liveCoach.dialogComposer     hot path
sms.classify                 inline customer/compliance decision
activity.contactSafetyReview inline contactability gate
transcribe/tts               modality providers, not Codex work
blogger.image               optional Codex imagegen worker path; API image remains fallback
queue/call state             deterministic CX plumbing
```

Codex may help audit or summarize those systems after the fact, but should not be the thing keeping a live workflow moving.

## Live-Ish Exception: Rolling Transcript Summary

Transcript cleanup is not a clean EOD-only task. It sits between the hot coach path and after-hours synthesis. The simplest useful version should not try to perfectly correct every word. It should read the messy transcript with tax-call context, assume odd phrases may be tax-related, and maintain a rolling semantic summary the coach can pick up as it arrives:

```text
STT final
  -> hot path: deterministic clean -> semantic/coach path immediately
  -> sidecar path: async rolling semantic summary
  -> coach deep-pull memory reads latest rolling summary when available
  -> later consumers: transcript display, call summary, grader, searchable artifacts
```

The existing code already points this way:

```text
packages/shared-services/src/liveCoachTranscriptTranslator.js
packages/shared-services/src/coachTranscript.js
tests/livecoach-translator/*
docs/AI_LIVE_COACH_TRANSCRIPT_SEMANTIC_AUDIT_2026-06-23.md
```

Current translator rules worth preserving:

- regex/domain normalization first;
- model cleanup optional, not primary;
- fail open to deterministic text;
- no throws;
- no second compose trigger;
- no write-back into `transcript.text`;
- if correction exists, it is annotation/debug only, not the canonical STT row.

### Can Codex Do This?

Yes, if the goal is rolling understanding rather than transcript repair. Codex should not be inserted between STT and coach response. Instead, use it as a rolling call-memory worker: every minute or two, send final transcript rows since the last cursor and ask for an updated semantic summary.

Codex-first rolling experiment:

```text
every 60-120 seconds
  -> collect final transcript rows since the last summary cursor
  -> group by active call
  -> warm Codex MCP call
  -> validated rolling call summaries
  -> emit/store call.rollingSummary by sessionId/uii
  -> optionally store suspected mishearings for audit, not live behavior
```

Batch request shape:

```js
{
  schemaVersion: "live-coach.rolling-summary-batch.v1",
  taskId: "liveCoach.rollingSemanticSummary",
  generatedAt,
  cadenceMs: 120000,
  batchId,
  maxCalls: 7,
  calls: [
    {
      sessionId,
      uii,
      callSessionId,
      queueItemId,
      agentExtensionId,
      agentEmail,
      summaryCursor,
      previousRollingSummary: {
        summary: [
          {
            sequence,
            at,
            kind,
            text,
            sourceTranscriptIds
          }
        ],
        factsCaptured,
        openQuestions,
        objections,
        taxIssues
      },
      rows: [
        {
          transcriptId,
          role,
          redactedRawText,
          deterministicText,
          priorLine,
          at
        }
      ]
    }
  ]
}
```

Output shape:

```js
{
  schemaVersion: "live-coach.rolling-summary-result.v1",
  batchId,
  generatedAt,
  summaries: [
    {
      sessionId,
      uii,
      callSessionId,
      queueItemId,
      agentEmail,
      agentExtensionId,
      summary: [
        {
          sequence,
          at,
          kind: "fact" | "objection" | "tax_issue" | "open_question" | "next_step" | "call_progress" | "uncertainty",
          text,
          sourceTranscriptIds
        }
      ],
      summaryText, // optional derived projection; app may rebuild this from summary[]
      factsCaptured,
      openQuestions,
      objections,
      taxIssues,
      nextBestFocus,
      confidence,
      sourceTranscriptIds,
      suspectedMishearings: [
        {
          transcriptId,
          heard,
          likelyMeant,
          reason
        }
      ]
    }
  ]
}
```

Prompt contract for Codex:

```text
Return JSON only.
Return one summaries[] row per call you can safely identify.
Every summaries[] row must include sessionId, uii, agentExtensionId, and agentEmail.
Include callSessionId and queueItemId when they were provided in the input.
Never return an unkeyed summary.
Treat previousRollingSummary.summary as append-only memory.
Do not rewrite or renumber existing summary[] entries.
Append only new summary[] entries for new transcript evidence.
Use sourceTranscriptIds on every new summary[] entry.
If there is no new useful information for a call, return the keyed row with summary unchanged and no new sourceTranscriptIds.
If identity is ambiguous, omit the row rather than guessing.
```

### Floor Batch Identity Rules

This has the same identity problem as the batch coach: one model call may process up to seven live conversations. The architecture must assume the model can return stale, swapped, missing, or ambiguous rows and reject them before any session memory changes.

Follow the same mold as:

```text
packages/shared-services/src/liveCoachBatchProjectionService.js
packages/shared-services/src/liveCoachBatchGuidanceDispatchService.js
docs/AI_LIVE_COACH_ACTIVE_BATCH_OBJECT_2026-06-26.md
```

Input isolation rules:

```text
one batch -> calls[]
one call row -> sessionId + uii + agentExtensionId + agentEmail
one transcript row -> transcriptId scoped to sessionId/uii
```

Output resolution rules:

```text
summary row has sessionId
  -> find active conversation by sessionId
  -> require current uii match when both sides have uii
  -> require agentExtensionId/agentEmail match when present
  -> apply to that session only

summary row lacks sessionId
  -> reject, even if uii looks unique

summary row uii mismatches current call
  -> do not update live memory
  -> store only as late closeout artifact if the old call can be resolved

multiple active rows match
  -> reject as ambiguous
```

Suggested helper names:

```js
buildRollingSummaryBatchFromActiveConversations(activeBatch)
normalizeRollingSummaryItem(row)
resolveRollingSummaryTarget(item, activeBatch)
buildRollingSummaryApplyPlan(activeBatch, modelResponse)
```

The apply plan should look like the guidance dispatch plan:

```js
{
  schemaVersion: "live-coach.rolling-summary-apply-plan.v1",
  batchId,
  activeConversationCount,
  receivedSummaryCount,
  applyCount,
  rejectedCount,
  applies: [
    {
      status: "ready",
      target: {
        sessionId,
        uii,
        callSessionId,
        queueItemId,
        agentEmail,
        agentExtensionId
      },
      payload: {
        schemaVersion: "live-coach.rolling-summary.v1",
        sessionId,
        uii,
        callSessionId,
        queueItemId,
        agentEmail,
        agentExtensionId,
        summary,
        summaryText,
        factsCaptured,
        openQuestions,
        objections,
        taxIssues,
        nextBestFocus,
        sourceTranscriptIds,
        generatedAt
      }
    }
  ],
  rejected: [
    { reason: "session-not-active" },
    { reason: "uii-mismatch" },
    { reason: "agent-mismatch" },
    { reason: "missing-session" },
    { reason: "ambiguous-target" }
  ]
}
```

This keeps the seven-call batch cheap while making the writeback boring and safe.

Apply rule:

```text
if summary arrives while call is active
  -> update call.rollingSummary for coach deep-pull memory
  -> optionally emit summary-updated event
if summary arrives after call ended
  -> store for closeout summary / grader
if summary never arrives
  -> leave existing transcript/summary as-is
```

The rolling summary may improve:

```text
rolling coach memory
communication summary
call grader
later search
next deep-pull memory, if still relevant
```

The rolling summary must not:

```text
trigger a new VAD final
trigger a second context judge
trigger a second writer response
replace raw STT text
pretend suspected mishearings are canonical corrections
block guidance
delay current-call UI
```

### Rolling Cursor Rules

Each call needs a small summary cursor so repeated batches do not re-send the same transcript forever:

```js
{
  sessionId,
  uii,
  lastSummaryTranscriptId,
  lastSummaryAt,
  pendingSummaryBatchId,
  summarizedCount,
  failedSummaryCount,
  rollingSummaryVersion,
  rollingSummaryUpdatedAt
}
```

The batch builder should select:

```text
final transcript rows
  where transcriptId > lastSummaryTranscriptId
  and role in ["agent", "prospect"]
  and text length is useful
```

Do not enqueue provisional fragments. They are too noisy and too likely to be superseded. The summary lane should consume final rows only.

### Rolling Summary Rules

The rolling summary is not a coach response. It is memory. It should be compact, factual, and cumulative:

```text
what the prospect said
what the agent learned
tax facts captured
objections raised
open questions
next best focus
suspected tax-term interpretation when wording is funny
```

The returned memory must be object-shaped and identity-keyed:

```text
one row per call
match keys: sessionId + uii + agentExtensionId + agentEmail
summary is an array, not one mutable paragraph
each summary[] entry has sequence, kind, text, at, and sourceTranscriptIds
new batches append entries instead of rewriting old entries
flat summaryText is only a display/readability projection from summary[]
```

It should not:

```text
write advice directly to the agent panel
replace the guide state reducer
cross off checklist items by itself
invent facts to make the summary smoother
normalize away uncertainty
merge multiple agents or calls into one summary row
return summary text without identity keys
```

The coach can read it as input on a later deep pull:

```text
live coach deep pull
  -> active conversation object
  -> latest transcript rows
  -> latest call.rollingSummary if present
  -> guide/objection/tax knowledge selection
```

That means Codex improves the next model call's memory, but it does not become the live coach decision-maker.

### Reuse For Grading And Communications

The rolling summary should be saved in a shape that both downstream paths can consume:

```text
grader:
  CxAgentCallNote.transcriptSummary / facts / coachSuggestions / metrics

communications:
  cxCallWrapService input summary / interviewNote / facts / nextStep
```

Do not make separate "grader summary" and "communication summary" models at first. Produce one factual call-memory object, then let the apply services format it for their destinations:

```js
toAgentCallNotePatch(rollingSummary)
toCxCallWrapPacket(rollingSummary)
toCloseoutMemoryPatch(rollingSummary)
```

That keeps the seven-call Codex pass universal. The formatting differences belong in deterministic mappers, not in more model calls.

### Background Timeout Policy

This should not have a user-facing timeout. A slow Codex batch should not flash errors or block the coach. The worker still needs an operational lease so it cannot live forever:

```text
target cadence: 60-120s
worker lease: 5-10 minutes
on lease expiry: mark batch stale and retry only unsummarized rows
```

That means "Codex took too long" is not a call-flow event. It is only a background health metric.

### Privacy / Redaction Rule

Before any transcript row goes to Codex, run the deterministic redaction pass:

```text
SSN / card-like long numbers / bank account-looking numbers -> redacted token
```

The app keeps the local association:

```text
sessionId + uii + transcriptId
```

Codex receives enough text to understand call meaning, not raw sensitive numbers. Any suspected-mishearings output should preserve redaction tokens and never re-invent digits.

### Why API May Still Be Better

If the goal changes back to "repair this exact turn before the next coach decision," the latency budget is tight. Codex via CLI/MCP has no service-level latency promise and is better treated as opportunistic. A cheap API model may be more appropriate for per-line or per-turn repair because the current translator is already designed around a sub-second timeout.

Recommended substrate policy:

```text
rolling summary:
  1. deterministic aliases / normalizeTaxTerms
  2. Codex batch sidecar every 60-120s for semantic summary
  3. optional suspected-mishearings list for audit/debug
  4. API only if a same-turn correction must affect an immediate decision

after-call repair:
  1. Codex can summarize chunks before grader
  2. grader consumes rolling summaries when available
  3. missing summary never blocks grade; it only lowers evidence quality
```

### Minimal Codex Rolling Summary Test

Do not start with all calls. Start with a shadow batch that cannot affect guidance.

Files to add or touch:

```text
packages/shared-services/src/liveCoachRollingSummaryService.js
packages/shared-services/src/liveCoachTranscriptTranslator.js
scripts/codex-agent/run-rolling-summary-shadow.js
tests/livecoach-translator/*
```

Atomic functions:

```js
buildRollingSummaryBatch(activeSessions)
invokeRollingSummaryBatch(batch, codexRunner)
validateRollingSummaryResult(result)
applyRollingCallSummaries(result, sessionStore)
dropExpiredRollingSummaryBatches(now)
```

Flags:

```text
LIVE_COACH_ROLLING_SUMMARY_ENABLED=false
LIVE_COACH_ROLLING_SUMMARY_SUBSTRATE=codex|api|off
LIVE_COACH_ROLLING_SUMMARY_SHADOW_ONLY=true
LIVE_COACH_ROLLING_SUMMARY_BATCH_MS=120000
LIVE_COACH_ROLLING_SUMMARY_LEASE_MS=600000
```

Shadow acceptance:

- no change to `vadToFirstDeltaMs`;
- no extra `context` or `dialog` events;
- `call.rollingSummary` updates are keyed by `sessionId/uii`;
- coach deep-pull can read the summary without requiring it;
- suspected-mishearings are clearly marked uncertain;
- batches do not resend already-summarized rows;
- late results attach to closeout/grader instead of live UI;
- failures are dropped silently and counted;
- raw transcript retention policy is honored.

If Codex misses the rolling cadence, keep the output for closeout/grader and leave live display alone. That is not a failure; it means the summary arrived too late to be useful on-screen, but can still improve the durable call record.

## P0 Plan: Nightly Call Grader

Current source of truth:

```text
packages/shared-services/src/cxAgentCallNoteService.js
packages/shared-repositories/src/cxAgentCallNoteRepository.js
packages/shared-services/src/cxCallWrapService.js
packages/shared-services/src/liveCoachCloseoutService.js
apps/ai-bus/src/server.js createOpenAiCallGrader
packages/shared-services/src/aiSandbox/tasks.js liveCoach.callGrader
```

The important part already exists: `CxAgentCallNote` is the durable nightly input. The repository already exposes:

```js
listNightlyGradeCandidates({ from, to, agentEmail, minDurationSec, limit })
markGradeStatus(noteKey, status, patch)
```

Target flow:

```text
cx terminal drain / coach closeout
  -> upsert CxAgentCallNote
  -> gradeCandidate=true when evidence is enough
nightly Codex worker
  -> listNightlyGradeCandidates()
  -> build one task packet per call note
  -> invoke liveCoach.callGrader contract
  -> validate CALL_GRADER_SCHEMA
  -> mark gradeStatus=graded or failed
  -> optional manager email bundle reads graded notes
```

The Codex prompt should receive only the grade packet:

```js
{
  taskId: "liveCoach.callGrader",
  noteKey,
  domain,
  caseId,
  agentEmail,
  happenedAt,
  durationSec,
  terminalOutcome,
  summary,
  transcriptSummary,
  facts,
  coachSuggestions,
  metrics,
  transcriptArtifactPath // optional ref, not auto-read unless worker allows it
}
```

Output:

```js
{
  overallScore,
  verdict,
  callPhaseReached,
  outcome,
  scores,
  whatWorked,
  missedOpportunities,
  coachingNotes,
  nextCallFocus,
  riskFlags,
  factsCaptured,
  summaryForAgent
}
```

Implementation files:

```text
packages/shared-services/src/codexAgentTaskRunner.js
packages/shared-services/src/cxNightlyCallGradeService.js
apps/ai-bus/src/codexAgentWorker.js
scripts/codex-agent/run-nightly-call-grades.js
```

Atomic functions:

```js
buildCallGradeTaskPacket(note)
runCallGradeTask(packet, runner)
validateCallGradeResult(result)
applyCallGradeResult(noteKey, result, repository)
markCallGradeFailure(noteKey, error, repository)
```

Current implementation anchor:

```text
packages/shared-services/src/cxNightlyCallGradeService.js
packages/shared-services/src/cxNightlyCallGradeService.test.js
packages/shared-services/src/index.js
```

Implemented now:

- `buildCallGradeTaskPacket(note)` turns a drained `CxAgentCallNote` into a stable `liveCoach.callGrader` packet.
- `buildCallGradePrompt(packet)` creates the JSON-only Codex prompt around that packet.
- `normalizeCallGradeResult(result)` validates and clamps the model return.
- `applyCallGradeResult(noteKey, result, repository)` writes only through `markGradeStatus`.
- `markCallGradeFailure(noteKey, error, repository)` records the failed grade path without partial side effects.
- `buildNightlyCallGradeReport(notes)` gives the dry-run visibility report before any worker is allowed to write.

Still deferred:

- The scheduled Linux/Codex worker that calls Codex.
- Durable `AiAgentTaskRun` storage for cross-process retries.
- Manager email bundle generation from graded notes.

Safety:

- No email/send side effect inside Codex.
- No Logics write inside Codex.
- `noteKey` is the idempotency key.
- Failed grades remain `gradeStatus:"failed"` and can be retried.
- If output fails schema, store failure and do not partially apply.

First test:

```text
one synthetic CxAgentCallNote fixture
  -> build packet
  -> fake Codex result
  -> schema validate
  -> markGradeStatus("graded")
```

Second test:

```text
real local candidate list dry-run
  -> write no grade
  -> output JSON report of candidates and packet sizes
```

Third test:

```text
one live after-hours real run
  -> one note only
  -> no email
  -> mark grade
  -> inspect grade quality
```

## P0 Plan: Call Note And Communication Synthesis

Current source of truth:

```text
packages/shared-services/src/cxAgentCallNoteService.js
packages/shared-services/src/cxCallWrapService.js
packages/shared-services/src/cxTerminalOutboxDrain.js
packages/shared-repositories/src/cxAgentCallNoteRepository.js
```

Goal: when a call has useful coach/transcript/interview evidence, create one durable summary object that can be written into:

```text
CaseProfile.communications
Logics activity
CxAgentCallNote.summary / transcriptSummary / facts
nightly grader input
```

The after-hours Codex task should not replace the real-time drain. It should enrich sparse notes after the fact.

Target flow:

```text
terminal outbox / closeout
  -> writes sparse CxAgentCallNote immediately
  -> writes any available summary/interview snapshot
after-hours synthesis worker
  -> finds notes with summary missing or thin
  -> reads allowed transcript/coach artifacts
  -> returns compact communication packet
existing cxCallWrapService
  -> writes app communication + Logics activity once
```

Task packet:

```js
{
  taskId: "cx.callCommunicationSummary",
  noteKey,
  domain,
  caseId,
  prospectName,
  agentName,
  terminalOutcome,
  durationSec,
  transcriptSummary,
  interviewSnapshot,
  facts,
  coachSuggestions,
  existingCommunicationThreadKey
}
```

Output:

```js
{
  subject,
  summary,
  interviewNote,
  nextStep,
  facts,
  riskFlags,
  logicsActivityBody,
  communicationBody
}
```

Implementation files:

```text
packages/shared-services/src/cxCallWrapService.js
packages/shared-services/src/cxAgentCallNoteService.js
packages/shared-services/src/cxCallCommunicationSynthesisService.js
scripts/codex-agent/run-call-note-synthesis.js
```

Atomic functions:

```js
listSynthesisCandidates({ from, to, limit })
buildCallCommunicationTaskPacket(note)
validateCallCommunicationResult(result)
applyCallCommunicationSummary(note, result, deps)
```

Safety:

- `threadKey` prevents duplicate communications.
- Existing `writeCxCallWrapSummary` remains the only app/Logics committer.
- The agent returns text; it does not call Logics.
- Missing `domain` or `caseId` means skip, not invent.

## P1 Plan: Blogger Drafts

Current source of truth:

```text
scripts/blogger-claude-writer.js
scripts/blogger-current-event.js
scripts/bloggerContentUtils.js
tests/blogger/blogger-current-event-bus.test.js
packages/shared-services/src/aiSandbox/tasks.js blogger.write / blogger.currentEvent / blogger.failureRecovery / blogger.image
```

Codex is a strong fit for draft production and source review, but publishing remains gated.

Target flow:

```text
daily blogger scheduler
  -> creates BloggerDraftRun row
  -> Codex writes draft JSON
  -> deterministic validator checks structure, citations, source domains, no forbidden claims
  -> optional API verifier grades factuality
  -> human/publish gate or existing publisher applies
```

Split:

```text
Codex:
  - normal blog draft
  - current-event topic research and draft
  - recovery plan after failed publish

API/OpenAI:
  - optional small verifier
  - optional image fallback when Codex imagegen is unavailable or batch volume is too high

Deterministic:
  - source allowlist
  - block splitting
  - title/category/slug validation
  - copy selected Codex image artifact from `CODEX_HOME/generated_images/**/ig_*.png` into the site asset path
  - publish/deploy
```

Implementation files:

```text
packages/shared-services/src/bloggerAgentDraftService.js
scripts/codex-agent/run-blogger-draft.js
scripts/blogger-current-event.js
scripts/blogger-claude-writer.js
tests/blogger/*
```

Atomic functions:

```js
buildBloggerDraftTask(seed)
buildCurrentEventDraftTask(recentTitles)
validateBloggerDraft(draft)
validateBloggerSources(draft)
writeBloggerDraftArtifact(draft)
```

Safety:

- Draft-only until validation passes.
- Source URLs must be explicit and allowlisted.
- No publish/deploy from Codex output.
- If current-event search cannot be made safe through Codex, keep current Anthropic search loop and let Codex handle normal evergreen drafts first.

## P1 Plan: Case / Document Synthesis

Current surfaces:

```text
apps/web-client/src/workspaces/resolution/ResolutionWorkspace.tsx
packages/shared-services/src/resolutionBankService.js
packages/shared-services/src/logicsActivityReviewService.js
packages/shared-services/src/cxCallWrapService.js
packages/shared-integrations/src/logicsClient.js
```

Goal: Codex should synthesize extracted case data, not become a raw document storage/PII sink.

Target flow:

```text
deterministic upload/parse path
  -> parse-and-delete document
  -> store shorthand fields / document hashes / notice matches
after-hours Codex synthesis
  -> reads extracted shorthand + activity notes + call summaries
  -> produces case strategy packet
resolution/app UI
  -> displays packet or uses it as context for interactive pitch
```

Task packet:

```js
{
  taskId: "resolution.caseSynthesis",
  domain,
  caseId,
  notices,
  shorthandFacts,
  activityNoteExtracts,
  callSummaries,
  payment/status facts,
  missingData
}
```

Output:

```js
{
  clientSituation,
  likelyTaxIssues,
  urgency,
  missingDocuments,
  suggestedNextActions,
  pitchAngles,
  riskFlags,
  citations
}
```

Implementation files:

```text
packages/shared-services/src/resolutionCaseSynthesisService.js
packages/shared-services/src/resolutionBankService.js
packages/shared-services/src/logicsActivityReviewService.js
scripts/codex-agent/run-resolution-synthesis.js
```

Safety:

- Do not feed raw uploaded PDFs unless explicitly needed and approved.
- Prefer extracted fields and summaries.
- Use `domain + caseId + source digest` as idempotency.
- Interactive `/resolution.pitch` remains API-backed until Codex latency and quality are proven.

## P1 Plan: Resolution Precompute

Current source:

```text
packages/shared-services/src/aiSandbox/tasks.js resolution.pitch
apps/ai-bus/src/server.js createOpusResolutionPitchAgent
docs/AI_TASK_DICTIONARY.md resolution.pitch
```

`resolution.pitch` is interactive enough that it should keep API execution. Codex should precompute slower prep packets:

```text
overnight:
  - which cases are most pitchable tomorrow
  - what missing facts block the pitch
  - what client-safe strategy angle is likely
  - what Logics activities should be reviewed first
```

Output should be a prep object, not final prose:

```js
{
  caseId,
  readiness: "pitch_now" | "develop" | "nurture" | "pass",
  why,
  missingFacts,
  strongestAngle,
  suggestedQuestions,
  confidence
}
```

Then `/resolution` can use that prep as context for the faster API pitch call.

## P2 Plan: SMS And Contact-Safety Review

Current source:

```text
packages/shared-services/src/aiSandbox/tasks.js sms.classify / activity.contactSafetyReview
docs/AI_TASK_DICTIONARY.md
```

Codex should not handle inline SMS classification or live contactability gates at first.

Good Codex uses:

```text
nightly review of messages that failed closed to needs_human
batch audit of contact-safety decisions
prompt/rule improvement suggestions
summary of recurring inbound objections
```

Bad Codex uses:

```text
send SMS reply directly
mark DNC/contactability directly
decide whether live contact is allowed
block an agent/client interaction waiting on subscription agent
```

Implementation shape:

```text
inline path:
  deterministic fast path -> API classifier -> fail closed to human

after-hours:
  list failed/ambiguous SMS/contact rows
  Codex clusters and suggests rule/prompt changes
  human reviews
```

## Shared After-Hours Queue Shape

Every deferred Codex job should share one work item shape:

```js
{
  taskRunId,
  taskId,
  idempotencyKey,
  source: {
    type,
    ref,
    domain,
    caseId,
    noteKey,
  },
  payload,
  outputSchema,
  status: "queued" | "running" | "succeeded" | "failed" | "applied",
  attempts,
  leaseUntil,
  createdAt,
  updatedAt,
}
```

One queue shape means grader, blogger, case synthesis, and metrics narratives can all use the same runner while keeping their committers separate.

The runner is universal:

```js
claimNextCodexTask()
buildPromptForTask(taskRun)
invokeCodex(taskRun)
validateTaskOutput(taskRun, output)
storeTaskOutput(taskRun, output)
```

The apply step is task-specific:

```js
applyCallGrade()
applyCallCommunicationSummary()
applyBloggerDraft()
applyResolutionSynthesis()
applyMetricsNarrative()
```

That separation is the important simplification. The expensive thinking can be universal; side effects cannot.

## End-Of-Day Codex Queue Model

The right operating model is not "every feature invokes Codex when it feels like it." It is:

```text
daytime app
  -> creates durable Codex task intents as work happens
end-of-day runner
  -> drains the queued intents in priority order
  -> stores validated outputs
deterministic/apply workers
  -> apply safe outputs with idempotency
```

This turns Codex into an EOD thinking queue. The live app keeps moving; Codex catches up on the slow work when latency does not matter.

### What Enqueues During The Day

```text
call ends with enough evidence
  -> enqueue call.communicationSummary
  -> enqueue liveCoach.callGrader if gradeCandidate=true

coach/interview produces structured data
  -> enqueue call.interviewPersistence / communication merge if not already covered

document parse/delete captures shorthand facts
  -> enqueue document.caseSynthesis

resolution profile changes materially
  -> enqueue resolution.casePrep

blog schedule says tomorrow needs content
  -> enqueue blogger.write or blogger.currentEvent

SMS/contact safety fails closed or is ambiguous
  -> enqueue sms.auditReview, not live-send

nightly metrics close finishes
  -> enqueue metrics.narrative if anomalies need explanation
```

Daytime writers should be tiny and deterministic. They should only create/update queue rows with stable references and idempotency keys.

### EOD Queue Priorities

Recommended priority order:

| Order | Task family | Reason |
| ---: | --- | --- |
| 1 | `call.communicationSummary` | It creates better inputs for grading and case history. |
| 2 | `liveCoach.callGrader` | Uses call notes/summaries; internal QA can wait but should finish nightly. |
| 3 | `document.caseSynthesis` | Documents can improve next-day resolution and coach context. |
| 4 | `resolution.casePrep` | Useful for tomorrow; should use document/call synthesis if available. |
| 5 | `blogger.*` | Important but not tied to client workflow. |
| 6 | `sms.auditReview` / `contactSafety.auditReview` | Rule improvement and human review queues, not live work. |
| 7 | `metrics.narrative` | Last because deterministic counts must finish first. |

Dependencies should be explicit rather than implied by timing:

```js
{
  taskId: "liveCoach.callGrader",
  dependsOn: [
    { taskId: "call.communicationSummary", idempotencyKey: "uii:..." }
  ]
}
```

If a dependency fails, the dependent task should either skip with `blocked_dependency` or run with the best existing input, depending on task policy.

### EOD Queue Row State

Add a small amount of scheduling intent to the shared task shape:

```js
{
  taskRunId,
  taskId,
  idempotencyKey,
  priority: 10,
  runAfter: "2026-06-26T18:30:00.000-07:00",
  deadlineAt: "2026-06-27T06:00:00.000-07:00",
  dependsOn: [],
  source,
  payload,
  outputSchema,
  status: "queued" | "blocked" | "running" | "succeeded" | "failed" | "applied",
  attempts,
  leaseUntil,
  resultRef,
  errorCode,
  errorMessage,
  createdAt,
  updatedAt,
}
```

The row should not carry giant blobs by default. Prefer:

```text
source refs + digests + compact payload
```

Only store large transcript/document excerpts when the task actually needs them.

### EOD Runner Loop

Atomic functions:

```js
listReadyCodexTaskRuns({ now, limit })
claimCodexTaskRun(taskRunId, leaseMs)
resolveCodexTaskInput(taskRun)
invokeCodexForTask(taskRun, input)
validateCodexTaskOutput(taskRun, output)
storeCodexTaskOutput(taskRun, output)
releaseOrFailCodexTaskRun(taskRun, error)
```

The runner should be boring:

```text
claim one row
resolve input
invoke Codex
validate output
store output
mark succeeded/failed
move on
```

No side effects in the runner. No "while I have the result, also write Logics." That belongs to the apply worker.

### EOD Apply Loop

Apply workers are allowed to mutate real systems, but each one should be idempotent and narrow:

```js
applyCallCommunicationSummary(taskRun)
applyCallGrade(taskRun)
applyDocumentCaseSynthesis(taskRun)
applyResolutionCasePrep(taskRun)
applyBloggerDraft(taskRun)
applySmsAuditReview(taskRun)
applyMetricsNarrative(taskRun)
```

Each apply function should own exactly one destination:

```text
call communication -> CaseProfile.communications + optional Logics activity
call grade -> CxAgentCallNote.grade + manager bundle source
document synthesis -> case synthesis collection / resolution packet
resolution prep -> resolution prep collection
blogger draft -> draft artifact, not publish
sms audit -> review queue / rule suggestions
metrics narrative -> nightly explanation artifact/email section
```

If a task needs two destinations, use one orchestrator that calls two named committers and records partial step status. Do not hide multi-system writes inside Codex or inside a generic runner.

### EOD Visibility

Before this runs unattended, add a simple report:

```text
queued by task
claimed/running
succeeded
failed
blocked_dependency
applied
average runtime
oldest queued
last error per task
subscription-agent failures
API fallback count
```

This report should be printable without running any task:

```bash
node scripts/codex-agent/report-eod-queue.js --date 2026-06-26
```

And a dry-run should show exactly what would run:

```bash
node scripts/codex-agent/run-eod-codex-queue.js --dry-run --date 2026-06-26
```

### First Safe EOD Version

The first production version should be intentionally small:

```text
enabled:
  - call.communicationSummary for sparse call notes
  - liveCoach.callGrader for 1-5 selected grade candidates

disabled:
  - blogger publish
  - Logics writes from synthesis
  - document raw reads
  - SMS/customer-facing actions
```

Then expand:

```text
night 1: dry-run queue report only
night 2: one real call summary + one real grade
night 3: all call summaries, capped call grades
night 4: add blogger draft artifact
night 5: add document/case synthesis dry-run
```

## 6 PM Codex Lane Schedule Sketch

```text
18:05 PT
  - first capped Codex lane starts just after the floor day
  - use :05 instead of exactly :00 to avoid top-of-hour hourly workers
  - dry-run queue report first, then 1-5 real grade candidates

18:10 PT
  - call communication synthesis for today's thin call notes

18:30 PT
  - nightly call grades for gradeCandidate notes

19:00 PT
  - manager grade/email bundle draft

19:30 PT
  - resolution/case synthesis for tomorrow's likely work

20:00 PT
  - blogger draft/current-event research

20:30 PT
  - SMS/contact-safety ambiguity review

02:00 PT
  - metrics narrative / anomaly explanations after deterministic close is done
```

All jobs should be skippable and rerunnable by idempotency key.

First `liveCoach.callGrader` commands:

```bash
# 1. Report only: Mongo read, no Codex, no writes.
node scripts/codex-agent/run-nightly-call-grades.js --date 2026-06-26 --limit 5

# 2. One Codex call, no DB writes.
node scripts/codex-agent/run-nightly-call-grades.js --date 2026-06-26 --codex --limit 1

# 3. First capped apply after the dry-runs look sane.
node scripts/codex-agent/run-nightly-call-grades.js --date 2026-06-26 --codex --apply --limit 5
```

The runner writes reports under `runtime/codex-agent/nightly-call-grades/`. Do not schedule the `--apply` form until the report-only run confirms the right candidates and packet sizes.

## Sequenced Codex Blog Prompts

The blogger should not be one Codex request that tries to set up context, choose a topic, research, draft, audit, and finalize at the same time. The first safe shape is a prompt chain:

```text
setup
  -> topic plan
  -> research brief
  -> draft
  -> accuracy audit
  -> final artifact
```

Prompt files:

```text
scripts/codex-agent/prompts/blog/00-sequence.md
scripts/codex-agent/prompts/blog/01-setup.md
scripts/codex-agent/prompts/blog/02-topic-plan.md
scripts/codex-agent/prompts/blog/03-research-brief.md
scripts/codex-agent/prompts/blog/04-draft.md
scripts/codex-agent/prompts/blog/05-accuracy-audit.md
scripts/codex-agent/prompts/blog/06-finalize.md
```

Runner:

```bash
# 1. Render only the setup prompt and context. No Codex call.
node scripts/codex-agent/run-blog-prompt-sequence.js

# 2. Let Codex run only the setup step.
node scripts/codex-agent/run-blog-prompt-sequence.js --codex --through setup

# 3. Later, after setup output is sane, advance through audit.
node scripts/codex-agent/run-blog-prompt-sequence.js --codex --through audit
```

Default behavior is render-only and setup-only. That is intentional. It gives us a cheap inspection point before asking Codex to pick topics or write prose.

The setup step studies the existing blogger system and returns a `codex.blog.setup.v1` packet with:

- canonical draft fields;
- required slide fields;
- body HTML rules;
- source and hallucination guardrails;
- current blogger state;
- recent titles and draft inventory;
- known duplication between the current-event and seed-draft paths.

The prompt chain is a sidecar. It must not replace `scripts/blogger-daily-runner.js` or `scripts/blogger-post-pipeline.js` until a separate apply/publish gate is written. Codex can produce a draft artifact; the existing deterministic blogger pipeline owns publishing.

### Codex Imagegen Probe

Linux headless Codex can generate a real PNG through the built-in `$imagegen`
skill while authenticated through the dedicated subscription `CODEX_HOME` and
with `OPENAI_API_KEY` stripped. The measured probe wrote PNGs under:

```text
CODEX_HOME/generated_images/<codex-session-id>/ig_*.png
```

Do not trust final-message placeholder paths such as `_image_id_.png`. The
blog image runner should locate the newest `ig_*.png` created during the Codex
imagegen run, copy it into the deterministic blog asset path, and validate it
with `file`/image dimensions before publish. If no `ig_*.png` appears, fail the
image step cleanly and use the explicitly armed OpenAI Image API fallback or no
image; do not fall back to SVG by accident.

Local patch wiring now exists in `scripts/blogger-post-pipeline.js`:

```bash
# Run preflight with Codex imagegen armed. This does not mutate or publish.
BLOG_IMAGE_PROVIDER=codex node scripts/blogger-daily-runner.js --preflight

# Publish with Codex imagegen armed after preflight is clean.
BLOG_IMAGE_PROVIDER=codex node scripts/blogger-daily-runner.js
```

Optional overrides:

```bash
# Production Linux default. The runner calls local `codex exec` on-box.
CODEX_IMAGE_TRANSPORT=local
CODEX_IMAGE_CODEX_HOME=/opt/tagcontactbridge-parallel/runtime/codex-agent-home
CODEX_IMAGE_CODEX_BIN=codex
CODEX_IMAGE_TIMEOUT_MS=300000

# Windows/dev smoke only. Do not use this as the production shape.
CODEX_IMAGE_TRANSPORT=ssh
CODEX_IMAGE_SSH_HOST=ubuntu@tagcontactbridge
CODEX_IMAGE_SSH_KEY=$HOME/.ssh/id_ed25519_contactbridge_ubuntu
CODEX_IMAGE_REMOTE_USER=parallel
```

Smoke result on 2026-06-26: `renderHeaderImage()` with
`BLOG_IMAGE_PROVIDER=codex` generated a 1254x1254 PNG via Linux Codex in about
66 seconds, normalized it through `sharp`, and deleted the disposable output.
The first local patch smoke used Windows -> SSH only to prove the path before
deployment; the production implementation defaults to local Linux execution and
does not need Windows in the loop. The publish preflight then reached the
image-provider gate successfully; the only reported blocker was unrelated dirty
state in the TAG site repo (`tag-clean`).

## Acceptance Gates Before Any Production After-Hours Run

- `scripts/codex-agent/smoke-codex.js --probe` works on Linux.
- One real `--ask` smoke works on Linux.
- `AiAgentTaskRun` or equivalent durable row exists.
- Each task has a schema validator.
- Each task has a no-side-effect runner test.
- Each task has an idempotent apply test.
- Failures mark rows failed and do not mutate the app.
- A dry-run report can show what would be processed tonight.
- A per-task kill switch exists:

```text
AI_AGENT_CODEX_ENABLED=false
AI_AGENT_CODEX_CALL_GRADER_ENABLED=false
AI_AGENT_CODEX_BLOGGER_ENABLED=false
AI_AGENT_CODEX_CASE_SYNTHESIS_ENABLED=false
AI_AGENT_CODEX_SMS_AUDIT_ENABLED=false
```

## Phase B: True `agent` Provider Adapter

Only do this after Phase A proves stable and the registry split is collapsed enough to trust task identity.

Files:

```text
packages/shared-services/src/aiProviders.js
packages/shared-services/src/aiTaskRunner.js
packages/shared-services/src/aiBusRegistry.js
packages/shared-services/src/aiTaskRegistry.js
apps/ai-bus/src/server.js
tests/ai-bus/*
```

### aiProviders.js

Add:

```js
function createAgentAdapter(client) {
  return {
    id: "agent",
    supports(kind) {
      return kind === "compose" || kind === "json" || kind === "classify";
    },
    async run(kind, request = {}, opts = {}) {
      // call runCodexAgentTask or warm MCP client
      // return { text } or { json } with:
      // { model, usage: null, provider: "agent" }
    },
  };
}
```

Update:

```js
function createAiProviders({ agent, anthropic, openai } = {}) {
  const providers = {};
  if (agent) providers.agent = createAgentAdapter(agent);
  if (anthropic) providers.anthropic = createAnthropicAdapter(anthropic);
  if (openai) providers.openai = createOpenAiAdapter(openai);
  return providers;
}
```

Unsupported kinds must stay unsupported:

```text
transcribe
image
tts
```

### aiTaskRunner.js

The runner can already loop providers, but agent rollover needs stricter rules:

- A task must explicitly allow `agent`.
- One total deadline budget must cover agent + API fallback.
- Validation must run after every provider.
- `forceProvider` remains a hard override.
- `preferProvider:"agent"` may try agent first, but still falls back if the task allows fallback.
- Missing agent configuration should skip with a loud telemetry reason, not crash the bus.

### aiBusRegistry.js / aiTaskRegistry.js

Add `agent` only to tasks that are safe:

```js
providerOrder: ["agent", "anthropic", "openai"]
```

Do not blanket-add it to all reasoning tasks.

Recommended first adapter-backed tasks:

```text
liveCoach.callGrader
blogger.write
misc.caseNotesSummary
documentAnalyzer.summary
```

Recommended hold-outs:

```text
sms.classify
liveCoach.contextJudge
liveCoach.dialogComposer
activity.contactSafetyReview
```

### server.js

Create and register the agent provider only when all required env is present:

```text
AI_AGENT_CODEX_ENABLED=true
CODEX_HOME=/opt/tagcontactbridge-parallel/runtime/codex-agent-home
CODEX_AGENT_MODEL=gpt-5.5
```

No `OPENAI_API_KEY` should be required for the agent provider. In fact, it should be stripped from the Codex child env.

## Invocation Patterns

### One-Off CLI

Use this for manual smoke tests and emergency verification:

```bash
sudo -u parallel -H env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  CODEX_HOME=/opt/tagcontactbridge-parallel/runtime/codex-agent-home \
  codex exec --ephemeral --ignore-rules --skip-git-repo-check \
  -C /opt/tagcontactbridge-parallel --sandbox read-only \
  --output-last-message /tmp/codex-agent-last.txt \
  "Read only the provided fixture and return strict JSON matching this schema: ..."
```

Use read-only by default. Move to writable sandbox only for isolated scratch directories, never the app repo, unless a human explicitly wants Codex editing.

### Warm MCP Client

Use this for worker mode so process startup is paid once:

```js
const { createCodexMcpClient } = require("../../scripts/codex-agent/codexMcpClient");

const client = createCodexMcpClient({
  codexHome: process.env.CODEX_HOME,
  model: process.env.CODEX_AGENT_MODEL || "gpt-5.5",
  sandbox: "read-only",
  approvalPolicy: "never",
  timeoutMs: 120000,
});

const result = await client.ask(prompt, {
  baseInstructions,
  cwd: "/opt/tagcontactbridge-parallel",
});
```

Production runner should parse/validate `result.text`, store `result.threadId`, and always stop/restart the client on repeated MCP failures.

### Bus API Smoke

List bus tasks:

```bash
curl -s \
  -H "x-service-secret: $INTERNAL_SERVICE_SECRET" \
  http://127.0.0.1:7000/api/ai/tasks
```

Run a task:

```bash
curl -s \
  -H "content-type: application/json" \
  -H "x-service-secret: $INTERNAL_SERVICE_SECRET" \
  -d '{"payload":{"text":"hello"},"options":{"qualityMode":"cheap","timeoutMs":30000}}' \
  http://127.0.0.1:7000/api/ai/tasks/misc.caseNotesSummary/run
```

Do not echo or paste the actual internal secret in docs, logs, or chat.

## Test Order

1. Local static bus tests:

```bash
node --test tests/ai-bus/aiTaskRunner.test.js tests/ai-bus/aiPrimitives.test.js tests/ai-bus/aiSandbox.test.js tests/ai-bus/busContract.test.js tests/ai-bus/apiLocal.test.js tests/ai-bus/aiTaskClient.test.js tests/ai-bus/busWiring.test.js
```

2. Local Codex wrapper unit test with fake MCP process if available.

3. Linux no-model probe:

```bash
node scripts/codex-agent/smoke-codex.js --probe
```

4. Linux tiny model smoke:

```bash
node scripts/codex-agent/smoke-codex.js --ask "Reply with exactly READY."
```

5. Offline fixture run:

```text
one call summary fixture -> Codex JSON -> schema validate -> store task row
```

6. Shadow comparison:

```text
same input -> existing API path
same input -> Codex agent path
compare:
  schema validity
  missing required facts
  hallucinated facts
  latency
  retries
  fallback behavior
```

7. Enable one scheduled/batch task with API fallback armed.

8. After one clean day, decide whether that task can be `providerOrder:["agent","anthropic","openai"]`.

## Security Rules

- `CODEX_HOME` is a credential boundary.
- Never print `auth.json`.
- Never pass `OPENAI_API_KEY` or `OPENAI_BASE_URL` into Codex child processes.
- Never let browser/client routes call Codex directly.
- Never let model output perform side effects directly.
- Use idempotency keys before any task can write an applyable output.
- Store full prompt/input only when necessary; otherwise store input digests plus safe refs.
- PII-heavy prompts should be task-limited and not reused across unrelated work.
- All published/customer-facing actions still require the existing deterministic or human gate.

## Rollout Recommendation

Do not make this a global provider flip first.

Recommended sequence:

1. Sync `scripts/codex-agent/*` to Linux.
2. Add `codexAgentTaskRunner` with strict JSON/text parsing and schema validation.
3. Add durable `AiAgentTaskRun` rows with unique `taskId + idempotencyKey`.
4. Run one fixture through Codex and store output.
5. Wire nightly grader draft to use Codex in shadow mode.
6. Compare against existing grader/API output.
7. Let existing drain/committer apply the validated output.
8. Only then add `providers.agent` to the bus adapter map.

This gets the subscription-backed work doing useful background labor without making the live coach, SMS, or queue flow depend on a new and still-unproven execution lane.

## Open Decisions

- Whether task run storage should be `AiAgentTaskRun` or folded into a future universal `AiTaskRun`.
- Whether the AppArmor user-namespace warning needs a host policy change before long-running production worker use.
- Whether `agent` provider should use `codex exec` per task or the warm MCP server for every production run. The warm MCP route is better for worker mode, but `codex exec` is simpler for one-off proof.
- Which exact tasks become agent-eligible once the registry/catalog split is collapsed.
- Whether subscription usage limits should be monitored manually first or represented as a health check in the bus governor.
