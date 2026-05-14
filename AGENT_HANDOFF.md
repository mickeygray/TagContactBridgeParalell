# Agent Handoff — TagContactBridgeParallel ("Parallel")

**Written:** 2026-05-14 PT by Claude (Sonnet 4.5 in Claude Code on Windows)
**Audience:** the next Claude/Codex session — possibly on a different machine after the cutover.
**Purpose:** preserve in-flight context so you don't have to relearn the codebase or relitigate decisions already made.

If you're reading this fresh on a new machine: start here, then look at `MEMORY.md` references the user keeps about TCB versions, the Parallel session state, and the Logics dual-tenant setup. The user's notes there are authoritative on org structure; this doc is authoritative on **recent code state**.

---

## 1. Identity / environment

- **Repo:** `C:\Users\Admin\Code\TagContactBridgeParallel` (Windows). Monorepo. The older reference monolith lives at `C:\Users\Admin\Code\TagContactBridge` ("v2") — read-only history; current work happens in Parallel.
- **Mongo:** Atlas. `MONGO_URI` in `.env`. **Production database name is `tagcontactbridge_parallel`** — set via `PARALLEL_DB_NAME`. When you write throwaway query scripts, **always pass `dbName: process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel"` to `mongoose.connect()`**, otherwise you'll hit the empty default DB and waste 30 minutes thinking production is dead (I did this — see §6).
- **Services:** Most things run under **NSSM** on Windows (Parallel*, RingBridge, etc.). `nssm restart <ServiceName>` to bounce. Logs go to per-service log files under each service's working dir.
- **Ports:** All env-overridable now. Don't hardcode 5001/3001 — read from `PORTS` in `packages/shared-config/src/index.js`.
- **Tunneling:** ngrok for inbound webhooks (CallRail SMS, RingCentral webhooks).
- **Two physical machines:** user is mid-cutover — the new box becomes primary, the old becomes a Linux dev box. Cutover scripts live at `ops/cutover/`.

---

## 2. System overview (one-paragraph version)

Parallel is a tax-resolution sales-floor stack. Two tenants share one codebase: **TAG** (existing clients, AI auto-response disabled, humans always in loop) and **WYNN** (autonomous prospecting flow, AI classifier + auto-responder + hot-intent router fires). The CX shell is the agent-facing UI (`/cx`) for outbound dialing via RingCentral CX (RingCX). The admin shell (`/admin`) is for ops/Matt. SMS comes in via CallRail webhook → classifier → workflow → optional auto-reply. Outbound cadence dials run through a universal queue with RC 10DLC SMS, RingCX voice, and an outbound email gateway. Logics is the source-of-truth CRM for cases on both tenants (separate ID namespaces per tenant — TAG case 106029 ≠ WYNN case 106029).

---

## 3. Current state of key projects (this session, 2026-05-13 → 2026-05-14)

### 3a. WYNN SMS inbox — AI-push hot-intent routing (LIVE, just deployed)

**The big shift this session.** Original plan was a manual "Send to my campaign" button for reps to claim hot SMS threads. The user **rejected that mid-build** and replaced it with AI-driven autonomous routing. The manual-claim path was deleted; this is the live model:

1. **Inbound SMS** hits CallRail webhook → `handleSmsInboundForwarded` in `packages/shared-services/src/controlPlaneEventService.js`.
2. **Classifier** (`classifySms` in `smsClassifierService.js`) returns `tier` + `hotIntent: { detected, reason }`. New `hotIntent` field — buying-intent detection (tax questions, pricing questions, "I need help", IRS notice mentions). Errs HIGH on purpose; reps can dismiss false positives in one click.
3. **If `hotIntent.detected`** → `autoRouteHotInboundWorkflow` in `hotIntentRouterService.js` fires:
   - Stamps `aiHotIntent: true`, `aiHotIntentReason`, `aiHotIntentDetectedAt` on the `ConversationWorkflow`.
   - Round-robins to the next available agent. "Available" = `AgentState.cxRouting.desiredAvailability === "available"` AND `appPresence.lastSeenAt` within 5 min.
   - Round-robin cursor: `AgentState.cxRouting.lastHotIntentRoutedAt` — least-recently-routed-wins. No separate counter document.
   - Stamps `routedToAgentId/Name/At` on the workflow.
   - Idempotent for 30 min — a hot follow-up message on the same thread doesn't bounce assignment.
