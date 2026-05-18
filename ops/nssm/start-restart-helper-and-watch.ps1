param(
    [int]$TimeoutSeconds = 300,
    [switch]$StopIfAlreadyRunning
)

$ErrorActionPreference = "Stop"

$ServiceName = "ParallelRestartHelper"
$LogsDir = if ($env:PARALLEL_LOGS_DIR) { $env:PARALLEL_LOGS_DIR } else { "C:\tools\logs" }
$OutLog = Join-Path $LogsDir "parallel-parallelrestarthelper.out.log"
$ErrLog = Join-Path $LogsDir "parallel-parallelrestarthelper.err.log"

function Write-Step($message) {
    Write-Host "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] $message"
}

function Get-LogLength($path) {
    if (-not (Test-Path $path)) { return 0 }
    return [int64](Get-Item $path).Length
}

function Read-NewLogText($path, [int64]$offset) {
    if (-not (Test-Path $path)) { return "" }
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        if ($stream.Length -lt $offset) { $offset = 0 }
        $stream.Seek($offset, [System.IO.SeekOrigin]::Begin) | Out-Null
        $reader = New-Object System.IO.StreamReader($stream)
        return $reader.ReadToEnd()
    } finally {
        $stream.Dispose()
    }
}

function Write-NewLogLines($label, $path, [ref]$offsetRef) {
    $text = Read-NewLogText $path $offsetRef.Value
    $offsetRef.Value = Get-LogLength $path
    if (-not $text) { return $false }
    $lines = $text -split "`r?`n" | Where-Object { $_ -ne "" }
    foreach ($line in $lines) {
        Write-Host "[$label] $line"
    }
    return ($lines -match "Universal Parallel restart complete|Parallel restart helper complete").Count -gt 0
}

$service = Get-Service -Name $ServiceName -ErrorAction Stop
if ($service.Status -eq "Running") {
    if ($StopIfAlreadyRunning) {
        Write-Step "$ServiceName is already running; stopping it first..."
        Stop-Service -Name $ServiceName -Force -ErrorAction Stop
        $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
    } else {
        throw "$ServiceName is already running. Re-run with -StopIfAlreadyRunning if the previous helper is stuck."
    }
}

if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir | Out-Null
}

$outOffset = Get-LogLength $OutLog
$errOffset = Get-LogLength $ErrLog

Write-Step "Starting $ServiceName and streaming NSSM logs..."
Start-Service -Name $ServiceName -ErrorAction Stop

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$sawComplete = $false
do {
    $outComplete = Write-NewLogLines "out" $OutLog ([ref]$outOffset)
    $errComplete = Write-NewLogLines "err" $ErrLog ([ref]$errOffset)
    if ($outComplete -or $errComplete) { $sawComplete = $true }

    $service = Get-Service -Name $ServiceName -ErrorAction Stop
    if ($service.Status -eq "Stopped") {
        Write-Step "$ServiceName stopped; restart helper run is complete."
        exit 0
    }
    if ($sawComplete) {
        Write-Step "$ServiceName printed completion. If the service remains Running, reinstall helper with AppExit=Exit."
        exit 0
    }
    Start-Sleep -Seconds 1
} while ((Get-Date) -lt $deadline)

throw "Timed out waiting for $ServiceName output. Check $OutLog and $ErrLog."
