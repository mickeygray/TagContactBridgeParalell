param(
  [string]$StreamUrl = "wss://tag-webhook.ngrok.app/ringcx-stream",
  [string]$ProductType = "CAMPAIGN",
  [string]$ProductId = "2306",
  [string]$DialGroupId = "963",
  [string]$CampaignId = "2306",
  [string]$Phone = "13106665997",
  [int]$ProbePort = 3336,
  [int]$WatchSeconds = 120,
  [switch]$FireLead,
  [switch]$ContinueOnProfileFailure
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$runtime = Join-Path $repo "runtime\ringcx-ws-stream-probe"
$stdout = Join-Path $runtime "server.stdout.log"
$stderr = Join-Path $runtime "server.stderr.log"
$pidFile = Join-Path $runtime "server.pid"
$events = Join-Path $runtime "events.ndjson"

New-Item -ItemType Directory -Force -Path $runtime | Out-Null

Write-Host "== RingCX WSS call-streaming test =="
Write-Host "Repo:       $repo"
Write-Host "StreamUrl:  $StreamUrl"
Write-Host "Product:    $ProductType $ProductId"
Write-Host "Probe port: $ProbePort"

$listener = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -eq $ProbePort } |
  Select-Object -First 1

if (-not $listener) {
  Write-Host "`n== Start WSS probe receiver =="
  $proc = Start-Process -FilePath "node" `
    -ArgumentList @("scripts\ringcx-ws-stream-probe-server.js", "--port", "$ProbePort", "--no-enforce-basic") `
    -WorkingDirectory $repo `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru
  Set-Content -Path $pidFile -Value $proc.Id
  Start-Sleep -Seconds 1
  Write-Host "Started probe receiver PID $($proc.Id)"
} else {
  Write-Host "`nProbe receiver already listening on $ProbePort (PID $($listener.OwningProcess))"
}

Write-Host "`n== Apply streaming profile =="
$profileArgs = @(
  "scripts\ringcx-wss-stream-profile-test.js",
  "--apply",
  "--try-all",
  "--streaming-url", $StreamUrl,
  "--product-type", $ProductType,
  "--product-id", $ProductId
)

& node @profileArgs
$profileExit = $LASTEXITCODE
if ($profileExit -ne 0) {
  Write-Host "`nStreaming profile apply failed with exit code $profileExit."
  Write-Host "That means the WSS receiver is ready, but RingCX did not accept the profile API call."
  if (-not $ContinueOnProfileFailure) {
    exit $profileExit
  }
}

if ($FireLead) {
  Write-Host "`n== Fire one campaign lead =="
  $runId = "wss-stream-test-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss")
  & node scripts\ringcx-predictive-test-runner.js `
    --dial-group-id $DialGroupId `
    --campaign-id $CampaignId `
    --phones $Phone `
    --strip-leading-1 `
    --max-leads 1 `
    --batch-size 1 `
    --watch-sec $WatchSeconds `
    --run-id $runId `
    --extern-prefix $runId `
    --live
} else {
  Write-Host "`nSkipping campaign lead fire. Re-run with -FireLead when the agent is ready."
}

Write-Host "`n== Recent WSS receiver events =="
if (Test-Path $events) {
  Get-Content $events -Tail 30
} else {
  Write-Host "No WSS event log yet: $events"
}

Write-Host "`nDone."
