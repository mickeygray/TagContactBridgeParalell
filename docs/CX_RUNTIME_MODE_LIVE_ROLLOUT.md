# CX Runtime Mode Live Rollout

Purpose: test removal of EX-era artifacts from CX lead serving without guessing during floor hours.

## 4 PM Test Script

Goal: run four controlled restart windows, about 10 minutes each, so every change has its own logs. Do not stack multiple new ideas in one restart unless the prior window is clearly stable.

### Window 0: Baseline Snapshot

Time: 3:55 PM to 4:00 PM.

No restart.

Capture current counters before changing anything:

```bash
journalctl -u parallel-ringcentral-cx --since "10 minutes ago" --no-pager \
  | grep -E 'session_mismatch|status_updated|poll.reconciled|agent-ineligible|ringcx.offhook|cx.login.trace|auth.verify_code.timing'
```

Record:

- `session_mismatch` count
- `status_updated` / poll reconcile chatter
- `agent-ineligible:ex-busy`
- any active desync reports from the floor

### Restart 1: Login Thinning

Time: 4:00 PM to 4:10 PM.

Environment:

```bash
CX_LOGIN_THIN_ENABLED=true
CX_LOGIN_TRACE_ENABLED=true
```

Restart:

```bash
sudo systemctl restart parallel-control-plane
```

Watch:

```bash
journalctl -u parallel-control-plane --since "10 minutes ago" --no-pager \
  | grep -E 'cx.login.trace|auth.verify_code.timing|ringcx.offhook.self_heal.async'
```

Pass:

- `auth.verify_code.timing` shows `loginThinEnabled=true`.
- `cx.login.trace` shows `otp-verify` timing from `start` through `response.ready`.
- login response is not waiting on `ringcxOffhookSelfHealMs`.
- async off-hook completion/failure logs appear separately.
- no agent loses ability to enter the CX workspace.

Fail / rollback:

```bash
CX_LOGIN_THIN_ENABLED=false
sudo systemctl restart parallel-control-plane
```

### Restart 2: EX Poll Observe-Only

Time: 4:10 PM to 4:20 PM.

Environment:

```bash
CX_LOGIN_THIN_ENABLED=true
CX_LOGIN_TRACE_ENABLED=true
CX_CALL_TRACE_ENABLED=true
RC_CX_EX_PRESENCE_POLL_MODE=observe-only
RC_CX_EX_DECOUPLE_ENABLED=true
RC_CX_EX_POLL_CX_WRITE_MODE=cx-owned
# RC_CX_RUNTIME_MODE unset
```

Restart:

```bash
sudo systemctl restart parallel-control-plane
sudo systemctl restart parallel-ringcentral-cx
```

Watch:

```bash
journalctl -u parallel-ringcentral-cx --since "10 minutes ago" --no-pager \
  | grep -E 'presence_poller.started|cx.call.trace|observe_only|session_mismatch|status_updated|poll.reconciled'

journalctl -u parallel-control-plane --since "10 minutes ago" --no-pager \
  | grep -E 'cx.login.trace|auth.verify_code.timing|ringcx.offhook.self_heal.async'
```

Pass:

- startup says `exPresencePollMode=observe-only`, `exCxDecoupleEnabled=true`, and `exCxPollWriteMode=cx-owned`.
- `cx.call.trace` appears at lifecycle pinch points with the UII/session identity each layer believes it holds.
- `ringcentral.ex.poll.observe_only_*` may appear, but `ringcentral.ex.poll.status_updated` and `ringcentral.ex.poll.reconciled` should stop coming from the poller.
- `ringcentral.ex.poll.observe_only_tick` appears every poll cycle with `changed:0`, `observed`, and `observedReasons` showing how much work was suppressed and why.
- login timing shows `loginThinEnabled=true` and off-hook repair, if needed, completes asynchronously.
- `cx.login.trace` breaks out OTP, OAuth callback, OAuth refresh, RingCentral exchange, RingCX exchange, token-store, and off-hook repair timing without logging OTPs or tokens.
- `session_mismatch`/screen flicker materially drops.
- app/CX person mismatch does not reproduce during a few real calls.

Safety net to watch:

