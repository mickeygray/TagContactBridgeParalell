# CX 0.2 Alpha Test Observability Rubric

Date: 2026-06-29

Purpose: give tomorrow's alpha test a concrete thumbs-up / thumbs-down checklist. The rule is simple: do not guess from the UI alone. Every test observation should be grounded in one of these logs, health checks, or Mongo/RingCX state checks.

## Quick Start

Start the local app stack first, then start the alpha monitor:

```powershell
node scripts\alpha-test-monitor.js --interval-ms 5000
```

The monitor writes JSONL under:

```text
C:\code\TagContactBridgeParalell\runtime\alpha-test-monitor\
```

For the coach/gRPC test route, the expected public split is:

```text
tag-webhook.ngrok.app                 -> local app/control-plane on 5001
bethel-twee-agonisedly.ngrok-free.dev -> local gRPC bridge on 3344
RingCX Workflow Studio URL            -> grpc://bethel-twee-agonisedly.ngrok-free.dev:443
```

## Master Evidence Map

| Surface | Primary log/check | What it proves |
| --- | --- | --- |
| Whole app | `runtime\logs\control-plane.local.out.log`, `http://127.0.0.1:5001/health` if available, `http://127.0.0.1:5001/api/client/runtime` | Control plane is serving API/client runtime |
| Web client | `runtime\logs\vite-3001.out.log`, browser console/network | UI is built and fetching expected APIs |
| Inbound gateway | `runtime\logs\inbound-gateway.local.out.log`, `http://127.0.0.1:4001/health` | Incoming lead/intake routes are alive |
| RingCX service | `runtime\logs\ringcentral-cx.local.out.log`, `http://127.0.0.1:6101/health` | CX API bridge/poller is alive |
| AI bus | `runtime\alpha-cutover\ai-bus-7000-safe.out.log`, `http://127.0.0.1:7000/health` | AI service is alive and provider flags are visible |
| gRPC bridge | `runtime\live-coach-grpc-bridge\events.ndjson`, `runtime\alpha-cutover\grpc-bridge-3344.out.log` | RingCX streaming reaches local bridge |
| ngrok | `http://127.0.0.1:4040/api/tunnels`, `http://127.0.0.1:4041/api/tunnels`, `runtime\ngrok-dev-grpc\*.log` | Public routes point to the intended local ports |
| Alpha aggregate | `runtime\alpha-test-monitor\alpha-test-monitor-*.jsonl` | One timeline for ports, health, ngrok, and new gRPC events |
| Legacy/live reference | Live service logs on Linux plus Mongo records | Confirms whether a bug is new alpha behavior or existing live behavior |

## 1. Stack And Tunnel Readiness

Thumbs up:

- `3001`, `4001`, `5001`, `6101`, `7000` are listening.
- If coach streaming is being tested, `3344` and ngrok admin `4041` are listening.
- `tag-webhook.ngrok.app` returns `200` for `/login`, `/cx`, and `/api/client/runtime`.
- `bethel-twee-agonisedly.ngrok-free.dev` appears in ngrok tunnels pointing to `http://localhost:3344`.

Thumbs down:

- Any required port is down in `alpha-test-monitor`.
- `tag-webhook` points to `3344` instead of `5001`, or `bethel` points to the app instead of gRPC.
- Public route returns `404/503` during setup.

Action:

- Do not start agent testing until the route split is correct.
- If only coach is failing, keep CX testing alive and mark coach/gRPC as blocked separately.

