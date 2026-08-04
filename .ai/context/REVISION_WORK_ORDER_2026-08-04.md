# Revision work order — "a coherent, only-useful surface"

Date opened: 2026-08-04
Owner: Mickey
Status: OPEN. Sections run in order. Expect this to span several days.

**How to use this doc.** Sections are numbered in the agreed order. Each has
GOAL / STATE (verified, with evidence) / WORK / DONE WHEN / WATCH OUT. Do not
start a section until the one before it hits DONE WHEN, except where a section
is explicitly marked parallel-safe. When a section closes, mark it and record
the commit.

**The through-line.** Every section is the same question asked of a different
part of the app: *is anything actually drinking from this?* Two pools are
already known to fail it in opposite directions — the TAG filler pool is full
and nobody drinks (§3), and the CX dial queue is being filled by live traffic
that nobody drinks (§4). Expect more of this shape in §5 and §9.

---

## 0. Ground truth first — where does the control plane host?

**Blocks §1 and §2 completely. Nothing else.**

GOAL: know which process serves the control plane, so an edit to this repo's
`.env` / `server.js` is either live-on-restart or knowingly not.

STATE: **UNVERIFIED, and it has bitten us.** Two commits (`eecc0bf` floor
enables, plus `BLOGGER_ENABLED=true` in `.env`) are inert until the hosting
process restarts with these files. Candidates: this box's 8 Manual-start nssm
services, or the Linux box at `/opt/tagcontactbridge-parallel`. The nightly
stack demonstrably runs (spendSync 19:45, hygiene 19:50, night-persist 19:50,
live intake all morning) — but *which machine ran it* was never established.

WORK:
1. Identify the host: compare `git log -1` / file mtimes at
   `/opt/tagcontactbridge-parallel` against this working copy, and check which
   nssm services are Running here.
2. If Linux hosts it: this branch's commits must be deployed there, and every
   "takes effect on restart" claim in §1/§2 is about *that* box.
3. Restart deliberately, at Mickey's word, at a time of his choosing.

DONE WHEN: we can name the host, and a deliberate restart has happened with
`cleaned-metrics` (or whatever ships) in place.

WATCH OUT: **do not restart anything unasked.** Dev box runs live ops.

---

## 1. Blogger on

GOAL: blogs post again on the 08:00 schedule.

STATE: `BLOGGER_ENABLED=true` is set in `.env`. Code path is armed. It was off
because `blogger` is env-gated and the flag was absent.

WORK: none in code. Gated entirely on §0.

DONE WHEN: a blog run is observed after the restart — a fresh write, not a log
line claiming it scheduled.

WATCH OUT: "scheduled" ≠ "fired". Verify by newest write, per the rule in
[[control-plane-stopped-root-cause]].

---

## 2. Lead aging on

GOAL: the aged pool advances again; DNC recheck keeps dialing clean.

STATE: committed in `eecc0bf`. Three sweeps were being killed by a single
hard-coded `scheduledPhaseLite = true` at `server.js:703` and are now
independent of it:

- `dncRecheckEnabled` — keeps DNC'd numbers out of the dialer
- `agedRollingRefreshEnabled` — advances the aged pool
- `fillerPoolRefreshEnabled` — re-samples TAG yellows into the filler pool (§3)

WORK: none in code. Gated on §0.

DONE WHEN: after restart, an aged-advancement run and a DNC recheck each show a
fresh write.

WATCH OUT: `fillerPoolRefresh` coming back on makes §3's problem *bigger*, not
smaller — it fills a pool that currently has no consumer. That is fine and
intended, but don't read a growing filler pool as progress on §3.

---

## 3. TAG yellows → PhoneBurner: build the intake

**The first real build. Parallel-safe with §0–§2.**

GOAL: old TAG yellows actually reach agents' PhoneBurner folders.

STATE — half done, and the missing half is the one that matters:

- ✔ The sampler runs. `fillerPoolRefreshService` re-samples DNC-scrubbed
  `status=2` TAG cases (`caseId >= 50000`, has phone) into
  `MasterProspectIndex` — **4,586 TAG rows** sitting there.
- ✘ **Nothing delivers them.** `LeadDeliveryItem` is effectively WYNN-only:

  ```
  WYNN  (none)            7,432    newest Aug 04
  WYNN  older_available   1,880    newest Aug 04
  WYNN  follow_up_due     1,163    newest Aug 04
  WYNN  overnight           838    newest Aug 04
  WYNN  new_today           180    newest Aug 03
  TAG   (none)                4    newest Aug 04
  TAG   overnight             2    newest Jul 24
  ```

  Six TAG rows total, two of them from July 24. The delivery loop touches
  `MasterProspectIndex` only as a per-case `findOne` for enrichment
  (`leadDeliveryRepository:1212`), never as a *source*.

So the pool fills monthly and nobody drinks from it.

WORK:
1. Build a TAG filler **admission/composite source** modeled on
   `callRecoveryAdmissionService.js` + `callRecoveryCompositeSource.js` — that
   pair is the existing, proven pattern for admitting a non-standard population
   into the delivery pool.
2. Land them in tier 4 of the existing selection rank
   (`leadDeliveryService.js:1500` — "generic aged filler", coldest first). The
   slot already exists; nothing new needs inventing in the ranker.
3. Respect the existing per-day attempt counters (`filler.dailyDateKey` /
   `filler.dailyAttempts`, already projected at `leadDeliveryRepository:273`)
   so a filler lead can't be hammered.
4. Dry-run first: report how many TAG rows *would* admit, per agent, per day,
   before a single write.

DONE WHEN: TAG rows appear in `LeadDeliveryItem` with a filler pool, land in
PhoneBurner folders, and the per-day attempt cap demonstrably holds.

WATCH OUT: this puts a genuinely new population in front of agents. Cap the
first day low and look at it before opening up. DNC recheck (§2) must be
confirmed running *before* TAG yellows start dialing — these are old records.

---

## 4. CX phase-out — cut coupling first, move second

GOAL: CX off the working branch, deprecated not deleted.

STATE — **it is not a block move, and one piece is actively wasting writes.**

Surface: 62 `cx*` services + 8 `Cx*` models. But CX is three different things
with three different fates:

**(a) Auth plumbing — load-bearing, cannot leave.**
`apps/control-plane/src/middleware/auth.js:15` requires
`cxTokenStorageService`; accounts carry `cxAuth` / `cxAgentId`. Move this and
login breaks.

**(b) A live-path write nobody consumes — the real find.**
`CxDialQueue`: 21,611 docs, written **today at 10:38**. Looks alive. Is not:

```
last 14 days created : 1,444
  completedAt set    :     0
  everClaimed        :     0
  dailyPlacedCalls>0 :     0
intake route         : ld-posting-lead 1,314 | ld-lead 129 | affiliate-lead 1
```

Zero consumed, ever. The writer is the **live LD intake**:
`inboundIntakeService` → `cxCadenceService:2289` → `cxDialQueueRepository.upsertQueueItem`.
So ~100 dead docs/day land on the shared Atlas cluster off the back of real
lead traffic. This is the mirror of §3.

**(c) Genuinely dead sweeps — safe to deprecate.**
`cxRecordingHourlyService`, `cxCallActivityBackfillService`,
`cxTerminalRectificationService` (via `hourlySweeperService` and
`nightlyCloseService`); `CxAgentCallNote` / `CxTerminalOutbox` /
`CxCallWrapCard` all frozen at Jul 10, `CxSimpleLoopSession` at Jun 19,
`CxSlowLaneSession` empty. Mickey: "cxrecording isn't a thing."

Also still coupled: `leadDeliveryRepository` → `cxAppointmentRepository`
(`CxAppointment`, 79 docs, newest Jul 30 — near-dead but on a live import).

