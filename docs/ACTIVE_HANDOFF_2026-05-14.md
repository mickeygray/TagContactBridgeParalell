# Active Handoff - 2026-05-14

This is the working context handoff for `TagContactBridgeParallel`.

Use this file when moving to a new computer or opening a fresh Codex thread:

```text
Read docs/ACTIVE_HANDOFF_2026-05-14.md and continue from there.
```

## Repo / Runtime Shape

Workspace root on the current Windows machine:

```text
C:\Users\Admin\Code\TagContactBridgeParallel
```

Main services:

- Control plane: `apps/control-plane/src/server.js`, normally port `5001`.
- Inbound gateway: `apps/inbound-gateway/src/server.js`, normally port `4001`.
- Outbound gateway: `apps/outbound-gateway/src/server.js`, normally port `4002`.
- RingCentral CX service: `apps/ringcentral-cx/src/server.js`, normally port `6101`.
- Web client: `apps/web-client`, Vite dev port `3001`.
- Public access currently goes through ngrok/Nginx for `tagcontactbridge.ngrok.app`.

Installed Windows services seen on this machine:

- `ParallelControlPlane`
- `ParallelInboundGateway`
- `ParallelOutboundGateway`
- `ParallelRingCentralCx`
- `ParallelRestartHelper`
- `ParallelNginx` exists but has been seen stopped
- legacy `TagContactBridge` exists separately

Important local log paths:

```text
C:\tools\logs\parallel-parallelringcentralcx.out.log
C:\tools\logs\parallel-parallelringcentralcx.err.log
C:\tools\logs\parallel-parallelcontrolplane.out.log
C:\tools\logs\parallel-parallelcontrolplane.err.log
```

## New Computer Continuation

The safe migration path is:

1. Clone/pull this repo on the new computer.
2. Bring over the production `.env` manually. It is intentionally ignored by Git.
3. Install dependencies with `npm install`.
4. Use this handoff doc as the thread bootstrap.
5. Recreate Windows services or switch to Ubuntu/systemd using the existing ops docs.

Do not push or casually copy:

- `C:\Users\Admin\.codex\auth.json`
- `.env`
- token stores
- raw RingCX logs with lead/customer details

The exact Codex desktop chat may live under `C:\Users\Admin\.codex`, but that directory contains auth and local state. Prefer this repo handoff over copying the whole Codex state folder.

## Current Production Safety State

After the manual dial test, `.env` was flipped back to campaign-only.

Current intended runtime mode:

```text
RINGCX_DIAL_EXECUTION_MODE=ringcx-campaign-queue
RINGCX_AGENT_ROUTE_*_EXECUTION_MODE=ringcx-campaign-queue
RINGCX_MANUAL_CALL_PREFLIGHT_STRICT=false
RINGCX_MANUAL_CALL_RING_DURATION_SECONDS=8
CX_DIAL_FALLBACK_ON_UNVERIFIED=true
RCX_ACTIVE_CALL_VERIFY_MS=3000
```

Because `.env` is ignored, confirm this on the target machine before restart.

The service shell in Codex could edit files but could not restart the locked NSSM services. The user has been using their normal app restart trigger. Any env changes require the normal service restart to load.

## Git / Push Prep

The tree is intentionally dirty across multiple active workstreams. Do not blindly `git add .` without reviewing. Some untracked items are intentionally local artifacts.

Files that should not be committed from the latest manual dial test:

```text
out/rcx-manual-test-report-*.log
out/rcx-manual-dial-ticket-summary-*.md
```

These are now ignored by `.gitignore`; the sanitized ticket summary is in `docs/`.

Recommended push shape:

1. Commit durable docs and targeted code changes separately from raw logs.
2. Review untracked feature files before adding:
   - `apps/web-client/src/workspaces/inbox/WynnInboxWorkspace.tsx`
   - `packages/shared-services/src/hotIntentRouterService.js`
   - `ops/investigate/`
3. Avoid committing `.env`, auth, raw logs, or token material.

Good pre-push checks used recently:

```powershell
node --check packages\shared-services\src\cxWorkspaceService.js
npm.cmd run build --workspace=web-client
git diff --check
```

