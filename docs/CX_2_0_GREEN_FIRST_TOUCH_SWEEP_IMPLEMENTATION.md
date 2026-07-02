# CX 2.0 Green First-Touch Sweep Implementation Map

Date: 2026-06-29

## Goal

CX 2.0 needs a deterministic morning and refill rule:

1. If there are eligible green leads with zero confirmed CX dials, serve those first.
2. "Touched" means confirmed dial proof, not queued, mirrored, visible, or assigned.
3. Weekend and after-hours greens should be handled the same as weekday overnight greens: they enter the green first-touch pool and rise to the top when agents begin dialing.
4. Once first-touch green debt is gone, normal family mix resumes.
5. This rule belongs in queue creation/reservation/refill, not in the client.

This document is the implementation guide for the files that should change.

## Implementation Strategy Against Current Code

The current code already has most of the right machinery: cadence creates intent, `CxDialQueue` stores dialable rows, reservation claims rows, and RingCX mirroring publishes them. The change should not create a new queue universe. It should insert one shared rule into the existing creation and reservation flow:

> Before normal queue mix is written or reserved, ask whether green first-touch debt exists. If it does, write/reserve only those green first-touch rows. When the debt is gone, fall back to normal mix.

### Preferred Queue Exposure Model

The safest implementation is not a broad "morning sweep flag" that tries to suppress random downstream behaviors. The 7am builder should expose a narrower queue supply:

1. At 7am, resolve after-hours, prior-day, and weekend green leads with zero confirmed CX dials.
2. While that debt exists, the queue builder and reservation layer should expose only those zero-dial green rows.
3. Once every eligible zero-dial green has been touched once, unlock the normal queue mix.
4. After unlock, newly arriving greens can still rank at the top through the normal green priority path.
5. Every refill should re-check the debt instead of trusting a long-lived process flag.

In other words, this is a supply/query rule, not a UI state and not a mode-specific workaround.

The queue should behave like:

```txt
Morning / refill starts
  -> Are there eligible zero-dial greens from after-hours, yesterday, today, or weekend?
      yes -> expose/reserve only zero-dial greens
      no  -> expose/reserve normal family mix, with fresh greens still ranked first
```

This keeps the logic deterministic:

- no normal churn can start before first-touch green debt is paid down,
- no agent gets random live queue shoves,
- no client has to know why a row is first,
- no lead is considered touched until call proof arrives.

### Bridge From Current Code To The Clean System

The bridge should be a clean supply-layer change, not another runtime mode.

Current code already has these durable pieces:

- `LeadCadence` knows which leads exist and whether CX has actually touched them.
- `CxDialQueue` is the actual dialable supply.
- `cxQueueReservationService` is the clean place to claim rows.
- `cxMorningQueueBuilderService` is the right place to prepare the morning supply.
- Bulk/slow/legacy rails differ mostly in how rows are handed to RingCX, not in what should be eligible.

The new behavior should connect those pieces through one small service:

```txt
cxGreenFirstTouchSupplyService
  -> reads LeadCadence + CxDialQueue
  -> finds overnight/weekend/today green first-touch coverage debt
  -> creates missing queue rows through queueCxDialRequest
  -> exposes only green coverage rows until coverage is satisfied
  -> then returns normal family targets
```

Do not make this a global flag like `GREEN_SWEEP_ACTIVE=true`.

Instead, every build/refill asks the service a pure question:

```js
const supplyPlan = await resolveCxGreenFirstTouchSupplyPlan({
  domain,
  routeCampaigns,
  agentExtensionId,
  asOf
});
```

Return shape:

```js
{
  phase: "green-first-touch-coverage",
  coverageOpen: true,
  coveredCount: 18,
  uncoveredCount: 7,
  dialedOnceCount: 4,
  queuedCount: 14,
  missingQueueRows: 7,
  familyTargets: { "fresh-day1": 35 },
  reservation: {
    queueFamilies: ["fresh-day1"],
    firstTouchCoverageOnly: true
  },
  reason: "overnight-green-coverage-open"
}
```

When coverage is done:

```js
{
  phase: "normal-daily-mix",
  coverageOpen: false,
  familyTargets: {
    "fresh-day1": 15,
    "fresh-day2to15": 10,
    "fresh-day16to30": 5,
    "aged": 5
  },
  reservation: {
    firstTouchCoverageOnly: false
  },
  reason: "overnight-green-coverage-complete"
}
```

Important distinction:

- "Coverage complete" means every overnight/weekend/today green is either already in an agent queue or has confirmed dial proof.
- "Touched complete" means confirmed dial proof exists.

This lets the morning builder resume normal daily queue building once the overnight green set has been distributed, without pretending every queued lead has already been dialed.

#### Clean Boundaries

Use four single-purpose functions:

```txt
resolveGreenCoverageWindow(asOf)
  Pure date helper. Returns the overnight/weekend/today window that must be covered first.

listGreenCoverageDebt(domain, filters)
  Reads LeadCadence and CxDialQueue. Returns covered, uncovered, dialed, queued, and missing rows.

backfillGreenCoverageQueueRows(debt)
  Calls queueCxDialRequest for missing rows. Does not directly insert queue docs.

buildQueueSupplyPlan(debt, normalTargets)
  Returns green-only family targets while coverage is open, otherwise normal targets.
```

These functions should not know about React, RingCX button clicks, coach state, appointment state, or the dialer mode.

#### 7am Builder Flow

The 7am builder should become:

```txt
for each agent/domain route:
  1. resolve green coverage window
  2. list green coverage debt
  3. backfill missing queue rows
  4. build supply plan
  5. reserve/mirror according to that plan
  6. log coverage status
```

If coverage is still open:

- only green first-touch coverage rows are exposed/reserved,
- normal blue/yellow/red/aged rows wait.

If coverage is closed:

- build normal queue mix,
- newly arriving green rows continue to rank at the top through normal priority.

#### Refill Flow During The Day

Every refill should call the same supply planner:

```txt
refill starts
  -> resolve supply plan
  -> if coverage open, reserve fresh-day1 coverage rows only
  -> if coverage closed, reserve normal family mix
  -> publish accepted rows to RingCX
```

This handles after-hours spillover and live arrivals without a special "morning only" branch.

New green leads that arrive after coverage is complete should not reopen the whole morning coverage phase unless they are part of the configured coverage window. They should simply ride the existing green priority path and land at the top of later refills.

#### Avoiding Permanent Green-Only Lock

There is a real failure mode if "first-touch coverage" is treated as a live, unbounded mode:

```txt
one new green arrives
  -> coverage debt is nonzero
  -> normal queue does not build
  -> one more green arrives
  -> normal queue still does not build
  -> system stays green-only all day
```

Avoid this by making the 7am coverage set finite.

Recommended rule:

1. At the morning cutoff, create a fixed `greenCoverageBatch`.
2. That batch contains overnight, prior-day, weekend, and pre-cutoff same-day green leads with zero confirmed CX dials.
3. Distribute that batch across agents in chunks.
4. Build the normal queue behind those chunks immediately.
5. New greens that arrive after the cutoff go into the normal fresh lane and rank high, but they do not reopen the morning coverage lock.

This turns the system from "stay in special mode while any green exists" into "pay down this finite morning obligation first."

Suggested planning shape:

```js
{
  phase: "green-coverage-batch-open",
  batchId: "green-coverage-2026-06-29",
  cutoffAt: "2026-06-29T14:00:00.000Z",
  batchRemaining: 83,
  normalQueueCanBuildBehindBatch: true,
  postCutoffGreensUseNormalFreshPriority: true
}
```

Queue shape per agent:

```txt
agent visible/reservable queue
  1. assigned green coverage batch chunk
  2. post-cutoff fresh greens
  3. normal family mix
```

The queue can still fill to the normal target, but reservation should drain the assigned coverage chunk before normal rows for that agent.

This solves both sides of the tension:

- first-touch coverage is protected because the morning batch is first,
- normal day work is not starved because the queue is built behind the batch,
- a single new incoming green cannot keep resetting the whole queue builder,
- new greens still get fast treatment because they rank high in the normal fresh lane.

##### Post-Cutoff Green Arrivals

Leads that arrive after the 7:45am coverage snapshot should not reopen the morning coverage lock.

Recommended behavior:

```txt
7:45 snapshot creates finite morning coverage batch
7:50 new green arrives
  -> create normal fresh-day1 queue row
  -> rank it above normal nonfresh work
  -> do not interrupt assigned morning coverage chunks
  -> do not prevent normal queue from building behind coverage
```

If an agent is still working assigned morning coverage, that assigned chunk stays first. If the agent has exhausted their assigned coverage, post-cutoff greens should be the top of the normal refill before blue/yellow/red/aged.

This gives same-day arrivals fast treatment without letting a trickle of one-off new leads keep the whole floor in coverage mode.

Optional safety check:

```txt
if post-cutoff green volume becomes unusually high:
  let normal refill pull them first
  do not recreate a global coverage batch
```

##### RingCX Dial Priority For Zero-Dial Greens

Do not make every zero-dial green `dialPriority: "immediate"` throughout the day.

Recommended rule:

- Morning coverage rows: send to RingCX in ordered one-at-a-time mode with `normal` priority.
- Post-cutoff fresh greens: queue them at the top of our refill order, but still send with `normal` priority.
- Appointment/manual/explicit agent-requested dials: allow `immediate`.

Reason:

- `immediate` is a transport override, not a queue priority system.
- Blanket immediate can jump carefully built order, create UI/RingCX mismatch, and amplify auto-advance behavior.
- Our app should own priority with `CxDialQueue` ordering; RingCX should receive a clean ordered list.

So "zero dials" should mean high priority in our queue, not automatic RingCX immediate priority.

##### Fresh Green 15-Minute SLA

The system also needs an operational promise:

> A newly submitted green should receive its first CX dial attempt within 15 minutes when there is active dialing capacity.

Do not solve this with blanket RingCX `immediate` priority. Solve it with an SLA timer in our queue supply.

Recommended fields:

```js
{
  metadata: {
    freshSubmittedAt,
    firstDialSlaDueAt,
    firstDialSlaWarnAt,
    firstDialSlaState: "open" | "warning" | "urgent" | "satisfied",
    firstDialSlaReason
  }
}
```

Recommended timing:

```txt
submitted at T
  -> SLA warning at T + 10 minutes
  -> SLA due at T + 15 minutes
```

Supply behavior:

```txt
fresh green arrives
  -> create fresh-day1 zero-dial row
  -> set firstDialSlaDueAt = submittedAt + 15 minutes
  -> rank high in normal fresh lane

SLA watcher/refill sees row near due
  -> move it into urgent fresh supply
  -> any active agent can pull it on next refill

confirmed dial proof arrives
  -> mark SLA satisfied
```

Queue priority order after the 7:45 morning batch exists:

```txt
1. assigned morning coverage rows
2. overdue / near-due first-dial SLA greens
3. released shared morning coverage rows
4. post-cutoff fresh greens
5. normal family mix
```

This is the compromise:

- the finite morning batch still gets protected,
- new submissions cannot sit forever behind normal churn,
- one new green does not reopen the morning coverage lock,
- urgent rows can move across agents if the assigned path is not shrinking.

If the business promise must be hard 15 minutes, the system needs enough active capacity to honor it. Code can enforce priority and escalation; it cannot make seven busy agents place more calls than the floor can physically handle.

Recommended escalation rule:

```txt
if zero-dial green is within 5 minutes of SLA due
and it is not already accepted by RingCX
and it has no confirmed dial proof:
  make it shared urgent fresh supply
```

Optional break-glass only:

```txt
if row is past due
and the normal ordered handoff is not getting accepted
and an active agent is available:
  allow dialPriority immediate for that single SLA rescue row
```

Default should remain ordered `normal` priority. `immediate` should be a measured rescue path, not the standard priority system.

##### Appointment-Style SLA Logic

The 15-minute first-dial SLA can reuse the same timing shape as appointments, but it should not be stored or treated as a real appointment.

Clean abstraction:

```txt
queue obligation
  appointment callback
  first-dial SLA green
```

Both are deadline-driven work:

- they have a `dueAt`,
- they can have a `warnAt`,
- they can become urgent,
- they can be assigned to an agent or released to shared supply,
- they should rise above normal queue work when due.

But they have different meaning:

- Appointment: human-created scheduled follow-up, may write Logics task/activity, may require wrap-up/workbench behavior.
- First-dial SLA: system-created freshness promise, no appointment task, no appointment metrics, no appointment UI semantics.

Recommended shared metadata:

```js
metadata: {
  queueObligationType: "appointment" | "firstDialSla",
  queueObligationDueAt,
  queueObligationWarnAt,
  queueObligationState: "open" | "warning" | "urgent" | "satisfied" | "expired",
  queueObligationScope: "assigned" | "shared",
  queueObligationReason
}
```

Recommended helper:

```txt
resolveDueQueueObligations(...)
  -> reads queue rows with due/warn obligation metadata
  -> returns appointment callbacks and first-dial SLA greens in one priority list
  -> does not perform appointment-specific Logics writes
```

Reservation priority can then be:

```txt
1. due appointment callbacks
2. due or near-due first-dial SLA greens
3. assigned morning coverage rows
4. released shared morning coverage rows
5. post-cutoff fresh greens
6. normal family mix
```

Whether appointments should outrank SLA greens is a business choice. The important implementation rule is that both go through the same deadline prioritizer instead of two separate timing systems.

Do not implement this by naming SLA greens as appointments. That would pollute:

- appointment counts,
- Logics task creation,
- appointment UI workflows,
- sales follow-up reporting.

Implementation bridge:

- Extract the reusable deadline parts from appointment handling into a queue-obligation helper.
- Keep appointment-specific side effects in appointment code.
- Let first-dial SLA rows use the shared helper for warning/urgent/shared promotion.
- Let normal queue reservation consume the resulting priority list.

##### Dedicated First Contact Queue

Preferred refinement: keep first-contact SLA work in its own queue/lane instead of splicing it into the normal visible queue.

This avoids the fragile behavior we have repeatedly seen when special rows are inserted into an already active agent queue.

Clean lane model:

```txt
firstContactQueue
  -> zero-dial fresh greens that need first touch
  -> deadline ordered
  -> round-robin leased to logged-in agents
  -> feeds one row at a time

appointmentQueue
  -> actual scheduled follow-ups
  -> deadline ordered

normalQueue
  -> existing family mix
  -> built and drained normally
```

Agent selection order:

```txt
1. firstContactQueue due/available row
2. appointmentQueue due/available row
3. normalQueue next row
```

This means a first-contact lead can interrupt what the agent receives next, but it does not mutate, reorder, or splice the agent's existing normal queue list.

Recommended behavior:

```txt
new first-contact green arrives
  -> assign/lease it to the next logged-in eligible agent by round robin
  -> set dueAt = assignedAt + 5 minutes

agent becomes available for next lead
  -> if that agent has due/ready firstContactQueue row, serve it first
  -> else ask appointmentQueue
  -> else serve from normalQueue
```

For the client, keep the left-side normal queue stable. The middle active lead can come from the selected lane, but the normal queue does not need to visually churn just because an SLA row was served.

Why this is safer:

- first-contact SLA work has a clear owner,
- normal queue remains predictable,
- appointments remain semantically clean,
- no special row splicing,
- no "one green arrived so rebuild the whole queue" loop,
- lane priority can be tested independently.

Implementation surfaces:

- Add `firstContactQueue` as a logical lane over `CxDialQueue`, not necessarily a new Mongo collection.
- Use `metadata.queueLane = "firstContact"` or a narrow `queueFamily` only if the current queue family model cannot express it cleanly.
- Add a resolver:

```txt
claimNextFirstContactLead(agentContext)
  -> returns one due/available first-contact row for that agent
  -> uses route/campaign/domain filters
  -> respects active agent capacity
  -> marks claim with normal queue claim semantics
```

- Keep `normalQueue` build/refill untouched except for excluding rows already claimed by first-contact lane.
- Keep appointments in their own lane, below first-contact unless business decides otherwise.

Suggested priority:

```txt
first contact SLA
  above appointments when due/near-due

appointments
  above normal queue

normal queue
  existing family mix
```

If the floor decides appointments should always beat first-contact, the lane order can flip without changing the storage model.

###### Round-Robin First Contact Assignment

First-contact arrivals during the day should be assigned as short leases, not dropped into the normal queue.

Rule:

```txt
when a new zero-dial green arrives:
  find logged-in eligible agents
  choose next agent by round robin
  assign the first-contact row to that agent
  set dueAt = now + 5 minutes
```

Fields:

```js
metadata: {
  queueLane: "firstContact",
  firstContactAssignedToExtension,
  firstContactAssignedAt,
  firstContactDueAt,
  firstContactLeaseState: "assigned" | "due" | "claimed" | "satisfied" | "released",
  firstContactRoundRobinKey
}
```

The 5-minute value is a deadline, not a hold timer. If the assigned agent becomes available before the deadline, the row can be served immediately as that agent's next obligation.

```txt
assigned at 10:02
deadline at 10:07
agent is available at 10:04
  -> next lead served is the first-contact row

assigned at 10:02
deadline at 10:07
agent is still on a call at 10:06
  -> row can move into shared urgent first-contact pool

assigned at 10:02
deadline at 10:07
agent is on a call at 10:07
  -> wait until agent is available
  -> or let another eligible available agent claim it from shared urgent pool
```

Do not transfer the row one agent at a time at the 5-minute mark. That can create a round-robin carousel where the row keeps bouncing between agents who are only briefly available or not actually ready to receive a call.

Safer rule:

```txt
assignment phase:
  row is leased to one agent for fairness

warning phase:
  near deadline, if assigned agent is not available, promote to shared urgent pool

claim phase:
  any stable available/off-hook eligible agent can atomically claim it

publish phase:
  once claimed, publish to RingCX with a short claim TTL
```

Eligibility for claiming should require stable availability, not a single lucky poll:

```txt
agent must be:
  logged in
  off hook / ready
  not actively on a call
  not in appointment/workbench/break state
  available for at least 2 consecutive poll ticks
```

If the agent is not available, logged out, or not shrinking work as the deadline approaches, release the row back to the first-contact shared pool:

```txt
if now >= firstContactWarnAt
and agent is not logged in/off-hook/available
or row is still unclaimed after grace window:
  firstContactLeaseState = "released"
  firstContactAssignedToExtension = null
  make eligible for stable available logged-in agents
```

Recommended default:

- First-contact SLA deadline: 5 minutes.
- Shared urgent promotion: 4 minutes if assigned agent is not available.
- Release grace after claim/publish failure: 30-60 seconds.
- Only logged-in eligible agents participate in the round robin.
- If no eligible agents are logged in, leave the row in shared first-contact pool until one is available.
- Do not reassign directly from agent A to agent B. Release to shared urgent pool, then atomically claim.

This creates a real operational promise without disturbing the normal queue:

- new greens are distributed fairly,
- every one gets an owner,
- the owner has a short deadline,
- the lead is consumed as soon as the assigned agent can take it,
- near deadline, stable available agents can rescue it,
- stale assignments are reclaimed.

###### RingCX Predictive First-Contact Variant

There is a tempting alternative: make brand-new first-contact leads live in a RingCX predictive campaign and let RingCX dial them aggressively.

This should be treated as an experiment, not the default clean architecture.

RingCX constraints to respect:

- Agents can be assigned to multiple campaigns/dial groups, but an agent can only be actively logged into one outbound dial group at a time.
- A dial group has one dial mode. Campaigns inside that group share that mode.
- Predictive dialing lets RingCX decide how many leads to dial based on available agents.
- Absolute campaign priority can make higher-priority campaigns dial before lower-priority campaigns while those campaigns still have active leads.

Implication:

```txt
separate predictive first-contact dial group
  -> agents cannot simultaneously be active in the normal outbound dial group
  -> this is more like a floor mode switch than an overlay lane

first-contact campaign inside same dial group
  -> only works cleanly if the whole dial group is already predictive
  -> changes normal queue behavior and can undermine app-owned ordering
```

Why it is risky:

- Predictive owns routing, so our app loses precise "this lead is leased to this agent" semantics.
- Predictive may connect answered calls to whichever agent is available, not the round-robin owner.
- It can make current-call/UI matching harder because RingCX is intentionally optimizing away one-to-one control.
- It can worsen the exact auto-disposition/auto-advance surfaces we have been working around.

When it could be useful:

- Dedicated burst mode for a small first-contact campaign.
- A separate floor mode where agents intentionally switch into a first-contact predictive dial group.
- A controlled test using campaign priority inside a predictive-only dial group.

Not recommended for the default 2.0 path:

- Do not make "new green throughout the day" automatically predictive while agents are also expected to work the normal 2.0 queue.
- Keep the default first-contact lane app-owned, one-row-at-a-time, with RingCX receiving a clean ordered handoff.

Potential test only:

```txt
create First Contact predictive campaign
load only test greens
assign 1-2 agents explicitly
measure:
  time to first dial
  current-call matching accuracy
  whether owner semantics survive
  disposition/write accuracy
  whether agents can safely return to normal queue
```

###### Confirming Two-Queue Availability In RingCX

Before designing around "two queues at once," confirm which RingCX object is meant:

```txt
inbound queues
  -> agents can generally have multiple queue choices/assignments

outbound dial groups
  -> agents may be assigned to multiple dial groups
  -> agents can only be actively logged into one outbound dial group at a time

campaigns inside one dial group
  -> agents can dial campaigns inside the active dial group
  -> those campaigns share the dial group's dial mode
```

Practical consequence:

```txt
normal queue dial group + first-contact predictive dial group
  -> not simultaneously active for the same agent

normal campaign + first-contact campaign inside the same dial group
  -> simultaneously reachable
  -> but both use the same dial mode for that dial group
```

Read-only confirmation plan:

1. List RingCX dial groups.
2. List campaigns inside the normal dial group.
3. List agent assignments and `dialGroupIds`.
4. Confirm current active/off-hook state from the agent monitor/active-call probes.
5. Verify whether the desired "second queue" is an inbound queue, a campaign in the same dial group, or a separate outbound dial group.

Existing local probes that help:

- `scripts/rcx-voice-add-agents-to-dial-group.js --list`
- `scripts/ringcx-predictive-test-runner.js --resolve-only`
- `scripts/linux-heavy-api-smoke.js` for read-only RingCX list probes.

Design rule:

- If first contact must be simultaneous with the normal outbound flow, keep it in the app-owned lane or in a campaign inside the same active dial group.
- If first contact is a separate predictive dial group, treat it as a deliberate floor mode switch.

###### Per-Agent First-Contact Campaign Variant

Since a dial group cannot be both progressive and predictive, a safer RingCX-assisted variant is:

```txt
same active dial group
  normal campaign(s)
  first-contact campaign(s)

app-owned firstContactQueue
  chooses the agent
  waits until the agent is stable available/off-hook
  publishes exactly one first-contact lead to that agent's first-contact campaign
  requests urgent/immediate handling only for that single row
```

This does not use predictive. It keeps the current progressive dial group but gives first-contact its own campaign surface.

Two possible shapes:

```txt
preferred if RingCX supports it cleanly:
  one shared First Contact campaign
  row carries reserved/pending agent identity
  RingCX agent filter keeps it with the selected agent

fallback:
  one First Contact campaign per agent
  app publishes the selected lead into that agent's campaign only
```

The shared-campaign version is cleaner operationally if `enableAgentFilter` plus pending/reserved agent fields work reliably. The per-agent campaign version is more explicit but creates more admin objects.

Guardrails:

- Do not preload a list of first-contact rows into RingCX.
- Publish one row just-in-time after the app has selected the agent.
- Only publish if the agent is stable available/off-hook and not on a call.
- Keep a short claim/publish TTL.
- If publish is accepted but no active call appears, cancel/release/retry through the first-contact pool.
- Do not let the normal queue know about this row until it becomes current call proof.

Flow:

```txt
new green arrives
  -> app firstContactQueue assigns lease by round robin
  -> when selected agent is stable available
  -> publish one row to first-contact campaign for that agent
  -> RingCX dials it through the active dial group
  -> active-call poller confirms UII/current lead
  -> call proof satisfies first-contact SLA
```

This gives us most of what the predictive idea wanted:

- fast first-contact consumption,
- no dual dial-group login,
- no second dial mode,
- no splicing into the visible normal queue,
- app still owns assignment and SLA.

Risks to test:

- Whether RingCX honors agent reservation/filter fields for leads in this campaign.
- Whether `dialPriority: immediate` on one just-in-time row interrupts normal progressive order safely.
- Whether current-call matching still lands on the exact published row.
- Whether campaign-level priority or list priority is needed instead of row-level immediate.
- Whether per-agent campaigns are manageable if shared reservation is unreliable.

Recommended first test:

```txt
same dial group
one test First Contact campaign
one test agent
publish one lead only while agent is available/off-hook
verify:
  RingCX dials it immediately or next
  active-call poller identifies it
  no normal queue rows disappear/reorder
  disposition writes correctly
```

###### First-Contact Campaign vs Faux Appointment Lane

There are two viable ways to enforce urgent first-contact work without mutating the normal preloaded queue.

The shared abstraction should be:

```txt
queue obligation
  -> has due time
  -> has assignment/lease
  -> can become shared urgent
  -> can be claimed by a stable available agent
  -> can be satisfied by call proof or explicitly completed
```

Types:

```txt
firstContact
  system-created
  goal: first CX touch within SLA
  satisfied by confirmed first dial proof

appointment
  human/business-created
  goal: scheduled follow-up
  may require Logics task/activity writes
  may require agent workbench/appointment form behavior
```

Do not make first-contact rows literal appointments. Do make both use the same obligation engine.

Comparison:

| Option | Strength | Weakness | Best Use |
| --- | --- | --- | --- |
| App-owned faux appointment lane | Simple, app owns ordering, no RingCX admin sprawl, easy to test in Mongo | Still needs a reliable transport when due; can accidentally become queue splicing if implemented poorly | Shared deadline/claim/release engine |
| Just-in-time First Contact campaign | Does not touch normal preloaded pile, gives RingCX a single urgent row, good fit for 5-minute SLA | Must prove campaign priority/agent reservation/current-call matching; more RingCX setup | Actual dialing transport for first-contact obligations |
| Per-agent first-contact campaigns | Strong isolation and explicit ownership | Admin/config overhead, more campaigns to maintain, more places for config drift | Fallback if shared campaign agent reservation is unreliable |
| Moving appointments into the obligation engine | Unifies due work, claims, releases, stale handling, and UI queue-of-work | Appointment-specific Logics side effects must stay separate | Recommended as a side-effect of the cleanup |

Recommended architecture:

```txt
queueObligationService
  -> owns assignment, due timers, urgent promotion, release, claim

firstContactTransport
  -> publishes one selected first-contact row to RingCX just in time

appointmentTransport
  -> uses appointment-specific dial/wrap/workbench behavior
  -> writes Logics task/activity when appropriate

normalQueueTransport
  -> continues preloaded bulk/progressive work
```

Selection order:

```txt
agent asks for next work
  -> due/urgent firstContact obligation?
      yes: claim and send one row through firstContactTransport
  -> due appointment obligation?
      yes: claim and send through appointmentTransport
  -> otherwise:
      serve normal preloaded queue
```

This keeps the normal pile untouched:

```txt
normal queue
  stays preloaded
  drains naturally
  refills normally

obligation lane
  feeds one selected row at a time
  can outrank normal queue
  never splices into the visible normal list
```

If appointments move into this system:

- appointment due items become `queueObligationType: "appointment"`,
- appointment call serving uses the same claim/release semantics,
- appointment-specific effects stay in appointment code:
  - Logics task,
  - Logics activity,
  - appointment outcome,
  - workbench / form state,
  - case profile communication update.

If first-contact moves into this system:

- first-contact items become `queueObligationType: "firstContact"`,
- due time defaults to 5 minutes,
- warning/urgent promotion can happen before the deadline,
- satisfaction requires confirmed CX dial proof,
- no appointment metrics or Logics appointment task is created.

Clean implementation target:

```txt
one obligation engine
  two obligation types
  separate side-effect handlers
  separate RingCX transport adapters
  normal queue untouched
```

Decision:

- Build the faux appointment/obligation engine as the durable core.
- Test the just-in-time first-contact campaign as the transport for `firstContact`.
- Move appointments onto the same obligation engine only after first-contact claim/release semantics are proven.

###### Ownership And Due-Time Pipe

The durable abstraction is not "appointment" and not "fresh lead." It is:

```txt
owned timed work
```

Every obligation answers two questions:

```txt
1. Is this work owned?
2. Is this work due for consumption?
```

That creates one pipe:

```txt
incoming obligation
  -> if unowned, assign owner and due time
  -> if owned and not due, hold
  -> if owned and due, consume/dial when owner is stable available
  -> if owned but stale/unavailable, release by policy
```

For first-contact:

```txt
new zero-dial green
  -> unowned
  -> assign owner by round robin
  -> due time = now + 5 minutes
  -> consume when due or earlier if business chooses immediate-next behavior
  -> satisfied by confirmed first CX dial proof
```

For appointment:

```txt
scheduled follow-up
  -> already owned or assign to requested owner
  -> due time = appointment scheduled time
  -> consume only at/after due time
  -> side effects: Logics task/activity, appointment outcome, communication update
```

This directly addresses the current live appointment bug where appointments can dial around 20 minutes early. The obligation engine must not use fuzzy "near due" windows for consumption.

Strict timing rule:

```txt
warnAt can be early
dueAt is exact
consumeAt cannot be before dueAt
```

Allowed:

```txt
appointment at 10:00
9:40 warn UI / prepare row / show upcoming
10:00 eligible to dial
```

Not allowed:

```txt
appointment at 10:00
9:40 consumed/dialed because it is "near due"
```

For first-contact, the 5-minute due time has different semantics:

```txt
assigned at 10:00
due at 10:05
can dial before 10:05 only if the business rule is "as soon as owner is available"
must dial by 10:05 if capacity exists
```

So the pipe needs a per-type timing policy:

```js
{
  type: "appointment",
  canConsumeBeforeDueAt: false,
  warnBeforeMs: 20 * 60 * 1000
}

{
  type: "firstContact",
  canConsumeBeforeDueAt: true,
  dueAfterMs: 5 * 60 * 1000
}
```

The important clean-code rule:

- assignment policy decides owner,
- timing policy decides when consumption is legal,
- transport policy decides how to dial,
- side-effect policy decides what to write after completion.

Do not let transport decide timing. That is how early appointment dials happen.

###### Appointment Code Reference Blocks

The current appointment system should be used as a reference, but not copied whole into first-contact. Pull the timing/ownership ideas, not the appointment-specific side effects.

Primary files:

```txt
packages/shared-models/src/CxAppointment.js
packages/shared-repositories/src/cxAppointmentRepository.js
packages/shared-services/src/cxAppointmentService.js
apps/control-plane/src/routes/commandsCx.js
apps/web-client/src/workspaces/cx/AppointmentList.tsx
packages/shared-services/src/cxBulkLoadRuntime.js
apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx
```

Reference blocks:

| File | Lines | What To Reuse |
| --- | ---: | --- |
| `packages/shared-models/src/CxAppointment.js` | 25-48, 69-71 | Status + `appointmentAt` / `legalDialAt` indexed due-work shape. |
| `packages/shared-repositories/src/cxAppointmentRepository.js` | 122-129 | Correct due filter: `status in scheduled/blocked` and `legalDialAt <= now`. |
| `packages/shared-repositories/src/cxAppointmentRepository.js` | 148-207 | Agent-state mirror/remove pattern for owned timed work visibility. |
| `packages/shared-services/src/cxAppointmentService.js` | 204-234 | Legal dial timing helper pattern. Keep this separate from transport. |
| `packages/shared-services/src/cxAppointmentService.js` | 253-369 | `ensureAppointmentQueueItem(...)`: owned queue row, future hold, paused/non-reservable guard. |
| `packages/shared-services/src/cxAppointmentService.js` | 385-531 | `createCxAppointment(...)`: create appointment record, queue hold, mirror, workflow stage. |
| `packages/shared-services/src/cxAppointmentService.js` | 728-875 | Auto-fire path. Use as a warning reference, not default for obligation consumption. |
| `packages/shared-services/src/cxAppointmentService.js` | 877-1011 | Manual-only due path. Best reference for marking due without immediately dialing. |
| `packages/shared-services/src/cxAppointmentService.js` | 1013-1047 | Due worker shape. Useful for a future `runDueQueueObligations(...)`. |
| `packages/shared-services/src/cxAppointmentService.js` | 1049-1095 | `fireCxAppointmentNow(...)`: manual fire command with owner/domain validation. |
| `packages/shared-services/src/cxAppointmentService.js` | 1097-1160 | Completion/cancel resolution after disposition. |
| `apps/control-plane/src/routes/commandsCx.js` | 393-411 | Create appointment route plus safe workbench catch. |
| `apps/control-plane/src/routes/commandsCx.js` | 429-486 | Call-now route: fire appointment, then `requestCxDial` with `IMMEDIATE`. |
| `apps/web-client/src/workspaces/cx/AppointmentList.tsx` | 19-104 | Small owned-work list UI with call/release actions. |
| `packages/shared-services/src/cxBulkLoadRuntime.js` | 1213-1424 | Bulk appointment wrap partial-result pattern. Reuse the `safeStep` style. |

What to reuse for `queueObligationService`:

```txt
status lifecycle
  scheduled -> due -> claimed/fired -> completed/cancelled/released/blocked

due query
  dueAt <= now

owner mirror
  agent state gets a compact copy of owned timed work

queue hold
  rows can be non-reservable until timing policy says they are consumable

safe partial results
  every side effect returns a structured block
```

What not to copy:

```txt
appointment-specific Logics task/activity writes
appointment metrics
appointment "call now" semantics
blanket IMMEDIATE priority
auto-fire as default behavior
```

The live early-dial bug should be investigated against these points:

1. Was `legalDialAt` written earlier than the user-selected `appointmentAt` because `resolveLegalDialTiming(...)` adjusted it?
2. Did `fireCxAppointmentNow(...)` bypass due semantics from a manual/UI action?
3. Did `runDueCxAppointments(...)` run with `autoFireEnabled=true` and a bad `legalDialAt`?
4. Did UI display `appointmentAt` but backend consume by `legalDialAt`, making it look 20 minutes early?
5. Did a queue row become `ready` before the appointment due time through a state transition outside `cxAppointmentService`?

For the obligation engine:

- appointment consumption must use `dueAt = appointmentAt` unless a legal window moves it later,
- legal timing may move consumption later, never earlier than the requested appointment time,
- `warnAt` may be before due time,
- `consumeAt` must not be before due time for appointments,
- first-contact can opt into `canConsumeBeforeDueAt=true`.

Clean target:

```txt
cxAppointmentService
  remains appointment-specific

queueObligationService
  owns generic owner/due/release/claim rules

appointment adapter
  converts appointments into obligations
  keeps Logics side effects outside the generic engine

first-contact adapter
  converts fresh greens into obligations
  satisfies only on confirmed dial proof
```

###### What Can Be Recycled For Immediate Contact Leads

Immediate-contact leads can recycle the appointment mechanics, but they should not be rebranded as appointments.

Approximate reuse:

```txt
Reusable mechanics: 60-70%
Reusable appointment semantics: near 0%
```

Recycle:

- owned work record shape,
- due-time index/query shape,
- agent mirror pattern,
- paused/non-reservable queue hold pattern,
- due worker loop,
- owner validation,
- release/completion lifecycle,
- safe partial-result pattern.

Do not recycle:

- appointment status labels in the client,
- appointment counts/metrics,
- Logics appointment task creation,
- appointment activity subject/body,
- appointment "call now" button semantics,
- early auto-fire behavior,
- appointment side panel location as the first-contact UI.

Recommended naming:

```txt
Appointment remains appointment.
Immediate contact becomes First Contact.
Generic engine is Queue Obligation.
```

Data mapping:

```txt
CxAppointment.appointmentId      -> QueueObligation.obligationId
CxAppointment.agentExtensionId   -> QueueObligation.ownerExtensionId
CxAppointment.legalDialAt        -> QueueObligation.dueAt
CxAppointment.status             -> QueueObligation.status
CxAppointment.cxQueueRecordId    -> QueueObligation.queueItemId
CxAppointment.history            -> QueueObligation.history
```

For first contact:

```js
{
  obligationType: "firstContact",
  status: "assigned" | "due" | "claimed" | "satisfied" | "released" | "blocked",
  ownerExtensionId,
  assignedAt,
  dueAt,
  warnAt,
  queueItemId,
  caseId,
  phone,
  prospectName,
  satisfaction: {
    type: "cx-first-dial-proof",
    uii,
    dialedAt
  }
}
```

The first-contact obligation should be satisfied only by confirmed dial proof. It should not be satisfied by assignment, display, publish, or RingCX accepted response.

###### Client Surface For First Contact

Appointments stay where they are on the client.

First-contact work needs a separate visible signal only when the agent is actively dealing with a first-contact lead.

Do not put first-contact rows into the left `CX queue` list.

Current client anchors:

- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:1032` - `BulkBufferList(...)`, the visible left queue.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6341` - left queue column starts.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:6438` - center client-management section starts.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4407` - bulk current/last-outcome latch.
- `apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx:4489` - current bulk display candidate fills the center form.
- `apps/web-client/src/workspaces/cx/AppointmentList.tsx:19` - appointment list stays appointment-only.

Implementation target:

```txt
left queue:
  render normal preloaded buffer only

center current lead:
  if current.queueObligationType === "firstContact"
    show First Contact badge/card
    show "0 previous CX dials" / "first touch"
    show assigned/due timing
  otherwise
    render normal current lead

right/appointments:
  unchanged appointment list
```

Backend payload requirement:

`CxBulkLoadCurrent` / current-call projection should include enough lane metadata for the client:

```js
{
  queueLane: "normal" | "firstContact" | "appointment",
  queueObligationType: "firstContact" | "appointment" | null,
  queueObligationId,
  firstContact: {
    zeroDial: true,
    assignedAt,
    dueAt,
    source: "fresh-green",
    previousCxDials: 0
  }
}
```

UI behavior:

- Add a compact badge in the center card header: `First Contact`.
- Add a small line: `0 previous CX dials`.
- Do not show it in `AppointmentList`.
- Do not remove/reorder `BulkBufferList`.
- Do not create a new modal unless the agent has an action to take.

This gives the agent context:

```txt
"This is a brand-new green. You are the first touch."
```

without pretending it is an appointment and without mutating the normal queue.

Optional alert-style modal:

```txt
first-contact obligation assigned/claimed for this agent
  -> show non-blocking alert modal/toast:
     "New first-contact lead dialing now"
     Name
     Case number
     SLA / assigned time

RingCX active call confirmed with UII
  -> dismiss/update alert
  -> populate middle current-call card from confirmed active call
```

Important:

- The modal is only a notification.
- It must not populate the middle form before active-call proof.
- It must not remove the normal left queue item list.
- It must not become the source of truth for current call.
- If publish/claim fails, the modal should flip to a small failure/retry notice and the obligation should release by backend policy.

Client state:

```js
firstContactAlert: {
  obligationId,
  queueItemId,
  name,
  caseId,
  status: "assigned" | "publishing" | "dialing" | "connected" | "failed",
  assignedAt,
  dueAt
}
```

Good UX sequence:

```txt
1. Agent is available.
2. Backend claims first-contact obligation for agent.
3. Client receives/refetches alert: "New lead dialing now - Jane Doe / WYNN 12345."
4. RingCX dials.
5. Active-call poller confirms UII.
6. Alert dismisses or collapses into a badge.
7. Middle section populates from confirmed current call.
```

This gives the agent awareness before the middle form changes, while preserving the hard rule that the middle section only changes on confirmed active call.

##### Slacker / No-Show Agent Handling

Chunking creates one more risk: if an agent does not show up or works slowly, their assigned morning coverage chunk can sit stale.

Add an explicit release rule:

```txt
if assigned coverage rows are not claimed/dialed by the agent by releaseAt:
  return them to shared coverage pool
  let active agents claim them on next refill
```

Recommended defaults:

- 7:45am: create coverage batch and distribute evenly.
- 8:00am: dialing day begins; agents claim from their assigned chunk first.
- 8:45am: run a progress check.
- After 8:45am: release only chunks that have not shrunk at all.
- Refills after release: active agents can pull shared coverage rows before normal mix.

Do not silently leave no-show chunks stranded.

Progress rule:

```txt
if assignedChunkInitialCount > 0
and assignedChunkCurrentCount === assignedChunkInitialCount
and no confirmed dial proof exists for that chunk:
  release that chunk to shared coverage pool
else:
  let the agent keep working their chunk
```

If an agent has made some progress, even slow progress, keep their assigned coverage rows with them. The release is for no-progress/no-show behavior, not for punishing a slower call flow.

If a logged-in agent loses an untouched coverage chunk at 8:45, they should not be left empty. Their refill should fall through to the normal queue plan after the reclaimed coverage chunk is released.

```txt
agent chunk reclaimed
  -> release untouched assigned coverage rows to shared pool
  -> refill that agent from normal mix if they are active/logged in
  -> active faster agents can claim released shared coverage rows
```

This gives the floor coverage protection without leaving any logged-in worker with a blank queue.

Implementation surfaces:

- Store `metadata.greenCoverageBatchId`.
- Store `metadata.greenCoverageAssignedAt`.
- Store `metadata.greenCoverageReleaseAt`.
- Store `metadata.greenCoverageScope: "assigned" | "shared"`.
- Store `metadata.greenCoverageInitialChunkSize`.
- Reservation first checks assigned rows, then shared released rows, then normal mix.

This keeps first-touch coverage strong without letting one slow/no-show agent hold the whole floor hostage.

#### Why This Is Not A Bandaid

This bridge keeps the existing model and removes ambiguity:

- one source of truth for candidate leads: `LeadCadence`,
- one source of truth for dialable supply: `CxDialQueue`,
- one source of truth for claiming: queue reservation,
- one source of truth for actual touch: call proof/drain,
- one small planner deciding "green coverage first or normal mix."

No client tricks. No agent-specific emergency queue shoves. No broad flags that can be left on accidentally. No separate queue universe for bulk.

Important wording:

- Morning does not "touch" a lead by writing it to the queue.
- A lead becomes touched only when the call lifecycle produces confirmed dial proof, such as UII/call event/placed-call evidence.
- Morning can create queue rows and make first-touch greens exclusively reservable.

### Step 1: Add The Read-Only Debt Resolver

Start with read-only logic so the first patch can prove the shape without changing live ordering.

Primary files:

- `packages/shared-repositories/src/leadCadenceRepository.js`
- `packages/shared-repositories/src/cxDialQueueRepository.js`
- `packages/shared-services/src/cxMorningQueueBuilderService.js`

Create a helper that answers:

```js
{
  active: true,
  eligible: 42,
  alreadyQueued: 31,
  missingQueueRows: 11,
  debt: 42,
  reason: "green-first-touch-debt"
}
```

The resolver should count eligible green leads that:

- are active cadence records,
- are CX-callable,
- are not CX DNC-blocked,
- match allowed route/campaign filters,
- have no confirmed CX dial proof,
- are not already terminally disqualified.

Then split them into:

- already represented by active `CxDialQueue` rows,
- missing queue rows that need canonical queue creation.

This read-only step should log counts from the morning builder before any queue write.

### Step 2: Backfill Missing First-Touch Queue Rows Through Existing Creation

Primary files:

- `packages/shared-services/src/cxMorningQueueBuilderService.js`
- `packages/shared-services/src/cxCadenceService.js`
- `packages/shared-services/src/outboundDispatchService.js`

Once the resolver can identify missing first-touch queue rows, the morning builder should backfill them through `queueCxDialRequest(...)`.

Do this before normal `buildLocalQueue(...)`.

Recommended order inside `runForAgent(...)`:

```js
const sweepState = await resolveGreenFirstTouchSweepState(...);
const backfillResult = await backfillMissingGreenFirstTouchQueueRows(sweepState);
const localQueueResult = await buildLocalQueue(agent, {
  ...options,
  greenFirstTouchSweep: sweepState.active
});
const mirrorResult = await mirrorQueueRows(...);
```

Rules:

- Do not directly insert `CxDialQueue` rows from the builder.
- Do not mark cadence actions completed.
- Do not mark `lastTouched.cx`.
- Do not publish non-green rows if first-touch debt remains active.

### Step 3: Teach Reservation To Enforce First-Touch Green Only

Primary files:

- `packages/shared-repositories/src/cxDialQueueRepository.js`
- `packages/shared-services/src/cxQueueReservationService.js`
- `packages/shared-services/src/cxCadenceService.js`

The durable behavior belongs in reservation, not just morning write order.

Reason:

- Morning can miss late-arriving rows.
- Refills happen throughout the day.
- Bulk, slow, and legacy rails should not each reinvent this.

Add a `firstTouchOnly` option that flows:

```txt
bulk/workspace/cadence caller
  -> cxQueueReservationService.reserveFromFamilyOrder(...)
  -> cxDialQueueRepository.reserveReadyRows(...)
  -> buildReadyClaimQuery(...)
```

The repository query should require:

- `queueFamily: "fresh-day1"` through existing family filters,
- `placedCalls <= 0` or missing,
- `dailyPlacedCalls <= 0` or missing,
- `progressiveStageIndex <= 0` or missing,
- normal state/release/route/domain filters.

This is the hard guard that prevents normal rows from being served before green first-touch debt is cleared.

### Step 4: Make Bulk The First Runtime Consumer

Primary files:

- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
- `packages/shared-services/src/cxQueueReservationService.js`

Bulk is the cleanest first consumer because it already owns refill cadence and buffer size.

In `fillBuffer(...)`:

1. Resolve sweep state.
2. Compute family targets.
3. Reserve rows.
4. Publish rows one at a time.

The only bulk-specific decision should be target shaping:

```js
if (sweepState.active) {
  familyTargets = { "fresh-day1": deficit };
  firstTouchOnly = true;
} else {
  familyTargets = normalConfiguredFamilyTargets;
  firstTouchOnly = false;
}
```

Do not let bulk decide what makes a row eligible. The repository owns eligibility. Bulk only decides how much capacity to fill.

### Step 5: Align Workspace/Legacy Refill Without Rewriting UI

Primary file:

- `packages/shared-services/src/cxWorkspaceService.js`

`maybeRefillCxQueueForAgent(...)` already has the priority stack:

1. fresh,
2. day2to15,
3. day16to30,
4. aged.

Insert sweep state before this stack.

If sweep is active:

- fresh target fills all open queue capacity,
- nonfresh deficits are zero,
- `refillFreshHotLaneForAgent(...)` runs in first-touch sweep mode.

If sweep is inactive:

- existing stack continues.

This keeps the same UI and queue display. The UI should not know whether the current green row was selected because of a morning sweep or normal priority.

### Step 6: Replace The Rolling Fresh Window In Sweep Mode

Primary file:

- `packages/shared-services/src/cxFreshHotLaneService.js`

The current `computeFreshHotLaneWindow(...)` behavior is useful for an intraday hot lane, but it is the wrong limiter for weekend/after-hours first-touch debt.

Add an explicit mode:

```js
mode: "green-first-touch-sweep"
```

In this mode:

- do not require `createdAtGte` / `createdAtLte`,
- require first-touch filters,
- preserve route/campaign/domain/release filters,
- preserve excluded extension rules.

This is what makes Saturday/Sunday/Monday morning behave the same way as weekday overnight.

### Step 7: Keep Touch Accounting Downstream

Primary files:

- `packages/shared-services/src/ringcxDialExecutionService.js`
- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
- `packages/shared-services/src/cxTerminalOutboxDrain.js` if active
- call-event/cadence event writers used by the drain

The morning sweep should not decide that a lead was called.

The only code allowed to clear first-touch debt should be downstream of call proof:

- confirmed UII,
- RingCX call log/call event,
- placed-call event with enough identity proof,
- terminal outbox drain reconciliation.

That downstream write should update the same counters the current cadence system uses:

- `CxDialQueue.placedCalls`
- `CxDialQueue.dailyPlacedCalls`
- `CxDialQueue.lastPlacedAt`
- `LeadCadence.lastTouched.cx.lastCxDialedAt`
- `LeadCadence.lastTouched.cx.cxDailyCalls`
- `LeadCadence.lastTouched.cx.cxTotalCalls`

### Step 8: Prove With Logs Before Tests

Every morning/refill run should be able to answer:

- how many green first-touch leads exist,
- how many already have queue rows,
- how many were backfilled,
- how many were reserved,
- how many were published,
- why any eligible-looking lead was excluded.

Required log event:

```js
{
  event: "cx.green_first_touch_sweep",
  domain,
  agentExtensionId,
  active,
  eligible,
  debt,
  alreadyQueued,
  missingQueueRows,
  backfilled,
  reserved,
  published,
  unlockedNormalMix,
  reason
}
```

### Step 9: Turn The Rule On Narrowly

Recommended rollout:

1. Read-only resolver logging.
2. Morning backfill only.
3. Bulk reservation gate only.
4. Workspace/legacy reservation gate if those rails remain active.
5. Remove duplicate fresh/pacing writers or make them call the same helper.

The rule is considered implemented when normal family rows cannot be reserved while green first-touch debt exists.

## Current Creation And Serving Flow

### Morning Builder

File: `packages/shared-services/src/cxMorningQueueBuilderService.js`

Relevant sections:

- Lines 3-13: service intent is already the right home for the permanent morning queue builder.
- Lines 334-340: `buildLocalQueue(agent, options)` calls `buildCxQueueForAgent(...)`.
- Lines 342-399: `mirrorQueueRows(...)` publishes queue rows to RingCX one at a time.
- Lines 401-435: `runForAgent(...)` drains, builds local rows, then mirrors.
- Lines 477-511: `runCxMorningQueueBuilder(...)` runs the builder across agents.
- Lines 513-545: env options and enabled flag.

Implementation change:

- Add a preflight step before `buildLocalQueue(...)` that resolves green first-touch debt for the agent domain/routes.
- Backfill missing `CxDialQueue` rows through the canonical queue creation path only.
- Add sweep telemetry to the result object:
  - `greenFirstTouchEligible`
  - `greenFirstTouchDebt`
  - `greenFirstTouchBackfilled`
  - `greenFirstTouchAlreadyQueued`
  - `greenFirstTouchUnlocked`
- Do not write directly into Mongo from this service except through existing queue helpers.

### RingCX Scheduler

File: `apps/ringcentral-cx/src/server.js`

Relevant sections:

- Lines 768-795: fresh hot lane morning scheduler.
- Lines 813-916: morning queue builder scheduler.
- Lines 1011-1068: morning pacing prep scheduler.

Implementation change:

- Pick one owner for the morning first-touch sweep.
- Recommended owner: `cxMorningQueueBuilderService`.
- Keep the fresh hot lane / pacing workers from independently reshuffling the same leads unless they are explicitly still part of the active 2.0 path.
- Expand the morning builder status log with sweep counts so live can answer "did weekend/today greens get queued?"

## Core Reservation Surfaces

### Dial Queue Repository

File: `packages/shared-repositories/src/cxDialQueueRepository.js`

Relevant sections:

- Lines 6-14: `TOUCH_BALANCED_QUEUE_SORT`.
- Lines 58-95: `buildReadyClaimQuery(...)`.
- Lines 97-112: `applyCreatedAtRange(...)`.
- Lines 326-410: `reserveReadyRows(...)`.
- Lines 617-685: `listQueueItems(...)`.

Implementation change:

- Add a first-touch claim filter to `buildReadyClaimQuery(...)`.
- Proposed option name: `firstTouchOnly`.
- Proposed filter:

```js
if (filters.firstTouchOnly) {
  andClauses.push({
    $or: [
      { placedCalls: { $exists: false } },
      { placedCalls: { $lte: 0 } }
    ]
  });
  andClauses.push({
    $or: [
      { dailyPlacedCalls: { $exists: false } },
      { dailyPlacedCalls: { $lte: 0 } }
    ]
  });
  andClauses.push({
    $or: [
      { progressiveStageIndex: { $exists: false } },
      { progressiveStageIndex: { $lte: 0 } }
    ]
  });
}
```

- Pass `firstTouchOnly` through `reserveReadyRows(...)`.
- Preserve route/campaign/domain/agent exclusion filters.
- Do not rely only on `createdAtGte`/`createdAtLte`; that is the source of weekend/after-hours misses.

### Dial Queue Model

File: `packages/shared-models/src/CxDialQueue.js`

Relevant sections:

- Lines 5-67: fields already include `queueFamily`, `placedCalls`, `lastPlacedAt`, `dailyPlacedCalls`, `progressiveStageIndex`, and `metadata`.
- Lines 81-113: queue sort indexes.

Implementation change:

- Prefer existing fields over new schema fields.
- Add an index only if query testing shows the first-touch filter needs it.
- Recommended index if needed:

```js
CxDialQueueSchema.index({
  domain: 1,
  state: 1,
  queueFamily: 1,
  placedCalls: 1,
  dailyPlacedCalls: 1,
  progressiveStageIndex: 1,
  releaseAt: 1,
  priorityScore: -1,
  createdAt: 1
});
```

### Queue Reservation Service

File: `packages/shared-services/src/cxQueueReservationService.js`

Relevant sections:

- Lines 32-75: `reserveFromFamilyOrder(...)`.

Implementation change:

- Add a pass-through option:

```js
firstTouchOnly: Boolean(options.firstTouchOnly)
```

- Pass it into `cxDialQueueRepository.reserveReadyRows(...)`.
- Keep this service narrow. It should not decide whether sweep mode is active; it should only reserve according to the requested filter.

## Fresh Green Allocation

### Fresh Hot Lane Service

File: `packages/shared-services/src/cxFreshHotLaneService.js`

Relevant sections:

- Lines 80-107: `computeFreshHotLaneWindow(...)`.
- Lines 126-175: `rebuildFreshHotLane(...)`.
- Lines 287-402: `runFreshHotLaneAllocatorUnsafe(...)`.
- Lines 350-370: `assignCxQueueBatch(...)` uses `createdAtGte`/`createdAtLte`.

Current issue:

- The allocator is bounded by a rolling created-at window.
- Weekend and after-hours leads can be excluded even if they are still green and untouched.

Implementation change:

- Add an explicit sweep mode:

```js
mode: "green-first-touch-sweep"
```

- In sweep mode:
  - Do not require the rolling created-at window.
  - Use `queueFamily: "fresh-day1"`.
  - Use `firstTouchOnly: true`.
  - Keep release and route filters.
  - Keep the "do not reassign to currently excluded extensions" behavior.

- Leave the existing rolling hot-lane behavior available for non-sweep operation.

## Workspace Queue Build And Refill

### Workspace Service

File: `packages/shared-services/src/cxWorkspaceService.js`

Relevant sections:

- Lines 2542-2560: `sortQueueItemsForWorkspacePack(...)`.
- Lines 2959-3062: `materializeDay2To15QueueItems(...)`.
- Lines 3371-3431: `materializeQueueSupplyForAgent(...)`.
- Lines 3433-3565: `refillQueueFamilyForAgent(...)`.
- Lines 3567-3672: `refillFreshHotLaneForAgent(...)`.
- Lines 3674-3902: `maybeRefillCxQueueForAgent(...)`.
- Lines 4702-4770: `buildCxQueueForAgent(...)`.

Implementation change:

- Add a small helper near the refill helpers:

```js
async function resolveGreenFirstTouchSweepState({ domain, routeCampaigns, now }) {
  // Returns { active, debt, eligible, reason }
}
```

- Inside `maybeRefillCxQueueForAgent(...)`, resolve sweep state before family deficits are calculated.
- If `sweepState.active === true`:
  - Fresh target becomes the full open capacity.
  - Day2/day16/aged targets become zero.
  - `refillFreshHotLaneForAgent(...)` is called in `green-first-touch-sweep` mode.
- If `sweepState.active === false`, keep the existing priority stack.
- `sortQueueItemsForWorkspacePack(...)` should keep first-touch green rows above nonfresh rows while sweep debt exists.

Non-goal:

- Do not make the UI choose the lead family.
- Do not change button behavior to force this rule.

## Cadence And Queue Creation

### Cadence Service

File: `packages/shared-services/src/cxCadenceService.js`

Relevant sections:

- Lines 1935-1960: contact eligibility and canonical queue request creation.
- Lines 1962-2045: existing active row dedupe/update path.
- Lines 2131-2169: `CxDialQueue` row creation.
- Lines 3612-3667: `assignCxQueueBatch(...)`.

Implementation change:

- Keep `queueCxDialRequest(...)` as the canonical creation path for missing first-touch queue rows.
- Do not mark the lead touched here.
- Add optional payload metadata for traceability:

```js
metadata: {
  ...metadata,
  greenFirstTouchSweep: true,
  sweepReason: "morning-first-touch"
}
```

- Add `firstTouchOnly` pass-through to `assignCxQueueBatch(...)`.
- Ensure `claimNextCxQueueItem(...)` consumes the first-touch filter via repository query.

### Lead Cadence Model

File: `packages/shared-models/src/LeadCadence.js`

Relevant sections:

- Lines 113-127: `lastTouched.cx` fields.
- Lines 128-129: first contact request fields.
- Lines 130-146: cadence state.
- Lines 147-170: DNC state.
- Lines 226-240: existing indexes.

Implementation change:

- Prefer existing fields:
  - `lastTouched.cx.lastCxDialedAt`
  - `lastTouched.cx.cxDailyCalls`
  - `lastTouched.cx.cxTotalCalls`
  - `firstContactRequestedAt`
- Only add a new index if the backfill reader scans too much:

```js
LeadCadenceSchema.index({
  domain: 1,
  active: 1,
  createdAt: 1,
  "lastTouched.cx.lastCxDialedAt": 1
});
```

### Lead Cadence Repository

File: `packages/shared-repositories/src/leadCadenceRepository.js`

Relevant sections:

- Lines 347-369: `listDueLeadCadenceByChannel(...)`.
- Lines 807-854: `buildCadenceStateFromActions(...)`.
- Lines 856-904: `syncLeadCadenceState(...)`.

Implementation change:

- Add a narrow reader for missing green first-touch queue rows.
- Proposed name:

```js
listGreenFirstTouchCadenceDebt(domain, { asOf, routeCampaigns, limit })
```

- This reader should find active green leads that:
  - are CX eligible,
  - are not DNC-blocked for CX,
  - have a callable phone,
  - have no confirmed CX dial timestamp/count,
  - either have no active `CxDialQueue` row or need a row created.

- Use this only for backfill/preflight. Reservation should still operate on `CxDialQueue`.

## Outbound And Universal Queue Guardrails

### Outbound Dispatch Service

File: `packages/shared-services/src/outboundDispatchService.js`

Relevant sections:

- Lines 500-555: `createCadenceSweepEvents(...)`.
- Lines 557-573: `listTargetsForRound(...)`.
- Lines 1216-1250: CX branch creates `cx.dial.requested`.
- Lines 1262-1302: CX action marked requested, not completed.

Implementation change:

- Treat outbound dispatch as a source of request intent only.
- The morning sweep should verify that requested CX actions became queue rows.
- Backfill through `queueCxDialRequest(...)` if a requested green first-touch lead does not have an active queue row.

### Hourly Pacing Orchestrator

File: `packages/shared-services/src/hourlyPacingOrchestrator.js`

Relevant sections:

- Lines 20-33: hourly flow comments.
- Lines 136-160: `runMorningPrep(...)`.

Implementation change:

- If hourly pacing is still enabled for the same queues, it must use the same first-touch helper.
- If CX 2.0 bulk owns serving, keep pacing from mutating the same queue source.

### Universal Queue Service

File: `packages/shared-services/src/universalQueueService.js`

Relevant sections:

- Lines 15-27: pool refill intent.
- Lines 170-194: `readDueLeads(...)`.
- Lines 229-299: `refillPool(...)`.

Implementation change:

- If UCQ is active, it needs the same first-touch priority.
- If UCQ is not active for 2.0 bulk, document that clearly and avoid duplicating implementation here.

## Bulk Runtime Landing Place

### Bulk Load Runtime

File: `packages/shared-services/src/cxBulkLoadRuntimeService.js`

Relevant sections:

- Lines 17-22: default buffer and refill threshold.
- Lines 120-135: `familyRefillTargets(...)`.
- Lines 376-500: `fillBuffer(...)`.
- Lines 391-412: desired targets and reservation.
- Lines 505-527: `maybeRefill(...)`.
- Lines 1000-1030: watcher calls `maybeRefill(...)` in `beforePersist`.

Implementation change:

- Bulk should be the first rail to consume the new first-touch sweep.
- Add a sweep state input to `fillBuffer(...)`.
- Keep the logic atomic:
  - one helper decides the family target,
  - one helper reserves,
  - one helper publishes,
  - one helper records telemetry.

Recommended shape:

```js
function resolveBulkFamilyTargets({ deficit, configuredTargets, sweepState }) {
  if (sweepState?.active) {
    return { "fresh-day1": deficit };
  }
  return familyRefillTargets({ targetBuffer: deficit }, configuredTargets);
}
```

Then in `fillBuffer(...)`:

```js
const sweepState = await reservationService.resolveGreenFirstTouchSweepState?.(state);
const desiredFamilyTargets = resolveBulkFamilyTargets({
  deficit,
  configuredTargets: state.stats?.familyTargets,
  sweepState
});

const reservation = await reservationService.reserveFromFamilyOrder({
  ...,
  familyTargets: desiredFamilyTargets,
  firstTouchOnly: Boolean(sweepState?.active)
});
```

Important:

- Do not let bulk know how first-touch debt is queried.
- Do not let bulk rewrite queue rows to force priority.
- Bulk should simply ask for green-only while debt exists.

### Bulk Runtime Tests

File: `tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js`

Relevant existing tests:

- Per-family residual refill test around the `refill computes per-family residuals` case.
- Threshold refill test around `bulk refill at the threshold tops the buffer back to 35 in residual family order`.

Add tests:

1. `fillBuffer reserves only fresh-day1 when green first-touch debt is active`.
2. `fillBuffer returns to configured family targets after debt clears`.
3. `maybeRefill at threshold requests green-only refill during sweep`.
4. `sweep mode does not count a row as touched until active-call proof is recorded`.

