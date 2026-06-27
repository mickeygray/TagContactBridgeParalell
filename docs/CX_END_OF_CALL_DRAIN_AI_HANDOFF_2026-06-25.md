# CX End-Of-Call Drain + AI Handoff Plan - 2026-06-25

Purpose: guide the next pass so appointment tasks, interview activity, call summaries, coach closeout, CaseProfile communications, and Logics activity all meet at the end-of-call drain without slowing or destabilizing the dialing loop.

This is not an AI-bus build plan. AI is only a producer of call-summary data here.

## North Star

The live call loop should do the smallest possible thing:

```text
agent button / RingCX auto-advance
  -> write one durable terminal outcome row
  -> let the UI keep moving
```

Everything slower belongs after that:

```text
terminal drain
  -> count/release/advance the queue
  -> enqueue or run call wrap work
  -> append CaseProfile communication
  -> write sparse Logics activity
  -> optionally grade/email only when evidence thresholds pass
```

The dialer should never wait on AI, Logics, CaseProfile enrichment, email, or summary generation.

## Existing Pieces To Respect

### Terminal outcome spine

- `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`
  - `persistTerminalOutcome()` is already the single bulk-rail terminal entry point.
  - It builds the idempotency key from `queueItemId:uii` when UII exists.
  - Keep it narrow: outcome identity only, no summary/Logics/AI logic.

- `packages/shared-models/src/CxTerminalOutbox.js`
  - Durable insert-once outbox for terminal outcomes.
  - Its `payload` is replayed later.
  - It should remain the source of truth for "this call ended and needs to be counted."

- `packages/shared-services/src/cxTerminalOutboxDrain.js`
  - Currently replays rows into `recordCadenceEvent(row.payload)`.
  - This is the correct place to attach post-commit work, but only after the core terminal write succeeds.

- `packages/shared-services/src/cxCadenceService.js`
  - `handleCxTerminalCallOutcome()` is the existing counter/queue/callLog finalizer.
  - Do not duplicate its counter logic in a new summary worker.

### Summary / communication writers

- `packages/shared-services/src/liveCoachCloseoutService.js`
  - Already builds sparse operational summary, optional grade, artifact, CaseProfile communication, LeadCadence summary, Logics activity, and agent email.
  - This is useful, but it must not become a second independent owner of CaseProfile/Logics writes if the drain also writes them.

- `packages/shared-services/src/cxWorkspaceService.js`
  - `executeCxCallSummary()` now appends one `call` entry to `CaseProfile.communications[]` and writes a Logics activity.
  - Treat this as the first draft of the reusable summary writer, not a separate live-loop endpoint.

- `apps/control-plane/src/routes/commandsCx.js`
  - `/:domain/coach/call-summary` is a backend route. Keep it dormant/manual until the final coach form is known.

### Appointment / interview

- `createCxAppointment()` plus `executeCxAppointmentWorkbenchActions()` already creates a Logics task and appointment activity best-effort.
- `executeCxInterviewSnapshot()` saves structured interview data to LeadCadence, then writes the same call-wrap packet to CaseProfile communications and Logics.
- These are user-intent actions and do not need to wait for terminal drain, but they should attach identities that the end-of-call wrap can reference.

## The Clean Ownership Split

### Terminal outbox owns facts about call ending

Payload should be small and stable:

```json
{
  "idemKey": "queueItemId:uii",
  "domain": "WYNN",
  "caseId": 123456,
  "queueItemId": "...",
  "uii": "...",
  "agentEmail": "agent@example.com",
  "externId": "...",
  "outcome": "answered|dnc|voicemail|did_not_connect",
  "source": "disposition|active-call-release|hourly-terminal-rectifier",
  "at": "2026-06-25T..."
}
```

Do not put AI prose here. Do not put full transcript here. Do not do Logics here.

### Call wrap owns what we learned

The call wrap packet can be created from live coach closeout, interview snapshot, call log, and queue metadata:

```json
{
  "threadKey": "cx-call:<uii>",
  "domain": "WYNN",
  "caseId": 123456,
  "queueItemId": "...",
  "uii": "...",
  "terminalOutcome": "answered",
  "happenedAt": "2026-06-25T...",
  "durationSec": 182,
  "agentEmail": "agent@example.com",
  "phone": "+15555551212",
  "summary": "Sparse call summary for communications.",
  "nextStep": "Collect 2023 notice and confirm balance.",
  "contextKeys": ["irs_notice", "levy", "price_objection"],
  "transcriptArtifactPath": "...",
  "interviewSnapshotWorkflowId": "...",
  "coachSessionId": "..."
}
```

This packet is the thing summary AI may enrich. It is also valid without AI.

## Recommended Button-Up Shape

### Step 1 - Keep terminal drain core-only

Do not make `cxTerminalOutboxDrain.drainOnce()` fail because Logics, CaseProfile, email, or AI failed.

Core rule:

```text
recordCadenceEvent(row.payload) succeeds -> terminal row can be core-drained
```

Then post-commit work is separate:

```text
core terminal drained -> enqueue/run call wrap sync
```

Best clean implementation:

- Keep `CxTerminalOutbox.status` for terminal counting only.
- Add a separate call-wrap outbox or queue metadata, for example `CxCallWrapOutbox`, keyed by `threadKey` / `idemKey`.
- If that feels too heavy for first pass, add a `callWrap` subdocument to `CxTerminalOutbox`, but do not overload `status`.

Reason: metrics/cadence must not be held hostage by a Logics outage or a summary model timeout.

### Step 2 - Extract one reusable call-summary writer

Current duplicate risk:

- `liveCoachCloseoutService.writeCaseProfileCommunication()`
- `liveCoachCloseoutService.writeLogicsActivity()`
- `executeCxCallSummary()`

These should become one shared helper:

```text
writeCxCallWrapSummary(domain, userOrSystemActor, callWrapPacket, options)
```

It should:

- dedupe by `threadKey` (`cx-call:<uii>` preferred);
- append one `CaseProfile.communications[]` row with `channel:"call"`;
- write one sparse Logics activity if enabled;
- write no fake summary for non-substantive calls unless explicitly requested;
- return `{ communication, logicsActivity, skippedReason }`.

Keep `executeCxCallSummary()` as a route wrapper around that helper.
Have `liveCoachCloseoutService` call the same helper instead of owning its own duplicate writer.

Status as of the current pass:

- `packages/shared-services/src/cxCallWrapService.js` is the shared call-wrap writer.
- `executeCxCallSummary()` is now a thin wrapper that calls `writeCxCallWrapSummary()`.
- `executeCxInterviewSnapshot()` still saves the structured snapshot to LeadCadence, then writes the same packet through `writeCxCallWrapSummary()` so the interview persists into `CaseProfile.communications[]` and one Logics activity.
- `liveCoachCloseoutService` keeps artifact creation, grading, LeadCadence closeout summary, and agent/manager email thresholds, but its CaseProfile communication and Logics activity now use the shared call-wrap writer.
- Duplicate `threadKey` detection now skips both CaseProfile and Logics, preventing a duplicate app communication plus duplicate activity pair.
- If the CaseProfile communication write fails, Logics is skipped for that packet rather than creating an orphan activity outside the app memory.

The shared writer is intentionally dependency-injected. The terminal drain, workspace route, and live-coach worker can all call it without importing each other or making AI/Logics part of the live dialing loop.

### Step 3 - Let AI produce or improve the packet, not commit it

AI should never write CaseProfile or Logics directly.

AI can produce:

- `summary`
- `nextStep`
- `facts`
- `contextKeys`
- `agentFeedback`
- `grade`
- `transcriptArtifactPath`

The drain/wrap writer commits:

- `CaseProfile.communications[]`
- Logics activity
- LeadCadence closeout summary
- optional emails

This makes rollover safe: if AI falls back or fails, the same deterministic writer still runs with a sparse summary or skips for insufficient evidence.

### Step 4 - Connect live coach closeout to terminal identity

The summary writer needs stable identity:

- `domain`
- `caseId`
- `queueItemId`
- `uii`
- `agentEmail`
- `phone`
- `happenedAt`

