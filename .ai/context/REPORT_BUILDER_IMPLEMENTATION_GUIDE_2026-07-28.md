# REPORT BUILDER — IMPLEMENTATION GUIDE 2026-07-28 (v2, panel-verified)

## ⟳ BUILD STATUS — updated 2026-07-28 (read this first)

**Done and verified against live data: G1, G2, G6 (blocks), G4 (scheduler half).**
552 tests green (`tests/metrics` + config/cadence/inbound/queue/resolution/
logics-integration/trainer). Do NOT re-derive the settled decisions below.

| Step | State | Gate that was met |
|---|---|---|
| G1 | done | `reportOpsService` (18 ops) + 16 fixtures; SUCCESS-only split removed **$12,095.10** of phantom revenue over 5 days; 50,000-row cap splits recursively; `gatherSessionService` = 3 pulls cold / 0 warm |
| G2 | done | gathers `dials` · `postdateBilling` · `callsRange` · `caseContacts`; queue/recordings **loop or refuse**, never narrow to the last day |
| G6 | blocks done | +5 blocks (postdates, declines, effort, lag, streams) = 13 total; `renderHtml` derived from the csv column declarations, so no third renderer to drift |
| G4 | scheduler done, API routes NOT done | `ReportDefinition` + `reportDefinitionService` + `reportScheduleRuntime` (registered in server.js, **DISARMED**) + `scripts/report-schedule.js` |

**Live-verified numbers.** postdates block reproduces the standalone script
exactly: 51 post-dated → 11 converted (21.6%) → $4,699.97, split
21 no-billing-record / 15 declined / 4 not-yet.

**Bugs found by building this — do not reintroduce:**
1. `needs: ["events"]` is not a source name (`"activity"` is). The block
   gathered nothing and rendered a confident empty table. Now `SOURCES` is
   validated at module load AND mirrored by a test that greps gatherMaterial.
2. The live path never called `enrichAttribution`, so **$21,996.82** printed
   under "(unassigned)". Live payments carry NO `officerAtSale`/`sourceAtSale`/
   `phone` — only the stored snapshot does. "(no snapshot)" ≠ "(unassigned)".
3. `sendMail(domain, options)` is positional. Options-first throws at send
   time only — i.e. in production, at 07:00. Guarded by a mutation-tested check.
4. `callsRange` gathered only [from,to], so every call-to-close lag measured
   0 days — an artifact of the window. Now a 45-day lookback (`CALLS_LOOKBACK_DAYS`).
5. A case has several phones; matching only the primary reported 0 of 8 deals
   as call-covered when 7 of 8 were.
6. `distribution` had no `p90` while blocks printed `dist.p90` → `undefined`.

**Deliberately still OFF:** `REPORT_SCHEDULER_ENABLED` (default false). The
control plane on :5001 is running the OLD code — the runtime is registered but
will not exist until Mickey restarts. One unarmed definition ("morning board",
daily preset, yesterday, 07:00 PT) is saved in Mongo as a live smoke test.

**Next by build order:** G3 (RecordingIndex + PhoneBurner projection),
G4 remainder (`/api/reports` routes + job mode), G5 (front plate UI),
then G7 (persistence/reporting split) — G7 still carries the v1 blocker:
the migration must not stop attribution snapshots being written.


### Update 2026-07-28 (later) — attribution became a READ; sanitizer built

**Mickey's rulings this pass (settled, do not relitigate):**
- The lead source belongs IN Logics: "dont have to look it up again once you set it there."
- Forward-looking only cares about ACTIVE pieces; the other pieces stay on ABC.
  "if its not in logics with a match skip it and for now its just those 3."
- "this thing is part time report generator part time database sanitizer."
- Mail is TAG-only; BCD runs in BOTH TAG and WYNN and is all in CallRail;
  "95 percent of the work in call rail is mail matches."

**Built:** `logicsSourceSanitizerService` + `scripts/sanitize-logics-source.js`
+ `sourceSanitizerRuntime` (registered, DISARMED). Two independent switches:
`SOURCE_SANITIZER_ENABLED` (may it run) and `LOGICS_SOURCE_WRITER_ENABLED`
(may it WRITE). Both off = nothing happens; first on, second off = a standing
dry-run, which is the intended way to watch it.

**The join direction is the design.** Walking cases asks 12,670 shells "what
piece are you?" and 106 of every 120 have EVERY phone field blank. Inverted —
start from CallRail calls on an active piece, ask Logics whose number that is
— the same week yields 52 cases moved off ABC instead of 2.

**Bugs found and fixed this pass:**
7. Registry key `"3rd Day (Pink) Urgent Third State 800-921-9263"` went stale
   when the phone suffix was edited out of the CallRail source library on
   2026-07-27. Exact-match meant the HIGHEST-VOLUME piece (389 calls/45d)
   silently resolved to `unmapped-piece`. Matching stays EXACT — the library
   holds "URGENT THIRD PINK DAY 1" and "Affordability Pink State" as
   genuinely different pieces, so normalising would mis-tag live cases.
8. The `source` block never declared `caseContacts`, so the Logics read never
   ran: 34 of 39 July deals printed "(unsourced)". Now 13/8/4 across the three
   pieces with `(Logics catch-all)` carrying the 14-deal backlog.
9. One piece rendered as three rows (CallRail name, mail-sheet alias, canonical)
   fragmenting spend from deals. `canonicalSourceName` folds registered aliases.
10. Deal counts counted payment ROWS: case 394513 split its first invoice into
    two same-day $500 installments and counted twice. Now distinct sales.
11. `lag`/`effort` matched CallRail for EVERY domain although the account is
    shared — a WYNN deal could be credited to a TAG mail piece. Now
    `sourceFitsDomain`: mail ⇒ TAG only, BCD ⇒ any tenant, unknown ⇒ no.
12. A word-boundary escape became a literal 0x08 backspace FOR THE THIRD TIME
    (`/bcd/i` → `/^Hbcd^H/i`, matching nothing, failing open). The regex
    now uses no backslash escapes and a test scans the file for control chars.
13. `effort` was broken for EVERY tenant, not just TAG: DailyDial is 100% WYNN
    with a 15-day lifetime starting 2026-07-14. Rebuilt as two lanes that never
    share a median — inbound touches vs outbound dials are opposite agency.
