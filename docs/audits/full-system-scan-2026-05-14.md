# Full System Scan - TagContactBridgeParalell

Scanned from `C:\code\TagContactBridgeParalell` on the current Windows host during the May 14 cutover window. I avoided printing secrets and did not change application code. This report is meant to be the morning triage list.

## Executive Read

The repo itself is in decent mechanical shape: smoke checks pass, the web app builds, JavaScript syntax checks pass, and npm audit reports zero vulnerabilities. The weak spots are operational state and configuration: the live control-plane worker is disabled, strict production validation is effectively off, detailed health is available without a token, `.env` has many duplicate keys, and several "tomorrow" jobs are configured one way on disk but not active in the running services.

The single biggest thing to fix before trusting inbound SMS or Opus first-line behavior is the control-plane worker. Right now new `sms.inbound.forwarded`, lead, metric, and review events can sit pending instead of being processed.

## What Passed

- `npm.cmd run smoke` passed.
- `npm.cmd run build:web` passed (`tsc --noEmit` plus Vite build).
- `npm.cmd audit --omit=dev --json` found 0 vulnerabilities.
- `npm.cmd audit --json` found 0 vulnerabilities.
- Node syntax check over `apps`, `packages`, `scripts`, and `tests` passed.
- `git diff --check` reported line-ending warnings only, no whitespace errors.
- Live services answering locally:
  - `control-plane` on 5001
  - `inbound-gateway` on 4001
  - `outbound-gateway` on 4002
  - `ringcentral-cx` on 6101
- RingCentral platform auth is currently healthy and token-fresh on the 6101 health endpoint.

## Immediate Morning Fixes

### P0 - Control-plane event worker is disabled

Live `/health` reports `workers.controlPlane.enabled=false`. Current parsed config also shows `CONTROL_PLANE_WORKER_ENABLED=false`.

Impact:
- `/sms/inbound` only writes an `sms.inbound.forwarded` event. The AI classifier, inbox row, SMS auto-response, DNC side effects, and alert email happen later in the event worker.
- With the worker disabled, new inbound SMS can be accepted and acknowledged but not acted on.
- The same applies to some lead, metric, and review events.

Observed actionable backlog for event types the worker knows how to process:

| Event type | Pending |
| --- | ---: |
| `control-plane.review-item.observed` | 24 |
| `control-plane.metric.observed` | 13 |
| `control-plane.lead.observed` | 13 |
| `sms.inbound.forwarded` | 2 |

Recommended:
- Set `CONTROL_PLANE_WORKER_ENABLED=true`.
- Restart `ParallelControlPlane` elevated.
- Watch `/health` for `workers.controlPlane.enabled=true` and `lastCompletedAt`.
- Re-check the actionable pending counts until they drain.

### P0 - Live runtime is non-strict and health is detailed without a token

The current live health endpoint returned full detailed runtime state without `x-health-token`. Local config also resolves:

- `NODE_ENV=development` in the shell context
- `startupValidation.strict=false`
- `requireHealthToken=false`
- `jwtSecretLooksDefault=true`

Even if NSSM sets `NODE_ENV=production`, the live health behavior means strict runtime is effectively off or health token enforcement is absent.

Impact:
- If `/health` is reachable through nginx/ngrok, it leaks service names, runtime flags, recipient-like config, partial phone data, worker state, and infrastructure detail.
- Strict startup validation is not protecting against default JWT secret, OTP preview mistakes, missing senders, or missing health token.

Recommended:
- Clean duplicate `.env` keys first, then set:
  - `NODE_ENV=production`
  - `STRICT_STARTUP_VALIDATION=true`
  - `REQUIRE_HEALTH_TOKEN=true`
  - `HEALTH_TOKEN=<strong random token>`
  - a real non-default `JWT_SECRET`
- Restart all services and verify unauthenticated `/health` returns only the public minimal payload or 401 where intended.
- Consider blocking `/health` at nginx except from localhost/VPN/admin tooling.

### P0 - `.env` duplicate keys make runtime state unreliable

`.env.example` has no duplicate keys. The real `.env` has many duplicates. The important duplicates include:

- `NODE_ENV`
- `JWT_SECRET`
- `NGROK_DOMAIN`
- `WEB_CLIENT_ORIGINS`
- `STRICT_STARTUP_VALIDATION`
- `LEXIS_DAILY_DROP_ENABLED`
- `LEXIS_NIGHTLY_ENABLED`
- `HOURLY_SPEND_SYNC_ENABLED`
- `NIGHTLY_CLOSE_ENABLED`
- `RINGCX_AGENT_MONITOR_ENABLED`
- `RCX_STALE_DIAL_SWEEP_ENABLED`
- `DEMO_RINGOUT_ENABLED`
- `PARALLEL_RC_SUSPENDED`

