# July 2026 look-back — independent pass

Date: 2026-08-05
Method: dialer + call + payment sources, run independently of Mickey's
mailer-queue hand count, as a cross-check.
Status: **read-only.** Nothing written, nothing changed.

---

## THE HEADLINE: the dialer and the deals were different tenants

```
JULY DEALS                          PHONEBURNER DIALED IN JULY
  TAG    34 deals   $39,806.84        wynn   8,736 unique cases
  WYNN    9 deals    $4,439.67        tag    (none)
```

PhoneBurner served **WYNN exclusively** in July, while **79% of the deals and 90%
of the money came from TAG** — cases the dialer never touched.

So a per-agent cost-per-lead built from PhoneBurner cannot explain July's
revenue. The agents' dialing and the month's deals are largely disjoint
populations. Mickey's mailer-queue count and this dialer count are measuring
different things, and they *should* disagree — that is the answer, not a
reconciliation failure.

Confirmed by case-id range, which is per tenant: dialed cases run 102k–112k,
deal cases run 275k–426k.

## THE SECOND BOUNDARY: July is two different dialers

```
Jul 01–13   CX (RingCX)      5,650 calls    7 agents      41 recordings archived
Jul 14–31   PhoneBurner     21,038 calls    5 agents       0 recordings archived
both        EX (inbound)     7,415 calls               1,097 recordings archived
```

DailyDial starts exactly 2026-07-14 because that is when PhoneBurner *became*
the floor. Any "how many leads did each agent handle in July" answer has to span
both, and the two systems do not record the same things.

---

## Unique cases handled per agent

**Jul 14–31 — PhoneBurner (DailyDial), WYNN only**

| Agent | Unique cases | Day-rows | Attempts |
| --- | --- | --- | --- |
| chris_bolt | 5,121 | 6,514 | 8,955 |
| brad_hansen | 4,447 | 5,697 | 7,802 |
| sean_lucas | 1,320 | 1,370 | 1,811 |
| bruce_allen | 1,017 | 1,066 | 1,233 |
| phil_olson | 987 | 1,002 | 1,250 |

**Jul 01–13 — CX floor (CallLog)**

| Agent | Unique cases | Calls |
| --- | --- | --- |
| Brad Hansen | 1,869 | 2,266 |
| Chris Bolt | 1,552 | 1,834 |
| Sean Lucas | 859 | 941 |
| Phil Olson | 377 | 408 |
| Bruce Allen | 37 | 37 |
| Mickey Gray | 9 | 9 |
| James Sharp | 1 | 1 |

## Deals and money by officer — chargebacks excluded

| Officer | Deals | Money |
| --- | --- | --- |
| Phil Olson | 12 | $16,650.85 |
| Sean Lucas | 8 | $10,476.99 |
| **(NO OFFICER)** | **9** | **$8,488.67** |
| Bruce Allen | 7 | $5,200.00 |
| Chris Bolt | 5 | $3,150.00 |
| Brad Hansen | 1 | $280.00 |
| **TOTAL** | **42** | **$44,246.51** |

Nine deals worth $8,488.67 carry no officer — the same attribution gap that put
yesterday's WYNN BCD deal in "unattributed."

**Chargebacks (all `recurring`, excluded above):**

| Officer | Count | Amount |
| --- | --- | --- |
| (none) | 6 | −$10,956.32 |
| Sean Lucas | 1 | −$1,000.00 |

**On Bruce specifically:** 7 initial deals ($5,200) plus two recurring payments
on case 392380 ($2,400 + $6,000 on the same day, 2026-07-14). **No chargeback
exists against any case Bruce sold in July** — checked at any date, not just
July. If a Bruce chargeback is expected, it is not in PaymentTruth.

## Spend

| Channel | July |
| --- | --- |
| mailer | $44,965.09 (23 of 31 days) |
| lead-data | $13,311.00 (28 days) |
| **Total** | **$58,276.09** |

LD leads actually received in July: **4,743** → at $3 = **$14,229**, against
$13,311 recorded. A $918 gap, ~306 leads.

Blended: **$58,276.09 / 42 deals = $1,387.53 per deal.**

Per-agent cost-per-lead is NOT computed here, deliberately — see the headline.
Allocating spend to an agent requires knowing which leads they worked, and their
PhoneBurner work was WYNN while the spend bought TAG mail.

## Touches to a deal

Only **3 of 24** deals in the PhoneBurner window have any dial history, and that
is the tenant split showing up again rather than a data fault:

| Case | Officer | Amount | Touches | Days | Dialed by |
| --- | --- | --- | --- | --- | --- |
| 137912 | (none) | $400 | 8 | 4 | chris_bolt, brad_hansen |
| 137329 | Brad Hansen | $280 | 3 | 1 | brad_hansen |
| 123682 | Chris Bolt | $450 | 1 | 1 | chris_bolt |

Min 1, median 3, max 8 — on a sample of three, which is too small to conclude
anything from.

## Recording links for July deals — NOT AVAILABLE

**Zero.** PhoneBurner recorded nothing in July: `DailyDial.recordingUrl` is null
on all 15,649 July rows, and CallLog holds 21,038 phoneburner calls with 0
archived. PhoneBurner recordings first arrived **2026-08-03**.

What July recordings do exist are inbound: 1,097 archived on the `ex` platform
and 41 on `cx`. None of them attach to the deals above, because those deals are
TAG mail-driven and the archived recordings are inbound RingCentral/CallRail.

---

## What this pass can and cannot answer

**Can:** deals, money, chargebacks, per-agent dialing volume, blended cost per
deal, touches for the three deals that had any.

**Cannot, and why:**
- *Per-agent cost per lead* — the dialer worked WYNN, the money came from TAG.
- *First-half agent detail* — CX data is thinner and does not record attempts.
- *Recording links for deals* — none existed in July.

## Two things worth fixing regardless

1. **Nine July deals ($8,488.67) have no officer.** Same root cause as the WYNN
   BCD miss: attribution depends on stored fields that are often blank.
2. **The LD lead count and LD spend disagree by $918** (4,743 leads × $3 =
   $14,229 vs $13,311 recorded).