14. `no-inbound-call` was a lie: CallRail sees TRACKING numbers only, so a main-DID
    call is invisible. Case 275341 was called call-free while CallLog held a
    45-minute inbound call on its pay day. Now `no-callrail-match`.

**Verified live (27-agent adversarial panel + direct measurement):**
TAG deals matched to CallRail 90.3% at 45 days, 93.5% at 13 months (Mickey said
95%). Touches to close: median 1, p90 2, max 3. Lag: median 0 days, p90 16,
max 43 — and 45d vs 90d lookbacks gave IDENTICAL distributions, so the result
is not a window artifact.

**Still open:** ids 57/64 and WYNN 45–49 are unidentified (no Logics endpoint
lists sources; the registry is hand-maintained). WYNN has no registry, so the
sanitizer plans nothing for it by design.


### Update 2026-07-28 (evening) — id map settled; attribution DEFINED

**Every SourceCampaignID is now identified** (intake-line evidence + Mickey):
TAG 57=ABC(catch-all) · TAG 64=BCD · WYNN 45=LD CUSTOM · 46=LD GENERAL ·
47=LD CUSTOM 2 · 48=LD CUSTOM 3 · 49=ABC(catch-all). Encoded read-only in
`SOURCE_CAMPAIGN_LABELS` (logicsSourceWriterService) — labels match the
spend-sheet keys EXACTLY so LD/BCD deals fold onto the same rows as LD/BCD
spend. The WRITE registry is unchanged: TAG 73/74/75 only, "just those 3".
July source table now: pink 13 · white 8 · ABC 6 · Affordability 4 · BCD 1 ·
LD CUSTOM 3 · LD GENERAL 2 · LD CUSTOM 2 ×1 · LD CUSTOM 3 ×1.

**THE attribution definition (Mickey, verbatim): "attribution for me is
longest call on the day the deal closed."** Implemented once as
`reportOps.pickAttributionCall`: longest close-day call wins (latest breaks a
tie); else longest call on the LATEST day before close; calls after close
never attribute. Adopted by ops.lag (source column; timing stays first-call)
and by the nightPass snapshot writer's CallRail fallback (pools ALL case
phones, then picks once — sourceVia records the basis). Three rules existed
before and disagreed: first-wins (rescue-case-source — still there, one-off
tooling, align when next touched), most-recent-wins (sanitizer lead-tagging,
unchanged: leads have no close day), first-match (lag — replaced).

**Scope ruling: "we are starting in july so most of this is just confirming
the guts."** No historical backlog cleanup; forward-looking correctness only.

**Known-deferred:** month-range reports show large "(unsourced)" RECURRING
totals because rows whose phone came from the CaseProfile mirror skip the
Logics fold entirely (the fold is what carries SourceCampaignID). Deals are
always folded; recurring is not. Cost to fix ≈ one getCaseInfo per paying
case per report (~1,400/month, ~4 min) — decide before month-end reporting.


### Update 2026-07-28 (night) — the persistence split

**`runNightPass({ persistOnly: true })`** returns immediately after the
per-domain loop, skipping the redline join, recordings, queue reads and the
rendered board. Both business-critical writes (ActivityEvent.insertMany,
persistPaymentTruths) sit BEFORE the cut and are reused verbatim — same
stamp-then-persist ordering, not a reimplementation. Verified on 2026-07-27:
14s, board/text null, 5/5 deals stamped with officer AND source, sourceVia
showing the new rule (`callrail:<phone>:longest-close-day`).

Registered as `night-persist`, task #1 of `nightlyHygieneRuntime`, gated by
its own `NIGHT_PERSIST_ENABLED`. nightBoardRuntime is UNCHANGED (persistOnly
defaults false) so nothing moves until the flag is flipped.

**Runtime defects fixed while doing it:**
15. The hygiene runtime counted work as `plan.length`, but night-persist's
    plan is a counter snapshot — plannedCount read 0 and apply() would NEVER
    have run. It would have looked armed and silently written nothing: the
    worst possible failure for the only writer of attribution snapshots.
    Tasks now declare their own `count()`.
16. `createNightlyHygieneRuntime` handed out the module-level TASKS array, so
    any caller mutating it reconfigured every other instance. Each runtime
    now owns its list.
17. `gatherMaterial` enriched attribution TWICE per live report (the second
    pass re-queried PaymentTruth for the same ids and covered only payments).
    Removed; the surviving pass covers declines and records why a row has no
    snapshot.

**Deliberately NOT ported** (the board is "very basic unless we add to it"):
recording ATTACHMENTS (links survive via the recordings block; settled
earlier as links-not-attachments), the branded HBS template, the money-in-
subject line, and four diagnostic sections. If the self-check sections
(money that failed with NO status change; deals with no source) are wanted,
they should become blocks rather than return to the runtime.

**Still gated on:** the adversarial write-loss verification (4 attacks +
judge). Nothing is retired until it returns GO.


### Update 2026-07-28 (late) — split VERIFIED, 7 consumer defects fixed

**Verdict on `persistOnly` itself: CLEAN.** A 4-attack adversarial review
(static inventory, caller safety, live equivalence, task guards) confirmed
both business-critical writes execute BEFORE the gate, the attribution stamp
still runs in the same loop immediately before the persist, and no other
caller passes `persistOnly` (nightBoardRuntime and run-night.js untouched).
The only skipped write is PhoneBurner OAuth token rotation — self-healing
infrastructure state, not business data.

**But every defect was in the CONSUMER I wrote, and every one failed
silently.** All fixed:
18. WRONG BUSINESS DAY. `dateKey: pacificDateKey()` at the 02:00 default hour
    is a day two hours old — overnight noise, while YESTERDAY's deals (the
    ones carrying the snapshot) were never pulled or stamped. It failed
    quietly: rows=0 → plannedCount=0 → apply() never ran → task reported
    success having written nothing. Now `persistTargetDay()` (offset -1),
    which also makes the pass restart-proof: a 14:00 restart still persists a
    COMPLETE day rather than a partial one and then claiming the day.
19. DOMAIN NARROWING. Defaulted to TAG; runNightPass defaults to all three.
    WYNN and AMITY events and payment truths would never have been written.
    Now TAG,WYNN,AMITY — tenant-specific tasks skip the rest themselves.
