# Aged Pool — Rolling Daily Refresh

This is the implementation playbook for replacing the once-monthly
`runFillerPoolRefresh` burst with two cleaner jobs:

1. **Daily 06:00 PT age-in / re-scrub** — promotes 30-day-old leads into
   the red (aged) pool, re-scrubs at 60 and 90 days, then leaves them
   alone.
2. **Monthly day-1 graduation sweep** — drops leads from red after they
   have accumulated 8+ successful CX contacts in the trailing 4 months.

The end state: RealValidation load smooths from a monthly burst to a
steady ~1/30 daily trickle, the red pool self-prunes against actual
contact activity, and the SafeHarbor-style re-scrub cadence
(30/60/90 days) is encoded in data rather than wholesale rebuild.

**Scope of change**: replace the monthly `runFillerPoolRefresh`
orchestration. **Out of scope**: the actual RealValidation client,
classification of "filler-*" → "aged" queue family in
`cxLeadServing`, claim/assignment logic, agent policy. None of those
get touched.

Greppable anchors to drop while you build:
```
grep -rn "TODO(aged-rolling-refresh)" packages/ apps/
```

---

## End-state behavior

### Daily 06:00 PT — `runDailyAgedRefresh`

Finds every LeadCadence where `dncCheckpoints.nextAt <= now` and walks
them through the table below. The query is single-pass per tenant,
batched, and capped at a per-domain limit so a stuck day can't blast
RealValidation.

| Lead age (days since LeadCadence intake) | Action | DNC clean → | DNC hit → |
|---|---|---|---|
| 30 | First scrub | Promote: stamp `pool.tag = filler-YYYY-MM`, bump `dncCheckpoints.count`, set `nextAt = intake + 60d` | Drop: clear `pool.tag`, stamp `dncHit: true`, set `nextAt = null` |
| 60 | Re-scrub (already red) | Stay in red, bump counter, set `nextAt = intake + 90d` | Evict from red: clear `pool.tag`, stamp `dncHit: true`, set `nextAt = null` |
| 90 | Final re-scrub | Stay in red, stamp `dncCleared: true`, set `nextAt = null` (done forever) | Evict, stamp `dncHit: true`, `nextAt = null` |

After 90 days a lead either lives in red until the monthly graduation
sweep evicts it, or has already been dropped by a DNC hit. No further
periodic scrubs.

### Monthly day-1 06:00 PT — `runMonthlyGraduationSweep`

Walks current red pool (`pool.tag` matching `filler-*`). For each lead:

```js
const connects = await CallLog.countDocuments({
  domain,
  caseId,
  direction: "outbound",
  platform: "cx",
  durationSec: { $gte: 10 },
  callStartTime: { $gte: fourMonthsAgo },
});
if (connects >= 8) {
  // graduate out of red
  await LeadCadence.updateOne(
    { _id },
    { $unset: { "pool.tag": "" }, $set: { graduatedAt: new Date(), graduatedConnects: connects } },
  );
}
```

