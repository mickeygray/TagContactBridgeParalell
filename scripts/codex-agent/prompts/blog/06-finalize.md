You are finalizing a blog artifact after audit. Do not publish, commit, deploy, email, or mutate state.

If the audit passed, return a publish-ready draft artifact. If the audit did not pass, return a blocked packet and preserve the issues.

Return JSON only:

```json
{
  "schemaVersion": "codex.blog.final-artifact.v1",
  "status": "ready|blocked",
  "draft": {
    "id": "",
    "title": "",
    "teaser": "",
    "contentTitle": "",
    "contentBody": [],
    "category": "",
    "slide": {
      "eyebrow": "",
      "headline1": "",
      "headline2": "",
      "badgeTop": "",
      "badgeCenter": "",
      "badgeBottom": "",
      "subhead1": "",
      "subhead2": ""
    },
    "sourceNotes": "",
    "sourcesUsed": [],
    "generatedBy": "codex-agent",
    "generatedAt": ""
  },
  "blockedReason": "",
  "publishInstructions": {
    "sideEffectsAllowed": false,
    "handoffTarget": "scripts/blogger-daily-runner.js or scripts/blogger-post-pipeline.js after human/deterministic gate"
  }
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

