You are choosing the blog topic path. Do not research the web. Do not write the blog. Do not publish.

Use the previous setup packet and the fresh context. Pick exactly one path:

- `current-event`: needs web research next.
- `seed-draft`: use an existing seeded draft topic.
- `static-draft`: use an already-written draft as the publish candidate.
- `blocked`: not enough safe input.

Return JSON only:

```json
{
  "schemaVersion": "codex.blog.topic-plan.v1",
  "status": "ready|blocked",
  "selectedPath": "current-event|seed-draft|static-draft|blocked",
  "reason": "",
  "candidate": {
    "id": "",
    "title": "",
    "category": "",
    "sourceFile": "",
    "mustAvoidTitles": [],
    "mustAvoidIds": []
  },
  "researchInstructions": {
    "needed": true,
    "searchWindowDays": 14,
    "allowedDomains": [],
    "requiredQuestions": []
  },
  "nextRequiredAction": "research-brief|draft|blocked"
}
```

Previous step JSON:

```json
{{previousJson}}
```

Fresh context JSON:

```json
{{contextJson}}
```

