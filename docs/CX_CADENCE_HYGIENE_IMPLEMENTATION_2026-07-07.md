# CX CADENCE HYGIENE + FIRST-TOUCH MINT — IMPLEMENTATION GUIDE (2026-07-07, executing tonight)

**Mickey's order:** "test the dialing of appointments and new leads requires work to the
cadence hygiene and tracing the lead creation back to 4001 so it mints properly...
write yourself an implementation guide citing places to update and tests to run and hop to it."

Source of truth for the findings: the 3-agent write audit (this evening). The 4001 trace:
inbound-gateway `/lead-contact`+`/api/inbound/website/lead` → `intakeLdLead`
(inboundIntakeService.js:2487) → `intakeNormalizedLead` → `upsertLeadCadence` (:1960) →
`queueCxDialRequest` (cxCadenceService.js:2022) with `requestedBy:"intake-first-contact"`,
`actionKey:"first-cx:<caseId>"` — THE MINT.

**Gate after every item:** `node --test tests/cx-bulk-load/*.test.js` (334 green at start).
Declare the delta before each run. All server-side — ships on Mickey's next restart.

---

## H1 — syncLeadCadenceState merges, never replaces (THE clobber vector)
- **Place:** packages/shared-repositories/src/leadCadenceRepository.js:857-905 — both
  branches do `doc.cadenceState = buildCadenceStateFromActions(...)`, wholesale-replacing
  the subtree; `buildCadenceStateFromActions` returns only its 10 keys and DROPS
  `dncCheck` / `bypassChannelTiming` / `optedOutChannels` — so every drain terminal with a
  pending cx action erases the federal-DNC recheck schedule (`listLeadsDueForDncRecheck`
  filters on `cadenceState.dncCheck.nextCheckAt` — the lead drops out of rechecks forever).
- **Change:** extract pure `mergeCadenceState(prior, rebuilt)` = `{ ...prior, ...rebuilt }`
  (rebuilt keys win; unowned keys survive); use it at both assignment sites. Export for pins.
  DO NOT touch the active/currentStage recompute semantics tonight (noted hazard, deeper).
- **Pin:** prior carries dncCheck/bypassChannelTiming/optedOutChannels + stale channelDnc;
  rebuilt carries the 10 keys → merged keeps all three unowned keys, rebuilt keys win,
  channelDnc comes from rebuilt (the preserve-through-recompute contract already passes it in).
- **Risk:** low — merge is strictly more preserving than replace.

## H2 — intake re-ingest upsert stops resetting machinery ($setOnInsert split)
- **Place:** packages/shared-services/src/inboundIntakeService.js:1960-2010 (the upsert
  payload) + packages/shared-repositories/src/leadCadenceRepository.js:95-108
  (`upsertLeadCadence` = findOneAndUpdate `{$set: update, upsert: true}`).
