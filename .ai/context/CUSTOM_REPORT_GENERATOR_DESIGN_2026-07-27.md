# CUSTOM REPORT GENERATOR — DESIGN
Date: 2026-07-27 · Status: DESIGN (no code until Mickey approves)
Parent: METRICS_COACH_PATCH_WORK_ORDER_2026-07-27.md §3.10 / §0.6 #4

## 1. Purpose

> "They wanna see things indexed by a certain thing, I can get on and
> custom generate a report that is emailed." · "I need to share cost and
> profit data in a way they will deal with it." · Output = **CSVs and
> emails** (Mickey, 2026-07-27).

Mickey operates it from the faceplate. Recipients only ever receive an
email — a short written summary plus CSV attachments they can open in
Excel. Nobody is sent to a page.

**Not a backfill tool.** "We aren't gonna backwards fix it." Reports over
pre-August windows show history as it is (bare ABC, Unattributed, no CPL) —
honestly labeled, never retro-fixed. August 1 forward is the version that
makes sense: ST/FD sources, Logics CPLs, sheet-fed money.

## 2. Report definition (the whole input model)

```
{
  name:        "July initials by officer",        // subject line + filename stem
  index:       "source" | "officer" | "company" | "piece" | "day" | "week",
  window:      { preset: "yesterday" | "wtd" | "mtd" | "month" | "custom",
                 from: "YYYY-MM-DD", to: "YYYY-MM-DD" },   // from/to only for custom/month
  slice:       "ALL" | "LD" | "MAIL",             // THE meaningful split — see below
  domain:      "ALL" | "TAG" | "WYNN" | "AMITY",  // secondary filter, rarely used
  detail:      false | true,                       // attach row-level payments CSV too
  recipients:  ["...@taxadvocategroup.com", ...],
  note:        "optional one-line context shown atop the email"
}
```

Saved definitions live in a small collection (`ControlPlaneReportDefinition`)
so a recurring ask ("get me July by officer again") is one click. One-off
generation never requires saving.

**The split is LD vs everything — not WYNN vs TAG (SETTLED, Mickey
2026-07-27: "LD lives on wynn so in that the split is LD only and
everything not so much wynn vs tag").** WYNN's business IS the LD
operation, so the slice people actually mean is CHANNEL: `LD` (lead-data
leads/deals/money) vs `MAIL`/everything else. The `domain` filter stays
available but secondary; the WYNN-only nightly slice and the "LD sheet"
standing definition are the SAME view by two names.

**Recipients = a CHECKLIST of known people (SETTLED, Mickey 2026-07-27:
"maybe we can make a check list of known recipients and i can build the
pool of who the report is for").** A roster (`knownRecipients`: name +
email, maintained on the faceplate card) renders as checkboxes; each
report's pool is built by checking people off. Definitions store the
checked set. Free-typed one-off addresses still allowed in an "extra"
field, but the roster is the normal path.

## 3. Data inputs — all already built, all range-native

| Fact | Source of truth | Machinery |
|---|---|---|
| Money (cash + attributed, vintage split, officer) | PaymentLedger (sheet-authoritative) | `buildSimpleMarketingSummary({from,to})` totals/rows/byDomain/cashBreakdown/cashByOfficer |
| Deals by source / company | same | `initialsBySource`, `dealsBySourceByDomain` |
| Restatements | same | `chargebackRestatement` |
| Calls / responses | DailyCallStat (CallRail-direct) | summary rows |
| Mail spend | SpendEntry (mail sheet) | summary rows |
| Status changes (DNC, postdate, all categories) | Activities day JSONs | `readActivityStatusCounts(dateKey)` summed over window |
| Lead cost | **Logics CPL** (per source) | NOT in our DB — see §6 profit rule |

No new aggregation engine: the generator is a **formatter over the summary
read**, per index.

## 4. The six indexes and their columns

Every CSV: first column = the index value, then only columns that are
honest for that index. Shared money columns (from sale-attribution
doctrine): `deals, initials_$ (sale-attributed), cash_collected,
recurring_this_month, recurring_back_book`.

| index | rows | extra columns | notes |
|---|---|---|---|
| `source` | each active piece + LD + Aged + Unattributed | responses, calls, over5, mail_spend, cost_per_response, profit* | the board, as CSV |
| `officer` | each settlement officer | (money columns only) | from `cashByOfficer` + per-officer deal count (extend rollup: deals by officer — the ONE new aggregation this design needs) |
| `company` | TAG / WYNN / AMITY | dnc_count, postdate_count (per-domain activity counts) | calls NEVER appear here — see §5 |
| `piece` | each mail piece only (no LD/Aged) | pieces_mailed, mail_spend, responses, cost_per_response, profit* | the mailer view |
| `day` | each dateKey in window | + dnc, postdate per day | trend line as rows |
| `week` | each Mon–Sat block | same as day | feeds the Saturday ask |

`detail: true` adds `payments.csv`: one row per SUCCESS ledger row in
window — caseId, client, domain, date, amount, type, vintage, officer,
source, authoritativeSource.

**CSV/body split (SETTLED, Mickey 2026-07-27): "csvs should be thought of
as roi style reports. successful stuff but email bodies can be full
picture."** CSVs carry SUCCESS-only, ROI-shaped numbers — the thing a
recipient opens in Excel and forwards. Failed payments, restatements,
unsourced counts, gate status, and any caveats live in the EMAIL BODY
narrative, never as CSV rows. No exceptions, no flags to change it.

## 4.5 Standing definitions (ship pre-saved, day one)

Mickey (2026-07-27): "until it changes LD gets an LD sheet thats the same
level of granularity as the financials which gets the full wynn + tag
picture."

1. **"Financials"** — index `source`, domain ALL, full WYNN + TAG picture,
   money columns complete (cash, attributed, vintage split, restatements).
   Pool: the financial recipients (checklist).
2. **"LD sheet"** — the SAME columns at the SAME granularity, scoped to the
   LD slice (LD leads/deals/money only; no mail pieces, no other sources).
   Pool: the LD people (checklist).
Both editable like any saved definition; "until it changes" means these are
defaults, not code.

## 5. Hard constraints carried into every report

- **Calls cannot be split by company** (one CallRail tenant). `company`
  index has no call columns; a `domain` filter ≠ ALL greys out
  responses/calls in `source`/`piece` too — cell reads `n/a (shared
  tenant)`, never a number.
- **Cash headlines; attributed is labeled.** Both present, never blended.
- **EX never appears** — no recording links in reports; long-call data, if
  ever added, obeys the PB/CallRail allow-list.
- **Pre-cutover history is not rewritten** — Unattributed/ABC rows appear
  as themselves with no apology row-noise.

## 6. Profit — the honesty rule

`profit = initials_$ (sale-attributed) − cost`, where
`cost = mail_spend (sheet)` for pieces, `CPL × lead_count` for LD/ABC-ST/FD.
CPL lives in **Logics**, not our DB. Until a CPL source exists for the
index row: `profit` and `cost` cells read **`cost not configured`** — the
column never guesses and never silently omits. Implementation choice for
the CPL feed (pick at build time, Mickey's call):
  a) tiny `leadSourceCosts` config (env/JSON) Mickey maintains, or
  b) read from Logics source API if one exists.

