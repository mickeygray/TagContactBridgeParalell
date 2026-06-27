# AI Cost Model: API vs Subscription Split - 2026-06-26

## Purpose

This is a planning estimate for the four main AI spend surfaces:

- live coach
- SMS/text messaging
- `/resolution` / upsellerator pitch design
- blogger

The goal is not invoice-perfect accounting. The goal is to find the practical
sweet spot between:

- OpenAI API spend staying near the desired outside-budget range
- Claude Max being reserved for coach moments where Opus quality matters
- Codex subscription absorbing slow background agentic work

## Official Pricing Sources Used

- OpenAI API pricing: https://developers.openai.com/api/docs/pricing
- OpenAI GPT Image 1 pricing: https://developers.openai.com/api/docs/models/gpt-image-1
- Anthropic/Claude pricing: https://claude.com/pricing
- Codex pricing: https://developers.openai.com/codex/pricing
- Codex rate card: https://help.openai.com/en/articles/20001106-codex-rate-card

Pricing changes. Treat these estimates as a dated model.

## Current Code Surfaces

From `docs/AI_TASK_DICTIONARY.md` and code reads:

| Surface | Current task shape | Current route |
| --- | --- | --- |
| Coach strategy | `liveCoach.callStrategy` | Anthropic Opus via `apps/ai-bus/src/server.js` |
| Coach composer | `liveCoach.dialogComposer` | Anthropic Sonnet/Opus toggle via `apps/ai-bus/src/server.js` |
| Coach mini judge/digest | `liveCoach.contextJudge`, `liveCoach.rollingDigest` | OpenAI `gpt-5.4-mini` through 7000, prompt cache |
| Coach grader | `liveCoach.callGrader` | OpenAI `gpt-5.4`, gated by duration/transcript |
| SMS classifier | `sms.classify` | direct Anthropic, currently default `claude-opus-4-6` in `smsClassifierService.js` |
| Resolution pitch | `resolution.pitch` | 7000 Anthropic Opus, doctrine prefix cached |
| Blogger write | `blogger.write` | direct Anthropic Sonnet in `blogger-claude-writer.js` |
| Blogger current event | `blogger.currentEvent` | bus-shaped Anthropic search loop in `blogger-current-event.js` |
| Blogger image | `blogger.image` | OpenAI image generation in `blogger-post-pipeline.js` |

## Rate Card Snapshot

Prices below are dollars per 1M tokens unless noted.

| Model / route | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| OpenAI `gpt-5.4` | $2.50 | $0.25 | $15.00 |
| OpenAI `gpt-5.4-mini` | $0.75 | $0.075 | $4.50 |
| OpenAI `gpt-5.4-mini` priority | $1.50 | $0.15 | $9.00 |
| OpenAI `gpt-5.4-nano` | $0.20 | $0.02 | $1.25 |
| Claude Opus 4.8 API | $5.00 | $0.50 read | $25.00 |
| Claude Sonnet 4.6 API | $3.00 | $0.30 read | $15.00 |
| Claude Haiku 4.5 API | $1.00 | $0.10 read | $5.00 |

Other rates:

- OpenAI `gpt-4o-mini-transcribe`: about $0.003/minute.
- OpenAI `gpt-4o-transcribe`: about $0.006/minute.
- OpenAI web search: about $10/1K calls, plus search content/model-token rules by endpoint.
- Anthropic web search: about $10/1K searches, not including model tokens.
- Claude Opus fast mode through API is 2x standard pricing.
- GPT Image 1 low 1024x1024 is about $0.011/image; medium is about $0.042/image; high is about $0.167/image.
- Codex subscription use is not normal OpenAI API billing when authenticated through ChatGPT, but it is still limited/credit-metered. API-key Codex uses standard API token pricing.

## Estimation Assumptions

Token estimates use simple planning math, roughly `chars / 4`.

| Workload | Assumed input/output shape |
| --- | --- |
| Coach routine all-floor tick | 6,250 cached tokens + 3,000 dynamic input + 800 output |
| Coach tick cadence | every 12 seconds = 300 ticks/hour |
| Floor month | 176 scheduled floor-hours/month |
| STT full occupancy | 7 agents x 60 minutes = 420 audio minutes per floor-hour |
| SMS LLM branch | 12,000 input + 450 output |
| Resolution pitch | 15,000 cached doctrine + 5,000 dynamic input + 2,000 output |
| Blogger normal write | 8,000 input + 3,500 output |
| Blogger current-event | 12,000 input + 4,000 output + 6 web searches |
| Call grader | 4,500 input + 900 output |

