param(
    [switch]$Uninstall,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Find-Nssm {
    if ($env:NSSM_EXE -and (Test-Path $env:NSSM_EXE)) { return $env:NSSM_EXE }
    $candidates = @(
        "C:\tools\nssm-2.24\win64\nssm.exe",
        "C:\tools\nssm\win64\nssm.exe",
        "C:\Users\$env:USERNAME\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe",
        "C:\Users\admin\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    $onPath = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    throw "nssm.exe not found. Set `$env:NSSM_EXE or extract NSSM to C:\tools\nssm-2.24\win64\."
}

$Nssm = Find-Nssm
$Repo = if ($env:PARALLEL_REPO_ROOT) {
    $env:PARALLEL_REPO_ROOT
} else {
    Resolve-Path (Join-Path $PSScriptRoot "..\..") | Select-Object -ExpandProperty Path
}
$LogsDir = "C:\tools\logs"
$PowerShellExe = (Get-Command powershell).Source
$ServiceName = "ParallelRestartHelper"
$ScriptPath = Join-Path $Repo "ops\nssm\restart-parallel-all.ps1"

if (-not (Test-Path $Nssm)) { throw "nssm.exe not found at $Nssm" }
if (-not (Test-Path $Repo)) { throw "repo not found at $Repo" }
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
& $Nssm set $ServiceName Description "Manual helper that restarts the full local Parallel stack: Mongo, app workers, blogger, nginx, and ngrok. Legacy is untouched." | Out-Null
& $Nssm set $ServiceName DisplayName "Parallel - Restart Helper" | Out-Null
& $Nssm set $ServiceName Start SERVICE_DEMAND_START | Out-Null
& $Nssm set $ServiceName AppEnvironmentExtra "NODE_ENV=production" | Out-Null
& $Nssm set $ServiceName AppStdout "$LogsDir\parallel-parallelrestarthelper.out.log" | Out-Null
& $Nssm set $ServiceName AppStderr "$LogsDir\parallel-parallelrestarthelper.err.log" | Out-Null
& $Nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $Nssm set $ServiceName AppRotateOnline 1 | Out-Null
& $Nssm set $ServiceName AppRotateBytes 10485760 | Out-Null
& $Nssm set $ServiceName AppExit Default Exit | Out-Null
& $Nssm set $ServiceName AppRestartDelay 5000 | Out-Null
& $Nssm set $ServiceName ObjectName "LocalSystem" | Out-Null

Write-Host "$ServiceName installed."
Write-Host "Use it with:"
Write-Host "  Start-Service $ServiceName"