Impact:
- The last occurrence silently wins.
- This already bit Lexis: the file-level intent and the live service state diverged.
- It makes cutover scripts hard to reason about because "I changed the key" may mean "I changed the earlier copy, but the later copy still wins."

Recommended:
- Normalize `.env` to one key per name.
- Add a startup duplicate-key scanner in `packages/shared-config/src` so strict mode refuses to boot with duplicates.
- Keep `.env.example` as the canonical shape and use a separate private runbook for host-specific values.

### P1 - Lexis local cron is not active in the running service

Earlier Lexis review found no AWS/S3/Transfer Family dependency for the daily drop path. The path is direct SFTP plus local unzip plus SendGrid plus Mongo workflow records.

Current shell config resolves `lexisDailyDrop.enabled=true`, but live `ParallelControlPlane` health still reports:

- `lexisDailyDrop.enabled=false`
- `lexisNightly.enabled=false`

Impact:
- The intended local Lexis daily drop will not fire until the service loads the cleaned config.

Recommended:
- Clean duplicate env keys.
- Restart `ParallelControlPlane` elevated.
- Re-check `/health` for `runtimes.lexisDailyDrop.enabled=true`.
- Run a dry/preflight/manual Lexis command if one exists before relying on the 2am run.

### P1 - Blogger is not installed as a service and deploy PEMs are missing

From the earlier blogger scan:

- `ParallelBlogger` is not installed/running.
- No scheduled task was found.
- Sales repos exist at `C:\code\WynnTax` and `C:\code\taxadvocategroup`, are clean, have dependencies, and builds passed.
- Blogger preflight fails on missing PEM files:
  - `.ssh\wynntax2.pem`
  - `.ssh\tag.pem`
- Current-event generation timed out in testing; fallback static draft path works.

Impact:
- It will not attempt tomorrow's run unless the service/schedule is installed and the PEMs are restored.
- Even after install, deploy cannot complete without the private keys.

Recommended:
- Recover the PEMs from the old machine or GitHub Actions secrets source.
- Run `scripts\blogger-daily-runner.js --preflight`.
- Install/start `ParallelBlogger` after the keys are present.
- Treat current-event timeout as a reliability issue, not a blocker, because fallback draft generation works.

### P1 - SMS/Opus action routing is partially implemented, not fully queue-backed

The new prompt and tool schema are in `packages/shared-services/src/smsClassifierService.js`, and the default classifier model is `claude-opus-4-6`.

Good:
- The tool schema includes `soft_defer`, `prospect_state`, `callback_window`, hot intent fields, and required fields.
- AI auto-send validates the 320-char limit and required suffix.
- Auto-routing happens only after a successful SMS send.
- DNC audit rows are created before attempting Logics DNC.
- DNC idempotency exists against the local `CaseProfile` status/category.

Gaps:
- The code still uses regex fast paths that can return `dnc_confirm` before Opus is called. That contradicts the prompt's "always call classify_sms tool" discipline and means permanent DNC can be triggered by regex for cases like wrong number, represented, or resolved.
- "Queue a callback" currently means stamp/routing in `ConversationWorkflow` via `autoRouteHotInboundWorkflow`; it does not create an actual CX callback queue item. The source comment says universal-queue insertion is "NOT done yet."
- Daily DNC digest is not implemented.
- The Logics DNC idempotency check is local-cache based. If Logics is already DNC but local `CaseProfile` is stale, the code can still call Logics again.
- `SMS_AUTO_RESPOND_HOT_INTENT` exists as a helper but is unused, so that env flag currently controls nothing.

Recommended:
- Decide whether regex can ever fire lead-wide DNC. My recommendation: leave regex for hard STOP/noise/hostile safety only, and require Opus for `dnc_confirm`.
- Add actual queue insertion for `callback_prompt` and `soft_defer + callback_window`, or rename the current behavior to "route to inbox owner" so the UI/ops language is honest.
- Add the daily DNC digest from `dnc_audit`.
- Add a live Logics status check before DNC update when case ID is known.
- Add tests for classifier contract violations, missing suffix, over-length reply, DNC audit-before-Logics, and callback routing.

## Operational Hardening Findings

### Event queue contains thousands of long-lived pending events

The event table contains many pending records for event types that are not in the control-plane handler map or appear to be passive/audit-only. Top examples observed:

| Event type | Pending |
| --- | ---: |
| `ringcentral.ex.poll.reconciled` | 3975 |
| `calllog.transcription-pending` | 1057 |
| `attribution.retry-pending` | 883 |
| `attribution.case-binding-missing` | 789 |
| `ringcentral.ex.call.ended` | 591 |
| `inbound.lead.received` | 323 |

Impact:
- The queue looks unhealthy even when those rows may be intentionally passive.
- Mongo grows with records that never transition.
- Backlog dashboards become noisy and hide real blocked work.

Recommended:
- Split event journal vs work queue, or add no-op handlers/TTL/archive policies for audit-only events.
- Make backlog checks count only event types with active handlers.

### Local Mongo service is running but the app is connected to Atlas

`ParallelMongo` is running locally, but live service health shows the app connected to the Atlas `tagcontactbridge_parallel` database.

Impact:
- Copying or backing up `runtime\mongodb-data` does not capture the live app database.
- The local Mongo service can confuse migration work and cause locked-file copy errors even if it is not serving the active app.

Recommended:
- Decide explicitly: Atlas-only or local Mongo.
- If Atlas-only, document that and consider disabling `ParallelMongo`.
- If local is intended for offline fallback, add a clear health banner showing active DB source.

### Ngrok is running but Manual start

`ParallelNgrok` is running now, but `StartType=Manual`. `ParallelRestartHelper` is also stopped/manual.

Impact:
- After reboot, the app services can come back while the public ngrok URL does not.

Recommended:
- If this Windows host is expected to recover unattended, make `ParallelNgrok` automatic or make the restart helper automatic and prove it starts ngrok.
- If ngrok is intentionally manual during cutover, document the reboot recovery step.

### Many production lanes are currently disabled

Live health currently shows these disabled:

- Control-plane worker
- Hourly sweep
- Hourly spend sync
- Metrics refresh
- Call-log hygiene
- Lexis daily drop
- Lexis nightly
- Nightly close
- EOD recording archive
- Outbound worker
- Scheduled blasts
- RingCentral subscription watchdog
- Fresh hot lane
- Stale dial sweep
- RingCX agent monitor

Some of this may be intentional during cutover, but it should be an explicit checklist. The dangerous ones for "app appears up but does not do the work" are control-plane worker, Lexis daily drop, nightly close, RingCX agent monitor, and stale dial sweep.

## Linux Migration Risks

### Scheduler timezone math depends on host local timezone in several places

Several runtime schedulers accept `timezone: "America/Los_Angeles"` but compute the target run time with local `Date` construction or `setHours`. This is safe-ish on a Windows host whose OS timezone is Pacific, but wrong on an Ubuntu host left at UTC.

Files of interest:

- `apps/control-plane/src/services/lexisNightlyService.js`
- `apps/control-plane/src/services/lexisDailyDropRuntime.js` via the Lexis helper
- `apps/control-plane/src/services/nightlyCloseRuntime.js`
- `apps/control-plane/src/services/eodRecordingArchiveRuntime.js`
- `apps/control-plane/src/services/phoneburnerRotationRuntime.js`

Impact:
- A 2am PT Lexis job can become 2am UTC on Linux.
- Nightly close/EOD jobs can run hours early.

Recommended:
- Either set Ubuntu system timezone to `America/Los_Angeles` as a short-term guard, or patch these schedulers to convert IANA wall-clock times to UTC the same way `spendSyncService` and `demoRingoutRuntime` already do.

### Windows-only service scripts are still prominent

Expected for this host, but not portable:

- `ops/nssm/*`
- `ops/windows/*`
- `ops/cutover/*`
- `ops/nssm/control-plane.cmd` hardcodes `C:\Users\Admin\Code\TagContactBridgeParallel`
- `ops/nssm/install-restart-helper.ps1` still hardcodes old Admin paths
- `phoneburnerRotation.legacyScriptPath` resolves to a Windows path by default

The Node app is mostly cross-platform, but service management, nginx, Mongo, and bootstrap need the `ops/linux` path on Ubuntu.

Recommended:
- Treat Windows NSSM and Ubuntu systemd/nginx as separate deployment targets.
- Do not reuse `ops/nssm/*.cmd` on Linux.
- Add a Linux smoke script that checks Node, npm, env, Mongo/Atlas, nginx, systemd units, and ngrok/cloudflared/real DNS.

## Code Quality And Dead-code Notes

### Web lint script is dead

`apps/web-client/package.json` defines:

```json
"lint": "eslint src --ext .ts,.tsx"
```

But no `eslint` dependency/config exists in `package.json`, `package-lock.json`, or the workspace package. Running `npm.cmd run lint --workspace=web-client` fails with `eslint` not found.

