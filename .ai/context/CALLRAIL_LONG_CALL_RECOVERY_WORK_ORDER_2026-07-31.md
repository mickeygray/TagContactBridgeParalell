# CallRail Long-Call Recovery / PhoneBurner Work Order

Date: 2026-07-31  
Owner: Codex under Mickey's product and live-floor direction  
Status: IMPLEMENTATION AUTHORIZED 2026-07-31 ("just finish it")  
Parent: `PHONEBURNER_PROVIDER_NEUTRAL_LEAD_DELIVERY_WORK_ORDER_2026-07-10.md`  
Current parent phase: Phase 9 — controlled-floor hardening

## ⟳ BUILD STATUS — read this before touching recovery code

**The code is COMPLETE and DARK.** Every phase that can be built without a
running control plane is built and tested. What remains is rollout, which is
operator-gated by design.

| Phase | State | Evidence |
| --- | --- | --- |
| CR-1 pure qualification | DONE | `callRecoveryPolicy.test.js` (19) |
| CR-2 model + repository | DONE | `callRecoveryLeadRepository.test.js` (14) |
| CR-3 CallRail fact + discovery | DONE | `callRecoveryDiscoveryService.test.js` (19) |
| CR-4 nightly evidence persistence | DONE | task `call-recovery-discovery` in `nightlyHygieneRuntime` |
| CR-5 DNC/status/sale admission | DONE | `callRecoveryAdmission.test.js` (24) |
| CR-6 composite source + work item | DONE | same file — `buildRecoverySourceRow` |
| CR-7 Call End + curator effects | DONE | same file — `applyCallEndToEpisode` |
| CR-8 flags + activation ladder | DONE | `callRecoveryFlags.test.js` (8) |
| CR-9/10/11 canary → floor → review | OPERATOR | needs a running control plane |

764 tests pass repo-wide.

### Sanity check 2026-07-31 — 59 findings raised, 5 real, all fixed

Adversarial review (6 lenses, every finding refuted independently). The five
that survived, and what they were:

1. **`bad_lead` left a confirmed wrong number dialable.** `applyCallEndToEpisode`
   kept a private `TERMINALS` map keyed on PhoneBurner's RAW vocabulary, but
   `normalizeOutcome` collapses those — "bad number"/"wrong number"/"badnumber"
   all become canonical `bad_lead`, which matched nothing and fell to the
   retryable tail. Measured: `delivery.state="terminal"` alongside
   `episodeTransition="eligible"`, `removeExactContact=false`. Seven of the
   eleven map keys could never arrive; the tests fed exactly those dead keys,
   which is why it was invisible. Now branches on `delivery.state` /
   `delivery.lastOutcome` — the classification the decision owner already made.
2. **An opt-out never recorded durable suppression.** `opt_out` was not in
   `OUTCOME_ALIASES`, so it normalized to `review` — fail-closed (dialling
   stopped) but the request died with the work item instead of outliving it.
   Added `optout` / "opt out" / "opted out" / "remove me" / "unsubscribe" → `dnc`
   in the SHARED alias map; it applies to every lead, not just recovery.
3. **The CallLog projection named three fields that do not exist.** `agentId`,
   `extension`, `result` are not paths on `CallLog` (`providerAgentId`,
   `extensionId`, `outcome`/`missed`/`connected` are). Two failures rode on it:
   100% of candidates were dropped, AND `answered` was derived as
   `result == null ? true`, which — since `result` was always undefined —
   stamped `answered: true` on every leg. The first masked the second, so
   fixing the projection alone would have made hold music read as a human
   conversation. Both fixed together; `answered` now fails closed.
4. **The funnel could never qualify anything, silently.** `readCaseState` was
   never supplied and defaulted to `async () => null`, so every call held on the
   last gate and `qualified` was structurally 0 — and the nightly task counts
   `qualified` to decide whether to write. An operator could arm discovery, see
   the task report itself as writing, and persist nothing forever. Now bound to
   `CaseProfile`, and a missing `readCaseState` throws at plan time.
5. **`LeadDeliveryItem` had no home for the cohort fields.** Strict mode drops
   unknown keys, so `inventoryClass` / `contactPolicyId` / `expiresAt` /
   `eligibleFrom` would have vanished on write and every recovery gate would
   read the item as ordinary aged filler. The cap fails SAFE that way; the
   **120-day expiry does not** — the episode would never age out. Fields added.

Found separately while reviewing my own work, before the sweep returned:

6. **`compareSelectionCandidates` was not a valid comparator** — 36 transitivity
   violations in 1320 triples, because it mixed the pool comparator and a stable
   id inside one tier. `Array.sort` is implementation-defined with an
   inconsistent comparator, so the line an agent got could vary run to run. Now
   one ordering key per tier; brute-forced clean over 12,144 triples.
7. **A duplicate Call End claimed the attempt counted.** §19 says a replay adds
   no count; the function returned `countedAttempt: true` unconditionally and
   trusted callers to dedupe. PhoneBurner redelivers webhooks. Now takes
   `alreadyApplied`, and a Call End with no `providerCallId` freezes for review
   rather than colliding onto a shared effect key.

### ARCHITECTURE CORRECTION 2026-07-31 — discovery is an offshoot of metrics

Mickey, on being shown a funnel that qualified zero: *"none of these should be
added before they loop through the metrics and this should just be an offshoot
of that by which you will learn the agent who touched them first, then they will
show up in pb as well."*

Discovery was built as a parallel pipeline — its own CallRail pull, its own
CallLog query — and it could not work. On an INBOUND leg, `agentName` is the
CALLER's name and `providerAgentId` / `ringcx.agentId` / `connected` are never
populated: **0 of 4,530 July legs.** So §11's human-answer proof resolved nobody
and the funnel was structurally incapable of qualifying anything.

`buildCallRecoveryDiscoveryDeps` now consumes `gatherMaterial(["callsRange",
"callContext","payments","caseContacts"])` — the metrics pass's own output.
The agent comes from `callContext.officerByCase`, the settlement officer read
off the activity sweep, which is the same name the "Calls worth hearing" section
prints. On 2026-07-30 that resolved 6 of 8 long calls where the RC leg resolved
none.

