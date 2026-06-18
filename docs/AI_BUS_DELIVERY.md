# AI Bus Delivery — where it goes, how it gets there, and what it costs

The plumbing that ships an AI request from a consuming service to the bus and back, plus the measured cost of the cross-process hop so we can plan for efficient info delivery.

## The path

```
control-plane service (:5001)                         ai-bus (:7000)
  e.g. activityAiReviewService, smsClassifierService
        │
        │ createAiTaskClient().runAiTask("activity.contactSafetyReview", payload, options)
        ▼
  aiTaskClient  ──loopback HTTP POST──▶  POST /api/ai/tasks/:taskId/run   (mountAiTaskRoutes → runTask)
  127.0.0.1:7000/api/ai/tasks/:id/run         │   header: x-service-secret  (requireInternalAccess)
  body: { payload, options }                  ▼
  AbortController timeout                  aiTaskRunner.runAiTask
                                               │  resolveOrder → adapter → provider (OpenAI/Anthropic) → validate → failover
                                               ▼
        ◀──────── JSON envelope + { timing: { busMs } } ───────
  client stamps roundTripMs, computes transportMs = roundTrip − busMs
  transport failure (down/slow bus) → ok:false, code transport_* , safeFallback
```

Mirrors the proven `resolutionIntelligence` pitch proxy (same loopback + `x-service-secret` + `AbortController`), generalized to any task. Files: `packages/shared-services/src/aiTaskClient.js` (sender), `apps/ai-bus/src/aiTaskRoutes.js` (destination).

## The timing model

Every call carries a breakdown so we can see where the time goes:

| Field | Meaning | Who measures |
|---|---|---|
| `roundTripMs` | wall time the caller waited | client |
| `busMs` | time inside `runAiTask` (model + failover + validation) | bus (in the envelope) |
| **`transportMs`** | `roundTripMs − busMs` = **the cost of reading somewhere else** (serialize + loopback + other process) | derived |

`dryRun` runs the bus with no model call, so its round-trip *is* the pure transport cost — that's how the benchmark isolates the hop.

## Measured (loopback, N=300, dryRun = no model)

`node scripts/ai-bus-transport-bench.js`

```
client round-trip + isolated transport (ms):
  scenario                                         rt_p50  rt_p95  rt_mean | tp_p50  tp_p95
  dryRun small (pure transport)                    0.355   0.902   0.433  | 0.343   0.867
  dryRun LARGE ~50KB (transport + big info)        0.606   1.491   0.742  | 0.596   1.467
  instant task (transport + trivial bus)           0.225   0.491   0.279  | 0.215   0.470

connection-reuse lever (raw http POST, ms):
  keep-alive (reused conn)                         p50 0.124   p95 0.223   mean 0.139
  NEW connection each call                         p50 0.426   p95 0.633   mean 0.450
```

## What this means for delivery efficiency

1. **Transport is ~0.3ms median (~0.9ms p95) — negligible.** The cross-process hop to 7000 is nowhere near the bottleneck: model time dwarfs it (mini judges in the hundreds-of-ms, Sonnet/Opus in seconds, the call grader up to 45s). **Don't optimize the wire; optimize the model calls** (fewer calls via the mini-gate, cheaper tiers, caching).
2. **Payload size is cheap on the wire** (+~0.25ms per 50KB) but **expensive at the model** (tokens = $ + latency). So trim payloads for the *model*, not for transport — ship a summary because it costs tokens, not because it costs milliseconds.
3. **Connection reuse saves ~0.3ms/call.** The client uses Node global `fetch` (undici), which **pools connections by default** — already handled; no agent tuning needed for same-box.
4. **The floor-hot path doesn't pay this hop at all.** Live-coach (`contextJudge`, `dialogComposer`) runs **in-process on 7000** — it never makes the cross-process call. Only the 5001 batch/click services (sms, activity, resolution, blogger) pay the ~0.3ms hop, and none are sub-second-latency-critical. The architecture is right: hot path in-process, everything else a negligible hop.
5. **Same-box assumption.** 5001 and 7000 run on the same live box, so loopback is the correct model. If the bus ever moves to another host, add real LAN RTT (~0.5–2ms) — still small, but no longer free.

**Honest caveat:** absolute per-scenario ordering is noisy (JIT / cache warmth — the "instant" row landing below "dryRun small" is warm-path ordering, not a real inversion). Everything is sub-millisecond; the robust conclusion is *transport is negligible vs the model*, so plan info-delivery efficiency around model calls and token size, not the hop.