## 7. Output + delivery

- **Email**: subject `[Report] <name> — <from>..<to>`; body = 3–5 sentence
  narrative (same machinery as the nightly: statuses/money/sources scoped
  to the window) + the index table rendered inline (simple HTML table,
  same simple-close styling) + attachments.
- **Attachments**: `<stem>-<index>-<from>-<to>.csv` (+ `-payments.csv`
  when detail). CSV: UTF-8, CRLF, header row, `$` amounts as plain
  numbers (Excel-friendly), dates as YYYY-MM-DD.
- **Send path**: existing `mailerService.sendMail` (attachments already
  supported by the vendor email path — verify at build).

## 8. Faceplate card (the only UI)

One card in the existing workspace: dropdowns (index, window preset,
slice LD/MAIL/ALL, domain [secondary]), date pair (when custom),
RECIPIENT CHECKLIST (the known-people roster, §2 — checkboxes, plus an
"extra address" field), detail checkbox, note field, buttons:
**[Preview]** (renders the table client-side, sends nothing) ·
**[Generate & email]** · **[Save definition]** (name it). Below: saved
definitions list, each with [Run] and [Delete]. No other screens.

## 9. API

```
POST /api/reports/preview    { definition }        → { narrative, table, rowCount }
POST /api/reports/generate   { definition }        → { sent, recipients, files }
GET  /api/reports/definitions                      → [ saved ]
POST /api/reports/definitions { definition }       → { saved }
DELETE /api/reports/definitions/:id                → { deleted }
```
Admin-auth only (Mickey). Generate is the ONLY sending path — no schedule
in v1 (the nightly + Saturday weekly emails cover cadence; a saved
definition + one click covers the rest).

## 10. Non-goals (v1)

- No dashboards, no charts, no PDF, no xlsx (CSV per Mickey — Excel opens
  it; no new dependency).
- No scheduled custom reports (revisit if Mickey ends up clicking the same
  Run every Monday).
- No recipient self-service. They receive; that is all.

## 11. Build order (when design is approved)

1. Officer deal-count extension in the rollup (only new aggregation).
2. `reportDefinitionService` (build table per index from the summary read;
   pure, tested per index against fixtures).
3. CSV serializer (tiny; tested for Excel quirks: commas, quotes, CRLF).
4. Email composer (narrative + inline table + attachments).
5. Routes + faceplate card.
6. Live proof: generate "July by source" and "July by officer" against
   real data, Mickey eyeballs both before any recipient list is real.

## 12. Open design questions for Mickey

Q1. SETTLED: checklist of known recipients; Mickey builds each report's
    pool by checking people off (roster maintained on the faceplate).
Q2. DISSOLVED (Mickey): the meaningful split is LD vs everything, not
    WYNN vs TAG. `slice: LD` behaves like the WYNN nightly email (only its
    own numbers, isolation-tested); the `company` index remains for the
    rare true per-domain ask and shows all three.
Q3. SETTLED in principle (Mickey: "i have to manualy insert it into the
    crm but its 3 seconds of work") — cost lives in Logics, hand-entered.
    Build-time investigation: if a Logics endpoint exposes per-source cost,
    read it (b); otherwise mirror the same 3-second value in a faceplate
    config (a) so our profit column matches what he typed into the CRM.
    Either way Logics remains the display of record for cost at case level.
Q4. SETTLED: CSVs are ROI-style — SUCCESS-only, always. The full picture
    (failures, restatements, caveats) belongs to the email body.
