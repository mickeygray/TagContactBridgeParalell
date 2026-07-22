param(
    [switch]$DryRun,
    [switch]$SkipMongo,
    [switch]$IncludeMongo,
    [switch]$SkipNginx,
    [switch]$SkipNgrok,
    [switch]$SkipBlogger,
    [switch]$BuildWeb,
    [switch]$Healthcheck,
    [switch]$EnsureAutomatic,
    [switch]$Strict
)

$ErrorActionPreference = "Stop"

$Repo = if ($env:PARALLEL_REPO_ROOT) {
    $env:PARALLEL_REPO_ROOT
} else {
    Resolve-Path (Join-Path $PSScriptRoot "..\..") | Select-Object -ExpandProperty Path
}

$Npm = if ($env:NPM_EXE -and (Test-Path $env:NPM_EXE)) {
    $env:NPM_EXE
} else {
    (Get-Command npm.cmd -ErrorAction Stop).Source
}

$HealthcheckScript = Join-Path $Repo "ops\cutover\healthcheck.ps1"

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

$SkipLocalMongo = [bool]$SkipMongo -or -not [bool]$IncludeMongo

$ServiceCatalog = @{
    ParallelMongo           = @{ Label = "Mongo (local optional)"; Optional = $true;  Ports = @(27017); Skip = $SkipLocalMongo;  HealthUrls = @(); HealthRequired = $false }
    ParallelControlPlane    = @{ Label = "Control plane";    Optional = $false; Ports = @($ControlPlanePort);    Skip = $false; HealthUrls = @("http://127.0.0.1:${ControlPlanePort}/health"); HealthRequired = $true }
    ParallelInboundGateway  = @{ Label = "Inbound gateway";  Optional = $false; Ports = @($InboundGatewayPort);  Skip = $false; HealthUrls = @("http://127.0.0.1:${InboundGatewayPort}/health"); HealthRequired = $true }
    ParallelOutboundGateway = @{ Label = "Outbound gateway"; Optional = $false; Ports = @($OutboundGatewayPort); Skip = $false; HealthUrls = @("http://127.0.0.1:${OutboundGatewayPort}/health"); HealthRequired = $true }
    ParallelRingCentralCx   = @{ Label = "RingCentral CX";   Optional = $false; Ports = @($RingcentralCxPort);   Skip = $false; HealthUrls = @("http://127.0.0.1:${RingcentralCxPort}/health"); HealthRequired = $true }
    ParallelBlogger         = @{ Label = "Blogger";          Optional = $true;  Ports = @();     Skip = [bool]$SkipBlogger; HealthUrls = @(); HealthRequired = $false }
    ParallelNginx           = @{ Label = "nginx";            Optional = $true;  Ports = @(80, 81); Skip = [bool]$SkipNginx; HealthUrls = @("http://127.0.0.1:81/"); HealthRequired = $true }
    ParallelNgrok           = @{ Label = "ngrok";            Optional = $true;  Ports = @();     Skip = [bool]$SkipNgrok;   HealthUrls = @("https://tag-webhook.ngrok.app/login"); HealthRequired = $false }
}

$StopOrder = @(
    "ParallelNgrok",
    "ParallelNginx",
    "ParallelBlogger",
    "ParallelRingCentralCx",
    "ParallelOutboundGateway",
    "ParallelInboundGateway",
    "ParallelControlPlane",
    "ParallelMongo"
)

$StartOrder = @(
    "ParallelMongo",
    "ParallelControlPlane",
    "ParallelInboundGateway",
    "ParallelOutboundGateway",
    "ParallelRingCentralCx",
    "ParallelBlogger",
    "ParallelNginx",
    "ParallelNgrok"
)

function Write-Step($message) {
    Write-Host "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] $message"
}

$script:RestartSummary = @()
$script:RestartFailures = @()

function Add-Summary($serviceName, $result, $detail = "") {
    $entry = Get-CatalogEntry $serviceName
    $label = $serviceName
    if ($entry -and $entry.ContainsKey("Label") -and $entry.Label) {
        $label = $entry.Label
    }
    $script:RestartSummary += [pscustomobject]@{
        Service = $label
        Result = $result
        Detail = $detail
    }
}

function Get-ServiceLabel($name) {
    $entry = Get-CatalogEntry $name
    if ($entry -and $entry.ContainsKey("Label") -and $entry.Label) { return $entry.Label }
    return $name
}

function Get-CatalogEntry($name) {
    if ($ServiceCatalog.ContainsKey($name)) { return $ServiceCatalog[$name] }
    return $null
}

function Test-ServiceIncluded($name) {
    $entry = Get-CatalogEntry $name
    if (-not $entry) { return $false }
    return -not [bool]$entry.Skip
}

function Get-StackService($name) {
    return Get-Service -Name $name -ErrorAction SilentlyContinue
}

function Handle-MissingService($name) {
    $entry = Get-CatalogEntry $name
    $isOptional = [bool]$entry.Optional
    if ($Strict -or -not $isOptional) {
        throw "Required service '$name' is not installed."
    }
    Write-Step "Skipping missing optional service $name"
    return $false
}

