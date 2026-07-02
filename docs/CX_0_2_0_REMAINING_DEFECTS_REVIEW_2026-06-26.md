# CX 0.2.0 — Remaining Defects, Reviewer Dossier (2026-06-26)

**Purpose:** a second human reviewer signs off on each fix BEFORE any code changes land in this live
lead-dialing + DNC-compliance rail. Every defect below was **re-verified against the current files** (prior-sweep
line numbers were treated as stale and re-found) with the **actual code quoted**, so each claim is checkable
without spelunking.

**Context.** The two prior agents’ §20.8 list (8 blockers) is fixed + verified. A fresh adversarial sweep then
found these. **Two are already fixed** (not in this doc): #3 off-hook gate (fail-closed on `summary.ready===false`,
tested) and #9 PII leak (`sanitizeActiveCallSummary` strips `ani/dnis/leadPhone`, tested). The **11 defects
below are OPEN and UNTOUCHED**, pending your review. Cross-ref: audit guide §20.10 / §20.10.1.

| # | Sev | Status | One-line |
|---|---|---|---|
| 1 | blocker | OPEN | Contact-blocked reserved row leaks a permanent claimed ghost (enforced eligibility neither cancels nor releases it) |
| 2 | blocker | OPEN | Racy per-agent start: mutation lock keyed on freshly-minted sessionId, retire-then-create non-atomic, no DB agent-uniqueness backstop |
| 4 | blocker | OPEN | Review-outcome vs outbox-drain TOCTOU: agent DNC reported applied but silently lost |
| 5 | major | OPEN | confirmRingcxUiiReleased: transient poll errors after an early sighting are masked as a confirmed "still-active" result (stale snapshot), never re-verified |
| 6 | major | OPEN | Lost release across a __v-miss: watcher diff anchors persist only via the CAS write, dropped on version-miss with no retry/re-read |
| 7 | major | OPEN | Departing-call terminal write dropped when the incoming candidate's serving-ownership CAS misses |
| 8 | major | OPEN | Outbox-outage double-fault: dispositioned call left uncounted with current stuck at terminal.started |
| 10 | major | OPEN | Watcher serving-stamp CAS fires before any latest-aware staleness guard; orphan serving/wrapUpRequired stamp on version-miss |
| 11 | major | OPEN | Appointment-wrap commits Logics appointment outside the session lock; a concurrent watcher tick clearing state.current makes the terminal no-op (missing-current) and the wrap returns ok:false without resuming dialing — appointment already committed |
| 12 | major | OPEN | Reconciler evidence helper hand-rolls only the UII-bearing idemKey shape, so a no-UII terminal outbox row is missed and the reconciler RE-DIALS a terminally dispositioned lead |
| 13 | minor | OPEN | renewReserved is dead code: reservation lease stamped once at claim time and never renewed (no production callers) |

---

## #1 — Contact-blocked reserved row leaks a permanent claimed ghost (enforced eligibility neither cancels nor releases it)

**Severity:** blocker · **Status (re-verified):** OPEN

**Location:** cxBulkLoadRuntimeService.js:457-465 (fillBuffer eligibility branch) + :354-367 (dropReservedCandidate); cxDialQueueRepository.js:463-497 (cancelActiveQueueItems guard at :469-480); contactEligibilityService.js:151-162 (stopCaseContact → cancelActiveQueueItems at :161); test cxBulkLoadRuntimeService.test.js:215-239 (locking assert at :238). Wiring: cxBulkLoadRuntime.js:1105-1120.

### Mechanism
CONFIRMED. On an enforced contact-block the reserved row is left state:'claimed' with metadata.reservationSessionId still set — neither cancelled nor released — and the reaper is hard-excluded from session-held rows, so it is a permanent ghost freeable only by the session-kill path.

Chain, end to end against current code:
1. fillBuffer (:457-463) checks eligibility; on a block it calls dropReservedCandidate with releaseReserved: contactEligibility.enforced !== true. The live adapter (cxBulkLoadRuntime.js:1117) returns enforced:true whenever enforcement ran, so the branch passes releaseReserved:false.
2. dropReservedCandidate (:354-367) only emits the reducer event buffer.publish_failed and, because options.releaseReserved===false, SKIPS reservationService.releaseReserved (:363). The reducer (cxBulkLoadStateMachine.js:173-179) just drops the candidate from acceptedBuffer + bumps failedPublishCount/lastError; it never touches the Mongo row's state. So the row stays state:'claimed', reservationSessionId set.
3. The enforcement that was supposed to clean the row up is stopCaseContact (contactEligibilityService.js:151), which calls cxDialQueueRepository.cancelActiveQueueItems(domain, caseId, reason) at :161 with NO includeReserved and no options arg.
4. cancelActiveQueueItems (:463) defaults options={}, so options.includeReserved !== true is true and it ANDs in the $or that requires metadata.reservationSessionId to be absent/null/'' (:469-480). The row this session just reserved carries reservationSessionId (written by reserveReadyRows at :382), so it does NOT match the cancel query — it is left state:'claimed'.
5. The expired-claim reaper query buildExpiredClaimRequeueQuery (:122-158) ANDs in the same reservationSessionId-absent guard (:141-147 — 'a session-held reserved row is invisible to the global reaper, regardless of lease age'). So the leaked claimed row is never reaped.
Net: claimed + reservationSessionId set + not cancelled + not released + reaper-excluded ⇒ permanent ghost. The only freeing path is killCxBulkLoadSession (:957-1013), which releases reserved rows on session teardown — confirming the leak persists for the whole session lifetime.

NOTE the prior-sweep's own warning is correct: releaseReserved:true is the WRONG fix. Release transitions the row back to state:'ready' (cxQueueReservationService.js:117-124), which re-arms a DNC/blocked lead for the next reserve. The right terminal state for a contact-blocked lead is 'cancelled', not 'ready'.

### Current code
```js
// cxBulkLoadRuntimeService.js:457-465  (fillBuffer enforced-block branch)
      const contactEligibility = await checkReservedContactEligibility(row, state);
      if (!contactEligibility.ok) {
        const reason = contactEligibility.reason || "contact-blocked";
        next = await dropReservedCandidate(next, row, reason, {
          releaseReason: `bulk-contact-blocked:${reason}`,
          releaseReserved: contactEligibility.enforced !== true,
        });
        continue;
      }

// cxBulkLoadRuntimeService.js:354-367  (dropReservedCandidate — release is skipped when releaseReserved:false)
  async function dropReservedCandidate(current, row, reason, options = {}) {
    const next = reduce(current, { type: "buffer.publish_failed", candidate: { queueItemId: row._id }, reason }, now());
    traceBulkFlow("fill.candidate_dropped", next, {
      queueItemId: str(row._id),
      caseId: row.caseId || null,
      queueFamily: row.queueFamily || null,
      reason,
      releaseReserved: options.releaseReserved !== false,
    });
    if (options.releaseReserved !== false) {
      await reservationService.releaseReserved([row], options.releaseReason || reason);
    }
    return next;
  }

// cxDialQueueRepository.js:463-481  (cancelActiveQueueItems EXCLUDES reserved rows unless includeReserved===true)
async function cancelActiveQueueItems(domain, caseId, reason = null, options = {}) {
  const query = {
    domain: normalizeDomain(domain),
    caseId: Number(caseId),
    state: { $in: ["queued", "ready", "claimed", "serving", "paused"] },
  };
  if (options.includeReserved !== true) {
    query.$and = [
      ...(Array.isArray(query.$and) ? query.$and : []),
      {
        $or: [
          { "metadata.reservationSessionId": { $exists: false } },
          { "metadata.reservationSessionId": null },
          { "metadata.reservationSessionId": "" },
        ],
      },
    ];
  }
  const result = await CxDialQueue.updateMany(

// contactEligibilityService.js:157-162  (stopCaseContact calls cancel with NO includeReserved)
  const [leadCadence, cxQueue] = await Promise.all([
    leadCadenceRepository.cancelPendingActions(normalizedDomain, normalizedCaseId, {
      currentStage: options.currentStage || "contact-blocked",
    }),
    cxDialQueueRepository.cancelActiveQueueItems(normalizedDomain, normalizedCaseId, reason),
  ]);

// tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js:236-238  (LOCKS: enforced-blocked rows must NOT be re-released to ready)
  assert.equal(snap.stats.failedPublishCount, 1);
  assert.equal(snap.lastError, "blocked-stage");
  assert.deepEqual(reservation.released, [], "adapter-enforced blocked rows are not re-released to ready");
```

### Proposed fix
Make the enforced-block branch drive the reserved row to a terminal 'cancelled' state (it must leave the live set forever — it is a DNC/blocked lead), NOT 'ready' and NOT 'claimed'. Do this inside the bulk rail so no shared default changes.

Preferred (minimal, self-contained): add a guarded CAS to the reservation service and call it from the enforced branch.
1. cxQueueReservationService.js — add cancelReserved(rows, reason) modeled on releaseReserved but with target state 'cancelled' and the same reservationSessionId match guard, e.g.:
   await cxDialQueueRepository.transitionQueueItemState(row._id, ["claimed","ready"], { state:"cancelled", claimUntil:null, "metadata.reservationSessionId": null, "metadata.cancelReason": reason, "metadata.cancelledAt": new Date() }, { match: { "metadata.reservationSessionId": reservationSessionId } });
   Clearing reservationSessionId here is intentional: once cancelled the row is terminal, and clearing it keeps kill-path/listReservedForSession from re-touching it.
2. cxBulkLoadRuntimeService.js:457-465 — replace the dropReservedCandidate({ releaseReserved: enforced!==true }) call so that on enforced===true it drops from the buffer AND cancels the row (await reservationService.cancelReserved([row], `bulk-contact-blocked:${reason}`)) instead of leaving it claimed; on enforced!==true keep releaseReserved (back to ready) as today. The buffer-drop reducer event (buffer.publish_failed) is unchanged, so failedPublishCount/lastError assertions still hold, and reservation.released stays [] (cancel is a different sink than release), so test :238 stays green.

Acceptable alternative WITHOUT touching the shared service: keep using the eligibility adapter's own enforcement but route the bulk-rail enforcement through cancelActiveQueueItems(..., { includeReserved: true }) scoped to caseId+reservationSessionId. This is messier (caseId-cancel could catch a sibling row) and still leaves dropReservedCandidate's claimed-row leak if enforcement no-ops, so the reservation-service cancelReserved path is cleaner and id-precise.

Add a regression test: enforced block ⇒ the reserved row ends state:'cancelled' (assert via the reservation fake), reservation.released stays [], and the row is NOT visible to a subsequent reserve.

