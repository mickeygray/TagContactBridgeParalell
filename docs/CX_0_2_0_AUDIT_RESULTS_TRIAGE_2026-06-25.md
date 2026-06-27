# CX 0.2.0 audit results triage - 2026-06-25

Source reviewed: `docs/CX_0_2_0_DEEP_SCRUB_AUDIT_GUIDE_2026-06-25.md`, section 20.

Purpose: organize the audit results into what must be fixed before a bulk/0.2.0 pilot, what is real but can follow, and what is stale or overstated. This is not a second rewrite plan. It is a pilot-readiness filter.

## Verdict

The audit is mostly useful. It correctly found several real implementation defects and a real test-coverage blind spot around the live route boundary. It also overstates a few items as floor-critical when they live in abandoned or defensive paths.

The right response is not to tear the rail apart. The right response is:

1. Fix the small real defects that can break start, refill, counting, or cleanup.
2. Add focused tests around those defects and the live `cxBulkLoadRuntime.js` boundary.
3. Demote dead snapshot/source coverage into explicit future-hook documentation or remove it.
4. Keep the simple architecture intact: account watcher projects current call, reservation service owns queue rows, terminal outbox/drain owns durable business writes.

## Required Fixes Before Pilot

### 1. Bulk runtime missing import

Status: real defect, pilot blocker.

File: `packages/shared-services/src/cxBulkLoadRuntime.js`

Current issue:

- `summarizeRingcxLoginPayload(login)` is called inside the live off-hook gate.
- The function is exported from `dialService.js`, but not imported in `cxBulkLoadRuntime.js`.
- Tests currently bypass this path with a fake `offhookGate`, so the start flow can pass tests and still throw at runtime.

Required change:

- Import `summarizeRingcxLoginPayload` from `./dialService`, or extract the summarizer into a small shared helper and import it from both places.
- Add a runtime-boundary test that exercises the real off-hook gate with a fake RingCX client returning `getAgentLogin`.

### 2. Bulk runtime boundary has no dedicated tests

Status: real gap, pilot blocker.

File: `packages/shared-services/src/cxBulkLoadRuntime.js`

Why it matters:

- The orchestrator tests hit `cxBulkLoadRuntimeService.js`, not the actual route-facing wiring layer.
- The untested layer owns agent context resolution, bulk-mode gate, RingCX client actions, outcome-to-disposition mapping, progressive pause/resume, review outcomes, and the off-hook gate.

Required tests:

- Start session through `startCxBulkLoadSession` using fakes.
- Reject non-bulk agents.
- Confirm `bulkOutcomeDisposition("voicemail") === "VM DROP"` and `bulkOutcomeDisposition("dnc") === "Auto Dispo"`.
- Confirm off-hook gate does not throw and returns expected summary.
- Confirm progressive pause/resume behavior, especially superseded restore tokens.
- Confirm DNC review outcome can update an existing outbox row without creating a new terminal duplicate.

### 3. Mutation/version guard helper needs tests

Status: real gap, pilot blocker because it protects against stale watcher writes.

File: `packages/shared-services/src/cxBulkLoadMutationEligibility.js`

Required tests:

- `__v` produces `{ expectedVersion, versionGuard: true }`.
- `updatedAt` fallback produces `{ expectedUpdatedAt, versionGuard: true }`.
- busy session returns `session-busy`.
- stale `__v` returns `stale-projection`.
- stale `updatedAt` returns `stale-projection`.
- matching versions return `ok: true`.

This is small, pure, and should be locked down before leaning on the watcher.

### 4. Refill can still double-reserve under overlapping watcher ticks

Status: likely real defect, pilot blocker.

File: `packages/shared-services/src/cxBulkLoadRuntimeService.js`

Current state:

- `withSessionMutation` is now a real promise-tail serializer for command mutations. The older claim that it is only a Set is stale.
- But `watchAccountActiveCalls()` is not itself wrapped by that serializer.
- It passes `skipSessionIds` and checks `isSessionBusy`, but two watcher ticks can overlap when no agent command is active.
- Both can enter `beforePersist -> maybeRefill()` and reserve/refill against the same depleted session.

Required change:

- Add a per-session refill/watch mutation tail, or route the watcher write/apply path through the same session mutation queue without blocking unrelated agents.
- Add a test that starts two `watchAccountActiveCalls()` calls in parallel with a slow reservation service and asserts only one reserve/refill happens.