Consequences, all intended:
- a candidate cannot be enrolled before the metrics pass has seen it;
- there is ONE place that learns who touched a call;
- no second CallRail pull and no second CallLog query. A test now asserts the
  dep builder contains neither.

Two further bugs fell out of getting there, both found by dry-running real days:

- `trackingPhone` was a GATE. §2.1's ten conditions never require it — §10 lists
  it as the first ROUTE to proving a mail piece, not a precondition. Gating on it
  rejected every call arriving from the metrics gather, which carries a resolved
  source name but not the number that rang.
- Prospect classification used `/\[tier|active|client|retained/` to detect a
  client, which matches the word ACTIVE inside **"[Active Prospect]"** — so every
  live prospect was rejected as `not-a-prospect`. Measured: 7, 6 and 5 false
  rejections on three consecutive days, i.e. most of the pool. Now keyed on
  Logics' own bracket group; only `[Active Prospect]` is eligible, and a `[TIER n]`
  is a resolution tier on an existing client.

**Measured funnel, four completed days, writes off:**

```
2026-07-27   91 calls -> 11 qualify
2026-07-28   51 calls ->  7 qualify
2026-07-29   65 calls ->  6 qualify
2026-07-30   51 calls ->  5 qualify
```

~29 qualifying CALLS in 4 days. Distinct episodes are fewer — several calls map
to one case (429326 alone had three on 07-30), which is one episode with three
pieces of evidence.

### The one seam left before a live canary

CR-5/6/7 are implemented as `callRecoveryAdmissionService`, which is pure and
fully injected — it decides admission, emits the source row and maps Call End
onto the episode. What is deliberately NOT done is calling it from inside
`leadDeliveryService`'s live claim path.

That is a ~20-line wiring change (composite source read + admission recheck at
claim time + Call End effect drain), and it was left out on purpose: the only
regression net for that path is `tests/lead-delivery/leadDeliveryRuntime.test.js`,
which is under a standing never-run rule on this box. Wiring the provider claim
without that net is the one step that should be taken with the runtime
observable, not blind.

Three defects were found and fixed in the CR-1 groundwork; do not reintroduce:

1. The tenant guard compared `fact.tenantDomain` against the option that SET
   it, so `tenantDomain: "WYNN"` returned `qualified`. §2.1(3) was unenforced
   while reading as enforced.
2. A seventh local phone normalizer. It now imports the canonical
   `casePhoneFoldService.normalizePhone` (which is dependency-free, so CR-1
   stays pure).
3. `inventoryClass` was `call_recovery`; §16 says `callrail_long_call_recovery`.
   Nothing would have caught it until CR-6 persisted it to `LeadDeliveryItem`.

Also settled during the build: a `discovered` episode has NO legal edge to
`expired` (§6), but the expiry sweep can return one. `expireEpisode()` walks the
legal path; do not call `transitionState(discovered -> expired)`.

Nothing is armed. All four flags are `false` in `.env`, no provider write path
exists yet, and the discovery task dry-runs its full funnel with writes off.

## 0. Purpose of this document

This is the implementation contract for converting qualified inbound CallRail mail
conversations that did not close into a bounded, voice-only PhoneBurner recovery
program.

It is intentionally a separate work order because the feature crosses:

- CallRail call gathering;
- historical mail-source attribution;
- Logics case identity and current status;
- payment/conversion evidence;
- DNC and litigator screening;
- a new durable source/evidence collection;
- the provider-neutral lead-delivery decision owner;
- PhoneBurner Pool delivery and native recycle behavior;
- exact Call End attempt counting;
- nightly hygiene, reporting, observability, and rollout controls.

This document authorizes no implementation, live write, flag change, provider post,
backfill, or service restart by itself. Mickey must explicitly authorize the build.

## 0.1 Mandatory re-read and handoff rule

Before every implementation turn:

1. Read this work order end to end.
2. Read the parent PhoneBurner work order end to end.
3. Read `AGENTS.md`, `PROJECT_HANDOFF.md`, and `CODEX_RECOVERY_NOTES.md`.
4. Inspect `git status --short`; preserve all unrelated WIP.
5. State in commentary:
   `Re-read CallRail recovery work order; active phase: CR-N`.
6. State that no folder ID will be guessed and no secret/customer payload will be
   printed.
7. Work only inside the active CR phase.
8. Run the named proof gate before advancing.
9. Record phase, files, tests, assumptions, flags, and remaining blank values at
   every handoff.

After implementation starts, advance automatically after each passing proof gate.
Pause only for a material policy decision, destructive action, external credential,
or live-write authorization.

## 0.2 Relationship to the parent PhoneBurner contract

All parent architecture laws remain in force:

- `LeadDeliveryItem` is the one canonical live delivery store.
- `leadDeliveryService.js` is the one decision owner.
- There are four shared pools only.
- Physical PhoneBurner Pool count is capacity truth.
- The existing provider lane serializes PhoneBurner writes.
- Only an exact persisted Call End counts an attempt.
- Callback capture returns promptly; downstream effects drain asynchronously.
- No phone-only matching is allowed for provider outcomes.
- No second refill scheduler, counter, queue, or provider writer is permitted.

This work order proposes one narrow cohort override that must be appended to the
parent contract before code begins:

```text
contactPolicy = long_call_recovery_120d_2x
daily cap     = 2 exact outbound PhoneBurner attempts
retry floor   = 120 minutes
program life  = 120 calendar days
channels      = voice only
```

### Selection priority — SETTLED 2026-07-31 (amends §16)

Mickey, verbatim: *"i do think 3 times a day is a little much for mail. but it
should be high priority for selection"* and then *"below brand new 0 contact but
above same day 1 contact until it gets contacted."*

The daily cap is unchanged — recovery was already 2/day, and the resolver
branches on `contactPolicyId` before age is consulted, so no recovery case can
ever inherit the ordinary 0–1 day allowance of 3.

Selection order is elevated, as a cross-pool RANKING lens
(`resolveSelectionRank`). Pool membership is untouched: four pools, and a
recovery case is still ordinary `older_available` work everywhere except the
moment of selection.

