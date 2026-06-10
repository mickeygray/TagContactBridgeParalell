"use strict";

// permissionsCatalog — single source of truth for permission keys and
// role-default mappings.
//
// Design:
//   - Permissions are dot-separated strings: "domain.action"
//   - Each user has a `role` (admin | manager | internal-agent | widget-user | service)
//     which carries a default permission set
//   - Each user can have additional `permissions[]` granted on top of
//     their role's defaults (additive — no concept of "explicit deny")
//   - Admin role is special: implicitly carries ALL permissions, no need
//     to enumerate
//
// Adding a new permission:
//   1. Add the key to PERMISSIONS_CATALOG below with description
//   2. Add it to the appropriate role default set in ROLE_DEFAULT_PERMISSIONS
//   3. Use `requirePermission("the.key")` middleware on the endpoint
//
// Adding a new role:
//   1. Update the UserAccount schema enum
//   2. Add it to ROLE_DEFAULT_PERMISSIONS with its default set
//
// IMPORTANT: This file must NOT depend on shared-services (avoid cycles).
// Pure catalog only. Middleware lives in shared-auth/src/index.js.

const PERMISSIONS_CATALOG = Object.freeze({
  // ── Pacing queue (admin panel + agent UI) ────────────────────
  "pacing.read": "View pacing config and hourly reports",
  "pacing.write": "Edit pacing config (slice size, hourly target, business hours)",
  "pacing.run": "Manually trigger hourly orchestrator / refill / morning prep",

  // ── Queue serving + dialing (the core agent workflow) ────────
  "queue.read": "View own slice + fresh assignments",
  "queue.dial": "Place outbound calls from queued items",
  "queue.dispose": "Record disposition on calls",
  "queue.seed-test": "Seed synthetic test queue items (admin debug)",

  // ── Agents ───────────────────────────────────────────────────
  "agents.read": "View agent roster + presence states",
  "agents.read-self": "View own agent state only",
  "agents.manage": "Create / edit / disable other agents",
  "agents.toggle-availability": "Toggle own unavailable/available state",
  "agents.toggle-others": "Toggle other agents' availability (manager)",

  // ── Calls + dispositions (history view) ──────────────────────
  "calls.read": "View call history",
  "calls.read-self": "View own call history only",
  "calls.recordings": "Listen to call recordings",

  // ── Cases / Logics ───────────────────────────────────────────
  "cases.read": "View Logics case profiles",
  "cases.write": "Edit Logics case profiles, create activities",
  "cases.dnc": "Mark cases DNC / suspend cadence",

  // Live coach
  "coach.view": "View live AI coach transcript and dialog for own calls",

  // ── Metrics + reporting ──────────────────────────────────────
  "metrics.read": "View dashboards + reports",
  "metrics.export": "Export reports as CSV / email",

  // ── Recordings ───────────────────────────────────────────────
  "recordings.archive": "Archive call recordings to drive",

  // ── Inbox / cadence (existing system) ────────────────────────
  "inbox.read": "View inbox items",
  "inbox.action": "Approve / cancel / DNC inbox workflows",

  // ── Admin / system ───────────────────────────────────────────
  "system.admin": "Full admin access (everything)",
  "system.deploy": "Trigger deploys",
  "system.feature-flags": "Toggle feature flags",
  "system.users": "Manage user accounts + permissions",
  "system.runtime": "View runtime health, watchdog state",
});

// Role → default permissions. Admins implicitly have ALL permissions
// (handled by hasPermission()) so this list is for clarity/audit only.
const ROLE_DEFAULT_PERMISSIONS = Object.freeze({
  admin: Object.freeze(Object.keys(PERMISSIONS_CATALOG)),

  // Manager: per-domain admin. Manage agents, see metrics, dispatch
  // pacing config, but not system-level settings.
  manager: Object.freeze([
    "pacing.read",
    "pacing.write",
    "pacing.run",
    "queue.read",
    "queue.dial",
    "queue.dispose",
    "agents.read",
    "agents.manage",
    "agents.toggle-availability",
    "agents.toggle-others",
    "calls.read",
    "calls.recordings",
    "cases.read",
    "cases.write",
    "cases.dnc",
    "coach.view",
    "metrics.read",
    "metrics.export",
    "recordings.archive",
    "inbox.read",
    "inbox.action",
    "system.runtime",
  ]),

  // Internal agent: work the queue, dispose calls, see own metrics.
  // No agent management, no admin features.
  "internal-agent": Object.freeze([
    "queue.read",
    "queue.dial",
    "queue.dispose",
    "agents.read-self",
    "agents.toggle-availability",
    "calls.read-self",
    "calls.recordings",
    "cases.read",
    "cases.write",
    "coach.view",
    "metrics.read",
    "inbox.read",
    "inbox.action",
  ]),

  // Widget user: external (e.g. partner portal). Minimal access.
  "widget-user": Object.freeze([
    "metrics.read",
  ]),

  // Service: internal API caller (cron, microservice). No UI permissions.
  // Service-secret middleware handles their access; this set is for
  // any service-as-user flows.
  service: Object.freeze([
    "system.runtime",
  ]),
});

// All known permission keys (frozen Set for fast membership)
const ALL_PERMISSIONS = new Set(Object.keys(PERMISSIONS_CATALOG));

// All known roles
const ALL_ROLES = new Set(Object.keys(ROLE_DEFAULT_PERMISSIONS));

function isKnownPermission(key) {
  return ALL_PERMISSIONS.has(String(key));
}

function isKnownRole(role) {
  return ALL_ROLES.has(String(role));
}

function getRoleDefaults(role) {
  return ROLE_DEFAULT_PERMISSIONS[role] || [];
}

// Compute the effective permission set for a user account.
// = role defaults ∪ user.permissions[]  (admin = all)
function effectivePermissionsFor(user) {
  if (!user) return [];
  if (user.role === "admin") return Array.from(ALL_PERMISSIONS);
  const fromRole = getRoleDefaults(user.role);
  const fromUser = Array.isArray(user.permissions) ? user.permissions : [];
  // Set-merge + preserve order (role first, then any new user grants)
  const seen = new Set();
  const out = [];
  for (const p of fromRole) {
    if (!seen.has(p) && isKnownPermission(p)) {
      seen.add(p); out.push(p);
    }
  }
  for (const p of fromUser) {
    if (!seen.has(p) && isKnownPermission(p)) {
      seen.add(p); out.push(p);
    }
  }
  return out;
}

// Boolean check: does this user have permission `key`?
function hasPermission(user, key) {
  if (!user || !key) return false;
  if (user.role === "admin") return ALL_PERMISSIONS.has(String(key));
  if (!isKnownPermission(key)) return false;
  const fromRole = getRoleDefaults(user.role);
  if (fromRole.includes(key)) return true;
  const fromUser = Array.isArray(user.permissions) ? user.permissions : [];
  return fromUser.includes(key);
}

// At least one of the given keys
function hasAnyPermission(user, keys = []) {
  return keys.some((k) => hasPermission(user, k));
}

// All of the given keys
function hasAllPermissions(user, keys = []) {
  return keys.every((k) => hasPermission(user, k));
}

// Validate a list of permission keys (filter to known + dedupe).
function normalizePermissionList(input = []) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const key = String(raw || "").trim();
    if (!key) continue;
    if (!isKnownPermission(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

module.exports = {
  PERMISSIONS_CATALOG,
  ROLE_DEFAULT_PERMISSIONS,
  ALL_PERMISSIONS,
  ALL_ROLES,
  isKnownPermission,
  isKnownRole,
  getRoleDefaults,
  effectivePermissionsFor,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  normalizePermissionList,
};