### 5. Queue reservation fail-closed promises are not actually fail-closed

Status: real defect, pilot blocker.

File: `packages/shared-services/src/cxQueueReservationService.js`

Issues:

- `assertNotActiveInUcq()` catches `existsForLead` errors as `null`, which means "not active" and keeps the row. The comment says fail-closed.
- `releaseReserved()` passes `metadata.reservationSessionId: undefined` when a row lacks metadata. Mongo can treat `undefined` like a null/missing match, widening the release CAS.

Required changes:

- Treat `existsForLead` errors as active/unsafe and release the row, not keep it.
- In `releaseReserved`, skip rows without a non-empty `metadata.reservationSessionId` and log a warning.
- Add tests for both.

### 6. Reserve mode can violate policy

Status: real defect, pilot blocker if using green-first or disabled policies.

File: `packages/shared-services/src/cxReserveModeService.js`

Issues:

- `green-first` sends all deficit to `fresh-day1` without checking `fresh.eligible`.
- `RC_CX_AGED_MIN_RESERVE_PER_CYCLE` is applied even when the policy is disabled.

Required changes:

- In green-first, use the policy eligibility check before assigning `fresh-day1`.
- Do not apply aged floor unless the policy is enabled.
- Add tests for `fresh.eligible=false` and disabled policy with non-zero aged floor.

### 7. Publisher can mark non-uploaded leads as accepted and can cancel without campaign guard

Status: real defect, pilot blocker.

File: `packages/shared-services/src/cxBulkLoadRingcxPublisher.js`

Issues:

- `publishBatchToRingcx()` uploads only valid candidates, but maps the RingCX result against the original candidate list. A mixed list can mark a dropped/no-externId candidate as accepted even though RingCX never received it.
- `cancelBatchForSession()` does not require `campaignId`, so cancellation can be scoped only by `externIds`.

Required changes:

- Build the accept/reject patch only from the uploaded candidates, and report dropped candidates as rejected.
- Require `campaignId` in `cancelBatchForSession`, mirroring `publishBatchToRingcx`.
- Add tests for mixed valid/invalid candidates, `GENERAL_FAILURE`, nested `lead.externId`, and missing campaign cancel.

### 8. Terminal outcome idempotency is too coarse for correction events

Status: real design bug, pilot blocker for DNC/appointment correction after auto-disposition.

File: `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`

Issues:

- If `uii` exists but `queueItemId` is missing, the idem key can collapse to `sessionId::terminal`, losing UII identity.
- `eventType` is ignored on the `queueItemId:uii` fast path. A post-call DNC/review correction for the same call can collide with the terminal outcome and be dropped.
- `persistTerminalOutcome()` reports `written: true` when the injected writer returns `null`.

Required changes:

- Make UII anchor the key whenever present, even without queue item: e.g. `sessionId:uii:UII`.
- Include `eventType` for non-terminal correction writes: e.g. `queueItemId:uii:dnc`.
- Treat a null writer result as not written.
- Add tests for all three cases.

### 9. Terminal drain can crash on scan failures

Status: real defect, pilot blocker because drain is the safety net.

File: `packages/shared-services/src/cxTerminalOutboxDrain.js`

Issues:

- `listPendingForDrain()` rejection crashes the whole drain call.
- null/non-array return causes iteration failure before the later `Array.isArray` result check matters.

Required changes:

- Wrap the scan in try/catch, log, and return a distinguished zero-work result.
- Normalize non-array pending to `[]`.
- Add tests for scan throw, null return, limit forwarding, DNC payload passthrough, empty list, and string error.

### 10. Reservation reconciliation can adopt and strand

Status: real defect, pilot blocker for startup recovery.

File: `packages/shared-services/src/cxReservationReconcilerService.js`

Issues:

- If `terminalEvidence(row)` throws after the row is adopted, the row remains claimed/reconciled but neither completed nor released.
- `releaseReserved([row])` uses the stale pre-adoption row instead of the CAS-returned `adopted` document.
- Tests do not assert the important audit fields: `queueOutcome`, `actorEmail`, `fromStates`, release reason.

Required changes:

- If terminal evidence fails, release the adopted row conservatively or leave a very explicit retryable state.
- Pass `adopted` to `releaseReserved`.
- Add tests for terminal evidence throw, idempotent repeated startup, exact fromStates, complete payload, and release reason.

