# WYNN Lead-Delivery Cutover Note — 2026-07-24

**Status: code landed, WYNN seat DISABLED. Nothing changes at runtime until the
operator completes the checklist below and restarts control-plane.**

## What changed

The PhoneBurner lead-delivery path now supports per-seat **domain scoping**.
Each agent in `config/lead-delivery-agents.json` may carry a `domains`
allowlist (company keys: TAG / WYNN / AMITY). A seat with no `domains` field
serves every domain (the old behavior); a scoped seat only ever receives items
whose `LeadDeliveryItem.domain` is in its list.

Scoping is enforced at every item→seat matching point:

| Matching point | Where |
|---|---|
| Packet candidates (preview/recipe, top-of-queue refill, aged cushion) | `leadDeliveryRepository.listPacketCandidateItems` gained an optional `domains` filter; all three call sites pass the seat's domains |
| Morning first-contact barrier | `hasUnconsumedOvernightFirstContact` is scoped to the requesting seat's domains — parked WYNN overnight items can no longer freeze TAG seats out of the aged pool |
| Fresh fair-pick reservation | `reserveFreshWork` skips a candidate with no serving seat (`continue`, not `break` — a WYNN fresh lead cannot stall TAG reservations) |
| Immediate fresh dispatch | takes the first *servable* candidate instead of stalling on an unservable head item |
| Productivity redistribution | per-item target filtering; unservable items are recorded as `no-domain-eligible-target` and skipped |

The config file now sets `"domains": ["TAG"]` on the five floor seats and adds
a **disabled** `bruce_allen_wynn` seat (`ballen@wynntaxsolutions.com`,
`domains: ["WYNN"]`, folder IDs blank).

Also: `policyForDomain` in control-plane now honors per-domain Logics status
env overrides — `LOGICS_PROSPECT_STATUS_IDS_WYNN` / `LOGICS_DNC_STATUS_IDS_WYNN`
(comma-separated IDs). Unset → the global lists apply, exactly as before.

## Immediate effect after the next control-plane restart (no other action)

- TAG seats stop pulling WYNN/AMITY cadence rows. WYNN items still ingest and
  sit in the pools unclaimed until a WYNN seat is enabled.
- WYNN items already reserved for a TAG seat are no longer packetable by that
  seat; the reservation expires and the item returns to the pool (self-healing).
- WYNN items already **delivered** (PhoneBurner contact exists) stay with their
  seat; callbacks resolve by provider identity and outcomes write back to the
  WYNN Logics tenant keyed by `item.domain`, as they do today.

## Checklist to enable the Wynn seat (ordered)

1. **[PhoneBurner]** In the (shared) PhoneBurner org, create the Wynn seat's
   distribution + receiving folders; note both folder IDs. If Bruce dials from
   his own PhoneBurner login, note his member ID as well.
2. **[DATA]** Ensure a `UserAccount` exists with email
   `ballen@wynntaxsolutions.com` — call/appointment attribution resolves the
   seat via `applicationAccountEmail` → `findUserAccountByEmail`.
3. **[CONFIG]** In `config/lead-delivery-agents.json` → `bruce_allen_wynn`:
   fill `distributionFolderId`, `receivingFolderId` (must be unique across all
   seats), optionally `phoneBurnerMemberId`, then set `"enabled": true`.
4. **[ENV — optional]** If Wynn's Logics tenant uses different prospect/DNC
   status IDs than the global lists, set `LOGICS_PROSPECT_STATUS_IDS_WYNN` /
   `LOGICS_DNC_STATUS_IDS_WYNN`.
5. **[RESTART — operator's call, live box]** Restart control-plane so the
   config loads. The webhook agent allowlist picks the seat up automatically.
6. **[VERIFY]** `node scripts/validate-phoneburner-lead-delivery-folders.js
   --agent bruce_allen_wynn` (reads folder counts), then watch
   `phoneburner-floor-status` for the seat's buffer filling with WYNN items.

## Open decisions / flags

- **Same PhoneBurner org assumed.** The delivery runtime holds ONE PhoneBurner
  OAuth credential (keyed by `PARALLEL_SERVICE_EMAIL`, default
  `service@taxadvocategroup.com`). Wynn seats must be folders/members of that
  org. A separate Wynn PhoneBurner account would need a second credential
  store + per-domain client wiring — deliberately not built here.
- **DNC actor email** for WYNN Logics writes is still the TAG-default service
  email unless `PARALLEL_SERVICE_EMAIL` policy says otherwise.
- Curator folders (callbacks / expired) are shared across domains — Wynn
  callbacks land in the same curator folders as TAG.
- `LEAD_DELIVERY_*` env flags are untouched by this change (see
  `docs/CX_BULK_ROUTE_REFEED_NOTE_2026-07-22.md` for that landscape).
