# CX Chris Pilot Pivot Guide - 2026-07-08

Purpose: safely pivot the one-agent pilot target from Sean to Chris without changing
the dialing workflow, poller, wrap flow, bulk runtime, or lane semantics.

This is a guide only. No service restart, `.env` edit, `--arm`, or live queue mutation
should happen from Codex. Mickey owns those actions.

## Why Pivot

Sean has mail-call interruptions, so his test needs a permanent pause/hold story.
Chris may be cleaner for a churn block if he can be treated as a dedicated pilot agent
for a few hours. The goal is to avoid building new behavior around Sean's schedule when
the product workflow itself is what we want to test.

The pivot is safe only if Chris is isolated from the regular floor while the pilot runs.
Do not assume that changing the target agent alone prevents regular slow-steady cadence
from feeding him.

## Do Not Touch

These are out of scope for the pivot:

- Bulk poller logic.
- Current-call ownership logic.
- Wrap card creation/resolution logic.
- Disposition transport.
- RingCX button/outcome mapping.
- Client middle-panel workflow.
- Fable/coach files listed in `AGENTS.md`.
- Live Ubuntu code or live services.

The pivot should be configuration, docs, dry-runs, and narrowly scoped safety checks.

## Known Chris Facts

Known from repo docs and local route resolution:

- Email: `cbolt@taxadvocategroup.com`
- Name: `Chris Bolt`
- RingEX extension number: `741`
- Extension id: `63914586004`
- CX agent id: `21810`
- Regular/bulk route: account `50810001`, campaign `2458`, dial group `1068`
- First-touch campaign: `2829`
- Appointment campaign from lane docs: `2900`

Important: the local Mongo verification attempt timed out once. Before arming anything,
verify Chris's live user/account/agent state from a healthy DB connection or RingCX
readback. Treat the facts above as repo-backed, not final live proof.

## Campaign Inventory

Chris-only pilot targets:

| Use | Account | Dial group | Campaign | Source |
| --- | ---: | ---: | ---: | --- |
| Regular/bulk/pilot session route | `50810001` | `1068` | `2458` | `cx-pilot-queue.js status --agent cbolt@...` |
| First-touch drip / first-touch lane | `50810001` | `1068` | `2829` | first-touch campaign docs |
| Appointment lane | `50810001` | `1068` | `2900` | lane campaign map docs |

If lane priority is part of the test, Chris's dial group `1068` is the group that needs
absolute priority enabled, with campaign priority shape:

| Priority | Campaign | Meaning |
| ---: | ---: | --- |
| `10` | `2900` | Chris appointment lane |
| `5` | `2829` | Chris first-touch lane |
| `1` | `2458` | Chris regular/bulk campaign |

Full five-agent rollout inventory gathered from route dry-runs and lane docs:

| Agent | Email | Dial group | Regular/bulk campaign | First-touch campaign | Appointment campaign |
| --- | --- | ---: | ---: | ---: | ---: |
| Sean | `slucas@taxadvocategroup.com` | `1011` | `2344` | `2831` | `2902` |
| Bruce | `ballen@taxadvocategroup.com` | `1012` | `2345` | `2828` | `2899` |
| Phil | `polson@taxadvocategroup.com` | `1014` | `2347` | `2830` | `2901` |
| Brad | `bhansen@taxadvocategroup.com` | `1067` | `2457` | `2827` | `2898` |
| Chris | `cbolt@taxadvocategroup.com` | `1068` | `2458` | `2829` | `2900` |

Read-only route checks on 2026-07-08 showed `PILOT ROWS (WYNN): none` for all five.

Current local env state observed before the Chris pivot:

- `CX_FIRST_TOUCH_QUEUE_MAP={"mgray@taxadvocategroup.com":2910}`
- `CX_APPT_QUEUE_MAP={"mgray@taxadvocategroup.com":2911}`
- Chris is not currently in the lane maps.
- The Sean first-touch drip override env vars are currently unset.

Current local env state after Mickey's 2026-07-08 restart:

- `CX_BULK_RESERVE_PILOT_FAMILY=pilot`
- `CX_ALPHA_TRACE_AGENT=cbolt@taxadvocategroup.com`
- `CX_FIRST_TOUCH_ENABLED=true`
- `CX_FIRST_TOUCH_QUEUE_MAP={"cbolt@taxadvocategroup.com":2829}`
- `CX_APPT_LANE_ENABLED=true`
- `CX_APPT_QUEUE_MAP={"cbolt@taxadvocategroup.com":2900}`
- `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=true`
- `CX_DIAL_RUNTIME_AGENT_OVERRIDES` includes Chris and Mickey; Sean is deliberately
  not in the override map.

Chris regular route aliases currently present in local `.env` include:

- `RINGCX_AGENT_ROUTE_CBOLT_AT_TAXADVOCATEGROUP_COM_CAMPAIGN_ID=2458`
- `RINGCX_AGENT_ROUTE_CBOLT_AT_TAXADVOCATEGROUP_COM_DIAL_GROUP_ID=1068`
- `RINGCX_AGENT_ROUTE_CBOLT_50810001_8283_AT_TAXADVOCATEGROUP_COM_*`
- `RINGCX_AGENT_ROUTE_63914586004_*`
- `RINGCX_AGENT_ROUTE_21810_*`
- `RINGCX_AGENT_ROUTE_CHRIS_BOLT_*`

Do not look only for `RINGCX_AGENT_ROUTE_CBOLT_*`; that guessed shape is blank and will
produce a false negative.

## Chosen Test Shape

Mickey confirmed this Chris pilot should include all three lanes:

1. Regular/bulk churn through campaign `2458`.
2. First-touch interruption through campaign `2829`.
3. Appointment interruption through campaign `2900`.

This means the Chris run is a combined canary, not bulk-only.

## Current Chris Load State

As of the 2026-07-08 restart and preload:

- Running session: `cxbl-9563a503-f034-4278-aad6-265e8e2fa629`.
- Phase: `waiting_offhook`.
- Buffer: `30` accepted RingCX-published pilot rows.
- Current call: none yet.
- Refills remaining: `210` ready pilot rows.
- Cancelled from this batch: `61`.
- Active non-pilot rows in this pilot batch: `0`.
- Isolation gate verdict: `PASS`.

Important pool lesson:

- The first preload accepted only 13/30 because some rows passed the pilot builder's
  cadence-only screen but failed the live contact eligibility gate as `blocked-stage`.
- Before the successful reload, a read-only runtime eligibility pass found and then
  cancelled 44 additional bad ready rows.
- Tighten `scripts/cx-pilot-queue.js build-mix` to use the same runtime eligibility
  concept before the next rebuild, or repeat the preflight cleanup.

## Current RingCX Readiness For Chris

Read-only check on 2026-07-08:

```text
DIAL_GROUP 1068 "Chris"
  enableAbsolutePriority=false
  enableListPriority=false
  dialMode=PREVIEW
  isActive=true

CAMPAIGN 2458 "Chris"
  isActive=1
  campaignPriority=1
  dialLoadedOrder=0
  dispositionTimeout=60
  afterCallBaseState=AVAILABLE

CAMPAIGN 2829 "Chris First Touch"
  isActive=1
  campaignPriority=1
  dialLoadedOrder=0
  dispositionTimeout=60
  afterCallBaseState=AVAILABLE

CAMPAIGN 2900 "Chris Appointment"
  isActive=1
  campaignPriority=1
  dialLoadedOrder=0
  dispositionTimeout=60
  afterCallBaseState=AVAILABLE
```

Interpretation:

- The campaigns exist and are active.
- `dialLoadedOrder=0` is already the lane-friendly shape.
- The blocker is priority: `enableAbsolutePriority=false` means campaign priorities are
  decorative, and all three campaigns are currently priority `1`.

Before testing first-touch + appointment interruption, Chris dial group `1068` needs:

```text
enableAbsolutePriority=true
campaign 2900 priority=10  # appointment
campaign 2829 priority=5   # first-touch
campaign 2458 priority=1   # regular/bulk
```

Mickey owns applying that RingCX settings change. Codex can prepare a dry-run/default-off
helper if needed, but should not patch RingCX settings without an explicit go.

## Target Local Env For Chris Combined Canary

