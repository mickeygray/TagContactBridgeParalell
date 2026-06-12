# Live Coach Universal AI Bus Implementation Plan

Working plan for moving only the proven live coach plumbing out of the one-off harness and into a universal AI bus playground, without dragging along every experiment that happened on the way here.

## Goal

Create a clean bridge where RingCX gRPC audio streams can be tested through an AI playground service, produce readable prospect transcription plus agent dialog, and eventually embed that coach surface above appointments in the CX workspace.

The first target is not full production automation. The first target is a controlled test harness that proves the specific workflow we have converged on:

- the stream can be started through the bus route,
- raw audio files can be captured and replayed from an app-owned folder,
- gRPC sessions can be associated with the correct agent/call,
- stale streams can be found and cleaned,
- the AI chain can run on known test text and then on live audio,
- the frontend can show only the two useful fields: what the prospect said and what the agent should say.

Anything outside that workflow is a maybe, not final plumbing.

## Pre-Test Hardening Decisions

These are the blockers that must be treated as part of the test harness, not future polish.

1. **Agent/current-call scoping is mandatory.** The CX workspace panel must never pick the latest coach session globally. It should bind by the current agent plus the current UII or queue item, then subscribe to that one session. A newer `cx.call.placed` for the same agent invalidates the older stream.
2. **Next-call cleanup rides the UI call transition.** When the workspace moves to a new call or clears the current call, it should send a best-effort asynchronous stop/release for the prior coach session. The AI bus also retires replaced sessions during scoped bind, and a periodic stale sweep is the backstop.
3. **Avoid polling full session state.** The dashboard can keep full session routes for local debugging, but the production-ish panel should request a scoped session once per call and then use SSE for that session. Full `listSessions()` snapshots include memory/events and are too heavy for multi-agent polling.
4. **Memory is in-process first, Mongo snapshot second.** Live turn state stays in memory for speed. A Mongo snapshot model can persist the rolling session memory every few minutes and immediately on terminal events. Writes must be async and not awaited by transcript/context/dialog emission.
5. **Start VAD eager, then walk back.** For testing, prefer earlier STT/VAD finalization and let the mini/context gate decide whether a sentence is worth coaching. If this creates bad turns, reduce eagerness after the pipe is proven.
6. **Spend mini to protect Sonnet.** Mini can check semantic completeness frequently because Sonnet is the expensive and more latency-sensitive hop. The gate should be tuned to hold partial thoughts, call screeners, and low-value chatter without starving useful guidance.

Cost model for mini gating:

- Assume 100 hours of connected talk has roughly 50 active spoken hours after silence.
- A mini completeness/context check every 3 seconds is about 60,000 checks across 50 spoken hours.
- If each check averages 250 input tokens and 40 output tokens, that is roughly 15M input tokens and 2.4M output tokens.
- At a low-cost mini tier this is usually modest compared with repeatedly invoking Sonnet. The exact number depends on the chosen provider/model, but the architecture should optimize for more cheap gate checks and fewer expensive coach turns.

## Scope Boundary

Final plumbing means only the pieces needed for the current agreed path:

```text
gRPC stream
  -> raw capture and replay
  -> deterministic voicemail/system filtering
  -> STT / sentence stream
  -> context and tax-comprehension lookup
  -> Sonnet dialog
  -> two-field coach UI
```

Maybe-category experiments should stay out of the final service unless we explicitly pull them back in:

- RingEX headless monitor flows.
- Realtime direct coach-only experiments.
- Old transcript-heavy dashboards.
- Manual start/stop monitor controls.
- Token/lag/model debug panels for agents.
- Broad multi-model comparison switches.
- Anything that cannot be tied cleanly to agent, UII, and session state.

## Architecture Shape

```text
RingCX workflow
  -> gRPC stream
  -> CX/service caller
  -> AI bus playground :7000
  -> stream/session registry
  -> raw audio capture folder
  -> STT / sentence shaping / context lookup / Sonnet dialog
  -> local test UI
  -> later: CX workspace coach panel
```