4. **Alert email** to ogleads@taxadvocategroup.com gets `🔥 HOT` subject prefix + "routed to {rep}" footer.
5. **Inbox UI** (`apps/web-client/src/workspaces/inbox/InboxWorkspace.tsx`):
   - Red 🔥 banner pill on hot threads.
   - Green ✓ "Routed to you" indicator if `routedToAgentName` matches current rep.
   - List-row chips: `🔥 hot`, `✓ you`, or `→ {other rep}`.

**Soft-lock on SMS authoring** — separate but related:
- When any rep approves/edit-sends/regenerates an SMS, `assertSmsLockAvailable` checks the workflow's `smsLockedByAgentId`. If another rep holds the lock and it's still fresh (< 15 min), returns **409 `sms-lock-held`**.
- Successful outbound stamps `smsLockedBy*` on the workflow.
- Soft-lock **auto-clears on next inbound** (built into `recordConversationAi` in `caseIntelligenceService.js`).
- UI shows amber 🔒 "Sean is replying" badge + a **Take over** button that arms `forceOverride` and re-posts with `override: true` to bypass the lock.
- `commandsInbox.js` route file: Approve / Edit-Send / Regenerate are mounted under `requireUser` (admin OR user audience) BEFORE the `requireAdmin` gate. Cancel / Sleep / Wake / DNC remain admin-only.

**WYNN-only inbox at `/cx/inbox`** — separate route in the CX shell sidebar between Queue and Clients. Uses the same `InboxWorkspace` component with `forcedDomain="WYNN"` to bypass the global domain store.

**Schema fields added** (`packages/shared-models/src/ConversationWorkflow.js`):
- `aiHotIntent`, `aiHotIntentReason`, `aiHotIntentDetectedAt`
- `routedToAgentId`, `routedToAgentName`, `routedAt`, `routedQueueItemId` (null — see "pending" below)
- `smsLockedByAgentId`, `smsLockedByAgentName`, `smsLockedAt`

**Schema field added** (`packages/shared-models/src/AgentState.js`):
- `cxRouting.lastHotIntentRoutedAt` — round-robin cursor

**Test phrase that should trip hot-intent end-to-end:**
> "I got a notice from the IRS about back taxes I owe. How does your service work and what does it cost?"

