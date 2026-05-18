# healthcheck.ps1
# ------------------------------------------------------------------------------
# Verifies the Parallel stack is alive locally. This script is read-only.
# Exit code: 0 if all required checks pass, 1 if any required check fails.
# ------------------------------------------------------------------------------

param(
    [int]$ControlPlanePort = $(if ($env:CONTROL_PLANE_PORT) { [int]$env:CONTROL_PLANE_PORT } else { 5001 }),
    [int]$InboundGatewayPort = $(if ($env:INBOUND_GATEWAY_PORT) { [int]$env:INBOUND_GATEWAY_PORT } else { 4001 }),
    [int]$OutboundGatewayPort = $(if ($env:OUTBOUND_GATEWAY_PORT) { [int]$env:OUTBOUND_GATEWAY_PORT } else { 4002 }),
    [int]$RingcentralCxPort = $(if ($env:RINGCENTRAL_CX_PORT) { [int]$env:RINGCENTRAL_CX_PORT } else { 6101 }),
    [int]$NginxPort = 81,
    [switch]$SkipRingCentralPing
)

$ErrorActionPreference = "Continue"
$results = @()

function Add-Result {
    param(
        [string]$Label,
        [string]$Url,
        [bool]$Ok,
        [object]$Status,
        [bool]$Required = $true,
        [string]$Note = ""
    )

    return @{
        label = $Label
        url = $Url
        ok = $Ok
        status = $Status
        required = $Required
        note = $Note
    }
}

function Test-Endpoint {
    param(
        [string]$Label,
        [string]$Url,
        [int]$TimeoutSec = 5,
        [bool]$Required = $true
    )

    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        $ok = ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400)
        return Add-Result $Label $Url $ok $r.StatusCode $Required ""
    } catch {
        $statusCode = $null
        if ($_.Exception.Response) {
            try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { $statusCode = $null }
        }
        return Add-Result $Label $Url $false $statusCode $Required $_.Exception.Message
    }
}

function Test-TcpPort {
    param(
        [string]$Label,
        [string]$HostName = "127.0.0.1",
        [int]$Port,
        [int]$TimeoutMs = 1500
    )

    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($HostName, $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutMs)
        if ($ok) { $client.EndConnect($iar) }
        $client.Close()

        if ($ok) {
            $status = "open"
        } else {
            $status = "timeout"
        }

        return Add-Result $Label "${HostName}:${Port}" $ok $status $true ""
    } catch {
        return Add-Result $Label "${HostName}:${Port}" $false "error" $true $_.Exception.Message
    }
}

Write-Host ""
Write-Host "=== Parallel stack health check ===" -ForegroundColor Cyan
Write-Host "Configured ports: cp=$ControlPlanePort, in=$InboundGatewayPort, out=$OutboundGatewayPort, cx=$RingcentralCxPort, nginx=$NginxPort"
Write-Host ""

Write-Host "TCP ports:"
$results += Test-TcpPort "control-plane" -Port $ControlPlanePort
$results += Test-TcpPort "inbound-gateway" -Port $InboundGatewayPort
$results += Test-TcpPort "outbound-gateway" -Port $OutboundGatewayPort
$results += Test-TcpPort "ringcentral-cx" -Port $RingcentralCxPort
$results += Test-TcpPort "nginx" -Port $NginxPort

Write-Host ""
Write-Host "HTTP health endpoints:"
$results += Test-Endpoint "control-plane /health" "http://localhost:$ControlPlanePort/health"
$results += Test-Endpoint "inbound-gateway /health" "http://localhost:$InboundGatewayPort/health"
$results += Test-Endpoint "outbound-gateway /health" "http://localhost:$OutboundGatewayPort/health"
$results += Test-Endpoint "ringcentral-cx /health" "http://localhost:$RingcentralCxPort/health"
$results += Test-Endpoint "nginx /" "http://localhost:$NginxPort/"

