# ATTIC — WO-4 dead code (scraps, moved one at a time)

Retired by: WO-4 (2026-07-02) — the dead-code bundle: each item verified zero live callers by
grep at move time, moved individually with the full gate run between moves.
Applied to: nothing — that's the point. Each section notes what the code WAS for.
Replaced by: nothing needed.
Revive: copy the section back; each notes its original file:lines at move time.

NOTE (stale bullet, NOT moved): the "always-'terminal' eventType param" bullet from the
original WO-4 scan is OBSOLETE — the WO-31 correction lane now uses eventType
"review-correction", so the param is load-bearing. Left alive on purpose.

## packages/shared-services/src/cxBulkLoadRuntime.js (lines 457-463 at move time) — normalizeBulkTerminalOutcome — outcome-string normalizer, zero callers (verified twice: grep 2026-07-01 + 07-02)

```js
function normalizeBulkTerminalOutcome(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

```

## packages/shared-services/src/cxQueueReservationService.js (lines 220-220 at move time) — renewReserved barrel export

```js
    renewReserved,
```

## packages/shared-services/src/cxQueueReservationService.js (lines 171-198 at move time) — renewReserved — lease heartbeat, service half; the code's own comment admits no caller (reaper ownership-exclusion is the real mechanism)

```js
  // renewReserved (M2 §3.2) — heartbeat the lease for rows still held in the rail's buffer.
  // Delegates to the repo guarded CAS, grouping ids by reservationSessionId so a stray
  // foreign-session row can never be renewed under the wrong owner. Returns the ids actually
  // renewed; the caller drops the rest (serving / reaped / re-owned) from its heartbeat set.
  //
  // UNWIRED (#13): no production caller invokes this — the lease is single-shot and reserved rows
  // are reaper-exempt by ownership (cxDialQueueRepository buildExpiredClaimRequeueQuery), so no
  // heartbeat is needed for safety. Kept as M2 scaffolding + tested in isolation. If renewal is ever
  // wanted, wire it from the BULK watch tick only (cxBulkLoadRuntimeService) — never here, since this
  // is the shared instance the slow-lane rail also uses.
  async function renewReserved(rows = [], claimMinutes) {
    if (typeof cxDialQueueRepository.renewClaim !== "function") {
      throw new Error("cxQueueReservationService.renewReserved requires cxDialQueueRepository.renewClaim");
    }
    const idsBySession = new Map();
    for (const row of rows) {
      const sessionId = row?.metadata?.reservationSessionId;
      if (!sessionId || !row?._id) continue;
      if (!idsBySession.has(sessionId)) idsBySession.set(sessionId, []);
      idsBySession.get(sessionId).push(row._id);
    }
    const renewed = [];
    for (const [sessionId, ids] of idsBySession) {
      const got = await cxDialQueueRepository.renewClaim(ids, claimMinutes, sessionId);
      renewed.push(...got);
    }
    return renewed;
  }
```

## packages/shared-repositories/src/cxDialQueueRepository.js (lines 760-760 at move time) — renewClaim repo export

```js
  renewClaim,
```

## packages/shared-repositories/src/cxDialQueueRepository.js (lines 449-468 at move time) — renewClaim — lease heartbeat, repo CAS half (M2 §3.2), unwired

```js
// renewClaim (M2 §3.2) — ONE guarded CAS per row. Re-confirms {state:'claimed',
// reservationSessionId} at write time, so it silently no-ops once the row goes 'serving'
// or another owner holds it. This is a LIVENESS heartbeat, NOT the safety mechanism (that
// is the reaper ownership-exclusion above). Returns the ids actually renewed; the caller
// drops the rest from its heartbeat set.
async function renewClaim(ids = [], claimMinutes = 5, sessionId = null) {
  const now = new Date();
  const minutes = Math.max(Number(claimMinutes) || 5, 1);
  const until = new Date(now.getTime() + minutes * 60 * 1000);
  const renewed = [];
  for (const id of ids) {
    const updated = await CxDialQueue.findOneAndUpdate(
      { _id: id, state: "claimed", "metadata.reservationSessionId": sessionId },
      { $set: { claimUntil: until, "metadata.reservationExpiresAt": until } },
      { new: true },
    );
    if (updated) renewed.push(updated._id);
  }
  return renewed;
}
```

