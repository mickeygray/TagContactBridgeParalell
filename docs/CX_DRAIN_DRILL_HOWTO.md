# How to run the Drain Drill

**What it is:** a self-grading test of the outcome drain — the worker that turns recorded
call outcomes into queue/cadence/call-log writes. It proves the three failure lanes work
(good rows drain, broken rows resolve minimally, junk rows get tossed) **without making a
single phone call**. It injects three fake outcome rows and watches the real, live drain
worker process them.

**When to run it:** after any restart that changes drain/outcome code, or any time you want
to prove the exit path is healthy. It needs no session, no queue, no agent — just the
control plane running.

**How long:** about 5–6 minutes. Most of that is deliberate waiting (the "broken row" has
to fail three times with growing pauses between retries — that ladder is the thing being
tested).

---
## Steps

**1. Make sure the control plane is running the current code.**
If you just pulled/changed code: restart `ParallelControlPlane` first. The drill tests
whatever is actually running.

**2. Dry run (optional but nice):**
```
node scripts/cx-drain-drill.js
```
Prints what would be injected and what to expect. Touches nothing.

**3. Arm it:**
```
node scripts/cx-drain-drill.js --arm
```
Then just watch. It injects the three rows and polls every 10 seconds, printing each
change as the live drain eats them. Ctrl+C is safe at any point — everything is in Mongo
and you can re-check later.

**4. What you'll see, roughly in order:**

| When | Line you'll see | Meaning |
|---|---|---|
| ~15s | `…:malformed -> status=drained … resolution=malformed` | the junk row (no button press behind it) was tossed instantly — no retries, no writes |
| ~15s | `…:good -> status=drained … resolution=-` | the good row drained fully on its first pass |
| ~15s | `…:poison -> status=failed attempts=1` | the broken row failed try #1 (this is correct!) |
| ~30–90s | `…:poison -> … attempts=2`, then `attempts=3` | retries with growing pauses between them |
| ~4–6min | `…:poison -> status=drained … resolution=minimal` | after 3 strikes the drain gave up on the full effects, stamped the bare outcome onto the lead, and cleared the row |

**5. Read the verdict.** The script grades itself at the end:
```
VERDICT:
  PASS  A malformed drains instantly, no retries
  PASS  B poison rides the 3-retry ladder then resolves minimally
  PASS  C good drains fully on the first pass
  PASS  C label store live: row carries lastTerminalSystemDisposition=DRILL
  PASS  C terminal stamps landed on the row
ALL PASS. Cleanup when done: node scripts/cx-drain-drill.js --cleanup <tag>
```
Five PASS lines = the exit path is healthy. Any FAIL = copy this output plus the
control-plane stdout (`cx.alpha.drain.*` lines) and send both to Fable.

**6. Clean up.** Run the exact cleanup command the script printed (it includes the run's
tag). This deletes the drill's fake rows. If you forget, no harm — everything is tagged
`drill` with fake case numbers (9999xx) and touches nothing real.

---
## FAQ / troubleshooting

**Nothing happens for a minute.** The script will tell you, but the causes are: the control
plane isn't running, wasn't restarted onto the current code, or the drain is switched off
(`CX_TERMINAL_OUTBOX_DRAIN_ENABLED=false`). Fix, then just keep watching — the injected rows
are still there and will process as soon as the drain wakes up.

**The poison row is "stuck" on failed.** It isn't — look at the timestamps. The pauses
between retries grow on purpose (15s → 60s → ~2min). If it's still `failed` after 8+
minutes, that's a real finding — capture and report.

**Can I run it twice?** Yes — every run gets its own timestamp tag, so runs never collide.
Clean up old runs when convenient.

**Is it safe with the floor testing at the same time?** Yes. The three lanes can't touch
RingCX (verified by construction: the junk row never replays, the broken row never succeeds,
and the good row lands on a pre-completed synthetic lead that takes the stamp-only path).
The only shared resource is the drain worker itself, which processes real rows in the same
batch as usual.

**What does "resolution=minimal" actually mean for a real lead?** If this ever happens
outside a drill, it means a real outcome's full bookkeeping kept failing, so the system
stamped the essential fact (outcome, time, call id, RingCX verdict) onto the lead and moved
on rather than retrying forever. The lead carries the truth; only counters/cadence extras
may be missing. It's logged loudly (`cx.alpha.drain.row.minimal_resolved`) — a cluster of
those in real traffic means something downstream is sick and worth a look.
