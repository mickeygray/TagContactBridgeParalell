# Registers a one-time Windows Scheduled Task for the local CX/WEM
# recording backfill. Re-runnable: -Force overwrites the same task.
#
# To remove:
#   Unregister-ScheduledTask -TaskName "Parallel-CX-WEM-Recording-Backfill-Once" -Confirm:$false

param(
  [datetime]$At,
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [int]$StartHour = 7,
  [int]$EndHour = 19,
  [string]$Domains = "TAG,WYNN",
  [int]$BetweenWindowsMs = 180000
)

$ErrorActionPreference = "Stop"

$TaskName = "Parallel-CX-WEM-Recording-Backfill-Once"
$Repo = "C:\code\TagContactBridgeParalell"
$WrapperScript = Join-Path $Repo "scripts\scheduled\run-cx-wem-recording-backfill.ps1"

if (-not (Test-Path $WrapperScript)) {
  throw "Wrapper script not found at $WrapperScript"
}

if (-not $PSBoundParameters.ContainsKey("At")) {
  # Run just after 7 PM so the Node backloader's default 15-minute
  # readiness buffer can include calls that ended right at 7:00.
  $At = Get-Date -Hour 19 -Minute 15 -Second 0
  if ($At -lt (Get-Date)) {
    $At = $At.AddDays(1)
  }
}

$Argument = "-NoProfile -ExecutionPolicy Bypass -File `"$WrapperScript`" -Date `"$Date`" -StartHour $StartHour -EndHour $EndHour -Domains `"$Domains`" -BetweenWindowsMs $BetweenWindowsMs"

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument $Argument `
  -WorkingDirectory $Repo

$Trigger = New-ScheduledTaskTrigger -Once -At $At

$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 6) `
  -RestartCount 1 `
  -RestartInterval (New-TimeSpan -Minutes 10)

$Principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

$Task = New-ScheduledTask `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $Principal `
  -Description "One-time local CX/WEM recording backfill. Runs the repo wrapper slowly against today's CX calls and uploads eligible 5+ minute recordings."

Register-ScheduledTask `
  -TaskName $TaskName `
  -InputObject $Task `
  -Force | Out-Null

Write-Output ""
Write-Output "Registered: $TaskName"
Write-Output "  Trigger : Once at $($At.ToString('yyyy-MM-dd HH:mm:ss zzz'))"
Write-Output "  Action  : powershell.exe $Argument"
Write-Output "  Logs    : $(Join-Path $Repo 'ops\scheduled-logs')\cx-wem-recording-backfill-$Date.log"
Write-Output ""
Write-Output "Verify with:"
Write-Output "  Get-ScheduledTask -TaskName $TaskName | Format-List"
Write-Output ""
Write-Output "Run ad-hoc with:"
Write-Output "  Start-ScheduledTask -TaskName $TaskName"
