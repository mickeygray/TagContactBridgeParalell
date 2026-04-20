# 5001 Frontend Route Plan

## Goal

`5001` should be the single frontend-facing control-plane API for `3001`.

That means:
- `3001` talks only to `5001`
- `5001` reads Mongo and returns page-shaped data
- execution ports (`4001`, `4002`, `6101`) do not become ad hoc frontend APIs
- writes from the frontend should mostly become instructions, not direct provider actions

## Original UI surfaces reviewed

From the original client, the main tool surfaces are:

- `SMS Intelligence` / inbox
- `Email Campaign Sender`
- `SMS Campaign Sender`
- `CallFire Auto-Dialer`
- `Phone/Email Scrubber`
- `NCOA Direct Mail Prep`
- `TCPA Consent Vault`
- `Metrics Dashboard`
- `Redline Panel`
- `RingBridge Dashboard`
- `Call Log Panel`
- `Scored Calls Panel`
- deploy panel / deployment guide
- unified client search / client review / per-client enrichment
- schedule funnel / daily schedule manager / new client creation

These should not map 1:1 to old endpoints.
They should map to a cleaner `5001` route surface grouped by user intent.

## Route families

### 1. Workspace shell

Purpose:
- load the top-level dashboard shell
- return what panels, counts, warnings, and nav state should show first

Recommended routes:

- `GET /api/read/workspace/:domain/overview`
  Returns:
  - top counters
  - unread review counts
  - active dispatch counts
  - current agent presence summary
  - latest nightly/hourly run summary
  - deploy/ops warning badges

- `GET /api/read/workspace/:domain/navigation`
  Returns:
  - enabled tools
  - role-based access flags
  - active warning counts by area

### 2. Metrics and redlines

Purpose:
- replace the old mixed metrics/redline panel with stable read APIs

Recommended routes:

- `GET /api/read/metrics/:domain/overview`
  Returns:
  - daily metrics snapshot
  - lifetime metrics snapshot
  - new leads
  - new prospects
  - new clients
  - payments observed
  - outbound attempts
  - enrichment counts

- `GET /api/read/metrics/:domain/timeseries`
  Filters:
  - `metricName`
  - `range`
  - `bucket`
  - `sourceKey`

- `GET /api/read/metrics/:domain/sources`
  Returns:
  - source totals
  - source-by-metric family
  - spend vs lead counts where available

- `GET /api/read/redlines/:domain`
  Returns:
  - current redline issues
  - counts by category
  - affected case ids
  - latest detected timestamps

- `GET /api/read/mail-costs/:domain`
  Returns:
  - daily spend
  - direct mail counts
  - cost by source / list

### 3. Dispatch and send schedulers

Purpose:
- power the scheduler / dialer / manual send surfaces
- let operators inspect the exact buffered list that will be consumed

Recommended routes:

- `GET /api/dispatch/:domain`
  Already added.
  Use for:
  - recent dispatch lists
  - channel/mode/status filtering

- `GET /api/dispatch/item/:id`
  Already added.
  Use for:
  - inspecting one buffered list and its members

- `POST /api/dispatch/build`
  Already added.

- `POST /api/dispatch/queue`
  Already added.

Additional planned routes:

- `GET /api/read/schedules/:domain/overview`
  Returns:
  - lead cadence counts by stage
  - next due buckets by channel
  - paused/failed cadence counts

- `GET /api/read/schedules/:domain/cadence`
  Filters:
  - `channel`
  - `stage`
  - `status`
  - `dueBefore`
  - `intakeSource`

- `GET /api/read/schedules/:domain/calendar`
  Returns:
  - future scheduled actions in timeline form

- `GET /api/read/schedules/:domain/case/:caseId`
  Returns:
  - one case cadence plan
  - action history
  - next scheduled actions

- `POST /api/commands/schedules/build-dispatch`
  Writes:
  - build dispatch list from filters
  - queue it for `4002` or `6101`

- `POST /api/commands/schedules/case/:caseId/pause`
- `POST /api/commands/schedules/case/:caseId/resume`
- `POST /api/commands/schedules/case/:caseId/rebuild`
- `POST /api/commands/schedules/case/:caseId/cancel-action`

### 4. Contact library

Purpose:
- browse reusable text/email/RVM copy
- support one-off contact attempts without embedding message bodies in components

Recommended routes:

- `GET /api/read/library/contact-copy`
  Returns:
  - texts
  - emails
  - RVM templates
  - tags / categories
  - active/inactive flags
  - channel compatibility

- `GET /api/read/library/contact-copy/:id`

- `GET /api/read/library/contact-copy/search`
  Filters:
  - `channel`
  - `tag`
  - `status`
  - `query`

- `POST /api/commands/library/contact-copy`
- `PUT /api/commands/library/contact-copy/:id`
- `POST /api/commands/library/contact-copy/:id/archive`

Notes:
- initial data can come from stored documents or file-backed templates
- old email HTML templates are a source, not a final API shape

### 5. RingCentral presence and call surfaces

Purpose:
- replace the old RingBridge dashboard as a `5001` read surface over `6101`/Mongo state

Recommended routes:

- `GET /api/read/ringcentral/:domain/presence`
  Returns:
  - agent presence rows
  - EX telephony status
  - CX desired availability
  - current call info
  - last event / stale flags

- `GET /api/read/ringcentral/:domain/presence/:extensionId`

- `GET /api/read/ringcentral/:domain/call-log`
  Returns:
  - recent resolved call-ended events
  - telephony session ids
  - source attribution where known

