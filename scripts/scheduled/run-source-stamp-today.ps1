# One-shot CX source stamp for today's calls — runs the inline backfill
# against today's PT date for WYNN + TAG. Logs to ops/scheduled-logs/.
#
# Registered as a one-time scheduled task that fires at 17:00 PT today
# and auto-removes itself afterwards.

$ErrorActionPreference = "Stop"

$Repo = "C:\code\TagContactBridgeParalell"
$LogDir = Join-Path $Repo "ops\scheduled-logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
$LogFile = Join-Path $LogDir "source-stamp-today-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').log"

Set-Location $Repo

$Script = @'
require('dotenv').config();
const m = require('mongoose');
const { backfillCallLogSourceFromLeadCadence } = require('./packages/shared-services/src/callLogSourceBackfillService');
(async () => {
  await m.connect(process.env.MONGO_URI, { dbName: process.env.PARALLEL_DB_NAME || 'tagcontactbridge_parallel' });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  console.log('source stamp for', today);
  for (const d of ['WYNN', 'TAG']) {
    const r = await backfillCallLogSourceFromLeadCadence({ domain: d, date: today, timezone: 'America/Los_Angeles', limit: 50000 });
    console.log(d, 'scanned=', r.rowsScanned, 'stamped=', r.rowsStamped, 'noCadence=', r.rowsSkippedNoCadence, 'ledgerSync=', r.ledgerResyncs);
  }
  await m.disconnect();
})().catch(async e => { console.error(e); try { await m.disconnect(); } catch (_) {} process.exit(1); });
'@

Add-Content -Path $LogFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')] start" -Encoding utf8
& node -e $Script 2>&1 | Tee-Object -FilePath $LogFile -Append | Out-Null
$ExitCode = $LASTEXITCODE
Add-Content -Path $LogFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')] end (exit=$ExitCode)" -Encoding utf8

exit $ExitCode