## tests/cx-bulk-load/cxQueueReservationService.test.js (lines 293-339 at move time) — renewReserved dedicated tests (4) — die with the feature

```js
test("renewReserved groups ids by reservationSessionId and delegates one CAS batch per owner", async () => {
  const repo = fakeRepo();
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  const renewed = await svc.renewReserved(
    [
      { _id: "a", metadata: { reservationSessionId: "sess-1" } },
      { _id: "b", metadata: { reservationSessionId: "sess-1" } },
      { _id: "c", metadata: { reservationSessionId: "sess-2" } },
    ],
    10,
  );
  assert.equal(repo.calls.renew.length, 2); // one batch per session
  const s1 = repo.calls.renew.find((c) => c.sessionId === "sess-1");
  assert.deepEqual(s1.ids, ["a", "b"]);
  assert.equal(s1.claimMinutes, 10);
  assert.deepEqual(renewed.sort(), ["a", "b", "c"]); // union of renewed ids
});

test("renewReserved skips rows missing an id or a reservationSessionId", async () => {
  const repo = fakeRepo();
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  await svc.renewReserved([
    { _id: "a", metadata: { reservationSessionId: "sess-1" } },
    { _id: "b", metadata: {} }, // no sessionId -> skipped
    { metadata: { reservationSessionId: "sess-1" } }, // no _id -> skipped
  ]);
  assert.equal(repo.calls.renew.length, 1);
  assert.deepEqual(repo.calls.renew[0].ids, ["a"]);
});

test("renewReserved returns only the ids the CAS actually renewed (serving/reaped rows drop out)", async () => {
  // sess-1 row 'b' lost its lease (serving/reaped) -> CAS returns only 'a'.
  const repo = fakeRepo({ renewReturns: () => ["a"] });
  const svc = createCxQueueReservationService({ cxDialQueueRepository: repo });
  const renewed = await svc.renewReserved([
    { _id: "a", metadata: { reservationSessionId: "sess-1" } },
    { _id: "b", metadata: { reservationSessionId: "sess-1" } },
  ]);
  assert.deepEqual(renewed, ["a"]);
});

test("renewReserved requires cxDialQueueRepository.renewClaim", async () => {
  const svc = createCxQueueReservationService({
    cxDialQueueRepository: { reserveReadyRows: async () => ({ reserved: [], missing: {} }) },
  });
  await assert.rejects(() => svc.renewReserved([{ _id: "a", metadata: { reservationSessionId: "s" } }]), /renewClaim/);
});
```

## tests/cx-bulk-load/cxQueueReservationService.test.js (lines 26-26 at move time) — test fake renewClaim entry

```js
    renewClaim: async (ids, claimMinutes, sessionId) => {
```

## packages/shared-repositories/src/cxDialQueueRepository.js (lines 735-735 at move time) — findQueueItemsByRingcxExternIds export

```js
  findQueueItemsByRingcxExternIds,
```

## packages/shared-repositories/src/cxDialQueueRepository.js (lines 560-603 at move time) — findQueueItemsByRingcxExternIds — extern-id row lookup, zero refs anywhere (not even tests)

```js
    cursor.limit(Math.min(Number(input.limit) || 1000, 5000));
  }
  return cursor.lean();
}

async function findQueueItemsByRingcxExternIds(externIds = [], filters = {}) {
  const ids = Array.from(
    new Set(
      (Array.isArray(externIds) ? externIds : [externIds])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
  if (!ids.length) return [];

  const query = {
    $or: [
      { "metadata.rcxVisibilityExternId": { $in: ids } },
      { "metadata.lastRingcxPublishedExternId": { $in: ids } },
      { "metadata.lastDialExecutionRingcxPublish.externId": { $in: ids } },
    ],
  };
  if (filters.domain) query.domain = normalizeDomain(filters.domain);
  if (Array.isArray(filters.states) && filters.states.length > 0) {
    query.state = { $in: filters.states.map((value) => String(value || "").trim()).filter(Boolean) };
  }
  const campaignId = String(filters.campaignId || "").trim();
  if (campaignId) {
    query.$and = [
      ...(Array.isArray(query.$and) ? query.$and : []),
      {
        $or: [
          { rcxCampaignId: campaignId },
          { "metadata.rcxCampaignId": campaignId },
          { "metadata.lastRingcxPublishedCampaignId": campaignId },
        ],
      },
    ];
  }

  return CxDialQueue.find(query)
    .limit(Math.min(ids.length * 3, 100))
    .lean();
}
```