The AI bus should be a playground and service host for AI-related workflows, not a separate product surface. It should not bind `6101`, because `6101` is already CX. Use a separate thousand-band service port; default plan is `7000` for the AI playground unless that conflicts. Later it can sit behind nginx or the control-plane routing layer if that is cleaner operationally.

## 7000 AI Bus Sketch

Port `7000` should become the project-level AI service host. The first real implementation is live coach, but the shape should make room for other AI endpoints without making the main control plane own every model call directly.

Think of `7000` as:

```text
app / CX / worker / one-off script
  -> http://127.0.0.1:7000/api/ai/<workflow>
  -> shared provider adapters
  -> OpenAI / Anthropic / other model providers
  -> structured result + event log + usage telemetry
```

The bus should provide common mechanics:

- provider clients and model selection,
- streaming response helpers,
- tool/context lookup helpers,
- prompt/version registry,
- usage and cost telemetry,
- replay/test fixture support,
- runtime artifact folders,
- consistent error/event logs,
- internal-auth checks,
- optional dry-run/test modes.

### Immediate Routes

These are the live coach routes to build first:

```text
POST /api/ai/live-coach/grpc/start
POST /api/ai/live-coach/grpc/stop
GET  /api/ai/live-coach/grpc/sessions
GET  /api/ai/live-coach/grpc/sessions/:sessionId
POST /api/ai/live-coach/replay
POST /api/ai/live-coach/fixture
```

### Model Adapter Routes

These are useful as internal primitives, but should not be agent-facing:

```text
POST /api/ai/stt/transcribe
POST /api/ai/stt/stream-session
POST /api/ai/context/sentence
POST /api/ai/context/call-summary
POST /api/ai/coach/dialog
POST /api/ai/coach/evaluate-call
```

The live coach workflow can call these internally rather than exposing every adapter as a public surface.

### Future Workflow Routes

These are eventual candidates after live coach is stable:

```text
POST /api/ai/call-scoring/run
POST /api/ai/call-summary/run
POST /api/ai/case-pitch/build
POST /api/ai/activity-review/classify
POST /api/ai/document-review/extract
POST /api/ai/blogger/generate
POST /api/ai/vendor-email/summarize
```

The important rule is that these should be adapters or workflow endpoints, not a rewrite of the whole app. The app decides when work should happen; the AI bus decides how to run the AI work cleanly.

## 1. Sanitize The One-Off

The current one-off has useful pieces mixed with old monitor assumptions, UI experiments, and dead-end test paths. Sanitizing means extracting only the pieces that support the final agreed pipe. It does not mean preserving every lane behind flags.

Keep:

- gRPC stream receiver primitives.
- raw audio file writing.
- event/state broadcasting to the local dashboard.
- test-call/session tracking helpers.
- AI chain adapters that can be called with either text fixtures or live stream output.
- cost/usage logging when available.
- deterministic voicemail/system filtering.
- UII/agent/session matching guards.
- stale-session cleanup hooks.

Remove or isolate:

- RingEX monitor-only language and controls.
- manual start/stop coach controls that no longer represent the intended flow.
- old mixed monitor attach assumptions.
- UI fields for monitor status, lag, internal mode, token trivia, and debug-only event walls.
- stale Realtime direct paths that are not part of the next chain.
- broad model-comparison switches.
- half-working semantic gates that slow the pipe before the pipe is proven.
- any code path that can render one agent's stream in another agent's lane.

Output of this phase:

- a small sanitized test runner,
- a bus-facing service module,
- a narrow dashboard HTTP layer,
- clear runtime folders for raw audio and AI artifacts.

## 2. Attach To Universal AI Bus And Port 7000

The universal AI bus should expose one test-only live coach route on its own playground port. Proposed default:

```text
7000 = universal AI bus / AI playground
6101 = CX, already reserved
```

Proposed route responsibilities:

- accept a request to begin a gRPC-backed coach session,
- create or resolve a session id,
- register the agent/call/UII metadata,
- choose the raw audio capture directory,
- start or attach to the gRPC stream listener,
- expose current session state for the dashboard,
- provide a controlled shutdown endpoint.

Suggested route names:

```text
POST /api/live-coach/grpc-test/start
POST /api/live-coach/grpc-test/stop
GET  /api/live-coach/grpc-test/sessions
GET  /api/live-coach/grpc-test/sessions/:id
```

The first implementation can be local-only and protected by existing internal secret rules. Do not expose credentials or raw env values in logs, state snapshots, or dashboard payloads.

## 3. Streaming gRPC Test Through AI Bus And Raw File Folder

The first end-to-end test should not depend on the full production app lifecycle. It should be possible for CX/6101 or a local test script to invoke the AI bus route on `7000` and watch files appear in a known app folder.

Runtime folder shape:

```text
runtime/live-coach-grpc/
  sessions/
    <sessionId>/
      metadata.json
      events.ndjson
      raw/
        prospect.pcmu
        agent.pcmu
        mixed.pcmu
      wav/
        prospect-0001.wav
      ai/
        transcript.ndjson
        context.ndjson
        dialog.ndjson
```

Test flow:

1. Start universal AI bus on `7000`.
2. Call `POST http://127.0.0.1:7000/api/live-coach/grpc-test/start` with test agent and call metadata.
3. Trigger the RingCX workflow stream.
4. Confirm the bus sees stream open.
5. Confirm raw files are written immediately.
6. Confirm the dashboard reads from session state, not from a random global singleton.
7. Confirm replay mode can feed the captured files back through the AI chain.

The replay path matters because it lets us retest model behavior without redialing real people.

## 4. Prepare Cleanup Of Stale gRPC Sessions

Stale stream cleanup needs to be designed before production use, even if the first pass is manual.

Track for every session:

- session id,
- UII,
- agent email,
- agent extension,
- queue/case id when known,
- RingCX workflow instance id if available,
- stream id if available,
- last packet time,
- last transcript time,
- last app call event time,
- last disposition/hangup signal,
- state: `starting`, `streaming`, `ended`, `stale`, `force_closed`, `error`.

Cleanup rules:

- If a newer `cx.call.placed` event arrives for the same agent, mark the old session stale and clear the UI lane immediately.
- If disposition/hangup is observed, close the session and clear UI state.
- If no packets arrive for a configured timeout, mark stale.
- If gRPC stop is available, call it once and record the result.
- If gRPC stop is not available or fails, drop local processing and keep a stale record for review.

Create a small manual cleanup command before any cron/daemon:

```powershell
node scripts/live-coach-cleanup-stale-grpc-sessions.js --dry-run
node scripts/live-coach-cleanup-stale-grpc-sessions.js --apply
```

Future enhancement: force-close by UII/stream id from the app when the agent disposition event fires.

## 5. Universal AI Bus Owns This Workflow Only

For this pass, the AI bus should control only the live coach gRPC workflow.

The bus is best treated as an AI playground with production-shaped boundaries:

- own port: yes, `7000` is useful for isolation while the stream work is still experimental,
- own lifecycle: yes, so stream tests and model work do not destabilize the main control plane,
- own logs/runtime folders: yes, because replay and cleanup are core to this work,
- own product UI: no, only local test dashboards and service endpoints.

It should own:

- session registry,
- stream lifecycle,
- raw audio file capture,
- replay mode,
- AI chain invocation,
- dashboard state snapshots,
- stale session cleanup hooks.

It should not yet own:

- nightly emails,
- blogger,
- Logics scrapers,
- NCOA,
- lead cadence scoring,
- vendor reporting,
- unrelated Claude/OpenAI jobs.

