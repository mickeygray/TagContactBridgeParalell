# ATTIC — Manual-Dial Lane (`/start-next` side door)

Retired by: WO-3 (2026-07-02) — same fork as WO-2: a current call exists only by RingCX proof.
This lane was the other unproven-current door: it staged `state.current` WITHOUT RingCX
publish proof (`uii:null, manualStartPending:true`) and forced the rail's last PHONE-ONLY
matcher to attach a UII afterward. Zero code callers existed (the client hook was never
imported); a wedged queue recovers through `/get-leads` (the surviving hatch, on the
DO-NOT-CUT list).

Applied to: `POST /api/cx/bulk-load/start-next` (route), `useCxBulkLoadStartNext` (client hook,
never imported), the manual-start fields on the bulk API types, the UI's
`manualStartPending` button guard, `startCxBulkLoadNextManualCall` (runtime-service mutator),
the runtime's `manualDialer` adapter + `resolveBulkManualDialContext`, and the watcher's
`findManualStartedActiveCall` phone-digit attach (ANI/DNIS match, no agent scoping).

Lived at (at move time): `apps/control-plane/src/routes/cxBulkLoad.js`,
`apps/web-client/src/lib/api/queries/cxBulkLoad.ts`,
`apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx`,
`packages/shared-services/src/cxBulkLoadRuntimeService.js`,
`packages/shared-services/src/cxBulkLoadRuntime.js`,
`packages/shared-services/src/cxAccountActiveCallWatcherService.js`,
`packages/shared-services/src/index.js`, plus the two disabled dedicated tests extracted from
`tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js` and
`tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js`.

Replaced by: RingCX-buffer advancement only (disposition → RingCX advances → watcher proves),
with `/get-leads` as the manual recovery nudge. The active tree keeps ONE remnant: a 3-line
tripwire at the route — `POST /start-next` → `410 { code:"manual-dial-disabled",
use:"/api/cx/bulk-load/get-leads" }` — so muscle-memory callers get the replacement named
instead of a mystery 404.

