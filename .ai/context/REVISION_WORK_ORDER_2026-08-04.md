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
that nobody drinks (§4). Expect more of this shape in §5 and §8.

---

## The yardstick — what this system is actually for

Mickey, 2026-08-04, and this governs every KEEP/REMOVE call below:

> "cx ... shouldn't be there if it isn't being used, and currently no one
> really logs in. Maybe eventually we get to the point where there's a live
> call assistant, if people want it. But for now it's holding a trainer for
> when we need to hire someone, and will be my ability to generate reports for
> people, and that's about it."

So the system has **two products and one spine**:

1. **A trainer** — held for a future hire.
2. **Report generation** — Mickey producing reports for people.
3. **The live operational spine**, which must keep running regardless: lead
   delivery into PhoneBurner, inbound lead intake, DNC safety, aged-pool
   advancement, blogs.

A *possible* fourth someday: a live call assistant, if people want it. Dormant
is acceptable — dishonestly-dormant is not. Anything serving none of these is a
removal candidate, and CX is the largest instance of exactly that.

**Scope note (Mickey, same day):** "when I say app I mean the front end —
everything else with processes running and the server doing server things still
applies." §8 is therefore a **front-end** deprecate-and-rebuild. The server, its
routes, and its scheduled processes are not in that section's scope; they are
handled in §4 and §5.

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

**CORRECTED 2026-08-04 by `scripts/tag-filler-admission-audit.js` — the intake
is NOT the binding gate. The DNC scrub is.**

```
4,586 TAG rows — every one with a phone, every one past the caseId floor
    7 have EVER been DNC-checked
    1 on national DNC, 1 on state DNC
    6 clean and admissible
4,579 pool.tag=filler-retry-2026-08, pool.source=dnc-lookup-pending-retry
```

The sampler deferred the DNC lookup for **99.8% of the pool** and the retry has
never run. Building an intake today would admit **six rows**. Fix the scrub
first — the intake question cannot be answered until there is a population to
answer it about.

Field-shape note that cost a wrong reading once already: there is **no
`dnc.result` field** in MasterProspectIndex, on either domain. The verdict is
discrete flags (`onNationalDnc`, `onStateDnc`, `onDma`, `isLitigator`) with
`checkedAt` proving the lookup happened. Query `dnc.result` and every row looks
undialable for the wrong reason.

WORK (revised):
0. **Find out why 4,579 rows are stuck in `dnc-lookup-pending-retry`** and get
   the scrub through them. Everything else in this section waits on that.
1. Then, if a real population exists: build a TAG filler
   **admission/composite source** modeled on `callRecoveryAdmissionService.js` +
   `callRecoveryCompositeSource.js` — the proven pattern for admitting a
   non-standard population into the delivery pool.
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

## 3a. STANDING RULE — the two invariants, and permission to break the rest

Mickey, 2026-08-04: *"as long as the night services run and phone burner keeps
churning there can be construction everywhere else where things temporarily are
wonky and don't work, because well they aren't being used. so don't be afraid to
yank some wires out."*

**Protect exactly two things:**

1. **The night services run.**
2. **PhoneBurner keeps churning** (lead delivery in, dials out).

Everything else may be temporarily broken. Screens can 404, admin panels can be
half-wired, dark features can stay dark. Do not gold-plate a migration path for
a surface nobody opens — cut it and move on.

**The one exception, and it is not timidity:** anything that could cause us to
**dial someone who asked us to stop** is not covered by "wonky is fine." A
broken screen is visible and reversible; over-dialing is neither. That is why
the CxTerminalOutbox dial-frequency floor (§3b) gets re-sourced before it gets
removed, while the CX dial queue got cut the same afternoon it was measured.

Also settled: **the 4,579 aged TAG rows are NOT the target.** They are aged out
of the ~4-month window, and PhoneBurner already has an aged folder for manual
selection. §3 is about *going forward*, not backfilling that pool — so the
pending-retry DNC scrub is a curiosity, not a blocker.

---

## 3b. STANDING RULE — CX as a data source

Mickey, 2026-08-04: *"anything that relies on cx as data should immediately be
shaken down for its value and reformatted."*

This applies wherever a **kept** surface reads a `Cx*` collection or a `cx*`
service for its facts. For each: ask what the read is worth, then either drop it
or re-source it from a non-CX origin. Do not leave a kept feature drinking from
a dying well.

The known list, from the surface map:

| Reader (kept) | CX data it drinks | Shakedown |
| --- | --- | --- |
| `leadDeliveryService:2764` → `readLegacyDailyAttemptFloor` (`leadDeliveryRepository:1200`) | **CxTerminalOutbox** — folds `terminalOutboxCallCount` into a `Math.max` dial-frequency floor | **HIGHEST VALUE, HIGHEST RISK.** Frozen since Jul 10, so it contributes nothing new — but removing it *lowers* a contact-safety floor. Failure mode is invisible over-dialing. Re-source from DailyDial / LeadDeliveryEvent, then drop. |
| `nightReportService:300,309` (report listenUrl) and `trainingCallReviewSourceService:342` | `recordingArchive.*`, written by **`cxRecordingInboxDrainService`** (SFTP push path) | §7 replaces recordings with links. Decide whether the SFTP fallback still recovers anything; if not, drop both sides together. |
| Trainer "My calls" tab (`TrainingCenterPanels.tsx:303`) | `/api/read/cx/recordings/library` → `readCx.js:971` | Handler reads Google Drive, touches no `Cx*` model — so this is CX **in name only**. Re-point the path; no data migration. |
| `hourlySweeperService` | `cxRecordingHourlyService`, `cxCallActivityBackfillService` | Pull RingCX recordings into CallLog. If RingCX dialing is dead these recover nothing — verify with a live count before deleting, per §5. |
| `frontendReadService:699-707` | `agent.cxRouting` field | Field read off an already-loaded doc, not a CX collection. Cheap to keep, cheap to drop. |
| `taxResolutionSalesTrainerService:355-356` | `account.cxAuth` / `account.cxSession` emails | Widens an allowlist; degrades to "fewer emails". Drop with the auth severing (§4 EDIT 4). |

Order: the dial-frequency floor first — it is the only one where getting it
wrong dials somebody who asked us to stop.

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

**VERIFIED 2026-08-04. `nightlyClose` is NOT the 8pm report.**

- The 8pm email is `reportScheduleRuntime`, which holds no schedule of its own —
  it asks `dueDefinitions()` what is due and runs it. The schedule lives on
  each `ReportDefinition` row under **`schedule.enabled` / `schedule.hour`**
  (note: there is no top-level `enabled` field; querying one reports every
  definition as off).
- `nightlyClose` fires at **21:30** — `NIGHTLY_CLOSE_HOUR=21`,
  `NIGHTLY_CLOSE_MINUTE=30`. Separate thing, ninety minutes later.

**Four definitions are enabled, all at 20:00 — so four emails go out, not two:**

```
ON  vendor roll up with calls      20:00   last Aug 03 16:56
ON  financial roll up with calls   20:00   last Aug 04 08:10
ON  vendor                         20:00   last Aug 03 20:00
ON  financial                      20:00   last Aug 03 20:00
```

The duplicate pair is confirmed live and firing. Archive plain `vendor` and
`financial` **in Mongo**. **Never rename "financial roll up with calls"** —
`dailyReportFactService.js:9` pins to it by name.

**The night inventory to collapse into ONE service:**

| Time | Thing | Fate |
| --- | --- | --- |
| 19:45 | `spendSync` | fold in as a step |
| 19:50 | `nightlyHygiene` (night-persist, mail-invoice, mail-spend-derive, call-links, queue-rollup, logics-source) | fold in as steps |
| 20:00 | `reportSchedule` → 4 definitions | becomes the LAST step |
| 20:00 | `logicsActivityReview` | fold in or drop |
| 21:30 | `nightlyClose` | operational half folds in; email half already silenced |
| 23:00 | `recordingArchive` EOD | replaced by call-link capture (§7) |
| **02:00** | **`lexisDailyDrop`** | **STAYS SEPARATE — Mickey's explicit exception** |

Five separate timers between 19:45 and 23:00 become one pass. Lexis at 02:00 is
the only other night job that survives on its own clock.

### IT IS ALL ONE PROCESS

Mickey, 2026-08-04, asked whether the email re-gathers or reads the stored fact:
*"its all one process."*

So this is **not** "a 19:50 writer and a 20:00 reader that hand off through
Mongo." It is one process that gathers once and ends with the send:

```
   ONE PROCESS
   ├─ get the links
   ├─ pull the cost
   ├─ run activities
   ├─ gather  ← ONCE, in memory
   ├─ save the snapshot   (from that gather)
   └─ send the email      (from THAT SAME gather)
```

**NOW vs EVENTUALLY — Mickey, same exchange:** *"for now building the email from
the snapshot isnt how it exists but eventually we will get there."*

So the diagram above is the DESTINATION. Do not build the email off the snapshot
in this pass.

**BUILD NOW — one shot, then BRANCH.** Mickey: *"you can do it in one shot and
just branch — just do both, save the report and send the email separately, so
you don't have to run the activities twice."*

```
   ONE PROCESS
   ├─ links → cost → activities
   ├─ gather                    ← ONCE. The activities run one time.
   └─ branch, both from THAT material:
      ├─ save the snapshot      ← first
      └─ send the email         ← second
```

The two branches are **siblings off one gather**, not a writer and a reader. So:

- The activities never run twice. That is the point of the branch.
- The snapshot and the email **cannot disagree** — they consume the same
  in-memory material, so there is no timing gap to reconcile.
- The email is still *rendered the way it is rendered today*; it is simply fed
  the material that was already gathered instead of gathering again.

