# Live Coach Cockpit — Design Spec (2026-06-26)

Source of truth for the deliberate cockpit rewrite. Grounded in **real** Opus/Haiku
pulls against the production `batch-guidance.v1` contract (`scripts/coach-ui-draft-pulls.js`),
a 4-way design panel, and a judge pass against the locked product principles.

## What the model actually returns (measured)

Real pulls (Opus deep ~25s non-fast / ~9–11s fast, Haiku reactor ~15s) over a diverse
3-call floor. The fields that come back rich, every time:

| Field | Shape | Role in UI |
| --- | --- | --- |
| `read` | 1–2 sentences, the diagnosis | the "why now," smaller, above steer |
| `steer` | 1–2 sentences, the actionable move | **the hero** |
| `try` | a paragraph (can hit max_tokens) | collapsed, one tap, never dominates |
| `completed[]` | 2–4 crisp items | passive spine (done) |
| `next[]` | 2–3 items, often "ask for X" | passive spine (next) + drives fact asks |
| `phase` `confidence` `mode` | short labels | chips; `mode` = reaction vs guidepost |

Implication: `steer` is the hero (strategy-over-script); `try` is a paragraph and must be
expandable, not central; `next[]` is frequently an "ask," which is the hook for the interview.

## Two surfaces (different audiences, same contract)

- **Focus Card** — the agent-on-call cockpit. Winner of the panel (9/9/9/9): the only design
  that satisfies every locked principle without trading one for another.
- **Floor Wallboard** — the floor-lead/manager surface. The whole-floor batch already computes
  every call's guidance, so the triage grid is nearly free. Same `batch-guidance.v1`, no invented data.

Both render the `dialog` SSE event the bus already emits (`Read:/Steer:/Try:` = the
`parseNavigatorSay` string) plus `completed`/`next` — so the cockpit sits on the **wired
backend**; the work is rendering, not new plumbing.

## Substrate ownership — the three-tier load split (user, 2026-06-26)

The coach load is split across THREE substrates, each on its own budget. Source: the rolling-summary
"Live-Ish Exception" in `docs/AI_CODEX_AGENT_BUS_WALKTHROUGH_2026-06-26.md`.

| Tier | Substrate | Cadence | Produces | Budget |
| --- | --- | --- | --- | --- |
| **Summary / memory** | **Codex** (OpenAI $200 sub; isolated `CODEX_HOME`, `OPENAI_API_KEY` stripped) | sidecar, every 60–120s | `call.rollingSummary` = `{summaryText, factsCaptured, objections, taxIssues, openQuestions, nextBestFocus, confidence}` per call | OpenAI subscription |
| **Interpretation** | **Opus** (`claude -p`, Max pool) | ~once/min | the script-anchored strategic read — reads `rollingSummary` + transcript → `beats`/`remember`/`says`-picks/`currentSection`/`priorFlags` | Anthropic Max |
| **Guidance** | **Haiku** (metered key) | per-turn | the live say-line + `read`/`steer` | Anthropic metered |

**Why it lightens the load:** the expensive "read all transcripts + maintain call memory" job moves to
the cheap Codex sub, **off the Anthropic budgets**. Opus no longer *generates* the summary — it
*interprets* it. And Codex's `objections`/`taxIssues`/`factsCaptured` pre-populate the say-zone's
objection targets, the summary column's tax-memory, and the discovery facts — so Opus's deep-pull
shrinks to "given this summary + these objections, mark the beats and pick the lines."

**Sidecar discipline (from the doc):** the rolling summary updates `call.rollingSummary` for the
deep-pull to read on its next pass; it must NOT trigger a VAD final / second context-judge / second
writer, must NOT replace raw STT, must NOT block guidance or delay UI; a late summary attaches to
closeout/grader instead. Redact SSN/card/account numbers before any row goes to Codex. Flags:
`LIVE_COACH_ROLLING_SUMMARY_ENABLED` / `_SUBSTRATE=codex|api|off` / `_SHADOW_ONLY` / `_BATCH_MS` / `_LEASE_MS`.

Cockpit → substrate: **Summary+tax-facts+captured-facts = Codex** · **Script beats + remember +
say-picks = Opus** · **Say-zone reactions = Haiku**.

## Cockpit anatomy (final layout)

1. **Context bar** — live dot, who/case, right-aligned **freshness chip** (makes the 5–25s
   model lag honest; flips to amber past the TTL midpoint).
