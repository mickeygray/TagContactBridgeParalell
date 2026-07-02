WO-attic-riders — Move WO-1/2/3 pending-delete blocks to the attic          STATUS: DONE
Executor: Claude Fable (big guns, per Mickey's direct request 2026-07-02)

LEDGER: 295 total / 271 pass / 24 skipped -> 273 total / 273 pass / 0 skipped / 0 fail
(expected and declared before the gate: -24 skips [three skip-gated green-first-touch test
files moved whole to the attic], +2 new WO-3 negative pins)
TYPECHECK: `npm run typecheck --workspace=web-client` -> clean

EVIDENCE:
- Method: line-range mover script (content never transits operator context; byte-exact moves)
  + boundary scanner proposing each block's extent, reviewed before every cut; cuts applied
  bottom-up per file so line numbers never shifted under pending cuts.
- Whole-file moves (5): cxGreenFirstTouchSupplyService.js (341L), cxGreenFirstTouchQueue-
  MaterializerService.js (398L) — zero live importers verified before removal (all references
  were commented) — plus the three dedicated test files (175L + 372L + 112L).
- Partial-block cuts (48 blocks across 11 files), including the adjacent-but-distinct WO-1/WO-2
  markers at runtimeService:347/348 routed to their separate attics.
- `node --check` on every touched .js -> all parse. Require sanity (barrel, runtime,
  runtimeService, watcher, route) -> require-ok.
- Full gate -> 273/273/0/0, exactly the declared ledger.
- `grep -rc "pending delete" packages apps tests` -> 0 (was ~60 marker sites).
- WO-1 kill-set grep -> remaining hits ONLY inside the inverted negative-pin tests (their
  input payloads + assertions). WO-2 set -> pin test + scripts/alpha-watch.js:26 (a log-watcher
  REGEX alternation, not a code dependency — inert, left alone). WO-3 set -> pin test + the
  stale built asset under apps/web-client/build (regenerates on next build; not source).
- `firstTouchEligible` source count: 33 before, 33 after (live policy feature untouched, rule 2a).

NEW NEGATIVE PINS (rule 2a2, required before the move):
- Route tripwire: `POST /api/cx/bulk-load/start-next` -> 410 {code:"manual-dial-disabled",
  use:"/api/cx/bulk-load/get-leads"} (apps/control-plane/src/routes/cxBulkLoad.js — the ONLY
  manual-dial remnant in the active tree).
- "WO-3 manual-dial mutator is not exported" (cxBulkLoadRuntimeService.test.js) — service,
  runtime, and barrel all assert no startCxBulkLoadNextManualCall.
- "WO-3 watcher never phone-attaches an active call" (cxAccountActiveCallWatcherService.test.js)
  — an ACTIVE call sharing a candidate's phone digits with no extern/queueItem/uii match gains
  no UII, is not promoted, produces zero session writes.

ATTIC:
- attic/green-first-touch-supply.attic.md (~1,600 lines of code moved: 2 whole services,
  3 whole test files, 15 partial blocks from repo/reservation/runtimeService/runtime/index)
- attic/adoption-path.attic.md (7 blocks: markAdoptedCandidateServing CAS, watcher external-
  candidate plumbing + adopted-serving branch, resolveExternalCandidates pass-throughs)
- attic/manual-dial-lane.attic.md (17 blocks: route, client hook + types, UI guard,
  startCxBulkLoadNextManualCall, manualDialer adapter, resolveBulkManualDialContext,
  findManualStartedActiveCall, barrel exports, both disabled dedicated tests)
Each attic file opens with the full provenance header: Retired by / Applied to / Lived at /
Replaced by / Revive (naming the exact pin tests a revival must consciously remove).

FILES (active tree): cxDialQueueRepository.js, cxQueueReservationService.js,
cxBulkLoadRuntimeService.js, cxBulkLoadRuntime.js, cxAccountActiveCallWatcherService.js,
index.js, routes/cxBulkLoad.js, queries/cxBulkLoad.ts, CXWorkspaceBulkLoad.tsx,
cxAccountActiveCallWatcherService.test.js, cxBulkLoadRuntimeService.test.js; removed:
2 service files + 3 test files (contents in attic). Net: ~700 lines of comment corpses out of
active files on top of the ~1,400 lines of moved dead code.

STOPPED/NOTED:
- scripts/alpha-watch.js:26 keeps `markAdoptedCandidateServing` inside a log-filter regex —
  observational tooling, never matches anything now; left as-is (flag for the WO-30 trace
  tranche if anyone wants the alternation trimmed).
- No service restart performed; no commits (Mickey owns both). Running NSSM services pick this
  up at next restart.
- WO-3's "one clean live loop" precondition was consciously dropped for the attic model:
  revival is one paste from the attic file and the pins guard the door; holding corpses in
  active files another day bought nothing (ruling in-session, Mickey present).

LIVE HITS:
- pending-delete markers: 0 in packages/apps/tests.
- WO-1/2/3 kill sets: 0 live hits outside pin-test assertion strings, the 410 stub, the
  alpha-watch regex, and the stale build artifact.
- firstTouchEligible: 33 (unchanged, intentional — live policy feature).
