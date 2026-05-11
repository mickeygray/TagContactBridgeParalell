# Inbound Swap Worksplit

Updated: 2026-04-30

## Goal

Get `TagContactBridgeParallel` solid enough to accept real inbound traffic and run the `text / RVM / email` follow-on loops safely behind the new URL, without assuming full CX cutover yet.

This doc starts from the current state:

- `Logics createCase dedup` is landed.
- `Synthetic STOP` was smoke-tested and passed.
- `Cadence suppression` was re-confirmed after the dedup change.
- `Operator visibility` surfaces were checked and are responding.

So the remaining work is no longer "invent the system." It is:

1. harden the core runtime under repeat traffic,
2. make the outbound loops conservative,
3. make the reporting/close path trustworthy enough to monitor the cutover,
4. stage the real canary.

## Shared Rules

- Smoke test after every meaningful change.
- Prefer replaying the same known fixtures so regressions are obvious:
  - `Tina Webb` for `LD / pre-ping`
  - `Daniel Hahn` for `affiliate`
  - `Jean Barney` for `VF landing`
  - `Kamran Irfani` for `organic / website`
  - one synthetic `STOP` payload to `/sms/inbound`
- Do not widen scope into full CX cutover while working this list.
- The "done" bar for each task is:
  - code landed,
  - smoke test passed,
  - behavior visible in logs / health / workflow trails.

## Current Done

### Completed

1. Base Logics dedup
   - [packages/shared-integrations/src/logicsClient.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-integrations\src\logicsClient.js)

2. STOP inbound compliance pass
   - [apps/control-plane/src/server.js](C:\Users\Admin\Code\TagContactBridgeParallel\apps\control-plane\src\server.js)
   - [packages/shared-repositories/src/leadCadenceRepository.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-repositories\src\leadCadenceRepository.js)
   - [packages/shared-services/src/smsAutoResponderService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\smsAutoResponderService.js)
   - [packages/shared-services/src/controlPlaneEventService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\controlPlaneEventService.js)

3. Cadence dispatch suppression re-check
   - [packages/shared-services/src/outboundDispatchService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\outboundDispatchService.js)
   - [apps/outbound-gateway/src/server.js](C:\Users\Admin\Code\TagContactBridgeParallel\apps\outbound-gateway\src\server.js)

4. Runtime visibility confirmation
   - [apps/control-plane/src/server.js](C:\Users\Admin\Code\TagContactBridgeParallel\apps\control-plane\src\server.js)
   - [packages/shared-services/src/controlPlaneHealthService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\controlPlaneHealthService.js)

### Deferred

- Full synthetic create-case posts across all vendor routes
  - deferred to canary to avoid burning Logics dollars on junk test cases

## Workstream A

Owner suggestion: `Codex`

Mission: make the backend runtime conservative, idempotent, and ledger-backed under live inbound traffic.

### Owned Files

- [packages/shared-services/src/inboundIntakeService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\inboundIntakeService.js)
- [packages/shared-repositories/src/masterProspectRepository.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-repositories\src\masterProspectRepository.js)
- [packages/shared-repositories/src/leadCadenceRepository.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-repositories\src\leadCadenceRepository.js)
- [packages/shared-repositories/src/prePingRepository.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-repositories\src\prePingRepository.js)
- [packages/shared-services/src/outboundDispatchService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\outboundDispatchService.js)
- `packages/shared-services/src/outboundRateShaperService.js` if added
- [apps/outbound-gateway/src/server.js](C:\Users\Admin\Code\TagContactBridgeParallel\apps\outbound-gateway\src\server.js)
- [packages/shared-services/src/contactEligibilityService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\contactEligibilityService.js)
- [packages/shared-services/src/hourlyLeadCadenceEnforcementService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\hourlyLeadCadenceEnforcementService.js)
- [packages/shared-services/src/prospectCleanerService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\prospectCleanerService.js)
- [packages/shared-services/src/hourlyCallLogHygieneService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\hourlyCallLogHygieneService.js)
- [packages/shared-services/src/callLedgerService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\callLedgerService.js)
- [packages/shared-services/src/paymentReconcileService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\paymentReconcileService.js)
- [packages/shared-services/src/hourlyMetricsRefreshService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\hourlyMetricsRefreshService.js)
- [packages/shared-services/src/metricsBackfillService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\metricsBackfillService.js)
- [packages/shared-services/src/vendorDailySummaryService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\vendorDailySummaryService.js)
- [packages/shared-services/src/vendorNightlyEmailService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\vendorNightlyEmailService.js)
- [packages/shared-services/src/nightlyCloseService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\nightlyCloseService.js)

