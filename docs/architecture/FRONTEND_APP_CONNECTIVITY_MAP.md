# Frontend App Connectivity Map

## Purpose

This document translates the current frontend/product wish list into a backend-facing map for `5001`.

It is meant to make frontend implementation smoother by answering:

- which app/workspace should exist
- what backend read surfaces already exist
- what command surfaces should exist next
- which port actually owns the execution behind the UI

The guiding rule remains:

- `3001` should talk only to `5001`

Everything else should be hidden behind control-plane reads, commands, workflows, work-lists, and events.

---

## Core rule set

### Implemented page-shaped `5001` reads

These route families already exist and should be preferred over inventing new frontend-specific endpoint shapes:

- `/api/read/workspace/:domain`
- `/api/read/metrics/*`
- `/api/read/inbox/:domain`
- `/api/read/clients/*`
- `/api/read/review/*`
- `/api/read/schedules/*`
- `/api/read/ringcentral/*`
- `/api/read/deploy/:domain`
- `/api/read/library/:domain`
- `/api/dispatch/*`
- `/api/worklists/*`
- `/api/workflows/*`

### Reads

All page data should come from `5001`.

That means:

- no direct frontend calls to `4001`
- no direct frontend calls to `4002`
- no direct frontend calls to `6101`

### Writes

Frontend writes should usually become:

- commands
- work-list build requests
- dispatch requests
- review actions
- schedule actions

Not:

- direct provider operations
- direct port-to-port orchestration

### Execution ownership

- `4001`
  intake only

- `4002`
  non-call outbound execution

- `6101`
  RingCentral / CX / EX runtime and future dial execution

- `5001`
  orchestration, policy, materialization, review, metrics, frontend read surfaces

---

## Workspace map

## 1. Metrics Workspace

### Product intent

- lead metrics
- source performance
- spend
- redlines
- payment alerting
- call aggregates
- mail-cost views

### Existing `5001` reads

- `GET /api/read/metrics/:domain`
- `GET /api/read/metrics/sources/:domain`
- `GET /api/read/metrics/mail-cost/:domain`
- `GET /api/read/metrics/redlines/:domain`
- `GET /api/read/metrics/daily-summary/:domain`
- `GET /api/read/metrics/callrail`

### Backend truth

This workspace is already one of the best aligned with the current backend.

The remaining work is mostly:

- frontend expression
- metric naming refinement
- richer source/payment/spend joins over time

### Recommended frontend shape

- top KPI row
- daily summary panel
- source performance table
- spend/mail-cost panel
- redline alert panel
- payment alerts panel
- call aggregate panel

### Recommended next backend additions

- `GET /api/read/metrics/:domain/timeseries`
- `GET /api/read/metrics/:domain/source/:sourceKey`
- `GET /api/read/metrics/:domain/payments`

---

## 2. RingBridge Workspace

### Product intent

- live agent presence
- current calls
- availability / on-call / disposition states
- agent wallboard
- telephony event awareness
- eventually scored calls and call review

### Existing `5001` reads

- `GET /api/read/ringcentral/workspace/:domain`
- `GET /api/read/ringcentral/presence/:domain`
- `GET /api/read/clients/case/:domain/:caseId`
  can already expose latest QC/conversation summaries at case level

### Existing `5001` command/ops surfaces

- `GET /api/ringcentral/status`
- `POST /api/ringcentral/reinitialize`

### Execution owner

- `6101`

### Recommended frontend shape

- live stats bar
- agent card grid
- current call detail
- recent RC event feed
- RC runtime / poller / auth state

### Recommended next backend additions

- `GET /api/read/ringcentral/:domain/runtime`
- `GET /api/read/ringcentral/:domain/events`
- `GET /api/read/ringcentral/:domain/call-log`
- `GET /api/read/ringcentral/:domain/scored-calls`

### Important note

This workspace should be a `3001` workspace powered by `5001`.
It should not become a separate frontend that talks directly to `6101`.

---

## 3. Deploy Workspace

### Product intent

- deploy overview
- deploy targets
- last deploy status
- content push vs full deploy distinction
- operational visibility

### Existing `5001` reads

Indirectly available today:

- `/api/health/*`
- topology/health/provider views

### Gaps

No dedicated deploy workspace routes yet.

### Recommended backend additions

- `GET /api/read/deploy/overview`
- `GET /api/read/deploy/targets`
- `GET /api/read/deploy/history`
- `GET /api/read/deploy/content-sync`

- `POST /api/commands/deploy/full`
- `POST /api/commands/deploy/content-push`
- `POST /api/commands/deploy/restart-service`

### Recommended frontend shape

- deploy summary header
- targets table
- recent jobs
- content sync card
- operations warnings

---

## 4. SMS Inbox Workspace

### Product intent

- inbox of conversations
- pending AI drafts
- approve / cancel / edit / regenerate
- sleep / wake
- suppression / DNC handling
- job/campaign-aware AI behavior later

