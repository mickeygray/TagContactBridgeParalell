# Welcome to Contact Bridge 5.6 - The Boring Dialer Field Guide

Date: 2026-07-09

Audience: the next high-capability model taking over this project.

Tone note: this is not a polished product spec. This is the honest map of a live
system that has survived too many clever half-solutions. Read it like a field
manual written from inside the blast radius.

## Contact Bridge 5.6 In One Page

Contact Bridge has one job it must do over and over: keep the right leads moving
through RingCX and record what happened. The app became fragile because multiple
feeders, managers, sweepers, caches, flags, and browser behaviors were each allowed
to own part of that one loop.

5.6 is the collapse:

1. One owner builds a hard-eligible pool and selects work.
2. One loader sends that selection to RingCX and records only what RingCX accepts.
3. RingCX owns the outstanding live list and dial order after acceptance.
4. One watcher observes the active call by `externId`/UII and projects current state.
5. A button or RingCX system disposition writes one terminal fact.
6. One outbox drainer performs the existing cadence, call-wrap, DNC, bad-number,
   appointment, and Logics work after the live call loop.

Keep the proven disposition/drain/call-wrap pipe. Replace the daytime lead-progression
trunk. Do not create another rail beside the old one. Hard-gate the old owners, wire
the boring trunk, prove one clean agent can run past the first batch, then delete the
dark code only after Mickey approves the evidence.

The governing sentence is:

> Before RingCX, Contact Bridge chooses. After RingCX accepts, Contact Bridge
> observes. At terminal, Contact Bridge records once.

No cache may become a second RingCX list. No stale cache may veto a real RingCX
call. No read failure may become destructive certainty. No helper may re-ready,
prune, reorder, rescue, or cancel accepted inventory in the background.

## First Principle

The mission is simple:

Phones ring. Agents work. Outcomes drain. The machine does not invent judgment.

Everything else is secondary.

If you are tempted to design a beautiful abstraction before proving the phone keeps
moving, stop. If you are tempted to add a new autonomous worker that "helps" by
deciding something is stale, bad, low quality, or not worth dialing, stop harder.
This product has been hurt most often by helpful machinery making side decisions.

The current north star is:

1. Intake gets a lead.
2. A single owner queues it.
3. RingCX dials it.
4. The app identifies it by hard identity, not vibes.
5. The agent records a concrete outcome.
6. The terminal outbox drains that outcome.
7. Only explicit stop states or the retry clock decide whether it returns.

No hidden pruning. No duplicate owners. No phone-number guessing. No "this looks
wrong so I cleaned it up." No silent skips.

## Human Context

Mickey is trying to get a call floor out of a fragile legacy system without losing
live sales hours. The floor is the customer here. The code is allowed to be ugly for
another day if it keeps them dialing safely.

Mickey is also doing live operations while talking to agents, RingCentral, and you.
Do not make Mickey re-explain things that are already in the docs. Do not casually
restart services. Do not casually say "probably." If you need a restart of a
Windows `Parallel*`/NSSM service, Mickey does it. On Ubuntu, coordinate restarts
explicitly. Mickey may tell you "go" for Linux restarts, but do not infer that from
momentum.

When Mickey says "simple atomic code," he means one owner, one purpose, one clear
flow. He does not mean "a large operation divided into many clever tiny machines."

## Current Big Decision

The system is being moved from a local-office owner model to Ubuntu ownership.

Before this push, there were effectively two writing worlds:

- the local Windows stack used for live alpha testing;
- the Ubuntu live stack.

That dual-writer world created whole classes of bugs:

- a browser tab bound to a dead/replaced session;
- buttons flickering or disappearing because another worker changed state;
- agents seeing stale middle-panel data;
- calls advancing in RingCX while the app still believed another lead was current;
- local testing and live routing stepping on each other.

The current intended state:

- Ubuntu owns CX dialing workers and the agent front.
- Local is quiet for dialing.
- Local can come back tomorrow for coach work, but not as a CX lifecycle writer.

As of the 2026-07-09 patch window:

- local `Parallel*` services were stopped;
- local Vite/web dev server on port 3001 was stopped;
- live repo was switched to `release/0.2.0-alpha`;
- live head after the final test-isolation commit was `6608fb1`;
- live build and CX/queue test gate passed;
- services were not restarted by Codex after that handoff;
- live env still needed first-contact forward flags before the restart if 4001 must
  forward fresh intake to 6101.

Later local read at `2026-07-09 12:49 -07:00` supersedes the earlier "all local
services stopped" snapshot:

- `ParallelControlPlane`, `ParallelInboundGateway`, `ParallelNginx`,
  `ParallelNgrok`, `ParallelOutboundGateway`, and `ParallelRingCentralCx` were
  running;
- `ParallelMongo` and `ParallelRestartHelper` were stopped;
- local ports `4001`, `5001`, and `6101` were listening and their health endpoints
  returned `200`;
- local AI bus `7000` was down.

Running is not the same as owning. Before changing a worker, confirm which machine
is currently authorized to write CX lifecycle state. Do not restart a local
`Parallel*` service from Codex; Mickey owns that action.

## Deployment State To Know

Local repo branch:

```text
release/0.2.0-alpha
```

Important commits:

```text
0c3ccae 0.2.0 alpha floor rollout candidate
6608fb1 Isolate EX busy eligibility test env
```

Live Ubuntu repo:

```text
/opt/tagcontactbridge-parallel
branch: release/0.2.0-alpha
head:   6608fb1
```

Live dirty-state capture from before branch switch:

```text
/tmp/live-uncommitted-20260709004757.status.txt
/tmp/live-uncommitted-20260709004757.diff
/tmp/live-uncommitted-20260709004757.stat.txt
```

Copied home locally under:

```text
C:\code\TagContactBridgeParalell\live-captures
```

Live tracked WIP stash:

```text
stash@{0}: pre-alpha-deploy-tracked-20260709004757
```

Live checkout-colliding untracked files were moved to:

```text
/tmp/live-untracked-conflicts-20260709004757
```

Do not casually pop that stash. It belongs to the previous live branch state and
contains old hotfixes/artifacts from a dirty 0.1.9-era tree. The current branch was
chosen deliberately as the owner. If you need something from that stash, inspect it
like evidence, not like a patch to apply wholesale.

## Missing Env At Last Handoff

The code was on the live box, but env was not fully final.

Live env sanity showed:

```text
CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=true
CX_FIRST_TOUCH_ENABLED=true
CX_APPT_LANE_ENABLED=true
CX_CALL_WRAP_QUEUE_ENABLED=true
CX_SYSDISPO_CLASSIFIER_ENABLED=true
CX_MORNING_QUEUE_BUILDER_ENABLED=true
CX_MORNING_QUEUE_BUILDER_ALLOW_BROAD_DISCOVERY=false
CX_FIRST_TOUCH_QUEUE_MAP=set, four entries
CX_APPT_QUEUE_MAP=set, four entries
CX_MORNING_QUEUE_BUILDER_AGENT_EMAILS=set, four entries
CX_BULK_RESERVE_PILOT_FAMILY=empty
CX_SEAN_FIRST_TOUCH_TEST_ENABLED=absent
```

These were absent but mostly safe by default:

```text
CX_TERMINAL_OUTBOX_DRAIN_ENABLED
CX_ACCOUNT_ACTIVE_CALL_WATCHER_ENABLED
CX_MORNING_QUEUE_BUILDER_RESPECT_PRESENCE
RC_CX_GREEN_RETRY_DELAY_MINUTES
RC_CX_FRESH_RETRY_DELAY_MINUTES
```

Drain and active-call watcher default to enabled in code. Morning builder presence
defaults false. Fresh retry defaults to 90 minutes. Still, explicit env is better
for rollout clarity:

```text
CX_TERMINAL_OUTBOX_DRAIN_ENABLED=true
CX_ACCOUNT_ACTIVE_CALL_WATCHER_ENABLED=true
CX_MORNING_QUEUE_BUILDER_RESPECT_PRESENCE=false
RC_CX_GREEN_RETRY_DELAY_MINUTES=90
```

The important stop-light was missing first-contact forward env:

```text
CX_FIRST_CONTACT_FORWARD_ENABLED=true
CX_FIRST_CONTACT_FORWARD_URL=http://127.0.0.1:6101/api/inbound/cx-first-contact-forward
CX_FIRST_CONTACT_FORWARD_SECRET=<same internal service secret if receiver requires it>
```

Do not print secrets. Do not paste `.env`. Hand Mickey names and let Mickey edit.

## Service Map

Ubuntu services that matter:

```text
parallel-control-plane       port 5001  Main backend/control-plane, workers, web serving/proxy
parallel-ringcentral-cx      port 6101  CX dialer/backend service
parallel-ai-bus              port 7000  AI/live coach bus
parallel-live-coach-grpc     port 3344  RingCX gRPC bridge
parallel-barge               port 7335  EX barge / voicemail helper
parallel-inbound-gateway     intake gateway
parallel-outbound-gateway    outbound/cadence gateway
```

For the alpha CX owner restart, likely restart set after env is ready:

```text
parallel-control-plane
parallel-ringcentral-cx
parallel-inbound-gateway
parallel-outbound-gateway
parallel-ai-bus
parallel-live-coach-grpc
```

Do not restart before env is ready. After restart, verify health before any test.

Health checks:

```bash
curl -fsS http://127.0.0.1:5001/health
curl -fsS http://127.0.0.1:6101/health
curl -fsS http://127.0.0.1:7000/health
curl -fsS http://127.0.0.1:7335/status
```

Use `docs/UBUNTU_LIVE_BOX_GUIDE.md` for SSH and quoting. From Windows, prefer small
Python/Node scripts piped over SSH. PowerShell eats nested quoting for breakfast.

## What This System Actually Is

This repository is a parallel control plane for lead/call operations around:

- RingCX dialing;
- RingEX / old EX artifacts;
- Logics case state;
- LeadCadence / CaseProfile / queue state in Mongo;
- a web client for agents;
- live coach experiments;
- marketing/intake pieces around 4001;
- various ops scripts that became load-bearing because the product was being built
  while it was being flown.

The CX alpha center of gravity is:

```text
apps/control-plane/src/server.js
apps/control-plane/src/routes/cxBulkLoad.js
apps/ringcentral-cx/src/server.js
apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx
apps/web-client/src/lib/api/queries/cxBulkLoad.ts
packages/shared-services/src/cxBulkLoadRuntime.js
packages/shared-services/src/cxBulkLoadRuntimeService.js
packages/shared-services/src/cxBulkLoadActiveCallWatcher.js
packages/shared-services/src/cxAccountActiveCallWatcherService.js
packages/shared-services/src/cxTerminalOutboxDrain.js
packages/shared-services/src/cxCallWrapCardService.js
packages/shared-services/src/cxCadenceService.js
packages/shared-services/src/cxFirstTouchDispatchService.js
packages/shared-services/src/cxAppointmentDispatchService.js
packages/shared-services/src/cxMorningQueueBuilderService.js
packages/shared-services/src/contactEligibilityService.js
packages/shared-services/src/cxDialQueueMediatorService.js
packages/shared-services/src/agentAvailabilityService.js
```

The tests are unusually important. They encode scars.

Run focused gates before trusting yourself:

```powershell
node --test tests/cx-bulk-load/*.test.js tests/cx-handoff/cxDialQueueMediatorService.test.js tests/queue/activityState.test.js tests/queue/cxLoadBalancerEligibility.test.js tests/queue/cxManualUnavailableRelease.test.js
npm run build:web
```

Last known live gate:

```text
474 pass / 0 fail
```

## The Core CX Dialing Model

There are several "lanes" but they must behave like one disciplined trunk.

### Bulk

Bulk is the main floor rail. The app builds/reserves a session buffer, publishes
leads into the agent's RingCX campaign, watches active calls, then records terminal
outcomes.

Bulk lead extern ids use the `cxbl` convention. That identity shape is sacred. If
you put legacy-style ids into the bulk rail, the poller and UI lose their mind.

Do not feed RingCX with a script that bypasses the actual app/API route unless you
are explicitly testing a script. The app has to own the production path.

### First Touch

First-touch is for new/fresh intake. It must be generic and map-driven:

```text
CX_FIRST_TOUCH_ENABLED=true
CX_FIRST_TOUCH_QUEUE_MAP=<agent order/map>
```

Use `cxFirstTouchDispatchService`, not `cxSeanFirstTouchDripService`, for final
rollout. The Sean drip was a pilot artifact. It can remain in code if flag-dark,
but it must not be the production fresh path.

First-touch extern ids should be lane identities, not bulk ids. They should be
consumed by lane disposition, not accidentally treated as ordinary bulk.

### Appointment

Appointments are their own lane:

```text
CX_APPT_LANE_ENABLED=true
CX_APPT_QUEUE_MAP=<agent order/map>
```

An appointment should publish to the owning agent campaign when due. It should show
the lane/modal UI. It should resolve the appointment and terminal queue row on
disposition. It should not become generic bulk material unless explicitly designed
as fallback.

### Bad Number

Bad Number is a fourth outcome button. It is operationally "DNC this because the
number is disconnected/out of service," plus an alert to Mickey/vendor ops.

