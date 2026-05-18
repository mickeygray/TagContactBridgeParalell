# bring-online-and-go-live.ps1
# ------------------------------------------------------------------------------
# One-shot cutover for the new Parallel host.
#
# Sequence:
#   1. Require Administrator PowerShell.
#   2. Start the local Windows services.
#   3. Run local health checks while RingCentral is still suspended.
#   4. Start the ParallelNgrok service.
#   5. Confirm the reserved public ngrok domain reaches THIS control-plane.
#   6. Flip PARALLEL_RC_SUSPENDED=false in .env.
#   7. Restart RC-touching services so they pick up the new env.
#   8. Run post-cutover checks.
#
# The old host must be stopped first. If the reserved ngrok domain is still
# attached to the old host, this script should fail before flipping RC live.
# ------------------------------------------------------------------------------

param(
    [switch]$Force,
    [switch]$SkipPublicProbe,
    [string]$Domain = "",
    [int]$ControlPlanePort = $(if ($env:CONTROL_PLANE_PORT) { [int]$env:CONTROL_PLANE_PORT } else { 5001 }),
    [int]$NgrokApiPort = 4040,
    [int]$TunnelTimeoutSec = 180
)

$ErrorActionPreference = "Stop"

function Write-Step($Message) {
    Write-Host ""
    Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Write-OK($Message) {
    Write-Host "  [ok] $Message" -ForegroundColor Green
}

function Write-Warn($Message) {
    Write-Host "  [warn] $Message" -ForegroundColor Yellow
}

function Write-Fail($Message) {
    Write-Host "  [fail] $Message" -ForegroundColor Red
}

function Require-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        throw "Run this script from PowerShell as Administrator."
    }
}

function Wait-ServiceRunning {
    param(
        [string]$Name,
        [int]$TimeoutSec = 45
    )

    $svc = Get-Service -Name $Name -ErrorAction Stop
    if ($svc.Status -ne "Running") {
        Start-Service -Name $Name -ErrorAction Stop
    }

    $svc = Get-Service -Name $Name -ErrorAction Stop
    $svc.WaitForStatus("Running", [TimeSpan]::FromSeconds($TimeoutSec))
    Write-OK "$Name is Running"
}

function StartOrRestart-ServiceAndWait {
    param(
        [string]$Name,
        [int]$TimeoutSec = 60
    )

    $svc = Get-Service -Name $Name -ErrorAction Stop
    if ($svc.Status -eq "Running") {
        Restart-Service -Name $Name -Force -ErrorAction Stop
    } else {
        Start-Service -Name $Name -ErrorAction Stop
    }

    $svc = Get-Service -Name $Name -ErrorAction Stop
    $svc.WaitForStatus("Running", [TimeSpan]::FromSeconds($TimeoutSec))
    Write-OK "$Name is Running"
}

function Restart-ServiceAndWait {
    param(
        [string]$Name,
        [int]$TimeoutSec = 60
    )

    $svc = Get-Service -Name $Name -ErrorAction Stop
    if ($svc.Status -eq "Running") {
        Restart-Service -Name $Name -Force -ErrorAction Stop
    } else {
        Start-Service -Name $Name -ErrorAction Stop
    }

    $svc = Get-Service -Name $Name -ErrorAction Stop
    $svc.WaitForStatus("Running", [TimeSpan]::FromSeconds($TimeoutSec))
    Write-OK "$Name restarted and Running"
}

function Read-DotEnvValue {
    param(
        [string]$Path,
        [string]$Name
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    $pattern = "^\s*" + [regex]::Escape($Name) + "\s*=(.*)$"
    $lines = Get-Content -LiteralPath $Path
    $value = $null
    foreach ($line in $lines) {
        $match = [regex]::Match($line, $pattern)
        if ($match.Success) {
            $value = $match.Groups[1].Value.Trim()
        }
    }

    if ($null -eq $value) {
        return $null
    }

    return $value.Trim('"').Trim("'")
}

function Set-DotEnvValue {
    param(
        [string]$Path,
        [string]$Name,
        [string]$Value
    )

    $text = Get-Content -LiteralPath $Path -Raw
    $line = "$Name=$Value"
    $pattern = "(?m)^\s*" + [regex]::Escape($Name) + "\s*=.*$"

    if ([regex]::IsMatch($text, $pattern)) {
        $text = [regex]::Replace($text, $pattern, $line)
    } else {
        if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) {
            $text += "`n"
        }
        $text += "$line`n"
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $text, $utf8NoBom)
}

