# CX OAuth (Agent SSO) — Setup Guide

When complete: agents log into Parallel via OTP, then click "Connect RingCentral"
once. After that, every dial uses **their** RingCX credentials (audit trail
attributes activity to them, not the admin service account). Refresh tokens
last ~60 days; the admin only re-prompts after that.

This doc is the runbook for the one-time RC app + env setup.

## What this PR ships

- `cxAuth` + `cxSession` fields on UserAccount (encrypted at rest)
- `cxTokenStorageService` (AES-256-GCM, env key)
- `cxOAuthService` (PKCE start + callback + refresh)
- `RcOAuthState` collection (TTL-cleaned PKCE state)
- 5 new endpoints:
  - `POST /api/auth/cx/start` (authenticated user kicks off SSO)
  - `GET /api/auth/cx/callback` (RC redirects here)
  - `POST /api/auth/cx/refresh` (manual refresh)
  - `GET /api/auth/cx/status` (own session status)
  - `POST /api/auth/cx/revoke` (clear own tokens)
- 3 admin-only endpoints:
  - `GET /api/admin/accounts/:id/cx-session` (view any agent's status)
  - `POST /api/admin/accounts/:id/cx-session/revoke`
  - `POST /api/admin/accounts/:id/cx-session/refresh`
  - `GET /api/admin/accounts/cx-oauth/status` (config check)
- 23 tests for crypto + PKCE math (all passing)

## What's NOT shipped here (deferred)

- The SPA "Connect RingCentral" UI button — frontend follow-up
- `ringcxVoiceClient` per-user bearer override — separate PR; `placeManualCall`
  currently still uses admin token scoped via `agentEmail` (works, but every
  call still attributes to admin in RingCX-side audit logs)
- Embedded RingCX softphone in the Parallel SPA — separate UX project

The infra is here; ringing the bell starts when the RC app config below is set.

## What you need to do (one-time RC app config)

The existing RC app uses the `RING_CENTRAL_*` env vars for **JWT-bearer auth**
(server-to-server). 3-legged OAuth needs additional config on the same RC app
or a new dedicated app. Either is fine.

### 1. Enable Auth Code (3-legged) on the RC app

Log into <https://developers.ringcentral.com/my-account.html> as the app owner.

- Open the RC app you're using for Parallel (the one whose `client_id` is in
  `RING_CENTRAL_CLIENT_ID`).
- **Auth → OAuth Settings**:
  - Add **"Authorization Code"** as an allowed grant type (alongside
    "JWT" which is already there).
  - Add a **redirect URI**: `https://tagcontactbridge.ngrok.app/api/auth/cx/callback`
    (or whatever your prod domain is).
