# CX APPOINTMENT LANE — DESIGN SKETCH (2026-07-07)

**The ruling (Mickey, mid-answer-test):** "we can create a new campaign if it's cleaner —
basically Brad Appointment etc. — so every agent serves each type of lead from a discrete
place. A Lead Cadence is marked as appointment-scheduled, which generates a CxApt key
consumed by the appointment queue, sent at the moment of the call."

Architecture delegated to Fable. This sketch is executor-grade at the shape level;
line-level specs land when the build is gated in (after first-touch F0-F6 — see §6).

---

## 1) THE INSIGHT: this is the THIRD instance of one shape — build a LANE REGISTRY

| lane            | extern prefix | mark on the cadence            | discrete place (RingCX)        | dispatch trigger            | consumption (exactly-once)       |
|-----------------|--------------|--------------------------------|--------------------------------|-----------------------------|----------------------------------|
| bulk families   | `cxbl-`      | family reservation             | the bulk campaign              | agent fetch/dial            | terminal → outbox → drain        |
| first touch     | `cxft-`      | `metadata.firstTouchPending`   | "CX \<Agent\> First Touch"     | mint drip + 07:45 build     | drain CAS on the cxft terminal   |
| **appointments**| `cxapt-`     | `metadata.appointmentPending`  | "\<Agent\> Appointments"       | **the clock: appointmentAt**| drain CAS on the cxapt terminal  |

Every lane is: *a mark that takes the lead out of general circulation → a discrete
per-agent serving place → a dispatch trigger → drain-side exactly-once consumption that
releases the mark.* The differences are configuration, not machinery.

**AMENDMENT TO THE FIRST-TOUCH PLAN (F0):** build the F0 pures lane-generic from day one —
an extern-lane registry (`{prefix, markField, mintKey, releaseOnTerminal}`) instead of
cxft-hardcoded helpers. Appointments then cost a registry entry + one dispatcher, not a
third spine. (One table; the guard against reinventing shapes.)

---

## 2) THE APPOINTMENT LANE, END TO END

### Mint (booking)
- Sources: the wrap-card **[Appointment]** button (primary — proven live today) and the
  M3 live-call modal (unchanged).
- Booking writes, atomically-ish (order matters, each idempotent):
  1. `CxAppointment` row — gains `cxAptKey: "cxapt-<apptId>"` (THE key: RingCX extern ↔
     appointment ↔ case in one string), `status: "scheduled"`.
  2. QUEUE-ROW stamp: `CxDialQueue metadata.appointmentPending = { cxAptKey, at, agentEmail }`.
     This **is** the hold-until-appointment — a structural exclusion, not date math
     (same law as firstTouchPending: no windows, no bleed, released on consumption).
     **AUDIT CORRECTION (2026-07-07): the flag lives on the QUEUE ROW, not LeadCadence.**
     The 3-agent write audit proved a LeadCadence `metadata.*` write is a SILENT NO-OP
     (the schema declares no metadata path; strict mode strips the $set — empirically
     verified), while CxDialQueue.metadata is Mixed and schema-ready today, and the F1
     exclusion reader (buildReadyReservationQuery, cxDialQueueRepository.js:69-84 — the
     `metadata.appointmentId` line is the exact template) reads queue rows anyway. Any
     future lead-LEVEL flag requires a LeadCadence schema declaration first (see the
     dead-replay-guard incident: undeclared paths strip silently).
