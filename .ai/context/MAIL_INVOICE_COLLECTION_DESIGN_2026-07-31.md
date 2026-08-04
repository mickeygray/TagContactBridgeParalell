# Mail Invoice Collection — design

Date: 2026-07-31
Status: DESIGN — `MailInvoice` v1 exists and holds 2026-07-31 #83648. This
records what v2 must handle before the Gmail reader lands.
Owner: Mickey / Claude

## 0. What this replaces

The hand-maintained spend Google Sheet. The vendor emails two PDFs every day
and somebody was retyping the numbers into a sheet, which is why the sheet ran
two or three days behind and why the 8pm board reports `NO SPEND RECORDED`.

Changing the source changes the failure mode, which is the actual win:

```
before   somebody forgot to update the sheet      (silent, invisible)
after    the vendor did not send today's invoice  (detectable, alertable)
```

## 1. What is stable, measured on the sample

From `83648 Invoice - Daily Mail 7-31.pdf` and `83648_Receipt.pdf`:

| Property | Observed | Confidence |
| --- | --- | --- |
| Two attachments per day | invoice + card receipt | high |
| Invoice number in both, and in both filenames | `83648` | high — the join key |
| Job name carries the drop date, no year | `Daily Mail 7-31` | high |
| Two billed sections | Postage $1,009.20 / Services $224.91 | high |
| Sections reconcile independently | $971.32 + fee, and $224.91 | high |
| Postage lines carry a tracking fragment | `9263`, `6356`, `8323` | high |
| Print lines carry the piece NAME, no fragment | `3rd PINK Lttr …` | high |
| Card fee is a line, not a piece | `Our Permit` $37.88 | high |
| Receipt states the GRAND total | $1,234.11 | high |
| Receipt is a browser print-to-PDF | `Producer: Skia/PDF` | medium — could change tool |
| Template lists 39 descriptions; 7 billed | see §4 | high |

## 2. The three failure modes worth designing against

**A receipt counted as a cost.** It states the grand total, so misfiling it
doubles the day. Mitigated structurally: receipts live in a DIFFERENT
collection, so there is no field on the cost record for one to land in.

**A day silently missing.** "They sent nothing" and "they sent only the
receipt" and "we could not parse it" are three different problems. All three
must be distinguishable, or the nightly check reports a clean zero.

**A new mail piece appearing.** The map covers three fragments; the template
shows at least six more pieces the vendor can bill. An unmapped piece must
block ONLY its own money and must be loud, never rounded to zero or dropped.

## 3. Collection

ONE. `MailInvoice`, with the receipt embedded.

An earlier draft of this document argued for two collections on the grounds
that the receipt could arrive before, after, or without the invoice. Mickey
2026-07-31: *"i mean they both come in the same email."* That premise was
wrong, and with it the whole argument — there is no ordering problem to solve,
so a second collection would be machinery paid for with nothing bought.

The safety property that argument was really protecting survives anyway, and
more cheaply: the receipt lives in a SUB-DOCUMENT with no cost field, and
nothing sums `receipt.total` into spend. It states the invoice's GRAND total,
so counting it would double the day — but a nested object that has no place to
put a cost is as structural a guarantee as a separate collection was, without
the join.

What the same-email fact actually buys:

- **The email is the unit of work.** Both attachments are ingested together or
  neither is, so there is no window where a day is half-recorded.
- **`messageId` is the idempotency key for the day**, not just for a file.
- **A missing attachment is detectable immediately** — an email carrying one
  PDF instead of two is an anomaly on arrival, rather than a "wait and see if
  the other one shows up".
- The subject carries the invoice number, so the pair can be validated before
  either attachment is opened.

### `MailInvoice` — the cost