Do not overthink that into a new disconnected segment yet. The current business
decision was: bad numbers need DNC because the floor cannot keep recycling bad
numbers.

Files:

```text
packages/shared-services/src/cxBadNumberOutcomeService.js
tests/cx-bulk-load/cxBadNumberOutcome.test.js
```

## Identity Law

This system breaks when it guesses.

Good identity:

- RingCX `uii`;
- lane/bulk `externId`;
- queue item id;
- campaign/dial group/account route stamps;
- session id when scoped correctly.

Bad identity:

- phone-only matching;
- name-only matching;
- "top of queue must be current";
- "agent probably has this call";
- "there is only one call-ish thing so use it."

The active-call watcher should match by extern/UII. Phone-only can be diagnostic,
but not ownership proof.

The recent "buttons disappeared / poller lagged" fix added a click-time resolver:

- outcome buttons can stay visible for a running bulk session;
- when clicked, the server asks RingCX what active call exists;
- it only resolves if the active call extern id matches a candidate in the current
  bulk session;
- if multiple session candidates match, it refuses to guess;
- there is also a manual `Sync call` UI button.

This is a reasonable emergency hatch because it asks RingCX for identity at click
time instead of relying only on the poller. It must not devolve into "click button
against whatever RingCX says, no matter what."

## Ownership Law

Most severe bugs were ownership bugs:

- too many things owned the beginning of a call;
- too many things owned the end of a call;
- local and live both writing queue lifecycle;
- old EX presence trying to govern CX;
- browser tab bound to killed session;
- stale middle panel not matching RingCX;
- random cleanup deciding a row should be released/cancelled.

Desired ownership:

- RingCX owns dialing/active call reality.
- The app owns queue/session state and terminal outcome persistence.
- The poller/watcher projects RingCX reality into app state.
- The agent buttons submit outcomes, but server verifies identity before acting.
- Terminal outbox owns durable downstream effects.
- Wrap card owns human case decision after answered material.
- Logics/contact eligibility gates own "do not dial" only when evidence is concrete.

No other worker should independently decide call lifecycle.

## Autonomy Dampening

Mickey's principle:

If the machine says "go go go," fine.
If the machine says "wait, I need this to be perfect," it is probably doing too much.

Allowed machine behavior:

- retry after a transient failure;
- hold for a short window;
- release a stale claim with proof;
- requeue after a jam with evidence;
- refuse to act when identity is ambiguous;
- skip DNC/client/non-active-prospect when confirmed.

Forbidden machine behavior:

- cancel because Logics/RingCX read failed;
- mark a lead bad because a lookup was unavailable;
- clear current call because active-call snapshot was unavailable;
- release dialed rows as if undialed;
- prune because it "looks stale" without concrete ownership proof;
- keep polling a dead idea until the UI freezes.

Key recent changes:

- transient Logics status miss is `transient:true`, `destructive:false`;
- transient miss releases/holds for retry rather than DNC/cancel;
- outbound dispatch does not cancel scheduled actions on transient contact-check
  failure;
- stale bucket reconciliation requires a known active-call snapshot before clearing
  shadow current call;
- active identities are marked known only after a successful RingCX active-call read.

Read:

```text
docs/CX_AUTONOMY_DAMPENING_CENSUS_2026-07-08.md
.ai/context/CX_FINAL_PUSH_AUDIT_RESULT_2026-07-08.md
```

## DNC / Client / Active Prospect

Mickey's rule:

An active prospect is not DNC. Once DNC, not active. Once client, not active.

Blocking these is not unwanted autonomy; it is compliance/business reality. The
danger is not blocking confirmed DNC/client rows. The danger is treating uncertain
reads as confirmed stops.

Eligibility should block:

- DNC / opt-out / stop-contact;
- inactive cadence;
- non-prospect Logics status;
- paid/converted/client;
- blocked lifecycle stage.

Eligibility should not destructively cancel on:

- transient Logics failure;
- transient RingCX failure;
- missing status from an outage;
- temporary read ambiguity.

## Retry Timing

Fresh retry default is 90 minutes. Mickey accepted 90 minutes if enforced.

Code default lives in `cxCadenceService`.

Prefer explicit env:

```text
RC_CX_GREEN_RETRY_DELAY_MINUTES=90
```

or:

```text
RC_CX_FRESH_RETRY_DELAY_MINUTES=90
```

Do not change timing logic unless you have evidence the existing 90-minute delay is
not actually enforced.

## System Disposition Discovery

A major find: RingCX system disposition reveals useful truth:

- congestion;
- no answer / machine / busy;
- number failed to connect;
- someone answered and hung up;
- ANSWER.

This is better than making the UI guess after a dropped call. The current strategy:

- read system disposition from RingCX lead search when possible;
- if RingCX says ANSWER, treat it as answered/wrap material;
- if RingCX says non-answer machine/busy/congestion/etc., drain it as did-not-connect
  style material with the label carried;
- if RingCX read fails, use retry/guard behavior rather than inventing certainty.

This solved a lot of "it looked like no answer but was actually congestion/answered"
fog.

## End Of Call

The old wound: "RingCX still owns the call" guards could prevent dispositions from
actually clearing. No-answer used to be the only button and worked for ages, then
logic around still-active verification made it feel like the app refused to end the
call.

Current design:

- button sends a terminal outcome;
- server resolves/verifies UII;
- disposition transport talks to RingCX;
- terminal outbox writes once;
- drain replays downstream effects;
- RingCX advances to next lead;
- watcher picks next active call.

Do not add a second end-of-call owner.

Voicemail is special: VM DROP transfer may own call end, so post-disposition hangup
is skipped for voicemail where configured. Do not blindly unify voicemail and
no-answer.

Bad number is special: it runs DNC/cadence/logics side effects and alerting.

Answered is special: it should create wrap material, not instantly DNC or no-answer.

## Wrap Queue

The wrap queue exists because answered calls need human case decisions after the call.
This is the place for appointment / DNC / closeout style decisions.

Important idea:

- The live outcome row records the call result.
- "Never call me" is not a live DNC button anymore in the call row.
- The wrap card is the case decision channel for answered material.

This is why the UI removed agent-facing live DNC from the row. The backend DNC path
still exists because wrap card DNC writes through it.

Known hazard:

- If wrap queue is disabled on a deployed floor, there is effectively no floor DNC
  path for answered material.

So:

```text
CX_CALL_WRAP_QUEUE_ENABLED=true
CX_SYSDISPO_CLASSIFIER_ENABLED=true
```

are not cosmetic.

## UI State

The middle panel was redesigned around "Client Information" with collapsible detail.
Agents do not type much in the old boxes. The useful state is:

- who is current;
- case id / name / phone / email once;
- lead type pill;
- communications/activity/info compactly;
- coach space;
- right-side appointments/closeouts/wrap actions.

