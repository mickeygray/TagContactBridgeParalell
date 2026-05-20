# RingCX Recording Download — Pipeline Map

How a CX call recording goes from "agent hangs up" to "row on the admin
review dashboard with a working play button." The whole chain is already
implemented; the only thing holding it back is the 403 on the
`interaction-metadata` POST that RC support still has to grant.

## TL;DR

1. RC voice client already speaks the two endpoints we need.
2. An hourly poller already runs the join between CallLog rows and
   RingCX segments and queues archive jobs.
3. Existing archive job already downloads WAV → uploads to Drive →
   stamps `CallLog.recordingArchive.driveFileId`.
4. The call review dashboard already reads `driveFileId` to render the
   inline play button. Today it shows "No rec" badges; once metadata
   access lights up those badges convert to playable audio
   automatically.
5. Marker script captures known-call breadcrumbs for the RC support
   ticket and for sanity-checking the first real recording pulls.

So the plan is small: **wait for the 403 to resolve, flip the
`RINGCX_RECORDING_ENABLED` env flag on, watch the hourly poller pick up
its first window.**

## The data flow, end to end

```
[Agent hangs up]
      │
      ▼
[handleCxCallPlaced]              ← already wired, writes CallLog
      │                              row with platform="cx",
      │                              telephonySessionId=<UII>,
      │                              callStartTime, callEndTime,
      │                              extensionId, caseId
      ▼
[cxRecordingHourlyService.runCxRecordingHourly]
      │                            ← fires at top of every hour
      │                              for the window
      │                              [(HH-2):45, (HH-1):45]
      │                              (gives RC ≥15 min of post-call
      │                              media-ready buffer)
      │
      │   POST /voice/api/cx/integration/v1/.../interaction-metadata
      │   ─ body: { segmentEndTime, timeInterval, timeZone }
      │   ─ optional: agentIds / agentGroupIds
      ▼
[fetchInteractionMetadata]         ← rows include
      │                              interactionId (== UII),
      │                              dialogId, segmentId(s)
      │
      ▼
[buildRingcxMetadataCache]         ← group rows by UII so we can do
      │                              CallLog.telephonySessionId →
      │                              {dialogId, segmentId} lookups
      │                              in O(1) during the loop
      ▼
[for each CallLog row in window where
   platform=="cx" AND recordingArchive.status NOT terminal]
      │
      ▼
[processCallRecordingArchive]      ← already exists, handles ringcx
      │                              provider branch
      │
      │   GET /voice/api/cx/integration/v1/.../recordings/dialogs/
      │       {dialogId}/segments/{segmentId}     (binary WAV)
      ▼
[downloadRecordingBySegment]
      │                              { buffer, mimeType, contentLength }
      ▼
[Upload via recordingStorageService → Google Drive]
      │
      ▼
[Stamp on CallLog row:
   recordingArchive.driveFileId
   recordingArchive.driveWebViewLink
   recordingArchive.sourceUri
   recordingArchive.status = "completed"
   recordingArchive.ringcxDialogId
   recordingArchive.ringcxSegmentIds]
      │
      ▼
[Call review dashboard reads driveFileId]
      │
      ▼
[Inline <audio> in CallsTodayPanel
   via /api/read/cx/recordings/play/:fileId
   Range-supported proxy]
```

## The identifier chain

| Identifier | Where it's set | Where it gets used | Notes |
|---|---|---|---|
| `uii` / `telephonySessionId` | RingCX webhook → `handleCxCallPlaced` | CallLog.telephonySessionId; join key into metadata cache | The stable single-call identifier. Matches the marker script's "observedIds" field. |
| `externalId` | We send `parallel:DOMAIN:caseId:queueItemId` when publishing the lead to RingCX | Visible in active-calls; useful for fault diagnosis but NOT used as the recording join key | Carries our queueItemId so we can trace queue → call. |
| `interactionId` | Returned by `interaction-metadata` | == UII per the API contract | The join field on the metadata side. |
| `dialogId` | Returned by `interaction-metadata` per call | Path param on the recording GET | One per call/leg. |
| `segmentId` | Returned by `interaction-metadata`, can be multiple per dialog | Path param on the recording GET | A call can have multiple segments (transfers, holds, etc.). The pipeline picks the segment(s) with recording=true. |
| `recordingArchive.driveFileId` | Set after Drive upload | Read by the call-review dashboard play button | The final useful artifact for the operator. |

