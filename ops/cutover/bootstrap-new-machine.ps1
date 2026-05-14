# bootstrap-new-machine.ps1
# ------------------------------------------------------------------------------
# Provisions a NEW Windows host to run the Parallel stack alongside (or as a
# replacement for) the current production host. Idempotent — safe to re-run.
#
# What this script does:
#   1. Verifies prerequisites (Git, Node, npm, nssm, nginx) are installed
#   2. Clones the repo (if not already present)
#   3. Verifies the .env file exists at the expected path
#   4. Sets PARALLEL_RC_SUSPENDED=true in .env (REQUIRED — until cutover)
#   5. Runs npm install at the repo root
#   6. Builds the web-client
#   7. Reports next steps (NSSM install needs elevation)
#
# What this script does NOT do (requires you at the keyboard):
#   - Install Node / Git / nssm / nginx via winget (needs UAC for each)
#   - Install NSSM services (needs elevated PowerShell)
#   - Stop / start services on the old host
#   - Repoint webhooks during cutover
#
# Usage:
#   .\bootstrap-new-machine.ps1                    # standard run
#   .\bootstrap-new-machine.ps1 -SkipInstall       # skip `npm install` (faster re-runs)
#   .\bootstrap-new-machine.ps1 -SkipBuild         # skip `npm run build`
#   .\bootstrap-new-machine.ps1 -RepoDest C:\path  # custom clone path
# ------------------------------------------------------------------------------

param(
    [string]$RepoDest    = "C:\Users\$env:USERNAME\Code\TagContactBridgeParallel",
    [string]$RepoUrl     = "",   # leave empty to use -LocalRepoSource instead
    [string]$LocalRepoSource = "",   # path to a local copy (e.g. USB stick: D:\TagContactBridgeParallel)
    [string]$NssmExe     = "C:\tools\nssm-2.24\win64\nssm.exe",
    [string]$NginxRoot   = "C:\tools\nginx-1.29.6",
    [switch]$SkipInstall,
    [switch]$SkipBuild,
    [switch]$AllowRcLive  # set this if you actually want RC traffic ON — do NOT use during cutover prep
)

$ErrorActionPreference = "Stop"

function Write-Step($message) {
    Write-Host ""
    Write-Host "═══ $message ═══" -ForegroundColor Cyan
}

function Write-OK($message) {
    Write-Host "  [ok] $message" -ForegroundColor Green
}

function Write-Warn($message) {
    Write-Host "  [warn] $message" -ForegroundColor Yellow
}

function Write-Fail($message) {
    Write-Host "  [fail] $message" -ForegroundColor Red
}

function Require-Tool {
    param([string]$Name, [string]$VersionCommand)
    try {
        $output = Invoke-Expression $VersionCommand 2>&1
        Write-OK "$Name -> $output"
        return $true
    } catch {
        Write-Fail "$Name not found on PATH. Install it first."
        return $false
    }
}

# ── 1. Prerequisites check ─────────────────────────────────────────────────────
Write-Step "Prerequisites"
$prereqOk = $true
$prereqOk = (Require-Tool "git"  "git --version") -and $prereqOk
$prereqOk = (Require-Tool "node" "node --version") -and $prereqOk
$prereqOk = (Require-Tool "npm"  "npm --version") -and $prereqOk
$prereqOk = (Require-Tool "ngrok" "ngrok --version") -and $prereqOk

if (Test-Path $NssmExe) {
    Write-OK "nssm at $NssmExe"
} else {
    Write-Fail "nssm not found at $NssmExe. Download from nssm.cc and extract to C:\tools\"
    $prereqOk = $false
}

if (Test-Path (Join-Path $NginxRoot "nginx.exe")) {
    Write-OK "nginx at $NginxRoot"
} else {
    Write-Warn "nginx not found at $NginxRoot. The app will still start, but nginx reverse proxy won't work until installed."
}

if (-not $prereqOk) {
    Write-Host ""
    Write-Host "Install missing prerequisites in an elevated PowerShell, then re-run this script:" -ForegroundColor Red
    Write-Host "  winget install --id Git.Git -e --source winget"
    Write-Host "  winget install --id OpenJS.NodeJS.LTS -e --source winget"
    Write-Host "  winget install --id Ngrok.Ngrok -e --source winget"
    Write-Host "  See ops/cutover/README.md for nssm + nginx manual install steps."
    exit 1
}

