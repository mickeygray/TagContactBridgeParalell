# CX Rollout Codex Log - 2026-07-08

## 2026-07-08T08:19:06-07:00 - WO1 No-Show Release Tool

Implemented the first rollout work-order slice in `scripts/cx-pilot-queue.js`:

- Added `noshow-release` dry-run-first subcommand.
- No-show check uses both required signals:
  - zero `CxBulkLoadSession` rows for the source agent since the Pacific 06:00 cutoff with status `running|killed`;
  - zero pilot rows for that source agent with today dial evidence.
- Release set is scoped to `queueFamily:"pilot"`, `state:"ready"|"claimed"`, and `placedCalls:0`.
- Armed release requires explicit `--to <email>` so receiver route stamps are exact.
- Release patch sets top-of-pile fields, clears old reservation/publish ownership metadata, re-stamps the receiver route, and stamps `metadata.noShowRelease`.
- Added structured console markers:
  - `cx.alpha.noshow.checked`
  - `cx.alpha.noshow.released`

Added `tests/cx-bulk-load/cxNoShowRelease.test.js` with pins for:

- session-query status/cutoff shape;
- pilot-only/dialed-only activity query;
- release filter never selecting non-pilot or dialed rows;
- route restamp + old ownership cleanup patch;
- released rows sorting ahead of a fresh rank-zero pilot row;
- dry-run no-write guard.

Verification:

- `node --test tests/cx-bulk-load/cxNoShowRelease.test.js` -> 7 pass / 0 fail.
- `node --check scripts/cx-pilot-queue.js` -> pass.
- `node --test tests/cx-bulk-load/*.test.js` -> 386 pass / 0 fail.

Not run:

- No live dry-run against Atlas yet. This slice was verified with pure tests only; no queue rows were read or changed.

Next safe step:

- If Mickey wants the live dry-run, run `node scripts/cx-pilot-queue.js noshow-release --agent <source> --to <receiver>` and inspect the `cx.alpha.noshow.checked` line before any `--arm`.

## 2026-07-08T08:24:08-07:00 - WO3 Checklist Stragglers

Verified Phase 2 checklist stragglers:

- Item 5 done: `scripts/sync-indexes.js` already carries `CxCallWrapCard` in the model allowlist.
- Item 7 done: wrap-card resolve effects already return per-effect status, and the client shows a persistent red toast for failed external writes.
- Item 6 was still open: the call-wrap appointment picker sent a bare browser `datetime-local` value.

Implemented item 6:

- Replaced the wrap-card appointment picker payload with explicit `appointmentDate`, `appointmentTime`, and `appointmentTimezone`.
- Kept legacy `appointmentAt` support alive in the wrap-card service for existing callers/tests.
- Forwarded the explicit fields through the control-plane route and into `createCxAppointment`, which already knows how to parse timezone-explicit appointment requests.
- Added a wrap-card service pin proving explicit date/time/timezone reaches the appointment effect.

Verification:

- `node --test tests/cx-bulk-load/cxCallWrapCardService.test.js tests/cx-bulk-load/cxDeleteRunFleet.test.js` -> 11 pass / 0 fail.
- `node --test tests/cx-bulk-load/*.test.js` -> 387 pass / 0 fail.
- `npm.cmd run build --workspace=web-client` -> pass.
- `git diff --check` on touched files -> pass, with only the repo's normal CRLF warnings.

Notes:

- The remaining `datetime-local` controls in `CXWorkspaceBulkLoad.tsx` are Logics task due/reminder fields, not the wrap-card appointment picker.
- Mickey still owns the rebuild/restart path for the running local client if this UI needs to be visible immediately.

## 2026-07-08T08:25:02-07:00 - WO4 Deploy-Day Parity Prep

Added a document-only `UBUNTU PUSH-DAY CHECKLIST` section to `docs/CX_FLOOR_ROLLOUT_USER_BY_USER_2026-07-08.md`.

The section records:

- live `.env` deploy gate before restart:
  - `CX_CALL_WRAP_QUEUE_ENABLED=true`
  - `CX_SYSDISPO_CLASSIFIER_ENABLED=true`
- flags that must stay absent/off on live unless a separate lane rollout explicitly says otherwise;
- inert code that can ride the push safely while its env switches stay absent;
- readback checks after Mickey deploys/restarts;
- no Codex queue writes on Ubuntu.

Verification:

- Documentation-only change; no code gate required beyond the already green WO3 gates.

OPEN QUESTIONS FOR MICKEY:

- For any live push, confirm the exact deploy window and whether you want me limited to read-only log/watch checks afterward.

## 2026-07-08T08:31:46-07:00 - Sean Forwarder Low-Impact Hardening

Mickey clarified the priority: prove the live forwarder is low-impact on the regular floor and thoroughly tested; env flags come later.

Audited `cxSeanFirstTouchDripService` and tightened the write-time safety checks:

- Candidate query is limited to:
  - `domain` configured for the test;
  - `state:"ready"`;
  - `queueFamily:"fresh-day1"`;
  - `placedCalls` zero/null;
  - no assignment;
  - `metadata.requestedBy:"intake-first-contact"`;
  - no existing `metadata.seanFirstTouchTest`;
  - not lane-owned (`metadata.firstTouchPending` not true);
  - not appointment-owned;
  - recent mint window only.
