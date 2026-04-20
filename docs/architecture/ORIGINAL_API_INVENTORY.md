# Original TagContactBridge API Inventory

This is a backend-first inventory of the currently exposed API/webhook surface in
`C:\Users\Admin\Code\TagContactBridge`.

It is intended to answer two questions for the parallel rebuild:

1. What endpoints exist today?
2. Which of those should become shared domain capabilities versus thin gateway endpoints?

## Runtime Mounts

### Root app (`server.js`, port `5000`)

Mounted prefixes:

- `/api/auth` -> `routes/auth.js`
- `/api/calls` -> `routes/recording.js`
- `/api/list` -> `routes/list.js`
- `/api/admin` -> `routes/admin.js`
- `/api/invite` -> `routes/invite.js`
- `/api/emails` -> `routes/emails.js`
- `/api/sms` -> `routes/sms.js`
- `/api/cleaner` -> `routes/cleaner.js`
- `/api/texts` -> `routes/texts.js`
- `/api/schedule` -> `routes/schedule.js`
- `/api/clients` -> `routes/clients.js`
- `/sms/inbound` -> direct `server.js` endpoint

### Webhook app (`webhook.js`, port `4000`)

Direct endpoints:

- `GET /pb/auth`
- `GET /pb/callback`
- `GET /fb/webhook`
- `POST /fb/webhook`
- `GET /tt/webhook`
- `GET /tt/oauth/start`
- `GET /tt/oauth/callback`
- `GET /tt/oauth/status`
- `POST /sms/inbound`
- `POST /tt/webhook`
- `POST /lead-contact`
- `POST /test-lead`
- `GET /status`
- `POST /lead-contact/pre-ping`
- `POST /drop-webhook`
- `GET /drop-balance`

### RingBridge app (`ringBridge/server.js`, port `6100`)

Mounted prefixes:

- `/api` -> `ringBridge/routes/apiRoutes.js`
- `/webhook` -> `ringBridge/routes/webhookRoutes.js`

Also:

- `GET /` -> dashboard HTML

Note:

- The frontend currently calls these through `/ringbridge/api/...`, which suggests a
  reverse-proxy/public path in front of the standalone RingBridge service.

## Root API Endpoints

### Auth

- `GET /api/auth/me`
- `GET /api/auth/check`
- `POST /api/auth/send-code`
- `POST /api/auth/verify-code`
- `POST /api/auth/logout`

### Admin / consent vault

- `GET /api/admin/consent-records`
- `GET /api/admin/consent-records/:id`
- `GET /api/admin/consent-stats`

### Cleaner

- `POST /api/cleaner/clients`
- `GET /api/cleaner/status/:jobId`
- `POST /api/cleaner/prospects-phone`
- `POST /api/cleaner/prospects-email`

### Clients

- `POST /api/clients/uploadDocument`
- `POST /api/clients/enrichClient`
- `POST /api/clients/zeroInvoice`
- `POST /api/clients/createTask`
- `POST /api/clients/createActivity`
- `POST /api/clients/`
- `POST /api/clients/reviewSaleDate`
- `POST /api/clients/reviewCreateDate`
- `POST /api/clients/delete`

### Emails

- `POST /api/emails/send`
- `POST /api/emails/daily`
- `GET /api/emails/templates`
- `GET /api/emails/templates/:name`
- `POST /api/emails/templates/:name`
- `DELETE /api/emails/templates/:name`

### Invite

- `POST /api/invite/`
- `GET /api/invite/:token`
- `POST /api/invite/:token`

### List

- `POST /api/list/download-and-email-daily`
- `POST /api/list/postNCOA`
- `POST /api/list/search`
- `POST /api/list/addCreateDateClients`
- `POST /api/list/parseZeros`
- `POST /api/list/buildLienList`
- `POST /api/list/buildPeriod`
- `POST /api/list/appendContactInfo`
- `POST /api/list/validate`
- `POST /api/list/filterList`

### Recording / calls

- `GET /api/calls/:callId`

### Schedule

- `GET /api/schedule/wynn-leads`
- `GET /api/schedule/tag-leads`
- `POST /api/schedule/start-wynn`
- `POST /api/schedule/start-tag`
- `GET /api/schedule/status`
- `POST /api/schedule/stop`
- `POST /api/schedule/pause`
- `POST /api/schedule/resume`

### SMS inbox

- `GET /api/sms/stats`
- `GET /api/sms/conversations`
- `GET /api/sms/conversations/:id`
- `POST /api/sms/conversations/:id/approve`
- `POST /api/sms/conversations/:id/cancel`
- `POST /api/sms/conversations/:id/edit`
- `POST /api/sms/conversations/:id/send`
- `POST /api/sms/conversations/:id/regenerate`
- `POST /api/sms/conversations/:id/sleep`
- `POST /api/sms/conversations/:id/wake`
- `POST /api/sms/conversations/:id/dnc`
- `GET /api/sms/settings`
- `PUT /api/sms/settings`

### Text senders

- `POST /api/texts/send`
- `POST /api/texts/daily`

### Root direct webhook

- `POST /sms/inbound`

## Webhook / intake Endpoints

### PhoneBurner / deploy / intake / platform webhooks

