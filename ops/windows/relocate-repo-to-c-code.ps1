# relocate-repo-to-c-code.ps1
# ------------------------------------------------------------------------------
# Moves the Windows service install from the temporary Codex workspace to a
# stable repo path, defaulting to C:\code\TagContactBridgeParalell.
#
# It does not delete the old source directory. It copies the repo, installs
# dependencies/builds in the target, stops services briefly, copies final
# runtime state, repoints NSSM services, and starts the stack again.
# ------------------------------------------------------------------------------

param(
    [string]$SourceRepo = $(Resolve-Path (Join-Path $PSScriptRoot "..\..")),
    [string]$TargetRepo = "C:\code\TagContactBridgeParalell",
    [string]$Nssm = "C:\Users\micke\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe",
    [string]$NginxRoot = "C:\tools\nginx-1.29.6",
    [string]$MongoToolsRoot = "C:\tools\mongodb",
    [string]$Node = "C:\Program Files\nodejs\node.exe",
    [string]$Npm = "C:\Program Files\nodejs\npm.cmd",
    [switch]$SkipBuild,
    [switch]$IncludeMongo,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

function Write-Step($Message) {
    Write-Host ""
    Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Write-OK($Message) {
    Write-Host "  [ok] $Message" -ForegroundColor Green
}

function Require-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this script from PowerShell as Administrator."
    }
}

function Require-File($Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Required file not found: $Path"
    }
}

function Invoke-Nssm([string[]]$Arguments) {
    & $Nssm @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "nssm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Invoke-RobocopyMirror {
    param(
        [string]$From,
        [string]$To,
        [switch]$IncludeNodeModules,
        [string[]]$ExcludeDirs = @()
    )

    New-Item -ItemType Directory -Force -Path $To | Out-Null

    $args = @(
        $From,
        $To,
        "/E",
        "/COPY:DAT",
        "/DCOPY:DAT",
        "/R:2",
        "/W:2",
        "/NFL",
        "/NDL"
    )

    $excludedDirs = @()
    if (-not $IncludeNodeModules) {
        $excludedDirs += "node_modules"
    }
    $excludedDirs += $ExcludeDirs
    if ($excludedDirs.Count -gt 0) {
        $args += "/XD"
        $args += $excludedDirs
    }

    & robocopy @args | Out-Host
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed with exit code $LASTEXITCODE"
    }
}

function Stop-ServiceIfPresent {
    param([string]$Name)
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne "Stopped") {
        Stop-Service -Name $Name -Force -ErrorAction Stop
        $svc.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(45))
    }
}

function Start-ServiceAndWait {
    param([string]$Name)
    $svc = Get-Service -Name $Name -ErrorAction Stop
    if ($svc.Status -ne "Running") {
        Start-Service -Name $Name -ErrorAction Stop
    }
    $svc = Get-Service -Name $Name -ErrorAction Stop
    $svc.WaitForStatus("Running", [TimeSpan]::FromSeconds(60))
    Write-OK "$Name Running"
}

Require-Administrator

$SourceRepo = (Resolve-Path $SourceRepo).Path
$TargetRepo = [System.IO.Path]::GetFullPath($TargetRepo)

Require-File $Nssm
Require-File $Node
Require-File $Npm
Require-File (Join-Path $NginxRoot "nginx.exe")
Require-File (Join-Path $SourceRepo "package.json")
Require-File (Join-Path $SourceRepo ".env")

if ($SourceRepo.TrimEnd("\") -ieq $TargetRepo.TrimEnd("\")) {
    throw "SourceRepo and TargetRepo are the same path."
}

if ((Test-Path -LiteralPath $TargetRepo) -and -not (Test-Path -LiteralPath (Join-Path $TargetRepo ".git")) -and -not $Force) {
    throw "Target exists but does not look like this repo: $TargetRepo. Re-run with -Force if you are sure."
}

Write-Step "Plan"
Write-Host "Source: $SourceRepo"
Write-Host "Target: $TargetRepo"
Write-Host "Old source will be left in place for rollback."

if (-not $Force) {
    $answer = Read-Host "Type MOVE to relocate services to the target path"
    if ($answer -ne "MOVE") {
        throw "Aborted."
    }
}

Write-Step "Pre-copy repo to target"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TargetRepo) | Out-Null
Invoke-RobocopyMirror -From $SourceRepo -To $TargetRepo -ExcludeDirs @("runtime")
Write-OK "Initial copy complete"

if (-not $SkipBuild) {
    Write-Step "Install dependencies and build in target"
    Push-Location $TargetRepo
    try {
        & $Npm ci
        & $Npm run build:web
    } finally {
        Pop-Location
    }
    Write-OK "Target build complete"
}

Write-Step "Stop services for final sync"
$ngrokWasRunning = $false
$ngrok = Get-Service -Name "ParallelNgrok" -ErrorAction SilentlyContinue
if ($ngrok -and $ngrok.Status -eq "Running") {
    $ngrokWasRunning = $true
}

