# CX "screen advanced without submission" — Tracey → Veronica handoff

**Status:** verified diagnosis + patch plan for review. **No code changed.**
**Verified against:** real current code (6 functions read in full), the **actual event timeline** for this incident from `eventrecords`, and a blast-radius sweep (10 mutation sites). Where the original 11:05 AM analysis was wrong, it is corrected below.
**Incident:** 2026-06-15, agent **Chris Bolt** (ext `63914586004`, cxAgentId `21810`, TAG). Tracey Giles (caseId `128210`) → Veronica Chavez (caseId `128215`) with **no disposition submitted for Tracey**. Incident UII `202606151320473610000136381455`.

---

## 1. What actually happened (verified from `eventrecords`)

| UTC | Source | Event |
|---|---|---|
| 17:18:30 | `cx.dial.requested` | Dial requested for **Tracey** (128210) by Chris |
| 17:18:31 | `agentstates.currentCall` snapshot | Tracey's CX call is **live** on Chris's line — `currentCall.sessionId = 202606…455`, channel `cx`, `activePlatform=CX`. **The UII is present in agent state.** |
| 17:18:32 | `cx.call.placed` | placed event for Tracey, `payload.uii = null` (UII captured async — true of **every** placed event, not Tracey-specific) |
| **17:19:27** | `agentstates.lastCallEndedAt` | **Tracey's call cleared** — `lastCallOutcome='ringcx-auto-disposition'`, `currentCall` emptied, `activePlatform=none`. **No agent disposition.** ← the harmful clear |
| 17:21:19 → 17:27:48 | `ringcentral.ex.poll.reconciled` (`session_mismatch`) ×~14 | RingCentral **EX still reports Chris onCall on Tracey's UII**, local state already `available`. Each reconcile re-forces `available`. |
| 17:28:00 | `cx.dial.requested` | Dial requested for **Veronica** (128215) — app advanced |
| 17:28:02 | `cx.call.placed` | Veronica placed. Tracey (128210) **never** got a disposition/terminal event. |

**Two corrections to the original diagnosis the data forced:**

- **(A) The EX `session_mismatch` did NOT pull Chris onto a new lead.** In every mismatch, `activeCall.sessionId` is **Tracey's own UII** — it's two views of the *same* call (EX "still onCall" vs local "already cleared"). Polarity is the reverse of the original story: **the CX auto-disposition cleared first, then EX kept reasserting onCall and each reconcile re-cleared to `available`.** EX presence is a **symptom amplifier, not the cause.**
- **(B) `uii:null` on `cx.call.placed` is normal system behavior** (async capture), present on every placed event — not a Tracey anomaly. It weakens identity but downstream paths compensate with phone/agent/queue matching.

**Root cause (verified):** at ~17:19:27 something auto-ended Tracey's call and called a clear path **with no UII**, and that clear path **does not protect an active CX call when the request's UII is missing** (Bug 1). Because the agent's `currentCall` already held Tracey's UII as `existingIdentity`, a UII-aware guard *would* have blocked this exact clear. Everything after (EX re-reconciles, Veronica served, client auto-stage) is downstream of that clear.

---

## 2. Bug-by-bug verdicts (original claim → verified reality)

| # | Original claim | Verdict | Real location | Keep? |
|---|---|---|---|---|
| 1 | `markAgentAvailableAfterAutoDisposition` + `clearAgentCxCallState` clear an active CX call when the request has **no UII** | **CONFIRMED** | `ringcxDialExecutionService.js:499-542`; `cxWorkspaceService.js:1593-1638` | **KEEP — primary fix** |
| 2 | "no-active-call after disposition" is trusted and clears state | **CONFIRMED** | `cxWorkspaceService.js:6460-6486` accept logic → `:6631` clears via `clearAgentCxCallState({uii})` | **KEEP — same chokepoint as #1** |
| 3 | EX `session_mismatch` overrides CX call | **REFRAMED / NO FIX** | `ringcentralExService.js:894`; guard `shouldHoldCxDisposition` at `:88-111` | **DROP the proposed fix** |
| 4 | `cx.call.placed` born with `uii:null` | **CONFIRMED but NORMAL** | `ringcxDialExecutionService.js:1797,1869` | **KEEP only as observability** |
| 5 | Client optimistically advances ahead of backend truth | **CONFIRMED** | `CXWorkspace.tsx:4936-5014` + auto-stage effect `:4545-4606` | **KEEP — client defense** |
| net | `assertNoUnresolvedCxDispositionBeforeDial` checks serving queue only, not `currentCall` | **CONFIRMED** | `cxWorkspaceService.js:6521-6547` | **KEEP — strengthen** |

