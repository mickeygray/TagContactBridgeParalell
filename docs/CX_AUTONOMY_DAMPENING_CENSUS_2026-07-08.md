# AUTONOMY DAMPENING CENSUS - everything that decides a lead's value or a dial's fate
## Mickey's directive, 2026-07-08 night

> "Go after anything that autonomously decides the value of a lead or the execution of a dial and dampen it so the system works."

## THE TWO LAWS

1. **Mechanical rules may act; judgment may only recommend.** A lease expiry, age threshold, or counter cap is mechanical and may act. "Looks stale," "looks inactive," "capture didn't confirm," and "status fetch failed" are judgment and may only log/hold.
2. **Absence of evidence is not evidence.** A failed or missing read (AgentState, Logics status, UII capture) must never trigger a destructive action: requeue, cancel, force-idle, or drain. Block the single action if needed; never destroy inventory or flatten a human's state off a null.

## PATCHED TONIGHT

| Actor | The violation | The dampening |
|---|---|---|
| **Stale-serving sweep** (`requeueStaleServingQueueItems`) | Missing/unreadable AgentState was judged "inactive" and requeued rows agents were live on. | `missing-agent-state` now holds the row and stamps `held-missing-agent-state`; only a positive inactive read requeues. |
| **Stale-serving post-transition** | A second null read could force-write the agent available/idle, wipe `currentCall`, and drain a terminal. | Force-idle and drain now require a positive "provably elsewhere" read; null holds. |
| **Contact eligibility fresh Logics gate** (`resolveCaseContactEligibility`) | Failed/unparseable live Logics status under `requireFreshLogicsStatus` was treated like a confirmed bad status and could run `stopCaseContact` / cancel active queue rows. | `logics-status-check-failed` is now `transient:true`, `destructive:false`; it blocks only the current dial attempt. Ready-claim rows go back to `queued` on a short retry hold; bulk reservations release, not cancel. Stored positive stop evidence still blocks normally. |
| **`cx.bucket` stale reconcile** (`reconcileCxBucketCurrentCalls`) | The shadow bucket reconciler could treat an omitted active-call identity snapshot as an empty snapshot. | Stale clear now requires an explicit known active-call snapshot (`activeIdentitiesKnown:true` or provided identity set/array). Missing/null snapshot skips with `active-identities-unknown` and writes nothing. |

## THE CENSUS

**Lead-value deciders**

- Queue family assignment + `TOUCH_BALANCED_QUEUE_SORT` + `queueFamilyRank`/`priorityScore`: mechanical age/counter ordering; keep.
- Per-lead daily/monthly dial caps (`resolveQueueDialability`): mechanical; keep. Single-owner env blocks remove the double-count risk.
- **Contact eligibility with live Logics fetch (`enforceStop:true`)**: patched by Codex. A Logics outage is a transient, non-destructive block. It can skip/hold the single dial attempt; it cannot cancel queue inventory or stop case contact. Positive stored stop evidence still blocks normally.
- Cadence callPlan scheduling (`releaseAt`/delays): mechanical; keep.
- 8:30 no-show release: already dampened by design (human-armed, no weight, cancel-before-release).
- **Morning queue builder**: the largest autonomous value-decider in the system. Current mitigation: explicit allowlist/fail-closed targeting. Follow-up: per-run ledger of what it drained, built, and why before trusting it unattended.

**Dial-execution deciders**

- **Active-call capture**: the 06-17 law stands: observational, never a destructive gate. `pending-confirmation` stays a status, never a cancel.
- **1s account active-call watcher**: cancels are extern-scoped and reservation-foreign-protected. Acceptable under single-owner. Follow-up knob: consider 2-3s interval to cut API pressure.
- Agent monitor (`releaseManualUnavailableAgentQueues`): mechanical-ish but state-fed; single-owner covers today's failure. Add loud per-release logging when touched next.
- Lease reaper: mechanical lease expiry; keep.
- Ghost-call cancel policy: extern-scoped and proven; keep.
- Wrap janitor auto-resolve + auto-advance-as-no-answer: agreed design laws; keep.
- Lane dispatchers + first-touch drip: flag-gated / human-armed; keep dark until rollout step.
- **`cx.bucket` / `cxDialQueueMediatorService` lifecycle writer**: audited and patched by Codex. Write contract: shadow-only `AgentState.cxCallBuckets` writes; it never writes legacy `currentCall`, never changes queue row state, and never cancels/hangs up. Candidate prime and active observation are observational. Terminal observation only buffers completion and may clear bucket current on explicit terminal identity/trusted terminal input. Stale bucket clear is now allowed only after a known active-call snapshot; null/omitted snapshot skips with no write.
- **Carrier boundary**: per-ANI daily caps + hourly rotation are the dampener; connect-rate canary is the meter.

## HANDOFFS

- **Still open:** capture-flag assertion on both boxes; per-ANI caps when rotation pools fill; morning-builder ledger/dry-run report; watcher interval knob; zombie-session age note.
- **Codex completed in this pass:** Logics-transient dampening + mediator write-contract patch.
- **Gate:** `node --test tests/cx-bulk-load/*.test.js tests/cx-handoff/cxDialQueueMediatorService.test.js` => 440/440 passing.
