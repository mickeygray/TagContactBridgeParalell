#!/usr/bin/env node
"use strict";

// Read-only PhoneBurner folder proof for the provider-neutral lead-delivery
// runtime. This command never lists contacts, posts contacts, mutates folders,
// refreshes credentials, or prints folder IDs, credentials, or lead data.

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

const {
  createPhoneBurnerClient,
  createPhoneBurnerEnvironmentCredentialStore,
} = require("../packages/shared-integrations/src");
const {
  validateLeadDeliveryConfiguration,
} = require("../packages/shared-services/src/leadDeliveryService");

function requestedAgent(argv = process.argv.slice(2)) {
  const inline = argv.find((value) => value.startsWith("--agent="));
  if (inline) return inline.slice("--agent=".length).trim().toLowerCase();
  const index = argv.indexOf("--agent");
  return index >= 0 ? String(argv[index + 1] || "").trim().toLowerCase() : null;
}

function safeResult(agentId, role, result = {}) {
  return {
    agentId,
    role,
    ok: result.ok === true,
    count: result.ok === true && Number.isSafeInteger(result.count) ? result.count : null,
    httpStatus: Number.isSafeInteger(result.httpStatus) ? result.httpStatus : 0,
    reason: result.ok === true ? null : String(result.reason || "folder-read-failed"),
  };
}

async function main() {
  const configPath = path.resolve(__dirname, "..", "config", "lead-delivery-agents.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const validation = validateLeadDeliveryConfiguration(config);
  if (!validation.valid) {
    console.log(JSON.stringify({ ok: false, reason: "configuration-invalid", errorCount: validation.errors.length }));
    process.exitCode = 1;
    return;
  }

  const agentFilter = requestedAgent();
  // Disabled seats have no provider folders yet; validate them only when
  // explicitly requested via --agent.
  const entries = Object.entries(config.agents)
    .filter(([agentId]) => !agentFilter || agentId === agentFilter)
    .filter(([, agent]) => agentFilter || agent.enabled === true);
  if (!entries.length) {
    console.log(JSON.stringify({ ok: false, reason: "agent-not-configured" }));
    process.exitCode = 1;
    return;
  }

  const credentialStore = createPhoneBurnerEnvironmentCredentialStore();
  const credentials = await credentialStore.read();
  if (!credentials.accessToken) {
    console.log(JSON.stringify({ ok: false, reason: "phoneburner-access-unavailable" }));
    process.exitCode = 1;
    return;
  }

  const client = createPhoneBurnerClient({
    credentialStore,
    refreshOnUnauthorized: false,
  });
  const results = [];
  for (const [agentId, agent] of entries) {
    for (const [role, folderId] of [
      ["distribution", agent.distributionFolderId],
      ["receiving", agent.receivingFolderId],
    ]) {
      try {
        results.push(safeResult(agentId, role, await client.getFolderCount(folderId)));
      } catch {
        results.push(safeResult(agentId, role, { reason: "folder-read-failed" }));
      }
    }
  }
  const ok = results.every((result) => result.ok);
  console.log(JSON.stringify({ ok, checkedAgents: entries.length, results }));
  if (!ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(() => {
    console.log(JSON.stringify({ ok: false, reason: "validation-command-failed" }));
    process.exitCode = 1;
  });
}

module.exports = {
  requestedAgent,
  safeResult,
};