### 11. State machine re-init can leak old session arrays

Status: real defect, required before pilot.

File: `packages/shared-services/src/cxBulkLoadStateMachine.js`

Issue:

- `session.started` sets status/phase but does not reset `current`, `acceptedBuffer`, `completed`, review hold, or previous active evidence.

Required change:

- Make `session.started` produce a clean running session unless the runtime intentionally never dispatches it on a non-empty state. The safer implementation is explicit reset.
- Add a test: starting from a state with current/buffer/completed, dispatch `session.started` and assert they are empty/null.

## Required Tests Before Pilot

These are not all separate defects, but they are the tests that protect the pieces most likely to break the floor.

- `cxBulkLoadRuntime.test.js`: live boundary wiring, off-hook gate, disposition mapping, progressive pause/resume, review outcome.
- `cxBulkLoadMutationEligibility.test.js`: version/updateAt/busy/stale guards.
- `cxBulkLoadRuntimeService.test.js`: raw throw clears mutation tail, concurrent commands serialize, overlapping watcher refills do not double-reserve, kill handles current-row cleanup when outcome adapter fails.
- `cxAccountActiveCallWatcherService.test.js`: current switch completes previous with terminal observation, version-miss behavior, busy second-gate, adopted-candidate serving, synthetic UII suppression.
- `cxBulkLoadStateMachine.test.js`: preload/refill/offhook/current.cleared/buffer.released/session.completed/fatal failed/session.started reset.
- `cxQueueReservationService.test.js`: UCQ fail-closed and releaseReserved missing metadata.
- `cxReservationReconcilerService.test.js`: exact forced-complete payload, exact fromStates, terminalEvidence throw recovery, repeated startup idempotency.
- `cxTerminalOutboxDrain.test.js`: scan failure/null return/limit/DNC payload/empty pending.
- `cxTerminalRectificationService.test.js`: terminal metadata skip, terminal queue-state skip, duplicate insert, omitted dryRun default.

## Real But Lower Priority

These should be fixed, but they do not need to block a small controlled bulk test if the above items are handled.

- `cxBulkLoadActiveCallWatcher.js`: queueItemId fallback match test, null/unexpected active-call response tests, ambiguous match tests. Implementation is mostly sensible; coverage needs strengthening.
- `cxBulkLoadLeadSourceService.js`: `normalizeQueueRow` drops `queueFamily` and `rcxCampaignId`, and `snapshotCandidates` is dead relative to the M4 reservation path. This is real but not floor-critical because live `fillBuffer()` no longer uses this path. Either remove the dead requirement from `createCxBulkLoadRuntimeService` or label it as future/diagnostic.
- `cxTerminalRectificationService.js`: most findings are coverage gaps around safety guards. Important for hourly backstop confidence, but not the live loop itself.
- RingCX publisher low items around phone sanitization in returned patch. Important for logs/client hygiene, but secondary to accepted/rejected correctness.

## Stale Or Overstated

These are not nonsense, but they should not drive the patch by themselves.

- "withSessionMutation is only a Set" is stale. Current code has a promise-tail serializer. The remaining problem is that watcher/refill can still run outside that tail.
- "normalizeQueueRow dropping queueFamily is high floor risk" is overstated. It is a real latent bug in the old snapshot path, but the live reservation-sourced refill injects queue family from the raw reserved row.
- "snapshotCandidates tests prove live fillBuffer coverage" is correctly called misleading. The fix is documentation/removal/integration coverage, not urgent behavior surgery.
- Several high labels are really "test missing" labels. They are worth adding because this code is new and sensitive, but they should be grouped into one coverage pass rather than treated as 36 separate production fires.
- The finder-overturned items in section 20.4 should be treated as no action unless a new code read finds regression.

## Suggested Build Order

1. Patch the small implementation defects: missing import, reservation fail-closed, reserve mode policy, publisher accept/cancel guards, outcome idem key, drain scan guard, reconciler evidence failure, state-machine reset.
2. Add pure tests for helpers first: mutation eligibility, reserve mode, outcome idem key, publisher mapping, terminal drain.
3. Add runtime boundary tests for `cxBulkLoadRuntime.js`.
4. Add concurrency tests: command serialization and overlapping watcher refill.
5. Run:

```powershell
node --test tests/cx-bulk-load/*.test.js
node --test tests/cx-bulk-load/*.test.js tests/cx-call-state-guard/*.test.js tests/cx-dial-runtime/*.test.js tests/cx-handoff/*.test.js tests/cx-morning-prep/*.test.js tests/cx-simple-loop/*.test.js tests/queue/cxTerminalOutcome.test.js tests/queue/dispositionMap.test.js
npm.cmd run build:web
```

## Evidence Snippets

These are the current-code excerpts that anchor the required-fix list. They are intentionally short.

### Missing runtime import

File: `packages/shared-services/src/cxBulkLoadRuntime.js`

```js
// Imports include runtime/service deps, but not summarizeRingcxLoginPayload.
const { executeCxHangupRequest } = require("./ringcxDialExecutionService");

// Later, inside offhookGate.isAgentOffhook:
const login = await ringcxClient.getAgentLogin(agentId, agentGroupId);
const summary = summarizeRingcxLoginPayload(login);
```

Why this matters: the live off-hook path can throw `ReferenceError` even though orchestrator tests pass.

### Watcher/refill outside the command mutation tail

File: `packages/shared-services/src/cxBulkLoadRuntimeService.js`

```js
async function withSessionMutation(sessionId, work) {
  const prior = sessionMutationTails.get(key) || Promise.resolve();
  busySessionIds.add(key);
  // command work is serialized here
}

async function maybeRefill(state) {
  const started = reduce(state, { type: "buffer.refill_started", refillThreshold: refillThresholdFor(state) }, now());
  const filled = await fillBuffer(started);
  return filled;
}

async function watchAccountActiveCalls(input = {}) {
  return runCxAccountActiveCallWatchOnce({
    skipSessionIds: Array.from(busySessionIds),
    isSessionBusy,
    beforePersist: async ({ projection, state }) => {
      // not wrapped by withSessionMutation
      return maybeRefill(state);
    },
  });
}
```

Why this matters: the old "only a Set" finding is stale, but overlapping watcher ticks can still race each other into refill when no command is active.

### Reservation fail-closed gap

File: `packages/shared-services/src/cxQueueReservationService.js`

```js
const active = await queueItemRepository.existsForLead(leadId).catch(() => null);
if (active) {
  await releaseReserved([row], "cross-pool-interlock:active-in-queueitem");
} else {
  keep.push(row);
}

// Later:
{ match: { "metadata.reservationSessionId": row?.metadata?.reservationSessionId } }
```

Why this matters: a UCQ check error currently behaves like "safe to keep," and a missing reservation session id can widen the release match.

### Reserve policy bypass

File: `packages/shared-services/src/cxReserveModeService.js`

```js
const open = (family) => getQueueFamilyTargetOpen(policy, family);

if (mode === "green-first") {
  targets = { "fresh-day1": deficit, "fresh-day2to10": 0, "fresh-day16to30": 0, aged: 0 };
}

const agedFloor = readEnvNonNegInt("RC_CX_AGED_MIN_RESERVE_PER_CYCLE", 0, env);
targets.aged = Math.max(Number(targets.aged) || 0, agedFloor);
```

Why this matters: green-first bypasses the `open()` eligibility check, and aged floor can revive a disabled policy.

### Publisher accepts candidates RingCX never received

File: `packages/shared-services/src/cxBulkLoadRingcxPublisher.js`

```js
const payload = buildBulkLeadLoaderPayload(input.candidates, { dialPriority: input.dialPriority });
const result = await client.loadLeads(campaignId, payload);
const patch = toCandidatePublishPatch(result, input.candidates);
```

```js
for (const c of list) {
  if (c.externId && rejectedExternIds.has(c.externId)) {
    rejected.push({ queueItemId: c.queueItemId, externId: c.externId, reason: "rejected" });
  } else {
    accepted.push({ queueItemId: c.queueItemId, externId: c.externId, candidate: c });
  }
}
```

Why this matters: `buildBulkLeadLoaderPayload` filters invalid candidates, but the accept/reject patch is built from the original list.

### Cancel without campaign guard

File: `packages/shared-services/src/cxBulkLoadRingcxPublisher.js`

