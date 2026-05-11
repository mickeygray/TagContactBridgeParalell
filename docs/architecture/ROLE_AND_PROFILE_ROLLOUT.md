# Role & Profile Rollout

**Status:** planning. Treated as a peer workstream to `PARALLEL_PRODUCTION_DEPLOYMENT.md`. Standing the app up on NSSM + nginx is the easy half — wiring authorization through queues, dispositions, dispatch, and per-tenant data is the harder half, and it's been under-represented in earlier passes.

The premise: the frontend already speaks the language of roles, capabilities, and views. The server speaks `requireAuth` (signed-in or not) and an inline `req.user.role !== "admin"` check in two places. Everything in between — "this CX agent should only see their own queue claims," "only internal-agents and admins can disposition a case," "widget-users get nothing past `/me`" — is currently enforced (if at all) only by what the SPA chooses to render. That's not a posture we can ship to non-employees on, and it's the gap we're closing here.

## Today — what exists

### Token + identity

`packages/shared-auth/src/index.js` `issueLoginToken` packs into the JWT:

- `id`, `email`, `name`
- `role` — one of `admin`, `internal-agent`, `widget-user`, `service`
- `audience` — coarser grouping (e.g. `internal`, `widget`)
- `capabilities` — array of capability strings the UI uses to render/hide features
- `views` — array of route surfaces the SPA exposes
- `workspace`, `stationLabel`, `company`
- Identity hooks for telephony + Logics: `extensionId`, `extensionNumber`, `cxAgentId`, `phone`
- Per-tenant Logics: `tagLogicsId`/`tagEmail`/…, `wynnLogicsId`/`wynnEmail`/… (the user can have separate identities under TAG vs Wynn — see `project_tcb_logics_dual_tenant`)
- `logicsAuth.{credentialMode, credentialStatus, scopes, permissionsLabel}` — status only, never credential material

The token TTL defaults to 12 hours (`config.jwtTtlHours`). Bearer-style — UI puts it in `Authorization: Bearer …`, nginx forwards it on protected routes.

### Server-side enforcement

Two primitives, both in `packages/shared-auth/src/index.js`:

```js
function requireAuth(config) { /* verifies bearer; sets req.user */ }
function requireRole(role)   { /* req.user?.role !== role -> 403 */ }
```

`requireRole` is single-argument: it can't express "internal-agent OR admin" today, which is the most common gate the operator app needs. Two consumers in the wild:

1. `apps/control-plane/src/routes/auth.js:144` — `/api/auth/accounts` does an **inline** `req.user?.role !== "admin"` check rather than calling `requireRole`. Pure inertia.
2. Most other routes use `requireAuth(config)` only and trust the SPA to gate.

### Frontend role surface

The SPA already consumes `capabilities` + `views` from `/api/auth/me` and renders accordingly — admin-only menu items, CX-agent-only buttons, etc. This is fine as a UX layer. **It is not a security boundary.** Anyone with a valid JWT can hit any non-admin-gated `/api/*` route directly via curl right now.

### Per-user data hooks already in place

We've been good about *recording* the actor on writes — most route handlers stamp `req.user.email` or `req.user.id` into the audit fields. We have NOT been consistent about *filtering* reads by actor. Concretely:

- **CX dial queue** (`apps/ringcentral-cx`): each queue row has `assignment.extensionId` indicating which agent owns it. The list endpoint returns *all* rows, and the SPA filters client-side. An internal-agent can call the unfiltered endpoint and see everyone's pipeline.
- **Dispatch** (`apps/control-plane/src/routes/dispatch.js`): same shape — items have an owning extension/agent, but the list isn't server-filtered.
- **Inbox / read.js / readClients.js**: ditto — workspace scoping happens but per-agent doesn't.

This is the "profile ingestion" problem: the user's identity (extensionId / cxAgentId / Logics ID per tenant) is in the token; we just need the read paths to pivot off it.

### nginx auth gate gap (real bug to fix during this pass)

`ops/nginx/parallel.conf:76` does:

```nginx
location = /auth-check {
    internal;
    proxy_pass http://parallel_cp/api/auth/check;
    ...
}
```

