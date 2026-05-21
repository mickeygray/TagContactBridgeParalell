# One-shot registrar for the nightly EOD recording backfill task.
# Registers a Windows Scheduled Task that runs
# `run-eod-recording-backfill.ps1` every day at 01:00 local time.
#
# Re-runnable: -Force on Register-ScheduledTask overwrites any prior
# registration with the same name.
#
# To remove the task later:
#   Unregister-ScheduledTask -TaskName "Parallel-EOD-Recording-Backfill" -Confirm:$false

$ErrorActionPreference = "Stop"

$TaskName = "Parallel-EOD-Recording-Backfill"
$Repo = "C:\code\TagContactBridgeParalell"
$WrapperScript = Join-Path $Repo "scripts\scheduled\run-eod-recording-backfill.ps1"

if (-not (Test-Path $WrapperScript)) {
  throw "Wrapper script not found at $WrapperScript"
}

# Action: launch powershell.exe with the wrapper. NoProfile skips the
# per-user PS profile (faster, more deterministic). ExecutionPolicy
# Bypass scopes only this invocation — no system-wide policy change.
$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$WrapperScript`"" `
  -WorkingDirectory $Repo

# Trigger: every day at 01:00 local time.
$Trigger = New-ScheduledTaskTrigger -Daily -At 1:00AM

# Settings:
#   StartWhenAvailable — if the PC was off/asleep at 1 AM, run as soon
#       as it's available again (catches up missed runs)
#   AllowStartIfOnBatteries — laptop scenarios
#   DontStopIfGoingOnBatteries — don't kill mid-archive if power switches
#   MultipleInstances IgnoreNew — if a previous run is still going, skip
#   ExecutionTimeLimit 2h — hard kill if it hangs
#   RestartCount 1 + RestartInterval 10m — one auto-retry on transient
#       failure (network blip, Logics 502, etc.)
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -RestartCount 1 `
  -RestartInterval (New-TimeSpan -Minutes 10)

# Run as the current user, no elevation. Limited run level keeps the
# task usable without an admin password prompt at registration time.
$Principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

$Task = New-ScheduledTask `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $Principal `
  -Description "Nightly catch-up: pulls CX recordings from RingCX/Drive for any calls the hourly archive missed. Drive dedup makes re-runs safe."

Register-ScheduledTask `
  -TaskName $TaskName `
  -InputObject $Task `
  -Force | Out-Null

Write-Output ""
Write-Output "Registered: $TaskName"
Write-Output "  Trigger : Daily at 01:00 $(Get-Date -Format 'zzz')"
Write-Output "  Action  : powershell.exe -File $WrapperScript"
Write-Output "  Logs    : $(Join-Path $Repo 'ops\scheduled-logs')\backfill-recordings-YYYY-MM-DD.log"
Write-Output ""
Write-Output "Verify with:"
Write-Output "  Get-ScheduledTask -TaskName $TaskName | Format-List"
Write-Output ""
Write-Output "Run ad-hoc (don't wait until 1 AM) with:"
Write-Output "  Start-ScheduledTask -TaskName $TaskName"