$stopOrder = @(
    "ParallelNgrok",
    "ParallelControlPlane",
    "ParallelInboundGateway",
    "ParallelOutboundGateway",
    "ParallelRingCentralCx",
    "ParallelNginx"
)
if ($IncludeMongo) { $stopOrder += "ParallelMongo" }
foreach ($svc in $stopOrder) {
    Stop-ServiceIfPresent -Name $svc
}

Write-Step "Final sync including runtime state"
Invoke-RobocopyMirror -From $SourceRepo -To $TargetRepo
Write-OK "Final copy complete"

Write-Step "Repoint NSSM services"
if ($IncludeMongo) {
    $mongoApp = & $Nssm get ParallelMongo Application
    $mongoInstallRoot = Split-Path -Parent (Split-Path -Parent $mongoApp)
    $mongoTargetRoot = Join-Path $MongoToolsRoot (Split-Path -Leaf $mongoInstallRoot)
    New-Item -ItemType Directory -Force -Path $MongoToolsRoot | Out-Null
    Invoke-RobocopyMirror -From $mongoInstallRoot -To $mongoTargetRoot
    $mongoApp = Join-Path $mongoTargetRoot "bin\mongod.exe"
    $mongoDir = Split-Path -Parent $mongoApp
    Require-File $mongoApp

    $mongoData = Join-Path $TargetRepo "runtime\mongodb-data"
    $mongoLog = Join-Path $TargetRepo "runtime\mongodb-service.log"
    New-Item -ItemType Directory -Force -Path $mongoData | Out-Null

    Invoke-Nssm @("set", "ParallelMongo", "Application", $mongoApp)
    Invoke-Nssm @("set", "ParallelMongo", "AppDirectory", $mongoDir)
    Invoke-Nssm @("set", "ParallelMongo", "AppParameters", "--dbpath `"$mongoData`" --bind_ip 127.0.0.1 --port 27017 --logpath `"$mongoLog`" --logappend")
} else {
    Write-OK "Skipping local Mongo service repoint; app uses Atlas via MONGO_URI"
}

Invoke-Nssm @("set", "ParallelNginx", "Application", "C:\windows\System32\WindowsPowerShell\v1.0\powershell.exe")
Invoke-Nssm @("set", "ParallelNginx", "AppDirectory", $TargetRepo)
Invoke-Nssm @("set", "ParallelNginx", "AppParameters", "-NoProfile -ExecutionPolicy Bypass -File `"$TargetRepo\ops\nssm\run-nginx.ps1`" -NginxRoot `"$NginxRoot`"")

$nodeServices = @{
    "ParallelControlPlane" = "apps\control-plane\src\server.js"
    "ParallelInboundGateway" = "apps\inbound-gateway\src\server.js"
    "ParallelOutboundGateway" = "apps\outbound-gateway\src\server.js"
    "ParallelRingCentralCx" = "apps\ringcentral-cx\src\server.js"
    "ParallelNgrok" = "scripts\run-ngrok.js"
}

foreach ($pair in $nodeServices.GetEnumerator()) {
    Invoke-Nssm @("set", $pair.Key, "Application", $Node)
    Invoke-Nssm @("set", $pair.Key, "AppDirectory", $TargetRepo)
    Invoke-Nssm @("set", $pair.Key, "AppParameters", $pair.Value)
}

if (Get-Service -Name "ParallelRestartHelper" -ErrorAction SilentlyContinue) {
    Invoke-Nssm @("set", "ParallelRestartHelper", "Application", "C:\windows\System32\WindowsPowerShell\v1.0\powershell.exe")
    Invoke-Nssm @("set", "ParallelRestartHelper", "AppDirectory", $TargetRepo)
    Invoke-Nssm @("set", "ParallelRestartHelper", "AppParameters", "-NoProfile -ExecutionPolicy Bypass -File `"$TargetRepo\ops\nssm\restart-parallel-stack.ps1`"")
}

Write-OK "NSSM service paths updated"

Write-Step "Start services from target"
$startOrder = @(
    "ParallelNginx",
    "ParallelControlPlane",
    "ParallelInboundGateway",
    "ParallelOutboundGateway",
    "ParallelRingCentralCx"
)
if ($IncludeMongo) { $startOrder = @("ParallelMongo") + $startOrder }
foreach ($svc in $startOrder) {
    Start-ServiceAndWait -Name $svc
}

if ($ngrokWasRunning) {
    Start-ServiceAndWait -Name "ParallelNgrok"
} else {
    Write-Host "  [ok] ParallelNgrok was stopped before relocation; leaving it stopped." -ForegroundColor Green
}

Write-Step "Healthcheck"
Push-Location $TargetRepo
try {
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\ops\cutover\healthcheck.ps1 -SkipRingCentralPing
    if ($LASTEXITCODE -ne 0) {
        throw "healthcheck failed"
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Relocation complete. Services now point at: $TargetRepo" -ForegroundColor Green
Write-Host "Old source left in place: $SourceRepo" -ForegroundColor Yellow
