# PhoneBurner simple-loop removal ledger

Date: 2026-07-14  
Status: inventory complete; physical deletion still requires Mickey's approval  
Runtime contract: `docs/PHONEBURNER_SIMPLE_LOOP.md`

## Purpose

This is the current cut list. It is narrower and more current than the July 13
surgery guide. Nothing in this document authorizes deleting live-test WIP.

The live refill operator is:

```text
exact Call End
  -> persist and process once
  -> read the exact agent's Pool twice
  -> Pool >= 5: stop
  -> Pool < 5: retry unfinished provider work, then post up to 20
```

Eligibility happens before this operator. PhoneBurner's Consumer folder,
estimated counts, agent weights, and a periodic refill planner do not grant
permission to post.

## Batch A: ready for deletion after one proven live window

These symbols have no production caller under the current server composition.
They remain only as definitions, exports, disabled code, compatibility
fallbacks, scripts, or tests.

| Candidate | Current evidence | Delete with it | Gate |
| --- | --- | --- | --- |
| `recirculateCompletedProviderContact` | Defined but never called. The current path creates a fresh provider identity. | `shouldRetainCompletedProviderContact` if no external consumer appears. | One due redial receives a new provider contact and exact identity. |
| `appendAgentPacket` | Called only by `appendWeightedAgentPacket` and tests. | Its call-end-pulse tests. | Production callback continues through durable event drain and `postTopOfQueue`. |
| `appendWeightedAgentPacket` | No app or script caller. | Weight-based pulse tests and runtime export. | Exact callback identity continues to select the agent. |
| `launchBackgroundRefill` | No live caller; the automatic tick block that referenced it is disabled. | `backgroundRefills`, `backgroundRefillsByAgent`, stop/state reporting for them. | Concurrent Call Ends prove one per-agent top-up. |
| `refreshAgentCapacity` and legacy `refillAgent` | No production caller; remaining references are tests and the disabled automatic block. | `physicalRefreshesByAgent`, refill-request leases, local-estimate refill branches, related exports/tests. | Stable Pool double-read and durable event retry prove refill recovery. |
| Disabled automatic refill block in `runTick` | Entire block is commented out. | Preview/weighted/refill branches that exist only for it. | Tick still ingests, drains events, and runs daily close. |
| `createPhoneBurnerLeadDeliveryDrain` fallback | Production injects the real runtime drain in `server.js`. | Preview-only fallback, export, and fallback tests. Make injected drain required. | Callback insert still precedes HTTP 200; injected drain processes the exact event. |
| Route pulse meters | Production does not inject `legacyPulseModeEnabled`, `legacyRouteOwnerEnabled`, or pulse callbacks. | `callEndCounts`, `floorCallEndCount`, `meterAgentCallEnd`, low-water pulse branches/logs/options/tests. | Scoped and generic callbacks both process through exact persisted identity. |
| `reserveFreshWork`, `freshEligibleAgents`, `rankFreshAgents`, reservation counters, and speed-override helpers | Live ingestion and Call End now signal the independent immediate-fresh worker; ordinary packets exclude `new_today`. | Old reservation repair/release/finalize helpers, pending-fresh bookkeeping, speed-override tests, and compatibility exports. | Live proof shows newest-first accepted delivery rotating across exact-recently-active agents while low-water packets contain no fresh rows. |

Expected result: one callback owner, one Pool-count owner, one posting method,
and substantially less state in `leadDeliveryService.js` and the callback route.

## Batch B: replace before deleting

These are not part of the steady-state refill loop, but they still cover a real
business edge or feed eligibility.

| Candidate | Why it cannot be removed yet | Required replacement |
| --- | --- | --- |
| `seedAgent`, `launchAgent`, `fillAgent`, `refillAgent`, weighted/append helpers, and `preloadWindow` | Normal cold start is owned by durable `runDayStart`. These definitions now default to `legacy-operator-disabled` and exist only for the no-delete proof window and opted-in legacy tests. | Prove one live 7:50 start, then move the definitions and their compatibility tests into the approved deletion batch. |
| Admin `/seed` and `/launch` routes | Routes now return `410` and contain no runtime writer call. | Remove the dead routes after live proof. Keep preview, pause/cancel, status, guarded tick, and exact repair only. |
| `packetAllowances`, `composePacketRecipe`, `candidateGroups` | The new top-of-queue operator bypasses recipe composition, but preview/seed and older fairness paths still consume it. | Remove with legacy seed/fill after simple cold start and blue/yellow/red eligibility are proven. |
| `estimatedOutstanding` and provider accepted/completed projections | They no longer permit posting, but daily close, status, repair, and old tests still write/read them. | Decide whether they remain metrics. If not, stop writers, compare physical counts, then remove fields/indexes. |
| Consumer-folder configuration | Consumer is ignored for refill, but PhoneBurner still uses it and daily close must account for active session inventory. | Keep unless PhoneBurner configuration and close behavior no longer require it. |