Note: PowerShell blocks `npm.ps1` on this host, so use `npm.cmd`.

## RingCX Manual Dial Workstream

### Problem

Campaign dialing works. Manual outbound through RingCX API does not reliably connect.

Desired path:

- App serves lead to agent.
- App tries manual outbound through RingCX.
- If manual fails in normal production mode, campaign fallback protects the workflow.
- During diagnostic mode, campaign fallback was turned off to isolate manual behavior.

### Support Guidance Received From RingCentral

RingCentral support said:

- For manual agent call, use the generated RingCX username, not the plain email.
- Username example shape: `mgray+50810001_9702@taxadvocategroup.com`
- Query parameter must be encoded, so `+` becomes `%2B` and `@` becomes `%40`.
- Agent must be logged into RingCX Agent portal to create an off-hook session.
- If using SPOG, dynamic off-hook session may be required.

Relevant endpoints from support:

```text
GET /v1/admin/accounts/{accountId}/agentGroups/{agentGroupId}/agents/{agentId}/login
GET /voice/api/v1/admin/accounts/{accountId}/gateGroups/{gateGroupId}/gates/{gateId}/gateAgentAccessLogin
PUT /voice/api/v1/admin/accounts/{accountId}/agentGroups/{agentGroupId}/agents/{agentId}
PUT /voice/api/v1/admin/accounts/{accountId}/dialGroups/{dialGroupId}/assignAgents
PUT /voice/api/v1/admin/accounts/{accountId}/campaignLeads/actions?leadAction=AGENT_RESERVATION
POST /v1/admin/accounts/{accountId}/agentGroups/{agentGroupId}/agents/{agentId}/setAgentState?state=<STATE>
POST /v1/admin/accounts/{accountId}/agentGroups/setStateByUsername/{username}?state=<STATE>
POST /v1/admin/accounts/{accountId}/agentGroups/updateAgentLoginDialGroup/{dialGroupId}
POST /voice/api/v1/admin/accounts/{accountId}/activeCalls/{uii}/dispositionCall
```

Public integration API detail from support:

```text
POST https://ringcx.ringcentral.com/voice/api/cx/integration/v1/accounts/2252193005/sub-accounts/50810001/interaction-metadata
```

### What Was Implemented/Tested

Manual call username handling was patched in:

- `packages/shared-integrations/src/ringcxVoiceClient.js`
- `packages/shared-services/src/dialService.js`

Key behavior:

- Pull generated RingCX username from RingCX/user metadata.
- Prefer generated username over plain office email.
- Encode query using `URLSearchParams`.
- Use per-user bearer first when available, then fall back to admin bearer on `401/403`.
- Preflight manual dial by checking RingCX login/session state.
- Verify accepted manual call by polling active calls because response has no `uii`.

Endpoint flow tested:

```text
GET  /voice/api/v1/admin/accounts/{accountId}/agentGroups/{agentGroupId}/agents/{agentId}/login
POST /voice/api/v1/admin/accounts/{accountId}/activeCalls/createManualAgentCall
GET  /voice/api/v1/admin/accounts/{accountId}/activeCalls/list
```

Manual-only diagnostic flags used:

```text
RINGCX_DIAL_EXECUTION_MODE=manual
RINGCX_AGENT_ROUTE_*_EXECUTION_MODE=manual
RINGCX_MANUAL_CALL_USE_USER_BEARER=true
RINGCX_MANUAL_CALL_SEND_CALLER_ID=true
RINGCX_MANUAL_CALL_PREFLIGHT_ENABLED=true
RINGCX_MANUAL_CALL_PREFLIGHT_STRICT=true
RINGCX_MANUAL_CALL_RING_DURATION_SECONDS=20
RINGCX_DIAL_EXECUTION_VERBOSE_LOGS=true
CX_DIAL_FALLBACK_ON_UNVERIFIED=false
RCX_ACTIVE_CALL_VERIFY_MS=30000
RCX_ACTIVE_CALL_VERIFY_INTERVAL_MS=3000
```

### Manual Dial Test Result

The manual-only test was conclusive:

- Agents passed strict preflight.
- RingCX reported them available/logged in with IQ `sessionId` and `iqServerId`.
- `createManualAgentCall` returned a boolean success-like response, but no `uii`.
- Active call verification found no matching active call after about 30 seconds.
- Sean/Anthony user-bearer attempts returned `401`, then admin-bearer returned boolean/no-active-call.
- No campaign fallback occurred during the test.
- No 429 appeared during the manual-only test window.

Resulting error:

```text
placement-unverified:no-active-ringcx-call
```

Sanitized ticket doc:

```text
docs/RINGCX_MANUAL_DIAL_API_TICKET_2026-05-14.md
```

Local raw extracted diagnostic log, not for GitHub:

```text
out/rcx-manual-test-report-20260514-203848.log
```

### Current Decision

Stay in campaign-only mode until RingCentral explains why `createManualAgentCall` accepts but does not create/attach an active call.

Possible next manual test after support response:

- Omit `callerId` and let RingCX use default manual outbound caller ID.
- Test after setting `manualOutboundDefaultWorkflowId`.
- Test with dynamic off-hook session setting confirmed.
- Ask RingCentral whether `activeCalls/list` should show manual API calls and what boolean response means.

## RingCX Rate Limit Safety

RingCentral clarified usage groups:

- Token/Auth group: example `5 requests/user/min`.
- Heavy group: example `10 requests/user/min`.
- Multiple Heavy APIs share the same group budget.
- On rate limit, delay for the group penalty interval; honor `Retry-After`.
- `X-Rate-Limit-Remaining` is available in response headers.

Observed production alert:

```text
Service: ringcx-voice
Scope: active-call-list
Status: 429
Retry-After: 1
Path: /voice/api/v1/admin/accounts/{accountId}/activeCalls/list
Response body: "rate"
```

Work in repo includes:

- `packages/shared-integrations/src/ringcentralClient.js`
- `packages/shared-integrations/src/rateLimitAlertService.js`
- `packages/shared-integrations/src/ringcxVoiceClient.js`

Intent:

- Avoid request storms after restarts.
- Apply grouped cooldown/penalty behavior for RingCentral/RingCX.
- Email alert when cooldown trips.
- Avoid a five-minute global blunt pause except as emergency fallback.

Open item:

- Re-audit all RingCX polling paths against usage groups and make sure `activeCalls/list` is not polled concurrently by multiple services when one shared answer would do.

## CX Queue / Lead Serving

### Business Rules User Confirmed

Current conceptual lead filters:

- Green priority.
- Green second tier.
- Blue/red balanced.
- Red only.
- Day 1 zero contact.
- Day 1 second contact.
- Day 2-15.
- Aged.
- Aged-only formed from queue hits.

User preference:

- Most authenticated CX users should be able to use contact tools.
- Domain agnostic by default, except Logics calls and client contact.
- Do not expose API credentials in public/client requests.
- Avoid meaningful queue behavior changes unless very targeted.

### Queue Ordering Bug Fixed

Bug report:

Blue was loading above green on some agents' queues.

Cause:

- Green first-contact items ranked `0`.
- Blue ranked `1`.
- Green follow-up/second-tier items ranked `1.5`.
- Therefore blue could sort above green follow-ups for agents who had those items.

Patch:

- Green first-contact remains `0`.
- Green follow-up becomes `0.5`.
- Blue remains `1`.
- Red/aged remains `2`.

Files changed:

```text
apps/web-client/src/workspaces/cx/CXWorkspace.tsx
packages/shared-services/src/cxWorkspaceService.js
```

Verification:

```powershell
node --check packages\shared-services\src\cxWorkspaceService.js
npm.cmd run build --workspace=web-client
```

This needs normal deploy/restart to show everywhere.

### Queue Serving / Routing Files To Know

Core files:

```text
packages/shared-services/src/cxWorkspaceService.js
packages/shared-services/src/cxCadenceService.js
packages/shared-services/src/cxQueuePolicyService.js
packages/shared-services/src/cxLoadBalancerService.js
packages/shared-services/src/ringcxLeadServingService.js
packages/shared-services/src/ringcxDialExecutionService.js
packages/shared-repositories/src/cxDialQueueRepository.js
packages/shared-models/src/CxDialQueue.js
apps/web-client/src/workspaces/cx/CXWorkspace.tsx
```

