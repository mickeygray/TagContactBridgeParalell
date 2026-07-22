# Welcome — The Single-Owner / One-Loop / No-Flags Attack

Date: 2026-07-09
Companion to: `.ai/context/WELCOME_GPT_5_6_TAGCONTACTBRIDGE_2026-07-09.md`
Author: Claude (Opus 4.8), read-only code audit — no files were edited, the live box was not touched.

Read the GPT-5.6 welcome first for the ground truth of the system. This doc is narrower and
opinionated: it attacks ONE question, the one Mickey posed after the 2026-07-09 outage —

> How do we get to single owner, one process, one loop, no head-butts, no flags?

It is grounded in a six-angle read-only audit of the actual code (runtime resolution, feeder
census, stale inventory, terminal ownership, the full flag census, mode fragmentation). Every
claim below traces to a file:line the audit quoted. Where it says "confirmed," it means the code
says so, not that it sounds right.

---

## The verdict on Mickey's theory: CONFIRMED, with one correction

Mickey's post-mortem (two owners feeding/owning RingCX + stale inventory surviving resets) is
**right in effect**. One mechanism is misattributed, and the correction matters because it changes
what you have to delete.

**Right:**
- "Bulk was enabled but not the default owner." True and live. `cxDialRuntimeModeService.js:16`
  hardcodes `DEFAULT_RUNTIME = SLOW_SINGLE`; `:50` falls back to it when `CX_DIAL_RUNTIME_DEFAULT`
  is unset. So `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=true` only makes bulk *allowed*, never *default*.
  The live `.env` is configured exactly into the trap: bulk enabled (`.env:790`), 5 agents force-
  overridden to `bulk_load` (`.env:791`), but `CX_DIAL_RUNTIME_DEFAULT` **absent**. Every non-override
  agent resolves to `slow_single`.
- "Stale RingCX inventory survives session replace → current=null → dead buttons." Structurally true
  (see §3).

**The correction (theory point 2):** the RC_CX **cadence worker does NOT write to RingCX.**
`cxCadenceService` has zero `loadLeads` / `publishQueueItemToRingcx` calls. `assignCxQueueBatch`
only stamps `assignment.extensionId` on Mongo `CxDialQueue` rows and logs
`ringcentral.cx_queue.assigned` (`apps/ringcentral-cx/src/server.js:622`). It is a **Mongo-only
assigner**, not the second RingCX feeder.

The real RingCX second feeder is the **legacy `parallel:*` publisher** —
`ringcxLeadServingService.publishQueueItemToRingcx` (`:1026`), reached from the **slow_single lane**
(`cxSlowLaneService.js:668`), the morning-builder mirror, dial-execution, simple-loop, and a manual
`/publish` route — all resolving the **same** `RINGCX_AGENT_ROUTE_*_CAMPAIGN_ID` bulk uses.

Why the correction matters: **turning off the cadence flag alone would not have fixed it.** The
two-owner condition has two heads — a Mongo-assignment owner (cadence) *and* a RingCX-write owner
(the `parallel:*` publisher fed via slow_single). Kill one, the other still head-butts. This morning's
hotfix (set `CX_DIAL_RUNTIME_DEFAULT=bulk_load`, turn off `RC_CX_CADENCE_WORKER_ENABLED`) is correct
and is essentially migration STEP 3 done by hand — but it is *configuration discipline*, and the whole
point of this doc is that configuration discipline is exactly what keeps failing.

---

## 1. Why it happened: a split-brain, not a bug

There is **no single source of truth for "is bulk the owner."** At least **six** places re-derive it,
using **three mutually inconsistent formulas**:

```text
Resolver A — cxDialRuntimeModeService.resolveCxDialRuntimeMode   (per-agent DIAL rail)
  bulk_load  ⇔  BULK_LOAD_ENABLED && (default==bulk_load OR agent-override==bulk_load)
  DEFAULT is slow_single; honors CX_DIAL_RUNTIME_AGENT_OVERRIDES
  → consumed by the bulk rail 403 gate (cxBulkLoadRuntime.js:996) and the legacy-dial block
    (cxWorkspaceService.js:7094)

Resolver B — cxRuntimeModeService.isBulkLoadAlphaRuntime          (process feeder-shutoff)
  bulk       ⇔  BULK_LOAD_ENABLED && (VITE_CX_WORKSPACE_MODE==bulk_load OR default==bulk_load)
  IGNORES agent overrides
  → gates the cadence worker (server.js:497), fresh-hot lane, stale-dial sweep, EX-suppression

Formula C — cxMorningQueueBuilderService.isCxMorningQueueBuilderEnabled
  if its own flag unset → returns CX_DIAL_RUNTIME_BULK_LOAD_ENABLED directly (:590)

Formula D — cxCadenceService.isBulkLoadOwnedCxQueueItem
  per-ROW: metadata.reservationRail=='bulk_load' OR metadata.bulkLoadSessionId (:4101)
```

Feed all four the incident `.env` (bulk enabled, 5 overrides, `DEFAULT` + `WORKSPACE_MODE` unset):

- **Resolver A** says the 5 override agents ARE on bulk → the bulk rail serves their sessions.
- **Resolver B** says `isBulkLoadAlphaRuntime()==false` → the process **keeps its legacy feeders
  alive** (cadence assigner, fresh-hot lane, stale sweep), and `RC_CX_CADENCE_WORKER_ENABLED=true`
  (`.env:592`) leaves cadence on.

That is the two-owner state, encoded. "Some code thought we were in bulk while session control fell
back elsewhere" is not a metaphor — it is two functions reading the same env and returning opposite
booleans.

**And nothing catches it.** There is no startup gate. When bulk is enabled but not default, the
resolver **silently degrades** bulk→slow (`cxDialRuntimeModeService.js:77`) instead of refusing to
boot. The only `process.exit` in `ringcentral-cx/server.js` is a generic catch on a startup throw
(`:2548`) — it knows nothing about ownership.

---

## 2. The feeder sprawl (who can put a lead into RingCX)

Good news first: there is exactly **ONE** RingCX lead-load primitive —
`client.loadLeads` = `POST campaigns/{id}/leadLoader/direct` (`ringcxVoiceClient.js:878`). Single
owner is reachable by controlling the wrappers above it, not by touching the transport.

Above it, two publishers into the **same** per-agent campaign:

```text
FEEDER A (intended owner):  cxBulkLoadRingcxPublisher.publishBatchToRingcx
                            extern = cxbl-<domain>-<sessionToken>-<queueItemId>   (session-scoped ✓)
FEEDER B (the leak):        ringcxLeadServingService.publishQueueItemToRingcx
                            extern = parallel:<domain>:<caseId>:<queueItemId>     (NO session token ✗)
```

Feeder B is reachable from **five** live callers, the dangerous one being the slow_single lane —
which is the default rail whenever `CX_DIAL_RUNTIME_DEFAULT` is unset. So "bulk enabled but not
default" doesn't just fail to route to bulk; it actively routes to a *second* RingCX writer on the
same campaign.

Plus a flag-coupling trap: the **morning-queue-builder's enable defaults to
`CX_DIAL_RUNTIME_BULK_LOAD_ENABLED`** (`cxMorningQueueBuilderService.js:590`) and its apply phase
publishes `parallel:*` (`:406`). Turning **on** the bulk flag can silently start a **legacy** feeder.
(The team clearly knows — `.env:807` pins `CX_MORNING_QUEUE_BUILDER_ENABLED=false`.)

Then three lane dispatchers (first-touch `cxft-*`, appointment `cxapt-*`, Sean drip) that reuse the
*bulk* publisher but into campaigns from independent env maps. Nothing in code asserts those campaigns
are disjoint from the bulk route — lane-vs-bulk single-ownership is a config invariant, not a code
guarantee.

