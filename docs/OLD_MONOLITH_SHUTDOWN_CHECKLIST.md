# Old monolith (`TagContactBridge`) shutdown checklist

The legacy monolith at `C:\Users\Admin\Code\TagContactBridge\webhook.js` (port 4000) is being retired in favor of the parallel monorepo (`TagContactBridgeParallel`, ports 4001 / 6100 / 6101). This doc walks through the verification + transition steps, in order. Don't skip steps unless you've explicitly confirmed the corresponding system is already migrated.

Run this top-to-bottom on cutover day. Anything failing a check should block the shutdown until resolved.

---

## 1. LD vendor traffic — forwarder verified

The bandaid in `webhook.js` (`/lead-contact` + `/lead-contact/pre-ping` → `http://localhost:4001`) needs to be running and proven before old monolith dies.

**Verify:**
- [ ] `FORWARD_LD_TO_NEW_GATEWAY=true` in `TagContactBridge/.env`
- [ ] `NEW_GATEWAY_URL` in same `.env` points at the parallel inbound-gateway URL
- [ ] Both `LEAD_WEBHOOK_SECRET` values match between `TagContactBridge/.env` and `TagContactBridgeParallel/.env`
- [ ] Old monolith restarted since flag was set (check stdout: it should log `[FORWARD-LD]` lines on each LD POST, not `[PIPELINE]`)
- [ ] Send one test pre-ping → lead-contact pair via the vendor's posting endpoint and confirm:
  - Old monolith logs `[FORWARD-LD] POST /lead-contact/pre-ping → http://localhost:4001/... → HTTP 200`
  - Old monolith logs `[FORWARD-LD] POST /lead-contact → ... → HTTP 202`
  - Lead lands in **parallel** DB's `LeadCadence` (intakeRoute starts with `ld-`)
  - Lead does NOT land in legacy `test` DB's `leadcadences`
- [ ] Forwarder dedup cache works: replay the same payload within 60s, confirm second response logs `DEDUP-HIT`

**Once verified, you can flip the vendor over to post directly to the parallel gateway**, but the forwarder is sufficient. Vendor URL change is a separate task.

---

## 2. Audio file hosting

Old monolith serves `https://tag-webhook.ngrok.app/audio/{WYNN,TAG}/*.wav` for drop.co RVM payloads. Parallel inbound-gateway has the same `/audio` route mounted but the files don't auto-copy.

**Action:**
- [ ] Copy files to the parallel runtime dir:
  ```bash
  cp -r "/c/Users/Admin/Code/TagContactBridge/audio/." \
        "/c/Users/Admin/Code/TagContactBridgeParallel/runtime/audio/"
  ```
- [ ] Verify both subdirs land:
  ```bash
  ls /c/Users/Admin/Code/TagContactBridgeParallel/runtime/audio/WYNN/
  ls /c/Users/Admin/Code/TagContactBridgeParallel/runtime/audio/TAG/
  ```
- [ ] Set `RVM_AUDIO_BASE_URL` in `TagContactBridgeParallel/.env` to the parallel app's public URL `+ /audio`. Whatever ngrok tunnel / public hostname the parallel inbound-gateway is reachable at.
- [ ] Restart parallel inbound-gateway to pick up the env change.
- [ ] Test the URL: `curl -I "<RVM_AUDIO_BASE_URL>/WYNN/rvm-1-intro.wav"` should return 200.
- [ ] Drop.co RVMs queued AFTER this point will use the new URL. RVMs queued BEFORE will still reference the old hostname — those will fail to deliver if the old monolith is down.

**Rollback if broken:** keep old monolith alive until in-flight RVMs drain (drop.co retries for ~24h, then gives up).

---

## 3. PhoneBurner dependencies

Per ops decision PB stays up until full agent transition; PB-related shutdown is deferred. But verify the parallel side's PB rotation runtime is alive so morning cascade keeps firing when old monolith's cron stops.

**Verify:**
- [ ] `phoneburnerRotationRuntime.js` is enabled in the parallel control-plane (check the runtime config)
- [ ] Comment out / disable old monolith's 7am rotation cron at `webhook.js:1583` so it doesn't fire alongside the parallel one

**OAuth callback URL** still points at `tag-webhook.ngrok.app/pb/callback`. When PB refresh tokens eventually expire, this will need a new callback URL on the parallel app. Not urgent.

---

## 4. Inbound webhooks (FB / TikTok / SMS / drop.co)

The parallel inbound-gateway already has these routes mounted. Whether vendor traffic is flowing to them depends on each vendor's configured webhook URL.

