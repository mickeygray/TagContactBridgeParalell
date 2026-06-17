# CX OAuth Necessity Audit

Date: 2026-06-17

## Question

Do CX agents actually need per-user RingCentral/RingCX OAuth for the queue workspace, or can the app continue to place calls through the shared RingCX control/JWT lane while targeting the relevant agent?

## Current Read

The code currently supports both models, but the core CX dial path does not inherently require per-user OAuth.

- `RC_CX_REQUIRE_USER_OAUTH` controls whether `/cx` and CX command routes require a valid stored OAuth session. The code default is `false`.
- `RINGCX_MANUAL_CALL_USE_USER_BEARER` controls whether `dialService.placeCall()` tries an agent-specific RingCX bearer before the shared/admin bearer. Local `.env` sets this to `false`.
- The RingCX voice client can place a manual call through `activeCalls/createManualAgentCall` using a shared/platform bearer and a target RingCX username.
- The current workspace dial flow is browser command -> control-plane dial intent -> RingCX serving service on `6101` -> `ringcxDialExecutionService` -> `dialService.placeCall()` -> RingCX manual call.
- That flow already carries the logged-in agent identity separately from auth: extension id, RingCX username/email, caller ID, and queue assignment are resolved from the user/account/agent state, not from the browser's OAuth token.

## Evidence In Code

- `packages/shared-services/src/cxTokenStorageService.js`
  - `isCxUserOAuthRequired()` returns `envFlag("RC_CX_REQUIRE_USER_OAUTH", false)`.
  - `summarizeOAuthValidityFromAccount()` reports `oauthRequired: false` and `isOAuthValidated: true` when the flag is off.

- `apps/web-client/src/app/CxAuthGuard.tsx`
  - Skips the OAuth redirect when `user.cxAuth.oauthRequired === false`.

- `apps/control-plane/src/middleware/auth.js`
  - `requireCxOAuth` also exits immediately when `isCxUserOAuthRequired()` is false.

- `packages/shared-services/src/cxWorkspaceService.js`
  - `requestCxDial()` validates the logged-in agent and queue ownership, records a dial intent, and relays it to `6101`.

- `packages/shared-services/src/ringcxDialExecutionService.js`
  - Manual execution calls `placeCall(extensionId, ucqQueueItemId, { agentEmail, callerId })`.

- `packages/shared-services/src/dialService.js`
  - If `RINGCX_MANUAL_CALL_USE_USER_BEARER` is enabled and a valid per-user bearer exists, it uses `createRingcxVoiceClient({ userBearer })`.
  - Otherwise it uses `createRingcxVoiceClient()` with the shared RingCX platform/admin bearer.
  - On 401/403 from the user-bearer path, it falls back to the shared/admin bearer.

- `packages/shared-integrations/src/ringcxVoiceClient.js`
  - `placeManualCall()` posts to `activeCalls/createManualAgentCall` with the target `username`, `destination`, `ringDuration`, and `callerId`.
  - The client only uses `userBearer` when explicitly constructed with one.

## Likely Conclusion

Per-user OAuth is probably not necessary for the core queue dial/disposition flow if:

- `RC_CX_REQUIRE_USER_OAUTH=false`
- `RINGCX_MANUAL_CALL_USE_USER_BEARER=false`
- the shared RingCX platform/JWT bearer can call `createManualAgentCall` for the target agent username
- queue ownership and agent identity continue to be enforced inside the app

OAuth may still be useful for a future mode where agents perform actions through their own RingCX bearer, but it should not block queue login unless that mode is deliberately enabled.

## Separate Login Pain Source

There is another cold-login blocker that is not OAuth:

- `apps/control-plane/src/routes/auth.js` awaits `ensureRingcxOffhookAllowed(latest, "auth-verify-code")` before returning the login token.
- `ensureRingcxAgentOffhookAllowed()` may call RingCX to list/find/update agents.
- It has in-memory cooldowns, but the first login after process restart or cache expiry can still pay the RingCX lookup/update cost.

That makes it a good candidate for a morning prep job. It should not be on the critical OTP login path unless we prove it is required for the first call.

## Proof Plan

Add logging before changing behavior:

1. On `/api/auth/verify-code`, log elapsed time for:
   - OTP verification
   - `findAccountByEmail`
   - `ensureRingcxOffhookAllowed`
   - token issuance

2. On `CxAuthGuard`, log whether it skips because:
   - `oauthRequired=false`
   - `isOAuthValidated=true`
   - `cxauth=ok`
   - error state

3. On `dialService.placeCall`, log:
   - `RINGCX_MANUAL_CALL_USE_USER_BEARER`
   - `userBearerActive`
   - `manualAuthMode`
   - elapsed time for user-bearer lookup/refresh
   - elapsed time for RingCX `placeManualCall`

4. Local A/B:
   - A: `RC_CX_REQUIRE_USER_OAUTH=false`, `RINGCX_MANUAL_CALL_USE_USER_BEARER=false`
   - B: same, but disable or defer `ensureRingcxOffhookAllowed` on OTP login
   - C: enable user-bearer lookup only and compare dial latency

5. Functional checks:
   - fresh OTP login
   - workspace render
   - set available/unavailable
   - load next lead
   - place call
   - no-answer disposition
   - answer disposition
   - voicemail disposition/drop
   - end call

## Recommended Direction

Short term:

- Confirm live env has `RC_CX_REQUIRE_USER_OAUTH=false`.
- Confirm live env has `RINGCX_MANUAL_CALL_USE_USER_BEARER=false`.
- Add timing logs around OTP verify and dial bearer selection.
- Move `ensureRingcxOffhookAllowed` off the blocking login path after logs confirm it is a major delay.

Medium term:

- Build a morning CX prep job that loops over active CX agents and performs:
  - off-hook self-heal
  - agent state warmup
  - first queue pack/materialization
  - optional RingCX active state check

Then login can be mostly OTP + `/me`, while the expensive RingCX prep happens before agents arrive.