Recommended:
- Either add ESLint/config and make it real, or remove the script so CI/readiness docs do not imply coverage that is not there.

### Anthropic timeout env is documented but not wired

`packages/shared-integrations/src/anthropicClient.js` comments/docs mention an env timeout, but `getAnthropicConfig()` does not read `ANTHROPIC_TIMEOUT_MS`. Unless a caller passes `timeoutMs`, the effective timeout is always 25 seconds.

Recommended:
- Add `timeoutMs: Number(env("ANTHROPIC_TIMEOUT_MS", 25000))` to `getAnthropicConfig()`.
- For Opus SMS, consider a longer timeout or a very explicit fail-to-human path.

### Anthropic model fallback can silently downgrade the SMS classifier

The SMS classifier requests `SMS_CLASSIFIER_MODEL` or defaults to `claude-opus-4-6`. If Anthropic returns 404 for that model name, the shared client falls back through older models.

Impact:
- The logged `model` shows what actually ran, but behavior may not be Opus 4.6 even though config requested it.

Recommended:
- For safety-critical SMS/DNC triage, either fail to `needs_human` if the requested model is unavailable, or make the fallback list explicitly approved for this prompt.
- Run a live non-sending classifier smoke before go-live to confirm the requested model alias works.

### Social responder module starts a timer at import time

`packages/shared-services/src/socialResponderService.js` starts a cleanup `setInterval` at module load. Because `shared-services/src/index.js` exports it, services and scripts that import shared services inherit that background timer.

Impact:
- Low operational risk because the timer is unref'ed, but it is surprising in scripts/tests and makes imports less pure.

Recommended:
- Move the cleanup interval behind an explicit `startSocialResponderCleanup()` function, or document the side effect.

### Stale docs and paths remain

Many docs still point at `C:\Users\Admin\Code\...` and old EC2/key paths. This is not runtime-breaking, but it increases cutover mistakes.

Recommended:
- Add a short `docs/CURRENT_HOST_STATE.md` with the true repo path, service names, public URL ownership, active DB source, and "what starts on reboot."
- Update the top deployment docs after the Windows-to-`C:\code` move settles.

## Current Git State

The worktree is dirty with today's changes plus untracked ops/model files. I did not revert or clean anything.

Modified areas include:

- `.env.example`, `.gitignore`
- control-plane auth and inbox routes
- web-client inbox types/UI
- cutover and NSSM scripts
- RingCentral client
- conversation models/repositories
- SMS classifier and auto-responder services
- blogger pipeline

Untracked areas include:

- `ops/cutover/bring-online-and-go-live.ps1`
- `ops/linux/`
- `ops/nssm/run-nginx.ps1`
- `ops/windows/`
- DNC audit model/repository
- RingCX manual smoke script

Recommendation:
- Before committing, run a focused review on the SMS/DNC changes separately from ops relocation scripts. They are different risk classes.

## Suggested First-hour Order Tomorrow

1. Clean `.env` duplicates and turn strict production validation on.
2. Set/confirm non-default `JWT_SECRET`, `HEALTH_TOKEN`, and `REQUIRE_HEALTH_TOKEN=true`.
3. Enable `CONTROL_PLANE_WORKER_ENABLED=true`; elevated restart `ParallelControlPlane`.
4. Confirm actionable event backlog drains, especially `sms.inbound.forwarded`.
5. Confirm Lexis daily drop is enabled in live health after restart.
6. Decide whether ngrok should auto-start on reboot.
7. Restore blogger PEMs and install/start `ParallelBlogger` if tomorrow's run matters.
8. Patch or consciously accept the SMS/Opus gaps: regex DNC bypass, no real callback queue item, no DNC digest.
9. For Ubuntu, set the OS timezone to Pacific or patch scheduler wall-clock conversion before relying on nightly jobs.

## Commands Used

Key commands/checks run during this scan:

```powershell
git status --short
npm.cmd run smoke
npm.cmd run build:web
npm.cmd audit --omit=dev --json
npm.cmd audit --json
npm.cmd run lint --workspace=web-client
git diff --check
git diff --stat
Get-Service Parallel*
Invoke-RestMethod http://127.0.0.1:5001/health
Invoke-RestMethod http://127.0.0.1:4001/health
Invoke-RestMethod http://127.0.0.1:4002/health
Invoke-RestMethod http://127.0.0.1:6101/health
rg -n "CONTROL_PLANE_WORKER_ENABLED|SMS_CLASSIFIER_MODEL|computeNextRunAt|setInterval|STRICT_STARTUP_VALIDATION"
```