- During observe-only, the EX poller is **not** allowed to repair stuck `onCall`, `ringing`, `disposition`, or `session_mismatch` states. That is the point of the causality test.
- The active safety net for the hour is the CX/UII/disposition path: valid RingCX call events and agent button submissions should still release and advance calls.
- `cx.call.trace` should show the same call identity flowing through `ringcx-dial.execution.*`, `ringcx-monitor.mark-active.*`, and release/clear events. A new UII replacing an old one without a terminal/release trace is the smell we are hunting.
- If `observedReasons` repeatedly shows `observe_stuck_oncall`, `observe_stuck_ringing`, or `observe_stuck_disposition`, the old poller safety net is being asked to repair real stuck state. Roll back to write mode or run a targeted repair before agents pile up.
- If `observedReasons` mostly shows `observe_session_mismatch` while the UI is stable, that is strong evidence the poller was the desync source and observe-only is doing its job.

Fail:

- agents stop being recognized as ready/available even though RingCX is dialing correctly.
- current call is stranded after a valid disposition.
- rollback to write mode:

```bash
RC_CX_EX_PRESENCE_POLL_MODE=write
RC_CX_EX_POLL_CX_WRITE_MODE=cx-owned
sudo systemctl restart parallel-ringcentral-cx
```

### Restart 3: CX-Only Runtime

Time: 4:20 PM to 4:30 PM.

Environment:

```bash
CX_LOGIN_THIN_ENABLED=true
CX_LOGIN_TRACE_ENABLED=true
CX_CALL_TRACE_ENABLED=true
RC_CX_EX_PRESENCE_POLL_MODE=observe-only
RC_CX_EX_DECOUPLE_ENABLED=true
RC_CX_EX_POLL_CX_WRITE_MODE=cx-owned
RC_CX_RUNTIME_MODE=cx-only
```

Restart:

```bash
sudo systemctl restart parallel-ringcentral-cx
```

Watch:

```bash
journalctl -u parallel-ringcentral-cx --since "10 minutes ago" --no-pager \
  | grep -E 'presence_poller.started|cx.call.trace|observe_only|cx_owned_preserved|session_mismatch|status_updated|poll.reconciled'

journalctl -u parallel-control-plane --since "10 minutes ago" --no-pager \
  | grep -E 'cx.login.trace|auth.verify_code.timing|ringcx.offhook.self_heal.async'
```

Pass:

- startup says `cxRuntimeMode=cx-only`, `exPresencePollMode=observe-only`, and `exCxPollWriteMode=cx-owned`.
- login trace still shows the response is not waiting on off-hook repair.
- no `agent-ineligible:ex-busy` deferrals for CX agents.
- CX-held calls stay on the correct agent/lead.
- active CX calls still prevent that same agent from receiving another lead.

Fail:

- active CX calls stop blocking new leads.
- current call is stranded after a valid disposition.
- rollback to Restart 2 settings by clearing `RC_CX_RUNTIME_MODE`.

### Restart 4: CX-Only Runtime + Clean Object Facade

Time: 4:30 PM to 4:40 PM.

Use only if the clean active-dial facade is implemented and smoke-checked locally. If it is not ready, stop after Restart 3 and keep observing.

Environment:

```bash
CX_LOGIN_THIN_ENABLED=true
CX_LOGIN_TRACE_ENABLED=true
CX_CALL_TRACE_ENABLED=true
RC_CX_RUNTIME_MODE=cx-only
RC_CX_EX_PRESENCE_POLL_MODE=observe-only
RC_CX_EX_DECOUPLE_ENABLED=true
RC_CX_EX_POLL_CX_WRITE_MODE=cx-owned
```

Restart:

```bash
sudo systemctl restart parallel-control-plane
sudo systemctl restart parallel-ringcentral-cx
```

Client build: required if the UI is rendering the clean active-dial object or updated fresh-lead gate labels.

Watch:

```bash
journalctl -u parallel-control-plane --since "10 minutes ago" --no-pager \
  | grep -E 'activeDial|freshLeadGate|exArtifactsSuppressed|agent-ineligible|cx.login.trace|auth.verify_code.timing'

journalctl -u parallel-ringcentral-cx --since "10 minutes ago" --no-pager \
  | grep -E 'presence_poller.started|cx_owned_preserved|session_mismatch|status_updated'
```

Pass:

- startup says `cxRuntimeMode=cx-only` and `exCxPollWriteMode=cx-owned`.
- no `agent-ineligible:ex-busy` deferrals for CX agents.
- `freshLeadGate.exArtifactsSuppressed=true` appears only when suppressing stale EX artifacts.
- the client displays the clean current object and does not locally restore/juggle stale leads.
- old plumbing still dials/dispositions underneath.

Fail / rollback:

```bash
RC_CX_RUNTIME_MODE=
RC_CX_EX_POLL_CX_WRITE_MODE=cx-owned
sudo systemctl restart parallel-control-plane
sudo systemctl restart parallel-ringcentral-cx
```

