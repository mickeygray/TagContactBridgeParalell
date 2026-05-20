# Call Review Dashboard

Per-agent + per-lead review surface hung off the admin users component. Lets
admins click into an agent, see today's individual calls (with durations,
recording playback, lead chips), and jump to a "who dialed this lead today"
view by clicking any case chip.

Scaffolded as stubs that read what exists today; ready to fill in once the
recording archive and status-shift correlation are wired up.

## What landed

### Backend — stubs reading real CallLog data

New router [`apps/control-plane/src/routes/adminCallReview.js`](../apps/control-plane/src/routes/adminCallReview.js)
mounted at `/api/admin/call-review` (server.js wires it next to the other
admin routers).

| Endpoint | Returns |
|---|---|
| `GET /agent/:extensionId/today?domain=TAG&sort=duration\|time` | Every CallLog row for that extension on today's PT date, plus a summary (count, total talk time, longest call, recording coverage) |
| `GET /case/:caseId/today?domain=TAG&sort=time\|duration` | Every CallLog row against that lead today, plus a per-agent grouping so a glance answers "who worked this lead?" |

- Both reuse the existing `callLogRepository.listCallLogs` — same indexed
  query the rest of the system uses.
- Recording link composed from `recordingArchive.driveFileId` →
  existing `/api/read/cx/recordings/play/:fileId` proxy (auth-protected,
  Range-supported). No new transport.
- `statusShift` field reserved on each row, returning `null` today;
  commented `TODO(call-review-status-shift)` with both options
  (heuristic vs explicit `triggeredByCallId`) for the fill-in step.

### Client — full UI with empty states

- New hooks [`apps/web-client/src/lib/api/queries/callReview.ts`](../apps/web-client/src/lib/api/queries/callReview.ts)
  — `useAgentCallReviewToday`, `useCaseCallReviewToday`. 5-second poll,
  5-second stale. Types mirror the server projection.
- New query keys under `queryKeys.callReview.*`.
- **`<CallsTodayPanel>`** ([CallsTodayPanel.tsx](../apps/web-client/src/workspaces/users/CallsTodayPanel.tsx))
  — sort toggle (time ↔ duration), per-row direction icon, duration pill
  color-coded (under 30s gray, under 2m accent, under 8m green, longer =
  warning), inline `<audio>` element that mounts only when expanded so
  we don't ping Drive for every row, "No rec" badge when archive hasn't
  caught up yet.
- **`<CaseCallsDrawer>`** ([CaseCallsDrawer.tsx](../apps/web-client/src/workspaces/users/CaseCallsDrawer.tsx))
  — modal that opens from a case-chip click. Shows the
  "who dialed this lead today" per-agent rollup on top, then the full
  call list with the same play-on-expand affordance.
- Both wired into [`UserDetailDrawer`](../apps/web-client/src/workspaces/users/UserDetailDrawer.tsx)
  — the panel sits directly under the existing call-stats rollup, and
  the case drawer opens when a row's case chip is clicked.

## What's deliberately empty / stubbed for fill-in

| Layer | State today | What's needed to fill in |
|---|---|---|
| Per-call status-shift correlation | Returns `null`; UI shows "—" | Server side: either (A) heuristic on `CaseProfile.statusLastChangedAt` ± 5min around `callEndTime`, or (B) thread `triggeredByCallId` into `executeCxLogicsUpdateCase` / `caseProfilePromotionService` writes |
| Recording bytes for fresh calls | "No rec" badge shows when `recordingArchive.driveFileId` is missing | Existing bulk-pull script (`scripts/archive-eod-recordings.js`) stamps the field on its cadence — nothing to change here, this is purely "when archive catches up" |
| Per-agent `domain` selection | Hardcodes `current.company \|\| "TAG"` | If admins need to flip domain on the panel, add a domain switcher prop to `<CallsTodayPanel>` |
| Authoritative duration for hot calls | Uses CallLog `durationSec` (filled in by `ringcentralCallLogSweepService` at call-end) | If you want a "live timer" for in-flight calls, that's a separate live-call read |

## How to verify it's working

1. Restart the control-plane to expose `/api/admin/call-review/*`.
2. Open the admin Users workspace → click any row with an `extensionId`.
3. The new "Calls today" panel renders below the rollup buckets.
4. For agents with calls today:
   - Each row shows direction icon, time, phone, case chip, duration pill, play button.
   - Click the duration sort toggle to flip ordering.
   - Click the play button on a row with a stamped recording → inline
     `<audio>` element appears; existing proxy serves the bytes with Range support so scrubbing works.
   - Click the case chip (`#112004` etc.) → `<CaseCallsDrawer>` opens
     showing every agent who dialed that lead today.

If `recordingArchive.driveFileId` is `null` on a call (the archive script
hasn't caught up yet) the row shows "No rec" instead of a play button.

## Where the fill-in goes when you circle back

- **Status-shift correlation**: pick approach A (heuristic) or B (explicit
  field) per the TODO in `adminCallReview.js#projectCallRow`. The client
  already renders the field if returned (`call.statusShift.toStatusLabel`)
  so no UI change is needed once the server populates it.
- **Recording-pull integration**: nothing to do on the dashboard side —
  the bulk-pull script writes the `driveFileId` that's already being
  read. If you want on-demand pulls (rather than waiting for the cron),
  hit `/api/read/cx/recordings/call/:domain/:telephonySessionId` which
  already exists and resolves CallLog → fileId → proxy on demand.

## Reaching the implementation breadcrumbs

```bash
grep -rn "TODO(call-review-status-shift)" apps/ packages/
```

Single anchor today — the status-shift correlation note in
`apps/control-plane/src/routes/adminCallReview.js`.
