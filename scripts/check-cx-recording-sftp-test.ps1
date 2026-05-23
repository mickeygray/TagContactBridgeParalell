param(
  [int]$Port = 2222,
  [string]$RuntimeDir = "runtime\cx-recording-sftp-test",
  [string]$InboxDir = "C:\Users\micke\Desktop\cx-recordings\inbox",
  [switch]$SkipPublicProbe
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$runtimePath = Join-Path $repoRoot $RuntimeDir
$credentialsPath = Join-Path $runtimePath "credentials.json"
$eventsPath = Join-Path $runtimePath "events.ndjson"

function Write-Section($title) {
  Write-Host ""
  Write-Host "=== $title ===" -ForegroundColor Cyan
}

function Get-NgrokTunnels {
  $ports = @(4040, 4041, 4042, 4043)
  foreach ($apiPort in $ports) {
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

Write-Section "Local SFTP Receiver"
$listeners = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listeners) {
  $listeners | Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize
  $pids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
  Get-CimInstance Win32_Process | Where-Object { $pids -contains $_.ProcessId } |
    Select-Object ProcessId,Name,CommandLine | Format-List
} else {
  Write-Host "No listener on port $Port" -ForegroundColor Yellow
}

Write-Section "Ngrok TCP Tunnel"
$tunnels = @(Get-NgrokTunnels)
$sftpTunnels = $tunnels | Where-Object {
  $_.Proto -eq "tcp" -and ($_.Addr -match "(:|^)$Port$" -or $_.Addr -match "localhost:$Port")
}
if ($sftpTunnels) {
  $sftpTunnels | Format-Table ApiPort,Name,Proto,PublicUrl,Addr,ConnCount -AutoSize
  foreach ($tunnel in $sftpTunnels) {
    if ($tunnel.PublicUrl -match "^tcp://([^:]+):(\d+)$") {
      Write-Host "RingCX Server : $($Matches[1])"
      Write-Host "RingCX Port   : $($Matches[2])"
    }
  }
} elseif ($tunnels) {
  Write-Host "Ngrok is running, but no TCP tunnel to port $Port was found." -ForegroundColor Yellow
  $tunnels | Format-Table ApiPort,Name,Proto,PublicUrl,Addr,ConnCount -AutoSize
} else {
  Write-Host "No ngrok API/tunnels found on ports 4040-4043." -ForegroundColor Yellow
}

Write-Section "SFTP Credentials"
if (Test-Path $credentialsPath) {
  $creds = Get-Content $credentialsPath -Raw | ConvertFrom-Json
  Write-Host "User       : $($creds.username)"
  Write-Host "Password   : <stored in $credentialsPath>"
  Write-Host "Root path  : /"
} else {
  Write-Host "Missing credentials file: $credentialsPath" -ForegroundColor Yellow
}

Write-Section "Local Auth/List Probe"
if (Test-Path $credentialsPath) {
  $creds = Get-Content $credentialsPath -Raw | ConvertFrom-Json
  $env:CX_SFTP_HOST = "127.0.0.1"
  $env:CX_SFTP_PORT = [string]$Port
  $env:CX_SFTP_USER = $creds.username
  $env:CX_SFTP_PASSWORD = $creds.password
  node (Join-Path $repoRoot "scripts\pull-cx-recordings-sftp.js") --list-only
}

if (-not $SkipPublicProbe -and $sftpTunnels -and (Test-Path $credentialsPath)) {
  Write-Section "Public TCP Auth/List Probe"
  $creds = Get-Content $credentialsPath -Raw | ConvertFrom-Json
  $first = $sftpTunnels | Select-Object -First 1
  if ($first.PublicUrl -match "^tcp://([^:]+):(\d+)$") {
    $env:CX_SFTP_HOST = $Matches[1]
    $env:CX_SFTP_PORT = $Matches[2]
    $env:CX_SFTP_USER = $creds.username
    $env:CX_SFTP_PASSWORD = $creds.password
    node (Join-Path $repoRoot "scripts\pull-cx-recordings-sftp.js") --list-only
  }
}

Write-Section "Inbox"
if (Test-Path $InboxDir) {
  Get-ChildItem -LiteralPath $InboxDir -Recurse |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 20 FullName,Length,LastWriteTime |
    Format-Table -AutoSize
} else {
  Write-Host "Missing inbox: $InboxDir" -ForegroundColor Yellow
}

Write-Section "Recent Events"
if (Test-Path $eventsPath) {
  Get-Content $eventsPath -Tail 30
} else {
  Write-Host "No event log yet: $eventsPath" -ForegroundColor Yellow
}