20. DOUBLE PASS. plan() ran the full gather, then apply() ran it AGAIN with
    apply:true, re-deriving attribution independently — so the numbers written
    were not the numbers reported, and a lookup that succeeded in plan() but
    failed in apply() persisted a weaker snapshot. runNightPass now collects
    `night.pending.{events,truths}` in dry mode and apply() persists exactly
    those. One pass.
21. NULL OVERWRITE of the protected field. The stamp did
    `t.officerAtSale = entry.officer || null` and persist does `$set: {...t}`,
    so a re-run whose CaseInfo/CallRail block threw wrote null OVER a good
    snapshot. Now never-null-over-non-null: attribution can be filled in or
    corrected, never erased by a bad night.
22. `eventsPersisted` counter never existed — the insert result was discarded,
    so the only operator-facing signal that ActivityEvent persistence worked
    read 0 forever. Declared and fed.
23. `describe()` read `counters.deals` (deals live on `night.lanes.deals`), so
    the summary said "0 deal(s) to snapshot" every night.
24. Return-shape asymmetry: persistOnly set fields the full path never did and
    left recordings/streams undefined. Aligned.

**Verified live, dry, on the completed day 2026-07-27:**
`2026-07-27: 2240 row(s) · 5 deal(s) · 2240 event(s) + 1123 payment truth(s)
to persist` — 14s, single pass, applied=null.

**First armed night, confirm snapshots landed:**
`db.controlplanepaymenttruths.countDocuments({ paymentDateKey: "<day>",
officerAtSale: { $ne: null } })` should be non-zero and match the deal count.

**Retirement of the board body is still NOT done** — it stays until the
persist task has run armed for at least one night and that query confirms it.

<!-- /BUILD-STATUS -->

The clean build document. Every primitive named here ran against live data
this session with measured costs; every claim below survived a three-lens
adversarial review against the actual code (1 blocker and 14 serious
findings from v1 are folded in — the largest: the nightly-board migration
would have silently stopped attribution persistence). Companions hold the
evidence; this document holds the plan and wins conflicts.

Mickey's brief, verbatim: *(1) "a front plate that lets me decide the shape
of a summary" (2) "persisting relevant data that can make some look ups
faster, mostly call recording urls … open to considering things that dont
change day over day" (3) "combining steps logically to answer any question
posed by the report … so its possible this is the part thats model guided so
we can create arbitrarily complicated and specific reports from the same set
of tools."*

And the capstone (2026-07-28, after the AMITY audit proved arbitrary
questions answerable): *"custom connectivity designer that can make lists
from my asking it a question i want the answer to and sorta the confirming
should we look here here and here and combine like this. okay heres that
report ... basically sure theres some basic reports you can run but custom
report builder that answers any question you have about our data."*

Final calibration (Mickey, same day): *"mostly this is a report scheduler on
the common things. so if i want to run something and email it tonight i can
set that up without talking to a model. but if i get asked an interesting
question we can design something that uses this set of tools to get an
answer."*

**TWO LANES, AND THE SCHEDULER IS THE DEFAULT.**
- **Lane 1 — the everyday tool (no model, ever):** pick blocks, set filters
  and a range, save the shape, schedule it, it emails tonight. Parts 1-2.
  This is what the app opens to and what it must be excellent at.
- **Lane 2 — the interesting question (model-guided, on demand):** ask ->
  plain-language proposal -> confirm -> run. Parts 3-5. An escape hatch for
  questions no saved report answers; a good answer graduates INTO lane 1 as
  a saved definition.

Lane 1 never waits on, degrades with, or requires lane 2. `ASK_ENABLED=false`
leaves a complete, fully useful product.

## 0. Settled doctrine

1. **Faceplate, not aggregator.** Reports gather live from the authoritative
   services. Measured: ActivityReport is range-native (one call per domain,
   any window — 5 days = 30s, a month ≈ 3 min); per-case billing ≈ 364ms.
2. **Events vs state.** Persist events; never report state from storage.
   The tell: if the answer could change without a new event, it is state.
3. **Three storage classes, and only three.**
   a. *Irreproducible history* — attribution-at-sale (`officerAtSale`,
      `sourceAtSale`, `clientName`, `sourceVia` on PaymentTruth).
   b. *Facts that originate with us* — SpendEntry, DailyCallStat, DailyDial
      (including PhoneBurner `recordingUrl`, already on the attempt schema).
   c. *Cached immutable provider artifacts* — droppable, rebuildable, never
      authoritative, cached only to avoid per-item fetch cost
      (RecordingIndex, PaymentTruth/ActivityEvent in `--cached` mode).
   Anything not in a class is gathered, every time.
4. **Money is a claim until Billing confirms it.** Cash comes from
   `Billing/CasePayment` rows (verified to the penny vs the manual CSV).
   Chargebacks key on PaymentTypeID 6 / negative amount, never status.
   **Composer material is SUCCESS-only** (`material.payments`); declines are
   a separate key (`material.declines`) that redline blocks declare — the
   live path must filter to SUCCESS exactly as the cached path does, or live
   cash silently inflates. (Panel finding: today they differ. Fix in G1.)
5. **Recordings are links.** CallRail recordings are durable **to re-fetch**
   (verified to Sep 2025); the lifetime of an already-issued URL is
   UNKNOWN — every index reader needs a dead-link re-fetch fallback.
   EX recordings never surface — allow-list by construction.
6. **RingCentral is a slow trickle; CallRail is the volume source; LD is
   PhoneBurner's own data.** Never re-auth RC per request.
7. **The email is for people who don't read emails.** Diagnostics go to
   logs/day-doc, never the reader.

---

## PART 1 — THE FRONT PLATE

### 1.1 The contract (exists, verified)

A report = **selection × filters × range × output**.
Blocks declare `needs`; the composer gathers the union ONCE. Filters slice
before any block computes; every report prints what it narrowed (`3/91
payments`). CLI: `scripts/build-report.js`.

### 1.2 Range semantics (panel finding — must be explicit)

`needs` come in two kinds, and the catalog must mark each:

- **Range-native** — payments, activity, spend, calls, dials(new),
  postdateBilling(new): one gather covers any window.
- **Day-scoped** — queue, recordings: the underlying reads take one dateKey.
  Over a multi-day range the composer either (a) iterates days under a hard
  cap (`RANGE_DAY_LOOP_MAX`, default 31, cost noted per day), or (b) the
  block declares `singleDay: true` and the composer REJECTS it for ranges —
  never silently narrows to the last day. Silent narrowing is what we do
  today; it ends here.