If closeout has `uii` but no queue item, it can still write a communication if `caseId` is known.
If terminal outbox has `queueItemId:uii` but closeout is not ready, it can write only the terminal count and leave wrap pending.

Do not block terminal drain waiting for closeout.

### Step 5 - Keep appointment and interview as intent-side writes

Appointment:

```text
agent sets appointment
  -> create appointment record
  -> create Logics task/activity best-effort
  -> terminal outcome later only records what happened on the call
```

Interview:

```text
agent saves/generates interview snapshot
  -> write LeadCadence snapshot
  -> write Logics activity
  -> call wrap may reference latest snapshot id/text, but does not own it
```

Do not move appointment task creation into terminal drain. It is not an end-of-call fact; it is an agent action.

## Proposed Implementation Points

### `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`

Keep as-is except make sure payload carries enough identity for later wrap:

- `phone` if available
- `durationSec` if already known
- `agentName` if available
- `sourceService`

No Logics, no CaseProfile, no AI.

### `packages/shared-services/src/cxTerminalOutboxDrain.js`

Add dependency injection, not hard imports:

```js
createCxTerminalOutboxDrain({
  outboxRepository,
  recordCadenceEvent,
enqueueCallWrap, // optional
logger
})
```

Status as of the current pass:

- `enqueueCallWrap` is now an optional injected hook.
- The hook runs only after `recordCadenceEvent(row.payload)` succeeds and the terminal row is marked drained.
- Hook failures are logged as call-wrap failures and do not flip the terminal row back to failed.
- Hook returns may be `{skipped:true}` for rows that do not have coach/interview/summary material.
- `apps/control-plane/src/server.js` wires the hook to `enqueueCxCallWrapFromTerminal()`. It skips ordinary terminal rows, but rows that already carry readable wrap material (`callSummary`, `summary`, `interviewSnapshot`, `interviewSnapshotWorkflowId`, or `transcriptArtifactPath`) are passed through `writeCxCallWrapSummary()`.
- The hook does not run AI or grading. It only commits already-produced wrap material after terminal counting succeeds.
- Rows that only carry future coach/session identity and no readable summary body skip with `missing-call-wrap-body`; this avoids fake communications.
- The next coach-side implementation can either enrich the terminal row before drain or enqueue a separate call-wrap job, but it should still commit through `writeCxCallWrapSummary()`.

Flow:

```text
for row:
  recordCadenceEvent(row.payload)
  markDrained(row.idemKey)
  enqueueCallWrap(row) best-effort
```

If `enqueueCallWrap` fails, log it and mark call-wrap failed/pending elsewhere. Do not re-fail the terminal row after cadence succeeded.

### `packages/shared-services/src/cxWorkspaceService.js`

Convert `executeCxCallSummary()` internals into a reusable helper:

```text
buildCxCallWrapPacket(input)
writeCxCallWrapSummary(domain, actor, packet, options)
executeCxCallSummary() -> wrapper only
```

The helper should dedupe by `threadKey`.

Current implementation:

- Workspace calls use `writeCxWorkspaceCallWrap()` as the local adapter.
- Manual call summary writes:
  - `source: "cx-call-summary"`
  - `provider: "cx-workspace"`
  - `threadKey` from `cx-call:<uii>` when possible.
- Interview snapshot writes:
  - LeadCadence structured snapshot remains the source of reusable form data.
  - CaseProfile communication receives the readable interview note plus compact snapshot metadata.
  - Logics receives one activity note through the same writer.
  - If no UII exists, `cx-interview:<workflowId>` or `cx-interview:<caseId>:<timestamp>` becomes the dedupe key.

### `packages/shared-services/src/liveCoachCloseoutService.js`

Stop owning separate communication/logics writers long-term.

Replace:

```text
writeCaseProfileCommunication()
writeLogicsActivity()
```

with:

```text
writeCxCallWrapSummary(...closeout packet...)
```

Keep:

- artifact creation;
- grade thresholds;
- agent/manager email thresholds;
- leadCadence summary if that remains the best home for call memory.

Current implementation:

- Artifact creation still happens before durable writes.
- Call grading and grade-email thresholds remain in the closeout worker.
- CaseProfile + Logics commits now go through `writeCxCallWrapSummary()`.
- The packet carries `grade`, `facts`, `contextKeys`, `metrics`, `transcriptArtifactPath`, `coachSessionId`, `uii`, and `queueItemId` in metadata so the communication tab can show the call memory without keeping the whole coach session alive.

### `packages/shared-repositories/src/caseProfileRepository.js`

`appendCommunicationEntry()` already supports `call`; keep using it.

Possible hardening:

- add an atomic dedupe helper:

```text
appendCommunicationEntryOnce(domain, caseId, channel, threadKey, entry)
```

Current code checks duplicate before append in service logic. That is acceptable for first pass, but atomic dedupe is safer once drain workers run concurrently.

### `apps/control-plane/src/routes/commandsCx.js`

Keep:

- `/appointments`
- `/interview-snapshot`
- `/coach/call-summary`

But route summary should be manual/backfill/debug, not the only production writer.

## Summary Write Gate

Do not write a communication for every terminal row.

Suggested first gate:

Write call summary if any of these are true:

- terminal outcome is `answered` or `dnc`;
- duration >= 30 seconds;
- transcript chars >= 120;
- closeout facts/context keys exist;
- agent saved interview or appointment info during the call.

Skip or sparse-only:

- `did_not_connect`
- `voicemail`
- missing `caseId`
- missing UII and missing queue identity

For skipped rows, keep terminal counting. Just do not pollute communications.

## Thread Keys

Use this priority:

```text
cx-call:<uii>
cx-call:<queueItemId>:<outcomeAt>
live-coach:<coachSessionId>
```

Best is always `cx-call:<uii>` because it ties the call log, terminal outcome, coach closeout, communication row, and Logics activity together.

## Tests Claude Should Add

### Pure packet tests

- `buildCxCallWrapPacket()` returns stable `threadKey`.
- It keeps `domain/caseId/queueItemId/uii/outcome/durationSec`.
- It does not require AI fields.

### Summary gate tests

- no-answer/voicemail with no transcript skips communication.
- answered 45s writes communication.
- dnc writes communication even if short.
- missing caseId fails closed without Logics call.

### Dedupe tests

- same `threadKey` writes once.
- second attempt returns `duplicate-thread-key`.
- if CaseProfile write succeeds and Logics fails, retry does not create duplicate communication.

### Drain tests

- cadence failure keeps terminal row failed/pending.
- cadence success plus wrap failure still marks terminal row drained and leaves wrap retryable.
- auto-advance terminal row can create sparse no-contact event without AI.

### Closeout integration tests

- live-coach closeout packet calls shared summary helper.
- below-evidence closeout does not email or write noisy communications.
- grade failure does not block sparse summary write.

## What Claude Should Work Around

- Do not build a big AI-bus migration to solve this.
- Do not let the coach UI call Logics directly for end-of-call summary.
- Do not write communications from both live-coach closeout and the drain with different code paths.
- Do not add summary writes to the 1-second watcher or button response path.
- Do not make terminal counting depend on transcript availability.

## Practical Patch Status

Completed first pass:

1. Extracted the summary writer into `packages/shared-services/src/cxCallWrapService.js`.
2. Made `executeCxCallSummary()` and `executeCxInterviewSnapshot()` call that writer.
3. Made `liveCoachCloseoutService` use that writer for CaseProfile and Logics commits while keeping grade/email thresholds local to closeout.
4. Added the optional `enqueueCallWrap` hook to `cxTerminalOutboxDrain`.
5. Wired the control-plane terminal hook to commit already-produced call-wrap material through the shared writer.
6. Added unit coverage for thread-key derivation, duplicate skipping, interview metadata, app+Logics write pairing, and CaseProfile-failure behavior.

That gives the final coach summary form a clean place to plug in:

```text
coach/interview/AI summary -> callWrapPacket -> shared summary writer
terminal outcome -> terminal outbox drain -> same shared summary writer when ready
```

One writer, one thread key, one communications row, and no AI in the dial loop.
