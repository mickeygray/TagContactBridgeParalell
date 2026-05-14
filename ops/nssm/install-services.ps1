# -----------------------------------------------------------------------------
# install-services.ps1
# -----------------------------------------------------------------------------
#
# Installs the Parallel app as per-process NSSM-managed Windows services.
#
#   1. ParallelNginx           - reverse proxy on :80 / :81 (the edge in front
#                                of ngrok). MUST run with `-g "daemon off;"`
#                                so NSSM can supervise the master process.
#   2. ParallelControlPlane    - 5001 control-plane / built web edge
#   3. ParallelInboundGateway  - 4001 public intake service
#   4. ParallelOutboundGateway - 4002 cadence + outbound worker
#   5. ParallelRingCentralCx   - 6101 CX / agent-state worker
#   6. ParallelRestartHelper   - manual restart helper for the Parallel stack
#   7. ParallelBlogger         - long-running blogger daemon
#
# The old `npm run dev` / concurrently wrapper is intentionally not used here.
# If one child dies, NSSM should restart that child directly instead of only
# seeing a wrapper process.
#
# nginx was historically launched in-session and silently died whenever a
# sibling process (e.g. one of the NSSM restart paths) touched the box —
# leaving the tunnel up but returning 502 from upstream. Adding it here so
# the same auto-restart safety net applies. The web client is served from
# apps\web-client\build by the control-plane, so there is no separate Vite
# service in this install script.
#
# Run from an elevated PowerShell:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\install-services.ps1
#
# Flags:
#   -Uninstall   Remove the services
#   -DryRun      Print what would happen, do not change anything
#   -OnlyStack   Only install/uninstall the core app services
#   -OnlyBlogger Only install/uninstall ParallelBlogger
# -----------------------------------------------------------------------------

param(
    [switch]$Uninstall,
    [switch]$DryRun,
    [switch]$OnlyStack,
    [switch]$OnlyBlogger
)

$ErrorActionPreference = "Stop"

