# Unified Agent Brain — Architecture Plan (2026-06-24)

> Status: design, close-to-ready. WYNN-mono (the coaching/guidance content is one tenant;
> the dialer/CX platform underneath stays dual-tenant — different layer). Nothing here is built
> yet; this is the contract the build works against.

---

## 0. Thesis

One **brain** sits over *all* client-facing AI — live coaching, SMS replies, blog writing,
client-data synthesis, call grading — instead of each feature inventing its own prompts, context,
and model wiring. Every AI task becomes a **skill** the brain invokes, fed from one **shared
context**, executed on a Max-baseload / API-backstop substrate. The brain is **one orchestrator
engine** whose role — live coach, scheduled batch runner — is a *preprompt it is fed*, not a
separate codebase (§2): role is data.

Three facts shape everything:

1. **The API is "literally what you send."** Stateless: `system` (preprompt) + `messages` +
   `tools`, every call. There is no server-side skill, stored preprompt, or registry. So the
   brain — skill assembly, preprompt, context selection, routing, failover — is **a layer we
   build**, not a feature we get. It is the evolution of the existing **AI bus**
   (`aiProviders` / `aiTaskRunner` / `aiTaskRegistry`); the API and `claude -p` stay the dumb-fast
   executor.
2. **Reactions are nudges, not teleprompter lines** — a `Read/Steer/Try` move with a ~10–30s
   relevance half-life. So **~5s is real-time** for this use case. That single fact collapses a
   lot of complexity (no warm-SDK pool needed; both lanes can baseload on Max).
3. **Intelligence belongs in the build, not the render.** A cheap model faithfully renders a
   well-structured prompt (measured: Haiku executed a built prompt cleanly while Opus argued with
   the brief). So the smart model *routes, builds, and authors the library*; the cheap model
   *renders*. Two tiers — Sonnet on both the live build and the offline authoring (it responds to
   preprompting either way), Haiku on the render. No third tier: Opus buys nothing here right now.

---

## 1. Substrate — what executes (Max baseload + API backstop)

The substrate is the existing **AI bus**, with two execution providers and a governor on top.

| Provider | Role | Cost | Latency | Ceiling |
|---|---|---|---|---|
| **Max subscription** (`claude -p` / SDK on subscription auth) | **baseload** — preferred | flat | ~5s spawn (real-time for nudges) | rate-capped (~15 concurrent clean, measured; real ceiling higher) |
| **Metered API** | **backstop** — always armed, never removed | per-token | ~1–2s (no spawn) | scales with tier |

**The API never leaves the system.** It stays registered and warm as the failover provider; Max
is the *preferred* primary the router reaches *not* to use. This is the AI-bus failover with Max
added as a provider in the order (the blogger already runs `provider=agent with API fail-back`).

### Three spill triggers (the governor)

Spill at the **headroom threshold, not at the wall** — proactive thresholds keep us off the walls;
the reactive errors are the safety net behind them.

```text
TRIGGER            SPILL DURATION                 PROACTIVE (preferred)            REACTIVE (backstop)
429 (rate cap)     momentary — back off window    inflight >= safeCap (~10-12)     actual 429 -> back off, no retry-hammer
overage (allotment) long — until period reset      consumption >= ~85-90%           quota-exhausted error
latency rollover   adaptive — until p95 recovers   rolling p95 > ~8-10s             (none; latency is its own signal)
```

```text
route(call):
  consumption >= 90%     -> API   (overage guard)
  throttled (in backoff) -> API   (429 guard)
  p95 > latencyMax       -> API   (responsiveness guard)
  inflight >= safeCap    -> API   (concurrency guard)
  else                   -> Max
  on Max 429/overage     -> retry on API + mark Max-health state
```

The governor owns one small **Max-health state** `{ consumption%, throttledUntil, rollingP95,
inflight }` and routes every call against it. The thresholds are the **cost dial**: loose = more
Max utilization (cheaper, nearer the walls), tight = more spill (safer, more metered $). At current
floor scale we cross them rarely, so the bill stays mostly flat with the API catching only bursts.

### Measured facts (probed 2026-06-24)

- `claude -p` Haiku trivial: ~5s cold (CLI/auth spawn tax; the model is ~sub-second).
- 10 and 15 concurrent `claude -p`: **clean, no 429**, bulk near baseline, first tail at 15 (2/15
  to ~8–9s). One seat ≈ **~100 calls/min** at safe concurrency. The real ceiling is well above 15;
  we deliberately did not chase it.
- Nudge quality at Haiku is good (cold nudge produced a correct, sharp Steer).

### v1 substrate decision (2026-06-24): all-Anthropic, one Max account, agent-as-a-bus-provider

Locked: **v1 runs entirely on Anthropic via headless Max-account agents (`claude -p`) as the default
execution substrate.** No OpenAI in the v1 execution path. The metered API (Anthropic API + OpenAI)
stays **armed but rarely used** — the rollover must keep working, but at floor scale it's all but
never hit.

The hard requirement is **continuity on rollover**: if a service spills agent→API (or API→API),
context, output contract, idempotency, telemetry, and fail-closed behavior must be identical. The
clean way to get that — and what the 2026-06-24 code audit targets — is to make the **Max agent a
third PROVIDER in the bus** (`aiProviders`), not a per-service bolt-on:

- Today `aiProviders` builds only `{ anthropic, openai }` (both API); every task's `providerOrder`
  is `["anthropic","openai"]` / `["openai","anthropic"]` — **"agent" appears nowhere.** The agent
  path lives outside the bus, wired per-service (blogger, grader). That fragmentation *is* the
  continuity risk the directive names.