Open concerns:

- Make sure backend serving order and frontend rendered order never diverge.
- Make sure queue assignment and route/campaign publication use the same effective route fields.
- After any queue sort change, test auto-serve, visible queue panel, and campaign publication together.

## User / Agent Flow

Work was discussed and partially wired around:

- Deactivating a user.
- Adding a user by explicitly finding them in both EX and CX.
- Capturing username/email/extension.
- Running OAuth check so users recertify as needed.
- Storing/generated RingCX username on `UserAccount.metadata`.

Known generated RingCX usernames were written directly into Mongo user records for current agents. This is database state, not Git state.

Current known examples:

```text
slucas+50810001_3929@taxadvocategroup.com
polson+50810001_7853@taxadvocategroup.com
acalloway+50810001_9322@taxadvocategroup.com
awells+50810001_4902@taxadvocategroup.com
ballen+50810001_3443@taxadvocategroup.com
mgray+50810001_9702@taxadvocategroup.com
manderson+50810001_3409@taxadvocategroup.com
abanks+50810001_5524@taxadvocategroup.com
```

Relevant files:

```text
apps/web-client/src/workspaces/users/UsersWorkspace.tsx
apps/web-client/src/workspaces/users/UserForm.tsx
packages/shared-services/src/userProvisioningService.js
packages/shared-repositories/src/userAccountRepository.js
packages/shared-models/src/UserAccount.js
```

Open item:

- Fully verify deactivation behavior across UI, API, queue eligibility, OAuth guard, and workspace visibility.

## Sales Trainer / Prospect Bot

Current direction:

- React app for tax resolution call simulator.
- Claude/Anthropic can be the simulator brain.
- GPT/OpenAI Whisper handles speech-to-text.
- GPT/OpenAI TTS handles voice back to the trainee, with personality/instruction text coming from the simulator.
- UI renders coaching, health, phase notes, and scorecard from tagged payloads.
- Chat-visible text must strip `<UI_HEALTH>`, `<UI_PAYLOAD>`, and `<UI_SCORECARD>` JSON blocks.

Auth:

- Trainer is behind OTP.
- Allowed non-TaxAdvocateGroup emails supplied:
  - `c.rodriguez0905@icloud.com`
  - `yochrisbolt@gmail.com`
  - `c.garcia11@me.com`
- TaxAdvocateGroup agent/admin users should also access.

Voice UX state:

- App should request mic permission on load.
- Agent should not need to press anything after starting.
- UI should detect a pause, show countdown, then send audio blob to backend for transcription.
- Text sending should be disabled or deprioritized for voice mode.
- TTS speed tuning was explored. Current direction was faster server-side TTS/base speed and slower client playback. Re-check actual code before changing again.

Relevant files:

```text
apps/control-plane/src/routes/salesTrainer.js
apps/web-client/src/workspaces/trainer/SalesTrainerWorkspace.tsx
packages/shared-services/src/taxResolutionSalesTrainerService.js
packages/shared-services/src/taxResolutionSalesTrainerPrompt.md
apps/web-client/src/lib/api/salesTrainer.ts
```

Open items:

- End-to-end audio test on HTTPS/ngrok.
- Confirm browser mic permission prompts on load.
- Confirm transcribed audio posts automatically after silence.
- Confirm TTS uses consistent voice throughout conversation.
- Confirm no tips/coaching text appears in chat when the latest spec says coaching belongs in the side UI.

## SMS / Inbox Workstream

There is active work around SMS inbox and conversation workflows.

Files changed/untracked:

```text
apps/control-plane/src/routes/commandsInbox.js
apps/control-plane/src/routes/readInbox.js
apps/web-client/src/app/routes.tsx
apps/web-client/src/lib/api/queries/inbox.ts
apps/web-client/src/lib/api/types.ts
apps/web-client/src/workspaces/inbox/InboxWorkspace.tsx
apps/web-client/src/workspaces/inbox/WynnInboxWorkspace.tsx
packages/shared-models/src/ConversationWorkflow.js
packages/shared-repositories/src/conversationWorkflowRepository.js
packages/shared-services/src/inboxCommandService.js
packages/shared-services/src/smsClassifierService.js
packages/shared-services/src/hotIntentRouterService.js
```

