# Subtractive App Audit Plan

Date: 2026-06-17

## Purpose

The next cleanup phase is not a feature sprint. It is a deep scrub for speed, stability, and focus.

The app has grown through useful emergency patches, repair loops, polling layers, retry logic, parked experiments, admin surfaces, and AI integrations. Some of that is load-bearing. Some of it is stale scaffolding. Some of it works but runs in the wrong place, especially on login, queue handoff, metrics load, and AI calls.

This audit asks the same two questions across the app:

1. Is this necessary for the app to do what it needs to do?
2. Is this sufficient, or is it doing more than the job requires?

The desired result is a narrower app:

```text
fewer live-path dependencies
fewer serial waits
fewer stale repair loops
fewer duplicate state owners
fewer direct provider integrations
faster first useful screen
more predictable workers
```

Then we can make the system smarter on top of something that is already fast and stable.

## Core Heuristic

Every line of code in the target flows should fall into one of these buckets:

| Bucket | Meaning | Action |
| --- | --- | --- |
| Required live-path | The user cannot safely proceed without it | Keep, simplify, make fast, make observable |
| Required but not live-path | Needed eventually, not before first screen/click | Move to background, morning prep, nightly, or lazy panel load |
| Useful admin-only | Helps investigation but not agent UX | Hide from agent path, keep admin/debug route if cheap |
| Historical scaffold | Helped build or test a system but no longer carries current behavior | Park, un-route, or delete after verifying no runtime dependency |
| Duplicate owner | Two places try to own the same state or decision | Pick one owner, make the other read-only or remove |
| Expensive intelligence | AI/model/reconciliation call | Route through 7000 or a worker; never directly block UX unless explicitly click-and-wait |

## Phase-Out Vocabulary

Use precise words so we do not delete something that is quietly load-bearing.

- **Hide:** remove from nav/UI, backend remains live.
- **Un-serve:** remove route/nav entry, keep file and service code.
- **Park:** keep source file with a comment explaining why it is intentionally orphaned.
- **Retire:** disable worker/feature flag, keep code for rollback.
- **Delete:** remove code only after logs/tests prove no caller depends on it.

The pasted social responder example is the right model: un-serve the admin component, but keep webhooks/service/config if the runtime still needs them.

## Audit Workstreams

### 1. Call Queue And Agent Login

Goal: agents should reach a useful CX screen quickly, with a stable current lead and no flicker.

Necessary live-path work:

- Authenticate the app user.
- Confirm the agent identity and domain scope.
- Confirm RingCX token/readiness enough to dial.
- Load current queue item or current call.
- Render core disposition buttons.
- Bind coach state only when there is a current call/session.

Likely not necessary before first useful screen:

- Full queue history.
- Full call history.
- Recording depot.
- Metrics summaries.
- Admin-only panels.
- Repair sweeps that can run before login or after failure.
- Deep Logics enrichment unless the current lead needs it.

Audit questions:

- What exact HTTP calls fire between login and first visible CX lead?
- Which calls are serial only because the client awaits them in sequence?
- Which calls can be parallelized?
- Which calls can be moved to morning prep?
- Which data can be snapshot-first, then refreshed after render?
- Which client effects can still restore an older lead after a newer one is served?
- Which backend "self heal" actions run on every login but only need to run after a detected failure?

Subtractive direction:

- Build an agent morning-prep job:
  - warm RingCX/OAuth where possible,
  - precompute readiness,
  - prebuild first queue slice,
  - cache queue counts,
  - record failures before agents log in.
- Make login mostly read prepared state plus OTP/auth.
- Separate "current lead" from "everything else."
- Ensure only one actor advances the served lead.
- Keep optimistic UI, but never let old queue hydration overwrite a newer served identity.
- Remove or defer dashboard panels that are not needed for the next call.

Definition of done:

- First useful CX screen renders from identity + prepared queue/current lead state.
- No answer, answer, voicemail, and appointment transitions do not flicker between people.
- A failed optional enrichment cannot block the agent from dialing.

### 2. Hourly And Nightly Data Sanitization For Metrics

Goal: metrics should be honest, but metric repair should not clog live UX or Mongo during business-critical moments.

Necessary work:

- Maintain source/cost/deal/call ledgers accurately enough for daily decisions.
- Reconcile missed LD/WYNN/TAG attribution.
- Prune operational bloat that does not support current reporting.
- Preserve enough June/current-month events to repair metrics.

Likely not necessary in live path:

- Heavy full scans during page load.
- Runtime reads of large stale event collections.
- Recomputing historical aggregates every time a metric screen opens.
- Keeping pre-June operational noise after dump-first safety.
- Keeping stale gRPC/session junk after call close.

Audit questions:

- Which metrics screens still compute instead of reading snapshots?
- Which collections grow without retention?
- Which event logs are used for ledgers vs only for debugging?
- Which metrics can be reconstructed from compact monthly ledgers?
- Which cleanup operations need dump-first safety?
- Which workers run hourly but can move to nightly or claim-based Phase B work?

Subtractive direction:

- Treat metrics as read models:
  - call counts,
  - lead counts,
  - close/payment ledgers,
  - source spend,
  - vendor attribution.
- Run repair/reconciliation out of band.
- Keep current-month operational records where they can help repair metrics.
- Dump and prune older bloat on a schedule.
- Make metrics pages load a snapshot first, with explicit "last refreshed" metadata.

Definition of done:

- Metrics load fast even when repair jobs are running.
- Cleanup reports what was deleted and what might affect attribution.
- Operational event bloat has a retention plan.

### 3. Automated Processes

Scope:

- mail sending,
- NCOA/doc receipt/redline,
- blogging,
- case upgrading,
- counter cadence,
- scheduled RVM/SMS/email,
- nightly close.

Goal: workers should be boring, idempotent, and isolated from the agent UX.

Necessary work:

- Claim due work.
- Execute once.
- Record result.
- Retry safely.
- Emit useful error detail.
- Avoid overlapping runs.

Likely not necessary:

- Multiple schedulers for the same job.
- Hidden side effects during app boot.
- Worker logic that runs only because a UI page opened.
- Silent catch blocks around worker failure.
- Work that continues after feature flags say the feature is off.
- Large batch fan-out without caps.

Audit questions:

- Which workers are interval-based without in-flight guards?
- Which workers are duplicate scheduled by both "hourly" and standalone service?
- Which workers can switch to claim/dead-letter semantics?
- Which should run outside business hours only?
- Which can be paused independently without restarting the app?
- Which logs are too vague to know whether anything happened?

Subtractive direction:

- One worker primitive for intervals and claim loops.
- One ownership point per scheduled job.
- One result shape per job:
  - selected,
  - sent,
  - skipped,
  - failed,
  - retried,
  - deferred.
- No direct app-page dependency for scheduled jobs.
- Feature flags should be checked before expensive prep begins.

Definition of done:

- A worker can fail without taking down the app.
- A disabled feature does not do hidden expensive work.
- A nightly report can explain exactly what ran.

### 4. Lead Contact Intake And Dispatch

Goal: lead intake and outbound dispatch should be narrow, canonical, and observable.

Necessary work:

- Accept vendor payloads.
- Normalize domain/vendor/source.
- Create/update lead/cadence records idempotently.
- Preserve payload snapshot.
- Route to the correct queue/cadence.
- Respect DNC/contactability.
- Dispatch SMS/email/RVM only through the canonical outbound path.

Likely not necessary:

- Old source-name split logic if vendor field is canonical.
- Duplicate general/custom branches that now mean vendor splits.
- Ad hoc one-off dispatch paths that bypass cadence rules.
- UI surfaces that mutate source/contact status without being the canonical owner.
- Campaign logic that only exists for old experiments.

Audit questions:

- How many places create or mutate a lead cadence?
- How many places can send outbound contact?
- Which dispatch paths bypass the current DNC/contactability model?
- Which vendor fields are canonical now?
- Which old source-name rules are still active but no longer wanted?
- Which scripts are one-off tools vs production-safe commands?

Subtractive direction:

- Canonicalize intake around:
  - domain,
  - vendor,
  - source id/name,
  - case id,
  - phone/email,
  - contactability.
- Dispatch should go through one service with one rate/eligibility policy.
- Remove or park redundant vendor split logic after confirming payload shape.
- Keep one-off scripts untracked or clearly marked non-production.

Definition of done:

- A lead enters once, gets one canonical identity, and dispatch decisions are traceable.
- Outbound sends are governed by the same contactability/cadence logic.