## packages/shared-repositories/src/cxBulkLoadSessionRepository.js (lines 172-172 at move time) — killActiveBulkLoadSessionsForAgent export

```js
  killActiveBulkLoadSessionsForAgent,
```

## packages/shared-repositories/src/cxBulkLoadSessionRepository.js (lines 167-167 at move time) — appendBulkLoadSessionEvent export

```js
  appendBulkLoadSessionEvent,
```

## packages/shared-repositories/src/cxBulkLoadSessionRepository.js (lines 143-164 at move time) — killActiveBulkLoadSessionsForAgent — the second worse kill (bypasses buffer release + RC cancel); zero callers

```js
async function killActiveBulkLoadSessionsForAgent(input = {}) {
  const agentEmail = normalizeEmail(input.agentEmail);
  const agentExtensionId = normalizeExternalId(input.agentExtensionId);
  const reason = String(input.reason || "replaced").trim() || "replaced";
  const query = { status: { $in: ACTIVE_STATUSES } };
  if (agentEmail) {
    query.agentEmail = agentEmail;
  } else if (agentExtensionId) {
    query.agentExtensionId = agentExtensionId;
  } else {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  return CxBulkLoadSession.updateMany(query, {
    $set: {
      status: "killed",
      phase: "released",
      current: null,
      killedAt: new Date(),
      lastError: reason,
    },
  });
}
```

## packages/shared-repositories/src/cxBulkLoadSessionRepository.js (lines 128-141 at move time) — appendBulkLoadSessionEvent — the events append-log substrate, zero callers

```js
async function appendBulkLoadSessionEvent(sessionId, event = {}, options = {}) {
  const session = await findBulkLoadSessionById(sessionId);
  if (!session) return null;
  const now = options.now instanceof Date ? options.now : new Date();
  const events = trimEvents([
    ...(Array.isArray(session.events) ? session.events : []),
    {
      type: event.type || "event",
      at: now.toISOString(),
      ...event,
    },
  ]);
  return updateBulkLoadSession(sessionId, { events, updatedAt: now }, options);
}
```

---
## MOVE LOG (one-at-a-time, gate between each)
2026-07-02: moved 5 items, all gates green, final ledger 280/280 (284 - 4 lease-heartbeat tests):
1. normalizeBulkTerminalOutcome (runtime) — 7 lines
2. renewReserved + renewClaim + 4 dedicated tests + fake entry (reservation/repo/tests) — ~100 lines
3. findQueueItemsByRingcxExternIds (repo) — ~45 lines (note: section's first 4 lines are the
   previous function's tail, restored to source after an over-cut — surplus here, harmless)
4. appendBulkLoadSessionEvent (session repo) — 14 lines
5. killActiveBulkLoadSessionsForAgent (session repo) — 22 lines

NEXT ITEM (analyzed, NOT moved — stop point): watchCxBulkLoadSession. Bigger than the scan
said: runtime wrapper (cxBulkLoadRuntime.js:~1250 + export), SERVICE implementation
(cxBulkLoadRuntimeService.js:~830 + export), barrel (index.js:301+1101), and a read-only
invariant test (cxBulkLoadRuntimeService.test.js:~791) whose delta must be declared. Then:
MATCH_ORDER export + the agentLifecycleAdapter pass-through (runtimeService passes it at the
runCxAccountActiveCallWatchOnce delegation ~:1086 — remove BOTH ends), previewCxTerminal-
Rectification, fallbackRuntime + buildCxDialRuntimeMetadata (cxDialRuntimeModeService — touch
NOTHING else in that file), dead client knobs (waitForRestore, input.hangup, useCxBulkLoadStart
if zero imports), always-null releaseStatus/releaseAttempts.
