# Parallel cutover playbook

Scripts for migrating the Parallel stack from one Windows host to another with a clean hot-swap.

## The flow

1. **Old host (current production):** keeps running with `PARALLEL_RC_SUSPENDED` unset (RC active).
2. **New host (target):** boots, pulls repo, runs `bootstrap-new-machine.ps1`, has `PARALLEL_RC_SUSPENDED=true` set. App is fully running EXCEPT it makes zero calls to RingCentral.
3. **Cutover moment:** stop old host's services, swap ethernet (or DNS), run `go-live.ps1` on new host which flips `PARALLEL_RC_SUSPENDED=false` and restarts.
4. **Old host:** shut down, repurpose.

The key invariant: only one host at a time may have `PARALLEL_RC_SUSPENDED` unset. Two hosts refreshing the same RC OAuth token simultaneously produced the 429 cascade on 2026-05-13 — the kill-switch exists to prevent that during overlap.

## Why this approach

- **Risk of concurrent RC auth:** one OAuth token, two refresh paths → RC throttles us
- **Risk of partial-config new host:** new machine without env / Mongo / .env mistakes makes 4 services start and then fail in confusing ways
- **Mitigation:** new host runs the full stack with RC silenced, all health checks green, before cutover. The flip is one env change + restart.

## Scripts

| Script | When to run | Where | Elevation? |
|---|---|---|---|
| `bootstrap-new-machine.ps1` | First-time setup on the NEW host | New host PowerShell | Most of it no; NSSM install step yes |
| `healthcheck.ps1` | Anytime — verifies all services answering | Any host | No |
| `go-live.ps1` | At the cutover moment | New host | No (just restarts services) |
| `disable-rc.ps1` | Emergency — silence RC traffic immediately | Any host with the app installed | No |

## Prerequisites on the new host

Manually install BEFORE running `bootstrap-new-machine.ps1`. These need UAC and are installer dialogs the agent can't approve:

```powershell
# In an elevated PowerShell:
winget install --id Git.Git -e --source winget
winget install --id OpenJS.NodeJS.LTS -e --source winget    # Node 22
winget install --id Ngrok.Ngrok -e --source winget

# nssm — manual:
$nssmZip = "$env:TEMP\nssm.zip"
Invoke-WebRequest "https://nssm.cc/release/nssm-2.24.zip" -OutFile $nssmZip
Expand-Archive $nssmZip -DestinationPath "C:\tools\" -Force

# nginx — manual:
$nginxZip = "$env:TEMP\nginx.zip"
Invoke-WebRequest "https://nginx.org/download/nginx-1.29.6.zip" -OutFile $nginxZip
Expand-Archive $nginxZip -DestinationPath "C:\tools\" -Force
```

Confirm everything is on PATH:

```powershell
git --version; node --version; npm --version; ngrok --version
& "C:\tools\nssm-2.24\win64\nssm.exe" version
```

## What you provide manually (from the old machine via USB)

| File | Where on old machine | Where on new machine |
|---|---|---|
| `.env` (secrets) | `C:\Users\Admin\Code\TagContactBridgeParallel\.env` | Same path on new |
| ngrok config | `%LOCALAPPDATA%\ngrok\ngrok.yml` (or `~/.ngrok2/ngrok.yml`) | Same path on new |

Bring them on a USB stick. Don't email or chat them.

## After bootstrap, before cutover

1. New host runs full stack with RC silenced — confirm via `healthcheck.ps1`
2. Verify webhooks would route correctly (the ngrok tunnel can be tested in a dry-run)
3. List which external services point at the OLD ngrok URL — these need to be repointed at cutover

## At cutover

```powershell
# 1. On OLD host — stop all services so it stops touching RC:
Stop-Service ParallelRingCentralCx, ParallelControlPlane, ParallelInboundGateway, ParallelOutboundGateway, ParallelNginx

# 2. Swap ethernet to new host (or update DNS/forwarding)

# 3. Repoint any external webhook URLs to the new ngrok tunnel
#    (or start new host's ngrok with the same reserved domain after old's ngrok is stopped)

# 4. On NEW host — flip the kill-switch and restart:
.\ops\cutover\go-live.ps1
```

After ~10 min of clean logs (no 429s, RC auth succeeding, webhooks arriving), the cutover is complete.

## Rolling back

If something goes wrong after cutover, the rollback is symmetric:

```powershell
# On NEW host — re-silence RC:
.\ops\cutover\disable-rc.ps1

# On OLD host — bring services back up:
Start-Service ParallelNginx, ParallelControlPlane, ParallelInboundGateway, ParallelOutboundGateway, ParallelRingCentralCx
```

Then repoint webhooks back to the old ngrok tunnel.