---

## 3. Stale inventory: the current=null path is structural

This is the cleanest confirmation in the audit. On session kill/replace:

1. `killCxBulkLoadSession` cancels only the **buffered** candidates' RingCX leads
   (`state.acceptedBuffer`) and terminalizes the in-flight `state.current` **in Mongo only** — it
   never `CANCEL_LEADS` / hangs up the current's **live RingCX lead**
   (`cxBulkLoadRuntimeService.js:1099–1142`).
2. All of an agent's sessions share **one** campaign (`cxBulkLoadRuntime.js:1662`), so the old
   session's un-cancelled lead physically coexists with the new session's leads. RingCX can dial the
   stale one.
3. The extern carries a **per-session token** (`cxBulkLoadLeadSourceService.js:78`), so the new
   session mints a *different* `cxbl-*` set. The watcher **filters out** any active call whose extern
   isn't in the current session's pool (`cxAccountActiveCallWatcherService.js:199`), and the matcher
   has **no phone fallback** (`cxBulkLoadActiveCallWatcher.js:96` — the 2026-06-17 footgun, correctly
   removed). So the live call is excluded, never adopted → `current=null`.
4. A killed session leaves the watch set entirely (`ACTIVE_STATUSES=["running"]`,
   `cxBulkLoadSessionRepository.js:5`). Its still-live call now has **no owner at all.**
5. Buttons dead-end exactly as observed: disposition returns `missing-current-call`
   (`cxBulkLoadRuntimeService.js:942`), "Sync call" toasts *"No matched RingCX call"*
   (`CXWorkspaceBulkLoad.tsx:5253`).

The session-token design is *correct* for preventing wrong-attach — but it only ever **excludes**,
never **cleans up or adopts.** There is no reconcile on boot after a power cycle. The in-session
resync machinery (`CX_BULK_RESYNC_ENABLED`, default true) only audits the *current* session's buffer;
it cannot fire for a call whose extern belongs to a dead session.

---

## 4. The terminal path is already the model — copy it, don't rebuild it

Counter to expectation, end-of-call is the **strongest** part of the rail. Five entry points
(disposition, skip, kill, watcher observation, lane disposition) all funnel through one durable
chokepoint: `persistTerminalOutcome → cxTerminalOutboxRepository.insertOnce`, deduped by a **Mongo
unique idemKey index** (`cxTerminalOutboxRepository.js:36,45`) — not an in-memory Set, so it survives
the exact restarts the incident describes. One drain (`cxTerminalOutboxDrain`) is the sole downstream
cadence/Logics/DNC writer. The bad-number button is *not* a separate writer — it flags the normal
disposition and the effects run drain-side. **This is the shape the whole rail should have.**

