"use strict";

const express = require("express");
const {
  agentStateRepository,
  userAccountRepository,
} = require("../../../../packages/shared-repositories/src");
const {
  decorateAccountRecord,
  HARDENED_USERS,
  SEED_ADMINS,
} = require("../../../../packages/shared-data/src/accounts");
const {
  syncUsersFromRcExtensions,
} = require("../../../../packages/shared-services/src");
const {
  deriveFreshLeadGate,
} = require("../../../../packages/shared-services/src/agentAvailabilityService");
const {
  PERMISSIONS_CATALOG,
  ROLE_DEFAULT_PERMISSIONS,
  ALL_ROLES,
  isKnownRole,
  effectivePermissionsFor,
  normalizePermissionList,
} = require("../../../../packages/shared-auth/src");
const cxTokenStorageService = require("../../../../packages/shared-services/src/cxTokenStorageService");
const cxOAuthService = require("../../../../packages/shared-services/src/cxOAuthService");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

const SEED_ADMIN_EMAILS = new Set(SEED_ADMINS.map((seed) => seed.email.toLowerCase()));
const HARDENED_USER_RULES = new Map(
  HARDENED_USERS.map((seed) => [seed.email.toLowerCase(), seed]),
);
const HARDENED_USER_EMAILS = new Set(HARDENED_USER_RULES.keys());
const HARDENED_ACCOUNT_EMAILS = new Set([
  ...SEED_ADMIN_EMAILS,
  ...HARDENED_USER_EMAILS,
]);

function decorate(record) {
  if (!record) return null;
  return {
    ...decorateAccountRecord(record),
    isSeed: SEED_ADMIN_EMAILS.has(String(record.email).toLowerCase()),
    isHardened: HARDENED_ACCOUNT_EMAILS.has(String(record.email).toLowerCase()),
  };
}

function summarizeAgentState(agentState) {
  if (!agentState) return null;
  return {
    status: agentState.status || null,
    exPresenceStatus: agentState.exPresenceStatus || null,
    exTelephonyStatus: agentState.exTelephonyStatus || null,
    cxRouting: agentState.cxRouting || null,
    freshLeadGate: deriveFreshLeadGate(agentState, agentState.cxRouting || null),
    currentCall: agentState.currentCall || null,
    lastStatusChange: agentState.lastStatusChange || null,
    lastEventReceived: agentState.lastEventReceived || null,
    dailyStats: agentState.dailyStats || null,
    activePlatform: agentState.activePlatform || null,
  };
}

function attachAgentState(record, agentStateByExtensionId) {
  const decorated = decorate(record);
  if (!decorated) return null;
  const extensionId = String(record.extensionId || "").trim();
  return {
    ...decorated,
    agentState: extensionId
      ? summarizeAgentState(agentStateByExtensionId.get(extensionId) || null)
      : null,
  };
}

// Admin-writable subset of `logicsAuth`. Hashes and the activation/rotation
// timestamps are system-managed — they update as a side-effect of the
// rotate flow, never directly via the admin PUT. Exposed here: the knobs
// an admin needs to grant, revoke, or scope per-agent Logics access.
const LOGICS_AUTH_WRITABLE = new Set([
  "credentialMode",
  "credentialStatus",
  "scopes",
  "permissionsLabel",
  "externalSecretRef",
]);