## Proposed Helper Functions

These should be small and single-purpose.

### `resolveGreenFirstTouchSweepState(...)`

Owner: shared service, likely near queue/refill helpers.

Inputs:

- `domain`
- `routeCampaigns`
- `asOf`
- optional `agentExtensionId`

Returns:

```js
{
  active: true,
  debt: 23,
  eligible: 23,
  alreadyQueued: 18,
  missingQueueRows: 5,
  reason: "green-first-touch-debt"
}
```

Rules:

- `active` is true if eligible green first-touch debt is greater than zero.
- Use confirmed CX proof only.
- Do not infer touch from queue assignment or RingCX publish.

### `listGreenFirstTouchCadenceDebt(...)`

Owner: `leadCadenceRepository`.

Purpose:

- Find eligible green leads that do not yet have confirmed CX dial proof.
- Used for morning/preflight backfill only.

### `buildGreenFirstTouchClaimFilter(...)`

Owner: `cxDialQueueRepository`.

Purpose:

- Add first-touch conditions to ready-row reservation.
- Used by every rail through reservation pass-through.

### `resolveBulkFamilyTargets(...)`

Owner: `cxBulkLoadRuntimeService`.

Purpose:

- Convert sweep state plus configured targets into one family target object.
- No database access.

### `recordGreenFirstTouchSweepTelemetry(...)`

Owner: morning builder or shared queue telemetry.

Purpose:

- Emit one compact log line per run/agent:

```js
{
  event: "cx.green_first_touch_sweep",
  domain,
  agentExtensionId,
  routeCampaigns,
  active,
  eligible,
  debt,
  missingQueueRows,
  alreadyQueued,
  backfilled,
  assigned,
  unlocked
}
```

## Implementation Order

### Phase 1: Read-Only Evidence

Files:

- `leadCadenceRepository.js`
- `cxDialQueueRepository.js`
- `cxMorningQueueBuilderService.js`

Tasks:

- Add read-only debt resolver.
- Log morning and refill debt counts.
- Do not change reservation yet.

Exit criteria:

- We can answer how many weekend/today green first-touch leads exist.
- We can answer how many are already active queue rows.

### Phase 2: Backfill Missing Queue Rows

Files:

- `cxMorningQueueBuilderService.js`
- `cxCadenceService.js`

Tasks:

- For missing first-touch green rows, call `queueCxDialRequest(...)`.
- Do not assign or publish yet unless the normal builder would do so.

Exit criteria:

- All eligible green first-touch leads have canonical queue rows.

### Phase 3: Bulk Reservation Gate

Files:

- `cxBulkLoadRuntimeService.js`
- `cxQueueReservationService.js`
- `cxDialQueueRepository.js`

Tasks:

- Bulk asks for green-only while debt exists.
- Repository enforces first-touch filter.
- Publishing remains one-at-a-time 200 accepted mode.

Exit criteria:

- Bulk refill at threshold pulls green first-touch rows until debt is gone.
- Once gone, normal family mix resumes.

### Phase 4: Morning Builder Enforcement

Files:

- `cxMorningQueueBuilderService.js`
- `apps/ringcentral-cx/src/server.js`
- `cxWorkspaceService.js`

Tasks:

- Morning builder runs the same sweep state.
- Workspace queue build honors green first-touch gate for legacy/slow surfaces if they remain active.
- Logs show sweep state on every morning run.

Exit criteria:

- Monday morning and normal weekday morning use the same rule.

### Phase 5: Optional UCQ/Pacing Alignment

Files:

- `hourlyPacingOrchestrator.js`
- `universalQueueService.js`
- `outboundDispatchService.js`

Tasks:

- Either wire them to the shared sweep helper or explicitly keep them away from CX 2.0 serving.

Exit criteria:

- There is one active source of truth for CX serving priority.

## Test Plan

### Unit Tests

Add tests for:

- `buildReadyClaimQuery(..., firstTouchOnly: true)` includes zero-call filters.
- `reserveFromFamilyOrder(..., firstTouchOnly: true)` passes the option to repository.
- `resolveBulkFamilyTargets(...)` returns green-only during sweep and normal targets when cleared.
- `fillBuffer(...)` requests only `fresh-day1` during debt.
- Morning builder logs debt/backfill counts.

### Integration Tests

Use local Mongo or a controlled fixture database.

Cases:

1. Saturday/Sunday green leads with zero dials are selected Monday morning.
2. Same-day green leads with zero dials are selected before blue/yellow/red.
3. A green lead that was queued but never dialed remains debt.
4. A green lead with confirmed UII/call event is no longer debt.
5. DNC-blocked green leads are excluded.
6. Agent-specific campaign filters prevent bleed between agents.

### Live Dry Run

Before write/apply mode:

- Run the resolver in read-only mode.
- Capture:
  - total green first-touch debt,
  - rows already queued,
  - rows missing queue rows,
  - rows blocked by DNC,
  - rows excluded by route/campaign mismatch.

After write/apply mode:

- Confirm debt decreases only after confirmed dial proof.
- Confirm queue display/refill is green-only while debt exists.
- Confirm normal mix resumes after debt clears.

## Acceptance Criteria

The change is ready when:

1. Every eligible weekend/today green with zero confirmed CX dials becomes queueable without manual intervention.
2. New greens are not shoved into an agent's active UI mid-call.
3. Bulk refill at threshold pulls first-touch greens until debt is gone.
4. Queue assignment does not bleed across route/campaign/agent.
5. A queued or published lead is not considered touched until UII/call proof exists.
6. Logs can explain why a lead was included or excluded.
7. Slow/legacy paths either share the same resolver or are explicitly outside the 2.0 test.

## Non-Goals

- Do not create a UI workaround for first-touch priority.
- Do not mark touch complete on queue creation, mirroring, or display.
- Do not bypass existing DNC and cadence eligibility rules.
- Do not create a second queue source for the same agents.
- Do not patch live agent rows directly unless running an emergency cleanup.

## One-Sentence Implementation Rule

The queue system should always ask: "Are there green leads with zero confirmed CX dials?" If yes, reserve only those; if no, use the normal family mix.

## First-Touch Campaign Provisioning Strategy

This is the operational bridge for creating the per-agent RingCX campaigns that receive first-contact leads without mutating the agent's normal preloaded working queue.

### Current Decision

Do not enable external-app dispositions yet.

The RingCX setting labeled "Disable Dispositions, Agent Notes and Lead Details" is promising for a later 2.5 simplification because it can remove native RingCX disposition friction when the app fully owns disposition and writeback. It is not part of the first-touch campaign creation pass. For now, mirror Brad's campaign behavior exactly and leave native disposition visibility as Brad has it.

Reference notes:

- RingCX campaign docs show campaigns are created under dial groups, and every campaign inside a dial group inherits that dial group's dial mode.
- RingCX campaign docs expose `surveyPopType` on campaign payloads.
- RingCX queue docs describe `surveyPopType: "SUPPRESS"` as hiding native dispositions/notes and `surveyPopType: "FLASH"` as the external app/integrated script path. Treat this as a future decongestion lever, not the alpha default.

### Source Of Truth

Use Brad's manually created `Brad First Touch` campaign as the source template.

Required source inputs:

- Brad first-touch dial group id, or exact Brad first-touch dial group name.
- Brad first-touch campaign id, or exact Brad first-touch campaign name.

Required target inputs:

- Bruce first-touch dial group id.
- Chris first-touch dial group id.
- Phil first-touch dial group id.
- Sean first-touch dial group id.

Do not infer target dial groups by loose name matching when applying live. The dry-run can resolve names, but `--apply` should use explicit ids.

### Provisioning Script

Script:

```powershell
node scripts/rcx-first-touch-campaigns.js `
  --source-dial-group-id <bradFirstTouchDialGroupId> `
  --source-campaign-id <bradFirstTouchCampaignId> `
  --target bruce:<bruceFirstTouchDialGroupId> `
  --target chris:<chrisFirstTouchDialGroupId> `
  --target phil:<philFirstTouchDialGroupId> `
  --target sean:<seanFirstTouchDialGroupId>
```

The script is dry-run by default. It prints:

- authenticated RingCX account,
- source campaign id/name,
- caller id,
- dialLoadedOrder,
- `surveyPopType`,
- disposition timeout,
- after-call state,
- per-target payload summary,
- whether it would create, update, or skip.

Apply only after the dry-run matches Brad:

```powershell
node scripts/rcx-first-touch-campaigns.js `
  --source-dial-group-id <bradFirstTouchDialGroupId> `
  --source-campaign-id <bradFirstTouchCampaignId> `
  --target bruce:<bruceFirstTouchDialGroupId> `
  --target chris:<chrisFirstTouchDialGroupId> `
  --target phil:<philFirstTouchDialGroupId> `
  --target sean:<seanFirstTouchDialGroupId> `
  --apply
