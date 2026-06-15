# CX Voicemail Drop Issues and Logging

Last updated: 2026-06-15

This note summarizes the voicemail-drop problems we worked through, the current intended flow, and the logging that was added so the next failure can be diagnosed from server logs instead of guesswork.

## Current Intended Flow

The production path is now disposition-based, not barge-based.

1. Agent clicks the voicemail button in the CX workspace.
2. Control plane receives `POST /api/commands/cx/:domain/voicemail-drop`.
3. The server resolves the authenticated agent to a fixed voicemail disposition.
4. The server looks up the live RingCX UII from active calls, using prospect phone first and agent name as fallback.
5. The server calls RingCX `dispositionCall(uii, { disposition, callback: false })`.
6. RingCX completes the agent side of the call and cold-transfers the prospect/voicemail leg to the agent's monitor/message extension.
7. `parallel-vm-answerer` answers the monitor extension, plays that agent's recording, and hangs up.

Relevant files:

- `packages/shared-services/src/cxVoicemailDropService.js`
- `apps/control-plane/src/routes/commandsCx.js`
- `apps/control-plane/src/server.js`
- `scripts/vm-theme-answerer.js`
- `scripts/systemd/parallel-vm-answerer.service`
- `packages/shared-services/src/voicemailServingService.js`

## Issues We Found

### 1. Barge Mode Was Too Fragile

The original approach tried to pre-warm or arm a headless monitor and then barge into the live call quickly enough to play audio. It failed in several ways:

- Sometimes the monitor did not attach fast enough.
- Sometimes the app reported "unable to confirm barge and release."
- There was a risk of barge firing at the wrong time because arm/warm state lived outside the actual voicemail button click.
- Monitor registration and JWT ownership were confusing: a shared token or stale softphone binding could make the wrong extension answer, or no extension answer.
- If the monitor extension did not answer, RingCentral could roll to its own generic voicemail instead of our intended message.

The barge path still exists as a fallback behind `CX_VOICEMAIL_DROP_MODE=barge`, but it should not be the normal floor path.

### 2. Disposition Timeout Caused Queue Stall and Flicker

The stamped VM dispositions inherited `timeout: 300`, while Auto Dispo used `timeout: 1`.

Effect:

- VM drop could leave the agent in a long "dispositioning" window.
- Dial executor saw `agent-ineligible:activity-dispositioning`.
- Agent screens flickered or appeared to swap people while RingCX caught up.

Fix direction:

- All `VM DROP*` dispositions should use `timeout: 1`.
- See `scripts/rcx-vm-dispositions-timeout-fix.js`.

### 3. The Client Still Had Barge-Era Reflexes

In disposition mode, warm/arm/release are no longer required. The server now no-ops those actions, but the old client choreography was still sending unnecessary round trips:

- warm on serve,
- arm at ring,
- release on call end.

Current desired client behavior:

- Voicemail button sends exactly one meaningful request: the drop/disposition.
- No theme picker for normal agents.
- The agent's identity determines the disposition.
- After the button succeeds, the app should proceed like a disposition/no-answer path with enough pacing for RingCX to settle.

### 4. Monitor Extension Answering Was Inconsistent

We saw cases where the RingCX transfer reached a monitor/message extension but did not reliably play the intended message.

Likely causes we investigated:

- Monitor softphone not registered.
- Headless SIP/OtherPhone binding lost or stolen by another process.
- Transfer rolling to RingCentral's generic voicemail.
- Announcement-only extension behavior not matching the softphone answering setup.
- `parallel-barge` and the VM answerer competing for the same registration if both warm the same devices.

Current answerer direction:

- `parallel-vm-answerer` owns the monitor extension SIP registrations.
- It should run continuously under systemd.
- `parallel-barge` should not also warm/register those same devices.
- The service expects per-agent raw audio under `runtime/audio/voicemails/`.

### 5. 429 / Limit Errors Need Better Evidence

We saw agent reports like "you have reached a limit" when clicking voicemail, including at least one case where the agent had not dialed much. That could be:

- RingCX API rate limiting,
- campaign/disposition throttling,
- a stale active-call lookup causing repeated attempts,
- or a tenant/account-level constraint.

The important change is that failures now log the RingCX/provider response summary, retry metadata, rate limit headers if present, and a request id.

### 6. Drop.co RVM Is Separate

The Drop.co/ringless voicemail path is a separate outbound/cadence concern. It should not be confused with the live CX agent voicemail button.

Live CX button:

- agent is on a RingCX call,
- button dispositions that live UII,
- RingCX transfers the prospect leg to a monitor extension.

Drop.co RVM:

- posts a phone number and campaign token to Drop.co,
- has DNC/queue/audio-url concerns,
- does not resolve a live RingCX UII.

## Logging Added

### Route-Level Logging

File: `apps/control-plane/src/routes/commandsCx.js`

The `/voicemail-drop` route now creates a `requestId` for every click and logs:

- `cx.voicemail_drop.request`
- `cx.voicemail_drop.completed`
- `cx.voicemail_drop.failed`

Fields logged:

- request id,
- domain,
- masked user email,
- user role,
- action (`play`, `warm`, `arm`, `release`),
- case id,
- queue item id,
- prospect phone last 4 only,
- elapsed milliseconds,
- result mode,
- disposition name,
- UII,
- active-call match method,
- skipped/no-op state,
- sanitized error details on failure.

The logger is wired from control plane in `apps/control-plane/src/server.js`.

### Service-Level Logging