```text
0  overnight             first-contact barrier — recovery may never bypass it
1  new_today, 0 touches   a lead nobody has ever called still wins
2  RECOVERY, 0 touches    a 15-minute conversation outranks a second dial
3  anything touched       follow_up_due retries, and recovery once contacted
4  generic aged filler
```

The elevation is earned by the UNANSWERED conversation, not by membership — it
ends at the first attempt, or at any evidence of contact (`lastContactAt` alone
is enough, so a counter that failed to increment cannot silently re-grant
priority). Pinned in `tests/lead-delivery/callRecoverySelectionRank.test.js`.

The ordinary age-tapered caps continue unchanged for every other lead. The recovery
override applies only while this specific recovery episode owns the work item.

## 1. Product objective

Recover high-intent mail callers who had a substantial human conversation but did
not convert.

The system should:

```text
discover a qualifying inbound mail conversation
  -> prove a single case and a human answer
  -> wait until the next Pacific business contact window
  -> prove the case remains an open prospect
  -> perform a fresh DNC/litigator sweep
  -> offer it to the existing PhoneBurner delivery system
  -> allow no more than two exact attempts per eligible business day
  -> stop on conversion, appointment, DNC, opt-out, invalidity, or day 120
```

The system must not send email, SMS, RVM, prerecorded voice, or any other automated
engagement for this program.

## 2. Settled business policy

### 2.1 Qualification threshold

A qualifying call must satisfy every condition:

1. Provider is CallRail.
2. Direction is inbound.
3. Call belongs to the TAG CallRail tenant.
4. Call resolves to a historical mail piece, including a piece that later became
   inactive.
5. CallRail reports `answered === true`.
6. CallRail reports `duration >= 600` seconds.
7. A non-shared internal agent/extension match proves that a human at the company
   actually took the call.
8. Caller phone normalizes to one supported ten-digit US number.
9. Evidence resolves to exactly one TAG Logics case.
10. The case has no current sale/conversion/terminal evidence at admission.

CallRail documents `answered` as whether the call was answered, but a downstream
phone system can make that value true without proving a human conversation.
Therefore `answered + duration` is necessary but not sufficient; internal agent-leg
evidence is mandatory. Missing or ambiguous human evidence goes to review.

### 2.2 Start time

The program never starts on the day of the qualifying inbound call.

`eligibleFrom` is the opening of the next permitted Pacific business contact window,
as determined by the existing contact-window policy. It is not a hardcoded UTC time.

### 2.3 Duration

An episode expires 120 calendar days after its first qualifying inbound call.

Additional qualifying calls during an open episode add evidence but do not extend
the expiration. A new qualifying inbound call after a fully expired episode may
create a new episode, because it is a new consumer-initiated conversation. A DNC,
entity opt-out, permanent bad-number result, client status, or other permanent stop
survives episode boundaries and blocks a new episode.

### 2.4 Attempts

- Maximum two exact outbound PhoneBurner attempts per Pacific date.
- Minimum 120 minutes between retryable attempts.
- The qualifying inbound call does not count as an outbound attempt.
- Provider placement, folder movement, watchdog reads, discovery, reconciliation,
  and retry scheduling do not count.
- Only an exact persisted PhoneBurner Call End counts.

### 2.5 Answered recovery calls

Conservative default policy:

- once a recovery attempt reaches a human, no second attempt occurs that day;
- current case status is refreshed after the call;
- if no terminal outcome or conversion appears, the episode may resume on the next
  eligible business day;
- an unknown/contradictory outcome enters review and fails closed.

This avoids calling a person twice after already speaking with them that day.

### 2.6 Stop conditions

Any of the following prevents a new claim and removes an exact provider contact when
one exists:

- entity-specific DNC or explicit opt-out;
- national DNC, state DNC, or litigator result under the configured policy;
- Logics DNC status;
- invalid/disconnected/bad phone;
- sale, initial payment, conversion, retained/client status;
- active or completed appointment that makes further sales recovery inappropriate;
- non-prospect, duplicate, wrong person, or closed case;
- contact-safety `stop_contact`;
- program expiration;
- exact terminal PhoneBurner disposition;
- irreconcilable identity conflict.

Retryable infrastructure uncertainty produces `held`, not `terminal` and not a call.

## 3. Non-goals

This project does not:

- change PhoneBurner folder IDs, LeadStreams, or dialer presets;
- create another PhoneBurner folder or another pool color;
- create a new Windows service, cron, daemon, or refill loop;
- replace the current CallRail reporting system;
- infer a sale from AI sentiment or a report label;
- transcribe calls to decide admission;
- store recordings or raw webhook/API bodies;
- create normal multichannel LeadCadence schedules;
- send email, SMS, RVM, or prerecorded/artificial voice;
- alter existing LD/new-lead cadence policy;
- reopen a case with permanent stop evidence;
- make legal/compliance eligibility depend solely on elapsed time.

## 4. Architecture laws

### 4.1 Dedicated evidence source, not a competing queue

Create `CallRecoveryLead` as an upstream program/evidence collection.

It may answer:

- which call qualified;
- which case it resolved to;
- when the episode starts and expires;
- whether the episode is open, held, terminal, expired, or under review;
- when its DNC/status evidence was last refreshed.

It may not decide:

- pool membership;
- agent ownership;
- packet composition;
- delivery priority;
- refill timing;
- PhoneBurner folder selection;
- whether the provider should be called now;
- how an exact Call End transitions the live work item.

Those decisions remain in `leadDeliveryService.js`.

### 4.2 One live work item per case

The existing unique active-attempt rule on `(domain, caseId)` remains authoritative.

If a case already has ordinary provider-neutral delivery work:

- do not create a second work item;
- do not post a second PhoneBurner contact;
- do not override an in-flight provider attempt;
- hold the recovery episode with `existing-delivery-owns-case`;
- if existing work proves a permanent terminal condition, terminalize recovery too;
- if existing work is review/delivery-failed, hold recovery for the same review.

The recovery feature fills a gap; it does not compete with or duplicate an already
active delivery source.

