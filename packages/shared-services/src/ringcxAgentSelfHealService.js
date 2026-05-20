"use strict";

const { createRingcxVoiceClient } = require("../../shared-integrations/src");

const DEFAULT_SUCCESS_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

const CACHE = new Map();
const IN_FLIGHT = new Map();

function readDurationMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readBooleanFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function compactUnique(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = normalizeId(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function coerceList(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["records", "items", "data", "content", "results", "agents", "agentGroups"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function readAgentId(agent = {}) {
  return normalizeId(agent.agentId || agent.id || agent.agentID || agent.agent_id);
}

function readAgentGroupId(group = {}) {
  return normalizeId(
    group.agentGroupId
      || group.groupId
      || group.id
      || group.agentGroupID
      || group.agent_group_id
      || group.group?.id,
  );
}

function isTruthy(value) {
  if (value === true || value === 1) return true;
  return String(value || "").trim().toLowerCase() === "true";
}

function resolveRingcxAgentIdentity(account = {}) {
  const metadata = account?.metadata && typeof account.metadata === "object"
    ? account.metadata
    : {};
  const username = compactUnique([
    metadata.ringcxUsername,
    metadata.ringcxAgentUsername,
    metadata.ringcxAgentEmail,
    metadata.cxUsername,
    account?.cxSession?.rcxAgentEmail,
    account?.cxAuth?.rcUserEmail,
    account?.email,
  ])[0] || null;

  return {
    userId: normalizeId(account?.id || account?._id),
    email: normalizeId(account?.email),
    agentId: normalizeId(
      account?.cxAgentId
        || metadata.ringcxAgentId
        || metadata.cxAgentId,
    ),
    agentGroupId: normalizeId(
      metadata.ringcxAgentGroupId
        || metadata.cxAgentGroupId
        || process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID,
    ),
    username,
    rcUserId: normalizeId(
      metadata.ringcxRcUserId
        || metadata.rcUserId
        || account?.extensionId,
    ),
  };
}

function cacheKeyForIdentity(identity = {}) {
  return [
    identity.agentGroupId || "group?",
    identity.agentId || identity.username || identity.rcUserId || identity.email || identity.userId || "agent?",
  ].join(":");
}

function summarizeAgent(agent = {}, agentGroupId = null) {
  return {
    agent,
    agentId: readAgentId(agent),
    agentGroupId: normalizeId(agentGroupId),
    username: normalizeId(agent.username || agent.email),
    rcUserId: normalizeId(agent.rcUserId),
    allowOffHook: agent.allowOffHook,
  };
}

async function listPossibleAgentGroups(client, preferredGroupId) {
  const preferred = compactUnique([preferredGroupId]);
  let discovered = [];
  try {
    const groups = await client.listAgentGroups();
    discovered = coerceList(groups).map(readAgentGroupId).filter(Boolean);
  } catch {
    discovered = [];
  }
  return compactUnique([...preferred, ...discovered]);
}

async function findRingcxAgent(client, identity) {
  const preferredGroups = compactUnique([identity.agentGroupId]);

  if (identity.agentId) {
    for (const groupId of preferredGroups) {
      try {
        const agent = await client.getAgent(identity.agentId, groupId);
        if (agent) return summarizeAgent(agent, groupId);
      } catch {
        // Fall through to group discovery below.
      }
    }
  }

  const username = normalizeUsername(identity.username);
  const rcUserId = normalizeId(identity.rcUserId);
  const groupIds = await listPossibleAgentGroups(client, identity.agentGroupId);

  for (const groupId of groupIds) {
    let agents = [];
    try {
      agents = coerceList(await client.listAgents(groupId));
    } catch {
      continue;
    }
    const match = agents.find((agent) => {
      const currentAgentId = readAgentId(agent);
      const currentUsername = normalizeUsername(agent.username || agent.email);
      const currentRcUserId = normalizeId(agent.rcUserId);
      return (
        (identity.agentId && currentAgentId === identity.agentId)
        || (username && currentUsername === username)
        || (rcUserId && currentRcUserId === rcUserId)
      );
    });
    if (!match) continue;

    try {
      const full = await client.getAgent(readAgentId(match), groupId);
      return summarizeAgent(full || match, groupId);
    } catch {
      return summarizeAgent(match, groupId);
    }
  }

  return null;
}

function writeLog(logger, level, event, meta = {}) {
  const sink = logger && typeof logger[level] === "function"
    ? logger[level]
    : logger && typeof logger.log === "function"
      ? logger.log
      : null;
  if (!sink) return;
  sink.call(logger, event, meta);
}

function readCached(key, force) {
  if (force) return null;
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() < entry.nextAttemptAt) return entry;
  CACHE.delete(key);
  return null;
}

function stampCache(key, result, cooldownMs) {
  CACHE.set(key, {
    result,
    nextAttemptAt: Date.now() + cooldownMs,
  });
}

async function ensureRingcxAgentOffhookAllowed(account, options = {}) {
  const logger = options.logger || console;
  const source = options.source || "ringcx-agent-self-heal";
  const force = Boolean(options.force);

  if (readBooleanFlag("RINGCX_OFFHOOK_SELF_HEAL_DISABLED", false)) {
    return { ok: true, skipped: true, reason: "disabled", source };
  }

  const identity = resolveRingcxAgentIdentity(account);
  const key = cacheKeyForIdentity(identity);
  const cached = readCached(key, force);
  if (cached) {
    return {
      ok: true,
      skipped: true,
      reason: "cooldown",
      source,
      cached: cached.result,
      nextAttemptAt: new Date(cached.nextAttemptAt),
    };
  }
  if (!force && IN_FLIGHT.has(key)) {
    return { ok: true, skipped: true, reason: "in-flight", source };
  }

  const run = (async () => {
    const successCooldownMs = readDurationMs(
      "RINGCX_OFFHOOK_SELF_HEAL_COOLDOWN_MS",
      DEFAULT_SUCCESS_COOLDOWN_MS,
    );
    const failureCooldownMs = readDurationMs(
      "RINGCX_OFFHOOK_SELF_HEAL_FAILURE_COOLDOWN_MS",
      DEFAULT_FAILURE_COOLDOWN_MS,
    );

    if (!identity.agentId && !identity.username && !identity.rcUserId) {
      const result = { ok: true, skipped: true, reason: "missing-agent-identity", source, identity };
      stampCache(key, result, successCooldownMs);
      return result;
    }

    try {
      const client = options.client || createRingcxVoiceClient();
      const found = await findRingcxAgent(client, identity);
      if (!found?.agent || !found.agentId || !found.agentGroupId) {
        const result = { ok: true, skipped: true, reason: "agent-not-found", source, identity };
        stampCache(key, result, failureCooldownMs);
        writeLog(logger, "warn", "ringcx.offhook.self_heal.agent_not_found", {
          source,
          email: identity.email,
          agentId: identity.agentId,
          agentGroupId: identity.agentGroupId,
          username: identity.username,
          rcUserId: identity.rcUserId,
        });
        return result;
      }

      if (isTruthy(found.agent.allowOffHook)) {
        const result = {
          ok: true,
          patched: false,
          reason: "already-enabled",
          source,
          agentId: found.agentId,
          agentGroupId: found.agentGroupId,
          username: found.username,
        };
        stampCache(key, result, successCooldownMs);
        return result;
      }

      const payload = { ...found.agent, allowOffHook: true };
      await client.updateAgent(found.agentId, payload, found.agentGroupId);
      const result = {
        ok: true,
        patched: true,
        source,
        agentId: found.agentId,
        agentGroupId: found.agentGroupId,
        username: found.username,
        before: { allowOffHook: found.agent.allowOffHook },
        after: { allowOffHook: true },
      };
      stampCache(key, result, successCooldownMs);
      writeLog(logger, "info", "ringcx.offhook.self_heal.patched", {
        source,
        email: identity.email,
        agentId: found.agentId,
        agentGroupId: found.agentGroupId,
        username: found.username,
      });
      return result;
    } catch (error) {
      const result = {
        ok: false,
        source,
        error: error.message,
        identity: {
          email: identity.email,
          agentId: identity.agentId,
          agentGroupId: identity.agentGroupId,
          username: identity.username,
          rcUserId: identity.rcUserId,
        },
      };
      stampCache(key, result, failureCooldownMs);
      writeLog(logger, "warn", "ringcx.offhook.self_heal.failed", result);
      return result;
    }
  })();

  IN_FLIGHT.set(key, run);
  try {
    return await run;
  } finally {
    IN_FLIGHT.delete(key);
  }
}

module.exports = {
  ensureRingcxAgentOffhookAllowed,
  resolveRingcxAgentIdentity,
};
