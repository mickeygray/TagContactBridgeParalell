## Nightly Vendor Email Spec

### Goal

Make the parallel nightly vendor email feel like the legacy nightly process where it matters, while using the newer ledger/daily model for better consistency.

The nightly vendor email should be a `final close` for the business day, not just a shallow read of whatever hourly happened to leave behind.

### Scope

Primary scope is `WYNN` vendor reporting.

Tracked vendor families:
- `LD Posting`
- `Lead Form Affiliate`
- `Social / VF / Landing Page`

Non-vendor channels like `mail`, `BCD`, and `CallFire` should stay out of this specific nightly vendor email unless explicitly added later.

### Required Email Output

#### 1. Calls summary

Include all `WYNN` calls that came in for the report date, with:
- call time
- caller phone
- matched case id
- matched lead/source attribution
- call duration
- whether a recording exists
- whether a transcript exists
- score / verdict when available

Body should summarize:
- total calls
- calls over 2 minutes
- calls over 5 minutes
- scored calls
- average score
- hot / warm / cold / dead / fake counts

Attachment:
- `wynn-vendor-calls-YYYY-MM-DD.csv`

#### 2. Lead counts by source

Count leads from `LeadCadence` for the report date, grouped by tracked vendor source family and specific source name.

For each source row include:
- source family
- source name
- lead count
- first-touch channel
- created-at day bucket

Body should summarize:
- total vendor leads
- totals by family
- totals by source

Attachment:
- `wynn-vendor-leads-YYYY-MM-DD.csv`

#### 3. Outcome/status changes by source

For those same tracked vendor leads, report:
- how many became `DNC`
- how many became `Postdate`
- how many became `Deal`
- if a deal happened, how much was collected

Collected should include:
- initial amount
- total collected amount

This needs to be grouped by source family and source name.

Body should summarize:
- total DNC today
- total Postdate today
- total Deals today
- total initial collected today
- total collected today

Attachment:
- `wynn-vendor-outcomes-YYYY-MM-DD.csv`

#### 4. Small body, detailed attachments

The email body should stay concise:
- top-line totals
- family rollups
- exceptions / attribution holdouts

The detail lives in attached CSVs.

### Data Source Contract

#### Body should prefer daily/ledger truth

Use daily/ledger-backed reads for top-line body totals whenever possible:
- `CallLedger`
- `PaymentLedger`
- `DailyCallStat`
- `SpendEntry`
- `LeadCadence`

#### Attachments should come from a fresh nightly close pass

Attachments should be built from a final nightly report pass that re-reads the underlying truth directly, not only from pre-aggregated daily rows.

That final pass should inspect:
- `CallLog` and `CallLedger`
- `LeadCadence`
- `CaseProfile`
- `PaymentLedger`

### Nightly Execution Model

The vendor nightly should run in this order:

1. `Final payment reconcile`
- run one last payment sweep
- make sure same-day payments are in `PaymentLedger`
- sync case profile payment totals

2. `Final call hygiene`
- ingest/mirror any remaining calls
- attach transcript/score where available
- sync `CallLedger`
- refresh touched case profiles

3. `Final status reconciliation`
- re-check relevant vendor cases for current status
- record DNC / Postdate / Deal outcomes for the report date

4. `Build report rows`
- build lead rows from `LeadCadence`
- build call rows from `CallLedger`
- build outcome rows from `CaseProfile` + `PaymentLedger`

5. `Compose email`
- body from summary totals
- attachments from detailed rows

### Missing Pieces To Build

#### Status outcome finality

Current parallel nightly can count current statuses, but the vendor nightly wants stronger same-day finality.

Needed:
- a stronger end-of-day outcome pass over tracked vendor cases
- preferably a first-class status/outcome ledger later

#### CSV attachment builders

Needed:
- call export builder
- lead export builder
- outcome export builder

#### Vendor-focused nightly composer

Current `nightlyCloseService` is broader management reporting.

Needed:
- a dedicated `vendor nightly` composer for WYNN
- concise body
- three detailed CSV attachments

### Important Behavioral Rule

Hourly is there to keep metrics alive and mostly correct.

Nightly must still do one last deep and thorough pass before sending, because:
- status changes can lag
- payments can land late
- call scoring can complete after the hourly
- attribution can get corrected during the day

So the nightly vendor email should be:

- `body = daily / ledger front plate`
- `attachments = fresh final report pass`

### Acceptance Standard

This is ready when a nightly vendor email for `WYNN` can be compared against the legacy nightly process and it:
- captures the same basic business truth
- includes attached CSV detail for calls, leads, and outcomes
- is at least as useful operationally
- is slightly more accurate because it is backed by ledgers plus a final close pass