### Existing `5001` data primitives

- `ConversationWorkflow`
- `WorkflowRecord`
- `ReviewQueueItem`
- latest conversation summary on `CaseProfile`
- `/api/workflows`
- review and client detail reads

### Existing event substrate

- `/sms/inbound`
  forwarded into `5001`

### Gaps

The canonical workflow objects exist, but there is no dedicated inbox read/command family yet.

### Recommended backend additions

- `GET /api/read/inbox/:domain/overview`
- `GET /api/read/inbox/:domain/conversations`
- `GET /api/read/inbox/:domain/conversation/:id`
- `GET /api/read/inbox/:domain/settings`

- `POST /api/commands/inbox/:id/approve`
- `POST /api/commands/inbox/:id/cancel`
- `POST /api/commands/inbox/:id/edit-send`
- `POST /api/commands/inbox/:id/regenerate`
- `POST /api/commands/inbox/:id/sleep`
- `POST /api/commands/inbox/:id/wake`
- `POST /api/commands/inbox/:id/dnc`
- `PUT /api/commands/inbox/settings`

### Execution owner

- `5001` owns workflow state
- `4002` should own actual outbound SMS execution

---

## 5. Contact Library Workspace

### Product intent

- browse text templates
- browse email templates
- browse RVM templates / mail pieces
- render/edit reusable content
- organize content by campaign/job/channel

### Existing related concepts

- old `textMessageLibrary`
- old `Templates`
- current dispatch/work-list pattern

### Gaps

No dedicated library read surface yet.

### Recommended backend additions

- `GET /api/read/library/contact-copy`
- `GET /api/read/library/contact-copy/:id`
- `GET /api/read/library/contact-copy/search`
- `GET /api/read/library/mail-pieces`
- `GET /api/read/library/email-templates`

- `POST /api/commands/library/contact-copy`
- `PUT /api/commands/library/contact-copy/:id`
- `POST /api/commands/library/mail-piece`
- `PUT /api/commands/library/mail-piece/:id`

### Recommended frontend shape

- channel tabs
- search/filter
- preview panel
- metadata/tags
- assignment to jobs/campaigns

---

## 6. Manual Campaign / Dispatch Workspace

### Product intent

- manual text campaigns
- manual email campaigns
- manual RVM jobs
- future CX dial jobs
- choose audience from shallow prospects or case profiles
- schedule jobs over time ranges

### Existing `5001` surfaces

- `POST /api/dispatch/build`
- `POST /api/dispatch/queue`
- `GET /api/dispatch/:domain`
- `GET /api/dispatch/item/:id`
- `POST /api/worklists/build`
- `POST /api/worklists/queue`
- `GET /api/worklists/:domain`
- `GET /api/workflows/:domain`

### Execution owners

- `4002` for text/email/RVM
- `6101` for future CX/dial work

### Recommended frontend shape

- audience builder
- filter builder
- schedule/range controls
- pacing controls
- preview count
- resulting dispatch/work-list inspection

### Recommended next backend additions

- `GET /api/read/dispatch/:domain/templates`
- `GET /api/read/dispatch/:domain/history`
- `POST /api/commands/dispatch/build-from-search`
- `POST /api/commands/dispatch/build-from-caseprofiles`

---

## 7. Cleaning / Enrichment Workspace

### Product intent

- client/prospect cleaning
- enrichment review
- exception handling
- activities / source / status / payment check review
- human review queues

### Existing `5001` reads

- `GET /api/read/review/overview/:domain`
- `GET /api/read/review/queue/:domain`
- `GET /api/hygiene/hourly-plan`
- `GET /api/hygiene/daily-plan`
- `GET /api/hygiene/review-feed/:domain`
- client detail/search routes

### Existing AI substrate

- activity AI review on `CaseProfile`
- `ActivityAiReview`
- `QualityReview`

### Recommended next backend additions

- `GET /api/read/review/:domain/scrubs`
- `GET /api/read/review/:domain/enrichment`
- `GET /api/read/review/:domain/activity-ai`
- `GET /api/read/review/:domain/payment-checks`

- `POST /api/commands/review/:id/resolve`
- `POST /api/commands/review/:id/replay`
- `POST /api/commands/review/:id/promote`

---

## 8. Client / Prospect Portal

### Product intent

- one place to open any prospect/client
- see merged shallow + normalized state
- perform targeted actions
- schedule or dispatch from that client
- create activities/tasks
- enrich / suppress / review

### Existing `5001` reads

- `GET /api/read/clients/search/:domain`
- `GET /api/read/clients/case/:domain/:caseId`

### Existing client detail content

Already includes:

- latest activity AI review
- latest QC review
- latest conversation workflow
- recent workflow stages

### Recommended next backend additions

- `GET /api/read/clients/:domain/:caseId/timeline`
- `GET /api/read/clients/:domain/:caseId/actions`
- `GET /api/read/clients/:domain/:caseId/dispatch-history`