## Files involved (file:line for quick jumps)

**Implemented and waiting**:
- [packages/shared-integrations/src/ringcxVoiceClient.js:1081](../packages/shared-integrations/src/ringcxVoiceClient.js) — `fetchInteractionMetadata(...)` (POSTs `interaction-metadata`)
- [packages/shared-integrations/src/ringcxVoiceClient.js:1145](../packages/shared-integrations/src/ringcxVoiceClient.js) — `downloadRecordingBySegment({dialogId, segmentId})` (GETs `recordings/dialogs/.../segments/...`)
- [packages/shared-services/src/cxRecordingHourlyService.js:75](../packages/shared-services/src/cxRecordingHourlyService.js) — `runCxRecordingHourly(...)` — the hourly orchestrator
- [packages/shared-services/src/recordingArchiveService.js:553](../packages/shared-services/src/recordingArchiveService.js) — `buildRingcxMetadataCache(metadata)` — UII → segment lookup
- [packages/shared-services/src/recordingArchiveService.js:805](../packages/shared-services/src/recordingArchiveService.js) — `processCallRecordingArchive(..., ringcxMetadataCache)` — per-row download + stamp
- [packages/shared-models/src/CallLog.js:236](../packages/shared-models/src/CallLog.js) — `recordingArchive.driveFileId` field that's the join key into the dashboard

**Diagnostic scaffolding**:
- [scripts/ringcx-known-call-marker.js](../scripts/ringcx-known-call-marker.js) — places a controlled manual call, captures account/agent/dial-group/campaign/UII/externalId/active-call context, writes a marker JSON. Run with `--metadata-only --marker <file>` after 20 minutes to probe `interaction-metadata` for that exact window.

**Consumer side (already shipped this session)**:
- [apps/control-plane/src/routes/adminCallReview.js](../apps/control-plane/src/routes/adminCallReview.js) — admin endpoints that read `recordingArchive.driveFileId` and surface playback URLs
- [apps/web-client/src/workspaces/users/CallsTodayPanel.tsx](../apps/web-client/src/workspaces/users/CallsTodayPanel.tsx) — UI that renders the play button when `recording.available === true`, "No rec" badge otherwise

## What's blocked

1. **`POST interaction-metadata` returns 403.** RC support has to enable the
   permission on the account before any metadata row comes back. The
   marker script's `--metadata-only` mode is the cheapest way to
   re-test after each support touch.
2. **`RINGCX_RECORDING_ENABLED` env flag.** Defaults to `false`. The
   hourly poller short-circuits when this is unset. Flip to `true` only
   after the 403 lifts AND a manual marker-script run can pull at least
   one row of metadata.

## Sequence to unblock

1. RC support enables `interaction-metadata` POST on the account.
2. Run a controlled call (the marker script handles this):
   ```
   node scripts/ringcx-known-call-marker.js --to <test-number>
   ```
   Note the marker JSON path in the output.
3. Wait 20 minutes after hangup.
4. Probe:
   ```
   node scripts/ringcx-known-call-marker.js --metadata-only --marker <path>
   ```
   Expected result: at least one window returns rows that match the
   marker's `observedIds` (UII match) and `destination` / `callerId`
   needles.
5. If matches show up, set `RINGCX_RECORDING_ENABLED=true` and restart
   the control-plane. The hourly poller will pick up its first window
   at the top of the next hour.
6. Spot-check: open the admin Users → click an agent who placed a call
   in the past 2 hours → the "Calls today" panel rows should flip from
   "No rec" to play buttons within ~1 hour of call end.

## What lights up automatically once the pipeline runs

- The call review dashboard's per-row play button (no UI change needed —
  the response payload already surfaces `recording.available` and
  `recording.playbackUrl`; both flip to truthy when `driveFileId` is
  stamped).
