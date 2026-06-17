# CX Login Prep Rollback Test Plan

## Goal

Make CX first login feel fast without hiding expensive RingCX and queue-prep work inside page reads. The change must be rollbackable, observable, and testable with a real agent before it is merged into the normal production flow.

## Current Problem

The `/cx` route currently reaches several systems during the first usable screen:

- OTP verification awaits RingCX off-hook self-heal.
- CX OAuth callback awaits RingCX off-hook self-heal again.
- Workspace reads fire a best-effort off-hook self-heal on refresh.
- Workspace queue reads may trigger queue refill/materialization.
- Empty queues can show as "ready" while refill is still running in memory.

That means a user can experience a multi-step operational repair flow as a login spinner or an apparently blank workspace.

## Rollback Rule

The first implementation should be gated behind env flags. Turning the flags off must return the app to the current behavior without a code rollback.

Suggested flags:

- `CX_LOGIN_PREP_FLOW_ENABLED=false`
- `CX_LOGIN_ASYNC_OFFHOOK_SELF_HEAL=false`
- `CX_LOGIN_READY_GATE_ENABLED=false`
- `CX_LOGIN_PREBUILD_STARTER_PACK_ENABLED=false`
- `CX_LOGIN_PREP_DEBUG_ENABLED=false`

The existing flow remains the default until a real-agent test confirms the new path is stable.

## Proposed Test Branch Shape

Create a focused branch or local-only patch named around:

`cx-login-prep-v1`

Keep unrelated coach, voicemail, metrics, and resolution work out of the branch.

The branch should make the CX launch path explicit:

1. OTP login issues the Parallel token quickly.
2. `/api/auth/me` returns stored CX readiness facts from Mongo only.
3. `/cx` displays a readiness surface instead of silently repairing everything.
4. A new readiness endpoint runs expensive work in a named flow.
5. The normal workspace GET becomes closer to a read-only snapshot.

## Readiness Flow

Add one server-side orchestration function:

`ensureCxAgentReadyForDay({ user, domain, source })`

It should produce a status object like:

```json
{
  "ok": true,
  "stage": "ready",
  "agent": {
    "email": "agent@example.com",
    "extensionId": "123"
  },
  "steps": {
    "oauth": { "ok": true, "source": "mongo" },
    "ringcxIdentity": { "ok": true, "groupStored": true },
    "offhookSelfHeal": { "ok": true, "async": true, "reason": "cooldown" },
    "queueStarterPack": { "ok": true, "visible": 3 },
    "freshTopOff": { "ok": true, "queued": true }
  },
  "durationMs": 1234
}
```

Stages should be boring and finite:

- `needs_oauth`
- `preparing`
- `ready`
- `degraded`
- `failed`

## What Moves Where

### OTP / Code Exchange

Keep:

- verify OTP
- update login timestamp
- issue app token
- return `buildPublicAuthUser`

Move out of the blocking path:

- awaited `ensureRingcxAgentOffhookAllowed`

Instead, when `CX_LOGIN_ASYNC_OFFHOOK_SELF_HEAL=true`, schedule it in the background and stamp readiness state to Mongo.

### CX OAuth Callback

Keep:

- exchange RC code for tokens
- store RC refresh token
- exchange/store RingCX bearer when available
- redirect back to `/cx`

Move out of the blocking path:

- awaited off-hook self-heal

The callback can enqueue or fire-and-forget readiness prep, but it should not make the browser wait on RingCX agent mutation.

### Workspace GET

Keep:

- read account
- read agent state
- read visible queue items
- read tasks/reminders/light workspace data

Avoid:

- expensive repair work
- synchronous queue materialization
- repeated self-heal attempts

If the queue is missing, return:

```json
{
  "queueReadiness": {
    "status": "preparing",
    "reason": "starter-pack-not-ready",
    "lastPrepAt": "..."
  }
}
```

## Morning Prep

Use a scheduled or manual morning step before agents arrive:

1. Refill shared pool.
2. Resolve/persist agent RingCX group identity.
3. Run off-hook self-heal.
4. Build a small blue/red starter pack for expected agents.

Do not reserve the whole day of leads.

## No-Show Release

At around 9 AM:

- release morning-prep starter packs for agents who never became active
- reason: `morning-prep-no-show`
- only release items stamped with the morning prep pack id
- never release served, dialing, or dispositioning items

Late login should call the same readiness function. It should not need a separate code path.

## Bethel Twee Test

Use the local/test route, not production, for the first real-agent test.

1. Build local client with debug timing visible.
2. Expose the local control-plane through the Bethel Twee tunnel.
3. Enable only the feature flags needed for the test.
4. Have one real agent log in.
5. Watch:
   - OTP response time
   - OAuth guard behavior
   - readiness status
   - first visible queue time
   - whether calls still place correctly
   - whether no-answer/answer/VM dispositions still advance cleanly

Success target:

- login/token returns quickly
- `/cx` shows a useful readiness state in under 2 seconds
- first usable lead appears in under 10 seconds, ideally under 5
- no OAuth loop
- no workspace flicker
- no accidental queue ownership for absent agents

## Merge Criteria

Do not merge until:

- feature flags default to current production behavior
- real-agent Bethel Twee test succeeds
- logs explain every long wait over 2 seconds
- late-login behavior uses the same readiness function
- no-show release has a dry-run report
- rollback is documented as "turn off flags and rebuild/restart only what is needed"

## First Implementation Order

1. Add timing/status logging around OTP, OAuth callback, workspace GET, queue GET, and readiness prep.
2. Add the readiness status object in Mongo or agent state.
3. Make OTP off-hook self-heal async behind a flag.
4. Make OAuth callback off-hook self-heal async behind a flag.
5. Add `/api/commands/cx/ready` or similar readiness endpoint.
6. Put the CX UI behind the readiness result.
7. Add morning prep starter-pack dry run.
8. Run Bethel Twee real-agent test.