### 4.3 Four pools remain four

No `recovery` fifth pool is added.

Recovery items use:

- `older_available` for a first available attempt;
- `follow_up_due` after a retryable exact Call End and the two-hour delay.

They carry metadata:

```text
inventoryClass = callrail_long_call_recovery
contactPolicyId = long_call_recovery_120d_2x
```

Within `older_available`, `leadDeliveryService` ranks recovery inventory ahead of
generic aged filler but behind `new_today` and `overnight`. This is the intended
“blue-like” treatment without falsifying age or modifying pool truth.

### 4.4 Report gathering stays read-only

Report composition and email delivery never write recovery state.

CallRail normalization must be reusable, but operational discovery has an explicit
nightly-hygiene task. The report and recovery task may share a fact-fetching helper or
process cache; the report is not the orchestrator and report failure cannot suppress
recovery.

### 4.5 One provider writer

All creates, moves, and deletes continue through the existing PhoneBurner adapter,
provider lane, agent Pool-operation lock, and reconciliation rules.

The new model/repository never imports the PhoneBurner client.

### 4.6 Before acceptance choose; after acceptance observe

Once PhoneBurner accepts an exact contact:

- the recovery source cannot reorder it;
- discovery cannot create a replacement;
- policy changes are enforced through the existing exact-contact curation path;
- Call End identity and reconciliation remain provider-authoritative.

## 5. Vocabulary

| Term | Meaning |
| --- | --- |
| qualifying call | One inbound CallRail mail call satisfying the 10-minute and human-answer proof |
| recovery episode | One bounded 120-day case-level opportunity beginning with a qualifying call |
| recovery evidence | Call/case/source facts explaining why an episode exists |
| admission | Decision that an episode may be considered by lead delivery |
| delivery work item | Existing canonical `LeadDeliveryItem` |
| inventory class | Metadata used by the decision owner to order work inside an existing pool |
| contact policy | Named cap/delay/lifetime rule applied by the decision owner |
| hold | Retryable fail-closed state; no provider claim |
| review | Human/system reconciliation required; no provider claim |
| terminal | Permanent stop for this episode |

## 6. Recovery episode lifecycle

Allowed source states:

```text
discovered
awaiting_start
eligible
active
held
review
terminal
expired
```

Allowed transitions:

```text
new call -> discovered
discovered -> awaiting_start | held | review | terminal
awaiting_start -> eligible | held | review | terminal | expired
eligible -> active | held | review | terminal | expired
active -> eligible | held | review | terminal | expired
held -> eligible | review | terminal | expired
review -> held | eligible | terminal | expired   (explicit reconciliation only)
terminal -> terminal
expired -> expired
expired + new qualifying inquiry -> new episode
```

Terminal and expired documents are immutable except for audit timestamps and a link
to a later episode. They are never silently reactivated.

## 7. Persistence contract

### 7.1 `CallRecoveryLead` shape

Required fields:

```text
programKey                    callrail-mail-long-call-v1
episodeId                     stable opaque episode identity
episodeNumber                 positive integer per domain/case/program
domain                        TAG
caseId                        canonical string/number normalization
normalizedPhone               ten digits
displayName                   nullable
firstQualifyingCallAt         immutable
latestQualifyingCallAt
qualifyingCallIds[]           capped, add-to-set
maximumObservedDurationSec
mailSourceCanonicalId         nullable only while review
mailSourceName                bounded display/audit label
humanAnswerEvidence           normalized safe identifiers/status only
discoveredAt
eligibleFrom
expiresAt
state
stateReason
lastEligibilityCheckedAt
lastStatusCheckedAt
dnc.checkedAt
dnc.nextCheckAt
dnc.result                    clean | hit | failed | unknown
dnc.reason                    bounded normalized reason
activeEpisode                 boolean
linkedLeadDeliveryItemId      nullable
supersedesEpisodeId           nullable
version
createdAt / updatedAt
```

No raw CallRail payload, Logics response, recording URL, transcript, token, secret,
or provider body is persisted.

### 7.2 Indexes

- unique `{ episodeId: 1 }`;
- unique `{ programKey: 1, domain: 1, caseId: 1, episodeNumber: 1 }`;
- unique partial `{ programKey: 1, domain: 1, caseId: 1, activeEpisode: 1 }`
  where `activeEpisode: true`;
- `{ state: 1, eligibleFrom: 1, expiresAt: 1 }`;
- `{ "dnc.nextCheckAt": 1, state: 1 }`;
- `{ normalizedPhone: 1, state: 1 }`;
- `{ qualifyingCallIds: 1 }` for idempotent evidence lookup.

### 7.3 Evidence cap

Keep at most 25 qualifying CallRail IDs per episode. Preserve the first and latest
qualifying call timestamps plus maximum duration independently so evidence capping
does not change business state.

### 7.4 Optimistic concurrency

Every state mutation uses versioned compare-and-set. Duplicate discovery, parallel
night tasks, process restarts, and overlapping status/DNC refreshes cannot regress
state or create two active episodes.

## 8. Call fact contract

Create a narrow normalized fact shape shared by report reads and recovery discovery:

```text
provider                     callrail
providerCallId
tenantDomain                 TAG
direction                    inbound
answered                     boolean
durationSec                  integer or null
recordingDurationSec         integer or null (diagnostic only)
startedAt
endedAt                      derived when safe
customerPhone                normalized at boundary
trackingPhone                normalized at boundary
sourceName                   bounded
firstCall / priorCalls       diagnostic only
```

The normalizer is pure. It cannot write Mongo, call Logics, decide DNC, send email,
or invoke PhoneBurner.

CallRail API `duration` is treated as provider-reported call duration, not labeled
“connected duration.” Human-answer evidence closes that semantic gap.

## 9. Discovery contract

### 9.1 Runtime owner

Add one task to the existing `nightlyHygieneRuntime` task registry:

```text
key: call-recovery-discovery
plan: read/normalize the completed Pacific day; count-only funnel
apply: upsert evidence/episode documents only when discovery flag is armed
```

This is a task in the existing nightly loop, not a new timer. One task failure does
not block other nightly chores. A failed task does not claim discovery completion;
the next safe pass can replay idempotently.

