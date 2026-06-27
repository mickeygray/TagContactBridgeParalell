# CX Three-Mode Live Patch Readiness - 2026-06-22

Purpose: prepare the live box for a disruptive CX workspace patch that introduces three selectable workplace modes:

```text
legacy_emergency
slow_single
bulk_load
```

The live safety goal is simple: preserve every live hotfix before patching, keep legacy available as the emergency client build, and make the new rails selectable without mixing AI-v2 or unrelated WIP into this deploy.

## Local Patch Surface

Current local intent:

- AI-v2, coach, resolution, blogger, and unrelated one-offs are preserved in git stash and are not part of this patch surface.
- Visible working tree should stay limited to CX workplace, RingCX/CX backend, rail services, tests, docs, and queue scripts.
- `CXWorkspaceRouter` selects the client mode by `VITE_CX_WORKSPACE_MODE`.
- `legacy_emergency` renders the live-shaped `CXWorkspace`.
- `slow_single` renders `slow-single/CXWorkspaceSlowSingle`.
- `bulk_load` renders `CXWorkspaceBulkLoad`.

Important live-safety cleanup already applied:

- The simple-loop test panel no longer hard-codes Sean/Slucas as enabled. It is now opt-in through `VITE_CX_SIMPLE_LOOP_PANEL_ENABLED`, `VITE_CX_SIMPLE_LOOP_PANEL_EMAILS`, or localhost-only query/localStorage testing.
- Legacy terminal buttons keep the conservative defer behavior through `DEFER_DISPOSITION_NEXT_DIAL=true`.
- Appointment "call now" uses the RingCX campaign queue path and immediate priority rather than manual-call test plumbing.

## Mode Matrix

| Mode | Client flag | Purpose | Patch posture |
| --- | --- | --- | --- |
| `legacy_emergency` | `VITE_CX_WORKSPACE_MODE=legacy_emergency` or unset | Floor-safe fallback matching the current live UX. | Must include the subtle live patches. No test panels by default. |
| `slow_single` | `VITE_CX_WORKSPACE_MODE=slow_single` | Clean one-lead-at-a-time rail. Stability first. | Testable after backend route/service restart. |
| `bulk_load` | `VITE_CX_WORKSPACE_MODE=bulk_load` | RingCX-owned buffer rail. Throughput first. | Visually allowed to match legacy, but must use bulk backend endpoints where intentionally wired. |

## Live Stash Protocol

Before replacing anything on live:

```bash
cd /opt/tagcontactbridge-parallel
git status --short
git stash push -u -m "pre-three-mode-cx-patch-$(date -Iseconds)"
git stash list -1
```

Rules:

- Do not drop the live stash during the patch window.
- If live has untracked files, stash with `-u` so they are preserved.
- If the status includes files that look like emergency hotfixes, capture `git diff --stat` and `git diff -- <file>` before stashing so the reason is visible in the thread.
- Patch only after the local commit is validated and pushed.

## Required Restarts

The patch can touch three surfaces:

- Web client build: required when changing `VITE_CX_WORKSPACE_MODE` or any CX workspace React code.
- `parallel-control-plane`: required for new `/api/cx-*` routes and control-plane CX route changes.
- `parallel-ringcentral-cx`: required for RingCX/CX runtime changes, morning queue builder, active-call watcher, EX poll settings, and dial execution env changes.

Likely restart order:

```bash
sudo systemctl restart parallel-control-plane
sudo systemctl restart parallel-ringcentral-cx
systemctl is-active parallel-control-plane parallel-ringcentral-cx
```

If the web client was rebuilt, agents should hard refresh after backend health is green.

## Env Defaults For Patch Safety

Keep these conservative unless intentionally testing a mode:

```text
VITE_CX_WORKSPACE_MODE=legacy_emergency
RINGCX_CAMPAIGN_REQUIRE_ACTIVE_CALL_CONFIRMATION=true
RINGCX_CAMPAIGN_CALL_CAPTURE_ASYNC=false
CX_CANONICAL_CALL_STRICT_GATE=false
```