When Mickey is ready to restart this local box for the Chris combined canary, the target
shape is:

```env
CX_BULK_RESERVE_PILOT_FAMILY=pilot
CX_ALPHA_TRACE_AGENT=cbolt@taxadvocategroup.com

CX_FIRST_TOUCH_ENABLED=true
CX_FIRST_TOUCH_QUEUE_MAP={"cbolt@taxadvocategroup.com":2829}

CX_APPT_LANE_ENABLED=true
CX_APPT_QUEUE_MAP={"cbolt@taxadvocategroup.com":2900}
```

Remove or replace the current Mickey-only lane maps before the Chris run:

```env
CX_FIRST_TOUCH_QUEUE_MAP={"mgray@taxadvocategroup.com":2910}
CX_APPT_QUEUE_MAP={"mgray@taxadvocategroup.com":2911}
```

Do not leave both Mickey and Chris in the maps unless we are intentionally running a
multi-agent lane test.

## Operator Script

`scripts/cx-chris-combined-canary.js` exists to bundle the final preparation in one
repeatable operator flow while staying dry-run by default.

It does not edit `.env` and does not restart services.

Default:

```powershell
node scripts/cx-chris-combined-canary.js
```

Behavior:

1. Prints the target Chris env block and current env snapshot.
2. Runs a read-only Chris regular-floor isolation gate.
3. Reads Chris RingCX dial group/campaign priority settings.
4. Runs the Chris pilot pool builder dry-run:
   `cx-pilot-queue.js build-mix --agent cbolt@...`.
5. Prints the RingCX priority patch it would apply.

Write gates:

```powershell
# Put Chris into the isolation boundary and release regular-floor assigned rows.
# Dry-run with --isolate-only first; add --isolate-apply only when Mickey is ready.
node scripts/cx-chris-combined-canary.js --isolate-only
node scripts/cx-chris-combined-canary.js --isolate-only --isolate-apply

# Build Chris pilot pool only; RingCX priority untouched.
node scripts/cx-chris-combined-canary.js --queue-arm --skip-ringcx

# Final RingCX priority flip only; no queue build.
node scripts/cx-chris-combined-canary.js --skip-queue --apply-ringcx

# Queue first, RingCX priority last.
node scripts/cx-chris-combined-canary.js --queue-arm --apply-ringcx
```

Equivalent env gates:

```env
CX_CHRIS_CANARY_APPLY_ISOLATION=true
CX_CHRIS_CANARY_ARM_QUEUE=true
CX_CHRIS_CANARY_APPLY_RINGCX=true
```

Priority writes always run last. If the queue build fails, the script never applies the
RingCX priority patch.

Isolation gate:

- PASS requires Chris to be held out of regular cadence with
  `cxRouting.desiredAvailability:"unavailable"` and zero active assigned
  regular-floor rows. Preferred hold is untimed `pauseType:"work-pause"` with no
  `pauseReleaseAt`; `pauseType:"logout"` is also safe as a pre-test holding state.
- Pilot rows (`queueFamily:"pilot"`) are not a clash.
- First-touch/appointment lane rows in campaigns `2829`/`2900` are reported separately.
- Any other active assigned row for Chris is a blocker, because it can ring during the
  canary and contaminate the observed workflow.
- Use `--skip-isolation` only for targeted inspection that is not preparing a live
  canary.

Read-only isolation-only check:

```powershell
node scripts/cx-chris-combined-canary.js --skip-queue --skip-ringcx
```

## Safety Model

There is one shared Atlas data plane. The regular floor and the pilot both read/write
`CxDialQueue`.

Safe isolation is:

1. Pilot rows stay in `queueFamily:"pilot"`.
2. Pilot rows are route-stamped to Chris's route: account `50810001`, campaign `2458`,
   dial group `1068`.
3. Bulk reservation is constrained by `CX_BULK_RESERVE_PILOT_FAMILY=pilot`.
4. Chris is not simultaneously fed by regular cadence during the pilot block.
5. One-active-row-per-case remains absolute.

The pivot is not safe if Chris is available to regular cadence and also running a pilot
session, because regular assigned/fed work can contaminate the observed test.

## Preflight Checks

Run read-only checks first:

```powershell
node scripts/cx-pilot-queue.js status --agent cbolt@taxadvocategroup.com --domain WYNN
```

Expected route line:

```text
route: account 50810001 / campaign 2458 / dial group 1068
```

Expected pilot rows before a fresh build:

```text
PILOT ROWS (WYNN)
  none
```

If there are existing Chris pilot rows, stop and inspect before rebuilding. Do not mix
old pilot material with a new test block.

Also verify:

- Chris route entries exist using the normalized email token
  `RINGCX_AGENT_ROUTE_CBOLT_AT_TAXADVOCATEGROUP_COM_*` or one of the extension/id
  aliases listed above.
- `CX_FIRST_TOUCH_ENABLED=false`.
- `CX_APPT_LANE_ENABLED=false`, unless we are explicitly testing lanes.
- `CX_BULK_RESERVE_PILOT_FAMILY=pilot` only when Mickey is ready for pilot mode on this
  box.
- `CX_ALPHA_TRACE_AGENT` is empty or includes Chris, otherwise the watch may miss the
  useful Chris-specific trace lines.

## Regular Cadence Isolation

Question to answer before any live pilot block:

How do we keep slow-steady from feeding Chris regular work while he is the pilot agent?

Current safe option:

- Put Chris into a manual unavailable/work-pause style state at the start of the block.
- That blocks new regular cadence assignments because the assigner excludes agents with
  `cxRouting.desiredAvailability:"unavailable"`.
- The 2026-07-08 local patch also sweeps already-assigned regular rows when the pause
  type is `work-pause`.

This does not mean Chris has to take mail-call pauses during the test. It is a one-time
pilot isolation boundary, not part of the tested workflow.

Before using it live, confirm the patch is in the running service after Mickey restarts.
Do not assume a refreshed browser is enough.

Alternative if Mickey does not want to rely on the pause state:

- Chris's regular campaign/queue must be manually drained/held in RingCX before the
  pilot block.
- App-side assigned regular rows must be inspected and released with an explicit dry-run
  first.

Do not invent a third path mid-test.

## Build The Sequestered Pool

Dry-run first:

```powershell
node scripts/cx-pilot-queue.js build-mix --agent cbolt@taxadvocategroup.com --count 300 --mix 60/30/5/5 --domain WYNN --tag pilot-cbolt-mix-20260708
```

If safe green availability is too low, dry-run the practical fallback:

```powershell
node scripts/cx-pilot-queue.js build-mix --agent cbolt@taxadvocategroup.com --count 300 --mix 14/76/5/5 --cooldown-days 1 --domain WYNN --tag pilot-cbolt-mix-20260708
```

Only Mickey adds `--arm`.

After arming:

```powershell
node scripts/cx-pilot-queue.js status --agent cbolt@taxadvocategroup.com --domain WYNN
```

Expected: roughly the armed count in `ready`, all under `queueFamily:"pilot"` and
`metadata.pilotAgentEmail:"cbolt@taxadvocategroup.com"`.

## Launch A 30-Lead Dialable Slice

Do not side-door publish directly to RingCX.

The 30-lead working set should be created through the same app/bulk route that starts a
bulk session, with `targetSize:30` if we expose an operator path for it. If the current
UI cannot request that exactly, write a small operator helper later that calls the same
production route/runtime path. Do not bypass the app route with a one-off RingCX batch.

Expected behavior:

- The session reserves only Chris's `pilot` rows.
- The session publishes one lead at a time to Chris's regular/bulk campaign `2458`.
- RingCX dials from Chris's route.
- Poller matches `cxbl`/bulk externs.
- Button dispositions advance and refill from the pilot pool.

## First-Touch Drip Pivot

The current service is named `cxSeanFirstTouchDripService`, but its mechanics are env
configurable.

Minimal config-only pivot, still with Sean-named env/log keys:

```env
CX_SEAN_FIRST_TOUCH_TEST_ENABLED=true
CX_SEAN_FIRST_TOUCH_DRY_RUN=true
CX_SEAN_FIRST_TOUCH_AGENT_EMAIL=cbolt@taxadvocategroup.com
CX_SEAN_FIRST_TOUCH_AGENT_NAME=Chris Bolt
CX_SEAN_FIRST_TOUCH_EXTENSION_ID=63914586004
CX_SEAN_FIRST_TOUCH_CAMPAIGN_ID=2829
CX_SEAN_FIRST_TOUCH_MAX_PER_TICK=1
CX_SEAN_FIRST_TOUCH_MIN_GAP_MINUTES=10
CX_SEAN_FIRST_TOUCH_WINDOW_MINUTES=30
CX_SEAN_FIRST_TOUCH_DOMAIN=WYNN
```

This is mechanically acceptable for a fast test, but confusing:

- Logs still say `cx.alpha.sean_ft.*`.
- Metadata still uses `metadata.seanFirstTouchTest`.
- Docs still call it Sean-first-touch.

Clean pivot option before live use:

- Add generic alias env keys while preserving the old Sean keys for compatibility.
- Rename logs to a generic `cx.alpha.agent_ft.*` or include both old and new event names
  for one transition.
- Keep metadata compatibility, or add generic metadata beside the old field with tests.

Do not do the clean rename until Mickey explicitly asks. It is safer than the names, but
it is still code churn.

## Lane Maps

For a Chris-only lane test, maps must be Chris-only:

```env
CX_FIRST_TOUCH_QUEUE_MAP={"cbolt@taxadvocategroup.com":2829}
CX_APPT_QUEUE_MAP={"cbolt@taxadvocategroup.com":2900}
```

Keep lane flags off unless the test is specifically about modal lane dispatch:

```env
CX_FIRST_TOUCH_ENABLED=false
CX_APPT_LANE_ENABLED=false
```

Do not mix lane testing with the bulk churn test unless Mickey deliberately chooses that
combined run.

## Watch And Report

During the Chris block:

```powershell
node scripts/cx-floor-watch.js --agent cbolt@taxadvocategroup.com
```

End-of-block:

```powershell
node scripts/cx-floor-pilot-report.js --agent cbolt@taxadvocategroup.com --archive
node scripts/cx-pilot-queue.js status --agent cbolt@taxadvocategroup.com --domain WYNN
```

Stop-if list:

- Pilot lead appears in another agent's RingCX queue.
- Chris's phone rings for a lead not visible in the app.
- Middle panel clears without a click or RingCX machine/system disposition.
- Buttons are dead for more than 15 seconds.
- Any `[cx][wipe]` style log.
- Unknown system disposition token.
- Drain backlog grows and does not clear.
- Regular floor-family rows appear in Chris's pilot session.

## Cleanup

Dry-run first:

```powershell
node scripts/cx-pilot-queue.js cleanup --agent cbolt@taxadvocategroup.com --domain WYNN
```

Mickey arms only after reading the candidate list:

```powershell
node scripts/cx-pilot-queue.js cleanup --agent cbolt@taxadvocategroup.com --domain WYNN --arm
```

If first-touch drip rows were used:

```powershell
node scripts/cx-pilot-queue.js drip-status --agent cbolt@taxadvocategroup.com --domain WYNN
node scripts/cx-pilot-queue.js drip-cleanup --agent cbolt@taxadvocategroup.com --domain WYNN
```

Mickey adds `--arm` only after confirming no dialed rows are selected.

## Verification Gates Before Live

Run after any code change. If this stays docs/config-only, no code gate is required, but
these are the correct gates before trusting a pivot patch:

```powershell
node --test tests/queue/*.test.js
node --test tests/cx-bulk-load/*.test.js
npm.cmd run build --workspace=web-client
```

If only the docs changed, record that no code tests were needed.

## Open Questions For Mickey

- Is Chris dedicated to the pilot block, or can slow-steady regular floor work continue
  feeding him between pilot chunks?
- Do we use the existing `Pause dials` work-pause as the formal isolation boundary, or
  does Mickey drain/hold Chris's regular RingCX side manually before the block?
- Is the Sean-named first-touch drip acceptable for one Chris test if the env points to
  Chris, or should we genericize the names first?
- Are lanes part of the Chris run, or is this bulk churn only?
- Should the first Chris pool preserve the requested 60/30/5/5 mix even if green supply
  is short, or use the practical 14/76/5/5 fallback already proven in dry-run?
