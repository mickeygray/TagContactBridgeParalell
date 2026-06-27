You are preparing a blog-writing task for a later Codex step. Do not write the blog. Do not research the web. Do not publish.

Your only job is to read the provided local context and produce a compact setup packet that future steps can use safely.

Return JSON only with this exact shape:

```json
{
  "schemaVersion": "codex.blog.setup.v1",
  "status": "ready",
  "blockedReason": "",
  "task": {
    "taskId": "blogger.setup",
    "blogMode": "current-event|seed-draft|static-draft|unknown",
    "recommendedNextStep": "topic-plan|blocked"
  },
  "contracts": {
    "canonicalDraftFields": [],
    "requiredSlideFields": [],
    "requiredCurrentEventFields": [],
    "bodyHtmlRules": [],
    "publishSideEffectsForbidden": true
  },
  "existingSystem": {
    "runnerFiles": [],
    "stateFiles": [],
    "fallbackBehavior": [],
    "knownDuplication": [],
    "testsOrChecks": []
  },
  "guardrails": {
    "allowedSources": [],
    "forbiddenClaims": [],
    "brandRules": [],
    "qualityGates": []
  },
  "inputsForNextStep": {
    "dateKey": "",
    "dayOfWeek": "",
    "recentPublishedTitles": [],
    "publishedIdsSample": [],
    "fridayRotationState": "",
    "draftInventorySummary": {}
  },
  "nextPromptInstruction": "Use this setup packet to choose one blog topic path. Do not draft yet."
}
```

Rules:

- Set `status:"blocked"` only if the context is missing the blogger contract or canonical draft shape.
- Preserve exact field names from the existing app when listing contracts.
- Name duplicated or legacy surfaces plainly, but do not propose deleting them in this step.
- Keep `existingSystem.runnerFiles` as file paths from the context.
- `qualityGates` must include the split-body block count guard and duplicate slug guard when present.
- Do not invent recent titles, source URLs, or state. Use only the context.

Context JSON:

```json
{{contextJson}}
```

