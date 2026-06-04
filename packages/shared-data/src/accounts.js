"use strict";

const { AUDIENCES, ROLES } = require("../../shared-types/src");
const { env } = require("../../shared-config/src/env");
const {
  findUserAccountByEmail,
  listUserAccounts,
  upsertUserAccount,
} = require("../../shared-repositories/src/userAccountRepository");

const INTERNAL_AGENT_CAPABILITIES = Object.freeze([
  "services.read",
  "contacts.read",
  "contacts.message",
  "contacts.email",
  "contacts.dial",
  "contacts.status",
  "ring.workspace",
]);

const WIDGET_USER_CAPABILITIES = Object.freeze([
  "ring.workspace",
  "contacts.read",
  "contacts.message",
  "contacts.email",
  "contacts.dial",
  "contacts.status",
]);

function unique(items = []) {
  return Array.from(new Set(items.filter(Boolean)));
}

const ROLE_CAPABILITIES = Object.freeze({
  [ROLES.ADMIN]: unique([
    ...INTERNAL_AGENT_CAPABILITIES,
    ...WIDGET_USER_CAPABILITIES,
    "events.read",
    "events.replay",
    "services.read",
    "accounts.read",
    "accounts.manage",
    "contacts.launch",
    "metrics.read",
  ]),
  [ROLES.INTERNAL_AGENT]: [...INTERNAL_AGENT_CAPABILITIES],
  [ROLES.WIDGET_USER]: [...WIDGET_USER_CAPABILITIES],
  [ROLES.SERVICE]: ["events.process"],
});

const ROLE_VIEWS = Object.freeze({
  [ROLES.ADMIN]: ["admin", "user", "agent"],
  [ROLES.INTERNAL_AGENT]: ["user", "agent"],
  [ROLES.WIDGET_USER]: ["user"],
  [ROLES.SERVICE]: ["service"],
});

function buildFreshPriorityCxQueuePolicy() {
  return {
    tier: "fresh_priority",
    enabled: true,
    fresh: {
      eligible: true,
      firstTouchEligible: true,
      targetOpen: 15,
      priorityWeight: 100,
    },
    day2to15: { targetOpen: 15 },
    day16to30: { targetOpen: 5 },
    aged: { targetOpen: 5 },
  };
}

/**
 * Seed admins are bootstrapped on startup and cannot be deleted through the
 * normal admin UI. They can still be edited (name, extensionId) via the
 * admin/accounts routes — just not demoted past admin.
 */
const SEED_ADMINS = Object.freeze([
  {
    email: "mgray@taxadvocategroup.com",
    name: "Mickey Gray",
    role: ROLES.ADMIN,
    audience: AUDIENCES.ADMIN,
    company: "TAG",
    workspace: "general",
  },
  {
    email: "manderson@taxadvocategroup.com",
    name: "M. Anderson",
    role: ROLES.ADMIN,
    audience: AUDIENCES.ADMIN,
    company: "TAG",
    workspace: "general",
  },
  {
    email: "abanks@taxadvocategroup.com",
    name: "Alexander Banks",
    role: ROLES.ADMIN,
    audience: AUDIENCES.ADMIN,
    company: "TAG",
    workspace: "general",
  },
]);

/**
 * Baseline internal agents that should always exist with user-shell access.
 *
 * These are the current live CX-capable operators. We harden them the same
 * way we harden seed admins, except their access profile remains
 * `internal-agent` + `audience=user`.
 */
const HARDENED_USERS = Object.freeze([
  {
    email: "acalloway@taxadvocategroup.com",
    name: "Anthony Calloway",
    role: ROLES.INTERNAL_AGENT,
    audience: AUDIENCES.USER,
    company: "TAG",
    workspace: "general",
  },
  {
    email: "ballen@taxadvocategroup.com",
    name: "Bruce Allen",
    role: ROLES.INTERNAL_AGENT,
    audience: AUDIENCES.USER,
    company: "TAG",
    workspace: "general",
  },
  {
    email: "polson@taxadvocategroup.com",
    name: "Phil Olson",
    role: ROLES.INTERNAL_AGENT,
    audience: AUDIENCES.USER,
    company: "TAG",
    workspace: "general",
  },
  {
    email: "slucas@taxadvocategroup.com",
    name: "Sean Lucas",
    role: ROLES.INTERNAL_AGENT,
    audience: AUDIENCES.USER,
    company: "TAG",
    workspace: "general",
  },
  {
    email: "cbolt@taxadvocategroup.com",
    name: "Chris Bolt",
    role: ROLES.INTERNAL_AGENT,
    audience: AUDIENCES.USER,
    company: "TAG",
    workspace: "general",
    extensionId: "63914586004",
    extensionNumber: "741",
    cxAgentId: "21810",
    cxQueuePolicy: buildFreshPriorityCxQueuePolicy(),
  },
  {
    email: "bhansen@taxadvocategroup.com",
    name: "Brad Hansen",
    role: ROLES.INTERNAL_AGENT,
    audience: AUDIENCES.USER,
    company: "TAG",
    workspace: "general",
    extensionId: "63914587004",
    extensionNumber: "742",
    cxAgentId: "21812",
    cxQueuePolicy: buildFreshPriorityCxQueuePolicy(),
  },
]);

