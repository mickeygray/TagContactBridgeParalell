# Cron Migration Board

Updated: 2026-04-29

## Goal

Move healthy nightly/hourly/intake behavior from the legacy `TagContactBridge` stack into `TagContactBridgeParallel` so we can begin testing real lead intake on the new endpoints, then migrate webhook traffic route-by-route onto the new public URL without breaking the working recorder / Drive player setup.

This board is intentionally blunt:

- `Green` means the new app has a real runtime and the business behavior is trustworthy enough to migrate behind a guarded test.
- `Yellow` means the plumbing is real but the business rule is still thin, partial, or not yet auto-fired.
- `Red` means the old app has the behavior and the new app does not yet have an equivalent scheduled truth path.

## Important Topology Note

The new webhook surface is split across multiple apps:

- `inbound-gateway`
  - `/lead-contact`
  - `/lead-contact/pre-ping`
  - `/api/inbound/...`
  - `/fb/webhook`
  - `/tt/webhook`
- `control-plane`
  - `/sms/inbound`
  - `/ringcentral/session-events`
  - admin/read/dispatch routes
- `outbound-gateway`
  - cadence sweep worker
  - outbound event intake

That means a single new public URL only works if:

1. it fronts a reverse proxy that maps paths to the right service, or
2. we temporarily cut over only one gateway at a time.

If the plan is “turn the second ngrok URL into the new webhook surface,” the safest first use is:

- point it at `inbound-gateway` first for lead intake routes
- leave `control-plane` webhook routes on the current path until we are ready to proxy or move them too

## Current Read

### 1. Hourly call-log check for case changes / payments / invoices

- Legacy status: `Green`
- Parallel status: `Yellow`

Legacy:

- [C:\Users\Admin\Code\TagContactBridge\ringBridge\services\hourlySyncService.js](C:\Users\Admin\Code\TagContactBridge\ringBridge\services\hourlySyncService.js)
- refreshes active/today cases
- sweeps payments
- materializes payment summaries

Parallel:

- [C:\Users\Admin\Code\TagContactBridgeParallel\apps\control-plane\src\server.js](C:\Users\Admin\Code\TagContactBridgeParallel\apps\control-plane\src\server.js)
- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\hourlySweeperService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\hourlySweeperService.js)
- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\paymentReconcileService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\paymentReconcileService.js)

What is good:

- hourly runtime is real
- payment ledger upsert is real
- case profile payment application is real

What is still missing:

- no single explicit hourly “calls over N minutes -> inspect case for status/payment/invoice drift” orchestration pass
- invoice/billing refresh is not part of the hourly sweeper in the same concrete way

Migration gate:

- add a true “touched long calls in last hour” hourly pass or accept that payments reconcile independently from the call-log trigger

### 2. Hourly lead-cadence shutoff for bad inactive / postdate / deal / DNC

- Legacy status: `Green`
- Parallel status: `Yellow`

Legacy:

- [C:\Users\Admin\Code\TagContactBridge\webhook.js](C:\Users\Admin\Code\TagContactBridge\webhook.js)
- [C:\Users\Admin\Code\TagContactBridge\ringBridge\services\nightlyCaseHealthService.js](C:\Users\Admin\Code\TagContactBridge\ringBridge\services\nightlyCaseHealthService.js)

Parallel:

- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\contactEligibilityService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\contactEligibilityService.js)
- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-repositories\src\leadCadenceRepository.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-repositories\src\leadCadenceRepository.js)
- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\outboundDispatchService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\outboundDispatchService.js)

What is good:

- DNC / inactive / payment / blocked-stage suppression logic is better and more centralized
- outbound and CX flows call `resolveCaseContactEligibility()`

What is still missing:

- the hourly worker itself only cancels stale scheduled actions
- there is no confirmed broad hourly status poll that actively flips cadence rows inactive across the whole population

Migration gate:

- add an hourly “contact eligibility enforcement” sweep for active lead-cadence rows, or accept temporary send-time-only suppression

### 3. Hourly counts for new leads / new calls / mail payments persisted as ledgers

- Legacy status: `Yellow`
- Parallel status: `Yellow`

Legacy:

- partial through case profile/payment summary materialization

