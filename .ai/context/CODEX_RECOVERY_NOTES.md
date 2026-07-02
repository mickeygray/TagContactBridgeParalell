# Codex Recovery Notes

Date: 2026-06-30

## Scope

The user asked for a read-only analysis of the Codex SQLite log database after a Codex Desktop crash, followed by durable repo handoff notes. No project app code was changed for this recovery step.

No Codex support files were modified or deleted.

## Source Paths

Requested Codex home:

- `C:\code\agents\codex-home`

Expected paths:

- `C:\code\agents\codex-home\log`
- `C:\code\agents\codex-home\sessions`
- `C:\code\agents\codex-home\archived_sessions`

Observed state:

- `C:\code\agents\codex-home\log` was not present.
- `C:\code\agents\codex-home\logs` was not present.
- `C:\code\agents\codex-home\sessions` was not present.
- `C:\code\agents\codex-home\archived_sessions` was not present.
- The newest log-shaped database found under `C:\code\agents\codex-home` was `C:\code\agents\codex-home\logs_2.sqlite`.

## Read-Only Copy

Before inspection, the database and sidecar files were copied to:

- `C:\Users\micke\AppData\Local\Temp\codex-log-recovery-20260630-144250`

Copied files:

- `logs_2.sqlite`
- `logs_2.sqlite-shm`
- `logs_2.sqlite-wal`

Python `sqlite3` inspected the copied database, not the original.

## SQLite Inventory

Database: `logs_2.sqlite`

Tables:

| Table | Row count | Newest timestamp |
| --- | ---: | --- |
| `_sqlx_migrations` | 2 | `2026-06-30 20:08:45` |
| `logs` | 617 | `2026-06-30T20:17:46+00:00` |
| `sqlite_sequence` | 1 | n/a |

Schemas:

```sql
CREATE TABLE _sqlx_migrations (
    version BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN NOT NULL,
    checksum BLOB NOT NULL,
    execution_time BIGINT NOT NULL
);
```

```sql
CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    ts_nanos INTEGER NOT NULL,
    level TEXT NOT NULL,
    target TEXT NOT NULL,
    feedback_log_body TEXT,
    module_path TEXT,
    file TEXT,
    line INTEGER,
    thread_id TEXT,
    process_uuid TEXT,
    estimated_bytes INTEGER NOT NULL DEFAULT 0
);
```

```sql
CREATE TABLE sqlite_sequence(name,seq);
```

## Search Results

Searches were run across text columns for the requested strings.

| Search string | Matches |
| --- | ---: |
| `PermissionProfileSelectionParams` | 0 |
| `Invalid request` | 0 |
| `Error creating task` | 0 |
| `:workspace` | 0 |
| `thread/start` | 3 |
| `permissionProfile/list` | 12 |
| `model/list` | 68 |
| `codex/models` | 4 |

## Last Successful Codex Backend Request

The last explicit successful Codex backend request found in the copied log database was:

- Time: `2026-06-30T20:16:07Z`
- Row id: `527`
- Request: `model/list`
- URL: `https://chatgpt.com/backend-api/codex/models?client_version=0.130.0`
- HTTP status: `200`
- Success: `true`
- Duration: `519 ms`

Nearby duplicate/related rows also recorded the `model/list` request as successful, including row id `523` with status `200 OK`.

## Last Local App-Server Request Before Log Silence

The last local app-server style request found before the database settled into telemetry heartbeat rows was:

- Time: `2026-06-30T20:16:19Z`
- Row id: `588`
- Method/event: `plugin/installed`

Nearby local app-server requests included:

- `account/read`
- `app/list`
- `plugin/list`
- `skills/list`
- `permissionProfile/list`
- `thread/start` at row id `530`, time `2026-06-30T20:16:07Z`

The final row in the database was an OpenTelemetry heartbeat:

- Time: `2026-06-30T20:17:46Z`
- Row id: `617`
- Target: `opentelemetry_sdk`
- Message type: `PeriodReaderThreadLoopAlive`

## Warnings And Non-Findings

The requested crash/error strings were not present:

- No `PermissionProfileSelectionParams`
- No `Invalid request`
- No `Error creating task`
- No `:workspace`

Warnings observed in the log included:

- Remote plugin sync returned `401 Unauthorized` during startup.
- A configured non-curated browser plugin was reported as no longer existing.
- A plugin default prompt was too long for `ngs-analysis`.

These warnings were present, but the copied log database did not show a clear crash stack, panic, or direct failure cause.

## Plain-English Summary

The Codex log database shows Codex successfully starting up enough to list models, list permission profiles, start a thread, read account/app/plugin/skill state, and record plugin-installed state. After that, the log turns mostly into telemetry heartbeats and then stops.

The database does not contain the searched crash strings or an obvious fatal error. Based on this evidence, the log looks more like a Desktop/app-server recovery or restart trail than the original root cause of the crash.

The expected Codex `log`, `sessions`, and `archived_sessions` folders were absent under `C:\code\agents\codex-home`, so the old project transcript was not recovered from that location.

## Recovery Implications

- The repo docs and current working tree are the best available source of truth.
- The lost Codex thread should be treated as unrecoverable unless another backup or transcript location appears.
- Before coding resumes, inspect app runtime state and decide whether to restart the stopped NSSM stack or continue offline review.
- Preserve this handoff as the durable bridge for future Codex threads.

