# Whole-System Audit — reliability holes + speed/reliability improvements

Method: 8 finder angles (4 subsystem: AI bus, coach hot path, CX call-state, event
spine; 4 cross-cutting: failure-recovery, speed, AI spend, altitude) → adversarial
verification per candidate → gap sweep → synthesis. 61 verified findings distilled
to the 15 holes + 12 improvements below. Floor-safe framing: prefer default-off/
additive fixes.

## Top priorities (highest leverage)

1. **Close the compliance fail-OPENs (holes 2/3/4).** A missing
   `REAL_VALIDATION_API_KEY`, a swallowed `markChannelDnc` failure, and a
   RealValidation-outage fallback each silently mark litigators/DNC numbers as
   contactable floor-wide. Highest legal/financial blast radius; all small/additive.
2. **Fix the AI-bus Opus path + bound its spend.** ✅ hole 1 (temperature:0 → Opus
   400) is **fixed**; still open: plumb caller-abort + a per-attempt timeout into
   the adapters (hole 12) and add a durable AiTaskRun spend sink (improvement 1).
3. **Harden the event spine for at-least-once:** PROCESSING reaper (hole 5),
   idempotent metric handler (hole 6), stop inbound-SMS dedupe swallowing genuine
   repeats (hole 7), add the `{status,nextAttemptAt,createdAt}` index (impr. 6).
4. **Stop the EX/CX state-clobber + queue-strand races (holes 8/9/10)** — the
   live-floor "lead flickers / advances to the wrong case / lead goes undialable."
5. **Restore live-coach stream resilience + cut hot-path latency** — reconnect on
   clean SSE close (hole 11), guard SSE writes/heartbeat (hole 13), move per-turn
   ndjson appends off the event loop (impr. 3).

## Holes (reliability / correctness)

| # | Sev | Location | Hole | Fix |
|---|-----|----------|------|-----|
| 1 | P1 ✅FIXED | anthropicClient.js:85 | `temperature:0` sent to Opus 4.7/4.8 → every Opus bus task 400s, runner burns the ladder then cross-fails. | Client now omits temperature for Opus 4.7+ (`modelRejectsSamplingParams`); buildRequestFor carries declared temps. Tested. |
| 2 | P1 | realPhoneValidationClient.js:52 | Missing `REAL_VALIDATION_API_KEY` → validatePhone/lookupDnc return permissive (canCall/canText:true, DNC/litigator false) → federal-DNC screen silently off floor-wide. | Empty key → return block/hold (fail-closed) + loud startup/per-call alert. |
| 3 | P1 | dncRecheckService.js:92 | `markChannelDnc` failure swallowed, yet lead counted disabled + `nextCheckAt` rolled ~2wks → confirmed-DNC lead keeps getting CX calls. | Only advance/count after the write resolves; on failure leave nextCheckAt near-term + surface error. |
| 4 | P1 | inboundIntakeService.js:1236 (+ outboundDispatchService.js:352) | `buildValidationFallback` is fully permissive whenever RealValidation rejects → fail-OPEN for the whole outage. | On rejection/outage, hold call/SMS channels (needs-revalidation), don't mark contactable. |
| 5 | P1 | event-core/eventService.js:54 | No reaper for rows stuck in PROCESSING (claim matches only PENDING/FAILED/REPLAYED) → crash/restart mid-handler strands the event forever (payment/SMS lost). | Sweep PROCESSING older than a visibility timeout → FAILED w/ nextAttemptAt; stop discarding markCompleted/markFailed returns. |
| 6 | P1 | controlPlaneEventService.js:462 | Metric handler blind-`$inc` with no processedEventId guard → any redelivery double-counts floor metrics. | Add eventId to the match / `$addToSet` guard so redelivery is a no-op. |
| 7 | P1 | control-plane/server.js:1139 | Inbound-SMS dedupeKey = hash(source,dest,trimmed body) → a prospect texting "yes" twice has the 2nd silently swallowed (no classify/alert/queue). | Mix a coarse time bucket or provider message-id into the key. |
| 8 | P1 | ringcentralExService.js:1056 | EX-poll `session_mismatch` clobbers a CX-held call in default `preserve` mode (only short-circuits in `cx-owned`) — the lead-flicker the decouple was meant to stop. | Route the mismatch branch through `decideExPollCxOwnership` / hasCxCallSnapshot suppression in `preserve` too. |
| 9 | P1 | cxCadenceService.js:1204 | `markAgentCxCallState` overwrites currentCall with no different-live-call guard; read→write via findOneAndUpdate keyed only on extensionId = TOCTOU last-writer-wins. | Compare-and-set: include prior currentCall identity in the match; skip when a different live CX call holds the seat. |
| 10 | P1 | cxCadenceService.js:3688 | `releaseCxQueueItem` cancels the RingCX published copy BEFORE the guarded transition; if the transition match fails, lead is de-published but left claimed → stranded/undialable. | Do the guarded Mongo transition first; cancel the published copy only on success. |
| 11 | P1 | web-client/lib/liveCoach/stream.ts:311 | SSE reconnect treats a CLEAN upstream close (reader done) as success → a mid-call 7000 restart / nginx idle-FIN silently freezes the coach feed, no error badge. | Treat reader-done as a reconnect trigger; reset the retry counter on each successful (re)connect. |
| 12 | P1 | aiProviders.js:61 | Caller abort never reaches the in-flight model HTTP call; runner enforces no per-attempt timeout → paid Opus/GPT generations finish + bill after the caller is gone; a hung adapter wedges the task. | Plumb `options.signal` into createMessage/createResponse + wrap adapter.run in a runner Promise.race timeout. |
| 13 | P1 | ai-bus/server.js:4042 (+ liveCoachProxy.js:498) | SSE write/heartbeat has no error handling / writableEnded guard / backpressure; a close without FIN leaks the interval + writes a dead socket forever; a slow consumer buffers the whole call unbounded. | Guard with writableEnded, clear heartbeat on write error, honor write() backpressure, race the proxy drain against close. |
| 14 | P2 | control-plane/server.js:1360 | 5 of 6 apps register NO uncaughtException/unhandledRejection handler (only ai-bus) → an unhandled rejection kills the process with no crash log / graceful drain. | Register the ai-bus crash hook in `shared-runtime.initializeServiceRuntime` so all apps inherit it. |
| 15 | P2 | cxCadenceService.js:2739 | Terminal-outcome fast-advance doesn't verify the inbound UII matches the agent's CURRENT held call → queue advances off a stale call; queue/agent state diverge. | Add a `payload.uii == currentCall` identity check at the front of handleCxTerminalCallOutcome. |

