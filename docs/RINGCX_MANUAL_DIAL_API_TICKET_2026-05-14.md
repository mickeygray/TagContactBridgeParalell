# RingCX Manual Dial API Diagnostic Summary

Generated: 2026-05-14

## Environment / Account Context

- RingCX sub-account: `50810001`
- RingEX account ID supplied by RingCentral support: `2252193005`
- App/workspace: `TagContactBridgeParallel`
- Test window in local logs: approximately `2026-05-14T20:34Z` through `2026-05-14T20:37Z`

Local raw evidence file, not intended for GitHub:

```text
C:\Users\Admin\Code\TagContactBridgeParallel\out\rcx-manual-test-report-20260514-203848.log
```

## Goal

We are trying to place manual outbound RingCX calls from our own app while agents are logged into the RingCX Agent portal. Campaign dialing works. Manual dialing through the API is the failing path.

For the diagnostic test, campaign fallback was disabled so manual API behavior was not masked by successful campaign fallback.

## Endpoints / API Flow Tested

### Agent login/session preflight

```text
GET /voice/api/v1/admin/accounts/{accountId}/agentGroups/{agentGroupId}/agents/{agentId}/login
```

Verified fields:

- `status: AVAILABLE`
- `auxState: AVAILABLE`
- `loginType: OUTBOUND`
- `loggedIn: true`
- `ghostLogin: false`
- `pendingDisposition: false`
- `registeredPhone` populated
- `sessionId` populated
- `iqServerId` populated

Observed successful preflight examples:

- Phil Olson: RingCX agent `20844`, group `2156`, ready with IQ session.
- Sean Lucas: RingCX agent `20845`, group `2156`, ready with IQ session.
- Anthony Calloway: RingCX agent `20842`, group `2156`, ready with IQ session.
- Bruce Allen: RingCX agent `21017`, group `2187`, ready with IQ session.

### Manual call create

```text
POST /voice/api/v1/admin/accounts/{accountId}/activeCalls/createManualAgentCall
```

Query parameters sent:

```text
username={generated RingCX username, URL encoded}
destination={lead phone}
ringDuration=20
callerId={agent/account caller id}
```

Important implementation detail:

RingCentral support instructed us to use the generated RingCX username, not the plain email. We updated the app to send usernames shaped like:

```text
user+50810001_xxxx@taxadvocategroup.com
```

The app encodes the query through `URLSearchParams`, so:

```text
+ -> %2B
@ -> %40
```

### Active call verification

Because `createManualAgentCall` returned only a boolean response and no `uii`, we polled active calls:

```text
GET /voice/api/v1/admin/accounts/{accountId}/activeCalls/list
```

During the manual-only test:

```text
RCX_ACTIVE_CALL_VERIFY_MS=30000
RCX_ACTIVE_CALL_VERIFY_INTERVAL_MS=3000
```

Result: no matching active call appeared for the requested destination/caller ID after 30+ seconds.

## Temporary Runtime Flags Used

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

Production rollback settings after the test:

```text
RINGCX_DIAL_EXECUTION_MODE=ringcx-campaign-queue
RINGCX_AGENT_ROUTE_*_EXECUTION_MODE=ringcx-campaign-queue
RINGCX_MANUAL_CALL_PREFLIGHT_STRICT=false
RINGCX_MANUAL_CALL_RING_DURATION_SECONDS=8
CX_DIAL_FALLBACK_ON_UNVERIFIED=true
RCX_ACTIVE_CALL_VERIFY_MS=3000
```

## What Changed Before Testing

1. Switched manual call username from plain email to generated RingCX username.
2. Ensured username query parameter is URL encoded exactly once.
3. Added preflight to verify live RingCX login/IQ session before `createManualAgentCall`.
4. Added user-bearer attempt first when user OAuth is available, with admin-bearer fallback on `401/403`.
5. Disabled campaign fallback during diagnostic test.
6. Increased manual call `ringDuration` to `20`.
7. Increased active-call verification to `30` seconds.
8. Reduced active-call polling to every `3` seconds to avoid rate-limit pressure.

## Observations