- `POST /api/commands/clients/:domain/:caseId/enrich`
- `POST /api/commands/clients/:domain/:caseId/create-activity`
- `POST /api/commands/clients/:domain/:caseId/create-task`
- `POST /api/commands/clients/:domain/:caseId/update-schedule`
- `POST /api/commands/clients/:domain/:caseId/dispatch`
- `POST /api/commands/clients/:domain/:caseId/suppress`

---

## 9. Schedule / Mail Piece Workspace

### Product intent

- see contact schedule
- move schedule around
- assign new pieces
- track active mail pieces
- manipulate future contact cadence
- eventually interact with mail house processes

### Existing `5001` reads

- `GET /api/read/schedules/overview/:domain`
- `GET /api/read/schedules/cadence/:domain`
- work-lists / dispatch lists

### Gaps

Needs a stronger calendar/timeline and piece assignment layer.

### Recommended next backend additions

- `GET /api/read/schedules/:domain/calendar`
- `GET /api/read/schedules/:domain/pieces`
- `GET /api/read/schedules/:domain/case/:caseId`
- `GET /api/read/schedules/:domain/active-mail`

- `POST /api/commands/schedules/build-mail-job`
- `POST /api/commands/schedules/reassign-piece`
- `POST /api/commands/schedules/move-range`
- `POST /api/commands/schedules/case/:caseId/pause`
- `POST /api/commands/schedules/case/:caseId/resume`

---

## 10. CX User Portal

### Product intent

- smaller role-specific workspace
- manual texting via EX later
- templated email through SendGrid
- manual status setting
- dispositioning
- call cycling support
- outbound calling through CX/ringout using the agent's EX number
- task/reminder creation
- locate/create Logics cases
- look up leads by phone number while serving them through CX
- one-click lead statusing in Logics

### Existing relevant backend surfaces

- RingCentral presence state
- client search/detail
- Logics routes
- review/workflow substrate
- `GET /api/read/cx/workspace/:domain`
- `GET /api/read/cx/call-queue/:domain`
- `GET /api/read/cx/tasks/:domain`
- `GET /api/read/cx/search/:domain`
- `GET /api/read/cx/logics/match/:domain`
- `GET /api/read/cx/logics/tasks/:domain`
- `POST /api/commands/cx/:domain/set-status`
- `POST /api/commands/cx/:domain/disposition`
- `POST /api/commands/cx/:domain/create-task`
- `POST /api/commands/cx/:domain/create-reminder`
- `POST /api/commands/cx/:domain/text`
- `POST /api/commands/cx/:domain/email`
- `POST /api/commands/cx/:domain/dial`
- `POST /api/commands/cx/:domain/logics/create-case`
- `POST /api/commands/cx/:domain/logics/find-match`
- `POST /api/commands/cx/:domain/logics/update-status`
- `POST /api/commands/cx/:domain/logics/task`
- `POST /api/commands/cx/:domain/logics/activity`
- `POST /api/commands/cx/:domain/logics/update-case`
- `POST /api/commands/cx/:domain/logics/invoice`
- `POST /api/commands/cx/:domain/logics/amortization`

### Recommended backend additions

- `POST /api/commands/cx/:domain/complete-task`
- `POST /api/commands/cx/:domain/complete-reminder`
- `GET /api/read/cx/history/:domain`
- `POST /api/commands/cx/:domain/logics/document`

### Execution model clarification

- EX text:
  command originates on `5001`
  execution should eventually live with RingCentral/EX ownership

- Email:
  command originates on `5001`
  execution should ultimately route through SendGrid-backed outbound handling

- Dial:
  command originates on `5001`
  execution should ultimately route through CX/ringout with the agent's EX number as caller identity

- CX:
  primarily status/routing management, not the canonical home for texting/email logic

- Logics:
  remains the system of record for case lookup, tasking, and lead/client status changes

### Important note

This workspace should remain role-limited and much narrower than the admin/operator side.

---

## Recommended implementation order

If the goal is to make frontend connection smooth quickly, the best order is:

1. Metrics workspace
2. RingBridge workspace
3. SMS inbox workspace
4. Client/prospect portal
5. Schedule / dispatch builder
6. Contact library
7. Deploy workspace
8. CX user portal

---

## Backend-first principles for Claude's frontend pass

If frontend components are being brought over now, they should follow these rules:

- preserve useful product concepts from old apps
- do not preserve old route assumptions
- do not talk to execution ports directly
- expect `5001` page-shaped reads
- if a route is missing, note the exact `5001` route needed instead of creating a workaround against another port

---

## Bottom line

The smoothest path is not:

- "port old frontend components and then make the backend fit them"

The smoothest path is:

- keep the best old component/workspace ideas
- bind them to `5001` route families
- let `5001` stay the integration layer for everything the frontend needs

That keeps the frontend moving forward without undoing the current backend architecture.