The assumptions are intentionally conservative enough to guide architecture.
Real `AiTaskRun` telemetry should replace them.

## Live Coach Costs

### STT

At seven fully active agents:

| STT route | Cost per floor-hour | Cost per 176 floor-hours |
| --- | ---: | ---: |
| `gpt-4o-mini-transcribe` | $1.26 | $222 |
| `gpt-4o-transcribe` | $2.52 | $444 |

This is the first hard reality: if we transcribe seven agents every minute of
every scheduled hour, STT alone can exceed a $200 API target. The target is only
realistic if the system gates no-answer, voicemail, silence, and idle time.

At 50% active-call occupancy, mini-transcribe is about $111/month. At 35%, it is
about $78/month.

### Routine all-floor coach tick

Assuming one batched request covers the whole floor every 12 seconds:

| Route | Cost per tick | Cost per floor-hour |
| --- | ---: | ---: |
| `gpt-5.4-nano` | $0.0017 | $0.52 |
| `gpt-5.4-mini` standard | $0.0063 | $1.90 |
| `gpt-5.4-mini` priority | $0.0126 | $3.79 |
| Claude Haiku API | $0.0076 | $2.29 |
| Claude Sonnet API | $0.0229 | $6.86 |
| Claude Opus API cached | $0.0381 | $11.44 |
| Claude Opus fast API cached | $0.0763 | $22.88 |

Takeaway:

- `gpt-5.4-nano` is the budget candidate for routine "did something matter?"
  classification.
- `gpt-5.4-mini` is plausible if called only on active calls or uncertainty.
- `gpt-5.4-mini` priority as the default doubles the cost. Use it only if the
  standard tier misses latency.
- Opus on every tick is not compatible with the spend target, even with caching.

### What $200 buys in routine coach ticks

| Route | Approx floor-hours at 300 ticks/hour |
| --- | ---: |
| `gpt-5.4-nano` | 386 hours |
| `gpt-5.4-mini` standard | 105 hours |
| `gpt-5.4-mini` priority | 53 hours |
| Claude Haiku API | 87 hours |
| Claude Opus fast API cached | 9 hours |

This is why "one Opus call coaches the whole floor" is directionally good but
still not enough if it happens every 12 seconds all day. The right move is:

```text
nano/mini classifies every tick
Opus writes only the high-stakes subset
Codex handles closeout/background
```

### Monthly coach scenarios

These scenarios assume 176 scheduled floor-hours/month and include STT plus the
routine coach tick. Claude Max pool burn is modeled at Opus-fast API-equivalent
cost for high-stakes turns.

| Scenario | API/month | Claude Max equivalent/month | Read |
| --- | ---: | ---: | --- |
| 50% occupancy, nano routine, 3% Opus escalation | $156 | $60 | Best first target if nano quality is acceptable. |
| 50% occupancy, nano routine, 5% Opus escalation | $156 | $101 | Strong sweet spot. Leaves Max room for asks/strategy. |
| 50% occupancy, nano routine, 10% Opus escalation | $156 | $201 | Max pool basically consumed by coach writer. |
| 35% occupancy, mini standard routine, 5% Opus escalation | $194 | $70 | Good if mini is needed for quality. |
| 50% occupancy, mini standard routine, 5% Opus escalation | $278 | $101 | Useful but misses the $200 outside target. |
| 50% occupancy, mini priority routine, 5% Opus escalation | $445 | $101 | Too expensive unless latency demands priority. |
| 100% occupancy, Opus fast every tick | STT $222 | Opus $4,026 | Not a production option. |

The realistic sweet spot is:

- STT only when a call is meaningfully active.
- Routine tick on nano first.
- Mini only when nano is uncertain or when a response draft is needed.
- Opus Max only for objections, fee/close, hostile/trust moments, and explicit Ask.
- Cap Opus escalations around 3-5% of ticks at first; alert at 10%.

## SMS/Text Messaging

Current code defaults the LLM branch to Opus. That is expensive for a task with
a strict schema and many deterministic fast paths.

Estimated cost per 1,000 LLM-classified SMS messages:

| Route | Cost / 1K LLM branches |
| --- | ---: |
| `gpt-5.4-nano` | $3 |
| `gpt-5.4-mini` | $11 |
| Claude Haiku API | $14 |
| `gpt-5.4` | $37 |
| Claude Sonnet API | $43 |
| Claude Opus API | $71 |

