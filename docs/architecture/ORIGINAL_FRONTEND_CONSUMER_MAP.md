# Original Frontend Consumer Map

This document maps confirmed frontend consumers in the original `TagContactBridge`
client to the backend API families they call today.

Use this alongside `ORIGINAL_API_INVENTORY.md` to distinguish:

- exposed endpoints
- actively consumed endpoints
- mismatches or stale client assumptions

## Core Context Consumers

### Auth (`client/src/context/auth/AuthState.js`)

Confirmed calls:

- `GET /api/auth/me`
- `POST /api/auth/send-code`
- `POST /api/auth/verify-code`
- `POST /api/auth/logout`

Notes:

- This is the active login/current-user contract in the root app shell.

### Admin / consent vault (`client/src/context/admin/AdminState.js`)

Confirmed calls:

- `GET /api/admin/consent-records`
- `GET /api/admin/consent-records/:id`
- `GET /api/admin/consent-stats`

Notes:

- This is a confirmed consumer of the consent/admin surface and should be preserved in
  the shared admin domain.

### Clients (`client/src/context/client/ClientState.js`)

Confirmed calls:

- `POST /api/clients/uploadDocument`
- `POST /api/clients/enrichClient`
- `POST /api/clients/zeroInvoice`
- `POST /api/clients/createTask`
- `POST /api/clients/createActivity`
- `POST /api/clients`
- `POST /api/clients/delete`
- `POST /api/clients/reviewSaleDate`
- `POST /api/clients/reviewCreateDate`

Notes:

- These cluster naturally into:
  - case/client file actions
  - enrichment/billing actions
  - review workflow actions

### Email (`client/src/context/email/EmailState.js`)

Confirmed calls:

- `POST /api/emails/send`
- `GET /api/emails/stats`
- `POST /api/emails/daily`

Notes:

- The client expects `/api/emails/stats`.
- That endpoint did not appear in the currently discovered `routes/emails.js` route
  declarations and should be verified as either:
  - implemented indirectly
  - removed/stale in the frontend
  - missing from the route file scan because of non-router declaration style

### List tools (`client/src/context/list/ListState.js`)

Confirmed calls:

- `POST /api/list/postNCOA`
- `POST /api/list/appendContactInfo`
- `POST /api/list/buildLienList`
- `POST /api/list/download-and-email-daily`
- `POST /api/list/buildPeriod`
- `POST /api/list/addCreateDateClients`
- `GET /api/list/reviewClients`
- `POST /api/list/parseZeros`
- `POST /api/list/validate`
- `POST /api/list/filterList`
- `POST /api/list/search`

Notes:

- `GET /api/list/reviewClients` is actively consumed by the client.
- It did not appear in the initial `routes/list.js` router scan and should be verified.

### Schedule / dialer (`client/src/context/schedule/ScheduleState.js`)

Confirmed calls:

- `GET /api/schedule/wynn-leads`
- `POST /api/schedule/start-wynn`
- `GET /api/schedule/tag-leads`
- `POST /api/schedule/start-tag`
- `GET /api/schedule/status`
- `POST /api/schedule/stop`
- `POST /api/schedule/pause`
- `POST /api/schedule/resume`

Notes:

- This is a complete active consumer family and a good candidate for a shared
  outbound-dialer domain contract.

### SMS inbox (`client/src/context/sms/SmsState.js`)

Confirmed calls:

- `GET /api/sms/conversations`
- `GET /api/sms/conversations/:id`
- `GET /api/sms/stats`
- `GET /api/sms/settings`
- `PUT /api/sms/settings`
- `POST /api/sms/conversations/:id/approve`
- `POST /api/sms/conversations/:id/cancel`
- `POST /api/sms/conversations/:id/edit`
- `POST /api/sms/conversations/:id/send`
- `POST /api/sms/conversations/:id/regenerate`
- `POST /api/sms/conversations/:id/sleep`
- `POST /api/sms/conversations/:id/wake`

Notes:

- These are a strong shared-domain candidate for:
  - conversation queries
  - response moderation
  - bot state toggles
  - settings

### Text sending (`client/src/context/text/TextState.js`)

Confirmed calls:

- `POST /api/texts/send`
- `POST /api/texts/daily`

## RingBridge / Metrics Consumers

### Metrics dashboard (`client/src/components/tools/metrics/MetricsDashboard.js`)

Confirmed calls through `/ringbridge/api/...`:

- `GET /ringbridge/api/admin/spend`
- `GET /ringbridge/api/admin/source-canonicals`
- `GET /ringbridge/api/admin/caseprofiles/stats`
- `GET /ringbridge/api/admin/callrail/stats`
- `GET /ringbridge/api/admin/contacts/stats/by-source`
- `GET /ringbridge/api/admin/callrail/live`
- `GET /ringbridge/api/admin/spend/summary`
- `GET /ringbridge/api/admin/contacts/stats/summary`
- `GET /ringbridge/api/admin/redlines`
- `GET /ringbridge/api/admin/callrail/summary`
- `GET /ringbridge/api/admin/payments/today`
- `GET /ringbridge/api/admin/leads/today`
- `GET /ringbridge/api/admin/daily-summary`
- `POST /ringbridge/api/admin/spend/sync`
- `POST /ringbridge/api/admin/caseprofiles/manual`

Notes:

- This dashboard is one of the clearest examples of why a shared metrics domain is
  needed before further service extraction.
- It currently knows about many raw backend slices directly.

## Likely Additional RingBridge Consumers

The search pass also showed live API usage in:

- `components/tools/ringcentral/RingBridgeDashboard.jsx`
- `components/tools/ringcentral/CallLogPanel.jsx`
- `components/tools/ringcentral/ScoredCallsPanel.jsx`
- `components/tools/metrics/RedlinePanel.jsx`

These should be extracted next to finish the consumer map for:

- agent state
- SSE event stream
- scored call/contact exports
- redline workflow
- widget/user interactions

## Confirmed Consumer-to-Domain Candidates

Based on currently verified frontend usage, the strongest shared-domain groupings are:

- `auth`
- `admin consent`
- `clients / cases`
- `email delivery`
- `text delivery`
- `sms conversations`
- `list processing`
- `dialer scheduling`
- `metrics / spend / callrail / summaries`
- `ring workspace / agent state`

## Known Gaps / Mismatches To Verify

- `GET /api/emails/stats` is consumed by the frontend but not yet confirmed in the
  route scan.
- `GET /api/list/reviewClients` is consumed by the frontend but not yet confirmed in
  the route scan.
- RingBridge frontend consumers still need a full call-by-call extraction beyond the
  metrics dashboard.