If still broken, roll all the way back:

```bash
CX_LOGIN_THIN_ENABLED=false
RC_CX_RUNTIME_MODE=
RC_CX_EX_PRESENCE_POLL_MODE=write
RC_CX_EX_POLL_CX_WRITE_MODE=legacy
RC_CX_EX_DECOUPLE_ENABLED=false
sudo systemctl restart parallel-control-plane
sudo systemctl restart parallel-ringcentral-cx
```

## If The Test Is Green: Patch Checklist

Use this only after the floor has made enough real calls to prove that:

- no app/CX person mismatch reproduced,
- no lead advances while a different UII is still active,
- `session_mismatch` and flicker materially dropped,
- valid dispositions still release exactly once,
- login timing is improved or at least no worse,
- no agent is stranded in `claimed`, `disposition`, or unavailable state.

### 1. Freeze The Observed Good Flags

Set only the flags that were proven during the windows. If Restart 3 is green, preferred operating state is:

```bash
CX_LOGIN_THIN_ENABLED=true
CX_LOGIN_TRACE_ENABLED=true
CX_CALL_TRACE_ENABLED=true
RC_CX_RUNTIME_MODE=cx-only
RC_CX_EX_DECOUPLE_ENABLED=true
RC_CX_EX_POLL_CX_WRITE_MODE=cx-owned
RC_CX_EX_PRESENCE_POLL_MODE=off
```

If `off` has not been tested yet, leave:

```bash
RC_CX_EX_PRESENCE_POLL_MODE=observe-only
```

until a controlled `off` window is run. Do not jump from `write` directly to permanent `off` without the observe-only evidence.

### 2. Restart Only Required Services

Use control-plane when login flags or client-facing route behavior changed. Use ringcentral-cx when poll/runtime flags changed.

```bash
sudo systemctl restart parallel-control-plane
sudo systemctl restart parallel-ringcentral-cx
```

If the client build changed, rebuild/deploy the web client after backend health is green. Do not rebuild first; that makes UI symptoms harder to attribute.

### 3. Health Check

```bash
systemctl is-active parallel-control-plane parallel-ringcentral-cx
journalctl -u parallel-control-plane --since "5 minutes ago" --no-pager \
  | grep -E 'error|failed|cx.login.trace|auth.verify_code.timing|ringcx.offhook.self_heal.async' || true
journalctl -u parallel-ringcentral-cx --since "5 minutes ago" --no-pager \
  | grep -E 'presence_poller.started|cx.call.trace|session_mismatch|status_updated|poll.reconciled|agent-ineligible' || true
```

Expected:

- both services are active,
- startup log shows the intended mode flags,
- `cx.login.trace` appears only around real login/OAuth activity,
- no startup exceptions,
- no new `agent-ineligible:ex-busy` stream for CX agents.

### 4. Floor Verification

Ask agents to hard refresh after any client build. Then watch at least one full call lifecycle per active agent:

- lead appears in app and CX on the same person,
- active call keeps the same UII through dial/connected/wrapup,
- No Answer, Answer, VM DROP, and DNC buttons do not submit the page or flicker to a stale lead,
- current call releases only after a valid disposition or UII-matched clear,
- next lead is not served while the prior call still has an active UII.

### 5. Keep A One-Command Rollback Ready

If mismatch/flicker comes back after the green patch, first restore observe-only instead of full legacy:

```bash
RC_CX_EX_PRESENCE_POLL_MODE=observe-only
RC_CX_EX_POLL_CX_WRITE_MODE=cx-owned
RC_CX_RUNTIME_MODE=
sudo systemctl restart parallel-ringcentral-cx
```

If agents are stranded or cannot receive calls, full rollback:

```bash
CX_LOGIN_THIN_ENABLED=false
RC_CX_RUNTIME_MODE=
RC_CX_EX_PRESENCE_POLL_MODE=write
RC_CX_EX_POLL_CX_WRITE_MODE=legacy
RC_CX_EX_DECOUPLE_ENABLED=false
sudo systemctl restart parallel-control-plane
sudo systemctl restart parallel-ringcentral-cx
```

## Clean Object Principle

The fourth window is not a rewrite of RingCX publishing. It is a facade over existing plumbing:

```js
{
  agentExtensionId,
  state: "idle" | "claiming" | "dialing" | "connected" | "wrapup" | "closed" | "error",
  queueItemId,
  caseId,
  domain,
  phone,
  ringcxUii,
  version,
  updatedAt
}
```

