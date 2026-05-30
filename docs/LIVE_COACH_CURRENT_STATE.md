# Live Coach Current State

Current handoff for the RingEX/RingCX live coach experiment as of 2026-05-29.

## Short Version

The current best path is a RingEX headless monitor that stays attached to the agent audio leg, but only sends audio to AI when our app sees a CX call event for that agent.

The best-performing model lane right now is `gpt-realtime-2` in direct coach-only mode. It listens to mixed monitor audio and returns compact coaching JSON instead of returning a full transcript plus coaching response. That matters because the product goal is "what should the agent say or adjust right now", not captioning.

This does not rely on RingCX gRPC. gRPC remains blocked upstream, so the current path uses RingEX supervision audio.

## Main Files

- `scripts/rc-ex-live-trainer-oneoff.js`
  - Headless RingEX softphone monitor.
  - Local dashboard.
  - STT, diarization, semantic-turn, prospect-coach, and Realtime-2 direct coach lanes.
  - Event-gated audio processing.
- `docs/LIVE_PROSPECT_COACH_PLAYBOOK.md`
  - Stable sales/tax coaching playbook.
  - Used as focused context for coach behavior.
- `scripts/send-live-coach-campaign-call.js`
  - Sends a RingCX campaign lead, emits a synthetic `cx.call.placed` event, watches for active call UII, and tries to attach the monitor.
- `scripts/emit-synthetic-cx-call-event.js`
  - Emits a local completed `cx.call.placed` event for coach gate testing.
- `package.json`
  - Current reusable scripts:
    - `rc:live-monitor`
    - `rc:live-monitor:coach:realtime2`
    - `rc:live-monitor:coach:summary-openai`
    - `rc:live-monitor:coach:summary-haiku`
    - `rc:live-monitor:synthetic-event`
    - `rc:live-monitor:test-call`

## Current Best Launch Shape

The package script contains the current Realtime-2 model/timing defaults:

```powershell
npm run rc:live-monitor:coach:realtime2 -- --event-gated --agent-ext 101 --supervisor-ext 987 --dashboard-port 7332
```

For the Mickey/Phil local test, the important pieces are:

- `--realtime-direct-coach`
- `--realtime-direct-coach-only`
- `--realtime-direct-model gpt-realtime-2`
- `--realtime-direct-reasoning-effort low`
- `--realtime-direct-start-delay-sec 120`
- `--realtime-direct-hold-recheck-sec 120`
- `--realtime-direct-min-chunk-sec 3`
- `--realtime-direct-incomplete-hold-ms 6000`
- `--split-on-silence`
- `--silence-split-ms 900`
- `--chunk-sec 8`
- `--summary-provider openai`
- `--summary-model gpt-4o-mini`
- `--summary-service-tier priority`
- `--summary-every-sec 120`

Local dashboard:

```text
http://127.0.0.1:7332/
```

## Current Logic Flow

1. The script authenticates to RingEX with the configured platform/JWT credentials.
2. It resolves the supervisor/monitor extension and device.
3. It registers a headless softphone using RingCentral SIP info.
4. The monitor can be attached to an agent call through RingEX supervision / monitor attach.
5. The monitor receives PCMU/8000 RTP audio packets.
6. Packets are always counted and can be written locally, but AI processing is gated.
7. With `--event-gated`, the script polls the local event store for recent `cx.call.placed` events matching the configured agent email or extension id.
8. When a matching call event appears, the coach gate opens for that CX call.
9. On gate open, transcript/coach state resets and Realtime-2 sleeps for the configured start delay, currently 120 seconds.
10. After the delay, audio chunks are flushed by silence or max window.
11. Chunks go directly to `gpt-realtime-2`.
12. The model returns a compact JSON object:

```json
{
  "acceptInput": true,
  "mode": "PROSPECT_RESPONSE",
  "say": "That makes sense; let's look at the notice first so we know what option actually fits. What date is on it?",
  "signal": "got a notice",
  "topic": "IRS notice",
  "direction": "acknowledge and ask notice date"
}
```

13. The dashboard streams the model response into the large center `Live Guidance` card.
14. The result is also stored in `realtime-direct-coach.ndjson` under the run directory.
15. A compact summary can refresh every 120 seconds and be sent back into the realtime session as background memory.

## Event Gate Behavior

The current preferred trigger is our own app event, not RingCX gRPC.

Expected event:

- `eventType: "cx.call.placed"`
- `sourceService: "ringcentral-cx"` by default
- payload includes agent identity, queue item/case id, and optional call/session identifiers

Synthetic events are deliberately marked completed and `countAsAttempt: false`, so they should not be picked up as cadence work.

The gate closes when:

- no matching app call event exists
- the event expires
- a completed disposition/hangup workflow exists for that queue item
- manual stop/fake stop is used in the test UI

