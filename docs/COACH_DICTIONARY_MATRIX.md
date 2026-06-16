# Live Call-Coach — Dictionary & Decision Matrix

*A human-readable map of what the coach listens for, how it decides what to say, and how the post-call grader scores. Generated from the live source — each section cites its file. Two separate systems: the **live coach** (during the call) and the **grader** (after the call).*

Sources: `liveCoachContextMatchBank.js` (what it hears), `liveCoachSanitizedPipeline.js` (context + tactic dictionaries, the decision contract), `liveCoachObjectionBank.js` (objection plays), `transcriptionScoringService.js` (the grader).

---

## TL;DR — how it decides (3 gates, 3 bars)

```
prospect/agent word stream
   │
1. DETERMINISM  (liveCoachContextMatchBank) — "is this conversation?"
   exact-phrase match → contextKeys + tacticKeys, scored & ranked (top 24)
   │
2. MINI gate    (gpt-mini) — "does this make sense?"  FILTER + GROUND, never composes
   junk (voicemail/IVR/filler) → HOLD;  coherent → grounds 2-3 candidate lines
   │
3. SONNET writer — "is this coachable?"  picks ONE move, rewrites the words
   nothing to add → replies exactly  WAIT  (suppressed, never shown)
   │
   emit  →  degradation ladder: Sonnet line  >  mini-grounded draft  >  deterministic baseline
```

- **Two engines by latency:** the fast path owns the UI ribbon and never composes; completed *thoughts* are the only compose trigger. Agent-initiated **Ask** questions route to Opus (best answer); live ticks stay on Sonnet (cheap, on-task).
- **Call phases:** **OPENING** (prospect turns 1-3) = scripted self-ID, verbatim lines. **ESTABLISHED** (turn 4+) = the *navigator* contract → `Read:` (≤12 words, what's happening) / `Steer:` (≤25 words, direction) / `Try: "…"` (optional exact words).
- **Whole-call memory:** a mini "scribe" keeps a **fact ledger** (keyed discovery facts) + a rolling ≤400-char call summary, fed back so the coach steers toward gaps and never re-asks.

---

## 1. Context dictionary — *what's happening* (14 rules)

`CONTEXT_RULES` in `liveCoachSanitizedPipeline.js:194-720`. Each: `family` (sales · tax_comprehension · human_context), `priority` 65-100, keyword list, guidance. Higher priority wins ties.

| Key | Family | Listens for (sample) | Coach instruction (gist) |
|-----|--------|----------------------|--------------------------|
| `legitimacy` | sales | who are you, scam, how'd you get my #, legit | Self-ID + firm, tie to their tax inquiry, ask permission to verify before pitching |
| `irs_notice` | tax | IRS, CP501/503/504, CP2000, LT11, Letter 1058, notice, federal | Treat as federal unless a state agency is named; ask notice type, year, amount, deadline |
| `state_tax` | tax | state, FTB, EDD, franchise/sales tax, state lien/levy | Separate state vs federal symptoms; screen for an IRS balance/unfiled years (bigger value) |
| `collection_pressure` | tax | levy, lien, garnish, bank freeze, paycheck, revenue officer | Confirm if money is being taken *now*, then move to representation + facts |
| `unfiled_returns` | tax | unfiled, haven't filed, years behind, missing return | Find the missing years + income type; cleanup is step one before guessing resolution |
| `payroll_tax` | tax | payroll, 941/940, trust fund, TFRP, withholding | Separate business vs personal exposure; ask quarters/years, is the business operating |
| `self_employment` | tax | 1099, contractor, self-employed, Schedule C, gig/Uber | Withholding likely didn't happen; ask years, records, expenses |
| `audit_adjustment` | tax | audit, exam, underreporter, adjustment, proposed assessment | Identify exam vs underreporter vs post-assessment balance; what doc/deadline |
| `spouse_identity` | tax | spouse, ex, divorce, joint, innocent/injured spouse, identity theft | Don't decide liability on the call; ask filing status, years, who the notice names |
| `money_pressure` | human | can't afford, rent, mortgage, bills, kids, paycheck | One human acknowledgment, then a concrete financial/enforcement fact |
| `emotional_pressure` | human | scared, stressed, worried, embarrassed, can't sleep | Sound human first, no therapy language, ask the next fact to regain control |
| `objection` | sales | not interested, busy, call back, already handled, expensive | Lower pressure, clarify the objection, return to why the review matters |
| `representation` | tax | represent, power of attorney, POA, 2848, 8821 | Frame representation as the foundation for facts + agency comms, not a magic fix |
| `fees_close` | sales | cost, fee, price, how much, what does it cost | State value + scope confidently *after* enough facts; don't apologize for price |

---

## 2. Tactic dictionary — *what move to make* (20 rules)

`TACTIC_RULES` in `liveCoachSanitizedPipeline.js:770-1017`. Each: `family` (psychology · sales_psychology · humor), `priority` 20-100, an `applies()` test (on context keys, raw text regex, or jurisdiction), guidance, and a **humor boundary** (never-do). Several fire on **raw text only** (no context key needed).

| Key | Fires when | The move | Never |
|-----|-----------|----------|-------|
| `calm_urgency` | `collection_pressure` | Calm urgency not alarm; confirm enforcement, then facts | No humor around levy/garnishment/liens |
| `human_reassurance` | `emotional`/`money_pressure` or "scared/overwhelmed/lost my job" | Mirror the life pressure plainly, then one control question | Warmth not jokes |
| `permission_legitimacy` | `legitimacy` | Slow down, ID agent+firm, tie to tax signal, ask permission | No jokes until legitimacy restored |
| `lower_pressure_objection` | `objection` | Respect resistance, lower pressure, ask one fact/permission | Never joke around DNC/anger/distrust |
| `confident_value_frame` | `fees_close` | Answer price with confidence + scope; no apology/discount | No humor on fee pressure |
| `expert_specificity` | payroll/SE/audit/spouse keys | Name the next fact that matters → prove expertise → ask docs | No jokes about complex/embarrassing facts |
| `shame_reduction` | `unfiled`/`spouse` or "embarrassed/years behind" | Normalize without excusing; make it feel sortable | Don't make them the joke |
| `state_to_irs_screen` | `state_tax` or jurisdiction state/mixed | Don't over-anchor on state; screen for federal balances | Clarity over personality |
| `next_phase_control` | any context key present | Advance one phase: identify → discover pain → prove → gather | Light warmth only when calm |
| `light_warmth_allowed` | calm + "what a mess/i hate taxes" | Brief human softener, then pivot to the next fact | Never joke about enforcement/the prospect |
| `anchor_to_inquiry` | "didn't ask / never signed up / why would I" | Re-anchor with quiet authority: "you submitted an inquiry…do you owe the IRS or not?" | No humor — calm certainty disarms |
| `hostility_resilience` | "f you / stop calling / harass / loser" | Stay flat, acknowledge once, one clean value attempt; honor a genuine stop | None — humor reads as mockery |
| `loop_in_decision_maker` | "my spouse / ask my wife / file jointly" | Affirm involving them, gather facts now so that talk is informed | Never joke about the relationship/authority |
| `dissolve_stall` | "think about it / call me back / email me" | LAER: explore the real hesitation (cost vs legit); tie waiting to compounding penalties | Not on a hard no / money pressure |
| `already_represented` | "I have a CPA / attorney / tax guy" | Separate filing from resolution; screen if actually represented on collections | No jokes at the other provider |
| `earn_trust_with_proof` | not legitimacy + "scam / prove it / skeptical" | Offer real proof/verification, not defensiveness | No humor — reads as deflection |
| `channel_relief` | "thank god / finally / you can really help" | Meet the relief sincerely, then move forward | Warmth yes, jokes no |
| `momentum_close` | "let's do it / sign me up / where do I sign" | Match energy one beat, then get practical | Don't over-celebrate (buyer's remorse) |
| `buying_signal_momentum` | "how does this work / what happens next / process" | Treat as buying signal; answer the momentum + next step | No cuteness about the process |
| `mirror_to_open` | **no** strong topic matched (`keys.size === 0`) | Voss mirror/label to open them up and surface a topic | Mirrors carry their own warmth |