Useful commands:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3001,4001,5001,6101,7000,3344,4040,4041
Invoke-RestMethod http://127.0.0.1:4040/api/tunnels
Invoke-RestMethod http://127.0.0.1:4041/api/tunnels
```

## 2. Login And Workspace Load

Thumbs up:

- Agent can log in and land on the expected CX workspace mode.
- `/api/client/runtime` returns `200`.
- Workspace read calls return `200` and include the expected agent/domain/mode.
- No repeated `500` around `/api/read/cx/workspace/...`.

Thumbs down:

- Login succeeds but workspace mode is wrong.
- Workspace read returns stale lead data from another mode or another agent.
- Browser shows a working UI while server logs show repeated failed workspace refreshes.

Action:

- Stop before dialing. A wrong workspace/mode contaminates the rest of the test.
- Check `control-plane.local.out.log` and browser network for the first failing route.

## 3. Queue Build, Persistence, And Filtering

Thumbs up:

- Queue rows are built from the intended source pool only.
- Bulk mode does not bleed random live-inserted leads into the active batch.
- Client/prospect filters keep existing clients out of call queues.
- Wrong-domain case data does not overwrite the middle card or queue row.
- Queue rows retain stable identifiers: domain, caseId, leadCadenceId, phone, campaign/route ids, externalId/actionKey when present.

Thumbs down:

- A client appears in a call queue.
- A test Mickey/First Last leaks into another active agent's real queue.
- A lead appears visually in the queue but has no matching RingCX upload/accepted evidence.
- Current card is enriched by phone lookup before the active UII identifies the call.

Action:

- Treat client leakage or cross-agent leakage as a stop-the-test issue.
- For wrong visual enrichment, capture the row and UII, then verify whether it came from queue build or current-call projection.

Evidence:

- `runtime\logs\control-plane.local.out.log`
- `runtime\logs\ringcentral-cx.local.out.log`
- Mongo queue/session/lead cadence rows
- Bulk session state in the app API response

## 4. RingCX Lead Upload

Thumbs up:

- Preload/upload happens one row at a time where required.
- Each send waits for RingCX acceptance before the next send.
- Accepted rows keep their local identity and are not renumbered incorrectly.
- Upload ordering matches the intended queue strategy for the chosen campaign mode.
- No `400 invalid phone`, `429`, or route-lock rejection storms.

Thumbs down:

- UI says a lead is queued but RingCX never received/accepted it.
- RingCX order is surprising and there is no accepted-result evidence to reconcile it.
- `429` during upload or call download causes the UI session to pause/cancel.
- Test names or case IDs start at the wrong number due to stale fixtures.

Action:

- If upload acceptance is not deterministic, stop testing buttons; queue state is untrustworthy.
- For `429`, separate call-log/download rate limits from active-call poller limits.

Evidence:

- `ringcentral-cx.local.out.log`
- Alpha monitor health rows
- RingCX campaign/lead API responses written by test scripts

## 5. Active Call Watcher / Current Call Projection

Thumbs up:

- On a RingCX UII change, the app middle section changes to the matching active call quickly.
- The queue removes or marks only the lead that became current.
- The previous current call stays visible until a new active UII is actually detected.
- Polling sees account/campaign active calls without per-agent duplicate polling explosions.
- Unmatched active calls are logged with enough data to debug, not silently ignored.

Thumbs down:

- The middle section advances ahead of RingCX.
- RingCX dials lead A while the app shows lead B.
- Buttons disappear because the app has no current UII even though RingCX is on a call.
- A released/stale lead remains stuck as current after the watcher sees a newer UII.

Action:

- This is the core of bulk. If projection is wrong, stop and inspect current-call watcher logs plus queue state before continuing.

Evidence:

- `ringcentral-cx.local.out.log`
- Bulk runtime logs in `control-plane.local.out.log`
- `alpha-test-monitor` rows showing health during the mismatch
- Mongo agent/session current-call state

## 6. Middle Card And Button State

Thumbs up:

- Buttons are enabled only when there is a confirmed current call/UII.
- Clicking an outcome sends the intended RingCX disposition/terminal command.
- The old call does not visually disappear just because a button was clicked.
- The old call remains actionable during RingCX's configured between-call delay.
- The middle card releases only when the watcher sees the next active UII or the session is explicitly stopped.

Thumbs down:

- Clicking a button ejects the middle card before RingCX advances.
- Buttons are missing during a real active call.
- No Answer/Voicemail/DNC do not map 1:1 to the expected RingCX disposition.
- DNC or appointment wrap stalls the agent in an unavailable state.

Action:

- Capture button clicked, UII, RingCX disposition response, and next watcher event.
- Do not add client-only tricks if the correct failure is in terminal command ordering.

Evidence:

- Browser network for the button route
- `control-plane.local.out.log`
- `ringcentral-cx.local.out.log`
- Bulk terminal/outbox records

## 7. Refill Behavior

Thumbs up:

- Refill has one clear trigger point.
- Refill starts when available pending count crosses the configured threshold.
- Only one refill can be in flight for an agent/session.
- New rows append after RingCX accepts them.
- The app never gets stuck with exactly one replacement lead when it should load a full replenishment set.

Thumbs down:

- Queue visually refills but RingCX campaign does not.
- Refill consumes from the wrong pool or pulls client/test rows.
- Refill repeatedly fires because the count remains under threshold while an upload is already in flight.
- A slow/slacking agent owns a slice of first-touch leads indefinitely.

Action:

- Inspect pending count before and after each active UII transition.
- Confirm refill source pool and accepted upload count before continuing.

Evidence:

- Bulk session state
- `ringcentral-cx.local.out.log`
- Mongo pending/refill state
- First-touch sweep logs when enabled

## 8. Terminal Drain And Outcome Counting

Thumbs up:

- Every call with a UII eventually gets one terminal/outcome record or a deliberate deferred review record.
- Button-generated terminal events and auto-advance terminal events flow into one drain/outbox shape.
- The drain writes Mongo cadence/count updates once per UII.
- No Answer and Voicemail count consistently where they are equivalent for cadence.
- DNC and appointment outcomes preserve the extra work needed for Logics.

Thumbs down:

- Calls with UII end without entering terminal buffer/drain.
- The drain and immediate event path both count the same call.
- Calls under auto-advance are never counted because no button was clicked.
- Calls are counted without UII evidence.

Action:

- Prefer "UII evidence first, outcome second."
- If outcome is missing after a timeout, default no-contact/no-answer only through the drain, not in the live poll loop.

Evidence:

- Terminal/outbox Mongo collection
- Lead cadence communication/count fields
- `control-plane.local.out.log`
- Hourly call-log reconciliation output if run

## 9. DNC, Appointment, And Logics Work

Thumbs up:

- DNC writes happen through the dedicated Logics-facing path, not through queue enrichment.
- Appointment flow puts the agent into a working/not-available state only when necessary.
- Appointment submit returns the agent to available/off-hook state when appropriate.
- Interview/call summary/logics activity writes are queued or drained outside the latency-critical current-call watcher.
- Partial failures return structured step results instead of throwing away the whole wrap result.

Thumbs down:

- Logics case lookup changes the middle card identity.
- Appointment submit fails terminal handling and hides the partial result.
- Agent remains unavailable after appointment/DNC.
- Logics activity failures block the next call loop.

Action:

- Keep Logics writes off the immediate RingCX watcher path.
- Check step-level result objects for terminal/workbench/assign/postdate/activity writes.

Evidence:

- `control-plane.local.out.log`
- Logics activity review logs
- Appointment/wrap route responses
- Mongo communication array / lead cadence communications

## 10. Coach And gRPC Streaming

Two separate judgments are required.

### Transport

Thumbs up:

- `events.ndjson` shows `stream.start`, `dialogInit`, two `segmentStart` events, media frames, and `stream.end`.
- `dialog.attributes.uii` is present.
- The stream metadata includes `x-forwarded-host: bethel-twee-agonisedly.ngrok-free.dev`.
- Real gRPC smoke passes:

```powershell
node scripts\ringcx-grpc-stream-smoke-client.js --target grpc://bethel-twee-agonisedly.ngrok-free.dev
```

Thumbs down:

- RingCX creates no `stream.start`.
- Only smoke events appear, no real `dialogInit` from RingCX.
- Streams start but never end or never include media.

### Coach/STT

Thumbs up when coach is intentionally off:

- `coach.kill_switch.active` appears.
- AI bus health may show zero sessions.
- This is acceptable only when the test goal is CX mechanics, not live coach guidance.

Thumbs up when coach is intentionally on:

- No `coach.kill_switch.active`.
- No repeated `stt.realtime.error` / `connect_error`.
- AI bus `/health` is OK and live coach sessions/events increase.
- Agent/prospect transcript or summary events reach the coach UI.

Thumbs down:

- Transport works but STT errors repeat after credits/model access are restored.
- Coach sessions are created but never receive segment input.
- gRPC stream is accepted but UII/call binding never resolves.

Action:

- Do not conflate gRPC transport success with coach success.
- If OpenAI credits are off, mark coach as intentionally blocked and keep CX test going.

Evidence:

- `runtime\live-coach-grpc-bridge\events.ndjson`
- `runtime\alpha-cutover\grpc-bridge-3344.out.log`
- `runtime\alpha-cutover\ai-bus-7000-safe.out.log`
- `http://127.0.0.1:7000/health`

