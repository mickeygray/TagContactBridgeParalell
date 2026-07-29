# CX Bulk-Route Re-Feed Note — 2026-07-22

**Status: REFERENCE ONLY. Nothing here has been executed. Do not flip flags or restart until decided.**

## TL;DR
The bulk-load route was **not deleted or unwired** during the PhoneBurner work — every
piece of code (route, runtime, publisher, outcome adapter, feeder services, outbox drain)
is intact and only **env-gated off**. The single load-bearing cause is
`LEAD_DELIVERY_ENABLED=true`, which made PhoneBurner the sole voice owner and structurally
locked the CX bulk feed dark. Re-feeding is a **flag/config/data** operation, not a code
rebuild. Verified in code and against the live `.env` (HIGH confidence).

## Feed path as it stands today (intake → outcome)
| # | Stage | Component | Status |
|---|---|---|---|
| 1 | Intake (evidence) | LeadCadence + CaseProfile | ✅ intact (now shared with PB cadence source) |
| 2 | **Queue producer (the feed)** | morning-queue-builder, first-touch, cadence, fresh-hot lane | ❌ **DARK** — `leadDeliveryOwnsVoice` + every per-feeder flag false |
| 3 | Queue store | `CxDialQueue` (`state:'ready'` rows by `visibleExtensionId`) | ✅ intact, but **starved** (no producer running) |
| 4 | **Rail gate** | `resolveCxDialRuntimeMode` / `assertBulkRuntime` | ❌ **403s everything** — `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=false` |
| 5 | Route / runtime | `cxBulkLoad.js` classic path (`/api/cx/bulk-load/*`) | ✅ intact (both boring flags off → classic selected) |
| 6 | Publish | `publishBatchToRingcx` → `client.loadLeads(campaignId,…)` | ✅ intact (RingCX ids present in `.env`) |
| 7 | **Promoter** | account active-call watcher (reserved→serving, stamps outcomes) | ❌ **OFF** — `CX_ACCOUNT_ACTIVE_CALL_WATCHER_ENABLED=false` |
| 8 | Outcome sink | terminal-outbox drain → cadence/Logics | ✅ intact & healthy (only gated by controlPlaneWorker) |

## What the PhoneBurner work disconnected (all reversible via env)
1. **Master switch — `LEAD_DELIVERY_ENABLED=true`.** Via `leadDeliveryOwnsVoice`
   (ringcentral-cx `server.js:83-85,327`) force-darkens **every** CxDialQueue writer:
   cadence (:506), fresh-hot (:759), morning builder (:858), pacing (:964), stale-dial
   sweep (:1139), agent monitor (:1181).
2. **Boot interlock** (control-plane `server.js:119-149`, throw ~`:1980`): startup **throws**
   if `LEAD_DELIVERY_ENABLED=true` AND any legacy CX voice writer is armed. Bulk-load and
   lead-delivery are **mutually exclusive by construction**.
3. **Outbound CX round** short-circuits to `lead-delivery-owns-voice`; outbound-gateway 409s
   the PB round/manual routes.
4. **Every per-feeder flag independently false** in `.env` (morning builder, first-touch,
   cadence, fresh-hot, bulk rail, active-call watcher, both boring flags, pacing, appt lane).
5. **New diversion scaffolding (inert today):** `dialerCommand` selector + boring
   dialer/webhook runtimes + `/disposition`,`/skip` → 410 under `CX_BORING_WEBHOOK_ENABLED`.
   Both boring flags off, so classic path is active and these don't bite.

## Setup checklist to re-feed the CLASSIC bulk route (ordered)
> Order matters: step 1 must precede any writer flag or the control-plane throws at boot.

1. **[ENV]** `LEAD_DELIVERY_ENABLED=false` (+ `LEAD_DELIVERY_ACTIONS_ENABLED=false`,
   `LEAD_DELIVERY_REFILL_ENABLED=false`, `LEAD_DELIVERY_CALLBACK_CAPTURE_ENABLED=false`).
   Master switch — nothing else takes effect until this is off.
2. **[ENV]** Keep `CX_BORING_DIALER_ENABLED=false` and `CX_BORING_WEBHOOK_ENABLED=false`
   (selects the classic request-driven publish path). *Decision needed: classic vs boring.*
3. **[ENV]** `CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=true` — arms the bulk rail. The 5 agents
   (mgray/slucas/polson/bhansen/cbolt) are already mapped via `CX_DIAL_RUNTIME_AGENT_OVERRIDES`.
4. **[ENV]** Re-enable ≥1 queue producer: `CX_MORNING_QUEUE_BUILDER_ENABLED=true` and/or
   `CX_FIRST_TOUCH_ENABLED=true` (queue map already populated) and/or
   `RC_CX_CADENCE_WORKER_ENABLED=true` (+ `RC_CX_FRESH_HOT_LANE_ENABLED`).
5. **[ENV]** `CX_ACCOUNT_ACTIVE_CALL_WATCHER_ENABLED=true` — re-enable the promoter (else the
   flow stalls right after publish).
6. **[ENV — verify only]** Confirm `RINGCX_VOICE_ACCOUNT_ID` / `_DEFAULT_CAMPAIGN_ID` /
   `_DEFAULT_DIAL_GROUP_ID` / `_DEFAULT_AGENT_GROUP_ID` are present and still point at live
   RingCX objects post-July-cutover (publish throws without a valid campaignId).
7. **[DATA]** Confirm each target agent's `UserAccount` has a valid `cxAgentId` + `extensionId`
   that matches what the builder stamps as `visibleExtensionId` (mismatch = invisible rows).
8. **[DATA]** To seed today (builder is daily ~07:00), manually trigger `runCxMorningQueueBuilder`
   and verify `state:'ready'` rows land for the target extensions.
9. **[RESTART — operator's call, live box]** Restart both services so the flags load:
   ringcentral-cx (builders/cadence) + control-plane (route/watcher). `ops/nssm/restart-parallel-all.ps1`.
10. **[CODE]** None required for the classic route. Code change is only needed to run PB
    delivery **and** CX bulk simultaneously — deliberately forbidden today.

## Unknowns to confirm before re-feeding
- **Classic vs boring dialer** — both drain `CxDialQueue`; code can't infer intent.
- **`mgray` is in the rail overrides but NOT in the morning-builder email list**
  (slucas/bhansen/cbolt/polson) — reconcile the roster.
- `CX_DIAL_RUNTIME_DEFAULT` is unset → any agent not in the override list falls to `slow_single`.
- RingCX campaign/dial-group/agent-group ids valid post-cutover?
- **Mutual exclusivity is real:** re-feeding bulk **requires standing PhoneBurner fully down.**
  Both read the same LeadCadence/CaseProfile evidence — running both would double-dial.
- Last-known-good pre-cutover env backup: `.env.bak-local-lanes-20260708T204430Z` (Jul 8) —
  diff **selectively**, don't restore wholesale (it predates other July changes).
