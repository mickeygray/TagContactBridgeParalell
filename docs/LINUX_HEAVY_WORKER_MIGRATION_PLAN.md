# Linux Heavy Worker Migration Plan

## Purpose

Move the app toward a stable Linux production box without letting heavy API,
recording, transcription, or live-monitoring work threaten the core lead flow.

The first Linux milestone is uptime and correctness for the operational app:

- nginx and ngrok receive webhooks.
- control-plane serves the app/API.
- inbound and outbound gateways handle accepted lead flow.
- RingCX service handles CX queue/manual-dial integration.
- essential hourly jobs keep queue/state/metrics fresh.
- essential nightly jobs send operator summaries and close the day.
- Lexis daily drop and mailhouse flow run from the always-on side.
- Atlas remains the single state backbone.

Recording polling, recording downloads, transcription, live trainer audio,
blogging, and bulk backfills are deliberately treated as separate enrichment
workers. They can stay on Windows or any cheap worker host as long as they read
from and write back to Atlas correctly.

The dividing line is not "heavy" by itself. The dividing line is whether the app
is operationally wrong if the job misses a run.

- Operational correctness jobs belong in cloud/Linux production.
- Enrichment/backlog jobs can stay behind the office network.

## Current Linux Baseline

Observed on the Ubuntu box:

- `parallel-control-plane` is running.
- `parallel-inbound-gateway` is running.
- `parallel-outbound-gateway` is running.
- `parallel-ringcentral-cx` is running.
- `parallel-ngrok` is running and forwarding `https://tag-webhook.ngrok.app` to local nginx port `81`.
- nginx is running and passes config validation.
- `http://127.0.0.1:81/` serves the app shell.
- `http://127.0.0.1:81/api/client/runtime` returns the control-plane runtime heartbeat.
- `http://127.0.0.1:81/api/auth/me` correctly returns unauthenticated JSON without redirect confusion.

Intentional staging disables seen in logs while the box is being proven:

- control-plane worker disabled.
- hourly disabled.
- Lexis nightly/daily drop disabled.
- nightly close disabled.
- spend sync disabled.
- EOD recording archive disabled.

This is the right posture only during bring-up. Before cutover, the cloud box
needs a clean essential-hourly, essential-nightly, and Lexis lane enabled.

## Smoke Test Tooling

Use this script for heavy read/API confidence without production writes:

```bash
cd /opt/tagcontactbridge-parallel
sudo -n -u parallel env HOME=/home/parallel NODE_ENV=production \
  node scripts/linux-heavy-api-smoke.js \
  --domains TAG,WYNN \
  --limit 30 \
  --lookback-minutes 90 \
  --vendor-row-limit 2500 \
  --skip-ringcx-recordings
```

The smoke runner:

- connects to Atlas;
- installs a Mongo write guard;
- runs hourly-style call ledger previews;
- probes Logics read paths;
- probes RingCX read/list paths;
- builds the grouped nightly payload with email disabled, final close skipped,
  attribution refresh disabled, and payment ledger updates disabled;
- writes only local JSON receipts under `runtime/linux-heavy-api-smoke/`.

Known result:

- clean no-write smoke passes with `0` failures when recording metadata polling
  is skipped.
- RingCX recording metadata currently fails from Linux with `403 access.denied.exception`
  on `POST interaction-metadata`.

That permission issue should be resolved before any Linux recording worker is
enabled.

## Why Heavy Workers Stay Separate

The heavy jobs are not dangerous because Linux is weak. They are dangerous
because they are bursty, long-running, and API-rate-sensitive:

- RingCX recording metadata polling has a strict low rate limit.
- recording downloads can be large and slow.
- transcription and scoring are CPU, network, and vendor-API heavy.
- live trainer audio creates continuous streams and per-call state.
- Google Drive uploads/reorganization can run for a long time.
- retry loops can accidentally fan out if not locked.

The core app should not share fate with those jobs. If a recording worker gets
429s or spends 45 minutes backfilling audio, webhooks and lead serving should
remain boring.

## Target Service Split

Core Linux/cloud services:

- `parallel-control-plane`
- `parallel-inbound-gateway`
- `parallel-outbound-gateway`
- `parallel-ringcentral-cx`
- `parallel-ngrok`
- `nginx`

Cloud-required worker services:

- `parallel-light-hourly`
  - queue hygiene, queue/state freshness, lightweight metrics, accepted-lead
    health, unresolved-job reporting.
