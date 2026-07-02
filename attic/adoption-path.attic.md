# ATTIC — Adoption Path (extern-matched active calls adopted into a bulk session)

Retired by: WO-2 (2026-07-02) — the fork decision: a current call exists ONLY by RingCX proof
against a row this session reserved (`metadata.reservationSessionId` CAS). Adopting a `cxbl`
active call whose row lost its reservation metadata made the system less honest and hid
loader/session data bugs; production had already hard-coded `resolveExternalCandidates: null`
with a comment banning adoption.

Applied to: `markAdoptedCandidateServing` (a CAS that accepted `queued/ready/claimed/serving`
rows and back-stamped `reservationSessionId`), the account watcher's external-candidate
pool/resolver/reproject plumbing and adopted-serving branch, and the
`resolveExternalCandidates` dependency pass-through (runtime → runtime service → watcher).

Lived at (at move time): `packages/shared-services/src/cxBulkLoadRuntime.js` (the
markAdoptedCandidateServing block + the hard-coded null wiring),
`packages/shared-services/src/cxAccountActiveCallWatcherService.js` (external-candidate
plumbing + adopted-serving branch), `packages/shared-services/src/cxBulkLoadRuntimeService.js`
(dependency pass-through).

Replaced by: strict reserved-row serving promotion only (`markCandidateServing` with the
reservationSessionId match), plus `cx.alpha.watch.serving_stamp.missed` logging when a `cxbl`
active call has no owning reservation — missing metadata is a loader/session bug to fix, not a
runtime adoption opportunity. Field-proven 2026-07-02: the app refused to adopt a live
non-bulk `parallel:WYNN` call (the "Jennie" case).

Revive (don't — this was the twice-banned behavior; but if the design ever truly reverses):
restore the blocks below, rewire `resolveExternalCandidates`, and consciously remove the
negative pin "WO-2 injected external candidates are ignored by the account watcher"
(tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js), which plants a throwing trap on
`markAdoptedCandidateServing` and asserts the resolver is never called.

## packages/shared-services/src/cxBulkLoadRuntimeService.js (lines 1241-1241 at move time)

```js
      // WO-2 pending delete: resolveExternalCandidates: input.resolveExternalCandidates || resolveExternalCandidates,
```

## packages/shared-services/src/cxBulkLoadRuntimeService.js (lines 348-348 at move time)

```js
    // WO-2 pending delete: resolveExternalCandidates = null,
```

## packages/shared-services/src/cxBulkLoadRuntime.js (lines 1070-1070 at move time)

```js
    // WO-2 pending delete: resolveExternalCandidates: null,
```

## packages/shared-services/src/cxBulkLoadRuntime.js (lines 972-1018 at move time)

```js
    /*
    WO-2 pending delete: adopted active-call serving is disabled. Bulk now only
    promotes rows already reserved by this session through markCandidateServing.
    async markAdoptedCandidateServing({ session = {}, candidate = {}, uii = null, activeCallSummary = null, matchReasons = [] } = {}) {
      const queueItemId = normalizeExternalId(candidate.queueItemId || candidate.id || candidate._id);
      const externId = normalizeExternalId(candidate.externId || candidate.ringcx?.externId);
      if (!queueItemId || !externId) return null;
      const now = new Date();
      return cxDialQueueRepository.transitionQueueItemState(
        queueItemId,
        ["queued", "ready", "claimed", "serving"],
        {
          state: "serving",
          claimUntil: null,
          lastClaimedAt: now,
          "assignment.extensionId": session.agentExtensionId || null,
          "assignment.agentName": session.agentEmail || null,
          "assignment.assignedAt": now,
          "assignment.queueFamilySnapshot": candidate.queueFamily || null,
          "metadata.reservationSessionId": session.sessionId || null,
          "metadata.bulkLoadSessionId": session.sessionId || null,
          "metadata.bulkLoadActiveAt": now,
          "metadata.bulkLoadRuntime": "bulk_load",
          "metadata.servingAt": now,
          "metadata.lastDialExecutionUii": uii || null,
          "metadata.lastQueueAttemptUii": uii || null,
          "metadata.lastDialExecutionSource": "cx-bulk-load-adopted-active",
          "metadata.lastDialIntentStatus": "active",
          "metadata.lastQueueAttemptHeldForDisposition": true,
          "metadata.wrapUpRequired": true,
          "metadata.wrapUpReason": "bulk-load-active-call",
          "metadata.lastRingcxActiveCall": activeCallSummary || null,
          "metadata.lastRingcxMatchReasons": Array.isArray(matchReasons) ? matchReasons : [],
        },
        {
          match: {
            domain: normalizeDomain(session.domain || candidate.domain),
            $or: [
              { "metadata.rcxVisibilityExternId": externId },
              { "metadata.lastRingcxPublishedExternId": externId },
              { "metadata.lastDialExecutionRingcxPublish.externId": externId },
            ],
          },
        },
      );
    },
    */
```

## packages/shared-services/src/cxAccountActiveCallWatcherService.js (lines 735-740 at move time)

```js
      // WO-2 pending delete: adopted active-call candidates are not a promotion path.
      // const adopted = promotion.candidate?.adoption?.source === "ringcx-active-external-id";
      // const servingMethod =
      //   adopted && typeof input.queueStateAdapter.markAdoptedCandidateServing === "function"
      //     ? "markAdoptedCandidateServing"
      //     : "markCandidateServing";
```

## packages/shared-services/src/cxAccountActiveCallWatcherService.js (lines 575-575 at move time)

```js
    // WO-2 pending delete: resolveExternalCandidates: input.resolveExternalCandidates,
```

## packages/shared-services/src/cxAccountActiveCallWatcherService.js (lines 484-492 at move time)

```js
      // WO-2 pending delete: external adoption candidate resolution is disabled.
      // let externalCandidates = [];
      // if (typeof input.resolveExternalCandidates === "function") {
      //   externalCandidates = await input.resolveExternalCandidates({
      //     session,
      //     activeCalls,
      //     now: at,
      //   });
      // }
```

## packages/shared-services/src/cxAccountActiveCallWatcherService.js (lines 200-201 at move time)

```js
  // WO-2 pending delete: external adoption candidates are ignored.
  // const externalCandidates = Array.isArray(options.externalCandidates) ? options.externalCandidates : [];
```

## packages/shared-services/src/cxAccountActiveCallWatcherService.js (lines 119-121 at move time)

```js
  // WO-2 pending delete: the external adoption pool is disabled. Bulk only
  // matches calls already present in acceptedBuffer/current.
  // if (Array.isArray(extraCandidates)) pool.push(...extraCandidates);
```
