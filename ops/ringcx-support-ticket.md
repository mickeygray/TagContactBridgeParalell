# RingCX Support Ticket — Manual Outbound + Recording Download

## Summary

We're hitting two independent blockers on our RingCX integration v1 API
against our SUB-Tax Support account:

1. **`createManualAgentCall` does not reliably produce an active call**,
   even when the API returns 200 OK.
2. **All `recordings/*` endpoints return failure** suggesting the
   recording feature isn't provisioned for our `rc_account_id` at all.

Authentication, OAuth, and every non-recording RingCX read endpoint
(`listAccounts`, `listDialGroups`, `listAgents`, `listActiveCalls`,
etc.) work cleanly under the same JWT bearer, so neither issue appears
to be auth-related.

---

## Account context

| | |
|---|---|
| Parent rcAccountId | `50810000` (Tax Support) |
| Sub-account | `50810001` (SUB-Tax Support) |
| Sub-account type | `OMNI`, shard `shard5` |
| App client_id | `8Wv8kvb9UUWb8U3D4YKjBh` (JWT bearer flow) |
| Bearer user | `mgray@taxadvocategroup.com` |
| Agent under test | `mgray+50810001_9702@taxadvocategroup.com` (synthetic RingCX agent email) |

---

## Issue #1 — `createManualAgentCall` placement failures

**Endpoint:** `POST /voice/api/v1/admin/accounts/50810001/activeCalls/createManualAgentCall`

We've observed two distinct failure patterns on this endpoint over the
last 24 hours, with two different agent-identity configurations passed
as the `username` query parameter.

### Configuration A — passing the office email

`username=mgray@taxadvocategroup.com`

**Result:** HTTP 400

```json
{
  "errorCode": "active.calls.agent.not.logged.in",
  "generalMessage": "The supplied data is not valid",
  "details": "Unable to make call: The provided agent is not logged in",
  "requestUri": "/api/v1/admin/accounts/50810001/activeCalls/createManualAgentCall - POST",
  "timestamp": 1778613384671
}
```

Repro timestamp: `2026-05-12T19:16:24.592Z`

This was returned even when the agent was confirmed signed in to the
RingCX Agent dashboard and in AVAILABLE state.

### Configuration B — passing the synthetic RingCX agent email

`username=mgray+50810001_9702@taxadvocategroup.com`

(This is the username RingCX provisioned for the agent — visible in the
RingCX Admin UI under the agent record. Format: `<office-prefix>+<sub-account-id>_<random>@<domain>`.)

**Result:** HTTP 200 OK from the API, but no active call ever appears
in `listActiveCalls` for that destination/caller pair.

Repro timestamps (all `placement-unverified:no-active-ringcx-call`):
- `2026-05-12T19:21:13.089Z`
- `2026-05-12T19:19:15.507Z`
- `2026-05-12T16:02:19.612Z`
- `2026-05-11T23:58:16.899Z`
- `2026-05-11T23:57:11.394Z`
- `2026-05-11T21:59:11.239Z`
- `2026-05-11T21:48:59.164Z`

Our integration polls `listActiveCalls` for ~10 seconds after the
placeManualCall response to verify the call materialized. In these
cases the active-call list never contains a record matching the
destination + callerId we just requested.

### What we'd like RC to clarify

1. **Which exact field value belongs in the `username` query parameter
   for `createManualAgentCall`?** Office email
   (`mgray@taxadvocategroup.com`) or synthetic RingCX agent email
   (`mgray+50810001_9702@taxadvocategroup.com`)? The two configurations
   produce two different errors and the documentation isn't explicit.

2. **Under what conditions does the API return 200 but not actually
   place a call?** Is there a downstream provisioning state on the
   account / agent profile / dial group that we're missing? The
   pattern is consistent across multiple agents and across multiple
   attempts spanning two days.

3. **Is there an authoritative log on RC's side** we can correlate
   with the timestamps above to see what the platform actually did
   with each request? E.g., did the request reach an agent's seat at
   all, or did the platform silently drop it?

---

## Issue #2 — Recording download endpoints return platform / permission errors