```
vendor / invoiceNumber          unique together; the vendor's own number
fileSha256                      re-issued invoice reusing a number trips this
jobName                         "Daily Mail 7-31"
serviceDate                     2026-07-31, the day the mail DROPPED
serviceDateSource               receipt | email | jobName+assumedYear
postageTotal / servicesTotal / grandTotal / cardFee
lineItems[]                     description, qty, unit, ext, section, source, confident
perPiece[]                      source, pieces, postage, service, feeShare, total, costPerPiece
pieceMapVersion                 so a later remap is detectable
state                           parsed | reconciled | review | superseded
reviewReasons[]                 unmapped-piece | totals-disagree | split-unproven
source                          how it arrived (see below)
spendDerivedAt                  set once, so spend cannot be derived twice
```

`serviceDate` deliberately does NOT come from the upload time. It is the day
the mail dropped, which is the day the money belongs to.

### The embedded `receipt`

```
receipt.total / capturedAt / method / authCode / transactionId
receipt.fileSha256
receipt.matchesInvoice          total === grandTotal ?
```

No cost field, ever. `receipt.total` is the SAME money as `grandTotal` — it is
proof the charge captured, plus a cross-check that billing and charging agree.
If those two ever disagree, something changed between the invoice being cut and
the card being run, and that is worth knowing before either number reaches the
board.

### The `source` sub-document

Everything the Gmail reader knows, so the row can be traced back to an email:

```
channel        gmail | manual-upload
messageId      Gmail id — the email-level idempotency key
threadId
subject        carries the invoice number too (Mickey, 2026-07-31)
from
receivedAt
attachmentName
```

`messageId` matters: re-running the reader over the same mailbox must not
re-ingest. Invoice number dedupes the DOCUMENT; message id dedupes the EMAIL.

## 4. The piece map

Keyed on the tracking fragment where one exists, because that is provable —
`9263` is the pink piece's CallRail number `800-921-9263`. Print lines carry no
fragment, so they match on piece name and resolve to the same source.

Pre-map from the TEMPLATE, not from what has billed. Known today:

```
9263  3rd Notice - PINK            -> 3rd Day (Pink) Urgent Third State
6356  Urgent 3rd White             -> Urgent Third State
8323  Afford Csnap                 -> Affordability Federal
```

Seen on the template, not yet billed — needs a source before it runs:

```
      3rd Pink Fed PC - 8 x 6 to 4 x 6
      State Citation PC - 8 x 6 to 4 x 6
      Tax Lien PC - 8 x 6 to 4 x 6
      Must Resp White - 8.5 x 14
      Pink Affordable Snap
      3rd WHITE Lttr - 8.5 x 11
```

Non-piece rows that must never become a source: every Data Processing and
Lettershop line (`Setup DP`, `CASS`, `NCOA`, `Folding`, `Inserting`, `Sort
Automation`, `Mail Drop`, …), and `Our Permit`, which is the card fee.

## 5. Deriving spend

> **SUPERSEDED BY §8 (2026-08-03).** Derivation writes `MailSpendDay`, NOT
> `SpendEntry` — both available sheetIds turned out to be traps. The gate below
> is right in spirit and wrong in two details: `allPiecesMapped` no longer holds
> the day (the remainder becomes a `MAIL UNMAPPED` row), and a re-issued invoice
> re-derives rather than being blocked by `spendDerivedAt`. Read §8.

Gated, and separate from ingest. A `SpendEntry` is only written when:

```
state === "reconciled"          totals agree with the line items
allPiecesMapped                 nothing in unmapped[]
spendDerivedAt == null          never twice
```

Otherwise the invoice stores and the day shows as needing review. Pieces are
counted from POSTAGE lines only — the same physical mailer is billed twice, so
summing every quantity reports double the mail actually sent.

## 6. The daily check

The invoice is PUSHED, so there is nothing to poll. The daily part is the
expectation.

Mickey 2026-07-31: "the invoice check can run once at the 8 pm thing."

BUILT — and it is deliberately two halves in two places, because ingest and
check are not the same job:

**Ingest — nightly hygiene, 19:50**, task key `mail-invoice`, armed by
`MAIL_INVOICE_MAILBOX_ENABLED` (currently OFF). It sits SECOND, after
`night-persist`: a mailbox read is the most stallable task in the loop, and
`night-persist` writes the one thing in the pass that cannot be recovered
later. Ten minutes of headroom before the report is the same ordering rule the
rest of the loop follows — fix the data, then report it. Running the ingest
inside the report would mean the first board of the day reported a cost it was
still fetching.

