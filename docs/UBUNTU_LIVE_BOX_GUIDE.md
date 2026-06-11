# Ubuntu Live Box Guide

This is the working map for the TagContactBridge Parallel Ubuntu live box. It is the local/live Ubuntu server used for the app services, not the separate marketing-site AWS boxes.

## SSH In

From Windows PowerShell:

```powershell
ssh -i C:\Users\micke\.ssh\id_ed25519_contactbridge_ubuntu ubuntu@tagcontactbridge
```

Useful first move after login:

```bash
cd /opt/tagcontactbridge-parallel
```

The repo and services are normally owned by the `parallel` user. For commands that should run exactly like the service user:

```bash
sudo -H -u parallel <command>
```

Example:

```bash
cd /opt/tagcontactbridge-parallel
sudo -H -u parallel npm run build:web
```

## Main Paths

```text
/opt/tagcontactbridge-parallel
  Main app repo: control-plane, CX service, AI bus, barge, scripts, env, runtime.

/opt/tagcontactbridge-parallel/.env
  Live app environment file. Do not print or copy secrets into chat/GitHub.

/opt/tagcontactbridge-parallel/runtime
  Runtime files, logs, generated audio, coach artifacts, reports, mailbox state.

/opt/tagcontactbridge-parallel/runtime/audio
  Voicemail/audio files used by barge and Drop.co audio URLs.

/opt/tagcontactbridge-parallel/runtime/live-coach-grpc-bridge/events.ndjson
  gRPC bridge event log.

/opt/tagcontactbridge-blogger-sites/WynnTax
  Wynn blog/site repo used by the blogger pipeline.

/opt/tagcontactbridge-blogger-sites/taxadvocategroup
  TAG blog/site repo used by the blogger pipeline.
```

## Services

Check all app services:

```bash
systemctl --no-pager --type=service --state=running | grep -E 'parallel-(ai-bus|barge|control-plane|inbound-gateway|live-coach-grpc|ngrok|outbound-gateway|ringcentral-cx|tag-webhook-front|tag-webhook-ngrok)'
```

Core service map:

```text
parallel-control-plane       port 5001  Main backend/control-plane, cron-ish workers, web client serving/proxy.
parallel-ringcentral-cx      port 6101  CX dialer/backend service.
parallel-ai-bus              port 7000  AI/live coach bus and coach dashboard.
parallel-live-coach-grpc     port 3344  RingCX gRPC audio bridge into AI bus.
parallel-barge               port 7335  EX barge / voicemail-drop helper.
parallel-tag-webhook-front   port 3345  h2/gRPC front door for tag-webhook.
parallel-tag-webhook-ngrok   n/a        ngrok tunnel for tag-webhook.
parallel-ngrok               n/a        main app ngrok tunnel.
parallel-outbound-gateway    port 4002  Outbound/cadence gateway.
parallel-inbound-gateway     n/a        Inbound lead/webhook service.
```

Status for specific units:

```bash
systemctl --no-pager status parallel-ai-bus parallel-control-plane parallel-ringcentral-cx parallel-live-coach-grpc parallel-barge --lines=30
```

Restart only what changed. Common coach patch restart set:

```bash
sudo systemctl restart parallel-ai-bus parallel-live-coach-grpc parallel-control-plane
```

VM/barge changes:

```bash
sudo systemctl restart parallel-barge
```

CX service changes:

```bash
sudo systemctl restart parallel-ringcentral-cx
```

If a service hangs in `deactivating (stop-sigterm)` after systemd timeout, force only the stuck unit:

```bash
sudo systemctl kill -s SIGKILL parallel-ai-bus
sudo systemctl start parallel-ai-bus
```

## Health Checks

```bash
curl -fsS http://127.0.0.1:5001/health
curl -fsS http://127.0.0.1:6101/health
curl -fsS http://127.0.0.1:7000/health
curl -fsS http://127.0.0.1:7335/status
```

Barge status should show monitors registered:

```bash
curl -fsS http://127.0.0.1:7335/status | jq
```

If `jq` is not installed, just run the curl without `| jq`.

## Logs

Recent logs for one service:

```bash
sudo journalctl -u parallel-ai-bus --since '10 minutes ago' --no-pager | tail -n 200
```

Coach bundle:

```bash
sudo journalctl \
  -u parallel-ai-bus \
  -u parallel-live-coach-grpc \
  -u parallel-control-plane \
  -u parallel-ringcentral-cx \
  -u parallel-barge \
  --since '10 minutes ago' --no-pager | tail -n 300
```

Look for important failures:

```bash
sudo journalctl -u parallel-ai-bus -u parallel-live-coach-grpc --since '10 minutes ago' --no-pager \
  | grep -Ei 'uncaught|unhandled|fatal|exception|EADDRINUSE|syntax|failed|timeout|runtime_config|listening|ready'
```

gRPC bridge file log:

```bash
tail -n 200 /opt/tagcontactbridge-parallel/runtime/live-coach-grpc-bridge/events.ndjson
```

## Live Coach Quick Read

Open locally through whatever tunnel/proxy is active, or on the box:

```text
AI bus dashboard: http://127.0.0.1:7000/live-coach
AI bus health:    http://127.0.0.1:7000/health
```

Expected live coach pieces:

```text
parallel-live-coach-grpc receives RingCX audio.
parallel-ai-bus creates/binds live coach sessions, runs mini/context, streams Sonnet lines.
parallel-control-plane proxies app/client live coach events.
Vite web client renders agent/admin panels.
```

Useful live coach runtime flags to inspect without exposing secrets:

```bash
cd /opt/tagcontactbridge-parallel
sudo grep -E '^LIVE_COACH_(ANTHROPIC_COMPOSER_ENABLED|ANTHROPIC_MODEL|COMPOSE_DEDUP_WINDOW_MS|COMPOSE_RATE_LIMIT_PER_MINUTE|CONTEXT_JUDGE_ENABLED|CONTEXT_JUDGE_MODEL|OPENAI_TURN_DETECTION|OPENAI_SERVER_VAD_SILENCE_MS)=' .env
```

## Safe Patch Rhythm

The safest pattern is:

1. Commit locally first.
2. Push the branch to GitHub if appropriate.
3. Copy only intended files to the box, or pull/checkout if the live repo is clean enough.
4. Back up the live files being overwritten.
5. Run tests/checks on live as `parallel`.
6. Build web if client files changed.
7. Restart only affected services.
8. Check health and journals.

Example test/build commands on live:

```bash
cd /opt/tagcontactbridge-parallel

sudo -H -u parallel node --test \
  tests/live-coach/sanitizedPipeline.test.js \
  tests/live-coach/liveCoachBusService.test.js \
  tests/live-coach/liveCoachMongoBridgeService.test.js \
  tests/live-coach/uiiReconcile.test.js

sudo -H -u parallel node --check apps/ai-bus/src/server.js
sudo -H -u parallel node --check scripts/ringcx-grpc-live-coach-bridge.js
sudo -H -u parallel npm run build:web
```

If permissions get weird after a patch:

```bash
cd /opt/tagcontactbridge-parallel
sudo bash ops/linux/repair-runtime-permissions.sh
```

## Important Cautions

- Do not push `.env`, PEMs, runtime audio, or raw call recordings to GitHub.
- The live repo may be dirty because of hotfixes and runtime/blogger state. Check before broad git operations:

```bash
cd /opt/tagcontactbridge-parallel
git status --short
```

- Prefer targeted file patches over `git reset`, `git checkout --`, or broad pulls when live is dirty.
- Most services run as `parallel`; do not leave patched files owned by `ubuntu` or `root`.
- Marketing-site deploys are separate from this app box. Current blogger site repos live under `/opt/tagcontactbridge-blogger-sites`.

## One-Liners

All core live services active:

```bash
systemctl --no-pager is-active parallel-ai-bus parallel-control-plane parallel-ringcentral-cx parallel-live-coach-grpc parallel-barge parallel-tag-webhook-front parallel-tag-webhook-ngrok
```

Coach logs:

```bash
sudo journalctl -u parallel-ai-bus -u parallel-live-coach-grpc --since '5 minutes ago' --no-pager | tail -n 200
```

Barge monitors:

```bash
curl -fsS http://127.0.0.1:7335/status
```

Repair ownership after deploy:

```bash
cd /opt/tagcontactbridge-parallel && sudo bash ops/linux/repair-runtime-permissions.sh
```