## Improvements (speed / reliability)

| # | Area | Improvement | Gain | Effort |
|---|------|-------------|------|--------|
| 1 | AI-bus spend | Durable AiTaskRun sink (telemetry is logger-only) — persist per-attempt usage/cost + alert on N failover attempts. | Queryable spend + alerting; closes the blind spot ladder-burns leak through. | M |
| 2 | AI-bus cost | SMS classifier defaults to **Opus** on the highest-volume inbound path (direct, no failover) despite a "classify with Sonnet" comment — drop to Sonnet/Haiku or route the bus ladder. | ~4-8× cheaper on the busiest reasoning path + failover. | S |
| 3 | Coach latency | `fs.appendFileSync` inside `emit()` (+ per-turn ndjson writes) blocks the event loop on the SSE fan-out — make them fire-and-forget async. | Removes blocking disk I/O between Claude's first delta and the agent line. | M |
| 4 | CX workspace | N+1 in queue-refill materializers (~600 sequential `findOne`s/refill) → one batched `$in` + in-memory Set. | ~600 round-trips → ~3; seconds off the per-agent poll. | M |
| 5 | Screen-pop | `findCxLeadCandidates` runs serially though `lookupCxLead` already `Promise.all`s the same trio — parallelize tiers + per-domain Logics. | ~halves inbound-lookup tail latency. | S |
| 6 | Event spine | No compound index for the 5s claim query → add `{status:1,nextAttemptAt:1,createdAt:1}`. | Index-covered claim; bounded worker-tick latency as the collection grows. | S |
| 7 | Call-log read | `buildCallLog` legacy/workflow path N+1 `listEvents` (~100 round-trips/page) → one `$in` grouped in memory. | 0.5–3s off the call-log page. | S |
| 8 | Coach spend | Rolling digest (paid mini) scheduled from 3 places, coalesced by one dirty flag → continuously in flight, starving the latency-critical judge. Add min-interval debounce / skip-if-unchanged. | Cuts steady priority-tier spend + frees rate budget. | S |
| 9 | Direct-client reliability | Several direct Anthropic sites (transcription scoring, blogger writer, activity legacy fallback) have one hardcoded model, no ladder/failover, some no timeout → a model rename 404s them floor-wide. | Survives model deprecation/outage. | M |
| 10 | Cache correctness | rollingDigest cache key omits the model (collides on a model-swap); bus cache keys ship literal `{model}`/`{agentScope}` placeholders never substituted. | Restores per-model/scope cache isolation → higher hit rate, lower latency/spend. | S |
| 11 | Cross-process locks | In-process-only guards (cxFreshHotLane `allocatorRunning` bool, resolution `askInFlight` Map) let 2 processes double-serve / double-fire an 8–16k-token Opus pitch. | Stops double-serve past caps + duplicate paid Opus pitches. | M |
| 12 | Metrics-panel I/O | `resolveMetricsCollection` runs a live `countDocuments` probe per call + re-resolves the same collections per request → memoize source-routing with a short TTL. | Removes repeated probe I/O on the known-pain metrics path. | S |

## Notes

- **Hole 1 is fixed** (anthropicClient omits temperature for Opus 4.7+; buildRequestFor
  carries declared temps; 3 tests). Everything else is recorded, not yet changed.
- The compliance fail-OPENs (2/3/4) and the CX state/queue races (8/9/10) touch
  sensitive, owner-adjacent floor paths (DNC is terminal; EX↔CX is active work) —
  recommend owner sign-off before editing, even though the fixes are small.
- In my lane and default-off/additive if you want them next: hole 12 (adapter abort
  + per-attempt timeout), hole 13 (coach SSE guards), improvement 1 (AiTaskRun sink),
  improvement 10 (cache-key fixes), improvement 2 (SMS classifier model default).