WORK, in this order:
1. **Cut the dead write (b).** Stop `cxCadenceService` enqueuing from the LD
   intake path. Highest value, smallest diff, immediate stop to ~100 wasted
   writes/day. Verify LD intake is otherwise untouched.
2. **Sever (c).** Remove the dead sweeps from `hourlySweeperService` and
   `nightlyCloseService` — note §5 rewrites both anyway, so sequence with it.
3. **Isolate (a).** Auth plumbing stays. Consider renaming out of the `cx*`
   namespace later so "CX" means one thing.
4. **Then** move what's left to its own branch. Only after 1–3 is the residue
   actually detachable.

DONE WHEN: `CxDialQueue` stops growing; the dead sweeps are gone from the two
runtimes; the remaining CX set is on its own branch; login and LD intake both
verified working.

WATCH OUT: **do not start with the branch move.** `auth.js` and
`leadDeliveryRepository` will follow it off the branch and take login and lead
delivery with them.

---

## 5. Service workers → three passes a day

GOAL: replace scattered timers with three named passes. Everything else stops.

STATE: 13 runtimes constructed in `server.js`, firing at 19:45, 20:00, 21:30,
23:00, 02:00, plus continuous. Several overlap; two near-identical 20:00 report
definitions still exist.

### 5a. MORNING — set the floor

Blogs (08:00), rotation-era chores, the day's starting state. Cheap, and mostly
a matter of moving existing armed work under one named pass.

### 5b. MIDDAY — the LD cycling check *(the section Mickey cares most about)*

GOAL: an honest answer to "how are we doing at touching stuff," runnable more
than once a day.

Two questions, and they are different:
1. **Coverage** — per pool and per age band, what got touched, what didn't, and
   what has been sitting untouched longest.
2. **Reorientation** — should new stuff get a **second touch** before the pool
   moves on to colder work? This is a *policy* change to the ranker
   (`leadDeliveryService.js:1500`), not a report. Decide it from what the
   coverage report actually shows, not in advance.

Build (1) first and read it for a day or two. (2) follows from it.

### 5c. EVENING — one discrete pass, one gather

Settled with Mickey. Order is load-bearing:

```
drain PhoneBurner folders
capture call links (agent + source + caseId)
gather material  ← ONCE
SAVE THE SNAPSHOT      ← first
build + send the email ← second, from the same material
```

Rationale, in Mickey's words: "a send error isn't the death of the data."
Absorbs `nightlyClose`'s operational half (payment sweep, cadence refresh, PB
reconcile); its email half is already silenced.

Also folded in / resolved here:
- `metricsPulseService` — 337 lines, zero callers. **Verified safe to delete.**
- Duplicate `ReportDefinition`s — plain `financial` and `vendor` duplicate the
  "roll up with calls" pair, both `rollup` at 20:00. Archive **in Mongo**, not
  code.
- `queue-rollup` — decision owed (see below); today it puts a red
  `[DEGRADED]` band on every monthly report.

DONE WHEN: three named passes exist, every other timer is off or absorbed, and
the evening pass has produced a snapshot *and* an email from one gather.

WATCH OUT:
- **Nightly automated PB drain is not yet authorized.** Drain stays MANUAL
  until Mickey says otherwise.
- **Never rename "financial roll up with calls"** —
  `dailyReportFactService.js:9` pins to it by name.
- Do not delete `spendSyncService`, `nightReportService`, `nightPassService`,
  `frontendReadService`, `readCallLinks()`, or the four `nightRecordingsService`
  "orphans". All verified load-bearing despite looking dead (§4 of the audit).

---

## 6. Vendor email tightening

**Outward-facing. Must close before any vendor address goes on it.**

GOAL: the vendor sees their channel and nothing else.

STATE: channel isolation landed (`b33412a`) — BCD money no longer credits the
LD vendor. Leaks remain.