### 9.2 Completed-day boundary

Read the same completed Pacific date selected by nightly hygiene. Calls that are too
fresh or still mutable are deferred to the next pass. A configurable settlement
grace may be added only if CallRail post-call evidence is observed to lag.

### 9.3 Qualification pipeline

For every normalized fact:

1. Require provider/direction/tenant.
2. Require `answered === true`.
3. Require `durationSec >= 600`.
4. Resolve tracking/source evidence to a historical mail piece.
5. Match to a non-shared internal agent leg.
6. Normalize the caller phone.
7. Resolve exactly one case.
8. Check for an open episode.
9. Upsert evidence idempotently or create the next episode.
10. Set `eligibleFrom` and `expiresAt` deterministically.

Every rejection/hold reason is counted. No customer row is emitted in logs/health.

## 10. Mail-source proof

Current-active source configuration is not historical truth. A mail piece that is
inactive today was still mail when yesterday's call arrived.

Source proof order:

1. exact CallRail tracking number mapped to a stored/canonical mail piece;
2. exact canonical CallRail source identity mapped to mail;
3. exact historical source registry alias with one unambiguous canonical match;
4. otherwise `review: mail-source-unproven`.

Do not qualify generic service/client lines, LD campaigns, BCD unless later approved,
or source-name substring guesses.

## 11. Human-answer proof

Human-answer evidence must resolve the CallRail fact to an internal call leg within
a bounded time window and to a non-shared internal extension/agent.

Accepted proof:

- exact cross-provider/call link when available; otherwise
- normalized caller phone plus bounded call-start window plus one non-shared internal
  answered leg, with no competing match.

Rejected/held evidence:

- only a shared queue/line extension;
- IVR/voicemail/system-only leg;
- zero internal human matches;
- multiple plausible calls or agents;
- timestamp/phone contradiction.

This gate prevents a ten-minute phone-system interaction from being treated as a
ten-minute prospect conversation.

## 12. Case identity proof

Case resolution precedence:

1. exact bound `CallLog.caseDomain/caseId` from the matched human leg;
2. exact existing call-attribution record;
3. Logics phone lookup only when it returns one canonical TAG case;
4. otherwise review.

Never pick `results[0]` from an ambiguous phone lookup. Never cross TAG/WYNN/AMITY
solely because a phone matches. Spouse/household matching is not part of v1.

## 13. “Did not close” proof

The original nightly report is discovery evidence only. Current state decides whether
the episode can call.

Before first admission and every provider claim, fail closed on:

- CaseProfile `convertedAt`;
- first payment date, positive payment count, or positive total paid;
- authoritative PaymentTruth/PaymentLedger sale evidence available to the current
  runtime;
- Logics status outside the allowed prospect catalog;
- retained/client/closed/non-prospect lifecycle;
- active appointment;
- explicit contact-safety pause/stop as defined below.

If payment or status systems are unavailable, hold with a retryable reason. Never
treat “could not verify close” as “did not close.”

## 14. DNC and suppression contract

### 14.1 Initial sweep

Before first admission, perform a fresh RealValidation DNC/litigator lookup unless a
clean result within the approved reuse window is already present for the same exact
phone and policy.

Results:

- national/state DNC or litigator: terminal;
- clean: record `checkedAt`, schedule day-30 checkpoint;
- provider failure/timeout/contradiction: held, retry later;
- missing/changed phone: review or terminal depending on authoritative status.

### 14.2 Checkpoints

Schedule from `firstQualifyingCallAt`:

- day 30;
- day 60;
- day 90;
- day 120 expiration.

Every clean checkpoint advances atomically. Every hit stops the episode and triggers
exact-contact removal. Every failed lookup remains held with a bounded retry time.

### 14.3 Continuous entity suppression

At discovery, admission, claim, Call End, and curation, honor:

- Logics DNC;
- `cadenceState.channelDnc.cx` when an associated LeadCadence exists;
- `dncCheckpoints.hit` when an associated LeadCadence exists;
- CaseProfile opt-out detection;
- durable PhoneBurner DNC/opt-out outcomes;
- contact-safety `stop_contact`.

Entity-specific DNC always wins over inquiry/relationship timing.

## 15. Source adapter and admission

### 15.1 Composite source

Extend the provider-neutral source boundary to consider:

- existing active LeadCadence source rows;
- eligible `CallRecoveryLead` episodes.

The adapter only reads and normalizes. It does not classify pools or choose agents.

Use a typed cursor carrying source kind plus stable sort identity. Do not merge two
independent cursors with Mongo natural order. Head-page replay remains bounded and
deduplicated by canonical case identity.

### 15.2 Source normalization

A recovery source row supplies:

```text
domain / caseId
normalizedPhone / displayName
receivedAt = firstQualifyingCallAt
eligibleFrom / expiresAt
inventoryClass
contactPolicyId
sourceProgramId / episodeId
status and DNC evidence
caseProfile / activeAppointment joins
```

It does not supply a fake `leadCadenceId`.

### 15.3 Existing delivery conflict

Before insertion, read the canonical case work item:

- no item: normal admission may create one;
- active ordinary item: hold recovery as `existing-delivery-owns-case`;
- terminal item with terminal business reason: terminalize recovery;
- review/delivery-failed/in-call/provider-accepted item: hold recovery;
- contradictory source identity: review.

No recovery path may clear provider identity or resurrect a terminal item.

## 16. Pool classification and ordering

`leadDeliveryService` owns the policy:

```text
first daily availability -> older_available
retry due after exact call -> follow_up_due
```

Ordering precedence remains:

```text
follow_up_due
new_today
overnight
older_available
```

Inside `older_available`:

1. recovery inventory;
2. generic older inventory;
3. stable existing tie-breaks.

Within recovery inventory:

1. longest time since last exact outbound contact;
2. earliest episode expiration;
3. oldest qualifying call;
4. stable canonical identity.

Recovery cannot bypass an active overnight first-contact barrier.

## 17. Contact-policy decision

Add a pure policy resolver in `leadDeliveryService.js`:

```text
ordinary source -> existing age-based cap/delay policy
recovery source -> 2/day, 120-minute delay, 120-day expiry
unknown policy  -> blocked/review
```

The selected policy is persisted on `LeadDeliveryItem` as a named identifier plus
bounded source episode identity. Numeric values are re-derived from checked-in policy
code/config, not trusted from Mongo metadata.

Every relevant path must call the same resolver:

- source classification;
- claim-time eligibility;
- immediate/ordinary provider posting;
- Call End transition;
- provider contact curator;
- next-day reopen;
- reconciliation repair.

A code path that still calls the ordinary age-cap function directly for recovery is
a test failure.

## 18. PhoneBurner lifecycle

### 18.1 First placement

Recovery work enters ordinary packet/refill flow. It does not use the immediate-fresh
lane and does not bypass low-water/physical-count proof.

### 18.2 Native recycle

After a retryable first exact Call End:

- persist attempt count and last contact first;
- retain the same exact provider contact;
- PhoneBurner may recycle it after the configured two-hour interval;
- claim-time policy still rechecks status, DNC, window, expiration, and cap.

### 18.3 Daily cap

After the second exact counted attempt:

- remove the exact provider contact;
- keep the canonical work item in a next-day hold with no invented same-day due time;
- reopen only on a later Pacific date after source and eligibility refresh.

### 18.4 Day close

Existing 17:30 close owns physical folder draining. Recovery adds no close loop.
Next-day admission follows normal day-start/refill behavior.

## 19. Outcome matrix

| Normalized outcome | Count attempt | Same-day provider contact | Recovery episode |
| --- | ---: | --- | --- |
| no answer | yes | retain if count < 2; else remove | active/next-day hold |
| voicemail | yes | retain if count < 2; else remove | active/next-day hold |
| retryable disconnect/busy | yes | retain if count < 2; else remove | active/next-day hold |
| answered, unresolved | yes | remove/hold for rest of day | eligible next day after refresh |
| appointment | yes | remove | terminal |
| sale/client/payment/converted | yes when from a call | remove | terminal |
| DNC/opt-out | yes when from a call | remove | terminal + durable downstream DNC |
| bad number/wrong person/non-prospect | yes | remove | terminal |
| unknown/contradictory | at most once with exact identity | remove or freeze | review |
| duplicate callback | no additional count | no duplicate effect | unchanged |

## 20. Call End downstream effects

Extend the existing durable action/drain path; do not add synchronous callback work.

After the canonical attempt transition, enqueue idempotent recovery effects:

- update linked episode state/last eligibility time;
- terminalize episode for terminal outcomes;
- schedule next-day hold after answered-unresolved;
- preserve/reopen eligibility for retryable outcomes under cap;
- project attempt to DailyDial and CallLog through existing ownership;
- remove exact contact when policy requires.

Effect identity includes provider call/attempt identity plus episode ID. Replay is a
successful no-op after the first completed effect.

## 21. Runtime wiring

No new process.

Existing owners:

- nightly hygiene: completed-day discovery and evidence upsert;
- existing lead-delivery tick: bounded source ingestion, status/DNC refresh due work,
  pool admission, physical watchdog, and curator;
- existing callback route: durable event capture only;
- existing drain: outcome/business effects;
- existing report scheduler: read-only reporting only.

Bound every pass by count, cursor, time budget, and provider concurrency. A large
historical backlog cannot starve fresh delivery or Call End draining.

## 22. Configuration and flags

All checked-in defaults are false/dark:

```text
CALL_RECOVERY_DISCOVERY_ENABLED=false
CALL_RECOVERY_SHADOW_ENABLED=false
CALL_RECOVERY_DELIVERY_ENABLED=false
CALL_RECOVERY_AGENT_ALLOWLIST=
```

Checked-in policy constants:

```text
minimumDurationSec=600
maximumAttemptsPerPacificDay=2
minimumRetryDelayMinutes=120
maximumProgramAgeDays=120
dncCheckpointDays=[30,60,90]
evidenceCallIdCap=25
```

Do not use environment variables for core product rules unless Mickey explicitly
requires operator-tunable policy. Flags control activation, not business truth.

Flag semantics:

- discovery: allows evidence/source writes only;
- shadow: evaluates admission/classification but performs no provider write;
- delivery: permits recovery candidates to enter provider delivery;
- allowlist: narrows delivery to named configured agents during canary.

`delivery=true` while discovery/shadow prerequisites are false must fail closed and
surface a configuration error.

## 23. Observability contract

Health/runtime state is count-only:

```text
discoveryEnabled / shadowEnabled / deliveryEnabled
lastDiscoveryDay / lastDiscoveryAt / lastDiscoveryStatus
factsRead
qualified
rejectedByReason
episodesInserted / episodesUpdated
awaitingStart / eligible / active / held / review / terminal / expired
dncChecked / dncClean / dncHit / dncFailed
admissionEvaluated / admissionAccepted / admissionBlocked
providerAccepted / attemptsCounted / exactContactsRemoved
capHolds / answeredDayHolds
lastErrorCategory
```

Never expose names, phones, case IDs, call IDs, URLs, provider IDs, raw reasons from
external payloads, tokens, or environment values in health/logs.

Alerts:

- discovery cannot read a completed business day;
- zero qualified calls is not an error by itself;
- backlog/held growth beyond configured threshold;
- DNC lookup failure rate above threshold;
- provider acceptance without linked episode/work item;
- attempt over cap;
- terminal/DNC case physically present in a Pool after grace;
- recovery provider write while flag/allowlist is off;
- source conflict or identity contradiction.

## 24. Reporting contract

Add read-only recovery metrics only after delivery proof:

- qualifying calls;
- episodes admitted;
- held/rejected reasons;
- PhoneBurner attempts;
- reached humans;
- appointments;
- conversions/payments after recovery admission;
- DNC/opt-out/bad-number outcomes;
- active inventory and upcoming expirations.

Do not claim causal revenue attribution merely because payment occurred after a
recovery attempt. Label it as post-admission/post-contact conversion unless a stronger
attribution contract is separately approved.

Reports may link back to existing call-review audio when authorized, but the recovery
collection never stores those URLs.