Do not bring back jumpy panels that wipe buttons during poller lag. The agent needs
stable buttons. If the poller is behind, buttons should still be able to ask the
server/RingCX for current identity and act if exactly matched.

But also do not let buttons fire against an unknown/stale session silently. Better:

- show stale/reconnecting state;
- offer refresh/rebind;
- server returns structured stale-session response;
- UI rebinds to canonical running session.

The stale browser/dead tab problem is real. A tab can remain visually alive while its
server session was killed and replaced. Fixes should make that obvious and recoverable,
not silently send no-op dispositions.

## Break / Availability / Work Pause

Desired floor behavior:

- Start of day: agent logs in, goes off hook/starts RingCX dialing.
- No "Start Queue" ceremony in our app.
- No "Stop Queue" ceremony in our app.
- Dial, dial, dial.
- Break buttons are useful because they can set unavailable/on-hook style state.
- Work pause / mail call style pause should block new dials until manually resumed.
- Timed breaks can return to available and tell agent to press RingCX start dialing
  if needed.

Do not make refresh/stale state automatically govern agent login. Do not let "stale
break state" or "presence watcher" sign agents out mid-day. The only broad automatic
governance Mickey wants is end-of-day style logout/termination, not random daytime
self-healing.

## Morning Queue Builder

Important lesson: "in CX" or "has route config" does not mean "showed up to work."

The morning builder must not stage work for every CX-enabled account.

It now supports explicit allowlists:

```text
CX_MORNING_QUEUE_BUILDER_AGENT_EMAILS
CX_MORNING_QUEUE_BUILDER_EXTENSION_IDS
```

Scheduled path fails closed when no allowlist is present. Broad discovery requires:

```text
CX_MORNING_QUEUE_BUILDER_ALLOW_BROAD_DISCOVERY=true
```

Keep it false for rollout unless Mickey explicitly changes the plan.

Presence should not gate morning build for this alpha:

```text
CX_MORNING_QUEUE_BUILDER_RESPECT_PRESENCE=false
```

Why: people can be on hook, off hook, in a weird RingCX state, or not yet fully
ready. The morning build should be based on the named working floor, not incidental
presence.

## No-Show Release

No-show release exists because agents might have leads staged but not actually show
up. If those leads remain published to their RingCX campaign, a late login can cause
count conflicts and stale dialing.

Correct order:

1. Cancel RingCX copies first, scoped by publish stamps/extern ids.
2. Only if cancellation succeeds, release Mongo ownership.
3. No artificial weight/priority.
4. Never release rows with `placedCalls > 0` as undialed.
5. Distribution must be explicit: `pool` or `bottom`.

Route-lock finding:

Current reservation queries require exact route stamps. A row released to generic pool
may not be claimable by another agent unless restamped or assigned through explicit
mechanics. For same-day rescue, receiver-restamped/bottom-style release is safer than
"free pool" unless the pool route assignment is implemented.

Read:

```text
.ai/context/CX_STALE_OWNERSHIP_FAMILY_2026-07-08.md
tests/cx-bulk-load/cxNoShowRelease.test.js
scripts/cx-pilot-queue.js
```

## RingCX / RingEX / EX Artifacts

Old EX presence logic is a recurring source of false ownership. The bulk/CX runtime
is supposed to be CX-only. RingEX artifacts should not block CX fresh serving unless
explicitly intended.

Important env/logic:

- `RC_CX_RUNTIME_MODE=cx-only` or similar runtime mode suppresses EX artifacts.
- `RC_CX_EX_BUSY_GATE_ENABLED` can block on connected EX calls in legacy mode.
- Tests now isolate env so live `cx-only` does not make the legacy EX-busy test fail.

Do not reintroduce old EX lifecycle control into CX bulk. If you need EX data for
diagnostics, keep it diagnostic.

## Caller ID Rotation

Caller ID burn is real. A rotation script exists:

```text
scripts/rcx-shift-caller-ids.js
config/rcx-caller-id-pools.json
```

Concept:

- campaign caller id rotates across account-owned DIDs;
- ideally extension caller id rotates in lockstep;
- callback path must still route to the same agent/person;
- CNAM is not realistically programmable per hour.

Do not run caller-id rotation as part of a CX lifecycle patch unless Mickey explicitly
asks. It touches RingCX/RC configuration. It is adjacent, not the same thing as the
dialing trunk.

Current working tree note at this handoff:

- `scripts/rcx-shift-caller-ids.js` was modified after the alpha commit. Treat as
  user/other-agent WIP until inspected.

## Coach Work

Coach/two-station work exists and is important, but it is not the floor dialing
cutover. Local is expected to come back tomorrow for coach stuff.

Do not mix coach refactors into emergency CX dialing fixes unless Mickey explicitly
moves that scope back in.

Relevant files/docs:

```text
apps/ai-bus/src/coachTwoStationTransports.js
packages/shared-services/src/coachTurnAccumulator.js
packages/shared-services/src/coachTwoStationLoop.js
docs/CX_COACH_TEST_INSTANCE_3002_2026-07-08.md
docs/CX_COACH_TWO_STATION_PLUGIN_RUNBOOK_2026-07-08.md
tests/live-coach/coachTwoStationLoop.test.js
```

## What Still Scares Me

This is the part to read twice.

### 1. Env can quietly undo code correctness

The code can be perfect and still not run because flags are absent or conflicting.
The final push proved this: code was on live, tests passed, but first-contact forward
env was absent.

Before declaring anything fixed, verify the exact live flags by name. Do not print
secret values.

### 2. One owner is still mostly config discipline

The code has guards, but the big dual-writer fix is operational:

- local quiet;
- Ubuntu owner;
- no accidental local restart with workers enabled;
- no second box running cadence/dial/poller/drain.

If tomorrow someone starts local with old env, ghost bugs can return.

### 3. The UI can still lie by being stale

A browser can show old state. The poller can lag. A session can be killed/replaced.
Buttons disappearing was one symptom; stale buttons are the other.

The long-term fix is a canonical session rebind path and structured stale-session
server responses.

### 4. RingCX can be broken independently

Agents saw multiple-session/suspect/login weirdness in RingCentral itself. Sometimes
RingCentral freezes or fails resource loads. Do not assume every freeze is our code.
Check journals and RingCX status. If RingCentral login page has 503/404 assets, that
is bigger than us.

### 5. Live repo history is dirty

The live box had a massive uncommitted/untracked history. We captured it, stashed
tracked changes, and moved checkout collisions. But the box still has old backup
artifacts. Do not "clean" them in the middle of dialing. If cleanup is needed, schedule
it.

### 6. Generated artifacts and PII