WORK:
- Drop the `listen` column from vendor boards.
- `attachCsv = false` on the vendor definition — the CSV restores columns the
  email deliberately hides (`new_ld`, talk minutes, spend split).
- Decide `ldcalls` on vendor boards: anonymize the seat or drop the block. It
  currently exposes seat names.
- Suppress officer names.
- **Give the vendor phone numbers, not our CRM ids** — they cannot look
  anything up by internal id. This is the one Mickey raised from the vendor's
  own complaint.

DONE WHEN: a full vendor render contains no seat name, no officer name, no
internal id, no other channel's money — checked against a real send, not a
unit test.

---

## 7. CallLog → recording-forward surface

GOAL: one lightweight index over every call that has a recording, with a
downloadable link. Metadata ours; media stays with the vendor.

STATE: more built than it looks.
- CallRail links serve unauthenticated (HTTP 200, `audio/mpeg`).
- PhoneBurner links work (allowlist populated, promotion gate in place).
- RingCentral 401s — **but the forwarder already exists**:
  `recordingPlayback.js:518` `/rc-play/:recordingId`, HMAC-signed
  (`fileId|exp|viewer`), viewer allowlist, mints a fresh RC bearer server-side
  and pipes the media. Configured, 3 viewers. `mintRecordingPlaybackUrl`
  already routes correctly per provider.

Missing: the report path never calls the minter; there is no searchable index;
252 CallRail rows are mislabeled `platform:"ex"`; the EX exclusion (502 rows)
must be enforced *in the endpoint*, not by the caller.

WORK: authenticated index endpoint returning metadata + opaque ids, minting on
request; repair the 252 mislabeled rows; point the nightly email at the minter.
`DailyDial` stays exactly as it is — it works. `MarketingCallLink` folds in.

DONE WHEN: any call with a recording is findable by date/agent/source/case, and
its link plays for an allowed viewer.

WATCH OUT: RC signed-link TTL defaults to 1h — too short for a link read the
next morning. Decision owed below.

---

## 8. Admin panel / app review

GOAL: every screen and function on the admin panel is either used or gone.

STATE: not started. This is the section most likely to expand.

WORK: inventory routes and screens; for each, the §0-through-§7 question —
*does anything actually drink from this?* Deprecate, then rebuild what's left
worth keeping.

DONE WHEN: Mickey can open the panel and everything on it is something he'd
use.

---

## Decisions owed by Mickey

Four block work; the rest can wait.

| # | Decision | Blocks | Cost of not deciding |
| - | -------- | ------ | -------------------- |
| 1 | Where does the control plane host? | §0 → §1, §2 | Blogger and lead aging stay off |
| 2 | `queue-rollup`: re-arm capture, or drop the reader? | §5c | Every monthly report ships `[DEGRADED]` |
| 3 | RC links in email: index-page link, or long-TTL signed link? | §7 | Overnight links expire before they're read |
| 4 | Nightly automated PB drain: yes or no? | §5c | Drain stays manual |
| 5 | Archive the duplicate `financial` / `vendor` definitions? | §5c | Two near-identical emails keep going out |

---

## Standing invariants (do not violate while working this order)

- Mongo is the **shared Atlas cluster** — writes are live. Name the write
  before making it.
- Never restart the live nssm services unasked.
- Never run `tests/lead-delivery/leadDeliveryRuntime.test.js`.
- Never call the Logics ActivityReport in a loop — it is range-native.
- Never re-auth RingCentral per request.
- Scripts on this box need `DNS_SERVERS=8.8.8.8`.
- No pushing to origin without an explicit ask.
- **Unknown ≠ zero.** "We could not look" must never render as "nothing
  happened."

---

## Commit log for this revision

```
665029a  LD cost day 20:00→20:00, script DNS fixes
b33412a  WYNN BCD attribution, vendor-board channel isolation, off-hours callers
eecc0bf  Keep floor services running through lite mode (§1, §2)
bc7a676  Revision plan in priority order
```