**SEPARATION OF CONCERNS (user, 2026-06-26): SAY at top, READ below.** Anything the agent might
*say or think about saying* is grouped at the top — whoever authored it (Opus or Haiku). Everything
that's context/input/state — what's happened, the temperature, the pressable case fields — is below.
A line is never mixed into the read; the read never holds a line.

2. **Say zone (top, full width)** — "a few things you could say," a **CHOICE** (not one imperative
   "say this"): a few typed options, a `steer` framing line above, the recommended one lightly starred.
   **Types & mix** — the system leans hard here (exaggerated by the user as ~75% / ~25% / ~0.1%):
   - **objection** — an overcome, tagged with the objection it answers. The **dominant** type.
   - **tactic** — a sales-tactic move/line (boomerang, anchor, alternative-choice close…).
   - **line** — a general line. Rare.
   A **merge of sources** as `says[{type:'objection'|'tactic'|'line', text, tag?, rec?}]`: the reactor's
   live line + the deep-pull's picked options + the **objection bank** (dominant) + the sales-tactic
   library. **Tax guidance is almost never something to SAY** — tax facts persist as call MEMORY in the
   summary column instead (see below).
3. **Section spine (full-width row)** — between the say zone and the columns. The 8 script sections as
   tabs (done ✓ · current ▶ · flagged ⚠ · upcoming dim). The **shared navigator** — it drives all three
   columns at once. Defaults to the live `currentSection`; the agent can click any section to review/edit it.
4. **Three section-bound columns (bottom)** — all show the SELECTED section; never a line to say:
   - **Script** — that section's beat checklist (hit/pending/fumbled). Each beat is a one-line row that
     **toggles open** the full script detail for that point (inline, not a modal). Beat shape
     `{point, detail, status}` — `point` + `detail` are STATIC from `taxGroupScript.js` (the script's own
     words, no model); only `status` comes from Opus. Thin by default; the whole script one tap away.
   - **Summary + remember** — that section's `summary` (what happened in *this* part of the call) +
     `remember[]` (`watch` cautions/gaps in amber, `key` facts to hold; `priorFlags` surface as `watch`).
     Upcoming sections show "not reached yet." At the bottom, **tax facts** (`taxFacts[]`, WHOLE-CALL
     memory, persistent across sections): the tax facts the coach has established about the call
     (CP504 = levy / FTA may apply / substitutes inflate the balance) — the sliver of tax guidance lives
     here as remembered context, not as a line to say.
   - **Case** — the **temperature** pills (whole-call, persistent across navigation) + that section's
     **form slice**: discovery facts at Case-build, the tax-problems checklist at Expert, financials at
     Payment, contact fields at Info, a notes field elsewhere. The interview is no longer one global form
     — it's a per-section capture matching where you are in the call.

   **Separate but persisted:** each section's summary + form-slice is its own state, tied to the same
   sections as the script, and retained as you navigate. The whole call record is organized by the
   script's sections. The say zone (top) and temperature stay whole-call.

The split: SAY at top (words, by either model, the live moment), READ below (section-bound script ·
summary+remember · case). This is "one live-feedback channel + passive checklist" made literal.

**Mode treatment:** reaction = danger/red (urgent foreground), guidepost = info/blue (calm note),
quiet collapses to an "on track" line. Felt peripherally (color + icon) before read.

**Open item:** a **min-dwell hold** so a fast second nudge can't yank a card before it's read.

## Interview ↔ spine (the case-fact strip)

The in-call surface is the **5-fact CORE**, not the 30-field form:
`balance · unfiled_years · collection_status · income_type · ability_to_pay` — the exact keys
`coachSignalExtractor.js` auto-detects and the model's guidance keeps referencing.

- **AI fills what it hears** — `ti-sparkles` chips are auto-detected from the transcript
  (`FACT_MARKERS`). The agent confirms/corrects, never types these.
- **Agent records the blanks** — tap a blank slot → inline input → captured (source: "you").
- **The coach drives the asks** — a blank GLOWS (dashed, mode-color, "coach is asking") only when
  the current `read`/`next[]` is circling it (Dana's **Balance** glows because her whole guidepost
  is "she can't see the real number").

The full `InterviewSnapshotState` (`CXWorkspace.tsx:2729`; tabs: tax-problem / client-temp /
compliance / financials) is reached via **buttoned progressive-disclosure sections** — one open
at a time, so the spine never bloats. The buttons map to the real tabs; the toggles/inputs are the
real fields (`taxProblems`, `temperature`, `flags`, `employment`, `unfiledYears`, financials).

### Two decisions (user, 2026-06-26)