`apps/control-plane/src/routes/auth.js` has no `/check` route. The subrequest will 404 on every protected hit, the `auth_request` directive will treat that as "not authenticated," and the `error_page 401 = @login_redirect` will bounce everyone to `/login`. Either:

- **(A)** Add `GET /api/auth/check` that runs `requireAuth(config)` and returns `204 No Content` on success / `401` on failure (no body either way — nginx only cares about the status code), OR
- **(B)** Repoint nginx at `/api/auth/me` (which already runs `requireAuth`).

Recommend (A): `/me` returns a meaningful body and shouldn't be issued on every request when only the status code matters. `/check` is the conventional name for a subrequest target.

## Target — what "rolled out" looks like

Three layers, ordered cheapest → most invasive:

### Layer 1 — Multi-role gate

Replace the single-arg `requireRole(role)` with a variadic `requireRole(...roles)` so handlers can write the natural thing:

```js
// admin-only
router.post("/deploy", requireAuth(cfg), requireRole("admin"), handler);

// admin OR internal-agent
router.get("/cx/queue", requireAuth(cfg), requireRole("admin", "internal-agent"), handler);
```

Backwards-compatible with the one current call site. Add a small `requireCapability(...caps)` next to it for cases where role is too coarse (e.g. "deploy" vs "blogger-admin" vs "scrub-runs" all live under `admin`).

### Layer 2 — Per-route audit + apply

A pass through every route file in `apps/control-plane/src/routes/` and the gateway apps, tagging each with a role/capability requirement. Concrete classification:

| Surface | Files | Required role |
|---|---|---|
| OTP login flow | `auth.js` send/verify/logout | public |
| Auth introspection | `auth.js` me/check/views/workspace | `requireAuth` only |
| Account admin | `auth.js` accounts, `adminAccounts.js` | `admin` |
| Deploy | `commandsDeploy.js`, `readDeploy.js` | `admin` |
| Blogger admin views | (planned) | `admin` |
| Scrub / hygiene runs | `hygiene.js` | `admin` |
| CX agent surfaces | `commandsCx.js`, `readCx.js` | `admin`, `internal-agent` |
| Dispatch | `dispatch.js` | `admin`, `internal-agent` |
| Inbox / library / metrics / clients / workspace | `commandsInbox.js`, `readInbox.js`, `readLibrary.js`, `readMetrics.js`, `readClients.js`, `commandsClients.js`, `readWorkspace.js`, `metrics.js` | `admin`, `internal-agent` |
| Drop / events / domains / drop targets | `drop.js`, `events.js`, `domains.js` | `admin`, `internal-agent` |
| RingCentral admin (extensions, CallRail config) | `ringcentral.js`, `readRingcentral.js`, `callrail.js` | `admin` |
| Recording playback | `recordingPlayback.js` | public (HMAC-gated) |
| Lexis / NCOA upload | `lexis.js` | `admin` (data-touching, big file) |
| Logics passthrough | `logics.js` | `admin`, `internal-agent` |
| Read-only review feeds | `readReview.js`, `readSchedules.js` | `admin`, `internal-agent` |
| Webhook receivers (inbound/outbound/cx gateways) | the gateway apps | public, app-layer signature verify |

Audit each file; add `requireRole(...)` next to each existing `requireAuth(...)`. Capability gates layered on for the granular admin-side splits.

The point of the audit isn't just to add middleware — it's to find the surfaces we *thought* were admin-only but actually trust the SPA to hide.

### Layer 3 — Profile-scoped reads

This is the under-represented half. The data model already binds work items to users; the read paths just need to honor the binding.

**CX dial queue scoping.** Today: every signed-in caller gets every row. Target: agents see (a) rows assigned to their `extensionId`/`cxAgentId` plus (b) the unassigned pool. Admins see all rows. Concretely in `apps/ringcentral-cx/src/server.js` queue list endpoint(s):

```js
function scopeQueueRowsForUser(user, rows) {
  if (user.role === "admin") return rows;
  const myExt = user.extensionId;
  const myAgent = user.cxAgentId;
  return rows.filter((r) =>
    !r.assignment ||
    r.assignment.extensionId === myExt ||
    r.assignment.cxAgentId === myAgent
  );
}
```