*(Frameworks behind these: Voss mirror/label/calibrated-Qs, SPIN, Sandler, Cialdini — mapped to tax resolution.)*

---

## 3. Objection plays (18) — `liveCoachObjectionBank.js`

Detected by trigger phrases; the coach gives the *play*, never a verbatim script.

| Objection | Trigger (sample) | The play |
|-----------|------------------|----------|
| **DNC / revocation** *(terminal)* | stop calling, do not call, take me off | Confirm removal immediately — no value statement, no one-more-question |
| Not interested | not interested, i'm good, we're all set | Reflex brush-off, not a verdict; re-anchor to their inquiry |
| Don't trust / scam | scam, tax relief companies are crooks | Validate first ("right to be careful"), offer live verification |
| Talk to spouse first | talk to my wife/husband, ask my spouse | Get them on the line NOW — explain once to both |
| Need to think | think about it, sleep on it | Isolate: "usually it's the cost or whether this is legit — which is it?" |
| Can't afford it | can't afford, broke right now | Test objection vs *condition* — is the money truly not there, or…? |
| Too expensive | too expensive, why so much | Re-anchor: fee as % of the debt + penalties already accrued |
| Handle it myself | call the IRS myself, deal with them myself | Takeaway/negative-reverse: concede the simple case honestly |
| Already represented | my CPA/accountant/attorney handles it | Value audit not attack: actively representing on *collections*, or just prep? |
| Already paid / got burned | paid another company, got burned | Take their side, listen long; then differentiate |
| Just email me | send me something, email me the info | Agree + confirm address (momentum), one fact "while pulling it up" |
| How'd you get my # | never signed up, how'd you get my info | Answer with the real opt-in data (source + date + masked email) |
| Busy / driving | bad time, at work, i'm driving | 90-second version OR a precise window ("4:30?") |
| Guarantee / pennies on dollar | guarantee, settle for less, promise me | Name it: anyone guaranteeing a number before transcripts is lying |
| IRS hasn't bothered me | haven't heard from them, it can wait | Math the silence: penalties since the balance year; name the triggers |
| Already on a payment plan | installment agreement, paying monthly | Treadmill test: "is the balance lower than the day you set it up?" |
| How much (early) | how much do you charge | A **buying signal** — give the *shape*, refuse false precision |
| Hopeless / too far gone | too far gone, no one can help | Not an objection — a confession; normalize with specifics |

