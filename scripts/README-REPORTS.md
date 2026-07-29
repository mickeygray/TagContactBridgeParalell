# REPORTS — the field guide

Everything here runs from the repo root on any machine with `.env`. No UI
needed. If you are at home and someone wants a number, this is the file.

```bash
node scripts/build-report.js --blocks        # what can I ask for?
```

---

## 1. Someone wants a number right now

```bash
# a day
node scripts/build-report.js --pick board --today

# a month
node scripts/build-report.js --pick roi-by-source --from 2026-07-01 --to 2026-07-28

# as a spreadsheet instead
node scripts/build-report.js --pick roi-by-source --month --csv

# as a web page (opens in any browser, keeps the tables)
node scripts/build-report.js --pick profit-loss --month --html

# email it to yourself
node scripts/build-report.js --pick board --today --email --to you@taxadvocategroup.com
```

Ranges: `--today` · `--yesterday` · `--month` · `--from X --to Y`.

**A live report re-gathers from Logics, CallRail and the spend sheet every
time.** A day takes ~15s, a month ~2min. The second run of the same range is
much faster — there is a 10-minute cache.

---

## 2. The reports that already have names

| pick | answers |
|---|---|
| `roi-by-source` | which piece made money, ROAS and ROI per source and per channel |
| `officer-performance` | deals and cash per settlement officer, plus calls |
| `profit-loss` | cost, money in, net and margin over time |
| `board` | the night board: spend, money, net, by source |
| `worklog` | calls received/taken/made and deals written, per person |
| `pipeline` | post-dates, declines, call-to-close lag |
| `daily` | the big one — everything above for a single day |

---

## 3. Slicing it — "just for Bruce", "just LD", "just 2024 clients"

```bash
--where officer=Bruce          # matches loosely, so "Bruce" finds "Bruce Allen"
--where source=LD              # any source containing LD
--where domain=TAG
--where cohort=2024            # clients who first paid in 2024
--where minutes>10             # long calls only
```

Repeat `--where` to stack them. Filters slice the material **before** any
calculation runs, so every number in the report reflects the slice.

```bash
# what did Bruce do with mail leads in July?
node scripts/build-report.js --pick officer-performance \
  --from 2026-07-01 --to 2026-07-28 --where officer=Bruce
```

---

## 4. The vendor split — LD's picture vs ours

LD gets their own numbers; we keep the whole board.

```bash
# what we send THEM
node scripts/build-report.js --pick roi-by-source --month --where source=LD --csv

# what we keep
node scripts/build-report.js --pick roi-by-source --month
```

---

## 5. Recordings

The `recordings` block emits listen links, and marks with `SOURCE` the call
the attribution actually came from — the longest one on the day the deal
closed.

```bash
node scripts/build-report.js --pick board,recordings --today --email
```

Links, not attachments: a 47-minute call is ~33MB and CallRail links have
been durable back to Sep 2025.

---

## 6. Putting it on a clock

```bash
node scripts/report-schedule.js --list          # what is saved
node scripts/report-schedule.js --due           # what would fire right now

node scripts/report-schedule.js --save "monday marketing" \
  --pick roi-by-source --range last7 --at 08:00 --dow 1 \
  --to you@taxadvocategroup.com --enable

node scripts/report-schedule.js --run "monday marketing"          # DRY: prints, sends nothing
node scripts/report-schedule.js --run "monday marketing" --send   # actually emails
```

Ranges roll: `today · yesterday · last7 · last30 · mtd · lastmonth · ytd`.
`--dow 1` is Mondays, `--dom 1` is the 1st, `--dom 0` is month-end. Omit both
for every day.

Nothing fires automatically until `REPORT_SCHEDULER_ENABLED=true` **and** the
control plane restarts.

---

## 7. Data cleanup

```bash
# what would move off the mail-house catch-all
node scripts/sanitize-logics-source.js --days 7

# actually write it (also needs LOGICS_SOURCE_WRITER_ENABLED=true)
node scripts/sanitize-logics-source.js --days 7 --commit
```

Only the three ACTIVE pieces are ever written. Anything else is left alone.

---

## 8. Building something that does not exist yet

The toolkit is three parts. Anything askable is a combination of them.

**Substrates** — costs · counts (calls, pieces, deals) · money (initial, total)
**Factors** — source/piece · settlement officer · time range · domain · cohort
**Functions** — `roi` `roas` `costPerCall` `costPerLead` `costPerAcquisition` `profitMargin`

```js
const ops = require("./packages/shared-services/src/reportOpsService");
const { gatherMaterial } = require("./packages/shared-services/src/reportComposerService");

const m = await gatherMaterial({
  needs: ["payments", "spend", "caseContacts"],
  from: "2026-07-01", to: "2026-07-28", live: true,
});

const deals = m.payments.filter((p) => p.paymentType === "initial" && !p.isChargeback);
const byOfficer = ops.groupBy(deals, "officer");

for (const b of byOfficer) {
  const money = ops.measure(b, ["deals", "cash"]);
  console.log(b.key, ops.applyFunctions({ ...money, cost: 0 }, ["costPerAcquisition"]));
}
```

Other ops worth knowing: `funnelGap` (did A, did NOT do B — the shape behind
every "who didn't convert" question), `joinAttempts`, `lag`, `distribution`,
`compare`, `shareOf`, `topN`.

**Rules that keep answers honest**, learned the hard way:

- A missing source renders as UNKNOWN, never as `0`. If you write a new
  calculation, keep that.
- Every ratio comes from `applyFunctions`. Never compute one inline — ROI once
  meant two different things because of exactly that.
- Deals count SALES, not payment rows. A first invoice split into two
  instalments is one deal.
- Attribution is the longest call on the day the deal closed.

---

## 9. Copy this to me

If you want a report that is not here, paste the question. The useful shape:

> "For July, by settlement officer, how many deals and how much cash, but only
> for mail leads, and show me cost per acquisition."

Substrate, factor, filter, function. If it can be said in those four, it can
be built in a few minutes.