## 25. File plan

Expected new files:

```text
packages/shared-models/src/CallRecoveryLead.js
packages/shared-repositories/src/callRecoveryLeadRepository.js
packages/shared-services/src/callrailCallFactService.js
packages/shared-services/src/callRecoveryDiscoveryService.js
tests/lead-delivery/callRecoveryPolicy.test.js
tests/lead-delivery/callRecoveryLeadRepository.test.js
tests/lead-delivery/callRecoveryDiscoveryService.test.js
tests/lead-delivery/callRecoverySource.test.js
tests/lead-delivery/callRecoveryRuntime.test.js
tests/lead-delivery/callRecoveryOutcome.test.js
tests/metrics/callRecoveryReporting.test.js
```

Expected existing files touched:

```text
.ai/context/PHONEBURNER_PROVIDER_NEUTRAL_LEAD_DELIVERY_WORK_ORDER_2026-07-10.md
packages/shared-models/src/index.js
packages/shared-models/src/LeadDeliveryItem.js
packages/shared-services/src/index.js
packages/shared-services/src/leadDeliveryService.js
packages/shared-repositories/src/leadDeliveryRepository.js
apps/control-plane/src/services/nightlyHygieneRuntime.js
apps/control-plane/src/server.js
packages/shared-services/src/reportBlocksService.js          (late reporting phase only)
packages/shared-templates/src/templates/reports/report.hbs  (late reporting phase only)
```

This is a planning manifest, not permission to touch every file. Each phase narrows
the actual diff. Avoid changes to inbound/outbound gateways, RingCX, web client, or
NSSM unless a failing proof demonstrates a real dependency.

## 26. Implementation phases

### CR-0 — contract adoption and baseline

Work:

- Mickey approves or edits this work order;
- append the accepted cohort override to the parent PhoneBurner work order;
- record active phase `CR-1`;
- inventory dirty-tree overlap;
- run current lead-delivery and metrics baseline tests without edits;
- capture count-only current service/config state; no restart.

Gate:

- no unresolved business-policy question;
- parent contract and this work order agree;
- baseline failures are documented before feature code;
- all new flags confirmed absent/off.

### CR-1 — pure qualification and contact policy

Work:

- implement pure CallRail fact normalization/qualification;
- implement pure episode timing;
- implement pure recovery contact-policy resolution in `leadDeliveryService`;
- implement outcome table and pool-priority comparison as pure functions;
- no Mongo, HTTP, runtime, flags, or provider code.

Gate:

- 599 rejects / 600 qualifies;
- answered false rejects;
- human-answer missing rejects/reviews;
- next-business-window and day-120 boundaries pass DST/weekend cases;
- exactly two attempts/day and 120-minute delay;
- answered gives no same-day retry;
- ordinary age-based policy remains byte-for-behavior compatible in tests.

### CR-2 — model and atomic repository

Work:

- create `CallRecoveryLead` schema/indexes;
- export model;
- implement thin repository CAS/upsert/cursor methods;
- enforce evidence cap and one-active-episode invariant;
- no external API or runtime wiring.

Gate:

- duplicate call upsert is idempotent;
- parallel first discovery produces one episode;
- new inquiry after expiry produces one next episode;
- DNC/terminal episode cannot reactivate;
- cursor is deterministic;
- model contains no raw payload/recording/transcript fields.

### CR-3 — CallRail fact and discovery shadow

Work:

- extract/reuse pure CallRail fact normalization;
- build read-only discovery planner;
- add historical mail-source and human-agent proof;
- add exact/ambiguous case resolution;
- wire no runtime and perform no writes by default.

Gate:

- report call counts remain unchanged;
- historical inactive mail piece still qualifies;
- service/client/LD/non-mail lines reject;
- shared-only/IVR-only calls reject;
- ambiguous calls/cases enter review;
- CallRail/API failure returns incomplete, never an empty-success day.

### CR-4 — nightly evidence persistence

Work:

- add the existing nightly-hygiene task;
- plan always read-only;
- apply writes evidence only behind discovery flag;
- add replay checkpoint and count-only state;
- no lead-delivery source admission.

Gate:

- flag off writes zero;
- dry run reports complete reason counts;
- crash/replay duplicates nothing;
- task failure does not block other nightly tasks;
- report scheduler remains read-only and unchanged in delivery behavior.

### CR-5 — DNC/status/sale admission

Work:

- add initial DNC/litigator transport and normalized persistence;
- add 30/60/90 checkpoint transitions;
- join current CaseProfile/payment/appointment/contact-safety evidence;
- add hold/retry/terminal decisions in the decision owner;
- no provider delivery.

Gate:

- lookup failure holds;
- all DNC types stop;
- sale/payment/conversion/client/appointment stop;
- stale/missing status holds;
- clean evidence expires on schedule;
- case/phone changes invalidate prior DNC proof;
- no external result value appears in logs.

### CR-6 — composite source and canonical work-item integration

Work:

- implement typed composite source cursor;
- normalize recovery source rows;
- persist inventory/contact policy identity on `LeadDeliveryItem`;
- enforce existing-work conflict rules;
- classify only into existing pools;
- shadow only.

Gate:

- no second active item per case;
- no fifth pool;
- recovery ranks ahead of generic aged only inside `older_available`;
- overnight barrier still holds;
- immediate-fresh lane never receives recovery;
- source replay does not regress attempt/status evidence;
- no fake LeadCadence row is created.

### CR-7 — Call End and curator integration

Work:

- apply the named contact policy across claim/post/completion/curation;
- add idempotent recovery downstream effects;
- enforce second-attempt removal and answered-day hold;
- preserve DailyDial/CallLog ownership;
- no provider writes while delivery flag is off.

Gate:

- exact Call End counts once;
- duplicate callback no-ops;
- first retryable attempt retains exact contact;
- second daily attempt removes exact contact;
- answered removes/holds for the day;
- terminal outcomes remove and terminalize;
- unknown outcome freezes review;
- next day reopens only after all gates pass;
- ordinary leads retain existing age-based behavior.

### CR-8 — runtime flags, health, and bounded shadow