Floor of `durationSec >= 10` includes voicemail (per call: "if it's
voicemail it's voicemail, there are still other ways to reach them")
and excludes 4-second drops. Tunable via env.

`graduatedAt` is a permanent stamp — the daily age-in job skips any
lead with `graduatedAt` set, so we never re-promote a finished lead.

---

## Schema additions

### `LeadCadence` (packages/shared-models/src/LeadCadence.js)

Add to the existing schema:

```js
dncCheckpoints: {
  // First scrub fires when ageDays >= 30. After each scrub:
  //   count 0→1: nextAt = intake + 60d
  //   count 1→2: nextAt = intake + 90d
  //   count 2→3: nextAt = null (done, dncCleared: true)
  // Any scrub that returns dirty: nextAt = null + dncHit = true.
  count: { type: Number, default: 0 },
  lastAt: { type: Date, default: null },
  // Daily sweep query lives on this index. Backfill on cutover sets
  // nextAt = intake + 30d for every existing lead without a checkpoint.
  nextAt: { type: Date, default: null, index: true },
  dncCleared: { type: Boolean, default: false },
  dncHit: { type: Boolean, default: false },
  dncHitAt: { type: Date, default: null },
  dncProvider: { type: String, default: null }, // "realvalidation"
  dncReason: { type: String, default: null },   // "national" | "state" | "litigator"
},
graduatedAt: { type: Date, default: null, index: true },
graduatedConnects: { type: Number, default: null },
```

Add a sparse index so the daily query is cheap:
```js
leadCadenceSchema.index(
  { "dncCheckpoints.nextAt": 1, graduatedAt: 1 },
  { sparse: true },
);
```

---

## Files + functions to add or change

| # | File | What |
|---|---|---|
| 1 | [packages/shared-models/src/LeadCadence.js](../packages/shared-models/src/LeadCadence.js) | Add `dncCheckpoints` subdoc + `graduatedAt` + `graduatedConnects` per the schema block above. |
| 2 | [packages/shared-services/src/fillerPoolRefreshService.js](../packages/shared-services/src/fillerPoolRefreshService.js) | Add `runDailyAgedRefresh({ logger, now, limitPerDomain })`. Reuses the existing RealValidation client (`lookupDnc`) and the existing "stamp pool.tag" upsert helper. Cohort query: `LeadCadence.find({ "dncCheckpoints.nextAt": { $lte: now }, graduatedAt: null }).limit(limitPerDomain)`. Returns `{ checked, promoted, evicted, dncHits, dncLookupFailures, perDomain }` for the report. |
| 3 | [packages/shared-services/src/fillerPoolRefreshService.js](../packages/shared-services/src/fillerPoolRefreshService.js) | Add `runMonthlyGraduationSweep({ logger, now })`. Aggregates `CallLog` by `caseId` for each red lead, evicts those with `connects >= AGED_GRADUATION_THRESHOLD` (default 8) over `AGED_GRADUATION_WINDOW_DAYS` (default 120). Returns `{ scanned, graduated, perDomain }`. |
| 4 | [packages/shared-services/src/fillerPoolRefreshService.js](../packages/shared-services/src/fillerPoolRefreshService.js) | Add `isAtDailyAgedRefreshBoundary(now)` — `hour === "06"` PT, any day. Mirror `isAtMonthlyRefreshBoundary` style. Day-1 + 06:00 fires BOTH (daily age-in AND monthly graduation). |
| 5 | [packages/shared-services/src/hourlySweeperService.js](../packages/shared-services/src/hourlySweeperService.js) | Replace the existing `fillerPoolRefresh` line (currently at ~914) with: `dailyAgedRefresh: await runDailyAgedRefreshIfDue({ logger }).catch(...)` AND `monthlyGraduationSweep: await runMonthlyGraduationSweepIfDue({ logger }).catch(...)`. The old `runMonthlyFillerPoolRefreshIfDue` becomes a NO-OP wrapper (kept as a graveyard for one release, then deleted) OR removed in the same PR — see Cutover plan. |
| 6 | [packages/shared-services/src/hourlySweeperService.js](../packages/shared-services/src/hourlySweeperService.js) | Add `runDailyAgedRefreshIfDue` and `runMonthlyGraduationSweepIfDue` wrappers that gate on the boundary functions + an `hasAlreadyRunForKey` idempotency check (e.g. an `OperationLog` row keyed by `aged-daily:YYYY-MM-DD` and `aged-monthly:YYYY-MM`). The day-1 06:00 tick must run BOTH; order: graduation first (frees up cooldown slots before age-in adds new red leads). |
| 7 | [packages/shared-services/src/nightlyCloseService.js](../packages/shared-services/src/nightlyCloseService.js) | Add `agedPool` recipient pool to `NIGHTLY_RECIPIENT_POOLS`: `production: ["mgray@", "manderson@", "abanks@"]`. Add `sendAgedRefreshReportEmail({ summary, now })` that renders the new template and routes through the same SES path as the close emails. Wire it into the daily sweeper *after* `runDailyAgedRefresh` completes (not from nightlyClose — this is a 06:00 job, nightly close fires at 21:00). |
| 8 | [packages/shared-templates/src/templates/nightly/aged-refresh.hbs](../packages/shared-templates/src/templates/nightly/aged-refresh.hbs) | New template. Sections: (a) headline counts — checked, promoted, evicted, DNC hits; (b) per-domain table; (c) on day-1, an extra "Graduated today" section listing names/phones (capped at ~50, link to full export); (d) lookup-failure count so we see when RealValidation is choking. |
| 9 | [packages/shared-services/src/index.js](../packages/shared-services/src/index.js) | Export the two new functions + the boundary helpers. |
| 10 | `ops/migrations/2026-XX-aged-checkpoint-backfill.js` | One-shot backfill script. For every existing `LeadCadence` doc with `graduatedAt: null` and no `dncCheckpoints.nextAt`: compute the appropriate `nextAt` from `createdAt` (intake) — if already older than 90 days, set `dncCleared: true` and `nextAt: null` instead of re-checking (these are leads that already lived in the old monthly pool, they're effectively past the re-scrub window). Critical: without this backfill, the FIRST daily run will try to scrub every single existing lead at once. |

---

## Email report — `aged-refresh.hbs`

Subject: `Aged pool refresh — {{date}} — {{counts.checked}} checked, {{counts.evicted}} retired`

Body (HTML, mirrors `lead-data-vendor.hbs` style):

```
┌─ Aged Pool Daily Refresh — Mon Mar 2, 2026 ─────────────────┐
│                                                              │
│  Checked today:        47                                    │
│  Promoted into red:    38                                    │
│  Evicted (DNC hit):     3                                    │
│  Lookup failures:       1                                    │
│  Currently in red:  4,812                                    │
│                                                              │
│  ── Per domain ─────────────────────────────────             │
│  WYNN:  checked 29, promoted 24, evicted 2                   │
│  TAG:   checked 18, promoted 14, evicted 1                   │
│                                                              │
│  ── Retired today (DNC) ───────────────────────              │
│  John Doe (310) 555-0143 — national DNC                      │
│  Jane Roe (555) 123-9876 — state DNC                         │
│  Mike Smith (310) 555-2244 — litigator                       │
│                                                              │
│  ── On day-1 only: Graduated (8+ contacts) ─────             │
│  [list of up to 50 names, then "+N more"]                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Recipients (production): `mgray@taxadvocategroup.com`,
`manderson@taxadvocategroup.com`, `abanks@taxadvocategroup.com`.
Development pool: `mgray@` only, same env-flip pattern as the close
emails.

---

## Cutover plan

1. **Land schema + service changes behind disabled feature flag**
   (`AGED_ROLLING_REFRESH_ENABLED=false`). The existing
   `runMonthlyFillerPoolRefreshIfDue` keeps running so we don't lose
   the next 1st-of-month refresh.
2. **Run the backfill migration** in dev first, then prod. Verify
   `LeadCadence.find({ "dncCheckpoints.nextAt": { $lte: tomorrow6am } }).countDocuments()`
   is reasonable (expected: somewhere between zero and a few hundred —
   the leads that intake'd ~30 days ago).
3. **Dry-run the daily job** — set `AGED_ROLLING_REFRESH_DRY_RUN=true`,
   point at prod data but skip writes + email. Tail the summary.
4. **Enable for one tenant** (set `AGED_ROLLING_REFRESH_DOMAINS=wynn`)
   for one week. Verify emails land, RealValidation spend is bounded.
5. **Enable both tenants, disable the monthly burst.** Delete
   `runMonthlyFillerPoolRefreshIfDue` and its boundary helper from
   `hourlySweeperService` + `fillerPoolRefreshService`. The standalone
   script `scripts/build-monthly-filler.js` stays — it's still useful
   as a manual full-rebuild hammer for cohort rebuilds after major
   policy changes.

---

## Env knobs

```
AGED_ROLLING_REFRESH_ENABLED         # default false during build, true after cutover
AGED_ROLLING_REFRESH_DRY_RUN         # default false; if true, log only, no writes/email
AGED_ROLLING_REFRESH_DOMAINS         # CSV; defaults to all
AGED_ROLLING_REFRESH_LIMIT_PER_DOMAIN # default 500; safety cap per daily tick
AGED_GRADUATION_THRESHOLD            # default 8
AGED_GRADUATION_WINDOW_DAYS          # default 120
AGED_GRADUATION_DURATION_FLOOR_SEC   # default 10
AGED_REFRESH_REPORT_RECIPIENTS       # CSV override, otherwise dev/prod pool
```

---

## TODO breadcrumbs to drop while you build

```js
// TODO(aged-rolling-refresh): schema additions on LeadCadence
// TODO(aged-rolling-refresh): runDailyAgedRefresh entry point
// TODO(aged-rolling-refresh): runMonthlyGraduationSweep entry point
// TODO(aged-rolling-refresh): daily/monthly boundary helpers
// TODO(aged-rolling-refresh): hourly-sweeper wiring + idempotency keys
// TODO(aged-rolling-refresh): email report template + recipient pool
// TODO(aged-rolling-refresh): backfill migration for existing leads
// TODO(aged-rolling-refresh): retire runMonthlyFillerPoolRefreshIfDue
```

`grep -rn "TODO(aged-rolling-refresh)"` is the punch list.

---

## LD campaign attribution — what the queue side needs to consume

Companion to the aged-pool sweep is the LD custom / general split in
the vendor families email. The consumer end is wired:

- `LeadCadence.routeCampaignKey` is set at intake (value-detection on
  the LD payload — `GS03RB7W` → `ld-custom`, `JM8K5B7Y` → `ld-general`).
- `MasterProspectIndex.metadata.routeCampaignKey` is now stamped by the
  daily aged-pool promotion (this doc) so aged-tier queue items carry
  the campaign through.
- `CallLog.routeCampaignKey` is stamped at call-placed time by
  [cxCadenceService.handleCxCallPlaced](../packages/shared-services/src/cxCadenceService.js)
  from `queueItem.metadata.routeCampaignKey`.
- `CallLedger.routeCampaignKey` is mirrored by `syncCallLedgerFromCallLog`.
- `callLogSourceBackfillService` re-stamps from LeadCadence as the
  nightly safety net.
- Vendor families rollup splits LD into `ld-custom` / `ld-general` rows
  based on the campaign key.

**What the producer (queue) side must guarantee**:

1. Every materialized queue item carries
   `metadata.routeCampaignKey` + `metadata.routeCampaignName`. The four
   existing materializers in
   [cxWorkspaceService](../packages/shared-services/src/cxWorkspaceService.js)
   already do this (line ~2369, 2465, 2566, 2637) — verify any *new*
   materialization paths added during the queue rewrite also copy the
   field. Greppable anchor: `metadata.routeCampaignKey` in that file.

2. **RingCX publish path**
   ([ringcxLeadServingService.publishQueueItemToRingcx](../packages/shared-services/src/ringcxLeadServingService.js))
   — optional but recommended: surface the campaign key in a RingCX
   custom field so it's visible in the agent dashboard / interaction
   metadata. Not blocking for our internal rollups (which read from
   CallLog), but useful for live operator context. Greppable anchor:
   `TODO(ld-campaign-queue-feed)` in cxCadenceService for the
   consumption seam.

3. **Filler/aged path** — items materialized from MPI for the red
   tier read `prospect.metadata.routeCampaignKey`. The aged-pool
   refresh's MPI promotion now stamps this. If any other code path
   creates MPI rows for the aged tier (one-off scripts, manual
   backfills), they need the same stamp or the calls will land as
   `ld-posting` (legacy fallback) instead of `ld-custom`/`ld-general`.

If the queue side drops the field, the nightly backfill recovers
correctness for the email — but the real-time CX dashboards lose the
split. The producer-side stamp is the supply chain; the backfill is
the warranty.