1. **No silent auto-push.** The transcript already auto-flows to the coach (the model hears the
   call). The interview push is ONLY for **out-of-band** context the call can't carry — financials,
   "single parent," "spouse decides," why-now, the agent's read on temperature. An explicit
   **"Update case context"** button pushes it = the existing Generate/Rewrite-strategy path
   (interview note → `caseContext` → re-strategize → next pull uses it). The freshness chip flips
   to "context updated · coach refreshing" for that round-trip.
2. **Persist at call end regardless** of whether it was pushed — via the existing
   `buildInterviewActivityNote` → activity path. A save guarantee, not new plumbing.

## The spine is the script (not a checklist)

The spine is **The Tax Group's approved 7-section method** (`taxGroupScript.js`: Intro · Case
building · Expert guidance · Representation pitch · Payment/close · Info collection · Think-it-over
· Closing) rendered as **static, tabbable** content. The script defines each section's goal; the
coach lays its read on top. This kills the "thin checklist" problem — the structure is the real
method, authoritative, and the agent can cycle the full script as a reference any time.

**Division of labor (user, 2026-06-26): the words go to the SAY ZONE (top); the read goes BELOW.**
- **Say zone (top)** = every sayable item, typed `says[{type, text, tag?, best?}]`. `line` = the
  reactor's live line + the deep-pull's picked line(s) (one `best` → "say this"); `objection` = an
  overcome from the objection bank (tagged with the objection); `tax` = an insert from `taxTopics`.
  One channel, a **merge of all sayable sources**, with the `read`/`steer` framing above it.
- **The call so far (read, bottom-left)** = the section's beats as a coach-MARKED checklist
  (`beats[{point, status}]`, hit | pending | fumbled) + `priorFlags[{section, issue}]` (a past section
  with a fumbled beat, ⚠-marked on its tab even after the call moves past it). What's happened — never
  a line. The full static script is tabbable here as the method reference.
- **Their read (bottom-right)** = the pressable **temperature** + case form. Agent input, not model.

Tabbing to a non-current section shows just the static script beats (preview). Tab status: done (✓) ·
current (▶, mode color) · flagged (⚠ amber) · upcoming (dim).

**Two-tier mapping:** reactor (Haiku, per-turn) → `read` + `steer` + a live `line` into the say zone.
deep-pull (Opus, ~once/min) → `currentSection` + `beats[{point,status}]` + `priorFlags` + the picked
`says` (best line + objection overcome + tax insert). Validated by real Opus pulls
(`scripts/coach-spine-pull.js`, ~32s, clean JSON) — marks the beats, names the tact, picks a strong line.

**Contract (three producers):**
- **Codex rolling summary** (per call, ~60–120s): `rollingSummary{summaryText, factsCaptured,
  objections, taxIssues, openQuestions, nextBestFocus, confidence}` → feeds the summary column's
  `summary`, the **tax-facts memory** (`taxIssues`), and pre-fills the discovery **facts** (`factsCaptured`).
- **Opus deep-pull** (~once/min): INPUT += `call.rollingSummary`; OUTPUT =
  `currentSection · says[{type:'objection'|'tactic'|'line', text, tag?, rec?}] ·
  sections{<id>:{beats[{point,status}], remember[{text,kind:'watch'|'key'}]}} · priorFlags[{section,issue}]`.
  It does NOT emit `summary`/`taxFacts` anymore (Codex owns them) — it interprets them. `says` is a few
  options (one `rec`), weighted ~75% `objection` / ~25% `tactic` / rare `line`; the model is told
  `objections` (from Codex) to overcome and leans on the objection bank.
- **Haiku reactor** (per-turn): `read · steer · a live say-line`.

**IMPLEMENTED 2026-06-26** (`coachBatchRunner`, schema `v2`, 276 live-coach tests green): the deep/reactor
prompts are now **skeleton-fed** — the exact response object is shown to the model with "fill in this
object," intent baked into the rules. Validated against real models (`scripts/coach-prompt-validate.js`):
Opus deep (~33s) fills `currentSection/beats/remember/says/priorFlags`, anchors beats to the right script
section, picks one `rec` say, reads-not-rewrites the rolling summary, keeps tax facts OUT of the says
(woven into objection-overcomes instead); Haiku reactor (~12s) fills `read/steer/say` and goes `quiet`
when pushing would hurt. The deep output is cockpit STATE (floor loop applies it, no dialog dispatch);
the reactor's `say.text` rides as `try` so the dispatch/emit path is unchanged. `summary`/`taxFacts` are NOT
emitted by the deep pull (Codex owns them).

