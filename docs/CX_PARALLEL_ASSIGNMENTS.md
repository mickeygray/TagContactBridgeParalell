# CX Parallel Assignments

**Status:** split workstreams for parallel implementation with minimal overlap.

## Goal

Take the merged CX backlog and split it into two coherent assignment sheets:

- one for **Codex**
- one for **Claude**

The split should minimize merge conflicts, keep ownership clear, and preserve a stable contract between backend serving logic and frontend workspace behavior.

## Shared Rules

- Do **not** edit files owned by the other workstream unless the contract has already changed and both sides agree.
- Keep queue-family names exact:
  - `fresh-day1`
  - `fresh-day2to10`
  - `aged`
- Keep Logics as the source of truth for write outcomes.
- If a contract changes, update this doc first.
- Avoid "helpful" cross-cutting refactors during this pass.

## Shared Contract

These are the contracts both workstreams should assume.

### Queue item contract

The frontend queue should be able to consume items shaped like:

```json
{
  "domain": "WYNN",
  "caseId": 104846,
  "queueFamily": "fresh-day1",
  "queueDayIndex": 0,
  "state": "ready",
  "priorityScore": 90,
  "releaseAt": "2026-04-28T18:00:00.000Z",
  "claimUntil": null,
  "assignment": {
    "extensionId": null,
    "agentName": null,
    "assignedAt": null
  },
  "leadBody": {},
  "cxAction": {}
}
```

Minimum additions the frontend will want:

- `state`
- `assignment.extensionId`
- `assignment.agentName`
- `assignment.assignedAt`
- `claimUntil`

### Preview assignment contract

Proposed route:

- `POST /api/ringcentral/cx-serving/preview-assign`

Proposed response shape:

```json
{
  "queueItem": {
    "caseId": 104846,
    "queueFamily": "fresh-day1"
  },
  "selectedAgent": {
    "extensionId": "3652",
    "agentName": "Andrew Wells"
  },
  "rankedAgents": [
    {
      "extensionId": "3652",
      "agentName": "Andrew Wells",
      "eligible": true,
      "reasonCode": "lowest-family-count",
      "familyAssignedCount": 2,
      "totalAssignedCount": 9,
      "openAssignments": 1,
      "lastAssignedAt": "2026-04-28T17:10:00.000Z"
    }
  ]
}
```

### Runtime serving contract

Proposed route:

- `GET /api/ringcentral/cx-serving/runtime`

Proposed response shape:

```json
{
  "domain": "WYNN",
  "queueCounts": {
    "fresh-day1": 12,
    "fresh-day2to10": 31,
    "aged": 44
  },
  "agents": [
    {
      "extensionId": "3652",
      "name": "Andrew Wells",
      "cxRouting": {
        "desiredAvailability": "available",
        "reason": "manual-available"
      },
      "openAssignments": 1,
      "assignmentStats": {
        "freshDay1Assigned": 2,
        "freshDay2to10Assigned": 5,
        "agedAssigned": 1,
        "totalAssigned": 8,
        "lastAssignedAt": "2026-04-28T17:10:00.000Z"
      },
      "eligibility": {
        "eligible": true,
        "reasonCode": "ok"
      }
    }
  ]
}
```

### Recording playback contract

Preferred backend shape:

```json
{
  "recordingArchive": {
    "provider": "ringcentral",
    "driveFileId": "abc123",
    "playbackUrl": "/api/recordings/play/abc123",
    "isPartialRecording": true
  }
}
```

The frontend should not depend on raw Google Drive folder browsing.

## Codex Assignment Sheet

### Mission

Make the **serving truth** explicit in backend/runtime code and expose stable contracts the workspace can consume.

### Owned Files

- `C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\cxCadenceService.js`
- `C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\cxLoadBalancerService.js`
- `C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\cxWorkspaceService.js`
- `C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-models\src\AgentState.js`
- `C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-models\src\CxDialQueue.js`
- `C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-repositories\src\agentStateRepository.js`
- `C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-repositories\src\leadCadenceRepository.js`
- `C:\Users\Admin\Code\TagContactBridgeParallel\apps\ringcentral-cx\src\server.js`
- `C:\Users\Admin\Code\TagContactBridgeParallel\apps\control-plane\src\routes\readCx.js`
- any new backend route/service files needed for serving-runtime or recording-playback endpoints

### Do Not Touch

- `C:\Users\Admin\Code\TagContactBridgeParallel\apps\web-client\src\workspaces\cx\*`
- `C:\Users\Admin\Code\TagContactBridgeParallel\apps\web-client\src\lib\api\queries\cx.ts`
- `C:\Users\Admin\Code\TagContactBridgeParallel\apps\web-client\src\lib\api\types.ts`