**On Bug 3:** the code *already* implements "ignore EX mismatch while a CX call is active" — `shouldHoldCxDisposition()` returns and **blocks reconciliation** when `channel==="cx"`/`activePlatform==="CX"`. It didn't protect Tracey because **Bug 1 had already cleared the CX snapshot**, so there was nothing left to hold. Adding the originally-proposed Bug 3 guard is redundant. (Optional, speculative: when EX reports `onCall` on a UII we *just* auto-cleared, treat that as evidence the clear was premature — see §5 P2.)

---

## 3. Blast radius — every site that clears/overrides CX call state (10 found; **4 new**)

Mechanism class: *a CX active call gets cleared/overridden without proving it's the same call.*

**Unsafe (no identity proof) — must fix or justify:**
- `ringcxDialExecutionService.js:481` `markAgentAvailableAfterAutoDisposition` — **missing-UII bypass (Bug 1)**
- `cxWorkspaceService.js:1581` `clearAgentCxCallState` — **missing-UII bypass (Bug 1/2)**
- **NEW** `idleReaperService.js:148` `clearOrphanCxDispositionStates` — clears by `activityState`/`channel` only, **no UII/queueItem check** ("can clear the wrong call")
- **NEW** `ringcentralExService.js:313` `persistState` (bridge-call suppression) — zeroes `currentCall` on a **name/phone pattern match**, no identity
- **NEW (partial)** `ringcxAgentMonitorService.js:469` `markMissingCxCallsEnded` — moves to `disposition` when a call disappears from one poll; checks `callIdentity` vs an `activeIdentities` set but **not** queueItem/UII match → **likely the trigger that fired Tracey's auto-disposition while EX still had her live**

**Conflicting reads to resolve before patching (two agents disagreed):**
- `dialService.js:371` `markAgentAvailableAfterAutoDisposition` — described as a **duplicate** of the vulnerable function. The sweep marked it "safe"; the deep trace shows the *same* `requestedIdentity && …` guard shape that has the missing-UII hole. **Verify before patching — likely the same bug.**
- `cxCadenceService.js:1451` `clearAgentCxCallStateForTerminalOutcome` — sweep says it checks `callIdentity`; confirm it also handles the **missing-UII** case, not just different-UII.

**Genuinely safe (identity-checked):** `ringcxAgentMonitorService.js:365` `markAgentCxActive` (scores queueItem→call via `scoreQueueItemForActiveCall`), `:495` (UII-matched long-hold clear).

---

## 4. The single mechanism behind Bugs 1 & 2

All the vulnerable clear functions share this guard shape:

```js
const requestedIdentity = normalizeExternalId(uii);            // null when uii missing
if (requestedIdentity && existingIdentity                      // <-- only fires when UII present
    && existingIdentity !== requestedIdentity
    && activePlatform === "CX") {
  return { skipped: true, reason: "different-active-cx-call" };
}
// ...falls through and clears: status:"available", activePlatform:"none", currentCall:{}
```

It protects against a **different** UII but not against a **missing** UII while a CX call is active. `normalizeExternalId(null) → null`, so the whole guard short-circuits and the clear proceeds. That is precisely the Tracey path: `existingIdentity` = Tracey's UII (in `currentCall`), `requestedIdentity` = null → clear.

---

## 5. Proposed fixes (prioritized)

### P0 — Close the missing-UII clear (one shared guard, applied everywhere)
Extract a single helper and use it in **all** clear/auto-available functions:

```js
// returns a skip directive when we must NOT clear, else null
function cxClearSkipReason(existing, requestedIdentity) {
  const existingIdentity = callIdentity(existing?.currentCall);
  const isCx = String(existing?.activePlatform || "").toUpperCase() === "CX"
            || existing?.currentCall?.channel === "cx";
  if (!isCx || !existingIdentity) return null;                 // nothing protected
  if (!requestedIdentity)  return "missing-uii-active-cx-call"; // NEW
  if (existingIdentity !== requestedIdentity) return "different-active-cx-call"; // existing
  return null;                                                 // same call -> ok to clear
}
```
Apply in: `ringcxDialExecutionService.js:481`, `cxWorkspaceService.js:1581`, and (after verification) `dialService.js:371`, `cxCadenceService.js:1451`. This also closes Bug 2, because the `:6631` clear runs through `clearAgentCxCallState`.