- **Change:** teach `upsertLeadCadence(domain, caseId, update, { setOnInsert })` a second
  bucket → `{ $set: update, $setOnInsert: setOnInsert }`; move the MACHINERY out of $set at
  the intake call site: `cadenceCounters`, `lastTouched`, `counterCadence`, `currentStage`,
  `firstContactRequestedAt/EventId`, `schedule`, `cadenceState`, `active`, `cadenceMode`.
  Identity/attribution/validation stay $set (they SHOULD refresh on re-ingest).
  **The compliance teeth:** re-ingest can no longer set `active:true` on a stopped lead or
  rebuild `channelDnc` empty (the audit's erase-a-DNC-block scenario).
- **Pin:** pure — export a tiny `splitLeadCadenceUpsert` (or pin the repo's built update doc):
  machinery keys land in $setOnInsert only; identity keys in $set; no key in both.
- **Risk:** medium — re-ingest behavior change (deliberate). Watch: leads that RELY on
  re-ingest to reactivate — that path is now explicit-only (correct per the audit).

## H3 — queueCxDialRequest mint-path metadata goes dotted (the two clobber $sets)
- **Place:** cxCadenceService.js — the mint/update sites inside/near queueCxDialRequest
  (audit: two `$set: { metadata: {...} }` whole-object writes on EXISTING rows; row
  CREATION with a whole metadata object is fine — it owns the doc at birth). Locate by
  `metadata: {` under an update context around :2099/:2120 (+ any in the 3100-3400 range).
- **Change:** flatten to dotted `metadata.<key>` entries (normalizeExtraQueueUpdate at
  :3833 is the in-file precedent/helper).
- **Pin:** if the site is reachable via an exported fn, pin the built update doc contains
  no bare `metadata` key; else document + rely on the schema-declaration-guard pattern.
- **Risk:** low — mechanical flattening.

## H4 — buildBlockedReason learns channelDnc.cx (closes the federal-DNC dial-time hole)
- **Place:** packages/shared-services/src/contactEligibilityService.js:39-148
  (buildBlockedReason — never reads `cadenceState.channelDnc`); reader helper
  `evaluateChannelDnc` exists at leadCadenceRepository.js:1480-1487.
- **Change:** one check alongside the stage-signal block: channelDnc.cx blocked →
  `{ blocked: true, reason: "channel-dnc-cx" }`. Every dial gate funnels through this fn
  (queue build :3054, bulk publish via cxBulkLoadRuntime:1401, legacy claim :3535,
  dialService:1297, watcher rescue :1072) — one edit, all gates.
  **This is also the landing pad for the wrap-click direct DNC write** (targeted $set of
  `cadenceState.channelDnc.cx`, never markChannelDnc's hydrated save) — wiring the wrap
  click itself is NOT tonight (behavior sequencing with the floor), the reader is.
- **Preflight:** read-only count of leads currently carrying channelDnc.cx.blocked=true
  per domain — the blast radius IS those leads becoming un-dialable (correct, but count first).
- **Pin:** buildBlockedReason with a cadence carrying channelDnc.cx.{blocked:true} → blocked
  with the new reason; without it → unchanged verdicts.
- **Risk:** deliberate behavior change, compliance-positive. The count bounds the surprise.

## H5 — legacy claim rail gets exclusion parity + the (inert) lane-flag exclusions
- **Place:** packages/shared-repositories/src/cxDialQueueRepository.js:86-123
  (buildReadyClaimQuery — excludes NOTHING; the appointment pin at
  cxAppointmentService.js:309-323 exists to paper over exactly this) and :69-84
  (buildReadyReservationQuery — has the `metadata.appointmentId` template line).
- **Change:** add to BOTH queries: `"metadata.appointmentId": { $in: [null, ""] }` (claim
  query only — reservation already has it), `"metadata.firstTouchPending": { $ne: true }`,
  `"metadata.appointmentPending": { $in: [null, false] }` (object flag → $in, not $ne).
  All inert today (nothing stamps them); they become live the moment the stamps land.
- **Pin:** query-shape pins on both builders (exported or via targeted export).
- **Risk:** near-zero (inert terms; appointmentId parity matches the reservation rail's
  existing behavior).

## H6 — appointment lead-stamp hygiene: clear payloadSnapshot.cxAppointment on resolution
- **Place:** packages/shared-services/src/cxAppointmentService.js —
  `upsertLeadAppointmentHold` stamps `payloadSnapshot.cxAppointment` (:371-383);
  `resolveCxAppointmentAfterDisposition` (:1149-1156) and `releaseCxAppointment`
  (:631-648) clear queue metadata + the CxAppointment doc but never the lead stamp.
- **Change:** targeted `$set { "payloadSnapshot.cxAppointment": null }` in both clears.
- **Pin:** if the clear path is exported-callable offline, pin the update doc; else assert
  via the service's _test surface or document.
- **Risk:** low.

## F0-SLICE — the first-touch mint stamp (flag-gated, default OFF)
- **Place:** cxCadenceService.js queueCxDialRequest (:2022+) — the intake mint arrives with
  `requestedBy: "intake-first-contact"` / `actionKey: "first-cx:<caseId>"`
  (inboundIntakeService.js:2411-2425).
- **Change:** pure `deriveFirstTouchStamp({ requestedBy, actionKey }, { enabled })` →
  `{ "metadata.firstTouchPending": true }` or `{}`; enabled =
  `CX_FIRST_TOUCH_ENABLED === "true"` (default off). Apply at the row mint. Export for pins.
- **Pin:** decision matrix (intake-first-contact + flag on → stamp; flag off → never;
  non-intake mints → never) + the H5 exclusion pins prove stamped rows are invisible to
  both rails.
- **Risk:** zero while the flag is off; with it on, stamped rows are excluded from bulk
  BEFORE the cxft lane can serve them — so the flag STAYS OFF until F2/F3 land. The stamp
  is "mints properly"; the lane is next.

## TESTS TO RUN (the full sweep, in order)
1. Per-item: the new pins + `node --test tests/cx-bulk-load/*.test.js`.
2. End of run: the full gate + `npx tsc --noEmit` in apps/web-client (untouched, but cheap).
3. Read-only H4 preflight count (before the H4 patch lands in a restart).
4. NOT run tonight: live restart (Mickey's act; these ship with the next helper run).
