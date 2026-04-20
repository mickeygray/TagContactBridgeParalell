# Backend Review Roadmap

This document is the high-level review handoff for the parallel backend.

It is intentionally opinionated.

The goal is not just to list what exists.
The goal is to explain:

- what each port is for
- how events are supposed to move
- where durable state should live
- what is already strong
- what is still provisional
- what a reviewer should attack first

---

## 1. Design intent

The backend is split by responsibility, not by provider.

The intended shape is:

- `3001`
  Frontend only.
  Talks to `5001`.

- `4001 inbound-gateway`
  Accept inbound web/source traffic.
  Do shallow writes only.
  Emit events.

- `4002 outbound-gateway`
  Consume outbound instruction events.
  Pull targets from Mongo.
  Send texts, emails, RVMs.
  Report outcomes.

- `5001 control-plane`
  Auth.
  Orchestration.
  Enrichment.
  Metrics.
  Review queues.
  Queue/list building.
  Frontend read APIs.
  Durable normalized writes.

- `6101 ringcentral-cx`
  RingCentral / EX / CX runtime.
  Presence, telephony, reinit, call-ended event generation.

The key architectural rule is:

- edge services write raw or shallow facts fast
- `5001` decides what those facts mean
- execution services consume instructions and write outcomes

---

## 2. Current port boundaries

### `4001 inbound-gateway`

Current role:

- receives source-family-specific inbound traffic
- writes:
  - `MasterProspectIndex`
  - `LeadCadence`
  - events
- does not try to become the enrichment layer

Current route philosophy:

- no giant generic lead-contact route
- separate entry points by source family
- route identity is part of source truth

Current source families:

- `ld`
- `affiliate`
- `vf landing page`
- `organic landing page`
- `website`
- `facebook`
- `instagram`
- `tiktok`
- `lexis mailer`

What `4001` should not own:

- rich attribution
- metrics semantics
- client materialization
- provider-heavy hygiene logic

### `4002 outbound-gateway`

Current role:

- consume outbound instruction events
- pull targets from Mongo by ids or list ids
- send by channel
- update cadence state for cadence-driven sends
- create review items for failures

Current channel split:

- text
- email
- RVM
- dialer placeholder path that should evolve into CX/dialer semantics

What `4002` should not own:

- batch selection policy
- priority logic
- source targeting logic
- frontend command logic

### `5001 control-plane`

Current role:

- auth and protected read/write surfaces
- event intake and event processing
- work-list / dispatch-list building
- AI summary persistence
- metrics materialization
- review queues
- hygiene planning
- frontend read APIs

This port is broad, but the breadth is intentional.
It is the policy/orchestration layer.

### `6101 ringcentral-cx`

Current role:

- RingEX presence webhook receiver
- telephony webhook receiver
- agent-state mirroring
- RC platform warmup / reinitialize
- presence polling and reconciliation
- EX call started / ended event generation

What `6101` should grow into:

- CX dialer execution
- queue placement from work-list instructions
- call execution outcomes flowing back as events

---

## 3. Data shape: shallow vs normalized

### Shallow state

Shallow state exists so high-volume intake does not force rich client creation.

Primary shallow collections:

- `MasterProspectIndex`
- `LeadCadence`

Meaning:

- `MasterProspectIndex` = who this is at a shallow level
- `LeadCadence` = what communication schedule currently exists

### Normalized business state

Normalized state is what the control plane owns after verification or enrichment.

Primary normalized collections:

- `CaseProfile`
- `PaymentLedger`
- `MetricsSnapshot`
- `ReviewQueueItem`
- `DispatchList`
- `WorkflowRecord`
- `QualityReview`
- `ConversationWorkflow`
- `DeepCutRun`
- `SpendEntry`
- `PaymentAlert`
- `DailyCallStat`

Guiding rule:

- not every shallow prospect becomes a rich case profile
- rich state should be created only after stronger verification or meaningful lifecycle change

---

## 4. Event philosophy

The event system is supposed to carry lightweight instructions and observations.

It should not carry large lead arrays or bulky provider payloads unless the payload is the durable raw fact itself.

### Desired event family language

The lifecycle language is now being pushed toward:

- `observed`
- `requested`
- `built`
- `consuming`
- `completed`
- `failed`

Examples:

- `control-plane.lead.observed`
- `control-plane.enrichment.requested`
- `control-plane.qc-review.observed`
- `control-plane.conversation-ai.observed`
- outbound events that consume a list id

