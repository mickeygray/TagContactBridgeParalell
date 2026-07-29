# ACTIVITY FEED SHAPE MAP — 2026-07-27

Evidence-first map of the Logics ActivityReport feed, built from **4,130 real
rows** pulled live on 2026-07-27 for Thu 2026-07-23 and Mon 2026-07-27, across
TAG / WYNN / AMITY, then reconciled against the real payments CSV for 7/23.

Mickey's brief: *"we can do everything in activities … pull activities from
last thursday and today and try to map the shape of everything we need."*

Raw dump: `scratchpad/activities-2026-07-23_2026-07-27.json` (session
scratchpad; regenerate with `pull-activities.js`).

---

## 1. Feed contract (the parts that bite)

- Endpoint: `POST Report/ActivityReport` with
  `{StartDate, EndDate, ReportName: "ActivityReport", Email}`.
- **Dates MUST be zero-padded** `MM/DD/YYYY`. `7/23/2026` → HTTP 400 (proven
  live; the service's `formatLogicsReportDate` already pads — keep using it).
- **Report rows are 9 fields** and are NOT the per-case activity shape:
  `CaseID, ClientName, Type, ActivitySubject, Created, CreatedBy,
  TaskOrActivity, LastModifiedDate, LastModifiedBy`.
  No `Comment`, no `ActivityID`. All detail beyond the subject line requires a
  secondary per-case call.
- **The window selects on LastModified, not Created** — a "RE REDLINE:" row
  created 11/20/2025 surfaced in the 7/27 report because it was edited 7/27.
  Consequences: (a) rows recur across days → cross-day dedupe is mandatory;
  (b) `Created` vs report-day tells you new-today vs re-touched.
- **No ActivityID in the report** → dedupe key is
  `(CaseID, ActivitySubject, Created)`. The per-case feed
  (`CaseActivity/Activity`) does carry `ActivityID` when exactness matters.
- Timestamps are Pacific strings `M/D/YYYY h:mm:ss AM`.

## 2. Volume + the system-lane partition

| | rows 7/23 | rows 7/27 | touched cases | staff-touched cases |
|---|---|---|---|---|
| TAG | 1,604 | 1,851 | ~1,500/day | 63 / 78 |
| WYNN | 372 | 261 | 110–197 | 33 / 14 |
| AMITY | 27 | 15 | 5–6 | 5–6 |

**The noise partition is exact.** On the two sampled days,
`CreatedBy = "Mickey Gray"` (the API service account) = 3,389 rows =
`Case received from ABC` (2,904) + `Case updated by Public API` (294) +
`Case received from LD CUSTOM` (191) — precisely the intake flood plus our own
writes echoing back. Filter those three subject signatures (not the name — a
human Mickey row must survive) and **~740 human rows/day remain across ~100
cases**. Never interpret `Case updated by Public API` rows: that is us reading
our own writes.

Bonus: `Case received from <SOURCE>` is itself a clean **lead-intake feed**
(source attribution per new case) if we ever want it.

## 3. Lane taxonomy (real Type values, real counts)

| Type | n (2 days) | what it is |
|---|---|---|
| General | 3,669 | everything below; see grammar |
| New File Uploaded | 218 | doc uploads (existing review already consumes) |
| Conversation | 97 | logged client conversations |
| **Payment** | 78 | **typed money lane — see §4** |
| Document sent | 43 | outbound docs/emails |
| 1SOFTPULL / iSoftpull | 11 | credit pulls, subject carries score |
| CaseAccount | 9 | payment-instrument changes |
| RuleEngine | 3 | automation echoes |
| LOAN | 2 | loan-funding events |

### General-lane subject grammar (139 distinct signatures)

Structured, regex-safe (with real 2-day counts):

- `Status changed from "[X]"  to  "[Y]"` (~45) — full status catalog names,
  DNC / POST DATE / TIER n / Suspended / RESO ONLY all observed. Note the
  DOUBLE SPACE around `to`. One self-transition observed (DNC→DNC) — ignore
  no-ops.
- `Assigned to Set. Officer : <Name>` (~43) — **the officer lane Mickey
  described.** Also `Assigned to AS 433a : <Name>`, `Assigned to OG Opener :
  <Name>`, `Assigned to CPA/Attorney/EA : <Name>`, and
  `--Unassigned--` as a name.
- `Converted from prospect to client` (6) · `Approved - Converted to client` ·
  `Converted to Prospect` · `Submitted for approval` · `Case created` — the
  deal lifecycle. WYNN 136657 showed the whole arc in ONE day: Unopened →
  Opened → POST DATE → prospect → submitted → approved-client, plus two
  `Payment Declined` rows.
- `Tax Liability changed to X from Y` (15).
- `Source updated to <SOURCE>` (8).
- `iSoftpull TransUnion Score: NNN` (score for MEANS ranking).
- Task machinery: `New task assigned to '<names>' (<free text>)`,
  `Task updated (…)`, `Task Completed (…)`, `Task deleted …` — the parenthetical
  is free text and often carries intent (`2ND PAYMENT`, `RUN PAYMENT`).

Free-text staff notes (the **model lane** — 93 one-off signatures): `SWC`,
`A/S REVIEW:`, `TAX PREP NOTES`, `Fed Reso Notes`, `RE REDLINE:`, `CUSTOMER
SERVICE:`, `RO CONTACT`, `FTB CASE`, `OG SALE'S NOTE`… Subjects are often
EMPTY labels (`"RE REDLINE:"` carries nothing) — the content is in the
per-case `Comment` field, which the report does not return.

## 4. The Payment lane (typed, subject carries the amount)

All observed forms:

- `Payment made $1,216.67` — money in, amount parses from subject
- `Payment Declined $250.00` — the redline/failed lane
- `Payment deleted $1,679.00` — corrections (373763: two deletes then a
  re-make at the corrected $559.67 — visible correction sequence)
- `Payment plan changed` · `New invoice item added` ·
  `An invoice item has been modified.`

## 5. Reconciliation vs the payments CSV (7/23, TAG)

CSV (PaymentsReport_20260724180827, PaidDate=7/23): 9 rows / $38,682.67.
Activity `Payment made` same day: 9 rows.

**7/9 matched on (case, amount) directly.** All four residuals resolved:

| gap | resolution | design rule |
|---|---|---|
| act-only 415022 $11,050 | in CSV with **PaidDate 7/22** (activity 7/23 12:10 AM) | activity date = detection date; authoritative PaidDate comes from CasePayment |
| act-only 102610 $200 | WYNN case; all sampled exports were TAG | per-domain, nothing wrong |
| csv-only 164652 $29,405 **Check** | hand-keyed check → NO payment activity, but case touched 8× that day | candidate set must be ALL staff-touched cases, not payment-lane rows |
| csv-only 245457 $6,200 | same — touched (softpull + uploads), no payment activity; its officer (Richard Miller) appears in ZERO activity rows | officer comes from the case record, not from activity CreatedBy |

**With the touched-cases rule: 9/9 = 100% coverage on the test day.**

## 6. Secondary calls (all already wired in `logicsClient.js`)

`Billing/CasePayment` per case — **superset of the CSV row**: real positive
`CasePaymentID` (CSV has none; importer synthesises negative hashes),
authoritative `PaidDate`, `Amount`, `TransactionStatus`, `TransactionID`,
`AuthorizationCode`, `PaymentTypeID/Name` (initial/recurring), `TagID/TagName`
(Initial Payment / Ad-Serv …), `AccountUsed`, `MerchantAccountID`,
`CheckNumber`, `Balance`, `MappedInvoices`, `CreatedByUserFullName`.

`Case/CaseInfo` per case — the case-level fields the CSV carried: client name,
status, and the assigned officer roster (names resolvable via
`shared-data/logicsAgents.js` settlementOfficerId maps).

**Sizing (measured):** ~100 staff-touched cases/day × 2 calls ≈ **under a
minute** at concurrency 3. Trivial.

## 7. The nightly one-pass shape (what to build)

1. **Pull** ActivityReport per domain for today (zero-padded dates).
2. **Partition** system lane (three intake/echo signatures) from staff lane.
3. **Deterministic grammar** over staff rows → typed events:
   payments (made/declined/deleted), status changes, officer assignments,
   conversions, liability changes, source updates, credit scores, doc uploads,
   tasks. Regex keeps its veto on DNC/post-date — a missed DNC is compliance,
   not reporting.
4. **Candidate sweep**: for EVERY staff-touched case, fetch
   `Billing/CasePayment` (+ `CaseInfo` where officer/name needed). This — not
   subject parsing — is the money authority. Catches check payments and
   anything keyed without an activity.
5. **Model pass (cheap, one batch)**: ~740 subjects/day in ONE Haiku call —
   classify the long tail, flag anything money/status/compliance-shaped the
   grammar missed, summarize staff notes. Union, never veto: the model widens
   detection; regex retains its floor. (Note-BODY reading needs the per-case
   `CaseActivity/Activity` fetch for Comment text — scope to flagged cases.)
6. **Persist** typed events + CasePayment rows (real `CasePaymentID` as the
   ledger key at last) → the daily close reads from here.
7. **External completeness check** (the self-certification fix): the nightly
   email prints payment-lane count vs CasePayment-row count vs prior-day
   deltas; month-end still ties against a pulled full-window CasePayment sweep
   (or the CSV's Grand Total when a sheet exists). A pull that both produces
   and certifies its own coverage is not a control.

## 7.5 Probe result: the sheet CANNOT be pulled server-side

Probed live 2026-07-27: `Report/ActivityReport` with
`ReportName: "PaymentsReport"` returns 400 with the validation body
`"ReportName must be 'ActivityReport'."`; direct paths
(`Report/PaymentsReport`, `Report/PaymentReport`, `Report/Payments`,
`Report/CasePaymentsReport`) all 404. **The API exposes exactly one report.**
The manual CSV is a web-UI report-builder artifact with no API twin.

Therefore the external completeness control (replacing the CSV's Grand Total
footer) must be an independent ENUMERATION, not an independent report:

- **Nightly driver**: staff-touched cases → `Billing/CasePayment` (§7.4).
- **Periodic control** (weekly / month-end): enumerate the paying universe via
  `Case/GetCasesByStatus` (already wired — status-driven, server-side, NOT
  derived from the activity feed) ∪ every caseId ever seen in the ledger, and
  sweep `CasePayment` over the window. Disagreement with the nightly
  accumulation = the alarm. This is a genuinely independent axis: a payment
  needs a case, and paying cases sit in client/prospect statuses.
- **Occasional manual CSV** stays as a third-party audit — the parser is
  retired-not-deleted, so a hand-dropped export can always be diffed.

Residual hole named honestly: a hand-keyed payment on a case with ZERO
activity that day evades the nightly sweep (keying a check provably writes no
activity). The periodic control exists precisely to catch that class; observed
frequency in the sample: 0 of 9 (both check/no-activity cases were touched).

## 8. Open items

- WYNN/AMITY reconciliation unproven (no WYNN export in the sample) — run the
  same 9/9 test on a WYNN day before trusting cross-domain.
- `Payment made` on a deleted-then-remade payment: confirm CasePayment shows
  the surviving row only (expected — it is the ledger of record).
- Multi-domain case collisions: report rows carry no domain; domain comes from
  which client pulled them. Keep the per-domain pull loop.
