# Agent Handoff

This repository is in the middle of CX 0.2 alpha live-testing recovery after a Codex Desktop crash/context loss on 2026-06-30.

## Guardrails

- Read `.ai/context/PROJECT_HANDOFF.md` and `.ai/context/CODEX_RECOVERY_NOTES.md` before changing code.
- Treat the current working tree as live-test WIP. Do not reset, revert, or clean files unless the user explicitly asks.
- Do not read, print, or commit secrets such as `auth.json`, `.env` files, token stores, or raw logs containing credentials or PII.
- Use evidence-first alpha testing. UI state alone is not enough for pass/fail conclusions.
- Check app and service state before editing or restarting anything. At recovery time, the `Parallel*` NSSM services were stopped.
- Hard live-test rule: if any `Parallel*`/NSSM service needs a restart, ask Mickey to do it and wait for confirmation. Do not attempt service restarts from Codex.
- Local Windows authority boundary: Codex may edit `.env` and other in-scope configuration, but PowerShell/NSSM service restarts require elevation Codex does not have. Mickey owns every `Parallel*` start/restart and confirms when it is complete.
- Linux authority boundary: Codex owns targeted Ubuntu `parallel-*` systemd restarts needed by an authorized live change, including the before/after health checks. Do not hand those restarts back to Mickey; the elevated-permission restriction applies to the Windows desktop services.
- 2026-07-02 bulk rewrite rule: do not physically delete code during the weed-whack pass. Disable, comment out, or hard-gate old paths; write the replacement path; run the named tests/gate; report what is now pending deletion; then advance. Permanent deletion waits for Mickey's approval after proof.

## First Reads

- `.ai/context/PROJECT_HANDOFF.md`
- `.ai/context/CODEX_RECOVERY_NOTES.md`
- `.ai/context/PHONEBURNER_PROVIDER_NEUTRAL_LEAD_DELIVERY_WORK_ORDER_2026-07-10.md` whenever the task touches lead selection, cadence dialing, agent allocation, PhoneBurner, queue replacement, call events, or the CX-to-PhoneBurner migration. Re-read it at the start of every such turn and state which numbered phase is active before editing.
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

## PhoneBurner Rewrite Guardrail

- The new daytime lead-delivery trunk is provider-neutral and must not use `CxDialQueue`, `QueueItem`/UCQ, or a renamed copy of either as its runtime store.
- `packages/shared-services/src/leadDeliveryService.js` is the one decision-owning service. Supporting model, repository, transport, route, and configuration files must remain thin and must not make allocation, priority, cadence, or refill decisions.
- Folder IDs remain blank until Mickey creates the PhoneBurner distribution and receiving folders and supplies the IDs. Never guess, discover-and-write, or reuse historical folder IDs without explicit confirmation.
- Do not write implementation code until the work order's pre-implementation checklist is satisfied. After implementation begins, re-read the work order at every turn and report the active phase and proof gate.
- This rewrite runs as a persistent proof-gated goal. After a phase gate passes, advance to the next phase automatically; do not wait for a new user prompt. Pause only for a genuinely external requirement (notably Mickey-created PhoneBurner folder/LeadStream IDs), a destructive action, or a material product decision the work order does not settle.
