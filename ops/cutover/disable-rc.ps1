# disable-rc.ps1
# ------------------------------------------------------------------------------
# Emergency kill-switch. Flips PARALLEL_RC_SUSPENDED=true and restarts the
# RC-touching services so this host immediately stops calling RingCentral.
#
# Use cases:
#   - Cutover rollback (something went wrong after go-live)
#   - 429 storm — silence this host while investigating
#   - Preparing this host to be the "standby" while the other host runs RC
#
# Reversible at any time via go-live.ps1.
#
# Usage:
#   .\disable-rc.ps1               # interactive — prompts
#   .\disable-rc.ps1 -Force        # skip the confirmation
#   .\disable-rc.ps1 -NoRestart    # just edit .env, don't bounce services
#                                    (useful if services are already stopped)
# ------------------------------------------------------------------------------

param(
    [switch]$Force,
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "`n═══ $msg ═══" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [warn] $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "  [fail] $msg" -ForegroundColor Red }

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$envPath  = Join-Path $repoRoot ".env"

if (-not (Test-Path $envPath)) {
    Write-Fail ".env not found at $envPath"
    exit 1
}

$envText = Get-Content $envPath -Raw
$currentlySuspended = ($envText -match "(?m)^\s*PARALLEL_RC_SUSPENDED\s*=\s*(true|1|yes|on)\b")

if ($currentlySuspended) {
    Write-Warn "PARALLEL_RC_SUSPENDED is already TRUE. This host already isn't calling RC."
    if (-not $Force) {
        $confirm = Read-Host "Restart services anyway to ensure they've picked up the env? (y/N)"
        if ($confirm -ne "y" -and $confirm -ne "Y") {
            Write-Host "Done." -ForegroundColor DarkGray
            exit 0
        }
    }
}

# ── Flip ──────────────────────────────────────────────────────────────────────
if (-not $Force -and -not $currentlySuspended) {
    Write-Host ""
    Write-Host "About to silence RingCentral traffic from this host." -ForegroundColor Yellow
    Write-Host "If another host is configured to take over, make sure it's running first." -ForegroundColor DarkGray
    $confirm = Read-Host "Continue? (y/N)"
    if ($confirm -ne "y" -and $confirm -ne "Y") {
        Write-Host "Aborted." -ForegroundColor Red
        exit 1
    }
}

Write-Step "Set PARALLEL_RC_SUSPENDED=true"
if ($envText -match "(?m)^\s*PARALLEL_RC_SUSPENDED\s*=") {
    $envText = $envText -replace "(?m)^\s*PARALLEL_RC_SUSPENDED\s*=.*$", "PARALLEL_RC_SUSPENDED=true"
} else {
    $envText += "`n# Emergency kill-switch — flip to false via go-live.ps1 to resume.`nPARALLEL_RC_SUSPENDED=true`n"
}
Set-Content -Path $envPath -Value $envText -NoNewline
Write-OK "kill-switch enabled in .env"

# ── Restart services so they pick up the env ──────────────────────────────────
if ($NoRestart) {
    Write-Step "Service restart (skipped via -NoRestart)"
    Write-Warn "Services are still running with the OLD env. Bounce them manually when ready:"
    Write-Host "    Restart-Service ParallelControlPlane, ParallelRingCentralCx, ParallelOutboundGateway, ParallelInboundGateway"
} else {
    Write-Step "Restart services to pick up the env"
    $svcs = @("ParallelControlPlane", "ParallelRingCentralCx", "ParallelOutboundGateway", "ParallelInboundGateway")
    foreach ($svc in $svcs) {
        $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
        if ($s -and $s.Status -eq "Running") {
            Write-Host "  restarting $svc ..."
            Restart-Service -Name $svc -Force
            Write-OK "$svc restarted"
        } elseif ($s) {
            Write-Warn "$svc not Running (status: $($s.Status)) — skipping"
        } else {
            Write-Warn "$svc not installed — skipping"
        }
    }
}

Write-Host ""
Write-Host "RC traffic silenced on this host." -ForegroundColor Green
Write-Host "To re-enable: .\go-live.ps1" -ForegroundColor DarkGray
