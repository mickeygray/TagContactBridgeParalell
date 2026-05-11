# CX Implementation Checklist

**Status:** merged backlog from the current code read plus the secondary review pass.

## Purpose

This document is the practical build list for the CX workspace and lead-serving system.

For the parallel split between Codex and Claude, see:

- [CX Parallel Assignments](./CX_PARALLEL_ASSIGNMENTS.md)

It is intentionally split into:

- **Now** - can and should be finished without live RingCX Voice API access
- **Later** - not blocked on RingCX, but should come after the truth-changing work
- **Blocked on CX API** - depends on RingCX credentials, admin setup, or live event surfaces

## Status Legend

- `Solid` - looks finished and exercised
- `Working but thin` - implemented end-to-end but obvious gaps remain
- `Partial` - visible holes, dead branches, or dev-only seams
- `Stub / placeholder` - declared but not really wired

## Current Read

### Workspace and lookup

- `Solid` Identity strip / lookup ladder
- `Solid` Save flow to Logics + CaseProfile mirror
- `Solid` Fresh-call reset / scramble behavior
- `Solid` Candidate dedup and tier preference

### Communications and wrap-up

- `Working but thin` SMS from workspace
- `Working but thin` Email from workspace
- `Partial` Dial-from-workspace
- `Partial` Rich wrap-up / disposition capture

### Queue and serving

- `Working but thin` Queue visibility
- `Partial` Queue semantics / claim ownership
- `Working but thin` CX availability toggle
- `Working but thin` EX-call suppression for CX eligibility
- `Partial` True multi-agent balancing and issuing loop

### Media and safety

- `Partial` Recording surfacing in workspace
- `Working but thin` Error handling exists, but mostly as toasts and happy-path fallbacks
- `Partial` Server-side domain/permission wall is thinner than the UI suggests

## Decision Gates

These are not blocked on RingCX, but they do need a product or architecture call before some of the work below can be estimated cleanly.

- [ ] Choose the tenant-authorization source of truth
  - candidates: `UserAccount.allowedDomains`, IdP/SSO claim, or explicit Logics pairing fields
  - do this before estimating server-side tenant authorization
  - recommended baseline captured in [CX Tenant Authorization Decision](./CX_TENANT_AUTH_DECISION.md)

- [ ] Choose the default queue visibility model
  - agent sees only assigned work
  - agent sees ready pool plus own claims
  - admin sees shared pool plus assignments

- [ ] Choose the default saturation cap
  - proposed starting point: `max 3 open assignments globally per agent`
  - later make this configurable

- [ ] Choose the playback data path for archived recordings
  - proposed path: `CallLog.recordingArchive.driveFileId -> /api/recordings/play/:fileId`
  - avoid leaving playback dependent on legacy `transcription.recordingUri`

## Now

These are the highest-value items that do **not** require live RingCX Voice origination.

### P0 - Make system truth explicit

- [ ] Move the left queue from "due `LeadCadence` rows" toward "served / assigned work"
  - Today the UI reads due `cx` actions directly.
  - Target: the queue reflects what 6101 has actually issued or reserved.
  - Final shape should explicitly answer whether standard agents see only their assignments or a wider pool view.

- [ ] Add a preview assignment route
  - Proposed route: `POST /api/ringcentral/cx-serving/preview-assign`
  - Input: queue item + candidate agent pool
  - Output: ranked agents, winner, and why
  - Include per-row `reasonCode` so the response can explain skips and ranking tiebreaks
  - Purpose: prove the balancing math before live call placement exists.

- [ ] Enforce server-side tenant authorization
  - Do not rely on the CX domain switcher alone.
  - The server should validate whether the authenticated user can act in the requested domain.
  - This depends on the tenant-authorization source-of-truth decision above.

- [ ] Define queue mutation rules as first-class behavior
  - State transitions should be explicit:
  - `ready -> claimed` on successful assignment
  - `claimed -> pending` on callback / reschedule
  - `claimed -> ready` on timeout
  - `claimed -> ready` on manual return-to-pool
  - `claimed -> completed/cancelled` on terminal Logics outcome
  - Add audit fields for who moved the ticket and why.

- [ ] Make disposition persistence Logics-first and measurable
  - Order of operations should be: write Logics -> read reflected Logics state -> persist queue outcome
  - callback
  - postdate
  - dnc
  - converted / sold / status-updated
  - Store queue outcome and reflected Logics status together, for example:
  - `queueOutcome`
  - `reflectedLogicsStatusId`
  - `reflectedLogicsStatusLabel`
  - `completedAt`
  - `workflowId`

