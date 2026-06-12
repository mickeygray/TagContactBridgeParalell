# Patch notes — 2026-06-12 (the big one)

Pre-patch verification: **356/357 tests pass, 0 fail, 1 deliberate skip** (see
Open items). `build:web` green behind the new build-safety tripwire.

## New surfaces

- **The Upsellerator** (`/resolution`) — resolution case bank (2,062 clients),
  per-client profile pages, document parse-and-delete uploads (THS/WIT/RT/
  Lexis), Opus pitch designer chat with verdict cards. Admin sidebar entry;
  the 7 resolution users (widget-user + `resolution.*`) land directly on it
  at login and have a sign-out in the header. Server: `/api/resolution/*` in
  control-plane, pitch agent in ai-bus (uses existing `ANTHROPIC_API_KEY`).

## Nightly close — new steps (all isolated, all env-gated)

| Step | When | Config | First-night behavior |
|---|---|---|---|
| Client-case discovery | final close pass | `CLIENT_CASE_DISCOVERY_STATUS_IDS` (unset = **skips politely**) | arm after blessing status IDs (harvest below) |
| LD spend materializer | after spend sync | `LD_SPEND_MATERIALIZER_ENABLED` (default on), `LD_SPEND_DOMAINS` (default WYNN), rates `LD_GENERAL/CUSTOM/CUSTOM_2_COST_PER_LEAD` (1.50/3/3) | writes today's LD spend; nightly email LD estimate now uses the same rates (general was hardcoded $2 — overstated) |
| Resolution bank close | AFTER all close emails | `RESOLUTION_NIGHTLY_CLOSE_ENABLED` (default on), `RESOLUTION_CLOSE_MAX_CASES` (600) | elevates new client caseProfiles + refreshes ~600 stalest bank cases (~25 min, never blocks emails) |

## Hourly

- **Unknown-type payment healer** — ledger rows stuck `paymentType:
  "unknown"` with a success-ish status jump the reconcile queue (cap
  15/domain/hr). Queue is empty today; this is a go-forward guard.

## Live coach / gRPC bridge

- **Segment cleanup** (the 75GB lesson): finalize-time removal + startup/5-min
  TTL sweep (4h retention, active streams protected) + boot-time event-log
  rotation at 128MB. Restart of `parallel-live-coach-grpc` rides this patch —
  first boot prints the `cleanup:` config line, rotates the 215MB event log,
  and runs the startup sweep. Tests: `tests/live-coach/grpcSegmentCleanup`.
- Coach window layout pass (Coach/Guidance/Interview tabs, Logics card to the
  right rail, interview Ask-pills), no-answer pacing fix (8s next-lead delay +
  8s restore debounce).

## Build safety

- `npm run build:web` now runs `scripts/check-build-safety.js` first — any
  `DO NOT COMMIT` marker in source **fails the build** with file:line.
  Local-only toggles belong in `VITE_*` env flags (`.env.local`), not code.

## Post-patch operator checklist

1. **June initials repair** (after close finishes):
   `node scripts/recalibrate-first-payments.js --csv "<PaymentsReport.csv>"`
   → eyeball the dry output → re-run with `--write`. Fixes the 5 ghost cases
   ($5,803 never synced), Ramos ($3,200 DECLINED-then-approved), counter
   drift, legacy mirror. NOTE: the legacy-db half needs `LEGACY_READ_DB_NAME`
   pointing at the real legacy db (run on the box).
2. **Tomorrow morning**: `node scripts/ensure-client-case-profiles.js
   --harvest` → bless the client status IDs (so far: 208=[TIER 3],
   209=[TIER 4], 212=[TIER 5]) → set `CLIENT_CASE_DISCOVERY_STATUS_IDS`.
3. **LD backfill**: confirm whether LD GENERAL is actually paused (it counted
   0 leads all week — paused vs routeCampaignKey not stamping), then
   `node scripts/backfill-ld-spend.js --from 2026-05-01 --to 2026-06-12`
   (dry) → review vs manual nudges → `--write`.
4. Check `finalClose.resolutionBankClose` + `ldSpendMaterializer` +
   `clientCaseDiscovery` in tonight's close result / ops log.

## Open items

- **Coach opening prompt — DECIDED unified-on-purpose** ("do everything, back
  off later"): every turn runs the navigator with the call phase stamped in
  the user payload. Test locks the unified contract; the scripted opening
  prompt is kept-but-unrouted as the documented back-off lever (one-line
  restore in `getSonnetSystemPrompt`). Watch turn-1 line quality on the
  floor tomorrow.
- **LD GENERAL zero leads** (see checklist 3).
- **No-answer permanent fix** (post-patch design): generation-fenced queue
  state (stable ticketId on every poll + disposition returns post-transition
  row + ignore older generations) — then the 8s delays drop back to 2s.