## Hold / Dormant Behavior

The exact phrase is:

```text
please continue to hold
```

Current rule:

- Only this exact phrase should pause AI input.
- Generic hold music, queue prompts, voicemail prompts, silence, and system noise should return `WAIT` with `acceptInput: true`.
- If the model tries to send hold control without the exact phrase, the script logs `realtime_direct.strict_hold_ignored` and keeps going.
- When the exact phrase is detected, the script sleeps for `--realtime-direct-hold-recheck-sec`, currently 120 seconds.
- After the sleep, it checks again rather than staying dormant forever.

This is intended to reduce spend while the agent is sitting off-hook waiting for a real CX conversation.

## UI State

The local dashboard now emphasizes guidance rather than transcript.

Working UI pieces:

- Large center `Live Guidance` panel.
- Clear mode labels:
  - `Proposed Response`
  - `Adjust Current Talk`
  - `Hold/System`
  - `Waiting`
- Signal, topic, and direction details under the main response.
- Event list on the right.
- Buttons:
  - `Attach monitor`
  - `Start coaching`
  - `Stop coaching`

The UI still contains old transcript/history machinery underneath because the same script also supports transcript-first tests. The current product direction is to simplify the production UI to "what was heard enough to justify this" and "what to say/adjust now."

## What Works

- The headless monitor can register as a RingEX softphone.
- The monitor receives packets/bytes once attached.
- The local dashboard streams state updates.
- The Realtime-2 direct coach can return coaching without requiring a separate transcript response.
- The current prompt can distinguish:
  - prospect-oriented response
  - agent feedback
  - wait/no useful action
  - exact hold phrase
- The exact hold phrase control loop exists.
- Synthetic CX call events can open the gate for local testing.
- A campaign-call helper exists to send a test lead and emit the matching gate event.
- The current `gpt-realtime-2` path was subjectively faster/snappier than transcript -> semantic splitter -> coach for the "say this now" use case.
- The playbook has improved tone: warmer, less robotic, less DIY tax advice, more service-sales oriented.
- CP/IRS/state routing rules are in the playbook and should default tax-ish issues to IRS unless clear state signal exists.

## What Needs Improvement

- Speaker separation is still the big problem.
  - The monitor leg is mixed mono.
  - The model must infer agent vs prospect from content and turn shape.
  - This is usable for science, not yet proven enough for production.
- Hold/system gating still needs repeated real-call testing.
  - We need to verify it does not burn money on hold loops.
  - We need to verify it wakes correctly after the 120-second recheck.
- The current event trigger is synthetic/test-friendly.
  - Production should consume real `cx.call.placed` events from the app and close on real disposition/hangup.
  - Need test with multiple simultaneous agents.
- The monitor attach flow can hit RingEX state errors.
  - Example seen: `TAS-102 Incorrect State [WrongState]`.
  - Need better retry/backoff and clearer UI status when attach is impossible.
- The UI is still a one-off local dashboard.
  - Production should be simplified and embedded in the actual CX workspace.
  - Agent should not see raw implementation details.
- Token/cost telemetry needs to be captured consistently.
  - The realtime turns include usage when returned, but we need a clean per-call cost summary.
- The summary/memory loop is present, but not yet proven.
  - It should update independently every couple minutes.
  - It should feed compact context into the realtime session without blocking live response.
- Need to decide whether agent feedback is useful or distracting.
  - Prospect responses are the obvious product.
  - Agent feedback may be helpful but should be rare and not noisy.

## Competing Model Lanes

### Current Best Lane: Realtime-2 Direct Coach

Flow:

```text
RingEX monitor audio -> gpt-realtime-2 -> streamed coach JSON -> dashboard
```

Pros:

- One model call path.
- Can output only coaching, not transcript.
- Lower output token waste if we suppress transcript.
- Fast enough to feel usable in short tests.
- Can potentially hold conversational context in one realtime session.

Cons:

- More expensive than smaller text models.
- Speaker separation is model-inferred.
- Needs stronger prompt/tuning for tax-resolution sales quality.
- Need better usage/cost accounting.

### Three-Headed Lane

Flow:

```text
gpt-4o-transcribe -> gpt-4o-mini priority semantic splitter -> Claude Sonnet coach
```

Pros:

- More inspectable.
- Transcription quality was good with `gpt-4o-transcribe`.
- Sonnet sounded warmer and more natural than some OpenAI text responses.
- Semantic splitter was decent with 4o-mini priority.

Cons:

- More latency.
- More moving parts.
- Can duplicate/fragment turns.
- Pays for transcript text and coaching text.
- Still does not solve mixed mono audio perfectly.

### Diarization / Native Speaker Experiments

The script still has native diarize and speaker-label paths.

Pros:

- More explicit speaker handling if it works.
- Useful for offline evaluation.

Cons:

- Not yet proven fast/reliable enough for live coaching.
- May require reference audio and tuning per agent.

## Product Direction

First production-feeling version should be:

1. Monitor is attached and available.
2. AI is dormant until a CX call event starts the timing loop.
3. At 2 or 3 minutes after a call event, AI begins listening unless the agent manually starts it earlier.
4. If the exact hold phrase is heard, pause AI for a recheck interval.
5. When the prospect says something response-worthy, stream a suggested response to the agent.
6. If the agent is talking poorly or dangerously, provide brief private feedback instead.
7. Stop or go dormant on disposition/hangup.

The UI should primarily show:

- What to say next.
- Why it is suggesting that, in a short signal/direction line.
- Optional "heard enough to respond" context, not a full transcript.

## Test Plan

### Single-Agent Smoke

1. Start local monitor on port `7332`.
2. Open dashboard.
3. Attach monitor to the test agent.
4. Send a campaign call with `npm run rc:live-monitor:test-call`.
5. Confirm packets/bytes increase.
6. Confirm event gate opens.
7. Confirm Realtime-2 sleeps initially.
8. Start coaching manually or wait for the delay.
9. Say prospect-only scripted lines.
10. Confirm guidance appears in the big center panel.

### Hold Gate Test

1. Let the monitor hear "please continue to hold".
2. Confirm status moves to hold/sleep.
3. Confirm chunks are dropped while sleeping.
4. Confirm it checks again after the recheck interval.
5. Confirm generic hold/system audio does not set `acceptInput=false` unless exact phrase is present.

### Two-Person Speaker Test

1. Put an agent and prospect in the same live call.
2. Have the agent follow some model suggestions and ignore others.
3. Confirm the model can:
   - respond to prospect statements
   - avoid responding to its own prior suggestion repeated by the agent
   - give agent feedback only when useful
   - wait through irrelevant chatter

### Cost Test

1. Run a 5-minute coached call.
2. Export `realtime-direct-coach.ndjson`.
3. Sum input/output usage when present.
4. Compare cost against:
   - Realtime-2 direct
   - 4o-transcribe + 4o-mini splitter + Sonnet
   - Sonnet-only text coach after STT

### Multi-Agent Test

1. Run monitors for at least two agents.
2. Emit or receive separate `cx.call.placed` events.
3. Confirm each monitor only opens for its configured agent email/extension id.
4. Confirm one agent's hold prompt does not pause another agent.
5. Confirm each UI shows the right call state.

## Monday Implementation Adjustments

- Promote the useful pieces from the one-off script into a manager/service shape.
- Keep the one-off script as the science harness.
- Add clean per-call cost and token/usage summaries.
- Make event-gated mode the normal path.
- Make hold/sleep state obvious in the production UI.
- Add a production-safe monitor assignment map:
  - agent -> monitor extension
  - agent email/extension id -> event gate
  - monitor SIP device -> RingEX softphone session
- Make attach retry behavior more deliberate:
  - wrong state
  - no active call
  - already attached
  - agent unavailable
- Add a simple "call coach session" record so each coached call has a durable trace.
- Decide whether the production UI shows any transcript snippets or only signal/direction.

## Questions To Resolve

- Is the first automatic listen point 2 minutes or 3 minutes after `cx.call.placed`?
- Should manual start override the initial delay for that call, or only enable the gate while keeping the delay? Current behavior keeps the delay logic tied to the call event.
- Should exact hold phrase sleep be 120 seconds, 180 seconds, or adaptive?
- Should `AGENT_FEEDBACK` appear in the same UI slot as proposed response, or a smaller separate warning state?
- How often should the compact summary update: 120 seconds, 180 seconds, or only after meaningful turns?
- Do we keep Realtime-2 as the primary lane, or keep the three-model lane as a fallback for cost/quality comparison?

## Known Useful Commands

Start the current best local coach lane:

```powershell
npm run rc:live-monitor:coach:realtime2 -- --event-gated --agent-ext 101 --supervisor-ext 987 --dashboard-port 7332
```

Send a test campaign call and emit matching gate event:

```powershell
npm run rc:live-monitor:test-call
```

Emit only a synthetic gate event:

```powershell
npm run rc:live-monitor:synthetic-event
```

Open dashboard:

```text
http://127.0.0.1:7332/
```

## Bottom Line

The science path is alive. We have audio capture, event gating, hold sleep/recheck, streaming UI, a tax-sales playbook, and a Realtime-2 direct coach that can output guidance without paying to display full transcripts.

The hard remaining question is not "can we hear audio"; it is whether we can infer speaker/intent fast enough from mixed monitor audio to make the guidance trustworthy, useful, and cheap enough before RingCX gives us isolated streaming.