```js
const campaignId = str(input.campaignId);
const externIds = (Array.isArray(input.candidates) ? input.candidates : [])
  .map((c) => str(c.externId || (c.ringcx && c.ringcx.externId)))
  .filter(Boolean);

const result = await client.leadAction("CANCEL_LEADS", {
  campaignLeadSearchCriteria: { campaignId, campaignIds: campaignId ? [campaignId] : undefined, externIds },
  leadActionParams: {},
});
```

Why this matters: unlike publish, cancel does not reject a missing campaign id.

### Terminal idem key collision

File: `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`

```js
function makeOutcomeIdemKey({ sessionId, queueItemId, uii = null, caseId = null, eventType = "terminal" } = {}) {
  const qid = str(queueItemId);
  const u = str(uii);
  if (qid && u) return `${qid}:${u}`;
  const caseKey = str(caseId);
  if (!qid && caseKey) return `${str(sessionId)}:case:${caseKey}:${str(eventType) || "terminal"}`;
  return `${str(sessionId)}:${qid}:${str(eventType) || "terminal"}`;
}
```

Why this matters: UII is ignored when queue item is absent, and non-terminal correction event types are ignored on the `qid:uii` fast path.

### Null writer result treated as written

File: `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`

```js
const result = await recordCadenceEvent(cadenceEvent);
return {
  written: result?.written !== false,
  idemKey,
  reason: result?.reason || null,
  cadenceEvent,
  result,
};
```

Why this matters: `null` means "unknown/no write," but currently reports as written.

### Terminal drain scan can crash

File: `packages/shared-services/src/cxTerminalOutboxDrain.js`

```js
const pending = await outboxRepository.listPendingForDrain(limit);
for (const row of pending) {
  // ...
}
return { scanned: Array.isArray(pending) ? pending.length : 0, drained, failed };
```

Why this matters: the non-array guard runs after iteration, and scan rejection is not caught.

### Reservation reconciler can adopt then strand

File: `packages/shared-services/src/cxReservationReconcilerService.js`

```js
const adopted = await cxDialQueueRepository.transitionQueueItemState(
  row._id,
  ["claimed"],
  { "metadata.reservationReconciledAt": new Date() },
  { match: { "metadata.reservationSessionId": sessionId }, returnNew: true },
);

try {
  if (await terminalEvidence(row)) {
    await cxCadenceService.completeCxQueueItem({ queueItemId: row._id, ... });
  } else {
    await cxQueueReservationService.releaseReserved([row], "reservation-reconciler:session-gone");
  }
} catch (err) {
  logger.warn?.("reconcileDanglingReservations row failed", ...);
}
```

Why this matters: evidence failure after adoption leaves the row claimed; release also uses `row`, not the CAS-returned `adopted` document.

### Session start does not reset old arrays

File: `packages/shared-services/src/cxBulkLoadStateMachine.js`

```js
const state = {
  ...clonePlain(previous || {}),
  current: previous.current ? clonePlain(previous.current) : null,
  acceptedBuffer: arrayOf(previous.acceptedBuffer),
  completed: arrayOf(previous.completed),
  // ...
};

case "session.started": {
  state.status = "running";
  state.phase = CX_BULK_LOAD_PHASES.IDLE;
  state.startedAt = state.startedAt || nowIso;
  state.lastError = null;
  break;
}
```

Why this matters: dispatching `session.started` over a non-empty state preserves old current/buffer/completed data.

## Proposed Fixes

This is the patch shape I would ask for. Keep the changes small, atomic, and covered by tests in the same pass.

### Fix 1: import the RingCX login summarizer

File: `packages/shared-services/src/cxBulkLoadRuntime.js`

Proposed change:

```js
const { summarizeRingcxLoginPayload } = require("./dialService");
```

Do not duplicate parsing logic unless importing from `dialService` creates a cycle. If it does, extract only the summarizer and its tiny helpers into `ringcxLoginSummary.js`, then have both `dialService.js` and `cxBulkLoadRuntime.js` import from that.

Test:

- Add `tests/cx-bulk-load/cxBulkLoadRuntime.test.js`.
- Stub the RingCX client so `getAgentLogin()` returns an off-hook login payload.
- Start the runtime through the public `startCxBulkLoadSession()` path and assert no `ReferenceError`.

### Fix 2: wrap watcher/refill application in a per-session tail

File: `packages/shared-services/src/cxBulkLoadRuntimeService.js`

Proposed change:

- Keep `withSessionMutation()` for agent commands.
- Add a second narrow helper, such as `withSessionApplyTail(sessionId, work)`, or reuse `withSessionMutation()` for the apply phase only.
- The account watcher can still read once per account without blocking. The serialization should happen only when applying one session projection and possibly calling `maybeRefill()`.
- Do not put a global floor lock around the account watcher.

Test:

- Configure a fake `reservationService.reserveFromFamilyOrder()` that resolves slowly.
- Fire two `watchAccountActiveCalls()` calls in parallel for the same depleted session.
- Assert only one reserve call happens and the final buffer has one coherent refill, not doubled candidates.

### Fix 3: make reservation safety truly fail-closed

File: `packages/shared-services/src/cxQueueReservationService.js`

Proposed change:

```js
let active = true;
try {
  active = await queueItemRepository.existsForLead(leadId);
} catch (error) {
  logger.warn?.("cross-pool interlock check failed; releasing reserved row", {
    id: String(row?._id),
    caseId: row?.caseId,
    error: error.message,
  });
}
if (active) {
  await releaseReserved([row], "cross-pool-interlock:active-or-unknown");
} else {
  keep.push(row);
}
```

Also add a guard at the top of `releaseReserved()`:

```js
const reservationSessionId = row?.metadata?.reservationSessionId;
if (!row?._id || !reservationSessionId) {
  logger.warn?.("releaseReserved skipped row without reservationSessionId", { id: String(row?._id || "") });
  continue;
}
```

Test:

- `existsForLead()` throws and the row is released, not kept.
- `releaseReserved([{ _id: "x" }])` does not call `transitionQueueItemState()`.

### Fix 4: respect reserve policy in green-first and disabled modes

File: `packages/shared-services/src/cxReserveModeService.js`

Proposed change:

- Determine `enabled` once: `const enabled = Boolean(policy && policy.enabled !== false)`.
- In `green-first`, set fresh-day1 to `open("fresh-day1") > 0 ? deficit : 0`.
- Apply aged floor only when `enabled` is true.

Tests:

- `fresh.eligible=false`, `green-first`, `totalDeficit=20` -> fresh-day1 is 0.
- disabled policy plus `RC_CX_AGED_MIN_RESERVE_PER_CYCLE=5` -> all targets remain 0.

### Fix 5: make publisher acceptance match what was actually uploaded

File: `packages/shared-services/src/cxBulkLoadRingcxPublisher.js`

Proposed change:

- Build the payload from a filtered list of uploadable candidates, not only upload leads.
- Pass that uploadable candidate list into `toCandidatePublishPatch()`.
- Return dropped candidates as rejected with a reason such as `missing-phone-or-extern-id`.
- Require `campaignId` in `cancelBatchForSession()` before building the cancel body.

Test:

- Input `[validCandidate, { queueItemId: "q2" }]` produces `supplied: 1`, one accepted row, and one rejected/dropped row.
- `cancelBatchForSession()` with candidates but no campaign id rejects.
- `GENERAL_FAILURE` rejects every uploaded candidate.

### Fix 6: make terminal idem keys separate terminal facts from correction facts

File: `packages/shared-services/src/cxBulkLoadOutcomeAdapter.js`

Proposed change:

```js
if (u) {
  const base = qid ? `${qid}:${u}` : `${str(sessionId)}:uii:${u}`;
  return eventType && eventType !== "terminal" ? `${base}:${eventType}` : base;
}
```

Also change:

```js
written: Boolean(result && result.written !== false)
```

Tests:

- `makeOutcomeIdemKey({ sessionId:"s1", uii:"u1" })` differs from UII `u2`.
- Same `queueItemId + uii`, `eventType:"terminal"` and `eventType:"dnc"` produce two keys.
- `recordCadenceEvent()` returning `null` produces `written:false`.

### Fix 7: harden terminal outbox drain scan

File: `packages/shared-services/src/cxTerminalOutboxDrain.js`

Proposed change:

```js
let pending;
try {
  pending = await outboxRepository.listPendingForDrain(limit);
} catch (error) {
  logger.warn?.("cxTerminalOutboxDrain scan failed", { error: error.message });
  return { scanned: 0, drained: 0, failed: 0, scanError: true };
}
if (!Array.isArray(pending)) pending = [];
```

Test:

- scan throws -> no crash, returns scanError.
- scan returns null -> no crash, scanned 0.
- limit is forwarded.
- DNC payload is passed through unchanged.