There are DNC/export CSVs under `exports/` and live captures under `live-captures/`.
Do not commit them casually. They may contain names/phones or operational logs.

### 7. Tests can be env-sensitive

Node tests can load `.env` depending on import path. A test that passes locally may
fail on live because live env intentionally says `cx-only`. Isolate env in tests that
assert legacy behavior.

### 8. The phrase "just patch it on live" is dangerous

Patch live carefully:

- capture dirty state;
- know the branch/head;
- use `parallel` user for repo writes/builds;
- watch ownership;
- build;
- test;
- coordinate restart.

Live build directories have had root-owned artifacts before. If build fails on
permissions, fix the exact denied path, not the whole filesystem.

## What To Read First

Read in this order:

```text
AGENTS.md
.ai/context/PROJECT_HANDOFF.md
.ai/context/CODEX_RECOVERY_NOTES.md
docs/CX_0_2_ALPHA_TEST_OBSERVABILITY_RUBRIC_2026-06-29.md
.ai/context/CX_FINAL_PUSH_IMPLEMENTATION_GUIDE_2026-07-08.md
.ai/context/CX_FINAL_PUSH_AUDIT_RESULT_2026-07-08.md
docs/DEPLOY_TONIGHT_2026-07-08.md
.ai/context/CX_ROLLOUT_CODEX_LOG_2026-07-08.md
docs/UBUNTU_LIVE_BOX_GUIDE.md
docs/CX_AUTONOMY_DAMPENING_CENSUS_2026-07-08.md
```

Then inspect current state:

```powershell
git status --short
git branch --show-current
```

On live:

```bash
cd /opt/tagcontactbridge-parallel
git status --short
git rev-parse --abbrev-ref HEAD
git rev-parse --short HEAD
systemctl --no-pager is-active parallel-control-plane parallel-ringcentral-cx parallel-inbound-gateway parallel-outbound-gateway parallel-ai-bus parallel-live-coach-grpc
```

## What To Do Immediately After Restart

When Mickey has edited env and restarted live services, do this in order:

1. Health checks:

```bash
curl -fsS http://127.0.0.1:5001/health
curl -fsS http://127.0.0.1:6101/health
curl -fsS http://127.0.0.1:7000/health
curl -fsS http://127.0.0.1:7335/status
```

2. Journal sanity:

```bash
sudo journalctl -u parallel-control-plane -u parallel-ringcentral-cx --since '10 minutes ago' --no-pager
```

Look for:

```text
listening
ready
cx.alpha
firsttouch
appointment
terminal outbox
active call watcher
```

Also look for:

```text
uncaught
unhandled
fatal
syntax
EADDRINUSE
permission denied
```

3. Single-writer proof:

- Ubuntu journals show CX lifecycle writes.
- Local NSSM/logs stay silent.
- No local `Parallel*` services running.

4. Fresh first-contact proof:

- Create/wait for one fresh callable intake.
- Confirm 4001 forward sent.
- Confirm 6101 forward received.
- Confirm row marked first-touch pending.
- Confirm dispatcher publishes/assigns according to current window mode.
- Confirm phone rings.
- Outcome drains.
- Retry waits 90 minutes unless stop status.

5. Bulk proof:

- Work a small set of normal bulk calls.
- Confirm extern/UII poller match.
- Confirm buttons remain stable.
- Confirm no-answer/voicemail/bad-number/answered behavior.

6. Appointment proof:

- Due test appointment publishes to appointment lane.
- Modal/lane appears.
- Disposition resolves appointment and terminal row.

## Debugging Sensitive Points

### If phones are not ringing

Check:

- service health;
- lane flags;
- queue maps non-empty;
- RingCX campaign ids and dial group ids;
- RingCX lead accept/reject logs;
- queue rows in Mongo are ready/claimed with correct route stamps;
- no-show/builder did not stage zero agents because allowlist missing;
- first-touch window mode is not holding when you expected drip;
- RingCX itself is not freezing/suspect.

### If app shows wrong current lead

Check:

- active call watcher logs;
- `externId` shape (`cxbl`, `cxft`, `cxapt`);
- current session id vs canonical active session;
- whether the browser is stale;
- whether RingCX has advanced without app projection;
- whether `Sync call` can resolve exactly one active session candidate.

### If buttons disappear or do nothing

Check:

- stale feed state;
- `bulkSessionId` exists;
- server response from disposition route;
- stale/killed session;
- lane call taking priority over bulk;
- active-call resolver no-match or multiple-match logs;
- RingCX disposition transport result.

### If lead disappears mid-call

Check:

- system disposition;
- active-call switch terminal observations;
- wrap hold/review hold;
- ghost-rescue/invalidated buffer logs;
- whether RingCX ended/advanced first;
- terminal outbox row.

### If DNC/client leads are dialing

Check:

- contact eligibility;
- LeadCadence stop evidence;
- CaseProfile status;
- Logics status read;
- transient vs confirmed classification;
- queue builder gate and runtime gate agree.

Do not solve by broad pruning. Find the gate mismatch.

### If RingCX freezes / multiple sessions

Check:

- agent state in RingCX;
- suspect/multiple session indicators;
- service journals around that time;
- whether our app sent session replacements or status changes;
- RingCentral login/resource errors.

If RingCentral itself returns login 503/404 assets, escalate as RingCentral-side.

## The "Do Not Be Clever" List

Do not:

- re-enable local as a worker because it is convenient;
- use legacy dial commands for bulk;
- insert leads directly into RingCX with wrong extern id shape;
- treat phone match as ownership;
- let Sean pilot drip become production;
- turn broad morning discovery on because the map is annoying;
- add a new cleanup worker without hard evidence gates;
- change `.env` and code in one unproven sweep;
- print secrets;
- commit generated CSVs/log captures;
- restart services just because you changed code;
- pop old live stash wholesale;
- fix coach and CX in the same breath unless asked;
- refactor normalizers during a live floor patch;
- add "skip" as an agent-facing outcome;
- make the app decide lead quality beyond concrete DNC/client/non-active evidence.

Do:

- keep phones moving;
- keep logs concrete;
- prefer explicit env;
- ask Mickey for restarts;
- test one slice at a time;
- use route stamps and extern ids;
- make stale state visible;
- preserve old state before live changes;
- write down every operational finding.

## Work That Is Probably Next

### 1. Finish restart/post-restart proof

After env edit and restart:

- health;
- journals;
- first-contact forward;
- first-touch dispatch;
- appointment dispatch;
- bulk call loop;
- bad number path;
- sysdispo classifier.

### 2. Formal single-writer monitor

Write or run a monitor that confirms:

- Ubuntu emits CX lifecycle events;
- local emits none;
- no local `Parallel*` services are active;
- no second worker is draining terminal outbox.