- Claim CAS now re-checks that full shape at write time. A stale read, floor claim, lane claim, prior Sean selection, non-fresh row, or already-dialed row simply fails the claim and publishes nothing.
- Publish-failure release now only frees a Sean-held, undialed claim for Sean's configured extension.
- Legacy extern shape remains `parallel:<DOMAIN>:<caseId>:<queueRowId>`.

Added/expanded tests in `tests/cx-bulk-load/cxSeanFirstTouchDrip.test.js`:

- candidate query is floor-safe;
- recent-selection guard is domain-scoped and durable;
- claim CAS rechecks floor-safe shape;
- publish-failure release only frees Sean-held undialed rows;
- legacy extern identity shape remains the floor-compatible convention;
- existing flag-off, dry-run zero-write, min-gap, claim-lost, publish-reject, max-per-tick, and env override pins still pass.

Verification:

- `node --test tests/cx-bulk-load/cxSeanFirstTouchDrip.test.js` -> 13 pass / 0 fail.
- `node --check packages/shared-services/src/cxSeanFirstTouchDripService.js` -> pass.
- `node --test tests/cx-bulk-load/*.test.js` -> 392 pass / 0 fail.

Readiness read:

- With `CX_SEAN_FIRST_TOUCH_TEST_ENABLED` absent/false, the interval is a no-op before DB reads.
- With dry-run true, the worker reads and narrates candidates but writes nothing.
- With live mode true, blast radius is bounded by `MAX_PER_TICK`, `MIN_GAP_MINUTES`, the fresh-mint window, and the claim CAS.
- The regular floor can still win every race; claim-lost means no publish and no release.

## 2026-07-08T08:50:00-07:00 - Sean Mixed Pilot Pool Builder

Mickey asked for Sean's sequestered refill pool to be about 300 names with a color mix: 60% green, 30% blue, 5% yellow, 5% red.

Verified the existing rollout shape:

- `queueFamily:"pilot"` is the quarantine/refill pool; floor workers do not enumerate it.
- Pilot rows are still route-stamped to Sean's RingCX campaign/dial group.
- Color mapping:
  - green = `fresh-day1`
  - blue = `fresh-day2to10`
  - yellow = `fresh-day16to30`
  - red = `aged`

Implemented `scripts/cx-pilot-queue.js build-mix`:

- Dry-run by default; `--arm` is still Mickey-only.
- Selects from safe `LeadCadence` material:
  - active;
  - not DNC/staged-out;
  - phone + name present;
  - no active `CxDialQueue` row for the case;
  - no CX dial inside the chosen cooldown window.
- Writes only `queueFamily:"pilot"` rows when armed.
- Stores the source family/color in metadata:
  - `metadata.pilotSourceFamily`
  - `metadata.pilotSourceColor`
  - `metadata.pilotMix`
- Interleaves `queueFamilyRank` so blue/yellow/red are not buried behind the whole green block.
- Arm-time upsert filter now re-checks any active row for the same case, independent of this batch tag. If the floor or another tool claims the case between dry-run and arm, the builder skips instead of creating a duplicate active row.

Dry-run findings:

- Exact requested mix, default 30-day cooldown:
  - command: `node scripts/cx-pilot-queue.js build-mix --agent slucas@taxadvocategroup.com --count 300 --mix 60/30/5/5 --tag pilot-slucas-mix-20260708`
  - selected `73/300`: green `40/180`, blue `3/90`, yellow `15/15`, red `15/15`.
- Exact requested mix, relaxed 1-day cooldown:
  - command: `node scripts/cx-pilot-queue.js build-mix --agent slucas@taxadvocategroup.com --count 300 --mix 60/30/5/5 --cooldown-days 1 --tag pilot-slucas-mix-20260708`
  - selected `162/300`: green `42/180`, blue `90/90`, yellow `15/15`, red `15/15`.
- Practical low-impact compromise, relaxed 1-day cooldown:
  - command: `node scripts/cx-pilot-queue.js build-mix --agent slucas@taxadvocategroup.com --count 300 --mix 14/76/5/5 --cooldown-days 1 --tag pilot-slucas-mix-20260708`
  - selected `300/300`: green `42/42`, blue `228/228`, yellow `15/15`, red `15/15`.
  - excluded `2650` cases with active queue rows before selection.
  - dry-run only; no rows written.

Interpretation:

- The exact 60/30/5/5 pool is blocked today by safe green availability, not by tooling.
- The floor-safe path is to keep all 300 sequestered in `pilot` and fill the green shortfall with blue.
- Forcing 180 green would require waiting for more green intake or violating the low-impact rule by touching active/floor-owned rows.

Verification:

- `node --check scripts/cx-pilot-queue.js` -> pass.
- `node --test tests/cx-bulk-load/cxPilotQueueMix.test.js tests/cx-bulk-load/cxNoShowRelease.test.js tests/cx-bulk-load/cxSeanFirstTouchDrip.test.js` -> 25 pass / 0 fail.
- `node --test tests/cx-bulk-load/*.test.js` -> 397 pass / 0 fail.

OPEN QUESTIONS FOR MICKEY:

