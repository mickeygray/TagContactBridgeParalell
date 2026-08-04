# Who works the fresh leads — investigation guide

Date: 2026-08-03
Status: GUIDE ONLY. Nothing investigated, nothing changed.
Why: Mickey 2026-08-03 — *"they are just bums who want to take mailer calls. is
what it is."* So the cause is understood as a behaviour problem. This is the
recipe for proving it with numbers when someone wants to.

---

## The observation that started it

2026-07-31, all WYNN, five dialers:

```
agent          firstDial  lastDial  attempts  firstTouch(all)  firstTouch(NEW)
Brad Hansen        08:08     15:46       645              402               29
Chris Bolt         07:54     16:05       477              364                3
Sean Lucas         08:53     13:34       223              180                0
Phil Olson         08:52     13:41       107               66                0
Bruce Allen        09:42     12:43        50               50                0
```

Of 32 dial docs with `leadAgeDays === 0`, Brad was first agent on 29.

**What is already ruled out:**

- **Not domain.** All five dial WYNN only.
- **Not start time.** Chris starts 14 minutes EARLIER than Brad.
- **Not overall skill at getting there first.** Chris's first-touch rate is
  higher (364/477 = 76% vs Brad's 402/645 = 62%). He is first on plenty of
  leads — just not on FRESH ones.

That last point is the whole puzzle: Chris is fast and early, and still takes
only 3 of the new inventory. Volume and punctuality do not explain it.

**The standing read:** three of the five stop by ~13:40 and prefer inbound
mailer calls, so the fresh LD queue gets swept by whoever is still dialling.

---

## How to prove or kill it

### 1. Is it every day, or was the 31st an outlier?

The single highest-value query. One day proves nothing.

```
for each dateKey 2026-07-27 .. 2026-08-02:
  DailyDial docs where leadAgeDays === 0
  -> the agent on the earliest attempt carrying an agentId
  -> count per agent per day
```

If Brad is dominant every day it is structural. If it moves around, the 31st
was noise and there is nothing to fix.

### 2. Share of first-touches vs share of dials

The gap IS the finding. Brad had ~43% of attempts and ~91% of new-lead first
touches. Compute both per agent per day and compare. An agent whose first-touch
share materially exceeds their dial share is being served fresh inventory
preferentially — by the queue or by their own choice of pool.

### 3. Push or pull — this decides whether there is a bug at all

`leadDeliveryService` is the one decision owner; `LeadDeliveryItem` is the one
live store.

- If the system ASSIGNS a lead to a named agent, "next available person" is a
  real contract and a skew is a bug.
- If PhoneBurner PULLS whatever is on top, then whoever dials most and latest
  sweeps fresh inventory by construction, and the fix is operational, not code.

Read `resolveSelectionRank` / `compareSelectionCandidates`. The tiers are:

```
0 overnight   1 new_today untouched   2 recovery untouched
3 anything touched   4 aged filler
```

Note this orders **leads**, not agents. If nothing anywhere balances across
people, the answer is pull and the expectation needs restating.

### 4. Is `LeadDeliveryFairPickCursor` alive?

`packages/shared-models/src/LeadDeliveryFairPickCursor.js` exists, so somebody
built fairness. Three outcomes, all worth telling apart:

- **dead code** — grep for readers/writers; if none, fairness was never wired;
- **flag-disabled** — find the gate and check it;
- **wired but fair across the WRONG dimension** — balancing domains, sources or
  cadences rather than agents would look exactly like this bug while appearing
  to work.

Also query the collection: how many cursor docs, last advanced when. A stale
cursor is a strong tell.

### 5. The trap that would invalidate all of the above

**Does anything touch a lead before an agent does?**

Everything here reads "first attempt carrying an `agentId`" as first human
contact. If an automated pass writes attempts with no `agentId`, then "first
agent" is really "first agent AFTER the robot", and the skew may be measuring
something else entirely.

Check: count attempts with no `agentId` on new-inventory docs. If non-trivial,
redo steps 1–2 with that in mind before drawing any conclusion.

### 6. Benign explanations to eliminate before calling it a problem

- **Shifts.** Sean, Phil and Bruce all stop by ~13:40; Brad and Chris run past
  16:00. If fresh leads land in the afternoon, the "skew" is just who is at a
  desk. Cross-check lead ARRIVAL times against each agent's active window.
- **Per-agent caps** or list assignments in PhoneBurner that this repo cannot
  see.
- **Pool preference.** On the 31st only 3 of 32 same-day leads sat in
  `new_today` when the doc was stamped; 29 read `follow_up_due`. That field
  reflects a LATER pull, not the state at first touch — which is exactly why
  `leadAgeDays === 0` is the right "new" filter and `originPool` is not. Using
  the pool would report 3 leads instead of 32.

---

## Ground rules for whoever runs this

- READ ONLY. This is the live dialer; a distribution change moves who gets paid.
- Mongo needs `DNS_SERVERS=8.8.8.8` on this box or every connect fails
  `querySrv ECONNREFUSED`.
- **Never run `tests/lead-delivery/leadDeliveryRuntime.test.js`** — it hangs the
  runner. Other lead-delivery tests by name pattern only.
- Agent names are staff and fine to print. Customer names, phones, emails and
  case detail are not.

---

## Why this matters beyond fairness

Per-agent attributed spend divides the day's real LD cost by who first touched
each new lead. On 2026-07-31 that gave Brad $87 of the $96 attributed. If the
distribution is a queue artefact rather than effort, that column is measuring
**who reached the queue first**, not who worked hardest — fine as a cost
allocation, misleading as a performance measure. Say which it is before anyone
is judged on it.
