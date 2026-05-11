# Frontend Port Audit — 2026-04-24

## Bottom line

The port is generally moving in the right direction:

- `3001` is talking to `5001`, not directly to `4001`, `4002`, or `6101`
- the app is organized into page-shaped workspaces instead of old v2 one-off screens
- `Metrics` and `RingBridge` already fit the new frontend shell and should stay

The biggest thing to protect is this:

- do **not** keep porting old v2 assumptions that expect direct provider/runtime objects in the browser
- keep adapting the UI to `5001` read models and command surfaces

---

## What already fits the backend well

### Metrics workspace

This is one of the best aligned pieces of the port.

Why it fits:

- the frontend is using the real `5001` metrics route family
- the page is composed from multiple backend reads instead of assuming one giant legacy payload
- the current panel layout matches the backend better than the old dashboard model did

Current read shape used by the UI:

- `/api/read/metrics/:domain`
- `/api/read/metrics/sources/:domain`
- `/api/read/metrics/daily-summary/:domain`
- `/api/read/metrics/pulse/:domain`
- `/api/read/metrics/mail-costs/:domain`
- `/api/read/metrics/redlines/:domain`
- `/api/read/metrics/callrail/:domain`

Why this matters:

- the backend already materializes these as separate views
- the frontend should continue composing them at the page level instead of trying to recreate old v2 “one fetch powers everything” behavior

### RingBridge workspace

This also fits the current backend architecture well.

Why it fits:

- the workspace reads through `5001`
- it uses the current read model: workspace, presence, events, call log, runtime
- it treats `6101` as hidden infrastructure instead of a direct browser target

Current read shape used by the UI:

- `/api/read/ringcentral/workspace/:domain`
- `/api/read/ringcentral/presence/:domain`
- `/api/read/ringcentral/events/:domain`
- `/api/read/ringcentral/call-log/:domain`
- `/api/read/ringcentral/runtime/:domain`
- `/api/ringcentral/status`

This is the right direction:

- `RingBridge` should be an operator workspace powered by `5001`
- not a separate telephony app that talks directly to RingCentral/CX internals

### Other workspaces that are structurally fine

These are not “done,” but the route shape is directionally correct:

- `Users`
- `Dispatch`
- `Library`
- `Clients`
- `Social`
- `Deploy`

The common good pattern is:

- read via `5001`
- mutate via command routes
- leave provider/runtime execution to backend services

---

## Where old v2 assumptions still conflict with the backend

### 1. Metrics should not be re-ported as a monolith

Old v2 behavior to avoid:

- one oversized dashboard payload
- frontend assuming raw call/spend/lead models are already perfectly merged
- charts and drilldowns that expect timeseries endpoints we do not actually expose yet

Current backend reality:

- metrics are a set of focused read models
- some calculations are intentionally frontend-composed
- the backend exposes summary/table snapshots better than it exposes exploratory analytics

Action:

- keep `MetricsWorkspace` as a composed page
- do not port old v2 charts unless there is a dedicated backend route for them

### 2. RingBridge should not regress into direct provider thinking

Old v2 behavior to avoid:

- direct runtime/provider assumptions in the browser
- treating raw telephony events as the primary UI contract
- assuming every call row is a provider-native record

Current backend reality:

- call log rows are folded session-level read models
- attribution is layered in after the fact
- presence/runtime/call-log/events are separate backend views

Action:

- keep the workspace built around aggregated read models
- do not port direct RingCentral/CX widgets unless `5001` exposes the needed page shape first

### 3. CX workspace is still more ambitious than the backend truth

The `CX` workspace is the place with the most product ambition and the most partial backing.

What is real now:

- read workspace
- call queue
- search
- Logics match lookup
- Logics task list
- commands for status, disposition, task, reminder, email, text, dial, and several Logics actions

What is still speculative or partial:

- true EX-backed text history
- full “conversation bubbles” continuity from provider truth
- mature reminder scheduling semantics
- richer task completion / reminder completion lifecycle
- deeper call-log-linked servicing flows

Action:

- keep the current CX screen framed as a workbench
- but continue labeling some panels/flows as partial until the backend owns those histories and transitions for real

### 4. Schedule and Inbox should adapt to current workflow objects, not old UI mental models

The backend now revolves around:

- cadence records
- workflow records
- review queue items
- dispatch/work-list objects

That means the frontend should avoid porting:

- old inbox assumptions tied to legacy message state only
- old schedule/calendar assumptions that bypass cadence/workflow/read-model layering

Action:

- build Inbox around workflow/review/conversation state from `5001`
- build Schedule around cadence/work-list/dispatch state from `5001`
- avoid recreating old direct-service assumptions

---

## Metrics-specific notes

### What works

- the KPI row is now derived from the actual source and callrail queries instead of pretending the workspace summary slice is enough
- the “Leads” KPI correctly follows the same LD/Meta fallback logic the sources table uses
- the callrail panel now assumes `summary` is an array, which matches the backend
- the pulse panel is using the current grouped pulse shape rather than old sidebar-specific assumptions

### What needs adaptation instead of direct reuse

- do not bring over old timeseries or drilldown widgets until `5001` exposes timeseries/drilldown routes
- do not assume every backend metric is natively “final”; some values are intentionally composed across route families
- fixed costs are currently a frontend policy/display decision, not a backend-owned truth model

### Recommended next metrics work

- keep tables and KPI rows as the primary experience for now
- add deeper backend routes first before porting legacy chart-heavy views
- if a panel wants one-off derived numbers, prefer deriving from the existing route family instead of inventing a new partial backend shape

---

## RingBridge-specific notes

### What works

- workspace shell and route placement are right
- current call log visibility filters are a good fit for preserved history + UI filtering
- recent workflow records and runtime health are the right backend-facing abstractions

### What needs adaptation instead of direct reuse

- do not port any old screen that expects direct ownership of RC auth/runtime internals in the browser
- do not treat call rows as raw provider rows; they are session-shaped aggregates
- keep attribution display secondary because attribution can still resolve after the session exists

### Recommended next RingBridge work

- keep improving operator clarity, not provider detail
- prefer:
  - better call outcome labeling
  - stronger attribution/review badges
  - clearer agent runtime health
- avoid:
  - exposing low-level RC/CX mechanics unless the backend has already normalized them

---

## Workspace-by-workspace implementation stance

### Keep as-is and continue polishing

- `Metrics`
- `RingBridge`
- `Users`
- `Dispatch`
- `Library`

### Keep, but stay honest about partial backend support

- `CX`
- `Inbox`
- `Schedule`
- `Social`
- `Deploy`
- `Cleaning`

### Do not port blindly from v2

- old metrics drilldowns/charts
- old direct telephony/provider widgets
- old inbox/schedule flows that bypass the current workflow/read-model design

---

## Notes on the frontend shell/style

The new shell/workspace organization Claude implemented is good and should be preserved.

Specifically:

- route-level lazy loading is right
- workspace registry + readiness flags are useful
- page-shaped query hooks are the right abstraction level
- `Metrics` and `RingBridge` already fit this structure, so no extra “add them to the app” pass was needed

That means the best next move is not adding more screens fast.

It is:

- tightening the backend contract each screen already uses
- removing leftover old-v2 assumptions
- promoting partial workspaces to fully backed workspaces one route family at a time

---

## Recommended next implementation order

1. Keep polishing `Metrics` and `RingBridge` as the two strongest backend-aligned workspaces.
2. Tighten `CX` around the command/read surfaces that are actually real today.
3. Build `Inbox` and `Schedule` around current workflow/cadence/read-model objects instead of legacy UI expectations.
4. Treat `Deploy`, `Social`, and `Cleaning` as operational sidecars until their route families are richer.
