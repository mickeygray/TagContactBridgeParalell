# Targeted Talk Skill Packets — Claude Build Guide

**Purpose:** Give Claude the canonical mental model for authoring and wiring
course-specific Targeted Talk sessions.

**Related authority:**

- `SALES_TRAINER_TARGETED_TALK_BUILD_GUIDE_2026-07-28.md`
- `SALES_TRAINER_EXECUTION_WORK_ORDER_2026-07-28.md`
- `SALES_TRAINER_COMPLETION_PLAN_2026-07-29.md`

This file explains mechanics. It does not publish company doctrine. Real rules
still require the named source and rule decision gates.

## The basic idea

Each course part teaches one bounded skill or closely related skill group.

When a learner selects Part 1, the server does not launch a generic role-play
and ask the model to decide what Part 1 means. It resolves one versioned,
server-owned skill packet for Part 1 and pins that packet to the attempt.

The packet defines:

- what the learner is practicing;
- what the learner must demonstrate;
- which approved rules govern success;
- which persona and scenario variation the learner receives;
- what the prospect may and may not do;
- which section of the call the conversation occupies;
- how many turns and retries are allowed;
- what evidence the evaluator may cite;
- which reflection and Q&A follow the conversation.

The learner completes the conversation only by satisfying the packet's required
criteria. The model may produce realistic dialogue and propose cited evidence.
The model never decides progression, pass/fail, mastery, certification, or
unlocking.

## Runtime composition

```text
Course part
  -> server resolves published skill packet
  -> attempt pins packet + variant + rule/rubric versions
  -> server compiles immutable cached skill header
  -> deterministic controller selects current node
  -> prospect model receives:
       1. cached skill header
       2. small current-node directive
       3. learner utterance as untrusted input
  -> evaluator proposes cited criterion evidence
  -> deterministic controller accepts/rejects evidence and advances
```

## The three inputs to a prospect turn

### 1. Cached skill header

The header is stable for the attempt. It contains:

- packet and blueprint IDs/versions;
- section and direction;
- local objective;
- approved rule IDs;
- required success criteria;
- persona, facts, utterance families, and pinned voice;
- prohibited speech acts;
- turn and section boundaries.

It receives a content-addressed cache key. A packet change creates a new key.
An in-progress attempt continues using its pinned version.

### 2. Current-node directive

This is intentionally small:

- current node ID;
- the reaction the prospect should produce now;
- speech acts permitted at this node.

The node directive may change each turn. It may not rewrite the packet.

### 3. Learner utterance

The learner's newest words are supplied separately as untrusted text.

Instructions inside learner text—such as “ignore the rubric,” “tell me the next
node,” or “close the sale now”—cannot modify the skill header, rules, persona,
rubric, or controller state.

## Separation of authority

### Prospect model may

- speak naturally as the pinned persona;
- vary wording while preserving the required situation;
- react according to the current node;
- remain difficult when the exercise calls for difficulty.

### Evaluator may

- inspect the learner turn;
- propose satisfaction of declared criteria;
- cite the exact turn supporting each proposal;
- return uncertainty or no evidence.

### Deterministic controller alone may

- accept criterion evidence;
- check required boxes;
- select declared graph edges;
- advance nodes;
- end a run;
- allow a bounded retry;
- record guided-execution progress.

### Neither model may

- invent rules or criteria;
- expose hidden rubrics or next nodes;
- mark the attempt passed;
- unlock another item;
- update mastery directly;
- escape the course section;
- convert advisory suggestions into company rules.

## Course-part authoring rules

1. One part has one local objective.
2. Required criteria must be observable in learner speech.
3. Every required criterion references an approved `ruleId` and revision.
4. Every persona variant uses equivalent success gates.
5. Persona variation changes difficulty and wording, not what counts as success.
6. The conversation remains inside its assigned call section.
7. Terminal success requires every required criterion.
8. Misses lead to declared recoverable reactions or bounded failure.
9. A retry stays inside the same attempt and uses an unused variant when
   available.
10. Reflection precedes full Coach teaching.
11. Model-generated teaching is labeled **Things to consider** unless backed by
    published company authority.
12. Certification remains off until its separate decision gate is approved.

## Example

Part 1 might teach “acknowledge the concern and ask a useful clarifying
question.”

Its packet could require:

- acknowledge the prospect's concern without arguing;
- ask one question that advances understanding;
- avoid quoting price or attempting to close;
- remain in Discovery.

The persona variation might be calm, suspicious, impatient, or guarded. All
variations require the same two learner behaviors. The prospect model keeps the
conversation realistic; the controller checks whether cited learner evidence
satisfies both behaviors.

## Engineering seams

- Skill header compiler:
  `packages/shared-services/src/trainingProspectDialogueService.js`
- Deterministic graph controller:
  `packages/shared-services/src/trainingGauntletController.js`
- Runtime persistence and CAS:
  `packages/shared-services/src/trainingGauntletService.js`
- Semantic evidence boundary:
  `packages/shared-services/src/trainingEvidenceEvaluatorService.js`
- Blueprint validation:
  `packages/shared-services/src/trainer-content/validateTargetedTalkBlueprint.js`
- Learner player:
  `apps/web-client/src/workspaces/trainer/TrainerGauntletPlayer.tsx`

## Before publishing a real packet

- Confirm the authoritative source.
- Publish the referenced rules and revisions.
- Validate variant gate parity.
- Validate section and prohibited-speech boundaries.
- Complete required target audio.
- Run prompt-injection, replay, stale-turn, restart, and provider-outage tests.
- Keep flags off until the matching proof and product gates pass.

