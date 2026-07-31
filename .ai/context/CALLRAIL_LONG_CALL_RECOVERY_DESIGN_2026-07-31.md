# CallRail Long-Call Recovery Design

Date: 2026-07-31  
Status: SUPPORTING DESIGN — implementation contract is
`CALLRAIL_LONG_CALL_RECOVERY_WORK_ORDER_2026-07-31.md`; no runtime or live behavior
is authorized by this document  
Owner: Mickey / Codex  
Parent contract: `PHONEBURNER_PROVIDER_NEUTRAL_LEAD_DELIVERY_WORK_ORDER_2026-07-10.md` Phase 9

## 1. Settled policy

Create a voice-only recovery program for an inbound CallRail mail caller when:

- the call is answered and has at least 600 seconds of connected duration;
- the call resolves to exactly one TAG Logics case and one normalized US phone;
- the case has not converted or produced a completed sale;
- the case and phone pass the current status, suppression, and DNC gates;
- the recovery program starts no earlier than the next Pacific business morning;
- the program lasts at most 120 calendar days from the qualifying call;
- the program permits at most two PhoneBurner attempts per eligible Pacific business day;
- attempts are separated by the existing PhoneBurner two-hour recycle interval;
- SMS, email, RVM, and every other non-voice action are forbidden for this program.

An opt-out is not the only stop. DNC, sale, payment, conversion, active appointment,
client/non-prospect status, invalid phone, ambiguous identity, an unresolved high-risk
read, and program expiration all stop or hold delivery as described below.

## 2. Architecture decision

Use a dedicated upstream collection, tentatively `CallRecoveryLead`, but do not make
it another queue, scheduler, counter, allocator, or PhoneBurner writer.

The collection answers only:

> Why is this case a member of the long-call recovery program, and is that program
> still open for consideration?

`leadDeliveryService.js` remains the only decision owner. `LeadDeliveryItem` remains
the only provider-neutral live delivery store. PhoneBurner continues to receive work
through the existing serialized provider lane and existing physical-Pool refill path.

```text
CallRail call facts
  -> recovery discovery/evidence record
  -> next-business-day status + DNC admission check
  -> leadDeliveryService eligibility and pool classification
  -> LeadDeliveryItem
  -> existing PhoneBurner packet/refill/provider lane
  -> exact Call End attempt evidence
  -> continue, hold, or stop
```

This deliberately avoids manufacturing a normal `LeadCadence` row. That prevents a
voice-only recovery case from accidentally acquiring SMS, email, or RVM schedule
actions while still allowing the existing delivery runtime to curate PhoneBurner.

## 3. Collection boundary

One `CallRecoveryLead` document represents one case-level recovery program, not one
daily dial and not one provider contact.

Suggested stable key:

```text
programKey = callrail-mail-long-call-v1
identity   = programKey + domain + caseId
```

Suggested fields:

```text
programKey
domain / caseId
normalizedPhone
displayName
firstQualifyingCallAt
latestQualifyingCallAt
qualifyingCallIds[]          capped, add-to-set audit evidence
maximumObservedDurationSec
mailSourceCanonicalId/name
discoveredAt
eligibleFrom
expiresAt
state                       discovered | awaiting_start | eligible | held |
                            active | terminal | expired | review
stateReason
lastEligibilityCheckedAt
lastStatusCheckedAt
dnc                         checkedAt / result / nextCheckAt / reason
version
createdAt / updatedAt
```

Do not store recordings, transcripts, raw CallRail payloads, raw Logics responses,
provider credentials, or report HTML in this collection.

Required indexes:

- unique `{ programKey, domain, caseId }`;
- `{ state, eligibleFrom, expiresAt }` for bounded source reads;
- `{ "dnc.nextCheckAt": 1, state: 1 }` for the compliance sweep;
- `{ normalizedPhone: 1, state: 1 }` for suppression reconciliation.

## 4. Discovery is evidence, not admission

The existing `callsRange` gather already proves the useful CallRail facts: provider
call ID, caller phone, source, start time, duration, and answered state. Recovery
discovery should reuse the same narrow CallRail normalizer, not invoke the report
composer and not parse an email.

For every candidate:

1. Require CallRail, inbound, answered, and duration `>= 600` seconds.
2. Require a source that resolves as a mail piece. Current-active-source status must
   not erase historical mail provenance.
3. Normalize the phone.
4. Resolve the phone to exactly one Logics case. Zero or multiple cases enter
   `review`; they never enter delivery.
5. Upsert the case-level program record idempotently and add the CallRail call ID as
   evidence.
6. Set `eligibleFrom` to the next Pacific business morning.
7. Set `expiresAt` to 120 calendar days after the first qualifying call.

The discovery pass may run alongside the metrics scrape, but the email/report path
must never own operational writes. Both call the same reusable discovery service.

## 5. Admission and claim-time safety

At `eligibleFrom`, admission requires all of the following:

- fresh Logics status evidence;
- allowed prospect status;
- no DNC or entity-specific opt-out evidence;
- a fresh RealValidation DNC/litigator result;
- no payment, conversion, retained/client state, or completed sale;
- no active appointment;
- a valid normalized phone and supported contact timezone/window;
- no existing active delivery attempt for the same domain/case.

An unavailable or contradictory status, DNC, identity, or contact-window read is a
retryable hold, never permission to call.

The same high-risk gates run again immediately before every provider claim. A clean
nightly snapshot cannot authorize a call after the case changes during the day.