- `GET /pb/auth`
- `GET /pb/callback`
- `GET /fb/webhook`
- `POST /fb/webhook`
- `GET /tt/webhook`
- `GET /tt/oauth/start`
- `GET /tt/oauth/callback`
- `GET /tt/oauth/status`
- `POST /sms/inbound`
- `POST /tt/webhook`
- `POST /lead-contact`
- `POST /test-lead`
- `GET /status`
- `POST /lead-contact/pre-ping`
- `POST /drop-webhook`
- `GET /drop-balance`

## RingBridge API Endpoints

These are mounted internally under `/api`, and are often consumed externally as
`/ringbridge/api/...`.

### Redlines / payment alerts

- `GET /api/admin/redlines`
- `POST /api/admin/redlines/:id/suppress`
- `POST /api/admin/redlines/send-texts`
- `POST /api/admin/redlines/:id/unsuppress`

### Event stream / health

- `GET /api/events`
- `GET /api/health`

### Agents / admin state

- `GET /api/admin/agents`
- `GET /api/admin/source-canonicals`
- `GET /api/admin/case-health-rollup`
- `POST /api/admin/agents`
- `DELETE /api/admin/agents/:extensionId`
- `POST /api/admin/agents/:extensionId/override`
- `GET /api/admin/extensions`
- `GET /api/admin/extensions/:extensionId/presence`
- `GET /api/admin/webhooks`
- `POST /api/admin/webhooks/reinitialize`
- `GET /api/admin/events`

### Widget / user interactions

- `GET /api/widget/status/:extensionId`
- `POST /api/widget/disposition`
- `POST /api/widget/available`
- `POST /api/widget/away`

### Contacts / exports / contact intelligence

- `GET /api/admin/contacts`
- `GET /api/admin/contacts/csv`
- `GET /api/admin/contacts/export/grouped`
- `GET /api/admin/contacts/stats/summary`
- `GET /api/admin/contacts/scored`
- `GET /api/admin/contacts/scored/all`
- `GET /api/admin/contacts/scored/csv`
- `POST /api/admin/contacts/archive`
- `GET /api/admin/contacts/:id`
- `PATCH /api/admin/contacts/:id/source`
- `POST /api/admin/contacts/:id/retry-enrichment`
- `POST /api/admin/contacts/:id/retry-transcription`
- `GET /api/admin/contacts/:id/transcript`
- `GET /api/admin/contacts/:id/recording`
- `GET /api/admin/contacts/stats/by-source`

### Reporting / spend / metrics / callrail / summaries

- `POST /api/admin/report/send`
- `GET /api/admin/report/preview`
- `POST /api/admin/report/test`
- `POST /api/admin/spend/sync`
- `GET /api/admin/spend`
- `GET /api/admin/spend/summary`
- `GET /api/admin/spend/mailer`
- `GET /api/admin/spend/sheets`
- `GET /api/admin/caseprofiles/stats`
- `POST /api/admin/callrail/sync`
- `GET /api/admin/callrail/stats`
- `GET /api/admin/callrail/daily`
- `GET /api/admin/callrail/summary`
- `GET /api/admin/daily-summary`
- `POST /api/admin/hourly-sync`
- `POST /api/admin/caseprofiles/manual`
- `GET /api/admin/callrail/live`
- `GET /api/admin/leads/today`
- `GET /api/admin/payments/today`

### RingBridge webhook endpoints

- `POST /webhook/ex`
- `GET /webhook/test`

## Known Frontend Consumers

This is not yet a complete client-call-site map, but these are already confirmed:

### Root app frontend

- Auth context consumes:
  - `/api/auth/me`
  - `/api/auth/send-code`
  - `/api/auth/verify-code`
  - `/api/auth/logout`
- Client context consumes:
  - `/api/clients/uploadDocument`
  - `/api/clients/enrichClient`
  - `/api/clients/zeroInvoice`
  - `/api/clients/createTask`
  - `/api/clients/createActivity`
  - `/api/clients`
  - `/api/clients/delete`
  - `/api/clients/reviewSaleDate`
  - `/api/clients/reviewCreateDate`
- SMS context consumes:
  - `/api/sms/stats`
  - `/api/sms/conversations`
  - `/api/sms/conversations/:id`
  - `/api/sms/settings`
  - `/api/sms/conversations/:id/*` action endpoints

### RingBridge frontend

Confirmed consumer family in `MetricsDashboard`:

- `/ringbridge/api/admin/spend`
- `/ringbridge/api/admin/spend/summary`
- `/ringbridge/api/admin/spend/sync`
- `/ringbridge/api/admin/caseprofiles/stats`
- `/ringbridge/api/admin/callrail/stats`
- `/ringbridge/api/admin/callrail/live`
- `/ringbridge/api/admin/callrail/summary`
- `/ringbridge/api/admin/contacts/stats/summary`
- `/ringbridge/api/admin/contacts/stats/by-source`
- `/ringbridge/api/admin/redlines`
- `/ringbridge/api/admin/daily-summary`
- `/ringbridge/api/admin/payments/today`
- `/ringbridge/api/admin/leads/today`
- `/ringbridge/api/admin/source-canonicals`
- `/ringbridge/api/admin/caseprofiles/manual`

## Migration Guidance

This inventory suggests the shared top layer should eventually export domain
capabilities grouped roughly as:

- `auth`
- `accounts/workspace`
- `contacts`
- `messages`
- `cases`
- `payments`
- `metrics`
- `ring workspace`
- `reporting`
- `deploy/brand ssh`
- `event replay`

The port-specific processes should then expose only the subsets they need.