- `parallel-nightly-close`
  - nightly close email, financial summary, operational summary, postdate
    reporting once Linux is trusted.
- `parallel-lexis-drop`
  - Lexis daily file processing, receipt generation, and mailhouse path.

Optional/enrichment worker services:

- `parallel-recording-metadata-worker`
  - RingCX `interaction-metadata` polling only.
- `parallel-recording-archive-worker`
  - recording download, Drive upload, transcription, scoring.
- `parallel-live-trainer-worker`
  - EX/CX live monitoring, transcript stream, advice stream.
- `parallel-blogger-worker`
  - blog research/drafting/publishing support.

Windows can continue running enrichment workers indefinitely if that is cheaper
and more stable. Cloud should own the jobs that keep the live business state
accurate.

## Global Safety Rules

1. Atlas is the source of truth.
2. Every heavy job needs a durable job row and idempotency key.
3. Every heavy worker needs a run lock so Windows and Linux cannot process the
   same lane at the same time.
4. Workers must claim one unit of work before doing external API work.
5. External API failures must open a circuit breaker instead of retrying hot.
6. Recording/transcription workers must have strict concurrency caps.
7. Metadata polling should schedule future work; it should not download and
   transcribe inline.
8. No heavy worker should be required for accepted lead intake, webhooks, auth,
   queue serving, or manual dialing to work.
9. All worker enables should be env-gated and reversible by service restart.
10. Backfills run manually or under a separate backfill service, never inside
    the ordinary hourly loop.

## Recommended Rate Limits

Initial conservative defaults:

- RingCX recording metadata: 1 request every 180 seconds.
- RingCX recording downloads: 1 at a time.
- transcription uploads: 1 to 2 at a time.
- Claude/OpenAI scoring: 1 to 2 at a time.
- EX presence polling: 30 seconds or slower unless active call state requires
  a short focused window.
- active-calls polling: 10 to 30 seconds, with backoff on any 429/5xx.
- Google Drive upload: 1 to 2 files at a time.
- recording retry delay: at least 15 to 20 minutes after call end before first
  metadata/download attempt.

These can loosen after a week of clean logs.

## Migration Phases

### Phase 0: Prove Linux As The Front Door

Goal: Linux can receive traffic and serve the app without handling heavy work.

Checks:

- app shell loads over `tag-webhook.ngrok.app`;
- `/api/client/runtime` returns healthy runtime JSON;
- login works;
- accepted lead webhook smoke works;
- manual CX dial works;
- one app-driven queue lead lands correctly;
- services survive reboot;
- no scheduler unexpectedly starts hourly/nightly/recording jobs.

Exit criteria:

- one business day of stable lead flow;
- no unexpected service restarts;
- no unexplained 429 storms;
- no queue lockups caused by Linux-only behavior.

### Phase 1: Add Worker Locking And Visibility

Goal: make it safe for Windows and Linux to coexist.

Build or verify:

- one durable lock per worker lane;
- visible owner, acquiredAt, expiresAt, heartbeatAt;
- manual release command;
- lock timeout longer than expected unit of work;
- worker status endpoint or admin card;
- local receipt JSON plus Atlas status row for every run.

Suggested locks:

- `hourly-light`
- `nightly-close`
- `lexis-drop`
- `recording-metadata`
- `recording-archive`
- `live-trainer`
- `blogger`

Exit criteria:

- Windows can own a lane while Linux refuses to run it;
- Linux can own a lane while Windows refuses to run it;
- stale locks are visible and recoverable.

### Phase 2: Recording Metadata Worker

Goal: discover available RingCX recording metadata without downloading audio.

Prerequisites:

- RingCX `interaction-metadata` permission is fixed.
- Smoke probe succeeds without 403.
- Metadata requests are globally rate-limited.

Behavior:

- poll one completed window at a time;
- use 15 to 20 minute lag after call end;
- persist `dialogId`, `segmentId`, call timestamps, agent, phone, and case
  binding if available;
- create archive jobs for segments that look useful;
- never download media in this worker.

Exit criteria:

- 2 to 3 days of metadata discovery without 429 alerts;
- no duplicate archive jobs;
- metadata volume matches expected CX recording settings.

### Phase 3: Recording Archive Worker

Goal: download, store, transcribe, and score recordings in a capped queue.

Behavior:

- claim one archive job;
- download one segment;
- upload/store it;
- transcribe;
- score/summarize;
- update call/case transcript state;
- mark job completed.

