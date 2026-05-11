param(
    [switch]$Uninstall,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$Nssm = "C:\Users\admin\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe"
$Repo = "C:\Users\Admin\Code\TagContactBridgeParallel"
$LogsDir = "C:\tools\logs"
$PowerShellExe = (Get-Command powershell).Source
$ServiceName = "ParallelRestartHelper"
$ScriptPath = Join-Path $Repo "ops\nssm\restart-parallel-stack.ps1"

if (-not (Test-Path $Nssm)) { throw "nssm.exe not found at $Nssm" }
if (-not (Test-Path $ScriptPath)) { throw "restart helper script not found at $ScriptPath" }
if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir | Out-Null }

function Remove-ServiceIfPresent {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Host "$ServiceName not installed, skipping"
        return
    }
    if ($svc.Status -eq "Running") {
        Stop-Service $ServiceName -Force
        Start-Sleep -Seconds 1
    }
    & $Nssm remove $ServiceName confirm | Out-Null
}

if ($Uninstall) {
    if ($DryRun) {
        Write-Host "DRY RUN: would remove $ServiceName"
        exit 0
    }
    Remove-ServiceIfPresent
    Write-Host "$ServiceName removed."
    exit 0
}

if ($DryRun) {
    Write-Host "DRY RUN: would install $ServiceName -> $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
    exit 0
}

Remove-ServiceIfPresent

& $Nssm install $ServiceName $PowerShellExe "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`"" | Out-Null
& $Nssm set $ServiceName AppDirectory $Repo | Out-Null
& $Nssm set $ServiceName Description "Manual helper that restarts the Parallel core services, reloads nginx, and re-ensures the Parallel ngrok tunnel. Legacy and the old blogger daemon are untouched." | Out-Null
& $Nssm set $ServiceName DisplayName "Parallel - Restart Helper" | Out-Null
& $Nssm set $ServiceName Start SERVICE_DEMAND_START | Out-Null
& $Nssm set $ServiceName AppEnvironmentExtra "NODE_ENV=production" | Out-Null
& $Nssm set $ServiceName AppStdout "$LogsDir\parallel-parallelrestarthelper.out.log" | Out-Null
& $Nssm set $ServiceName AppStderr "$LogsDir\parallel-parallelrestarthelper.err.log" | Out-Null
& $Nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $Nssm set $ServiceName AppRotateOnline 1 | Out-Null
& $Nssm set $ServiceName AppRotateBytes 10485760 | Out-Null
& $Nssm set $ServiceName AppExit Default Ignore | Out-Null
& $Nssm set $ServiceName AppRestartDelay 5000 | Out-Null
& $Nssm set $ServiceName ObjectName "LocalSystem" | Out-Null

Write-Host "$ServiceName installed."
Write-Host "Use it with:"
Write-Host "  Start-Service $ServiceName"
