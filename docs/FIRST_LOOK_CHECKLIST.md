# First-look checklist — walk-through after a few days away

Tick these in order. Nothing here needs the CX API key — CX-specific validation is at the bottom in **Pending**.

## 0. Pre-boot — `.env` sanity

Before starting the services, open `.env` and confirm:

- [ ] `TAG_CALL_RAIL_TRACKING_NUMBER=8186865483` — **recommended** but not required for boot. Without it, inbound SMS can't reliably resolve to TAG, and outbound replies use whatever generic number is set.
- [ ] `WYNN_CALL_RAIL_TRACKING_NUMBER=3105611009` — same.
  (Boot only fails if you explicitly set BOTH envs to the SAME number — that's a real config mistake. Leaving both blank is treated as "unconfigured" — server boots with a warning.)
- [ ] `RC_SUBSCRIPTION_WATCHDOG_ENABLED` is **absent or `false`**.
  We do not want Parallel to manage the live RC subscription yet. If this is `true` and `NGROK_DOMAIN` points at a real URL, Parallel could silently redirect prod RC webhooks to itself.
- [ ] `ANTHROPIC_API_KEY` is set — the SMS classifier uses it. If it's blank, inbound SMS will classify as `needs_human` every time (falls through cleanly; just flagging).
- [ ] `MONGODB_URI` is the one you expect (dev vs. prod). Easy to miss when coming back after time away.

## 1. Boot

```
npm run dev   # or npm run dev:backend if you're skipping the web UI
```

Watch the control-plane startup log for:

- [ ] `control-plane.callrail.tracking_unconfigured` — absent (means both tracking numbers resolved).
- [ ] `control-plane.accounts.bootstrap.complete` — present, with a sensible `seedsTotal`.
- [ ] `control-plane.worker.batch` — fires within a minute (proves the main event worker is alive).
- [ ] `control-plane.hourly.tick` — fires on the first minute (proves the hourly sweeper cron is alive).
- [ ] `ringcentral.watchdog.disabled` — present, with the "set to true when Parallel is ready to own the webhook subscription" reason. **This is the correct state right now.**
- [ ] `ringcentral.platform.ready` + `ringcentral.presence_poller.started` — present (RC EX still active for call attribution even though we're not managing the CX subscription).
- [ ] No `ERROR`-level lines. Warnings are OK.

## 2. `/health` endpoints

With the health token handy:

- [ ] `GET http://localhost:5001/health` (control-plane) — returns `ok:true`, mongo connected, worker running.
- [ ] `GET http://localhost:6101/health` (ringcentral-cx) — returns `ok:true`, `subscriptionWatchdog.enabled: false`, presence poller running.
- [ ] 5001 health response includes the new worker blocks: `cxCadenceWorker`, `subscriptionWatchdog` (if you've wired both across).

## 3. Web UI — first impression

Open the web app.

- [ ] **Theme toggle** lives in the top-left of the sidebar (sun/moon/laptop icon next to the TAG logo). Click through all three modes:
  - Light → canvas goes cream/warm, TAG orange accent.
  - Dark → canvas goes blue-black (the ringBridge palette), TAG orange stays as accent, gradient highlights look blue-violet instead of orange-cream.
  - System → icon becomes the laptop; theme follows your OS setting.
- [ ] Reload the browser — theme **persists** (stored in `localStorage` under `web-client-theme`).
- [ ] Flip to dark mode. Scan every workspace via the sidebar: Users, Inbox, CX, Dispatch, Metrics, Library, RingBridge, Schedule, Deploy, Clients. Every surface reads cleanly (no bright white bleed, no unreadable text). If any workspace flashes white — that's a hardcoded color I didn't catch; note which one.

## 4. Users workspace

Open **Users**.

- [ ] List has these columns: Name, Email, Role, Company, **Ext** (short dialable), **Logics** (TAG/Wynn ids), **Cred** (colored pill from `logicsAuth.credentialStatus`), **Live** (presence from joined AgentState), Status, Last login.
- [ ] Click **Bruce Allen** (or any agent you know is paired). Drawer shows:
  - Ext number = `966` (not the long RC id).
  - Logics identities section shows **TAG id 404** + **Wynn id 24** with both emails.
  - Credential state section — likely "No credentials configured" since we haven't rotated any yet.
  - Live presence section — populated if the RC presence poller has seen them, else empty.
- [ ] Click **Sync from RC** button. Dry-run should show 68 scanned, 4 updated, 0 errors (no changes since the last sync). If something errors with "createdBy email mismatch" — ignore, cosmetic.
- [ ] Edit a user and change nothing — Save should round-trip without stripping fields. Then edit their TAG roles field, save, reload — the value should persist.

## 5. Inbox workspace

Open **Inbox**.

- [ ] Left-pane list shows conversations. **Auto-responded threads are hidden by default.** If you want to see them, the filter toggle is wired — look for an "Include auto-replied" switch or a query-param `includeAutoResponded=true`.
- [ ] Click a thread. Right pane shows a **bubble conversation view** (not the old "latest inbound + draft" single-panel UI):
  - Inbound messages left-aligned, neutral background.
  - Outbound messages right-aligned, primary-tinted.
  - Outbound bubbles that were auto-sent show a small `auto` tag.
  - Provider status pill below outbound ("sent", "delivered" in green, "failed" in red with the error inline).
  - Timestamps + classifier tier/confidence pills below inbound bubbles.
- [ ] Header of the thread shows an **auto-responder chip** if the bot touched it: red "Auto-suppressed" (dnc_confirm) or blue "Auto-callback sent" (callback_prompt) or red "Carrier STOP" (hard_stop).
- [ ] **Per-message chip row** on every inbound bubble — `Approve draft`, `Send as-is`, `Regenerate`, `Mark DNC hard`, `Mark DNC soft`, `Hostile`, `Spam`, `Already client`, `Wrong number`. Click one — it posts the disposition, the chip becomes highlighted, and the pill persists after a refetch.
- [ ] Empty state — on a brand-new thread with only the summary row, you should see the workflow's `latestInboundText` as a single fallback bubble with "No messages yet" context.

## 6. Email template send (CX workspace, non-CX-API path)

Open **CX Workspace**. This tests the branded HBS template rendering, not the RingCX integration.

- [ ] Pick any contact in the left pane (any case with an email).
- [ ] In the email library, click **Direct intro**. Subject + body populate in the compose form. A muted hint reads "Branded template `direct-intro` will be rendered server-side on send."
- [ ] Edit the subject — the hint disappears (dropped to free-form).
- [ ] Click the template again to re-arm it.
- [ ] Hit Send. Check the actual delivered email (a test inbox) — it should arrive with the TAG branded header bar, accent color top stripe, signature block with the logged-in agent's name + email + phone, and the disclaimer footer. Same flow for a Wynn case should use Wynn's brand strip.

## 7. Hourly sweeper — evidence of life

Check the control-plane log for the last hour:

- [ ] `control-plane.hourly.tick` lines appearing every minute (Phase B retry drain).
- [ ] **Once per hour** (on the UTC hour rollover) a tick with `scheduledPhase: true` — this ran Phase A (session reconcile + payment reconcile across all domains + stale cadence sweep + resolution emails).
- [ ] `hourly.cadence.stale_swept` — either absent (nothing stale) or present with `modified: N`. Either is fine; `matched: 500` + `modified: 0` would suggest the sweep is capping out on something weird.
- [ ] `payment.reconcile.chargeback_detected` — if it ever appeared, that's a real payment that flipped to FAILED and we correctly reversed the CaseProfile totalPaid. Spot-check the case.

## 8. SMS auto-responder (simulate without the UI)

Fire a synthesized inbound through the webhook path. Replace `<SECRET>`:

```bash
curl -X POST http://localhost:5001/sms/inbound \
  -H "content-type: application/json" \
  -H "x-webhook-secret: <SECRET>" \
  -d '{
    "source_number": "8185559911",
    "destination_number": "+18186865483",
    "content": "can you tell me what you charge for 30k owed?"
  }'
```

Expected:

- [ ] Log shows `sms.inbound.forwarded` → classifier ran → tier `callback_prompt` → `sms.auto.sent`.
- [ ] Mongo: `conversationmessages` has two rows for phone `8185559911` — one inbound with classification metadata, one outbound with body containing "Give us a call at 818-686-5483".
- [ ] The outbound message has `autoResponded: true` + `providerStatus: "sent"` (if CallRail is reachable) or `"failed"` (if the CallRail key is dev).
- [ ] No ConsentRecord created (callback_prompt doesn't DNC).
- [ ] `conversationworkflows` row status stays `observed`.

Then try `"STOP"` as the content — expected:
- [ ] Hard-stop regex fast path (free, no Sonnet call). No outbound bubble. `leadcadences` row (if one exists for that phone) has `sms` added to `cadenceState.exhaustedChannels` with reason `"carrier-stop"`.
- [ ] No ConsentRecord (we do NOT DNC the lead — they might still want email).

## 9. Things you should explicitly NOT see

- [ ] `decorateAccountRecord` never returns `apiKeyHash` / `secretHash` anywhere (check `/admin/accounts` response JSON — only `apiKeyLast4` + `secretLast4` allowed through).
- [ ] JWT preview after login (decode the token) — should include `tagLogicsId`, `wynnLogicsId`, `extensionNumber`. Should NOT include any `*Hash` field.
- [ ] `/auth/send-code` response includes `attemptsRemaining` and DOES NOT include `previewCode` unless `AUTH_OTP_PREVIEW=true`.
- [ ] No `hourly.job.failed` with `reason: "unknown-handler"` — means Codex emitted a handlerKey we didn't register. If you see one, tell me which.
- [ ] No spam of `rc.watchdog.tick_failed` — watchdog is disabled right now, only the silence checker should run. If you see watchdog ticks, `RC_SUBSCRIPTION_WATCHDOG_ENABLED` flipped on somehow.

## 10. Pending until CX API key lands

These are the parts we **cannot** verify today:

- [ ] RingCX click-to-dial via `createManualAgentCall` — no-op until the `ringcxClient` is built (Phase 1 in [CX_CONSUMER_IMPLEMENTATION.md](CX_CONSUMER_IMPLEMENTATION.md)).
- [ ] RingCX disposition / hangup / active-call panel.
- [ ] Per-agent `ringcxUsername` mapping — schema field TBD.
- [ ] RingCX webhook ingestion — static UI-registered, requires the ops team to register the URL after we build the endpoint.
- [ ] Real disposition enum pulled from `GET /auxStates` — currently the UI hardcodes `callback / not-interested / dnc / converted`; will swap to the tenant's list once the client is live.

When the API key + credentials land, ping me and we'll start Phase 1 from the CX plan doc.

## Quick triage — "something broke, what do I do"

| Symptom | First place to look |
|---|---|
| Control-plane won't boot | Tracking-number conflict guard — check whether both `*_CALL_RAIL_TRACKING_NUMBER` envs are explicitly set to the SAME number. If so, make them distinct. Leaving both unset is fine; they'll fall through to the generic fallback and boot with a warning. |
| Inbound SMS arrives but nothing happens | Check `ANTHROPIC_API_KEY` is set; check `handleSmsInboundForwarded` in the log; look for a review item with category `sms-inbound-unknown-tracking`. |
| Theme flicker on first paint | Expected once — `ThemeProvider` applies the class in a `useEffect` so there's one frame of the default before it settles. Low priority. |
| Inbox bubble view empty when thread has messages | Hit `GET /api/read/inbox/:domain/threads/:workflowId/messages` directly — confirms the endpoint; if it returns `messages: []` but you know there are rows, the query is using a stale `workflowId`. |
| Dead-letter jobs piling up | `db.hourlyjobevents.find({ status: "dead-letter" })` in a Mongo shell — the `lastError` field tells the story. No UI for this yet (noted as polish in the earlier audit). |
| Outbound dispatch fires but action never flips | Action might be stuck in `requested` state from a prior crash — the new stale-action sweep in Phase A clears anything older than 48h on the next hourly tick. |
