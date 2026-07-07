# CX Bulk Certification Guide - 2026-07-07

Purpose: define what has to be true before we treat the bulk rail as certified for alpha testing. This is not a delete map and not a feature plan. It is the evidence checklist for saying "bulk owns the call loop cleanly enough to keep testing."

Use this guide with:
- `docs/CX_0_2_ALPHA_TEST_OBSERVABILITY_RUBRIC_2026-06-29.md`
- `docs/CX_CALL_WRAP_QUEUE_DESIGN_2026-07-06.md`
- `docs/CX_LEGACY_HANGOVER_DELETE_LEDGER_2026-07-07.md`
- `.ai/context/CX_BULK_LOCAL_TEST_WORKFLOW_2026-07-01.md`

## Non-Negotiables

- Do not judge the loop from UI state alone. Certification needs log, queue, outbox, and RingCX evidence.
- Do not restart `Parallel*`/NSSM services from Codex. If certification needs a service bounce, Mickey does it.
- Bulk test rows must use the bulk `cxbl` external-id shape. Mixed legacy ids invalidate the run.
- Bulk load owns dialing. Do not use legacy manual dial/start-next paths during certification.
- A clean test starts from a drained RingCX side and a rebuilt app-side bulk batch.
- Do not expose raw phones, auth material, or customer PII in the certification notes.

## Certification Result Levels

### Not Certified

Use this when a blocker remains in the direct bulk path:
- disposition does not terminate or advance reliably;
- poller cannot match current calls by extern/UII;
- a non-bulk/legacy lead can become current without being refused;
- terminal outcomes are lost or duplicated;
- a compliance block can be bypassed into RingCX dialing.

### Local Alpha Certified

Use this for Mickey/local testing only:
- core loop passes;
- known production/setup items are documented as exceptions;
- no known issue can cause an unsafe local test dial;
- any required service restart is handled by Mickey.

### Broad Alpha Certified

Use this only after the setup and side-effect gates pass:
- wrap-card indexes are proven in the database;
- transient Logics failures do not cancel queue inventory as if they were confirmed blocks;
- wrap-card resolution failures are visible or repairable;
- appointment datetime handling is timezone-explicit;
- first-touch flags have a live consumer before `CX_FIRST_TOUCH_ENABLED=true`.

## Current Certification Blockers From Side-By-Side Review

These are the places that can create unintended side effects, choke points, or under-defined behavior.

### 1. Wrap-card duplicate protection depends on an unpromoted index

Current refs:
- `packages/shared-models/src/CxCallWrapCard.js:13` declares unique `idemKey`.
- `packages/shared-repositories/src/cxCallWrapCardRepository.js:14` through `23` relies on duplicate-key errors for `insertOnce`.
- `apps/control-plane/src/server.js:1159` through `1184` fast-mints wrap cards as soon as terminal rows are inserted.
- `apps/control-plane/src/server.js:1144` through `1150` still uses the drain path as the backstop.
- `scripts/sync-indexes.js:30` through `42` does not include `CxCallWrapCard`.

Certification rule:
- Before broad alpha, verify the actual Mongo collection has a unique `idemKey` index, or add `CxCallWrapCard` to the index-sync allowlist and run the normal index promotion process.

Why it matters:
- Fast-mint plus drain-backstop is good only if duplicate suppression is durable. Without the real DB index, timing races can create duplicate pending wrap cards.

### 2. Fresh Logics status failure is treated too much like confirmed bad status

Current refs:
- `packages/shared-services/src/contactEligibilityService.js:61` through `65` returns `logics-status-check-failed` when fresh status is required but unavailable.
- `packages/shared-services/src/contactEligibilityService.js:164` through `175` enforces a block by cancelling pending actions and active queue rows.
- `packages/shared-services/src/cxCadenceService.js:2055` through `2067` requires fresh Logics status during queue creation.
- `packages/shared-services/src/cxCadenceService.js:3563` through `3583` requires fresh Logics status during ready claim.
- `packages/shared-services/src/cxWorkspaceService.js:2771` through `2797` materialization catches the error shape, but still returns a failed eligibility.