const SEED_ADMIN_EMAILS = new Set(SEED_ADMINS.map((seed) => seed.email.toLowerCase()));
const HARDENED_USER_EMAILS = new Set(
  HARDENED_USERS.map((seed) => seed.email.toLowerCase()),
);
const HARDENED_ACCOUNT_EMAILS = new Set([
  ...SEED_ADMIN_EMAILS,
  ...HARDENED_USER_EMAILS,
]);

/**
 * Optional service principal, configurable via env. Used internally for
 * service-to-service event intake.
 */
function buildServiceSeed() {
  return {
    email: String(
      env("PARALLEL_SERVICE_EMAIL", "service@taxadvocategroup.com"),
    ).toLowerCase(),
    name: env("PARALLEL_SERVICE_NAME", "Control Plane Service"),
    role: ROLES.SERVICE,
    audience: AUDIENCES.ADMIN,
    workspace: env("PARALLEL_SERVICE_WORKSPACE", "control-plane"),
    company: env("PARALLEL_SERVICE_COMPANY", "TAG"),
  };
}

/**
 * Strip sensitive subfields from `logicsAuth` before returning the
 * record to any API consumer. Hashes and rotation timestamps are
 * audit-only and must never cross the network even to authenticated
 * admins — rotation happens via a dedicated `/rotate` flow that
 * accepts the new credential inline.
 *
 * Preserved: credentialMode, credentialStatus, scopes, permissionsLabel,
 * externalSecretRef (the *reference*, not the secret itself), and the
 * `last4` tails so admins have a visual "which key is installed" cue.
 */
function sanitizeLogicsAuthForResponse(logicsAuth) {
  if (!logicsAuth || typeof logicsAuth !== "object") return null;
  return {
    credentialMode: logicsAuth.credentialMode || "company",
    credentialStatus: logicsAuth.credentialStatus || "pending",
    scopes: Array.isArray(logicsAuth.scopes) ? logicsAuth.scopes : [],
    permissionsLabel: logicsAuth.permissionsLabel || null,
    externalSecretRef: logicsAuth.externalSecretRef || null,
    apiKeyLast4: logicsAuth.apiKeyLast4 || null,
    secretLast4: logicsAuth.secretLast4 || null,
    activatedAt: logicsAuth.activatedAt || null,
    rotatedAt: logicsAuth.rotatedAt || null,
    lastValidatedAt: logicsAuth.lastValidatedAt || null,
  };
}

function decorateAccountRecord(record) {
  if (!record) return null;
  const {
    cxAuth,
    cxSession,
    ...safeRecord
  } = record;
  const role = record.role || ROLES.WIDGET_USER;
  const email = String(record.email || "").toLowerCase();
  const cxValidity = (() => {
    const auth = cxAuth || {};
    const sess = cxSession || {};
    if (!auth.refreshTokenEnc) return { isOAuthValidated: false, invalidReason: "no-refresh-token" };
    if (auth.consentRevokedAt) return { isOAuthValidated: false, invalidReason: "consent-revoked" };
    if (auth.refreshTokenExpiresAt && new Date(auth.refreshTokenExpiresAt) <= new Date()) {
      return { isOAuthValidated: false, invalidReason: "refresh-token-expired" };
    }
    if (auth.lastRefreshError && !sess.bearerEnc) {
      return { isOAuthValidated: false, invalidReason: "refresh-failed" };
    }
    return { isOAuthValidated: true, invalidReason: null };
  })();
  return {
    ...safeRecord,
    logicsAuth: sanitizeLogicsAuthForResponse(record.logicsAuth),
    cxAuth: {
      ...cxValidity,
      rcUserEmail: cxAuth?.rcUserEmail || null,
      scopes: Array.isArray(cxAuth?.scopes) ? cxAuth.scopes : [],
      refreshTokenExpiresAt: cxAuth?.refreshTokenExpiresAt || null,
      consentGrantedAt: cxAuth?.consentGrantedAt || null,
    },
    capabilities: ROLE_CAPABILITIES[role] || [],
    views: ROLE_VIEWS[role] || [],
    isSeed: SEED_ADMIN_EMAILS.has(email),
    isHardened: HARDENED_ACCOUNT_EMAILS.has(email),
  };
}

async function bootstrapSeedAccounts({ logger } = {}) {
  const seeds = [...SEED_ADMINS, ...HARDENED_USERS, buildServiceSeed()];
  let created = 0;
  let updated = 0;

  for (const seed of seeds) {
    const existing = await findUserAccountByEmail(seed.email);
    await upsertUserAccount({ ...seed, source: "seed", status: "active" });
    if (existing) {
      updated += 1;
    } else {
      created += 1;
    }
  }

  if (logger) {
    logger.info("accounts.bootstrap.complete", {
      seedsTotal: seeds.length,
      created,
      updated,
    });
  }

  return { created, updated, total: seeds.length };
}

async function findAccountByEmail(email) {
  const record = await findUserAccountByEmail(email);
  return decorateAccountRecord(record);
}

async function listAccounts(filters = {}) {
  const records = await listUserAccounts(filters);
  return records.map(decorateAccountRecord);
}

module.exports = {
  ROLE_CAPABILITIES,
  ROLE_VIEWS,
  HARDENED_ACCOUNT_EMAILS,
  HARDENED_USERS,
  HARDENED_USER_EMAILS,
  SEED_ADMINS,
  SEED_ADMIN_EMAILS,
  bootstrapSeedAccounts,
  decorateAccountRecord,
  findAccountByEmail,
  listAccounts,
};
