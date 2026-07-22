# Coach-as-Analyst Doctrine + Guarded-Guidance Refactor

*2026-07-20 — direction set by Mickey. This is the measuring stick for the sales-manual
refactor and the coach/trainer prompt posture. Companion to the PhoneBurner-era monitor
work (pb-monitor-daemon) and the trainer-bot integration.*

## The posture shift

The coach is an **analyst, not a scriptwriter**. It listens to the call, reads the guide,
and returns two things:

1. **Custom feedback** — what is actually happening on this call, grounded in what the
   prospect's demeanor and words show ("they went quiet after the fee — that's
   consideration, not objection; don't fill the silence").
2. **Guidance** — the relevant *approach* from the manual ("this is a trust-first moment;
   the guide's read on skeptics is X"), not lines to parrot. Verbatim words are the rare
   exception (compliance-critical moments only), never the default.

Silence stays first-class. An analyst that has nothing load-bearing to say says nothing.

## Coach output posture — advisory, never directive

Everything the coach surfaces is framed as **something to think about, not a direct
resource**: exercise caution, follow the instructions of management, use your judgment.
Management is the authority on how to sell; the coach is a second set of eyes.
Implementation: a standing advisory banner on the coaching surface (cockpit/wallboard
lane) plus suggestive phrasing in the guidance itself ("worth considering…", "the guide's
read on this is…") — never imperative commands. The per-message preface lives in the
prompt contract for A/B stations when they are re-pointed (phase 4).

## The house doctrine (what management preaches — the corpus orbits this)

1. **Bob and weave** — stay light on your feet. Don't take every hard question head-on
   and don't get pinned into specifics you don't have. Answer the legitimate core
   honestly, decline to speculate, keep the conversation moving toward what you can
   actually offer. (Written defensibly: this is *refusal to speculate*, never evasion of
   accountability.)
2. **Expertise without specifics** — demonstrate command of the domain (process, ladder,
   what the agency does) without committing to numbers, timelines, or outcomes.
3. **Certain without promising** — total confidence is honest when it is confidence in
   what the FIRM does. You can be certain we get authorized, review the file, and pursue
   what the facts support — because that is entirely within our control. Certainty about
   IRS decisions is never honest, so it is never offered.
4. **Compliance and representation only** — that is the product. Not settlements, not
   forgiveness, not outcomes. Getting the client compliant and represented is the honest
   pitch, and it is enough.

## Corpus source: Matt's floor coaching

Matt's (sales management's) live advice to the sales team will be recorded and
transcribed, and becomes primary source material for the guide's next authoring passes —
the manual should read like the floor's best coaching sounds, filtered through the
guarded-guidance rubric above.

## Why the manual gets refactored

The current corpus was written as a deep **branded-selling** manual. Its failure mode is
"leading with your chin": prescriptive, aggressive plays whose language — quoted back by
a hostile reader — looks like pressure, promises, or deception. We sell trust first:
build rapport, earn the moment, and *then* open the door to who we are and what we do.

The refactor is defensive by design. Assume any call may be recorded by someone hoping to
manufacture a complaint. The manual must never hand them the sentence that does it.

## The guarded-guidance language rubric

Every entry in the corpus gets measured against these, and rewritten or killed:

1. **Demeanor-conditional, not prescriptive.** Frame: "read the person — if they present
   as X, an approach that tends to work is Y." Judgment is the instruction; the play is
   the illustration. Never "say this."
2. **Trust-and-rapport sequencing.** No identity-forward or pitch-forward plays early.
   The reveal of who we are and what we do is *earned* and comes after rapport.
3. **Measured claims only.** Nothing that promises outcomes, timelines, savings, or
   government standing. Nothing that could be quoted as a guarantee. Hedged, factual,
   calm.
4. **Complaint-surface minimization.** Strike or rewrite anything that reads as pressure,
   urgency manufacturing, fear leverage, or misdirection when read cold by a regulator,
   a lawyer, or a journalist. If a sentence needs context to be defensible, rewrite it
   until it doesn't.
5. **Bad-actor awareness.** Add explicit recognition guidance: demeanor patterns of
   complaint-bait / entrapment callers (fishing for recorded promises, pushing the agent
   to name figures, inviting rule-breaking). Doctrine: disengage gracefully, concede
   nothing, document. The best play against a bad actor is a short, polite, boring call.
6. **Best-judgment framing throughout.** The manual speaks to a professional exercising
   judgment ("here's how you can approach this"), not an operator executing a script.

## Surfaces the refactor touches (in order)

| # | Surface | What changes |
|---|---------|--------------|
| 1 | Field-manual corpus (`apps/web-client/src/workspaces/field-manual/content/*.ts` — script, strategies-plays, objections-{capability,money,trust}, psychology-{principles,voss}, strategies-mechanics, tax) | Full editorial pass against the rubric; entries rewritten demeanor-conditional; bad-actor section added |
| 2 | Coach reference library + beat catalog (`coachReferenceLibrary`, `DEEP_BEAT_CATALOG` in the batch runner) | Re-derived from the refactored corpus; analyst framing |
| 3 | Two-station prompts (`coachTwoStationPrompts`) | B = analyst brief (read of the call + relevant guide approaches); A = feedback/guidance selector, words-verbatim only for compliance moments; HOLD emphasis retained |
| 4 | Trainer prompts (`taxResolutionSalesTrainerPrompt*.md`) + coaching panel + Opus debrief | Same posture; trainer becomes the doctrine sandbox |
| 5 | Grader rubrics (`transcriptionScoringService`, `cxNightlyCallGradeService`) | Score trust-building, sequencing discipline, and defensive language; penalize chin-leading even when it "works" |

## Execution phases

1. **Doctrine lock (this doc).**
2. **Adversarial corpus audit** — every entry read three ways: as a hostile complainant,
   as a regulator, as a bad-actor caller. Output: keep / rewrite / kill list with reasons.
3. **Rewrite passes** per file, reviewed against the rubric.
4. **Prompt re-pointing** — coach (B/A), trainer, graders adopt analyst posture + the
   refactored corpus.
5. **Sandbox proving** — live coach plugged into trainer roleplay (trainer STT already
   exists; feed turns through the coach input contract). Doctrine iterates against the
   bot before any real call.
6. **Monitored-calls rollout** — the pb-monitor daemon feeds the proven analyst coach for
   trainees on real PhoneBurner calls.
