param()

$ErrorActionPreference = "Stop"

$root = "C:\Users\Admin\Code\TagContactBridgeParallel"
$installScript = Join-Path $root "ops\nssm\install-services.ps1"
$ports = 3001, 4001, 4002, 5001, 6101
$serviceOrder = @(
    "ParallelControlPlane",
    "ParallelInboundGateway",
    "ParallelOutboundGateway",
    "ParallelRingCentralCx",
    "ParallelBlogger"
)

function Stop-ParallelPortProcess($port) {
    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in @($connections)) {
        $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
        if (-not $process) {
            continue
        }

        if ($process.ProcessName -notin @("node", "ngrok")) {
            throw "Port $port is owned by unexpected process '$($process.ProcessName)' (PID $($process.Id)). Refusing to kill it automatically."
        }

        Write-Host "Stopping $($process.ProcessName) on port $port (PID $($process.Id))..."
        Stop-Process -Id $process.Id -Force
        Start-Sleep -Milliseconds 750
    }
}

Write-Host "Stopping existing Parallel dev listeners if present..."
foreach ($port in $ports) {
    Stop-ParallelPortProcess $port
}

Write-Host "Installing NSSM services..."
powershell -ExecutionPolicy Bypass -File $installScript

Write-Host "Starting NSSM services..."
foreach ($name in $serviceOrder) {
    Start-Service $name
    Start-Sleep -Seconds 2
}

Write-Host ""
Get-Service Parallel* | Select-Object Name, Status, StartType | Format-Table -AutoSize