# --- Path discovery ---------------------------------------------------------
# nssm.exe location varies per machine. Try env override first, then known
# candidate paths in priority order. Fail loud if none exist so a fresh
# machine surfaces the missing-binary error immediately instead of
# silently installing nothing.
function Find-Nssm {
    if ($env:NSSM_EXE -and (Test-Path $env:NSSM_EXE)) { return $env:NSSM_EXE }
    $candidates = @(
        "C:\tools\nssm-2.24\win64\nssm.exe",
        "C:\tools\nssm\win64\nssm.exe",
        "C:\Users\$env:USERNAME\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe",
        "C:\Users\admin\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    $onPath = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    throw "nssm.exe not found. Set `$env:NSSM_EXE or extract NSSM to C:\tools\nssm-2.24\win64\."
}

$Nssm      = Find-Nssm
$Repo      = if ($env:PARALLEL_REPO_ROOT) { $env:PARALLEL_REPO_ROOT } else { "C:\Users\$env:USERNAME\Code\TagContactBridgeParallel" }
if (-not (Test-Path $Repo)) {
    # Fall back to the original admin path if the per-user path doesn't exist.
    if (Test-Path "C:\Users\Admin\Code\TagContactBridgeParallel") {
        $Repo = "C:\Users\Admin\Code\TagContactBridgeParallel"
    }
}
$LogsDir   = if ($env:PARALLEL_LOGS_DIR) { $env:PARALLEL_LOGS_DIR } else { "C:\tools\logs" }
$NodeExe   = (Get-Command node).Source
$PowerShellExe = (Get-Command powershell).Source
$NginxRoot = if ($env:NGINX_ROOT -and (Test-Path $env:NGINX_ROOT)) { $env:NGINX_ROOT } else { "C:\tools\nginx-1.29.6" }
$NginxExe  = Join-Path $NginxRoot "nginx.exe"

# --- Port discovery ---------------------------------------------------------
# Pull from env so service Display + Description match what the apps will
# actually bind to. Defaults match packages/shared-config/src/index.js so
# nothing changes for a vanilla install.
function Get-PortEnv($name, $default) {
    $raw = [Environment]::GetEnvironmentVariable($name, "Process")
    if (-not $raw) { $raw = [Environment]::GetEnvironmentVariable($name, "Machine") }
    if ($raw -and $raw -match '^\d+$') { return [int]$raw }
    return $default
}
$ControlPlanePort     = Get-PortEnv "CONTROL_PLANE_PORT"     5001
$InboundGatewayPort   = Get-PortEnv "INBOUND_GATEWAY_PORT"   4001
$OutboundGatewayPort  = Get-PortEnv "OUTBOUND_GATEWAY_PORT"  4002
$RingcentralCxPort    = Get-PortEnv "RINGCENTRAL_CX_PORT"    6101
Write-Host "Ports: cp=$ControlPlanePort, in=$InboundGatewayPort, out=$OutboundGatewayPort, cx=$RingcentralCxPort"
Write-Host "Paths: Repo=$Repo, Logs=$LogsDir, Nssm=$Nssm, Nginx=$NginxRoot"
# LocalSystem runs the service without an interactive password step.
# It has full local-filesystem access (so it can read this repo at
# C:\Users\Admin\... and write logs to C:\tools\logs\), and the
# Parallel app uses .env-driven config for all external auth — no
# user-context credentials are required at runtime. If a future
# integration needs user-mapped credentials (e.g. a smb share that
# only Admin can reach), switch this to ".\Admin" and run
# `nssm edit <ServiceName>` per service to set the password.
$RunAsUser = "LocalSystem"

if (-not (Test-Path $Nssm)) { throw "nssm.exe not found at $Nssm" }
if (-not (Test-Path $Repo)) { throw "Repo not found at $Repo" }
if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir | Out-Null }

$Services = @()

if (-not $OnlyBlogger) {
    $Services += @(
        @{
            Name        = "ParallelNginx"
            Display     = "Parallel - nginx reverse proxy (80/81)"
            Application = $NginxExe
            # `-p` sets the prefix so relative paths in the config resolve
            # against C:\tools\nginx-1.29.6\, not the AppDirectory.
            # `-g "daemon off;"` keeps the master process in the foreground
            # so NSSM can supervise it — without this nginx forks and
            # detaches, NSSM sees the parent exit, and it'd thrash
            # restart-restart-restart.
            Arguments   = "-p `"$NginxRoot`" -c conf\nginx.conf -g `"daemon off;`""
            AppDirectory = $NginxRoot
            Description = "Reverse proxy on :80/:81. Routes ngrok-terminated traffic to control-plane ($ControlPlanePort) and the various Parallel workers."
        },
        @{
            Name        = "ParallelControlPlane"
            Display     = "Parallel - Control Plane ($ControlPlanePort)"
            Application = $NodeExe
            Arguments   = "apps\control-plane\src\server.js"
            Description = "Runs the Parallel control-plane on port $ControlPlanePort and serves the built web client."
        },
        @{
            Name        = "ParallelInboundGateway"
            Display     = "Parallel - Inbound Gateway ($InboundGatewayPort)"
            Application = $NodeExe
            Arguments   = "apps\inbound-gateway\src\server.js"
            Description = "Runs the Parallel inbound gateway on port $InboundGatewayPort."
        },
        @{
            Name        = "ParallelOutboundGateway"
            Display     = "Parallel - Outbound Gateway ($OutboundGatewayPort)"
            Application = $NodeExe
            Arguments   = "apps\outbound-gateway\src\server.js"
            Description = "Runs the Parallel outbound gateway on port $OutboundGatewayPort."
        },
        @{
            Name        = "ParallelRingCentralCx"
            Display     = "Parallel - RingCentral CX ($RingcentralCxPort)"
            Application = $NodeExe
            Arguments   = "apps\ringcentral-cx\src\server.js"
            Description = "Runs the Parallel RingCentral CX worker on port $RingcentralCxPort."
        },
        @{
            Name        = "ParallelRestartHelper"
            Display     = "Parallel - Restart Helper"
            Application = $PowerShellExe
            Arguments   = "-NoProfile -ExecutionPolicy Bypass -File `"$Repo\\ops\\nssm\\restart-parallel-stack.ps1`""
            Description = "Manual helper that restarts the Parallel core services, reloads nginx, and re-ensures the Parallel ngrok tunnel. Legacy and the old blogger daemon are untouched."
        }
    )
}

if (-not $OnlyStack) {
    $Services += @{
        Name        = "ParallelBlogger"
        Display     = "Parallel - Blogger Daemon"
        Application = $NodeExe
        Arguments   = "scripts\blogger-daemon.js"
        Description = "Long-running daemon. Internal cron fires the daily blog post at 8 AM PT Mon-Fri."
    }
}

function Stop-ServiceIfRunning($name) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq "Running") {
        Write-Host "  Stopping $name..."
        Stop-Service $name -Force
        Start-Sleep -Seconds 2
    }
}

function Remove-NssmService($name) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Host "  $name not installed, skipping"
        return
    }
    Stop-ServiceIfRunning $name
    Write-Host "  Removing $name..."
    & $Nssm remove $name confirm | Out-Null
}

function Install-NssmService($svc) {
    $name = $svc.Name
    $existing = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-ServiceIfRunning $name
        Write-Host "  Removing existing $name..."
        & $Nssm remove $name confirm | Out-Null
    }

    Write-Host "  Installing $name..."
    & $Nssm install $name $svc.Application $svc.Arguments | Out-Null
    $appDir = if ($svc.ContainsKey("AppDirectory")) { $svc.AppDirectory } else { $Repo }
    & $Nssm set $name AppDirectory $appDir | Out-Null
    & $Nssm set $name Description $svc.Description | Out-Null
    & $Nssm set $name DisplayName $svc.Display | Out-Null
    if ($name -in @("ParallelBlogger", "ParallelRestartHelper")) {
        & $Nssm set $name Start SERVICE_DEMAND_START | Out-Null
    } else {
        & $Nssm set $name Start SERVICE_AUTO_START | Out-Null
    }
    # nginx doesn't read NODE_ENV; the env var is harmless for it but the
    # other Node services rely on it. Set it everywhere for consistency.
    & $Nssm set $name AppEnvironmentExtra "NODE_ENV=production" | Out-Null

    $base = $name.ToLower()
    & $Nssm set $name AppStdout "$LogsDir\parallel-$base.out.log" | Out-Null
    & $Nssm set $name AppStderr "$LogsDir\parallel-$base.err.log" | Out-Null
    & $Nssm set $name AppRotateFiles 1 | Out-Null
    & $Nssm set $name AppRotateOnline 1 | Out-Null
    & $Nssm set $name AppRotateBytes 10485760 | Out-Null

    if ($name -eq "ParallelRestartHelper") {
        & $Nssm set $name AppExit Default Ignore | Out-Null
    } else {
        & $Nssm set $name AppExit Default Restart | Out-Null
    }
    & $Nssm set $name AppRestartDelay 5000 | Out-Null

    if ($RunAsUser -eq "LocalSystem") {
        # LocalSystem doesn't take a password — single-arg ObjectName.
        & $Nssm set $name ObjectName $RunAsUser | Out-Null
    } else {
        & $Nssm set $name ObjectName $RunAsUser | Out-Null
        Write-Host "    NOTE: set the run-as password via 'nssm edit $name' before first start"
    }
    Write-Host "    OK $name installed (run-as: $RunAsUser)"
}

if ($Uninstall) {
    Write-Host "==========================================================="
    Write-Host "Uninstalling Parallel NSSM services"
    Write-Host "==========================================================="
    foreach ($svc in $Services) { Remove-NssmService $svc.Name }
    Write-Host "Done."
    exit 0
}

Write-Host "==========================================================="
Write-Host "Installing Parallel NSSM services"
Write-Host "  Repo: $Repo"
Write-Host "  Node: $NodeExe"
Write-Host "  Logs: $LogsDir\parallel-<name>.{out,err}.log"
Write-Host "==========================================================="

if ($DryRun) {
    Write-Host "DRY RUN - would install:"
    foreach ($svc in $Services) {
        Write-Host "  $($svc.Name): $($svc.Application) $($svc.Arguments)"
    }
    exit 0
}

foreach ($svc in $Services) {
    Install-NssmService $svc
}

Write-Host ""
Write-Host "==========================================================="
Write-Host "Install complete. Next steps:"
if ($RunAsUser -eq "LocalSystem") {
    Write-Host "  Services run as LocalSystem - no password step needed."
    Write-Host ""
    Write-Host "  1. Stop your current 'npm run dev' if still running"
    Write-Host "     (frees ports $ControlPlanePort/$InboundGatewayPort/$OutboundGatewayPort/$RingcentralCxPort + web-client 3001 if dev)"
    Write-Host "  2. Start-Service ParallelControlPlane"
    Write-Host "  3. Start-Service ParallelInboundGateway"
    Write-Host "  4. Start-Service ParallelOutboundGateway"
    Write-Host "  5. Start-Service ParallelRingCentralCx"
    Write-Host "  6. Start-Service ParallelBlogger"
    Write-Host "  7. Optional one-shot restart helper:"
    Write-Host "       Start-Service ParallelRestartHelper"
    Write-Host "  8. Tail $LogsDir\parallel-*.{out,err}.log to confirm health"
    Write-Host "  9. Once stable, retire the legacy TagContactBridge service:"
    Write-Host "       Set-Service TagContactBridge -StartupType Manual"
    Write-Host "       Stop-Service TagContactBridge"
    Write-Host " 10. Delete old blogger Task Scheduler entries:"
    Write-Host "       schtasks /Delete /TN WynnTAGBlogger       /F"
    Write-Host "       schtasks /Delete /TN WynnTAGBloggerHealth /F"
} else {
    Write-Host "  1. nssm edit ParallelControlPlane    -> Log on tab -> set $RunAsUser password"
    Write-Host "  2. nssm edit ParallelInboundGateway  -> Log on tab -> set $RunAsUser password"
    Write-Host "  3. nssm edit ParallelOutboundGateway -> Log on tab -> set $RunAsUser password"
    Write-Host "  4. nssm edit ParallelRingCentralCx   -> Log on tab -> set $RunAsUser password"
    Write-Host "  5. nssm edit ParallelRestartHelper  -> Log on tab -> set $RunAsUser password"
    Write-Host "  6. nssm edit ParallelBlogger        -> Log on tab -> set $RunAsUser password"
    Write-Host "  7. Start-Service ParallelControlPlane"
    Write-Host "  8. Start-Service ParallelInboundGateway"
    Write-Host "  9. Start-Service ParallelOutboundGateway"
    Write-Host " 10. Start-Service ParallelRingCentralCx"
    Write-Host " 11. Start-Service ParallelBlogger"
    Write-Host " 12. Optional one-shot restart helper:"
    Write-Host "       Start-Service ParallelRestartHelper"
    Write-Host " 13. Tail $LogsDir\parallel-*.{out,err}.log to confirm health"
    Write-Host " 14. Once stable, retire the legacy TagContactBridge service:"
    Write-Host "       Set-Service TagContactBridge -StartupType Manual"
    Write-Host "       Stop-Service TagContactBridge"
    Write-Host " 15. Delete old blogger Task Scheduler entries:"
    Write-Host "       schtasks /Delete /TN WynnTAGBlogger       /F"
    Write-Host "       schtasks /Delete /TN WynnTAGBloggerHealth /F"
}
Write-Host "==========================================================="