- Fix: an **`agent` adapter** implementing the same `{ supports, run } → { text|json, model, usage,
  provider }` contract by shelling `claude -p`. Then `providerOrder: ["agent","anthropic","openai"]`
  gives every service uniform `agent → Anthropic-API → OpenAI` failover *for free* through the one
  runner — continuity by construction, because the rollover is one code path, not N per service.

So "all-Anthropic-Max default" and "API rollover with continuity" become the **same** mechanism: the
existing provider-order + failover, with the agent added as the preferred provider. (The blogger's
`provider=agent with API fail-back` is the prototype of exactly this, done per-service; the audit
asks whether to lift it into the bus.)

---

## 2. The brain — one orchestrator engine, specialized by a role preprompt

There is **one orchestrator *type* — a generic engine** — and it becomes the live coach, the
scheduled batch runner, or anything later, purely by the **role packet** it is fed. This is the
direct consequence of "the API is what you send" (§0): the engine's *judgment* is a preprompt, so
the role is **data, not code.** Adding an orchestrator = writing a role packet, not forking the
engine.

A **role packet** is two parts:

| Part | What it sets | Lives as |
|---|---|---|
| **preprompt** | the role's judgment — how to translate, route reaction-vs-guidance, build sub-agent prompts, when to propose a skill | the cached `system` block |
| **policy config** | allowed skills · model · cadence · lane + priority · output contract | a small declarative record |

The **engine** (shared code, identical for every role) owns the deterministic mechanics no preprompt
should touch: the governor/failover (§1), validation of the model's proposed `control` changes (§7),
context I/O (§5), the compliance gate (§8), the cadence timer, and the DNC interrupt.
**Preprompt = judgment; config = policy; engine = safe machinery.** It is the same split as
parent→sub-agent (a smart node builds a preprompt that specializes a cheap renderer), lifted one
level up: now a config specializes the *orchestrator* itself.

### The two roles we ship first

| Role | Skills | Lane | Cadence / trigger |
|---|---|---|---|
| **Live** | coach reaction, coach guidance, **SMS** | metered API + Max baseload | event-driven; SMS rides at *lower priority*, coach pre-empts under pressure |
| **Scheduled** | blog, grade, client-synthesis | Max baseload (paced) | cron/batch, latency-tolerant; stagger across the window |

Same engine, two packets. **Many runtime *instances*** of each — one per active session/job, each
isolated (per-call state never bleeds — same discipline as the dialer rail). The lane mechanics that
*do* differ — live has a cadence timer + interrupt + streaming; scheduled is batch with no interrupt
— are policy-config flags on the one engine, not separate codebases.

### The two tiers (parent / sub-agent)

```text
PARENT (smart, on a cadence):
  read -> translate (grammar/logic + tax guidelines) -> classify reaction|guidance (can be both)
  -> select skills, compose the detector's tool-matches -> build the sub-agent's STANDING prompt
SUB-AGENTS (cheap, per-turn):
  render the parent-built prompt -> reaction / guidance output
```

The parent does, at runtime, the prompt-engineering we'd otherwise do offline — it absorbs the
intelligence so the sub-agents can be the cheapest model. **The parent runs on a cadence (~1/min),
not synchronously in front of every reaction** — it *maintains* the sub-agent's standing config;
the sub-agent fires fast off that config + the live turn. (Synchronous parent → sub-agent stacks
~5s + ~5s = ~10s and pushes the nudge half-life.)

### Model map

| Tier | Job | Model | Cadence |
|---|---|---|---|
| Parent / orchestrator | translate · route · build sub-agent prompt · **author the library offline** | **Sonnet** | cadence live; batch offline |
| Sub-agents | render → reaction / guidance | **Haiku / mini** | per-turn |

**No Opus — two tiers, one smart model.** Sonnet responds to preprompting for *both* jobs: the live
build *and* the offline authoring/auditing of the library. A third tier buys nothing right now. The
offline author is itself just another role packet (preprompt + config) on the same engine, so its
model is one config field — if a harder auditing job ever wants a bigger model, swap the field, not
the design.

### Does Haiku render faithfully? (probed 2026-06-24)

Tested the core bet directly: Sonnet builds the prompt → Haiku renders it → Sonnet renders the
*same* prompt as the gold control → 3 adversarial judges (contract / groundedness / usefulness-vs-
gold) across 7 WYNN moments (covered → edge → safety → guidance). Findings:

- **Zero material quality gaps.** Every Haiku render scored "minor" or "equivalent" vs the Sonnet
  control — never "material." The render tier does not move quality; **the build carries it.** The
  bet, confirmed.
- **The hard turns held.** Novel objection (family-CPA-calls-it-a-scam), distressed prospect (fear
  of losing the house), and the *guidance* seat (steer-back-to-discovery) all came back grounded
  3/3, zero hallucinations. Haiku improvised *safely* and rendered guidance faithfully — it did
  **not** invent dangerous claims on the turns expected to break it.
- **The two real weaknesses are deterministic, not cognitive.** Raw faithful rate 4/7; every miss
  was either (a) **length drift** — Haiku reliably overruns the word caps (TRY lines 40–68 words vs
  a "short line"); or (b) **compliance *precision* drift** — softened a mandated exact string
  (dropped literal "Circular 230"; "approval" for "signature") or added a soft intensifier
  ("immediately triggers", "I get why that sounds great"). **No miss was a prohibited promise** — no
  guarantee, no settlement, no "pennies on the dollar." Judgment sound; discipline slipped.

**Hypothesis holds, sharpened: Sonnet's job is to build a *prescriptive* prompt; two cheap
deterministic gates clean up the rest; no Sonnet re-render needed (no quality gap to close).**