### 1.3 The block catalog

Verified: `money · spend · net · source · officer · cohort · status ·
recordings`. To add — each with its REAL gather cost named (the v1 claim
"adding a block touches nothing else" was false for 4 of 6; a block is
plug-in only when its material already exists):

| id | shows | needs (● = new gather to build) |
|---|---|---|
| `postdates` | created → converted → never-paid funnel, "declined" vs "no billing record" split (measured: 51/11/40, 21.6%) | ● `postdateBilling` — postdate events → full per-case history, 404 = no-billing-record (lift from `postdate-followup.js`; cost ~364ms × post-dated cases, ~51/mo) |
| `redline-recovery` | declines that later cleared, retries, recovered $ | `material.declines` (the §0.4 split) — live-only; cached mode lacks declines and the block must say so |
| `effort` | attempts before close per deal, median dials-to-close | ● `dials` — DailyDial per-case rows over a dateKey range (ours, cheap, range-native) |
| `lag` | response→deal days (call date vs first payment) | ● `callsRange` — per-day CallRail loop under the day cap. **TAG-only coverage**: WYNN/AMITY deals render in an explicit "no call coverage" bucket, never vanish |
| `intake` | new leads by source | activity (exists — `kind: "intake"` events already flow) |
| `queues` | answer rate + connections per agent per stream | queue, via the day loop; keep answerRate (today's fold discards it) |

Board-parity blocks (needed before the nightly migration, see 1.6):
`deals-detail` · `redlines` · `review` (day-doc/gap notes) · `bcd-line` ·
`pass-footer`, plus **`renderHtml` on every block** (only renderText exists).

### 1.4 API (control-plane; no existing /api/reports family — verified no collision)

```
POST /api/reports/compose        { selection, where[], from, to, domain?, output, cached? }
GET  /api/reports/blocks         catalog + presets + filter keys + range kinds
GET/POST /api/reports/definitions   saved shapes; optional { schedule }
POST /api/reports/definitions/:id/run
POST /api/reports/ask            { question, from, to }        (Part 3)
```

- Synchronous ≤ ~35s (a week). Longer → `202 { jobId }` + poll. **This rule
  binds `ask` too** — same gather underneath plus two model calls; nginx's
  7200s proxy timeout would let a month-long ask "work" by holding a socket,
  which is exactly what the rule forbids.
- Email output: send-once claim per (definition, dateKey).
- `domain` is hard-allowlisted `{TAG, WYNN, AMITY}` — **reject, never
  default**. (`getCompanyConfig` silently falls back to WYNN for unknown
  keys; the API layer must validate before that fallback can fire. Fixing
  the fallback itself to throw is a separate, wider change — flagged, not
  bundled here.)

### 1.5 UI (web client)

**Scheduler-first: the app opens to the saved-reports rail (run now /
scheduled / last sent) and the tick-box builder. The ask box (Part 5) sits
alongside as "ask a question" — present, not dominant.** Builder zones: block checkboxes (from `GET /blocks`, with
range-native/day-scoped badges) · filter rows (keys+ops from the catalog) ·
range chips · output. "Save this shape…" names a definition; saved shapes
can schedule. The UI renders server-produced sections and never computes.
Every render carries the `gathered` footer (rows, cases, seconds).

### 1.6 The nightly board migration (rewritten after the blocker)

v1 said "the runtime's body becomes `runDefinition('daily')` — migration,
not new machinery." **Wrong twice:**

1. `runNightPass` is the system's ONLY writer of attribution-at-sale
   snapshots, ActivityEvents, and `dayDocCompletedAt` — a body-swap would
   silently stop persisting the one storage class that cannot be re-derived.
2. Today's board email (HBS template, deals detail, redlines, review notes,
   BCD, attachments) is not reproducible from the current catalog — "byte-
   equal" was unattainable.

The correct migration, in order:
- **Persistence and reporting split.** The runtime keeps an explicit
  persist step (events + PaymentTruth + day-doc) BEFORE any reporting call.
  Persistence is never a side effect of an email again.
- Board-parity blocks + `renderHtml` land (1.3) — this IS new machinery and
  is budgeted as such.
- The runtime's reporting body becomes `runDefinition("daily")`.
- Gate: **section-content-equal** to a manual `build-report --pick daily`
  run (numbers and rows identical; byte-equality across an HBS template vs
  block renders is not a real target).

### 1.7 VERIFY (Part 1)

- CLI and API byte-identical block data for identical inputs.
- Live/cached parity: same day, same SUCCESS-only cash (the §0.4 fix).
- `postdates` reproduces 51/11/40/21.6%.
- A 30-day compose 202s and completes; a 1-day returns 200.
- A day-scoped block over a range either day-loops or rejects — never
  silently narrows.
- Migration gate per 1.6; attribution snapshots still written nightly
  (count PaymentTruth rows with `officerAtSale` before/after).

---

## PART 2 — THE NARROW LEDGER

### 2.1 RecordingIndex (storage class c — immutable artifacts only)

The panel killed v1's schema: it cached `reasons` (DEAL/POSTDATE) and case
matches, which are **state** — a call indexed at midday freezes as LONG
before the money loop confirms the sale, and an index HIT never re-fetches,
recreating the exact tagged-LONG bug we already fixed once. The index stores
only what is true forever:

```js
// controlplanerecordingindex
{
  platform: "callrail" | "phoneburner",   // allow-list enforced in code
  callId: String,                          // unique with platform
  listenUrl: String,
  dateKey: String,
  phone: String|null,                      // last-10, immutable call fact
  durationSec: Number|null,                // immutable once the call ends
  firstSeenAt: Date,
}
// unique { platform, callId } · index { dateKey } · { phone }
```

- **Reasons, case matches, officer, source: recomputed at read time, always**
  — exactly as `listNotableCalls` does now.
- Reader: index-first; on link failure → re-fetch via `getCallRecording`,
  overwrite (the §0.5 unknown-lifetime fallback).
- Writers (idempotent): nightly pass; on-demand recordings block
  (cache-through); PhoneBurner projection — which READS
  `DailyDial.attempts[].recordingUrl` (already persisted there by the
  webhook fix; the index is a queryable cross-platform projection of it,
  not the sole copy — v1 overstated this).