Same shape applies to dispatch lists, claim/release endpoints, and the disposition write path (only the owning agent or an admin can disposition).

**Per-action audit fields.** Make sure every write through `commandsCx.js`, `commandsClients.js`, `commandsInbox.js`, `dispatch.js` records:

- `actedBy.userId`, `actedBy.email`, `actedBy.role`
- `actedBy.extensionId` / `actedBy.cxAgentId` when telephony-relevant
- `actedAt` ISO timestamp

Most write handlers stamp `req.user.email`; the goal is to make this a single shared helper (`buildAuditedActor(req.user)`) and make sure every command goes through it. Then "show me everything Heather did yesterday" is a one-shot query rather than an archaeological dig.

**Tenant scoping (TAG vs Wynn).** Deferred-but-on-deck. The user already has `tagLogicsId` and `wynnLogicsId` separately in the token, and the phone-lookup at call time resolves which tenant a case belongs to. The remaining work is making sure list endpoints honor the resolved tenant — an internal-agent acting on a TAG case shouldn't see Wynn fields and vice versa. Capture this as a follow-on once Layer 1+2 are in.

## Sequencing

Recommend landing in four small PRs rather than one giant one. The auth surface is everywhere — granular PRs make `git bisect` on a regression actually useful.

1. **PR 1 — `shared-auth` plumbing** (small, mostly mechanical)
   - Variadic `requireRole(...roles)`
   - New `requireCapability(...caps)`
   - New `GET /api/auth/check` endpoint (closes the nginx subrequest 404 gap above)
   - Replace the one inline `req.user?.role !== "admin"` in `auth.js:144` with `requireRole("admin")`
   - Tests: unit test the middleware directly + an integration test against `/api/auth/accounts` confirming the 403 path.

2. **PR 2 — Route audit application** (medium, touches many files)
   - Add `requireRole(...)` to every route per the table above
   - Add a `# Auth posture` block at the top of each route file noting which roles + capabilities the file requires (so future readers don't have to grep middleware to know who can call this)
   - Tests: a router-level integration test that walks every route and asserts a `widget-user` token gets 403 on operator surfaces

3. **PR 3 — Queue & dispatch read scoping**
   - `scopeQueueRowsForUser` helper in `shared-auth` (or a `shared-authz` package if it grows)
   - Apply to CX queue list endpoint(s), dispatch list, inbox per-agent reads
   - Tests: integration tests covering admin-sees-all vs internal-agent-sees-only-mine vs unassigned-pool-visible-to-everyone
   - Frontend: confirm the SPA's existing client-side filter still works as a no-op once the server filters

4. **PR 4 — Audited-actor helper + per-action fields**
   - `buildAuditedActor(req.user)` helper
   - Replace ad-hoc `req.user.email` stamps in every command handler
   - Backfill schema where actor field shape differs across tables (one-time migration)
   - Tests: command-level — confirm every write produces `{ actedBy, actedAt }`

5. **(Deferred) PR 5 — Tenant scoping**
   - Resolve tenant from case/queue context, narrow the user identity slice on the response
   - Defer until 1–4 are stable; this is the fiddliest because tenant is data-driven not user-driven.

## Operational notes

- Real OTP delivery (`AUTH_OTP_PREVIEW=false`) lands as part of `PARALLEL_PRODUCTION_DEPLOYMENT.md` Phase 3, not here. They're independent: role gating is enforced regardless of how the OTP arrives.
- The JWT TTL of 12h is fine for internal-agent use. Once we expose `widget-user` to non-employees, drop their TTL to ~1h via a per-role override in `issueLoginToken`. Hold off until that audience is real.
- Audit logging volume will jump once Layer 3 lands. Make sure the audit sink (Drive folder, SQL table, whatever the canonical store is for action logs) can absorb the volume — quick stress test before PR 4 ships.

## Out of scope

- SSO / SAML / OAuth — JWT bearer is sufficient for the population we have.
- Per-document ACLs (e.g. "Heather can see *this* case but not *that* one inside her assigned queue") — every queue item already implicitly belongs to one agent, and admins see all; we don't need finer-grained ACLs yet.
- Refresh tokens — not worth the complexity until we have a clear UX driver. JWT TTL extension via re-login covers the current use case.