For this rollout, the object should be used to observe and display the active lead. It should not yet own queue selection. After the test, rewrite the serving path so the clean object becomes the source of truth and the old queue/client juggling is removed.

## Modes

### `RC_CX_EX_PRESENCE_POLL_MODE`

Controls whether the EX presence poller is allowed to mutate CX-facing state.

- `write` / unset: legacy behavior. The poller can persist AgentState changes, relay presence reactions, and emit poll reconcile events.
- `observe-only`: aggressive 4 PM test mode. The poller still reads RingCentral presence and logs what it would have corrected, but it does **not** write AgentState, trigger the presence bridge, emit call-start/call-end reconcile events, or wake queue serving.
- `off`: the poller loop stays alive but skips RC presence reads entirely.

Use `observe-only` before `off`; it gives us evidence without letting the suspect write to the patient.

### `RC_CX_EX_POLL_CX_WRITE_MODE`

Controls how EX poll data treats an already-held CX call when writes are allowed.

- `legacy`: EX poll owns the state as before.
- `preserve`: EX poll preserves a held CX call unless it sees a genuine separate EX call.
- `cx-owned`: a held CX call wins even when EX sees a different session.

When `RC_CX_EX_PRESENCE_POLL_MODE=observe-only`, this mode still affects what the poller would have done and what it logs, but the result is not persisted.

## Login Thinning Add-On

Use alongside any of the runtime modes when testing agent login speed.

Environment:

```bash
CX_LOGIN_THIN_ENABLED=true
CX_LOGIN_TRACE_ENABLED=true
```

Effect:

- OTP verification still validates the account and issues the app token normally.
- RingCX off-hook/self-heal is scheduled asynchronously instead of blocking the login response.
- RingCentral OAuth callback also treats off-hook/self-heal as async.
- Existing `CX_LOGIN_ASYNC_OFFHOOK_SELF_HEAL=true` remains supported; `CX_LOGIN_THIN_ENABLED=true` is the clearer umbrella flag.

Restart required: `parallel-control-plane`.

Expected login timing log:

```text
auth.verify_code.timing ... loginThinEnabled=true asyncOffhookSelfHeal=true
cx.login.trace ... flow=otp-verify step=response.ready
```

Expected async completion log:

```text
ringcx.offhook.self_heal.async.done
```

Pass criteria:

- OTP login should return after OTP/account/token work, not after RingCX off-hook repair.
- If async self-heal fails, the agent still reaches the app and the failure appears as a warning log.
- Queue serving must still wait for real CX readiness/availability gates; this flag only removes blocking repair from the login response.

Rollback:

```bash
CX_LOGIN_THIN_ENABLED=false
```

Then restart `parallel-control-plane`.

### 1. Preserve

Use for the first 4 PM sample.

Environment:

```bash
RC_CX_EX_DECOUPLE_ENABLED=true
# RC_CX_EX_POLL_CX_WRITE_MODE unset
# RC_CX_RUNTIME_MODE unset
```

Restart required: `parallel-ringcentral-cx` only.

Expected startup log:

```text
ringcentral.presence_poller.started ... exCxDecoupleEnabled=true exCxPollWriteMode=preserve
```

Behavior: EX poll still runs, but should preserve known CX-held call state when identities line up.

### 2. CX-Owned Poll

Use if preserve still shows EX poll state churn.

Environment:

```bash
RC_CX_EX_DECOUPLE_ENABLED=true
RC_CX_EX_POLL_CX_WRITE_MODE=cx-owned
# RC_CX_RUNTIME_MODE unset
```

Restart required: `parallel-ringcentral-cx` only.

Expected startup log:

```text
ringcentral.presence_poller.started ... exCxPollWriteMode=cx-owned
```

Expected preservation log, throttled per agent/signature:

```text
ringcentral.ex.poll.cx_owned_preserved
```

Behavior: when an agent already has a CX call snapshot, EX poll must not overwrite that call even if EX reports a different session.

### 3. CX-Only Runtime

Use for the full artifact-removal test.

Environment:

```bash
RC_CX_RUNTIME_MODE=cx-only
RC_CX_EX_DECOUPLE_ENABLED=true
RC_CX_EX_POLL_CX_WRITE_MODE=cx-owned
```

Restart required:

- `parallel-ringcentral-cx`
- `parallel-control-plane`

Client build required if the UI should reflect the mode. The client now trusts the backend `freshLeadGate.exCallActive` field when present, so stale local EX-looking state should not re-block the agent screen.