Do not turn on test-only simple loop UI in live by default:

```text
VITE_CX_SIMPLE_LOOP_PANEL_ENABLED=false
VITE_CX_SIMPLE_LOOP_PANEL_EMAILS=
CX_SIMPLE_LOOP_ENABLED=false
```

For bulk rail tests, enable deliberately and only when the backend route/runtime is expected to accept it:

```text
VITE_CX_WORKSPACE_MODE=bulk_load
CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=true
```

For slow single:

```text
VITE_CX_WORKSPACE_MODE=slow_single
```

## Pre-Patch Validation

Run locally before commit:

```powershell
npm.cmd run typecheck --workspace=web-client
node --check apps/control-plane/src/routes/cxSlowSingle.js
node --check apps/control-plane/src/routes/cxBulkLoad.js
node --check packages/shared-services/src/cxSlowLaneService.js
node --check packages/shared-services/src/cxSlowLaneStateMachine.js
node --check packages/shared-services/src/cxBulkLoadRuntime.js
node --check packages/shared-services/src/cxBulkLoadRuntimeService.js
node --check packages/shared-services/src/cxMorningQueueBuilderService.js
node --check apps/ringcentral-cx/src/server.js
```

Also verify:

- `git status --short` does not show `apps/ai-bus`, live coach model files, blogger, resolution AI, transcription, or unrelated one-offs.
- `CXWorkspaceRouter` defaults to `legacy_emergency`.
- Legacy client build does not show the simple-loop test panel unless explicitly enabled.
- Slow-single terminal buttons record outcome and then request the next call through its own route.
- Bulk-load mode can start/watch/complete without using legacy `nextDial` as the source of truth for the center card.

## Smoke Tests After Patch

Legacy fallback smoke:

- Build with `VITE_CX_WORKSPACE_MODE=legacy_emergency`.
- Agent can login and load CX.
- Answer, No Answer, and VM buttons do not submit the form accidentally.
- Buttons disable during transition.
- No simple-loop panel appears by default.
- Conservative defer behavior remains in place.

Slow-single smoke:

- Build with `VITE_CX_WORKSPACE_MODE=slow_single`.
- Start/select one lead.
- Confirm active call identity before showing it as current.
- Press terminal button.
- Outcome is recorded once.
- UI enters loading/transition.
- Next call is requested only through slow-single command flow.

Bulk-load smoke:

- Build with `VITE_CX_WORKSPACE_MODE=bulk_load`.
- Publish a small ordered buffer.
- Watch active call once per second.
- Current card updates from the active RingCX call identity, not our assumed queue order.
- Terminal button pushes current to completed/buffer for grading/metrics.
- Remaining accepted buffer count decreases.
- Refill is triggered only at the configured threshold.

## Rollback

Fastest user-visible rollback:

```text
VITE_CX_WORKSPACE_MODE=legacy_emergency
```

Rebuild the client and hard refresh agents. If backend routes were restarted but behavior is bad only in the client rail, prefer client rollback first.

Backend rollback if services regress:

```bash
cd /opt/tagcontactbridge-parallel
git status --short
git log --oneline -5
# reset/redeploy to the known previous commit, preserving the pre-patch stash
sudo systemctl restart parallel-control-plane parallel-ringcentral-cx
```

Only apply the pre-patch live stash if the rollback target needs a live-only hotfix restored. Do not blindly apply it over a newer tree.

## Open Patch Risks

- The legacy workspace still carries old handoff plumbing by design. It is an emergency fallback, not the target architecture.
- Bulk mode is visually close to legacy right now. That is acceptable for the floor if the backend behavior is the desired bulk behavior, but audit the data source before declaring it clean.
- Runtime resolver flags are later-phase canary tools. The first live switch should be the client build flag unless deliberately testing per-agent runtime routing.
- Any client build that enables test panels or local harness UI by default is not live-safe.