Takeaway:

- SMS is not the main monthly spend unless volume is very high.
- Current Opus default is still wasteful.
- Best shape: deterministic regex gates first, then nano/mini or Haiku for the
  structured branch, with `needs_human` fail-closed for uncertain DNC/compliance
  outcomes.
- Do not use Codex subscription for inline SMS. A prospect is waiting and the
  task can mutate contactability.

Recommended split:

```text
regex/known rules -> no model
normal LLM branch -> gpt-5.4-mini or Haiku
cheap experimental branch -> gpt-5.4-nano with quality gate
ambiguous DNC/compliance -> needs_human, not Opus
```

## Resolution / Upsellerator

Resolution pitch is Opus today and uses a cached doctrine prefix. It is
important reasoning, but it is not high-volume like live coach.

Estimated cost per 100 pitch runs:

| Route | Cost / 100 runs |
| --- | ---: |
| `gpt-5.4-nano` | $0.38 |
| `gpt-5.4-mini` | $1.39 |
| Claude Haiku API | $1.65 |
| `gpt-5.4` | $4.63 |
| Claude Sonnet API | $4.95 |
| Claude Opus API cached | $8.25 |
| Claude Opus fast API cached | $16.50 |

Takeaway:

- Even Opus resolution is not the budget killer unless people run it constantly.
- Quality matters more than raw cost here.
- A good split is first-pass Sonnet or `gpt-5.4`, then Opus only for final/high
  value pitch design.
- Codex subscription can precompute slower strategy packets overnight or after a
  case update, but should not be the click-and-wait route unless the UI can
  tolerate job-style delay.

Recommended split:

```text
precompute / overnight client strategy -> Codex subscription worker
first interactive pitch read -> Sonnet or gpt-5.4
high-value final pitch / difficult case -> Claude Max Opus or metered Opus if explicitly armed
cheap follow-up classification -> mini
```

## Blogger

Blogger is agentic, slow, and internal. It is a perfect Codex subscription
candidate, but not because it is the biggest bill. The token cost is modest; the
reason to move it is to protect the live coach pools and centralize agentic
writing.

Estimated model cost:

| Task | Route | Unit cost |
| --- | --- | ---: |
| Normal blog write | Sonnet API | $0.08/post |
| Normal blog write | Opus API | $0.13/post |
| Current-event blog with 6 searches | Sonnet API + Anthropic search | $0.16/post |
| Current-event blog with 6 searches | Opus API + search | $0.22/post |
| Image 1024x1024 low | GPT Image 1 | $0.011/image |
| Image 1024x1024 medium | GPT Image 1 | $0.042/image |
| Image 1024x1024 high | GPT Image 1 | $0.167/image |

At 20 posts/month, the writer is only a few dollars. The risk is not unit cost;
it is hidden retries, web-search loops, one-off scripts, and direct provider
calls outside the bus.

Recommended split:

```text
blog planning/write/current event -> Codex subscription worker when stable
fallback if Codex unavailable -> Sonnet API or static draft
image generation -> Codex imagegen for small/background blog assets; OpenAI API low-quality fallback only when explicitly armed
publish/deploy -> deterministic script, never inside the AI adapter
```

## Codex Subscription Use

Codex Pro/20x is useful, but it is not a free production API. Official docs say
Codex is included in ChatGPT plans, but Codex usage is also token/credit-shaped
under the current rate card, and API-key usage is billed at standard API rates.

Use Codex for:

- call grader closeout
- agent coaching email draft
- call summary / LeadCadence communication summary
- blogger drafts and current-event research
- client health flags
- upsellerator precompute
- CX/metrics/code audits

Do not use Codex for:

- STT
- inline SMS
- live 12-second coach ticks
- customer-facing app routes
- any task where a human is waiting on a sub-5-second response

The worker must strip `OPENAI_API_KEY` when the goal is subscription auth, use a
dedicated `CODEX_HOME`, validate schema output, and queue/retry before any
metered fallback.

## The Practical Monthly Budget Picture

To stay near a $200 OpenAI API target while using the Claude/Codex subscriptions:

| Item | Target |
| --- | --- |
| STT | $75-$125/month by gating idle/no-answer/voicemail time |
| Routine coach classifier | $35-$90/month via nano-first, active-call-only |
| SMS LLM branch | under $15/month at 1K LLM branches on mini/Haiku |
| Resolution | under $10/month unless usage explodes |
| Blogger text/image | under $10/month if API fallback; ideally Codex worker |
| OpenAI API total target | about $150-$225/month depending floor occupancy |
| Claude Max burn | Opus only for 3-5% high-stakes coach ticks, plus asks/strategy |
| Codex subscription burn | background jobs, not live service paths |

