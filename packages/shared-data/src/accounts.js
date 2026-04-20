"use strict";

const { AUDIENCES, ROLES } = require("../../shared-types/src");
const { env } = require("../../shared-config/src/env");

const ROLE_CAPABILITIES = Object.freeze({
  [ROLES.ADMIN]: [
    "events.read",
    "events.replay",
    "services.read",
    "accounts.read",
    "contacts.launch",
    "metrics.read",
  ],
  [ROLES.INTERNAL_AGENT]: [
    "services.read",
    "contacts.read",
    "contacts.message",
    "ring.workspace",
  ],
  [ROLES.WIDGET_USER]: [
    "ring.workspace",
    "contacts.read",
    "contacts.message",
    "contacts.email",
  ],
  [ROLES.SERVICE]: ["events.process"],
});

const ROLE_VIEWS = Object.freeze({
  [ROLES.ADMIN]: ["admin", "user"],
  [ROLES.INTERNAL_AGENT]: ["user", "agent"],
  [ROLES.WIDGET_USER]: ["user"],
  [ROLES.SERVICE]: ["service"],
});

function normalizeAccount(seed) {
  return {
    id: seed.id,
    email: String(seed.email).toLowerCase(),
    name: seed.name,
    role: seed.role,
    audience: seed.audience,
    capabilities: ROLE_CAPABILITIES[seed.role] || [],
    views: ROLE_VIEWS[seed.role] || [],
    workspace: seed.workspace || "general",
    stationLabel: seed.stationLabel || null,
    company: seed.company || "TAG",
    extensionId: seed.extensionId || null,
    cxAgentId: seed.cxAgentId || null,
    phone: seed.phone || null,
  };
}

function listAccounts(config) {
  const seeds = [
    {
      id: "admin-1",
      email: config.adminAccount.email,
      name: config.adminAccount.name,
      role: ROLES.ADMIN,
      audience: AUDIENCES.ADMIN,
      company: "TAG",
    },
    {
      id: "user-1",
      email: env("PARALLEL_USER_EMAIL", "cx.user@taxadvocategroup.com"),
      name: env("PARALLEL_USER_NAME", "CX User"),
      role: ROLES.WIDGET_USER,
      audience: AUDIENCES.USER,
      workspace: env("PARALLEL_USER_WORKSPACE", "ringcentral-cx"),
      stationLabel: env("PARALLEL_USER_STATION_LABEL", "CX Desk 1"),
      company: env("PARALLEL_USER_COMPANY", "TAG"),
      extensionId: env("PARALLEL_USER_EXTENSION_ID", ""),
      cxAgentId: env("PARALLEL_USER_CX_AGENT_ID", ""),
      phone: env("PARALLEL_USER_PHONE", ""),
    },
    {
      id: "agent-1",
      email: env("PARALLEL_AGENT_EMAIL", "agent@taxadvocategroup.com"),
      name: env("PARALLEL_AGENT_NAME", "Internal Agent"),
      role: ROLES.INTERNAL_AGENT,
      audience: AUDIENCES.USER,
      workspace: env("PARALLEL_AGENT_WORKSPACE", "ringcentral-cx"),
      stationLabel: env("PARALLEL_AGENT_STATION_LABEL", "Agent Console"),
      company: env("PARALLEL_AGENT_COMPANY", "TAG"),
      extensionId: env("PARALLEL_AGENT_EXTENSION_ID", ""),
      cxAgentId: env("PARALLEL_AGENT_CX_AGENT_ID", ""),
      phone: env("PARALLEL_AGENT_PHONE", ""),
    },
    {
      id: "service-1",
      email: env("PARALLEL_SERVICE_EMAIL", "service@taxadvocategroup.com"),
      name: env("PARALLEL_SERVICE_NAME", "Control Plane Service"),
      role: ROLES.SERVICE,
      audience: AUDIENCES.ADMIN,
      workspace: env("PARALLEL_SERVICE_WORKSPACE", "control-plane"),
      company: env("PARALLEL_SERVICE_COMPANY", "TAG"),
    },
  ];

  return seeds.map(normalizeAccount);
}

function findAccountByEmail(config, email) {
  if (!email) return null;
  return listAccounts(config).find(
    (account) => account.email === String(email).toLowerCase(),
  );
}

module.exports = {
  ROLE_CAPABILITIES,
  findAccountByEmail,
  listAccounts,
};
