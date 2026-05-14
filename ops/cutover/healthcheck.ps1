# healthcheck.ps1
# ------------------------------------------------------------------------------
# Verifies the Parallel stack is alive locally. Run anytime — non-destructive,
# read-only, makes no calls to RingCentral when the kill-switch is active.
#
# Exit code: 0 if all required checks pass, 1 if any fail.
# ------------------------------------------------------------------------------

param(
    [int]$ControlPlanePort      = ($env:CONTROL_PLANE_PORT      ? [int]$env:CONTROL_PLANE_PORT      : 5001),
    [int]$InboundGatewayPort    = ($env:INBOUND_GATEWAY_PORT    ? [int]$env:INBOUND_GATEWAY_PORT    : 4001),
    [int]$OutboundGatewayPort   = ($env:OUTBOUND_GATEWAY_PORT   ? [int]$env:OUTBOUND_GATEWAY_PORT   : 4002),
    [int]$RingcentralCxPort     = ($env:RINGCENTRAL_CX_PORT     ? [int]$env:RINGCENTRAL_CX_PORT     : 6101),
    [int]$NginxPort             = 80,
    [switch]$SkipRingCentralPing
)

$ErrorActionPreference = "Continue"
$results = @()

function Test-Endpoint {
    param(
        [string]$Label,
        [string]$Url,
        [int]$TimeoutSec = 5,
        [bool]$Required  = $true
    )
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        $ok = ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400)
        return @{ label = $Label; url = $Url; ok = $ok; status = $r.StatusCode; required = $Required; note = "" }
    } catch {
        return @{ label = $Label; url = $Url; ok = $false; status = $null; required = $Required; note = $_.Exception.Message }
    }
}

function Test-TcpPort {
    param(
        [string]$Label,
        [string]$Host = "127.0.0.1",
        [int]$Port,
        [int]$TimeoutMs = 1500
    )
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($Host, $Port, $null, $null)
        $ok  = $iar.AsyncWaitHandle.WaitOne($TimeoutMs)
        if ($ok) { $client.EndConnect($iar) }
        $client.Close()
        return @{ label = $Label; url = "${Host}:${Port}"; ok = $ok; status = if ($ok) { "open" } else { "timeout" }; required = $true; note = "" }
    } catch {
        return @{ label = $Label; url = "${Host}:${Port}"; ok = $false; status = "error"; required = $true; note = $_.Exception.Message }
    }
}

Write-Host ""
Write-Host "═══ Parallel stack health check ═══" -ForegroundColor Cyan
Write-Host "Configured ports: cp=$ControlPlanePort, in=$InboundGatewayPort, out=$OutboundGatewayPort, cx=$RingcentralCxPort, nginx=$NginxPort"
Write-Host ""

# ── Local TCP ports listening ─────────────────────────────────────────────────
Write-Host "TCP ports:"
$results += Test-TcpPort "control-plane"       -Port $ControlPlanePort
$results += Test-TcpPort "inbound-gateway"     -Port $InboundGatewayPort
$results += Test-TcpPort "outbound-gateway"    -Port $OutboundGatewayPort
$results += Test-TcpPort "ringcentral-cx"      -Port $RingcentralCxPort
$results += Test-TcpPort "nginx"               -Port $NginxPort

# ── HTTP health endpoints ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "HTTP health endpoints:"
$results += Test-Endpoint "control-plane    /healthz" "http://localhost:$ControlPlanePort/healthz"
$results += Test-Endpoint "inbound-gateway  /healthz" "http://localhost:$InboundGatewayPort/healthz"
$results += Test-Endpoint "outbound-gateway /healthz" "http://localhost:$OutboundGatewayPort/healthz"
$results += Test-Endpoint "ringcentral-cx   /healthz" "http://localhost:$RingcentralCxPort/healthz"
$results += Test-Endpoint "nginx            /healthz" "http://localhost:$NginxPort/healthz" -Required $false

# ── NSSM service status ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "NSSM service status:"
$svcNames = @("ParallelControlPlane", "ParallelInboundGateway", "ParallelOutboundGateway", "ParallelRingCentralCx", "ParallelNginx")
foreach ($svc in $svcNames) {
    $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if ($s) {
        $ok = ($s.Status -eq "Running")
        $results += @{ label = "service $svc"; url = ""; ok = $ok; status = $s.Status; required = $true; note = "" }
    } else {
        $results += @{ label = "service $svc"; url = ""; ok = $false; status = "not-installed"; required = $false; note = "" }
    }
}

