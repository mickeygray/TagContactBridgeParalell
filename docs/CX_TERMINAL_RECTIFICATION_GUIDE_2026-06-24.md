# CX Terminal Rectification Guide

Date: 2026-06-24

Purpose: design the smallest clean implementation that lets CX calls be counted correctly even when RingCX auto-advances a non-connected call before an agent clicks a terminal button.

The core rule is simple:

> The live dial loop observes calls. Terminal counting is durable. Hourly rectification only repairs missed terminal outcomes when there is enough evidence.

This is not a replacement for the bulk rail. It is the safety net behind the bulk rail, slow rail, and eventually the unified queue rail.

## Current Building Blocks

Use these existing structures. Do not create a parallel counting system.

| Responsibility | Existing file | Current role |
| --- | --- | --- |
| Bulk active-call watcher | `packages/shared-services/src/cxAccountActiveCallWatcherService.js` | Reads RingCX active calls and detects current-call changes/releases. |
| Bulk runtime session orchestration | `packages/shared-services/src/cxBulkLoadRuntimeService.js` | Applies reducer, persists session, calls the outcome adapter when release evidence exists. |
| Durable terminal outbox | `packages/shared-models/src/CxTerminalOutbox.js` | One idempotent terminal row per released/counted call. |
| Outbox repository | `packages/shared-repositories/src/cxTerminalOutboxRepository.js` | Insert-once, list pending, mark drained/failed. |
| Outbox drain | `packages/shared-services/src/cxTerminalOutboxDrain.js` | Replays terminal rows into the cadence finalizer. |
| Control-plane drain worker | `apps/control-plane/src/server.js` | Runs terminal outbox drain every few seconds. |
| Final cadence/counting writer | `packages/shared-services/src/cxCadenceService.js` | `handleCxTerminalCallOutcome` updates LeadCadence, queue state, CallLog, counters. |
| CX call-log backfill | `packages/shared-services/src/cxCallActivityBackfillService.js` | Reconstructs CX CallLog rows from placed events and queue metadata. |
| CX recording hourly | `packages/shared-services/src/cxRecordingHourlyService.js` | Downloads/archive/transcribes recordings for existing CallLog rows only. |

## Component Implementation Map

This section is the implementation checklist. Do these in order. Each step should be small enough to code, test, and revert by itself.

### 0. Schema prerequisite: make queue ownership real on `CallLog`

Problem found during audit: several writers pass an `audit` object to `callLogRepository.upsertCallLog`, but `packages/shared-models/src/CallLog.js` does not currently define an `audit` field. Do not build rectification on a field that may not persist.

Update `packages/shared-models/src/CallLog.js`:

1. In the existing `ringcx` block near `CallLog.js:273`, add explicit fields:
   - `queueItemId: { type: String, default: null, index: true }`
   - `agentEmail: { type: String, default: null }`
   - `actionKey: { type: String, default: null }`
   - optional: `terminalSource: { type: String, default: null }`
2. Add an index after the existing CX indexes near `CallLog.js:320`:
   - `{ domain: 1, platform: 1, "ringcx.queueItemId": 1, telephonySessionId: 1 }`
3. Do not add a broad unstructured `audit` dependency for this workflow. If an `audit` field is later wanted for debugging, it can be added separately, but rectification should rely on indexed, named fields.

Update `packages/shared-services/src/cxCadenceService.js`:

1. In `handleCxCallPlaced` near `cxCadenceService.js:2203`, extend the `ringcxStamp` object near `cxCadenceService.js:2291`:
   - `queueItemId: String(queueItem._id)`
   - `agentEmail: payload.agentEmail || null`
   - `actionKey: payload.actionKey || queueItem.metadata?.actionKey || null`
2. In the `callLogRepository.upsertCallLog` call near `cxCadenceService.js:2360`, make sure `ringcx: ringcxStamp` carries those fields.
3. In `handleCxTerminalCallOutcome` near `cxCadenceService.js:2651`, update the terminal `CallLog` upsert near `cxCadenceService.js:2888` so it also sets:
   - `ringcx.queueItemId`
   - `ringcx.externId` when available
   - `ringcx.terminalSource`
   - `callEndTime`
   - `missed`

