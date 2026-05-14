# RingCX Rate Limits — Docs vs. Our Actual Workload

## What RC publishes

| Endpoint family | Documented limit | Source |
|---|---|---|
| **Reports / metadata** (`/voice/api/cx/integration/v1/.../interaction-metadata`) | **2 calls per minute** | RingCX dev docs + reports-orig page |
| **Admin** (`/voice/api/v1/admin/...` — active calls, dial groups, agents, leads, dispositions, hangup) | **Not publicly documented** | Searched dev portal, Engage Voice guide, basics, GitHub docs — silent |
| **Integration v1 recordings download** (`/voice/api/cx/integration/v1/.../recordings/.../segments/...`) | **Not publicly documented** | Recording-feature isn't provisioned for us so we can't probe yet anyway |

Comparable peers for context (RingEX/Office, not RingCX, but same parent platform):

- Heavy tier: 10 req/user/min
- Medium tier: 40 req/user/min
- Light tier: 50 req/user/min

RingCX likely has its own admin-endpoint tier but RC doesn't publish where it lands.

## What our system actually does

### Sustained background load

| Source | Endpoint | Rate |
|---|---|---|
| `runRingcxAgentMonitor` (every 30s, in `apps/ringcentral-cx`) | `listActiveCalls` | **2 / min** |
| `cxRecordingHourlyService` (top of every hour, gated off until RC enables) | `fetchInteractionMetadata` | **1 / hr ≈ 0.017 / min** |
| **Total background** | | **~2 / min** |

That's the floor — whatever else happens, that's what we draw.

### Per-dial load (every outbound CX call)

The `dialService.placeCall` flow makes these RingCX calls per dial:

| Call | Count |
|---|---|
| `listCampaignDispositions` (lazily cached after first) | ~0 |
| `placeManualCall` | 1 |
| `listActiveCalls` (verification poll for ~10s after place) | ~5 |
| `dispositionCall` (on operator disposition) | 1 |
| `hangupCall` (if app initiates hangup) | 1 |
| **Per dial total** | **~8 calls** |

The 5 verification polls are spread across ~10s, so peak burst per dial is roughly 5 rps for 2 seconds, then ~3 more calls over the lifetime of the call.

### Sustained load at different dial volumes

Assumption: 1 active dial generates ~8 RingCX admin calls spread over the dial lifecycle (~30s-3min), so effectively ~3-5 calls/min sustained per active dial.

| Dial volume | Concurrent active dials (avg) | Per-min API rate | Verdict |
|---|---|---|---|
| **5 dials/hr** (the slow-cold-cadence baseline) | ~0.3 | **~3 / min** (mostly the agent monitor) | Comfortable |
| **30 dials/hr** (1 agent dialing steadily) | ~1.5 | **~10 / min** | Comfortable if admin tier ≥ Medium |
| **450 dials/hr** (10 agents × 45/hr — the load test target) | ~22 | **~70-90 / min sustained**, peak bursts to ~100+ during the 10s verification windows | At-risk if admin tier ≤ Medium (40/min); safe if tier is in the 100+/min range |
| **900 dials/hr** (peak agent activity, theoretical max) | ~45 | **~140-180 / min sustained** | Almost certainly hits the limit at any reasonable admin tier |

The verification-poll loop is the costliest single contributor — 5 polls per dial. That's there because RC sometimes returns 200 on `placeManualCall` but doesn't actually create the call (the failure mode in our support ticket). If/when RC fixes that, we can drop to 0-1 verification polls and cut per-dial cost by ~50%.

## Reports endpoint specifically

Pacing on `interaction-metadata` is **not relevant** to our actual use case:

- Documented limit: 2/min
- Our actual usage: 1/hour (the hourly batch poller). That's ~0.017/min.
- Headroom: **>100×**.

We could increase to a poll-per-15-minutes and still be at 4/hr = 0.067/min. Still ~30× below the limit. Pacing here is a non-question.

## Admin endpoints — where the question actually is

Three scenarios:

### If RC's admin tier is generous (say 100+/min)

Our current implementation is fine up to ~450 dials/hr. No pacing needed for today's volume. Build pacing later if/when you scale to 2-3× current operator count.

### If RC's admin tier is at RingEX Medium (40/min)

We start to feel pressure at ~30-50 dials/hr sustained, fall over at 100+ dials/hr. Pacing **is** worth building before we scale up agent count. Concretely: a token-bucket limiter in front of `ringcxVoiceClient.request` that smooths bursts.

### If RC's admin tier is Heavy (10/min)

We were already over the line when 1 agent was actively dialing. The fact that we're not seeing 429s in production means the tier is NOT this tight. So this scenario isn't realistic.

## What today's 5pm probe will tell us

The probe ramps `listActiveCalls` (same family as most of our hot calls — active calls, dial groups, etc.) through `1, 2, 4, 8, 12, 16, 24, 32, 48, 64 rps` for 30s per level. It stops on 2 consecutive 429 levels.

**Most informative outcome:** the probe finds the ceiling at level N rps. Multiply by 60 to get rpm, that's the admin-tier limit. Then decide:

- Limit ≥ 100/min → pacing is **not relevant** for current load. Worth revisiting if you ever hit 5+ concurrent agents dialing flat-out.
- Limit ≤ 50/min → pacing **is** relevant. Build a token-bucket limiter and add Retry-After-aware backoff in the client.

The probe will give a definitive answer in 5 minutes. Without it, my honest read is "**probably fine for current load but no way to be sure**."

## Recommendation

1. **Tonight at 5pm**: let the probe run (already armed). Cancel it if business-hours risk feels too high; otherwise the empirical number it returns settles this whole question for the next year.

2. **Regardless of probe result**: add Retry-After-aware backoff to `ringcxVoiceClient.request` even if we never hit 429 today. It's cheap (~20 lines) and means the day RC tightens limits we don't notice. Not a token bucket, just "on 429, sleep min(retry-after, 30s) then retry once."

3. **Defer pacing logic** unless either (a) the probe shows ≤ 50/min, or (b) you're actively planning to scale to 5+ concurrent flat-out dialing agents. Pacing has real complexity cost (token bucket, fairness across agents, prioritization between dial vs. monitor calls) and we should only take it on when we have evidence we need it.

## Sources

- [RingCentral API Rate Limits — main developer docs](https://developers.ringcentral.com/guide/basics/rate-limits)
- [RingCX Reports API — 2/min limit](https://ringcentral-ringcx-api-documentation.readthedocs-hosted.com/en/latest/integration/reports-orig/)
- [RingCentral API Rate Limit Explained (Medium)](https://medium.com/ringcentral-developers/ringcentral-api-rate-limit-explained-2280fe53cb16)
- [RingCX Voice API hub](https://developers.ringcentral.com/engage-voice-api)
- [Engage Voice Guide basics](https://developers.ringcentral.com/engage/voice/guide/basics)
