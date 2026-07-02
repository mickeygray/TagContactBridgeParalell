# Agent Handoff

This repository is in the middle of CX 0.2 alpha live-testing recovery after a Codex Desktop crash/context loss on 2026-06-30.

## Guardrails

- Read `.ai/context/PROJECT_HANDOFF.md` and `.ai/context/CODEX_RECOVERY_NOTES.md` before changing code.
- Treat the current working tree as live-test WIP. Do not reset, revert, or clean files unless the user explicitly asks.
- Do not read, print, or commit secrets such as `auth.json`, `.env` files, token stores, or raw logs containing credentials or PII.
- Use evidence-first alpha testing. UI state alone is not enough for pass/fail conclusions.
- Check app and service state before editing or restarting anything. At recovery time, the `Parallel*` NSSM services were stopped.
- Hard live-test rule: if any `Parallel*`/NSSM service needs a restart, ask Mickey to do it and wait for confirmation. Do not attempt service restarts from Codex.

## First Reads

- `.ai/context/PROJECT_HANDOFF.md`
- `.ai/context/CODEX_RECOVERY_NOTES.md`
- `docs/CX_0_2_ALPHA_TEST_OBSERVABILITY_RUBRIC_2026-06-29.md`
- `docs/CX_0_2_ALPHA_LOG_FLEET_RUNBOOK_2026-06-30.md`
- `docs/CX_0_2_0_PRE_ALPHA_REVIEW_PUNCHLIST_2026-06-29.md`
- `docs/CX_STALE_SERVING_DIAGNOSTIC_NOTES_2026-06-29.md`
- `docs/CX_COACH_SINGLE_MODEL_COLLAPSE_NOTES_2026-06-30.md`
- `docs/CX_CURRENT_STATE_AUDITOR_GUIDE_2026-06-25.md`

## Live-Test Posture

- Read state first: git status, `Parallel*` services, app ports, health endpoints, and relevant log tails.
- Do not start or restart services during live testing. If a restart is needed, tell Mickey exactly which service and why.
- If asked to launch the app, prove the stack state in order: Mongo, control plane, RingCentral CX service, web client, alpha monitor, and alpha log sections.
- Prefer small, auditable changes. Patch one slice at a time, then run targeted tests and capture evidence.