Controls:

- concurrency 1 initially;
- pause flag;
- max calls per hour;
- max bytes per hour;
- 429 circuit breaker;
- failed jobs retry with increasing delay;
- permanent failures go to review, not hot retry.

Exit criteria:

- one small day runs successfully;
- no duplicate recordings;
- no Drive clutter;
- transcript playback links work;
- Windows worker can be paused without data loss.

### Phase 4: Live Trainer Worker

Goal: stream near-real-time transcript and advice without touching the core
lead-serving process.

Initial implementation:

- CX/manual dial remains controlled by the app.
- EX AI monitor leg is attached separately.
- live trainer worker receives mixed audio from the monitor path.
- transcript chunks are sent to the client by call/session id.
- advice runs on a slower cadence than transcription, usually once per minute
  or on detected sales moments.

Known limitation:

- EX supervision audio is a mixed leg. Speaker separation is heuristic unless
  RingCentral provides separate audio channels.

Controls:

- one live session per monitored call;
- hard timeout after call end;
- transcript chunks dedupe by timestamp/hash;
- advice stream cannot block transcription;
- client reconnect can resume from stored chunks.

Exit criteria:

- one agent test call shows transcript in the correct client;
- no bleed between agents;
- no runaway transcript loops;
- advice latency is acceptable;
- core CX lead serving remains responsive.

### Phase 5: Essential Hourly, Nightly, And Lexis Migration

Goal: move scheduled operational jobs to cloud after the front door is stable.
Do not wait for recording/transcription/blogging migration; those are separate
enrichment lanes.

Order:

1. split the current hourly runner into essential and enrichment substeps if
   needed;
2. essential hourly smoke with writes guarded;
3. essential hourly enabled in cloud with low cadence and visible receipts;
4. nightly close smoke with email disabled;
5. nightly close email to Mickey only;
6. nightly close real recipient pool;
7. Lexis smoke to Mickey only;
8. Lexis real file/mailhouse path;
9. Windows schedules disabled for the matching cloud-owned lanes after Linux
   completes the same job successfully.

Essential hourly candidates:

- queue freshness and stuck queue cleanup;
- accepted lead health checks;
- lightweight call/agent metrics needed by the app;
- unresolved event reporting and alerting;
- SMS/intake operational checks;
- service heartbeat/receipt writing.

Keep out of essential hourly:

- recording metadata polling;
- recording downloads;
- transcription/scoring;
- Drive archive work;
- historical backfills;
- blogging.

Essential nightly candidates:

- financial close and operator email;
- postdate/hold reporting;
- Lexis receipts and daily handoff checks;
- daily queue/agent stats needed by managers;
- sparse failure summaries.

Keep out of essential nightly:

- large recording backfills;
- transcript repair jobs;
- blog generation;
- heavy Drive reorganization;
- nonessential enrichment catch-up.

Exit criteria:

- two successful scheduled runs from Linux;
- Windows equivalent is off or lock-protected;
- recipients confirm expected emails/files.

## Rollback Plan

For each lane:

1. disable the Linux env flag or stop the Linux service;
2. verify the lock is released or expired;
3. resume the Windows worker;
4. check Atlas job rows for stuck `processing` items;
5. run the smoke script before re-enabling Linux.

The front-door services should not need rollback just because a heavy worker
is paused.

## Immediate Watch Items

- RingCX recording metadata permission is still blocked on Linux with 403.
- `parallel-ringcentral-cx` logs show repeated EX polling reconciliation for
  extension `63704036004` with `session_mismatch`; this needs review before
  relying on EX state as the only call-state source.
- Existing unresolved hourly jobs are visible in the nightly smoke payload;
  they should be cleaned or separately archived before nightly emails are
  judged by operators.
- `http://127.0.0.1:80/` is still the default nginx welcome page; active app
  traffic is on nginx port `81` behind `tag-webhook.ngrok.app`.

## Practical Recommendation

Keep Linux/cloud focused on:

- app serving;
- webhook intake;
- queue/manual-dial control;
- essential hourly state freshness;
- essential nightly summaries;
- Lexis/mailhouse operations;
- safe read-only smoke tests.

Keep Windows or another cheap worker owning:

- recording polling;
- recording downloads;
- transcription/scoring;
- live trainer capture;
- bulk backfills.
- blogging.

Then migrate enrichment workers only if the cost/stability tradeoff makes
sense, and always behind locks, rate limits, and a clear rollback switch.