**Check — the 20:00 board**, in `gatherMaterial`'s spend block. It has to be
here rather than in hygiene because hygiene's `describe()` reaches only the
log, and a log nobody opens is not a check. The board is the only 8pm surface
an operator reads.

```
spend sheet has rows, no mail, no invoice ingested -> fail()    -> red, [DEGRADED]
invoice ingested but state=review                  -> fail()    -> names the reason
invoice parsed clean, absent from the spend sheet  -> advise()  -> amber
```

The check is silent when the spend sheet is missing ENTIRELY — that already
fires its own `fail()`, and it is one root cause. Two reds for one cause is
exactly the cry-wolf the failure/advisory split exists to stop. It speaks only
when it knows something the spend line does not.

The third band is amber on purpose: a clean parse that has not reached the
sheet is a plumbing gap, not a missing source, and the number is recoverable by
hand that night.

Still to build (the reader records what it needs for these, the board does not
yet distinguish them):

```
email arrived, fewer than 2 PDFs on it    -> fail()  -> "attachment missing"
```

The middle one is what a naive "is there an invoice for yesterday?" check
misses. Since both attachments ride a single email, the realistic failure is a
SHORT email — not a second file arriving late — and that is only visible if the
reader records how many attachments it saw, not just what it managed to parse.

## 7. Open

- **Year for `serviceDate`.** The job name has no year. Prefer the receipt's
  captured date (`31-Jul-2026`), then the email date, then today — and record
  which was used in `serviceDateSource`.
- **Sunk vs attributed cost.** Data-processing and lettershop setup lines are
  real money not attributable to a piece. Today they fold into the per-piece
  print cost. Whether they should stay there or become an unallocated bucket is
  a reporting decision, not a parsing one.

## 8. Spend derivation — BUILT 2026-08-03

Mickey: "its the same mail box as nco." / "you need to make a collection to
post the results into."

### The collection

`MailSpendDay` (`controlplanemailspenddays`) — one row per (serviceDate,
source), as billed. Day-atomic: no month-to-date, no ROAS, no cost-per-lead.

It is NOT a `SpendEntry` row, and that was the pivotal call. Both available
sheetIds are traps: under the mailer sheetId the 19:45 sheet sync retires
anything it did not write, so derived rows would vanish nightly and the board
would read LOW with nothing to say why; under any other sheetId the composer
SUMS it beside the sheet's own mail row and the day's cost doubles. A separate
collection is the only shape with a third outcome.

Doctrine: this looks like the stored STATE the house rule forbids, so — no
service holds this number. The PDF in our mailbox is its only holder, which
makes it a fact originating with us. A finished drop day's billed cost cannot
change; a correction is a NEW invoice, handled by retiring rows, not editing.

### The invariant

```
uq_mail_spend_active_day_source: {domain, serviceDate, source} UNIQUE
                                 partial on {active: true}
```

autoIndex is OFF in production, so this is not built by declaring it. Run
`node scripts/ensure-mail-spend-day-indexes.js` BEFORE the first derivation —
without it, two invoices for one day can both stay active and the double-count
the design prevents happens anyway.

### The merge — the invoice wins the whole day

`partitionMailSpend()` in reportComposerService, extracted and exported so the
invariant is testable without a database. For any day an invoice covers, the
sheet's mail rows are REMOVED and the invoice's rows stand in their place.
Never summed.

Whole-day, not per-source, deliberately. A per-source merge needs both sides to
agree on source naming, and any disagreement leaks a PARTIAL double-count that
sums to something plausible and so goes unnoticed. "Is this day invoiced?" has
an answer.

When both exist and disagree, the invoice is used and the gap is named via
`advise()` — a persistent gap means the sheet is being typed from something
other than the invoice, which is worth knowing.

### What the deriver refuses