**BUILD EVENTUALLY — the email renders from the persisted snapshot document**
rather than from sibling material. Mickey: *"for now building the email from the
snapshot isn't how it exists, but eventually we will get there."* That is a
later change and is NOT in scope for this pass.

Two consequences that DO apply immediately:

1. **`reportScheduleRuntime` stops being its own loop** and becomes the tail of
   the pass. That kills the "fired randomly at 11:30pm" drift — the send cannot
   wander if it is the last step of something that starts at a fixed time.
2. **Ordering is load-bearing: snapshot first, send second.** A send failure is
   not the death of the data.

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

### 7a. SHAKEDOWN — `recordingArchiveService` (1,666 lines)

Mickey, 2026-08-04: *"the hard downloaded calls is going to translate to a list
of links so we can actually just store it in mongo, so the searching everywhere
and getting them part (especially ring central code) and like rules for dividing
them into the right folder etc these sorts of things are of value, but since we
are just storing links."*

This is §3b applied to the 23:00 archive. **The finding logic is the asset; the
fetching is not.** Split the file, keep the top half:

**KEEP — reformat to return a LOCATOR, not a buffer**
| Lines | What | Why it survives |
| --- | --- | --- |
| 471 `resolveRingcxRecording` | RingCX segment → recording | the RC code Mickey named |
| 721 `resolveCallrailRecording` | CallRail → media url | already link-native (HTTP 200) |
| 821 `resolveRingcentralRecording` | RC → content uri | pairs with the existing `/rc-play/:id` forwarder |
| 846 `resolveRecordingArtifact` | the provider-order fan-out | "searching everywhere" |
| 387 `pickBestSegmentForCallLog` | which segment IS the call | non-obvious, hard-won |
| 1011 `pickTerminalCandidate` | which candidate wins | same |

**KEEP — the folder rules, unchanged in meaning**
`normalizeAgentBucketName` (125), `getAscsAgentNameSet` (133),
`getAlwaysCxAgentNameSet` (141), `getExcludedAgentTokens` (149),
`findExcludedAgentMatch` (166), `findExcludedCallLogAgentMatch` (188),
`buildRecordingFileName` (226). These encode who a call belongs to and who must
never be archived. **The EX exclusion in particular becomes an index-time and
endpoint-time rule (§7), not a download-time one** — it must not be lost in the
move, because dropping the download is what currently enforces it.

**DROP — the media half**
`downloadRecordingBySegment` / buffer plumbing (544-556), `fetchBinary` (645,
753), and the entire Google Drive destination layer (280-283, 1054-1068:
`clientEmail`, `privateKey`, per-bucket `folderId`s). Media stays with the
vendor.

**The refactor in one sentence:** every `resolve*Recording` currently returns
`{ artifact: { buffer, mimeType } }`; it should return
`{ provider, providerCallId, locator, bucket }` and never fetch bytes.

**Fate of the 23:00 timer:** retired. Link capture belongs to the 19:50 pass as
part of `call-links` (task 4), not as a fourth task — one concept, one step.
Per §5c the handover is two-step: fold in and kill the timer in the same change,
or it runs in both places.

**Carry forward:** `recordingArchive.driveWebViewLink` is read by
`nightReportService:300,309` (the report's listenUrl) and
`trainingCallReviewSourceService:342`. Those readers must be re-pointed at the
new locator in the same change, or the report's listen links go blank.

---

WORK: authenticated index endpoint returning metadata + opaque ids, minting on
request; repair the 252 mislabeled rows; point the nightly email at the minter.
`DailyDial` stays exactly as it is — it works. `MarketingCallLink` folds in.

DONE WHEN: any call with a recording is findable by date/agent/source/case, and
its link plays for an allowed viewer.

WATCH OUT: RC signed-link TTL defaults to 1h — too short for a link read the
next morning. Decision owed below.

---

## 8. The front end — deprecate and rebuild

**Scope: `apps/web-client` only.** Server processes and routes are §4/§5.

GOAL: every screen in the app is either serving the trainer, serving reports,
or gone.

STATE: under investigation (front-end surface map running). The expectation
going in — to be confirmed or refuted, not assumed — is that the front end is
mostly **CX-era**: agent floor, dial queue, wrap cards, call notes, agent
login. That whole concept has no users. Meanwhile the two things the app is
actually *for* may have little or no front end at all, which would make this
section largely greenfield rather than a cleanup.

WORK (sequence depends on the map):
1. Inventory every screen: routed-and-linked / routed-not-linked / orphaned.
2. Classify each against the yardstick.
3. Find screens whose backing endpoints no longer exist — already broken, and
   the easiest removals to justify.
4. Cut the CX-era surface.
5. Build what the two real purposes need and don't have.

DONE WHEN: Mickey can open the app and everything on it is something he'd use.

WATCH OUT: a screen with no nav link is not necessarily dead — the nightly
emails link into the app. Check the server's email templates for front-end URLs
before removing anything that looks orphaned.

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