# ── 2. Clone or copy repo ──────────────────────────────────────────────────────
# Three sources, in priority order:
#   1. Repo already exists at $RepoDest -> use it, just `git status`
#   2. -RepoUrl provided -> git clone (requires GitHub access + the repo
#      to actually be pushed; not the case yet for this codebase as of
#      2026-05-14 since the MP3 history scrub hasn't happened)
#   3. -LocalRepoSource provided -> robocopy from a USB or network path
Write-Step "Repo @ $RepoDest"
if (Test-Path $RepoDest) {
    Write-OK "already present"
    if (Test-Path (Join-Path $RepoDest ".git")) {
        Push-Location $RepoDest
        git status --short
        Pop-Location
    } else {
        Write-Warn "no .git folder — this is a flat copy, not a git checkout"
    }
} elseif ($RepoUrl) {
    Write-Host "  cloning $RepoUrl ..."
    git clone $RepoUrl $RepoDest
    Write-OK "cloned"
} elseif ($LocalRepoSource -and (Test-Path $LocalRepoSource)) {
    Write-Host "  copying from $LocalRepoSource ..."
    # Robocopy mirrors the tree. /XD node_modules so we don't drag
    # ~500MB of installed deps across USB. /XD build skips the
    # web-client build artifacts (we'll rebuild). /R:2 retries twice on
    # transient errors. /MT:8 parallelizes for speed on USB.
    New-Item -ItemType Directory -Force -Path $RepoDest | Out-Null
    robocopy $LocalRepoSource $RepoDest /E /XD node_modules build dist .git /R:2 /MT:8 /NFL /NDL /NJH /NJS | Out-Null
    # .git is excluded above to keep the copy small; if the source had
    # one, copy it separately so we keep git history.
    if (Test-Path (Join-Path $LocalRepoSource ".git")) {
        robocopy (Join-Path $LocalRepoSource ".git") (Join-Path $RepoDest ".git") /E /R:2 /MT:8 /NFL /NDL /NJH /NJS | Out-Null
    }
    Write-OK "copied"
} else {
    Write-Fail "No repo source specified."
    Write-Host ""
    Write-Host "Provide ONE of the following:" -ForegroundColor Yellow
    Write-Host "  -RepoUrl https://github.com/your-org/TagContactBridgeParallel.git"
    Write-Host "  -LocalRepoSource D:\TagContactBridgeParallel    (path to a USB copy)"
    Write-Host "  (or pre-populate $RepoDest manually before running this script)"
    exit 1
}

# ── 3. .env file check ─────────────────────────────────────────────────────────
Write-Step ".env file"
$envPath = Join-Path $RepoDest ".env"
if (-not (Test-Path $envPath)) {
    Write-Fail ".env file not present at $envPath"
    Write-Host ""
    Write-Host "Copy it from the OLD host (via USB) to this exact path, then re-run this script." -ForegroundColor Yellow
    Write-Host "The .env contains: Mongo URI, RC OAuth credentials, OpenAI/Anthropic API keys, Google Drive service-account creds, etc."
    exit 1
}
Write-OK ".env file present"

# ── 4. RC kill-switch ──────────────────────────────────────────────────────────
Write-Step "RC kill-switch (PARALLEL_RC_SUSPENDED)"
$envContent = Get-Content $envPath -Raw
$flagLine   = "PARALLEL_RC_SUSPENDED=true"

if ($AllowRcLive) {
    Write-Warn "-AllowRcLive specified. NOT inserting kill-switch. Make sure the old machine is OFF before this host starts."
} elseif ($envContent -match "(?m)^\s*PARALLEL_RC_SUSPENDED\s*=") {
    if ($envContent -match "(?m)^\s*PARALLEL_RC_SUSPENDED\s*=\s*(true|1|yes|on)\b") {
        Write-OK "kill-switch already enabled"
    } else {
        Write-Warn "kill-switch line present but disabled. Forcing it to TRUE for cutover prep."
        $envContent = $envContent -replace "(?m)^\s*PARALLEL_RC_SUSPENDED\s*=.*$", $flagLine
        Set-Content -Path $envPath -Value $envContent -NoNewline
    }
} else {
    Write-Host "  adding PARALLEL_RC_SUSPENDED=true to .env"
    Add-Content -Path $envPath -Value "`n# Cutover kill-switch — set to false when this host should take over RC traffic.`n$flagLine`n"
    Write-OK "kill-switch enabled"
}

Write-Host "  This host will make ZERO RingCentral API calls until you flip it off via go-live.ps1." -ForegroundColor DarkGray

# ── 5. npm install ─────────────────────────────────────────────────────────────
if ($SkipInstall) {
    Write-Step "npm install (skipped via -SkipInstall)"
} else {
    Write-Step "npm install"
    Push-Location $RepoDest
    npm install
    Pop-Location
    Write-OK "dependencies installed"
}

# ── 6. web-client build ────────────────────────────────────────────────────────
if ($SkipBuild) {
    Write-Step "web-client build (skipped via -SkipBuild)"
} else {
    Write-Step "web-client build"
    $webClientDir = Join-Path $RepoDest "apps\web-client"
    if (Test-Path $webClientDir) {
        Push-Location $webClientDir
        npm run build
        Pop-Location
        Write-OK "build complete"
    } else {
        Write-Warn "web-client directory not found at $webClientDir — skipping build"
    }
}

# ── 7. Next steps ──────────────────────────────────────────────────────────────
Write-Step "Next steps"
Write-Host ""
Write-Host "Bootstrap complete. RC traffic is SILENCED on this host (PARALLEL_RC_SUSPENDED=true)." -ForegroundColor Green
Write-Host ""
Write-Host "Manual step #1 — install NSSM services (REQUIRES ELEVATED PowerShell):" -ForegroundColor Yellow
Write-Host "  cd $RepoDest"
Write-Host "  .\ops\nssm\install-services.ps1"
Write-Host ""
Write-Host "Manual step #2 — start the services (works from a normal PowerShell):"
Write-Host "  Start-Service ParallelControlPlane, ParallelInboundGateway, ParallelOutboundGateway, ParallelRingCentralCx, ParallelNginx"
Write-Host ""
Write-Host "Manual step #3 — verify (any shell):"
Write-Host "  .\ops\cutover\healthcheck.ps1"
Write-Host ""
Write-Host "Manual step #4 — at cutover moment, flip RC on:"
Write-Host "  .\ops\cutover\go-live.ps1"
Write-Host ""