- **Prescriptive build (the lever).** Most misses trace to the build leaving a choice open that
  Haiku filled slightly wrong. On compliance-critical and bait turns, Sonnet bakes the mandated
  strings and the exact opener as near-verbatim ("render approximately: '…'"), shrinking Haiku's
  degrees of freedom where they're dangerous. Sonnet rendering its *own* build chose the safe opener
  ("we won't guess") — so the fix is to put that opener in the build, not to re-render.
- **Two deterministic post-gates (no model).** (1) per-line word-cap enforcer → hard-trim or one
  "tighten" retry; (2) the §8 compliance gate made **bidirectional** — forbid banned claims *and*
  assert required strings per active topic. Fail-closed.

Caveats: n=7, one render each (no variance estimate); judges were Sonnet and "gold" was Sonnet's own
render, so gap-vs-gold is gap-vs-Sonnet by construction (which is exactly "faithful *enough*"); the
12/25-word caps are strict, so part of the 4/7 is a strict-contract artifact, not Haiku weakness —
the format spec is itself a knob. Multi-turn skill execution (the payment ladder across 4 turns) is
the untested next probe.

### Blog: published precision is high-variance, and "facts-as-tool" is not the fix (probed 2026-06-24, two runs)

Ran the rig on 6 precision-dense tax topics (OIC · installment agreements · CP504-vs-LT11 · CNC ·
CSED · FTA) with exact source-fact sheets. The second run corrected an overclaim from the first —
keep both, the correction is the lesson:

- **Run 1 (brief-only):** Haiku produced catastrophic errors — invented a "$10k/$25k" streamlined-IA
  threshold (source: **$50k / 72mo / Form 9465**), mislabeled the CP504 with the LT11's subtitle.
  Read alone this looked *systematic* (1/6 faithful), and the first draft of this section said so.
- **Run 2 (same brief-only condition, re-run):** **2 fact errors across all 6, avg precision
  2.83/3** — the $10k/$25k fabrication and the CP504 mislabel **did not reproduce**; those topics
  came back clean.

**So the dominant signal is VARIANCE, not a systematic flaw.** Identical prompt, same model, swung
from ~15 errors to 2. Haiku's published-precision *mean* is decent (~2.8/3); its *tail* includes
catastrophic fabrication, and the tail is unpredictable. The Run-1 "Haiku reliably fabricates" claim
was an n=1 artifact — corrected here.

**The A/B that answers "just give it the fact tool":** Run 2 also tested arm2 = Haiku handed the
**verbatim facts as an authoritative reference block** (what a ReferenceDatum/TaxTopic tool would
hand the renderer) + "reproduce verbatim, invent nothing." It was **not better — slightly worse
(5 errors vs 2; 2.5 vs 2.83/3).** Raw facts made Haiku *interpret more* (terse bullet → prose) and
it drifted in the gap: softened "the most it can collect" → "best outcome," hedged "interest IS
reduced" → "may be reduced," added "offset tax refunds" to a levy/lien/garnish list. A brief-fidelity
check confirmed the Sonnet briefs carried every fact (0 dropped) — the brief was never the lossy
step.

**The counterintuitive lesson: the brief is not a lossy intermediary — it is value-adding
pre-digestion.** Sonnet turns terse authoritative facts into publication-ready, pre-phrased,
structured prose with explicit "do not soften this" rules (the captured briefs read like near-
scripts). That **shrinks the cheap renderer's interpretive surface**, which is what kept the
brief arm clean. Handing the renderer raw reference data and trusting a "verbatim" instruction does
the opposite. This is the coach probe's *prescriptive-build* lesson generalized: **the smart model's
job is to pre-digest, not just to retrieve — the less the renderer interprets, the less it drifts.**

Architectural conclusion (the §6/§8 recommendations survive, for the corrected reason):

1. **A published surface cannot ship a high-variance renderer unsupervised** — you cannot risk the
   run that invents $25k. So blog stays **`model: sonnet`** (clean in both runs) on the no-cost-
   pressure scheduled lane; a cheaper Haiku lane is viable *only* behind a hard fact-binding gate
   that catches the tail. Render tier is still per-skill (one config field) — this just sets blog's.
2. **The fact-binding gate (§8) is mandatory for published skills** — it catches *both* the
   variance-tail fabrication *and* the paraphrase-softening drift, neither of which the no-promise
   lane sees.
3. **Pre-digestion + binding > raw-facts + trust.** Facts come from the verified pool (§5), the
   smart model pre-phrases them into the brief, the gate verifies; the renderer never interprets raw
   reference data unsupervised.

**Honest limit (the meta-lesson across all three probes): every cell is n=1.** The 2-vs-5 arm gap is
within the variance just demonstrated, so this does *not* claim pre-digestion *significantly* beats
facts-as-tool — only that facts-as-tool did not help. For a published surface the **tail is what
ships**, so the real production-decision probe is **multi-sample worst-case** (e.g. 5 renders /
scenario, judge the worst not the mean) — not the single-sample point estimates used so far.

**Domain-expert correction (2026-06-24) — and it reverses the arm comparison.** The firm principal
reviewed arm2's 5 flagged "fact errors" and overturned at least 3: *"interest may be reduced"* is
**more** correct than the source's flat *"interest IS reduced"* (FTA doesn't abate interest; removing
the penalty lowers the interest paid over time); *"the IRS can offset your tax refund"* is **true** (a
real collection action the terse sheet omitted); the OIC *"best outcome"* rephrase is acceptable. So
arm2's "drift" was largely **Haiku adding correct domain knowledge the source sheet lacked** — not
fabrication. With the false flags removed, facts-as-tool ties or beats brief-only *and* produced
richer content. Three consequences, all bigger than the model-tier question:

1. **A strict fact-binding gate (output ⊆ source set) is the WRONG gate** — it would strip "the IRS
   can offset your refund," a true useful fact, for being unsourced. It enforces the *poverty* of the
   source set.