### Preflight passed

Agents were reported by RingCX as available and logged in with IQ sessions.

Example fields:

```json
{
  "ready": true,
  "reason": "ringcx-agent-ready",
  "status": "AVAILABLE",
  "auxState": "AVAILABLE",
  "loginType": "OUTBOUND",
  "loggedIn": true,
  "ghostLogin": false,
  "pendingDisposition": false,
  "registeredPhone": "populated",
  "sessionId": "populated",
  "iqServerId": "populated"
}
```

### `createManualAgentCall` accepted the request but returned only boolean

For Phil/Bruce admin-bearer calls and Sean/Anthony after admin fallback:

```json
{
  "response": {
    "valueType": "boolean"
  }
}
```

No `uii`, `callId`, or active-call identifier was returned.

### User OAuth bearer failed with 401 for some users

For Sean and Anthony, the app first tried the stored user bearer token. RingCX returned:

```text
POST /voice/api/v1/admin/accounts/50810001/activeCalls/createManualAgentCall failed: 401
```

The app retried with admin bearer. Admin bearer did not return an HTTP error; it returned the boolean response described above.

### No active call appeared after manual call acceptance

Observed failure:

```text
placement-unverified:no-active-ringcx-call
```

Examples:

- Phil: preflight ready, admin-bearer manual create returned boolean, no matching active call after about 32 seconds.
- Sean: preflight ready, user-bearer 401, admin-bearer manual create returned boolean, no matching active call after about 32 seconds.
- Anthony: preflight ready, user-bearer 401, admin-bearer manual create returned boolean, no matching active call after about 31 seconds.
- Bruce: preflight ready, admin-bearer manual create returned boolean, no matching active call after about 32 seconds.

### No campaign fallback occurred during test

Logs confirmed:

```json
{
  "executionMode": "manual",
  "fallbackCandidate": false,
  "fallbackAttempted": false
}
```

### No 429 rate-limit issue appeared in this manual-only window

The relevant failure was not rate limiting. The failure was that manual call creation returned a boolean success-like response but no active call appeared.

## Primary Question For RingCentral

When an agent is logged into the RingCX Agent portal and the login endpoint shows `AVAILABLE`, `OUTBOUND`, `loggedIn: true`, populated `registeredPhone`, populated `sessionId`, and populated `iqServerId`, why would:

```text
POST /voice/api/v1/admin/accounts/50810001/activeCalls/createManualAgentCall
```

return a boolean success-like response but never create a visible active call in:

```text
GET /voice/api/v1/admin/accounts/50810001/activeCalls/list
```

and never connect the agent/destination?

## Specific Questions

1. Does `createManualAgentCall` returning a bare boolean mean the call was accepted, queued, rejected, or only command-dispatched?
2. Is there another endpoint or event stream we should check to confirm the JMS/IQ command was accepted by the live agent session?
3. Is `activeCalls/list` expected to show calls created by `createManualAgentCall` immediately, or can these calls be invisible there?
4. Are `defaultLoginDest`, `manualOutboundDefaultWorkflowId`, `manualOutboundDefaultCallerId`, `manualOutboundDefaultGate`, or `allowManualOutboundGates` required for API-created manual calls to actually connect?
5. Does the `callerId` query parameter need to be omitted, E.164 formatted, or restricted to a configured manual outbound caller ID?
6. Why would a valid user OAuth bearer receive `401` on `createManualAgentCall` while admin bearer gets a boolean response?
7. Is Dynamic Off-Hook Session required for this path if agents are using the RingCX/SPOG portal?
8. Is there an API or admin setting that confirms the agent has the exact live IQ telephony endpoint required for `createManualAgentCall`, beyond the login endpoint fields we are already reading?

## Files Changed In App For This Diagnostic Path

```text
packages/shared-integrations/src/ringcxVoiceClient.js
packages/shared-services/src/dialService.js
packages/shared-services/src/ringcxDialExecutionService.js
packages/shared-services/src/cxWorkspaceService.js
packages/shared-services/src/ringcxAgentMonitorService.js
packages/shared-services/src/ringcxLeadServingService.js
```

