# ROAD TO FLOOR — THE CHECKLIST (Fable, 2026-07-08)

From here to floor tests, in order. Each item names its owner and its proof. The delete
items are sequenced against `CX_LEGACY_HANGOVER_DELETE_LEDGER_2026-07-07.md` triggers —
two of which today's live proofs already met.

## PHASE 1 — lock the tree (tonight/tomorrow morning)

- [ ] **1. Commit.** (Mickey) The post-commit work since this morning's commit: cadence
      hygiene H1-H6, F0 stamp, both lane dispatchers, lane registry + modal, the lane
      drill + experiment docs, cert signoff. One checkpoint before any more cutting.
- [ ] **2. One formal `node scripts/cx-wrap-drill.js --arm` run.** (Mickey, 2 min)
      Everything it proves has been proven piecemeal — this puts ledger #4's exact
      trigger line ("cards minted by the LIVE drain hook", non-deduped interview) on the
      record. ⚠ It really sets case 101617 to DNC again — revert after, as before.
- [ ] **3. Revert case 101617's Logics status** if still DNC from Morgan's test. (Mickey)

## PHASE 2 — the unblocked cuts (Fable, small, before floor)

- [ ] **4. Cut the live-dialer DNC button** (ledger #6 — trigger MET by Morgan's card:
      interview + correction drained + external Logics status read). The floor should
      learn wrap-card-only muscle memory from day one. Client cut + rebuild; the live row
      keeps Answered / No answer / Voicemail only. No agent-facing Skip. Backend dnc handling stays (wrap
      cards use it).
- [ ] **5. sync-indexes allowlist + CxCallWrapCard.** Belt for fresh environments; the
      live index is verified. One-line list addition.
- [ ] **6. Wrap picker goes timezone-explicit** (cert blocker #6): send appointmentDate /
      appointmentTime / appointmentTimezone from the card instead of a bare datetime-local
      string. Small; early-fire-adjacent; agents book from this daily.
- [ ] **7. Resolve route returns effect statuses + the client surfaces failures** (cert
      blocker #5): today a failed Logics write hides behind a resolved card, log-only.
      Route change is trivial (the service already returns `effects`); client shows a
      red toast naming the failed effect.

## PHASE 3 — the one ruling (Mickey, then Fable's one-liner)

- [ ] **8. Logics transient-vs-confirmed policy** (cert blocker #2): today a Logics
      OUTAGE during an eligibility check cancels queue inventory exactly like a confirmed
      DNC status. Options: (a) keep fail-closed (compliance-max, inventory pays for
      outages), (b) transient failures block the SINGLE dial but never cancel rows
      (recommended: visible + non-destructive), (c) per-lane policy. One line each after
      the ruling.

## PHASE 4 — deliberately NOT before floor (defer, with reasons)

- **Ledger #4 cut (legacy drain-side auto-summary fallback):** trigger substantively met,
  but the fallback IS the flag-off parachute — keep it through the first floor week so
  flipping `CX_CALL_WRAP_QUEUE_ENABLED` off remains a safe rollback. Cut after floor
  acceptance.
- **Cut-map §3 (legacy queue auto-serve client slab, the biggest cut):** post-floor. It
  removes the stale-served-queue recovery including the name-vanish guard — good riddance,
  but not the week the floor is learning the surface.
- **WO-28 (EX presence ownership) + cut-map G:** post-floor, per its own trigger.
- **F2 consumption + loader windows + threshold rebuild + M2 popup:** the lane build
  continues on its own track; lane flags stay OFF on the floor (except the Mickey-only
  interrupt test, which has its own doc and its own containment).

## PHASE 4b — LIVE-BOX DEPLOY GATE (whenever this tree ships to the Ubuntu box)

- [ ] **Set `CX_CALL_WRAP_QUEUE_ENABLED=true` in `/opt/tagcontactbridge-parallel/.env`
      BEFORE the deploy restart.** Verified 2026-07-08 (read-only SSH check during the
      UI-restructure review): the live box .env does NOT carry the flag, so it resolves
      to the false default. With the live DNC button cut (ledger #6) and lane DNC
      deliberately deflected to the wrap path, a flag-off live box would have **zero DNC
      affordance anywhere in the workspace** while cadence keeps dialing — a compliance
      hole, not a degraded mode. Same check for `CX_SYSDISPO_CLASSIFIER_ENABLED=true`
      (the wrap queue's upstream). Local alpha already runs both true; this is purely a
      deploy-day parity step.

## PHASE 5 — the floor runs (Mickey + agents)

> **EXPANDED**: the per-agent execution plan (Sean first, wave-by-wave, preflight
> traps, observation station, pilot report tooling) lives in
> `docs/CX_FLOOR_ROLLOUT_USER_BY_USER_2026-07-08.md`. Items 9-12 below are satisfied
> inside its Wave 1.

- [ ] **9. Floor Experiment 1** (docs/CX_FLOOR_EXPERIMENT_1_TRUNK_ACCEPTANCE_2026-07-06.md)
      — preflight now includes the workspace-fork lesson + fresh bundle check. E2 wrap-hold
      and E7 rescue-answer remain the money rows.
- [ ] **10. The cert guide's minimum drill** rides the same session (10-lead batch, three
      outcomes, one DNC card + one appointment card) — it closes **Gate 2** and, with one
      break/resume cycle observed, **Gate 7**. That upgrades the signoff from
      "local alpha certified w/ floor items" to fully signed.
- [ ] **11. The Mickey-only lane interrupt test** (docs/CX_LANE_EXPERIMENT_1_INTERRUPT_2026-07-08.md)
      — independent of the floor run; needs your two test campaigns; Mickey-only maps;
      flags flipped back off after.
- [ ] **12. File the signoff** — fill Gates 2/7 into
      docs/CX_BULK_CERTIFICATION_SIGNOFF_2026-07-08.md, record exceptions, done.

## THE INVARIANTS (unchanged by anything above)

- Gate after every change: `node --test tests/cx-bulk-load/*.test.js` (353 now) + the
  delete-fleet test after any cut + web tsc/build for client changes.
- Mickey owns commits and restarts. Tombstone before delete. `get-leads` survives.
- Lane flags OFF outside the contained test. First-touch stamp stays flagless-off until
  F2 exists (cert blocker #7 — correct as written).
