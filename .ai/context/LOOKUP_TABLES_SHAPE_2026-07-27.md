# LOOKUP TABLES — SHAPE SPEC 2026-07-27

Companion to `ACTIVITY_FEED_SHAPE_MAP_2026-07-27.md`. Every vocabulary below
was censused from real data this session: 4,130 live activity rows (7/23 +
7/27), 12 real PaymentsReport exports (497 rows, 353 deduped), captured
CasePayment samples in `ops/`, plus a LIVE 9/9 join of 7/23 CSV rows to
`Billing/CasePayment`.

## 0. The design principle (proven, not aesthetic)

**Seed + learn + alarm.** The hand-maintained roster (`logicsAgents.js`,
April dumps) is already missing 10 of the names observed in July — including
Chris Bolt and Brad Hansen, who are actively closing deals. Hand-kept tables
drift silently; the 34.6% lesson says silent drift is the enemy. So every
table is:

- **seeded** from what we pinned today,
- **upserted on observation** by the nightly pass
  (`firstSeenAt / lastSeenAt / seenCount / examples`),
- **alarmed on novelty** — a never-seen status name, TagID, or officer in the
  nightly email is a review line, not a silent insert.

Proposed storage: ONE collection, kind-discriminated:

```js
// controlplanelookupentries
{
  kind:   "status" | "person" | "paymentType" | "paymentTag"
        | "merchantAccount" | "source" | "assignmentRole" | "activityLane",
  domain: "TAG" | "WYNN" | "AMITY" | "ALL",   // tenant-scoped where IDs collide
  key:    String,          // the id or canonical name
  value:  Mixed,           // the mapped payload (shape per kind, below)
  firstSeenAt: Date, lastSeenAt: Date, seenCount: Number,
  source: "seed" | "observed" | "joined",     // how we know it
  needsReview: Boolean,                       // novel value flag
}
// unique index { kind, domain, key }
```

## 1. status_catalog (kind: "status")

The activity feed speaks NAMES (`[Active Client]-Start Docs In`); the API
control lane (`Case/GetCasesByStatus`) speaks IDs; `statusMap.js` already maps
ID → {label, category, color} per tenant with colliding ID spaces (TAG 39+173
= DNC vs WYNN 173 = DNC, per doctrine). The new table joins the two axes:

```js
value: {
  statusId: Number|null,       // joined via Case/CaseStatusInfo when known
  bracket: "Active Prospect" | "Active Client" | "TIER n" | "Suspended"
         | "Bad/Inactive" | "RESO ONLY" | "Pending Approval" | ...,  // 10 observed
  label: "Start Docs In",      // the post-bracket suffix
  safetyClass: "dnc" | "postdate" | "suspended" | "redline" | null,
  tier: "T1".."T5" | null,     // parseStatusTier already derives this
}
```

16 full names observed in two days of transitions. Safety classes seen live:
DO NOT CALL, POST DATE (3 bracket variants!), 1st Payment Default, PAYMENT
DEFAULT STOP WORK / CONTINUE WORK. Note `POST DATE` appears under THREE
brackets (`Active Prospect`, `Pending Approval`, trailing-space variants) —
match on suffix label, never on the full string. Ignore self-transitions
(observed: DNC→DNC).

Name→ID join strategy: `Case/CaseStatusInfo?StatusID=x` (wired) over
statusMap's known IDs once, then learn stragglers when a case's `CaseInfo`
shows `StatusID` + `StatusName` together.

## 2. staff_roster (kind: "person")

Names arrive from FIVE observation points: activity `CreatedBy`, assignment
subjects (`Assigned to Set. Officer : X`), CSV officer/manager/worker/opener/
preparer columns, `CasePayment.CreatedByUserFullName`, and the existing
`logicsAgents.js` seed (per-tenant logicsId + roles + emails).

```js
value: {
  canonicalName: "Bruce Allen",
  aliases: ["Jacqueline  Santos"],   // double-space variant OBSERVED in data
  tagLogicsId: 404, wynnLogicsId: 24,   // from seed where known
  rolesSeen: ["Set. Officer", "Case Manager", "Tax Preparer", "gateway"],
  isServiceAccount: Boolean,   // "Mickey Gray" = the API lane (3,389/4,130 rows)
}
```

Known census: 19 CSV officers, 16 managers, 17 openers, 11 preparers;
~20 activity CreatedBy humans. Sentinels to keep OUT of person-space:
`--Unassigned--`, `Tax Advocate Group`, `Logics Support`, `Support Center 3`.
Special row: the gateway keyer (all `Payment made` rows are CreatedBy
Alexander Banks — he is the payments operator, not the officer; officer comes
from the case, proven by Richard Miller appearing on payments but in ZERO
activities).

## 3. payment_type (kind: "paymentType") — METHOD axis

**Naming-collision warning:** CasePayment `PaymentTypeID` = payment METHOD;
the CSV column called "Payment Type" = Initial/Recurring. Different axes.