2. **The needed distinction is wrong vs unsourced-but-true** — a domain judgment, not a string match.
   So the string-check can only *flag* unsourced figures for review; the real arbiter of published tax
   content is an **expert-vetted source pool + human review** (publish-approval, §6). The durable fix
   is upstream: make the pool rich enough that the renderer rarely needs to supplement.
3. **Every precision score this session measured adherence-to-the-sheet, not tax-truth.** Synthetic
   judges are capped by ground-truth quality; a terse, slightly-wrong answer key yields terse,
   slightly-wrong "errors." Decision-grade evaluation of tax accuracy needs the domain expert or
   authoritative IRS source docs as ground truth — not a model judging a model against a bullet list.

### SMS: the cleanest Haiku case (probed 2026-06-24, 3 samples/scenario)

Tested the SMS skill as Haiku off a standing Wynn-rep preprompt (DNC-absolute · no-fee-over-text ·
no-guarantees · stay-on-task→book-a-call): 9 inbound texts × 3 samples across DNC / vague / on-task,
judged on intent, DNC-miss, false-opt-out, compliance, on-task. **Strongest result of all three
probes — and zero variance:**

- **DNC recall 100% (0 missed of 9 opt-out samples)** — including the no-keyword semantic opt-out
  ("please stop texting me") and the legal-threat opt-out, which a `STOP`-regex lane would miss. So
  the model is a strong **second layer** behind the deterministic regex: combined (regex ∨ model-flag
  → suppress), DNC coverage is near-airtight.
- **Zero false opt-outs** — the DNC-absolute / when-in-doubt-suppress bias did *not* over-trigger on
  the benign "who is this and how'd you get my number?" (it replied, identified, offered a call).
  Safety bias bought no precision cost.
- **Zero compliance violations · zero on-task failures · 27/27 intent-correct · every scenario 3/3
  consistent.** The fee question never got a number (all pivoted to a call); the $40k-distressed
  money-ball stayed empathetic + represent-first with no settlement promise; the bot-bait redirected
  once without derailing.

**Why so clean, and why no variance (unlike blog):** SMS is *render-from-supplied-content* — intent
classification + a short on-mission reply governed by a clear preprompt — not *render-from-knowledge*.
It lands firmly on the Haiku-safe side of the §2 dividing line, confirming the line predicts which
surfaces are cheap-renderer-safe. The plan's `model: haiku` for SMS is validated.

**Two doctrine gaps caught by *reading the outputs* (the judge + answer key missed both):**
1. **Bot disclosure.** To "are you a real person or a bot?", Haiku answered "Real person here!" — an
   AI asserting personhood. Bot-disclosure law (e.g. CA B.O.T. Act) can require disclosing automated
   nature in sales texts. The SMS preprompt needs an explicit honest-disclosure stance, not an
   improvised denial. (Also the lesson again: an aggregate score hides what reading the text reveals.)
