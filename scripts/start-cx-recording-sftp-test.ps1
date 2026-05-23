param(
  [int]$Port = 2222,
  [string]$RuntimeDir = "runtime\cx-recording-sftp-test",
  [string]$Root = "C:\Users\micke\Desktop\cx-recordings\inbox",
  [string]$NgrokPath = "C:\tools\ngrok\ngrok.exe",
  [string]$NgrokUrl = "",
  [string]$NgrokToken = "",
  [switch]$SkipNgrok
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$runtimePath = Join-Path $repoRoot $RuntimeDir
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
New-Item -ItemType Directory -Force -Path $Root | Out-Null

function Write-Section($title) {
  Write-Host ""
  Write-Host "=== $title ===" -ForegroundColor Cyan
}

function Get-NgrokTokenFromProcess {
  $cmd = Get-CimInstance Win32_Process -Filter "name='ngrok.exe'" |
    Select-Object -ExpandProperty CommandLine -First 1
  if ($cmd -and $cmd -match "--authtoken\s+([^\s]+)") {
    return $Matches[1]
  }
  return ""
}

function Get-NgrokTunnels {
  foreach ($apiPort in @(4040, 4041, 4042, 4043)) {
    try {
      $result = Invoke-RestMethod -Uri "http://127.0.0.1:$apiPort/api/tunnels" -TimeoutSec 2
      foreach ($tunnel in @($result.tunnels)) {
        [pscustomobject]@{
          ApiPort = $apiPort
          Name = $tunnel.name
          Proto = $tunnel.proto
          PublicUrl = $tunnel.public_url
          Addr = $tunnel.config.addr
          ConnCount = $tunnel.metrics.conns.count
        }
      }
    } catch {
      # No ngrok API on this port.
    }
  }
}

Write-Section "Ensure local SFTP receiver"
$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listener) {
  Write-Host "SFTP receiver already listening on port $Port"
} else {
  $stdout = Join-Path $runtimePath "sftp-server.stdout.log"
  $stderr = Join-Path $runtimePath "sftp-server.stderr.log"
  $args = @(
    (Join-Path $repoRoot "scripts\run-cx-recording-sftp-test-server.js"),
    "--port", [string]$Port,
    "--root", $Root,
    "--runtime-dir", $runtimePath
  )
  $proc = Start-Process -FilePath "node" -ArgumentList $args -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  Start-Sleep -Seconds 2
  if ($proc.HasExited) {
    Write-Host "SFTP receiver exited immediately." -ForegroundColor Red
    if (Test-Path $stderr) { Get-Content $stderr -Tail 40 }
    exit 1
  }
  Write-Host "Started SFTP receiver pid=$($proc.Id) on port $Port"
}

if (-not $SkipNgrok) {
  Write-Section "Ensure ngrok TCP tunnel"
  $existing = @(Get-NgrokTunnels | Where-Object {
    $_.Proto -eq "tcp" -and ($_.Addr -match "(:|^)$Port$" -or $_.Addr -match "localhost:$Port")
  })
  if ($existing) {
    Write-Host "ngrok TCP tunnel already present:"
    $existing | Format-Table ApiPort,Name,Proto,PublicUrl,Addr,ConnCount -AutoSize
  } else {
    if (-not (Test-Path $NgrokPath)) {
      Write-Host "ngrok not found at $NgrokPath" -ForegroundColor Red
      exit 1
    }
    if (-not $NgrokToken) {
      $NgrokToken = Get-NgrokTokenFromProcess
    }
    $stdout = Join-Path $runtimePath "ngrok-sftp.stdout.log"
    $stderr = Join-Path $runtimePath "ngrok-sftp.stderr.log"
    $ngrokArgs = @("tcp")
    if ($NgrokUrl) {
      $ngrokArgs += "--url=$NgrokUrl"
    }
    $ngrokArgs += @([string]$Port)
    if ($NgrokToken) {
      $ngrokArgs += @("--authtoken", $NgrokToken)
    }
    $proc = Start-Process -FilePath $NgrokPath -ArgumentList $ngrokArgs -WindowStyle Hidden `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    Start-Sleep -Seconds 5
    if ($proc.HasExited) {
      Write-Host "ngrok exited immediately." -ForegroundColor Red
      if (Test-Path $stderr) { Get-Content $stderr -Tail 80 }
      exit 1
    }
    Write-Host "Started ngrok pid=$($proc.Id)"
  }
}

& (Join-Path $PSScriptRoot "check-cx-recording-sftp-test.ps1") -Port $Port -RuntimeDir $RuntimeDir -InboxDir $Root