Residual cracks (fix, don't discard):
- Two autonomous **deciders** race on classification: the button and the watcher both call
  `persistTerminalOutcome` for the same UII; whoever writes the idemKey first wins, the other's
  verdict is silently dropped. (For *connected* calls this is resolved by policy — the 2026-07-02
  WRAP ruling holds the call so the agent's disposition is the record. Never-connected releases the
  watcher still auto-writes.)
- `makeOutcomeIdemKey` has a **no-UII fallback branch** (`cxBulkLoadOutcomeAdapter.js:34,40`) — a
  UII-row and a no-UII-row for the same physical call can both insert as distinct rows.
- The outbox-unavailable **fallback dispatch** (`cxBulkLoadRuntime.js:1058`) side-writes legacy
  cadence outside the idemKey guarantee — a second, non-idempotent effect writer that appears only on
  the outage path.
- `markDrained` is a CAS that warns "the singleton-drain assumption just failed" on a concurrent
  drainer — i.e. "one drain" is an assumption, not an invariant.

---

## 5. The target: one owner, one loop

```text
resolveCxOwnership(env, {tenant, agent}) -> { owner: 'bulk' | 'legacy_emergency', reason, inputs }
        computed ONCE at process boot, frozen, consumed everywhere.
        NOBODY re-reads CX_DIAL_RUNTIME_* / VITE_CX_WORKSPACE_MODE directly, ever.
```

When `owner == bulk`, the legacy cadence assigner, fresh-hot lane, empty-queue refill,
morning-builder-as-feeder, and the `parallel:*` publisher are **code-path gone for that floor** —
not flag-gated off. You cannot head-butt a feeder that does not exist.

**THE loop, per agent, per tick:**

```text
reserve  → app owns CxDialQueue; pull ready rows (lane-tagged for first-touch/appt/aged)
publish  → cxBulkLoadRingcxPublisher (the ONLY loadLeads caller) mints cxbl-* into the ONE campaign
watch    → read RingCX active calls; match extern/UII ONLY (never phone); promote current
dispose  → ONE terminal via insertOnce (idemKey) → the ONE drain does downstream effects
```

Who observes vs who writes: **RingCX owns dial reality; the app owns queue/session + terminal
persistence.** The watcher OBSERVES and writes `current` + terminal for never-connected releases; for
a connected call it holds WRAP and the agent's disposition is the record. Exactly one writer per call
class, folded into one loop. The app never invents a call the watcher didn't observe — that is the
hard law from the field guide, preserved.

**Feeder collapse (the concrete deletions):**
- `parallel:*` publisher + slow_single lane + simple-loop → **delete** as floor rails (slow_single is
  already atticked client-side, `CXWorkspaceRouter.tsx:12`). One publisher, one extern grammar.
- Cadence assigner's RingCX-feeding role → folded into the reserve step (bulk reserves + publishes in
  one tick); the schedule-progression judgment (day2-15 / 16-30 / aged) becomes queue-family
  **data** the reserve step reads, not a second worker.
- Morning builder → a pure Mongo pre-stager (drop its `publishQueueItemToRingcx`); enable stops
  defaulting to the bulk flag.