If routine coach stays on `gpt-5.4-mini` standard at 50% occupancy, OpenAI API
lands closer to $275+ before SMS/resolution/blog. If it stays on priority, it
can blow past $400. If routine coach goes nano-first and active-call gated, the
target is plausible.

## Recommended Architecture By Surface

### Coach

1. Keep STT on OpenAI API, but gate hard.
2. Run one batched floor classifier on `gpt-5.4-nano` first.
3. Promote only uncertain/actionable beats to `gpt-5.4-mini`.
4. Escalate only high-stakes moments to Claude Max Opus.
5. Move closeout grader and agent email draft to Codex subscription worker.
6. Alert if Opus escalations exceed 5% of ticks; hard review at 10%.
7. Avoid OpenAI priority tier as a default unless logs prove standard misses.

### SMS

1. Keep regex gates local.
2. Move model branch to bus.
3. Use mini/Haiku as the default; test nano for non-DNC branches.
4. Fail closed to human on low confidence, DNC, legal/compliance ambiguity.
5. Do not use Codex worker inline.

### Resolution

1. Keep click route on API-backed 7000.
2. Use Sonnet or `gpt-5.4` for first reads and follow-ups.
3. Use Opus only for high-value final pitch design.
4. Add Codex subscription precompute for slower background strategy.

### Blogger

1. Move writer/current-event to Codex worker once the runner is hardened.
2. Keep Sonnet API as fallback, not the default.
3. Prefer Codex imagegen for small/background blog images; if the API fallback is armed, keep image API low quality by default unless a human requests higher.
4. Keep publish/deploy deterministic and idempotent.

## Final Answer

We cannot have "Opus every 12 seconds all day" and also keep the spend near the
target. We can have:

```text
OpenAI API around target:
  STT + nano/mini routine coach + SMS + small modality costs

Claude Max around target:
  Opus only on the high-stakes live coach turns

Codex subscription:
  slow background work that would otherwise consume Claude/API reasoning
```

The sweet spot is not "move everything off API." It is:

```text
Use API where latency/modality/structured JSON matters.
Use Claude Max where quality in the live call matters.
Use Codex where time does not matter.
```

The next implementation step is usage telemetry by named task. These estimates
are good enough to set policy, but the system needs real rows with:

```text
taskId, routeId, provider, model, cachedInputTokens, inputTokens, outputTokens,
elapsedMs, activeAgents, callOccupancy, fallbackFrom, meteredFallthrough
```

Without that, the monthly bill will keep feeling like weather.

## Double-Check + Slow-Pull Usage Map (Claude, 2026-06-26)

The model above is sound. This addendum (a) corroborates its rate card against numbers I **measured live** this session on `claude -p`, (b) reconciles the "slow Opus pull every few minutes" idea with the doc's "5% Opus escalation" (they're the same thing), and (c) flags the one assumption that is optimistic. Nothing above is being changed — this is verification + the direct answer to "how do we spend the $200 on the coach smartest."

### 1. Measured corroboration of the Claude rate card

This session I ran the real whole-floor batch tick (25K reference, 7 transcripts, warm cache) on the Max pool and read `modelUsage` / `total_cost_usd`:

| Route | This doc's estimate | Measured this session | Verdict |
| --- | ---: | ---: | --- |
| Opus fast (cached) | $0.0763/tick | **$0.085/tick** | ✓ corroborated; mine is a touch higher because real transcripts push dynamic input past the 3,000-token assumption. Treat $0.076 as a floor and **~$0.09–0.10 as typical on long calls**. |
| Claude Haiku | $0.0076/tick | **$0.009/tick** | ✓ |
| Opus fast = 2× standard Opus | (stated as a rule) | **confirmed in `modelUsage`** | the fast-mode premium roughly doubles the Opus token bill — the doc's $0.0763 (fast) vs $0.0381 (standard) 2× relationship is exactly right. |

Two latency facts the cost table doesn't capture but the architecture should: Opus-fast is ~9–11s but **varies with Anthropic load** (one tick spiked to 34s mid-session, then recovered to 9s — server variance, not throttling; usage was at 17%). And **Haiku is cheaper but *slower* than Opus-fast** (~18s vs ~9s) — it is a slow-lane model, never the fast cheap lane. For a live reaction the cheap-fast option is OpenAI nano/mini, not Haiku.