## Batch C: one-off migration and emergency tools

These should not remain as ordinary ways to mutate the floor.

### Delete after checkpoint/retention proof

- `preloadWindow` and its checkpoint helpers.
- `LeadDeliveryCheckpoint` write paths and runtime exports.
- `scripts/phoneburner-july-preload.js`.
- `scripts/phoneburner-today-four-launch.js`.
- `scripts/phoneburner-today-four-status.js`.
- `phoneburner:july-preload` in `package.json`.

### Quarantine, then delete after the simple operator is proven

- `scripts/phoneburner-emergency-topup.js`.
- `scripts/phoneburner-align-ledger-to-folders.js`.
- `scripts/phoneburner-redistribute-bruce.js`.
- `scripts/phoneburner-redistribute-undialed-fresh.js`.
- `scripts/phoneburner-reverse-last-redistribution.js`.
- `scripts/phoneburner-reset-delivery-ledger.js`.
- `scripts/phoneburner-drain-working-folders.js` after daily close is proven.

Keep read-only status and identity-repair tools only while they answer a question
the runtime health/status endpoint cannot answer.

## Batch D: CX delivery rails

CX queue ownership is a separate deletion slice. Remove writers before stores.
Do not delete RingCentral recording, transcription, call-memory, coaching, or
read-only monitoring merely because CX no longer owns lead delivery.

Writer candidates remain the CX boring/bulk runtimes, queue publishers, first
touch/morning dispatchers, caller-ID mutation/watchdog scripts, bulk routes, and
bulk UI controls listed in the July 13 surgery guide. CX collections and indexes
remain read-only until every consumer and retention requirement is proven gone.

## Keep list

- `LeadCadence` and CaseProfile morning eligibility evidence.
- `LeadDeliveryItem` durable queue/attempt identity.
- `LeadDeliveryEvent` durable callback inbox.
- `DailyDial` exact same-day attempt ledger and close-time cadence projection.
- The single age-based daily-cap verdict at Call End, source refresh, and final
  provider claim; capped rows retain history but have no due time.
- `leadDeliveryRepository` narrow reads and versioned claims.
- `postTopOfQueue` and its per-agent single-flight guard.
- The independent immediate-fresh worker, durable `fresh` cursor, and shared
  paced provider mutation lane.
- Stable Pool count read.
- Provider mutation lane, exact attempt identity, and retry reconciliation.
- Call End counting and downstream DNC/appointment/Logics effects.
- `runTick` for ingestion, pending-event drain, durable 7:50 day start, the
  5:00 posting stop, and 5:30 daily close.
- `runDayStart` and its durable per-agent `simpleDayStart` marker until the
  automated morning has been proven live.
- Daily close and next-day release until a separately proven replacement exists.
- The agent-scoped callback URLs currently configured in PhoneBurner. The URL is
  transport context only; persisted provider identity remains attribution truth.

## Ordered deletion gate

Before each batch:

1. Prove with `rg` that no production caller remains.
2. Replace or delete the tests that exist only to preserve the old owner.
3. Run service, repository, callback-route, and server-wiring tests.
4. Restart `ParallelControlPlane` through Mickey and observe a live window.
5. Prove Pool counts, exact callbacks, partial posts, and retries remain correct.
6. Record the exact files/symbols approved for physical deletion.
7. Delete only that named batch.

The first recommended physical cut is Batch A. The cold-start replacement now
exists in `runDayStart`; deletion of the old seed/launch surface still waits for
one proven live morning and confirmation that it is not used as an external
repair tool. The rest of Batch B still waits for the small fresh-lead
round-robin replacement.
