# RingCX / CX Architecture Working Memo

## Purpose

This document is a starting point for conversations with RingCX developers and solution engineers.

It captures:

- what Parallel is trying to do
- where the current implementation is strong
- where the hard questions still are
- which RingCX APIs appear to support the target design
- what we should confirm before committing to a final operating model

This is not a final spec. It is a technical discussion memo.

## Product Goal

Parallel is intended to be a shallow Logics-adjacent operating layer that can:

- intake leads from multiple sources
- create and maintain a cadence state machine in Mongo
- execute text, email, RVM, and calling touches automatically
- sync or react to Logics state changes
- provide a custom frontend for internal operators and agents
- use RingCX as the calling engine, with agent presence, queueing, dispositioning, and campaign-related dial control exposed through API integrations

Long-term, the desired agent experience is:

- our frontend polls RingCX for agent state and work availability
- our frontend can touch Logics directly where needed
- our frontend can bridge RingCX, Logics, and text messaging into one operator workflow
- cadence and CX stay coordinated so that a status change, opt-out, payment, close, or operator action stops the next move immediately

## Current Parallel Shape

Today the system is conceptually split into:

- `4001` inbound gateway
  - normalizes inbound leads
  - creates or resolves case ids
  - writes `MasterProspect`
  - writes `LeadCadence`
  - arms scheduled actions in Mongo
- `4002` outbound gateway
  - sweeps cadence actions
  - executes sms / email / rvm
  - hands `cx` work to RingCX-side queueing
  - performs send-time eligibility and validation checks
- `6101` ringcentral-cx
  - consumes CX dial requests
  - buffers and re-releases leads
  - exposes queue claim / callback APIs
  - updates cadence when a call is actually placed

Our current design direction is:

- Parallel owns cadence intent and customer/contact state
- RingCX owns agent-side dial serving and call execution
- neither side should assume the other side means "completed" until the event says so

## Main Development Challenges

### 1. Cadence is not the same as queueing

Cadence answers:

- should this case be contacted at all
- by what channel
- at what time
- how many times
- when should it stop

RingCX queueing answers:

- which callable lead should be served to an agent now
- in what priority order
- under what campaign / queue / preview / callback semantics

Those are related, but they are not the same responsibility.

### 2. Contact state can change at any moment

Examples:

- hostile response
- opt-out
- bad inactive
- changed mind
- default payment
- payment captured
- retained / closed
- manual operator stop / pause

A scheduled contact is only valid if it is still valid at fire time.

That means every send or claim path needs a prefire eligibility check. We should not trust an earlier schedule snapshot.

### 3. There are at least two plausible CX designs

#### Option A: Parallel remains the true cadence engine

Parallel computes every next CX touch and hands work into RingCX in small controlled units.

Benefits:

- easier to keep text / email / RVM / calling in one rule engine
- easier to stop future touches immediately when Logics or `CaseProfile` changes
- simpler attribution and reporting from one source of truth

Costs:

- more responsibility in Parallel
- more API traffic
- more custom queue logic on our side

#### Option B: Parallel hands a lead cohort to RingCX and lets RingCX manage intra-day call flow

Parallel decides that a case is now "in CX" and RingCX takes over day-of serving, callbacks, and some requeue behavior until end of day.

Benefits:

- fewer handoffs
- RingCX does more of what it is designed to do
- agent-facing dial behavior may be more native

Costs:

- harder to keep multi-channel cadence truly unified
- more risk of drift between RingCX lead state and Parallel / Logics state
- we must be very clear about ownership of suppression and stop rules

### 4. Reporting needs milestone-level signals, not raw event noise

The system produces many low-level workflow events.

Operationally, the important facts are closer to:

- lead observed
- cadence armed
- text sent
- email failed
- CX call queued
- CX call placed
- case blocked from future contact
- campaign completed with counts

That matters for both internal UI and anything we later push back to `5001` and `3001`.

## Desired End State

### Lead lifecycle

1. Inbound lead is received.
2. Parallel creates or resolves the case.
3. Parallel writes lead / case / cadence state.
4. Parallel executes early channels: sms, email, RVM.
5. Once engagement channels are exhausted or rules say "move to call", the case becomes eligible for CX.
6. RingCX serves callable leads to agents.
7. RingCX dispositions, callbacks, and call results feed back into Parallel.
8. Parallel updates `LeadCadence`, `CaseProfile`, and eventually Logics-facing status changes.

### Agent lifecycle

Agents primarily work from our frontend, but that frontend should be reading from RingCX and using RingCX-native concepts where possible:

- agent state
- agent availability
- queue / campaign assignment
- active call info
- disposition actions

### Case stop behavior

Any of the following should stop future non-permitted contacts:

- opt-out
- bad inactive or equivalent status
- payment
- close / retained state
- manual stop or pause

### Reporting

We want milestone summaries like:

- queued to cx
- served to agent
- call placed
- disposition set
- callback scheduled
- contact blocked
- campaign finished

## Recommended Architecture

## Recommendation

Use a hybrid model:

- Parallel remains the system of record for cadence eligibility, suppression, and cross-channel coordination
- RingCX owns agent-facing call serving and active call execution
- Parallel can hand off a case to RingCX queueing, but RingCX should still be treated as a worker/execution domain, not the canonical cadence brain

In plain terms:

- Parallel decides whether the case may still be contacted
- RingCX decides which ready call to serve next to an eligible agent
- RingCX reports placements and dispositions back
- Parallel updates the true lifecycle and stop rules

This keeps the tricky business rules in one place while still using RingCX for what it does best.

## Proposed Ownership Boundaries

### Parallel owns

- case / lead identity resolution
- cadence schedule
- cross-channel caps
- suppression rules
- Logics-aware stop rules
- payment / close / bad inactive blocking
- text / email / RVM execution
- CX eligibility
- canonical reporting state

### RingCX owns

- agent objects
- agent states
- queue / campaign mechanics
- active call manipulation
- call placement events
- dispositions and callbacks
- intra-queue serve order

## Proposed CX Runtime Model

### Stage 1: Parallel hands work to CX

When a case becomes eligible for calling:

- `4002` emits a `cx.dial.requested` event
- `6101` converts it into a queue item with:
  - case id
  - phone
  - current priority
  - release time
  - call plan metadata

### Stage 2: CX queue serves work

`6101` runs a worker loop that:

- releases queued items when their timer is due
- allows a claim / fetch operation for the next ready lead
- eventually serves leads to agents or a RingCX execution adapter

### Stage 3: CX call result comes back

When a call is actually placed:

- RingCX (or our RingCX adapter) posts a `call placed` callback
- Parallel marks the corresponding `cx` cadence action completed
- Parallel increments `contacts_sent` for `cx`
- future CX timing is recalculated

### Stage 4: Disposition and callback feed back

Disposition should be treated as a first-class signal:

- no answer
- callback requested
- not interested
- bad lead
- payment / retained / transfer outcome

Disposition should update:

- `LeadCadence`
- `CaseProfile`
- possibly Logics status
- possibly future CX queueing state

## API Capabilities That Appear Relevant

Based on current RingCentral developer documentation:

- RingCX Voice APIs cover agents, queues, campaigns, leads, and active calls.
- Campaigns require a dial group first and require name, start date, end date, and valid caller id.
- Leads can be imported and searched.
- Active calls can be dispositioned with disposition name, callback flag, callback datetime, and notes.
- Agents are managed through Agent Groups and agent APIs.
- Current RingCX API base URL is `https://ringcx.ringcentral.com/voice/api/` with bearer auth.

Useful official docs:

- RingCX developer guide: <https://developers.ringcentral.com/engage/voice/guide>
- Authentication: <https://developers.ringcentral.com/engage/voice/guide/authentication>
- Campaigns: <https://developers.ringcentral.com/engage/voice/guide/dialing/campaigns/campaigns>
- Leads search: <https://developers.ringcentral.com/engage/voice/guide/dialing/leads/search>
- Active calls: <https://developers.ringcentral.com/engage/voice/guide/dialing/active-calls>
- Agents: <https://developers.ringcentral.com/engage/voice/guide/users/agents/agents>

## What We Need From RingCX APIs

### 1. Agent status / presence

We need to know:

- logged in / logged out
- available / away / engaged / working
- custom aux states
- queue assignment or availability context

Questions:

- What is the preferred polling endpoint for current agent state?
- Is there a webhook or event stream we should prefer over polling?
- Can we trust state transitions enough for our own agent UI?

### 2. Campaign creation and management

We need to know:

- should we create one long-lived campaign per business workflow
- or many short-lived campaigns tied to cadence windows
- or should we avoid campaigns for most of this and rely on leads + queues + callbacks

Questions:

- Is campaign creation cheap enough to be dynamic?
- Can campaigns be used primarily as reporting / configuration containers?
- Are preview/manual/agent-callback modes better suited for our architecture than predictive behavior?

### 3. Lead creation, search, and mutation

We need:

- create or import callable leads
- tag them with our own case ids / external ids
- search by external case id
- update lead status after disposition
- suppress or remove leads from future serve

Questions:

- What is the best external id field for our case id?
- Is bulk import materially better than one-by-one lead mutation for our use case?
- Can a lead be paused / requeued / callback-scheduled without moving campaigns?

### 4. Queue serving

We need:

- a reliable way to know "which lead is next"
- or a reliable way to let RingCX serve the right lead to the right agent while we still retain stop authority

Questions:

- Should we build our own queue in `6101` and use RingCX only for active call operations?
- Or should we let RingCX queue/campaign mechanics determine serve order entirely?
- If RingCX owns serve order, what APIs exist to inspect pending lead state and prevent stale work from being served?

### 5. Active call control

We need:

- identify active calls
- disposition calls
- schedule callbacks
- possibly transfer or manipulate active calls later

Questions:

- Is `dispositionCall` the right canonical mechanism for our agent UI?
- Can disposition reliably carry notes and callback times for our own reporting?
- What event or report should we trust to know a call was truly placed and connected?

### 6. Dispositions

We need dispositions to drive business state, not just telecom reporting.

Examples:

- no answer
- busy
- machine
- callback
- not interested
- wrong number
- bad lead
- retained / payment / transferred

Questions:

- Can we create and manage custom dispositions fully by API?
- Can those dispositions carry enough semantic meaning to drive our `LeadCadence` updates?
- Should we mirror RingCX dispositions to our own internal normalized disposition model?

## Open Design Questions

### Question A: Should RingCX or Parallel own intra-day call spacing?

Example:

- first call after a few minutes
- second call 30 minutes later
- third call 2 hours later

My recommendation:

- Parallel should own the rule
- RingCX can own the timer execution once the lead is in CX queue

That means:

- RingCX can re-serve internally for a short day-0 call plan
- but Parallel still decides whether the lead remains callable at all

### Question B: Should campaign creation be central or tactical?

Possible models:

- one persistent campaign per company / source bucket
- one campaign per outbound strategy
- one campaign per agent team
- one campaign per day / run

Working opinion:

- avoid excessive campaign churn
- prefer stable campaign structures plus lead-level control unless RingCX developers tell us campaigns are intended to be dynamic and cheap

### Question C: Should our frontend talk directly to RingCX for agent data?

Likely yes for read-heavy agent state / queue visuals, but mediated by our backend for write paths that also affect `LeadCadence`, `CaseProfile`, or Logics.

Working model:

- frontend polls our backend
- our backend polls or relays RingCX
- write actions go through our backend so we can maintain our own state consistently

## Current CX Concerns To Validate

These are the CX-specific issues we should keep in the architecture conversation and not lose in day-to-day implementation work:

- The current CX queue model has a mismatch between the longer cadence plan and the shorter internal CX retry ladder. We need an explicit decision on whether CX is meant to be three short-horizon retries, five cadence-driven calls, or a hybrid of both.
- CX queue release timing should honor the same quiet-hours / allowable-contact scheduling rules as the cadence planner. A queue item should not become callable just because its local retry timer elapsed.
- Queue items that reach `ready` but are never claimed need escalation or review semantics. "Ready forever" is operationally unsafe.
- We still need durable linkage between cadence intent, CX queue items, RingCentral telephony sessions, and final call logs so that audits, metrics, and dispute handling have a clean chain.
- Call placement callbacks need to be idempotent and unambiguous about which cadence action they are completing.
- The ownership boundary between Parallel cadence and RingCX intra-day serving still needs to be finalized: Parallel-as-brain with RingCX-as-executor is still the recommended model, but the exact handoff semantics are not locked yet.

## Proposed Integration Requirements

## Required

- authenticate cleanly against current RingCX API
- create / manage agents or sync them
- read agent status
- create or manage outbound call containers
- create / search / update leads
- identify active calls
- disposition active calls
- set callbacks
- map outcomes back to our own case ids

## Strongly desired

- event-driven agent state updates instead of polling only
- event-driven call placement / completion signals
- reliable external id support for lead correlation
- flexible callback scheduling
- clean disposition reporting

## Nice to have

- queue introspection deep enough that our UI can show "waiting in cx" vs "served to agent"
- agent workload / occupancy reporting
- routing hooks that let us influence serve order with our own priority model

## Proposed Discussion Agenda With RingCX Developers

1. Authentication and tenant model
2. Agent provisioning and agent state APIs
3. Campaign vs dial group vs queue best practices for API-driven outbound
4. Lead import / lookup / suppression best practices
5. Active call disposition and callback mechanics
6. Eventing options for:
   - agent state changes
   - call placed
   - call connected
   - call dispositioned
7. Recommended architecture for a custom CRM/agent UI that is not their default frontend
8. How they would model:
   - our case id
   - our disposition model
   - our callback flow
   - our stop-contact semantics

## Current Recommendation For Our Side

Short version:

- keep Parallel as the true cadence and suppression brain
- use RingCX as the agent/calling execution plane
- mirror agent state and call outcomes back into Parallel
- do not let RingCX become the only owner of contact eligibility
- do not mark CX work as complete until a real call placement callback is received

That gets us:

- a custom frontend we control
- one source of truth for business stop logic
- one place to coordinate Logics, texting, and calling
- enough flexibility to evolve the CX strategy after we learn more from their API team

## Questions We Should Ask Explicitly

- Do you recommend dynamic campaign creation or stable campaign reuse for API-driven outbound?
- Can we fully manage lead lifecycle, callbacks, and dispositions without using the default RingCX agent UI?
- What is the cleanest way to correlate our own `caseId` to RingCX leads and active calls?
- What event stream should we use for agent state and call progress?
- If a lead becomes ineligible after being queued, what is the best API mechanism to prevent further dialing?
- Should our system own day-of timing logic, or is there a native RingCX pattern we should lean on instead?
- Can callback and disposition APIs support our own frontend as the primary agent desktop?

## Closing View

The most likely winning architecture is not "replace RingCX" and not "let RingCX become the entire cadence brain."

It is:

- Parallel owns intent, suppression, and cross-channel business state
- RingCX owns agent-facing dialing operations
- both systems exchange a small number of meaningful events
- our frontend sits on top as the operational UI

That is the design this memo is intended to help validate.
