# CX Call-Wrap Queue — design ruling (Mickey, 2026-07-06 evening)

**The ruling, in the owner's words:** *"everything is done async. the calls just keep
flowing and dnc and appointment only exist in the call wrap... they disposition to move on
to the next but can still set an outcome that affects future dials async of the flow of
calls... this would also remove all logics calls off the trunk. basically answered, no
answered, voicemail => call wrap queue => drain... isolating services is better long term
stability."*

**Status: V1 BUILT 2026-07-06 late (gate 309/309), DEFAULT OFF (`CX_CALL_WRAP_QUEUE_ENABLED`,
flag off = legacy behavior byte-for-byte).** The end-call → wrap-up → drain chain is wired:
- CxCallWrapCard model (2h clock + dossier) / cxCallWrapCardRepository (insertOnce, CAS
  resolve, expiry scan) / cxCallWrapCardService (trigger predicate, RESOLUTION_RULES, the
  unified resolve pipeline, the janitor).
- Drain hook: flag on → answered rows become cards (exactly-once via inherited idemKey,
  coach summary from the existing enrich join) instead of the legacy auto-summary; the
  janitor rides the drain tick.
- Routes: GET /api/cx/bulk-load/wrap-cards + POST /wrap-cards/resolve (agent-ownership
  check, admin bypass; ✕ arrives as "dismiss").
- Interview activity reuses the EXISTING writeCxCallWrapSummary pipeline (threadKey dedup)
  at RESOLUTION time; DNC emits the correction row (drain applies app-side — layering law);
  appointment rides createCxAppointment (the M3 backbone) attributed to the resolver.
- Front end: the "Call wrap-up — answered today" bar in CXWorkspaceBulkLoad —
  [DNC] [Appointment → datetime-local] [✕] per card; renders NOTHING while the flag is off.
