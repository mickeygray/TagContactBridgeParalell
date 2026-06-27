# Codex Blog Sequence

This chain is intentionally sequential. Do not ask Codex to research, draft, audit, and publish in one request.

## Order

1. `01-setup.md` - read the local blogger contract and return a setup packet.
2. `02-topic-plan.md` - choose the specific post path/topic candidate.
3. `03-research-brief.md` - gather and normalize source-supported facts.
4. `04-draft.md` - write the canonical draft only from the approved brief.
5. `05-accuracy-audit.md` - check claims, citations, structure, and brand rules.
6. `06-finalize.md` - produce the final publish-ready artifact or a blocked reason.

## Invariants

- No step publishes, commits, deploys, sends email, or mutates blog state.
- Each step returns JSON only.
- Each step consumes the previous step's JSON as input.
- If a step lacks enough evidence, it returns `status:"blocked"` with `nextRequiredAction`.
- The final artifact must match the existing blogger canonical draft shape.