Parallel:

- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\hourlyFinancialPreviewService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\hourlyFinancialPreviewService.js)
- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\frontendReadService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\frontendReadService.js)
- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\paymentReconcileService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\paymentReconcileService.js)

What is good:

- payment ledger is a real persisted ledger
- metrics/source family logic for `LD`, `Affiliate`, `VF`, `CallFire`, mail exists

What is still missing:

- no dedicated persisted hourly fact table for “last hour lead count / last hour call count / last hour mail payment count”
- current “preview” services are read/report helpers, not clearly the production write path

Migration gate:

- decide whether to build a real hourly summary ledger or accept that these remain derived reads for now

### 4. Hourly recordings + Whisper + Claude + append to records

- Legacy status: `Green`
- Parallel status: `Green`

Legacy:

- [C:\Users\Admin\Code\TagContactBridge\ringBridge\services\transcriptionService.js](C:\Users\Admin\Code\TagContactBridge\ringBridge\services\transcriptionService.js)

Parallel:

- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\transcriptionScoringService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\transcriptionScoringService.js)
- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\hourlyJobHandlers.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\hourlyJobHandlers.js)

What is good:

- recording discovery is real
- whisper transcription is real
- claude scoring is real
- retry job loop is better than the old inline wait pattern

What is still thin:

- primary write target is `CallLog`
- case-profile-level outcome enrichment from scored recordings is not yet the main persisted truth

Migration gate:

- not a blocker for intake cutover
- only a blocker if nightly source/outcome reports require case-profile-level scoring rollups immediately

### 5. Nightly close by source/outcome/revenue

- Legacy status: `Yellow`
- Parallel status: `Yellow`

Legacy:

- [C:\Users\Admin\Code\TagContactBridge\ringBridge\services\nightlyCaseHealthService.js](C:\Users\Admin\Code\TagContactBridge\ringBridge\services\nightlyCaseHealthService.js)

Parallel:

- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\nightlyCloseService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\nightlyCloseService.js)

What is good:

- payment sweep is part of nightly close
- management snapshot exists
- vendor/source report exists
- source families like `ld-posting`, `affiliate`, `vf` are present in the attribution/reporting vocabulary

What is still missing:

- `startNightlyCloseRun()` exists but is not started automatically by [C:\Users\Admin\Code\TagContactBridgeParallel\apps\control-plane\src\server.js](C:\Users\Admin\Code\TagContactBridgeParallel\apps\control-plane\src\server.js)
- several summary fields are still effectively placeholders:
  - `statusChanges`
  - `attributionUpdates`
  - `stopSignalsDetected`
  - `aiCaseReviewsDue`

Migration gate:

- wire nightly close into a real scheduler
- make source/outcome/revenue counts trustworthy enough to compare against the old nightly email

### 6. Scheduled blasts separate from cadence

- Legacy status: `Red`
- Parallel status: `Yellow`

Parallel primitives:

- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\campaignAudienceService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\campaignAudienceService.js)
- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\dispatchListService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\dispatchListService.js)
- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\outboundDispatchService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\outboundDispatchService.js)
- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\outboundCallFireService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\outboundCallFireService.js)
- [C:\Users\Admin\Code\TagContactBridgeParallel\apps\outbound-gateway\src\server.js](C:\Users\Admin\Code\TagContactBridgeParallel\apps\outbound-gateway\src\server.js)

What is good:

- text/email/rvm/cx rounds have real runtime intake
- dispatch lists can be built/queued
- callfire dial batches work manually

What is still missing:

- no weekday/noon scheduler for:
  - Monday/Wednesday/Friday CallFire blast
  - Tuesday text blast
  - Thursday email blast
- `callfire` is mapped as manual-only right now, not a scheduled round event

Migration gate:

- build a dedicated blast scheduler and one new recurring event type for scheduled CallFire blasts

## What Is Healthy Enough To Migrate First

These are the pieces most ready for controlled cutover:

### A. New lead intake endpoints

Routes:

- [C:\Users\Admin\Code\TagContactBridgeParallel\apps\inbound-gateway\src\server.js](C:\Users\Admin\Code\TagContactBridgeParallel\apps\inbound-gateway\src\server.js)
  - `/lead-contact`
  - `/lead-contact/pre-ping`
  - `/api/inbound/website/lead`
  - `/api/inbound/ld/lead`
  - `/api/inbound/affiliate/lead`
  - `/api/inbound/vf/landing-page`
  - `/api/inbound/organic/:domain/landing-page`
  - `/api/inbound/facebook/lead`
  - `/api/inbound/instagram/lead`
  - `/api/inbound/tiktok/lead`

Why these are close:

- intake services are real
- source-specific handlers exist
- can skip Logics creation during test with `?doCase=false`

Required before live test:

- route-by-route payload smoke
- verify lead lands in `LeadCadence`
- verify cadence schedule builds correctly
- verify text/email/rvm rounds see the new row

### B. Normal cadence rounds for text/email/rvm

Routes/runtime:

- [C:\Users\Admin\Code\TagContactBridgeParallel\apps\outbound-gateway\src\server.js](C:\Users\Admin\Code\TagContactBridgeParallel\apps\outbound-gateway\src\server.js)
- cadence sweep via `createCadenceSweepEvents()`

Why this is close:

- real round events exist for `sms`, `email`, `rvm`
- lead suppression checks are in the send path

Required before live test:

- prove one fresh inbound lead cards correctly
- prove outbound-gateway sweep emits round events
- prove one text/email/rvm lead exits cleanly through the new stack

## What Must Be Cleaned Up Before Full EOD Intake Migration

1. Add an hourly active status enforcement pass for lead cadence
2. Decide whether hourly summary ledgers are real persisted tables or acceptable as derived reads
3. Start nightly close on a real runtime
4. Finish nightly source/outcome metrics so they are not placeholder counts
5. Decide whether the new public URL fronts only `inbound-gateway` first or all webhook surfaces behind a reverse proxy

## Recommended Cutover Order

### Phase 1: Safe lead-intake-only cutover

Move one route at a time onto the second public URL:

1. `/lead-contact/pre-ping`
2. `/lead-contact`
3. `/api/inbound/ld/lead`
4. `/api/inbound/affiliate/lead`
5. `/api/inbound/vf/landing-page`

Success criteria:

- request accepted
- lead carded in `LeadCadence`
- correct source family assigned
- no duplicate Logics case create
- cadence rows visible to outbound rounds

### Phase 2: Outbound cadence validation

Keep intake on the new URL, then validate:

1. text round
2. email round
3. rvm round

Success criteria:

- outbound-gateway sweep sees due rows
- suppression rules skip the right cases
- send outcomes update scheduled action status cleanly
- no stale requested/pending buildup

### Phase 3: Webhook/control-plane migration

Only after the above is clean:

1. `/sms/inbound`
2. `/ringcentral/session-events`
3. optional RC subscription renewal against the new base URL

Success criteria:

- inbound SMS still resolves company correctly
- RC webhook events still persist and reconcile
- no attribution drift

## Test Checklist Before NSSM Move

- Intake payload smoke on each target source route
- One test lead reaches `LeadCadence`
- One test lead is picked up by `sms` round
- One test lead is picked up by `email` round
- One test lead is picked up by `rvm` round
- Payment reconcile still updates:
  - `PaymentLedger`
  - `CaseProfile.totalPaid`
  - `CaseProfile.paymentsCount`
- Recording scoring still writes:
  - `CallLog.transcription`
  - `CallLog.callScore`
- Nightly close can be run manually without throwing

## Recommended Immediate Work

1. Implement hourly active status enforcement for lead-cadence rows
2. Wire nightly close into a real scheduler
3. Convert nightly close placeholder counts into real source/outcome rollups
4. Run route-by-route intake smokes on `inbound-gateway`
5. Only then move the second public URL to intake traffic

## Blunt Read

If the goal is “start accepting leads for texts, emails, and RVMs on the new endpoints starting EOD,” that is close enough to pursue in a staged way.

If the goal is “fully replace the old nightly/hourly truth layer before cutover,” the new app is not there yet.

The correct move is:

- cut over healthy intake first
- keep hourly/nightly reconciliation work in progress
- do not wait for the full blast scheduler before migrating ordinary intake/cadence traffic