**Endpoint family:** `/voice/api/cx/integration/v1/accounts/{rcAccountId}/sub-accounts/{subAccountId}/...`

We've run a structured diagnostic against every recording-related
endpoint we have access to. All three fail in different but related
ways.

### Probe 1 — `interaction-metadata`

`POST /voice/api/cx/integration/v1/accounts/50810000/sub-accounts/50810001/interaction-metadata`

Body shape (validated against RC's own 400-response validation rules):

```json
{
  "segmentEndTime": "2026-05-12 13:45:00",
  "timeInterval": 3600,
  "timeZone": "America/Los_Angeles"
}
```

**Result:** HTTP 403

```json
{
  "errorCode": "access.denied.exception",
  "generalMessage": "You do not have permission to access this resource",
  "details": "",
  "requestUri": "/api/cx/integration/v1/accounts/50810000/sub-accounts/50810001/interaction-metadata - POST",
  "timestamp": 1778625476960
}
```

Captured at `2026-05-12T22:37:56.043Z`.

### Probe 2 — bogus dialog/segment GET (to differentiate "permission denied" from "data not found")

`GET /voice/api/cx/integration/v1/accounts/50810000/sub-accounts/50810001/recordings/dialogs/bogus-id/segments/bogus-id`

**Result:** HTTP 404

```
"EvPlatform by rc_account_id=50810000 not found"
```

This response — `EvPlatform by rc_account_id=50810000 not found` —
strongly suggests the recording platform (Engage Voice Platform / EvPlatform)
hasn't been provisioned against our parent `rcAccountId` at all,
rather than that we lack permission to use it. We're not asking "is
this dialog accessible" — we're asking "does the recording platform
exist for our account", and the answer appears to be no.

### Probe 3 — recordings collection GET

`GET /voice/api/cx/integration/v1/accounts/50810000/sub-accounts/50810001/recordings`

**Result:** HTTP 500

```json
{
  "errorCode": "unknown.exception",
  "generalMessage": "An Internal Server Error occurred while processing this request",
  "details": "",
  "requestUri": "/api/cx/integration/v1/accounts/50810000/sub-accounts/50810001/recordings - GET",
  "timestamp": 1778625688413
}
```

### Cross-check — no `record*` flags appear on any account/dial-group/agent record

We inspected every read response we have access to (`listAccounts`,
`getDialGroup` × all dial groups, `listAgentGroups`, `listAgents`),
and **none** contain any field whose name matches `/record/i`. By
contrast, the same responses do surface `enableHciDialer`,
`enableChat`, `tcpaSafeMode`, `pciCompliance`, etc. — feature flags
are surfaced when they're active. The absence of a recording flag
suggests recording isn't merely permission-gated, it isn't part of
the account's configuration at all.

### What we'd like RC to clarify

1. **Confirm whether call recording is currently provisioned on
   rcAccountId `50810000` / sub-account `50810001`.** Based on the
   "EvPlatform not found" error, our read is that it is not.

2. **If it isn't, what plan tier / SKU change is required to enable
   it,** and is there any per-user, per-agent-group, or
   per-dial-group permission we need to set after RC's side is
   provisioned?

3. **Is the documented endpoint path
   `/voice/api/cx/integration/v1/accounts/{rcAccountId}/sub-accounts/{subAccountId}/recordings/dialogs/{dialogId}/segments/{segmentId}`
   correct** for our account, or has it been deprecated / moved? We
   noticed a legacy `/voice/api/integration/v2/admin/reports/...`
   surface in some docs but it returns 405 Method Not Allowed for
   GET against our account.

---

## What's already wired on our side, ready to use once recording is live

For context: our integration is already coded against the documented
recording flow (interaction-metadata POST → segmentRecordingURL +
dialogId/segmentId → recording WAV GET), with appropriate backoff for
the 2-rpm metadata rate limit and a 15-minute post-call readiness
window. Once RC flips provisioning, no further code changes are
needed on our side — the integration will start receiving recordings
on its existing hourly poll schedule.

## Supporting artifacts available on request

We have structured JSONL audit logs of every probe captured at the
timestamps cited above (request URI, response body, latency). Happy
to attach those if helpful.