**Doctrine** (`liveCoachObjectionBank.js:13-28`): advance-only · never apologize for the call · *agent* decides when to quit · **DNC is terminal** (only exception) · objections = requests for information / buying signals · agree-first · **isolate** before answering · feel-felt-found · boomerang · porcupine (answer with a better question) · reduction (per-day terms) · takeaway · close on **alternative choice** never yes/no · **silence after a number** belongs to the prospect · watch tense shifts ("would"→"will", "if"→"when") → stop selling, start scheduling · example lines are third-person, never read verbatim.

---

## 4. How words become keys (matching mechanics) — `liveCoachContextMatchBank.js`

- **Exact multi-word phrase match** (no stemming/fuzzy) via `keywordHit()` (:957) on text normalized by `normalizeBankText()` (:937 — lowercase, collapse whitespace, smart-quotes→`'`, dash/punct normalize). Word keywords use word-boundary regex; phrases allow flexible internal spacing.
- **`WEAK_CONTEXT_HITS`** (41 terms: irs, notice, letter, taxes, debt, balance, state, spouse, audit, 1099, owe…) — matched but **de-prioritized** in scoring.
- **`NEVER_MATCH_KEYWORDS`** (28 stopwords: a, an, the, my, you, uh, um…) — filtered before matching.
- **Score** = `priority + hits×8 + strongHits×10 + min(12, max(0, 8 − firstHitLen/10))`. **Rank**: score → priority → hits → key. Capped at **24 candidates**.

---

## 5. The output contract (what the agent actually sees)

| Phase | When | Output shape |
|-------|------|-------------|
| **OPENING** | prospect turns 1-3 | Scripted self-ID sequence, verbatim lines ≤25 words/turn; `WAIT` only for noise |
| **ESTABLISHED** | turn 4+ | `Read:` ≤12 words (what's happening) · `Steer:` ≤25 words (direction) · `Try: "…"` optional exact words |
| **WAIT** | adds nothing new | Replies exactly `WAIT` — suppressed, never displayed, refunds the rate limit |
| **Ask** (agent-initiated) | on demand | question / line / expand / objection → Opus answer, ≤130 words |

---

## 6. Grading (separate system) — `transcriptionScoringService.js`

Runs **after** the call on the transcript. Sonnet (`scoreWithClaude`, exported for regression). **Five dimensions, each 1-10:**

| Dimension | Measures | 1 ↔ 10 |
|-----------|----------|--------|
| `contactability` | Did someone answer, right person? | disconnected/wrong # ↔ answered, confirmed identity |
| `legitimacy` | Real person with a real tax issue? | fake/spam ↔ clearly legitimate taxpayer |
| `tax_issue_present` | Do they actually owe? | no tax issue ↔ confirmed large debt |
| `interest_level` | Interested in help? | hostile ↔ eager to proceed |
| `qualification` | Viable prospect overall? | total waste ↔ ready to sign |

**Output:** `overall` 1-10 · `lead_verdict` ∈ **hot · warm · cold · dead · fake** · 2-3 sentence vendor `summary` · `red_flags[]` · `key_details{answered, voicemail, tax_type(irs/state/both/unclear/none), tax_amount_mentioned, employed, willing_to_proceed}`. The overall is Claude's holistic read of the five dimensions; verdict is the category.

**Guardrails (the grounding fence — `SCORING_SYSTEM_PROMPT`, lines ~223-227):**
- The **transcript is the ONLY source of truth** — score only what's explicitly there.
- **NEVER name an IRS notice/form code** (CP14/501/503/504, LT11, Letter 1058, CP2000…) — *this is the anti-prompt-bleed fix*; the primer vocabulary must not leak into the grade.
- Don't invent/infer; missing detail → `null` / "not mentioned" / "unclear".
- Empty/garbled/voicemail-only → low scores, say so.
- Every red_flag/detail/summary statement must be transcript-supported. Transcript truncated to **12,000 chars** before scoring.

---

## How to filter this

- **By what it listens for** → §1 keyword columns + §4 vocab.
- **By move type** → §2 `family` (psychology / sales_psychology / humor) and the "Fires when" column.
- **By call moment** → §5 phases (opening script vs established navigator).
- **By "how does it decide"** → the 3 gates in the TL;DR (determinism → mini → Sonnet) + §4 scoring.
- **By "how is it graded"** → §6 (live coaching and grading are independent — the coach never sees a grade, the grader never coaches).

> Caveat: priority numbers and a few `applies()` regex lists are summarized, not exhaustive — the code is the final word. The trigger samples are representative, not the complete keyword arrays.