- Approve the 300-row compromise pool: green `42`, blue `228`, yellow `15`, red `15`?
- If yes, Mickey arms the exact command by adding `--arm` to the practical command above.
- If no, wait for more green intake or choose a smaller pool that preserves the original 60/30/5/5 ratio.

## 2026-07-08T08:59:00-07:00 - Untimed Pause Dials Button

Mickey asked for a permanent break-style control so Sean can pause CX dialing while taking a mail call.

Implemented:

- Added a `work-pause` CX pause type.
- `work-pause` normalizes from aliases like `working`, `mail-call`, and `pause-dials`.
- `work-pause` writes manual CX routing as unavailable but does not create a timed `pauseReleaseAt`.
- `work-pause` does not increment short/meal break usage.
- The manual-unavailable timeout release watcher skips untimed pause types, so it will not release/reset the pause like a stale timed break.
- The CX header availability control now shows a `Pause dials` button next to the existing 5-minute and 15-minute buttons.
- When a bulk session is running, `Pause dials` calls the same progressive pause path as the break buttons with `holdUntilResume:true`; RingCX receives the configured pause state (currently the WORKING state in local tests).
- Resuming still goes through `Available`, which calls the same progressive resume path and tells the agent to go off hook in RingCX.

Expected behavior:

- Click `Pause dials`: CX routing becomes unavailable with `pauseType:"work-pause"`, the header badge reads `Working`, and fresh/bulk dialing stays paused indefinitely.
- Click `Available`: CX routing returns available and the bulk progressive pause is resumed.
- Short/meal break counters are unchanged by `Pause dials`.

Verification:

- `node --check packages/shared-services/src/agentAvailabilityService.js; node --check packages/shared-services/src/cxCadenceService.js` -> pass.
- `node --test tests/queue/activityState.test.js tests/queue/cxManualUnavailableRelease.test.js tests/cx-bulk-load/cxBulkLoadRuntime.test.js` -> 30 pass / 0 fail.
- `npm.cmd run build --workspace=web-client` -> pass.
- `node --test tests/queue/*.test.js` -> 153 pass / 0 fail.
- `node --test tests/cx-bulk-load/*.test.js` -> 397 pass / 0 fail.

## 2026-07-08T09:15:00-07:00 - Pause Dials Stops Slow-Steady Feed

Mickey called out a rollout hazard: putting Sean into a mail-call/work pause must not
only stop the UI/bulk lane. The regular slow-steady cadence rail also has to stop
feeding him and stop acting on already-fed work.

Findings:

- Regular cadence assignment already excludes agents whose
  `cxRouting.desiredAvailability` is `unavailable`.
- `Pause dials` writes `desiredAvailability:"unavailable"` with
  `pauseType:"work-pause"`, so new slow-steady assignments are blocked once the status
  mutation lands.
- Gap found: the status route previously returned a delayed queue-release marker, and
  the timed release watcher now intentionally skips untimed `work-pause` states. That
  meant already-assigned regular rows could remain assigned to Sean during a work pause.

Implemented:

- `requestCxStatusChange` now performs an immediate queue release only for
  `pauseType:"work-pause"`.
- Existing short/meal break behavior stays delayed/unchanged.
- `releaseAssignedCxQueueForAgent` accepts the explicit pause type and preserves
  untimed pauses with `pauseReleaseAt:null`.
- Bulk-owned rows remain protected by the existing bulk-load release guard; the cleanout
  targets regular assigned rows and does not mutate bulk-owned rows.

Expected behavior:

- Click `Pause dials`: Sean becomes unavailable to regular cadence assignment, any
  already-assigned regular queue rows are released/cancelled, and the pause remains
  indefinite until `Available`.
- Click `Available`: the regular eligibility kick can resume feeding him, and the bulk
  progressive resume path still runs when a bulk session exists.

Verification:

- `node --check packages/shared-services/src/cxWorkspaceService.js` -> pass.
- `node --check packages/shared-services/src/cxCadenceService.js` -> pass.
- `node --test tests/queue/cxManualUnavailableRelease.test.js tests/queue/cxLoadBalancerEligibility.test.js tests/queue/activityState.test.js` -> 32 pass / 0 fail.
- `node --test tests/queue/*.test.js` -> 155 pass / 0 fail.
- `node --test tests/cx-bulk-load/*.test.js` -> 397 pass / 0 fail.

OPEN QUESTIONS FOR MICKEY:

- Before turning Sean on, should `Pause dials` be pressed while his normal CX campaign is
  already empty, or do we intentionally use this cleanout as the formal handoff step from
  regular floor work to the pilot block?

## 2026-07-08T09:35:00-07:00 - Chris Pivot Guide

Mickey raised a possible pivot from Sean to Chris to avoid building the first live churn
block around Sean's mail-call interruptions.

Created `.ai/context/CX_CHRIS_PILOT_PIVOT_GUIDE_2026-07-08.md`.

Key findings written into the guide:

- Chris's pilot route resolves through the existing tool:
  account `50810001`, campaign `2458`, dial group `1068`.
- Repo-backed Chris IDs: `cbolt@taxadvocategroup.com`, extension id `63914586004`,
  CX agent id `21810`, first-touch campaign `2829`, appointment campaign `2900`.
