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

## Windows PowerShell + SSH Formatting Notes

When running live read-only checks from Windows, keep remote commands simple.
PowerShell easily mangles nested quotes, pipes, `grep -E`, `awk`, and command
substitution before the text ever reaches Ubuntu. If a command needs more than
one pipe or any real parsing, send a small script over SSH instead of fighting
inline quoting.

Good pattern for multi-step log parsing:

```powershell
@'
import json
import re
from pathlib import Path

# Keep output summarized and masked. Do not print raw env, tokens, phones,
# emails, customer names, or full request bodies.
for line in Path("/var/log/nginx/access.log").read_text(errors="ignore").splitlines():
    if "/api/read/clients/case/" in line and " 500 " in line:
        print(line[:180])
'@ | ssh -i C:\Users\micke\.ssh\id_ed25519_contactbridge_ubuntu ubuntu@tagcontactbridge "python3 -"
```

For Node diagnostics that need repo code, change directory on the remote side
and pipe the script:

```powershell
@'
process.chdir("/opt/tagcontactbridge-parallel");
console.log(JSON.stringify({ ok: true }));
'@ | ssh -i C:\Users\micke\.ssh\id_ed25519_contactbridge_ubuntu ubuntu@tagcontactbridge "cd /opt/tagcontactbridge-parallel && node -"
```

Rules of thumb from 2026-07-03 live checks:

- Prefer `python3 -` or `node -` over inline `grep | awk | sed` chains from PowerShell.
- Use `journalctl -o cat --no-pager` when you want parseable JSON log lines.
- Keep SSH one-liners to simple reads: `systemctl show`, `curl /health`, `tail`, `git status`.
- If the service environment is needed for a reproduction, borrow it inside the remote script from the running process and do not print it.
- `parallel-live-coach-grpc` on port `3344` is gRPC. A normal HTTP health curl can fail oddly; verify it with `systemctl` and journals instead.
- `systemctl cat` / `systemctl status` may warn that a unit changed on disk and needs `daemon-reload`. Do not run `daemon-reload` or restart live services unless Mickey explicitly asks.
- Nginx access logs often show route/status evidence that the app journal does not, because some Express routes catch errors and return `500` without logging the stack.
- For customer-facing failures, report counts, route names, masked agent/email/phone fragments, and exception names/messages. Do not paste raw log rows unless Mickey specifically asks and the data is safe.

## After-Hours Ownership Cleanup Notes

2026-07-03 live hotfix context: `npm run build:web` succeeded through
typecheck as `parallel`, but Vite could not clear
`/opt/tagcontactbridge-parallel/apps/web-client/build/assets` because that
build output is root-owned. The web bundle was rebuilt with `sudo npm run
build:web` as a daytime mitigation, without restarting services. That worked,
but it keeps the ownership mess alive.

After hours, clean this up so normal deploy/build steps do not alternate
between "run as `parallel`" and "use sudo because the previous build was root":

- Inspect ownership for repo source, `apps/web-client/build`, `node_modules`,
  `runtime`, and service-write directories before changing anything.
- Preserve secrets and runtime data. Do not chown `.env`, private keys, raw
  recordings, or unrelated mounted/backed-up paths blindly.
- Desired state: source and build artifacts under
  `/opt/tagcontactbridge-parallel` should be writable by the deploy/build user
  path we actually use; service runtime directories should be writable by the
  service user that writes them.
- Preferred build test after cleanup:

```bash
cd /opt/tagcontactbridge-parallel
sudo -H -u parallel npm run build:web
```

- If that still fails, fix the specific denied path rather than building with
  sudo again.
- Re-run `stat -c '%U:%G %a %n'` on the corrected paths and record the final
  owner/group pattern here once settled.
- This is an after-hours maintenance task. Do not do broad ownership repairs in
  the middle of live CX calling.

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