## 11. Live-To-Local First Contact Forward

Only judge this if the forward envs are explicitly enabled.

Thumbs up:

- Live 4001 logs show forward attempt after queueing the first-contact request.
- Local receiver returns `200`.
- Payload is a wake/notification only; no duplicate lead creation locally.
- Intake path continues even if forward fails.

Thumbs down:

- Forward route is enabled before local receiver is loaded.
- Forward failure blocks live intake.
- Local side creates duplicate queue rows from the forwarded notification.

Action:

- Keep this dormant unless specifically testing it.
- If enabled, restart only live 4001 after envs are set.

Evidence:

- Live `parallel-inbound-gateway` logs
- Local `runtime\logs\inbound-gateway.local.out.log`
- Local `/api/inbound/cx-first-contact-forward` response

## 12. Failure Classes And Test Decisions

Stop the test immediately:

- Client/prospect appears in a dial queue.
- Wrong agent receives another agent's lead.
- RingCX dials one lead while the app confidently shows another and does not self-correct on next watcher tick.
- Button route writes an outcome to the wrong UII/case.
- Refill uploads a real floor agent's leads into the wrong campaign.

Continue but flag:

- Coach/STT unavailable because credits/kill switch are intentionally off.
- One-off RingCX `429` from call download if active-call watcher remains healthy.
- UI cosmetic queue count flicker if current card and UII remain correct.
- A Logics activity write fails but terminal/count drain still persists locally for retry.