- Chris has no existing WYNN pilot rows in the read-only pilot status check.
- The pool/bulk pivot is mostly agent-email based.
- The first-touch drip is mechanically configurable to Chris but still Sean-named in env,
  metadata, and logs, so that is the one confusing piece to either tolerate for one test
  or genericize deliberately.
- The same slow-steady contamination risk exists for Chris unless regular cadence is
  blocked or his regular queue is manually drained/held during the pilot block.

No workflow code was changed for this guide.

## 2026-07-08T09:45:00-07:00 - Campaign Inventory For Chris Pivot

Mickey asked to start by gathering all campaigns that need to be targeted.

Added a campaign inventory section to
`.ai/context/CX_CHRIS_PILOT_PIVOT_GUIDE_2026-07-08.md`.

Read-only checks:

- `node scripts/cx-pilot-queue.js status --agent slucas@taxadvocategroup.com --domain WYNN`
  -> account `50810001`, campaign `2344`, dial group `1011`, no WYNN pilot rows.
- `node scripts/cx-pilot-queue.js status --agent ballen@taxadvocategroup.com --domain WYNN`
  -> account `50810001`, campaign `2345`, dial group `1012`, no WYNN pilot rows.
- `node scripts/cx-pilot-queue.js status --agent polson@taxadvocategroup.com --domain WYNN`
  -> account `50810001`, campaign `2347`, dial group `1014`, no WYNN pilot rows.
- `node scripts/cx-pilot-queue.js status --agent bhansen@taxadvocategroup.com --domain WYNN`
  -> account `50810001`, campaign `2457`, dial group `1067`, no WYNN pilot rows.
- `node scripts/cx-pilot-queue.js status --agent cbolt@taxadvocategroup.com --domain WYNN`
  -> account `50810001`, campaign `2458`, dial group `1068`, no WYNN pilot rows.

Chris target set:

- Regular/bulk/pilot: campaign `2458`, dial group `1068`.
- First-touch: campaign `2829`, dial group `1068`.
- Appointment: campaign `2900`, dial group `1068`.

If lane priority is tested, Chris dial group `1068` is the target group and the intended
priority order is appointment `2900` priority `10`, first-touch `2829` priority `5`,
regular/bulk `2458` priority `1`.

Current local lane maps are still Mickey-only (`mgray` -> `2910`/`2911`), so Chris is
not currently targeted by lane maps.

## 2026-07-08T09:58:00-07:00 - Chris Combined Canary Readiness

Mickey confirmed the Chris test should include first-touch and appointment interruptions,
not just bulk churn.

Read-only RingCX settings check for Chris:

- Dial group `1068` ("Chris"): `enableAbsolutePriority=false`, `enableListPriority=false`,
  `dialMode=PREVIEW`, active.
- Campaign `2458` ("Chris"): active, `campaignPriority=1`, `dialLoadedOrder=0`.
- Campaign `2829` ("Chris First Touch"): active, `campaignPriority=1`,
  `dialLoadedOrder=0`.
- Campaign `2900` ("Chris Appointment"): active, `campaignPriority=1`,
  `dialLoadedOrder=0`.

Conclusion:

- Campaigns exist and are active.
- `dialLoadedOrder=0` is already good.
- Priority is not ready: with `enableAbsolutePriority=false` and all priorities at `1`,
  first-touch/appointment will not reliably interrupt the regular/bulk list.

Needed before Chris combined canary:

- RingCX dial group `1068`: set `enableAbsolutePriority=true`.
- Campaign priorities under group `1068`: appointment `2900 -> 10`, first-touch
  `2829 -> 5`, regular/bulk `2458 -> 1`.
- Local env on restart: `CX_BULK_RESERVE_PILOT_FAMILY=pilot`,
  `CX_ALPHA_TRACE_AGENT=cbolt@taxadvocategroup.com`,
  `CX_FIRST_TOUCH_QUEUE_MAP={"cbolt@taxadvocategroup.com":2829}`,
  `CX_APPT_QUEUE_MAP={"cbolt@taxadvocategroup.com":2900}` with both lane flags enabled.

No RingCX writes or local env edits were made.

## 2026-07-08T10:10:00-07:00 - Chris Combined Canary Operator Script

Mickey wanted the API priority flip to happen last, with a script ready to handle that
and the Chris queue build while env/restart stays under Mickey's hand.

Created `scripts/cx-chris-combined-canary.js`.

Behavior:

- Dry-run by default.
- Prints target Chris env and current env snapshot.
- Reads Chris RingCX group/campaign settings.
- Runs `scripts/cx-pilot-queue.js build-mix --agent cbolt@taxadvocategroup.com` to
  build/dry-run the pilot pool.
- Applies RingCX priority settings only when explicitly armed.
- Priority writes always run last; if queue build fails, no RingCX priority writes run.

Write gates:

- Queue: `--queue-arm` or `CX_CHRIS_CANARY_ARM_QUEUE=true`.
- RingCX priority: `--apply-ringcx` or `CX_CHRIS_CANARY_APPLY_RINGCX=true`.

Useful calls:

- Full dry-run: `node scripts/cx-chris-combined-canary.js`
- Queue only: `node scripts/cx-chris-combined-canary.js --queue-arm --skip-ringcx`
- Priority finalizer only: `node scripts/cx-chris-combined-canary.js --skip-queue --apply-ringcx`
- All at once: `node scripts/cx-chris-combined-canary.js --queue-arm --apply-ringcx`

Verification:

- `node --check scripts/cx-chris-combined-canary.js` -> pass.
- `node scripts/cx-chris-combined-canary.js --skip-queue` -> pass, dry-run only. It
  reported the expected RingCX patch: dial group `1068` absolute priority false -> true,
  campaign `2829` priority `1 -> 5`, campaign `2900` priority `1 -> 10`.
- `node scripts/cx-chris-combined-canary.js --skip-ringcx --count 1 --tag pilot-cbolt-wrapper-smoke`
  -> pass, dry-run only. It invoked `cx-pilot-queue.js build-mix` for Chris and selected
  one masked green row without writing.

No RingCX writes, Mongo writes, env edits, or service restarts were performed.

## 2026-07-08T10:18:00-07:00 - Live RingCX Chris Priority Applied

Mickey asked to do the live work needed for first-touch/appointment ordering.

Ran:

```powershell
node scripts/cx-chris-combined-canary.js --skip-queue --apply-ringcx
```

Scope:

- RingCX API settings only.
- No Mongo writes.
- No local `.env` edits.
- No service restarts.
- No queue build.

Applied:

- Dial group `1068` ("Chris"): `enableAbsolutePriority false -> true`.
- Campaign `2829` ("Chris First Touch"): `campaignPriority 1 -> 5`.
- Campaign `2900` ("Chris Appointment"): `campaignPriority 1 -> 10`.
- Campaign `2458` ("Chris"): remained `campaignPriority=1`.

Read-back verified:

- Dial group `1068`: `enableAbsolutePriority=true`, `enableListPriority=false`,
  `dialMode=PREVIEW`, active.
- Campaign `2458`: active, `campaignPriority=1`, `dialLoadedOrder=0`.
- Campaign `2829`: active, `campaignPriority=5`, `dialLoadedOrder=0`.
- Campaign `2900`: active, `campaignPriority=10`, `dialLoadedOrder=0`.

Remaining before Chris canary:

- Mickey applies local env/restart for Chris maps and pilot reserve.
- Build/arm Chris pilot pool.
- Isolate Chris from regular slow-steady cadence during the test block.

## 2026-07-08T10:32:00-07:00 - Chris Regular-Floor Isolation Gate Added

Mickey clarified that Chris must not clash with regular slow-steady while running the
pilot canary.

Updated `scripts/cx-chris-combined-canary.js` with a read-only isolation gate that runs
before RingCX priority checks or queue work unless explicitly skipped.

The gate checks:

- Chris AgentState for `cxRouting.desiredAvailability:"unavailable"`.
- Chris AgentState for untimed `pauseType:"work-pause"` with no `pauseReleaseAt`.
- Active assigned `CxDialQueue` rows for Chris extension `63914586004`.
- Pilot rows (`queueFamily:"pilot"`) are allowed.
- First-touch/appointment lane rows in campaigns `2829`/`2900` are reported separately.
- Any other active assigned row is a regular-floor clash and blocks the canary helper.

Verification:

- `node --check scripts/cx-chris-combined-canary.js` -> pass.
- `node scripts/cx-chris-combined-canary.js --skip-queue --skip-ringcx` -> blocked as
  intended, read-only.

Observed block:

- Chris AgentState is currently `desiredAvailability=available`, `pauseType=null`.
- 40 active non-pilot/non-lane queue rows are assigned to Chris.
- Those rows include regular floor families such as `fresh-day1`, `fresh-day2to10`,
  `fresh-day16to30`, and `aged`, all in `claimed` state.
- Several route stamps are not Chris's canary campaign, which makes the clash risk
  clearer rather than theoretical.

Conclusion:

- RingCX priority is ready from the earlier apply.
- Chris is not yet isolated from regular cadence.
- Before arming the canary: put Chris into the untimed work-pause boundary and clear or
  release the currently assigned regular-floor rows, then rerun the isolation gate until
  it passes.

## 2026-07-08T10:49:00-07:00 - Chris Isolated And Pilot Pool Loaded

Mickey said the test can start as soon as Chris is not clashing with regular floor work
and his pilot leads are loaded.

Added guarded cleanup mode to `scripts/cx-chris-combined-canary.js`:

- `--isolate-only` runs just the isolation check/cleanup lane.
- `--isolate-apply` writes the isolation cleanup.
- Default cleanup is still dry-run.
- Cleanup refuses `serving` regular rows unless `--include-serving` is explicitly passed.
- Cleanup sets Chris to untimed `work-pause` and releases only active regular-clash rows;
  pilot rows and lane rows are not treated as regular clashes.

Ran dry-run:

- Chris was `desiredAvailability=available`, `pauseType=null`.
- 47 active regular-clash rows were assigned to Chris.
- All were `claimed`; no `serving` rows were present.

Applied:

```powershell
node scripts/cx-chris-combined-canary.js --isolate-only --isolate-apply
```

Result:

- 47 regular-clash rows released back to ready.
- RingCX published copies were cancelled where publish stamps existed.
- Chris AgentState now has `desiredAvailability=unavailable`, `pauseType=work-pause`,
  `pauseReleaseAt=null`.
- Isolation gate passed with zero active assigned rows for Chris.

Pilot pool build:

- Strict requested mix `60/30/5/5` with 30-day cooldown could only find 73/300 rows:
  green 40, blue 3, yellow 15, red 15.
- Used the documented fallback shape with 1-day cooldown:
  `14/76/5/5`, selecting green 42, blue 228, yellow 15, red 15.

Applied:

```powershell
node scripts/cx-chris-combined-canary.js --skip-ringcx --queue-arm --mix 14/76/5/5 --cooldown-days 1 --tag pilot-cbolt-mix-20260708
```

Verified:

```powershell
node scripts/cx-pilot-queue.js status --agent cbolt@taxadvocategroup.com --domain WYNN
```

Result:

- Initial status showed `pilot-cbolt-mix-20260708 ready: 299`.
- The batch had no hidden claimed/serving/completed row; it was simply one row short
  under the Chris pilot-agent stamp.
- Topped up one blue row directly through the pilot builder with a wider scan:
  `node scripts/cx-pilot-queue.js build-mix --agent cbolt@taxadvocategroup.com --domain WYNN --count 1 --mix 0/100/0/0 --tag pilot-cbolt-mix-20260708 --cooldown-days 1 --max-scan 24000 --arm`.
- The top-up case briefly showed pilot metadata while still carrying `queueFamily:fresh-day1`;
  corrected that exact ready/undialed row to `queueFamily:pilot` before the final check.
- Final status: `pilot-cbolt-mix-20260708 ready: 300`.
- Final color mix: green 42, blue 228, yellow 15, red 15.
- RingCX priority read-back remains correct:
  - dial group `1068` absolute priority true.
  - campaign `2458` priority 1.
  - campaign `2829` priority 5.
  - campaign `2900` priority 10.
- Chris later appeared as `activityState=offline`, `pauseType=logout`, with
  `desiredAvailability=unavailable` and zero active assigned rows. The canary gate now
  treats logout as a safe pre-test holding state; work-pause remains the preferred
  manual holding state.

Restart + first Chris load:

- Mickey restarted `ParallelControlPlane` after the Chris flags were set.
- Runtime precheck after restart showed:
  - Chris runtime resolves to `bulk_load`.
  - Sean resolves to `slow_single`; Sean is not in the override map.
  - Chris lane maps point to first-touch campaign `2829` and appointment campaign `2900`.
- First session preload only accepted 13/30 because 17 candidate rows were rejected by
  runtime contact eligibility as `blocked-stage`.
- Read-only eligibility pass over the remaining ready pilot rows found 227/271 valid
  and 44 additional `blocked-stage` rows.
- Cleanup applied:
  - Cancelled those 44 ready-only bad pilot rows with
    `metadata.cancelledReason=chris-pilot-preflight:blocked-stage`.
  - Corrected one ready/undialed pilot-batch row that still had `queueFamily:fresh-day1`
    back to `queueFamily:pilot`.
- Replaced the half-loaded session through the normal bulk runtime start path. The old
  13-row session was killed as `replaced-by-new-session`, releasing its reserved rows.
- New running Chris session:
  - `cxbl-9563a503-f034-4278-aad6-265e8e2fa629`
  - phase `waiting_offhook`
  - buffer count `30`
  - family targets `{ pilot: 30 }`
  - current call `null`
  - last error `null`
- Final pilot batch status:
  - `claimed: 30`
  - `ready: 210`
  - `cancelled: 61`
  - active non-pilot rows in the batch: `0`
- Isolation gate passed: Chris has no regular-floor clash rows; all active assigned
  rows are the 30 claimed pilot rows.

Follow-up:

- `scripts/cx-pilot-queue.js build-mix` should be tightened to mirror
  `resolveCaseContactEligibility` before the next rebuild. The builder's local
  cadence-only screen missed `blocked-stage` case-profile signals that the live loader
  correctly rejected.

## Stale Ownership Family Note

Mickey identified the no-show release problem and Chris's stale-browser problem as the
same bug family: stale ownership artifacts outliving the thing that owned them.

Documented:

- Added `.ai/context/CX_STALE_OWNERSHIP_FAMILY_2026-07-08.md`.
- Added Work Order 6 to `.ai/context/CX_ROLLOUT_MARCHING_ORDERS_CODEX_2026-07-08.md`.

Shared rule:

- Prove current ownership before serving, displaying, or completing work.
- If ownership is stale, clean up or rebind.
- Do not invent outcomes or let autonomous pruning decide that a lead is bad.

Inventory-side shape:

- No-show release cancels RingCX copies first, scoped to our publish stamps/extern ids.
- Mongo release follows with no priority weight.
- Distribution must be explicit: `pool` or `bottom`.
- Rows with `placedCalls > 0` are never released as undialed.

Client-side shape:

- `/api/cx/bulk-load/session` is canonical for the running session.
- If a client is bound to a killed/replaced session, clear its stale card/buttons and
  rebind to the canonical running session.
- Dispositions against stale sessions should fail closed with a structured stale-session
  response.