```

Existing campaigns are skipped by default. To intentionally align an existing target campaign to Brad:

```powershell
node scripts/rcx-first-touch-campaigns.js ... --update-existing --apply
```

### Mirrored Fields

The script copies only campaign-owned fields that are relevant to first-touch behavior:

- active state, dates, caller id, ring time, transfer ring time,
- campaign priority, pass controls, daily pass controls,
- loaded-order behavior,
- voicemail/machine detect settings,
- after-call state and disposition timeout,
- recording/global phone book/settings that affect agent experience,
- `surveyPopType` exactly as Brad currently has it.

It does not copy read-only ids, nested dial group identity, campaign dispositions, lead lists, existing leads, call history, permissions arrays, or campaign result objects.

### Post-Create Verification

After `--apply`, verify every created campaign:

1. `campaignName` is `{Agent} First Touch`.
2. `callerId` matches Brad.
3. `dialLoadedOrder` matches Brad.
4. `surveyPopType` matches Brad and has not been independently forced.
5. `dispositionTimeout` and after-call state match Brad.
6. Campaign exists under the intended agent's first-touch dial group.
7. No leads are loaded as part of provisioning.

### Live Provisioning Result - 2026-06-29

Brad's source campaign was discovered read-only and used as the template:

- Brad dial group: `1067`
- Brad first-touch campaign: `2827`
- Brad source campaign name: `Brad First Touch`

Created first-touch campaigns:

| Agent | Dial Group | Campaign | Name |
| --- | ---: | ---: | --- |
| Bruce | `1012` | `2828` | `Bruce First Touch` |
| Chris | `1068` | `2829` | `Chris First Touch` |
| Phil | `1014` | `2830` | `Phil First Touch` |
| Sean | `1011` | `2831` | `Sean First Touch` |

Verified at create time:

- caller id matched Brad: `8183345087`
- `dialLoadedOrder` matched Brad: `0`
- `dispositionTimeout` matched Brad: `60`
- after-call base state matched Brad: `AVAILABLE`
- `surveyPopType` matched Brad: blank/native

No first-touch leads were loaded by this provisioning step.

### Campaign Disposition Follow-Up

RingCX dispositions for outbound dialing are campaign-level, not dial-group-level. The dial group owns dial mode and grouping; the campaign owns its outbound disposition list.

Read-back after provisioning:

| Campaign | Disposition count | Dispositions |
| --- | ---: | --- |
| Brad First Touch `2827` | `1` | `Default` |
| Bruce First Touch `2828` | `1` | `Default` |
| Chris First Touch `2829` | `1` | `Default` |
| Phil First Touch `2830` | `1` | `Default` |
| Sean First Touch `2831` | `1` | `Default` |

If first-touch campaigns need native RingCX `VM Drop`, `Auto Dispo`, DNC, or other agent-facing dispositions, provision those per campaign. Do not expect them to inherit from the dial group.

If the app owns the button/outcome workflow and RingCX native disposition UI stays secondary, the first-touch campaigns can stay with only `Default` until the 2.5 external-app-disposition pass.

### First-Touch Campaign Dispositions - Applied 2026-06-29

Script:

```powershell
node scripts/rcx-first-touch-dispositions.js --apply
```

Applied shape:

- `Default` exists but is disabled.
- `Auto Dispo` is enabled, default, `timeout: 1`, `rank: 10`.
- `VM DROP` is enabled, `timeout: 1`, `rank: 30`, `xfer: 2`.
- `VM DROP` keeps the same literal disposition name in each first-touch campaign so the app can continue sending `VM DROP`; the transfer number is campaign/agent-specific.

Verification:

| Agent | Campaign | Default | Auto Dispo | VM DROP destination |
| --- | ---: | --- | --- | --- |
| Brad | `2827` | disabled `32141` | `32146` | `2132797810` via `32147` |
| Bruce | `2828` | disabled `32142` | `32148` | `2137843567` via `32149` |
| Chris | `2829` | disabled `32143` | `32150` | `8182644826` via `32151` |
| Phil | `2830` | disabled `32144` | `32152` | `2133353006` via `32153` |
| Sean | `2831` | disabled `32145` | `32154` | `4242071310` via `32155` |

Operational note:

Do not rename the first-touch VM rows to `VM DROP BRUCE`, `VM DROP SEAN`, etc. in this lane unless the app disposition resolver is changed too. The current clean shape is "same app disposition name, different campaign-local transfer destination."

### How This Connects To CX 2.0

Provisioning creates RingCX destinations only. It does not decide lead eligibility.

The app-side first-touch obligation worker should:

1. Select zero-confirmed-dial green leads from the first-touch obligation pool.
2. Assign one due obligation to an available/off-hook agent.
3. Publish that single lead to the agent's first-touch campaign.
4. Show a non-blocking client alert: "New first-touch lead assigned."
5. Let RingCX dial the first-touch campaign.
6. Let the universal account watcher match current UII back to the app lead.
7. Mark first-touch satisfied only after UII/call proof exists.

Normal bulk queue refills remain separate. First-touch campaigns are an interrupt lane for fresh greens, not a splice into the visible normal queue.

## Implementation Feedback (Claude review, 2026-06-29)

This review poked at the doc against the current bulk reserve/refill code (the same code a fresh deep scrub
just audited — see `CX_0_2_0_REMAINING_DEFECTS_REVIEW_2026-06-26.md` / `CX_0_2_0_DEEP_SCRUB_AUDIT_GUIDE_2026-06-25.md`
§20.10.1). Net: **the design is right and targets the real hole correctly; the risk is sequencing.**

### The architecture is fundamentally right

- **"Touched = confirmed dial proof, not queued/mirrored/displayed"** is the actual fix for the imperfection.
  The current code conflates "we wrote a queue row" with "we handled the lead"; insisting on proof
  (UII / call-event / drain) is the correct invariant.
- **Supply-layer rule, not a client flag or runtime mode** — putting it in `buildReadyClaimQuery` / reservation
  (Step 3) so every rail inherits it is the right altitude.
- **Finite morning batch** instead of an unbounded "any green exists → green-only" mode correctly bounds the
  permanent-green-lock failure mode.

### The glaring hole in bulk, named precisely

The current bulk path has a green-*first* mode but **not a first-*touch* mode** — and those differ:

- `cxReserveModeService.buildFamilyTargets` green-first shapes targets by **family/age** (`{"fresh-day1": deficit}`),
  then `reserveReadyRows` reserves `ready` rows in that **age bucket**. A `fresh-day1` row already dialed three
  times today (`placedCalls=3`) is still "green-first eligible," while a brand-new **zero-dial** weekend green that
  never got a queue row is invisible. **Age ≠ untouched.**
- `reserveReadyRows` / `buildReadyClaimQuery` have **no `placedCalls<=0` filter at all** — bulk literally cannot
  express "never-dialed only." Step 3's `firstTouchOnly` is the missing guard.
- Weekend/after-hours greens are excluded by the **rolling `createdAt` window** in `cxFreshHotLaneService` — a
  Saturday green is outside Monday's window, so it never enters fresh-day1. Step 6 (drop the window in sweep mode)
  is the right fix.

So Steps 3 / 4 / 6 correctly target the real hole.

### ⚠ Prerequisite: this feature AMPLIFIES the open bulk audit defects (change the rollout order)

Steps 3–4 land on the **exact reserve/refill code that currently has OPEN blockers** from the scrub. The
green-first-touch gate does not just sit next to those bugs — it makes several worse, and two create a
**permanent green-only-lock** risk because the gate's unlock condition *is* touch-accounting integrity:

- **#1 inventory leak (blocker):** every contact-blocked reserved row leaks a permanent `claimed` ghost
  (`cxBulkLoadRuntimeService.js:447` + `cxDialQueueRepository.js:469-480`). Under a green-only gate you reserve
  *more* greens, so the leak compounds, and the leaked lead has zero dial proof → its first-touch **debt never
  clears** → the floor stays **locked green-only**. This is the doc's own feared failure mode, caused by the leak.
- **#4 lost-DNC TOCTOU + #8 outbox double-fault (blocker/major):** Step 7's "debt clears only on confirmed proof"
  depends on the drain writing `placedCalls` / `lastTouched.cx`. If that write is lost (#8) debt never clears →
  lock. If the DNC is lost (#4), a DNC'd green stays "untouched debt" → **re-dialed** (compliance violation).
- **#2 racy per-agent start (blocker):** two live sessions for one agent → both reserve green-first rows →
  **double-dial the most sensitive leads** (brand-new greens) + double-count the morning chunk.
- **#12 reconciler key inversion (major):** re-dials a terminally-dispositioned lead → a first-touched green is
  touched again.

**Recommendation — add a Phase 0 = fix the open bulk defects (at minimum #1, #4, #8, #2) BEFORE the
`firstTouchOnly` reservation gate ships.** The feature's correctness is defined by touch-accounting integrity and
no-inventory-leak, which the open defects break.

### Internal inconsistency to reconcile (finite batch vs hard gate)

The doc argues **both**: (earlier) "make the coverage set **finite** — a single new green can't reset the queue,"
and (Step 3) "the hard guard … **normal family rows cannot be reserved while green first-touch debt exists**."
Step 3 as written is the *unbounded* version — any single zero-dial green blocks all normal reservation. An
**un-dialable green** (bad phone, RingCX rejects, or one stuck behind the #1 leak) makes debt non-zero forever →
the gate never opens. **Reconcile by scoping the reservation gate to the finite `greenCoverageBatchId`** (not
"any zero-dial green"), with a **max-attempts / cutoff** so an un-dialable green exits the gate. As written the
two sections contradict, and the stricter one is the dangerous one.

### Touch-accounting consistency hole (under-specified)

Step 3 filters the *gate* on `CxDialQueue.placedCalls`, but "debt" is counted from `LeadCadence.lastTouched.cx`,
and Step 7 updates **both** as **two non-atomic writes**. Drift window: a row whose `placedCalls>0` (excluded from
reservation) but whose cadence still reads zero (still counts as debt) → a lead that **can't be reserved but keeps
the gate open** → lock. **Pick one source of truth for the gate** (the queue counter, since reservation operates
on the queue) and make the drain write `placedCalls` **atomically with the terminal write** — which again depends
on the #4 / #8 drain fixes.

### Smaller notes

- **The obligation engine (first-contact + appointment unified) is a large build.** The doc's sequencing is right
  (build the faux-appointment obligation core → prove first-contact claim/release → move appointments last). It is
  independently shippable from the morning sweep — don't let it block Phases 1–4.
- **The appointment early-dial bug (`consumeAt < dueAt`)** the doc references is a *separate, existing* live bug;
  the engine's strict `consumeAt ≥ dueAt` rule fixes it, but it's worth fixing on its own merits even before the
  engine.
- **The just-in-time single-row RingCX publish** caution (publish only when the agent is stably off-hook, short
  TTL, release on no-active-call) is exactly right — and it touches the same active-call-watcher code with open
  majors (#7 terminal-dropped-on-serving-miss, #10 orphan serving stamp). Same "fix the watcher first" theme.

### One-line takeaway

Right design, real hole, correct fixes — but **do not ship the green-first-touch reservation gate on top of the
open bulk blockers**: fix those first (Phase 0), scope the gate to the finite batch (not "any green"), and pick a
single source of truth for the gate counter.

## Simplification concepts for implementation

To keep this deliverable shippable, reduce each change to one narrow helper and one call site:

1) Treat `first-touch` as a single pure gate, not a global mode
- Add one planner function (e.g., `resolveGreenFirstTouchSupplyPlan(...)`) that returns:
  - `firstTouchOnly` boolean
  - `batchId` when a finite batch is active
  - `familyTargets` for reserve
- Every caller uses that one return value; no per-module "if green mode" branches.

2) Use finite batch ownership to stop permanent lock
- Persist a bounded batch id/expiry (or max-chunks) for overnight/weekend/after-hours greens.
- Reserve flow checks only rows in that batch while `coverageOpen=true`.
- When batch is done/expired, planner flips to normal mix regardless of late-arriving greens.
- `new green arrives -> normal queue` behavior happens automatically because it is outside the batch scope.

3) Make debt based on one source of truth
- Pick queue state (`placedCalls` on `CxDialQueue`) as the gate condition for `firstTouchOnly` (reservation-level truth).
- Keep `LeadCadence` as a derived visibility source, updated from terminal write, not the primary gate check.
- This removes drift where queue says touched and cadence says not touched.

4) Make `placedCalls` / last-touch updates atomic with terminal outcome
- In drain/writer, persist call-touch updates in the same logical atomic step as terminal state transitions.
- Don’t let a successful RingCX call clear only one side.
- This directly hardens both debt accounting and no-redial correctness.

5) Add the missing filter where it belongs (and nowhere else)
- Add `firstTouchOnly` filter only in `buildReadyClaimQuery`/`reserveReadyRows` (and its service wrappers).
- Avoid ad-hoc in memory filtering in caller services.
- If no rows match because a lead is blocked/reaped etc., fallback to normal mix per planner.

6) One renewal of touch flow before new logic
- Delay green-first-touch gate rollout until blockers are fixed (at least #1, #2, #4, #8 from the remaining-defects review).
- Keep reservation/backfill code paths unchanged until these are in place; this avoids compounding existing row-leak and double-dial races.

7) Keep appointment/SLA lane separate from normal queue mutation
- If implementing unified obligation later, add a separate internal `resolveDueQueueObligations(...)` helper that only returns
  order metadata.
- Let existing queue reservation consume the list; do not inject a second, mixed special path directly into active UI queues.

8) Minimal test lock for each simplification
- `firstTouchOnly` query includes zero-dial filter.
- Batch unlock happens after batch debt clears or timeout/expiry.
- Late-arriving zero-dial green does not reopen batch lock.
- No-UII and blocked rows are not counted as unresolved debt.
- New 2+ sessions per agent do not both reserve the same row.

## Final Build Path (Codex, 2026-06-29)

This section supersedes the earlier broad implementation order. The audited notes are right: first-touch is a good design, but it must not be built on top of known bulk defects that corrupt the exact proof this feature depends on.

The final shape has two related but separate lanes:

1. **Morning coverage batch**: a finite 7:45am batch of overnight/weekend/pre-cutoff zero-dial greens that sits ahead of normal queue work until distributed/touched/released.
2. **Live first-contact interrupt lane**: new zero-dial greens that arrive during the day and are served one at a time through the new First Touch campaigns without splicing the normal visible queue.

Both lanes share the same invariant:

```txt
touched = terminal/call proof written by the drain/call lifecycle
not touched = queued, mirrored, displayed, accepted by RingCX, or assigned
```

### Non-Negotiable Preflight

Do not implement the first-touch reservation gate until the following 0.2.0 defects are fixed or deliberately stubbed with hard fail-closed behavior:

1. `#1` reserved contact-blocked row leak.
2. `#2` racy per-agent session start.
3. `#4` review/DNC correction race against outbox drain.
4. `#8` terminal outbox double fault after RingCX disposition succeeds.
5. `#12` no-UII terminal evidence mismatch in startup reconciliation.

Recommended preflight files:

- `packages/shared-services/src/cxBulkLoadRuntimeService.js`
- `packages/shared-services/src/cxQueueReservationService.js`
- `packages/shared-repositories/src/cxDialQueueRepository.js`
- `packages/shared-services/src/cxTerminalOutboxDrain.js`
- `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`
- `packages/shared-repositories/src/cxTerminalOutboxRepository.js`
- `apps/control-plane/src/server.js`

Required preflight outcomes:

- A blocked/contact-ineligible reserved row is cancelled or terminalized, never left claimed.
- Starting a bulk session locks by stable agent identity and has a DB unique backstop for one running session per agent.
- DNC/review corrections write a separate rectification row instead of mutating a terminal row the drain may already own.
- If RingCX disposition succeeds but app persistence fails, the current call moves to replay-required/recovery state instead of staying `terminal.started`.
- Startup reconciliation uses the same idem-key shapes as the outcome adapter, including no-UII terminal rows.

This is Phase 0. It is not optional for a floor pilot because first-touch correctness is proof/accounting correctness.

### Phase 1: Name The Single Proof Source

Pick `CxDialQueue` terminal/call counters as the reservation gate truth.

Use:

- `CxDialQueue.placedCalls`
- `CxDialQueue.dailyPlacedCalls`
- `CxDialQueue.lastPlacedAt`
- terminal outbox / call proof rows that update those fields

Treat `LeadCadence.lastTouched.cx` as derived/reporting state for queue building visibility. It can help find candidate leads, but it must not be the sole gate that blocks normal queue reservation.

Implementation rule:

```txt
reservation asks CxDialQueue if a row is zero-dial
cadence helps discover missing rows
drain updates both queue row and cadence from one terminal proof path
```

Do not let this drift:

```txt
queue says touched, cadence says untouched
  -> normal reservation unlocks but debt resolver stays locked
  -> permanent first-touch lock
```

### Phase 2: Add A Small First-Touch Supply Service

Create:

```txt
packages/shared-services/src/cxGreenFirstTouchSupplyService.js
```

Export only narrow helpers:

```txt
resolveMorningCoverageBatchWindow({ asOf, timezone })
listMorningCoverageDebt({ domain, batchId, cutoffAt, routeCampaigns })
ensureMorningCoverageQueueRows({ debt, queueCxDialRequest })
buildMorningCoverageSupplyPlan({ debt, normalFamilyTargets })
resolveLiveFirstContactCandidates({ domain, asOf, routeCampaigns })
```

The service should not know about React, coach state, appointment forms, or RingCX button semantics.

Return a small plan object:

```js
{
  lane: "morningCoverage",
  batchId: "green-coverage-2026-06-29-WYNN",
  cutoffAt,
  coverageOpen: true,
  normalQueueCanBuildBehindBatch: true,
  firstTouchOnly: true,
  familyTargets: { "fresh-day1": 7 },
  claimFilter: {
    greenCoverageBatchId: "green-coverage-2026-06-29-WYNN",
    firstTouchOnly: true
  },
  counts: {
    eligible: 42,
    queued: 31,
    missingQueueRows: 11,
    touched: 0,
    blocked: 0
  },
  reason: "morning-coverage-open"
}
```

When the morning batch is done:

```js
{
  lane: "normal",
  coverageOpen: false,
  normalQueueCanBuildBehindBatch: true,
  firstTouchOnly: false,
  familyTargets: normalFamilyTargets,
  reason: "morning-coverage-complete"
}
```

### Phase 3: Persist Finite Batch Metadata, Not A Global Mode

The batch must be finite. Do not implement `any zero-dial green exists -> block normal queue`.

Stamp batch rows with:

```js
metadata: {
  greenCoverageBatchId,
  greenCoverageCutoffAt,
  greenCoverageScope: "assigned" | "shared",
  greenCoverageAssignedToExtension,
  greenCoverageAssignedAt,
  greenCoverageReleaseAt,
  greenCoverageReason
}
```

Batch membership:

```txt
created before the 7:45 cutoff
eligible green
zero confirmed CX dials
not DNC/contact blocked
route/campaign/domain eligible
```

Post-cutoff greens do not reopen this batch. They become live first-contact candidates or high-priority normal fresh rows depending on the feature phase.

### Phase 4: Teach Reservation One Filter

Update:

- `packages/shared-repositories/src/cxDialQueueRepository.js`
- `packages/shared-services/src/cxQueueReservationService.js`

Add a single reservation option:

```js
firstTouchOnly: true,
greenCoverageBatchId: "green-coverage-2026-06-29-WYNN"
```

The repository claim query should add all of these when `firstTouchOnly` is true:

```txt
queueFamily = fresh-day1
placedCalls missing or <= 0
dailyPlacedCalls missing or <= 0
metadata.greenCoverageBatchId = provided batch id, when provided
normal ready/release/domain/campaign/rail filters
```

Do not add in-memory filtering in runtime callers. If the row is not eligible, it should not be claimed.

Do not make `firstTouchOnly` unbounded. If no `greenCoverageBatchId` is passed, it should only be allowed for the live first-contact lane where the caller is explicitly asking for one row.

### Phase 5: Fix Family Target Semantics

Update:

- `packages/shared-services/src/cxReserveModeService.js`

The current `green-first` mode is not first-touch. It means "fresh family first," not "zero confirmed dials."

Rename or wrap the intent:

```txt
green-first       -> fresh family priority only
green-first-touch -> zero-dial proof-gated priority
```

Prefer not to add another env-driven mode. Instead, let `cxGreenFirstTouchSupplyService` return shaped family targets and claim options. `buildFamilyTargets(...)` can stay as the normal mix calculator.

### Phase 6: Make Bulk The First Consumer

Update:

- `packages/shared-services/src/cxBulkLoadRuntimeService.js`

Inside `fillBuffer(...)`:

1. Compute the normal family targets exactly as today.
2. Ask `cxGreenFirstTouchSupplyService` for a plan.
3. Pass `plan.familyTargets` into `reservationService.reserveFromFamilyOrder(...)`.
4. Pass `plan.claimFilter` through reservation metadata/options.
5. Log the plan and counts.
6. Publish rows one at a time exactly as bulk already does.

Target shape:

```js
const normalTargets = familyRefillTargets(state, state.stats?.familyTargets || {});
const firstTouchPlan = await resolveBulkFirstTouchSupplyPlan({
  domain: state.domain,
  agentExtensionId: state.agentExtensionId,
  routeCampaigns: state.stats?.routeCampaigns,
  normalFamilyTargets: normalTargets,
  asOf: now()
});

const { reserved } = await reservationService.reserveFromFamilyOrder({
  domain: state.domain,
  agentExtensionId: state.agentExtensionId,
  sessionId: state.sessionId,
  familyTargets: firstTouchPlan.familyTargets,
  totalLimit: deficit,
  claimMinutes,
  metadata: { rail: "bulk_load", ...ringcxRoute },
  firstTouchOnly: firstTouchPlan.firstTouchOnly,
  greenCoverageBatchId: firstTouchPlan.batchId,
});
```

Bulk should not decide what "untouched" means. It only consumes a supply plan.

### Phase 7: Morning Builder Backfills, But Does Not Mark Touch

Update:

- `apps/ringcentral-cx/src/server.js`
- `packages/shared-services/src/cxMorningQueueBuilderService.js` if present in the active tree
- `packages/shared-services/src/cxCadenceService.js`

Morning worker flow:

```txt
7:45 worker starts
  -> resolve finite batch window
  -> list cadence debt
  -> backfill missing queue rows through queueCxDialRequest
  -> stamp greenCoverageBatchId metadata
  -> build normal queue behind the batch
  -> log counts
```