File: `packages/shared-services/src/cxVoicemailDropService.js`

The service now logs the actual decision points:

- `cx.voicemail_drop.resolve_agent.start`
- `cx.voicemail_drop.resolve_agent.result`
- `cx.voicemail_drop.active_calls.failed`
- `cx.voicemail_drop.active_calls.matched`
- `cx.voicemail_drop.active_calls.no_match`
- `cx.voicemail_drop.disposition.start`
- `cx.voicemail_drop.disposition.succeeded`
- `cx.voicemail_drop.disposition.failed`
- `cx.voicemail_drop.control.skipped`

Important details:

- Full phone numbers are not logged; only last 4.
- Emails are masked.
- Provider response bodies are summarized, not dumped.
- Errors include status, method/path when available, retry-after, rate-limit group/window/remaining when available, and provider error codes/messages.
- `warm`, `arm`, and `release` are logged as skipped/no-op in disposition mode.

### Active-Call Matching Logs

The UII resolver now logs whether the live call was found by:

- phone match,
- agent-name match,
- or no match.

On no match, it logs a small sanitized sample of active rows:

- UII,
- call state,
- ANI/DNIS last 4,
- matched agent name.

This is the key log to distinguish:

- button fired but RingCX had no matching live call,
- button fired against wrong agent/call,
- or call already ended before the click reached the server.

### Disposition Logs

Before calling RingCX:

- log UII,
- disposition,
- drop key/label,
- match method,
- agent name.

After calling RingCX:

- success logs `cx.voicemail_drop.disposition.succeeded`;
- failure logs `cx.voicemail_drop.disposition.failed` with sanitized provider detail.

The service explicitly sends `callback: false`; omitting this caused RingCX `400 invalid.data`.

### Monitor Extension Logs

`parallel-vm-answerer` is expected to be the source of truth for whether the transferred call was actually answered and audio played.

Useful journal streams:

```bash
journalctl -u parallel-control-plane -f
journalctl -u parallel-vm-answerer -f
```

Search patterns:

```bash
cx.voicemail_drop.
active_calls.no_match
disposition.failed
disposition.succeeded
INVITE
ANSWERED
registrationError
platform auth in backoff
```

## Manual Audit Scripts Used / Created

Read-only campaign disposition audit:

```bash
node scripts/rcx-vm-drop-audit.js
```

Checks active campaigns and lists `VM DROP*` dispositions with id, transfer flag, destination, and timeout.

Timeout repair:

```bash
node scripts/rcx-vm-dispositions-timeout-fix.js
```

Sets `VM DROP*` disposition timeout to `1`.

Transfer toggle:

```bash
node scripts/rcx-vm-dispositions-xfer-toggle.js off
node scripts/rcx-vm-dispositions-xfer-toggle.js on
```

Safe emergency lever: with transfer off, the disposition still completes the agent side, but does not transfer the prospect leg to the answerer.

Monitor extension call-log check:

```bash
node scripts/rc-vm-ext-call-log.js 8
```

Pulls recent RingCentral call logs for the monitor DIDs/extensions so we can see whether transfers are reaching the expected message extensions and whether they are answered/missed.

## Triage Map For The Next Failure

### No `cx.voicemail_drop.request`

The app button did not reach control plane.

Check:

- client route/button wiring,
- auth/session,
- permission `queue.dispose`,
- browser/network error.

### Request Logged, Then `active_calls.no_match`

The server could not find the live RingCX UII.

Check:

- did the call already end,
- did the client send the right prospect phone,
- did RingCX active calls include this agent,
- did the agent name fallback point to the wrong person,
- are active call rows delayed/stale.

### `disposition.failed` With 400

Likely request shape or RingCX disposition config.

Known gotcha:

- `callback: false` is required on `dispositionCall`.

Check:

- disposition name exists on that active campaign,
- UII is valid,
- action is allowed for the current call state.

### `disposition.failed` With 429 / Limit

Likely RingCX or RingCentral rate/usage limiting.

Check logged fields:

- `retryAfter`,
- rate limit group,
- remaining/window,
- whether a circuit was opened,
- whether repeated clicks are retrying too aggressively.

### `disposition.succeeded`, But No Voicemail Plays

The app/RingCX disposition worked; the failure is downstream in transfer/answering.

Check:

- `rc-vm-ext-call-log.js`,
- `parallel-vm-answerer` journal,
- monitor extension registration,
- whether the transfer rolled to RingCentral generic voicemail,
- audio file exists under `runtime/audio/voicemails/`,
- answerer is not fighting another service for the same softphone binding.

### `disposition.succeeded`, Voicemail Plays, But App Flickers

The telephony path worked; the issue is CX/app pacing.

Check:

- disposition timeout is `1`,
- client is not immediately optimistic-swapping to a stale served item,
- no-answer/voicemail paths use the same paced next-lead transition,
- queue state is not being rewritten by stale EX/CX state reconciliation.

## Open Follow-Ups

- Add a small admin view for recent voicemail-drop attempts keyed by `requestId`.
- Add a counter/alert for `disposition.failed` grouped by status and disposition.
- Add explicit answerer metrics: registered extensions, last INVITE, last answered, last played, last registration error.
- Remove or permanently hide barge-era warm/arm/release calls from the client in disposition mode.
- Keep `rcx-vm-dispositions-xfer-toggle.js off` as the emergency safe-mode lever.
- Decide whether `RC_CX_EX_BUSY_GATE_ENABLED` should remain separate from voicemail-drop flow; it should not determine CX call state.