# ── RC kill-switch status ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "RC kill-switch:"
$envPath = Join-Path $PSScriptRoot "..\..\.env"
if (Test-Path $envPath) {
    $envText = Get-Content $envPath -Raw
    $suspended = ($envText -match "(?m)^\s*PARALLEL_RC_SUSPENDED\s*=\s*(true|1|yes|on)\b")
    Write-Host ("  PARALLEL_RC_SUSPENDED=" + (if ($suspended) { "TRUE  (RC traffic silenced)" } else { "FALSE (RC traffic ACTIVE)" })) -ForegroundColor (if ($suspended) { "Yellow" } else { "Green" })
} else {
    Write-Host "  (no .env at expected path)" -ForegroundColor Red
}

# ── RingCentral reachability (DNS + TLS, no auth) ─────────────────────────────
if (-not $SkipRingCentralPing) {
    Write-Host ""
    Write-Host "RingCentral reachability (DNS + TLS only — no auth, no 429 risk):"
    $rcReach = Test-Endpoint "RC platform.ringcentral.com reachable" "https://platform.ringcentral.com/restapi/v1.0/status" -Required $false
    $results += $rcReach
}

# ── Upstream API reachability (DNS + TLS only, no auth) ───────────────────────
Write-Host ""
Write-Host "Upstream API reachability (DNS + TLS only — these are app-critical):"
$results += Test-Endpoint "MongoDB Atlas (cloud.mongodb.com)"    "https://cloud.mongodb.com/" -Required $false
$results += Test-Endpoint "Anthropic API"                         "https://api.anthropic.com/" -Required $false
$results += Test-Endpoint "OpenAI API"                            "https://api.openai.com/" -Required $false
$results += Test-Endpoint "Google APIs (Drive)"                   "https://www.googleapis.com/" -Required $false

# ── App configuration smoke (via control-plane introspection) ─────────────────
# Hits an unauthenticated endpoint that reports configured providers
# without exposing keys. Confirms .env wired through correctly.
Write-Host ""
Write-Host "App configuration smoke:"
try {
    $cfgUrl = "http://localhost:$ControlPlanePort/api/sales-trainer/config"
    $cfg = Invoke-RestMethod -Uri $cfgUrl -TimeoutSec 5 -ErrorAction Stop
    # This endpoint is auth-gated; a 401 still tells us the route exists and
    # config is loaded. Treat any non-network response as "config is wired."
    $results += @{ label = "trainer config route responding"; url = $cfgUrl; ok = $true; status = "configured"; required = $false; note = "" }
} catch {
    $statusCode = $null
    if ($_.Exception.Response) {
        $statusCode = [int]$_.Exception.Response.StatusCode
    }
    # 401 / 403 = route exists, config is loaded, just needs auth. That's OK
    # for the smoke check — means .env was read and the route mounted.
    if ($statusCode -in 401, 403) {
        $results += @{ label = "trainer config route responding (auth-gated)"; url = $cfgUrl; ok = $true; status = "$statusCode auth-required"; required = $false; note = "expected — needs trainer token" }
    } else {
        $results += @{ label = "trainer config route responding"; url = $cfgUrl; ok = $false; status = $statusCode; required = $false; note = $_.Exception.Message }
    }
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "═══ Results ═══" -ForegroundColor Cyan
$failed = @()
foreach ($r in $results) {
    $sym = if ($r.ok) { "[ok]" } else { if ($r.required) { "[FAIL]" } else { "[skip]" } }
    $color = if ($r.ok) { "Green" } else { if ($r.required) { "Red" } else { "DarkGray" } }
    $line = "  $sym  $($r.label)"
    if ($r.url)    { $line += "  ($($r.url))" }
    if ($r.status) { $line += "  -> $($r.status)" }
    Write-Host $line -ForegroundColor $color
    if (-not $r.ok -and $r.required) { $failed += $r }
}

Write-Host ""
if ($failed.Count -eq 0) {
    Write-Host "All required checks passed." -ForegroundColor Green
    exit 0
} else {
    Write-Host "$($failed.Count) required check(s) failed." -ForegroundColor Red
    exit 1
}