- [ ] Add idempotency and race protection around `claim-next`
  - two agents should not be able to win the same ticket in parallel
  - assignment should succeed through one atomic claim path
  - failed/retried claim requests should be safe to repeat

### P1 - Finish provider-agnostic serving logic

- [ ] Finish queue-family classification
  - `fresh-day1`
  - `fresh-day2to10`
  - `aged`
  - second contacts staying in fresh where intended

- [ ] Add a real-time `openAssignments` counter
  - per-family assigned counters already exist
  - `totalAssigned` already exists
  - the missing gap is a counter that increments on claim and decrements on completion / release / timeout

- [ ] Add saturation rules
  - proposed default: skip agents who already hold `3` open assignments globally
  - preserve hot-lead fairness while still keeping everyone busy
  - make the cap configurable later if needed

- [ ] Add reassignment behavior
  - define trigger -> action -> audit result for:
  - agent paused manually
  - active EX call blocks new CX lead
  - stale claim expires
  - missed/no-touch lead returns appropriately
  - callback created from workspace
  - proposed default:
  - stale claim timeout returns to `ready`
  - callback moves to a future `pending` slot
  - EX-busy blocks new claim but does not silently destroy current assignment

- [ ] Build a debug/runtime view for serving
  - family counts
  - eligible agents
  - skipped agents
  - winning agent
  - reason codes

### P2 - Close obvious workspace gaps

- [ ] Wire the real dial action into the workspace
  - `requestCxDial` already exists
  - replace simulator-only behavior for normal operator flow

- [ ] Surface archived recordings in the workspace
  - not just legacy `transcription.recordingUri`
  - allow recent calls archived to Drive-backed storage to appear in history
  - preferred path: resolve `recordingArchive.driveFileId` into a playback endpoint or signed proxy URL

- [ ] Expand failure UX beyond generic toast errors
  - lookup failure
  - Logics update failure
  - permission failure
  - send failure
  - encryption / validation failure
  - explicit callout: if an agent tries to go `available` while EX has them busy, show that override clearly instead of silently forcing unavailable

- [ ] Add richer wrap-up input only where needed
  - keep lightweight if possible
  - but collect enough data for metrics and routing truth
  - define exactly which downstream metrics are impossible with today's callback / postdate / dnc buttons alone

- [ ] Add admin/supervisor visibility for assignment fairness
  - who got how many hot leads
  - who is paused
  - who is excluded because of EX activity

## Later

These are still worthwhile, but should come after the truth-changing items above.

- [ ] Replace polling with push where it matters most
  - workspace current-call state
  - queue updates
  - assignment changes

- [ ] Improve SSN UX
  - masking
  - reveal/hide affordance
  - safer operator feedback

- [ ] Add better permission/status signaling in the UI
  - why a domain is unavailable
  - why a mutation is disabled
  - whether the operator is in fallback/debug mode

- [ ] Add a clearer "next call" / "pull next lead" surface if that becomes the chosen operating model

- [ ] Add deeper supervisor reporting
  - fairness over time
  - queue-family throughput
  - callback/postdate aging

- [ ] Improve recording UX
  - transcript availability markers
  - playback source labels
  - partial-recording warnings for RingCentral cases

## Blocked On CX API

These should not be treated as "missing because we forgot." They depend on live RingCX Voice access or admin setup.

- [ ] Real call origination through RingCX Voice
  - manual agent call / active calls API

- [ ] Live call lifecycle synchronization
  - ringing
  - connected
  - transfer
  - hangup
  - disposition completion

- [ ] Aux state mapping from RingCX into agent eligibility

- [ ] Webhook-driven serving state changes
  - queue events
  - active-call events
  - disposition / end-of-call events

- [ ] Reliable UII / active-call correlation for live CX sessions

- [ ] Final hardened handoff between RingCX-issued work and the frontend workspace

## Suggested Build Order

1. Assignment preview route
2. Queue-family classification and balancing counters
3. Queue mutation rules
4. Idempotent `claim-next` path
5. Choose tenant-authorization source of truth, then implement server-side tenant authorization
6. Real dial button wired to `requestCxDial`
7. Admin/runtime serving debug surface
8. Recording archive surfaced in workspace
9. Richer wrap-up/disposition persistence
10. Push/live-update improvements
11. RingCX API execution layer

## Definition Of "Good Enough Before RingCX"

Before live RingCX Voice access arrives, the system should already be able to:

- classify leads into the correct queue family
- rank eligible agents deterministically
- skip paused or EX-busy agents
- show why a lead would be assigned to a given agent
- clear, reschedule, or return queue work based on Logics-driven outcomes
- let the workspace behave like the future serving UI even if call origination is still simulated or queued
