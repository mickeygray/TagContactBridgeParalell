# CX Bulk Certification Signoff — 2026-07-08 (Fable)

Filed against `docs/CX_BULK_CERTIFICATION_GUIDE_2026-07-07.md`, using its template and
result levels. Evidence = the 07-06→07-08 proof arc (live tests, drills, pins, logs).

```text
Bulk certification result: LOCAL ALPHA CERTIFIED (exceptions named below)
Date/time: 2026-07-08 evening
Branch/build: release/0.2.0-alpha (Mickey committed 07-08; server+client rebuilt; gate 353/353; web tsc clean)
Services restarted by Mickey: ParallelRestartHelper full-stack runs 07-07 ~17:40 and ~18:00
Flags: CX_CALL_WRAP_QUEUE_ENABLED=true, CX_SYSDISPO_CLASSIFIER_ENABLED=true (live since 07-07 17:40);
       CX_FIRST_TOUCH_ENABLED=false, CX_APPT_LANE_ENABLED=false (maps present, inert)
Batch: drill-tagged synthetics (sysdispo drill, wrap seeds, lane drill preflight) + Mickey live answered-call test
RingCX lead count: per-drill (1-3 rows each, tagged, cleaned)

Gate 0 build/route: PASS — /cx renders CXWorkspaceBulkLoad unconditionally (fork collapsed
  07-07, router one-lane, VITE mode flag deleted with zero readers); bundle rebuilt after every
  client change (hash verified each time — the 07-06 stale-bundle lesson is now procedure);
  /cx/prep navbar visibility fixed by Codex's pass.
Gate 1 stack/flags: PASS — flags explicitly enumerated above; every restart Mickey's hand;
  clean boot verified after the 17:40 ceremony (health 200, drills green immediately after).
Gate 2 clean inventory: TO RUN AT FLOOR — today's runs used tagged synthetics + one live
  answered test on a fresh session. The full 10-lead clean-batch discipline is the floor
  experiment's preflight (docs/CX_FLOOR_EXPERIMENT_1_TRUNK_ACCEPTANCE_2026-07-06.md).
Gate 3 poller/current ownership: PASS — live answered test narrated DIAL→ANSWER→TERMINAL with
  extern/UII match (progression narrator); ghost policy field-proven 07-06 (CANCEL_LEADS
  receipt before dial); foreign externs ignored by design (pinned); lane externs additionally
  recognized read-only (353-gate pins).
Gate 4 terminal loop: PASS — no-answer / voicemail (VM DROP live-verified 07-06) / answered
  (live 07-07-08) all field-proven; buttons return; drain ≤1 tick; queue rows complete.
Gate 5 system disposition: PASS (small scale) — ANSWER token proven ×3 on real dials;
  classifier live; sysdispo drill 12/12 THROUGH THE LIVE DRAIN (ANSWER→card, MACHINE→no card,
  no-label→nothing invented); retry queue pinned end-to-end (defer/recover/exhaust lanes);
  drain forwards labels (row metadata + external evidence). NOT yet observed live: a real RC
  429 exercising the retry lane — pinned only. Watch cx.alpha.sysdispo.* at floor.
Gate 6 wrap queue: PASS — cards minted by the LIVE hook (canary, 3 seeds, 1 real answered
  call; fast-mint route ~1s since 07-08); all three resolutions clicked and verified: DNC
  (interview + correction drained + Logics StatusName="[Bad/Inactive]-DO NOT CALL" by external
  read), Appointment (real record + thread-key dedupe proven in the wild), Dismiss (interview
  only). Unique idemKey index VERIFIED in the live collection (idemKey_1 unique:true).
  EXCEPTION (accepted, work item): effect failures are log-only — the client cannot yet see a
  failed Logics write behind a resolved card.
Gate 7 break/availability: TO RUN AT FLOOR — no break/resume cycle was exercised in this arc.
  The guide's one-break-one-resume check joins the floor run verbatim.
Gate 8 compliance/queue safety: PASS (hardened 07-07 night) — channelDnc.cx now blocks at the
  ONE shared eligibility gate every dial path funnels through (pinned; blast radius measured:
  16 WYNN leads); appointment holds excluded on BOTH ready rails (claim-rail parity was new);
  re-ingest can no longer resurrect stopped leads or erase channel DNC; the dead replay guard
  (undeclared schema paths) fixed + schema-declaration pin. EXCEPTION (needs Mickey ruling):
  a TRANSIENT Logics check failure still cancels inventory like a confirmed block.
Gate 9 legacy containment: PASS — /start-next 410 tripwire; simple-loop + slow-single
  tombstoned 410 with the fleet regression green; legacy queue hooks constant-off; workspace
  fork collapsed to one file; delete-fleet test now part of the 353-gate.

Known exceptions accepted for this run:
  1. Gate 2 + Gate 7 are floor-run items by design (this signoff certifies the machine, the
     floor run certifies the humans-plus-machine).
  2. Wrap resolve effect statuses invisible to the client (work item, small).
  3. Wrap appointment datetime not timezone-explicit (work item, small; all agents PT today).
  4. Logics transient-vs-confirmed policy awaiting Mickey's ruling (one-line change after).
  5. Real-RC retry-lane (429) behavior pinned but not yet observed live.
Unexpected failures: none open — every live find this arc was fixed same-session (coach-summary
  object leak, createCxAppointment import, appointment early-fire pair, dead replay guard).
Evidence links/log markers: cx.alpha.sysdispo.*, cx.alpha.drain.*, cx_wrap_cards.fast_minted,
  cx.wrap_card.resolved (now incl. logicsStatusOk), drill outputs (tags in sprint memory),
  gate = node --test tests/cx-bulk-load/*.test.js → 353/353.
Next safe step: the ROAD-TO-FLOOR checklist (docs/CX_ROAD_TO_FLOOR_CHECKLIST_2026-07-08.md).
```

**Broad Alpha remains correctly blocked** per the guide until: effects surfacing lands,
tz-explicit appointment lands, the Logics-transient ruling lands, and first-touch has its
consumer (F2). The unique-index blocker is closed by verification.