Expected startup log:

```text
ringcentral.presence_poller.started ... cxRuntimeMode=cx-only exCxPollWriteMode=cx-owned
```

Behavior:

- EX poll cannot own CX call state.
- EX-busy gates are suppressed for CX serving.
- stale `cxRouting.reason=ex-busy` is treated as available, not unavailable.
- manual unavailable, workspace inactive, long-call hold, active CX call, and disposition states still block as before.

## Preflight

1. Confirm live has the intended code before changing flags.
2. Confirm no unrelated local-only one-offs are being shipped.
3. Preserve live `.env`; edit only the mode flags above.
4. Note the current time so log searches can use `--since`.

Useful checks:

```bash
git status --short
grep -E 'RC_CX_(RUNTIME_MODE|EX_DECOUPLE_ENABLED|EX_POLL_CX_WRITE_MODE|EX_BUSY_GATE_ENABLED)' .env || true
systemctl is-active parallel-ringcentral-cx parallel-control-plane
```

## Watch Commands

Startup and mode:

```bash
journalctl -u parallel-ringcentral-cx --since "10 minutes ago" --no-pager \
  | grep -E 'presence_poller.started|cx_owned_preserved|session_mismatch|poll.reconciled|status_updated'
```

EX artifact pressure:

```bash
journalctl -u parallel-ringcentral-cx --since "10 minutes ago" --no-pager \
  | grep -E 'agent-ineligible:ex-busy|ex-busy|session_mismatch|cx_owned_preserved'
```

Control-plane after CX-only mode:

```bash
journalctl -u parallel-control-plane --since "10 minutes ago" --no-pager \
  | grep -E 'ex-busy|freshLeadGate|cx-unavailable|cx-workspace-stale|activity-onCall'
```

## Pass Criteria

For preserve mode:

- agents can make five calls without app/CX person mismatch.
- `session_mismatch` stops climbing materially.
- no repeated screen flicker between served leads.

For cx-owned mode:

- `ringcentral.ex.poll.cx_owned_preserved` appears when expected.
- `session_mismatch` no longer forces EX ownership of a CX-held call.
- active CX calls still block the same agent from receiving a new lead.

For cx-only mode:

- no `agent-ineligible:ex-busy` deferrals for CX agents.
- fresh-lead gate does not show EX as the blocker when the backend says `exCallActive=false`.
- manual breaks and closed workspace tabs still block.
- calls still release only on valid disposition / UII-matched clear.

## Fail Criteria

Rollback immediately if:

- active CX calls stop blocking new lead delivery.
- the app advances to the next lead before RingCX is on the matching person.
- agents cannot receive leads after returning from manual unavailable.
- control-plane or ringcentral-cx throws startup errors.

## Rollback

Fastest rollback:

```bash
RC_CX_RUNTIME_MODE=
RC_CX_EX_POLL_CX_WRITE_MODE=legacy
RC_CX_EX_DECOUPLE_ENABLED=false
```

Restart:

```bash
sudo systemctl restart parallel-ringcentral-cx
sudo systemctl restart parallel-control-plane
```

The client change is backward-compatible because legacy backend responses still carry `freshLeadGate.exCallActive`; if the backend says EX is active, the UI will show it.

## Notes

- Do not delete or clear live call state during the test unless the agent is actively stuck and the current UII is known.
- Do not judge the mode from UI text alone. Check the startup log for `cxRuntimeMode` and `exCxPollWriteMode`.
- OAuth/off-hook readiness is intentionally not removed by `cx-only`; that may still be real RingCX readiness rather than EX artifact state.

---

# Cross-Review Findings (2026-06-17)

xhigh-effort review of the rollout diff (EX-poll decouple + login thinning + fresh-lead gate). Verdict: **the design is sound and floor-safe** - staged env flags, clean rollback, fail-closed precedence. One real strander, a few latent landmines, and a clear test-streamlining win. Confidence levels below are deliberate: they say what each change *will* and *won't* fix.

## Most likely root cause of lead-state flicker + UI advancing to the next lead

**The EX presence poller overwriting CX-held call state on its own clock - the dual-owner race that logs as `session_mismatch`.** Both symptoms are the same defect seen from two angles:

```
CX call live (CX owns currentCall, UII X)
  -> EX poll tick: EX sees idle / a different session (it doesn't see the RingCX call)
  -> legacy write-mode overwrites the snapshot         <- session_mismatch
  -> deriveCxRouting / deriveFreshLeadGate re-run on the mutated snapshot
  -> for that tick the agent looks "available" (ex-idle, no CX call seen)
  -> fresh-lead gate opens
        |- balancer assigns in the window -> UI ADVANCES to next lead (call still live)
        `- next CX event re-asserts the call -> snapshot flips back -> REDRAW = FLICKER