Revive (the fork says don't): restore the blocks below, re-register the route over the 410
stub, re-export the hook, and consciously remove the negative pins
"WO-3 manual-dial mutator is not exported" (cxBulkLoadRuntimeService.test.js) and
"WO-3 watcher never phone-attaches an active call" (cxAccountActiveCallWatcherService.test.js).
If revived, fix what got it retired: agent-scope the phone attach, require ACTIVE state, and
bound `manualStartPending` with a TTL so it cannot wedge disposition/get-leads.

## packages/shared-services/src/cxBulkLoadRuntimeService.js (lines 1274-1275 at move time)

```js
    // WO-3 pending delete: manual start-next side door disabled.
    // startCxBulkLoadNextManualCall,
```

## packages/shared-services/src/cxBulkLoadRuntimeService.js (lines 1051-1151 at move time)

```js
  // WO-3 pending delete: manual start-next staged current without RingCX proof.
  // async function startCxBulkLoadNextManualCall(input = {}) {
  //   return withSessionMutation(input.sessionId, async () => {
  //   const state = await loadState(input.sessionId);
  //   if (!state) return null;
  //   if (state.status !== "running") {
  //     return {
  //       ...sanitizeSession(state),
  //       manualStart: { ok: false, reason: "session-not-running" },
  //     };
  //   }
  //   if (state.current) {
  //     return {
  //       ...sanitizeSession(state),
  //       manualStart: {
  //         ok: false,
  //         reason: state.current.uii ? "current-call-active" : "current-call-awaiting-uii",
  //         queueItemId: queueItemKey(state.current) || null,
  //       },
  //     };
  //   }
  //   const candidate = firstStartableBufferCandidate(state);
  //   if (!candidate) {
  //     return {
  //       ...sanitizeSession(state),
  //       manualStart: { ok: false, reason: "no-startable-buffer-candidate" },
  //     };
  //   }
  //   if (!manualDialer || typeof manualDialer.startNext !== "function") {
  //     return {
  //       ...sanitizeSession(state),
  //       manualStart: { ok: false, reason: "manual-dialer-unavailable" },
  //     };
  //   }
  //
  //   traceBulkFlow("manual_start.started", state, {
  //     queueItemId: queueItemKey(candidate),
  //     externId: str(candidate.externId) || null,
  //     ringDuration: input.ringDuration || null,
  //   });
  //   const manualStart = await manualDialer.startNext({
  //     session: state,
  //     candidate,
  //     ringDuration: input.ringDuration,
  //   });
  //   if (!manualStart || manualStart.ok === false) {
  //     traceBulkFlow("manual_start.failed", state, {
  //       queueItemId: queueItemKey(candidate),
  //       reason: manualStart?.reason || manualStart?.error || "manual-start-failed",
  //     });
  //     return {
  //       ...sanitizeSession(state),
  //       manualStart: {
  //         ok: false,
  //         reason: manualStart?.reason || "manual-start-failed",
  //         error: manualStart?.error || null,
  //       },
  //     };
  //   }
  //
  //   const startedAt = now();
  //   let next = reduce(state, {
  //     type: "current.matched",
  //     candidate: {
  //       ...candidate,
  //       manualStartPending: true,
  //       manualStartedAt: startedAt.toISOString(),
  //       manualStartSource: "createManualAgentCall",
  //     },
  //     uii: null,
  //     activeCallSummary: {
  //       source: "createManualAgentCall",
  //       elapsedMs: manualStart.elapsedMs || null,
  //     },
  //     matchReasons: ["manual-start-request"],
  //     completePrevious: false,
  //   }, startedAt);
  //   next = {
  //     ...next,
  //     stats: {
  //       ...(next.stats || {}),
  //       lastManualStartAt: startedAt.toISOString(),
  //       lastManualStartQueueItemId: queueItemKey(candidate) || null,
  //       lastManualStartElapsedMs: manualStart.elapsedMs || null,
  //     },
  //   };
  //   await persist(next);
  //   traceBulkFlow("manual_start.accepted", next, {
  //     queueItemId: queueItemKey(candidate),
  //     elapsedMs: manualStart.elapsedMs || null,
  //   });
  //   return {
  //     ...sanitizeSession(next),
  //     manualStart: {
  //       ok: true,
  //       queueItemId: queueItemKey(candidate) || null,
  //       elapsedMs: manualStart.elapsedMs || null,
  //     },
  //   };
  //   });
  // }
```

## packages/shared-services/src/cxBulkLoadRuntimeService.js (lines 344-345 at move time)

```js
    // WO-3 pending delete: manual start-next adapter disabled during bulk-load rewrite.
    // manualDialer = null,
```

## packages/shared-services/src/cxBulkLoadRuntime.js (lines 1764-1765 at move time)

```js
  // WO-3 pending delete: manual start-next side door disabled.
  // startCxBulkLoadNextManualCall,
```

## packages/shared-services/src/cxBulkLoadRuntime.js (lines 1692-1702 at move time)

```js
// WO-3 pending delete: manual start-next side door disabled during bulk-load rewrite.
// async function startCxBulkLoadNextManualCall(input = {}, options = {}) {
//   const agent = await resolveAgentContext(input, options.user || {});
//   assertBulkRuntime(agent);
//   const sessionId = await resolveSessionId(input, agent);
//   if (!sessionId) return null;
//   return getService().startCxBulkLoadNextManualCall({
//     sessionId,
//     ringDuration: input.ringDuration,
//   });
// }
```

## packages/shared-services/src/cxBulkLoadRuntime.js (lines 1203-1235 at move time)

```js
    // WO-3 pending delete: manual start-next adapter disabled for bulk-load.
    // manualDialer: {
    //   async startNext({ session = {}, candidate = {}, ringDuration = null } = {}) {
    //     const destination = firstNonEmpty(candidate.phone);
    //     if (!destination) return { ok: false, reason: "missing-destination" };
    //     const context = await resolveBulkManualDialContext(session);
    //     if (!context.username) return { ok: false, reason: "missing-ringcx-username" };
    //     if (!context.callerId) return { ok: false, reason: "missing-caller-id" };
    //     const startedAt = Date.now();
    //     try {
    //       const response = await client.placeManualCall({
    //         username: context.username,
    //         destination,
    //         callerId: context.callerId,
    //         ringDuration: Number(ringDuration) > 0 ? Number(ringDuration) : 5,
    //       });
    //       return {
    //         ok: response !== false,
    //         elapsedMs: Date.now() - startedAt,
    //         response: response === true ? true : undefined,
    //         usernameSource: context.usernameSource,
    //         callerIdSource: context.callerIdSource,
    //       };
    //     } catch (error) {
    //       return {
    //         ok: false,
    //         elapsedMs: Date.now() - startedAt,
    //         reason: "place-manual-call-failed",
    //         error: error && error.message ? error.message : String(error),
    //       };
    //     }
    //   },
    // },
```

## packages/shared-services/src/cxBulkLoadRuntime.js (lines 482-514 at move time)

```js
// WO-3 pending delete: manual start-next dialing context disabled for bulk-load.
// async function resolveBulkManualDialContext(session = {}) {
//   const account = session.agentExtensionId
//     ? await userAccountRepository.findUserAccountByExtensionId(session.agentExtensionId).catch(() => null)
//     : session.agentEmail
//       ? await userAccountRepository.findUserAccountByEmail(session.agentEmail).catch(() => null)
//       : null;
//   const domain = normalizeDomain(session.domain);
//   const username = firstNonEmpty(
//     account?.metadata?.ringcxUsername,
//     account?.metadata?.ringcxAgentUsername,
//     account?.metadata?.ringcxAgentEmail,
//     account?.metadata?.cxUsername,
//     account?.cxSession?.rcxAgentEmail,
//     account?.cxAuth?.rcUserEmail,
//     account?.email,
//     session.agentEmail,
//     process.env.RINGCX_VOICE_AGENT_EMAIL,
//   );
//   const callerId = firstNonEmpty(
//     account?.metadata?.ringcxCallerId,
//     account?.metadata?.cxCallerId,
//     account?.phone,
//     domain === "WYNN" ? process.env.WYNN_PROSPECT_CONTACT_PHONE : process.env.TAG_CLIENT_CONTACT_PHONE,
//     domain === "WYNN" ? process.env.WYNN_RINGOUT_CALLER : process.env.TAG_RINGOUT_CALLER,
//   );
//   return {
//     username,
//     callerId,
//     usernameSource: username ? "account-or-env" : null,
//     callerIdSource: callerId ? "account-or-env" : null,
//   };
// }
```

## packages/shared-services/src/cxAccountActiveCallWatcherService.js (lines 207-212 at move time)

```js
  // WO-3 pending delete: manual-started phone proof no longer augments relevant calls.
  // const manualStartedCall = findManualStartedActiveCall(session.current, compactCalls);
  // if (manualStartedCall) {
  //   const alreadyIncluded = relevantCalls.some((call) => call.uii && call.uii === manualStartedCall.uii);
  //   relevantCalls = alreadyIncluded ? relevantCalls : [...relevantCalls, manualStartedCall];
  // }
```

## packages/shared-services/src/cxAccountActiveCallWatcherService.js (lines 142-159 at move time)

```js
// WO-3 pending delete: manual start-next phone-only UII fallback is disabled.
// function findManualStartedActiveCall(current = null, compactCalls = []) {
//   if (!current || current.uii || current.manualStartPending !== true) return null;
//   const targetPhone = normalizePhoneDigits(current.phone);
//   if (!targetPhone) return null;
//   const matches = (Array.isArray(compactCalls) ? compactCalls : []).filter((call) => {
//     if (!call?.uii) return false;
//     const ani = normalizePhoneDigits(call.ani);
//     const dnis = normalizePhoneDigits(call.dnis);
//     return ani === targetPhone || dnis === targetPhone;
//   });
//   if (matches.length !== 1) return null;
//   return {
//     ...matches[0],
//     externId: candidateExternId(current) || queueItemKey(current),
//     manualStartMatched: true,
//   };
// }
```

## packages/shared-services/src/index.js (lines 1113-1114 at move time)

```js
  // WO-3 pending delete: manual start-next side door disabled during bulk-load rewrite.
  // startCxBulkLoadNextManualCall,
```

## packages/shared-services/src/index.js (lines 297-298 at move time)

```js
  // WO-3 pending delete: manual start-next side door disabled during bulk-load rewrite.
  // startCxBulkLoadNextManualCall,
```

## apps/control-plane/src/routes/cxBulkLoad.js (lines 72-75 at move time)

```js
  // WO-3 pending delete: manual /start-next staged a current call without RingCX proof.
  // router.post("/start-next", auth.requireAuth, auth.requireUser, async (req, res) => {
  //   return sendBulkCommand(req, res, startCxBulkLoadNextManualCall, (request) => request.body || {});
  // });
```

## apps/control-plane/src/routes/cxBulkLoad.js (lines 12-13 at move time)

```js
  // WO-3 pending delete: manual /start-next side door disabled during bulk-load rewrite.
  // startCxBulkLoadNextManualCall,
```

## apps/web-client/src/lib/api/queries/cxBulkLoad.ts (lines 187-188 at move time)

```ts
// WO-3 pending delete: manual /start-next side door disabled during bulk-load rewrite.
// export const useCxBulkLoadStartNext = buildBulkLoadCommandHook("start-next");
```

## apps/web-client/src/lib/api/queries/cxBulkLoad.ts (lines 46-53 at move time)

```ts
  // WO-3 pending delete: manual start-next response disabled for bulk-load.
  // manualStart?: {
  //   ok?: boolean;
  //   reason?: string | null;
  //   error?: string | null;
  //   queueItemId?: string | null;
  //   elapsedMs?: number | null;
  // };
```

## apps/web-client/src/lib/api/queries/cxBulkLoad.ts (lines 17-20 at move time)

```ts
  // WO-3 pending delete: manual start-next state is disabled for bulk-load.
  // manualStartPending?: boolean | null;
  // manualStartedAt?: string | null;
  // manualStartSource?: string | null;
```

## apps/web-client/src/workspaces/cx/CXWorkspaceBulkLoad.tsx (lines 4029-4034 at move time)

```ts
  // WO-3 pending delete: manual start-next staged-current waiting is disabled.
  // const bulkCurrentAwaitingUii = Boolean(
  //   bulkCurrent &&
  //     !bulkCurrent.uii &&
  //     (bulkCurrent as { manualStartPending?: boolean | null }).manualStartPending === true,
  // );
```

## tests/cx-bulk-load/cxAccountActiveCallWatcherService.test.js (lines 111-134 at move time)

```js
// WO-3 pending delete: phone-only UII attach for manual start-next is disabled.
// test("projectBulkSessionFromAccountSnapshot attaches UII to a manually-started current by scoped phone proof", () => {
//   const current = {
//     ...candidate("q1", "cxbl-q1"),
//     phone: "3106665997",
//     manualStartPending: true,
//     matchReasons: ["manual-start-request"],
//   };
//   const s = session("s1", "acct-a", [], current);
//   const projected = projectBulkSessionFromAccountSnapshot(
//     s,
//     [{ uii: "u-manual", callState: "ACTIVE", dnis: "+13106665997" }],
//     { now: new Date("2026-06-23T12:00:00.000Z") },
//   );
//
//   assert.equal(projected.changed, true);
//   assert.equal(projected.transitionKind, "same");
//   assert.equal(projected.after.current.queueItemId, "q1");
//   assert.equal(projected.after.current.uii, "u-manual");
//   assert.deepEqual(projected.after.current.matchReasons, ["externId"]);
//   assert.equal(projected.after.acceptedBuffer.length, 0);
//   assert.equal(projected.terminalObservations.length, 0);
//   assert.equal(projected.after.trace.accountActiveCallWatcher.relevantActiveCallCount, 1);
// });
```

## tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js (lines 999-1032 at move time)

```js
// WO-3 pending delete: manual start-next staged current without RingCX proof.
// test("manual start-next probe promotes the first accepted buffer lead and waits for watcher UII", async () => {
//   const liveCalls = { value: [] };
//   const starts = [];
//   const manualDialer = {
//     async startNext({ candidate, ringDuration }) {
//       starts.push({ candidate, ringDuration });
//       return { ok: true, elapsedMs: 42 };
//     },
//   };
//   const { svc, outcomeAdapter } = build(liveCalls, { manualDialer });
//
//   const started = await svc.startCxBulkLoadSession({
//     agentEmail: "mickey@example.com",
//     agentExtensionId: "mickey-ext",
//     domain: "TAG",
//     ringcx: { accountId: "acct1", campaignId: "camp1" },
//     targetSize: 2,
//     refillThreshold: 1,
//   });
//   assert.equal(started.bufferCount, 2);
//
//   const snap = await svc.startCxBulkLoadNextManualCall({ sessionId: "s1" });
//   assert.equal(snap.manualStart.ok, true);
//   assert.equal(starts.length, 1);
//   assert.equal(starts[0].candidate.queueItemId, "q1");
//   assert.equal(snap.current.queueItemId, "q1");
//   assert.equal(snap.current.uii, null);
//   assert.equal(snap.current.manualStartPending, true);
//   assert.deepEqual(snap.current.matchReasons, ["manual-start-request"]);
//   assert.equal(snap.bufferCount, 1);
//   assert.equal(snap.remainingQueue[0].queueItemId, "q2");
//   assert.equal(outcomeAdapter.writes.length, 0);
// });
```

## tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js (lines 187-188 at move time)

```js
    // WO-3 pending delete: manual start-next injection disabled.
    // ...(overrides.manualDialer ? { manualDialer: overrides.manualDialer } : {}),
```

## tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js (lines 84-88 at move time)

```js
    // WO-3 pending delete: bulk-load no longer places manual calls.
    // async placeManualCall(opts) {
    //   calls.manualStarts.push(opts);
    //   return true;
    // },
```

## tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js (lines 68-69 at move time)

```js
    // WO-3 pending delete: manual start-next test support disabled.
    // manualStarts: [],
```
