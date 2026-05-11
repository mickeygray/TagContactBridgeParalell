# CX Implementation Plan — Refined 2026-04-24

**Status:** Foundation to build. The earlier draft (below under "Prior draft") conflated **RC EX RingOut** (basic telephony) with **RingCX Contact Center** — they are two different RingCentral products with different APIs, different auth, and different event models. This refinement fixes that and lays out a four-phase plan.

## What we actually need to integrate with

**Product:** RingCX Voice Contact Center (aka Engage Voice). Distinct from:
- RC EX telephony (what `ringcentralClient.js` already talks to — extensions, presence, subscriptions)
- RingCX Digital (separate product for chat/email/social — has its own API)

**Base URL:** `https://ringcx.ringcentral.com/voice/api/v1` (legacy hosts `portal.vacd.biz` / `portal.virtualacd.biz` still respond).

**Auth:** Separate from RC EX. `POST /api/auth/login` → Bearer token. Different credentials entirely; you can't reuse the RC EX JWT.

**Event delivery:** Webhook-based. **UI-only registration** — there's no API to register/renew webhooks, admin does it in RingCX's `Dev tools > Web services`. No signature verification documented — we'll need a shared-secret URL param or header configured in the webhook UI. 24h retry window; must return HTTP 200.

## Confirmed endpoints (verified from developers.ringcentral.com/engage)

### Click-to-dial
- `POST /admin/accounts/{accountId}/activeCalls/createManualAgentCall`
- Body: `{ username, destination, ringDuration?, callerId? }`
- Returns `uii` (unique interaction identifier) — we must capture this to correlate with downstream events.

### Active call management (needs `uii` from above)
- `POST /activeCalls/{uii}/dispositionCall` — set disposition + release agent from post-call wrap-up. Supports callback scheduling inline.
- `POST /activeCalls/{uii}/hangupCall` — terminate.
- `POST /activeCalls/{uii}/hangupSession` — remove a third party without dropping the call.
- `GET /activeCalls/list?productType=AGENT|OUTBOUND|ACD&productId=...` — enumerate with uii's.

### Agent directory + state enumeration
- `GET /admin/accounts/{accountId}/auxStates/?activeOnly=true` — returns the tenant's configured agent states with `stateId` + `baseAgentState.colKey`. **Do not hardcode disposition labels in CXWorkspace.tsx — pull from here.**
- `GET /admin/accounts/{accountId}/agentGroups/{agentGroupId}/agents` — agent list with ids.
- `GET /admin/accounts/{accountId}/ringcentral/extensions` — the RC EX extension ↔ RingCX agent mapping (crucial for operator identity).
- **Not documented in the voice guide:** an endpoint to programmatically SET agent state. It may exist in WFM; confirm with RC support or test an observed agent to see if aux-state transitions come through as webhook events.

## Where the existing codebase stands

- `UserAccount.cxAgentId` — already present, indexed. But RingCX's `createManualAgentCall` takes a **username**, not an ID. Need to confirm whether `cxAgentId == RingCX username`, or add `ringcxUsername` alongside.
- `AgentState.cxAgentId` + `AgentState.cxRouting` — already present on the model. `cxRouting.desiredAvailability` is the right shape for managing state.
- `cxWorkspaceService.requestCxDial` — writes a `ReviewQueueItem` with `executionOwner: "ringcentral-cx"`. **Nothing consumes it today.** This was the original doc's motivation.
- No `ringcxClient.js` in `shared-integrations/src`. Has to be built.
- No `uii` / `ringcxCallId` on `CallLog`. Has to be added to correlate RingCX events back.

## Four-phase plan

### Phase 1 — Foundation (blocks everything)

1. **`ringcxClient.js`** in `packages/shared-integrations/src/`:
   - Bearer-token auth against `/api/auth/login`.
   - Token refresh (RingCX tokens expire; need the same `setRefreshCallback` pattern we have on RC EX).
   - Method surface: `createManualAgentCall`, `dispositionCall`, `hangupCall`, `listActiveCalls`, `listAgents`, `listAuxStates`.
   - Per-domain client (TAG vs WYNN may have distinct RingCX tenants).

