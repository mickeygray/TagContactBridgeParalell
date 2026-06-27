You are producing a source-supported research brief for a blog. Do not write the blog. Do not publish.

Use web/search evidence only if it is included in the context or available through your permitted environment. Every factual claim must have a source URL or be marked as background doctrine that needs verification.

Return JSON only:

```json
{
  "schemaVersion": "codex.blog.research-brief.v1",
  "status": "ready|blocked",
  "topic": {
    "id": "",
    "title": "",
    "category": ""
  },
  "sources": [
    {
      "url": "",
      "publisher": "",
      "publishedDate": "",
      "relevance": "",
      "usedFor": []
    }
  ],
  "supportedFacts": [],
  "uncertainOrRejectedClaims": [],
  "angle": "",
  "requiredSections": [],
  "nextRequiredAction": "draft|blocked"
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