**⚠ Mandatory companion (do not ship P0 alone) — a safe path to clear genuinely-ended calls.**
The missing-UII clear presumably exists to release calls that end without a clean UII-tagged terminal. If we simply stop clearing, **agents can get stuck "on a call" that already ended.** P0 must ship *with* one of:
- **(preferred)** a reconciler that clears a CX `currentCall` only when **both** CX poll **and** EX presence report `NoCall` for that **same UII** for ≥ N consecutive polls (corroborated end), or
- a **TTL/age guard**: clear a CX `currentCall` whose `startTime` is older than a conservative threshold *and* no longer observed active.

Without this, we trade "advances too eagerly" for "stranded agent." This is the central review decision.

### P0 — Stop premature auto-end (the trigger)
`ringcxAgentMonitorService.js:469` `markMissingCxCallsEnded` should **not** auto-end a call that EX still reports live on the same UII. Require corroboration (missing from ≥N consecutive polls, or EX also `NoCall`) before transitioning to `disposition`/auto-available. The incident shows EX held Tracey live for ~8 minutes after CX auto-ended her — that disagreement should *block* the auto-end, not be steamrolled.

### P1 — Next-dial gate also checks `currentCall`
Strengthen `assertNoUnresolvedCxDispositionBeforeDial` (`cxWorkspaceService.js:6521`) to additionally **409-block** when `context.agentState.currentCall` is a CX call whose identity ≠ the requested `queueItemId`. `context.agentState` is already available; it just isn't consulted. **Caveats:** (a) allow the legitimate rapid flow where `input.nextDial` is set + `skipAgentStateClearAfterRelay` keeps `currentCall` (match by `queueItemId`, not phone); (b) this is valuable precisely because the serving-queue check may be unreliable — the incident's `cxdialqueues` had **no** rows for these caseIds, so a second independent gate (agent `currentCall`) matters.

### P1 — Client: only auto-stage the *expected* next lead
`CXWorkspace.tsx:4545-4606` auto-stages whatever the poll returns as `activeServingQueueItem`; after optimistic eject the guard at `:4547` passes (no lead staged) so **any** polled "serving" item stages, with no check it matches the disposed lead. Track the disposed lead + the backend next-dial handoff token and **only** auto-stage when the served item is the confirmed handoff target; otherwise show "finishing previous call." Keep optimistic eject for **explicit** agent submits only.

### P2 — Observability / identity (validated, lower urgency)
- `cx.call.placed`: carry `queueItemId` + masked phone + `identityPending:true`; patch/emit a follow-up identity event when async capture lands. (This incident was hard to reconstruct because the auto-disposition has **no standalone event** — only `agentState` fields.)
- Emit explicit events for every **skipped** clear (`missing-uii-active-cx-call`) and every **auto-disposition** (with reason + UII), so the next occurrence is one query, not a 4-minute forensic dig.
- *(Optional, speculative)* EX `onCall` on a just-cleared UII → signal to restore/hold rather than re-clear.

---

## 6. Test strategy (failable checks — write before patching)

