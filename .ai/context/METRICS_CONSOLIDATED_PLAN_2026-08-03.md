# Metrics — consolidated state and plan

Date: 2026-08-03
Status: SESSION HANDOFF. Nothing committed. No live flags flipped beyond §6.
Author: Claude (context exhausted — this is the durable record)

Read this first, then the two companion orders:
`DAILY_FACT_CAPTURE_WORK_ORDER_2026-08-03.md` (Codex owns the fact layer) and
`LEAD_DISTRIBUTION_INVESTIGATION_GUIDE_2026-08-03.md` (separate track).

---

## 1. What this session actually changed

**CORRECTION 2026-08-03 — THE SPEND SHEET IS NOT RETIRED.** Earlier text in this
plan said it was. That was wrong and it would have driven a bad deletion.

Mickey: *"they updated the sheet but didnt send me invoices"* / *"when they
normally send me invoices and dont update the sheet"* / *"so it sorta needs to
be able to use both."*

The vendor does ONE OR THE OTHER on any given day, not reliably both. So
`SpendEntry`, `spendSyncService` and the Google-sheet ingest are **LOAD-BEARING
FALLBACK**, not deprecated, and must NOT appear on any deletion list.

The merge already implements exactly this — `partitionMailSpend` gives the
invoice the whole day when one exists and lets the sheet's rows stand on days
it does not. Verified: 07-31 (invoice) reports $1,234.11 and ignores the
sheet's $1,200; 08-01 (no invoice) reports the sheet's $900.

What actually broke on 2026-08-01..03 was neither source: `spendSyncRuntime` is
constructed in `apps/control-plane/src/server.js`, which runs inside
**ParallelControlPlane — Manual + Stopped**. The newest mailer row in
`SpendEntry` is dated 2026-07-30, written 07-30 07:27. The same stopped service
is why the mail-invoice ingest has not run either. ONE restart fixes both.

Mail spend has TWO live sources; the rest of this section stands.

```
mail   the vendor's invoice, scraped from documents@   MailInvoice -> MailSpendDay
LD     new leads x $3                                  EventRecord receipts
BCD    bcd calls x $4                                  DailyCallStat, all versions
```

Proven end to end on 2026-07-31: invoice #83648 parsed ($1,009.20 + $224.91 =
$1,234.11), receipt cross-checked, 3 piece rows allocated to the penny, and the
board reconciles:

```
SPEND      $1,608.11  (mail $1,234.11 · LD $318.00 · BCD $56.00)
By source  LD  2 deals  $1,100.00  spend $318.00  ROAS 345.9%  $3.00 ea
Aged       no spend
Recurring (all databases)  $15,832.45
```

Also landed: per-agent attributed spend (mail allocated by share of calls
offered, BCD and LD per unit, with an explicit unattributed remainder);
settlement-officer roster on both per-person tables; 3-column status movement;
AMITY correct at zero marketing spend; the `(unsourced)` / catch-all rows
collapsed into one `Recurring (all databases)` line.

**550 metrics tests pass.**

---

## 2. The plan, in order

Each step is blocked by the one above it — mostly because they edit the same
file (`reportBlocksService.js`), and two agents in it at once is how one
silently reverts the other.

1. **Recordings into the email** — IN FLIGHT (`wire-recordings-into-email`).
   See §3. This is first because Mickey asked for it first.
2. **Vendor board: drop total recurring.** The LD-only board must not disclose
   company-wide back-book revenue. WATCH: the standing invariant is *hiding a
   row must never hide money* — the vendor top line must stop counting it too,
   or the board contradicts itself. `sourceSectionReconciles.test.js` exists
   because a filter once swallowed $4,836 and a real deal.
3. **Wire `ldAttributionWindow`** — 5pm→5pm, weekends into Monday. Written and
   tested in `ldSpendService.js`, NOT wired. See §4.
4. **Per-agent CSV completeness** — decide whether the email table noting that
   it excludes non-roster officers is worth it (see §5).
5. **Operator actions** — §6. Human only.

