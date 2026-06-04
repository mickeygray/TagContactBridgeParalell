# AWS Migration Readiness & Belt-Tightening Audit

**Date:** 2026-06-01 PT
**Author:** Claude (Opus) — first-pass code audit
**Target:** Lift the stack off the single Linux/NSSM-style box onto AWS (ECS/containers) within ~30 days.
**Scope:** Statefulness / horizontal-scaling blockers, local-filesystem & binary dependencies, config/secrets/networking, and dead-code / modernization phase-outs.

> **Read this alongside, not instead of:** `docs/LINUX_HEAVY_WORKER_MIGRATION_PLAN.md` (front-door vs enrichment-worker split, per-lane run locks) and `docs/CRON_MIGRATION_BOARD.md` (route-by-route cutover order). Those already capture the worker-split and cron-cutover thinking well. This doc focuses on the **code changes** that have to land for any of that to be safe on AWS, plus general cleanup.

---

## TL;DR — priority matrix

| # | Item | Why it matters for AWS | Priority |
|---|------|------------------------|----------|
| 1 | Scheduled workers have **no distributed lock** | Run >1 task → every cron double-fires (double dials/emails/charges, RC 429s) | **P0** |
| 2 | Inter-service calls hardcode `127.0.0.1`; `bindHost` defaults to loopback | Separate containers can't reach each other on loopback | **P0** |
| 3 | RVM audio + SPA build served from **local disk**; ngrok is the webhook front door | Ephemeral/unshared container disk; single tunnel can't fan out | **P0** |
| 4 | Secrets live in one flat `.env` | No Secrets Manager/SSM integration; plaintext file moved by hand | **P0** |
| 5 | No `Dockerfile` / `engines` / `.nvmrc` | Containerization is greenfield; Node version unpinned | **P0** |
| 6 | In-memory rate limiter; RC platform token in memory | Weaker/divergent across tasks; concurrent token refresh hazard | **P1** |
| 7 | Recording staging & transcription scratch on local disk | Orphaned bytes if a task dies mid-flight | **P1** |
| 8 | `HEALTH_TOKEN` would 401 an ALB health check | Health checks fail if token is set | **P1** |
| 9 | Dead code, dialer phase-outs, legacy-read fallbacks | Belt-tightening; shrink surface before lift | **P2** |
| 10 | No lint/format, no wired `npm test`, untyped backend | Quality floor before a high-stakes migration | **P2** |

---

## What's already in good shape (do **not** churn these)

Worth stating up front so we don't "fix" things that are correct:

- **Event-queue claim is atomically multi-instance-safe.** `packages/event-core/src/services/eventService.js:63` claims via `findOneAndUpdate({ status: {$in:[PENDING,FAILED,REPLAYED]}, nextAttemptAt:{$lte:now} }, { $set:{status:PROCESSING}, $inc:{attemptCount} })`. Two workers cannot grab the same event — so the **batch drain** half of every worker scales horizontally fine. (It's the *periodic sweep* half that doesn't — see P0 #1.)
- **SIGTERM is handled** (what ECS sends): `packages/shared-runtime/src/serviceRuntime.js:58` registers `["SIGINT","SIGTERM"]`, runs cleanups, disconnects Mongo, exits 0.
- **Logging is already stdout/stderr JSON** (`packages/shared-observability/src/logger.js`) — CloudWatch captures it with zero changes. The per-service log files mentioned in the handoff are NSSM redirecting stdout, not the app writing files.
- **Per-agent RingCX tokens are persisted** to Mongo (`cxTokenStorageService` → `userAccount.cxSession.bearerEnc`). Only the *app-wide* RC platform token is in-memory (P1 #6b).
- **A correct distributed-lock primitive already exists** — `packages/shared-models/src/RunLock.js` + `runLockRepository.acquireRunLock` (atomic `findOneAndUpdate` + TTL). The problem is only one service uses it (see P0 #1).
- **Graceful worker drain** — every app blocks shutdown ≤25s for in-flight ticks to avoid partial writes.

---

## P0 — Blockers (must land before or at cutover)

### 1. Scheduled workers have no leader election → they double-fire on >1 instance

The single most important finding. A correct lock primitive exists and is **proven in one place** (`packages/shared-services/src/caseProfilePaymentSyncService.js:520` uses `acquireRunLock`). But:

- **Zero usages of `RunLock`/`acquireRunLock`/`runLockRepository` anywhere under `apps/`** (verified by grep).
- Every `setInterval`/`setTimeout` scheduled job guards only with an in-process `workerState.running` / `state.running` boolean, which means nothing across instances:
  - control-plane: hourly sweep `apps/control-plane/src/server.js:631`, CX recording `:729`, plus the runtime schedulers (nightly close, lexis nightly/daily, EOD archive, logics review, phoneburner rotation, demo ringout, blogger) — all guard on `state.running` only.
  - ringcentral-cx: subscription watchdog `:403`, cadence worker `:633`, fresh-hot lane `:728`, pacing hourly/tick/morning `:830/:865/:930`, stale-dial sweep `:976`, agent monitor `:1014`.
  - outbound-gateway: cadence sweep / counter-cadence / scheduled blasts / Drop polling inside the worker tick `apps/outbound-gateway/src/server.js:184`.

**Risk:** two ECS tasks each fire nightly-close, pacing, cadence, recording downloads, spend-sync → duplicate sends/dials/charges, duplicate ops emails, and RC auth rate-limit exhaustion (we already saw a 429 cascade on 2026-05-13 from *two hosts* sharing one RC token).

**Direction (pick one, ideally both layered):**
- **(a) Wrap every scheduled tick in `acquireRunLock(jobName, ttlMs)`** using the existing `caseProfilePaymentSyncService` pattern. Cheapest correctness win; lets request-serving stay at N replicas.
- **(b) Split a dedicated single-replica "scheduler/worker" service** (ECS `desiredCount: 1`) that owns all timers, with request-serving services at N≥2. This is exactly the front-door-vs-enrichment split already drafted in `LINUX_HEAVY_WORKER_MIGRATION_PLAN.md` — adopt it, and still add (a) as defense-in-depth so a deploy overlap doesn't double-fire.

This is the gating decision for whether any service can run >1 replica on day one.

### 2. Loopback inter-service networking + `bindHost` defaults to `127.0.0.1`

- `buildServiceProxy` hardcodes `http://127.0.0.1:${port}` (`apps/control-plane/src/server.js:346`). Other hardcoded loopback callers: `controlPlaneRelayService.js:8`, `callLogService.js:481`, `cxWorkspaceService.js:6125` & `:6312`. Only `controlPlaneBaseUrl` is env-driven (`shared-config/src/index.js:356`).
- `bindHost` defaults to `127.0.0.1` (`shared-config/src/index.js:244-247`); used by all four `app.listen(...)` calls.

**Risk:** in separate containers/tasks nothing is on loopback; the control-plane proxy and the relay calls fail.

**Direction:** make every cross-service base URL env-driven (ECS Service Connect / Cloud Map DNS or internal ALB), and set `SERVICE_BIND_HOST=0.0.0.0` in the task def. Replace the remaining `127.0.0.1` literals with a `getServiceBaseUrl(serviceName)` helper in shared-config so there's one place to point at service discovery.

### 3. Local-disk assets + ngrok ingress

- **RVM audio** is static-served from `runtime/audio/<DOMAIN>/*.wav` on local disk and the files are **not in source control** (`apps/inbound-gateway/src/server.js:476-493`). drop.co fetches them at delivery via `RVM_AUDIO_BASE_URL`. On containers some tasks 404 the audio → silent ringless-voicemail failures. → **Move WAVs to S3 (+ CloudFront) and point `RVM_AUDIO_BASE_URL` there.**
- **SPA build** served from `apps/web-client/build` on local disk (`apps/control-plane/src/server.js:412`). → **Build during `docker build` (multi-stage) so `build/` ships in the image**, or serve from S3/CloudFront.
- **ngrok is the production webhook front door** — `webhookBaseUrl` defaults to `NGROK_DOMAIN` (`shared-config/src/ringCentralConfig.js:17`), consumed by RC subscription registration (`ringcentral-cx/src/server.js:393`, `hourlyJobHandlers.js:535`) and CX OAuth redirect (`cxOAuthService.js:34`). A single reserved tunnel can't fan out to multiple tasks. → **Replace with an ALB/API Gateway**; set the webhook base URL to the ALB DNS; ngrok scripts become dev-only. (Unrelated to migration: the RingCX `interaction-metadata` 403 is a **vendor provisioning gap** — recording SKU not enabled on RC account `50810000`, per `ops/ringcx-support-ticket.md` — not an OS/permission issue. It returns 403 from any host and does not gate the move.)

### 4. Secrets in a single flat `.env`

- One `dotenv.config()` for the whole monorepo (`shared-config/src/index.js:15`); ~760 distinct env vars, ~100 secret-named (`MONGO_URI`, `JWT_SECRET` — **defaults to literal `"change-me"`**, `INTERNAL_SERVICE_SECRET`, `CX_TOKEN_ENCRYPTION_KEY`, `FIELD_ENCRYPTION_KEY`, `RECORDING_PLAYBACK_SIGNING_SECRET`, RC/Anthropic/OpenAI/Google/CallRail keys, etc.).
- **Good news:** non-empty real env overrides `.env` values (empty shell vars are deleted so file wins — `index.js:12-14`), so **ECS task env/secret injection works with no code change.** The gap is operational: secrets shouldn't live in a plaintext file copied by hand.

**Direction:** move secrets to AWS Secrets Manager / SSM Parameter Store, inject via ECS task `secrets`. Split true secrets from plain config. Fail-fast if `JWT_SECRET === "change-me"` in production (add to the existing strict-startup validation).

### 5. No container/runtime pinning

- **No `Dockerfile`, `.dockerignore`, compose, or ECS config** anywhere in the repo.
- **No `engines` field and no `.nvmrc`** in any manifest. Code requires Node 18+ (global `fetch`, no `node-fetch` import; `node:test`). README says Node 22.

**Direction:** add `engines.node` + `.nvmrc` (pin to 22 LTS). Write a multi-stage Dockerfile that does a **clean `npm ci` on Linux** — do **not** copy the Windows `node_modules` (it contains `@rollup/rollup-win32-*` and Windows builds of `ffmpeg-static`/`7zip-bin`; the platform binaries must be re-fetched for Linux). One image, entrypoint selected by `SERVICE_NAME`, is simplest given the shared-package layout.

---

## P1 — Fix during stabilization (right after cutover, or before going multi-replica)

### 6. Per-process state that diverges across instances

- **a) In-memory rate limiter** — `apps/control-plane/src/middleware/rateLimit.js:22` is a process-local `Map` (header comment explicitly assumes a single process). Used by inbound-gateway too. With N tasks, OTP/brute-force protection is N× weaker and resets every deploy. → Back it with a Mongo TTL doc or Redis (ElastiCache).
- **b) RC platform token in memory** — `packages/shared-integrations/src/ringcentralClient.js:21-40` holds `tokenState`/`authState`/`refreshTimer` as module-level `let`; never persisted. Multiple instances authenticate independently and run their own refresh timers → concurrent refreshes invalidate each other (the 429 hazard again). → Persist the platform token to Mongo; single-flight refresh behind a RunLock. (Lower urgency if the scheduler/worker split in P0 #1(b) means only one instance does RC work.)
- **c) Other module-level caches** that diverge or lose correctness across instances: fresh-hot-lane snapshot + allocator guard (`cxFreshHotLaneService.js:13-20`), RingCX voice backoff/throttle state (`ringcxVoiceClient.js:117-122` — per-process backoff means combined call rate can exceed RingCX limits), alert dedup (`rateLimitAlertService.js:14` → duplicate alert spam). → Treat lane snapshot + RC voice backoff as shared state, or pin those surfaces to the single worker replica. Mailer template/transport caches (`mailerService.js:38`) are idempotent — leave them.

### 7. Ephemeral-disk staging for recordings/transcription

- Recording archive stages bytes to a per-machine root then uploads to Google Drive (canonical) and deletes (`recordingStorageService.js:49-75`, write at `:231`). A task killed between download and Drive upload orphans bytes no other instance can finish. → Point the staging dir at `os.tmpdir()` and treat it as throwaway; rely on Drive (already network-based) as canonical.
- Transcription writes downloaded audio to `os.tmpdir()/parallel-recordings` then reads it back for Whisper (`transcriptionScoringService.js:55,147,179`) — works in a container but no visible cleanup → fills disk on a long-lived task. → Stream the in-memory buffer straight to the Whisper `Blob` (`:177`) and skip disk; if kept, unlink after use.
- ffmpeg (`ffmpeg-static`) and Lexis 7zip (`7zip-bin`) both already pipe via stdio / tmpdir and are **container-safe on Linux** — just ensure the Linux binaries are installed via the clean `npm ci` (P0 #5), not copied from Windows.

### 8. `HEALTH_TOKEN` will 401 an ALB health check

`buildHealthAccessMiddleware` (`packages/shared-utils/src/security.js`) returns **401 if `HEALTH_TOKEN` is set** and the caller lacks `x-health-token`. ALB/ECS health checks can't send that header. → Either leave `HEALTH_TOKEN` unset (the public payload is already fast and safe), or add an unauthenticated `/healthz` purely for the load balancer and keep the detailed `/health` token-gated. Note `REQUIRE_HEALTH_TOKEN` throws at startup if the token is missing (`shared-config/src/index.js:1483`) — reconcile that with the ALB needs.

### 9. Verify HTTP connection draining on SIGTERM

SIGTERM handling is solid, but confirm each `server.js` registers a `server.close()` cleanup so in-flight requests drain rather than getting cut. control-plane does (`registerCleanup("control-plane-server", ...)`); spot-check inbound/outbound/ringcentral-cx do the same.

---

## P2 — Belt-tightening, phase-outs, modernization (the general cleanup ask)

### Dead code — safe to remove (verify zero refs first)
- `packages/shared-services/src/legacyClientService.js` — **zero references** anywhere. Phase-out candidate.
- `packages/shared-services/src/legacyLeadCadenceService.js` — **zero references** (the `scripts/inspect-legacy-leadcadence.js` probe does not import it). Phase-out candidate.
- **Caution:** the *other* `legacy*` services are **actively used** as bridges to the old-monolith Mongo (`legacyContactActivityService`, `legacyMetricsService`, `legacyMetricsMirrorService`, `legacyAttributionSyncService`, `legacyNightlyDataService`). "legacy" in the name ≠ dead. Don't touch these until the v2 DB is fully retired.

### Dialer phase-out (PhoneBurner / CallFire → RingCX)
- `phoneburnerRotationRuntime` (control-plane) is **wired but gated OFF** (`PHONEBURNER_ROTATION_ENABLED` default false) and shells out to the *old monolith's* rotation script. Clean removal once PhoneBurner is fully cut — and one fewer cross-process dependency to containerize.
- `outboundCallFireService` and `outboundPhoneBurnerService` are **used but deprecated** — CallFire is the most-wired, with ~10 `channel === "callfire"` branches in `outboundDispatchService.js` (:1186, :1520, :1700, :1847…). Removing them is a focused refactor of that one file. Worth doing pre-migration to shrink the dispatch surface, but only after confirming RingCX covers every path they handle.

### Legacy-read fallback flags — retire post-cutover
A cluster of `*_LEGACY_READS_ENABLED` / `FRONTEND_LEGACY_*_FALLBACK_ENABLED` flags (all default false) exist purely as old-monolith fallbacks (`CASE_PROFILE_LEGACY_READS_ENABLED`, `CALL_LOG_LEGACY_READS_ENABLED`, `LEAD_CADENCE_LEGACY_READS_ENABLED`, `METRICS_DEDUP_LEGACY_READS_ENABLED`, etc.). Once the v2 DB is decommissioned, delete the flags and the branches behind them — this is concrete "make it definite" cleanup.

### Quality floor (cheap, high-leverage before a risky migration)
- **No linter/formatter** — no eslint/prettier config exists, yet `apps/web-client/package.json:11` declares a `lint` script with no eslint installed (it will fail). → Either install+configure eslint (flat config) or drop the dead script. Recommend adding a minimal eslint + prettier at the root for the backend `.js` too.
- **Tests aren't wired** — 20 `*.test.js` under `tests/{auth,cadence,queue}` use `node:test` but there's **no `npm test`**; `npm run smoke` is only `node --check` syntax validation of the four `server.js` files. → Add `"test": "node --test"` and run it in CI before every deploy. A migration is exactly when you want a green test gate.
- **Backend is untyped JS, web-client is TS.** Not worth converting now, but consider `// @ts-check` + JSDoc on the highest-risk shared-services (dispatch, dial, cadence) for cheap type safety.
- **OpenAI access is hand-rolled raw `fetch`/`WebSocket`** across 8 scripts (no `openai` dependency) while Anthropic uses the SDK. → If the live-trainer work continues, standardize on a thin shared OpenAI client so model IDs / auth / retries live in one place.

### TODOs worth making concrete
Density is low (good), but a few are load-bearing:
- `cxCadenceService.js:2135` — `TODO(ld-campaign-queue-feed)` producer side incomplete.
- `dialService.js:2229` — `TODO(next PR)` inbound lead correlation by from-number.
- `inboundIntakeService.js:274` — `TODO(ld-queue-split)` routing.

---

## Suggested sequencing (maps onto the existing migration docs)

1. **Pre-work (now → 2 weeks):** add `engines`/`.nvmrc` + Dockerfile (clean Linux `npm ci`); wire `npm test` + a lint pass; add `acquireRunLock` around every scheduled tick (P0 #1a). These are code-only, shippable on the current box with zero behavior change, and de-risk everything after.
2. **Networking & config:** env-drive all cross-service URLs + `SERVICE_BIND_HOST=0.0.0.0`; move secrets to SSM/Secrets Manager; fail-fast on `change-me` JWT.
3. **Assets:** WAVs → S3, SPA build into the image, stand up the ALB and repoint webhook base URL off ngrok.
4. **Cutover:** deploy scheduler/worker as single-replica, front-door services behind the ALB; follow the cron-cutover order in `CRON_MIGRATION_BOARD.md`.
5. **Post-cutover hardening:** shared rate limiter + RC token persistence (P1 #6), tmpdir-only recording staging (P1 #7), then retire legacy-read flags and dead dialers (P2).

---

## Open questions for you

1. **Replica model:** single-replica scheduler + N front-door tasks (the LINUX plan's split), or everything single-replica at first and scale later? This decides how hard P0 #1 / #6 are on day one.
2. **One image or per-service images?** The shared-package layout favors one image with `SERVICE_NAME` selecting the entrypoint — agree?
3. **Redis/ElastiCache in scope?** It's the clean home for the rate limiter and shared backoff state, but adds an AWS dependency. Mongo-TTL fallback works if you'd rather not.
4. ~~RingCX `interaction-metadata` 403-from-Linux~~ — **resolved as a non-issue.** It's a RingCX vendor provisioning gap (recording SKU not enabled on account `50810000`), not OS-specific and not a migration blocker. Pipeline is wired behind `RINGCX_RECORDING_ENABLED`; flip the flag when RC provisions.
5. **PhoneBurner/CallFire:** confirmed fully replaced by RingCX, or still needed for any tenant/path? Determines whether P2 dialer removal is in-scope this month.