Update `packages/shared-services/src/cxCallActivityBackfillService.js`:

1. In event-prepared rows near `cxCallActivityBackfillService.js:275`, move queue ownership into `ringcx.queueItemId`, not `audit.queueItemId`.
2. In queue-row-prepared rows near `cxCallActivityBackfillService.js:359`, also write `ringcx.queueItemId`.
3. Keep any debug metadata as non-authoritative. Rectification reads `ringcx.queueItemId`.

Acceptance check:

- A newly placed CX call produces a `CallLog` row with `platform: "cx"`, real `telephonySessionId`, and `ringcx.queueItemId`.
- Terminal outcome upsert preserves those fields.

### 1. Add the terminal rectification service

Create `packages/shared-services/src/cxTerminalRectificationService.js`.

Keep this file split into three zones:

1. Pure helpers.
2. Candidate/classification functions.
3. Thin orchestration functions with injected repositories.

Functions to implement, in order:

1. `isRealRingcxUii(value)`
   - returns false for empty values and `cx-synth:*`;
   - returns true for real RingCX session ids.
2. `normalizeRectificationWindow(input)`
   - converts `now`, `sinceMs`, and `minAgeMs` into `{ from, to, minEndedBefore }`.
3. `buildTerminalRectificationIdemKey({ queueItemId, uii })`
   - returns the exact idempotency key used by terminal outbox.
4. `extractRectificationKeysFromCallLog(callLog)`
   - reads `domain`, `telephonySessionId`, `ringcx.queueItemId`, `ringcx.externId`, `caseId`, `agentEmail`.
5. `classifyRectificationEvidence(input)`
   - pure decision function; no Mongo, no RingCX.
6. `buildTerminalOutboxPayloadFromEvidence(evidence)`
   - returns the row for `cxTerminalOutboxRepository.insertOnce`.
7. `previewCxTerminalRectification(deps, options)`
   - reads candidates and returns counts/samples only.
8. `runCxTerminalRectification(deps, options)`
   - calls preview/classification and inserts outbox rows when write mode is enabled.

Export pure helpers for unit tests.

Do not import `cxBulkLoadRuntimeService.js` into this file. If a shared idem-key helper is needed, extract it to a tiny shared helper such as `packages/shared-services/src/cxTerminalOutcomeKey.js`.

### 2. Add narrow repository helpers

Prefer small repository helpers over embedding query details in the service.

Update `packages/shared-repositories/src/callLogRepository.js`:

1. Add `listCxCallLogsForTerminalRectification({ from, to, domains, limit })`.
2. Query shape:
   - `platform: "cx"`
   - `telephonySessionId: { $exists: true, $nin: [null, ""] }`
   - exclude `telephonySessionId` matching `^cx-synth:`
   - `ringcx.queueItemId: { $exists: true, $nin: [null, ""] }`
   - window on `callStartTime` or `callEndTime`
3. Projection should include only:
   - `domain`
   - `telephonySessionId`
   - `callStartTime`
   - `callEndTime`
   - `caseId`
   - `phone`
   - `extensionId`
   - `agentName`
   - `ringcx`
   - `missed`
   - `platform`
4. Export it from `module.exports` near `callLogRepository.js:474`.

Update `packages/shared-repositories/src/cxTerminalOutboxRepository.js`:

1. Add `findByIdemKeys(idemKeys)`.
2. Keep it read-only and capped by caller input.
3. Projection can be small: `idemKey`, `status`, `queueItemId`, `uii`, `outcome`.

If the rectifier needs queue row state, use the existing `cxDialQueueRepository.findQueueItemById`. Only add a batch helper if N+1 becomes visible in dry-run logs.

### 3. Wire hourly in dry-run first

Update `packages/shared-services/src/hourlySweeperService.js`:

1. Import `runCxTerminalRectification` near the existing `recoverCxCallLogs` import at `hourlySweeperService.js:36`.
2. Add `runCxTerminalRectificationStep({ logger, domains, sinceMs, minAgeMs, limit, dryRun })` after `runCxCallActivityBackfill` near `hourlySweeperService.js:910`.
3. Add new `runHourlySweep` args near `hourlySweeperService.js:967`:
   - `cxTerminalRectificationEnabled = false`
   - `cxTerminalRectificationDryRun = true`
   - `cxTerminalRectificationSinceMs`
   - `cxTerminalRectificationMinAgeMs`
   - `cxTerminalRectificationLimit`
4. In Phase A, insert `cxTerminalRectification` after `cxCallActivityBackfill` near `hourlySweeperService.js:1047` and before `metricsRefresh` near `hourlySweeperService.js:1054`.
5. Update the compact hourly summary near `hourlySweeperService.js:210` to include:
   - scanned
   - wouldInsert
   - inserted
   - weak
   - ignored
   - errors

Update `apps/control-plane/src/server.js`:

1. Pass the new args into `runHourlySweep` near `server.js:549`.
2. Read from `config.hourlySweep` if available, otherwise env:
   - `HOURLY_CX_TERMINAL_RECTIFICATION_ENABLED`
   - `HOURLY_CX_TERMINAL_RECTIFICATION_DRY_RUN`
   - `HOURLY_CX_TERMINAL_RECTIFICATION_SINCE_MS`
   - `HOURLY_CX_TERMINAL_RECTIFICATION_MIN_AGE_MS`
   - `HOURLY_CX_TERMINAL_RECTIFICATION_LIMIT`
3. Do not create a separate worker in v1. It belongs in the existing hourly order so metrics runs after it.

Initial mode:

- disabled by default in config;
- enable for shadow with dry-run true;
- no writes except logs until write mode is intentionally flipped.

### 4. Harden the active-call release path

Update `packages/shared-services/src/cxAccountActiveCallWatcherService.js`:

1. Around `projectBulkSessionFromAccountSnapshot` release observations near `cxAccountActiveCallWatcherService.js:102`, only push a terminal observation if the released candidate has:
   - `queueItemId`
   - real `uii`
2. Around the apply loop near `cxAccountActiveCallWatcherService.js:336`, skip terminal write if those fields are missing and add a skipped reason:
   - `missing-queue-item-or-uii`
3. Keep the reducer release behavior separate from terminal writing. Visual cleanup can occur, but counting requires proof.

Update `packages/shared-services/src/cxBulkLoadRuntimeService.js`:

1. Around `watchCxBulkLoadSession` release handling near `cxBulkLoadRuntimeService.js:390`, apply the same guard before `persistTerminalOutcome`.
2. Around current release near `cxBulkLoadRuntimeService.js:407`, guard the terminal write the same way.
3. If proof is missing, write trace only; do not count.

### 5. Keep the existing terminal drain unchanged

Do not rewrite `packages/shared-services/src/cxTerminalOutboxDrain.js`.

The current drain already:

- reads pending/failed rows;
- calls injected `recordCadenceEvent`;
- marks drained or failed;
- continues after row-level errors.

The only allowed change here is a test if needed.

### 6. Do not touch recording hourly

Leave `packages/shared-services/src/cxRecordingHourlyService.js` alone for terminal rectification.

It already has the right job:

- find eligible CX `CallLog` rows;
- fetch RingCX interaction metadata once for the hour;
- process recordings.

Do not add terminal repair logic here.

## Boundaries

### Live Loop

The live loop may:

- observe active calls;
- match current RingCX call to a candidate;
- write a terminal outbox row when a previously observed UII disappears;
- update the visual state.

The live loop must not:

- call Logics;
- do broad RingCentral call-log sweeps;
- fetch RingCX recording metadata per missing call;
- infer no-answer from publish-only evidence;
- block UI handoff on metrics/cadence writes.

### Terminal Outbox

The terminal outbox is the durable bridge between "we know this call ended" and "the business counters have been updated."