function sanitizeLogicsAuth(input) {
  if (input == null || typeof input !== "object") return undefined;
  const out = {};
  for (const key of Object.keys(input)) {
    if (LOGICS_AUTH_WRITABLE.has(key)) out[key] = input[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizePatch(body = {}) {
  const patch = {};
  const fields = [
    "name",
    "role",
    "audience",
    "workspace",
    "stationLabel",
    "company",
    "extensionId",
    "extensionNumber",
    "cxAgentId",
    "phone",
    "cxQueuePolicy",
    "exShells",
    "status",
    "metadata",
    "logicsUserId",
    "logicsDisplayName",
    "tagLogicsId",
    "tagSOId",
    "tagEmail",
    "tagLogicsName",
    "tagLogicsRoles",
    "wynnLogicsId",
    "wynnSOId",
    "wynnEmail",
    "wynnLogicsName",
    "wynnLogicsRoles",
  ];
  for (const key of fields) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (body.logicsAuth !== undefined) {
    const safe = sanitizeLogicsAuth(body.logicsAuth);
    if (safe) patch.logicsAuth = safe;
  }
  return patch;
}

function createAdminAccountsRouter(auth) {
  const router = express.Router();

  router.get("/", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const [accounts, agentStates] = await Promise.all([
        userAccountRepository.listUserAccounts({
          status: req.query.status,
          role: req.query.role,
          audience: req.query.audience,
          company: req.query.company,
          search: req.query.search,
          limit: req.query.limit,
        }),
        agentStateRepository.listAgentStates(
          req.query.company ? { company: req.query.company } : {},
        ),
      ]);
      const agentStateByExtensionId = new Map(
        agentStates.map((agent) => [String(agent.extensionId || ""), agent]),
      );
      return res.json({
        ok: true,
        accounts: accounts.map((account) => attachAgentState(account, agentStateByExtensionId)),
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get(
    "/unassigned-extensions",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const filters = {};
        if (req.query.company) filters.company = req.query.company;

        const [agents, accounts] = await Promise.all([
          agentStateRepository.listAgentStates(filters),
          userAccountRepository.listUserAccounts({ limit: 1000 }),
        ]);

        const assigned = new Set(
          accounts
            .map((account) => account.extensionId)
            .filter((value) => value != null && value !== ""),
        );

        const unassigned = agents
          .filter((agent) => !assigned.has(String(agent.extensionId)))
          .map((agent) => ({
            extensionId: String(agent.extensionId),
            name: agent.name || null,
            company: agent.company || null,
            cxAgentId: agent.cxAgentId || null,
            status: agent.status || null,
            exPresenceStatus: agent.exPresenceStatus || null,
            lastStatusChange: agent.lastStatusChange || null,
            lastEventReceived: agent.lastEventReceived || null,
          }));

        return res.json({ ok: true, extensions: unassigned });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get("/:id", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const record = await userAccountRepository.findUserAccountById(req.params.id);
      if (!record) {
        return res.status(404).json({ ok: false, error: "Account not found" });
      }
      const agentState = record.extensionId
        ? await agentStateRepository.findAgentStateByExtensionId(record.extensionId)
        : null;
      return res.json({
        ok: true,
        account: {
          ...decorate(record),
          agentState: summarizeAgentState(agentState),
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      // Accept the same field surface as PUT so the admin can populate
      // tenant-prefixed Logics identities (tag*, wynn*), extensionNumber,
      // and logicsAuth credential state at create time.
      const fields = sanitizePatch(body);
      if (fields.cxQueuePolicy) {
        fields.cxQueuePolicy = {
          ...fields.cxQueuePolicy,
          updatedAt: new Date(),
          updatedBy: req.user?.email || null,
        };
      }
      const record = await userAccountRepository.createUserAccount({
        email: body.email,
        ...fields,
        status: body.status || "invited",
        source: "manual",
        metadata: {
          ...(fields.metadata || {}),
          createdBy: req.user?.email || null,
        },
      });
      return res.status(201).json({ ok: true, account: decorate(record) });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.put("/:id", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const current = await userAccountRepository.findUserAccountById(req.params.id);
      if (!current) {
        return res.status(404).json({ ok: false, error: "Account not found" });
      }

      const patch = sanitizePatch(req.body || {});
      if (patch.cxQueuePolicy) {
        patch.cxQueuePolicy = {
          ...patch.cxQueuePolicy,
          updatedAt: new Date(),
          updatedBy: req.user?.email || null,
        };
      }

      // Seed admins can be edited but cannot have role/audience demoted or
      // email reassigned — keep the hard-coded guarantees predictable.
      if (SEED_ADMIN_EMAILS.has(current.email)) {
        patch.role = "admin";
        patch.audience = "admin";
      } else {
        const hardenedUser = HARDENED_USER_RULES.get(String(current.email || "").toLowerCase());
        if (hardenedUser) {
          patch.role = hardenedUser.role;
          patch.audience = hardenedUser.audience;
          patch.company = hardenedUser.company;
          patch.workspace = hardenedUser.workspace;
        }
      }

      const record = await userAccountRepository.updateUserAccount(req.params.id, patch);
      return res.json({ ok: true, account: decorate(record) });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post(
    "/:id/disable",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const current = await userAccountRepository.findUserAccountById(req.params.id);
        if (!current) {
          return res.status(404).json({ ok: false, error: "Account not found" });
        }
        if (HARDENED_ACCOUNT_EMAILS.has(String(current.email || "").toLowerCase())) {
          return res
            .status(400)
            .json({ ok: false, error: "Hard-coded accounts cannot be disabled" });
        }
        const record = await userAccountRepository.updateUserAccount(req.params.id, {
          status: "disabled",
        });
        return res.json({ ok: true, account: decorate(record) });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/:id/enable",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const record = await userAccountRepository.updateUserAccount(req.params.id, {
          status: "active",
        });
        return res.json({ ok: true, account: decorate(record) });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * Consolidate RingCentral extensions → UserAccount, keyed by email.
   * Creates new accounts for RC Users not yet in Parallel (status=invited,
   * role=internal-agent, source=rc-poll), refreshes extensionId/name/cxAgentId
   * on existing accounts without trampling operator-edited fields, and
   * demotes accounts whose RC extension has gone Disabled or disappeared.
   * Seed admins are exempt.
   *
   * Body: { dryRun?: boolean }
   */
  router.post(
    "/sync-from-rc",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const dryRun = Boolean(req.body?.dryRun ?? req.query.dryRun === "true");
        const result = await syncUsersFromRcExtensions({ dryRun });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * GET /api/admin/accounts/permissions/catalog
   * Returns the full permission catalog + role-default mapping. Used by
   * the SPA admin panel to render permission-grant UI.
   */
  router.get(
    "/permissions/catalog",
    auth.requireAuth,
    auth.requireAdmin,
    (_req, res) => {
      res.json({
        ok: true,
        catalog: PERMISSIONS_CATALOG,
        roleDefaults: ROLE_DEFAULT_PERMISSIONS,
        roles: Array.from(ALL_ROLES),
      });
    },
  );

  /**
   * GET /api/admin/accounts/:id/permissions
   * Returns role + extra grants + effective permissions for one user.
   */
  router.get(
    "/:id/permissions",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const record = await userAccountRepository.findUserAccountById(req.params.id);
        if (!record) return res.status(404).json({ ok: false, error: "Account not found" });
        return res.json({
          ok: true,
          accountId: String(record._id || record.id),
          email: record.email,
          role: record.role,
          permissions: record.permissions || [],
          permissionsUpdatedAt: record.permissionsUpdatedAt || null,
          permissionsUpdatedBy: record.permissionsUpdatedBy || null,
          effective: effectivePermissionsFor(record),
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * PUT /api/admin/accounts/:id/permissions
   * Body: { permissions: [string, ...], role?: string }
   * Sets the additive permissions list (replaces, doesn't merge). Optional
   * role change. Validates against the catalog and known roles.
   * Hardened seed accounts are protected from role downgrades.
   */
  router.put(
    "/:id/permissions",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const record = await userAccountRepository.findUserAccountById(req.params.id);
        if (!record) return res.status(404).json({ ok: false, error: "Account not found" });

        const requested = req.body?.permissions;
        const newRole = req.body?.role ? String(req.body.role).trim() : null;

        const update = {
          permissionsUpdatedAt: new Date(),
          permissionsUpdatedBy: req.user?.email || req.user?.id || "internal",
        };

        if (Array.isArray(requested)) {
          update.permissions = normalizePermissionList(requested);
          // Surface unknown keys to the caller so they know the request was filtered
          const unknown = requested
            .map((k) => String(k).trim())
            .filter((k) => k && !update.permissions.includes(k));
          if (unknown.length) update.unknownPermissionsIgnored = unknown;
        }

        if (newRole) {
          if (!isKnownRole(newRole)) {
            return res.status(400).json({ ok: false, error: `unknown-role:${newRole}` });
          }
          // Protect seed admins from accidental role downgrade.
          if (
            SEED_ADMIN_EMAILS.has(String(record.email).toLowerCase())
            && record.role === "admin"
            && newRole !== "admin"
          ) {
            return res.status(403).json({
              ok: false,
              error: "cannot downgrade seed admin role",
            });
          }
          update.role = newRole;
        }

        const persisted = await userAccountRepository.updateUserAccount(
          record._id || record.id,
          update,
        );
        return res.json({
          ok: true,
          account: decorate(persisted),
          effective: effectivePermissionsFor(persisted),
          unknownPermissionsIgnored: update.unknownPermissionsIgnored || [],
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * GET /api/admin/accounts/:id/cx-session
   * Read-only summary of an agent's CX (RingCX) authentication state.
   * No plaintext tokens — just metadata for admin observability.
   */
  router.get(
    "/:id/cx-session",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const record = await userAccountRepository.findUserAccountById(req.params.id);
        if (!record) return res.status(404).json({ ok: false, error: "Account not found" });
        const desc = await cxTokenStorageService.describe(req.params.id);
        return res.json({ ok: true, accountId: req.params.id, email: record.email, session: desc });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * POST /api/admin/accounts/:id/cx-session/revoke
   * Clear an agent's stored CX tokens. Forces them to re-authorize via
   * /api/auth/cx/start on next dial attempt.
   */
  router.post(
    "/:id/cx-session/revoke",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const record = await userAccountRepository.findUserAccountById(req.params.id);
        if (!record) return res.status(404).json({ ok: false, error: "Account not found" });
        await cxTokenStorageService.revoke(req.params.id);
        return res.json({ ok: true });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * POST /api/admin/accounts/:id/cx-session/refresh
   * Manually trigger a token refresh for an agent (admin-side debugging).
   */
  router.post(
    "/:id/cx-session/refresh",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const record = await userAccountRepository.findUserAccountById(req.params.id);
        if (!record) return res.status(404).json({ ok: false, error: "Account not found" });
        const result = await cxOAuthService.refreshUserSession({ userId: req.params.id });
        return res.json(result);
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * GET /api/admin/cx-oauth/status
   * Check the OAuth configuration is present (no secrets returned).
   */
  router.get(
    "/cx-oauth/status",
    auth.requireAuth,
    auth.requireAdmin,
    (_req, res) => {
      res.json({ ok: true, config: cxOAuthService.describeConfig() });
    },
  );

  return router;
}

module.exports = {
  createAdminAccountsRouter,
};