- Droppable: CallRail rows rebuild from the API; PB rows rebuild from
  DailyDial.

### 2.2 Kept as-is
Attribution-at-sale · SpendEntry/DailyCallStat/DailyDial · PaymentTruth/
ActivityEvent as explicit `--cached` mode · lookup tables (seed+learn+alarm).

### 2.3 Rejected
Aggregates of any provider's numbers · case status/balances ·
a reports warehouse (the gather is the warehouse).

### 2.4 VERIFY
- Second run over the same day: ZERO `getCallRecording` calls, links play.
- An index row ≥30 days old still plays (or the fallback visibly re-fetches).
- Drop + rebuild restores every CallRail row.
- A deal confirmed AFTER a call was indexed still renders as DEAL
  (reasons-at-read regression test — the tagged-LONG bug, pinned).

---

## PART 3 — THE THROUGH-LINE COMPOSER (model-guided)

The motivating asks and their decompositions:

| ask | plan |
|---|---|
| "Bruce makes 50% of his money on cases from 2024" | payments · filter officer=Bruce · groupBy cohort · measure cash · shareOf |
| "Phil does better on this mailer over this mailer" | payments+spend+calls · filter officer=Phil · groupBy source · compare{a,b} · costPer |
| "these LD clients were contacted N times, here's where they closed" | payments(deals, source=LD) + dials · joinAttempts · distribution |

**gather → filter → join → group → measure → derive → narrate.** The model
translates and narrates; it never computes.

### 3.1 The ops library (`reportOpsService.js` — G1, the real work)

```
DIMENSIONS (per material — category errors REJECT, panel finding):
  payments:  officer · source · cohort · domain · day · month
  queue:     agent · stream
  dials:     agent · pool · day
MEASURES cash · newCash · recurringCash · deals · payments · declines ·
         declinedAmount · dials · connects · responses · spend · count
OPS
  groupBy(rows, dimension)          — cohort groupBy emits an explicit
                                      "unattributed" bucket when the
                                      snapshot is missing; never silently
                                      substitutes payment-year
  measure(bucket, measures[])
  shareOf(buckets, measure, { of: "filtered" | "all" })
                                    — denominator is EXPLICIT; "all" uses
                                      pre-filter material (the panel showed
                                      "Bruce vs everyone" was inexpressible)
  compare({ a, b }, measures[])     — bucket selectors resolve by the same
                                      prefix rule as filters; neither-match
                                      → hard error listing available keys
  spendJoin / costPer               — maps spendBySource onto source buckets
                                      by the documented alias rule; an
                                      officer-filtered costPer uses FULL
                                      source spend and says so (or rejects)
  joinAttempts(payments, dials)     — caseId STRING/int coercion (the known
                                      trap); boundary DEFINED: attempts with
                                      callEndedAt ≤ end of firstPaidDate day
                                      count as before-close, and
                                      sameDayAttempts reported separately —
                                      same-day closes are the MODAL case
                                      (all 5 of 7/27's deals)
  lag(payments, callsRange)         — per-deal { callAt, paidAt, days };
                                      WYNN/AMITY → "no call coverage" bucket
  funnel · distribution · rank · topN · threshold
```

Pure, fixture-tested against live cuts (4,130-row dump · 90-payment window ·
51-post-date month · the same-day-close set).

### 3.2 Plans

JSON, stored with results, replayable. The executor validates EVERYTHING
before running — the full wall, not three named checks (panel): op name ·
per-op arg schema · dimension-per-material · measure names · filter keys ·
`needs ⊆ known` · **domain ∈ allowlist (reject)** · numeric args. And two
clamps the model cannot override:
- **Range is stamped from the request.** `plan.range` is ignored; "since
  2023" in a question cannot widen a gather to an hour of API traffic.
- **Cost caps by needs**: day-scoped needs obey `RANGE_DAY_LOOP_MAX`;
  recordings-bearing plans are bounded the same way.