A hold is not a failure; it is declining to report a number it cannot stand
behind. `state !== reconciled`, no perPiece, allocation off by more than $0.02
(the parser's own tolerance), or a GUESSED year more than 45 days from the
email that carried it — the January bug, where "Daily Mail 12-31" read in
January files as next December.

`allPiecesMapped === false` does NOT hold the day. The unmapped remainder
becomes a `MAIL UNMAPPED` row so the day still ties to the bill; holding would
show $0 mail cost against live pieces, a worse lie than an unattributed bucket.

### The mailbox

Same mailbox as NCOA, borrowing `user` and `gmail` ONLY. The NCOA config is not
spread in: it carries `markRead` and `archiveProcessed`, both defaulting true.
They are NCOA loop-body behaviour and inert here, but passing them implies a
coupling that does not exist.

Standing hazard, verified safe today: NCOA scans the SAME mailbox, and its
archive is gated on `acceptedAny` — having accepted an attachment. Its
`acceptedExtensions` defaults to `.csv/.txt`, so a PDF-only email is never
touched. **Adding `.pdf` there would archive the vendor's invoice email out of
the inbox and break this reader.**

`gmail` is passed by reference, unmodified — the client keeps a single-slot
token cache keyed on its config, so narrowing scope would force a re-auth on
every alternation with NCOA.

### Which email — corrected 2026-08-03

Mickey: "we wont be getting the last email but
WBS.accounting@wizbangsolutions.com where the subject includes todays date."

```
from:WBS.accounting@wizbangsolutions.com has:attachment filename:pdf newer_than:3d
```

Exact sender, not `from:wizbang` — that would also match sales, support, or
anyone forwarding a thread, any of which can carry a PDF.

**Recency is not the selector.** "The last email from the vendor" and "the
invoice for today" diverge the moment they send a correction or a statement,
and the wrong invoice parses exactly as cleanly as the right one — so picking
by recency fails silently, in money. The run passes `targetDate` and only the
email whose SUBJECT names that day is ingested.

The date is matched in code, NOT in the Gmail query. `subject:` is token-based
and the vendor's exact formatting is unknown; a wrong guess there returns an
empty list, which is indistinguishable from "they sent nothing" — the precise
confusion this reader exists to remove. Matching in code means a format
surprise reads as "3 vendor emails, none for today", which names its own cause
and prints the subjects it saw.

Accepted: `7-31`, `07/31`, `7.31`, `7/31/2026`, `2026-07-31`, `July 31`,
`Jul 31st`, `31 Jul`. Refused: neighbouring days, `7-310`, `17-31`, and money
(`$7.31` would otherwise read as July 31).

A year in the subject now leads `serviceDateSource` — it is the only date the
vendor typed on purpose, and it settles the January bug where "Daily Mail
12-31" read on Jan 2 files as next December.

Still assumed, not verified: the vendor's actual subject format. The matcher
covers the plausible ones and reports what it saw when none match, so the first
real run either works or names the format.

### Order

```
19:50  night-persist -> mail-invoice -> mail-spend-derive -> ...
20:00  the board reads the spend
```

Ingest and derive are separate tasks with separate flags, because reading the
mailbox and BELIEVING the number are different decisions. The first is safe to
run for weeks while nobody trusts the output.

Flags, both OFF: `MAIL_INVOICE_MAILBOX_ENABLED`, `MAIL_SPEND_DERIVE_ENABLED`.

### Still not built

- No backfill. Historical invoices are `parsed`, not `reconciled`; a backfill
  would rewrite months already reported.
- `nightReportService` ADOPTED THE MERGE 2026-08-03, earlier than planned and
  for a reason worth recording: `run-night.js` builds the board through it, not
  through the composer, so an end-to-end test would have emailed the SHEET's
  mail number while looking like it worked. Two reporting paths disagreeing on
  the same day's mail cost is worse than either being wrong alone — it makes
  both untrustworthy with no way to tell from the emails which is right. Both
  now call the shared `partitionMailSpend`.
- Still sheet-only: `spendEntryRepository.summarizeMailCosts`,
  `metricsPulseService`, `frontendReadService`, `metricsBackfillService`.
- "Email arrived with one attachment instead of two" still does not reach the
  board, though the reader records `attachmentsSeen`.