It owns:

- idempotency;
- crash recovery;
- retries;
- decoupling the live loop from heavier cadence writes.

It should remain the single path into `handleCxTerminalCallOutcome` for bulk auto-release outcomes.

### Hourly Rectification

Hourly rectification is not the primary writer. It is an auditor.

It may:

- find strong uncounted call evidence from recent `CallLog`, `CxDialQueue`, or terminal outbox rows;
- insert missing terminal outbox rows;
- report weak evidence without counting it;
- reconcile missing `CallLog` rows through the existing call activity backfill.

It must not:

- mark a lead no-answer just because it was published to RingCX;
- make per-call RingCX metadata calls in a loop;
- mix recording download work with terminal repair;
- directly mutate LeadCadence counters outside the terminal finalizer.

## Evidence Levels

Use evidence level to decide whether a missing terminal outcome can be safely repaired.

### Strong Evidence

Safe to write `did_not_connect`.

Required:

- `queueItemId`
- real `uii`
- prior observation that this UII was active for the owned candidate
- later observation that the UII disappeared or was replaced
- no existing terminal outbox row for the same `queueItemId + uii`
- no current active call for that `uii`

Examples:

- account watcher saw `q1/u1`, then next tick saw `q2/u2`;
- current call had `uii`, then disappeared from active calls while the session continued;
- a `CallLog` row exists with real `telephonySessionId`, `ringcx.queueItemId`, `callEndTime`, and no terminal metadata.

### Medium Evidence

Usually safe after a grace window, but should be dry-run logged before first write mode.

Required:

- real `uii`
- `CallLog.platform = "cx"`
- `CallLog.callStartTime` older than a configured grace period
- `ringcx.queueItemId` ties it back to our queue
- no matching terminal outbox row
- no queue row already completed/cancelled from another terminal path

Action:

- In dry-run, report.
- In write mode, insert a terminal outbox row as `did_not_connect`.

### Weak Evidence

Do not count automatically.

Examples:

- lead was published to RingCX but no UII was ever observed;
- synthetic `cx-synth:*` session id only;
- queue item has `ringcxPublished = true` but no active-call/current-call proof;
- stale queue row lacks `uii` and only has phone/caseId timing.

Action:

- Write a diagnostic summary only.
- Keep it available for manual review or a later call-log correlation pass.

## New Service Shape

Create one new service file:

`packages/shared-services/src/cxTerminalRectificationService.js`

Keep it pure at the top, I/O at the bottom.

### Pure Helpers

#### `normalizeRectificationWindow(input)`

Input:

```js
{
  now,
  sinceMs,
  minAgeMs,
  maxAgeMs
}
```

Output:

```js
{
  from,
  to,
  minEndedBefore
}
```

Rules:

- default `sinceMs` to the same 65-minute shape used by the hourly sweep;
- default `minAgeMs` to 2 to 5 minutes so an in-flight call is never rectified;
- cap broad scans.

#### `buildTerminalRectificationIdemKey(input)`

Input:

```js
{
  queueItemId,
  uii,
  source
}
```

Output:

```js
`cx-terminal:${queueItemId}:${uii}`
```

Rules:

- require `queueItemId`;
- require real `uii`;
- do not build an idem key for synthetic session ids;
- keep this consistent with the bulk outcome adapter.

If the existing bulk `makeOutcomeIdemKey` is already exported cleanly, use it. If not, extract only the key builder into a tiny shared helper. Do not import the whole runtime service just to make a string.

#### `classifyRectificationEvidence(input)`

Input:

```js
{
  callLog,
  queueItem,
  existingOutbox,
  activeUiiSet,
  now
}
```

Output:

```js
{
  level: "strong" | "medium" | "weak" | "ignore",
  action: "insert-terminal-outbox" | "report-only" | "skip",
  outcome: "did_not_connect" | null,
  reason,
  queueItemId,
  uii,
  domain,
  caseId,
  agentEmail,
  externId
}
```

Rules:

- `existingOutbox` means `ignore`, reason `already-has-terminal-outbox`;
- active UII means `ignore`, reason `still-active`;
- missing UII means `weak`;
- missing queue ownership means `weak`;
- real UII plus owned queue item plus aged call evidence means `strong` or `medium`;
- never return `answered`, `dnc`, or `voicemail` from rectification. Rectification only supplies the no-contact default.

#### `buildTerminalOutboxPayloadFromEvidence(evidence)`

Input:

```js
{
  queueItemId,
  domain,
  caseId,
  uii,
  externId,
  agentEmail,
  source
}
```

Output:

```js
{
  idemKey,
  sessionId: null,
  rail: "rectifier",
  domain,
  queueItemId,
  uii,
  caseId,
  agentEmail,
  externId,
  outcome: "did_not_connect",
  source: "hourly-terminal-rectifier",
  payload: {
    queueItemId,
    domain,
    caseId,
    uii,
    externId,
    outcome: "did_not_connect",
    source: "hourly-terminal-rectifier",
    sourceService: "cx-terminal-rectifier",
    agentEmail,
    at
  }
}
```

Rules:

- produce the exact shape the existing outbox drain already replays;
- no LeadCadence writes here;
- no CallLog writes here;
- the drain remains the finalizer.

### I/O Functions

#### `listRectificationCandidates({ from, to, domains, limit })`

Read only.

Primary scan:

- `CallLog` where:
  - `platform: "cx"`
- `telephonySessionId` real and not synthetic
- `callStartTime` or `callEndTime` inside the window
  - has `ringcx.queueItemId`

Secondary lookup:

- `CxDialQueue` by `ringcx.queueItemId` from each call log;
- existing `CxTerminalOutbox` by `queueItemId + uii`;
- optional active UII set from the account watcher cache or a passed-in snapshot.

Do not call RingCX here in v1. Pass active UIIs in if a worker already has them.

#### `previewCxTerminalRectification(options)`

Read only.

Returns:

```js
{
  dryRun: true,
  window,
  scanned,
  strong,
  medium,
  weak,
  ignored,
  wouldInsert,
  samples,
  reasons
}
```

Use this for logs and first-day shadow mode.

#### `runCxTerminalRectification(options)`

Write mode.

Flow:

1. Build window.
2. List candidates.
3. Classify evidence.
4. Insert terminal outbox rows for `action = "insert-terminal-outbox"`.
5. Return counts.

This function should not call `handleCxTerminalCallOutcome` directly. It inserts outbox rows only. The existing drain owns replay.

## Hourly Wiring

Add one optional phase in `packages/shared-services/src/hourlySweeperService.js`.

Suggested placement:

1. `callLogHygiene`
2. `cxCallActivityBackfill`
3. `cxTerminalRectification`
4. `metricsRefresh`
5. recording/scoring/enrichment

Reason:

- call activity backfill can create missing CallLog stubs;
- terminal rectification can then create missing outbox rows;
- metrics refresh should run after terminal repairs.

New flag:

```txt
HOURLY_CX_TERMINAL_RECTIFICATION_ENABLED=false
HOURLY_CX_TERMINAL_RECTIFICATION_DRY_RUN=true
HOURLY_CX_TERMINAL_RECTIFICATION_SINCE_MS=3900000
HOURLY_CX_TERMINAL_RECTIFICATION_MIN_AGE_MS=300000
HOURLY_CX_TERMINAL_RECTIFICATION_LIMIT=1000
```

Initial live posture:

- disabled by default;
- enable intentionally with dry run true;
- log summaries only.

Write posture:

- dry run false after one clean evidence day.

## Active-Call Watcher Integration

The account watcher already detects release observations. Keep that as the fastest strong-evidence path.

Required shape:

```js
await outcomeAdapter.persistTerminalOutcome({
  session,
  candidate,
  outcome: "did_not_connect",
  source: "active-call-release",
  eventType: "terminal"
});
```

Hardening checks:

- only write release outcome if candidate has a real `uii`;
- candidate must have `queueItemId`;
- release must be derived from prior active set, not merely from absence in the app buffer;
- duplicate insert must be harmless through outbox idem key.