### 3. Stale session rebind

Server should return structured stale-session response when a disposition targets a
killed/replaced session. Client should rebind to canonical running session and tell
agent clearly.

### 4. First-contact forward production proof

The seam exists, but the env must be right:

- 4001 sends;
- 6101 receives;
- dispatcher sees row;
- RingCX accepts;
- terminal drains.

### 5. No-show release operationalization

Dry-run first. Confirm route restamping. Never release dialed rows. RingCX cancel
before Mongo release.

### 6. Caller ID rotation

Useful but separate. Needs number pools, callback routing, and careful RC/RingCX
read-back verification.

### 7. Coach local revival

Tomorrow local can come back for coach. Keep it worker-quiet for CX. Make the coach
rig explicit so it does not start CX lifecycle writers.

### 8. Live repo hygiene

After hours only:

- old backups;
- root-owned build artifacts;
- checkout-colliding untracked files;
- captured/stashed WIP triage.

Do not do broad cleanup during dialing.

## 2026-07-09 Audit Addendum: Flags Let Two Owners Run

This is the cleanest theory of the morning failure:

The outage did not create the bug. It exposed that CX ownership was still assembled
from several independent flags. One flag said bulk was enabled, another missing
flag let the runtime resolve back to the old slow rail, and another flag left the
old RingCX cadence worker alive. The result was two systems feeding RingCX and
two systems believing they owned the active call.

Mickey has said the desired product many times:

- phone rings;
- agent clicks one of a small number of outcomes;
- system records the outcome;
- next lead arrives;
- no hidden worker decides a lead is too weird, too stale, too fresh, or too
  inconvenient unless it is DNC/client/inside the cooldown law.

The code should reflect that. If a worker can publish, claim, assign, dispatch,
or terminate a CX call, it is not a casual feature flag. It is an ownership
decision.

### Where the Structure Leaks

1. `packages/shared-services/src/cxDialRuntimeModeService.js:16` defaults the
   dial runtime to `slow_single`.

   `packages/shared-services/src/cxDialRuntimeModeService.js:50-51` then reads
   `CX_DIAL_RUNTIME_DEFAULT` and `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED`
   independently. That means `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=true` can be
   present while the actual default runtime still silently becomes `slow_single`.

   For a live floor, that fallback is too polite. If bulk is the owner and the
   default is missing or contradictory, the process should fail closed at boot
   or emit a fatal stop-light. It should not quietly degrade into the old rail.

2. `packages/shared-services/src/cxRuntimeModeService.js:16-26` decides whether
   the service is in bulk alpha runtime by requiring both the bulk flag and either
   `VITE_CX_WORKSPACE_MODE=bulk_load` or `CX_DIAL_RUNTIME_DEFAULT=bulk_load`.

   This is how the ringcentral-cx process can fail to self-disable legacy workers:
   bulk can be "enabled" but not considered the current runtime. In practice that
   let the old worker keep running after the restart.

3. `apps/ringcentral-cx/src/server.js:496-640` still contains the old cadence
   assigner. It calls `assignCxQueueBatch()` for fresh, day 2-15, day 16-30, and
   aged families, then logs `ringcentral.cx_queue.assigned` and
   `ringcentral.cx_queue.assigned_nonfresh`.

   In the bulk world, those lines are not harmless housekeeping. They are another
   path that can put dialable inventory into RingCX outside the active bulk
   session.

4. `apps/ringcentral-cx/src/server.js:742-770` contains the fresh hot lane worker.
   It is guarded by the same bulk-runtime check. That is better than nothing, but
   it still means one derived boolean decides whether a second direct assigner is
   allowed to run.

5. `packages/shared-services/src/cxMorningQueueBuilderService.js:585-590` makes
   the morning builder default to `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED` when
   `CX_MORNING_QUEUE_BUILDER_ENABLED` is absent.

   That is another ownership decision disguised as a convenience default. A
   process that can pre-publish dial inventory should be explicitly part of the
   single owner profile, not accidentally on because a broader bulk flag is true.

6. `packages/shared-services/src/cxWorkspaceService.js:3561` calls
   `assignCxQueueBatch()` inside workspace refill logic, and
   `packages/shared-services/src/cxWorkspaceService.js:3727` defaults
   `RC_CX_EMPTY_QUEUE_REFILL_ENABLED` to true.

   This is a side door. If the new bulk session buffer is the owner, empty-queue
   refill cannot also be allowed to claim and assign through the old path unless
   it is explicitly redefined as part of that same owner.

7. `scripts/alpha-watch.js:7` and `scripts/alpha-watch.js:30-31` explicitly treat
   routine `cx_queue.assigned` as noise.

   That was reasonable when cadence assignment was expected. Under bulk ownership,
   it hid one of the most important red flags. A bulk-floor watcher should treat
   `ringcentral.cx_queue.assigned` as a stop-light unless the line comes from an
   approved migration or burnoff task.

8. `apps/control-plane/src/server.js:1291-1338` runs the account active-call
   watcher and calls `watchCxBulkLoadAccountActiveCalls()`. This is the right
   direction: one watcher observes RingCX reality and writes the current call
   state.

   The problem is not that this watcher exists. The problem is that other workers
   were still able to feed calls around it.

### What Actually Happened On The Floor

Bulk had clean session buffers. RingCX also had durable campaign inventory from
old or parallel assignment paths. When Chris dialed, RingCX could serve an old
`cxbl-*` lead that was not attached to the current clean bulk session. The app
then saw no current bulk call for that browser/session, so outcome clicks landed
as "no current" even while RingCX was still dialing and talking.

This is why voicemail could feel fine while answered/no-answer felt strange. The
happy path sometimes lined up by accident. The broken path was not a button bug
by itself; it was an ownership mismatch.

Killing or replacing an app session does not automatically erase already-published
RingCX campaign leads. RingCX inventory is durable until explicitly cancelled,
burned, or consumed. Any "rebuild" story has to account for both Mongo/session
state and RingCX campaign inventory.

### The Single Owner Target

Replace flag soup with one floor owner profile.

The profile can still be represented by env, but it should be one decision:

`CX_DIAL_OWNER=bulk_load`

or equivalent.

From that one decision, derive every worker:

- bulk session buffer: on;
- account active-call watcher: on;
- button resolution path: on;
- first-touch dispatcher: on if it is part of bulk owner;
- appointment dispatcher: on if it is part of bulk owner;
- old cadence assigner: off;
- old fresh hot lane assigner: off;
- empty workspace refill through `assignCxQueueBatch`: off unless rewritten under
  the bulk owner;
- morning builder: either part of the owner profile or off;
- stale dial sweep / old governance: off unless explicitly proven harmless.