### 5. AI Implementations

Goal: anything that invokes a model should invoke it through the same AI bus/governor unless there is an explicit temporary exception.

Necessary work:

- Live coach AI path.
- Resolution pitch / upsellerator AI.
- SMS classifier / response driver.
- Activity/contact safety review.
- Call transcription/scoring.
- Sales trainer.
- Blogger generation/images.

Likely not necessary:

- Direct OpenAI/Anthropic calls scattered through services.
- Hard-coded model ids in business logic.
- Multiple cost/logging styles.
- Strong models doing work that deterministic code or mini can handle.
- AI calls on page load when click-and-wait or background is sufficient.

Audit questions:

- Where does the repo call provider APIs directly?
- Which model calls are hot path vs batch vs click-and-wait?
- Which can be deterministic first?
- Which need strict JSON output?
- Which mutate contactability/compliance and must fail safe?
- Which prompts are stable and cacheable?
- Which calls need usage logs and daily spend caps?

Subtractive direction:

- Move model invocation to `7000`.
- Add `runAiTask(taskId, payload, options)` app-side helper.
- Add AI task registry:
  - task id,
  - owner,
  - provider/model by quality mode,
  - timeout,
  - max tokens,
  - cache policy,
  - fallback shape,
  - logging requirements.
- Keep deterministic prefilters before model calls.
- Route direct provider calls into tasks over time.

Definition of done:

- Business code says `runAiTask("sms.classify", payload)`.
- `7000` decides the model/provider/tier and logs the spend.
- AI can be downgraded, paused, or capped by task without code edits.

## Cross-Cutting Review Checklist

Use this checklist when opening any file in the five workstreams.

### Necessity

- What user/business outcome does this code support?
- Is it still used by the current workflow?
- Is it still used only because an old UI route exists?
- Is it a one-off experiment that should not be in production paths?

### Sufficiency

- Could this be a smaller deterministic check?
- Could this be precomputed?
- Could this be lazy-loaded?
- Could this be a snapshot read?
- Could this be one worker instead of two?
- Could this be one owner instead of two competing state writers?

### Runtime Path

- Does this run on login?
- Does this run on first CX workspace render?
- Does this run on every queue handoff?
- Does this run inside business hours without needing to?
- Does this run because a page mounted rather than because work is due?

### Failure Behavior

- If this fails, does the agent get blocked?
- Does it retry forever?
- Does it silently catch and hide the failure?
- Does it leave stale state that later causes flicker/desync?
- Can it be safely replayed?

### Observability

- Is the identity chain logged?
- Is the result counted?
- Is the elapsed time captured?
- Can we tell skipped vs failed vs disabled?
- Can we see if this is expensive?

## First Three Audit Outputs

Before broad code changes, produce these read-only outputs:

1. **Agent Login And Queue Dependency Graph**
   - endpoints called,
   - order,
   - elapsed time if measurable,
   - blockers vs optional hydration.

2. **Worker And Scheduler Inventory**
   - every interval/cron/claim loop,
   - owner service,
   - business-hour behavior,
   - in-flight guard,
   - last-error visibility.

3. **AI Invocation Inventory**
   - direct provider calls,
   - task purpose,
   - hot/batch/click path,
   - current model,
   - target `7000` task id.

These three outputs should guide the first subtractive patches.

## Suggested Execution Order

1. Read-only dependency graph for agent login and CX workspace boot.
2. Client-side cleanup of duplicate/stale effects only where a bug is already proven.
3. Morning prep design for agent readiness and first queue slice.
4. Worker inventory and shared worker primitive.
5. Metrics snapshot/retention cleanup.
6. AI task registry on `7000`, then move one low-risk AI task.
7. Lead intake/dispatch consolidation after queue and worker noise are calmer.

## Non-Goals

- Do not rewrite the dialer algorithm as part of this audit.
- Do not delete backend services just because their admin UI is hidden.
- Do not merge unrelated feature work into debloat patches.
- Do not move all AI calls in one patch.
- Do not make the app smarter until the current path is stable and narrow.

## Decision Rule

When unsure, prefer the change that reduces live-path work without reducing observability.

If a feature is not currently worth keeping in front of users but may still be operationally useful, park it. If a backend process is still load-bearing, harden it before hiding or deleting its UI.
