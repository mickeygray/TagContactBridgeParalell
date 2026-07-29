# Targeted Talk Skill Packet — Claude Authoring Template

Use one copy of this template for each course part. Do not fill unresolved
business rules with model-generated guesses. Mark them `DECISION_REQUIRED`.

## 1. Course identity

```yaml
coursePartId:
coursePartVersion:
title:
sectionId:
direction: inbound | outbound
localObjective:
estimatedMinutes:
```

## 2. Skill definition

Describe the unique learner skill in one sentence.

```yaml
skill:
whyItMatters:
entryKnowledge:
outOfScope:
```

`outOfScope` is important. A Discovery exercise must not silently become a
closing exercise.

## 3. Rule authority

Every deterministic requirement needs published authority.

```yaml
rules:
  - ruleId:
    ruleRevision:
    authorityCitation:
    requiredBehavior:
```

If authority is unavailable:

```yaml
status: DECISION_REQUIRED
```

Model-generated advice belongs under **Things to consider**, not here.

## 4. Success checklist

Each box must be observable and citeable in learner speech.

```yaml
successCriteria:
  - criterionId:
    ruleId:
    ruleRevision:
    description:
    required: true
    detector: exact | sequence | semantic
    acceptableEvidence:
    nonEvidence:
```

Avoid vague criteria such as “handled it well.” Prefer “acknowledged the
prospect's stated concern before asking a clarifying question.”

## 5. Persona variants

Variants may alter realism and difficulty. They may not alter success gates.

```yaml
variants:
  - variantId:
    variantVersion:
    personaProfileId:
    factSetId:
    utteranceSetIds: []
    voiceProfileId:
    difficultyNotes:
```

Parity check:

```yaml
allVariantsUseIdenticalRequiredCriteria: true
allVariantsRespectProtectedTraitPolicy: true
```

## 6. Conversation boundary

```yaml
maxTurns:
maxVisitsPerNode:
prohibitedSpeechActs: []
allowedSectionOutcome:
forbiddenSectionOutcomes: []
```

Examples of forbidden outcomes:

- quoting price during Discovery;
- attempting a close in an objection-only exercise;
- inventing tax advice;
- revealing the hidden rubric;
- performing an operational DNC action.

## 7. Deterministic node graph

```yaml
startNodeId:
nodes:
  - nodeId:
    nodeType: prospect | checkpoint | terminal
    sectionId:
    reactionIntent:
    allowedSpeechActs: []
    requiredCriterionIds: []

edges:
  - edgeId:
    from:
    to:
    priority:
    condition:
    fallback: false
```

Rules:

- Every nonterminal node has exactly one fallback.
- Every edge remains inside the section.
- Every node is reachable.
- Terminal success requires all required criteria.
- The model never selects an undeclared edge.

## 8. Misses, hints, and retries

```yaml
recoverableMisses:
  - missType:
    prospectReaction:
    retryNodeId:

hintPolicy:
  steps: []

retryPolicy:
  nodeRetryLimit:
  runRetryLimit:
  variantStrategy: unused-first
```

Hints are instructional metadata. They are never learner evidence.

## 9. Cached skill header

The runtime compiles Sections 1–8 into one immutable header:

```yaml
cachedHeaderContains:
  - blueprint identity and version
  - section and local objective
  - approved rules
  - success checklist
  - pinned persona/facts/voice
  - prohibited speech acts
  - turn and retry bounds
```

Do not put current learner text in this header. Current text is separate,
untrusted turn input.

## 10. Reflection and Q&A

```yaml
reflectionPrompt:

questions:
  - questionId:
    questionVersion:
    prompt:
    rubricCriterionIds: []
```

Full Coach teaching stays hidden until reflection is submitted.

## 11. Coach output

```yaml
scriptBackedFeedback:
  authority: published_rule

modelGeneratedFeedback:
  label: Things to consider
  authority: model_generated_consideration
```

Observed evidence must never be overwritten by reflection or Coach analysis.

## 12. Audio manifest

```yaml
audioManifestId:
audioManifestVersion:
requiredTargetIds: []
```

Production voice enablement is all-or-nothing. Partial target audio means the
packet is not ready.

## 13. Required proof

```yaml
proofChecklist:
  validatorPasses: false
  variantParityPasses: false
  promptInjectionPasses: false
  sectionEscapeRejected: false
  duplicateReplayPasses: false
  changedPayloadRejected: false
  staleTurnRejected: false
  restartReconstructionPasses: false
  partialAudioRejected: false
  graderOutageFailsClosed: false
  reflectionBeforeFeedbackPasses: false
  operationalWriteIsolationPasses: false
```

## 14. Decision gates

```yaml
decisionGates:
  DG-SOURCE-01:
  DG-RULE-01:
  DG-AUDIO-01:
  DG-CERT-01:
  DG-LIVE-01:
```

The packet may be built and tested with explicit synthetic fixture authority
while real doctrine gates remain pending.