function Wait-ForServiceState($name, $desiredStatus, $timeoutSeconds = 45) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    do {
        $service = Get-Service -Name $name -ErrorAction Stop
        if ($service.Status -eq $desiredStatus) {
            return $service
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    throw "Service '$name' did not reach state '$desiredStatus' within $timeoutSeconds seconds."
}

function Wait-ForPort($port, $timeoutSeconds = 45) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    do {
        $open = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($open) { return $true }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Test-HealthUrl($url, $timeoutSeconds = 15) {
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSeconds
        return [pscustomobject]@{
            Ok = ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
            Status = [int]$response.StatusCode
            Detail = "HTTP $($response.StatusCode)"
        }
    } catch {
        $statusCode = $null
        if ($_.Exception.Response) {
            try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { $statusCode = $null }
        }
        return [pscustomobject]@{
            Ok = $false
            Status = $statusCode
            Detail = if ($statusCode) { "HTTP $statusCode" } else { $_.Exception.Message }
        }
    }
}

function Stop-StackService($name) {
    $label = Get-ServiceLabel $name
    if (-not (Test-ServiceIncluded $name)) {
        Write-Step "[skip] $label skipped by switch"
        Add-Summary $name "skipped" "disabled by switch"
        return
    }
    $service = Get-StackService $name
    if (-not $service) {
        Handle-MissingService $name | Out-Null
        return
    }
    if ($service.Status -eq "Stopped") {
        Write-Step "[ok] $label already stopped"
        return
    }
    if ($DryRun) {
        Write-Step "[dry-run] would stop $label (current: $($service.Status))"
        return
    }
    Write-Step "[stop] $label stopping..."
    Stop-Service -Name $name -Force -ErrorAction Stop
    Wait-ForServiceState -name $name -desiredStatus "Stopped" -timeoutSeconds 60 | Out-Null
    Write-Step "[ok] $label stopped"
}

function Start-StackService($name) {
    $label = Get-ServiceLabel $name
    if (-not (Test-ServiceIncluded $name)) {
        Write-Step "[skip] $label skipped by switch"
        return
    }
    $service = Get-StackService $name
    if (-not $service) {
        Handle-MissingService $name | Out-Null
        return
    }
    if ($EnsureAutomatic -and -not $DryRun) {
        Set-Service -Name $name -StartupType Automatic -ErrorAction Stop
        Write-Step "[ok] $label startup set to Automatic"
    }
    if ($DryRun) {
        $startupText = if ($EnsureAutomatic) { " and set Automatic" } else { "" }
        Write-Step "[dry-run] would start $label$startupText"
        Add-Summary $name "dry-run" "would start"
        return
    }
    Write-Step "[start] $label starting..."
    Start-Service -Name $name -ErrorAction Stop
    Wait-ForServiceState -name $name -desiredStatus "Running" -timeoutSeconds 60 | Out-Null
    Write-Step "[ok] $label service running"

    $entry = Get-CatalogEntry $name
    $detailParts = @("service running")
    foreach ($port in @($entry.Ports)) {
        Write-Step "[wait] $label waiting for port $port..."
        if (-not (Wait-ForPort $port 60)) {
            throw "$name started but port $port did not open."
        }
        Write-Step "[ok] $label port $port online"
        $detailParts += "port $port"
    }
    foreach ($url in @($entry.HealthUrls)) {
        Write-Step "[wait] $label checking $url..."
        $probe = Test-HealthUrl $url
        $healthRequired = [bool]$entry.HealthRequired -or [bool]$Strict
        if ($probe.Ok) {
            Write-Step "[ok] $label online ($($probe.Detail))"
            $detailParts += "$url $($probe.Detail)"
        } elseif ($healthRequired) {
            throw "$name health check failed for ${url}: $($probe.Detail)"
        } else {
            Write-Step "[warn] $label health probe did not confirm online ($($probe.Detail))"
            $detailParts += "$url warn $($probe.Detail)"
        }
    }
    Add-Summary $name "online" ($detailParts -join "; ")
}

if (-not (Test-Path $Repo)) {
    throw "Repo not found: $Repo"
}

Write-Step "Universal Parallel restart starting"
Write-Step "Repo: $Repo"

if ($BuildWeb) {
    if ($DryRun) {
        Write-Step "[dry-run] would run npm build:web"
    } else {
        Write-Step "[build] Building web client before restart..."
        Push-Location $Repo
        try {
            & $Npm run build:web
            if ($LASTEXITCODE -ne 0) { throw "npm run build:web failed with exit code $LASTEXITCODE" }
            Write-Step "[ok] Web client built"
        } finally {
            Pop-Location
        }
    }
}

foreach ($serviceName in $StopOrder) {
    try {
        Stop-StackService $serviceName
    } catch {
        $message = $_.Exception.Message
        Write-Step "[error] $(Get-ServiceLabel $serviceName) stop failed: $message"
        Add-Summary $serviceName "stop failed" $message
        $script:RestartFailures += "${serviceName} stop: $message"
    }
}

foreach ($serviceName in $StartOrder) {
    try {
        Start-StackService $serviceName
    } catch {
        $message = $_.Exception.Message
        Write-Step "[error] $(Get-ServiceLabel $serviceName) start/health failed: $message"
        Add-Summary $serviceName "start/health failed" $message
        $script:RestartFailures += "${serviceName} start/health: $message"
    }
}

if ($Healthcheck) {
    if (-not (Test-Path $HealthcheckScript)) {
        throw "Healthcheck script not found at $HealthcheckScript"
    }
    if ($DryRun) {
        Write-Step "[dry-run] would run cutover healthcheck"
    } else {
        Write-Step "[check] Running local healthcheck..."
        Push-Location $Repo
        try {
            powershell.exe -NoProfile -ExecutionPolicy Bypass -File $HealthcheckScript -SkipRingCentralPing
            Write-Step "[ok] Local healthcheck completed"
        } finally {
            Pop-Location
        }
    }
}

if ($script:RestartSummary.Count -gt 0) {
    Write-Step "Restart summary"
    $script:RestartSummary | Format-Table -AutoSize
}

if ($script:RestartFailures.Count -gt 0) {
    Write-Step "Universal Parallel restart finished with $($script:RestartFailures.Count) failure(s); every included service was still attempted."
    throw ($script:RestartFailures -join " | ")
}

Write-Step "Universal Parallel restart complete"