Watch for recurrence:

- Agent becomes unavailable after certain dispositions.
- DNC takes materially longer than other terminal buttons.
- Auto-advance calls create no immediate button window.
- First-touch leads age because one assigned agent is not working their slice.

## 13. End-Of-Test Shutdown Checklist

Thumbs up:

- Test-only ngrok tunnels are stopped.
- gRPC bridge is stopped if not actively being tested.
- Alpha monitor is stopped after saving JSONL.
- Core local services are left only if still needed.
- Live 4001 forward remains disabled unless intentionally left on.

Commands:

```powershell
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match 'alpha-test-monitor|bethel-twee-agonisedly|tag-webhook.ngrok.app|ringcx-grpc-live-coach-bridge|tag-webhook-front-proxy'
} | Select-Object ProcessId,Name,CommandLine
```

Expected after shutdown:

```text
3344 down
3345 down
4040/4041 down unless another ngrok tunnel is intentionally running
tag-webhook/bethel no longer serving from this machine
```

## Short Daily Verdict Template

Use this at the end of each alpha block:

```text
Date/time:
Agent(s):
Mode:

Stack/tunnels: UP / DOWN
Login/workspace: PASS / FAIL
Queue build/filter: PASS / FAIL
RingCX upload: PASS / FAIL
Current-call watcher: PASS / FAIL
Buttons/terminal: PASS / FAIL
Refill: PASS / FAIL
Drain/counting: PASS / FAIL
DNC/appointment/Logics: PASS / FAIL
Coach gRPC transport: PASS / FAIL / NOT TESTED
Coach/STT/AI: PASS / FAIL / INTENTIONALLY OFF

Stop-test issues:
Flagged but non-blocking:
Exact log files used:
Next fix:
```