If any old assigner is explicitly enabled while `CX_DIAL_OWNER=bulk_load`, boot
should fail or at least refuse to start the assigning worker. Do not let the
process say "bulk is enabled" while also quietly running an old feed.

### What 5.6 Should Attack

1. Create one owner resolver.

   It should return a complete profile, not just a runtime string:

   - owner name;
   - can publish RingCX leads;
   - can claim Mongo queue rows;
   - can observe active calls;
   - can write terminal outcomes;
   - can drain terminal outcomes;
   - can run first-touch;
   - can run appointments;
   - forbidden workers.

   Every service imports that resolver. Nobody hand-parses the same five env vars.

2. Make contradictory config loud.

   Examples that should fail loudly:

   - bulk load enabled but default runtime missing;
   - bulk owner selected but cadence worker enabled;
   - bulk owner selected but empty-queue refill enabled through the old assigner;
   - morning builder enabled without an explicit owner decision;
   - first-touch forwarding enabled but dispatcher disabled;
   - appointment lane enabled but no agent map or campaign map for the target
     floor.

3. Remove silent fallback from floor ownership.

   Fallback is acceptable for a local developer preview. It is not acceptable for
   the live floor. The live process should prefer "do not start the bad writer" to
   "start an older writer because a string was missing."

4. Put RingCX inventory into the model.

   A bulk session is not clean just because Mongo says it is clean. The campaign
   can still contain old published leads. Rebuild tooling must either:

   - cancel old RingCX inventory by known extern/session stamp before declaring a
     clean run; or
   - explicitly mark the floor as stale burnoff and show that state in logs/UI.

5. Make the UI buttons ask the current owner once.

   The button should not disappear because the browser missed one poll. The safer
   model is:

   - poller matches current call when it can;
   - buttons remain available for valid outcomes;
   - on click, one owner endpoint asks RingCX "what is this agent's active UII
     right now?";
   - if it matches the current bulk lead, resolve normally;
   - if it does not match, return a clear stale/mismatch result and optionally
     surface a manual sync lane.

   That is healing, not guessing. The key is that one endpoint owns the answer.

6. Treat fresh-arrival firing as a first-class health check.

   The watcher should not only ask "are agents dialing?" It should ask:

   - did fresh/first-contact leads arrive since the last check;
   - were they stamped for the lane;
   - were they assigned across the active agents;
   - did any active agent get skipped;
   - did they dispatch or sit silently in a pool;
   - did 4001 send and 6101 receive.

   If new leads arrived and nothing moved toward an agent, that is not quiet. It
   is the exact failure class that made the morning confusing.

### Tests That Should Exist Before The Big Refactor Lands

- Bulk owner config test: one owner setting disables cadence, fresh hot lane,
  empty workspace refill, and any legacy direct assigner.
- Contradictory env test: bulk enabled with missing/default slow runtime fails
  loudly.
- Log sentinel test: `ringcentral.cx_queue.assigned` under bulk owner is a
  failing event unless the test explicitly arms legacy burnoff.
- RingCX stale inventory test: killed-session externs do not attach to the new
  app session, and the system reports stale campaign inventory rather than acting
  confused.
- Button recovery test: with a missed poll, clicking an outcome asks RingCX for
  the active UII once and either resolves the correct lead or returns a visible
  mismatch.
- Fresh-arrival test: a new inbound first-contact lead moves from 4001 to 6101 to
  first-touch assignment/dispatch for the intended active agent set.
- No-show/release test: undialed rows can be released only after RingCX copies are
  cancelled or proven absent; dialed rows are never released.

### Patch Bias

Do not make the next fix clever.

The desired behavior is a train, not a committee:

1. One process decides what should be dialable.
2. One process publishes it.
3. One watcher observes what RingCX is actually doing.
4. One endpoint resolves the outcome.
5. One drain writes the durable result.

Everything else should either observe, report, or refuse to run.

Flags are fine for experiments and optional polish. They are not fine as separate
answers to "who owns dialing today?"

## 2026-07-09 PM Addendum: The Boring Dialer Trunk

This is the distilled target from the live floor evidence after Sean/Chris/Brad/Phil
testing on July 9. Keep the proven end-of-call machinery. Replace only the lead
progression trunk.

The downstream flow that already has scars and proof should stay:

```text
button press or RingCX system disposition
-> terminal outbox
-> drain
-> call note / call wrap / bad number / DNC handling
```

Do not rewrite that as part of the trunk reset. The problem is how leads keep
arriving in RingCX through the day, not whether the drain/callwrap pipe can write
the final business result.

### Product Law

```text
Before RingCX: the app chooses eligible work.
After RingCX accepts it: RingCX owns live dial order.
During the call: the app observes by extern/UII.
End of call: terminal/drain records the result once.
```

Everything else is a bug unless Mickey explicitly asks for a manual reset.

### Allowed Writes

The RingCX load is the ownership boundary. Selection is read-only; the loader sends
the selection and records the accepted receipt. After RingCX accepts a lead, the app
has exactly two ordinary write paths:

1. **Current projection** - the watcher records the RingCX-proven active
   `externId`/UII for the agent.
2. **Terminal fact** - a button or RingCX system disposition writes one outbox row
   by `queueItemId:uii`.

The downstream drainer is the single consumer of that terminal fact. The app queue
is a rebuildable display/identity cache, not the dialer and not an append-only ledger.
Nothing re-readies, rescues, prunes, reorders, reclaims, or "maintains" RingCX
inventory after load.

### The Short Service Shape

Build the replacement as one boring service with short functions and injected
adapters. The core should be small enough that a tired human can see every owner in
five minutes.

```text
buildPool(poolParams, leadCadence)
addIncomingLead(agentId, incomingPost)
selectFromPool(pool, rules)
sendSelectionToRingCentral(agentId, leads)
persistAcceptedQueue(agentId, acceptedLeads)
getAgentQueue(agentId)
rebuildAgentQueueFromRingCentral(agentId)
pollAndMatchActiveCall(agentId)
readSystemDispositions(agentId)
writeSystemDispositionOutcomes(agentId)
dispositionCall(agentId, outcome)
killSession(agentId)
```

`killSession` is manual only. It is the only legal cancellation/pruning lane. No
background cleanup path may disguise itself as judgment.

### Floor-Stoppers The Reference Sketch Must Fix

The short sketch is a direction, not code to paste into production unchanged. These
rules are part of the 5.6 contract:

1. **Outstanding queue size comes from RingCX.** An append-only accepted cache never
   shrinks, so refill never fires after the first batch. Refill must use RingCX's
   outstanding accepted/active count, or a cache rebuilt from that list. Completed
   externs leave the projection. The invariant is `queue length = outstanding work`.