### Task A1: Make inbound idempotent under repeat traffic

Why:
- Dedup at `createCase` is now real, but repeated vendor retries can still create local drift if `MasterProspect`, `LeadCadence`, or `pre-ping` upserts are not fully idempotent.

Do:
- Review every inbound upsert path for stable keys and merge semantics.
- Make sure duplicate POSTs do not:
  - create extra cadence rows,
  - lose metadata,
  - fork pre-ping state,
  - overwrite better source/consent data with thinner later payloads.

Smoke:
- Fire the same Tina/Daniel payload 10-20 times concurrently.
- Confirm:
  - one Logics case,
  - one effective `MasterProspect`,
  - one effective `LeadCadence`,
  - stable metadata after the burst.

Done when:
- repeat POSTs converge cleanly and the workflow trail shows deterministic behavior.

### Task A2: Add outbound rate shaping for text / RVM / email

Why:
- Right now the sweep can empty all due eligible work too quickly.
- This is the largest remaining runtime-risk for real cutover volume.

Do:
- Introduce a rate-shaper for non-CX channels first.
- Pace by:
  - domain,
  - channel,
  - rolling window,
  - provider pressure.
- Requeue/roll over items that stay eligible but are not yet allowed to fire.

Smoke:
- Seed 50-100 due actions.
- Run the outbound worker.
- Confirm:
  - sends are paced,
  - not all due work fires at once,
  - overflow rolls cleanly to later execution,
  - business-hour guards still apply.

Done when:
- due work drains conservatively instead of bursting.

### Task A3: Tighten long-term suppression and deactivation hygiene

Why:
- STOP/DNC is now better, but the whole system still depends on long-term eligibility staying clean as statuses and payments change.

Do:
- Make sure hourly enforcement and case-contact suppression agree.
- Ensure paid / DNC / postdate / inactive / AI-stop cases fall out of future contact reliably.
- Keep channel-DNC and lead-wide stop behavior from fighting each other.

Smoke:
- Use a mix of:
  - DNC,
  - postdate,
  - paid,
  - inactive,
  - opt-out
  cases and verify they disappear from appropriate outbound paths.

Done when:
- suppressed leads stop resurfacing.

### Task A4: Reconcile calls, payments, and daily facts from the same truth

Why:
- Metrics and nightly close are only as trustworthy as the ledger paths feeding them.

Do:
- Keep pushing toward:
  - `CallLog -> CallLedger -> CaseProfile`
  - `Payments -> PaymentLedger -> CaseProfile`
  - `DailyCallStat / MetricsSnapshot` rebuilt from those feeds
- Reduce cases where reporting reads stale/partial shadow data.

Smoke:
- Run manual hourly passes.
- Compare same-day call and payment counts against legacy.
- Inspect the raw collections directly.

Done when:
- the reporting gap is explainable and shrinking instead of mysterious.

### Task A5: Make nightly vendor close the final truth pass

Why:
- Hourly keeps metrics warm; nightly still needs to do the authoritative close.

Do:
- Keep the body ledger-backed.
- Keep attachments fresh-run and detailed.
- Tighten:
  - call rows,
  - lead rows,
  - outcomes,
  - collected dollars,
  - vendor-only filtering.

Smoke:
- no-send preview,
- compare to legacy nightly,
- then send to `mgray@taxadvocategroup.com` only.

Done when:
- the nightly email is useful without hand-explaining what is missing.

## Workstream B

Owner suggestion: `Claude`

Mission: make the cutover edge, visibility surfaces, and operator-facing behavior trustworthy during the canary.

### Owned Files