- **Guard helper unit tests** (`cxClearSkipReason`): missing-UII + active CX + existing identity → **skip**; different UII → skip; **matching** UII → clear; empty `currentCall` → clear (no-connect no-answer still releases); non-CX platform → clear.
- **Regression test reproducing the incident**: seed agent state with a live CX `currentCall` (Tracey UII), invoke the auto-disposition/clear path with **no UII**, assert `currentCall` is **preserved** and a `missing-uii-active-cx-call` skip is recorded — then the same call with the **matching** UII clears it.
- **Trigger test**: `markMissingCxCallsEnded` with EX still `onCall` on the same UII → assert it does **not** auto-end.
- **Next-dial gate test**: agent has CX `currentCall` for queueItem A; dial for queueItem B without `nextDial` → 409; with `nextDial`/matching item → allowed.
- **Stale-clear companion test**: corroborated NoCall (CX+EX) for ≥N polls → the safe reconciler **does** clear (proves we didn't just strand agents).

---

## 7. Suggested patch order

1. **P0a** shared missing-UII guard helper + unit tests (no behavior change until wired).
2. **P0b** the corroborated/TTL safe-clear reconciler (so P0c can't strand agents).
3. **P0c** wire the guard into the 4 clear functions (verify `dialService`/`cxCadence` share the hole first).
4. **P0d** corroboration in `markMissingCxCallsEnded` (stop premature auto-end).
5. **P1** next-dial `currentCall` gate; client expected-lead auto-stage.
6. **P2** observability events.

Each step is independently shippable and reversible; steps 1-4 are the ones that actually prevent the Tracey→Veronica class.

---

## 8. Open questions / unverified (self-critique)

- **Queue-side state unproven:** `cxdialqueues` returned **no** rows for caseIds 128210/128215 at investigation time (consumed/rolled, or keyed differently). The serving-lease behavior is inferred, not corroborated — which is itself a reason to add the `currentCall` gate (P1) rather than trust queue state alone.
- **Trigger is inference:** that `markMissingCxCallsEnded` fired Tracey's auto-disposition is the best fit from (sweep + EX-still-onCall timeline), but there is **no explicit auto-disposition event** to prove it — only `agentState.lastCallEndedAt=17:19:27` + `lastCallOutcome='ringcx-auto-disposition'`. Confirm by adding the P2 event and/or reading the auto-disposition caller.
- **Two-agent disagreement** on whether `dialService.js:371` / `cxCadenceService.js:1451` share the missing-UII hole — resolved provisionally in favor of "they do" (same guard shape); **must be confirmed by reading those two functions before patching them.**
- **The companion safe-clear (§5) is the real risk.** A one-sided "stop clearing on missing UII" fix could strand agents on dead calls. The review's main job is to agree the corroboration/TTL mechanism before P0c lands.

---

## 9. Implemented locally (2026-06-15) — NOT deployed, for review

An adversarial 4-lens review of the implementation refined the plan in two ways and the fix shipped accordingly:

**What landed (local, tested):**
1. **Shared missing-UII guard** — `packages/shared-services/src/cxCallStateGuard.js` (`cxClearSkipReason` / `evaluateCxClear`), wired into all four clear functions (`markAgentAvailableAfterAutoDisposition` ×2, `clearAgentCxCallState`, `clearAgentCxCallStateForTerminalOutcome`). Skips the clear when an active CX call has a known identity but the request carries no UII. Behavior-preserving for the legacy `different-active-cx-call` skip and all normal Answer/NoAnswer/Voicemail/disposition flows (review lens 1 + 3 = sound; UII is reliably on the queue item by clear time, so <0.1% normal-path impact). 16 unit tests incl. the incident regression.
2. **idleReaper UII-event hold** — `idleReaperService.shouldClearOrphanCxDisposition` now **holds** (does not reap) a `dispositioning` CX call that still carries a UII identity; release must come from a UII-matched terminal/disposition (the guarded clear functions), never from age and **never from EX presence** (EX is stale — the user litigated this). Identity-less orphans still reap on age; an optional **non-EX** absolute cap (`RC_CX_ORPHAN_DISPOSITION_UII_MAX_HOLD_MS`, default disabled) bounds the lost-terminal case. 7 unit tests.

   > NOTE: an earlier iteration gated idleReaper on `exTelephonyStatus` (EX-corroboration). That was reverted — EX log information must not determine CX state. The hold is now UII-event-driven.

**Why idleReaper, not P0d-as-written:** the review proved the incident's harmful null came from the guarded `markAgentAvailableAfterAutoDisposition` (`lastCallOutcome='ringcx-auto-disposition'`), and that `markMissingCxCallsEnded` already corroborates via RingCX `activeIdentities` **and preserves `currentCall`** (it only moves status to `dispositioning`). The real residual leak was `idleReaper` re-clearing the guard-preserved call ~90s later with **no** identity check (its only guard is queue-item count, which was empty in the incident). The UII-event hold closes that leak: a UII-bearing call waits for its UII-matched terminal, so the guard's own `maxHoldMs` valve stays **disabled by default**.

## 11. EX→CX decouple — increment 1 SHIPPED DARK (2026-06-15)

Conservative first slice of "EX presence does nothing to CX status." Built + tested, **flag default OFF** (deployed behavior unchanged until enabled in a test window).

- **Pure decision** `decideExPollCxOwnership` in `cxCallStateGuard.js` (env-free, 7 unit tests incl. off-is-inert + the incident + the genuine-separate-EX-call exclusion).
- **Wired** into `ringcentralExService.reconcilePolledPresence`: when the agent holds a UII-CX call, the EX poll **preserves** `currentCall`/`activePlatform`/`status`/`activityState` instead of overwriting them from the EX dial-in snapshot, and forces `exTelephonyStatus="NoCall"` for the bridge leg so the **EX-busy lead gate (coupling #2) is unchanged**. ROI/call-log path untouched.
- **Flag:** `RC_CX_EX_DECOUPLE_ENABLED` (default false). OFF ⇒ byte-identical to prior behavior (the wiring overrides only fire when `cxOwnsCallState` is true, which requires the flag).
- **Verified:** decision unit tests + parse/load + full local suite (65 tests) green; off-is-inert proven.
- **NOT verified (needs the test window):** the ON-path behavior of the live async poller is not integration-tested (no Mongo poll harness). Validate tomorrow with `RC_CX_EX_DECOUPLE_ENABLED=true` on one agent/test tenant, watching: activePlatform stops thrashing CX↔none during a CX call, leads still flow (bridge not ex-busy), and a genuine EX call still registers.
- **Still ahead (next increments):** the genuine-separate-EX-call path relies on `exActiveIsBridge`/identity — confirm the bridge classifier covers all real cases; then consider removing the EX poll's CX writes entirely once the CX/UII side owns stuck-detection; persistent-station premise still unverified.

## 12. Code-review fix pass (2026-06-15) — EX-flag blockers cleared + live leak closed

- **#2 (EX identity completeness):** `snapshotCurrentCall` + `cloneCall` + `callSignature` now carry `callSessionId` and `uii` (ringcentralExService.js:190/210/142), so an EX active call identified only by those keeps a non-null identity through the snapshot → `decideExPollCxOwnership` no longer mis-decides ownership. Regression-tested (tests/cx-call-state-guard/exSnapshotIdentity.test.js, 5 tests).
- **#3 (daily-stats under preserve):** resolved as **documented ownership** (the user's option b). Verified that CX/UII owns the call lifecycle: `markAgentCxActive` counts the start (ringcxAgentMonitorService.js:399, applyCallStartedDailyStats) and the CX clear paths count the end. The EX poll counting CX calls was a double-count/mis-attribution. Documented at the preserve branch.
- **#5 (caller discipline — LIVE, not flag-gated):** the missing-UII guard ships active, so a skipped clear that still advanced the agent was a live leak. Closed the three sites that advanced unconditionally after a skipped clear: cxCadenceService.js:2723 (`onAgentBecomesEligible`), dialService.js:2065 (`onAgentBecomesEligible`), cxWorkspaceService.js:5350 & 5415 (`requestCxNextDialHandoff`). Each now skips the advance when `result.skipped` is set. The disposition bookkeeping still runs; only the *advance to next lead* is suppressed.
- **#1 (resolution projection):** restored `shorthand.logics_status` in clientProfileRepository.js listClientProfiles projection.
- **#4:** left as-is per the user (stricter closeout gate is intended — it killed the "446s no transcript" junk emails).
- **Verified:** all 6 modified files parse + load; full local suite 35 (cx-guard) / 65 (incl. queue) green. **NOT auto-verified (needs floor smoke):** the #5 skip-path behavior in the live disposition flows (no harness) and the #2/#3 EX ON-path (still gated by RC_CX_EX_DECOUPLE_ENABLED).

## 10. Deeper EX→CX determinant found (now addressed by §11 increment 1, flag-gated)

A read-only sweep + direct read of `ringcentralExService.reconcilePolledPresence` (lines 1185-1195) shows the EX presence poll **overwrites the CX `currentCall` with the EX active-call snapshot** (`activeCall ? snapshotCurrentCall(activeCall) : ...`) and **flips `activePlatform` to "EX"** when EX telephony is `CallConnected`/`OnHold`. The existing `shouldHoldCxDisposition` only protects the EX-says-`NoCall` case, not the EX-has-an-active-call case; the missing-UII guard does not cover the poller (it writes `currentCall` directly). This is the literal "EX dial-in log determining CX state." Proposed fix: make a UII-identified CX call **sticky** against the EX poll — the poll must not overwrite/clear `currentCall` or flip `activePlatform` off CX while the agent holds a CX UII, unless the EX active-call's identity matches that UII or a UII-matched CX terminal releases it. High blast radius (live presence reconciler governs floor availability), so pending explicit go-ahead.

**Coverage of the blast radius:** the two paths that actually empty `currentCall` to advance the agent in this incident class are now both guarded (auto-disposition → missing-UII guard; idleReaper → EX-corroboration). `markMissingCxCallsEnded` preserves `currentCall` (benign). Still **unaddressed / deferred:** `ringcentralExService.persistState` bridge-suppression (`:313`, different call type — inbound bridge pattern, not the outbound dial path), an optional EX check in `markMissingCxCallsEnded` (defense-in-depth), the P1 next-dial `currentCall` gate, the client expected-lead auto-stage, and full P2 observability events (only skip `logger.warn`s were added in 2 of 4 functions).

**Test artifacts:** `tests/cx-call-state-guard/cxCallStateGuard.test.js`, `tests/cx-call-state-guard/orphanDispositionCorroboration.test.js` (23 new); existing `tests/queue/*` (35) still green.