## What Not To Reuse

Do not use the CX recording hourly worker for terminal rectification.

Why:

- it only sees existing `CallLog` rows;
- it filters by duration and recording status;
- it is gated by recording enablement;
- it uses RingCX interaction metadata, which is rate-limited and intended for media retrieval.

Do not use broad RingCentral account call-log sweep as a per-call decision tool.

Why:

- it is a heavy hourly reconciliation surface;
- it is not the live source for RingCX campaign handoff;
- it should remain a verifier/enricher, not part of the dial loop.

## Tests

Create unit tests first. No Mongo required for pure helpers.

Implemented test file:

- `tests/cx-bulk-load/cxTerminalRectificationService.test.js`

Required cases:

1. Real UII, queue item, no outbox, not active -> inserts `did_not_connect`.
2. Existing outbox -> skips duplicate.
3. Active UII -> skips as `still-active`.
4. Synthetic `cx-synth:*` session -> report only.
5. Missing queue item -> report only.
6. Missing UII -> report only.
7. CallLog without `callEndTime`, or with a too-recent `callEndTime`, stays report-only.
8. Insert failure on one row does not abort the whole batch.
9. Dry run never calls `insertOnce`.
10. Write mode inserts outbox only, never calls `handleCxTerminalCallOutcome`.

Integration smoke:

1. Seed a fake CX CallLog with `platform: "cx"`, real UII, `ringcx.queueItemId`.
2. Seed matching queue row with no terminal metadata.
3. Run rectifier dry-run.
4. Confirm `wouldInsert = 1`.
5. Run write mode.
6. Confirm one `CxTerminalOutbox` row.
7. Run drain.
8. Confirm `handleCxTerminalCallOutcome` updates queue/cadence through existing behavior.

## Acceptance Criteria

Do not ship write mode until all are true:

- No terminal outcomes are written without real UII or explicit release evidence.
- No live UI action waits on rectification.
- Duplicate release observations produce one outbox row.
- Hourly rectifier produces a reason breakdown.
- Metrics refresh runs after rectification when enabled.
- Recording hourly still only handles recording/transcription.
- Weak evidence stays visible but does not count.

## First Implementation Pass

Smallest useful patch:

1. Patch `CallLog.ringcx.queueItemId` schema + writers first.
2. Add repository helpers.
3. Add `cxTerminalRectificationService.js` with pure helpers and dry-run preview.
4. Add tests for classification and payload building.
5. Wire an hourly summary behind disabled-by-default, dry-run-by-default env flags.
6. Run one business day and compare:
   - active-call release terminal writes;
   - terminal outbox rows;
   - rectifier `wouldInsert`;
   - CallLog rows with CX UII but no terminal metadata.
7. Only then enable write mode.

The design goal is not to make the hourly job clever. The goal is to make the live loop simple and let the hourly job prove where the live loop missed a durable terminal row.

## Implementation Status - First Pass

Implemented in this pass:

1. `CallLog.ringcx.queueItemId`, `agentEmail`, `actionKey`, and `terminalSource` are schema-backed and indexed for rectification lookup.
2. CX call placed/backfill/terminal writers now stamp queue ownership into `ringcx`, not only debug/audit data.
3. `cxTerminalRectificationService.js` can preview or insert terminal outbox rows for old-enough ended real RingCX calls that have an owning queue row and no prior terminal proof.
4. Open call logs and too-recent ended calls remain report-only.
5. Hourly sweep now has disabled-by-default, dry-run-by-default rectification flags and summary output.
6. The bulk active-call release paths require both a real UII and queue item before terminal writes.
7. Focused unit tests cover classification, payload shape, dry-run read-only behavior, and write-mode outbox insertion.

Still deferred:

1. Integration smoke against real Mongo.
2. One dry-run business window to inspect reason breakdowns.
3. Enabling write mode.
4. Any batch queue-row lookup optimization if dry-run logs show N+1 overhead matters.
