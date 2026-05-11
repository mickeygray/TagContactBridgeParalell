param(
    [switch]$DryRun,
    [switch]$SkipNginx,
    [switch]$SkipNgrok
)

$ErrorActionPreference = "Stop"

$Repo = "C:\Users\Admin\Code\TagContactBridgeParallel"
$NginxExe = $env:NGINX_EXE
if (-not $NginxExe) {
    $NginxExe = "C:\tools\nginx-1.29.6\nginx.exe"
}

$NodeExe = (Get-Command node).Source
$NgrokEnsureScript = Join-Path $Repo "scripts\ensure-parallel-ngrok-tunnel.js"
$ServiceOrder = @(
    "ParallelInboundGateway",
    "ParallelOutboundGateway",
    "ParallelRingCentralCx",
    "ParallelControlPlane"
)

function Write-Step($message) {
    Write-Host "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] $message"
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

function Restart-OrStartService($name) {
    $service = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $service) {
        throw "Required service '$name' is not installed."
    }

    if ($DryRun) {
        Write-Step "DRY RUN: would restart/start $name (current: $($service.Status))"
        return
    }

    if ($service.Status -eq "Running") {
        Write-Step "Restarting $name..."
        Restart-Service -Name $name -Force -ErrorAction Stop
    } else {
        Write-Step "Starting $name..."
        Start-Service -Name $name -ErrorAction Stop
    }

    Wait-ForServiceState -name $name -desiredStatus "Running" | Out-Null
    Write-Step "$name is Running"
}

function Reload-Nginx {
    if ($SkipNginx) {
        Write-Step "Skipping nginx reload"
        return
    }
    if (-not (Test-Path $NginxExe)) {
        throw "nginx.exe not found at $NginxExe"
    }

    if ($DryRun) {
        Write-Step "DRY RUN: would test and reload nginx via $NginxExe"
        return
    }

    Write-Step "Testing nginx config..."
    & $NginxExe -t
    Write-Step "Reloading nginx..."
    & $NginxExe -s reload
}

function Ensure-ParallelNgrokTunnel {
    if ($SkipNgrok) {
        Write-Step "Skipping ngrok tunnel ensure"
        return
    }
    if (-not (Test-Path $NgrokEnsureScript)) {
        throw "ngrok ensure script not found at $NgrokEnsureScript"
    }

    if ($DryRun) {
        Write-Step "DRY RUN: would run node $NgrokEnsureScript"
        return
    }

    Write-Step "Ensuring Parallel ngrok tunnel..."
    Push-Location $Repo
    try {
        & $NodeExe $NgrokEnsureScript
    } finally {
        Pop-Location
    }
}

Write-Step "Parallel restart helper starting"
Write-Step "Scope: Parallel core only (legacy and old blogger daemon untouched)"

foreach ($serviceName in $ServiceOrder) {
    Restart-OrStartService -name $serviceName
}

Reload-Nginx
Ensure-ParallelNgrokTunnel

Write-Step "Parallel restart helper complete"