**Rolling-summary incorporation (2026-06-26, 288 tests):** Codex's `liveCoachRollingSummaryService`
writes `session.latest.rollingSummary` (the normalized memory); the projection (`rollingSummaryFromSession`)
surfaces it as `conversation.rollingSummary` and sets `callSummary = summaryText`. `coachBatchRunner`
now renders the STRUCTURED buckets into the **deep** prompt (`renderRollingSummaryDetail`) with routing
labels: `objections → overcome in says`, `taxIssues → tax-memory remember items`, `factsCaptured → don't
re-ask`, `openQuestions → asks/remember`, `nextBestFocus → the steer`. The reactor stays lean (headline
`summaryText` + latest turns only — no token cost added to the cheap Haiku path). Real-pull confirmed
(`coach-prompt-validate.js` with a structured `latest.rollingSummary`): Opus moved the two surfaced
objections into `says`, the garnishment `taxIssue` into `remember{kind:key}` (NOT a say), the `openQuestion`
into a watch, and `nextBestFocus` into the rec'd say — exactly the intended routing. Sessions WITHOUT a
structured summary still produce valid cockpit state (graceful degradation).

**Repair layer (user, 2026-06-26):** `coachBatchRunner.repairGuidanceRow(row, tier)` — a model WILL
occasionally return a malformed object, so every parsed row is repaired into the COMPLETE canonical
object for its tier: every key present (arrays default `[]`), enums clamped (`status`/`kind`/say-`type`/
`mode` → safe defaults), misplaced fields recovered (top-level line → `say`; bare-string `says` → line
item; single un-wrapped object → one row), exactly one `rec` say, `mode` inferred, `say.text → try`. Never
throws on garbage; rows with no routing keys flagged `_dropReason`. Auto-detects tier when not told.
`parseBatchGuidance` runs it on every row; the floor loop passes the explicit tier. 11 repair tests.

**Objection lens = a MINDSET, not a quota (user, 2026-06-26):** the prompt tells both models to *think about
turning calls from the point of view of overcoming objections* (stated AND beneath-the-surface: fear,
skepticism, inertia) — everything else (tactics, discovery moves) is still valid when it fits. So the say
distribution is not a forced percentage; it varies by call context — objection-heavy moments yield
objection-overcomes, discovery moments yield discovery/tactic moves. Don't tune to a number; tune the lens.
- The per-section read (`beats`/`summary`/`remember`) is **keyed by script section** (section-bound +
  persisted). The **form-slice per section** is a static UI mapping (Case-build→discovery facts,
  Expert→tax problems, Payment→financials, Info→contact). `says`, tax-facts memory, and temperature stay
  whole-call. Per-section summaries = Opus segmenting Codex's `summaryText` into the script's sections.
The `says` carry the sayable channel (the old `bestTact`/`lines` fold into `steer` + the `line` says);
`beats` subsume the old wins/gaps (hit = win, fumbled = gap); `summary` may reuse the existing
rolling-digest `callSummary`; `remember[]` is the new "important to remember" column (`priorFlags`
surface here as `watch`). The say zone is a UI **merge** of the deep-pull `says` + the reactor's live
line + the objection bank + `taxTopics`. Deep-tier schema/prompt change in `coachBatchRunner` (script
sections stay static); the reactor stays lean (`read`/`steer` + a line).

## Backend ties

- **In (already there):** the guidance card reads the `dialog` event; the captured fact chips read
  the projection's `arrays.facts` (the `factLedger`); the glow reads the coach's `next[]`/asked facts.
- **Out (one wire still needed):** `coachBatchRunner.renderConversation` does NOT yet render
  `arrays.facts` to the model (it renders strategy/summary/asks/transcript). Add a `KNOWN:` block so
  a fact the agent records visibly steers the next pull. This is the single new wire to close the loop.
- **Push (already there):** "Update case context" = the Generate/Rewrite-strategy → `session.metadata.callStrategy`
  path; the deep-pull writeback then carries it forward (`session.callStrategy`, see the two-tier doc).

## Build order (when greenlit)

1. Cockpit component rendering the `dialog`/guidance event (Focus Card anatomy) + min-dwell hold.
2. Case-fact strip from `arrays.facts` + the asked-fact glow from `next[]`; inline record → `factLedger`.
3. The `KNOWN:` block in `renderConversation` (close the loop).
4. Buttoned interview sections + "update case context" wired to the strategy refresh.
5. Floor Wallboard as the separate floor-lead route.

Mockups: rendered in-session (Focus Card, Floor Wallboard, Focus Card + buttoned interview).