### Current event ownership

- `4001`
  emits inbound and shallow-state events

- `5001`
  consumes control-plane events and writes normalized state

- `4002`
  consumes outbound request events and writes send outcomes / failures

- `6101`
  emits EX/call/presence-related events

### Current strong point

The system already avoids shoving big lists between ports.

The control plane builds a list, stores it in Mongo, then emits a small event that carries:

- `dispatchListId`
- channel
- mode
- small instructions

This is the right shape.

---

## 5. Work-list / queue-builder direction

This is one of the most important abstractions in the system.

### Current state

Implemented:

- `DispatchList`
- `dispatchListService`
- `workListService`
- workflow recording around list build / request / consume / fail / complete

### Why it matters

This is how the backend avoids:

- huge event payloads
- duplicated selection logic in each port
- frontend talking directly to execution ports

### Intended long-term role

The same family should handle multiple queue types:

- outbound dispatch
- CX dialer queues
- QC review queues
- scrub queues
- AI review candidates

The current `DispatchList` model is acceptable for now, but the abstraction should keep trending toward a generalized work-list family with shared lifecycle semantics.

### Review question

The right thing to pressure-test is not whether the current model name is perfect.
The right thing to pressure-test is whether the rule is correct:

- build lists centrally
- store them durably
- emit tiny consume events
- let worker ports pull by id

That rule is deliberate and should probably survive review.

---

## 6. Frontend API strategy

The frontend should mostly speak only to `5001`.

That means the control plane is responsible for returning page-shaped data.

### Current live reviewer-facing surfaces

- metrics reads
- schedule reads
- review reads
- client detail/search reads
- RingCentral presence reads
- dispatch/work-list reads
- workflow history reads

### Why this matters

This keeps:

- auth simpler
- proxying simpler
- audit clearer
- frontend less dependent on provider-specific runtime ports

### Still not fully expressed

- contact library
- schedule calendar
- per-client command families
- workspace shell overview for the full frontend
- ringcentral scored-call / call-log read surfaces
- richer client timeline/history APIs

The important thing is that the route philosophy is now cleaner:

- read routes grouped by surface
- command routes should also be grouped by surface
- avoid expanding one giant generic `read.js`

---

## 7. Metrics strategy

Metrics are intentionally not treated as final yet.

That is okay.

### What is already in place

Collections and read surfaces now exist for:

- snapshots
- spend
- redlines/payment alerts
- daily call stats
- daily/source/mail/callrail workspaces

### Current truth

Metrics semantics are still provisional in places.

That means:

- the storage and read substrate is ready
- some naming/aggregation logic still needs refinement

### Review focus

A reviewer should focus on:

- whether the collections are the right materialized shapes
- whether writes should happen natively in parallel or be mirrored at first
- whether source/payment/spend joins are being materialized in the right place

They should not waste time arguing that metrics are still being refined.
That is already known.

---

## 8. AI, QC, and conversation intelligence

This is another important area where the abstraction matters more than the exact current behavior.

### Current implemented shape

Top-layer canonical records now exist for:

- `QualityReview`
- `ConversationWorkflow`

And `CaseProfile` carries latest snapshots for:

- `qcSummary`
- `conversationAi`
- `aiActivityReview`

### Intended responsibility split

- heavy execution can happen outside `5001`
  - call transcription
  - Whisper
  - Claude call scoring
  - heavier SMS reply modeling

- durable interpreted result should land in `5001`
  - latest QC summary
  - latest conversation status
  - latest AI recommendation
  - latest flags / concerns / positives

This is the right split.

### Current strengths

- activity AI review is already persisted
- QC result registry now exists
- conversation AI workflow now exists
- client detail exposes the latest summaries

### Still incomplete

- GHL/SMS auto-response workflow still needs fuller operational expression
- call scoring pipeline itself still belongs elsewhere
- AI-triggered actions need stronger rules before they become automated

---

## 9. RingCentral / CX strategy

### Current implemented baseline

- EX presence webhook receiver
- telephony webhook receiver
- RC platform reinit path
- presence poller
- agent-state mirroring
- started/ended call event emission

### Current architectural stance

RingCentral should be:

- fallback attribution signal
- queue/extension truth
- agent availability truth
- future CX dialer execution layer

### Important nuance

`6101` should own RingCentral/CX execution, not `4002`.

`4002` should stay non-call outbound execution.

The correct future flow is:

- frontend changes intent in `3001`
- `5001` stores policy and builds work
- `6101` consumes CX/dialer work lists
- `6101` places calls / queue work
- outcomes come back as events

This boundary should be defended in review.

---

## 10. Hygiene and scheduled loops

### Hourly

Current intended hourly role:

- shallow attribution checks
- suppression / STOP / DNC reflection
- newly created client payment checks
- lead cadence reads
- push notable hourly outcomes to human-facing review feed

### Nightly / deep cut

Current intended nightly role:

- deep attribution pass
- final payment/status/source checks
- spend sync
- redline checks
- AI review eligibility
- dashboard/report generation

### Current truth

The orchestration substrate exists.
Some business sections are still placeholders or partially realized.

That is acceptable at this stage because the structure exists and the heavy joins are intentionally scheduled away from realtime paths.

---

## 11. Security and resiliency posture

### Stronger now

- control-plane worker is always on
- outbound worker is always on
- social/lexis inbound routes were tightened to match webhook validation expectations
- event ownership is clearer
- event-driven writes reduce synchronous provider dependence

### Still worth pressure-testing

- provider-specific retry/backoff behavior
- dead-letter / replay policy maturity
- idempotency around repeated outbound sends
- internal auth hardening once day-to-day iteration is less fluid
- alert fan-out beyond persisted health data

Current honest summary:

- robust groundwork is in place
- not every operational hardening policy is final
- nothing critical is being hidden

---

## 12. What is solid enough to defend

These are the decisions I would defend strongly in review:

1. `3001` should mostly talk only to `5001`
2. `4001` should do shallow writes and emit events, not rich interpretation
3. `4002` should consume instructions and pull targets, not build policy-driven batches
4. `6101` should own RingCentral/CX runtime concerns
5. `5001` should own orchestration, enrichment, metrics, review, AI summaries, and frontend reads
6. Work lists should be built centrally and consumed by id
7. Rich client state should be gated behind stronger verification than raw edge intake
8. Metrics should be materialized for reads instead of computed ad hoc at request time
9. AI/QC should persist canonical results at the top layer even when heavy processing lives elsewhere

---

## 13. What is intentionally provisional

These are not bugs in the architecture.
These are known design areas still being refined:

- final metrics semantics
- final enrichment semantics
- exact CX/dialer queue naming and event family
- full SMS conversation automation behavior
- some frontend command surfaces
- some nightly/hourly business rules

Review should absolutely critique them.
But critique should treat them as evolving policy, not as proof that the port boundaries are wrong.

---

## 14. Highest-value next refinements

If review lands cleanly, these are the best next steps:

1. Formalize event family naming across all ports
   - make `observed/requested/built/consuming/completed/failed` more universal

2. Push CX/dialer work into a clearer `6101` work-list consumer
   - replace lingering PhoneBurner semantics with CX semantics

3. Mature the SMS conversation workflow
   - suppression checks
   - draft/manual-send/auto-send decisioning
   - full outcome loop

4. Keep replacing placeholder hygiene sections with real business loops
   - payment refresh
   - spend sync
   - source reconciliation
   - AI review cadence

5. Build grouped command routes on `5001`
   - client commands
   - schedule commands
   - ops commands

6. Add richer timeline/history reads for per-client review

---

## 15. What a reviewer should pressure-test first

If someone is trying to tear this apart productively, the best questions are:

1. Are the port boundaries correct?
2. Is `5001` broad in the right way, or is it absorbing execution concerns it should not own?
3. Are work lists the right abstraction for cross-port execution?
4. Are normalized collections the right long-term frontend read substrate?
5. Are the event lifecycles consistent enough?
6. Is RingCentral/CX kept separate enough from non-call outbound?
7. Are metrics/spend/redline shapes good enough to inherit old working logic without repainting everything later?
8. Are AI/QC summaries landing in the right place?

Those questions will produce useful feedback.

Questions that are less valuable right now:

- exact component-level frontend expression
- exact final dashboard layout
- exact final metric names

Those can evolve after review.

---

## 16. Bottom line

The backend is now at the point where criticism should be meaningful.

It is no longer just:

- disconnected service ideas
- ad hoc routes
- provider experiments

It is now a coherent control-plane-first system with:

- clear port roles
- shallow vs normalized state
- event-driven execution
- centralized queue building
- frontend-facing read surfaces
- AI/QC persistence
- RingCentral baseline runtime

That does not mean it is finished.

It means review feedback should now help refine the system rather than reveal what the system is supposed to be.