2. **"Stop collections" as a written claim.** The money-ball replies said "we help stop collections"
   — fine spoken on a call (it's in the WYNN scripts), but at scale *in writing* it edges toward an
   outcome claim. Tighten to "work to stop / request a hold on collections" in the preprompt + the §8
   string-lane.

### Grader: the one case Haiku FAILS — agreeableness becomes confabulation (probed 2026-06-24, 3 samples + Sonnet control)

Graded a planted 15-turn transcript (deliberate flaws: a discovery gap, a verbatim fee apology, a
verbatim over-promise "we can stop the garnishment", a soft close) on the real grader scorecard
(7 agent dims + 5 lead dims, each score + evidence), 3× Haiku + 1× Sonnet, with a grounding verifier.
**Haiku failed — and in the worst way a grader can:**

- **Lenient:** overall agent 4/4/5 vs Sonnet's 3. It scored **compliance 5/5** on a call with a
  verbatim over-promise *and* a verbatim fee apology.
- **Missed exactly what a grader exists to catch:** fee apology **0/3**, over-promise **0/3** (it
  reliably caught only the discovery gap, 3/3 — the one "what's missing" checklist item).
- **Ungrounded — it confabulated a *defense*:** 2/3 runs invented evidence. The worst — *"Turn 7:
  accurately states POA stops garnishment (technically correct via NOA)"* — Haiku **fabricated a
  legal mechanism (Notice of Assignment)** to *justify* the over-promise it should have flagged, and
  wrote *"Fee stated matter-of-fact, no apology"* contradicting the transcript. Worse than missing
  the violation: it manufactures an authoritative-sounding clean grade that tells a manager the agent
  was compliant when they weren't.

**Sonnet, same transcript:** caught all four flaws, scored **compliance 2/5** ("a direct outcome
guarantee… exposes the firm to regulatory and reputational risk"), flagged the apology by name,
soft-close 2/5, realistic **overall 3/5**, fully grounded — plus a genuine value-add coaching item.

**Why grading breaks Haiku — the third axis.** The data axis (supplied-content vs knowledge) isn't
enough. Grading adds a **stance axis: agreeable-render vs adversarial-judgment.** The very trait that
makes Haiku excellent at SMS and the coach card — faithful, agreeable rendering — makes it a *bad
grader*: it wants to credit and rationalize, so it confabulates a charitable story. Grading needs
skepticism (find the flaw, resist the charitable read) — the opposite stance.

**Design rule (broader than the grader): any judge / grade / audit / QA / critic seat must be the
critical model (Sonnet), never the cheap one.** Haiku renders; Sonnet judges.
- **§6: the call grader is `model: sonnet`, not Haiku** — scheduled/batch, no latency or cost
  pressure, so there's no reason to risk the cheap tier. Joins blog on the Sonnet side.
- **Live-system flag:** the *current production grader runs Haiku* (`CALL_GRADER_PROVIDER=agent`,
  Haiku `claude -p`). This probe implies those live grades are **inflated and ungrounded on the
  compliance dimension**, possibly confabulating defenses for real agent over-promises — audit + model
  switch warranted before the grades are trusted for QA/coaching.
- Retroactively validates that **every probe this session used Sonnet as the judge** — a Haiku judge
  would have been lenient/confabulating, compromising the whole evaluation. The verifier seat must be
  the adversarial model.

---

## 3. The three layers — preprompt / tools / skills

The dividing line is **shape of the moment**:

| Layer | Definition | How the API sees it | Contents |
|---|---|---|---|
| **Preprompt** | standing rules, always true, never fetched | the cached `system` block we assemble | Phase spine · DiscoveryItem checklist · DoctrineRules (compliance + WYNN tone) · OutputContract |
| **Tools** | a single move — one trigger → one unit, stateless | request `tools` + detector-pulled content injected into the message | Objection · Tactic · TaxTopic+explainer · ReferenceDatum |
| **Skills** | a committed multi-step sequence that owns the floor until it exits | the orchestrator-assembled bundle (instructions + tools + context) for an invocation | payment-ladder · strategist · grader · SMS-triage · roleplay · pitch |

**Dividing rule:** always-on + universal → preprompt; triggered + situational lookup → tool;
multi-step + stateful + branching → skill.

> A tool answers "what do I say to *this*?" (navigator stays in control). A skill is a play that
> takes over the next several turns. Preprompt is the rulebook both obey.

---

## 4. The guidance object model (WYNN content)

~90% of this content already exists in code — the job is making it **explicit, object-oriented,
de-duplicated**, not building from scratch. Ten entities, one canonical home each:

| Entity | What | Canonical home | Action |
|---|---|---|---|
| **Phase** | 7-stage arc (Intro→Discovery→Expert/Financial→Pitch→Payment→Info→Close) + entry/exit/factsDue/advanceGoal | **none — scattered** | **NEW first-class object** → preprompt spine |
| **DiscoveryItem** | fact to capture + questionBank + followUps | hardcoded, defined 4× | **one registry**, everything imports it |
| **Objection** | keywords + `{read,reframe,moves,lines}` (+ `failureModes`, `phaseAffinity`) | `liveCoachObjectionBank.js` (19) | **crown it**; reduce the 4 other copies to projections |
| **Tactic** | psychology move + `applies()` + humor boundary | `TACTIC_RULES` (20) | keep; reserve priority bands for incoming depth |
| **TaxTopic** | detection + **explainer** | `CONTEXT_RULES` + aliases (detection) | **unify** detection + the doc-only explainers |
| **Play** | multi-step branching sequence | **none — scripts only** | **NEW first-class object** → skill (payment-ladder) |
| **ReferenceDatum** | fees, forms, minimums, firms | scattered | one WYNN table (no tenant columns) |
| **DoctrineRule** | always-on rules (compliance, advance-only, **tone**) | `FIXED_*` + `OBJECTION_DOCTRINE` | promote the 13 mechanics + the script **tone doctrine** into the cached prefix once |
| **OutputContract** | per-seat output shape (Read/Steer/Try, grader JSON…) | per-seat prompts | model as one type |
| **ScoringRubric** | 3 graders (agent / lead-quality / trainer) | distinct already | keep distinct; factor the shared grounding fence into one DoctrineRule |

**Consolidation wins (pure dedup, highest ROI):** one `DiscoveryItem` registry · crown the objection
bank · promote `OBJECTION_DOCTRINE` into the prefix once · unify TaxTopic detection+explainer.
**Depth headroom (the user's incoming objections + tactics):** add `Objection.failureModes` +
`phaseAffinity` and `Tactic` priority bands *now* so new entries slot in without reshaping.

(Source-of-truth inventory: `docs/COACH_DICTIONARY_MATRIX.md` + the 56-artifact inventory; the two
sales scripts — crown the consultative Tax Group script as canonical, the Universal is the older cut.)

---

## 5. The shared context service (the moat)

> "Everything can be fed this wealth of information instead of writing its own context."

Today every service reinvents context (the blogger assembles sources, the SMS classifier builds its
frame, the coach builds its prompt, the grader builds its input). One **shared context pool** that
every skill draws a slice from gives DRY *and* — the bigger win — **one voice and one set of facts
across every client-facing surface.** The blog, the text, the coach card, and the grade all speak
from the same verified knowledge.

The pool is client-centric: case/Logics data, call history, documents, health flags — plus the
guidance object model (§4). The brain's real job is **selecting the relevant slice per skill and per
client.** This is where the client-health-flag service and the Logics case bank were already heading.
**Skills are cheap to add; a trustworthy shared wealth is the hard, valuable part** — and keeping it
correct is the offline author's job (Sonnet, batch), because everything downstream trusts it.

The blog probe (§2) is the proof this matters — with a sharpening. Sourcing facts from this pool is
*necessary but not sufficient*: when the pool's facts reached the renderer as **raw reference data**,
the cheap renderer still drifted (softened/inferred while turning bullets into prose). The fix is
**pre-digestion** — the smart model phrases the pool's facts into publication-ready form, the
renderer renders that, and a fact-binding gate (§8) verifies the figures survived. **The pool is the
only safe fact source; the smart model phrases it; the renderer never interprets raw facts
unsupervised; the gate checks.** A skill's job is to *phrase* its facts, never to *supply* them.

---

## 6. Skills catalog

| Skill | Lane | Trigger | Model | Output gate |
|---|---|---|---|---|
| coach **reaction** | live | per-turn reaction-worthy (detector) | Haiku/mini | compliance scrub |
| coach **guidance** | live | cadence / phase-change | Sonnet (parent) | — (internal guide state) |
| **SMS** reply | live (low pri) | inbound text | Haiku/mini *(probed ✓)* | compliance + DNC (regex ∨ model-flag) + bot-disclosure + send-gate |
| **payment-ladder** | live | enter payment phase / fee resistance | sub-agent driven by Play | compliance scrub |
| pre-call **strategist** | scheduled/pre-call | interview snapshot | Sonnet | — |
| **blog** | scheduled | cron | **Sonnet** (Max-agent) | **fact-binding** + compliance + publish approval |
| call **grader** | scheduled | call-end + evidence gate | **Sonnet** (`claude -p`) *(probed — Haiku is lenient + confabulates)* | — (internal) |
| client **synthesis** (dense doc reading) | scheduled | nightly | **Sonnet** (→ **Opus** when built — its standing candidate task) | PII-redaction |
| resolution **pitch** | scheduled | dossier (secondary sales) | gated reasoning | verdict fence |

---

## 7. Control flow — tool ↔ skill alternation

Tools and skills fire on **different trigger types**, so we never ask a model "tool or skill?" every
turn:

```text
content detected (keyword/alias/predicate)  -> TOOL   (reactive, per-turn, deterministic detector)
phase/lifecycle/commitment event            -> SKILL  (deliberate, owns the floor)
```

Alternation lives in **one mode state — `free` vs `in-skill`** — owned by the parent (the only thing
with full phase + call view):

```text
free:     detector -> tools -> Read/Steer/Try nudges
  trigger -> parent emits  control:{ mode:"skill", skill:"payment_ladder" }   (PROPOSE)
  orchestrator validates vs phase rules + owns-the-floor + legality            (DISPOSE)
in-skill: the play drives; tool-reactions subordinate
  play completes/aborts -> control:{ mode:"free" }
```

- **Propose, don't dispose:** the model proposes a skill change in its `control` field; the
  orchestrator validates + applies it (can't invoke `closing` while discovery's incomplete; can't
  abandon a play mid-step). Bounded self-direction = the agent loop, kept deterministic and safe.
- **Skill-invocation is mostly a deterministic state machine** (phase/lifecycle triggers fire
  skills); the model only arbitrates the gray zone (price resistance: tool nudge vs invoke the
  ladder, gated by phase + commitment).
- **The live model proposes which existing skill to run; it never rewrites a skill's content** —
  authoring is offline (Sonnet, batch), invocation is live.
- **Interrupts pre-empt everything:** DNC / compliance is the deterministic regex lane (no model),
  fires regardless of mode, terminates.

The one new field on the parent's output contract is **`control: { mode: free | skill:<name> }`** —
that single field *is* the alternation lever.

---

## 8. Safety — the central compliance gate

When one brain ships to blogs (public), texts (outbound, DNC-governed), and coach cards (read aloud),
a single model-invented claim has three ways to reach the world. So the deterministic
**generated-language compliance scrub** is not a coach feature — it's a **central, mandatory layer
every client-facing skill output passes through** before it ships, with per-skill scope:

| Skill output | Gate |
|---|---|
| coach card | guarantee/settlement-promise/unauthorized-conclusion scrub |
| SMS | scrub + DNC + send approval |
| blog | scrub + publish approval |
| synthesis | PII redaction before store/send |
| grade | internal — grounding fence only |

Deterministic (regex/allowed-claims), tenant-aware (WYNN allowed-claims), fail-closed (suppress or
fall back to the lookup-backed unit, never ship an unvouched claim).

**Bidirectional (probed 2026-06-24 — see §2).** The gate must both *forbid* banned claims **and**
*assert* required strings per active topic — the Haiku probe showed the renderer reliably *softens*
mandated citations (drops the literal "Circular 230", says "approval" for "signature") rather than
inventing forbidden ones. So the gate checks **presence, not just absence**: SSN/POA topic ⇒ output
must contain "Circular 230" + "signature"; garnishment/levy ⇒ must *not* contain timing words
("immediately", "same-day", "stop"). On a miss it patches the citation in or kicks back for one
retry. A per-line **word-cap enforcer** (trim or one tighten-retry) rides the same gate — Haiku's
one systematic non-compliance weakness is length, and length is countable.

**Fact-binding (probed 2026-06-24 — see §2; revised after domain review).** For *published /
render-from-knowledge* skills (blog, synthesis), figures / form-numbers / thresholds / deadlines in
the output are checked against the shared-context source set (§5) — but the check **flags for expert
review, it does not auto-reject.** Domain review found an unsourced claim is often *true*, not wrong:
the renderer correctly added "the IRS can offset your tax refund," which the terse source merely
omitted. The distinction that matters — *wrong* (a "$25k" streamlined threshold that doesn't exist)
vs *unsourced-but-true* — is a domain judgment, not a string match, so the string-check is a
**pre-filter** and the **expert publish-approval (§6) is the actual gate.** The durable fix is
upstream: a **rich, expert-vetted source pool** so the renderer rarely needs to supplement. (Note the
no-promise lane is still pure-deterministic and still auto-suppresses — guarantees/settlement claims
*are* string-matchable; tax-fact truth is not.) Render-from-knowledge skills get this lane;
render-from-supplied-content skills (the coach card) do not.

---

## 9. Cost & ops

- **Metered cost is bounded** — the live brain's metered bill is navigator-dominated, ~$0.5–1.5
  /agent-day, **halvable with transcript caching** (the #1 unrealized lever; the first pass never
  cached, and the prefix may be under the cache minimum — the object-model's stable doctrine prefix
  fixes both). Everything not on the metered path (Max baseload + the flat agent lane) doesn't grow
  the metered bill.
- **5s = real-time** for nudges → spawn-per-need, no warm-SDK machinery; the parent on a cadence
  keeps the per-reaction path at ~5s (not ~10s).
- **The governor (§1) is the rate/latency/overage manager** — prefer Max, spill to API on any
  threshold, never retry-hammer a 429.
- **Caching on the flat lane** doesn't save dollars (flat fee) — only latency/allotment — so we
  *stop fighting the cache architecture* on the Max baseload and reserve cache discipline for the
  metered peaker at scale.

---

## 9A. Registry Combination + Rollover Insertion Audit

The Max/account version only becomes reliable if the task catalog is singular. The current code has
the right runner shape, but task ownership is split:

```text
apps/ai-bus/src/server.js
  -> buildBusRegistry()
  -> aiBusRegistry copies ai.* primitives from aiTaskRegistry
  -> aiBusRegistry builds named tasks from aiSandbox/tasks.js
```

That means the "official-looking" named tasks in `aiTaskRegistry.js` can be edited without affecting
the live 7000 task surface. The concrete example is the grader: `aiTaskRegistry.js` names
`liveCoach.callGrade`, while `aiSandbox/tasks.js` names `liveCoach.callGrader`. One trailing `r`
means model ladders, env flags, cache policy, or failover edits can target the wrong object. This
must be fixed before agent-first/API-rollover becomes a production rule.

### Target Combination

There should be one canonical task catalog:

```text
aiTaskCatalog
  named production tasks:
    liveCoach.callStrategy
    liveCoach.rollingDigest
    liveCoach.contextJudge
    liveCoach.callGrader
    liveCoach.dialogComposer
    sms.classify
    activity.contactSafetyReview
    resolution.pitch
    blogger.currentEvent
    ...
  primitive dev verbs:
    ai.read
    ai.write
    ai.judge
    ai.score
    ai.transcribe
    ai.image
    ai.tts

aiSandbox
  prompt/schema/reference packet library only
  not a runnable registry
```

Production callers should use named tasks. Generic `ai.*` primitives remain useful for local tests,
one-offs, and internal composition, but they should not be the main production API.

### File-By-File Insertion Plan

1. `packages/shared-services/src/aiProviders.js`

   Current role: provider adapters live here; `createAiProviders()` only wires `anthropic` and
   `openai`.

   Change:

   - Add `createAgentAdapter(agentClientOrShell)` beside `createAnthropicAdapter` and
     `createOpenAiAdapter`.
   - Let `createAiProviders({ agent, anthropic, openai })` register `providers.agent`.
   - Agent adapter supports only reasoning/task kinds it can execute safely: `compose`, `json`,
     `classify`, and optionally `search` after the tool-loop contract is implemented.
   - Agent adapter returns the same normalized shape:

   ```js
   { text, json, model, usage, provider: "agent" }
   ```

   - Agent adapter must not perform side effects. It shells or talks to the account runner, parses
     output, estimates usage if exact token usage is unavailable, and returns a candidate result.
   - Unsupported modalities stay unsupported. `transcribe`, `image`, and `tts` should continue to
     skip to OpenAI or another explicit modality provider.

2. `packages/shared-services/src/aiTaskRunner.js`

   Current role: the strongest existing spine. It resolves provider order, runs provider/model
   attempts, validates output, records telemetry, and fails closed.

   Change:

   - Add a shared run envelope to every attempt:

   ```js
   {
     taskId,
     taskVersion,
     inputDigest,
     idempotencyKey,
     provider,
     model,
     attempt,
     fallbackReason,
     startedAt,
     elapsedMs,
     usage
   }
   ```

   - Thread `options.idempotencyKey` into the result and every telemetry row.
   - Resolve global substrate preference without overriding task capability:

   ```text
   AI_DEFAULT_SUBSTRATE=agent|api|registry
   ```

   `agent` means "try agent first when the task allows it"; `api` means "prefer metered providers";
   `registry` means "use the task's declared providerOrder."

   - Keep the existing `forceProvider` and env pin behavior as hard overrides, but log them as
     `routingOverride`.
   - Use one total deadline budget across rollover attempts. Do not let agent timeout + Anthropic
     timeout + OpenAI timeout exceed the caller's budget without an explicit batch deadline.
   - Keep validation after every provider. Rollover is only safe if every provider is judged by the
     same output contract.
   - Never run a side-effecting action inside `adapter.run()`. The runner returns a result; a keyed
     committer performs email/post/publish/write after validation.

3. `packages/shared-services/src/aiTaskRegistry.js`

   Current role: contains both real-looking named tasks and primitive tasks, but live 7000 named
   tasks are mostly built elsewhere.

   Change:

   - Either rename this file to the canonical catalog or create `aiTaskCatalog.js` and make this file
     a compatibility export.
   - Move every named task into that one catalog. No runnable named task should live only in
     `aiSandbox/tasks.js`.
   - Keep primitive tasks in a clearly marked `primitive` section, default-off for production HTTP
     routes.
   - Require these fields on every named task:

   ```js
   {
     id,
     version,
     family,
     kind,
     riskClass,
     latencyClass,
     providerOrder,
     models,
     contract,
     failClosed,
     buildRequest
   }
   ```

   - Add `providerOrder: ["agent", "anthropic", "openai"]` only where agent execution is allowed.
     Do not add `agent` blindly to compliance/customer-facing hot tasks until their risk policy says
     it is allowed.

4. `packages/shared-services/src/aiBusRegistry.js`

   Current role: production bus registry builder, but it currently composes two sources and owns a
   second schema validator.

   Change:

   - Stop rebuilding named tasks from `aiSandbox.listSandboxTasks()`.
   - Import the canonical catalog and expose that.
   - Delete the local validator or import the runner/catalog validator. There should be exactly one
     schema validator used by both tests and live rollover.
   - Keep this file only as a thin "build registry for 7000" wrapper if needed:

   ```js
   function buildBusRegistry() {
     return buildCanonicalRegistry({ exposePrimitives: false });
   }
   ```

   - Add boot-time assertions:
     - no duplicate task ids;
     - no named task with `promptTodo` is runnable;
     - every `contract` resolves to one validator;
     - every provider in `providerOrder` is either configured or loudly skipped at boot;
     - every task has a `failClosed` policy, even if the value is explicitly `null`.

5. `packages/shared-services/src/aiSandbox/tasks.js`

   Current role: functions as a second runnable task registry.

   Change:

   - Demote to packet inventory only: prompt source, schema source, cache hints, migration notes.
   - Keep `promptTodo` as documentation, not as runnable task state.
   - If a task is ready for production, copy/move its descriptor into the canonical catalog and leave
     a reference here.

6. `apps/ai-bus/src/server.js`

   Current role: still has large direct coach factories and then mounts the generic AI task routes.

   Change:

   - Wire `createAiProviders({ agent, anthropic, openai })` once.
   - Mount `buildCanonicalRegistry()` through the task route.
   - Migrate direct live-coach functions one at a time so each uses `runAiTask(taskId, payload,
     options)` internally.
   - Do not remove the proven hot path until the named task path has parity logs for provider,
     model, usage, latency, cache, and result shape.

7. `apps/ai-bus/src/aiTaskRoutes.js`

   Current role: HTTP task endpoint with useful option sanitization.

   Change:

   - Keep stripping privileged options from client calls.
   - Also strip or server-fill `idempotencyKey` when the caller lacks permission to provide it.
   - Continue to allow in-process callers to pass advanced options directly.
   - Add request labels and task run ids to response envelopes so 5001 can correlate rollover
     behavior with feature logs.

8. `packages/shared-services/src/aiTaskClient.js`

   Current role: 5001/app-side sender to 7000.

   Change:

   - Require production callers to pass a `label` and a stable `idempotencyKey` for tasks that can
     create downstream action.
   - Preserve timing split: `roundTripMs`, `busMs`, `transportMs`.
   - Never retry the HTTP call blindly for side-effect-capable tasks. Retry belongs inside the runner
     or in a keyed queue, not in an unkeyed caller loop.

### Rollover Invariants

Every provider attempt for the same task must preserve:

- same `taskId`;
- same `taskVersion`;
- same normalized request;
- same schema/validator;
- same `idempotencyKey`;
- same `riskClass`;
- same fail-closed result shape;
- same side-effect policy;
- same telemetry label.

Provider rollover may change only:

- provider;
- model;
- elapsed time;
- usage/cost;
- provider-specific cache metadata;
- fallback reason.

If the output contract cannot be identical across providers, the task is not rollover-compatible yet.
Mark it `providerOrder` single-provider until the contract is made portable.

### Side-Effect Rule

No model/provider adapter may publish, email, text, mutate Logics, mark DNC, update contactability,
or write final metrics. Provider attempts can be repeated during rollover, so they must be pure.

The safe flow is:

```text
runAiTask()
  -> provider attempts
  -> validated result
  -> keyed committer
  -> side effect exactly once
```

For live coach, "side effect" mostly means rendering advice and appending memory. For SMS, blogger,
grader emails, and Logics updates, the committer boundary is mandatory.

### Recommended Provider Policy By Risk Class

| Risk class | Example | Default substrate | Rollover |
|---|---|---|---|
| `internal_advisory_batch` | grader draft, manager summary, metrics explanation | agent | Anthropic API, then OpenAI if contract-compatible |
| `soft_live_guidance` | future coach strategy/guidance panels | agent or Anthropic API, based on latency governor | API rollover if p95/429/headroom says so |
| `customer_compliance` | SMS/DNC classification | API first | fail closed to human review; agent only after explicit approval |
| `published_content` | blogger draft | agent or Anthropic API | API fallback, but publish requires deterministic/human gate |
| `modality` | STT, image, TTS | explicit modality provider | no fake rollover unless another provider supports the modality |

This lets the future coach spend less money without pretending every AI feature has the same risk.

---

## 10. Build order

Each phase produces a verifiable artifact; nothing live-toggles until its gate passes.

1. **Object model + consolidations (no behavior change).** Define the 10 entities; crown the
   objection bank; one `DiscoveryItem` registry; promote `OBJECTION_DOCTRINE` + the WYNN tone
   doctrine into the cached prefix; unify TaxTopic detection+explainer; add `failureModes`/bands
   headroom. → kills the 4–5× duplication, gives the brain a contract.
2. **The shared context service.** First-class, authoritative — client slice + guidance object
   model. Everything else is plumbing around this.
3. **The substrate governor + registry combination.** Collapse to one canonical task catalog
   before provider rollover matters; add the `agent` adapter; keep API providers armed; enforce the
   3-trigger failover, Max-health state, per-key lane segmentation, idempotency, and single
   validator/telemetry envelope described in Â§9A.
4. **The orchestrator engine + role packets.** *One* engine; the live/scheduled roles are role
   packets (preprompt + policy config), not separate codebases; the parent/sub-agent two-tier; the
   cadence; the `control` field + the free/in-skill state machine; the deterministic DNC interrupt.
5. **Skill migration.** Re-home the existing AI services (coach, SMS, grader, blog, synthesis,
   strategist, pitch) as skills in the registry, fed from the shared context, behind the central
   compliance gate.
6. **Measure & tune.** The warm-SDK latency probe (only if 5s ever proves too slow); cache-hit-rate;
   the cost dial thresholds; the golden-set regression gate over the whole chain.

> Build order discipline: object model + context first (the moat), substrate + orchestrator next
> (the plumbing), skills last (re-homing what exists). Default-off until each gate passes.