- V1 deferrals (explicit): formSnapshot lands with WO-17; Logics DNC status write still
  unwired (the injectable `updateLogicsDncStatus` seam exists — the pre-existing compliance
  gap REMAINS until it's wired and proven); queue-row `servedQuarantineUntil` stamping +
  resurface enforcement is a follow-up (the card's 2h clock is live).
Pilot: set the flag, restart, rebuild the client, answer one test call, watch the card
appear — then press each button once and check Logics + the outbox.

## Why (evidence from the 2026-07-06 drain characterization)
- The ONLY Logics write on today's terminal path is the call-wrap activity — fired AFTER
  markDrained, failures never retried (at-most-once). A queue-shaped job without a queue.
- Bulk DNC performs NO lead-wide contact stop and NO Logics write — the comments claiming
  the drain "routes DNC to Logics" describe a branch that does not exist. The job never had
  a home. (Today's real DNC effect: queue row completed + cadence stamps only.)
- The appointment path (submitCxBulkLoadAppointmentWrap) is the freeze model: session marked
  busy through a multi-second Logics commit so the watcher won't clear current (#11). Works,
  but the trunk holds its breath for an external API.
- The correction lane drains near-effect-free (metadata amendment only) — corrections are
  wrap-shaped work pretending to be terminal rows.

## The pipeline
```
outcome click (answered / no-answer / voicemail / dnc-intent / skip)
      │  one press = advance; the flow NEVER blocks
      ▼
terminal OUTBOX (exists today; unchanged)
      ▼
DRAIN  = APP-SIDE ONLY: queue-row transition, cadence counters/reschedule,
         CallLog, agent-state clear, attempt proof. ZERO Logics calls.
      ▼ (emits wrap items for calls with wrap material)
CALL-WRAP QUEUE = HUMAN + LOGICS SIDE, async:
         Logics activity (call summary), appointment create,
         DNC → Logics status + lead-wide contact stop,
         outcome corrections (WO-31), coach summary enrichment.
         Its app-side consequences (remove lead until appointment time,
         DNC the rows) flow BACK through the drain as correction/command rows.
```

## Ownership contract (reads → writes, per the side-by-side law)
| Layer | consumes | produces | never touches |
|---|---|---|---|
| Disposition click | current call identity | ONE outbox row | Logics, modals (except live-call M3) |
| Drain | outbox rows | queue/cadence/CallLog/agent-state writes + wrap items | Logics, agent attention |
| Wrap queue | wrap items + agent grooming (worklist UI) | Logics activity/appointment/status, correction rows back into the outbox | the live call flow, the current slot |

## UX resolution (the "two things at once / flood" worry)
- It is never two-things-at-once: ONE mandatory act (disposition → advance), everything else
  is a WRAP ITEM on the worklist ("Answered today — follow up": [Set appointment][DNC][✕]) —
  WO-32 / BLOCK I is the wrap queue's UI, already specced. Groomed between calls.
- Flood control: only answered calls generate wrap items (a few/hour); ✕ dismisses;
  items auto-expire end-of-shift into "no action" (policy — confirm with owner).
- The live-call appointment (prospect still on the line) keeps M3: no freeze needed —
  the live call itself holds the dialer. Post-hangup appointment = wrap item.
- The freeze model survives ONLY as that live-call case; the session-busy hold for
  post-call paperwork is retired when this lands.

## Build law for the wrap queue (learn from the drain's own gaps, day one)
1. At-least-once WITH per-effect idempotency keys (the drain's counter-drift bug class).
2. Attempt cap + dead-letter status + backoff (the drain has poison-retry-forever today).
3. Claim CAS on items (the drain has no claim semantics today).
4. Every Logics write carries an idempotency token (threadKey pattern generalized).
5. Default-off env gate; the current wrap/appointment paths keep working until cutover.

## Sequencing
1. FIRST (now, small, pinned): drain hardening quick wins from the characterization —
   poison cap/dead-letter, replay counter-drift guard, systemDisposition store one-liners,
   markDrained CAS. Keeps the CURRENT trunk safe regardless of this design's timeline.
2. Wrap-queue spine (schema + repository + worker, default-off) absorbing WO-31 corrections
   + WO-32 worklist + the Logics DNC/appointment jobs. WO-17 identity routing feeds it.
3. Cutover per surface: activity first (lowest risk), then appointment, then DNC (compliance
   — needs the Logics status + contact-stop wired and PROVEN before the old path retires).

## The drain → wrap connection (sketched 2026-07-06 late, Mickey's spoke-to-a-human rule)

**The trigger rule, in the owner's words:** *"this only needs to fire if the call was
'Answered' on our side, not on the cx side which answered has multiple outcomes. like they
have to physically speak to someone for this to be necessary."*

**Why this is one predicate, not a detection problem:** OUR outcome enum already encodes
"physically spoke" — `answered` can only be produced by (a) the agent's click or (b) the
connected latch + the 10s real-pickup guard on an auto-advance. RingCX's messy answered
(SIP-answers, screeners, VM pickups) never lands in our enum as `answered`: the guard
downgrades short connects, the Voicemail click names VM boxes. So:

```
wrapItemNeeded(drainedRow) =
     row.payload.eventType is terminal (NEVER corrections/commands — no cycles)
 AND row.resolution is full          (minimal/malformed rows carry no trustworthy context)
 AND outcome ∈ { answered, dnc }     (+ appointment-wrap rows, which arrive pre-spoken)
```
`voicemail`, `did_not_connect`, `skipped` NEVER generate wrap items — that's the volume
filter: never-connects (the vast majority) stay drain-only. A long screener that survives
the 10s guard will occasionally produce a wrap item; the agent's ✕ absorbs it (acceptable
noise, and the ✕ records "no action").

**THE PURITY LAW (Mickey's refinement, 2026-07-06 late):** *"dnc appointment or x on the
card. basically 0 logics writes 0 mongo writes on the outcome of the dialer just pure cx
state is the idea."* The dialer's outcome writes CX STATE ONLY — session, queue rows, dial
scheduling. It writes NOTHING into case-land: no Logics activity, no Logics status, no
CaseProfile communications — ever, automatically. Case-land is touched ONLY by a human
pressing a card button. ✕ (or janitor expiry) = the card vanishes and NOTHING was ever
written anywhere outside CX state.

Consequences:
- **The auto call-summary activity is RETIRED at cutover** (today's writeCxCallWrapSummary →
  CaseProfile communication + Logics createActivity on answered calls — the outcome will no
  longer auto-generate it; if an appointment is booked, the summary can ride THAT write as
  context).
- **DNC leaves the live disposition row at cutover** — the dialer's buttons become
  Answered / No answer / Voicemail (+Skip). A prospect saying "never call me" = click
  Answered to advance, then DNC on the card, seconds later, async. One click stays the only
  mandatory act. (M3 remains for live-call appointment booking only.)
- The trigger predicate simplifies: `wrapItemNeeded = outcome === "answered"` (terminal
  rows only, full resolution). Nothing else makes a card.

**The card:** `[DNC] [Appointment] [✕]` — three buttons, nothing else.

```
DRAIN (per drained row, if wrapItemNeeded):
  insertOnce into CallWrapQueue {
    idemKey: row.idemKey          ← inherits the outbox key = exactly-once card creation
    payload: caseId, queueItemId, uii, agentEmail, name, at   (render data only)
    status: pending | actioned | dismissed | expired
  }
```

**THE UNIFIED RESOLUTION PROTOCOL (Mickey, 2026-07-06 late: "the update protocol should be
the same series of functions just carrying different rules around logics").** Every card
resolution — button OR passive expiry — flows through ONE pipeline; only the rules row
differs. The debate ("should ✕/no-click send to Logics?") resolves YES for the activity:
a card only exists because a human spoke to someone, and a real conversation must reach the
case file — the interview writes at resolution time with the full dossier, retried, deduped.

```
resolveWrapCard(card, resolution):            // resolution ∈ dnc | appointment | dismiss | expire
  1. freeze the card (CAS pending→<resolution>) — exactly-once; replays no-op
  2. rules = RESOLUTION_RULES[resolution]
  3. rules.logicsStatus   → Logics status update (DNC)
  4. rules.logicsActivity → ONE activity: the INTERVIEW (coach summary + form notes +
                            outcome + sys-label), threadKey cx-call:<uii> dedup,
                            SKIPPED when the dossier has no material (no noise)
  5. rules.appointment    → Logics appointment (interview rides it as context)
  6. rules.correctionRow  → correction row into the outbox (app-side effects via the drain)
  7. the 2h quarantine clock is never touched by any resolution

RESOLUTION_RULES = {
  dnc:         { logicsStatus: "DNC", logicsActivity: true, correctionRow: "dnc" },
  appointment: { appointment: true,   logicsActivity: true, correctionRow: "hold-until-appt" },
  dismiss:     { logicsActivity: true },   // ✕ — the interview still lands
  expire:      { logicsActivity: true },   // no click = same as ✕; a real call still happened
}
```

All four rows execute inside the wrap worker under the drain's laws (few retries, backoff,
minimal-resolve, nothing parks). PURITY LAW AMENDMENT: the dialer's outcome still writes
ZERO case-land — but the CARD is now the single, unified case-land writer, and even
"nothing" (✕/expiry) files the interview when there is material. Flipping any cell of
RESOLUTION_RULES is a one-line policy change, not a redesign — that is the point of the
table. DNC-accident note (Mickey): the interview activity landing on EVERY resolution is
what makes an accidental DNC recoverable — the record of what was actually said is in the
case file next to the status, "and it's free."

**THE LAYERING LAW (Mickey, 2026-07-06 late: "think of wrap up as exterior api calls and
then the drain writes to mongo one at a time in the order received"):**
- **WRAP WORKER = EXTERIOR ONLY.** Its side effects are Logics API calls (status, activity,
  appointment) and nothing else. It NEVER writes Mongo business state directly — every
  app-side consequence of a card press is expressed as a correction/command ROW into the
  terminal outbox.
- **DRAIN = THE SINGLE MONGO WRITER**, one row at a time, in the order received (the
  oldest-first serial scan it already does, now canonized as law). All app-state mutation —
  queue rows, cadence, holds, DNC app-effects — flows through this one serialized choke
  point. No write races are possible by construction, because there is exactly one writer
  and it is single-file.
- **METRICS TIE-BACK:** every row type the drain applies DECLARES its metrics effects, and
  the drain maintains them in the same serialized write — the counters/attribution feeding
  the metrics lists (placed/answered/DNC counts, agent attribution) can never diverge from
  the state change that caused them, because they are the same write in the same order.
  Card-originated rows carry the acting agent so attribution lands on the right person
  (e.g. the appointment credits the agent who made it).

**APPOINTMENT, SLASHED (Mickey, same ruling):** on the wrap BAR, [Appointment] is just a
date+time picker — no modal, no workbench choreography. Pick a slot → the wrap worker
creates the Logics appointment (interview as context) attributed to the agent who made it →
it appears on THAT agent's appointments view → the command row holds the lead until the
appointment time. M3 (the live-call modal) survives only for booking while the prospect is
still on the line.

**THE QUARANTINE RULE (Mickey, 2026-07-06 late):** *"by rule, by ending up in someone's
queue it shouldn't appear anywhere else for 2 hours — and by then the dnc should have been
resolved."* Any lead that was SERVED (became an agent's current) gets a flat **2-hour
no-resurface floor** measured from the serve: it cannot be re-reserved, re-loaded,
re-published, cadence-dialed on any channel, or surface in any other agent's pool inside
that window. This is what makes async DNC safe: the card's decision window and the lead's
quarantine are THE SAME CLOCK — a DNC pressed any time inside 2h always lands before the
lead could ring anywhere again.
- Enforcement sketch: the terminal handler stamps `metadata.servedQuarantineUntil = servedAt
  + 2h` on every served lead's terminal; reschedules take `releaseAt = max(plan delay,
  quarantineUntil)`; the reserve/loader/blast surfaces honor the marker.
- Card expiry = the same 2 hours (SUPERSEDES the earlier end-of-shift idea; open question
  #2 is now answered): at +2h an untouched card expires to "no action" and the lead
  re-enters circulation naturally. Card actions can only EXTEND holds (appointment) or kill
  the lead (DNC) — nothing shortens the 2h, including ✕.
- Sub-decision flagged for the owner: does the 2h floor also override SHORTER plan retries
  for served never-connects (e.g. a 60-min ring-out retry)? Default here: YES — "by rule" —
  a served lead rests 2h regardless of outcome; say the word if ring-outs should recycle
  faster.

**THE CARD CARRIES THE WHOLE CALL (Mickey, same ruling):** *"call wrap up needs to carry the
entire coach session, the form, everything needs to make it to call wrap up from the end of
the call."* The card is not a reminder — it is the call's complete context, frozen at
hang-up, so the async decision is as informed as the live one:
- **Form snapshot** — the case panel exactly as the agent left it (names, caseId, typed
  notes). Carrier: the disposition POST gains a `formSnapshot` field (this feeds the WO-17
  identity-routing contract: the POST becomes `{queueItemId, uii, disposition,
  formSnapshot}`), rides the outbox payload, lands on the card.
- **The entire coach session** — coachSessionId already lives on the outbox row, and the
  drain already joins LiveCoachSession via enrichTerminalPacketWithCoachSummary; the card
  stores the summary inline + the session id as the pointer to the full transcript/says.
- Plus render data (name, caseId, uii, agent, at) and the sys-label if any.
- Reads→writes: CLIENT produces formSnapshot at the click → OUTBOX carries it → DRAIN
  enriches with the coach join → CARD stores everything → the worklist renders a complete
  call dossier with three buttons under it.

**CX-state vs case-land boundary (explicit, so the line is Mickey's to move):** CX state =
session docs, dial-queue rows, dial-cadence scheduling/counters, and (classified here as
CX-side reporting) CallLog + agent call notes — all internal dial machinery. Case-land =
anything Logics + CaseProfile. If Mickey wants CallLog/notes off the outcome path too,
that's a one-line reclassification, not a redesign.

**Flow-back (the only loop, one-way per hop):** a human action on a wrap item (DNC /
appointment / correction) writes a CORRECTION row into the terminal outbox — the existing
WO-31 lane — and the drain applies the app-side effects. Corrections are eventType-suffixed,
so wrapItemNeeded refuses them: outbox → drain → wrap → (human/auto) → outbox → drain, and
it terminates. No hop can re-trigger itself.

**Reads → writes, one line each:** drain consumes outbox rows, produces wrap ITEMS (and
app-side writes); wrap worker consumes items, produces Logics writes + correction rows;
worklist UI consumes `needsHuman` items, produces human decisions on them. Nobody else
writes the wrap queue; the wrap queue never touches the live call flow or the current slot.

## VM-TEXT (added 2026-07-06 late — Mickey: "along with voicemail they can send a text via
## the callrail api that sends their name")

**Placement (fits the layering law exactly):** a text is an EXTERIOR API call → wrap-layer
work. This adds ONE auto item kind (the purity law is untouched — SMS is not case-land):
`outcome === "voicemail"` (the VM DROP played) → drain inserts wrap item `kind: "vm-text"`
→ wrap worker sends via CallRail's Send-a-Text API with the agent's name in the template
("Hi, this is <Agent> with <brand> — just left you a voicemail about your case…").

**Number strategy — three options, researched 2026-07-06:**
- **S1 (ships first): CallRail tracking number, different from the calling number.** One
  API key the main account owns; only local US/CA tracking numbers can text (no toll-free);
  10DLC registration is required but CallRail brokers it in-product; CallRail AUTO-APPENDS
  opt-out language on the first text to a lead — compliance rails built in. The number
  mismatch is acceptable because the agent's NAME + brand carry the identity.
- **S2 (the creative unification, worth ONE test): make the RingCX campaign caller ID BE a
  CallRail tracking number.** Then the call and the text show the SAME number, and the main
  account owns every number at the CallRail level regardless of which extension dialed —
  exactly the "my account owns all of them" shape. Same pattern as the Drop Cowboy BYOC-DID
  conclusion from the RVM investigation. Gate: RingCX must accept the external ANI
  (verification/LOA), texting must stay enabled on that number. Test with one number before
  believing it.
- **S3 (RingCentral-native — UNPARKED 2026-07-06, TCR already done + the service-extension
  pattern):** HARD FACT: JWT credentials are Developer-Console-only — NO API mints or
  destroys them, so per-agent programmatic JWTs are impossible. But per-agent JWTs are only
  needed if the from-number must be each agent's extension number. INVERT: one dedicated
  service extension (sms-service@) holding a POOL of cheap texting DIDs (one user can hold
  many direct numbers), all added to the EXISTING TCR campaign, ONE JWT minted once. The
  app sends everything through that extension with a config map agentEmail → number (each
  agent keeps a consistent texting number); the agent's identity rides the message body.
  Bonus: all replies land on ONE extension → one webhook → replies become app objects,
  routed to the agent's worklist, and STOP replies feed the DNC pipeline automatically.
  Same number-mismatch trade as S1 — and composes with S2 (the service extension's DIDs can
  BE the campaign caller IDs, unifying call+text inside RingCentral under the existing TCR).
- **S4 (text-from-the-caller-ID, Mickey's true goal — the N-JWT ceremony):** a Developer
  Admin CAN mint JWTs on behalf of agents, console-only, with one prerequisite: each agent
  logs into the Developer Console ONCE (one SSO click — that adds them to the dev org),
  then the admin mints from Organization → developer → Credentials. ~5 min/agent, one-time,
  one new-hire-checklist line. No API exists (mint-and-destroy is impossible), but two
  mitigations cover the blast radius: JWTs can be RESTRICTED TO THE SMS APP at creation
  (the key can only send texts) and can carry an EXPIRY (self-destructing credentials,
  annual re-mint). REQUIREMENT for the goal: the number the prospect saw must be the
  agent's own SMS-capable RingEX direct number, TCR-attached, set as their dial caller ID.
  ~~DECISION GATE~~ **RESOLVED (Mickey, 2026-07-06): the floor already runs the jackpot
  config** — one caller ID per agent, ALL texting-enabled, each attached to that agent's
  own EX extension (callbacks ring their phone directly). Every S4 requirement is already
  true; **S4 IS THE PLAN.** Remaining steps: (1) the one-time ceremony (agent logs into the
  Dev Console once → admin mints their JWT, SMS-app-restricted + expiry → stored keyed by
  agentEmail); (2) VERIFY each agent DID is attached to the TCR campaign (numbers not on
  the campaign list get carrier-filtered silently); (3) CENTRAL STOP CAPTURE — replies land
  on agents' own phones (correct for conversations, and the continuity bonus: the prospect
  sees ONE number that calls, texts, and answers both ways) but compliance needs a central
  eye: an admin app CAN READ other extensions' message stores (the send restriction is
  send-only), so one account-level event subscription watches inbound SMS for STOP/opt-out
  → DNC pipeline. Fallback rule: missing/expired JWT for an agent → skip the vm-text with a
  loud log (fail-soft), never borrow another agent's number.

- **S5 (RingCX-native SMS — researched for fun 2026-07-06, PARKED with a purpose):** RingCX
  Digital has real outbound SMS (agent UI + Send API) and the auth model RingEX refuses to
  offer: ADMIN-MINTED act-as-agent API tokens created in the portal ("select an Agent on
  which the token will act on behalf of") — zero agent involvement, actions attributed to
  the agent. BUT it sends only from RingCX Digital channel numbers — never from the agents'
  RingEX direct numbers (the caller IDs), and inverting (SMS numbers as caller IDs) would
  route callbacks into RingCX instead of ringing the agent's phone — sacrificing the
  callback behavior. NOT the vm-text plan. WHERE IT SHINES: any text lane where number-match
  doesn't matter — appointment reminders from a branded number, the new-lead second-queue's
  inbound texting, follow-up campaigns — with supervisor-visible threading and no JWT
  ceremony. Disposition-triggering needs nothing native: the wrap worker IS the trigger and
  can call the Digital Send API like any other exterior API.

**⛔ THE "ACT-AS" CRACK IS A DEAD END — PROVEN 2026-07-06 (don't re-attempt).** The probe's
`--extension` mode established the exact platform behavior with Michael's (ext 101) JWT:
- READING another extension's SMS numbers across the account = ALLOWED with extended scope
  (that's why Michael's JWT saw ext 742's `+18182246182` flagged SmsSender).
- SENDING as another extension = HARD-BLOCKED. The `OutboundSMS ... extended scope` 403 is
  MISLEADING (per RingCentral's own forums): the permission is assignable but the platform
  STILL refuses to send from a number not directly assigned to the authenticated extension —
  even for a super admin, even with the scope granted, same in sandbox and prod. It is an
  ARCHITECTURAL constraint, not a permission you can unlock.
- **Consequence:** there is NO single-admin-JWT shortcut. To send from agent X's caller ID
  you MUST authenticate AS agent X → a JWT minted for agent X. Reading is delegable; sending
  is not. The ceremony (below) is the only RingCentral-native path. If the ceremony's
  per-agent cost is ever unacceptable, S1 (CallRail, different number, agent name carries
  identity) or S5 (RingCX-native, different number) are the fallbacks — both accept a
  number that isn't the agent's caller ID, which is the thing RingCentral won't delegate.

**S4 PILOT (built 2026-07-06 — scripts/cx-vm-text-probe.js, one agent, one JWT, one text):**
Setup, in order:
1. Dev Console → the existing app (RING_CENTRAL_CLIENT_ID) → App Settings → verify the
   **SMS permission** is on the app (add if missing — without it, auth succeeds but the
   send 403s).
2. Mint YOUR JWT: Credentials → Create JWT → restrict to this app, set an expiry.
3. `.env`: `RC_SMS_PROBE_JWT=<the jwt>` (optional `RC_SMS_PROBE_FROM=+1…` to pick a
   specific number).
4. `node scripts/cx-vm-text-probe.js` — DRY: authenticates, prints who you are and every
   number on your extension with its features, flagging the SMS-capable ones (this doubles
   as the TCR/SMS-capability audit for your own numbers).
5. `node scripts/cx-vm-text-probe.js --send --to +1YOURCELL` — sends ONE real vm-text
   (agent-name template, opt-out line included) from your caller-ID number to your own
   phone. Arrival within ~1 min = S4 proven end to end; silence = check the number's TCR
   campaign attachment (carrier filtering is silent).
The probe is standalone on purpose (the shared ringcentralClient is a singleton with
module-level auth state — a second JWT must never pollute it). Scaling S4 after the pilot =
repeat step 2 per agent + the agentEmail → {jwt, fromNumber} config map in the wrap worker.

**Compliance gates (non-negotiable, wired into the worker):** contact-eligibility check
before every send (same gate as everything else — DNC'd lead = no text, fail-closed);
inbound "STOP"/opt-out webhooks feed the DNC pipeline; VERIFY the lead-source consent
language covers SMS (web-form leads — check the landing-page terms before enabling);
one text per voicemail, deduped by the wrap item's inherited idemKey (exactly-once by
construction).

## Open questions for the owner
- ~~DNC double-home~~ ANSWERED by the purity law: DNC exists only on the card; the 2-hour
  quarantine is what makes the async window compliant (nothing can re-dial the lead before
  the card resolves).
- ~~Wrap-item expiry policy~~ ANSWERED: 2 hours, same clock as the quarantine.
- Does the worklist live in the bulk workspace only, or also the agent's home view?
- Does the 2h floor override shorter plan retries for served never-connects? (Defaulted YES
  in the quarantine rule — flag if ring-outs should recycle faster.)