---

## 3. Recordings — the chain, and the one gap

The render was ALREADY BUILT. Do not rebuild it.

```
captured   safePayload.recordingReference          phoneBurnerLeadDelivery.js:87-100
   |
   |  <-- THE ONLY GAP: attempt.recordingUrl stays null because the validator
   |      accepts HTTPS only and PhoneBurner sends HTTP
   |      dailyDialLedgerService.js:28-36
   v
attempt.recordingUrl
   |  dailyDialCallLogProjectionService.js:140  -> recordingArchive.sourceUri
   v
nightRecordingsService.js:119  listenUrl
   v
reportBlocksService block "recordings" ("Calls to review") — listen links
```

Join key is `providerCallId`; the projection already refuses
`missing-provider-identity`, which is the guard against near-matching.

**Scope limits — violating these collides with Codex.** No second URL parser,
no discovery, no provider poll, no backfill, no second recording writer, and NO
SSRF fetch/redirect pipeline. The capture side is closed: URLs arrive and a
delivered link was manually proved. I already got this wrong once by
dispatching a full validation pipeline; the doc forbids it explicitly.

Keep only cheap local checks: absolute http/https, no embedded credentials,
exact host match from config (never `endsWith` — `evil-phoneburner.com`
satisfies that), bounded length. Fail closed, distinct rejection reasons.

Never log the link — and watch ERROR PATHS, where an interpolated URL bypasses
every deliberate log site.

**Capture cutoff `2026-08-03T20:57:45Z`.** Nothing earlier has a recording, so
7-31 gains no links. Expect them from today forward.

---

## 4. The two windows — DO NOT CONFLATE

**Billing = Pacific midnight.** What a day COST. Proven, not assumed:

```
day      UTC    PT   billed
07-25     81    86       86
07-26    106   111      111
07-27    103   105      105
07-28    120   101      101
```

PT reproduces all four; UTC matches none and 07-28 is off by 19 leads / $57.
`readLdSpend` / `countLdLeads` must NOT move off midnight.

**Attribution = 17:00→17:00, weekends into Monday.** WHO worked it, and which
board reports it. `ldAttributionWindow(dateKey)` in `ldSpendService.js`.

- A lead arriving 6pm is dialled next morning; midnight stranded 74 of 106
  leads on 07-31.
- **No board runs at the weekend but the vendor still delivers — more.**
  Sat 2026-08-01: 138 leads/$414. Sun: 130/$390. Fri: 106/$318. That $804
  appears on NO board and never would. Roughly **$3,000/month unreported**,
  flattering ROAS on every day that does run.

Monday will look like a spike. It is three days of inventory, first dialled
Monday. That is correct.

---

## 5. Known imperfections, deliberately left

- **The email's attributed-spend column does not sum to the total.** Pineda and
  Wells took mail calls carrying $86.10 but are off the board by roster. Email
  shows $1,206 of $1,292; the section summary carries the true figure. Same
  pre-existing property as deals/cash.
- **Reconciliation is near-tautological.** The residual is computed as
  `spend − agents`, so the identity holds by construction; drift is only
  non-zero when the clamp fires. The clamp DOES catch over-attribution and says
  so — but "reconciliation HELD" is not independent proof the components are
  right. A verifier separately recomputed spend from source across five days
  and ranges with zero drift; that is the real evidence.
- **Per-agent is limited to ranges ≤ 7 days** (`QUEUE_DAY_LOOP_MAX`). Monthly
  per-agent is not computable until the daily fact capture accumulates.
- **First-touch = first attempt carrying an `agentId`.** If anything automated
  touches a lead first without writing one, this measures "first agent after
  that". Unverified.
- **Corrupt spend dates** (`5026-05-05`, $3,273.46 across 5 rows) still trip the
  detector. It scans `SpendEntry`, which is retired, so the warning is now noise
  about a dead table.

---

## 6. Operator actions — human only, never an agent