- The existing `/api/read/cx/recordings/call/:domain/:telephonySessionId`
  on-demand endpoint that resolves CallLog → fileId → proxy (already in
  the codebase) — no change needed.
- Transcription + scoring downstream of `processCallRecordingArchive`
  (the existing pipeline runs them in the same job).

## Things to watch the first day

- **Metadata rate limit** — RingCX caps `interaction-metadata` at 2 RPM.
  The hourly poller fires once per hour (well under). The marker
  script's `--metadata-only` mode runs ~5 windows in sequence; throttle
  if you re-run within the same minute.
- **Media-ready threshold** — RingCX says recordings are media-ready 15
  min post-hangup. The hourly poller respects this by design; the
  marker script's "wait 20 minutes" rule covers manual probes.
- **Segment selection** — a call can have multiple segments (transfers,
  holds). `processCallRecordingArchive` picks the segment(s) with
  recording enabled. Spot-check the first few archived calls to confirm
  the right segment landed.
- **Drive folder ID** — `RECORDINGS_DRIVE_INBOUND_FOLDER_ID` and
  `RECORDINGS_DRIVE_TRAINING_FOLDER_ID` env vars must point at the
  intended Drive folders. Existing archive-eod script already uses
  these — same plumbing.

## Notes from the Codex conversation

- Codex's `ringcx-known-call-marker.js` was the right shape: capture
  the call's account/agent/dial-group/campaign + observed UIIs +
  destination/callerId so RC support has concrete "known recorded call
  at this time" evidence when chasing the 403.
- `uii` is the call-level identifier, not `dialogId`. They aren't
  interchangeable — the metadata POST is the only way to get dialogId.
- `externalId` (the `parallel:DOMAIN:caseId:queueItemId` string) is more
  useful from campaign-queue runs than manual dials because RingCX
  carries it through to active-calls — that's a stronger marker when
  RC support asks for proof of a recorded call.

---

## Spot download — the real review-dashboard need

The hourly poller is the right shape for **bulk archive** (background
fill, transcription downstream, score everything for QA). But the
review dashboard the user wants is **spot download**: an admin clicks
a specific call row and we go fetch THAT recording right now, whether
or not the hourly poller has reached it yet.

That requires three things, in increasing order of effort:

### 1. Stamp enough metadata at call-placed time

The on-demand fetcher needs to be able to find a single segment by UII
without scanning the entire account's metadata. The metadata POST
accepts `agentIds` + `agentGroupIds` filters — if we send those, the
response narrows to a handful of rows.

**What CallLog currently captures** (see `handleCxCallPlaced`
[cxCadenceService.js:1509](../packages/shared-services/src/cxCadenceService.js)):

| Field | Source | Notes |
|---|---|---|
| `telephonySessionId` | `payload.uii` | ✓ the join key |
| `direction`, `caseId`, `phone` | payload + queue item | ✓ |
| `extensionId` | `queueItem.assignment.extensionId` | This is the **RC user id** (e.g. 63730035004), NOT the RingCX agent id |
| `platform: "cx"` | hardcoded | ✓ |
| `audit.queueItemId`, `audit.actionKey`, `audit.agentEmail` | mixed | ✓ |

**What's missing** (per Codex's marker payload — these fields exist on
the queue item but never make it to CallLog):

| Field | Available on queue item as | Why we need it |
|---|---|---|
| `ringcxAgentId` | `assignment.agentId` (or `metadata.assignedAgentId`) — e.g. 21018 | The numeric agent id `interaction-metadata` filters by. Distinct from the RC user id we already capture. |
| `ringcxAgentGroupId` | `metadata.assignedAgentGroupId` — e.g. 2187 | Backup filter when agent id alone is ambiguous (rare). |
| `ringcxCampaignId` | `metadata.publishCampaignId` (set at publish time) | Diagnostic + lets us cross-check the call belongs to the expected campaign. |
| `ringcxDialGroupId` | `metadata.publishDialGroupId` | Diagnostic. |
| `externalLeadId` | `parallel:DOMAIN:caseId:queueItemId` (sent at publish) | Strong forensic ID; also visible in active-calls. |