- [apps/control-plane/src/server.js](C:\Users\Admin\Code\TagContactBridgeParallel\apps\control-plane\src\server.js)
- [apps/inbound-gateway/src/server.js](C:\Users\Admin\Code\TagContactBridgeParallel\apps\inbound-gateway\src\server.js)
- [apps/web-client/src/lib/api/client.ts](C:\Users\Admin\Code\TagContactBridgeParallel\apps\web-client\src\lib\api\client.ts)
- [apps/web-client/src/lib/api/queries/metrics.ts](C:\Users\Admin\Code\TagContactBridgeParallel\apps\web-client\src\lib\api\queries\metrics.ts)
- [apps/web-client/src/workspaces/metrics/*](C:\Users\Admin\Code\TagContactBridgeParallel\apps\web-client\src\workspaces\metrics)
- [apps/web-client/src/workspaces/cx/*](C:\Users\Admin\Code\TagContactBridgeParallel\apps\web-client\src\workspaces\cx)
- [apps/control-plane/src/routes/health.js](C:\Users\Admin\Code\TagContactBridgeParallel\apps\control-plane\src\routes\health.js)
- [apps/control-plane/src/routes/readMetrics.js](C:\Users\Admin\Code\TagContactBridgeParallel\apps\control-plane\src\routes\readMetrics.js)
- [docs/DEPLOY_QUICKSTART.md](C:\Users\Admin\Code\TagContactBridgeParallel\docs\DEPLOY_QUICKSTART.md)

### Task B1: Make canary observability boring

Why:
- During the one-number cutover, a human should be able to tell what is happening without opening Mongo manually.

Do:
- Make the runtime/health surfaces easy to read.
- Surface:
  - inbound failures,
  - STOP handling,
  - workflow/review queue volume,
  - hourly health,
  - nightly/lexis runtime status.

Smoke:
- Trigger one success and one forced failure.
- Confirm all of it is visible in health/runtime and operator-facing reads.

Done when:
- canary monitoring is readable from app surfaces and logs.

### Task B2: Finalize edge-route / URL cutover posture

Why:
- The new public URL needs to be predictable before the first live routing number moves.

Do:
- Confirm the same-origin `5001` story stays clean.
- Confirm which public routes are live and which are intentionally not.
- Keep the reverse-proxy / ngrok cutover instructions current.

Smoke:
- curl every public route that matters:
  - inbound lead routes
  - `/sms/inbound`
  - social webhooks
  - health endpoints

Done when:
- one-number canary can be executed from a simple playbook without guesswork.

### Task B3: Surface suppression / attribution / held-out truth in the UI

Why:
- Once inbound traffic starts flowing, the operator needs to see why a lead is suppressed, held out, or not counted.

Do:
- Add or tighten badges / status blocks for:
  - channel DNC,
  - contact stop,
  - held-out attribution review,
  - nightly/vendor exclusion reasons.

Smoke:
- create one held-out attribution row,
- one STOP’d lead,
- one payment/converted lead,
- verify the UI explains each state clearly.

Done when:
- totals and exclusions are understandable from the UI itself.

### Task B4: Close the user-facing queue/call-scoping loop before CX expansion

Why:
- Not an inbound blocker, but it is the next place confusion will show up once live users spend time in Parallel.

Do:
- Verify the server-filtered queue behavior with real agent sessions.
- Tighten any UI assumptions that still make it look shared when it is assigned.

Smoke:
- log in as two agents and one admin,
- compare queue views,
- verify only admin sees the broad pool.

Done when:
- agents do not see each other's queue work.

## Cutover Sequence

### Gate 1: Finish Workstream A1

- no live webhook cutover until duplicate/retry idempotency is boring

### Gate 2: Confirm Workstream B1 + B2

- operator can see failures
- route map is clean

### Gate 3: One-number canary

Ops steps:

1. Pick one low-volume CallRail tracking number
2. Point only that number at Parallel
3. Watch for 24 hours:
   - intake volume
   - duplicate behavior
   - STOP handling
   - text/RVM/email outcomes
   - review queue and alert emails
4. If clean, expand to the rest of the inbound numbers

## Not Blocking This Swap

- full CX rate shaping
- per-user CX queue perfection
- full RingCentral call-tracing finality
- bimonthly DNC recheck
- scheduled blasts
- generic batch-contact scrub perfection

Those matter, but they do not need to delay inbound cutover if the canary is clean.