### Blast radius / caveats
SHARED-SERVICE BLAST RADIUS: contactEligibilityService.stopCaseContact (and through it cxDialQueueRepository.cancelActiveQueueItems) is shared with the NON-BULK legacy CX cadence rail — cxCadenceService.js:2621 calls stopCaseContact with sourceService:"ringcentral-cx" after a cadence call, and resolveCaseContactEligibility:223 invokes it on the enforceStop path. The includeReserved-exclusion in cancelActiveQueueItems (:469-480) is DELIBERATE: it stops one rail's contact-guard from cancelling a row another session has reserved (ownership safety). Therefore DO NOT change the default of cancelActiveQueueItems or stopCaseContact — fix the bulk rail's own enforced branch (a reservation-service cancelReserved CAS keyed to THIS session's reservationSessionId is ownership-safe; it only ever touches rows this session owns).

TEST THAT LOCKS BEHAVIOR BY INTENT: cxBulkLoadRuntimeService.test.js:238 — assert.deepEqual(reservation.released, [], "adapter-enforced blocked rows are not re-released to ready"). The naive fix (flip releaseReserved to true) WOULD satisfy 'don't leak' but breaks this test AND is functionally wrong (returns a DNC lead to state:'ready' for re-dial). The proposed cancelReserved fix keeps reservation.released===[] (cancel ≠ release) so :238 stays green; verify the test fake distinguishes a cancel sink from the release sink (it currently only records .released).

Also: kill path (killCxBulkLoadSession :957-1013) already releases reserved rows on teardown, so the leak is bounded to the session's lifetime — real-world impact is a claimed row that blocks that lead from any other session/rail for up to the whole bulk session, and skews live-slot accounting, until the agent's session is killed/replaced.

### Test to lock it
node --test tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js (existing: "reserved rows blocked by contact eligibility are not published to RingCX" at :215 must stay green — failedPublishCount===1, lastError==="blocked-stage", reservation.released===[]). Add a new case asserting the enforced-blocked row reaches a terminal cancelled sink (not claimed, not ready) and is not re-offered on the next reserve. Full gate: node --test tests/cx-bulk-load/*.test.js.

---

## #2 — Racy per-agent start: mutation lock keyed on freshly-minted sessionId, retire-then-create non-atomic, no DB agent-uniqueness backstop

**Severity:** blocker · **Status (re-verified):** OPEN

**Location:** C:/code/tagcontactbridgeparalell/packages/shared-services/src/cxBulkLoadRuntimeService.js:569-622 (start body, lock key line 570-571, retire loop 574-580, create 582-599); C:/code/tagcontactbridgeparalell/packages/shared-models/src/CxBulkLoadSession.js:7,31-34,56-58 (indexes); C:/code/tagcontactbridgeparalell/packages/shared-repositories/src/cxBulkLoadSessionRepository.js:34-46 (plain create)

### Mechanism
CONFIRMED. startCxBulkLoadSession mints sessionId = input.sessionId || newSessionId() and then immediately calls withSessionMutation(sessionId, ...). The serializer key IS that just-minted sessionId. Two concurrent /start requests for the SAME agent that arrive WITHOUT input.sessionId (the normal UI start path) mint two DIFFERENT ids (newSessionId() defaults to `cxbl-${Date.now()}` per deps; the route lets the server mint), so they take TWO DIFFERENT entries in sessionOperationTails -> they do NOT serialize against each other and run fully concurrently. Inside each run, the retire-then-create is non-atomic: each calls findActiveBulkLoadSessionsForAgent (repo find), sees the OTHER has not created its row yet (or sees only the pre-existing one), kills what it found, then calls repo.createBulkLoadSession. createBulkLoadSession (repository line 34-46) is a plain CxBulkLoadSession.create with no agent-scoped guard. The ONLY unique index on the schema is sessionId (CxBulkLoadSession.js:7 `unique: true`); the agent fields are plain non-unique indexes (agentEmail line 31 `index: true`; agentExtensionId line 32; compound agentEmail+status+updatedAt line 56 and agentExtensionId+status+updatedAt line 57 are plain `.index(...)`, NOT `{ unique: true }` and NOT partial-on-status:running). Because the two sessionIds differ, the sessionId unique index never collides, both create() succeed, and the agent ends with TWO status:"running" sessions. Each then preloads/reserves leads and publishes to RingCX independently -> double-reserve of pool rows and double-dial into one agent's RingCX buffer. The retire loop (line 577-580) also skips existing.sessionId === sessionId, so neither run retires the other's brand-new row even if it became visible. Net: the "one live session per agent" invariant (comment line 572) is not enforced under the no-input-sessionId concurrent-start race.

### Current code
```js
// cxBulkLoadRuntimeService.js:569-599
  async function startCxBulkLoadSession(input = {}) {
    const sessionId = input.sessionId || newSessionId();
    return withSessionMutation(sessionId, async () => {
    // One live session per agent: retire any prior one through the full runtime kill path,
    // not the repository shortcut, so RC buffered leads and reserved rows are released.
    const activeSessions = typeof repo.findActiveBulkLoadSessionsForAgent === "function"
      ? await repo.findActiveBulkLoadSessionsForAgent({ agentEmail: input.agentEmail, agentExtensionId: input.agentExtensionId })
      : [await repo.findActiveBulkLoadSessionForAgent({ agentEmail: input.agentEmail, agentExtensionId: input.agentExtensionId })].filter(Boolean);
    for (const existing of activeSessions) {
      if (!existing || existing.sessionId === sessionId) continue;
      await killCxBulkLoadSession({ sessionId: existing.sessionId, reason: "replaced-by-new-session" });
    }

    const created = await repo.createBulkLoadSession({
      sessionId,
      agentEmail: input.agentEmail,
      agentExtensionId: input.agentExtensionId,
      ...

// CxBulkLoadSession.js:7,31-34 (only sessionId is unique; agent fields are plain indexes)
    sessionId: { type: String, required: true, unique: true, index: true },
    ...
    agentEmail: { type: String, required: true, index: true },
    agentExtensionId: { type: String, default: null, index: true },
    cxAgentId: { type: String, default: null, index: true },
    domain: { type: String, default: "TAG", index: true },

// CxBulkLoadSession.js:56-58 (compound indexes are NOT unique)
cxBulkLoadSessionSchema.index({ agentEmail: 1, status: 1, updatedAt: -1 });
cxBulkLoadSessionSchema.index({ agentExtensionId: 1, status: 1, updatedAt: -1 });
cxBulkLoadSessionSchema.index({ domain: 1, status: 1, updatedAt: -1 });

// cxBulkLoadSessionRepository.js:34-46 (plain create, no agent-scoped guard)
async function createBulkLoadSession(input = {}) {
  const session = await CxBulkLoadSession.create({
    ...input,
    agentEmail: normalizeEmail(input.agentEmail),
    ...
  });
  return asPlain(session);
}
```

### Proposed fix
Two layers; ship both. (1) Key the mutation serializer on a STABLE per-agent identity, not the new sessionId, so concurrent starts for one agent run one-at-a-time. In startCxBulkLoadSession, compute an agent key (e.g. `agentKey = normalizeEmail(input.agentEmail) || normalizeExternalId(input.agentExtensionId)`, reusing the repo normalizers) and wrap with withSessionMutation(agentKey, ...) (or a dedicated withAgentMutation that shares sessionOperationTails). The second start then waits behind the first, sees the now-running session via findActiveBulkLoadSessionsForAgent, and retires it through the kill path as intended. Keep the existing sessionId-keyed locking for all OTHER mutators (disposition/skip/kill/manual) unchanged. (2) Add a true DB backstop so a multi-process / multi-pod race (which an in-memory Map cannot serialize) still cannot create two running sessions per agent: a partial unique index, e.g. cxBulkLoadSessionSchema.index({ agentEmail: 1 }, { unique: true, partialFilterExpression: { status: "running" } }) (and/or the same on agentExtensionId), then handle the E11000 duplicate-key error from createBulkLoadSession by re-finding and retiring the winner before retrying. Because this is a live partial-unique index on existing data, it must be built carefully (it will fail to build if duplicate running rows already exist — sweep/kill duplicates first).

### Blast radius / caveats
BLAST RADIUS: (a) The in-memory withSessionMutation serializer only protects against concurrency WITHIN one Node process. This rail runs as part of a multi-process monorepo (5 processes per project memory); two starts hitting different pods are not serialized by the Map at all — only the DB partial-unique index (fix layer 2) closes that, so do not ship only layer 1. (b) The partial-unique index is on the SHARED CxBulkLoadSession collection; killActiveBulkLoadSessionsForAgent (repository:143-164) does updateMany status->killed, so legitimate retire flows still leave at most one running row — but ANY existing duplicate running rows in the live DB will block index creation; a sweep must run first. (c) agentExtensionId can be null (schema default null); a partial-unique on agentExtensionId must also filter agentExtensionId nonexistent/null to avoid colliding many null-extension rows — prefer keying uniqueness on agentEmail (always required) and treat extension as secondary. (d) The singular vs plural find fork (line 574-576) means the test fake (only implements findActiveBulkLoadSessionForAgent) exercises the else-branch; ensure any agent-key change is derived identically in both branches. TEST-LOCK: No existing test pins the keyed-on-new-sessionId behavior. tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js:426-458 ("start replaces a prior active session through full kill cleanup") passes an EXPLICIT sessionId and asserts only on cleanup outcomes (old.status killed, cancels, released, manual-reset terminal write); switching the lock key to agentEmail still passes it. The fake repo createBulkLoadSession (test line 26-30) enforces no agent uniqueness, so no test would catch the missing backstop — a regression test for two no-sessionId concurrent starts should be added with the fix.

### Test to lock it
Add to tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js: with a fake newSessionId that returns distinct ids and a fake repo whose createBulkLoadSession is awaited on a deferred promise, call svc.startCxBulkLoadSession({agentEmail:"a@x.com",...}) twice WITHOUT sessionId concurrently (Promise.all), then assert exactly one repo row has status "running" for that agent (listActiveBulkLoadSessions filtered by agentEmail has length 1) and that the second start retired/killed the first (one cancelBatchForSession + one releaseReserved). Separately, an integration test against real Mongo asserting the partial-unique index rejects a second concurrent insert (E11000) confirms the DB backstop; this is Mongo-execution and per the rail's policy is integration-deferred, so gate it accordingly.

---

## #4 — Review-outcome vs outbox-drain TOCTOU: agent DNC reported applied but silently lost

**Severity:** blocker · **Status (re-verified):** OPEN

**Location:** Review update: packages/shared-services/src/cxBulkLoadRuntime.js:1442-1457 (submitCxBulkLoadReviewOutcome) → packages/shared-repositories/src/cxTerminalOutboxRepository.js:58-88 (updatePendingOutcomeByIdentity), 90-98 (markDrained), 28-35 (listPendingForDrain). Drain: packages/shared-services/src/cxTerminalOutboxDrain.js:35-114 (drainOnce). Drain wiring/trigger: apps/control-plane/src/server.js:1058-1125. Cadence DNC gate: packages/shared-services/src/cxCadenceService.js:2678-2811.

### Mechanism
CONFIRMED. The review-outcome path and the outbox drain are two independent, unsynchronized actors over the same CxTerminalOutbox row, and the drain replays an in-memory snapshot with no CAS, so a concurrent DNC review is lost-update'd while the agent is told ok:true,updated:true.

1) The terminal row's replay payload is the snapshot taken at INSERT time. cxBulkLoadRuntime.js:725 stores `payload: event`, where `event.outcome` (cxBulkLoadRuntime.js:723) is the original terminal outcome (e.g. did_not_connect). The drain replays exactly this: drainOnce reads full rows via listPendingForDrain (cxTerminalOutboxDrain.js:38), then calls recordCadenceEvent(packet.payload) (cxTerminalOutboxDrain.js:68) using the IN-MEMORY snapshot. The control-plane recordCadenceEvent (server.js:1066-1078) and the cadence finalizer read `outcome: event.outcome`; handleCxTerminalCallOutcome gates ALL DNC/Logics work on normalizedOutcome (cxCadenceService.js:2680,2811), derived from payload.outcome.

2) submitCxBulkLoadReviewOutcome calls updatePendingOutcomeByIdentity (cxBulkLoadRuntime.js:1442), a bare findOneAndUpdate filtered on status {$in:[pending,failed]} (repo:68-74) that $sets payload.outcome='dnc' (repo:79). It runs in the agent's synchronous HTTP route — NOT inside withSessionMutation or any bulk-session lock (no lock wraps it; grep for withSessionMutation/drainOnce in the runtime returns nothing).

3) The drain runs on a separate setInterval worker (server.js:1125). Its only guard is workerState.running (server.js:1091), which serializes drain ticks against EACH OTHER, not against the review route. markDrained (repo:90-98) matches on idemKey ONLY — no status, no version, no outcome guard.

The race: drain tick reads the still-pending row (snapshot outcome=did_not_connect) at T0. At T1 the agent's review update findOneAndUpdate matches status=pending, writes payload.outcome='dnc', returns the new row → submit returns ok:true,updated:true (cxBulkLoadRuntime.js:1450-1451). At T2 the drain — still holding its T0 snapshot — replays recordCadenceEvent with the STALE did_not_connect (DNC branch at cxCadenceService.js:2811 never fires; nothing reaches Logics), then markDrained(idemKey) unconditionally flips status→drained. The row is now drained, so any later drain or re-review (filtered to pending/failed) skips it forever. Net: agent UI confirms DNC applied; the DNC never reaches Logics. In a live DNC-compliance system this is a silent compliance miss.

### Current code
```js
// cxBulkLoadRuntime.js:1442-1457  (review outcome — no lock, reports ok on the pre-drain update)
  const updated = await cxTerminalOutboxRepository.updatePendingOutcomeByIdentity({
    sessionId: session.sessionId,
    queueItemId,
    uii,
    outcome,
    source: "agent-auto-review",
  });
  return {
    ok: Boolean(updated),
    updated: Boolean(updated),
    reason: updated ? null : "terminal-outbox-already-drained-or-missing",
    sessionId: session.sessionId,
    queueItemId,
    uii,
    outcome,
  };

// cxTerminalOutboxRepository.js:68-87  (update filter — only requires pending/failed; succeeds vs an in-flight drain)
  return CxTerminalOutbox.findOneAndUpdate(
    {
      sessionId,
      queueItemId,
      uii,
      status: { $in: ["pending", "failed"] },
    },
    {
      $set: {
        outcome,
        source,
        "payload.outcome": outcome,
        ...
      },
    },
    { new: true },
  ).lean();

// cxTerminalOutboxRepository.js:28-34  (drain reads full rows incl. payload — the snapshot that goes stale)
async function listPendingForDrain(limit = 50) {
  const cap = Math.max(Number(limit) || 0, 1);
  const rows = await CxTerminalOutbox.find({ status: { $in: ["pending", "failed"] } })
    .sort({ createdAt: 1 })
    .limit(cap)
    .lean();

// cxTerminalOutboxDrain.js:38,68,87  (replay uses the in-memory snapshot; markDrained has no guard)
      rawPending = await outboxRepository.listPendingForDrain(limit);
      ...
        const terminalResult = await recordCadenceEvent(packet.payload);
      ...
        await outboxRepository.markDrained(row.idemKey);

// cxTerminalOutboxRepository.js:90-98  (markDrained — idemKey ONLY, no status/version CAS)
async function markDrained(idemKey) {
  const key = String(idemKey || "").trim();
  if (!key) return null;
  return CxTerminalOutbox.findOneAndUpdate(
    { idemKey: key },
    { $set: { status: "drained", drainedAt: new Date(), lastError: null } },
    { new: true },
  ).lean();
}

// cxCadenceService.js:2680, 2811  (DNC/Logics work fires ONLY when the replayed outcome is already 'dnc')
  const contactOutcome = normalizedOutcome === "answered" || normalizedOutcome === "dnc";
  ...
  if (normalizedOutcome === "dnc") {
```

### Proposed fix
Make the drain claim-and-CAS so it cannot mark-drained a row whose outcome changed under it, and have the review update be a true compare-and-swap that loses (not silently wins) if the row already drained.

Minimal, two-part:
1) Optimistic-version the row. Add a monotonically-bumped `rev` (or reuse Mongoose `__v`). Have listPendingForDrain return the row WITH its rev; markDrained must CAS on {idemKey, status:{$in:[pending,failed]}, rev:<snapshotRev>}. updatePendingOutcomeByIdentity must `$inc:{rev:1}` whenever it sets payload.outcome. Then in drainOnce, after the markDrained CAS, check the returned doc: if markDrained returns null (no match because rev moved or status already changed), DO NOT count it drained — re-list and re-replay on the next tick so the now-`dnc` payload is what gets dispatched. This closes the window: either the review update happens before the drain's CAS (drain's stale markDrained no-ops, row stays pending with outcome=dnc, next tick replays DNC) or after (review update fails its status filter and submit returns updated:false — the agent is correctly told it wasn't applied, instead of being lied to).

2) Re-read the row inside the drain immediately before dispatch instead of trusting the scan snapshot — i.e. recordCadenceEvent should operate on a fresh findByIdemKey(row.idemKey) payload, not packet.payload. (Necessary even with versioning, because the dispatch itself reads the payload; on its own, a fresh re-read shrinks but does not fully close the window — pair it with the CAS in (1).)

The cleaner single-actor alternative the reviewer should weigh: route the DNC review THROUGH the same outbox/drain instead of mutating a pending terminal row — i.e. submitCxBulkLoadReviewOutcome inserts a NEW outbox row (idemKey eventType="review-dnc") rather than racing the in-flight terminal row. That removes the shared-row contention entirely and is more in keeping with the rail's insert-once durability model.

### Blast radius / caveats
BLAST RADIUS: (1) recordCadenceEvent / handleCxTerminalCallOutcome (cxCadenceService.js:2654) is a SHARED cadence finalizer used by the non-bulk CX rail too (the dispatcher at cxCadenceService.js:2996 routes CALL_TERMINAL_OUTCOME events into it, and the live click-path dispatchCadenceEvent fallback at cxBulkLoadRuntime.js:730 also calls it). Do NOT change its outcome semantics; confine the fix to the outbox repository + drain orchestration. (2) markDrained/listPendingForDrain/insertOnce are the M11 durable-outbox primitives — adding a rev/CAS touches the CxTerminalOutbox model and must keep insertOnce's unique-idemKey dedup intact.

TEST-LOCK: tests/cx-bulk-load/cxTerminalOutboxDrain.test.js LOCKS the current no-CAS behavior by intent. fakeOutbox.markDrained (line 19) ignores everything and returns a synthetic drained row; the test 'drainOnce replays each pending payload and marks it drained' (lines 29-40) asserts drained===scanned and that recordCadenceEvent receives packet.payload (the snapshot). Adding a markDrained CAS that can return null (=not drained) plus a re-read-before-dispatch will break these fakes' assumptions — the fakes must be updated to model the rev/status guard, and a NEW regression test should assert the exact race: a row whose payload.outcome flips to 'dnc' between listPendingForDrain and markDrained must end up dispatching 'dnc' (or stay pending), never silently drained with the stale outcome. Note the Mongo execution paths here are integration-deferred (no local Mongo), so the race must be proven with fakes at the drain/repository seam.

### Test to lock it
Add to tests/cx-bulk-load/cxTerminalOutboxDrain.test.js a race regression: build a fakeOutbox whose listPendingForDrain returns a row with payload.outcome='did_not_connect' and a rev, but whose markDrained CAS is given a HIGHER current rev (simulating the review update landing mid-drain) so the CAS matches nothing and returns null. Assert: (a) the row is NOT counted drained (result.drained does not include it), (b) on a second drainOnce with the row now carrying payload.outcome='dnc', recordCadenceEvent receives outcome='dnc'. Separately, a repository/integration test (Mongo-gated): insert a pending terminal row (outcome=did_not_connect); interleave updatePendingOutcomeByIdentity(outcome='dnc') between a manual listPendingForDrain snapshot and markDrained(snapshotRev); assert the final row is status!=drained OR its drained dispatch carried 'dnc', and that submitCxBulkLoadReviewOutcome never returns ok:true,updated:true for an outcome that did not reach the cadence DNC branch. Run: node --test tests/cx-bulk-load/cxTerminalOutboxDrain.test.js

---

## #5 — confirmRingcxUiiReleased: transient poll errors after an early sighting are masked as a confirmed "still-active" result (stale snapshot), never re-verified

**Severity:** major · **Status (re-verified):** OPEN

**Location:** C:/code/tagcontactbridgeparalell/packages/shared-services/src/cxBulkLoadRuntime.js:304-348 (poll loop 313-335; lastError/lastActiveCall handling 336-342; fallthrough reason 343-347). Consumed at cxBulkLoadRuntime.js:967-983 and cxBulkLoadRuntimeService.js:697-717.

### Mechanism
The loop over waits=[250,600,900]ms (line 310) returns ok:true ONLY when a poll succeeds AND finds no match (324-326). A poll that succeeds and DOES find the UII sets lastActiveCall and continues (327-331); a poll that THROWS sets lastError and continues (332-334) — it does not break. So if an early poll sights the call (lastActiveCall is now truthy) and later polls throw, the post-loop guard `if (lastError && !lastActiveCall)` (336) is false because lastActiveCall is truthy, so the dedicated error reason "active-call-release-verification-failed" is suppressed and control falls through to "active-call-still-active-after-disposition" (343-347) carrying the STALE poll-1 snapshot. The result is the function asserts the call is confirmed still-active (a compliance-relevant claim) when in reality polls 2 and 3 only hit transient API errors and the call may already have been released — it is never re-confirmed. CORRECTION to the prior-sweep framing: both reasons return ok:false, so the terminal DB write is dropped EITHER way (see cxBulkLoadRuntimeService.js:697-706 returns terminal.failed before persistTerminalOutcome at 710). The defect is therefore NOT "error path would have let the write through" — it is that a recoverable transient-error condition is mis-reported as a definitive still-active determination with a stale snapshot, masking the real cause and short-circuiting the terminal outcome on a false positive. Net effect for the reviewer: a disposition that RingCX already accepted can be permanently reported as accepted-but-still-active (cxBulkLoadRuntime.js:977) and the terminal outcome never persists, on the basis of one early sighting plus transient poll failures.

### Current code
```js
// cxBulkLoadRuntime.js:310-348
  const waits = Array.isArray(options.waits) && options.waits.length ? options.waits : [250, 600, 900];
  let lastActiveCall = null;
  let lastError = null;
  for (let index = 0; index < waits.length; index += 1) {
    const waitMs = Math.max(Number(waits[index]) || 0, 0);
    if (waitMs > 0) await sleep(waitMs);
    try {
      const payload = await client.listActiveCalls({
        product: "ACCOUNT",
        productId: accountId || undefined,
        maxRows: 100,
      });
      const match = activeCallList(payload)
        .find((call) => normalizeExternalId(call?.uii) === normalizedUii);
      if (!match) {
        return { ok: true, status: "released", attempts: index + 1 };
      }
      lastActiveCall = {
        uii: normalizeExternalId(match.uii),
        externalId: normalizeExternalId(match.externalId || match.externId),
        callState: match.callState || match.state || match.status || null,
      };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError && !lastActiveCall) {
    return {
      ok: false,
      reason: "active-call-release-verification-failed",
      error: lastError.message || String(lastError),
    };
  }
  return {
    ok: false,
    reason: "active-call-still-active-after-disposition",
    activeCall: lastActiveCall,
  };

// cxBulkLoadRuntimeService.js:697-717 — terminal.ok===false returns BEFORE the terminal write
    if (terminal && terminal.ok === false) {
      next = reduce(next, { type: "terminal.failed", error: terminal.error || terminal.reason || "terminal-rejected" }, now());
      await persist(next);
      ...
      return { ...sanitizeSession(next), dispositionOk: false, terminal };
    }
    // single idempotent terminal write, then complete + clear current.
    _step("persistTerminalOutcome (DB WRITE) START");
    await outcomeAdapter.persistTerminalOutcome({ ... eventType: "terminal" });
```

### Proposed fix
Track per-poll freshness so a stale early sighting does not outrank a later transient error, and prefer the most recent observation. Minimal change inside the loop: record which poll produced lastActiveCall and clear/age it appropriately. Concretely, when a poll THROWS, do NOT leave a now-stale prior sighting authoritative for the final determination — capture the throw as the last observation. Smallest correct patch: in the catch block, set `lastError = error; lastActiveCall = null;` is WRONG (it would discard a legitimate sighting and over-report errors). Instead track ordering: keep both, and change the post-loop decision so that a throw on the FINAL poll (i.e. lastError observed after the last successful sighting) reports the verification-failed reason. Implement by recording the poll index of each: `let activeSeenAt = -1; let errorSeenAt = -1;` set `activeSeenAt = index` on sighting and `errorSeenAt = index` on throw; then replace line 336 with `if (lastError && errorSeenAt > activeSeenAt) { return { ok:false, reason:"active-call-release-verification-failed", error: lastError.message||String(lastError) }; }`. This yields: persistent sighting (no later error) -> still-active (unchanged, preserves the locked test); early sighting + later transient throws -> verification-failed (recoverable, not a false still-active claim); throws only -> verification-failed (unchanged). Reviewer should decide whether the desired downstream behavior for "verification-failed" should remain ok:false (block + retry) or be treated as inconclusive — both still block the terminal write today, so this fix changes the REASON/snapshot, not the write gating. If the intent is also to allow the terminal write on inconclusive verification, that is a separate, larger decision and should be called out explicitly rather than bundled here.

### Blast radius / caveats
BLAST RADIUS: (1) confirmRingcxUiiReleased is a bulk-rail-only function (defined in cxBulkLoadRuntime.js, exported via _test and used only at the bulk terminalExecutor call site cxBulkLoadRuntime.js:967); the non-bulk rail does not call it — low cross-rail risk. (2) TEST THAT LOCKS CURRENT BEHAVIOR BY INTENT: tests/cx-bulk-load/cxBulkLoadRuntime.test.js:41-51 ("confirmRingcxUiiReleased reports still-active UIIs without throwing") uses a client whose listActiveCalls ALWAYS returns the UII as ACTIVE with waits:[0], and asserts reason==="active-call-still-active-after-disposition". The proposed index-ordering fix preserves this (no error ever occurs, so errorSeenAt stays -1 and the still-active branch is taken) — but any naive fix that clears lastActiveCall in the catch or that returns verification-failed whenever lastError is set WOULD STILL pass this specific test (it never throws) yet would over-report errors in the persistent-sighting+transient-error case; reviewer should require a NEW test for the mixed sighting-then-throw sequence. (3) COMPLIANCE SENSITIVITY: this gate sits on the live lead-dialing/DNC path; the activeCall snapshot it returns is surfaced as dispositionStatus:"accepted-but-still-active" (cxBulkLoadRuntime.js:977) and drives terminal.failed state — a false still-active claim can strand an already-released call's terminal outcome, so correctness of the reason matters operationally, not just cosmetically.

### Test to lock it
Add to tests/cx-bulk-load/cxBulkLoadRuntime.test.js: a stateful client whose listActiveCalls returns the matching UII as ACTIVE on the FIRST call, then THROWS on subsequent calls; invoke `_test.confirmRingcxUiiReleased(client, "u1", { waits: [0, 0, 0] })`. Current code asserts result.reason === "active-call-still-active-after-disposition" with a stale activeCall snapshot (documents the bug). Post-fix asserts result.ok === false and result.reason === "active-call-release-verification-failed" (transient error wins because it was the most recent observation). Keep the existing line 41-51 test green (persistent ACTIVE, no throw -> still-active). Also add the inverse guard: error on first poll, sighting on last poll -> still-active (sighting is most recent). Run `node --test tests/cx-bulk-load/cxBulkLoadRuntime.test.js`.

---

## #6 — Lost release across a __v-miss: watcher diff anchors persist only via the CAS write, dropped on version-miss with no retry/re-read

**Severity:** major · **Status (re-verified):** OPEN

**Location:** C:\code\tagcontactbridgeparalell\packages\shared-services\src\cxAccountActiveCallWatcherService.js:211-218 (anchor writes), :559-568 (guarded save + version-miss branch); C:\code\tagcontactbridgeparalell\packages\shared-services\src\cxBulkLoadActiveCallWatcher.js:157-160 (release-detection requires previous.uii). Anchors are READ from the persisted session at :169-170 and :190.

### Mechanism
CONFIRMED. Each tick, deriveReleasedCandidates diffs the prior poll's active set against the current poll. The "prior poll" anchors are read off the session row that was loaded from Mongo: prevActiveExternIds <- session.prevActiveExternIds (:169) and prevActiveCalls <- session.trace?.prevActiveCalls (:170, :190). The freshly-computed next-tick anchors are written ONLY into the in-memory `next` object (:211-218): prevActiveExternIds = releaseDiff.nextActiveExternIds and trace.prevActiveCalls = compactActiveCalls(...). That `next` becomes projection.after, which becomes `patch` (:555-557, after stripping _id/__v), and the ONLY path to durable storage is the optimistic-concurrency write at :559 (updateBulkLoadSession with writeOptions.expectedVersion/versionGuard). If the row's __v advanced between the watcher's read and this write, updateBulkLoadSession returns falsy; the code takes the version-miss branch (:560-568): it pushes a {reason:'version-miss'} skip record and returns. There is NO re-read of the now-current row and NO retry of the projection. Consequently the recomputed anchors are discarded and the persisted session keeps its STALE prevActiveExternIds/prevActiveCalls. Cross that with the release detector (cxBulkLoadActiveCallWatcher.js:157-160): a pool candidate is only emitted as `released` when `ext && previous && previous.uii && !nowActive.has(ext)` — release detection REQUIRES a previous record carrying a real uii. So a lead that RingCX dialed-active and then released entirely across the version-miss gap has no previous.uii anchored for the tick that would observe it gone: the active-then-gone externId is never written as a `prevActiveCall` with its uii, so the next successful tick's diff cannot see it transition active->gone. Net effect: that released lead is never counted as did_not_connect (no terminal observation at :177-186 / :470-499) and is never de-buffered, exactly as claimed. This only matters when a __v bump races a tick (any concurrent writer to the same session: the runtime command tail, another watcher pass, agent action), but in those races the release evidence for a call that lived entirely inside the gap is lost permanently because the diff is anchor-to-anchor, not derivable from the live snapshot alone.

### Current code
```js
// cxAccountActiveCallWatcherService.js:168-173  (anchors READ from persisted session)
  const releaseDiff = watcher.deriveReleasedCandidates({
    prevActiveExternIds: session.prevActiveExternIds || [],
    prevActiveCalls: session.trace?.prevActiveCalls || [],
    activeCalls: relevantCalls,
    pool: session.acceptedBuffer || [],
  });

// cxAccountActiveCallWatcherService.js:211-218  (next-tick anchors WRITTEN only into `next`)
  next = {
    ...next,
    prevActiveExternIds: releaseDiff.nextActiveExternIds,
    trace: {
      ...(next.trace || {}),
      prevActiveCalls: compactActiveCalls(releaseDiff.nextActiveCalls || compactCalls),
    },
  };

// cxAccountActiveCallWatcherService.js:555-568  (CAS write is the ONLY persistence path; version-miss = skip + return, no retry/re-read)
    const patch = { ...after };
    delete patch._id;
    delete patch.__v;
    const writeOptions = eligibility.writeOptions || {};
    const saved = await sessionRepository.updateBulkLoadSession(projection.sessionId, patch, writeOptions);
    if (!saved) {
      skipped.push({
        sessionId: projection.sessionId,
        agentEmail: projection.agentEmail || null,
        accountId: projection.accountId || null,
        reason: "version-miss",
        expectedVersion: writeOptions.expectedVersion ?? null,
        expectedUpdatedAt: writeOptions.expectedUpdatedAt ?? null,
      });
    } else {

// cxBulkLoadActiveCallWatcher.js:157-160  (release detection REQUIRES a previous record carrying a real uii)
  const released = (Array.isArray(pool) ? pool : []).filter((cand) => {
    const ext = candidateExternId(cand);
    const previous = ext ? prevByExternId.get(ext) : null;
    return ext && previous && previous.uii && !nowActive.has(ext);
  }).map((cand) => {
```

### Proposed fix
On a version-miss inside applyProjection (the :560 branch), do not just record-and-return: re-read the latest session row and re-run the projection so the anchors are recomputed against fresh state and re-persisted. Minimal shape: add a bounded retry (e.g. 1-2 attempts) that, on !saved, reloads the row (a sessionRepository.getBulkLoadSession / findById injected like the other repo methods), feeds it back through projectBulkSessionFromAccountSnapshot with the SAME activeCalls snapshot for this account, and re-attempts updateBulkLoadSession with the refreshed expectedVersion. Because relevantCalls/compactCalls for this tick are already in hand, the re-projection reuses the same live snapshot, so the active-then-gone diff is preserved across the re-read. If retries exhaust, escalate the skip (distinct reason, e.g. 'version-miss-exhausted') so it is observable. Keep the change scoped to runCxAccountActiveCallWatchOnce / applyProjection; do NOT change the anchor-write block (:211-218) or the release predicate (:157-160), which are correct. Note: a re-read requires the active-call snapshot be re-projected (not just the patch re-sent), because the recomputed prevActiveCalls must reflect this tick's snapshot, not the row's stale trace.

### Blast radius / caveats
BLAST RADIUS: (1) The version-guard/CAS itself is INTENTIONAL and test-locked — cxBulkLoadMutationEligibility.test.js asserts buildVersionGuardOptions returns {expectedVersion, versionGuard:true} and the stale-projection path; cxBulkLoadRuntimeService.test.js:38-40 simulates the versionGuard rejecting on __v mismatch. The fix must PRESERVE the CAS (don't drop versionGuard to force the write) — that would reintroduce lost-update races the guard exists to stop. The fix adds re-read+retry on top of the guard, it does not remove it. (2) updateBulkLoadSession / listActiveBulkLoadSessions live on the shared sessionRepository (cxBulkLoadRuntimeService.js also consumes them); a new getById-style read method must be added without altering existing signatures so the non-watcher runtime rail is untouched. (3) No existing test locks the 'silently drop anchors on version-miss' behavior as intended — the only version-miss assertions concern the guard firing, not anchor loss — so adding retry/re-read does not contradict an intentional test. (4) Trigger is concurrency-only: requires a __v bump to race a watcher tick AND a call whose entire active->released lifetime falls inside that gap; under single-writer conditions the bug does not fire. This is why severity is major, not blocker.

### Test to lock it
Add to cxAccountActiveCallWatcherService.test.js: seed a session with prevActiveExternIds=['cxbl-q1'] and trace.prevActiveCalls=[{externId:'cxbl-q1',uii:'u1'}] and that lead in acceptedBuffer; client.listActiveCalls returns [] (lead released). Make updateBulkLoadSession return null on the FIRST call (simulating a __v bump) and succeed on a retry after a re-read that returns the row with bumped __v but the SAME prevActiveCalls anchor. Assert: with current code, terminalWriteCount===0 and the released lead remains in acceptedBuffer of the persisted row (demonstrates loss); after the fix, the retry path re-projects against the live empty snapshot and produces terminalWriteCount===1 with candidate.queueItemId==='q1'/uii==='u1' and the lead de-buffered. Mirror the existing 'writes terminal observations for released UIIs' test (:325-369) but inject the one-shot version-miss.

---

## #7 — Departing-call terminal write dropped when the incoming candidate's serving-ownership CAS misses

**Severity:** major · **Status (re-verified):** OPEN

**Location:** C:\code\tagcontactbridgeparalell\packages\shared-services\src\cxAccountActiveCallWatcherService.js — early-return on serving miss at lines 535-545; persistTerminalObservations invoked only at line 579 (inside the write-succeeded branch); co-attach of departing-A terminalObservation at lines 273-279 and incoming-B currentPromotion.required at lines 280-287, both on the same projection produced by projectBulkSessionFromAccountSnapshot.

### Mechanism
CONFIRMED. In a RingCX "switch" tick, projectBulkSessionFromAccountSnapshot puts TWO things on one projection: (a) the departing current call A as a terminal observation, and (b) the incoming candidate B's promotion. deriveCurrentTransition returns {kind:"switch", completePrevious:true, previousOutcome:"did_not_connect"} when the matched candidate's queueItemId differs from current's (watcher lines 126-137). On that branch projectBulkSessionFromAccountSnapshot pushes A onto terminalObservations (service lines 273-279, guarded by hasTerminalWriteProof(next.current), source "active-call-switch") AND sets currentPromotion={required:!sameCurrent=true, candidate:B, ...} (lines 280-287). In runCxAccountActiveCallWatchOnce.applyProjection, because promotion.required is true and a markCandidateServing adapter exists, it calls the serving stamp (lines 520-534). If that CAS returns falsy (`served` null), the function pushes a "serving-ownership-stamp-miss" skip and `return`s at line 544 — BEFORE updateBulkLoadSession (line 559) and BEFORE persistTerminalObservations (line 579). Since persistTerminalObservations is the ONLY place projection.terminalObservations are flushed to outcomeAdapter.persistTerminalOutcome, A's already-released terminal outcome is silently dropped. A's release is independent of whether B can be adopted, so a CAS miss on B must not suppress A's terminal write. In a DNC/cadence-compliance system this loses the did_not_connect outcome for a real, already-ended call (queueItemId + real UII), corrupting attempt accounting for lead A.

### Current code
```js
// cxAccountActiveCallWatcherService.js:273-287 (projectBulkSessionFromAccountSnapshot — A and B co-attached)
    if (!sameCurrent && transition.completePrevious === true && hasTerminalWriteProof(next.current)) {
      terminalObservations.push({
        source: "active-call-switch",
        outcome: transition.previousOutcome || "did_not_connect",
        candidate: next.current,
      });
    }
    currentPromotion = {
      required: !sameCurrent,
      kind: transition.kind,
      candidate: transition.candidate || null,
      uii: transition.uii || null,
      activeCallSummary: match.activeCall || null,
      matchReasons: transition.matchReasons || [],
    };

// cxAccountActiveCallWatcherService.js:519-545 (applyProjection — serving miss early-return)
    const promotion = projection.currentPromotion || null;
    if (promotion && promotion.required && typeof input.queueStateAdapter?.markCandidateServing === "function") {
      const adopted = promotion.candidate?.adoption?.source === "ringcx-active-external-id";
      const servingMethod =
        adopted && typeof input.queueStateAdapter.markAdoptedCandidateServing === "function"
          ? "markAdoptedCandidateServing"
          : "markCandidateServing";
      const served = await input.queueStateAdapter
        [servingMethod]({ ... })
        .catch(() => null);
      if (!served) {
        skipped.push({
          sessionId: projection.sessionId,
          agentEmail: projection.agentEmail || null,
          reason: "serving-ownership-stamp-miss",
          currentQueueItemId: projection.currentQueueItemId || null,
          currentUii: projection.currentUii || null,
          adopted,
        });
        return;            // <-- bails BEFORE persistTerminalObservations(projection)
      }
    }

// cxAccountActiveCallWatcherService.js:560-580 (the ONLY flush of terminalObservations — reached only on write success)
    if (!saved) {
      skipped.push({ ... reason: "version-miss" ... });
    } else {
      writes.push({ ... });
      await persistTerminalObservations(projection);
    }
```

### Proposed fix
Persist the co-attached terminal observations BEFORE bailing on the serving-stamp miss, because the departing call's release is independent of whether the incoming candidate can be adopted. In applyProjection's `if (!served)` branch (lines 535-545), call `await persistTerminalObservations(projection);` immediately before the `return;`. persistTerminalObservations already self-guards each observation with hasTerminalWriteProof and pushes its own skip on missing queue-item/uii (lines 472-482), so it is safe to call here. No double-write risk within a projection: the serving-miss branch returns immediately and never reaches the line-579 call. Note the session state patch (B's promotion + trace) is correctly NOT written on a serving miss — only A's terminal outcome should be flushed. (If reviewers prefer minimizing surface area, an alternative is to filter to only the "active-call-switch"/release observations whose candidate != promotion.candidate, but persistTerminalObservations already only contains released/departed candidates, so the unconditional call is sufficient and simplest.)

### Blast radius / caveats
BLAST RADIUS: This service is bulk-load-only (module exports buildCxAccountActiveCallWatchPlan / projectBulkSessionFromAccountSnapshot / runCxAccountActiveCallWatchOnce; the only require of cxAccountActiveCallWatcherService is the test file). It is NOT shared with the non-bulk EX/CX call-state rail, so the fix does not touch the legacy poller. EXISTING TESTS DO NOT LOCK THE DROP: (1) tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js:286 "requires the serving ownership stamp before current promotion" asserts writeCount 0 + a single serving-ownership-stamp-miss skip — but its session has NO prior current (fresh switch from empty current → candidate B, completePrevious:false), so it produces NO co-attached terminal observation; adding the flush leaves terminalWriteCount at 0 there and the test still passes. (2) test at :325 "writes terminal observations for released UIIs" exercises the pure release path with no promotion/serving stamp, unaffected. There is currently NO test covering the switch-with-completePrevious-AND-promotion-required combination, which is exactly why this bug is invisible — the reviewer should require a new regression test as part of the fix.

### Test to lock it
Add a regression test in tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js: build a session whose `current` is call A {queueItemId:"qA", externId:"cxbl-qA", uii:"uA"} with prevActiveExternIds/trace.prevActiveCalls reflecting A active last tick, and an acceptedBuffer candidate B {queueItemId:"qB", externId:"cxbl-qB"}; client.listActiveCalls returns ONLY B active now ([{externalId:"cxbl-qB", uii:"uB"}]) so the projection is a switch (completePrevious:true → A terminal obs) with currentPromotion.required for B; provide queueStateAdapter.markCandidateServing returning null (CAS miss) and an outcomeAdapter.persistTerminalOutcome spy. Assert: result.applied.skipped[0].reason === "serving-ownership-stamp-miss" (B not adopted), writeCount === 0 (session patch not persisted), AND the persistTerminalOutcome spy received exactly one call for candidate A (queueItemId "qA", uii "uA", outcome "did_not_connect") — i.e., A's terminal write survives B's CAS miss. Run: node --test tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js (and the full tests/cx-bulk-load/*.test.js suite to confirm the two locking tests still pass).

---

## #8 — Outbox-outage double-fault: dispositioned call left uncounted with current stuck at terminal.started

**Severity:** major · **Status (re-verified):** OPEN

**Location:** packages/shared-services/src/cxBulkLoadRuntime.js:707-732 (recordCadenceEvent fallback) and :730 (await dispatchCadenceEvent in the .catch); packages/shared-services/src/cxBulkLoadRuntimeService.js:710 (unguarded await persistTerminalOutcome); packages/shared-services/src/cxBulkLoadOutcomeAdapter.js:98 (unguarded await recordCadenceEvent); reducer transitions packages/shared-services/src/cxBulkLoadStateMachine.js:212-223 (terminal.started) vs :225-241 (terminal.accepted). Prior-sweep line numbers (~722-727, ~695) were stale; real lines confirmed above.

### Mechanism
CONFIRMED. submitCxBulkLoadDisposition does: (1) reduce terminal.started (service:676) — reducer sets phase=RELEASING and KEEPS state.current populated (stateMachine:212-223, current is NOT cleared); (2) await terminalExecutor — the call is HUNG UP (service:678-688); (3) await outcomeAdapter.persistTerminalOutcome with NO surrounding try/catch (service:710); (4) only AFTER that, reduce terminal.accepted, which is the step that pushes to state.completed (the "count") and sets state.current=null (stateMachine:225-241, esp. :234 and :237), then persist(next) (service:730). The injected recordCadenceEvent (runtime:696-742) calls cxTerminalOutboxRepository.insertOnce(...).catch(async (err) => { await dispatchCadenceEvent(event); ... }) (runtime:727-732). dispatchCadenceEvent (runtime:681-694) is a thin wrapper returning handleCxTerminalCallOutcome(...) with no try/catch. persistTerminalOutcome awaits recordCadenceEvent unguarded (outcomeAdapter:98). So if BOTH the outbox insertOnce rejects AND the fallback dispatchCadenceEvent throws (the comment at runtime:728-729 explicitly calls this the outage path, and the fallback runs shared cleanup including DNC stop/sync that can throw), the .catch handler's returned promise rejects -> recordCadenceEvent rejects -> persistTerminalOutcome rejects (outcomeAdapter:98 unguarded) -> the await at service:710 rejects. terminal.accepted (service:720-726) and persist(next) (service:730) are never reached. The rejection escapes the serializer: withSessionOperation awaits and re-throws (service:322-326); its finally only clears busy/tail (service:315-318) and cleanup=run.catch(()=>null) (service:320) only protects the NEXT op's chain, it does not suppress the current caller's rejection. Net double-fault: the call is already ended, yet state is stuck at terminal.started (phase=RELEASING, current still set, never pushed to completed = uncounted), current never cleared.

### Current code
```js
// cxBulkLoadRuntime.js:707-732 (recordCadenceEvent fallback — outbox insert with .catch that awaits dispatch, no inner try/catch)
      const inserted = await cxTerminalOutboxRepository
        .insertOnce({
          idemKey,
          ...
          payload: event,
        })
        .catch(async (err) => {
          // If the outbox itself is unavailable, fail open to the old direct dispatch so
          // terminal events are not silently lost. This is an outage path, not normal flow.
          await dispatchCadenceEvent(event);
          return { idemKey, fallbackDispatched: true, error: err };
        });

// cxBulkLoadRuntime.js:681-694 (dispatchCadenceEvent — thin wrapper, no try/catch)
  const dispatchCadenceEvent = async (event) =>
    handleCxTerminalCallOutcome({ ... });

// cxBulkLoadOutcomeAdapter.js:98 (persistTerminalOutcome awaits recordCadenceEvent unguarded)
    const result = await recordCadenceEvent(cadenceEvent);

// cxBulkLoadRuntimeService.js:709-730 (unguarded persist call; terminal.accepted only after it)
    _step("persistTerminalOutcome (DB WRITE) START");
    await outcomeAdapter.persistTerminalOutcome({
      session: state, candidate: current, outcome, source: "disposition", eventType: "terminal",
    });
    _step("persistTerminalOutcome (DB WRITE) DONE");
    await clearTerminalHold(state, current, outcome);
    const acceptedAt = now();
    next = reduce(next, { type: "terminal.accepted", outcome, hangup: terminal || input.hangup, reviewHoldUntil: buildReviewHoldUntil(acceptedAt), reviewHoldReason: "manual-disposition" }, acceptedAt);
    next = await maybeRefill(next);
    await persist(next);

// cxBulkLoadStateMachine.js:212-223 (terminal.started — KEEPS current)
    case "terminal.started": {
      state.phase = CX_BULK_LOAD_PHASES.RELEASING;
      if (state.current) { state.current = { ...state.current, phase: CX_BULK_LOAD_PHASES.RELEASING, outcome: event.outcome || null, terminalStartedAt: nowIso, updatedAt: nowIso }; }
      break;
    }

// cxBulkLoadStateMachine.js:225-241 (terminal.accepted — the step that counts + clears current)
    case "terminal.accepted": {
      const outcome = { ...(state.current || event.candidate || {}), phase: CX_BULK_LOAD_PHASES.RELEASED, ... };
      state.completed = pushCompletedOnce(state.completed, outcome);
      state.lastOutcome = outcome;
      ...
      state.current = null;
      ...
    }
```

### Proposed fix
Make terminal recording crash-safe so a call that already hung up still advances the reducer past terminal.started even if BOTH durable paths fail. Minimal, lowest-blast-radius fix: harden the fallback in cxBulkLoadRuntime.js so recordCadenceEvent never throws on the outage path — wrap the inner await dispatchCadenceEvent in its own try/catch and return a status instead of rejecting, e.g. in the .catch handler: `try { await dispatchCadenceEvent(event); return { idemKey, fallbackDispatched: true, error: err }; } catch (dispatchErr) { return { idemKey, fallbackDispatched: false, fallbackFailed: true, error: dispatchErr }; }`. recordCadenceEvent already returns a {written, fallbackDispatched,...} shape so it can carry written:false without throwing. Then in cxBulkLoadRuntimeService.js, treat a non-throwing persistTerminalOutcome result with written:false / fallbackFailed as a soft failure: still proceed to reduce terminal.accepted and persist (the call IS ended, so the reducer MUST reach a terminal state and clear current), while recording lastError / a needs-replay marker so the control-plane drain or a reconciler can re-count. Concretely, replace the bare `await outcomeAdapter.persistTerminalOutcome(...)` at service:710 with a guarded call (try/catch) that, on a thrown or written:false result, logs/stamps the failure but does NOT short-circuit before terminal.accepted+persist. Do NOT route this through terminal.failed (stateMachine:243-256) — that path is for terminalExecutor rejection (the call did NOT hang up) and would leave the call counted-as-not-released; here the call already ended, so terminal.accepted is the correct sink. The exact-once/idempotency invariant is preserved by the outbox idemKey, so a later drain re-write is a no-op.

### Blast radius / caveats
BLAST RADIUS: (1) dispatchCadenceEvent calls handleCxTerminalCallOutcome, a SHARED finalizer also used by the non-bulk rails — cxSlowLaneService.js, cxSimpleCallLoopService.js, cxCadenceService.js, ringcxAgentMonitorService.js, and the control-plane drain (confirmed by grep, 5+ src consumers). The fix touches only the bulk_load wrapper's error handling, not handleCxTerminalCallOutcome itself, so no behavior change leaks to those rails. (2) TEST THAT LOCKS REDUCER SEMANTICS (by intent, not in conflict): tests/cx-bulk-load/cxBulkLoadStateMachine.test.js:85-97 asserts terminal.started leaves current set (phase RELEASING) and only terminal.accepted clears current + pushes completed. The proposed fix does NOT change the reducer, so this test still passes — it actually corroborates the mechanism. (3) The runtime test (tests/cx-bulk-load/cxBulkLoadRuntime.test.js) and outcome-adapter test do NOT exercise recordCadenceEvent/persistTerminalOutcome throwing or the outbox-failure fallback at all (grep: no matches for recordCadenceEvent/insertOnce/rejects there), so there is NO test locking the current buggy propagation — the naive fix breaks nothing but is also currently UNCOVERED. (4) Compliance angle: the fallback's shared cleanup includes DNC stop/sync (per runtime:699 comment); if it throws and we now swallow-to-soft-fail, ensure the needs-replay marker actually drives a retry so DNC work is not silently dropped — fail-CLOSED to a replay marker, not fail-silent.

### Test to lock it
Add a unit test to tests/cx-bulk-load that builds the runtime/service with an injected cxTerminalOutboxRepository whose insertOnce rejects AND a handleCxTerminalCallOutcome (dispatch target) that also rejects, plus a terminalExecutor returning {ok:true,executed:true}. Drive submitCxBulkLoadDisposition and assert: (a) the call did NOT reject out of the service (no unhandled rejection); (b) the resulting sanitized session has current===null and the candidate appears in completed (counted); (c) phase is RELEASED/READY, not RELEASING; (d) a lastError / replay marker is set so the drain will re-record. Add a regression-guard variant asserting that with a HEALTHY outbox the happy path is unchanged (written:true, deferred:true). Also keep the existing cxBulkLoadStateMachine.test.js:85-97 green to prove the reducer contract is untouched. Run: node --test tests/cx-bulk-load/*.test.js.

---

## #10 — Watcher serving-stamp CAS fires before any latest-aware staleness guard; orphan serving/wrapUpRequired stamp on version-miss

**Severity:** major · **Status (re-verified):** OPEN

**Location:** C:\code\tagcontactbridgeparalell\packages\shared-services\src\cxAccountActiveCallWatcherService.js:505-559 (apply-time eligibility 506-509; serving CAS 520-546; version-guarded save 559). Supporting: cxBulkLoadMutationEligibility.js:25-58 (latest-gated staleness); cxBulkLoadRuntimeService.js:1033-1045 (beforePersist staleness check that does NOT abort); cxBulkLoadRuntime.js:789-817 (markCandidateServing Mongo CAS stamping serving/wrapUpRequired)

### Mechanism
CONFIRMED. In applyProjection, the apply-time eligibility check at 506-509 passes only {session: projection.before, busy}. describeBulkLoadMutationEligibility only runs its stale-projection branch when a `latest` arg is supplied (cxBulkLoadMutationEligibility.js:32 `if (latest)`), so this call is latest-blind and can never return reason "stale-projection". The serving CAS then runs at 520-546 (markCandidateServing / markAdoptedCandidateServing) — a real Mongo write via cxDialQueueRepository.transitionQueueItemState that sets state:"serving" and metadata.wrapUpRequired:true (cxBulkLoadRuntime.js:811) — and it fires BEFORE the version-guarded session save at 559. The only latest-aware staleness detection lives in beforePersist (cxBulkLoadRuntimeService.js:1033-1045), which loads latest and calls eligibility WITH latest, but on `!eligibility.ok` it merely returns the unchanged `state` and logs `watch.refill_skipped_*` (1041-1042) — it does NOT abort the persist. Worse, beforePersist runs at 549-554, AFTER the serving CAS. Result on a stale projection where the session still holds the queue-row reservation: the CAS succeeds (it is ownership-guarded on metadata.reservationSessionId === session.sessionId at cxBulkLoadRuntime.js:816, NOT version-guarded), stamping the queue row serving/wrapUpRequired for a `current` the session may never adopt; the subsequent version-guarded updateBulkLoadSession at 559 version-misses, taking the `if (!saved)` branch at 560 which only pushes a "version-miss" skipped record and performs NO revert of the serving stamp. The ownership guard is the sole thing averting a fully orphaned stamp (if the reservation has already moved, the CAS returns null and 535-545 skips). So the claim is accurate; the partial mitigation is exactly the ownership-CAS, not any staleness/version guard.

### Current code
```js
// cxAccountActiveCallWatcherService.js:505-509  (apply-time eligibility — NO latest)
  async function applyProjection(projection) {
    const eligibility = describeBulkLoadMutationEligibility({
      session: projection.before,
      busy: typeof input.isSessionBusy === "function" && input.isSessionBusy(projection.sessionId),
    });

// cxAccountActiveCallWatcherService.js:519-546  (serving CAS — Mongo side-effect, runs first)
    const promotion = projection.currentPromotion || null;
    if (promotion && promotion.required && typeof input.queueStateAdapter?.markCandidateServing === "function") {
      const adopted = promotion.candidate?.adoption?.source === "ringcx-active-external-id";
      const servingMethod =
        adopted && typeof input.queueStateAdapter.markAdoptedCandidateServing === "function"
          ? "markAdoptedCandidateServing"
          : "markCandidateServing";
      const served = await input.queueStateAdapter
        [servingMethod]({
          session: projection.before,
          candidate: promotion.candidate,
          uii: promotion.uii,
          activeCallSummary: promotion.activeCallSummary || null,
          matchReasons: promotion.matchReasons || [],
        })
        .catch(() => null);
      if (!served) {
        skipped.push({ ... reason: "serving-ownership-stamp-miss", ... });
        return;
      }
    }

// cxAccountActiveCallWatcherService.js:548-568  (beforePersist runs AFTER the CAS; version-guarded save; no revert on miss)
    let after = projection.after;
    if (typeof input.beforePersist === "function") {
      after = await input.beforePersist({ projection: { ...projection, after }, state: after });
    }
    const patch = { ...after };
    delete patch._id;
    delete patch.__v;
    const writeOptions = eligibility.writeOptions || {};
    const saved = await sessionRepository.updateBulkLoadSession(projection.sessionId, patch, writeOptions);
    if (!saved) {
      skipped.push({ ... reason: "version-miss", expectedVersion: writeOptions.expectedVersion ?? null, ... });
    } else { ... }

// cxBulkLoadMutationEligibility.js:32  (stale-projection detection is gated on `latest` being passed)
  if (latest) {

// cxBulkLoadRuntime.js:811-816  (CAS stamps wrapUpRequired; guard is ownership, not version)
          "metadata.wrapUpRequired": true,
          "metadata.wrapUpReason": "bulk-load-active-call",
          ...
        },
        { match: { "metadata.reservationSessionId": session.sessionId } },
```

### Proposed fix
Make the staleness guard latest-aware AND position it before the serving CAS, and revert/skip on staleness. Minimal change: at the top of applyProjection (before the serving block at 520), load the latest persisted session and pass it into the eligibility check so a stale projection is rejected before any Mongo side-effect. Concretely: add an apply-time latest read using the repo the watcher already has (the same repo exposes findBulkLoadSessionById, used by cxBulkLoadRuntimeService.loadState at 563-564), e.g. const latest = typeof input.loadLatestState === "function" ? await input.loadLatestState(projection.sessionId) : null; then call describeBulkLoadMutationEligibility({ session: projection.before, latest, busy }); on !eligibility.ok push a skipped record (reason "stale-projection-apply") and return BEFORE the serving CAS. Wire input.loadLatestState in cxBulkLoadRuntimeService.watchAccountActiveCalls (1015-1048) to the existing loadState. This keeps the existing beforePersist check as a second line of defense. Do not "fix" by reverting the serving stamp in the !saved branch — preventing the CAS on a known-stale projection is cleaner and avoids a partial-failure revert path. Note: this only closes the detectable-staleness window (a concurrent version bump observable at apply time); it does not eliminate the inherent TOCTOU between the apply-time read and the CAS, but that residual is already covered by the ownership guard on the CAS.

### Blast radius / caveats
BLAST RADIUS: (1) describeBulkLoadMutationEligibility (cxBulkLoadMutationEligibility.js) and the queue-state adapter markCandidateServing/markAdoptedCandidateServing (cxBulkLoadRuntime.js) are bulk-load-rail specific; cxDialQueueRepository.transitionQueueItemState underneath is a SHARED queue primitive used by the non-bulk rail, but this fix does not touch it — it only adds a guard that may SKIP a call into it, so no shared-write behavior changes. (2) Adding an extra findBulkLoadSessionById read per promoting projection at apply time is one additional Mongo round-trip per watch tick per session that has a current-promotion; acceptable but note it. (3) TEST LOCK: tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js:286-323 ("requires the serving ownership stamp before current promotion") asserts servingAttempts.length === 1 and reason "serving-ownership-stamp-miss". Its projection is fresh (no concurrent version bump) and it injects no loadLatestState, so with the fix gated on `latest` being available it stays green — but if the fix unconditionally loads latest via a default repo stub, that test's sessionRepository has no findBulkLoadSessionById and must tolerate its absence (guard with typeof check / optional chaining) or the test breaks. Keep loadLatestState optional and default to null. (4) No existing test currently locks the apply-time-vs-version-guard ordering or exercises a stale projection through the watcher, so the bug is presently uncovered.

### Test to lock it
Add a watcher unit test in tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js: build a session with a required currentPromotion whose projection.before.__v is N, inject loadLatestState (or a sessionRepository.findBulkLoadSessionById) returning the same session with __v = N+1 (simulating a concurrent mutation), and a queueStateAdapter.markCandidateServing spy. Assert: markCandidateServing was NEVER called (servingAttempts.length === 0), updateBulkLoadSession was NEVER called, and result.applied.skipped[0].reason === "stale-projection-apply". A second test should confirm the happy path (latest.__v === before.__v) still fires the CAS exactly once and writes, guarding against over-blocking.

---

## #11 — Appointment-wrap commits Logics appointment outside the session lock; a concurrent watcher tick clearing state.current makes the terminal no-op (missing-current) and the wrap returns ok:false without resuming dialing — appointment already committed

**Severity:** major · **Status (re-verified):** OPEN

**Location:** packages/shared-services/src/cxBulkLoadRuntime.js:1216 (unlocked session read), :1262-1291 (appointment create), :1299-1314 (workbench), :1340-1365 (Logics post-date), :1367-1390 (terminal via submitCxBulkLoadDisposition); packages/shared-services/src/cxBulkLoadRuntimeService.js:644-664 (missing-current early return), :305-331 (withSessionMutation/markBusy serializer), :1030 (watcher skipSessionIds = busySessionCounts.keys()); packages/shared-services/src/cxAccountActiveCallWatcherService.js:443-456 (busy-skip), :194-207 (current.released clears state.current)

### Mechanism
submitCxBulkLoadAppointmentWrap runs the entire Logics-mutating sequence OUTSIDE the per-session serializer. The session is fetched by a plain read (resolveOwnedBulkSession -> findOwnedBulkLoadSession / findActiveBulkLoadSessionForAgent, no lock, no markBusy). It then performs multi-second remote calls — createCxAppointment (the actual Logics appointment commit), executeCxAppointmentWorkbenchActions, optional requestCxAssignCaseToMe, and optional executeCxLogicsUpdateCase(status:'post-date') — none of which mark the session busy. Only afterward does it call submitCxBulkLoadDisposition, which is the FIRST point the session enters busySessionCounts (withSessionMutation -> withSessionOperation markBusy:true) so the watcher would skip it. During the long unlocked window the session is NOT in busySessionCounts, so a concurrent runCxAccountActiveCallWatchOnce tick does not skip it (busy-skip at watcher 443-456 only fires for ids in skipSessionIds, which come from busySessionCounts.keys() at service 1030). If RingCX reports the agent's active call released, the watcher reduces current.released (watcher 194-207) and persists a session with state.current === null. When the wrap finally calls submitCxBulkLoadDisposition, loadState now returns a session with no current, so the early return at service 650-664 fires: dispositionOk:false, terminal {ok:false, executed:false, reason:'missing-current-call'}, nothing sent to RingCX. Back in the runtime the terminal step maps dispositionOk:false (1380), so result.terminal.dispositionOk !== true at 1394 sets result.ok=false and returns at 1400, SKIPPING resumeCxBulkLoadProgressiveDialing (1403). Net partial commit: the Logics appointment (and workbench/assign/post-date) are already committed, but the bulk rail neither records a terminal outcome for the lead nor resumes progressive dialing — caller sees ok:false and the wrap looks failed despite the irreversible Logics write.

### Current code
```js
// cxBulkLoadRuntime.js:1213-1217 — plain unlocked read, never marks session busy
async function submitCxBulkLoadAppointmentWrap(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const session = await resolveOwnedBulkSession(input, agent);
  if (!session) return null;

// cxBulkLoadRuntime.js:1479-1482 — resolveOwnedBulkSession is a plain repo read, no lock/markBusy
async function resolveOwnedBulkSession(input = {}, agent = {}) {
  if (input.sessionId) return findOwnedBulkLoadSession(input.sessionId, agent);
  return cxBulkLoadSessionRepository.findActiveBulkLoadSessionForAgent(agent);
}

// cxBulkLoadRuntime.js:1262-1264 — Logics appointment committed while session is NOT busy
  const appointmentStep = await safeBulkAppointmentStep(
    () => createCxAppointment(domain, options.user || {}, {
      caseId: resolvedCaseId,

// cxBulkLoadRuntime.js:1299-1300 — workbench actions, still unlocked
  result.workbench = await safeBulkAppointmentStep(
    () => executeCxAppointmentWorkbenchActions(domain, options.user || {}, appointmentResult),

// cxBulkLoadRuntime.js:1341-1348 — optional Logics post-date update, still unlocked
    result.postdate = await safeBulkAppointmentStep(
      () => executeCxLogicsUpdateCase(domain, options.user || {}, {
        caseId: resolvedCaseId,
        CaseID: resolvedCaseId,
        status: "post-date",
        skipQueueFinalize: true,
        notes: input.note,
      }),

// cxBulkLoadRuntime.js:1367-1372 — only NOW does it enter the serializer (via submitCxBulkLoadDisposition)
  result.terminal = await safeBulkAppointmentStep(
    () => submitCxBulkLoadDisposition({
      sessionId: session.sessionId,
      disposition: "answered",
      notes: input.note,
    }, options),

// cxBulkLoadRuntime.js:1394-1401 — dispositionOk!==true => ok:false, RETURN, resume skipped
  if (result.terminal.dispositionOk !== true) {
    result.ok = false;
    result.resume = {
      skipped: true,
      reason: result.terminal.reason || result.terminal.error || "terminal-rejected",
    };
    return result;
  }

// cxBulkLoadRuntimeService.js:644-664 — the missing-current early return (nothing sent to RingCX)
  async function submitCxBulkLoadDisposition(input = {}) {
    return withSessionMutation(input.sessionId, async () => {
    const _step = createDispositionTrace("runtime");
    _step("ENTER", { sessionId: input.sessionId, disposition: input.disposition });
    const state = await loadState(input.sessionId);
    _step("loadState DONE", { hasState: Boolean(state), hasCurrent: Boolean(state && state.current) });
    if (!state || !state.current) {
      _step("RETURN early — no state/current (NOTHING SENT TO RINGCX)");
      ...
      return {
        ...sanitizeSession(state),
        dispositionOk: false,
        terminal: { ok: false, executed: false, reason: state ? "missing-current-call" : "missing-session" },
      };
    }

// cxBulkLoadRuntimeService.js:305-331 — markBusy is the watcher-skip signal; only set inside withSessionMutation
  async function withSessionOperation(sessionId, work, { markBusy = false } = {}) {
    const key = str(sessionId);
    if (!key) return work();
    const prior = sessionOperationTails.get(key) || Promise.resolve();
    if (markBusy) addBusySession(key);
    ...
  }
  async function withSessionMutation(sessionId, work) {
    return withSessionOperation(sessionId, work, { markBusy: true });
  }

// cxBulkLoadRuntimeService.js:1030 — watcher's skip set is exactly the busy set
      skipSessionIds: Array.from(busySessionCounts.keys()),

// cxAccountActiveCallWatcherService.js:443-456 — busy sessions are skipped; non-busy ones get mutated
  for (const session of allSessions) {
    const sessionId = str(session?.sessionId);
    if (sessionId && busySessionIds.has(sessionId)) {
      busySkipped.push({ ... reason: "session-busy" });
      continue;
    }
    sessions.push(session);
  }

// cxAccountActiveCallWatcherService.js:202-207 — watcher clears current via current.released
    next = reduce(next, {
      type: "current.released",
      ...
      reason: "ringcx-current-released",
      reviewHoldReason: "ringcx-current-released",
```

### Proposed fix
Hold the per-session serializer (markBusy) across the WHOLE wrap so a concurrent watcher tick is skipped while the Logics appointment is being committed, and re-validate current before the irreversible commit. Concretely: wrap the body of submitCxBulkLoadAppointmentWrap inside the service's withSessionMutation for session.sessionId (expose a runtime entry that runs the appointment+workbench+postdate+terminal sequence inside one withSessionMutation), so the session is in busySessionCounts for the full duration and the watcher's busy-skip (watcher 443-456) prevents it from clearing state.current. Because submitCxBulkLoadDisposition itself also calls withSessionMutation, switch the inner terminal call to the non-marking/inner service method (or refactor the disposition core out of its own withSessionMutation) to avoid the serializer self-deadlocking on the same sessionId (sessionOperationTails chains the inner call AFTER the outer, which would hang). Minimal alternative if a full refactor is too large for this pass: BEFORE calling createCxAppointment, re-load the session inside withSessionMutation and assert state.current still matches resolvedCaseId/current; abort with a clear pre-commit error if current is already gone — this closes most of the window by validating-then-committing under the lock, though the Logics call itself should still execute under the held busy flag to fully eliminate the race. Either way the goal: no Logics appointment commit while the session is mutable by the watcher, and if current is lost the wrap must surface the partial-commit explicitly (appointment committed, terminal/resume deferred) rather than returning a bare ok:false.

### Blast radius / caveats
BLAST RADIUS: (1) Self-deadlock hazard — submitCxBulkLoadDisposition already wraps in withSessionMutation; nesting the whole wrap in withSessionMutation for the same sessionId would chain the inner disposition after the outer tail in sessionOperationTails (service 308-321) and hang. The fix MUST route the inner terminal through a non-re-locking path. (2) Shared service: executeCxLogicsUpdateCase / createCxAppointment / executeCxAppointmentWorkbenchActions are general Logics/CX helpers used by the NON-bulk rail too — do NOT change their internals; the lock must be added only around the bulk-wrap call site. (3) submitCxBulkLoadDisposition and the watcher are shared by the normal dialing flow; changing the disposition's own locking could affect every disposition, so prefer adding the outer lock at the wrap level and calling an inner (already-locked-context) disposition core rather than altering submitCxBulkLoadDisposition's public locking. (4) Tests that LOCK current disposition behavior — cxBulkLoadRuntimeService.test.js:351-369 ('a rejected dispositionCall never completes the lead') and :371-388 ('a thrown dispositionCall leaves current retryable') assert dispositionOk:false with current STILL PRESENT on RingCX-side failures; they do not exercise the appointment-wrap or the missing-current early return, so the proposed fix should not break them, but any refactor of submitCxBulkLoadDisposition's locking/return shape must keep these green. (5) submitCxBulkLoadAppointmentWrap currently has ZERO test coverage (cxBulkLoadRuntime.js is the untested live route boundary per the audit), so there is no regression net for the wrap itself — add a test (see test field) alongside the fix.

### Test to lock it
Add a service+runtime integration test for submitCxBulkLoadAppointmentWrap (none exists today): start a session, sync one active call so state.current is set, stub createCxAppointment to succeed but, while it is awaiting, fire a concurrent watcher tick (runCxAccountActiveCallWatchOnce) whose live-calls show the current call released — assert that with the fix the watcher SKIPS the session (busySkipped reason 'session-busy') so state.current survives, the terminal disposition executes (dispositionOk:true), and resume runs (result.resume.ok true). Add a second test asserting the partial-commit guard: if current is forcibly cleared before the appointment commit, the wrap must NOT silently return ok:false after committing the Logics appointment — it must either abort before createCxAppointment or surface an explicit appointment-committed-terminal-deferred result. Also add a regression test that the wrap never deadlocks (completes within timeout) given the nested-lock fix.

---

## #12 — Reconciler evidence helper hand-rolls only the UII-bearing idemKey shape, so a no-UII terminal outbox row is missed and the reconciler RE-DIALS a terminally dispositioned lead

**Severity:** major · **Status (re-verified):** OPEN

**Location:** apps/control-plane/src/server.js:182-204 (cxBulkTerminalEvidenceKeys / hasCxBulkTerminalEvidence); reconciler branch packages/shared-services/src/cxReservationReconcilerService.js:76-87; canonical builder packages/shared-services/src/cxBulkLoadOutcomeAdapter.js:30-41; exact $in lookup packages/shared-repositories/src/cxTerminalOutboxRepository.js:44-45. (Prior-sweep line numbers ~182-197 / ~30-40 / ~44-45 verified accurate.)

### Mechanism
CONFIRMED. The reconciler asks `terminalEvidence(adopted)` and on true FORCE-COMPLETES the dangling reserved lead, on false RELEASES it back to `ready` (re-dial). `terminalEvidence` is `hasCxBulkTerminalEvidence`, which builds candidate keys with `cxBulkTerminalEvidenceKeys` and looks them up via `findByIdemKeys` — an EXACT `idemKey: { $in: keys }` match (no prefix/regex). The helper only ever emits `${queueItemId}:${uii}` (and returns [] when there is no queueItemId). But the SINGLE writer of the terminal outbox row keys it with the canonical `makeOutcomeIdemKey`, whose no-UII terminal branch returns `${sessionId}:${qid}:terminal` (and the no-qid branch `${sessionId}:uii:${u}` / `${sessionId}:case:${caseKey}:terminal`) — shapes the helper never reproduces. A no-UII terminal write IS reachable in production: skipCxBulkLoadCurrent (cxBulkLoadRuntimeService.js:746-752, source 'skip') and killCxBulkLoadSession's in-flight terminalize (cxBulkLoadRuntimeService.js:998-1008, source 'manual-reset') both call persistTerminalOutcome with `candidate: state.current`, and `state.current.uii` may be null (a lead published/serving but awaiting a UII, or skipped before connect). Those writes land an outbox row keyed `${sessionId}:${qid}:terminal`. When the control-plane reconciler later sweeps that same row (still `claimed`, owning session not live), `cxBulkTerminalEvidenceKeys` finds no UII on the row (uiis array empty) -> returns [] -> hasCxBulkTerminalEvidence returns false (keys.length 0 short-circuit at line 201) -> the reconciler takes the `else` branch and RELEASES the lead back to `ready`. A lead that was already terminally dispositioned (and may have been DNC-stopped) gets re-queued for dialing. Even where a UII exists on the row, if the outbox row was the no-qid `${sessionId}:uii:${u}` shape the exact-match helper still misses it. Net: a complete-vs-release inversion driven purely by idemKey-shape divergence.

### Current code
```js
// apps/control-plane/src/server.js:182-204  (hand-rolled key builder + evidence gate)
function cxBulkTerminalEvidenceKeys(row = {}) {
  const queueItemId = String(row?._id || row?.queueItemId || "").trim();
  if (!queueItemId) return [];
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const uiis = [
    row.uii,
    metadata.lastQueueAttemptUii,
    metadata.lastDialExecutionUii,
    metadata.lastRingcxActiveCall?.uii,
    metadata.lastRingcxActiveCall?.callId,
    metadata.lastRingcxActiveCall?.sessionId,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(uiis.map((uii) => `${queueItemId}:${uii}`))];
}

async function hasCxBulkTerminalEvidence(row = {}) {
  const keys = cxBulkTerminalEvidenceKeys(row);
  if (!keys.length) return false;
  const rows = await cxTerminalOutboxRepository.findByIdemKeys(keys);
  return Array.isArray(rows) && rows.length > 0;
}

// packages/shared-services/src/cxBulkLoadOutcomeAdapter.js:30-41  (canonical builder — shapes the helper never reproduces)
function makeOutcomeIdemKey({ sessionId, queueItemId, uii = null, caseId = null, eventType = "terminal" } = {}) {
  const qid = str(queueItemId);
  const u = str(uii);
  const kind = str(eventType) || "terminal";
  if (u) {
    const base = qid ? `${qid}:${u}` : `${str(sessionId)}:uii:${u}`;
    return kind === "terminal" ? base : `${base}:${kind}`;
  }
  const caseKey = str(caseId);
  if (!qid && caseKey) return `${str(sessionId)}:case:${caseKey}:${kind}`;
  return `${str(sessionId)}:${qid}:${kind}`;   // <-- no-UII terminal shape the helper can't match
}

// packages/shared-services/src/cxReservationReconcilerService.js:76-87  (release-vs-complete branch driven by hasEvidence)
      try {
        if (hasEvidence) {
          await cxCadenceService.completeCxQueueItem({
            queueItemId: adopted?._id || row._id,
            queueOutcome: "reservation-reconciled-terminal",
            actorEmail: "system:reservation-reconciler",
          });
          result.completed += 1;
        } else {
          await cxQueueReservationService.releaseReserved([adopted], "reservation-reconciler:session-gone");
          result.released += 1;
        }

// packages/shared-repositories/src/cxTerminalOutboxRepository.js:44-45  (EXACT $in — no prefix match)
  const rows = await CxTerminalOutbox.find(
    { idemKey: { $in: keys } },
```

### Proposed fix
Make the helper reproduce EVERY shape the single writer can produce, by delegating to the canonical builder instead of hand-rolling. In server.js import the canonical builder: `const { makeOutcomeIdemKey } = require("../../../packages/shared-services/src/cxBulkLoadOutcomeAdapter");` (it is NOT currently imported, and is not re-exported by the shared-services barrel, so import the module directly — same pattern cxTerminalRectificationService.js:8/70 already uses). Then rebuild cxBulkTerminalEvidenceKeys to emit, for the row's sessionId/queueItemId/caseId and each candidate UII (including the empty/no-UII case): makeOutcomeIdemKey({ sessionId, queueItemId, uii, caseId, eventType:"terminal" }) for each uii in the candidate list PLUS one call with uii=null. Concretely: derive `sessionId = String(row?.metadata?.reservationSessionId || row?.sessionId || "").trim()`, keep the existing queueItemId + uiis collection, then `const keys = new Set(); for (const u of [...uiis, null]) keys.add(makeOutcomeIdemKey({ sessionId, queueItemId, uii: u, caseId: row.caseId, eventType: "terminal" })); return [...keys].filter(Boolean);`. Drop the `if (!queueItemId) return []` early-return so a no-qid/UII or no-qid/caseId row can still match its `${sessionId}:uii:${u}` / `${sessionId}:case:${caseKey}:terminal` key. This guarantees the lookup set is a superset of whatever makeOutcomeIdemKey wrote, so a terminally dispositioned lead is force-completed, never re-dialed. Do NOT instead loosen findByIdemKeys to a prefix/regex match — that would weaken the exact-key dedup the outbox relies on and is shared with the rectification service.

### Blast radius / caveats
BLAST RADIUS: (1) The helper cxBulkTerminalEvidenceKeys / hasCxBulkTerminalEvidence lives ONLY in apps/control-plane/src/server.js — it is not a shared service and the slow/legacy non-bulk rail does not consume it; the terminal outbox itself is `rail: "bulk_load"` (CxTerminalOutbox.js:17, runtime writes rail:"bulk_load"), so this fix does not touch the non-bulk dialing path. (2) NO test locks the current helper shape: the only reconciler test, tests/cx-bulk-load/cxReservationReconcilerService.test.js, injects a FAKE terminalEvidence (`r?.metadata?.hasTerminal`) and never exercises the real key builder; cxBulkTerminalEvidenceKeys/hasCxBulkTerminalEvidence have ZERO direct unit coverage — so broadening the key set breaks nothing existing (it is also a behavior-fix, not a behavior-lock change). (3) findByIdemKeys at cxTerminalOutboxRepository.js:37-56 is SHARED with cxTerminalRectificationService.js:259 — leave that function exact-match; the fix is confined to the caller-side key set, so the rectifier is unaffected. (4) Corroborating intent: the sibling consumer cxTerminalRectificationService.js already imports and delegates to makeOutcomeIdemKey (lines 8, 65-70) rather than hand-rolling — the reconciler helper is the lone divergent builder, which is exactly the smell this finding flags. (5) Severity major not blocker: the inverted outcome is a RELEASE (re-dial) of an already-dispositioned lead, a real DNC/compliance + double-dial hazard, but it only triggers on the no-UII terminal subset (skip / kill-manual-reset) AND only for rows the reconciler sweeps at startup (claimed + owning session not live); the common dispositioned-with-UII path keys/matches correctly.

### Test to lock it
Add a unit test for the real helper (currently untested). Arrange: insert a CxTerminalOutbox row with idemKey = makeOutcomeIdemKey({ sessionId:"S1", queueItemId:"Q1", uii:null, eventType:"terminal" }) === "S1:Q1:terminal" (i.e. a skip/manual-reset terminal). Build a queue row { _id:"Q1", metadata:{ reservationSessionId:"S1" } } with NO uii anywhere. Assert hasCxBulkTerminalEvidence(row) === true (today it returns false because cxBulkTerminalEvidenceKeys yields [] / only "Q1:<uii>" shapes). Add a second case: outbox row keyed "S1:uii:U9" (no-qid UII shape) with a queue row carrying metadata.lastQueueAttemptUii="U9" and missing _id/queueItemId -> assert true (today false via the `if (!queueItemId) return []` early-return). Also add a reconciler-level integration test wiring the REAL terminalEvidence against an in-memory outbox to assert a no-UII dispositioned dangling row is force-COMPLETED (result.completed === 1) rather than RELEASED (result.released === 0). Keep the existing 8 cxReservationReconcilerService.test.js cases green (they use a fake terminalEvidence and are untouched).

---

## #13 — renewReserved is dead code: reservation lease stamped once at claim time and never renewed (no production callers)

**Severity:** minor · **Status (re-verified):** OPEN

**Location:** packages/shared-services/src/cxQueueReservationService.js:137-158 (renewReserved); export at :179. Supporting: cxBulkLoadRuntimeService.js:20-22 (lease-length comment that falsely implies a renewing watch tick) + :420 (claimMinutes stamped once); cxDialQueueRepository.js:122-158 (buildExpiredClaimRequeueQuery reaper EXCLUDES reserved rows) + :428-447 (renewClaim, only ever called by the dead renewReserved).

### Mechanism
CONFIRMED. renewReserved exists, is exported, and is fully unit-tested, but has ZERO production callers. A repo-wide grep for `renewReserved` returns only: its own definition (cxQueueReservationService.js:141), the build-plan comment (:12,:137), the dep-guard error string (:143), the export (:179), and four tests in tests/cx-bulk-load/cxQueueReservationService.test.js. Its delegate `renewClaim` is likewise only invoked from inside renewReserved (cxQueueReservationService.js:154) and a test fake — no rail, watch tick, runtime, runtime-service, or control-plane file calls either. The runtime sequencer cxBulkLoadRuntimeService.js injects and uses reservationService.reserveFromFamilyOrder (:413), releaseReserved (:350,:364,:994), and listReservedForSession (:983) — but never renewReserved. Consequence: at reserve time the lease is stamped ONCE (claimUntil + metadata.reservationExpiresAt via reserveReadyRows; claimMinutes default DEFAULT_RESERVE_CLAIM_MINUTES=10 at cxBulkLoadRuntimeService.js:22,:420) and is never heartbeated. This is NOT a double-dial risk: buildExpiredClaimRequeueQuery (cxDialQueueRepository.js:122-158) HARD-excludes any row carrying metadata.reservationSessionId (the $or at :141-147), so a stale-lease reserved row is invisible to the global reaper 'regardless of lease age' (its own comment, :138-140) and is only freed by an explicit releaseReserved or the crash reconciler. So the gap is correctness/observability, not safety: claimUntil/reservationExpiresAt become permanently stale audit values, and the comment at cxBulkLoadRuntimeService.js:20-22 ('10 min gives the bulk watch tick ample room to renew before the lease lapses') describes a renewal tick that does not exist.

### Current code
```js
// packages/shared-services/src/cxQueueReservationService.js:137
  // renewReserved (M2 §3.2) — heartbeat the lease for rows still held in the rail's buffer.
  // Delegates to the repo guarded CAS, grouping ids by reservationSessionId so a stray
  // foreign-session row can never be renewed under the wrong owner. Returns the ids actually
  // renewed; the caller drops the rest (serving / reaped / re-owned) from its heartbeat set.
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

// packages/shared-services/src/cxQueueReservationService.js:175  (export — renewReserved present but no production importer calls it)
  return {
    reserveFromFamilyOrder,
    listReservedForSession,
    releaseReserved,
    renewReserved,
    newSessionId: () => randomUUID(),
  };

// grep -rn 'renewReserved' --include='*.js' . | grep -v node_modules
//   cxQueueReservationService.js:12   (build-plan comment)
//   cxQueueReservationService.js:137  (doc comment)
//   cxQueueReservationService.js:141  (definition)
//   cxQueueReservationService.js:143  (error string)
//   cxQueueReservationService.js:179  (export)
//   tests/cx-bulk-load/cxQueueReservationService.test.js:197,200,215,218,227,231,238,242  (tests only)
//   -> NO runtime / runtime-service / control-plane / rail caller

// packages/shared-services/src/cxBulkLoadRuntimeService.js:20  (comment implies a renewing watch tick that does not exist)
// M4: reservation lease length. Must be ≥ renewal-interval·2 (G3a); 10 min gives the bulk
// watch tick ample room to renew before the lease lapses.
const DEFAULT_RESERVE_CLAIM_MINUTES = 10;

// packages/shared-repositories/src/cxDialQueueRepository.js:138  (reaper excludes reserved rows -> stale lease is harmless, but also never reclaimed)
      // M2 §3.1 — HARD ownership exclusion: a session-held (reserved) row is invisible to the
      // global reaper, regardless of lease age. Only the owning session (releaseReserved) or the
      // crash reconciler frees it. $exists:false keeps current non-reserved rows reaped as before.
      {
        $or: [
          { "metadata.reservationSessionId": { $exists: false } },
          { "metadata.reservationSessionId": null },
          { "metadata.reservationSessionId": "" },
        ],
      },
```

### Proposed fix
Pick ONE, do not silently leave it half-wired. (a) If lease-renewal is genuinely intended for the bulk rail: wire a heartbeat call into the runtime watch tick that already runs every poll — collect the still-buffered claimed rows for the session and call reservationService.renewReserved(rows, claimMinutes) on each tick, using the same DEFAULT_RESERVE_CLAIM_MINUTES the reserve path uses, and drop from the buffer any id renewReserved does NOT return (it already filters serving/reaped/re-owned rows). This makes claimUntil/reservationExpiresAt accurate again. (b) If renewal is deliberately deferred / unnecessary because the reaper already excludes reserved rows (the current de-facto design): then renewReserved + renewClaim are dead M2 scaffolding — either leave them with an explicit `// UNWIRED: lease is single-shot; reaper excludes reserved rows by ownership, so no heartbeat is needed (M2 §3.2 deferred)` banner on both, AND correct the misleading cxBulkLoadRuntimeService.js:20-22 comment so it no longer claims 'the bulk watch tick [renews] before the lease lapses'. The minimal reviewer-correct change for THIS finding (since it is classed minor/observability) is (b)-comment-fix: replace the false 'watch tick … renew' wording with the true behavior (single-shot lease; reserved rows are reaper-exempt by ownership), so the next maintainer is not misled into assuming a renewal loop exists.

### Blast radius / caveats
SHARED SERVICE — blast radius beyond bulk-load: createCxQueueReservationService is the ONE shared instance injected into multiple rails (file header :3-5). reserveFromFamilyOrder/releaseReserved are also called by cxSlowLaneService.js (:628,:640,:648) and cxReservationReconcilerService.js (:72,:85). So option (a) — actually wiring renewal — changes lease semantics for rows reserved by the slow-lane rail too, not just bulk; it must be wired in a rail-specific watch tick (bulk runtime only), NOT inside the shared service, or the slow lane silently gains a heartbeat it was never designed around. TEST-LOCK: four tests (cxQueueReservationService.test.js:197,215,227,238) assert renewReserved's internal grouping/skip/CAS-filter/dep-guard behavior. They test the function in isolation with a fake repo — they do NOT lock any production wiring, so they will NOT break if you add a caller. But they DO mean any refactor that deletes renewReserved/renewClaim (option b-delete) must also delete these four tests and the fakeRepo.renew plumbing (test :26) or `node --test tests/cx-bulk-load/*.test.js` goes red. The comment-only fix (recommended for a minor finding) touches no test.

### Test to lock it
Wiring-verification (option a): add a runtime-service unit test with a fake reservationService spy asserting that a watch/poll tick calls renewReserved with the buffered claimed rows and the session's claimMinutes, and that ids absent from the renewReserved return are dropped from the live buffer. Negative/regression (current behavior): a test asserting the runtime tick currently makes ZERO renewReserved calls would pass today and documents the dead-code state. For option (b) comment-only: no behavioral test; reviewer confirms the corrected comment matches buildExpiredClaimRequeueQuery's ownership-exclusion (cxDialQueueRepository.js:138-147) and that grep shows still-zero production callers.

---

## Codex Confirmation Pass - 2026-06-29

This pass treats the findings as a code review against the current `release/0.2.0-alpha` tree. The short version: most findings are grounded. The one I would downgrade is #13, because it is a misleading/dead-code cleanup rather than a functional pilot blocker. #4 is real, but I would sharpen the wording: the dangerous case is not simply "already drained returns success"; current code can return `ok:false` when the row is already drained. The real product defect is that a post-call review/DNC correction has no guaranteed rectification lane once the primary terminal row has been consumed.

| Finding | Verdict | Fix priority | Codex assessment |
| --- | --- | --- | --- |
| #1 contact-blocked reserved ghost | Confirmed | Blocker | Enforced contact eligibility can drop a candidate without releasing or cancelling the reserved queue row. This can strand a claimed row forever. |
| #2 racy per-agent start | Confirmed | Blocker | `withSessionMutation(sessionId)` protects a new session id, not the stable agent identity. There is also no DB-level one-running-session-per-agent backstop. |
| #4 review outcome vs drain race | Confirmed with wording adjustment | Blocker for DNC correctness | The row mutation model is fragile. A review/DNC correction should not depend on mutating a pending terminal row that the drain may already be processing. |
| #5 stale release verification | Confirmed | Major | `confirmRingcxUiiReleased` can report a stale still-active snapshot after later poll errors. That is not a reliable release proof. |
| #6 watcher `__v` miss loses release | Confirmed | Major | Version miss drops projected release work instead of re-reading and retrying against the latest session state. |
| #7 terminal write dropped on serving CAS miss | Confirmed | Major | Terminal observation for the departing call can be skipped if the incoming candidate's serving stamp misses. These are separate concerns. |
| #8 outbox outage double fault | Confirmed | Major | RingCX disposition can succeed, then persistence can fail, leaving state at `terminal.started` and the call uncounted. |
| #10 serving stamp before latest-aware guard | Mostly confirmed | Major | This overlaps #6/#7. The watcher can stamp queue ownership before the final latest-state guard succeeds, which can leave serving/wrap markers without the corresponding session state. |
| #11 appointment wrap outside session lock | Confirmed, mitigated but not solved | Major | The busy-session watcher skip lowers the race odds, but appointment wrap still commits external Logics work before the terminal/session-owned path is locked and verified. |
| #12 no-UII terminal evidence mismatch | Confirmed | Major | The reconciler evidence helper does not use the same idem-key shapes as the outcome adapter, so no-UII terminal outbox rows can be missed. |
| #13 `renewReserved` dead code | Confirmed, downgraded | Minor cleanup | The function is unwired, but reserved rows are explicitly reaper-exempt. This is misleading documentation/dead scaffolding, not a current double-dial safety defect. |

### Required fixes

1. Fix reserved-row finality before any floor pilot.
   - Add a narrow cancellation path for reserved rows, for example `reservationService.cancelReserved(rows, reason)`.
   - Implement it with guarded `transitionQueueItemState` calls that match the owning `metadata.reservationSessionId`.
   - In the contact-blocked/enforced branch, cancel the row as `blocked`/terminal for queue purposes instead of leaving it claimed and invisible.
   - Do not release blocked rows back to `ready`.

2. Make session start atomic by agent, not by new session id.
   - Change the start lock key to a stable agent identity, for example `bulk-start:${normalizedAgentEmail || agentExtensionId}`.
   - Add a DB unique backstop for one running bulk session per agent. Prefer a partial unique index on `agentEmail` and/or `agentExtensionId` where `status: "running"`.
   - Handle duplicate-key errors by reloading the active session and returning/recovering intentionally, not by creating another session.

3. Split rectification/review outcomes from the primary terminal row.
   - Do not mutate a terminal row that the drain may already be processing.
   - Insert a separate rectification outbox row, such as `review-dnc` or `terminal-correction`, keyed by `sessionId`, `queueItemId`, `uii`, and requested outcome.
   - Let the same drain machinery process that correction idempotently.
   - This gives DNC/appointment corrections a guaranteed lane even after the auto-disposition row has drained.

4. Make release verification truthful.
   - Treat a poll error after seeing the active call as `inconclusive`, not confirmed still-active.
   - Require a final successful read before returning still-active or released.
   - Add one bounded final retry on transient error, then return an explicit retryable status if still inconclusive.

5. Make watcher projection retryable and separate terminal from serving.
   - On session `__v` miss, re-read the session and retry the projection once or twice using the same RingCX snapshot.
   - Persist terminal observations even if candidate serving/adoption CAS fails.
   - Move latest-state/staleness checks ahead of serving-stamp writes, or perform serving stamp only inside a latest-session apply step.
   - If a serving stamp succeeds but session persistence fails, either retry the session write or explicitly undo/release the stamp.

6. Harden terminal persistence after RingCX disposition succeeds.
   - Wrap `outcomeAdapter.persistTerminalOutcome` and fallback dispatch so persistence failure becomes structured state, not an exception that leaves `terminal.started`.
   - After RingCX confirms disposition, move the session to a finished/replay-required terminal state even if Mongo/outbox persistence fails.
   - Mark the call for replay/reconciliation instead of keeping it as current.

7. Move appointment wrap session-owned work under one mutation boundary.
   - Extract a lock-free internal disposition core, for example `submitDispositionLocked`, so appointment wrap can call it without nested locks.
   - Under the session lock, verify the current call identity before and after external appointment work.
   - If Logics appointment succeeds but the current call changed before terminal, return a structured `appointmentCommittedTerminalDeferred` result and enqueue a rectification/replay row.
   - Keep the UI informed of which step succeeded, failed, or needs recovery.

8. Reuse the outcome adapter's idem-key builder in the reconciler.
   - Import or share `makeOutcomeIdemKey` instead of hand-building only `queueItemId:uii`.
   - Check both UII and no-UII terminal key shapes.
   - Add a regression test where a no-UII terminal outbox row prevents re-dial.

9. Clean up `renewReserved` truth-in-code.
   - If renewal is intended, wire it only from the owning rail's watch tick and test that buffered rows are renewed.
   - If renewal is not intended for this pilot, leave behavior alone and correct the misleading comment in `cxBulkLoadRuntimeService.js` that implies a heartbeat exists.
   - Do not add a shared-service heartbeat that silently changes slow-lane behavior.

## Simplification concepts for implementation

These are compact patterns to keep fixes minimal and safe:

1) Narrow reserved-row finality (`#1`)
- Introduce one new API `cancelReserved(rows, reason)` in reservation service.
- On blocked-contact branches, call cancel directly and transition to terminal/blocked state with owner check (`metadata.reservationSessionId` + session ownership guard).
- Keep behavior minimal: no path returns blocked rows to `ready`.

2) Session start atomicity (`#2`)
- Change lock key from per-session to stable identity: `bulk-start:{normalizedAgentEmail || agentExtensionId}`.
- Add one partial unique index for `status: "running"` per agent identity.
- Handle duplicate-key errors by loading existing running session and returning/recovering that session instead of creating a second.

3) Separate rectification lane (`#3`)
- Stop mutating the primary terminal row for review/DNC corrections.
- Emit a `review-dnc`/`terminal-correction` outbox row keyed with `(sessionId, queueItemId, uii?, outcome)` and process through existing drain/replay.
- Keep terminal row immutable once it is in flight to drain.

4) Truthful release checks (`#4`)
- Return explicit states from `confirmRingcxUiiReleased`: `released | active | inconclusive`.
- On poll errors after seeing active state, return `inconclusive` and run one bounded final retry before surfacing.
- Never conclude active from stale earlier reads.

5) Watcher projection safety (`#5` / `#6` / `#10`)
- On session `__v` miss, reload session and retry projection at least once with the same RingCX snapshot.
- Persist terminal observation separately from serving CAS; terminal outcome must not be dropped.
- Move latest-state validation before serving stamp writes, or write serving stamp inside the same guarded persistence apply.

6) Persistence after successful disposition (`#8`)
- Treat outcome persistence as terminal outcome state, not an all-or-nothing throw.
- After RingCX success, persist a finished/replay-required terminal state even if Mongo/outbox writes fail.
- Persist recoverability metadata so reconciler can pick up the row without leaving `terminal.started`.

7) Appointment wrap under one owned path (`#11`)
- Add `submitDispositionLocked` as the single internal disposition writer.
- Appointment wrap calls that path, while verifying call identity before/after external appointment work.
- Emit structured partial result + recovery row when Logics succeeded but terminal write could not be finalized.

8) Shared idem-keying (`#12`)
- Move `makeOutcomeIdemKey` into a shared util and use it everywhere outcome rows are generated/checked.
- Reconcile both UII and no-UII key shapes through that same helper.

9) `renewReserved` cleanup (`#13`)
- Choose one explicit mode and code it:
  - A) wire renewal in bulk watch tick only and add a watcher test, or
  - B) keep no heartbeat and update comments/docs to remove “watch tick renew” claims.
- Avoid touching shared service heartbeat behavior so slow-lane rail semantics stay unchanged.

### Fix order

1. #1, #2, #12 first. These are clean, bounded, and prevent obvious wrong-row/session corruption.
2. #6, #7, #10 next as one watcher transaction cleanup. These are the same family: terminal, serving, and session persistence must not be half-applied.
3. #8 next, because it defines what happens when RingCX succeeded but app persistence failed.
4. #4 next, because review/DNC correctness should be a separate rectification lane rather than a mutation race.
5. #11 after the terminal/disposition core is cleaner, because appointment wrap should reuse that hardened path.
6. #5 can land independently with tests around transient RingCX read failures.
7. #13 is comment/dead-code cleanup unless we intentionally add renewal.

### Tests I would require

- Contact-blocked enforced lead is cancelled/terminal and never remains claimed/reserved.
- Two concurrent starts for the same agent produce one running session, enforced both by service lock and DB uniqueness.
- Review DNC after drain already consumed the terminal row still creates a rectification row and eventually updates the correct lead/logics state.
- `confirmRingcxUiiReleased` returns inconclusive/retryable on "saw active, then read errors" instead of returning stale still-active.
- Watcher version miss retries projection and still persists the departing terminal observation.
- Serving CAS miss for incoming call does not drop terminal observation for outgoing call.
- RingCX disposition success plus outbox/Mongo failure clears current into replay-required terminal state, not `terminal.started`.
- Appointment wrap external success plus terminal failure returns structured partial status and leaves a recovery row.
- Reconciler detects no-UII terminal outbox evidence and does not re-dial.
- `renewReserved` comment accurately describes whichever behavior we choose.