## 6. DNC policy

The program receives a full DNC/litigator sweep before its first admission. A failed
lookup quarantines the record in `held`; it does not fall through as clean.

Reuse the established 30/60/90-day checkpoint concept:

- admission: full DNC/litigator check;
- day 30: recheck;
- day 60: recheck;
- day 90: recheck;
- day 120: expire regardless of prior results.

CRM DNC and entity-specific opt-out evidence are checked continuously and stop the
program immediately. A PhoneBurner DNC disposition uses the existing durable Call
End action path and retires the recovery program as a downstream effect; the callback
route still returns promptly and does not wait on Logics.

## 7. Pool treatment

Do not create a fifth shared pool and do not pretend an old case was received today.

The recovery program supplies ordinary callable work into the existing
`older_available` / `follow_up_due` lifecycle with an explicit inventory class:

```text
inventoryClass = callrail_long_call_recovery
contactPolicy  = long_call_recovery_120d_2x
```

Within ordinary available work, `leadDeliveryService` may rank this inventory with
the blue/newer preference, ahead of generic aged filler, without changing its true
age or its four-pool membership. Agent packet allowances remain configuration; the
new collection cannot allocate an agent.

After one retryable Call End, the same exact provider contact remains available for
PhoneBurner's two-hour recycle. After the second counted attempt that Pacific day,
the existing exact-contact removal path removes it from the physical Pool. The next
eligible business day reopens it if every gate still passes.

## 8. Attempt and outcome policy

Program-specific decision inputs:

```text
maximumAttemptsPerPacificDay = 2
minimumRetryDelayMinutes     = 120
maximumProgramAgeDays        = 120
channels                     = voice only
```

Only an exact, persisted PhoneBurner Call End counts an attempt. Placement, folder
movement, reconciliation, watchdog refill, and discovery never count.

Outcome treatment:

- no answer / voicemail / retryable disconnect: remain available below the daily
  cap, then reopen next eligible business day;
- DNC / opt-out / bad number / non-prospect / client / sale / payment / conversion:
  terminal and exact-contact removal;
- appointment: terminal for this recovery program and exact-contact removal;
- unknown or contradictory callback: `review`, fail closed;
- answered without a terminal business outcome: hold for status resolution and do
  not make another same-day attempt. If still open, it may resume the next eligible
  business day.

## 9. Sale reconciliation

“Did not close” is not a one-time report label. Before admission and every later
claim, current case state must be reconciled against the same authoritative signals
already used by lead delivery:

- CaseProfile conversion/payment evidence;
- current Logics prospect status;
- payment truth when available;
- active appointment evidence;
- explicit DNC/opt-out and contact-safety review state.

A delayed sale posted after the original CallRail call therefore removes the case
before another provider claim. The report may display the candidate, but the report
is never the sale authority.

## 10. Runtime ownership

No new Windows service, cron, daemon, or independent refill loop.

The existing control-plane tick performs bounded phases:

1. discover newly settled CallRail calls (or consume already-discovered records);
2. refresh a bounded set of due status/DNC holds;
3. ask `leadDeliveryService` to consider eligible recovery sources;
4. run the existing physical-Pool watchdog/refill behavior.

The source repository may read and normalize `CallRecoveryLead`, but it cannot decide
pool, priority, cap, timing, ownership, or outcome. Those remain in
`leadDeliveryService.js`.

## 11. Flags and rollout

All new behavior starts dark:

```text
CALL_RECOVERY_DISCOVERY_ENABLED=false
CALL_RECOVERY_DELIVERY_ENABLED=false
```

Recommended rollout:

1. Historical dry run: count-only candidate funnel by rejection/hold reason.
2. Shadow source: prove which pool and policy each candidate would receive.
3. One-agent canary with provider writes enabled only for that agent.
4. Full-floor enablement after exact Call End, cap, DNC, and terminal-removal proof.

The kill switch disables recovery admission only. Existing provider contacts are
then curated by normal eligibility/removal logic; data is not deleted.

## 12. Proof gates before live writes

- 599 seconds rejects; 600 seconds qualifies.
- unanswered CallRail calls reject.
- non-mail sources reject.
- duplicate call and duplicate case discovery remain one program.
- zero/multiple case matches enter review.
- start never occurs before next Pacific business morning.
- DNC lookup failure holds; national/state/litigator hit terminates.
- Logics DNC, sale, payment, conversion, client, non-prospect, and appointment block.
- SMS/email/RVM actions are structurally impossible.
- an existing active LeadDeliveryItem prevents duplicate delivery.
- no more than two exact attempts per Pacific day.
- retry cannot occur before 120 minutes.
- an answer gets no same-day retry.
- day 120 expires and removes any exact provider contact.
- Call End replay is idempotent.
- watchdog and Call End cannot double-post.
- a disabled flag produces no source admission and no provider write.

## 13. Required parent-contract amendment before implementation

Before code is written, amend the PhoneBurner work order to authorize:

- `CallRecoveryLead` as an upstream evidence/source collection, never a competing
  runtime store;
- a composite source read while preserving one `LeadDeliveryItem` per case;
- the `callrail_long_call_recovery` inventory class;
- the program-specific two-attempt daily cap and 120-day expiration;
- admission and 30/60/90 DNC checks;
- dark flags and the rollout proof gates above.

No implementation begins until Mickey accepts this design and the parent contract
records the accepted policy.
