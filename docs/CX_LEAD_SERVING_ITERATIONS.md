# CX Lead Serving Iterations

**Status:** speculative baseline, intended to de-risk dynamic lead serving before live RingCX Voice access is granted.

## Scope

- This document is for **CX lead serving**, not EX desk-phone routing.
- This document assumes **RingCX Voice** as the call execution platform.
- `AMITY` is intentionally out of scope for this phase.
- Metrics, scramble, and Logics writes remain domain-sensitive on the write side; only reporting can be domain-agnostic.

## Companion Checklist

For the practical backlog that merges the current code read with the follow-up review pass, see:

- [CX Implementation Checklist](./CX_IMPLEMENTATION_CHECKLIST.md)

## Why this exists

The current Parallel codebase already has most of the pieces we need:

- a **cadence ledger** (`LeadCadence`)
- a **queue ledger** (`CxDialQueue`)
- a **command surface** (`requestCxDial` -> `ReviewQueueItem`)
- a **CX workspace** in the frontend
- a **6101 runtime** that can release and requeue CX queue items

What it does **not** have yet is a real serving loop that:

1. classifies leads into the right CX queue family,
2. balances hot leads across active agents,
3. assigns work from 6101 as the source of truth,
4. and then later uses RingCX Voice to actually originate the call.

The point of these iterations is to get that shape in place conservatively, with benchmarks at each step, so we are not starting from zero when RingCX credentials and admin access arrive.

## Current code reality

### Frontend

Today the CX workspace queue is mostly a **read of due cadence actions**, not a true served queue:

- `cxWorkspaceService.buildCxCallQueue()` reads due `LeadCadence` actions for `channel === "cx"`
- `CXWorkspace.tsx` lets the agent pick from that list locally
- it does **not** claim work from 6101 as the source of truth

### 6101

Today the `ringcentral-cx` service does useful queue hygiene, but not real agent serving:

- it releases queued items to `ready`
- it requeues expired claims
- it processes cadence events
- it exposes `POST /api/ringcentral/cx-queue/claim-next`

But `claim-next` is still only a global "give me the next ready item" call. It is not yet:

- queue-family aware
- fairness aware
- agent aware
- hot lead balancing aware

### Intake / cadence

Today `queueCxDialRequest()` creates a very simple `day0` queue item with a basic call plan:

- queue tier: `day0`
- delays: `5`, `30`, `120` minutes
- priority: mostly a source heuristic

That is useful as a seed, but it is not yet the business model we want:

- **First day** queue
- **Day 2-10** queue
- **Aged** queue
- second contacts staying in the fresh queue
- aged LD and aged prospects filling gaps intentionally

## External RingCX Voice facts this design should honor

These iterations should build toward the real RingCX Voice command surface, not an invented one:

- Active call management and manual agent call originate live under the **Active Calls API**:
  [RingCX Active Calls](https://developers.ringcentral.com/engage/voice/guide/dialing/active-calls)
- Agent state options and extension mappings live under the **Agents guide**, including:
  `GET /auxStates/?activeOnly=true` and `GET /ringcentral/extensions`
  [RingCX Agents](https://developers.ringcentral.com/engage/voice/guide/users/agents/agents)
- Voice webhook / web service behavior is configured in the RingCX admin tooling:
  [RingCX Voice Web Services](https://developers.ringcentral.com/engage/voice/guide/notifications/web-service)

This means the final hardened version should assume:

- call placement via `createManualAgentCall`
- call tracking via `uii`
- disposition / hangup via the active-call APIs
- queue or call lifecycle events flowing from RingCX web services

## Queue families we should standardize now

These names should exist in the internal serving contract even before RingCX origination is live:

### `fresh-day1`

For:

- new leads accepted from `4001`
- first-day CX work
- second contacts that are still considered hot and should remain in the fresh queue

Behavior target:

- up to `3` contact attempts on day 1
- highest serving priority
- balanced across agents so hot leads are distributed fairly

### `fresh-day2to10`

For:

- business days `2-10`
- `3` contacts per day
- still hot enough that fairness matters

Behavior target:

- served after `fresh-day1`
- still balanceable across agents
- treated separately from aged work

### `aged`

For:

- older LD leads
- older prospects from other sources
- filler inventory when agents have capacity gaps

Behavior target:

- should not crowd out hot work
- should be used to keep agents productive when hot queues are thin

## Internal serving contract

Before any real RingCX call placement, 6101 should become the source of truth for **assignment**, not just queue release.

### Proposed entities

#### Queue ticket

The current `CxDialQueue` row should evolve conceptually into a ticket with:

- `domain`
- `caseId`
- `leadCadenceId`
- `queueFamily`
- `queueDayIndex`
- `attemptsToday`
- `attemptsLifetime`
- `priorityScore`
- `releaseAt`
- `state`
- `assignedAgentExtensionId`
- `assignedAt`
- `claimUntil`

`queueTier` can remain temporarily, but it should eventually map cleanly to the new family names.

#### Agent serving counters

The current `AgentState.dailyStats` already hints at this shape. We should formalize it into serving counters that the assignment path actually uses:

- `freshDay1Served`
- `freshDay2to10Served`
- `agedServed`
- `totalServed`
- `openAssignments`
- `lastAssignedAt`

This is what allows fairness to be explicit instead of accidental.

## Assignment rule set

This is the conservative baseline to build first.

### Step 1: pick the next queue family

Serve in this order:

1. `fresh-day1`
2. `fresh-day2to10`
3. `aged`

Only fall through when the higher-priority family has no eligible ready tickets.

### Step 2: filter eligible agents

An agent is eligible only if:

- they are active in CX serving
- they are not already saturated with open assignments
- they are not in an unavailable state
- they are in the target domain or otherwise explicitly mapped to that work pool

### Step 3: pick the fairest agent

Within the eligible set, choose by:

1. lowest served count in that queue family
2. lowest total hot-lead served count
3. lowest current open assignment count
4. oldest `lastAssignedAt`

That gives us the "round robin, but still balanced on hotness" behavior the business wants.

## Iteration plan

## Iteration 0 - contract and visibility

### Objective

Lock the queue-family language, route contract, and fairness math before wiring in live RingCX origination.

### Deliverables

- this document
- a stable route sketch for 6101
- deterministic queue-family classification rules
- deterministic agent ranking rules

### Benchmark

We can take the same set of leads and agents and get the same preview assignment order every time.

### Proposed 6101 routes

- `GET /api/ringcentral/cx-serving/runtime`
  Returns queue-family counts, eligible agents, and serving counters.
- `POST /api/ringcentral/cx-serving/preview-build`
  Dry-run assignment plan only. No writes, no call origination.
- `POST /api/ringcentral/cx-serving/preview-assign`
  Simulate pulling the next `N` assignments and return the chosen agents.

These are intentionally safe routes. They let us test the logic before the platform layer is involved.

## Iteration 1 - local assignment engine, still no live call placement

### Objective

Make 6101 the source of truth for **who gets served what**, even if the actual call is still manually initiated or simulated.

### Deliverables

- assignment service in 6101 that reads ready CX tickets
- family-aware fairness selection
- agent counter updates
- assignment records the frontend can consume

### Benchmark

Given `4` agents and a mixed hot queue:

- hot leads should distribute within `+/-1` across agents after a reasonable sample
- no agent should run away with the hot queue because they happened to request first
- the queue the frontend shows should match the assignments 6101 actually issued

### Proposed 6101 routes

- `POST /api/ringcentral/cx-serving/assign-batch`
  Promote ready tickets into assigned tickets using fairness rules.
- `POST /api/ringcentral/cx-serving/claim-next`
  Agent-specific claim or pull for the next already-assigned item.
- `POST /api/ringcentral/cx-serving/:ticketId/release`
  Return the ticket to ready or assigned pool.
- `POST /api/ringcentral/cx-serving/:ticketId/complete`
  Mark the assignment complete without yet requiring a RingCX `uii`.

### Frontend checkpoint

The CX left rail should stop reading raw due cadence rows as its primary source. It should read **assigned CX serving tickets** instead.

## Iteration 2 - intake classification and queue shaping

### Objective

Teach the 4001 intake and cadence layer to produce the queue families the business actually uses.

### Deliverables

- new 4001 leads land in `fresh-day1`
- second contacts can stay in `fresh-day1` when appropriate
- day `2-10` work lands in `fresh-day2to10`
- aged LD and other aged prospects feed `aged`
- queue-family mapping becomes explicit instead of inferred later

### Benchmark

For a business-day sample:

- brand-new 4001 leads show up in `fresh-day1`
- non-brand-new but still hot leads show up in `fresh-day2to10`
- aged fill only appears when intended

### Notes

This is where the current "legacy cadence schedule first, CX later" behavior should start getting replaced.

## Iteration 3 - frontend serving model

### Objective

Make the frontend behave like a CX serving console instead of a raw due-lead browser.

### Deliverables

- assigned queue rail
- accept / release / skip actions
- visible queue family badges
- visible fairness counters or queue counts for admin/debug modes
- cleaner EX vs CX platform labeling

### Benchmark

- an agent only sees the tickets they are allowed to work
- two agents do not accidentally work the same lead because both were reading the same raw cadence list
- admin/runtime views explain why a ticket went to a specific agent

### Frontend checkpoint

The current scramble / phone-driven Logics lookup can remain, but it should operate on top of an assigned CX ticket, not substitute for the serving model.

## Iteration 4 - RingCX Voice execution layer

### Objective

Once RingCX access is granted, swap live call placement into the already-stable assignment pipe.

### Deliverables

- `ringcxClient`
- `createManualAgentCall`
- `uii` capture on assignment / call log
- `activeCalls/list` correlation
- disposition and hangup through RingCX
- webhook processing for voice events

### Benchmark

- assigned CX ticket -> RingCX manual agent call succeeds
- returned `uii` is persisted and visible
- active-call state is queryable from 6101
- disposition and hangup operate on the same `uii`

### Notes

This should plug into the serving loop, not redefine it. By this point, the only new variable should be "how the call is placed," not "how work is chosen."

## Final hardened shape

The final pipeline should look like this:

1. intake or lead-import creates / updates cadence
2. cadence emits CX-ready tickets with explicit queue family
3. 6101 assigns tickets using fairness and queue-family priority
4. frontend reads assigned tickets, not raw due rows
5. RingCX Voice executes originate / active-call / disposition / hangup
6. outcomes feed case profile, call log, and downstream metrics

## Immediate next build target

The safest next technical move is **Iteration 1 in preview mode**:

- keep it read-mostly
- no real RingCX origination yet
- no risky frontend rewrite yet
- build the assignment engine and preview/runtime routes first

That gives us something measurable:

- which queue family a lead belongs to
- which agent would receive it
- why that agent was chosen
- whether hot work is balancing correctly

Once that is stable, the frontend and RingCX layers become integration work, not architecture work.
