# One-shot local CX/WEM recording backfill.
#
# Intended for "run it from this Windows box tonight" use. The Node
# script defaults to preview mode; this wrapper defaults to --apply
# because it is only used by the scheduled/manual backfill task.
#
# Logs each run to ops/scheduled-logs/cx-wem-recording-backfill-YYYY-MM-DD.log.

param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [int]$StartHour = 7,
  [int]$EndHour = 19,
  [string]$Domains = "TAG,WYNN",
  [int]$BetweenWindowsMs = 180000,
  [switch]$Preview
)

$ErrorActionPreference = "Stop"

$Repo = "C:\code\TagContactBridgeParalell"
$LogDir = Join-Path $Repo "ops\scheduled-logs"
if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

$LogFile = Join-Path $LogDir "cx-wem-recording-backfill-$Date.log"

Set-Location $Repo

$NodeArgs = @(
  "scripts/backfill-cx-wem-recordings.js",
  "--date", $Date,
  "--start-hour", "$StartHour",
  "--end-hour", "$EndHour",
  "--domains", $Domains,
  "--between-windows-ms", "$BetweenWindowsMs",
  "--max-rows-per-domain", "500",
  "--sample-limit", "3"
)

if ($Preview) {
  $NodeArgs += "--list-only"
} else {
  $NodeArgs += "--apply"
}

$Header = @(
  "",
  "================================================================",
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')] cx-wem backfill start",
  "  repo: $Repo",
  "  cmd:  node $($NodeArgs -join ' ')",
  "----------------------------------------------------------------"
) -join "`n"
Add-Content -Path $LogFile -Value $Header -Encoding utf8

# PowerShell 5's Tee-Object can append with UTF-16 in mixed streams on
# some machines, so write each line explicitly as UTF-8.
& node @NodeArgs 2>&1 | ForEach-Object {
  $Line = "$_"
  Write-Output $Line
  Add-Content -Path $LogFile -Value $Line -Encoding utf8
}
$ExitCode = $LASTEXITCODE

$Footer = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')] cx-wem backfill end (exit=$ExitCode)"
Add-Content -Path $LogFile -Value $Footer -Encoding utf8

exit $ExitCode