This gives us a clean runway to prove the bus pattern without turning every AI feature into one big migration at once.

If a separate port becomes operationally annoying later, we can reverse-proxy the AI bus under the main app without changing the internal service boundary.

## 6. Plant The Frontend Above Appointments

The production target is a compact coach panel above appointments in the CX workspace.

For the first UI pass, show two readable fields:

- `Prospect said`: the latest meaningful prospect-side transcript or compact paraphrase.
- `Say this`: the generated line or short response the agent should use.

Do not show:

- raw token counts,
- model lane names,
- internal lag,
- gRPC debug states,
- large event logs,
- implementation mode switches.

Suggested CX workspace placement:

```text
Lead header / primary action buttons
Live Coach
Appointments
Communications
Logics Info
Interview Snapshot
```

The live test dashboard can show more detail, but production should stay focused. Agents need to read the recommendation in a second or two, not inspect the machinery.

UI behavior:

- Keep the last good dialog visible until replaced.
- Do not wipe a response while the agent may still be reading it.
- When a call ends or voicemail is detected, replace the panel with a simple state message.
- If a new call event arrives for the agent, clear old transcript/dialog immediately and wait for the matching stream.
- If the stream UII does not match the latest call event UII for that agent, do not render it in that agent lane.

## 7. Run AI Chain With Implemented Test Text

Before live stream testing, the AI chain should run on deterministic fixture text.

Minimum fixtures:

- IRS notice opening: CP504 / LT11 / levy risk.
- State-only issue.
- Mixed IRS/state issue.
- 1099/self-employment.
- Payroll/941/trust fund.
- Unfiled years.
- Spouse/divorce/joint liability.
- Prior bad firm/accountant.
- Price objection.
- Voicemail prompt.
- Answering service / gatekeeper.
- Agent talking too much.
- Prospect emotional life context.

Expected chain shape:

```text
STT text or fixture text
  -> sentence/completeness pass
  -> prospect/agent/system classification
  -> context lookup / tax comprehension / sales phase match
  -> Sonnet dialog composition
  -> frontend event
```

The test text should prove:

- voicemail/system content does not reach Sonnet,
- screeners can be held or ignored without ending the call,
- tax comprehension is informative but does not become DIY tax advice,
- Sonnet receives agent name and firm name as explicit context,
- output is one or two useful sentences, not a paragraph,
- the same fixture can be replayed across model combinations.

## 8. Turn On Stream And Run Tests For A While

Once the fixture chain works, run real stream tests in increasing scope.

### Single Lane

1. One agent.
2. One workflow stream.
3. One dashboard lane.
4. Confirm raw files write.
5. Confirm transcription appears.
6. Confirm dialog appears.
7. Confirm voicemail phrases clear the state.
8. Confirm end/disposition clears the state.

### Three Lanes

Use fixed lanes:

- `cbolt`
- `bhansen`
- `jsharp`

Each lane should only show that agent's latest call. The dashboard should behave as a 3x3:

```text
cbolt:   transcript | context | dialog
bhansen: transcript | context | dialog
jsharp:  transcript | context | dialog
```

For the production CX panel, collapse that to the two useful fields. The 3x3 view is for test visibility only.

### Multi-Agent Criteria

Pass conditions:

- A call event for Brad never renders in Chris's lane.
- A stale gRPC stream does not keep old text visible after the agent moved on.
- A new call event wipes old UI state before the next stream starts writing.
- Voicemail phrase match creates a visible "call rejected for voicemail match" transcript/state message.
- Sonnet does not answer voicemail/system prompts.
- The bus can list open/stale sessions accurately.
- Manual cleanup removes stale local processing without crashing active sessions.

## Voice Mail And System Filtering

Current deterministic voicemail match list:

- `forwarded`
- `message`
- `tone`
- `record`
- `name and number`
- `can't take your call now`
- `at the tone`
- `please record your message`