- The stamp excludes the lead from EVERY other pool: family reservation, first-touch,
  morning builds (one query filter, same site as F1's).

### The discrete place
- **Recommendation: ONE dedicated RingCX campaign ("CX Appointments") with per-agent
  queues** ("Brad Appointments", …) — mirroring the first-touch topology. Why a campaign
  over more queues inside the bulk campaign:
  - separate dial settings (appointments may want different pass/AutoDispo behavior);
  - stats and attribution stay clean per lead-type (kept-rate per agent falls out);
  - the watcher/sys-dispo lookups scope by campaignId — no cross-lane probe pollution;
  - it is literally what "serves each type of lead from a discrete place" means.
- Mickey's console act: create the campaign + per-agent queues once (like first touch).

### Dispatch — "sent at the moment of the call"
- A control-plane tick lane (rides an existing scheduler tick) scans
  `CxAppointment { status: "scheduled", at <= now + LEAD_TIME }`:
  - publish the lead to the OWNING AGENT's appointment queue with IMMEDIATE priority,
    extern = the cxAptKey;
  - CAS `status: scheduled → dispatched` (the CAS is the exactly-once for dispatch;
    a crashed tick re-dispatches idempotently — same extern, RingCX dedupes the copy);
  - trace `cx.alpha.appt.dispatched`.
- `LEAD_TIME` = env knob (`CX_APPT_DISPATCH_LEAD_MS`, default 0 — AT the moment).
- Agent offline at the moment: dispatch anyway — the queue IS the discrete place and
  holds until the agent is available; an M2-style alert nudges. (No hold-and-reassign
  machinery in v1; a missed appointment has a policy below.)

### Serving
- The watcher learns `cxapt-*` extern recognition — the SAME work item as cxft
  recognition (today non-cxbl externs are filtered; the lane registry makes this one
  membership check).
- The call rides the EXISTING trunk unchanged: latch, terminal, sys-dispo classifier,
  retry queue, drain. The workspace identifies the case by extern match (the cxft/WO-16
  UI work covers both lanes).

### Consumption (the drain, single Mongo writer — layering law)
- The cxapt terminal arrives at the drain like any other; the consumption handler:
  - CAS-release `metadata.appointmentPending` (any outcome = consumed; no bleed);
  - stamp the appointment by the VERDICT: outcome answered → `status: "kept"`;
    anything else → `status: "missed"` (+ the sys-dispo label rides for forensics);
  - counters/attribution ride the same serialized write (kept/missed per agent).
- An ANSWERED appointment call mints a wrap card like any other answered call — the
  agent can re-book or DNC from the same bar. One trunk, no special cases.

### Miss policy (deliberately minimal — the 24-retries lesson)
- Missed → appointment marked `missed`, stamp released, an appointment-missed activity
  files, and the lead re-enters normal circulation after the standard 2h quarantine.
- NO auto-retry loop. Re-booking is a human act (the panel shows the miss; M2 alert
  optional later).

---

## 3) READS → WRITES LEDGER (per component)

| component            | reads                                              | writes                                                                 |
|----------------------|----------------------------------------------------|------------------------------------------------------------------------|
| booking (wrap/M3)    | card/case identity                                 | CxAppointment{cxAptKey, at, agentEmail, caseId, queueItemId, status:scheduled}; cadence `metadata.appointmentPending{cxAptKey, at, agentEmail}` |
| reservation filters  | `metadata.appointmentPending` (exclusion)          | — (read-only exclusion, one query filter)                              |
| dispatcher tick      | CxAppointment{scheduled, at<=now+lead}             | RingCX publish (extern=cxAptKey, IMMEDIATE); CxAppointment CAS→dispatched; trace |
| watcher              | active calls w/ cxapt-* extern (lane registry)     | session serving state (existing trunk paths)                            |
| drain (consumption)  | cxapt terminal outbox rows                         | cadence stamp CAS-release; CxAppointment→kept/missed (+sys label); counters |
| wrap cards           | answered cxapt terminals (existing trigger)        | cards (existing pipeline, zero new code)                                |
| appointments panel   | CxAppointment (scheduled/due/fired/kept/missed)    | — (SharedAppointmentList already renders status states)                 |

---

## 4) WHAT ALREADY EXISTS (make-explicit, don't rebuild)

- `CxAppointment` + `createCxAppointment` (proven live today via the wrap card).
- The wrap-card [Appointment] mint + datetime picker.
- SharedAppointmentList with scheduled/due/fired/blocked states + onCallNow (survives as
  the manual fallback lane).
- The whole terminal spine: sys-dispo, retry queue, drain, cards — untouched.
- First-touch F0-F6 primitives (extern recognition, exclusion filter, drain CAS,
  per-agent queue publish) — the 80% shared machinery.

## 5) NEW CODE, HONESTLY SCOPED

1. Lane registry (F0 amendment — generalize, near-zero marginal cost).
2. `cxAptKey` mint on CxAppointment + the cadence stamp write at booking.
3. The exclusion filter term (one line at the F1 site).
4. The dispatcher tick lane (~1 file + config).
5. The consumption handler entry (kept/missed stamping in the drain's lane switch).
6. Per-agent queue config map (agentEmail → RingCX appointment queue id), like first touch.

## 6) GATING + SEQUENCE

- **Gated behind first-touch F0-F6** (shared primitives; do NOT build twice).
- Order: F0 amendment (registry) → first-touch lands and soaks → appointment lane =
  registry entry + booking stamp + dispatcher + consumption entry.
- Mickey's acts: create the campaign + per-agent queues in the RingCX console; supply the
  queue-id map; flag flip (`CX_APPT_LANE_ENABLED`, default off).
- Open questions parked (not blockers): coach on appointment calls (default: same as any
  call); reassignment of a missed appointment to another agent (v2); kept-rate metrics
  surfacing (DAINTY — the metrics panel rule).