Required plan field: **`interpretation`** — one sentence ("Bruce Allen's
payments, grouped by first-payment year") rendered as the table caption, so
a semantic misread is visible in one line (the cheapest defense against
valid-shape-wrong-question plans).

Executor warnings, loud: any filter matching 0 rows names the miss and the
known values ("officer=Bruse matched 0 of 91 — known: Bruce Allen, Phil
Olson…"); any groupBy yielding one empty bucket flags it.

### 3.3 Model calls (two, hard walls)

- **Plan — Sonnet.** Forced `tool_choice {type:"tool"}` (the
  `smsClassifierService` half of the pattern) **plus** strict schemas with
  `additionalProperties: false` (the `coachUnified`/
  `taxResolutionSalesTrainerService` half — v1 mis-cited this) **plus**
  exhaustive JS post-validation with reject-with-reason (Anthropic does not
  strictly enforce input_schema server-side). Explicit `maxTokens`,
  `timeoutMs ≥ 60s` (client defaults 1,200/25s). A planner timeout maps to
  the SAME degraded response as a rejected plan ("planner unavailable — the
  vocabulary is…"), never a raw thrown error.
- **Narrate — Haiku**, computed tables in, ≤5 sentences out.
  **The numeric validator is NEW WORK (G7), not an existing guard** — v1
  claimed a "same guard as the nightly email" that does not exist anywhere.
  Spec: canonicalize numbers on both sides (strip `$ , %`, parse to float),
  a narration number matches if it equals any table value exactly OR within
  round-half-up at the rendered precision; any unmatched number discards the
  narration and renders tables alone with a note. Fixture-test the guard
  with seeded-wrong numbers and with formatting variants ($1,716.67 /
  1716.67 / 50% vs 50.3%) — both false-accept and false-reject.

### 3.4 Surface

`scripts/ask.js "question" --month` · `POST /api/reports/ask` (obeys the
202 rule). Response = `{ interpretation, plan, tables, narration }` — the
plan is part of the answer; a good plan saves as a definition and graduates
to a schedule without new code.

### 3.5 Guardrails
Model never computes, never sees raw API responses · one plan + one narrate
call, no loops · plans execute through the composer (rate discipline and
EX exclusion by construction; the registry has no write op — "delete all
cases" is inert, verified by the panel) · numeric post-validation on all
model prose · `ASK_ENABLED` default off.

### 3.6 VERIFY
- Three motivating asks hand-checked against `build-report` equivalents.
- Nonsense/hostile question → plan rejection with vocabulary.
- Seeded-wrong narration discarded; formatting variants pass.
- `joinAttempts` same-day fixture (not just string/int coercion).
- Misspelled-officer plan → 0-match warning with known values, not an
  all-zeros table.
- Month-range ask → 202, completes as a job.
- Plan replay reproduces its tables from a fresh gather.

---

---

## PART 4 — COHORT FINDER (the tool beyond metrics)

Mickey 2026-07-28, after the AMITY UCFS run: *"this tool could run those same
sort of queries. so finding clients who fit a certain set of circumstances
loan info payment info etc. finding prospects who did certain steps but didnt
convert can be made into dialer lists. so this tool can exist beyond metrics
and you just got a key example of that on accident."*

The AMITY audit was not a report. It was a **cohort query that produced a
worklist**, and it used nothing but primitives already built. Formalising
that is a small addition with a large surface.

### 4.1 The universal shape: DID A, DID NOT DO B

Both motivating cases are the same query:

| ask | did | did not | window |
|---|---|---|---|
| AMITY UCFS gap | UCFS approval on AMITY | loan posted on the TAG case | since 2024-04-05 |
| prospects who stalled | post-dated / quoted / soft-pulled | ever paid | any range |
| upsell candidates | paid, resolution complete | taken the upsell | any range |
| dead loans | approved | funded | any range |

So the core op is `funnelGap(populationA, populationB, { by })` — everything
in A whose join key is absent from B. `by` is `case`, `phone` (cross-tenant,
via the fold), or `person`. The AMITY query is
`funnelGap(ucfsApprovals, tagLoansPosted, { by: "phone" })`.

A report answers *how many*; a cohort answers *which ones*, and the row IS
the deliverable.

### 4.2 Predicates (new, over material that already exists)

```
hasLoan / loanCount(n)            posted loans (type 8/9 or UCFS comment)
paidTotal(op, amount)             lifetime or in-window cash
lastPaymentAge(op, days)          silence detection
declinedSince(days) / retries(n)  redline candidates
statusIs(...) / statusCategory    client · prospect · reso · redline
softPull({ maxAge, minScore })    credit posture — score AND bureau
didStep(kind, payload?)           any ActivityEvent kind (post-date,
                                  conversion, approval, doc upload…)
notDidStep(kind)                  the gap half
crossTenant(domain, predicate)    "…and on TAG, this is NOT true"
contactedTimes(op, n)             DailyDial attempts (needs the `dials` gather)
```

Every predicate reads material the composer already gathers, or one of the
gathers budgeted in G2. No new API surface.

### 4.3 Intent — and the safety wall that hangs off it

**A cohort list is not a report.** A report that is wrong is embarrassing; a
dialer list that is wrong calls someone who said never call again. So every
cohort declares an `intent`, and the intent selects a gate:

| intent | gate | notes |
|---|---|---|
| `analysis` | none | CSV/email only. **Never dialable** — carries no phone column by default |
| `contact-prospect` | `resolveCaseContactEligibility` | blocks DNC, channel-DNC, and **payment-or-converted** (never cold-dial a client) |
| `contact-upsell` | `resolveUpsellContactEligibility` + `getUpsellContactAllowList` | intentionally targets paid clients — the one path where "is a client" is a qualifier, not a blocker |

Rules, non-negotiable:
1. The gate runs **per case at list build**, and every excluded row is kept
   with its `blockedReason` in a separate `excluded` section — a list that
   silently shrinks is a list nobody can audit.
2. **Lists expire.** Each carries `generatedAt` and `maxAgeHours` (default
   24). Someone who goes DNC on Tuesday must not be dialed from Monday's
   list — **re-gate at dial time, not just at build time**. The list format
   stores the gate result so re-gating is a diff, not a re-derivation.
3. `analysis` lists cannot be promoted to a contact list by editing a flag —
   changing intent re-runs the query with the gate applied.
4. Every row carries **why it qualified** (the predicate trail), so a human
   can challenge a list without re-running it.

### 4.4 Output

```
node scripts/find.js --did "ucfs-approved" --not "tag-loan-posted"      --by phone --from 2024-04-05 --intent analysis --csv

node scripts/find.js --status reso-complete --paid ">5000"      --not-did upsell-taken --intent contact-upsell --list "aug-upsell"
```

- `--csv` — the worklist (what we shipped for AMITY)
- `--list <name>` — a named, gated, expiring worklist
- `--email` — the summary with the CSV attached

A saved cohort is a definition (Part 1), so "the upsell list" becomes a
weekly artifact without new code.

### 4.5 What this does NOT become

- **Not a lead-delivery bypass.** A cohort list is an input a human or an
  existing delivery path consumes; the finder never dials, never enqueues,
  never writes to a case.
- **Not a segmentation store.** Cohorts are computed on demand like
  everything else; a saved cohort stores the QUERY, never the members.
- **Not exempt from the doctrine.** Same gathers, same rate discipline, same
  EX exclusion, same live-first rule.

### 4.6 VERIFY

- The AMITY UCFS query reproduces 46 / 36 / 15 / 15 / 6 expressed purely as
  `funnelGap` + predicates (the proof the generalisation is real, not a
  re-implementation).
- A `contact-prospect` cohort over a set containing a known DNC case
  excludes it **and reports it** in `excluded` with the reason.
- A `contact-upsell` cohort over the same set INCLUDES paid clients (the
  gates genuinely differ).
- A list older than `maxAgeHours` refuses to export for dialing until
  re-gated; re-gating shows the diff.
- Every exported row carries its predicate trail.

---

## PART 5 — LANE 2: ASK -> CONFIRM -> RUN

The on-demand path for questions no saved report answers. NOT the front
door — the app opens to saved and scheduled reports (lane 1), and this lane
sits beside them. The interaction makes the model layer both safe and
legible; nothing here relaxes a Part 3/4 guardrail — the confirm step ADDS
one.

### 5.1 The loop

```
 QUESTION      "which amity clients got ucfs approved but never
               got a tag loan, and when were they last soft pulled?"

 PROPOSAL      the plan, translated BACK to plain language, with its cost:
               +----------------------------------------------------+
               | I will look at:                                    |
               |  - AMITY activity since 2024-04-05 (1 call)        |
               |  - UCFS approvals found there (~46 cases)          |
               |  - each case's billing for posted loans (46 calls) |
               |  - TAG cases matched by every phone on file        |
               |  - latest soft pull per case                       |
               | Combine: approvals WITHOUT a TAG loan.             |
               | Estimated ~90s. Intent: analysis (not dialable).   |
               | [Run it] [adjust range] [add WYNN] [make it a list]|
               +----------------------------------------------------+

 CONFIRM       tap Run — or adjust. Chip adjustments edit the plan
               DETERMINISTICALLY (range stamp, domain allowlist, block
               add/remove); free-text adjustments re-plan.

 RUN           the executor, exactly as specced in 3.2/3.3. 202-job for
               long ranges. Tables + validated narration + the plan trail.

 AFTER         [save as report] [schedule] [csv] [email]
               [gate as contact list]   <- intent change = human action
```

### 5.2 Why the confirm step is load-bearing

1. **Cost control** — no gather fires until a human has seen what it will
   pull and what it costs. The estimate is DETERMINISTIC (needs x range x
   measured per-call costs; no model involved). Below a threshold
   (`ASK_AUTO_RUN_SECONDS`, default 10) the proposal auto-runs — a one-day
   money question should not ask permission.
2. **Semantic safety** — the 3.2 `interpretation` stops being a caption
   after the fact and becomes the contract before it. A misread question
   dies at the proposal, not in a confidently wrong table.
3. **Teachability** — the proposal names real primitives, so using the app
   teaches its vocabulary. Users graduate from questions to saved shapes.

### 5.3 The model's three roles (all propose-only; the executor is the wall)

| role | when | output | guard |
|---|---|---|---|
| **Planner** | on ask | plan + interpretation | full 3.2 validation; range stamped from confirmed values, never from prose |
| **Nudger** | after a result | plan DIFFS as tappable chips — "coverage was thin, widen to the full month?" / "split this by officer too?" / "6 of these have a TAG case — want just those?" | every nudge is itself a validated plan; tapping = confirming; nudges never auto-run |
| **Narrator** | on tables | <=5 sentences | 3.3 numeric post-validation |

The nudger is the "nudging reports along to get larger slices" role — the
model may PROPOSE widening; only a confirmation runs it. A nudge that fails
validation is silently dropped (a bad suggestion is noise, not an error).

### 5.4 Cohort questions in the app

A question that yields a LIST ("...and make it a dialer list") flows through
Part 4 unchanged, with one app rule: **the model may detect list intent but
may never select a contact intent.** Proposals default `intent: analysis`;
switching to `contact-prospect` / `contact-upsell` is a human tap that
displays the gate it engages ("this will exclude DNC and existing clients —
excluded rows stay visible"). The gate, expiry, and re-gate rules of 4.3
apply exactly.

### 5.5 Surfaces

- **App**: question box first; proposal card; result sections; right rail =
  saved reports ("basic reports" ship as pre-saved definitions: daily board,
  weekly close, month source ROI). The picker remains as "build manually".
- **CLI**: `scripts/ask.js "question" [--yes]` — prints the proposal and
  waits; `--yes` accepts auto-runnable proposals only (never contact lists).
- **API**: `POST /api/reports/ask` -> `{ proposal }`;
  `POST /api/reports/ask/:id/confirm` (with optional chip edits) -> result
  or 202 job. Proposals expire in 15 minutes; a confirm re-validates against
  the current vocabulary before running.

### 5.6 VERIFY

- The AMITY question, asked in plain language, yields a proposal whose
  executed tables match the audit (46/36/15/15/6) — the end-to-end proof.
- A proposal's cost estimate is within 2x of actual on the three motivating
  asks (estimates are honest, not decorative).
- A free-text adjustment ("only 2026") re-plans; a chip adjustment edits
  the plan without a model call.
- A nudge chip, tapped, produces exactly its promised diff.
- The model cannot set a contact intent (schema forbids it; test it).
- `--yes` refuses a proposal above the auto-run threshold.

---

## PART 6 — MIGRATION LEDGER (remove / keep / reuse / modify / add)

The demolition-and-reuse map the build steps execute against. Standing rule
applies everywhere: **retire, never delete** — removed files move to
`C:/code/TagContactBridge-retired/<date>-<patch>/` with a manifest row.
`.orig` files are never deleted and never committed.

### 6.1 REMOVE from the app

| surface | why | when |
|---|---|---|
| `apps/web-client/src/workspaces/metrics/MetricsWorkspace.tsx` (276L) | replaced by the report-builder screen (lane 1). This is the workspace the whole migration exists to retire | G5, once the new screen renders the daily preset |
| `apps/web-client/src/workspaces/metrics/PaymentsCsvImportCard.tsx` (113L) | already invisible (`PAYMENTS_CSV_IMPORT_VISIBLE = false`); the CSV lane it fed is retired doctrine | G5, with its parent |
| `apps/control-plane/src/routes/readMetrics.js` -> `GET /simple-sources/:domain` | its ONLY consumer is MetricsWorkspace | G5, same commit as the workspace retire |
| `scripts/report.js` (named-reports CLI) | subsumed by `build-report.js` (same reads, fewer concepts) | when build-report has CSV parity — verify officer/source/deals/status/cohort all render, then retire |
| `scripts/amity-ucfs-audit.js` + `scripts/postdate-followup.js` | one-off proofs; their LOGIC lifts into `funnelGap` + predicates + the `postdateBilling` gather | G10 — each retires only after its numbers are reproduced from primitives (4.6 item 1 / 1.7) |
| `apps/web-client/src/app/routes.tsx` entry for the metrics workspace | swap registration to the new screen — an EDIT, not a removal | G5 |

### 6.2 KEEP, deliberately (not part of this build)

| surface | why |
|---|---|
| `AttributionReviewPanel.tsx` (566L) + `GET /attribution-review/:domain` | the attribution-review flow survived the earlier gutting on purpose; it is an ops tool, not a report. Revisit only after G10 (a cohort could subsume it; do not pre-empt) |
| every other workspace (cx, postdates, trainer, inbox, ...) | out of scope — this build touches ONLY the metrics workspace |
| `nightly/daily-board.hbs` + the send-once claims | the scheduled email keeps its template until board-parity blocks + renderHtml exist (1.6) |

### 6.3 REUSE AS-IS (verified this session; zero changes to satisfy their part)

| existing code | satisfies |
|---|---|
| `reportBlocksService.js` — 8 blocks, presets, needs declarations | Part 1 catalog |
| `reportComposerService.js` — union gather, 6 filters, parseFilters | Part 1 contract (minus the G1 fix below) |
| `reportingService.js` — enrichAttribution, readPayments live/cached, readCoverage | Parts 1-3 |
| `build-report.js` CLI | lane 1 CLI, and the reference the API must match byte-for-byte |
| `paymentTruthService.js` — money loop, verification, supersedes | every cash number |
| `casePhoneFoldService.js` — spouse-inclusive fold | cross-tenant identity (Part 4 `by: "phone"`) |
| `nightRecordingsService.js` — notable calls, allow-list, durable-link handling | recordings block + RecordingIndex reader |
| `mailerQueueService.js` — streams (MAILER/BCD from RC, LD from PhoneBurner) | queues block material |
| `contactEligibilityService.js` — `resolveCaseContactEligibility` / `resolveUpsellContactEligibility` / `getUpsellContactAllowList` | Part 4 intent gates, exactly as exported |
| `mailerService.sendMail` (domain + transportDomain pinned to TAG) | every email output |
| `spendSyncService`, `statusMap`, `logicsAgents`, `callrailLookupService` | spend material, status/roster vocabulary, phone lookups |
| `smsClassifierService` (forced tool_choice) + `coachUnified`/`taxResolutionSalesTrainerService` (additionalProperties:false) | the two halves of the Part 3 model-call pattern |

### 6.4 MODIFY (the complete list — nothing else is touched)

| file | change | step |
|---|---|---|
| `liveGatherService.js` | the 50,000-row cap guard: slice + recursively halve capped windows, dedupe on (case, subject, Created) — CORRECTNESS fix, proven pattern in `amity-ucfs-audit.js` | G1 |
| `reportComposerService.js` | SUCCESS-only `material.payments` + `material.declines`; new needs (`dials`, `postdateBilling`, `callsRange`); the day-loop with `RANGE_DAY_LOOP_MAX` | G1-G2 |
| `reportBlocksService.js` | `renderHtml` per block; the 6 new blocks + board-parity set | G6 |
| `nightBoardRuntime.js` / `nightPassService.js` | persistence/reporting split (1.6) — persist step stays, reporting body becomes `runDefinition("daily")` | G7 |
| `phoneBurnerLeadDelivery.js` route | none — the forward-looking recording capture is already live; RecordingIndex PROJECTION reads DailyDial, it does not touch the route | G3 |
| `server.js` | register `/api/reports` routes + the RecordingIndex model | G3-G4 |

### 6.5 ADD (new files, the whole list)

| new | part |
|---|---|
| `packages/shared-services/src/reportOpsService.js` | 3.1 ops library |
| `packages/shared-models/src/RecordingIndex.js` | 2.1 |
| `apps/control-plane/src/routes/reports.js` | 1.4 API |
| `apps/web-client/src/workspaces/reports/` (screen + builder + saved rail) | 1.5 / G5 |
| `packages/shared-services/src/cohortFinderService.js` + `scripts/find.js` | Part 4 |
| `packages/shared-services/src/reportPlanService.js` (plan validate/execute) + `scripts/ask.js` + proposal API | Parts 3/5, lane 2 |
| `ReportDefinition` model (saved shapes + schedules) | 1.4 |

## BUILD ORDER (revised after panel)

Lane 1 is G1-G6 + the scheduler pieces of G3-G5 — a complete product with no
model anywhere. Lane 2 is G8-G9 and G12-G14, buildable later or never
without diminishing lane 1. G10-G11 (cohorts) serve both lanes.

| step | scope | gate |
|---|---|---|
| G1 | `reportOpsService` + fixtures; **live/cached SUCCESS-only parity fix + `material.declines`** | ops vs known numbers (51/11/21.6% · $21,053.82 cohort=2024 · 3/91 Bruce) · live=cached cash on the same day |
| G2 | new gathers: `dials` · `postdateBilling` · `callsRange` + the day-loop with `RANGE_DAY_LOOP_MAX` | each gather fixture-tested; day-scoped blocks reject or loop, never narrow |
| G3 | RecordingIndex (narrowed schema) + cache-through + PB projection from DailyDial | 2.4 VERIFY incl. the reasons-at-read regression |
| G4 | compose API + definitions + job mode + domain allowlist | CLI/API identical · 202 path |
| G5 | front plate UI | a saved shape runs and emails |
| G6 | new blocks (1.3) incl. board-parity set + `renderHtml` | each vs its measured number |
| G7 | persistence/reporting split in the runtime → `runDefinition("daily")` | 1.6 gate: section-content-equal AND attribution snapshots still written |
| G8 | ask: executor + validation wall, hand-written plans; the numeric validator | 3.6 items 1, 4, 5, 7 |
| G9 | ask: model plan + narrate behind `ASK_ENABLED` | 3.6 full, then soft-run |
| G10 | cohort finder: `funnelGap` + predicates + `analysis` intent | 4.6 item 1 — AMITY query reproduced from primitives |
| G11 | contact intents + eligibility gates + expiring lists | 4.6 items 2–5 |
| G12 | proposal flow: deterministic cost estimator + confirm API + ask.js confirm loop | 5.6 items 2, 3, 6 |
| G13 | the app surface: question box + proposal card + result view + saved rail | 5.6 item 1 end-to-end |
| G14 | nudger (plan diffs as chips) | 5.6 items 4, 5 |

Standing constraints unchanged: retire-don't-delete · dry-run defaults · no
live writes without explicit go · CX/RingCX untouchable · EX never surfaces ·
never re-auth RC per request.

## OPEN ITEM (named, not hidden)
**2026 source-attribution cleanup** — `rescue-case-source.js` is a proven
single-case prototype; the sweep over unsourced 2026 cases has not run.
Until it does, source/officer blocks carry honest `(unsourced)` /
`(unassigned)` rows. Scheduled as its own one-off, outside this build.

## WHAT NOT TO BUILD
A stats warehouse or scheduled aggregations · dashboards with their own
compute · commission payout math (deferred; notes preserved on every
payment) · model-in-the-loop for anything deterministic · a second source
of truth for anything a paid service already holds.