### Work Items

1. Add `preview-assign` route
   - implement `POST /api/ringcentral/cx-serving/preview-assign`
   - return ranked agents with `reasonCode`
   - no writes

2. Add serving runtime route
   - implement `GET /api/ringcentral/cx-serving/runtime`
   - expose queue counts, agent counters, and eligibility reasons

3. Make queue family explicit at write time
   - stop relying on read-time inference wherever possible
   - write `queueFamily` when CX work is created or promoted

4. Add real-time `openAssignments`
   - increment on claim
   - decrement on complete / release / timeout

5. Add saturation enforcement
   - start with `max 3 open assignments globally per agent`
   - keep implementation configurable later

6. Make `claim-next` idempotent and race-safe
   - two agents should not win the same ticket
   - retries should not duplicate assignment side effects

7. Define queue mutation behavior in code
   - `ready -> claimed`
   - `claimed -> pending`
   - `claimed -> ready`
   - `claimed -> completed/cancelled`

8. Add recording playback endpoint
   - convert `recordingArchive.driveFileId` into a playback/proxy URL the frontend can consume

9. If time permits, write a short ADR or note for tenant authorization source-of-truth
   - do not block the rest of the backend work on this

### Definition Of Done

- `preview-assign` route returns deterministic ranking for the same input
- `runtime` route shows counters and eligibility reasons
- `claim-next` updates assignment and `openAssignments` atomically
- queue items exposed to the frontend include assignment/state fields
- recording archive data has a usable playback path

### Notes

- This workstream owns the serving math and queue truth.
- It should not spend time polishing the workspace UI.
- If backend payload shape changes, update the shared contract in this doc.

## Claude Assignment Sheet

### Mission

Make the **workspace behave like the future serving console** using the backend truth that already exists or is being added.

### Owned Files

- `C:\Users\Admin\Code\TagContactBridgeParallel\apps\web-client\src\workspaces\cx\CXWorkspace.tsx`
- `C:\Users\Admin\Code\TagContactBridgeParallel\apps\web-client\src\lib\api\queries\cx.ts`
- `C:\Users\Admin\Code\TagContactBridgeParallel\apps\web-client\src\lib\api\types.ts`
- any small UI helper/component files directly supporting the CX workspace

### Do Not Touch

- `C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\cxCadenceService.js`
- `C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\cxLoadBalancerService.js`
- `C:\Users\Admin\Code\TagContactBridgeParallel\apps\ringcentral-cx\src\server.js`
- backend queue mutation / serving logic

### Work Items

1. Replace simulator-first dial UX with real dial UX
   - wire the normal operator action to `requestCxDial`
   - keep simulation only as an explicit dev/test path if needed

2. Show EX-busy override explicitly
   - if an agent tries to go `available` while EX has them busy, show a visible explanation
   - do not leave this as a silent state override

3. Update the queue surface to consume assignment-aware payloads
   - use `state`
   - use `assignment`
   - prepare for either “assigned only” or “pool + my claims” depending on the final visibility model

4. Surface archived recordings in history
   - consume backend `recordingArchive.playbackUrl`
   - gracefully fall back to legacy `transcription.recordingUri`

5. Improve failure UX
   - lookup failure
   - save/update failure
   - send failure
   - dial failure
   - permission failure
   - move beyond generic toast-only behavior where it matters

6. Add supervisor/admin fairness visibility
   - consume the runtime route
   - show who is paused
   - show who is EX-busy
   - show hot/newish/aged counts

7. Expand wrap-up UI only where needed
   - do not invent a giant form
   - add only the fields or indicators needed to make backend outcomes understandable and metrics-usable

### Definition Of Done

- operator has a real dial action in the workspace
- EX-busy override is visible and understandable
- queue sections can render assignment-aware data
- recordings can play through backend playback URLs when available
- supervisor/admin view can read runtime fairness data

### Notes

- This workstream owns user-facing behavior.
- It should not redesign queue truth or serving math.
- If the backend route is not ready yet, code to the shared contract and guard the UI cleanly.

## Recommended Parallel Start

### Codex starts immediately on

1. `preview-assign`
2. `runtime`
3. `openAssignments`
4. `claim-next` idempotency

### Claude starts immediately on

1. real dial button
2. EX-busy override UX
3. failure UX cleanup

### Claude waits for Codex contract on

1. assignment-aware queue rendering
2. supervisor fairness view
3. recording archive playback wiring

## Handoff Checkpoints

- After Codex lands `preview-assign`, Claude can lock UI expectations for ranking/debug displays.
- After Codex lands `runtime`, Claude can wire supervisor visibility.
- After Codex lands recording playback contract, Claude can replace legacy recording-only rendering.