Certification rule:
- Confirmed non-contactable Logics status may cancel inventory.
- Logics transport/no-data/check failure should be visible and non-destructive unless Mickey explicitly accepts the fail-closed policy for that lane.

Why it matters:
- The DNC/status safety fix is good, but a transient dependency miss should not silently wipe useful queue state.

### 3. System-disposition reads can become a watcher choke point

Current refs:
- `packages/shared-services/src/cxAccountActiveCallWatcherService.js:884` through `898` bounds each RingCX `leadSearch` at 2 seconds.
- `packages/shared-services/src/cxAccountActiveCallWatcherService.js:958` through `1080` can run direct, family, and congestion searches for one terminal observation.
- `packages/shared-services/src/cxAccountActiveCallWatcherService.js:1113` reads system disposition before terminal persistence.
- `packages/shared-services/src/cxAccountActiveCallWatcherService.js:1117` through `1167` may defer terminal persistence into the retry lane when the classifier is on and no label is available.

Certification rule:
- The watcher must still tick fast enough under the largest expected local test load.
- Certification evidence should include timing logs for system-disposition lookup and terminal persistence.
- `CX_SYSDISPO_CLASSIFIER_ENABLED` must stay off unless the run is explicitly certifying system-disposition routing.

Why it matters:
- The sysdispo split is the right direction, but multiple bounded remote reads per release can make the watcher feel stuck.

### 4. Break/availability controls can leave app and RingCX half-synced

Current refs:
- `apps/web-client/src/components/cx/CxAvailabilityToggle.tsx:147` through `181` pauses RingCX progressive, writes app availability, then resumes RingCX.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4411` through `4468` still has the same workspace-level sequence.
- `packages/shared-services/src/cxBulkLoadRuntime.js:331` through `456` flips RingCX agent state using process-local pause tokens.

Certification rule:
- A break click must not leave RingCX paused while the app shows available, or vice versa.
- If any step fails, the UI must tell the agent what state needs human attention.
- Certification should include one short break and one resume, with RingCX state observed.

Why it matters:
- A single human button now crosses two state systems. That is fine only if failure is visible and recoverable.

### 5. Wrap-card resolution is fail-soft but not yet repair-friendly

Current refs:
- `packages/shared-services/src/cxCallWrapCardService.js:117` through `121` resolves the card before side effects run.
- `packages/shared-services/src/cxCallWrapCardService.js:128` through `133` catches side-effect errors into result objects.
- `apps/control-plane/src/routes/cxBulkLoad.js:125` through `133` returns only resolution/noop to the client.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6215` and `6238` catch resolve failures without surfacing details.

Certification rule:
- DNC, appointment, dismiss, and expiry must each show whether the external effect succeeded.
- If an external effect fails after the card resolves, there must be a repair path or a clearly logged operator action.

Why it matters:
- The card can disappear from the agent UI while a Logics status write, appointment write, or interview write failed.

### 6. Wrap appointment datetime is not timezone-explicit

Current refs:
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6165` uses `datetime-local`.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6180` sends that value as `appointmentAt`.
- `packages/shared-services/src/cxAppointmentService.js:111` through `156` has a safer date/time/timezone path, but `appointmentAt` falls through to `new Date(...)`.

Certification rule:
- Wrap appointment booking should send explicit `appointmentDate`, `appointmentTime`, and `appointmentTimezone`, or otherwise prove local/server timezone interpretation is correct.

Why it matters:
- A browser-local "10:00 AM" can be interpreted differently by the server unless the timezone is explicit.

### 7. First-touch lane flag can strand rows if enabled too early

Current refs:
- `packages/shared-services/src/cxCadenceService.js:2030` through `2040` stamps `firstTouchPending` when `CX_FIRST_TOUCH_ENABLED=true`.
- `packages/shared-services/src/cxCadenceService.js:2265` through `2283` writes the stamp into queue metadata.
- `packages/shared-repositories/src/cxDialQueueRepository.js:80` and `97` exclude stamped rows from both ready rails.