Intent:

- Better SMS inbox / workflow visibility.
- Support important inbound SMS classification.
- Route/review replies and opt-outs safely.
- Potential separate Wynn inbox surface.

Open item:

- Perform a focused review before committing these files. Some are untracked and should be intentionally added only after confirming the feature is wanted in this push.

## LD / Vendor Posting Route

Work in progress around accepting vendor/LD-style posts and routing into inbound intake.

Files:

```text
apps/inbound-gateway/src/server.js
packages/shared-services/src/inboundIntakeService.js
docs/INBOUND_VENDOR_POSTING_GUIDE.md
```

Context:

- User showed an Opta-style URL with query fields such as name, phone, email, DOB, address, campaign/pub IDs, and auth.
- Goal was to support that into the existing LD posting flow.
- User mentioned Royal Mills showed accepted on their end and wanted confirmation.

Open items:

- Smoke test inbound vendor route with a safe sample.
- Confirm accepted payload creates/updates expected records.
- Confirm auth/signature behavior and do not leak vendor auth details into logs.

## RingCX Campaign / Manual / Hard Phone Strategy

Current reality:

- API can do admin-plane updates and campaign lead loading.
- API cannot create a live agent voice endpoint purely through OAuth.
- Agent must have RingCX Agent UI/session for manual/dynamic off-hook work.
- Hard phone vs soft phone remains mostly an agent setup/admin workflow issue.

Manual outbound direction:

- Keep campaign path stable.
- Use manual path only as diagnostic/experimental until RingCentral explains boolean response/no active call.
- Do not let manual failure block production calling.

Hard phone/presence possibilities:

- Set default voice device/softphone binding for next login through admin API.
- Read agent login/default phone/off-hook state through login endpoint.
- Runtime device swap for active session is not supported per support response.

## Ubuntu / New Machine Readiness

User is migrating hardware:

- New computer will hold main Windows/data.
- Old machine likely becomes Ubuntu primary host.
- Existing drive may move as secondary drive for file access.

Guidance already given:

- If important work is in GitHub and `.env`/secrets are backed up, risk is manageable.
- Do not rely on Windows.old or drive migration as the only backup.
- On Ubuntu, prefer systemd services or pm2 over NSSM.
- Nginx/ngrok config needs a clean single source of truth; current Windows host has multiple Nginx configs/services.

Useful docs:

```text
docs/DEPLOY_QUICKSTART.md
docs/NGINX_NGROK_CUTOVER_CHECKLIST.md
docs/architecture/PARALLEL_PRODUCTION_DEPLOYMENT.md
docs/architecture/runtime-topology.md
ops/nginx/ubuntu-cutover.md
ops/nssm/README.md
```

Open items before Ubuntu launch:

- Confirm `.env` complete.
- Confirm Mongo connectivity.
- Confirm Node version.
- Confirm ngrok reserved domain/tunnel.
- Confirm Nginx config points at correct ports.
- Confirm service restart/reload commands.
- Confirm RingCentral/RingCX OAuth callback URLs match the public domain.

## Immediate Next Actions

1. Restart/redeploy after campaign-only env and queue-rank fix.
2. Confirm agents are back on campaign-only mode and calls are flowing.
3. Send `docs/RINGCX_MANUAL_DIAL_API_TICKET_2026-05-14.md` to RingCentral.
4. Decide whether the SMS inbox changes are ready for commit or should stay in a separate work branch.
5. Review untracked files before `git add`.
6. Push docs and targeted stable fixes to GitHub.
7. On the new computer, start with this doc and verify `.env`/services before touching queue logic.

## Known Verification Already Run

Queue-rank fix:

```powershell
node --check packages\shared-services\src\cxWorkspaceService.js
npm.cmd run build --workspace=web-client
```

Manual dial files were previously checked during the debugging session:

```powershell
node --check packages\shared-integrations\src\ringcxVoiceClient.js
node --check packages\shared-services\src\dialService.js
```

Final recommended check before push:

```powershell
git diff --check
npm.cmd run build --workspace=web-client
```