function Get-ClientRuntime {
    param(
        [string]$Url,
        [int]$TimeoutSec = 8
    )

    return Invoke-RestMethod -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
}

function Wait-NgrokTunnel {
    param(
        [string]$ExpectedDomain,
        [int]$ApiPort,
        [int]$TimeoutSec
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $apiUrl = "http://127.0.0.1:$ApiPort/api/tunnels"
    $expectedHost = $ExpectedDomain.ToLowerInvariant()

    do {
        try {
            $payload = Invoke-RestMethod -Uri $apiUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            foreach ($tunnel in @($payload.tunnels)) {
                $publicUrl = [string]$tunnel.public_url
                if ($publicUrl) {
                    $host = ([uri]$publicUrl).Host.ToLowerInvariant()
                    if ($host -eq $expectedHost) {
                        Write-OK "local ngrok API reports https://$ExpectedDomain"
                        return $tunnel
                    }
                }
            }
        } catch {
            Start-Sleep -Seconds 2
            continue
        }

        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    throw "Timed out waiting for local ngrok tunnel https://$ExpectedDomain. Is the old tunnel still running?"
}

function Invoke-Healthcheck {
    param(
        [switch]$SkipRingCentralPing,
        [int]$Attempts = 8,
        [int]$DelaySec = 5
    )

    $healthcheck = Join-Path $PSScriptRoot "healthcheck.ps1"

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        if ($SkipRingCentralPing) {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $healthcheck -SkipRingCentralPing
        } else {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $healthcheck
        }

        if ($LASTEXITCODE -eq 0) {
            return
        }

        if ($attempt -lt $Attempts) {
            Write-Warn "Healthcheck failed on attempt $attempt/$Attempts; waiting $DelaySec seconds before retry"
            Start-Sleep -Seconds $DelaySec
        }
    }

    throw "Healthcheck failed after $Attempts attempt(s)."
}

Require-Administrator

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$envPath = Join-Path $repoRoot ".env"

if (-not (Test-Path -LiteralPath $envPath)) {
    throw ".env not found at $envPath"
}

if (-not $Domain) {
    $Domain = Read-DotEnvValue -Path $envPath -Name "NGROK_DOMAIN"
}
if (-not $Domain) {
    $Domain = "tagcontactbridge.ngrok.app"
}
$Domain = $Domain.Trim()
$Domain = $Domain -replace "^https?://", ""
$Domain = $Domain.TrimEnd("/")

Write-Step "Pre-flight"
Write-OK "repo: $repoRoot"
Write-OK "domain: https://$Domain"

$suspendedValue = Read-DotEnvValue -Path $envPath -Name "PARALLEL_RC_SUSPENDED"
$currentlySuspended = $false
if ($suspendedValue) {
    $currentlySuspended = $suspendedValue -match "^(true|1|yes|on)$"
}

if (-not $currentlySuspended) {
    Write-Warn "PARALLEL_RC_SUSPENDED is already false or unset. RC may already be live on this host."
    if (-not $Force) {
        $answer = Read-Host "Continue anyway? Type GO to continue"
        if ($answer -ne "GO") {
            throw "Aborted."
        }
    }
} else {
    Write-OK "RC is currently suspended on this host"
}

Write-Step "Start local services"
$coreServices = @(
    "ParallelControlPlane",
    "ParallelInboundGateway",
    "ParallelOutboundGateway",
    "ParallelRingCentralCx",
    "ParallelNginx"
)
foreach ($svc in $coreServices) {
    if ($svc -eq "ParallelNginx") {
        Wait-ServiceRunning -Name $svc
    } else {
        StartOrRestart-ServiceAndWait -Name $svc
    }
}

Write-Step "Local healthcheck before public cutover"
Invoke-Healthcheck -SkipRingCentralPing

$localRuntimeUrl = "http://localhost:$ControlPlanePort/api/client/runtime"
$localRuntime = Get-ClientRuntime -Url $localRuntimeUrl
$localRuntimeId = [string]$localRuntime.runtime.runtimeId
if (-not $localRuntimeId) {
    throw "Could not read local runtime ID from $localRuntimeUrl"
}
Write-OK "local control-plane runtime: $localRuntimeId"

Write-Step "Start ngrok tunnel"
$ngrokSvc = Get-Service -Name "ParallelNgrok" -ErrorAction Stop
$existingTunnel = $null
if ($ngrokSvc.Status -eq "Running") {
    try {
        $existingTunnel = Wait-NgrokTunnel -ExpectedDomain $Domain -ApiPort $NgrokApiPort -TimeoutSec 10
    } catch {
        Write-Warn "ParallelNgrok is running but the expected tunnel is not ready; restarting it"
        Restart-Service -Name "ParallelNgrok" -Force -ErrorAction Stop
    }
} else {
    Start-Service -Name "ParallelNgrok" -ErrorAction Stop
}
$ngrokSvc = Get-Service -Name "ParallelNgrok" -ErrorAction Stop
$ngrokSvc.WaitForStatus("Running", [TimeSpan]::FromSeconds(30))
Write-OK "ParallelNgrok is Running"

if ($null -eq $existingTunnel) {
    Wait-NgrokTunnel -ExpectedDomain $Domain -ApiPort $NgrokApiPort -TimeoutSec $TunnelTimeoutSec | Out-Null
}

if (-not $SkipPublicProbe) {
    Write-Step "Verify public domain reaches this host"
    $publicRuntimeUrl = "https://$Domain/api/client/runtime"
    $publicRuntime = Get-ClientRuntime -Url $publicRuntimeUrl -TimeoutSec 15
    $publicRuntimeId = [string]$publicRuntime.runtime.runtimeId
    if ($publicRuntimeId -ne $localRuntimeId) {
        throw "Public runtime mismatch. Local=$localRuntimeId Public=$publicRuntimeId. Refusing to flip RC."
    }
    Write-OK "public domain reaches this host runtime: $publicRuntimeId"
} else {
    Write-Warn "Skipping public runtime probe by request"
}

if (-not $Force) {
    Write-Step "Final confirmation"
    Write-Host "The public domain is on this host. The next step enables RingCentral traffic here." -ForegroundColor Yellow
    Write-Host "Confirm the old host app/ngrok are stopped before proceeding." -ForegroundColor Yellow
    $answer = Read-Host "Type GO to flip PARALLEL_RC_SUSPENDED=false"
    if ($answer -ne "GO") {
        throw "Aborted before RC flip. Ngrok remains running on this host."
    }
}

Write-Step "Flip RingCentral live"
Set-DotEnvValue -Path $envPath -Name "PARALLEL_RC_SUSPENDED" -Value "false"
Write-OK "PARALLEL_RC_SUSPENDED=false written to .env"

Write-Step "Restart RC-touching services"
$rcServices = @(
    "ParallelControlPlane",
    "ParallelRingCentralCx",
    "ParallelOutboundGateway",
    "ParallelInboundGateway"
)
foreach ($svc in $rcServices) {
    Restart-ServiceAndWait -Name $svc
}

Write-Step "Post-cutover healthcheck"
Start-Sleep -Seconds 4
Invoke-Healthcheck

if (-not $SkipPublicProbe) {
    Write-Step "Post-restart public runtime check"
    $newLocalRuntime = Get-ClientRuntime -Url $localRuntimeUrl -TimeoutSec 15
    $newPublicRuntime = Get-ClientRuntime -Url "https://$Domain/api/client/runtime" -TimeoutSec 15
    $newLocalRuntimeId = [string]$newLocalRuntime.runtime.runtimeId
    $newPublicRuntimeId = [string]$newPublicRuntime.runtime.runtimeId
    if ($newLocalRuntimeId -ne $newPublicRuntimeId) {
        throw "Post-restart public runtime mismatch. Local=$newLocalRuntimeId Public=$newPublicRuntimeId."
    }
    Write-OK "public domain still reaches this host runtime: $newPublicRuntimeId"
}

Write-Host ""
Write-Host "Cutover complete. Parallel is online on this host and RingCentral is live." -ForegroundColor Green
Write-Host "Rollback command, if needed:" -ForegroundColor Yellow
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\disable-rc.ps1`" -Force"