Certification rule:
- Keep `CX_FIRST_TOUCH_ENABLED=false` until the first-touch consumer lane exists and has a clear consume/clear owner.

Why it matters:
- Once stamped, rows are intentionally hidden from bulk ready claims. Without the consumer lane, they sit forever.

## Certification Gates

### Gate 0 - Build and route posture

Pass criteria:
- `/cx` renders `CXWorkspaceBulkLoad` unconditionally.
- The local client bundle is rebuilt after frontend changes.
- `CxAvailabilityToggle` is visible on the actual route Mickey is using.
- `/cx/prep` is either not used for testing or explicitly included in navbar-control visibility.

Evidence to capture:
- Current route URL.
- Bundle/rebuild confirmation.
- Screenshot or observation that navbar controls are visible.

Known refs:
- `apps/web-client/src/workspaces/cx/CXWorkspaceRouter.tsx:14`
- `apps/web-client/src/app/CXShell.tsx:30`

### Gate 1 - Stack and flags

Pass criteria:
- Bulk services are running with the intended code.
- `CX_CALL_WRAP_QUEUE_ENABLED` is explicitly known before a wrap test.
- `CX_SYSDISPO_CLASSIFIER_ENABLED` is explicitly known before a sysdispo-routing test.
- `CX_FIRST_TOUCH_ENABLED` remains off unless certifying first-touch.
- No Codex-initiated service restart.

Evidence to capture:
- Health/status checks.
- Relevant env/flag state without printing secrets.
- Mickey confirmation for any restart.

### Gate 2 - Clean test inventory

Pass criteria:
- RingCX side is drained.
- App-side active bulk session/queue state is clean or intentionally rebuilt.
- Test batch uses `cxbl` extern ids only.
- No stale terminal outcome metadata contaminates the batch.
- Batch contains the intended mix: e.g. Mickey answer tests, yellows, or one poison lead.

Evidence to capture:
- Queue row counts by state and family.
- First few masked names/extern ids.
- Confirmation that RingCX accepted exactly the intended lead count.

### Gate 3 - Poller/current ownership

Pass criteria:
- RingCX current call extern id matches the app current.
- UII attaches to the correct queue item.
- If RingCX serves a non-bulk lead, the app refuses to adopt it.
- No EX presence, legacy queue, or simple-loop path can take over the current slot.

Evidence to capture:
- Active-call watcher logs around dial and match.
- App session current before and after each call.
- Queue row metadata for `lastRingcxActiveCall`, `lastDialExecutionUii`, and reservation/session ownership.

### Gate 4 - Terminal outcome loop

Pass criteria:
- No answer: disposition request accepted, call terminates, terminal row persists, drain clears, next lead advances.
- Voicemail: same loop, with voicemail-specific RC behavior validated.
- Answered/hangup: system disposition and/or guard produces the expected terminal outcome.
- Buttons return after each terminal event.

Evidence to capture:
- Disposition request/response status.
- Terminal outbox row and drain result.
- Queue row completion/cadence stamps.
- App session current changing from old lead to none/held state to next lead.

### Gate 5 - System disposition split

Pass criteria:
- `lastPassDispo` or `lastPassDisposition` is read from RingCX when available.
- `ANSWER` routes to answered/wrap only when classifier is intentionally on.
- Non-ANSWER labels route to no-answer/drain-only when classifier is intentionally on.
- Retry lane persists once, retries once, and flushes without losing the terminal outcome.
- With classifier off, labels are evidence only and do not change routing.

Evidence to capture:
- `cx.alpha.system_disposition.lookup.*`
- `cx.alpha.sysdispo.retry.*`
- `cx.alpha.terminal.outbox_insert.finished`
- Drain forwarded event with `systemDisposition`.

### Gate 6 - Wrap queue

Pass criteria:
- Answered terminal row mints one pending card.
- Card carries name/case/UII/system disposition/summary if present.
- DNC resolution writes interview material, DNC status effect, and correction row.
- Appointment resolution creates appointment with correct time and holds/releases queue state.
- Dismiss and expiry file the interview if material exists and do not affect live dialing.
- Failures are visible, not silently hidden from the agent/operator.

