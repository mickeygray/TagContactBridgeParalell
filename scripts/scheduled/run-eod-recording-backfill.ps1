# Nightly EOD recording backfill — runs every day at 01:00 PT via
# Windows Task Scheduler. Walks yesterday and the few prior days and
# pulls any CX call recordings that the hourly archive pipeline missed
# (calls stuck at `recordingArchive.status: "not_queued"`). Drive
# dedup makes re-runs safe — already-archived rows short-circuit.
#
# Logs each run to ops/scheduled-logs/backfill-recordings-YYYY-MM-DD.log
# (one file per calendar day; the script appends if run multiple times
# in a day).
#
# Registered by scripts/scheduled/register-eod-backfill-task.ps1.

$ErrorActionPreference = "Stop"

$Repo = "C:\code\TagContactBridgeParalell"
$LogDir = Join-Path $Repo "ops\scheduled-logs"
if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}
$Date = Get-Date -Format "yyyy-MM-dd"
$LogFile = Join-Path $LogDir "backfill-recordings-$Date.log"

Set-Location $Repo

# Args:
#   --start-offset 1   start from yesterday (skip today, it's still
#                       in flight at 1 AM and the hourly tick is the
#                       authoritative source for it)
#   --days 5           walk back five days for safety; the script
#                       short-circuits via --stop-on-fully-deduped 3
#                       once it hits a string of fully-archived days
#   --weekdays-only=false  include weekends — CX dialing happens then too
$NodeArgs = @(
  "scripts/backfill-eod-recordings.js",
  "--start-offset", "1",
  "--days", "5",
  "--weekdays-only", "false"
)

$Header = @(
  "",
  "================================================================",
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')] backfill start",
  "  repo: $Repo",
  "  cmd:  node $($NodeArgs -join ' ')",
  "----------------------------------------------------------------"
) -join "`n"
Add-Content -Path $LogFile -Value $Header -Encoding utf8

# Invoke node and capture combined stdout/stderr to the log file.
# 2>&1 merges stderr into stdout so per-day JSON lines and any error
# traces both land in the same file.
& node @NodeArgs 2>&1 | Tee-Object -FilePath $LogFile -Append | Out-Null
$ExitCode = $LASTEXITCODE

$Footer = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')] backfill end (exit=$ExitCode)"
Add-Content -Path $LogFile -Value $Footer -Encoding utf8

exit $ExitCode