- `GET /api/read/ringcentral/:domain/scored-calls`
  Returns:
  - scored call records from the 4000s scoring loop
  - transcript summary
  - disposition
  - red flags / positives

- `GET /api/read/ringcentral/:domain/agent-history`
  Filters:
  - `extensionId`
  - `range`

Write/instruction routes:

- `POST /api/commands/ringcentral/reinitialize`
- `POST /api/commands/ringcentral/presence/seed`
- `POST /api/commands/ringcentral/presence/poll`

### 6. Review and scrub surfaces

Purpose:
- power list scrubber, hygiene review, AI review, and manual exception handling

Recommended routes:

- `GET /api/read/review/:domain/queue`
  Filters:
  - `category`
  - `severity`
  - `workflow`
  - `status`

- `GET /api/read/review/:domain/scrubs`
  Returns:
  - STOP/DNC detections
  - outbound failures
  - redlines
  - enrichment-needed items

- `GET /api/read/review/:domain/deep-cut-runs`
- `GET /api/read/review/:domain/hourly-feed`
- `GET /api/read/review/:domain/ai-activity`

Write routes:

- `POST /api/commands/review/:id/resolve`
- `POST /api/commands/review/:id/replay`
- `POST /api/commands/review/:id/promote`
- `POST /api/commands/review/:id/suppress`

### 7. Client getter / per-client control surface

Purpose:
- one place to open a client or prospect and do whatever needs to be done

Recommended routes:

- `GET /api/read/clients/:domain/search`
  Filters:
  - `caseId`
  - `phone`
  - `email`
  - `name`
  - `statusCategory`
  - `source`

- `GET /api/read/clients/:domain/:caseId`
  Returns:
  - merged case profile
  - shallow prospect data if present
  - payment summary
  - latest AI review
  - review queue items
  - cadence state
  - dispatch history
  - contact history references

- `GET /api/read/clients/:domain/:caseId/timeline`
  Returns:
  - payments
  - activities
  - outbound attempts
  - inbound events
  - review flags

- `GET /api/read/clients/:domain/:caseId/actions`
  Returns:
  - available commands for this user
  - disabled reasons

Write routes:

- `POST /api/commands/clients/:domain/:caseId/enrich`
- `POST /api/commands/clients/:domain/:caseId/review-ai`
- `POST /api/commands/clients/:domain/:caseId/create-activity`
- `POST /api/commands/clients/:domain/:caseId/create-task`
- `POST /api/commands/clients/:domain/:caseId/upload-document`
- `POST /api/commands/clients/:domain/:caseId/dispatch`
- `POST /api/commands/clients/:domain/:caseId/update-schedule`
- `POST /api/commands/clients/:domain/:caseId/suppress`

### 8. Deploy hub / operations

Purpose:
- preserve deploy panel / health / reinit without mixing it into dashboard reads

Recommended routes:

- `GET /api/read/ops/overview`
  Returns:
  - health rollup by port
  - dead letters
  - queue backlogs
  - latest failures

- `GET /api/read/ops/events`
  Filters:
  - `status`
  - `eventType`
  - `sourceService`

- `GET /api/read/ops/providers`
  Returns:
  - Logics
  - CallRail
  - RingCentral
  - SendGrid
  - Drop
  readiness summaries

Write routes:

- `POST /api/commands/ops/replay-event/:id`
- `POST /api/commands/ops/process-batch/:worker`
- `POST /api/commands/ops/provider/:provider/reinitialize`

## Recommended code organization in 5001

Do not keep expanding one generic `read.js`.

Recommended route files:

- `routes/readWorkspace.js`
- `routes/readMetrics.js`
- `routes/readSchedules.js`
- `routes/readLibrary.js`
- `routes/readRingcentral.js`
- `routes/readReview.js`
- `routes/readClients.js`
- `routes/readOps.js`
- `routes/commandsDispatch.js`
- `routes/commandsClients.js`
- `routes/commandsOps.js`

That keeps `5001` broad in capability but narrow in file-level concerns.

## Current status

Already live and useful:

- auth
- overview/prospects/case-profiles/payments reads
- grouped first-pass reviewer reads:
  - `GET /api/read/metrics/:domain`
  - `GET /api/read/metrics/sources/:domain`
  - `GET /api/read/metrics/mail-cost/:domain`
  - `GET /api/read/metrics/redlines/:domain`
  - `GET /api/read/metrics/daily-summary/:domain`
  - `GET /api/read/metrics/callrail`
  - `GET /api/read/schedules/overview/:domain`
  - `GET /api/read/schedules/cadence/:domain`
  - `GET /api/read/review/overview/:domain`
  - `GET /api/read/review/queue/:domain`
  - `GET /api/read/clients/search/:domain`
  - `GET /api/read/clients/case/:domain/:caseId`
  - `GET /api/read/ringcentral/presence/:domain`
- dispatch list build/queue/list/get
- generic work-list build/queue/list/get
- workflow history read surface
- client detail now includes latest activity AI review, latest QC review, latest conversation workflow, and recent workflow stages
- hygiene/hourly/daily run surfaces
- ringcentral status / rc runtime surfaces

Not fully expressed yet:

- workspace-level overview for `3001`
- contact library
- client timeline/actions/history endpoints
- schedule calendar and per-case schedule command endpoints
- ringcentral call-log/scored-call frontend reads
- command routes grouped by surface

## Core principle

Frontend should mostly:
- read page-shaped data from `5001`
- send commands to `5001`

Execution ports should mostly:
- consume events
- read Mongo by ids or list ids
- write outcomes back as events or normalized state

That keeps proxying simple and keeps the UI from depending on provider-specific ports.