Work:

- wire source consideration into the existing lead-delivery tick;
- add dark flags and allowlist;
- add count-only health and alerts;
- run historical dry run and live shadow with zero provider writes.

Gate:

- off means zero admission/provider mutation;
- shadow creates no provider contact;
- backlog cannot starve normal source ingestion/events;
- every candidate has one explainable state/reason;
- no PII/IDs/URLs in health/logs;
- configuration contradictions fail closed.

### CR-9 — one-agent live canary

External prerequisite:

- Mickey explicitly authorizes live provider writes and names the canary agent.

Work:

- enable delivery for allowlisted canary only;
- observe one controlled business-day slice;
- reconcile candidates, work items, physical Pool contacts, Call Ends, outcomes,
  DNC/status effects, and daily close.

Gate:

- every provider acceptance has one episode and one canonical work item;
- no non-voice action;
- no attempt exceeds two/day;
- no retry under 120 minutes;
- terminal/DNC contacts disappear by exact identity;
- ordinary refill/fresh delivery remains stable;
- restart/replay duplicates nothing.

### CR-10 — controlled floor rollout

Work:

- enable one additional agent at a time;
- observe fairness, packet mix, physical pool depth, callback reconciliation, and
  next-day reopening;
- run at least one complete 120-minute recycle proof and one daily-close/reopen proof;
- add read-only reporting block after delivery stabilizes.

Gate:

- stable full-day multi-agent evidence;
- no ordinary-lead regression;
- no candidate/source conflicts unresolved;
- no DNC/client/payment leakage;
- Mickey approves full-floor enablement.

### CR-11 — completion and deletion review

Work:

- record final evidence and operating runbook;
- identify temporary shadow/backfill code pending deletion;
- do not physically delete until Mickey approves;
- retain durable episode/audit data.

Gate:

- definition of done satisfied;
- rollback tested;
- docs and flags match deployed behavior;
- pending deletion list approved separately.

## 27. Historical backfill

Historical discovery is dry-run first and newest-first.

Rules:

- bounded date range explicitly supplied by operator;
- no full-account unbounded scan;
- reuse provider call ID and case-level idempotency;
- create evidence/episodes only behind discovery flag;
- never deliver historical candidates until shadow gate passes and delivery is
  separately authorized;
- expire candidates already past day 120 without DNC/provider work;
- unresolved historical identity remains review;
- never replay missed daily attempts or create catch-up bursts.

## 28. Rollback

Immediate rollback:

1. Set `CALL_RECOVERY_DELIVERY_ENABLED=false`.
2. Leave ordinary lead delivery running.
3. Existing exact recovery contacts are removed/curated through the decision owner;
   do not bulk-delete unknown contacts.
4. Discovery may remain on for evidence or be disabled independently.
5. Preserve episode/work-item/call evidence for reconciliation.

Rollback never means:

- disabling all PhoneBurner delivery;
- deleting folders;
- clearing Mongo collections;
- resetting attempt counts;
- changing provider IDs;
- restarting unrelated services;
- reverting the dirty working tree.

## 29. Live deployment rules

- Commit scope must contain only approved work-order files plus required tests.
- Deploy targeted files only to the Linux checkout; never pull/reset/clean a dirty
  live tree.
- Create a timestamped backup before overwriting live targets.
- Verify hashes, syntax, focused tests, service active state, and health.
- Linux targeted `parallel-control-plane` restart is owned by Codex after explicit
  live-change authorization.
- Windows `Parallel*`/NSSM restarts remain Mickey's responsibility.
- No flag is enabled merely because code was deployed.
- No provider write occurs until CR-9 authorization.

## 30. Definition of done

The project is complete only when:

1. Every admitted episode is backed by one qualifying CallRail call and one human
   internal-answer proof.
2. Every episode resolves to one canonical TAG case and phone.
3. No report/email path owns operational writes.
4. No normal LeadCadence multichannel schedule is created.
5. No email, SMS, RVM, prerecorded, or artificial-voice action is possible.
6. No case has two active delivery work items or two provider contacts from this
   feature.
7. DNC/status/payment/client/appointment evidence fails closed at admission and claim.
8. Initial and 30/60/90 DNC checks are durable and replay-safe.
9. Recovery never starts before the next business contact window.
10. No episode receives more than two exact attempts per Pacific date.
11. No retry occurs before 120 minutes.
12. Human answer produces no second same-day attempt.
13. Every terminal condition removes the exact contact and stops the episode.
14. Every open episode expires at day 120; additional calls do not silently extend it.
15. A new post-expiration inbound inquiry can create a new episode without bypassing
    permanent suppression.
16. Existing fresh/overnight/older/follow-up behavior remains stable for ordinary
    leads.
17. Physical Pool, provider acceptance, and Call End identity remain authoritative.
18. Restart/replay duplicates no episode, item, contact, attempt, or effect.
19. Health/reporting is count-only and contains no customer/provider identifiers.
20. One-agent and multi-agent live proof pass under Mickey's explicit authorization.

## 31. Pre-implementation approval checklist

Implementation must not begin until all boxes are explicitly satisfied:

- [ ] Mickey accepts the 10-minute threshold.
- [ ] Mickey accepts next-business-window start.
- [ ] Mickey accepts 120 calendar days from the first qualifying call.
- [ ] Mickey accepts two attempts per eligible Pacific business day.
- [ ] Mickey accepts the two-hour minimum retry delay.
- [ ] Mickey accepts no same-day retry after a human answer.
- [ ] Mickey accepts voice-only with no email/SMS/RVM.
- [ ] Mickey accepts initial plus 30/60/90 DNC checks.
- [ ] Mickey accepts `CallRecoveryLead` as evidence source, not runtime queue.
- [ ] Mickey accepts existing four-pool admission and blue-like ordering inside
      `older_available`.
- [ ] Parent PhoneBurner work order contains the cohort override.
- [ ] Dirty-tree overlap and baseline tests are recorded.
- [ ] All flags are checked in false.
- [ ] No folder/provider identifiers need to be invented or changed.

Until this checklist is approved, this file remains a design/work-order artifact only.