**Verify:**
- [ ] Facebook Lead Ads: page subscription points at `<parallel-host>/fb/webhook`. Currently `tag-webhook.ngrok.app/fb/webhook` may still be configured at Meta — re-point or you'll lose FB leads at cutover.
- [ ] TikTok: `<parallel-host>/tt/webhook`. Same story.
- [ ] CallRail / RingCentral SMS inbound: `<parallel-host>/sms/inbound`. Old monolith forwards to localhost:5000/5001 today (lines 1144-1148 of webhook.js); parallel `control-plane/server.js:749` has its own handler.
- [ ] Drop.co disposition webhook: `<parallel-host>/drop-webhook`. Configured in drop.co dashboard.

**Action items (vendor-side, not code):**
- [ ] Update each vendor's webhook URL in their respective dashboards
- [ ] Or: keep ngrok tunnel `tag-webhook.ngrok.app` pointed at port 4000 and update DNS/proxy to forward to 4001 (deployment-environment dependent)

---

## 5. Cadence (the 5-min tick concern)

Old monolith fires `runCadenceTick(...)` every 5 minutes via `setInterval` (webhook.js:1733). Parallel app uses `hourlyLeadCadenceEnforcementService` — hourly resolution.

**Verify the design holds for your traffic:**
- [ ] Confirmed: fresh leads hit `setImmediate(fireImmediateContact)` on intake → first text + email + CX queue insert within seconds (independent of cadence tick frequency).
- [ ] Confirmed: `+2hr` second text uses `AGE_RELATIVE_TEXT_2_MS` (env-overridable to 1hr via `COUNTER_CADENCE_TEXT_2_DELAY_MS`).
- [ ] Daily fan-out runs hourly which is fine for day-1+ outreach.

**No action required unless you observe fresh-lead conversion drop after cutover.** If you do, set `COUNTER_CADENCE_TEXT_2_DELAY_MS=3600000` (1hr) in the parallel env and restart.

---

## 6. Logics status check cron

Old monolith runs `runStatusCheck()` every 15 min (webhook.js:1606). Parallel equivalent is in the hourly sweeper.

**Verify:** parallel app's hourly sweeper is alive and the `paymentReconcile / dncRecheck / fillerPoolRefresh / calllogBridge` Phase A entries fire on schedule. Tail the sweeper log for one full hour after cutover.

---

## 7. Final pre-flight checks

Before you actually flip off the old monolith:

- [ ] `pm2 list` (or whatever process manager) shows parallel apps RUNNING
- [ ] Parallel `inbound-gateway` (4001), `control-plane` (6100), `outbound-gateway` (6101) all return 200 on `/health`
- [ ] `MONGO_URI` matches between old `.env` and parallel `.env` so they're talking to the same Atlas cluster
- [ ] `LEAD_WEBHOOK_SECRET` matches
- [ ] At least one full hourly sweep cycle has run on the parallel app since the latest restart (logs show Phase A + Phase B completing)
- [ ] No `[FORWARD-LD] ✗ FAILED` errors in old monolith logs over the last 24h (means parallel is consistently reachable)
- [ ] Vincent (caseId 112285) is in parallel `LeadCadence`, `currentStage="legacy-cadence-active"`, `active=true`, `channelDnc.rvm.blocked=true`

---

## 8. Shutdown sequence

When all checks pass:

1. Stop accepting new vendor traffic on the old monolith — the easiest way is to flip `FORWARD_LD_TO_NEW_GATEWAY` off temporarily so vendor sees timeouts, OR repoint vendor URL to parallel directly. (Skip this if confident the forwarder has been working.)
2. Drain the queue: wait until old monolith's `[QUEUE]` log goes quiet for 5+ minutes. The queue paces leads at `QUEUE_PACE_MS=2500` so a queue of 10 takes 25s to drain.
3. Confirm no in-flight RVMs reference the old hostname (drop.co dashboard — check pending deliveries).
4. Stop the old monolith process (`pm2 stop webhook` or equivalent).
5. Don't delete the codebase yet — keep it for one week as a rollback option.

---

## 9. Rollback plan (if cutover goes sideways)

The forwarder is bidirectional in spirit — flip it OFF and the old monolith's pipeline runs locally again:

```bash
# in TagContactBridge/.env
FORWARD_LD_TO_NEW_GATEWAY=false
```

Restart old monolith. LD vendor traffic now runs the legacy `processLead` pipeline. You're back to pre-cutover state.

This works as long as you haven't deleted the old codebase. Keep it on disk for 7-14 days post-cutover.

---

## What's NOT in scope for this checklist

- **PB OAuth callback migration** — defer until PB phase-out
- **Vendor URL changes** — done by ops, not via this doc
- **DNS / ngrok tunnel changes** — environment-specific
- **Filler-fallback in CX queue render** — pending feature, doesn't block cutover
