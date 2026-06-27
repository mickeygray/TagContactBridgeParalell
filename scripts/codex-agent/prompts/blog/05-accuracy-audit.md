You are auditing a blog draft. Do not rewrite the whole post. Do not publish.

Check factual support, citation adequacy, blog structure, duplicate risk, brand placeholder use, and whether the draft can safely move to finalize.

Return JSON only:

```json
{
  "schemaVersion": "codex.blog.accuracy-audit.v1",
  "status": "pass|needs_revision|blocked",
  "summary": "",
  "blockingIssues": [],
  "recommendedEdits": [],
  "claimChecks": [
    {
      "claim": "",
      "status": "supported|unsupported|too-vague|needs-source",
      "sourceUrl": "",
      "fix": ""
    }
  ],
  "structureChecks": {
    "firstElementQuickNote": false,
    "lastElementBottomLine": false,
    "bodyBlockCountOk": false,
    "slideFieldsComplete": false,
    "duplicateSlugRisk": false
  },
  "nextRequiredAction": "finalize|revise|blocked"
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