- **`ParallelControlPlane` restart.** Manual + Stopped. Three `.env` flags were
  armed this session (`NIGHTLY_HYGIENE_ENABLED`, `MAIL_INVOICE_MAILBOX_ENABLED`,
  `MAIL_SPEND_DERIVE_ENABLED`) and do not take effect until it restarts.
- **`NIGHT_PERSIST_ENABLED`** writes attribution onto live client records —
  needs explicit authorization. Stored-fact persistence reported dead since
  2026-07-27 (audit finding, not independently confirmed).
- **`node scripts/ensure-mail-spend-day-indexes.js`** has been run. Re-run after
  any new environment.
- **This box cannot resolve SRV records.** Every Mongo connect needs
  `DNS_SERVERS=8.8.8.8`. The nightly runtimes will fail to reach Mongo on a
  fresh connection until that is fixed at the box level.

---

## 7. Commands

```bash
node --test "tests/metrics/*.test.js"
node scripts/report-schedule.js --run "financial roll up with calls" --date 2026-07-31 --send --force
node scripts/report-schedule.js --run "vendor roll up with calls" --date 2026-07-31 --send --force
node scripts/run-mail-invoice-mailbox.js --date 2026-07-31 --apply
node scripts/ensure-mail-spend-day-indexes.js
```

All Mongo-touching commands need `DNS_SERVERS=8.8.8.8` prefixed on this box.
**Never run `tests/lead-delivery/leadDeliveryRuntime.test.js`** — it hangs the
runner.

---

## 8. Known open gap — the 4 unattributable

Mickey 2026-08-03: *"the 4 missing leads we cant atrribute in calls is a fight
for another day."*

Deferred deliberately, not forgotten. Recorded here because the attribution
chain now has three steps and it is worth knowing which one these fall past:

```
1. stored sourceAtSale     — a real stored source always wins
2. attribution CALL source — the piece the prospect rang in on (CallRail)
3. LEAD source             — CaseProfile.sourceName, e.g. "ld-posting"
```

A case reaches "unattributable" only when Logics holds a catch-all or nothing,
CallRail saw no marketing call on it, AND the case carries no lead source.
That combination is real: an LD lead is dialled outbound so step 2 can never
fire for it, and a case that entered by some route we do not stamp has nothing
for step 3 either.

When picking this up: dump the offending cases and check which of the three
inputs is blank on each. If it is step 3, the fix is upstream — something is
creating cases without a `sourceName` — not in the report. Do NOT widen the
call match to non-marketing lines to close the gap; a servicing call naming a
source is worse than an honest blank.

---

## 9. Direction (TBD) — a morning "clean up the money" email

Mickey 2026-08-04: *"there would eventually be a morning email to Settlement
officers about where to clean up some money including red lines and overnight
calls but thats sorta a design tbd."*

Not designed, not built. Recorded so the pieces are not rediscovered.

**What already exists to build it from:**

- `status` block -> `REDLINES TO CHASE` (suspended / post-date / DNC), already
  one row per case per lane, already deduped.
- Weekend/overnight callers: measured 2026-08-01..02 as 31 inbound, 0 missed,
  **19 FIRST-TIME callers**, all 31 carrying a callback number. Concentrated on
  Urgent Third State (16) and 3rd Day Pink (10). These are mail responses that
  no board reported, because none runs at a weekend.
- Saved `ReportDefinition`s already carry blocks + schedule + recipients, so a
  07:00 M-F definition is configuration rather than code.

**The one real gap, and it is structural:** a definition has a single
`recipients` list and NO per-person scoping. A board addressed to five
settlement officers currently sends all five the same page. Per-officer content
means either (a) one definition per officer with a filter, or (b) a render that
splits by officer at send time. That decision is the design, and it is the part
worth thinking about before any block is written.

**Boundary note:** if it covers "overnight", use the same Fri-20:00 -> Mon-20:00
reach the LD cost day now uses, or Monday's edition silently omits the weekend —
the exact hole this document already records for LD spend.

**Do NOT** put mail/CallRail facts on a vendor board; CallRail is one TAG tenant.