Rule:

- If the first transcript item strongly matches voicemail, clear the call state and stop local AI processing for that session.
- If it sounds like an answering service or human gatekeeper, do not send it to Sonnet immediately; hold it as non-prospect context unless a real tax conversation starts.
- Do not rely on nano for the first pass if deterministic phrase matching is enough.

## Agent And Call Matching

The key production risk is matching the correct stream to the correct agent.

Preferred matching priority:

1. UII from app `cx.call.placed` event matched to stream metadata.
2. Agent email/extension from call event matched to lane/session.
3. Queue/case id from call event matched to current agent state.
4. Time-window fallback only for local testing.

Hard rule:

- If the stream UII does not match the latest known call UII for that agent, do not render it in that agent's coach lane.

State reset triggers:

- `cx.call.placed` for same agent with a newer UII,
- app disposition/hangup event,
- voicemail match,
- explicit session stop,
- stale timeout.

## End-Of-Call Closeout Worker

The live coach should not make the disposition path wait for summaries, emails,
Logics writes, or grading. On call release/hangup/disposition, the app should
enqueue a closeout job with the session id, UII, agent, case/contact ids,
transcript memory, selected context keys, reactions, guideposts, asks, facts,
and timing. The UI and queue move on immediately; the worker finishes the
recordkeeping in the background and then fully prunes live coach context for
that call.

Outputs should be intentionally different by destination:

- Logics activity: sparse operational note only. Use a short human-readable
  list: call outcome, major issue discussed, next step, and any promised
  follow-up. Do not include agent critique, strategy notes, or long transcript.
- Contact / communications panel: sparse call context, similar to Logics but
  local and searchable. It should answer "what happened on the call?" without
  turning the communications tab into a coach transcript.
- LeadCadence / case profile memory: compact continuity summary for future
  coach sessions. Include facts learned, unresolved questions, objections,
  promised next step, and selected context keys.
- Agent email: richer coaching artifact. This can include a call summary,
  useful moments, missed opportunities, objection handling notes, phase
  movement, and a light scorecard.
- Manager/admin view: optional deeper grade/debug record with timings, model
  usage, selected keys, and transcript references.
- Call grader: optional OpenAI analysis pass at closeout. It uses a stable
  cached grading rubric and a compact per-call payload to score phase movement,
  discovery, control, tax comprehension, sales pivot, compliance, and close.
  Default model: `LIVE_COACH_CALL_GRADER_MODEL=gpt-5.4`.

Controls:

- Agent summary emails must be toggleable by env/admin setting.
- Agent summary emails should probably only fire for longer or meaningful
  calls, for example after a minimum duration, minimum transcript character
  count, or at least one real coach turn.
- Voicemail/no-answer/short junk calls should prune context and skip summary
  writes unless a compliance event needs a sparse note.
- Summary failures must not reopen or block the agent queue; log and retry
  worker-side.

Proposed worker stages:

1. Snapshot session memory and mark the session `closing`.
2. Generate a compact operational summary.
3. Write sparse Logics activity when case/domain credentials are available.
4. Upsert local communications/case context.
5. Optionally generate and send the agent coaching email.
6. Persist closeout status and model usage.
7. Prune live coach session state and runtime buffers.

First pass status:

- `packages/shared-services/src/liveCoachCloseoutService.js` builds deterministic closeouts without an extra model call.
- Terminal bus paths enqueue closeout on stop, stale, prune, and voicemail reject. The queue is best-effort and never blocks the caller.
- Runtime artifacts always write to `runtime/ai-bus/live-coach/closeout`.
- CaseProfile communication and LeadCadence continuity summary are enabled only when Mongo is connected.
- Logics activity is opt-in; agent email is enabled by default for meaningful
  calls and can be disabled:
  - `LIVE_COACH_CLOSEOUT_LOGICS_ENABLED=true`
  - `LIVE_COACH_CLOSEOUT_AGENT_EMAIL_ENABLED=false`
  - `LIVE_COACH_CLOSEOUT_AGENT_EMAIL_MIN_SECONDS`
  - `LIVE_COACH_CLOSEOUT_AGENT_EMAIL_MIN_CHARS`