Evidence to capture:
- Wrap card count before/after.
- Resolve response including effect statuses or logs.
- Correction row drain for DNC.
- Appointment row and queue metadata for appointment.

### Gate 7 - Break and availability

Pass criteria:
- 5 minute break sets app unavailable and RingCX paused/on-hook as expected.
- Resume sets app available and RingCX available/off-hook expectations are clear.
- Timer expiry keeps the UI blocked with the correct resume instruction.
- Agent understands when RingCX's Start Dialing button must be pressed.
- No automatic logout/unavailable governance fires except the explicitly accepted after-hours rule.

Evidence to capture:
- AgentState `activityState` and `cxRouting`.
- RingCX agent state before/after.
- Bulk session paused/resumed response.

### Gate 8 - Compliance and queue safety

Pass criteria:
- `cadenceState.channelDnc.cx.blocked` blocks dialing at the shared eligibility gate.
- Appointment-held rows are excluded from ready claims.
- Logics confirmed DNC/non-prospect status blocks dialing.
- Logics check failure is handled according to the chosen policy and does not surprise-cancel inventory.
- A queue row cannot be re-dialed after a terminal outcome due to missing UII evidence.

Evidence to capture:
- Eligibility decision reason.
- Queue cancel reason if cancelled.
- Cadence DNC/appointment fields.
- Terminal evidence keys if a re-dial risk is investigated.

### Gate 9 - Legacy hangover containment

Pass criteria:
- `/api/cx/bulk-load/start-next` returns disabled/manual-dial-disabled.
- Simple-loop and slow-single are not used during certification.
- Legacy queue hooks in `CXWorkspaceBulkLoad` remain disabled or are deleted after proof.
- Hidden dead UI does not affect the live route.

Evidence to capture:
- Route response for retired manual dial if checked.
- No simple-loop/slow-single logs during the test.
- No legacy ids in RingCX.

## Minimum Local Alpha Certification Drill

Run this after Mickey drains RingCX and restarts any services he chooses to restart.

1. Rebuild or confirm the local client reflects the current tree.
2. Build a fresh 10-lead bulk batch with `cxbl` ids.
3. Confirm RingCX sees exactly those leads, in the expected order.
4. Start the progression narrator if useful: `scripts/cx-answer-progression.js`.
5. Run three basic outcomes:
   - one no-answer;
   - one voicemail;
   - one answered call where Mickey actually answers and hangs up.
6. For each call, verify:
   - app current matched RingCX current;
   - UII attached;
   - terminal outcome persisted;
   - drain completed;
   - next lead advanced or held for the expected reason;
   - no legacy lead was adopted.
7. If wrap is enabled, resolve one card as DNC and one as appointment.
8. If sysdispo routing is enabled, capture the direct `leadSearch` label and retry behavior.
9. Stop the run at the first unknown failure, not at the first known scheduled limitation.

## Certification Signoff Template

Use this exact shape in notes or handoff:

```text
Bulk certification result:
Date/time:
Branch/build:
Services restarted by Mickey:
Flags:
Batch:
RingCX lead count:

Gate 0 build/route:
Gate 1 stack/flags:
Gate 2 clean inventory:
Gate 3 poller/current ownership:
Gate 4 terminal loop:
Gate 5 system disposition:
Gate 6 wrap queue:
Gate 7 break/availability:
Gate 8 compliance/queue safety:
Gate 9 legacy containment:

Known exceptions accepted for this run:
Unexpected failures:
Evidence links/log markers:
Next safe step:
```

## Current Recommendation

Local alpha can continue if the test batch is clean and `CX_FIRST_TOUCH_ENABLED` remains off.

Do not call bulk broadly alpha-certified until:
- `CxCallWrapCard` unique index is promoted or otherwise verified;
- Logics transient failures are separated from confirmed compliance blocks;
- wrap-card resolution failures are visible or repairable;
- wrap appointment datetime is timezone-explicit;
- first-touch has a consumer before its stamp is enabled.