- **Permissions / Scopes**: ensure the app requests at least:
  - `CXRouting` — **REQUIRED** for RingCX off-hook capability (agents
    can't dial out without this scope on the granted token). The most
    common silent failure mode is an agent's `cxAuth.scopes` going
    empty after a refresh — the code now preserves prior scopes when
    RC's refresh response omits `scope` (per RFC 6749 §6), and the
    authorize URL always requests CXRouting by default so consent
    grants reliably include it.
  - `ReadAccounts`
  - `ReadCallLog`
  - `ReadCallRecording`
  - `ReadPresence`
  - (Add others as needed; the SPA does not currently use any others.)

The agent's RingCentral role still needs to *allow* CXRouting — RC
silently drops any scope the role doesn't permit, so requesting it for
non-CX-eligible users does no harm but also doesn't grant them off-hook.
Verify in **RC Admin → Users → \<agent\> → Permissions** that the agent
has the **RingCX / CX Agent** application enabled.

### 2. Set env vars in `.env`

```
# RC OAuth (3-legged) — defaults to RING_CENTRAL_CLIENT_ID/SECRET if unset
RC_OAUTH_CLIENT_ID=               # optional override; falls back to RING_CENTRAL_CLIENT_ID
RC_OAUTH_CLIENT_SECRET=           # optional override; falls back to RING_CENTRAL_CLIENT_SECRET
RC_OAUTH_REDIRECT_URI=https://tagcontactbridge.ngrok.app/api/auth/cx/callback
RC_OAUTH_SCOPES=   # optional; leave blank to use the code default
                   # ("CXRouting ReadAccounts ReadCallLog ReadCallRecording ReadPresence").
                   # Only override if your RC app config blocks one of those.
RC_OAUTH_AUTHORIZE_URL=https://platform.ringcentral.com/restapi/oauth/authorize
RC_OAUTH_TOKEN_URL=https://platform.ringcentral.com/restapi/oauth/token

# Encryption key for stored tokens — generate via:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Must be exactly 64 hex chars (32 bytes). NEVER commit this; treat as
# secret on par with JWT_SECRET. Store in your secrets manager.
CX_TOKEN_ENCRYPTION_KEY=<64-hex-char-secret>
```

### 3. Bounce control-plane

```powershell
Restart-Service ParallelControlPlane -Force
```

The strict-mode validator will warn if `CX_TOKEN_ENCRYPTION_KEY` is missing
when `cxOAuthService.isConfigured()` is hit, but won't block boot — OAuth
is optional infrastructure.

### 4. Smoke test

```bash
# Confirm config loaded:
curl -H "Authorization: Bearer <admin-jwt>" \
  https://tagcontactbridge.ngrok.app/api/admin/accounts/cx-oauth/status

# Expected: { ok: true, config: { enabled: true, clientIdSet: true, ... } }

# Kick off SSO as an agent:
curl -X POST -H "Authorization: Bearer <agent-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"finalRedirectTo":"/cx"}' \
  https://tagcontactbridge.ngrok.app/api/auth/cx/start

# Expected: { ok: true, authorizeUrl: "https://login.ringcentral.com/...", state: "..." }

# Open authorizeUrl in a browser. Authorize. RC redirects to /api/auth/cx/callback
# which 302s to /cx?cxauth=ok. Confirm via:

curl -H "Authorization: Bearer <agent-jwt>" \
  https://tagcontactbridge.ngrok.app/api/auth/cx/status

# Expected: session.hasRcRefreshToken = true, session.rcUserEmail = agent's email
```

## Architecture summary

```
agent SPA                  Parallel BE                RingCentral             RingCX
   │                            │                          │                      │
1. │── POST /cx/start ─────────▶│                          │                      │
2. │                            │── createState(PKCE) ────▶ Mongo                  │
3. │◀── { authorizeUrl, state } │                          │                      │
4. │── window.location → RC ───▶│──────────────────────────▶│                      │
5. │                            │                          │ user logs in + auth  │
6. │                            │◀── 302 /cx/callback?code ─                       │
7. │                            │── POST /oauth/token ─────▶│                      │
8. │                            │◀── { access_token,        │                      │
9. │                            │      refresh_token } ─────                       │
10.│                            │── encrypt + store on UA   │                      │
11.│                            │── POST /api/auth/login/rc/accesstoken ──────────▶│
12.│                            │◀── { accessToken, refreshToken (rcx) } ──────────│
13.│                            │── encrypt + store on UA   │                      │
14.│                            │── consumeByState ──────▶ Mongo                  │
15.│◀── 302 /cx?cxauth=ok ──────│                          │                      │
16.│── (later) dial flow ──────▶│── decrypt agent's bearer  │                      │
17.│                            │── placeManualCall ────────────────────────────── ▶│
18.│                            │   (using agent's RingCX session)                 │
```

## Common tripping points

- **"redirect_uri_mismatch"** at step 7: the value in `.env` differs from what's
  registered on the RC app. They must match exactly, including trailing slash
  and protocol. `https://tagcontactbridge.ngrok.app/api/auth/cx/callback`
  is NOT the same as `https://tagcontactbridge.ngrok.app/api/auth/cx/callback/`.
- **"insufficient_scope"** at step 11: RC granted fewer scopes than RingCX
  needs. Re-check the scopes on the RC app — they must include presence + call log
  for the user-scoped exchange to succeed.
- **CX_TOKEN_ENCRYPTION_KEY rotation**: rotating this key invalidates all stored
  tokens (decrypt will throw). Mitigation: agents re-authorize via /cx/start
  on next dial. Plan key rotation for low-traffic windows.
- **State expired (10 min TTL)**: if the user takes too long at the RC consent
  screen, the state row TTLs out. They click "Connect" again, fresh state.
- **Admin token still works for service operations**: bootstrap/poller/cron
  flows continue using admin JWT. Only agent-initiated dials should use
  the per-user bearer (separate PR to wire that into ringcxVoiceClient).

## Security notes

- Refresh tokens encrypted at rest (AES-256-GCM, authenticated)
- Tokens never logged in plaintext
- PKCE prevents code-interception attacks even if the redirect is intercepted
- State token (32 bytes random) prevents CSRF
- TTL cleans up unused state automatically (Mongo TTL index)
- Admin-only revoke endpoint lets you kill an agent's CX session if needed
