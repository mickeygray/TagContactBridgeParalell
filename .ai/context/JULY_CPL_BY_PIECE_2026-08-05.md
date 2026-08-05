# July cost per lead — from the paid-piece CallRail file

Date: 2026-08-05
Inputs: Mickey's three exports — `Call List-2026-08-05.xlsx` (570 unique CallRail
calls, all on pieces we paid for), plus the WYNN and TAG initial-payment CSVs.
Status: read-only. Nothing written.

---

## Cost per lead

570 unique calls on paid pieces is the right denominator — web-form and aged
PhoneBurner volume (~3,000 and ~1,677) cost nothing and would flatter it.

| Piece | Spend | Mailed | Calls | **CPL** |
| --- | --- | --- | --- | --- |
| Urgent Third Pink State | $18,282.76 | 20,299 | 239 | **$76.50** |
| Urgent Third State | $18,255.55 | 20,299 | 234 | **$78.02** |
| Affordability Federal | $8,426.78 | 9,086 | 97 | **$86.87** |
| **Total** | **$44,965.09** | **49,684** | **570** | **$78.89** |

Response rate **1.15%** (570 calls / 49,684 pieces). The two Urgent Third
variants perform within $1.52 of each other; Affordability Federal costs ~11%
more per lead on a third of the volume.

## The payment reconciliation — your "close but different"

| | Deals | Money |
| --- | --- | --- |
| Your files | 54 | $50,500.51 |
| My PaymentTruth | 43 | $44,246.51 |
| **Gap** | **11** | **$6,254.00** |

Mine is a **strict subset** — zero deals I have that you don't, zero amount
disagreements on the 43 we share. The 11 split two ways:

**8 genuinely missing from PaymentTruth ($6,254.00)** — no row at all:

| Date | Domain | Case | Amount | Officer |
| --- | --- | --- | --- | --- |
| 07-31 | WYNN | 130897 | $700.00 | Chris Bolt |
| 07-30 | WYNN | 135364 | $300.00 | Brad Hansen |
| 07-29 | WYNN | 133008 | $250.00 | Chris Bolt |
| 07-30 | TAG | 421385 | $200.00 | Sean Lucas |
| 07-29 | TAG | 420575 | $1,666.67 | Phil Olson |
| 07-29 | TAG | 422354 | $187.50 | Sean Lucas |
| 07-28 | TAG | 422731 | $2,679.00 | Phil Olson |
| 07-15 | TAG | 415954 | $270.83 | Bruce Allen |

Five of the eight fall on 07-28 to 07-31, which points at ingestion for that
window rather than eight unrelated misses.

**3 are not July deals at all** — 365360, 336405, 381862 are **June** initials
whose July rows are recurring or chargebacks. Your report labels them "Initial"
by *case*, not by *row*. Two are $0.00.

## Tying calls to deals

**20 of your 54 deals have a CallRail call behind them** ($26,929.65). The other
34 ($23,570.86) do not — dominated by ABC (8), LD variants (11) and Tag Web
Forms, which are not CallRail-tracked pieces, so that is expected rather than a
gap.

## Where the agent breakdown FAILS, and why

Only **117 of 570** phones tie to a case, and **116 of those 117 had no outbound
agent touch at all**. That is not an agent-productivity finding — it is the wrong
question for this data:

- These are **inbound mail respondents**. The person who "touched" them answered
  a call; they were not dialed.
- July's outbound dialer served **WYNN**, while these pieces sell **TAG**.
- On inbound (`ex`) rows, `agentName` holds the **caller's** name — e.g.
  "Customer Service - CARDENAS GEORGE". The answering rep appears only as an
  `extensionId` (`63914586004` and similar), with no name mapping I can resolve
  confidently.

**So a per-agent split of these 570 leads cannot be produced from stored data
without an extension-to-agent map.** That map is the missing piece, and it is
small — the top eight extensions carry most of the volume.

## Two joins that failed first, recorded so they are not retried

- `CaseProfile.normalizedPhones` ties **1 of 570**. The profile phone index
  covers only 20,547 of 111,200 cases (18%), and mail respondents are largely
  not in it.
- `CallLog.normalizedPhone` ties **117 of 570** and is the correct bridge.

## What I would want next

1. **The extension-to-agent map.** It converts this from "570 leads, unassignable"
   into the per-agent CPL you actually asked for.
2. **Why 07-28 to 07-31 lost five payments** — the same window where three WYNN
   deals vanished.