- First-touch / appointment → **sub-lanes** of the one loop (publish through the one publisher into
  the agent's one campaign with a lane tag), per Mickey's 2026-07-07 lane-registry ruling
  ("every agent serves each type of lead," `cxLaneRegistry.js:3`). If separate campaigns must
  persist, they are boot-asserted **disjoint** from the bulk route.

---

## 5.5 Post-load is sacred — the trunk reset (live evidence, 2026-07-09 PM)

Sean's dials + a targeted code read sharpened the target and moved the crosshairs. With the OLD
rails confirmed off (cadence / hot-lane / morning-builder / stale-sweep / workspace-reaper), the
**live offender is the NEW bulk rail managing individual leads AFTER load.** Mickey's rule:

> Once a lead is loaded into RingCX we do not prune, cancel, reorder, rescue, or reinterpret it.
> RingCX owns the dial list and order. The app only: loads eligible leads, observes the active call
> by extern/UII, lets buttons act on it, writes/drains the final outcome. Pre-load blockers stay
> (DNC / client / non-prospect / missing phone / appointment hold / duplicate active row). After
> load, no "smart cleanup" unless Mickey explicitly kills/resets the session.

**The load-bearing question — "will RingCX keep dialing by itself if we stop the app's get-leads
loop?" — answered from code: YES, very likely.**
- `loadLeads` loads with `listState: "ACTIVE"` and the publisher's own header says *"bulk dials in
  load order (FIFO)"* (`cxBulkLoadRingcxPublisher.js:13,64`). A loaded lead is dialable **on load**;
  nothing else is required for RingCX to dial it.
- Therefore the auto-get-leads loop — `READY_LEADS` then `AGENT_RESERVATION` per candidate
  (`cxBulkLoadRuntime.js:836`), run **every watch tick for every idle session**
  (`cxBulkLoadRuntimeService.js:1305-1314`, 5s/lead cooldown) — is a **preview/reservation OVERLAY,
  not the dial engine.**

**Decompose the patch — do not disable the whole loop blind:**
- `READY_LEADS` = re-arm a lead to dialable. On a healthy floor leads are already ACTIVE from load,
  so it is redundant; on a **stale buffer** it re-READYs an already-CANCELLED/COMPLETE extern and
  **resurrects** it — the duplicate READY copies of dead externs seen at 19:09Z.
  **Clearly safe to kill; it is pure harm.**
- `AGENT_RESERVATION` = pin a specific lead to a specific agent (`CALLBACK_DTS = now+1s`). This
  **might** be load-bearing for routing the right lead to the right agent IF campaigns are shared or
  the dial mode is preview. In the per-agent-route campaign model it is probably redundant, but
  **verify before removing** — the one-clean-agent live test is exactly the right probe: disable the
  loop, watch RingCX keep dialing the loaded ACTIVE list to that agent.

**The four "too-clever" offenders → target behavior:**
- **Resync/pruner** — `deriveBufferInvalidations` (`cxAccountActiveCallWatcherService.js:707`) →
  `buffer.invalidated` (`cxBulkLoadStateMachine.js:301`) drops buffer entries and can cancel RingCX
  copies (`cxBulkLoadRuntime.js:1120`). → **observation / log-only under bulk-owner mode.**
- **Current release / review-hold** — (`cxAccountActiveCallWatcherService.js:237`) →
  `current.released` (`cxBulkLoadStateMachine.js:269`) interprets "CX no longer shows this call" and
  clears/holds/re-reasons app state (the buttons/jitter/pinned-current family). → **strip to
  observation + terminal write.**
- **Buffer release** — `buffer.released` (`cxBulkLoadStateMachine.js:287`) drops a buffered lead the
  watcher thinks CX dialed-and-released between polls. Legit outcome accounting, but still app-side
  list maintenance — keep it as a pure completed-count, **never a RingCX mutation.**
- **Auto-get-leads** — (`cxBulkLoadRuntimeService.js:792` → `cxBulkLoadRuntime.js:836`).
  **Kill `READY_LEADS`; verify `AGENT_RESERVATION`.**

**Endorsed patch sequence (Codex's, with the decomposition):** make `CX_BULK_RESYNC` log-only/off in
bulk-owner mode → strip current-release/review-hold to observation + terminal-write → kill the
`READY_LEADS` re-arm → test **one clean agent batch** and confirm RingCX keeps dialing the loaded
queue by itself. This is a **trunk reset** (make the manager dumb), not a rewrite: keep `loadLeads`,
`cxbl` extern/UII matching, the sysdispo read, the outcome drain, and the buttons. It is the
operational form of §5's law — **the watcher OBSERVES; it does not curate inventory.**

---

## 5.6 The boring dialer trunk (the concrete target)

The full version lives in `.ai/context/WELCOME_GPT_5_6_TAGCONTACTBRIDGE_2026-07-09.md`
under **2026-07-09 PM Addendum: The Boring Dialer Trunk**. Treat it as the
implementation target for this doc's ownership theory.

The short form:

```text
Before RingCX: the app chooses eligible work.
After RingCX accepts it: RingCX owns live dial order.
During the call: the app observes by extern/UII.
End of call: terminal/drain records the result once.
```

Keep the proven terminal pipe:

```text
button press or RingCX system disposition
-> terminal outbox
-> drain
-> call note / call wrap / bad number / DNC handling
```

Replace the lead-progression trunk with one boring service:

```text
buildPool
addIncomingLead
selectFromPool
sendSelectionToRingCentral
persistAcceptedQueue
getAgentQueue
rebuildAgentQueueFromRingCentral
pollAndMatchActiveCall
readSystemDispositions
writeSystemDispositionOutcomes
dispositionCall
killSession
```

Only two normal writes are allowed: the RingCX load/accepted-receipt write and the
terminal outcome write. The app queue is a receipt/display cache, not a dialer.
Refill appends only. `killSession` is manual only. No background path may
re-ready, rescue, prune, reorder, reassign, or maintain loaded RingCX inventory.

Morning pool and overnight first-touch both use the same rail:

```text
lead -> hard eligibility -> sendSelectionToRingCentral -> accepted receipt -> display queue
```

This is the no-flags goal in code form: not a smarter manager, just one narrow
trunk where every function has one job and no function after load gets to decide
that RingCX inventory needs "help."

---

## 6. The flags answer (what Mickey actually asked)

Honest headline: **you cannot reach literally zero flags on a live, multi-tenant, mid-migration sales
floor — but you can go from ~90 CX-dial env flags (~30 ownership-relevant) to a single-digit
irreducible set,** and every survivor is either external data or a break-glass safety switch. "No
flags" is the right direction; the destination is "no flag encodes *ownership* or *mode* — those are
one value, computed once."

**Delete (dead, duplicate, or a second owner):**
`VITE_CX_WORKSPACE_MODE` (server read — client abandoned it), `RC_CX_CADENCE_WORKER_ENABLED`,
`RC_CX_FRESH_HOT_LANE_ENABLED`, `RC_CX_FRESH_HOT_LANE_IMMEDIATE_ENABLED` (default-TRUE, fires inline —
most dangerous), `RC_CX_EMPTY_QUEUE_REFILL_ENABLED` (side-door assigner), `CX_SIMPLE_LOOP_*`,
`CX_SLOW_SINGLE_*`, `CX_SEAN_FIRST_TOUCH_TEST_ENABLED` (when the pilot ends).

**Collapse into the one resolved mode:**
`CX_DIAL_RUNTIME_DEFAULT`, `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED`, `CX_MORNING_QUEUE_BUILDER_ENABLED`,
`RC_CX_RUNTIME_MODE`/`CX_RUNTIME_MODE`, the `RC_CX_EX_*` coupling cluster (let UII/RingCX own CX
state), the hygiene flags (`RC_CX_RELEASE_*`, reapers) folded into the loop's session-replace path,
and the terminal-classification tunables (`CX_SYSDISPO_CLASSIFIER_ENABLED`,
`CX_BULK_ANSWERED_MIN_CONNECTED_MS`, `CX_BULK_WRAP_TIMEOUT_MS`) frozen to their intended default —
freezing an already-coded judgment is not adding machine judgment.

**Keep as config / the one loop's on-switches:**
`CX_TERMINAL_OUTBOX_DRAIN_ENABLED` and `CX_ACCOUNT_ACTIVE_CALL_WATCHER_ENABLED` (the one drain / one
watcher; ideally tie their liveness to `owner==bulk`), `RINGCX_AGENT_RESERVATION_*`,
`CX_RESERVATION_RECONCILER_STARTUP_ENABLED` (the anchor to grow into the startup gate).

**Human ruling required:** `CX_FIRST_TOUCH_ENABLED`, `CX_APPT_LANE_ENABLED` /
`CX_APPOINTMENT_WORKER_ENABLED` (two appointment mechanisms — dedupe), `RINGCX_AGENT_MONITOR_*` (a
*second* watcher — confirm nothing unique lives there before retiring).

### The irreducible minimum (be honest about this)

1. **Secrets / URIs** — `mongoUri`, JWT/OTP, RingCX + Logics creds. Per-environment, secret.
2. **The per-tenant, per-agent campaign/dial-group route table** — `RINGCX_AGENT_ROUTE_*`,
   `RINGCX_VOICE_DEFAULT_CAMPAIGN_ID`. Real external RingCX resources; data, not logic.
3. **One emergency killswitch** — `CX_DIAL_RUNTIME_DEFAULT=legacy_emergency` (the third enum already
   exists, `cxDialRuntimeModeService.js:13`). Break-glass to the legacy floor mid-incident is an
   operational decision, not a compile-time one. This is the *single surviving mode value.*
4. **The rollout allow-list** — `CX_DIAL_RUNTIME_AGENT_OVERRIDES`, but owned by the ONE resolver so
   it can never diverge from feeder-shutoff the way it does today. Temporary, with a **delete date**:
   when the floor is 100% bulk, it empties and the flag is removed.
5. **Two safety killswitches from real incidents** —
   `RINGCX_CAMPAIGN_REQUIRE_ACTIVE_CALL_CONFIRMATION` (must stay **false** — true turns capture into
   a destructive queue gate, the 2026-06-17 incident) and `RINGCX_ACTIVE_CALL_ALLOW_WEAK_MATCH` (must
   stay **strict** — loosening it re-introduces wrong-attach of stale inventory). These are the
   scars. **Do not let "no flags" pressure delete them.**

---

## 7. Two structural fixes that make the trap impossible

**Startup gate (fail-closed, not fail-degraded).** In both processes, before any worker starts:

```text
const owner = resolveCxOwnership(process.env);
if (owner.bulkEnabled && owner.owner !== 'bulk') { logger.fatal('cx.ownership.split', owner.inputs); process.exit(1); }
// second clause: assert every lane campaign id (FIRST_TOUCH/APPT/SEAN) is DISJOINT from every
// RINGCX_AGENT_ROUTE_*_CAMPAIGN_ID — overlap ⇒ refuse to boot (a lane can never become a 2nd owner)
```

Because there is now ONE resolver, `bulkEnabled` and `owner` derive from the same inputs, so the only
way to hit this is a genuinely contradictory env — which is exactly the incident state. This replaces
today's silent `bulk→slow_single` degrade (`cxDialRuntimeModeService.js:77`) with a refusal to run
wrong.

**Inventory hygiene as a property of the loop, not a worker** (honors "no new autonomous cleanup
workers"):
1. Fix the kill gap — the *same* `killCxBulkLoadSession` path also `CANCEL_LEADS` the current's extern
   and best-effort hangs up its UII (today it only cancels the buffer).
2. Session-token sweep on replace — the new session's first publish tick enumerates the shared
   campaign and `CANCEL_LEADS` every `cxbl-*` whose token isn't the current session's. This is
   `CX_BULK_RESYNC_ENABLED` promoted from default-true flag to an always-on invariant of *starting*.
3. Boot reconcile — the startup reconciler reads every Mongo `running` session against live RingCX
   active calls + campaign leads and **adopts by token** (never weak-match) or cancels+terminalizes
   orphans. A power-cycle can no longer leave a live call with no owner.

One extern grammar (after the `parallel:*` retirement) means one thing to enumerate and one rule to
purge — no cross-namespace reaper needed.

---

## 8. Where "one loop, no flags" legitimately bends

The design is not "delete all configuration." These seams are real; each has a cheapest form that
is **not** a proliferating flag:

- **TAG/WYNN dual tenant** → tenant is a *routing dimension* of the one resolver's inputs; `owner`
  is still `bulk` for both, they differ only in which route/secret resolves. Route table is data.
- **Per-agent pilot/rollout** → the allow-list above; temporary, delete-dated, owned by the one
  resolver.
- **Emergency off** → the one `legacy_emergency` killswitch. Fail-safe by design.
- **The live coach** → a pure **observer** of the loop's outputs (current + terminal events). Owns
  nothing, needs no ownership flag, is never a second watcher.
- **First-touch / appointment** → sub-lanes (queue-family tag + campaign route = *data*), not
  autonomous feeders with their own enable flags.

---

## 9. Migration path (each step floor-safe; warn before fail-closed)

```text
0. Add resolveCxOwnership(env) as a NEW pure function (not wired). Unit-test against the incident
   .env combo so its verdict is pinned before any consumer moves.
1. Add the startup gate in WARN-ONLY mode in both processes. Confirm it fires on today's .env.
   (No boot-loop risk on the running floor.)
2. Point isBulkLoadAlphaRuntime + getCxRuntimeMode INTERNALS at resolveCxOwnership (keep names/
   signatures). Cadence self-disable, fresh-hot, stale sweep, EX-suppression now consult ONE result.
3. Set CX_DIAL_RUNTIME_DEFAULT=bulk_load on the box (gate green). The 5 override agents and the
   process now agree; legacy workers self-disable. **This alone stops the two-owner condition with
   zero code deleted** — it is the durable version of this morning's hand-fix.
4. Morning builder reads the resolved owner (not the raw bulk flag) and becomes a pure Mongo
   pre-stager. Ships behind a flag already false on the box → zero floor impact.
5. Fix the kill-session inventory gap (CANCEL_LEADS + hangup for state.current). Additive, no new
   worker.
6. Session-token sweep on first publish tick + boot reconcile of running sessions vs live RingCX.
7. Gate the parallel:* publisher + its 5 callers behind owner!=bulk; log-count in prod for a day to
   prove no floor traffic hits them; THEN delete slow_single/simple-loop and their flag families.
8. Flip the startup gate warn→fail-closed (maintenance window) and delete the now-dead flags.
9. HUMAN-GATED: rule on the lane feeders (sub-lane vs disjoint campaign); retire ringcxAgentMonitor
   as the second watcher only after a behavior diff confirms nothing unique lives there.
```

---

## What still scares me (read this twice)

1. **The one-line fix (STEP 3) is config, and config is what failed.** Setting
   `CX_DIAL_RUNTIME_DEFAULT=bulk_load` fixes today's floor, but it is the same *kind* of thing that
   broke: a value a human has to set right. The durable win is STEP 1's gate — make the wrong combo
   *unbootable*. Until that lands, we are one `.env` edit away from the same outage.
2. **Do not "simplify away" the two safety killswitches.** `REQUIRE_ACTIVE_CALL_CONFIRMATION` and
   `ALLOW_WEAK_MATCH` look like exactly the kind of flag a no-flags crusade deletes. They are the
   headstones of the 2026-06-17 and stale-inventory incidents. Keep them, default-safe.
3. **The cadence schedule-progression carries real judgment.** Folding day2-15 / 16-30 / aged
   selection into the reserve step is the largest surface. If the reserve step doesn't reproduce that
   pacing faithfully, aged leads starve or over-dial. Port it as data and **diff assignment counts
   against the legacy worker for a day** before deleting anything.
4. **Never delete the `parallel:*` publisher on faith.** The `/publish` route and dial-execution path
   may serve non-bulk tooling. Log-count in prod first (STEP 7) or a silent capability vanishes.
5. **Fail-closed can self-inflict an outage.** A transiently-wrong env on boot would refuse the whole
   floor. Warn-only first; fail-closed only in a window.
6. **ringcxAgentMonitorService is a second watcher.** It may hold unique terminal/orphan-clear
   behavior. Retiring it blind could drop a real cleanup — human ruling + behavior diff, not a
   code-only call.

---

## The one-line takeaway

The 2026-07-09 outage was not a missing recovery behavior. It was **"who owns the floor" being a
question four functions answer independently, three of them differently, with nothing refusing to run
when they disagree.** The fix is not a cleverer poller or a smarter reaper. It is making ownership a
**single value, computed once at boot, obeyed everywhere, and fail-closed when contradicted** — and
then deleting every code path that lets a second owner exist. One owner is a property of the data
model, not a configuration you re-agree to by hand every morning.

If ownership is one value and the second feeders are gone, the flags Mickey hates mostly delete
themselves — because a flag only earns its keep when there is a second thing it could have turned on.
