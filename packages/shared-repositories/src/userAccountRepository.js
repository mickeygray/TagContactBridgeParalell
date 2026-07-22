"use strict";

const { AgentState, UserAccount } = require("../../shared-models/src");
const { normalizeCxQueuePolicyTier } = require("../../shared-normalizers/src");

const CX_QUEUE_POLICY_TIERS = new Set([
  "no_leads",
  "red_only",
  "old_balanced",
  "fresh_capped",
  "fresh_priority",
]);
const PHONEBURNER_PROVIDER = "phoneburner";
const PHONEBURNER_CREDENTIAL_PATH = "providerCredentials.phoneBurner";

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function requirePhoneBurnerProvider(provider = PHONEBURNER_PROVIDER) {
  const normalized = String(provider || "").trim().toLowerCase();
  if (normalized !== PHONEBURNER_PROVIDER) {
    throw new TypeError("provider must be phoneburner");
  }
  return normalized;
}

function requireCredentialCiphertext(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function requireCredentialRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError("expectedRevision must be a non-negative integer");
  }
  return revision;
}

function normalizeCredentialDate(value, name) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} must be a valid date`);
  return date;
}

function toPhoneBurnerCredentialRecord(doc, { includeCiphertext = false } = {}) {
  if (!doc) return null;
  const plain = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const credential = plain.providerCredentials?.phoneBurner || {};
  const revision = Number(credential.revision);
  const record = {
    accountId: String(plain._id),
    provider: PHONEBURNER_PROVIDER,
    tokenType: credential.tokenType || null,
    accessTokenExpiresAt: credential.accessTokenExpiresAt || null,
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
    migratedAt: credential.migratedAt || null,
    refreshedAt: credential.refreshedAt || null,
  };
  if (includeCiphertext) {
    record.accessTokenEnc = credential.accessTokenEnc || null;
    record.refreshTokenEnc = credential.refreshTokenEnc || null;
  }
  return record;
}

function normalizeExtension(extensionId) {
  if (extensionId === null || extensionId === undefined) return null;
  const value = String(extensionId).trim();
  return value.length > 0 ? value : null;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeRouteCampaigns(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const normalized = Array.from(
    new Set(
      raw
        .map((entry) => String(entry || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  return normalized.length > 0 ? normalized : null;
}

function normalizeCxQueuePolicy(input) {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input !== "object") return undefined;

  const tier = normalizeCxQueuePolicyTier(input.tier);
  const out = {
    tier: CX_QUEUE_POLICY_TIERS.has(tier) ? tier : null,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    routeCampaigns: normalizeRouteCampaigns(input.routeCampaigns),
    totalOpen: toNullableNumber(input.totalOpen),
    fresh: {
      eligible: input.fresh?.eligible == null ? null : Boolean(input.fresh.eligible),
      firstTouchEligible:
        input.fresh?.firstTouchEligible == null
          ? null
          : Boolean(input.fresh.firstTouchEligible),
      targetOpen: toNullableNumber(input.fresh?.targetOpen),
      hourlyCap: toNullableNumber(input.fresh?.hourlyCap),
      priorityWeight: toNullableNumber(input.fresh?.priorityWeight),
    },
    day2to15: {
      targetOpen: toNullableNumber(input.day2to15?.targetOpen),
    },
    day16to30: {
      targetOpen: toNullableNumber(input.day16to30?.targetOpen),
    },
    aged: {
      targetOpen: toNullableNumber(input.aged?.targetOpen),
    },
    updatedAt: input.updatedAt || null,
    updatedBy: input.updatedBy || null,
  };

  return out;
}

function hasPolicyValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function hasManualCxQueuePolicy(input = null) {
  if (!input || typeof input !== "object") return false;
  return (
    input.enabled === false
    || hasPolicyValue(input.fresh?.eligible)
    || hasPolicyValue(input.fresh?.firstTouchEligible)
    || hasPolicyValue(input.fresh?.targetOpen)
    || hasPolicyValue(input.day2to15?.targetOpen)
    || hasPolicyValue(input.day16to30?.targetOpen)
    || hasPolicyValue(input.aged?.targetOpen)
    || hasPolicyValue(input.totalOpen)
    || hasPolicyValue(input.routeCampaigns)
  );
}

function buildAgentQueuePolicyMirror(account) {
  if (!account || typeof account !== "object") return null;
  const extensionId = normalizeExtension(account.extensionId);
  if (!extensionId) return null;
  const policy = normalizeCxQueuePolicy(account.cxQueuePolicy) || null;
  return {
    extensionId,
    update: {
      cxQueuePolicy: policy,
      cxQueuePolicyExplicit: hasManualCxQueuePolicy(policy),
    },
  };
}

async function mirrorCxQueuePolicyToAgentState(account) {
  const mirror = buildAgentQueuePolicyMirror(account);
  if (!mirror) return null;
  return AgentState.updateOne(
    { extensionId: mirror.extensionId },
    { $set: mirror.update },
  );
}

function normalizeExShells(shells) {
  if (!Array.isArray(shells)) return [];
  return shells
    .map((shell) => {
      if (!shell || typeof shell !== "object") return null;
      const loginPhones = (Array.isArray(shell.loginPhones) ? shell.loginPhones : [])
        .map(normalizePhone)
        .filter(Boolean);
      const primaryPhone = normalizePhone(shell.primaryPhone) || loginPhones[0] || null;
      const company = String(shell.company || "").trim().toUpperCase();
      return {
        company: ["TAG", "WYNN", "AMITY"].includes(company) ? company : "TAG",
        email: shell.email ? normalizeEmail(shell.email) : null,
        name: shell.name ? String(shell.name).trim() : null,
        extensionNumber:
          shell.extensionNumber != null ? String(shell.extensionNumber).trim() || null : null,
        loginPhones,
        primaryPhone,
        rcExtensionId: normalizeExtension(shell.rcExtensionId),
        lastResolvedAt: shell.lastResolvedAt || null,
        source: shell.source ? String(shell.source).trim() : null,
      };
    })
    .filter(Boolean);
}

function toAccountRecord(doc) {
  if (!doc) return null;
  const plain = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    id: String(plain._id),
    email: plain.email,
    name: plain.name,
    role: plain.role,
    permissions: Array.isArray(plain.permissions) ? plain.permissions : [],
    permissionsUpdatedAt: plain.permissionsUpdatedAt || null,
    permissionsUpdatedBy: plain.permissionsUpdatedBy || null,
    audience: plain.audience,
    workspace: plain.workspace || "general",
    stationLabel: plain.stationLabel || null,
    company: plain.company || null,
    logicsUserId: plain.logicsUserId || null,
    logicsDisplayName: plain.logicsDisplayName || null,
    tagLogicsId: plain.tagLogicsId || null,
    tagSOId: plain.tagSOId || null,
    tagEmail: plain.tagEmail || null,
    tagLogicsName: plain.tagLogicsName || null,
    tagLogicsRoles: plain.tagLogicsRoles || null,
    wynnLogicsId: plain.wynnLogicsId || null,
    wynnSOId: plain.wynnSOId || null,
    wynnEmail: plain.wynnEmail || null,
    wynnLogicsName: plain.wynnLogicsName || null,
    wynnLogicsRoles: plain.wynnLogicsRoles || null,
    logicsAuth: plain.logicsAuth || null,
    extensionId: plain.extensionId || null,
    extensionNumber: plain.extensionNumber || null,
    cxAgentId: plain.cxAgentId || null,
    phone: plain.phone || null,
    cxQueuePolicy: normalizeCxQueuePolicy(plain.cxQueuePolicy) || null,
    cxAuth: plain.cxAuth || null,
    cxSession: plain.cxSession || null,
    exShells: normalizeExShells(plain.exShells || []),
    status: plain.status,
    source: plain.source || "manual",
    lastLoginAt: plain.lastLoginAt || null,
    disabledAt: plain.disabledAt || null,
    createdAt: plain.createdAt || null,
    updatedAt: plain.updatedAt || null,
    metadata: plain.metadata || null,
  };
}

async function findUserAccountByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  const doc = await UserAccount.findOne({ email: normalizedEmail }).lean();
  return toAccountRecord(doc);
}

async function findUserAccountById(id) {
  if (!id) return null;
  const doc = await UserAccount.findById(id).lean();
  return toAccountRecord(doc);
}

async function findUserAccountByExtensionId(extensionId) {
  const normalized = normalizeExtension(extensionId);
  if (!normalized) return null;
  // Match the canonical primary extensionId OR any sibling extension
  // tracked in metadata.additionalExtensionIds. Each human has one UA
  // (keyed by their TAG-domain email) but can be paired to multiple
  // RC extensions across tenants — the wynn/amity tenant extensions
  // route to the same UA so dial/cx routing finds the right agent
  // regardless of which tenant's queue served the call.
  const doc = await UserAccount.findOne({
    $or: [
      { extensionId: normalized },
      { "metadata.additionalExtensionIds": normalized },
    ],
  }).lean();
  return toAccountRecord(doc);
}

async function listUserAccounts(filters = {}) {
  const query = {};
  if (filters.status) query.status = filters.status;
  if (filters.role) query.role = filters.role;
  if (filters.audience) query.audience = filters.audience;
  if (filters.company) query.company = filters.company;
  if (filters.search) {
    const search = String(filters.search).trim();
    if (search) {
      const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [{ email: pattern }, { name: pattern }];
    }
  }

  const limit = Math.min(Number(filters.limit) || 200, 1000);
  const docs = await UserAccount.find(query).sort({ name: 1, email: 1 }).limit(limit).lean();
  return docs.map(toAccountRecord);
}

async function createUserAccount(input = {}) {
  const payload = {
    email: normalizeEmail(input.email),
    name: String(input.name || "").trim(),
    role: input.role || "widget-user",
    permissions: Array.isArray(input.permissions) ? input.permissions : [],
    permissionsUpdatedAt: input.permissionsUpdatedAt || null,
    permissionsUpdatedBy: input.permissionsUpdatedBy || null,
    audience: input.audience || (input.role === "admin" ? "admin" : "user"),
    workspace: input.workspace || "general",
    stationLabel: input.stationLabel || null,
    company: input.company || "TAG",
    logicsUserId: input.logicsUserId != null ? Number(input.logicsUserId) : null,
    logicsDisplayName: input.logicsDisplayName || null,
    tagLogicsId: input.tagLogicsId != null ? Number(input.tagLogicsId) || null : null,
    tagSOId: input.tagSOId != null ? Number(input.tagSOId) || null : null,
    tagEmail: input.tagEmail ? normalizeEmail(input.tagEmail) : null,
    tagLogicsName: input.tagLogicsName || null,
    tagLogicsRoles: input.tagLogicsRoles || null,
    wynnLogicsId: input.wynnLogicsId != null ? Number(input.wynnLogicsId) || null : null,
    wynnSOId: input.wynnSOId != null ? Number(input.wynnSOId) || null : null,
    wynnEmail: input.wynnEmail ? normalizeEmail(input.wynnEmail) : null,
    wynnLogicsName: input.wynnLogicsName || null,
    wynnLogicsRoles: input.wynnLogicsRoles || null,
    logicsAuth: input.logicsAuth || null,
    extensionId: normalizeExtension(input.extensionId),
    extensionNumber: input.extensionNumber != null ? String(input.extensionNumber).trim() || null : null,
    cxAgentId: input.cxAgentId || null,
    phone: input.phone || null,
    cxQueuePolicy: normalizeCxQueuePolicy(input.cxQueuePolicy) || null,
    exShells: normalizeExShells(input.exShells),
    status: input.status || "active",
    source: input.source || "manual",
    metadata: input.metadata || null,
  };

  if (!payload.email) {
    const err = new Error("email is required");
    err.status = 400;
    throw err;
  }
  if (!payload.name) {
    const err = new Error("name is required");
    err.status = 400;
    throw err;
  }

  try {
    const doc = await UserAccount.create(payload);
    await mirrorCxQueuePolicyToAgentState(doc).catch(() => null);
    return toAccountRecord(doc);
  } catch (error) {
    if (error && error.code === 11000) {
      const err = new Error("An account with that email already exists");
      err.status = 409;
      throw err;
    }
    throw error;
  }
}

async function upsertUserAccount(input = {}) {
  const email = normalizeEmail(input.email);
  if (!email) {
    const err = new Error("email is required");
    err.status = 400;
    throw err;
  }

  const update = { $set: {}, $setOnInsert: {} };
  const setFields = [
    "name",
    "role",
    "permissions",
    "permissionsUpdatedAt",
    "permissionsUpdatedBy",
    "audience",
    "workspace",
    "stationLabel",
    "company",
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
    "logicsAuth",
    "extensionId",
    "extensionNumber",
    "cxAgentId",
    "phone",
    "cxQueuePolicy",
    "exShells",
    "status",
    "metadata",
  ];
  for (const key of setFields) {
    if (input[key] === undefined) continue;
    update.$set[key] =
      key === "extensionId"
        ? normalizeExtension(input[key])
        : key === "logicsUserId" || key === "tagLogicsId" || key === "tagSOId" || key === "wynnLogicsId" || key === "wynnSOId"
          ? (input[key] == null ? null : Number(input[key]) || null)
        : key === "tagEmail" || key === "wynnEmail"
          ? (input[key] ? normalizeEmail(input[key]) : null)
          : key === "cxQueuePolicy"
            ? normalizeCxQueuePolicy(input[key])
          : key === "exShells"
            ? normalizeExShells(input[key])
            : input[key];
  }
  update.$setOnInsert.email = email;
  update.$setOnInsert.source = input.source || "manual";
  if (Object.keys(update.$set).length === 0) delete update.$set;

  const doc = await UserAccount.findOneAndUpdate({ email }, update, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  });
  await mirrorCxQueuePolicyToAgentState(doc).catch(() => null);
  return toAccountRecord(doc);
}

async function updateUserAccount(id, patch = {}) {
  if (!id) {
    const err = new Error("id is required");
    err.status = 400;
    throw err;
  }

  const set = {};
  const editable = [
    "name",
    "role",
    "permissions",
    "permissionsUpdatedAt",
    "permissionsUpdatedBy",
    "audience",
    "workspace",
    "stationLabel",
    "company",
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
    "logicsAuth",
    "extensionId",
    "extensionNumber",
    "cxAgentId",
    "phone",
    "cxQueuePolicy",
    "exShells",
    "status",
    "metadata",
  ];
  for (const key of editable) {
    if (patch[key] === undefined) continue;
    set[key] =
      key === "extensionId"
        ? normalizeExtension(patch[key])
        : key === "logicsUserId" || key === "tagLogicsId" || key === "tagSOId" || key === "wynnLogicsId" || key === "wynnSOId"
          ? (patch[key] == null ? null : Number(patch[key]) || null)
        : key === "tagEmail" || key === "wynnEmail"
          ? (patch[key] ? normalizeEmail(patch[key]) : null)
          : key === "cxQueuePolicy"
            ? normalizeCxQueuePolicy(patch[key])
          : key === "exShells"
            ? normalizeExShells(patch[key])
            : patch[key];
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!key.includes(".")) continue;
    if (
      key.startsWith("cxAuth.")
      || key.startsWith("cxSession.")
    ) {
      set[key] = value;
    }
  }
  if (patch.status === "disabled" && !patch.disabledAt) {
    set.disabledAt = new Date();
  }
  if (patch.status === "active") {
    set.disabledAt = null;
  }

  if (Object.keys(set).length === 0) {
    const existing = await UserAccount.findById(id).lean();
    if (!existing) {
      const err = new Error("Account not found");
      err.status = 404;
      throw err;
    }
    return toAccountRecord(existing);
  }

  const doc = await UserAccount.findByIdAndUpdate(id, { $set: set }, { new: true });
  if (!doc) {
    const err = new Error("Account not found");
    err.status = 404;
    throw err;
  }
  await mirrorCxQueuePolicyToAgentState(doc).catch(() => null);
  return toAccountRecord(doc);
}

async function readServiceProviderCredentialPair({
  serviceEmail,
  provider = PHONEBURNER_PROVIDER,
} = {}) {
  requirePhoneBurnerProvider(provider);
  const email = normalizeEmail(serviceEmail);
  if (!email) throw new TypeError("serviceEmail is required");

  const doc = await UserAccount.findOne({ email, role: "service" })
    .select([
      "_id",
      `${PHONEBURNER_CREDENTIAL_PATH}.tokenType`,
      `${PHONEBURNER_CREDENTIAL_PATH}.accessTokenExpiresAt`,
      `${PHONEBURNER_CREDENTIAL_PATH}.revision`,
      `${PHONEBURNER_CREDENTIAL_PATH}.migratedAt`,
      `${PHONEBURNER_CREDENTIAL_PATH}.refreshedAt`,
      `+${PHONEBURNER_CREDENTIAL_PATH}.accessTokenEnc`,
      `+${PHONEBURNER_CREDENTIAL_PATH}.refreshTokenEnc`,
    ].join(" "))
    .lean();
  return toPhoneBurnerCredentialRecord(doc, { includeCiphertext: true });
}

async function writeServiceProviderCredentialPair({
  serviceEmail,
  provider = PHONEBURNER_PROVIDER,
  accessTokenEnc,
  refreshTokenEnc,
  tokenType = null,
  accessTokenExpiresAt = null,
  expectedRevision,
  migratedAt,
  refreshedAt = new Date(),
} = {}) {
  requirePhoneBurnerProvider(provider);
  const email = normalizeEmail(serviceEmail);
  if (!email) throw new TypeError("serviceEmail is required");
  const accessCiphertext = requireCredentialCiphertext(accessTokenEnc, "accessTokenEnc");
  const refreshCiphertext = requireCredentialCiphertext(refreshTokenEnc, "refreshTokenEnc");
  const revision = requireCredentialRevision(expectedRevision);
  const refreshDate = normalizeCredentialDate(refreshedAt, "refreshedAt");
  if (!refreshDate) throw new TypeError("refreshedAt is required");

  const filter = {
    email,
    role: "service",
  };
  if (revision === 0) {
    filter.$or = [
      { [`${PHONEBURNER_CREDENTIAL_PATH}.revision`]: 0 },
      { [`${PHONEBURNER_CREDENTIAL_PATH}.revision`]: { $exists: false } },
    ];
  } else {
    filter[`${PHONEBURNER_CREDENTIAL_PATH}.revision`] = revision;
  }
  const set = {
    [`${PHONEBURNER_CREDENTIAL_PATH}.accessTokenEnc`]: accessCiphertext,
    [`${PHONEBURNER_CREDENTIAL_PATH}.refreshTokenEnc`]: refreshCiphertext,
    [`${PHONEBURNER_CREDENTIAL_PATH}.tokenType`]: tokenType == null
      ? null
      : String(tokenType).trim() || null,
    [`${PHONEBURNER_CREDENTIAL_PATH}.accessTokenExpiresAt`]: normalizeCredentialDate(
      accessTokenExpiresAt,
      "accessTokenExpiresAt",
    ),
    [`${PHONEBURNER_CREDENTIAL_PATH}.refreshedAt`]: refreshDate,
  };
  if (migratedAt != null && migratedAt !== "") {
    set[`${PHONEBURNER_CREDENTIAL_PATH}.migratedAt`] = normalizeCredentialDate(
      migratedAt,
      "migratedAt",
    );
  }

  const doc = await UserAccount.findOneAndUpdate(
    filter,
    {
      $set: set,
      $inc: { [`${PHONEBURNER_CREDENTIAL_PATH}.revision`]: 1 },
    },
    { new: true, runValidators: true },
  )
    .select([
      "_id",
      `${PHONEBURNER_CREDENTIAL_PATH}.tokenType`,
      `${PHONEBURNER_CREDENTIAL_PATH}.accessTokenExpiresAt`,
      `${PHONEBURNER_CREDENTIAL_PATH}.revision`,
      `${PHONEBURNER_CREDENTIAL_PATH}.migratedAt`,
      `${PHONEBURNER_CREDENTIAL_PATH}.refreshedAt`,
    ].join(" "))
    .lean();
  return toPhoneBurnerCredentialRecord(doc);
}

async function touchUserAccountLogin(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  await UserAccount.updateOne(
    { email: normalized },
    { $set: { lastLoginAt: new Date() } },
  );
}

module.exports = {
  createUserAccount,
  findUserAccountByEmail,
  findUserAccountById,
  findUserAccountByExtensionId,
  listUserAccounts,
  readServiceProviderCredentialPair,
  touchUserAccountLogin,
  updateUserAccount,
  upsertUserAccount,
  writeServiceProviderCredentialPair,
};