```

Flicker = the two writers toggling at their tick cadences; advance = a window where the EX overwrite wins long enough for the gate to open. The flicker is likely **two-layered**: the backend overwrite is the driver, the frontend locally re-deriving/juggling stale EX-looking state is the amplifier (which is why `cx-only` also ships the client change to trust `freshLeadGate.exCallActive`).

**Confirm/refute in one step:** correlate `session_mismatch`/`poll.reconciled` timestamps with the flicker/advance moments; then watch the modes. **If flicker survives `cx-owned`, this root cause is wrong** and the next suspect is the frontend juggling (or the orphan-claim churn, finding #1).

## How certain each change resolves each symptom

| Symptom | Change | Confidence it resolves | Why / caveat |
|---|---|---|---|
| `session_mismatch` climbing | `preserve` -> `cx-owned` write mode | **High (~85%)** | This is *exactly* what the write-mode targets: EX poll stops overwriting a CX-held call. Fails only if something other than the poll is mutating the snapshot. |
| UI advancing to next lead mid-call | `cx-owned` + `cx-only` (suppress `ex-busy`) | **Med-High (~80%)** | Closes the gate-open window. **Residual risk:** the orphan-claim churn (finding #1) can advance/re-serve a lead independent of these flags - if advance persists in `cx-only`, it's #1, not the poll. |
| Screen flicker between leads | `cx-owned` (backend) | **Medium (~70%)** | Kills the driver; a UI shimmer can remain from local juggling. |
| Screen flicker between leads | `cx-only` + client build (trust `freshLeadGate.exCallActive`) | **High (~90%)** | Removes the frontend amplifier; this is the layer that finishes it. |
| Agent stranded / lead stuck in `claimed` | **Code fix, finding #1 (NOT a flag)** | **n/a - flags won't fix this** | `cx-only` may make it *more* likely. Must be fixed in `ringcxDialExecutionService` before Restart 3/4. |
| Painful, non-parallel-safe tests | Thread `cxRuntimeMode` as an option (below) | **Very high (~95%)** | Mechanical; the seam already exists. |

## Streamlining the live unit tests (priority)

The tests are correct but ~70% boilerplate and they **mutate global `process.env`** - order-dependent and not parallel-safe under `node --test`. The seam is already there: `cxRuntimeModeService.getCxRuntimeMode(options)` accepts `options.cxRuntimeMode`. The callers (`deriveCxRouting`, `deriveFreshLeadGate`, `buildEligibility`, and the `suppressExArtifactsForCx`/`suppressExBusyRoutingReason` sites) just don't thread it - which is the *only* reason the tests poke env.

**Thread the option through, and the tests collapse to the behavior under test:**

```js
// NOW - painful, global-env, not parallel-safe (~15 lines, 3-4 of them real):
const originalGate = process.env.RC_CX_EX_BUSY_GATE_ENABLED;
const originalMode = process.env.RC_CX_RUNTIME_MODE;
process.env.RC_CX_EX_BUSY_GATE_ENABLED = "true";
process.env.RC_CX_RUNTIME_MODE = "cx-only";
try {
  const gate = deriveFreshLeadGate({ status:"onCall", exTelephonyStatus:"CallConnected",
    cxRouting:{ enabled:true, reason:"ex-busy" } });
  assert.equal(gate.allowed, true);
  assert.equal(gate.exArtifactsSuppressed, true);
} finally { /* 6 lines of restore */ }