- Agent email can also alert managers on outlier graded calls. Defaults:
  high score `>=90`, low score `<=55`, longer call threshold `>=300s` or
  `>=800` prospect transcript chars, recipients Matt Anderson and Mickey Gray.
  Tune with:
  - `LIVE_COACH_CLOSEOUT_MANAGER_EMAIL_ENABLED`
  - `LIVE_COACH_CLOSEOUT_MANAGER_EMAIL_TO`
  - `LIVE_COACH_CLOSEOUT_MANAGER_EMAIL_MIN_SECONDS`
  - `LIVE_COACH_CLOSEOUT_MANAGER_EMAIL_MIN_CHARS`
  - `LIVE_COACH_CLOSEOUT_MANAGER_HIGH_SCORE`
  - `LIVE_COACH_CLOSEOUT_MANAGER_LOW_SCORE`
- Call grading is enabled by default when `OPENAI_API_KEY` is present and can
  be tuned with:
  - `LIVE_COACH_CALL_GRADER_ENABLED=false`
  - `LIVE_COACH_CALL_GRADER_MODEL`
  - `LIVE_COACH_CALL_GRADER_MIN_SECONDS`
  - `LIVE_COACH_CALL_GRADER_MIN_CHARS`
  - `LIVE_COACH_CALL_GRADER_TIMEOUT_MS`
- Dashboard stats are available at `/api/ai/live-coach/dashboard/closeout/stats`.

## First Implementation Checklist

- [ ] Create bus route skeleton on `7000`.
- [ ] Move sanitized stream/session registry into a bus-owned module.
- [ ] Add runtime folder writer for raw/audio/AI artifacts.
- [ ] Add fixture-driven AI chain runner.
- [ ] Add replay runner from captured files.
- [ ] Add stale session list and cleanup command.
- [ ] Add fixed three-lane test dashboard.
- [ ] Add deterministic voicemail phrase clear.
- [ ] Add UII/agent matching guard before rendering.
- [ ] Add production CX workspace panel stub above appointments.
- [ ] Run fixture tests.
- [ ] Run single-agent live stream.
- [ ] Run three-agent live stream.
- [ ] Document cost/latency from real runs.

## What Not To Do Yet

- Do not merge the whole one-off script into production unchanged.
- Do not expose raw gRPC/session debug to agents.
- Do not start moving every AI process behind the bus.
- Do not trust time-window matching as production identity.
- Do not keep zombie streams alive just because the UI cleared.
- Do not make Sonnet answer every transcript fragment.
- Do not hide the raw capture/replay artifacts; they are the fastest way to debug model behavior.

## Open Questions

- Does RingCX provide enough stream metadata to reliably bind UII without a local timing fallback?
- Can workflow studio stop-stream be invoked reliably from app disposition/hangup, or do we need local-only stale cleanup plus later workflow cleanup?
- Should raw files be kept for every test call or only when debug mode is on?
- Should production keep a per-call coach session record in Mongo immediately, or wait until the chain is stable?
- How long should the UI keep a good response visible before replacing it?
- Should the first production coach be prospect-only, or should agent feedback be allowed in a separate smaller state?

## Success Definition

This implementation is ready to move from local test to production branch when:

- `7000` can start and list live coach sessions,
- raw stream files are captured and replayable,
- three fixed agent lanes stay isolated,
- stale sessions can be detected and locally cleaned,
- voicemail/system prompts do not reach dialog generation,
- fixture text produces useful dialog,
- live stream tests produce readable `Prospect said` and `Say this` fields,
- the CX workspace can render the coach panel above appointments without disrupting appointment workflow.