Write-Host ""
Write-Host "NSSM service status:"
$svcNames = @(
    "ParallelNginx",
    "ParallelControlPlane",
    "ParallelInboundGateway",
    "ParallelOutboundGateway",
    "ParallelRingCentralCx"
)

foreach ($svc in $svcNames) {
    $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if ($s) {
        $ok = ($s.Status -eq "Running")
        $results += Add-Result "service $svc" "" $ok $s.Status $true ""
    } else {
        $results += Add-Result "service $svc" "" $false "not-installed" $true ""
    }
}

Write-Host ""
Write-Host "RC kill-switch:"
$envPath = Join-Path $PSScriptRoot "..\..\.env"
if (Test-Path $envPath) {
    $envText = Get-Content $envPath -Raw
    $suspended = ($envText -match "(?m)^\s*PARALLEL_RC_SUSPENDED\s*=\s*(true|1|yes|on)\b")
    if ($suspended) {
        Write-Host "  PARALLEL_RC_SUSPENDED=TRUE (RC traffic silenced)" -ForegroundColor Yellow
    } else {
        Write-Host "  PARALLEL_RC_SUSPENDED=FALSE (RC traffic ACTIVE)" -ForegroundColor Green
    }
} else {
    Write-Host "  no .env at expected path" -ForegroundColor Red
}

if (-not $SkipRingCentralPing) {
    Write-Host ""
    Write-Host "RingCentral reachability (DNS + TLS only; no auth):"
    $results += Test-Endpoint "RC platform reachable" "https://platform.ringcentral.com/restapi/v1.0/status" -Required $false
}

Write-Host ""
Write-Host "Upstream API reachability (DNS + TLS only):"
$results += Test-Endpoint "MongoDB Atlas" "https://cloud.mongodb.com/" -Required $false
$results += Test-Endpoint "Anthropic API" "https://api.anthropic.com/" -Required $false
$results += Test-Endpoint "OpenAI API" "https://api.openai.com/" -Required $false
$results += Test-Endpoint "Google APIs" "https://www.googleapis.com/" -Required $false

Write-Host ""
Write-Host "App configuration smoke:"
try {
    $cfgUrl = "http://localhost:$ControlPlanePort/api/sales-trainer/config"
    Invoke-RestMethod -Uri $cfgUrl -TimeoutSec 5 -ErrorAction Stop | Out-Null
    $results += Add-Result "trainer config route responding" $cfgUrl $true "configured" $false ""
} catch {
    $statusCode = $null
    if ($_.Exception.Response) {
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { $statusCode = $null }
    }

    if ($statusCode -eq 401 -or $statusCode -eq 403) {
        $results += Add-Result "trainer config route responding (auth-gated)" $cfgUrl $true "$statusCode auth-required" $false "expected; needs trainer token"
    } else {
        $results += Add-Result "trainer config route responding" $cfgUrl $false $statusCode $false $_.Exception.Message
    }
}

Write-Host ""
Write-Host "=== Results ===" -ForegroundColor Cyan
$failed = @()

foreach ($r in $results) {
    if ($r.ok) {
        $sym = "[ok]"
        $color = "Green"
    } elseif ($r.required) {
        $sym = "[FAIL]"
        $color = "Red"
    } else {
        $sym = "[skip]"
        $color = "DarkGray"
    }

    $line = "  $sym  $($r.label)"
    if ($r.url) { $line += " ($($r.url))" }
    if ($r.status) { $line += " -> $($r.status)" }
    if ($r.note) { $line += " [$($r.note)]" }
    Write-Host $line -ForegroundColor $color

    if (-not $r.ok -and $r.required) {
        $failed += $r
    }
}

Write-Host ""
if ($failed.Count -eq 0) {
    Write-Host "All required checks passed." -ForegroundColor Green
    exit 0
}

Write-Host "$($failed.Count) required check(s) failed." -ForegroundColor Red
exit 1