Rules:

- Do not direct-insert queue rows.
- Do not mark `lastTouched.cx`.
- Do not increment placed counts.
- Do not publish every batch row immediately unless the active rail is explicitly bulk and ready to own those rows.
- Do not block normal queue creation behind the batch; block reservation order, not data availability.

### Phase 8: Live First-Contact Interrupt Lane

This is separate from the morning batch.

Use the First Touch campaigns already provisioned:

| Agent | Campaign |
| --- | ---: |
| Brad | `2827` |
| Bruce | `2828` |
| Chris | `2829` |
| Phil | `2830` |
| Sean | `2831` |

Build this after bulk morning batch is stable.

Recommended storage:

```js
metadata: {
  queueLane: "firstContact",
  firstContactAssignedToExtension,
  firstContactAssignedAt,
  firstContactDueAt,
  firstContactLeaseState: "assigned" | "due" | "claimed" | "satisfied" | "released",
  firstContactCampaignId
}
```

Worker behavior:

```txt
new post-cutoff green arrives
  -> create/identify one firstContact queue row
  -> assign to eligible logged-in/off-hook agent by round robin
  -> when agent is available, publish one row to that agent's First Touch campaign
  -> watcher matches active UII back to queue row
  -> terminal proof marks satisfied
```

Do not splice this row into the normal visible queue. The client can show a small "First-touch lead assigned" alert and then rely on the universal active-call watcher to populate the middle section when RingCX starts the call.

### Phase 9: Keep RingCX Priority Normal By Default

Do not send every zero-dial green as `immediate`.

Rules:

- Morning coverage batch: ordered one-at-a-time, `normal`.
- Live first-contact lane: `normal` by default.
- Appointment/manual explicit dials: `immediate` allowed.
- SLA rescue row: `immediate` only as a logged break-glass path after the normal handoff fails or misses deadline.

The app owns priority with queue order. RingCX priority should not become a second hidden ordering system.

### Phase 10: Logging Required Before Apply Mode

Add one structured log event:

```js
{
  event: "cx.green_first_touch.plan",
  lane,
  domain,
  agentExtensionId,
  batchId,
  cutoffAt,
  coverageOpen,
  firstTouchOnly,
  familyTargets,
  eligible,
  queued,
  missingQueueRows,
  reserved,
  published,
  touched,
  blocked,
  normalQueueCanBuildBehindBatch,
  reason
}
```

Add one terminal proof log:

```js
{
  event: "cx.green_first_touch.proof",
  queueItemId,
  caseId,
  uii,
  batchId,
  lane,
  placedCalls,
  dailyPlacedCalls,
  proofSource,
  satisfied: true
}
```

These logs should be enough to answer:

- why a lead was included,
- why a lead was excluded,
- whether a queued lead has actually been touched,
- whether normal mix was allowed to build behind the batch,
- whether a live first-contact row was assigned/published/satisfied.

### Phase 11: Test Order

Unit tests first:

- `buildReadyClaimQuery` adds zero-dial filters only when `firstTouchOnly` is true.
- `buildReadyClaimQuery` scopes morning coverage to `greenCoverageBatchId`.
- `reserveFromFamilyOrder` passes first-touch options down to the repository.
- `resolveMorningCoverageBatchWindow` includes weekend and overnight leads in Monday's batch.
- Post-cutoff green is excluded from the morning batch.
- `ensureMorningCoverageQueueRows` calls `queueCxDialRequest`, never direct inserts.
- Terminal proof updates queue counters used by the gate.

Runtime tests:

- Bulk `fillBuffer` reserves morning batch rows before normal rows.
- Normal family mix can exist behind the batch but cannot be reserved ahead of it.
- Contact-blocked row is cancelled and does not keep coverage open forever.
- No-UII terminal evidence prevents re-dial.
- Two sessions for one agent cannot both reserve first-touch rows.

Integration dry run:

1. Seed Saturday/Sunday/Monday pre-cutoff green zero-dial leads.
2. Seed post-cutoff green zero-dial leads.
3. Run read-only planner.
4. Confirm only finite batch appears in morning coverage.
5. Run queue backfill.
6. Confirm queue rows are stamped with `greenCoverageBatchId`.
7. Start one bulk session.
8. Confirm batch rows reserve first.
9. Write terminal proof for one row.
10. Confirm debt decreases only after proof.
11. Confirm post-cutoff green does not reopen batch lock.

Live dry run:

- Run planner read-only for all agents.
- Compare counts to actual weekend/today green cadence records.
- Apply backfill for one agent only.
- Reserve/publish with one test agent before floor rollout.
- Watch logs for `cx.green_first_touch.plan` and `cx.green_first_touch.proof`.

### Final Acceptance Criteria

The feature is ready only when all are true:

1. Morning batch is finite and does not reopen for post-cutoff trickle leads.
2. Normal queue can build behind the batch, but cannot reserve ahead of assigned/released coverage rows.
3. First-touch debt clears only from terminal/call proof.
4. Blocked, DNC, no-UII terminal, and outbox-failure cases do not keep the floor locked in green-only mode.
5. Live first-contact lane can publish one due row to the correct agent's First Touch campaign without mutating the visible normal queue.
6. First Touch campaign dispositions remain campaign-local with the literal app-facing `VM DROP` name.
7. Logs explain every include/exclude/reserve/proof decision.
8. The same proof path supports bulk now and can later support slow/legacy without copying eligibility logic.

### Things To Avoid

- No unbounded `any zero-dial green exists` global lock.
- No client-side first-touch priority rules.
- No direct queue inserts from the morning builder.
- No immediate priority by default.
- No cadence-only unlock condition.
- No hidden per-mode duplicated first-touch code.
- No appointment semantics for first-contact SLA rows.
- No shared heartbeat/lease behavior that silently changes slow lane.

## Build Notes - 2026-06-29 First Pass

This pass intentionally built the safe foundation and did not turn on the first-touch gate in live bulk behavior yet.

### Built

1. Added first-touch claim filters in `packages/shared-repositories/src/cxDialQueueRepository.js`.
   - Exported `buildReadyClaimQuery(...)` for pure tests.
   - Added `firstTouchOnly` support.
   - Added zero-dial proof filters:
     - `placedCalls` missing/null/`<= 0`
     - `dailyPlacedCalls` missing/null/`<= 0`
   - Added finite batch scoping through `metadata.greenCoverageBatchId`.
   - Added lane scoping through `metadata.queueLane`.
   - Applied the same helper to both `buildReadyClaimQuery(...)` and `reserveReadyRows(...)`.

2. Threaded first-touch options through `packages/shared-services/src/cxQueueReservationService.js`.
   - `reserveFromFamilyOrder(...)` now accepts and forwards:
     - `firstTouchOnly`
     - `greenCoverageBatchId`
     - `queueLane`
   - This keeps the first-touch rule in the reservation source layer instead of adding caller-side filtering.

3. Added reserved-row cancellation for enforced contact blocks.
   - New `reservationService.cancelReserved(rows, reason)`.
   - It uses `transitionQueueItemState(...)` with `metadata.reservationSessionId` match.
   - It moves owned rows to `state: "cancelled"` instead of releasing them to `ready`.
   - `cxBulkLoadRuntimeService.fillBuffer(...)` now calls this path when contact eligibility returns `{ ok:false, enforced:true }`.
   - This addresses the contact-blocked claimed ghost class before first-touch increases green reservation pressure.

4. Added pure first-touch planner scaffold in `packages/shared-services/src/cxGreenFirstTouchSupplyService.js`.
   - `resolveMorningCoverageBatchWindow(...)`
   - `summarizeMorningCoverageDebt(...)`
   - `buildMorningCoverageSupplyPlan(...)`
   - Exported through `packages/shared-services/src/index.js`.
   - This was the first-pass planner shape; the second pass wires it into bulk behind a default-off config.

5. Aligned startup terminal evidence keys with the outcome adapter.
   - `apps/control-plane/src/server.js` now imports `makeOutcomeIdemKey`.
   - `cxBulkTerminalEvidenceKeys(...)` now includes both UII-bearing keys and the no-UII terminal fallback key.
   - This reduces the chance that startup reconciliation re-dials a row that already has terminal outbox evidence.

### Not Turned On Yet

The actual bulk `fillBuffer(...)` first-touch supply plan is wired but remains disabled by default.

Reason: the audited guide correctly says the first-touch gate depends on terminal proof integrity. The remaining terminal/drain issues still need to be closed before we should let first-touch block or reorder live reservation:

- racy per-agent start still needs the DB uniqueness backstop,
- review/DNC rectification still needs a guaranteed separate correction lane,
- terminal persistence after RingCX success still needs replay-required recovery,
- watcher version-miss/serving-stamp transactional cleanup still needs its own pass.
- See `docs/CX_STALE_SERVING_EDGE_CASE_BRUCE_2026-06-29.md` for the live Bruce stale-serving incident that should inform, but not broaden, the watcher cleanup design.

Operational switch:

- `CX_GREEN_FIRST_TOUCH_BULK_ENABLED=false` is the default.
- `CX_GREEN_FIRST_TOUCH_CUTOFF_HOUR=7` and `CX_GREEN_FIRST_TOUCH_CUTOFF_MINUTE=45` define the finite morning batch boundary.
- When enabled, bulk only narrows reservation if the planner provides a scoped `greenCoverageBatchId` or `queueLane`; unscoped first-touch plans fall back to normal family targets.

### Build Notes - 2026-06-29 Second Pass

This pass connected the safe planner into the bulk rail without changing live behavior.

Built:

1. Added `countReadyFirstTouchRows(...)` and `buildReadyReservationQuery(...)` in `packages/shared-repositories/src/cxDialQueueRepository.js`.
   - The count uses the same reservation query shape as the real claim path.
   - The query keeps `state: "ready"`, no appointment rows, RingCX route filters, zero-dial filters, and finite batch/lane scope together.
2. Expanded `packages/shared-services/src/cxGreenFirstTouchSupplyService.js`.
   - Added `buildNormalSupplyPlan(...)`.
   - Added `createCxGreenFirstTouchSupplyPlanner(...)`.
   - The planner is default-off, counts finite ready first-touch rows when enabled, and falls back to normal plans on missing count support or count failure.
3. Wired the planner into `packages/shared-services/src/cxBulkLoadRuntimeService.js`.
   - `fillBuffer(...)` asks for a plan after computing normal residual family targets.
   - It passes the effective family targets and claim filter into `reservationService.reserveFromFamilyOrder(...)`.
   - It logs lane, reason, counts, `firstTouchOnly`, and batch scope in reserve start/finish traces.
   - Planner errors fall back to normal refill behavior.
4. Wired production creation in `packages/shared-services/src/cxBulkLoadRuntime.js`.
   - `createCxGreenFirstTouchSupplyPlanner(...)` is injected with the real queue repository.
   - The behavior is controlled by `CX_GREEN_FIRST_TOUCH_BULK_ENABLED`.
5. Added focused tests.
   - Planner default-off behavior.
   - Planner enabled finite batch counting.
   - Repository reservation query batch/route scope.
   - Bulk runtime narrow first-touch reservation.
   - Bulk runtime fallback when a first-touch plan is unscoped.

### Tests Added / Updated

Added:

- `tests/cx-bulk-load/cxDialQueueRepositoryFirstTouch.test.js`
- `tests/cx-bulk-load/cxGreenFirstTouchSupplyService.test.js`

Updated:

- `tests/cx-bulk-load/cxQueueReservationService.test.js`
- `tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js`

### Test Results

Focused run:

```powershell
node --test tests/cx-bulk-load/cxDialQueueRepositoryFirstTouch.test.js tests/cx-bulk-load/cxQueueReservationService.test.js tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js tests/cx-bulk-load/cxGreenFirstTouchSupplyService.test.js
```

Result:

```txt
57 passed
0 failed
```

Broader CX bulk-load run:

```powershell
node --test tests/cx-bulk-load/*.test.js
```

Result:

```txt
217 passed
0 failed
```

Syntax check:

```powershell
node --check apps/control-plane/src/server.js
```

Result: passed.

### Next Build Pass

Recommended next order:

1. Add stable per-agent start locking plus a Mongo unique backstop for one running bulk session per agent.
2. Split review/DNC correction into a separate rectification outbox row instead of mutating the primary terminal row.
3. Make RingCX-success/app-persistence-failure move current into replay-required recovery instead of leaving `terminal.started`.
4. Make watcher projection retry on `__v` miss and persist terminal observations independently of serving-stamp success.
5. Run one read-only/local dry run with `CX_GREEN_FIRST_TOUCH_BULK_ENABLED=true` against seeded finite batch rows.
6. Add read-only planner logs to the live staging run before applying reservation behavior to floor agents.

## Build Notes - 2026-06-29 Third Pass

This pass added the producer spine for first-touch rows. It still does not schedule, publish, or change live runtime behavior by itself.

### Built

1. Added `packages/shared-services/src/cxGreenFirstTouchQueueMaterializerService.js`.
   - Reads green candidates from `LeadCadence`.
   - Limits candidates to the finite morning coverage window from `resolveMorningCoverageBatchWindow(...)`.
   - Can scope by `routeCampaignKey` so the producer does not mix unrelated campaign pools.
   - Skips rows with:
     - missing/invalid case id,
     - missing phone,
     - inactive/non-dialable cadence stage,
     - CX DNC proof,
     - any prior CX touch proof.
   - Treats `cadenceCounters.cx`, `counterCadence.cxDailyCalls`, `counterCadence.cxMonthlyCalls`, and `lastTouched.cx` as proof that a row is no longer first-touch eligible.
   - Checks existing active queue rows by deterministic `metadata.actionKey` before writing.
   - Defaults to dry-run unless `apply: true` or `dryRun: false` is passed.

2. Added queue-row creation shape for first-touch reservations.
   - Rows are written as `state: "ready"`.
   - Rows use `queueFamily: "fresh-day1"` and `queueTier: "day0"`.
   - Rows carry the RingCX route:
     - `rcxAccountId`
     - `rcxDialGroupId`
     - `rcxCampaignId`
   - Rows carry the reservation scope:
     - `metadata.firstTouchOnly: true`
     - `metadata.greenCoverageBatchId`
     - `metadata.queueLane: "morningCoverage"`
     - `metadata.actionKey`
   - Rows keep `placedCalls` and `dailyPlacedCalls` at `0` so the repository first-touch reservation query can prove they are untouched.

3. Exported producer helpers through `packages/shared-services/src/index.js`.
   - `buildGreenFirstTouchCadenceQuery`
   - `buildGreenFirstTouchQueueRow`
   - `createCxGreenFirstTouchQueueMaterializer`
   - `materializeGreenFirstTouchQueueRows`

4. Added focused unit coverage in `tests/cx-bulk-load/cxGreenFirstTouchQueueMaterializerService.test.js`.
   - Input normalization.
   - Touch-proof blocking.
   - Finite cadence query.
   - Dry-run creation preview.
   - Apply-mode write shape.
   - Existing-row idempotency.
   - Missing RingCX route fail-closed behavior.
   - Row shape consumed by first-touch reservation.

### Still Not Wired

- No hourly worker calls the materializer yet.
- No control-plane route exposes apply-mode creation yet.
- No live runtime behavior is changed unless a caller explicitly invokes the materializer and the existing bulk planner flag is enabled.
- The first safe integration should be a dry-run worker or script that logs the candidate/skip/create counts without writing queue rows.

### Test Results

Focused syntax:

```powershell
node --check packages/shared-services/src/cxGreenFirstTouchQueueMaterializerService.js
node --check packages/shared-services/src/index.js
```

Result: passed.

Focused materializer tests:

```powershell
node --test tests/cx-bulk-load/cxGreenFirstTouchQueueMaterializerService.test.js
```