Open question before final no-show coding:

- Verify whether released rows need route re-stamping for another agent's route-lock, or
  whether `pool` should clear route ownership until the next reservation.

## Queue Build / Release / Fresh Lane Airtight Pass

Mickey called out the three things that must be airtight before leaving the office:
queue build, release, and fresh/appointment queues.

Changed locally:

- `scripts/cx-pilot-queue.js build` and `build-mix` now call the shared
  `resolveCaseContactEligibility` gate before selecting a pilot row. This closes the
  Chris dry-run gap where the builder selected rows the runtime later rejected as
  `blocked-stage`.
- `noshow-release` no longer gives released rows artificial priority. It keeps normal
  `priorityScore:100` and does not reset `queueFamilyRank` to jump the line.
- `noshow-release` now performs RingCX cleanout before Mongo release for rows with
  publish stamps. If any RingCX cancel fails, the Mongo release is aborted.
- Tests now pin dry-run RingCX cleanout as no-write and armed cancel failures as visible.

Route-lock finding:

- Current reservation queries require exact `rcxAccountId`, `rcxCampaignId`, and
  `rcxDialGroupId` when a bulk session reserves rows.
- Therefore, a no-show row released to a generic shared pool is not automatically
  claimable by another agent today. The safe armed path remains receiver-restamped
  release/bottom-style distribution. A true shared pool needs a separate route assignment
  step before reservation.

Verification:

- `node --check scripts/cx-pilot-queue.js` -> pass.
- Focused gate: `node --test tests/cx-bulk-load/cxNoShowRelease.test.js
  tests/cx-bulk-load/cxPilotQueueMix.test.js
  tests/cx-bulk-load/cxSeanFirstTouchDrip.test.js
  tests/cx-bulk-load/cxLaneDispatch.test.js` -> 44 pass / 0 fail.
- Full bulk gate: `node --test tests/cx-bulk-load/*.test.js` -> 408 pass / 0 fail.
- Queue gate: `node --test tests/queue/*.test.js` -> 155 pass / 0 fail.

Read-only / dry-run probes:

- Chris no-show dry-run held correctly: sessions since 6am = 5, dialed today = 33,
  releasable = 207, verdict = hold.
- Chris build dry-run with the previous `14/76/5/5` thirty-lead shape selected 29/30;
  the only short bucket was green. The runtime gate skipped 79 `blocked-stage` cases
  instead of letting them reach the loader.
- Chris build dry-run with fallback `10/80/7/3` selected 30/30 and skipped 78
  `blocked-stage` cases.
- Pilot status read-only: Chris has 223 ready, 17 completed, 61 cancelled in
  `pilot-cbolt-mix-20260708`.

Operational note:

- For another Chris top-off today, prefer the fallback thirty-lead command:
  `node scripts/cx-pilot-queue.js build-mix --agent cbolt@taxadvocategroup.com --domain WYNN --count 30 --mix 10/80/7/3 --cooldown-days 1 --max-scan 8000 --tag <new-tag>`.
  Add `--arm` only when Mickey is ready to write rows.

## Morning Builder Active-Floor Guard

Mickey caught the core target-selection issue: being present in CX / routing-enabled is
not the same thing as answering the phone today. The scheduled morning builder cannot
stage work for every CX-enabled account.

Changed locally:

- `cxMorningQueueBuilderService` now supports explicit working-floor allowlists via:
  - `CX_MORNING_QUEUE_BUILDER_AGENT_EMAILS`
  - `CX_MORNING_QUEUE_BUILDER_EXTENSION_IDS`
- The env-driven scheduled path now fails closed when no allowlist is present. With no
  named floor, it selects zero agents instead of sweeping all routing-enabled accounts.
- Broad discovery is still possible only by explicitly setting
  `CX_MORNING_QUEUE_BUILDER_ALLOW_BROAD_DISCOVERY=true`.
- The scheduled builder still defaults to `WYNN` because account company values are not
  reliable domain truth for this rollout.

Verification:

- `node --check packages/shared-services/src/cxMorningQueueBuilderService.js` -> pass.
- `node --check scripts/cx-morning-queue-scale-audit.js` -> pass.
- Focused gate: `node --test tests/cx-bulk-load/cxMorningQueueBuilderService.test.js
  tests/cx-bulk-load/cxNoShowRelease.test.js
  tests/cx-bulk-load/cxPilotQueueMix.test.js` -> 22 pass / 0 fail.
- Full bulk gate: `node --test tests/cx-bulk-load/*.test.js` -> 417 pass / 0 fail.

Read-only scale audit:

- With no allowlist: `targetAgentCount: 0`, `dryRunTotals.agents: 0`. This proves the
  scheduled path is fail-closed and will not stage people merely because they exist in
  CX.
- With the four-agent rollout allowlist
  (`slucas@`, `bhansen@`, `cbolt@`, `polson@`): `targetAgentCount: 4`,
  `dryRunTotals.agents: 4`, `publishAttempted: 0` because mirror remains off.

Open hazard found by the audit:

- Current local queue state still contains assigned active rows whose stored RingCX
  campaign/dial-group does not match the agent route. The four-agent audit saw 106 route
  mismatches and 11 duplicate active case groups. This appears to be residue from the
  same-day test reshuffles, but it means the next true scale/morning test needs a clean
  drain/rebuild before judging the builder.

Next safe env shape when Mickey is ready:

```text
CX_MORNING_QUEUE_BUILDER_AGENT_EMAILS=slucas@taxadvocategroup.com,bhansen@taxadvocategroup.com,cbolt@taxadvocategroup.com,polson@taxadvocategroup.com
CX_MORNING_QUEUE_BUILDER_ALLOW_BROAD_DISCOVERY=false
```

## Live Env Flip / 5-6 First-Touch Window

Clarification from Mickey: the intent was to get the live `.env` set up, not deploy the
whole local working tree. A full code overlay did not happen.

Actions completed before the clarification:

- Local `.env` was made explicit for the current alpha shape:
  - bulk runtime on.
  - call wrap queue on.
  - system-disposition classifier on.
  - alpha trace enabled with no agent filter.
  - first-touch and appointment lanes on.
  - lane maps narrowed to the four active rollout agents: Sean, Phil, Brad, Chris.
  - morning builder on with WYNN, limit 30, mirror off, and those same four agents.
  - broad morning-builder discovery off.
  - pilot-family reservation blank/off.
- Live `.env` was updated with the same non-secret flag block and backed up at
  `/tmp/codex-env-backups/.env.20260708233531.bak`.
- Live `parallel-control-plane` and `parallel-ringcentral-cx` were restarted.
- Health checks passed on `127.0.0.1:5001/health` and `127.0.0.1:6101/health`.
- A focused live test for the morning-builder service passed: 9 pass / 0 fail.
- The small morning-builder code slice had already been copied to live before the
  clarification. Backup: `/tmp/codex-live-drop-20260708233515`.

Live 5-6 first-touch behavior check:

- Live time at check: 2026-07-08 16:38 PDT.
- The first-touch dispatcher clock is:
  - drip before 17:00 PT.
  - hold from 17:00-17:59 PT.
  - assign after 18:00 PT.
- Therefore 5-6 PT is a hold/buffer window: incoming first-touch rows can accumulate,
  but the dispatcher should not publish or assign them until the 18:00 assignment
  window.
- Read-only Mongo check found `pendingReadyOrQueued: 0`, `assigned: 0`, and one old
  dispatched Mickey test row for case 101617. There were no pending rows ready to fire
  before the 17:00 hold window.

Open watch item:

- At 17:00 PT, confirm pending first-touch rows accumulate with no
  `cx.alpha.firsttouch.dispatched` or `cx.alpha.firsttouch.assigned` activity.
- At 18:00 PT, confirm assignment begins and remains round-robin across the four-agent
  map without RingCX publishing.

## Autonomy Dampening Follow-Up

Source: Fable handoff pasted in the thread after the stale-feed/offhook client fixes.
Mickey's direction was to dampen anything that autonomously decides lead value or dial
execution.

Changes made:

- `contactEligibilityService` now marks fresh Logics status misses as
  `transient:true` and `destructive:false`. A Logics outage or unreadable live status
  can block the current dial attempt, but it no longer runs `stopCaseContact`.
- `cxCadenceService` now puts a claimed queue row back to `queued` on a short retry hold
  when that transient Logics miss happens during ready-claim. Confirmed stored stop
  evidence still cancels normally.
- `cxBulkLoadRuntime` propagates the transient flag through the bulk eligibility adapter;
  bulk reserved rows release instead of canceling on that shape.
- `outboundDispatchService` no longer cancels scheduled outbound actions on transient
  contact-check failure; it records a skipped/transient result so the action can retry.
- `cxWorkspaceService` propagates the transient flag in materialization eligibility
  diagnostics.
- `cxDialQueueMediatorService` stale bucket reconciliation now requires a known
  active-call snapshot before clearing its shadow `currentCall`; omitted/null active
  identities skip as `active-identities-unknown`.
- `ringcxAgentMonitorService` passes `activeIdentitiesKnown:true` only after a successful
  RingCX active-call read.
- `docs/CX_AUTONOMY_DAMPENING_CENSUS_2026-07-08.md` was rewritten in clean ASCII with
  the completed Logics and mediator rulings.

Verification:

- Focused: `node --test tests/cx-bulk-load/cxCadenceHygiene.test.js` -> 7 pass / 0 fail.
- Focused: `node --test tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js` -> pass.
- Focused: `node --test tests/cx-handoff/cxDialQueueMediatorService.test.js` -> 15 pass / 0 fail.
- Syntax: `node --check` passed for `contactEligibilityService.js`,
  `cxCadenceService.js`, `cxDialQueueMediatorService.js`,
  `outboundDispatchService.js`, `cxBulkLoadRuntime.js`, `cxWorkspaceService.js`, and
  `ringcxAgentMonitorService.js`.
- Broader gate: `node --test tests/cx-bulk-load/*.test.js
  tests/cx-handoff/cxDialQueueMediatorService.test.js` -> 440 pass / 0 fail.

Open:

- Still verify `RINGCX_CAMPAIGN_REQUIRE_ACTIVE_CALL_CONFIRMATION` is absent/false on the
  live owner before the final push window.
