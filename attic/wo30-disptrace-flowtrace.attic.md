# ATTIC — WO-30 now-half: runtime-SERVICE DISPTRACE copy + flow-trace console mirror
Retired by: Fable (2026-07-07, working the CX_LEGACY_HANGOVER_DELETE_LEDGER item 10 / WO-30 now-half)
Applied to: emergency instrumentation for the June "no answer did not end the call" investigation
Lived at: packages/shared-services/src/cxBulkLoadRuntimeService.js (factory ~:53-65, knob ~:92-107,
  mirror in traceBulkFlow ~:141-142, `_step` call sites through submitCxBulkLoadDisposition ~:846-969)
  + scripts/cx-bulk-agent-test-prep.js env lines
Replaced by: the structured cx.alpha.bulk.* channel (traceBulkFlow → logCxAlpha SURVIVES untouched)
  and the RUNTIME's own DISPTRACE (cxBulkLoadRuntime.js — UNTOUCHABLE until after acceptance per WO-30's
  dividing line: it still answers "no-answer didn't end the call — why?")
Revive: paste the factory back + re-add `const _step = createDispositionTrace("runtime")` in
  submitCxBulkLoadDisposition; the call-site labels are recorded below.

```js
function isDispositionTraceEnabled() {
  return /^(1|true|yes|on)$/i.test(str(process.env.CX_BULK_LOAD_DISPOSITION_TRACE));
}

function createDispositionTrace(scope) {
  if (!isDispositionTraceEnabled()) return () => {};
  const startedAt = Date.now();
  return (label, extra) => {
    console.log(
      `[DISPTRACE] ${scope}:${label} +${Date.now() - startedAt}ms`,
      extra !== undefined ? extra : "",
    );
  };
}

function isBulkFlowTraceEnabled() {
  return /^(1|true|yes|on)$/i.test(str(process.env.CX_BULK_LOAD_FLOW_TRACE));
}

function flowTraceMatchesAgent(state = {}) {
  const filter = str(process.env.CX_BULK_LOAD_FLOW_TRACE_AGENT).toLowerCase();
  if (!filter) return true;
  const haystack = [
    state.sessionId,
    state.agentEmail,
    state.agentExtensionId,
    state.cxAgentId,
    state.domain,
  ].map(str).join(" ").toLowerCase();
  return haystack.includes(filter);
}

// the console mirror that lived at the tail of traceBulkFlow:
//   if (!isBulkFlowTraceEnabled() || !flowTraceMatchesAgent(state)) return;
//   console.info("[CXBULK]", stage, payload);
```

`_step` call-site labels (order preserved): ENTER / loadState DONE / RETURN early — no state/current
(NOTHING SENT TO RINGCX) / current / terminalExecutor (HANGUP) START / terminalExecutor (HANGUP) DONE
/ RETURN — terminal FAILED / persistTerminalOutcome (DB WRITE) START / persistTerminalOutcome (DB
WRITE) DONE / maybeRefill (PUBLISH MORE LEADS) START / maybeRefill DONE / getLeadsAfterDisposition
START / getLeadsAfterDisposition DONE / persist DONE → RETURN ok (TOTAL)