2. **Clear server current only from a confirmed-good observation.** When a successful
   RingCX snapshot proves there is no active call for the agent, clear the server's
   current projection. When the read fails or the snapshot shape is unknown, hold.
   The browser may keep the last card latched for usability; that latch is not live
   call authority.

3. **A stale cache cannot veto a real call.** If RingCX reports an active UII/extern
   that the app cache does not contain, rebuild the identity projection from RingCX
   and retry. The disposition endpoint must not strand an agent merely because an
   app cache missed a restart or an earlier accepted lead. It must still refuse phone
   guessing and ambiguous identity.

4. **The extern grammar is complete or the load is rejected.** Keep the current
   `cxbl-<domain>-<sessionToken>-<queueItemId>` identity. Require a real session token;
   never publish `undefined` in an extern id. Do not silently invent a replacement
   grammar during the simplification.

5. **Pool selection has one concurrency owner.** FIFO `splice()` is safe only inside
   one serialized owner with one shared pool. If more than one process or concurrent
   refill can select, retain the existing atomic Mongo claim/CAS as the boring claim
   primitive. "One loop" must be enforced, not assumed.

6. **Outcome precedence is deterministic.** A manual agent outcome owns a call that
   was ever projected as current. RingCX system disposition owns true fly-bys that
   never became current. `insertOnce(queueItemId:uii)` prevents double effects, but
   first-writer-wins alone is not a business rule.

7. **Boot and duplicate handling ask RingCX.** Rebuild each agent's outstanding
   identity projection before the first refill. Before loading, exclude leads already
   outstanding in RingCX and reject duplicate active queue siblings.

8. **Manual kill closes the in-flight gap.** Cancel the accepted externs including
   current, best-effort hang up the active UII, write the explicit manual-reset
   terminal fact once, then clear the projection. Killing only the buffer loses the
   call already in flight.

9. **There is one terminal drainer.** Button and system-disposition facts converge on
   the same outbox, and exactly one drain owner applies downstream effects. A second
   drainer recreates the double-effect race even when the dialer trunk is clean.

### Morning And Overnight

Overnight/incoming first-touch should use the same rail as every other load:

```text
newLead = getLeadFromIncomingPost(res.data)
eligibleLead = validateHardEligibility(newLead)
addedLead = sendSelectionToRingCentral(agentId, [eligibleLead])
agentQueue.push(addedLead)
```

Only push to the app display queue after RingCX accepts the lead. Rejections are
logged, not projected as if the lead exists.

At the start of the day:

```text
pool = buildPool(poolParams, leadCadence)
```

`poolParams` should be fixed and boring:

```text
acceptedStatusId only
no appointments
no DNC
no clients
no non-prospects
respect the cadence window, currently 90 minutes
```

Store pool leads by type (`fresh-day1`, `fresh-day2to10`, `fresh-day16to30`,
`aged`) and pull FIFO from each bucket when RingCX's outstanding count for the agent
drops to the refill threshold, currently around 5. Do not use the length of an
append-only app receipt list. The mix rule is data. It should not become a second
worker.

### What To Reuse

Reuse the boring primitives that already work:

- eligibility reads and pool selection;
- `cxbl` extern creation;
- RingCX `loadLeads`;
- active-call match by extern/UII;
- disposition transport;
- system-disposition read;
- terminal outbox idempotency;
- drain/callwrap/bad-number/DNC handling.

Do not greenfield the downstream business pipe. Collapse the feeder/manager layer.

### What To Remove Or Stop Calling

The harmful class is post-load management:

- no `READY_LEADS` after the original load;
- no per-lead `AGENT_RESERVATION` as a keepalive unless a one-agent proof shows it
  is truly required for routing;
- no buffer invalidation that mutates RingCX inventory;
- no current-release/review-hold as a call-state owner;
- no stale sweep that decides a loaded lead should be controlled;
- no old cadence/fresh-hot/morning feeder running beside the owner;
- no hidden app-side pruning because the queue "looks wrong."

If RingCX accepted the lead, it is RingCX's list until terminal outcome or manual
kill. The app may observe and report. It may not curate.

During the 5.6 weed-whack, do not physically delete these paths on the first pass.
Hard-gate each old caller, run the named tests and one-agent proof, record it in a
pending-deletion ledger, and wait for Mickey's approval before permanent removal.

### Button Rule

Buttons should remain available for valid terminal actions. On click, they should
ask one owner endpoint for the agent's active RingCX UII, match by extern/UII, and
then write the terminal outcome. Do not depend on a stale browser current card.
If the local identity cache misses, rebuild it from RingCX and retry the hard-identity
match once. Do not let stale cache veto RingCX truth, and do not match by phone.

### System Disposition Rule

RingCX system disposition is the truth for fast outcomes the app can miss between
polls: congestion, no-answer, busy, disconnected, caller hangup, and similar. This
replaces the old "buffer released" inference. The app should ask RingCX what
happened to accepted externs and feed that into the same terminal outbox.

### Success Bar

The floor is healthy when:

- new incoming leads are accepted into RingCX and become visible receipts;
- morning pool/refill appends accepted leads and does not touch loaded ones;
- the outstanding projection shrinks as RingCX completes leads, so refill runs past
  the first batch instead of stopping forever;
- agents can keep dialing if the app UI jitters;
- voicemail/no-answer/answered/bad-number all produce one terminal result;
- fresh leads do not silently pool forever;
- no code path tries to be smarter than DNC/client/non-prospect/cadence and RingCX
  terminal truth.

The whole point is not a perfect abstraction. It is a phone floor that keeps
ringing without five managers arguing over the same call.

## How To Talk To Mickey During This

Be concrete. Mickey does not need ceremony. Good updates:

- "Live is on branch X at commit Y."
- "Tests passed: 474/474."
- "I found one stop-light: forward env is absent."
- "I need you to restart these services when ready."
- "This log says RingCX accepted the lead but poller did not match extern id."

Bad updates:

- "It should work."
- "Probably fine."
- "I cleaned up some stale stuff."
- "I restarted it."
- "I think this is a RingCentral thing" without evidence.

If you do not know, say what you are checking next.

## Final Mental Model

This project is not mainly a React app or a Node service. It is an ownership system
for live phone work.

The hardest bugs are not syntax bugs. They are disagreements about who owns reality:

- RingCX says this call is active.
- App says another lead is current.
- Browser says old session is alive.
- Queue row says claimed by old route.
- Worker says no-show release.
- Logics read fails and somebody treats that as truth.

Your job is to make reality have one writer at a time, and make every other part of
the system either observe it, retry it, or refuse to guess.

If the phone keeps ringing, the app records what happened, DNC/client rows stay out,
and uncertainty waits instead of destroying data, you are winning.

Everything else is cleanup.