Pinned by live join: `1 = Credit Card, 2 = Check, 6 = Charge Back, 8 = Loan,
9 = Loan Offset`. Chargebacks (3 live confirmations): NEGATIVE amount,
`TransactionStatus: "SUCCESS"` — key chargeback handling on type 6 / negative
amount, NEVER on status — and they carry the ORIGINAL sale's tag (the
restate-the-sale-month doctrine gets its join for free). Unobserved (learn on
sight): Refund, Cash, Offset. `PaymentTypeName` IS on the API row, so this
table self-learns; it exists to alarm on novelty and translate history.

## 4. payment_tag (kind: "paymentTag")

`TagName` is NULL on live CasePayment rows — TagID must be resolved by table.
Pinned by the 9/9 join:

TAG tenant:
```
0 = (untagged — on DECLINED attempts AND manual/hardship successes)
2 = Ad-Serv 1     3 = Origination Fee     4 = Initial Payment
5 = Ad-Serv 2     6 = Ad-Serv 3+
unknown: Investigation Fee id (learn from next joins)
```
**Tag IDs are PER-TENANT** (proven: WYNN success rows carry tag 1, which TAG
never uses) — same colliding-namespace rule as status IDs. The lookup's
`{kind, domain, key}` scoping exists for exactly this; never resolve a TagID
without the domain.

## 5. Initial/Recurring — a DERIVATION RULE, not a column

Nowhere on the API row (`MappedInvoices` empty on all 9 live rows). Derive:

- **Primary: first-payment-date rule.** A payment is `initial` iff its
  PaidDate equals the case's earliest-ever PaidDate in full CasePayment
  history. Evidence: 0/17 in-sample cases had an Initial row postdating the
  earliest date. Doctrine-aligned (sale month = first positive initial;
  split-tender same-day handling already exists in `simpleDealMathService`).
  The API gives FULL history per case — no export-window bias, which is
  exactly where the CSV column couldn't be reproduced.
- **Validator: tag rule.** `{Initial Payment, Investigation Fee, blank} →
  initial; {Origination Fee, Ad-Serv *} → recurring` — 350/353 (99.2%) on
  deduped CSV rows. Disagreement between the two rules → `needsReview`, never
  a silent pick.

## 6. merchant_account (kind: "merchantAccount")

4 gateway labels observed (CSV): `AUTHORIZENET | TAG Comerica` (360),
`AUTHORIZENET | Authorize` (54), `NMI | TAG npro` (28), `ACHSITE | TAG Npro
(E CHECK ACH ONLY)` (12). Live join pins `MerchantAccountID 8 = AUTHORIZENET |
TAG Comerica` (every CC row); id 3 observed in older captures; Check rows have
`null`. Doubles as a domain fingerprint (merchant names are per-company).

## 7. source_catalog (kind: "source")

29 distinct CSV source names + 2 intake sources (`Case received from ABC` /
`LD CUSTOM` — 3,095 intake rows in two days make this a free lead-source
feed). Dirty variants are REAL: `"4 - RVM \tSchwint #1"` carries a literal
tab; `LD CUSTOM` vs `LD CUSTOM 2` vs `LD Custom 3` differ by case. Seed from
`SOURCE_ALIASES` (paymentsSheetReconcileService) + the declared-feed doctrine
(one feed per number); canonicalize on write, alarm on novel source.

## 8. assignment_roles (kind: "assignmentRole")

4 observed: `Set. Officer` (57), `AS 433a` (3), `CPA/Attorney/EA` (2),
`OG Opener` (1). Grammar: `Assigned to <role> : <person>`. `--Unassigned--`
is a valid assignee (15 occurrences — treat as clearing the slot).

## 9. activity_lane (kind: "activityLane")

The 10 observed `Type` values with handling policy:

| Type | policy |
|---|---|
| Payment, CaseAccount, LOAN | typed money lane → parse subject, sweep case |
| General | grammar → typed events; residue → model lane |
| New File Uploaded, Document sent | doc lane (existing review consumes) |
| Conversation | model lane (summaries) |
| 1SOFTPULL / iSoftpull | credit score → MEANS ranking |
| RuleEngine | system echo — drop |

Plus the three system-partition signatures (exact-match, drop before all
processing): `Case received from *`, `Case updated by Public API`.

## 10. What deliberately does NOT get a table

- **AccountUsed / instruments** (281 distinct masked cards) — PII-ish, high
  cardinality, zero reporting value. Stays on the raw row only.
- **Task parentheticals** — free text, model lane, not vocabulary.
- **Team** (1 value: "Main Office") — until a second value appears; the
  novelty alarm covers it.

## Next probes (cheap, read-only)

1. WYNN-day reconciliation (the 9/9 proof is TAG-only).
2. `Case/CaseStatusInfo` sweep over statusMap IDs → pin name↔ID pairs.
3. A join on a Charge Back / Refund day → pin their PaymentTypeIDs (needed
   before the chargeback doctrine can run off API rows).
4. One deleted-payment case → confirm CasePayment shows only survivors.