### Fix 8: make reservation reconciler resolve adopted rows even when evidence fails

File: `packages/shared-services/src/cxReservationReconcilerService.js`

Proposed change:

- Call `terminalEvidence(adopted)` rather than `terminalEvidence(row)`.
- On `terminalEvidence` error, release `adopted` with reason `reservation-reconciler:evidence-error`, or mark a specific retryable state if we want another worker to decide. For the pilot, release is safer than permanent claimed.
- Pass `adopted` to `releaseReserved()`.

Test:

- `terminalEvidence()` throws after CAS adoption.
- Assert row is released or explicitly marked retryable.
- Assert complete path includes `queueOutcome:"reservation-reconciled-terminal"` and `actorEmail:"system:reservation-reconciler"`.
- Assert CAS `fromStates` is exactly `["claimed"]`.

### Fix 9: make `session.started` reset runtime state

File: `packages/shared-services/src/cxBulkLoadStateMachine.js`

Proposed change:

In the `session.started` branch, explicitly clear:

- `current`
- `acceptedBuffer`
- `completed`
- `lastOutcome`
- `reviewHoldUntil`
- `reviewHoldReason`
- `prevActiveExternIds`
- stale active-call trace fields if present

Test:

- Start with a dirty state containing current, accepted buffer, completed entries, and review hold.
- Dispatch `session.started`.
- Assert clean state.

## Responses To Less Crucial Or Inaccurate Claims

### `withSessionMutation` is only a Set

Response: inaccurate against current code.

Current code has a `sessionMutationTails` promise chain, so agent commands are serialized. The remaining issue is not "commands are unprotected." The issue is narrower: account-watcher apply/refill can still run outside that tail.

Action: fix watcher/refill serialization; do not rewrite the command serializer from scratch.

### `snapshotCandidates` coverage means the live refill path is tested

Response: the criticism is fair, but it points at documentation/coverage, not live behavior.

The live refill path now goes through `reservationService.reserveFromFamilyOrder()`. `snapshotCandidates()` is a read-only old/future hook. Its tests can mislead reviewers into thinking the live fill path is covered.

Action: remove `leadSource` from required runtime deps if unused, or label `snapshotCandidates` tests as non-live/future-hook. Add runtime-service tests for the reservation-to-buffer path.

### `normalizeQueueRow` dropping `queueFamily` is floor-critical

Response: overstated.

It is a real latent bug if `snapshotCandidates()` is reactivated. It is not currently the floor refill path. Current bulk fill injects queue family from the raw reserved row.

Action: add `queueFamily` and `rcxCampaignId` defensively, but do not let this distract from publisher/reservation/drain fixes.

### Most active-call watcher findings

Response: mostly valid coverage gaps, lower urgency.

The implementation already avoids phone-only promotion and throws on malformed active-call responses. The tests should pin those decisions, but the code shape is not obviously wrong.

Action: add targeted tests for queueItemId fallback, ambiguous matches, retryable null/unexpected responses, and release summary fields after pilot blockers are fixed.

### Terminal rectification findings

Response: valid but mostly safety-net coverage, not live-loop blockers.

The rectifier is the hourly backstop, not the one-second call loop. It should be hardened because it protects counts, but failures here do not explain the live UI/poller behavior.

Action: add tests for terminal metadata skip, terminal queue-state skip, duplicate insert, omitted `dryRun`, and insert throw. Keep it behind dry-run/write-mode discipline.

### "No test" items labeled high

Response: useful signal, noisy severity.

Many high labels mean "this branch is important and untested," not "this branch is currently broken." Treat them as a test checklist after the concrete implementation bugs are patched.

Action: group them into a coverage pass, starting with pure helpers and route-boundary tests.

### Dead or overturned finder claims

Response: no action unless a fresh code read proves regression.

Section 20.4 already lists claims the verifier overturned. Do not spend patch time on those now.

Action: leave them in the audit history, but do not include them in the pilot readiness patch.

## Bottom Line

The auditor is not a fool. The useful core is: route boundary untested, refill/concurrency still has a gap, reservation safety has two real fail-open edges, and terminal correction/idempotency needs to distinguish terminal writes from post-call correction writes.

The auditor is too loud in spots. Dead snapshot lead-source paths and many pure coverage holes should not distract from the pilot blockers above.
