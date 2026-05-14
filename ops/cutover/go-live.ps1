# go-live.ps1
# ------------------------------------------------------------------------------
# Run on the NEW host at the cutover moment, AFTER the old host has stopped
# its services. Flips PARALLEL_RC_SUSPENDED=false in .env and restarts the
# RC-touching services so they pick up the new env.
#
# Safety checks before flipping:
#   - Confirms .env exists
#   - Confirms healthcheck.ps1 passes (services up)
#   - Confirms the kill-switch flag is currently TRUE (you're actually doing
#     a cutover, not re-running this accidentally on an already-live host)
#
# Usage:
#   .\go-live.ps1               # interactive — prompts for confirmation
#   .\go-live.ps1 -Force        # skip the confirmation prompt
# ------------------------------------------------------------------------------

param(
    [switch]$Force,
    [switch]$SkipHealthcheck
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "`n═══ $msg ═══" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [warn] $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "  [fail] $msg" -ForegroundColor Red }

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$envPath  = Join-Path $repoRoot ".env"

# ── 1. Sanity ──────────────────────────────────────────────────────────────────
Write-Step "Pre-flight"
if (-not (Test-Path $envPath)) {
    Write-Fail ".env not found at $envPath"
    exit 1
}
Write-OK ".env present"

$envText = Get-Content $envPath -Raw
$currentlySuspended = ($envText -match "(?m)^\s*PARALLEL_RC_SUSPENDED\s*=\s*(true|1|yes|on)\b")

if (-not $currentlySuspended) {
    Write-Warn "PARALLEL_RC_SUSPENDED is already FALSE (or not set). RC is already live on this host."
    Write-Warn "Re-running go-live.ps1 in this state is a no-op flip + restart."
    if (-not $Force) {
        $confirm = Read-Host "Continue anyway and restart services? (y/N)"
        if ($confirm -ne "y" -and $confirm -ne "Y") {
            Write-Host "Aborted." -ForegroundColor Red
            exit 1
        }
    }
}

# ── 2. Healthcheck — confirm services are running before flipping ──────────────
if ($SkipHealthcheck) {
    Write-Step "Health check (skipped via -SkipHealthcheck)"
} else {
    Write-Step "Health check"
    $hc = Join-Path $PSScriptRoot "healthcheck.ps1"
    & $hc -SkipRingCentralPing
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Health check failed. Refusing to flip the kill-switch on an unhealthy stack."
        Write-Host "  Investigate the failed checks above, then re-run go-live.ps1."
        Write-Host "  Override with -SkipHealthcheck if you're sure."
        exit 1
    }
    Write-OK "Health check passed"
}

# ── 3. Big red button confirmation ─────────────────────────────────────────────
if (-not $Force) {
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════════════════" -ForegroundColor Red
    Write-Host "  ABOUT TO FLIP PARALLEL_RC_SUSPENDED=false ON THIS HOST" -ForegroundColor Red
    Write-Host "  This host will start refreshing RC OAuth tokens and polling presence." -ForegroundColor Red
    Write-Host "  Confirm the OLD host's RC services are STOPPED before proceeding." -ForegroundColor Red
    Write-Host "═══════════════════════════════════════════════════════════════════════" -ForegroundColor Red
    $confirm = Read-Host "Type 'GO' (uppercase) to proceed"
    if ($confirm -ne "GO") {
        Write-Host "Aborted." -ForegroundColor Red
        exit 1
    }
}

# ── 4. Flip the kill-switch ────────────────────────────────────────────────────
Write-Step "Flip PARALLEL_RC_SUSPENDED=false"
if ($envText -match "(?m)^\s*PARALLEL_RC_SUSPENDED\s*=") {
    $envText = $envText -replace "(?m)^\s*PARALLEL_RC_SUSPENDED\s*=.*$", "PARALLEL_RC_SUSPENDED=false"
} else {
    $envText += "`n# Cutover kill-switch — set to false at go-live.`nPARALLEL_RC_SUSPENDED=false`n"
}
Set-Content -Path $envPath -Value $envText -NoNewline
Write-OK "kill-switch flipped to FALSE"

# ── 5. Restart RC-touching services ────────────────────────────────────────────
Write-Step "Restart services"
$svcs = @("ParallelControlPlane", "ParallelRingCentralCx", "ParallelOutboundGateway", "ParallelInboundGateway")
foreach ($svc in $svcs) {
    $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if ($s) {
        Write-Host "  restarting $svc ..."
        Restart-Service -Name $svc -Force
        $s2 = Get-Service -Name $svc
        if ($s2.Status -eq "Running") {
            Write-OK "$svc Running"
        } else {
            Write-Fail "$svc status: $($s2.Status)"
        }
    } else {
        Write-Warn "$svc not installed — skipping"
    }
}

# ── 6. Re-run healthcheck (includes RC reachability) ──────────────────────────
Write-Step "Post-flip verification"
Start-Sleep -Seconds 4   # give services time to bind
& (Join-Path $PSScriptRoot "healthcheck.ps1")

Write-Host ""
Write-Host "Cutover flip complete." -ForegroundColor Green
Write-Host "Watch the logs for the next ~10 minutes:" -ForegroundColor DarkGray
Write-Host "  Get-Content C:\tools\logs\parallel-parallelringcentralcx.out.log -Tail 50 -Wait"
Write-Host "  Get-Content C:\tools\logs\parallel-parallelcontrolplane.out.log -Tail 50 -Wait"
Write-Host ""
Write-Host "If you see clean RC auth (no 429s) and webhooks arriving, the cutover succeeded." -ForegroundColor DarkGray
Write-Host "If RC is still 429ing, run .\ops\cutover\disable-rc.ps1 to roll back." -ForegroundColor DarkGray
