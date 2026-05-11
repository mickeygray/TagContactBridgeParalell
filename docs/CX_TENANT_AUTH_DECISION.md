# CX Tenant Authorization Decision

**Status:** recommended baseline for server-side CX domain authorization

## Purpose

This note answers the open decision-gate question from the CX checklist:

- what should the server use as the source of truth for `user X may act in domain Y`

The goal is to choose the least disruptive path that is already supported by the current data model, so we can enforce server-side domain authorization without inventing a parallel identity system first.

## Recommended Source Of Truth

Use the current `UserAccount` record as the primary source:

1. `role === "admin"` or `role === "service"` bypasses tenant filtering
2. otherwise, allowed domains are:
   - `UserAccount.company`
   - every distinct `exShells[].company`

This produces a simple allowed-domain set such as:

- `["TAG"]`
- `["WYNN"]`
- `["TAG", "WYNN"]`

## Why This Is The Right First Move

The current schema already contains the fields we need:

- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-models\src\UserAccount.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-models\src\UserAccount.js)
  - `company`
  - `role`
  - `audience`
  - `exShells[].company`

Those values are already used by CX workspace context resolution in:

- [C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\cxWorkspaceService.js](C:\Users\Admin\Code\TagContactBridgeParallel\packages\shared-services\src\cxWorkspaceService.js)

So this choice:

- uses existing persisted data
- matches current operator/account modeling
- supports dual-company agents without waiting for SSO/IdP work
- avoids blocking the tenant wall on a future auth redesign

## Explicit Non-Goals

This decision does **not** try to solve:

- fine-grained per-route capability authorization
- Logics permission scoping
- IdP claim mapping
- "temporary delegated access" workflows

Those can still be layered later.

## Enforcement Rule

For a requested CX domain:

1. normalize requested domain to uppercase
2. resolve the authenticated `UserAccount`
3. if user role is `admin` or `service`, allow
4. otherwise compute:
   - `allowedDomains = Set([account.company, ...account.exShells[].company])`
5. if requested domain is not in `allowedDomains`, reject with `403`

## Behavior Examples

### Standard TAG agent

- `company = "TAG"`
- `exShells = [{ company: "TAG" }]`

Allowed domains:

- `TAG`

Blocked:

- `WYNN`
- `AMITY`

### Cross-domain agent

- `company = "TAG"`
- `exShells = [{ company: "TAG" }, { company: "WYNN" }]`

Allowed domains:

- `TAG`
- `WYNN`

### Admin

- `role = "admin"`

Allowed domains:

- all

## Suggested Implementation Scope

Apply the check to:

- CX read routes
- CX command routes
- 6101 internal serving routes only when the caller is a user-context request

Do **not** apply the same restriction to:

- internal service-secret traffic
- service-to-service jobs running as `role = "service"`

## Future Upgrade Path

If we later need a stronger model, add:

- `UserAccount.allowedDomains: string[]`

and make enforcement:

1. `allowedDomains` when present
2. fallback to `company + exShells[].company`

That gives us a forward-compatible path without breaking the current baseline.