**The fix**: extend `CxDialQueue.assignment` (or stamp into the doc's
existing Mixed `metadata`) with `ringcxAgentId` + `ringcxAgentGroupId`
at assign-time. Then in `handleCxCallPlaced` at
[cxCadenceService.js:1509](../packages/shared-services/src/cxCadenceService.js),
extend the `upsertCallLog` payload to include those plus campaign /
dial-group / externalLeadId. Tiny patch — one read from `queueItem`,
five extra fields in the upsert.

### 2. On-demand recording endpoint

New endpoint, ~50 lines:

```
GET /api/admin/call-review/call/:domain/:telephonySessionId/recording

1. Look up the CallLog row by domain + telephonySessionId.
2. If recordingArchive.driveFileId is set:
     → 302 redirect to /api/read/cx/recordings/play/:fileId (existing
       Drive proxy with Range support).
3. Else, do an inline metadata fetch:
     a. Compute a tight time window: [callStartTime - 60s, callEndTime + 60s].
        Fall back to [now - 90min, now - 15min] if start/end missing.
     b. Pass agentIds: [ringcxAgentId] when available so the metadata
        response stays tiny (1-2 rows typically).
     c. Find the row whose interactionId === telephonySessionId.
     d. Pick the segment with recording=true (multi-segment calls take
        the first recorded leg; revisit if transfers show up).
     e. downloadRecordingBySegment(dialogId, segmentId) → binary WAV.
     f. Stream the buffer directly to the client with the right
        Content-Type. Background: kick off an async Drive upload +
        stamp recordingArchive on the CallLog so the next click is the
        fast path.
```

The route is auth-gated as admin (same posture as the rest of
`/api/admin/call-review`). It's idempotent — calling it twice within
the metadata's 2 RPM budget is fine because the second call hits the
cached `driveFileId` and never re-fetches metadata.

### 3. UI tweak (small)

The dashboard's `recording.playbackUrl` becomes "smart" — always set,
always points at the new on-demand endpoint:

```
recording.playbackUrl =
  driveFileId
    ? "/api/read/cx/recordings/play/${driveFileId}"     // fast path
    : "/api/admin/call-review/call/${domain}/${uii}/recording"  // on-demand
```

The HTML5 `<audio>` element doesn't care which endpoint serves the
bytes. The first click on a non-cached call shows a short loading
spinner while metadata+download runs (typically 2-4s); subsequent
clicks hit the Drive proxy in <500ms.

**"No rec" badge** stays for calls where we KNOW recording wasn't
captured (status is `"no_recording"` or terminal failure stamped by
the existing hourly poller). Calls we haven't tried yet just show a
play button — first click does the work.

### Implementation order if you decide to ship this

1. **Stamp the missing fields**: extend `CxDialQueue.assignment` +
   `handleCxCallPlaced`'s `upsertCallLog` to include `ringcxAgentId`
   etc. ~30 lines. Doesn't affect anything else.
2. **Build the on-demand endpoint** in `adminCallReview.js`. ~50 lines.
   Uses the existing `fetchInteractionMetadata` +
   `downloadRecordingBySegment` from `ringcxVoiceClient`. Returns
   binary; client treats it like any other audio URL.
3. **Update `projectCallRow`** in `adminCallReview.js` to fall back to
   the on-demand URL when `driveFileId` is missing. ~5 lines.
4. **Test** with the marker script's known call: open the user's
   detail drawer, find the call row, click play. First click triggers
   the on-demand path; second click confirms the Drive cache.

This composes cleanly with the hourly poller — the poller fills the
cache in the background for everything; the on-demand path covers the
"I want this call NOW" use case for fresh calls and for any miss in
the poller's coverage.

### What still needs RC support's blessing

Both paths (hourly + on-demand) read from `interaction-metadata`. So
the 403 unblock is the same precondition. Once that's resolved:

- Hourly poller backfills automatically on the next fire.
- On-demand endpoint works on the first click for any call where we
  have a UII + the basic CallLog row.
- Spot-download works even for calls the hourly poller hasn't reached
  yet (e.g. a call placed 20 minutes ago, before the next :00
  trigger).