Sent to the WYNN tracking number (NOT TAG — TAG bypasses LLM and won't compute hot-intent). Restart `ParallelControlPlane` to load the new code. At least one agent must have `desiredAvailability="available"` + heartbeat in the last 5 min, otherwise the workflow stays unrouted ("UNASSIGNED" in alert email). That's still a valid pass for the AI-detection half.

### 3b. Internal email sender consolidation (LIVE)

User asked all internal Parallel email to come **from `mgray@taxadvocategroup.com`** so replies hit a human inbox instead of `team@`. New env var `INTERNAL_FROM_EMAIL` (default `mgray@taxadvocategroup.com`) + new helper `getInternalFromEmail()` exported from `packages/shared-config/src/index.js`.

**Flipped to use the helper:**
- `controlPlaneEventService.sendClientSmsAlert` (the WYNN SMS alert to ogleads — the specific call-out)
- `hourlyJobEventService` — hourly job-failure alerts
- `hourlySweeperService` — sweeper alerts
- `inboundIntakeService.sendInboundLeadAlertEmail` — `[DOMAIN] Source - Name | Case #` alerts
- `lexisSftpService` — Lexis regional drop ops mail
- `lexisDailyDropService` — Lexis daily drop ops mail (from + reply_to, both branches)

**Intentionally left alone** (prospect-facing, must stay branded):
- `outboundEmailService` — cadence to leads
- `cxWorkspaceService` — agent-to-prospect emails
- `vendorNightlyEmailService` — vendor exports
- Per-domain `WYNN_FROM_EMAIL` / `TAG_FROM_EMAIL` still drive `company.fromEmail` for everything that needs branded sender.

**SendGrid caveat:** mgray@ must be either an authenticated domain sender (taxadvocategroup.com auth exists — should work) or a verified single-sender. If the first internal alert bounces with "sender identity not verified", add mgray@ as a verified sender in SendGrid console.

### 3c. WYNN/TAG SMS hygiene (earlier this session, LIVE)

- TAG SMS alerts route to `manderson, abanks, mgray @taxadvocategroup.com` (`TAG_SMS_ALERT_EMAIL` env var). TAG = client line, AI auto-response intentionally disabled.
- WYNN SMS alerts route to `ogleads@taxadvocategroup.com` (`WYNN_SMS_ALERT_EMAIL`). WYNN = prospect line, AI auto-responder fires.
- Inbox `buildQuery` (in `packages/shared-repositories/src/conversationWorkflowRepository.js`) default-hides `optOutDetected: true` + `status: "suppressed"/"closed"` — pass `includeOptedOut: true` / `includeTerminated: true` to override.

### 3d. Sales trainer (LIVE, foundation done)

Voice-loop AI for sales rep training. Three-tier model split for cost+quality:
- **Haiku** = live conversational turn (latency-critical)
- **Sonnet** = caller profile generation + coaching feedback + playbook
- **Opus** = post-call narrator

Other foundation pieces shipped: prompt caching (2-tier ephemeral cache_control), slim live-turn prompt, sentence-chunked parallel TTS via `Promise.allSettled`, Sonnet-generated story playbook, character anchor, scorecard split (facts panel + assessment panel — but UI for that is still pending, see §4), Opus coaching narrator, stage-direction stripping, outbound opted-in framing.

UI gaps remaining (see §4).

### 3e. Cutover (LIVE foundation)

User is replacing the Windows machine running Parallel. To make hot-swap painless:
- Env-overridable ports throughout.
- `PARALLEL_RC_SUSPENDED` env kill-switch wired through `ringcentralClient` + `ringcxVoiceClient` + the presence poller — flip it true and all RC traffic from this process stops cold.
- `ops/cutover/` scripts: `bootstrap.ps1`, `healthcheck.ps1`, `go-live.ps1`, `disable-rc.ps1`, and a port-aware NSSM install script.
- 429 response-header capture (X-Rate-Limit-*) for forensics when RC throttles us.

### 3f. RingCentral 429 investigation (RESOLVED)

Codex's auth-level backoff is working. RC Auth limit is 5 req/user/min default with a 60s penalty on overage. No code changes needed here beyond the response-header capture already added. If you see 429s again: check whether it's auth endpoint (covered) or a data endpoint (not covered). Don't add retries blindly — `429 retry in ringcxVoiceClient` is still on the backlog pending control-plane restart, but verify it's actually needed before building.

### 3g. Ron Colbert DNC investigation (RESOLVED — see §6 for the bug we found)

User asked why "the app DNC'd Ron Colbert" (WYNN case 106029). Answer: it didn't — Anthony Calloway clicked DNC in the CX shell at 2026-05-14 20:31 PT. The full chain is in the workflow records for case 106029. Investigation script lives at `ops/investigate/ron-colbert-v3.js` if you need it again.

**Side finding that's now an open task** (spawned to its own session): the RingCX `dispositionCall` endpoint returns **400 invalid.data on every disposition write**, regardless of disposition value. Captured 8 failed attempts in the workflow record for that case. The system records the disposition locally and updates Logics correctly, but RingCX itself never accepts a wrap-code. **Means RingCX-side disposition data is silently missing across all calls.** Look at `cxDispositionService` and `ringcxVoiceClient` for the dispositionCall payload shape — likely a request-body mismatch with RingCX's expected schema.

---

## 4. Pending backlog (prioritized, with dependencies)

### High-leverage (unblocks other work)

1. **SMS / WYNN — phone→case lookup at ingest** so inbound rows carry `caseId`. Currently `caseId: null` on most inbound `ConversationWorkflow` rows because we don't resolve phone → MasterProspectIndex → caseId at ingest. **Unblocks:**
   - Hot-intent router can call `upsertActiveItemForLead({ forceDialReady: true, assignedTo: agentId })` to actually insert into the universal queue (currently the router just stamps ownership; queue insertion is pending).
   - CaseProfile `communicationThreads.sms` gets populated for the case.
2. **Hot-intent routing — wire universal-queue insertion** into `hotIntentRouterService.autoRouteHotInboundWorkflow`. Depends on #1. The schema field `routedQueueItemId` is already there waiting.

### SMS / WYNN flow polish

3. **Human-response window worker** — defer `callback_prompt` auto-send by N minutes; cancel if a rep replies first. Currently the auto-responder fires immediately, which can race with a rep that just got the alert. The soft-lock helps (rep texting blocks AI from texting) but doesn't yet block the auto-responder's initial send.
4. **AI fallback template** — fires AFTER the human-response window expires if nobody replied. Acknowledge what the prospect said + schedule/call CTA.
5. **Outbound channel selector** — CallRail SMS vs RingCentral EX SMS (rep choice per send).

### TCPA / CX (lead eligibility at queue entry)

6. **Lead eligibility filter at queue entry** — daily cap, weekly cap, Florida-specific 3/24h cap, lead-local-time window (8am-9pm), opt-out filter, nurture-vs-prospecting lane.
   - Volume math user did: 100-135k current dials → ~50k under conservative caps (75 new/day + 6k aged).
7. **21-day aged-to-nurture lane** — drop dial rate on aged leads; promote to nurture.
8. **Admin control panel** for eligibility thresholds (non-engineer tuning).

### Sales trainer UI

9. **Scorecard two-section layout** (facts panel + assessment panel) — the data split is done in the service; UI hasn't been built.
10. **Coaching narration in chat bubble** at end of call — render the Opus narration as a chat message instead of the raw scorecard JSON.

### Recording storage

11. Migrate `dump-recordings-to-drive.js` to use the new module (optional cleanup).
12. **Stale-bytes sweeper** — clean up orphaned recording files.

### Linux migration (separate effort)

13. Step 3: GitHub history cleanup — strip 91 MP3 files from history + push.
14. Step 4: physical install on second SSD (when hardware arrives).
15. Step 5: bootstrap script + systemd units for Parallel on Ubuntu 24.04.4.

### Misc ops

16. **Add nginx to NSSM** — queued, needs admin shell.
17. **429 retry in `ringcxVoiceClient`** — pending ParallelControlPlane restart to verify.
18. **Landing pages backend pipeline** — wire branch + auto-deploy.

### Spawned to other sessions (not on this list)

- **RingCX `dispositionCall` 400 fix** — chip in the UI from this session. Investigates the request-body shape mismatch. Affects ALL calls, not just Ron Colbert.

---

## 5. Architectural decisions worth preserving

### TAG vs WYNN dual-tenant
- **Separate Logics ID namespaces.** TAG case 106029 ≠ WYNN case 106029. Always carry `domain` alongside `caseId`.
- TAG = existing-client traffic. AI auto-response **disabled**. Alert + humans only.
- WYNN = prospect-stage acquisition. AI auto-responder + hot-intent routing fires.
- UA fields are domain-prefixed: `tagLogicsId`, `tagEmail`, `wynnLogicsId`, `wynnEmail` on UserAccount. The cxOAuth + Logics auth flows resolve which tenant the user maps to based on which tenant fields are populated.
- Phone-based domain resolution happens at SMS ingest via `resolveCompanyByTrackingNumber(destination_number)` against `SourceCanonical.ringCentralExtensions` (seeded from the RC reference CSVs at `ops/ringcentral-reference/`).

### AI-push vs rep-pull (key reversal this session)
- User explicitly rejected manual claim. "Send to my campaign" button was built then **deleted** the same day.
- The model is: AI classifies → AI routes → rep consumes. Reps don't claim; they receive.
- Soft-lock guards cross-rep racing on outbound SMS, but routing itself is autonomous.

### Hot-intent definition
Err HIGH on detection. Buying-intent signals = ANY of: tax question, pricing question, "I need help / I need to do something", IRS notice mention, "can you call me", "how does this work", expressed confusion they want resolved. Borderline interest beats a missed hot lead.

### Soft-lock semantics
- Lock is **per-thread**, set on outbound, auto-cleared on next inbound.
- 15-min staleness fallback (in case lead never replies, lock evaporates).
- "Take over" override always available — soft lock, not hard.
- Server returns 409 `sms-lock-held` on attempted bypass without `override: true`.

### Round-robin cursor (no counter doc)
`cxRouting.lastHotIntentRoutedAt` per agent. Pick the one with the oldest value. Null sorts first ("never routed"). Naturally self-balancing, fault-tolerant, no shared counter to corrupt.

### Internal vs branded email sender
- Internal alerts (ops-facing) → `getInternalFromEmail()` → `mgray@`
- Prospect-facing email → per-domain branded sender (`WYNN_FROM_EMAIL` / `TAG_FROM_EMAIL` / `company.fromEmail`)
- Don't conflate these.

### Universal queue model
- States: `in_pool → in_slice → dialing → completed`
- Partitions: fresh vs non-fresh (fresh prioritized)
- Age buckets via `LeadCadence`: `just_came_in`, `second_contact`, `third_contact`, `day2_10`, `aged`
- Rate-shaped throughput; assignment-stat rollups per agent on `AgentState.cxRouting.assignmentStats`

---

## 6. Operational gotchas / things that look broken but aren't

### Mongo db name
**The default DB on the connection string is empty.** Production data is in `tagcontactbridge_parallel`. If a query returns 0 results across the board, **first** check whether you passed `dbName` to `mongoose.connect`. I burned 30 minutes on this — see `ops/investigate/*.js` for the pattern. All those scripts now pass `dbName` correctly.

### RingCX dispositionCall 400
Every disposition write returns 400 invalid.data. The disposition is captured locally + propagated to Logics, but RingCX side never sees it. Spawned as its own task; do NOT mark this resolved until that's fixed.

### PARALLEL_RC_SUSPENDED
This is a kill switch. If set, all RC traffic from this process stops. Used during cutover. Don't turn it on accidentally — and if RC traffic is mysteriously absent, check this env var first.

### Logics StatusID 173
That's the "DNC" status in Logics for WYNN (and presumably TAG — verify before using cross-tenant). Found via the Ron Colbert trace. There may be a status enum somewhere worth documenting; haven't searched.

### TAG vs WYNN MasterProspectIndex disparity
TAG has ~91k MPI rows (bulk-imported 2026-04-28). WYNN has 0 (verified via `controlplanemasterprospectindexes` count by domain in `tagcontactbridge_parallel` db — actually wait, I verified WYNN had 0 on the WRONG DB. Recheck if WYNN MPI population matters for any task.).

### SMS pipeline data presence
I did NOT verify total counts of `ConversationWorkflow` / `ConversationMessage` / `ConsentRecord` on the **correct** DB. The Ron Colbert trace showed 0 for that case, but he never SMS'd. **Open question:** is the SMS classifier pipeline actually firing in prod and persisting? Worth a 60-second sanity check before doing more SMS work.

### Mongo collection name conventions
Mongoose pluralizes lowercased model names. `mongoose.model("ControlPlaneConversationWorkflow", ...)` → collection `controlplaneconversationworkflows`. `mongoose.model("ControlPlaneConsentRecord", ...)` → `controlplaneconsentrecords`. Be aware when writing raw queries.

### Service names (NSSM)
- `ParallelControlPlane` — the main control plane (port 5001-ish)
- `ParallelRingBridge` — RingCentral bridge
- Other services in cutover scripts.

### Auth flow
- `requireAuth` — verifies JWT
- `requireAdmin` — admin role only, loads live account from Mongo
- `requireUser` — admin OR user audience (admin is a superset)
- Apply `requireUser` to routes you want both reps and admins to access. The Approve/Edit-Send/Regenerate inbox routes use this pattern now.

### NSSM service restart vs file rebuild
Backend changes need **service restart** to pick up. Frontend changes need `cd apps/web-client && npm run build` (does `tsc --noEmit && vite build`) and a **hard reload** of the browser (Ctrl-Shift-R) to pick up the new hashed bundles. The build outputs to `apps/web-client/build/` and is served by the control plane.

---

## 7. Key files / entry points

### SMS pipeline
- Webhook → `apps/control-plane/src/routes/smsInbound.js` (or wherever the CallRail webhook lands)
- Inbound handler → `packages/shared-services/src/controlPlaneEventService.js::handleSmsInboundForwarded` (line ~452)
- Classifier → `packages/shared-services/src/smsClassifierService.js::classifySms`
- Hot-intent router → `packages/shared-services/src/hotIntentRouterService.js::autoRouteHotInboundWorkflow`
- Auto-responder → `packages/shared-services/src/smsAutoResponderService.js::runAutoResponder`
- Workflow update → `packages/shared-services/src/caseIntelligenceService.js::recordConversationAi`
- Inbox commands → `packages/shared-services/src/inboxCommandService.js` (approve/edit-send/regenerate/cancel/sleep/wake/dnc)
- Inbox API hooks → `apps/web-client/src/lib/api/queries/inbox.ts`
- Inbox UI → `apps/web-client/src/workspaces/inbox/InboxWorkspace.tsx`
- WYNN-only wrapper → `apps/web-client/src/workspaces/inbox/WynnInboxWorkspace.tsx`

### Email
- Sender helpers → `packages/shared-services/src/sendgridMailService.js` (legacy shim) + `mailerService.js` (current)
- Internal sender helper → `packages/shared-config/src/index.js::getInternalFromEmail`
- Alert email subject/body builder → `controlPlaneEventService.js::sendClientSmsAlert`

### CX shell + dial path
- `apps/web-client/src/app/CXShell.tsx` — the shell layout
- `apps/web-client/src/app/routes.tsx` — `/cx`, `/cx/inbox`, `/cx/clients`, `/cx/workspace`
- `cxWorkspaceService.js` + `cxDispositionService.js` — workspace logic
- `ringcxVoiceClient.js` — RingCX HTTP calls (the dispositionCall bug lives here or in cxDispositionService)

### Auth
- `packages/shared-auth/src` — JWT helpers
- `apps/control-plane/src/middleware/auth.js` — `loadLiveAccount`, `requireAdmin`, `requireUser`, `requireCxOAuth`

### Sales trainer
- `apps/trainer/...` — TODO list its exact path; user spent a lot of time here, lives in apps/

### Cutover
- `ops/cutover/` — bootstrap, healthcheck, go-live, disable-rc scripts
- `ops/ringcentral-reference/` — RC reference CSVs

### Investigate scripts (this session's debug helpers)
- `ops/investigate/ron-colbert-v3.js` — DNC trace pattern (good template)
- `ops/investigate/wynn-totals.js` — domain-count diagnostic
- `ops/investigate/find-106029.js` — caseId scan across collections

---

## 8. Recently-modified files (this session — Sonnet 4.5 turns)

### Backend
- `packages/shared-models/src/ConversationWorkflow.js` — hot-intent + routed + soft-lock fields
- `packages/shared-models/src/AgentState.js` — `cxRouting.lastHotIntentRoutedAt`
- `packages/shared-services/src/hotIntentRouterService.js` — NEW
- `packages/shared-services/src/smsClassifierService.js` — hotIntent in tool schema + prompt + return shape
- `packages/shared-services/src/controlPlaneEventService.js` — hot-intent stamp/route + alert email 🔥 + internal-from
- `packages/shared-services/src/caseIntelligenceService.js` — recordConversationAi carries hot-intent + clears soft-lock
- `packages/shared-services/src/inboxCommandService.js` — soft-lock assert + stamp, removed manual pushToCampaign
- `packages/shared-services/src/hourlyJobEventService.js` — internal-from
- `packages/shared-services/src/hourlySweeperService.js` — internal-from
- `packages/shared-services/src/inboundIntakeService.js` — internal-from
- `packages/shared-services/src/lexisSftpService.js` — internal-from
- `packages/shared-services/src/lexisDailyDropService.js` — internal-from
- `packages/shared-services/src/index.js` — exports refreshed
- `packages/shared-config/src/index.js` — getInternalFromEmail helper + export
- `apps/control-plane/src/routes/commandsInbox.js` — split user vs admin route mounts

### Frontend
- `apps/web-client/src/app/CXShell.tsx` — WYNN inbox nav item
- `apps/web-client/src/app/routes.tsx` — `/cx/inbox` lazy route
- `apps/web-client/src/workspaces/inbox/InboxWorkspace.tsx` — hot-intent pill, soft-lock badge, Take over, list-row chips
- `apps/web-client/src/workspaces/inbox/WynnInboxWorkspace.tsx` — NEW thin wrapper
- `apps/web-client/src/lib/api/queries/inbox.ts` — `override` body field; removed pushToCampaign hook
- `apps/web-client/src/lib/api/types.ts` — schema fields refreshed

### Env
- `.env` — `INTERNAL_FROM_EMAIL=mgray@taxadvocategroup.com`, WYNN/TAG SMS alert recipients (set earlier this session)

---

## 9. Open questions / unverified assumptions

1. **Is the SMS classifier pipeline actually persisting data in prod?** I never ran a total-count diagnostic against `controlplaneconversationworkflows` / `controlplaneconversationmessages` / `controlplaneconsentrecords` on the **correct** DB (`tagcontactbridge_parallel`). Worth verifying before doing more SMS work.
2. **Is `INTERNAL_FROM_EMAIL=mgray@taxadvocategroup.com` an authorized SendGrid sender?** Probably yes via domain auth, but watch the first internal alert post-restart. If it bounces with "sender identity not verified", add as verified single sender.
3. **Does the hot-intent router actually fire end-to-end?** User was going to send a test text but switched to investigating Ron Colbert before the test happened. The path is built and `node -c` clean across all modified files, but it hasn't been verified live.
4. **RingCX dispositionCall request shape** — what does RingCX actually expect? See spawned task. The 8 failed attempts all returned `400 invalid.data, details: ""` (empty details, which is unhelpful).
5. **WYNN MPI population** — TAG has 91k MPI rows, WYNN appeared to have 0 on initial check but I may have been on the wrong DB. Re-verify before assuming.

---

## 10. User communication style

- Direct, often informal, often midstream pivots ("actually let me think more about this", "scrap that").
- When the user changes their mind mid-build, **rip out the rejected path cleanly** — don't leave dead code. They explicitly value tidy reversals.
- They want commentary that's substantive ("explain why", "trade-offs"), not glowing.
- "Build it" is a green light. They don't usually want a plan-first dance unless the cost/risk is high.
- They reference codex (the other coding agent) by name. Codex and Claude collaborate on this codebase; sometimes one of us patches what the other built. Be aware patches may have come from codex and aren't in this doc.

---

## 11. Don'ts

- Don't add documentation files unless asked. The user explicitly doesn't want `*.md` clutter (this handoff doc is an exception they asked for).
- Don't use emojis in code unless asked. UI labels are fine when they enhance UX (🔥 hot pill, 🔒 lock badge — those were specifically discussed).
- Don't `git push --force` or run destructive git ops without an explicit ask.
- Don't restart services without telling them — the user runs the floor live; an unannounced restart drops calls.
- Don't change `WYNN_FROM_EMAIL` / `TAG_FROM_EMAIL` / `company.fromEmail` — those are prospect-facing branded senders. Internal stuff uses `getInternalFromEmail()` now.
- Don't add manual claim-style UI for SMS leads. AI-push is the model. The user rejected manual claim explicitly this session.

---

**End of handoff.** If a critical decision was made between this doc's write date and your read date, the user's chat history will tell you. Start there, then `git log --since="2026-05-14"` for diffs.