### 2. "Slow pull every few minutes" == "5% Opus escalation" (the doc already lands here)

300 ticks/hr × 5% Opus = 15 Opus pulls/hr = **one every 4 minutes**. So the slow-Opus cadence you're describing and the doc's escalation-rate cap are the *same operating point* expressed two ways. The refinement worth making explicit is a **two-clock trigger** for the Opus pull:

```text
Opus deep pull fires on  max(  slow clock,  stakes trigger  )
  slow clock     = every ~4-5 min, unconditional (refresh spine/strategy)
  stakes trigger = nano per-tick classifier flags objection / fee / close / hostility
```

Most ticks stay on nano ($0.0017). Opus shows up on the clock **plus** the few moments that actually matter. That keeps Opus quality live while the baseline cost is a slow clock, not a 12-second firehose. Everything between pulls — the "punched-up with smaller APIs" layer — is nano/mini reactions that **use the last Opus pull as their context**, so the cheap layer inherits Opus's strategy without paying Opus's price.

### 3. The $36 transcript assumption is the optimistic number — STT is the real budget risk

Per this doc's own STT table, **7 fully-active agents = $222–444/mo** — $36 only happens at very low occupancy. At realistic gated occupancy (35–50%) on `gpt-4o-mini-transcribe` it's **$78–111/mo**. So budget STT at **~$80–125, not $36**, and treat hard idle / no-answer / voicemail / silence gating as a **first-class cost control**, not a nicety. STT — not the coach model — is the single line most likely to blow the outside-API target. The coach-model spend is the *easy* part to keep small; the transcript meter is the hard part.

### 4. A cheaper cheap-lane to A/B (optional saving)

The doc routes the cheap tier to `gpt-5.4-nano` ($0.20/$1.25). Two legacy/alt models are cheaper on **output** (the dominant cost for short coach calls): **gpt-4o-mini ($0.15/$0.60)** and **gpt-4.1-nano ($0.10/$0.40)**. If nano-5.4 is overkill for the punch-up / cleanup / summary lanes, a quality A/B against gpt-4.1-nano could shave the ~$20 cheap-lane bucket further. Not load-bearing — STT gating matters 5× more — but free money if the quality holds.

### 5. The crisp answer — how to use the $200 coach pool smartest

- **Claude $200 → Opus, slow + stakes-gated only.** Baseline deep pull every ~4–5 min + stakes-triggered pulls, capped ~5% of ticks (~$100/mo of the pool, per the doc's sweet-spot scenario), leaving headroom for ask-the-coach + strategy. **Never baseline-Opus every tick** — that's $4k/mo and the whole reason the pool feels tiny.
- **OpenAI metered → everything frequent and cheap.** nano classifier every tick · mini for drafts/uncertain beats · cleanup + rolling summary · and **STT, the big one (~$80–125, gate it hard)**.
- **Codex $200 → blog writer + resolution file-reading** (plus grader/closeout/health-flags) — slow, latency-tolerant, off both other budgets. Reachable only via a **subscription-auth `codexAgentRunner`** that strips `OPENAI_API_KEY` and uses a dedicated `CODEX_HOME` (per the Codex section above) — otherwise it silently bills the metered API instead of the $200 sub, the mirror image of the `claude -p` billing trap.

**Net monthly:** Claude pool ~$100 of coach-Opus (inside its $200, with room), OpenAI metered ~$150–200 (STT-dominated), Codex flat. The two levers that decide whether you hit the outside-API target are, in order: **(1) STT occupancy gating**, then **(2) keeping baseline Opus on the 4–5 min clock instead of the 12-second tick.** The coach-model cost is not the problem; the transcript meter and the Opus cadence are.

### 6. What's still estimate vs. measured

- Measured live: Opus-fast tick ($0.085), Haiku tick ($0.009), the 2× fast premium, the latency variance.
- Inferred (confirm with one run each): regular-Opus tick (~$0.042 = half of fast); whether `gpt-5.4-nano` beats `gpt-4.1-nano` on quality-per-dollar for the cheap lanes.
- Unmeasured and most important: **actual call-minutes per floor-month** (drives STT) and the **real dynamic-input size** of a mature call transcript (drives every Claude tick). Both should come from `AiTaskRun` telemetry before this model is trusted to the dollar — exactly as the section above says.