Result:

```txt
8 passed
0 failed
```

### Next Build Pass

Recommended next order:

1. Add a read-only worker/script wrapper that calls `materializeGreenFirstTouchQueueRows({ dryRun: true })` for each domain/route.
2. Compare dry-run counts against live `LeadCadence` and existing `CxDialQueue` rows before applying writes.
3. Add one controlled apply path that writes a finite batch for one test domain/campaign.
4. Only then wire the existing default-off bulk planner flag to consume those rows in a real floor pilot.

## Claude Review of the Final Build Path (2026-06-29)

Reviewed the two-pronged build (morning coverage batch + live first-contact lane) against the current
tree via a 14-agent adversarial pass (each finding re-verified against real code; 4 dismissed as not
real). **Bottom line: the foundation is sound and safe to keep dark. Nothing here is a live risk —
the feature is default-off (`CX_GREEN_FIRST_TOUCH_BULK_ENABLED=false`) and the bulk planner is a true
no-op when disabled.** Every finding below is **tighten-before-apply** — must land before the flag flips.

### Confirmed safe (the things that would have been blockers)
- **Default-off is a byte-for-byte no-op.** `applyFirstTouchClaimFilter` returns the query unchanged
  when `firstTouchOnly !== true`, so the SHARED `reserveReadyRows`/`buildReadyReservationQuery` used by
  the slow/legacy rails — and live bulk behavior — are unchanged. Planner returns the normal plan when
  disabled and **falls back to normal on any error/missing-count**.
- **Permanent green-only lock is correctly defended.** Debt is queue-side
  (`countReadyFirstTouchRows`, `placedCalls<=0`) **scoped to the finite date-stamped
  `greenCoverageBatchId`** + a `createdAt < cutoff` materialization window + the
  `normalizeFirstTouchSupplyPlan` fail-closed demotion of any unscoped first-touch plan. A post-cutoff
  green cannot reopen coverage. Gate truth is `placedCalls`, not cadence — kills the drift-lock I
  flagged earlier.
- **Preflight is satisfied.** The 0.2.0 defects Codex required (#1/#2/#4/#8/#12) are genuinely fixed in
  this tree (see `docs/CX_0_2_0_DEFECT_FIXES_NOTES_2026-06-29.md`). Bulk `fillBuffer` wiring is correct.
  16 green-first-touch tests pass; full `cx-bulk-load` suite 270/0.

### Tighten-before-apply (ordered by severity)

**1. HIGH — touch-accounting never converges for a non-connect (the headline).**
The bulk rail **never increments `CxDialQueue.placedCalls`/`dailyPlacedCalls`**. `placedCalls` is
written only by `handleCxCallPlaced → buildCallAttemptPatch`, which the bulk rail never calls — it
dispatches only `handleCxTerminalCallOutcome`, which writes answered/no-answer *counters* but not
`placedCalls`. So a no-answer/voicemail green takes the `rescheduleCxQueueItem` branch with
`placedCalls` still `0`, the batch stamps retained, and `countReadyFirstTouchRows` re-counts it →
re-reserved + re-dialed every cooldown. **Bounded** (after ~15 no-answers the unanswered budget
terminalizes it via `completeCxQueueItem`, and `batchId` rolls daily) so it is *not* a permanent lock,
but a real call produces **zero debt reduction** — directly violating the "cover each green once"
invariant — and it is wasteful repeated re-dialing. *(It also exposes a broader bulk gap: `lastPlacedAt`
is never written, so cooldown never engages for bulk-dialed rows.)*
**Fix:** on the bulk advancing/reschedule path in `handleCxTerminalCallOutcome`, fold
`buildCallAttemptPatch(queueItem, outcomeAt)` into the update so `placedCalls`/`dailyPlacedCalls`/
`lastPlacedAt` increment exactly as `handleCxCallPlaced` does. Add a `tests/cx-bulk-load` test:
reserve → markServing → `handleCxTerminalCallOutcome(no_answer)` → assert `countReadyFirstTouchRows`
drops by 1 and `coverageOpen` flips false when it was the last row. *(Cross-ref:
`cxCadenceService.js` ~2654-2884 / 4133-4214; `cxQueuePolicyService.buildCallAttemptPatch` ~1314.)*

**2. HIGH — the 7:45 morning cutoff is computed in UTC, not floor-local.**
`atUtcTime`/`resolveMorningCoverageBatchWindow` build the cutoff with `Date.UTC(...,7,45)`, so the
default fires at 07:45 **UTC** = ~03:45 ET / ~00:45 PT. The `createdAt` window the materializer applies
is therefore skewed ~4h (ET) / ~7h (PT): a genuine pre-open overnight green (e.g. created 6am ET) falls
*outside* that morning's window and is **deferred ~a day** (it's still served by normal green priority,
so not lost — but the batch misses exactly what it exists to catch). The doc's own signature
anticipated `resolveMorningCoverageBatchWindow({ asOf, timezone })`; the timezone param was never wired.
**Fix:** plumb a domain→IANA zone (TAG=America/New_York, WYNN=America/Los_Angeles), resolve the local
07:45 wall-clock instant via `Intl.DateTimeFormat` parts (DST-safe, not hardcoded offsets), convert to
UTC for the `createdAt` range, and key the Monday lookback off local days. The supply test currently
enshrines the literal `07:45:00.000Z` boundary — update it + add a PT/DST regression.

**3. MEDIUM — the materializer's cadence touch-proof is also blind to bulk dials.**
`hasConfirmedCxTouch` reads `cadenceCounters.cx` / `counterCadence.cxDailyCalls/cxMonthlyCalls` /
`lastTouched.cx` — none of which `handleCxTerminalCallOutcome` writes for a non-connect (it writes only
`cxNoAnswerCalls`). Those proof fields come only from `markLeadCxTouchState`, which only
`handleCxCallPlaced` calls. So a bulk dial-to-no-answer registers on **neither** gate, and stays
"already-touched"-false for the materializer (re-materialization-eligible within the window). Twin of #1.
**Fix:** stamp a cadence touch signal (`counterCadence.lastCxDialedAt` and/or `lastTouched.cx`) on any
safe-to-advance bulk terminal; pair with the #1 `placedCalls` fix.

**4. MEDIUM — `upsertQueueItem` has no state guard → a re-run can resurrect a terminal row.**
The filter is `{domain, caseId, "metadata.actionKey"}` with no state predicate, and the active-action
unique index is partial on active states, so a `completed`/`cancelled` first-touch row (same `batchId`
→ same `actionKey`) is matched and `$set` back to `state:"ready", placedCalls:0` → re-dialed. *(Verifier
correction: the COMMON no-answer case goes `releaseReserved → ready`, NOT `completed`, so the headline
"common case" is overstated — the real vector is a voicemail-drop completed **with** a UII, a serving
row that completed, or a DNC/review-race `cancelled` row whose cadence DNC flag lags the queue cancel.)*
**Fix:** add `state: { $nin: ["completed","cancelled"] }` to `upsertQueueItem`'s actionKey filter (a
no-match then inserts a fresh active row that legally coexists with the terminal one under the partial
index), and widen the materializer pre-check to query ALL states for the actionKey. Add a test:
drive a first-touch row to `completed`/`cancelled` with no cadence proof, assert a same-`batchId`
re-run does NOT flip it back to `ready`.

**5. LOW — never-dialed greens created *before* the lookback window are skipped by the batch.**
The `createdAt: { $gte: windowStartAt }` lower bound means a zero-dial green older than the lookback (or
stranded by a skipped Monday run) never enters the coverage lane (it's still dialed via normal green
priority). This diverges from the doc's own Step 6 ("drop createdAtGte in sweep mode"). **Fix:** drop the
lower bound in sweep mode and rely on the never-touched gating, or make it a configurable floor; document
the decision.

**6. LOW — `createLimit` (100) silently truncates a large weekend batch.** No `truncated`/`remaining`
flag, and `scanLimit` caps the scan, so a >100 backlog is silently capped and the caller can't tell
"drained" from "capped." **Fix:** set `result.truncated` on the cap break + have the planned dry-run
wrapper loop/raise the limit until drained.

**7. LOW (gate hardening) — push the unscoped-`firstTouchOnly` fail-closed guard down into the
repository,** so the *future* live first-contact lane (a second reservation consumer that bypasses
`normalizeFirstTouchSupplyPlan`) cannot express a floor-wide green-only filter. Also add the Step-3
`progressiveStageIndex<=0` clause to `applyFirstTouchClaimFilter` (or amend the doc — harmless today
since it's derived from `placedCalls` and the bulk path is batchId-pinned).

### Recommended sequencing
Fixes **#1 + #3 are the gate to enabling** (without them, enabling re-dials unanswered greens and never
clears their debt). **#2** must land before the first real morning run (else the batch catches the wrong
day's leads). **#4** must land before the first `apply:true` materializer run (re-runs are the designed
operating mode). #5–#7 can ride alongside the dry-run wrapper. None blocks keeping the code in the tree
default-off.

### Sign-off checklist

**Verdict to sign off on:** the green-first-touch foundation is correct and **safe to remain in the
tree default-off as-is**. No code change is required to keep it dark. The items below gate *enabling*
the feature, not merging it.

**Keep-dark sign-off (true today — verify and check):**
- [ ] `CX_GREEN_FIRST_TOUCH_BULK_ENABLED` defaults `false`; planner returns the normal plan when off and on any error.
- [ ] `applyFirstTouchClaimFilter` is a no-op when `firstTouchOnly!==true` (shared `reserveReadyRows` / slow-lane unaffected).
- [ ] Materializer producer is unwired (no live caller) and dry-run by default.
- [x] 0.2.0 preflight (#1/#2/#4/#8/#12) fixed in tree; `node --test tests/cx-bulk-load/*.test.js` green (280/0).

**Pre-enable gate (must be done + tested before flipping the flag to `true`):**
- [ ] **#1** bulk terminal writes `placedCalls`/`dailyPlacedCalls`/`lastPlacedAt` (fold `buildCallAttemptPatch` into the bulk path in `handleCxTerminalCallOutcome`) — debt clears on real call proof. *Test: reserve→serving→no_answer drops `countReadyFirstTouchRows` by 1.*
- [ ] **#3** bulk terminal stamps a cadence touch signal `hasConfirmedCxTouch` honors (twin of #1).
- [ ] **#2** 7:45 cutoff resolved in floor-local (IANA tz, DST-safe), not UTC — before the first real morning run.

**Pre-`apply:true` gate (before the first materializer write run):**
- [ ] **#4** `upsertQueueItem` adds `state:{$nin:["completed","cancelled"]}` + materializer pre-check widened to all states — no resurrection of a terminal row.
- [ ] **#5** lookback lower-bound decision made (sweep-mode drop vs configurable floor) + documented.
- [ ] **#6** `result.truncated` flag + dry-run wrapper loops until drained.

**Pre-first-contact-lane gate (prong 2, not yet built):**
- [ ] **#7** unscoped-`firstTouchOnly` fail-closed guard pushed into the repository (so the one-row lane can't express a floor-wide green-only filter).

## Build Notes - 2026-06-29 Fourth Pass

Checklist status note: items #1, #2, #3, #4, #6, and #7 are implemented in this pass. Item #5 remains a business/design decision about whether older never-dialed greens should be pulled by an explicit historical sweep mode or kept under the finite morning window.

This pass addressed the high-risk tightening items from the Claude review while keeping the feature dark unless explicitly enabled.

### Fixed In Code

1. Bulk terminal outcomes now stamp first-touch attempt proof when the payload is UII-backed.
   - File: `packages/shared-services/src/cxCadenceService.js`
   - Added `buildTerminalAttemptProofPatch(...)`.
   - `handleCxTerminalCallOutcome(...)` now folds `buildCallAttemptPatch(...)` into the terminal queue mutation for `sourceService: "cx-bulk-load"` only when a real terminal UII/call session exists.
   - The same UII-backed path calls `markLeadCxTouchState(...)`, so `lastTouched.cx`, `counterCadence.lastCxDialedAt`, `counterCadence.cxDailyCalls`, and `cadenceCounters.cx` converge with the queue's `placedCalls`.
   - No-UII terminal payloads do not count as a first touch. This preserves the anti-phantom-write rule.

2. Morning coverage cutoff now resolves in floor-local time instead of UTC.
   - File: `packages/shared-services/src/cxGreenFirstTouchSupplyService.js`
   - Domain defaults:
     - `TAG` -> `America/New_York`
     - `WYNN` -> `America/Los_Angeles`
   - `resolveMorningCoverageBatchWindow(...)` supports explicit `timezone` / `timeZone` override.
   - The local 7:45 wall-clock cutoff is converted to UTC for Mongo `createdAt` queries.
   - Batch IDs are keyed from the local coverage date, not the UTC date.

3. First-touch reservation is now fail-closed at the repository layer when unscoped.
   - File: `packages/shared-repositories/src/cxDialQueueRepository.js`
   - `firstTouchOnly` now requires either `greenCoverageBatchId` or `queueLane`.
   - If neither exists, the query adds an impossible `_id` clause so future consumers cannot accidentally create a floor-wide green-only reservation.
   - The first-touch filter also includes `progressiveStageIndex <= 0` or missing.

4. First-touch materializer no longer resurrects terminal rows.
   - Files:
     - `packages/shared-repositories/src/cxDialQueueRepository.js`
     - `packages/shared-services/src/cxGreenFirstTouchQueueMaterializerService.js`
   - `upsertQueueItem(...)` no longer matches `completed` or `cancelled` rows for action-key upserts.
   - The materializer now checks active and terminal queue rows for the deterministic action key.
   - Active rows dedupe as `alreadyQueued`.
   - Terminal rows skip as `terminal-queue-row`.

5. Materializer cap reporting is explicit.
   - File: `packages/shared-services/src/cxGreenFirstTouchQueueMaterializerService.js`
   - Result now includes:
     - `truncated`
     - `scanLimitReached`
     - `remainingCandidateCount`
   - This gives the dry-run/apply wrapper enough signal to loop, raise limits, or report that the batch was capped.

### Tests Added / Updated

Updated:

- `tests/queue/cxTerminalOutcome.test.js`
- `tests/cx-bulk-load/cxDialQueueRepositoryFirstTouch.test.js`
- `tests/cx-bulk-load/cxGreenFirstTouchSupplyService.test.js`
- `tests/cx-bulk-load/cxGreenFirstTouchQueueMaterializerService.test.js`

Focused run:

```powershell
node --test tests/queue/cxTerminalOutcome.test.js tests/cx-bulk-load/cxDialQueueRepositoryFirstTouch.test.js tests/cx-bulk-load/cxGreenFirstTouchSupplyService.test.js tests/cx-bulk-load/cxGreenFirstTouchQueueMaterializerService.test.js tests/cx-bulk-load/cxQueueReservationService.test.js tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js
```

Result:

```txt
90 passed
0 failed
```

Full bulk-load suite:

```powershell
node --test tests/cx-bulk-load/*.test.js
```

Result:

```txt
280 passed
0 failed
```

### Remaining Before Enable

1. Decide the older-never-dialed lower-bound rule:
   - Current behavior still uses the finite window lower bound.
   - If the business wants all historical zero-dial greens swept, add an explicit sweep mode that drops `createdAt.$gte` while keeping first-touch proof gates.
2. Add the dry-run worker/script wrapper that repeatedly materializes until `truncated === false`.
3. Run the materializer in dry-run against live data and compare counts before any `apply:true` write.
4. Keep `CX_GREEN_FIRST_TOUCH_BULK_ENABLED=false` until the dry-run counts and terminal/drain behavior are verified against real floor movement.

Reviewer sign-off: ________________   Date: __________   (keep-dark ✅ / pre-enable items owned by: ______)
