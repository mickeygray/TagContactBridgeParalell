# Control Plane 5001 Map

This document grounds the `5001` control plane in the original
`TagContactBridge` code before we move more business logic into the parallel
workspace.

## Position

`5001` should be the durable internal API and data hygiene layer.

It is not the first landing zone for noisy inbound or live telephony traffic.
Instead, it should:

- authenticate and authorize internal/admin access
- expose frontend-facing durable reads
- consume persisted events after writes land
- reconcile records against Logics and other systems of record
- materialize metrics and summaries
- run cleanup, sourcing, and list-review workflows

## Original Ownership Signals

### Auth and internal API

Original files:

- `server.js`
- `routes/auth.js`
- `middleware/authMiddleware.js`

Parallel home:

- `apps/control-plane`
- `packages/shared-auth`

### Logics reconciliation

Original files:

- `services/logicsService.js`
- `services/statusChecker.js`
- `ringBridge/services/hourlySyncService.js`

What this tells us:

- Logics is the source of truth for case status, payments, invoices, and
  contact/account lookups.
- Reconciliation should happen after writes land, not inside every edge port.
- Status checking and cleanup are control-plane jobs.

### Metrics and reporting

Original files:

- `ringBridge/services/dailyReportService.js`
- `ringBridge/services/spendSyncService.js`
- `ringBridge/services/callRailStatsService.js`

What this tells us:

- the metrics dashboard depends on durable materialized views
- spend sync and call statistics are query/reporting concerns
- these concerns grew in RingBridge, but they fit `5001` better than `6101`

### Sourcing and attribution

Original files:

- `services/logicsService.js`
- `services/callRailService.js`
- `ringBridge/services/callRailStatsService.js`
- `ringBridge/services/hourlySyncService.js`

What this tells us:

- sourcing is a follow-up process that checks what was written
- attribution often requires CallRail plus Logics lookup
- this belongs in the control plane as a reconciliation/audit domain

### Data hygiene and nightly cleanup

Original files:

- `ringBridge/services/nightlyCaseHealthService.js`
- `services/statusChecker.js`

What this tells us:

- deactivation, purge, archive, and health snapshots are control-plane jobs
- they should become durable worker workflows instead of timer-local behavior

### List cleaning and review

Original files:

- `controllers/listCleanerController.js`
- `utils/clientListCleaner.js`
- `utils/prospectListCleaner.js`
- `routes/cleaner.js`

What this tells us:

- client/prospect cleaning is already an internal admin workflow
- the current implementation stores job state in memory
- the parallel control plane should move this into durable event-backed jobs

### Frontend durable reads

Original files:

- `controllers/listController.js`
- `client/src/components/tools/smsinbox/SmsInbox.js`
- `client/src/components/tools/metrics/MetricsDashboard.js`

What this tells us:

- many admin/operator pages need durable database-backed reads
- text lists, contact history, metrics views, and case/profile reads should
  come from `5001`

## Near-term extraction order

1. Control-plane domain registry and route surface
2. Shared Logics reconciliation service boundaries
3. Shared metrics query/materialization boundaries
4. Shared sourcing/attribution boundaries
5. Shared list-cleaning job boundaries
6. Thin `5001` routes that call those shared services