// SMOOTHED - mode is visible in the call; no env; parallel-safe:
const gate = deriveFreshLeadGate(
  { status:"onCall", exTelephonyStatus:"CallConnected", cxRouting:{ enabled:true, reason:"ex-busy" } },
  { cxRuntimeMode: "cx-only", exBusyGateEnabled: true },
);
assert.equal(gate.allowed, true);
assert.equal(gate.exArtifactsSuppressed, true);
```

Benefits, in order of value: (1) the test reads like the behavior it asserts (informative); (2) no global env -> safe to parallelize and reorder; (3) it forces every suppression site to route mode through `cxRuntimeModeService` - a single source of truth instead of inline `process.env` reads in five places (the altitude win). Net: same coverage, half the lines, zero env risk. **This is also a production improvement, not just a test one** - runtime mode becomes injectable rather than locked to env at process start.

Coverage gaps to add while there: `preserve` mode (only `cx-owned` is tested), the `decideExPollCxOwnership(enabled=false, mode="cx-owned")` combo, and the login-thin async-failure warn path.

## Findings (ranked)

| # | Sev | File | Finding |
|---|---|---|---|
| 1 | **HIGH** | `ringcxDialExecutionService.js:1818-1850` | On `unconfirmed-active-call`, item goes `serving->claimed` (+2min) but **clears dial evidence** (`servingAt`/`lastDialExecutionUii`/`lastDialIntentStatus`); `promoteExpiredDialingClaims` only reclaims items *with* evidence -> orphaned in `claimed`, agent's assignment counter stuck. Fix: preserve evidence (or set `lastQueueAttemptHeldForDisposition`) so it can be reclaimed. **Verify the reclaim path before Restart 3/4.** |
| 2 | **HIGH (latent)** | `cxCallStateGuard.js:136-138` | `decideExPollCxOwnership`: `mode="cx-owned"` returns `cxOwnsCallState:true` even when `enabled=false`, contradicting the docstring. Masked today (caller keeps them coherent), but unguarded + untested. Fix: require `enabled` at line 138; add the missing test. |
| 3 | **HIGH (tests)** | `agentAvailabilityService.js:37,647`, `cxLoadBalancerService.js:313,325,372` | `suppress*` called with no `options` everywhere -> tests forced to mutate env. Fix = the streamlining above. |
| 4 | **MED** | `auth.js:99-124` / `cxOAuthService.js:376-380` | Async off-hook self-heal is fire-and-forget with **no terminal `.catch()`** -> a logger throw becomes an unhandled rejection. Fix: terminal `.catch()`. |
| 5 | **MED** | `cxRuntimeModeService.js:5` | `normalizeCxRuntimeMode` aliases `cx-owned -> cx-only` - a *different flag's* value. `RC_CX_RUNTIME_MODE=cx-owned` (easy mix-up) silently = full suppression. Fix: drop the alias. |
| 6 | MED (document) | `cxOAuthService.js:376` | Async path lets OAuth succeed before off-hook repair finishes - **intended**; the real gate is the **dial-time preflight**, not workspace entry. Document so nobody "fixes" it. |
| 7 | LOW (document) | `ringcentralExService.js:1266` | `RC_CX_RUNTIME_MODE` implies `cx-owned` write mode and overrides `RC_CX_EX_DECOUPLE_ENABLED`. Intentional + fail-closed; document the precedence + add a test. |
| 8 | LOW (cleanup) | `agentAvailabilityService.js:652-653` | Dead `ex-busy` check after `routingReason` is set to `ex-idle`. Harmless (long-call-hold protects); just confusing. |

## Proposed smoothed-out submission (order)

1. **Fix #1 first** (the strander) - correctness, independent of flags; do it before any `cx-only` window.
2. **Thread `cxRuntimeMode` as an option** (finding #3 + streamlining) - kills the env-mutation tests, rewrites the three test files to the smoothed form, and makes the suppression seam single-source. Lowest risk, highest readability.
3. **Defensive guard + test** on `decideExPollCxOwnership` (#2) + the precedence test (#7). Cheap insurance on a safety-critical function.
4. **Terminal `.catch()`** on the async self-heal (#4).
5. **Two doc lines**: the dial-time preflight is the off-hook safety net under login-thin (#6); `RC_CX_RUNTIME_MODE` overrides `DECOUPLE` (#7). Drop the `cx-owned->cx-only` alias (#5).
6. **Then the 4PM windows as written** - well-sequenced; just gate Restart 3/4 on #1.

## Post-Test Retire-or-Keep Decision (Simple Long-Term Plan)

The goal is to determine whether EX poller can be removed from regular CXWorkspace function without regressions, while keeping rollout safety intact.

### Decision principle

- If `cx-only` is stable through a full operating cycle, keep:
  - `RC_CX_RUNTIME_MODE=cx-only`
  - `RC_CX_EX_POLL_CX_WRITE_MODE=cx-owned`
  - `RC_CX_EX_PRESENCE_POLL_MODE=off`
- Keep `observe-only` only as an incident tool, never as a permanent control plane default.
- Do not touch non-CXWorkspace flows unless they have a reproducible dependency on EX writes.

### Simplification plan by file (functional behavior preserved)

- `packages/shared-services/src/cxRuntimeModeService.js`
  - remove ambiguous aliasing from `normalizeCxRuntimeMode` so `cx-only` cannot be reached indirectly.
  - keep runtime mode values strict and explicit.
- `packages/shared-services/src/ringcentralExService.js`
  - parse mode once at startup and thread that normalized object through poller helpers.
  - in `off`, skip reads + writes and skip reconcile events entirely.
  - keep `observe-only` for forensics only (metrics + log-only behavior).
- `packages/shared-services/src/cxCallStateGuard.js`
  - require `enabled` in `decideExPollCxOwnership` regardless of mode.
  - keep existing anti-stranding logic untouched.
- `packages/shared-services/src/agentAvailabilityService.js`
  - pass runtime mode / gate flags as explicit options into `deriveFreshLeadGate`.
  - reduce env reads in pure decision helpers.
- `packages/shared-services/src/cxLoadBalancerService.js`
  - thread same options into `buildEligibility` and eligibility checks.
  - reuse existing behavior for manual unavailable, workspace inactive, and disposition blocks.
- `packages/shared-services/src/ringcxDialExecutionService.js`
  - keep `unconfirmed-active-call` evidence so reclaim can re-own stale claims deterministically.
  - leave CX release timing logic intact.
- `packages/shared-services/src/auth.js` and `packages/shared-services/src/cxOAuthService.js`
  - keep async repair path but terminate promises with explicit `.catch()`.

### Retire-now checklist

- `session_mismatch` trend is flat or improved.
- no `agent-ineligible:ex-busy` regressions for CX agents.
- `freshLeadGate.exCallActive` remains the stable blocker signal.
- valid RingCX clear/disposition still releases calls once and only once.
- strander path in `ringcxDialExecutionService` is validated in live.

If all checks are green, schedule EX poller deprecation:

- disable writes permanently in CXWorkspace runtime mode,
- leave `observe-only` as a flagged maintenance mode,
- remove any legacy fallback defaults that silently keep EX write ownership active.

## After-Test Patch Plan (4-5 PM debrief + both review inputs)

Use this only after both result streams are returned. Keep it tiny: first stabilize behavior, then simplify.

### If both reviewers and logs are GREEN

Apply permanent simplification in one sweep:

1) Config hardening
- Default production to CX-first behavior:
  - `RC_CX_RUNTIME_MODE=cx-only`
  - `RC_CX_EX_PRESENCE_POLL_MODE=off`
  - `RC_CX_EX_POLL_CX_WRITE_MODE=cx-owned`
  - `RC_CX_EX_DECOUPLE_ENABLED=true`
- Keep `observe-only` only in an emergency toggle playbook.
- Restart services once after env update.

2) Minimal code cleanup (no behavior change, no perf cost)
- Thread runtime mode/options explicitly through decision points:
  - `agentAvailabilityService.js` (`deriveFreshLeadGate` and suppress helpers)
  - `cxLoadBalancerService.js` (`buildEligibility` and eligibility checks)
- Make `decideExPollCxOwnership` in `cxCallStateGuard.js` require both `enabled` and `cx-owned`.
- Finalize the `unconfirmed-active-call` reclaim evidence preservation fix in `ringcxDialExecutionService.js`.
- Add `.catch()` terminal handlers in async repair call-sites.
- Remove `cx-owned -> cx-only` alias risk in `cxRuntimeModeService.js`.

3) Verification
- Re-run the same smoke pass without changes to other behavior:
  - No new `session_mismatch` spike.
  - No `agent-ineligible:ex-busy` for CX sessions.
  - One-clear / one-disposition release invariants hold.
- If any one check fails, rollback only the two runtime flags back to `observe-only` and keep app changes only.

### If either reviewer sees regression

1) Keep the safe long-standing mode (`observe-only` if needed for diagnosis, else `write/cx-owned` as last-good).
2) Apply only blocking fixes first:
- `ringcxDialExecutionService.js` claimed-item reclamation evidence preservation
- `decideExPollCxOwnership` guard + tests
- terminal `.catch()` on async repair
3) Re-run only the failing slice and promote again only when stable.

### Patch boundary

Do not do both config and code in parallel with tests running.
- First: apply whichever code fixes are required.
- Second: flip runtime flags only after fixes are in.
- Third: add/remove `observe-only` from emergency playbook as a documentation-only change.

### Rollback boundary (still simple)

If any red condition appears in stable calls:
- Restore `RC_CX_EX_PRESENCE_POLL_MODE=observe-only`.
- Keep `cx-owned` write mode enabled while correcting.
- Keep running in the same config until the specific defect path is fixed.