2. **Config** in `shared-config/ringCentralConfig.js` (or new `ringcxConfig.js`):
   - `RINGCX_API_BASE_URL` (default `https://ringcx.ringcentral.com/voice/api/v1`)
   - Per-company: `TAG_RINGCX_ACCOUNT_ID`, `TAG_RINGCX_API_USERNAME`, `TAG_RINGCX_API_PASSWORD` (or OAuth client creds), `WYNN_*` equivalents.
   - `RINGCX_WEBHOOK_SHARED_SECRET` — since RingCX doesn't sign webhooks, we gate the endpoint by a secret in the URL or header configured at the RingCX admin side.

3. **Schema touch**:
   - `UserAccount.ringcxUsername` (String, default null). Backfill via `GET /ringcentral/extensions` join keyed on `extensionId`.
   - `CallLog.uii` (String, default null, sparse index). Allows us to tie RingCX events to our CallLog rows.
   - `CallLog.ringcxDispositionId` + `CallLog.ringcxDispositionAt`.

4. **auxStates cache**: boot `ringcentral-cx` service loads the tenant's aux-state list; refresh hourly alongside the subscription watchdog. Exposed via `GET /api/ringcentral/cx/dispositions` for the frontend.

### Phase 2 — Command consumer (fulfills the original doc's core)

Worker on 6101 (`ringcentral-cx`) — **inline**, not a separate process, so it shares the RingCX session + token refresh with the inbound event handler.

Loop: claim `ReviewQueueItem` where `executionOwner: "ringcentral-cx", status: "open"` sorted by `happenedAt: 1`, atomic `findOneAndUpdate` to flip `status: "in-progress"` + `claimedAt`.

Dispatch by `category`:

| category | action |
|---|---|
| `cx-text` | Existing `outboundDispatchService` path — **does NOT go through RingCX**. RingCX Voice isn't for SMS; CallRail is. Keep this on CallRail. |
| `cx-email` | Existing `requestCxEmail` render + SendGrid send. Not RingCX. |
| `cx-dial` | **`ringcxClient.createManualAgentCall({ username: userAccount.ringcxUsername, destination: phone })`** — capture `uii` in result. Fail-fast if `ringcxUsername` is null (surface in review item). |
| `cx-disposition` *(new, wasn't in original doc)* | `ringcxClient.dispositionCall(uii, { stateId, callback? })`. Pull `stateId` from cached aux-states. |
| `cx-hangup` *(new)* | `ringcxClient.hangupCall(uii)`. |
| `cx-status` | Unchanged — Logics facade. |
| `cx-source` | Unchanged — SourceCanonical write. |
| `cx-dnc` | Unchanged — `contactEligibilityService.stopCaseContact`. |

On success: mark review item `closed` + `resolution: "completed"` + emit `WorkflowRecord { family: "cx-command", stage: "completed" }` with `uii` in payload.

On failure: standard retry-then-dead-letter via the hourly-job system (reuse existing `emitHourlyJobEvent` + `retryCxLogicsAction`-style handler naming — e.g., `retryCxDial`, `retryCxDisposition`).

### Phase 3 — Inbound events (webhook pipe)

1. **Ops setup (manual):** in RingCX admin UI → Dev tools → Web services → create an endpoint pointing at `https://<parallel-public-url>/webhook/ringcx/voice/events?secret=<RINGCX_WEBHOOK_SHARED_SECRET>`. Subscribe to all available voice events.

2. **Handler** on 6101: `POST /webhook/ringcx/voice/events`:
   - Gate: require `secret` query param matches env (RingCX doesn't sign, so this is our integrity check).
   - Parse the event envelope (shape TBD once we see a real payload; agent-termination is the main documented event).
   - Match on `uii` against `CallLog` — update disposition / end time.
   - If uii doesn't exist yet (rare ordering), create a stub CallLog row and let the attribution resolver fill in the rest.
   - Stamp `recordRingcentralEvent("ringcx.voice.event")` for liveness tracking (distinct from EX events).

3. **No subscription renewal loop** — RingCX webhooks are statically registered. The **only** liveness signal is our silence detector. Extend `ringcentralSubscriptionWatchdogService` to track RingCX events separately: `ringcxLastEventAt`, `ringcxSilentForMs`. Alert threshold looser (RingCX volume depends on call traffic; maybe 2h silence during business hours).

### Phase 4 — UI refinements (after Phases 1–3 are solid)

1. **`CXWorkspace.tsx` dial button**: optimistic "placing call…" state, wait on the command's `uii` return, flip to "on call with [destination]" when present. Already has the disposition enum hardcoded — swap to the cached auxStates list.

2. **Active-call panel** (new): shows the current agent's active uii's from `GET /activeCalls/list?productType=AGENT&productId=<ringcxUsername>` polled every 5s. Hangup + disposition buttons dispatch to the consumer.

3. **Callback scheduling**: when operator selects "Callback" disposition, a date+time picker fires a `cx-disposition` command with callback payload. RingCX handles the actual scheduling.

4. **Agent state dock** (optional): widget showing the logged-in operator's current RingCX state with toggle. Blocked until we confirm the set-state endpoint exists.

## Questions I need answered before Phase 1

1. **Is RingCX Voice or RingCX Digital the target?** I wrote this for Voice. If Digital (chat/email routing), the client + endpoints are different.
2. **Tenant layout:** one RingCX account shared between TAG + WYNN, or separate? (RC EX is one shared tenant — but RingCX billing is sometimes split.)
3. **Credentials source:** RingCX user/pass or OAuth app client credentials? Who has them?
4. **Agent username convention:** does each operator have a RingCX username that matches their email? Or is it a separate identifier (like their extension number)?
5. **Existing prod footprint:** is RingCX already configured and posting events to the v2 app today? If yes, cutover plan = re-register webhook URL + disable v2's listener at the same time.
6. **Disposition vocabulary:** any fixed list of disposition codes ops cares about, or are we pulling entirely from the tenant's `auxStates` config?

## Things the original draft got right (keep)

- Claim-queue pattern with atomic `findOneAndUpdate`.
- `status: open → in-progress → closed/error` transitions.
- `ReviewQueueItem` as the queue mechanism (already shipped and consistent with the rest of the system).
- Ack path via `GET /api/read/review-queue?workflow=cx-command&...` for the frontend.
- Fail-fast on missing agent pairing.

## Things the original draft got wrong

- **`cx-dial` via `ringcentralClient.createRingOut`** — that's RC EX, not RingCX. Replace with `ringcxClient.createManualAgentCall`.
- **Assumed single API client** — we need a second one with its own auth, refresh, and token state.
- **No uii correlation path** — without it, inbound events can't be tied to commands we dispatched.
- **No disposition / hangup / active-calls management** — these are core CC workflows, not optional.
- **No mention that webhook registration is UI-only** — this is a gotcha that'll bite during rollout.

## Ordering (hard dependencies)

- Phase 1 blocks everything.
- Phase 2 needs Phase 1 + the hourly sweeper (already shipped).
- Phase 3 needs Phase 1 + ops access to the RingCX admin UI.
- Phase 4 needs Phases 1–3 for data to render.

---

## Prior draft (preserved for context)

<details>
<summary>Original 6101 CX Command Consumer notes — kept so you can see what changed</summary>

### Why it matters
Right now client-action buttons on the Clients workspace fire through `commandsClients` routes, which call `requestCxText/Email/Dial` in `cxWorkspaceService.js`. Those helpers write a `ReviewQueueItem` with `executionOwner: "ringcentral-cx"`. Nothing on 6101 polls that queue. Fix = build the consumer.

### Original dispatch table
- `cx-text` / `cx-email` → delegate to `outboundDispatchService.dispatchForLead` or direct Twilio/SendGrid send.
- `cx-dial` → **build a RingOut call via `ringcentralClient.createRingOut`** ← WRONG, corrected above.
- `cx-status` → `logicsFacade.updateCaseStatus`.
- `cx-source` → SourceCanonical write + `attribution.lockedManual: true`.
- `cx-dnc` → `contactEligibilityService.stopCaseContact`.

### Original open questions (mostly still valid)
1. Worker hosting — inline on 6101 vs separate process. **Still: inline.**
2. Per-agent extensionId requirement — yes, fail-fast at claim time. **Still applies, plus ringcxUsername.**
3. Retry backoff — now handled by the hourly-sweeper pattern that shipped.
4. Rate limiting — RingCX has per-second limits on activeCalls endpoints; serialize per agent.

</details>
