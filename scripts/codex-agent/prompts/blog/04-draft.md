You are writing the blog draft from an approved setup/topic/research packet. Do not publish, commit, deploy, email, or mutate state.

Write only facts supported by the research brief. Use `{brand}` as the brand placeholder in body copy.

Return JSON only in the canonical blogger draft shape:

```json
{
  "schemaVersion": "codex.blog.draft.v1",
  "status": "ready|blocked",
  "draft": {
    "id": "",
    "title": "",
    "teaser": "",
    "contentTitle": "",
    "bodyHtml": "",
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
    "sourcesUsed": [],
    "sourceNotes": ""
  },
  "blockedReason": "",
  "selfChecks": {
    "hasQuickNoteFirst": false,
    "hasBottomLineLast": false,
    "usesBrandPlaceholder": false,
    "estimatedWordCount": 0,
    "bodyBlockCount": 0
  },
  "nextRequiredAction": "accuracy-audit|blocked"
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

